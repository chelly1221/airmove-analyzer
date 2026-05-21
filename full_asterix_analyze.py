#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NEC ASS 파일 전수 ASTERIX 분석기.
CAT048 / CAT034 / CAT008 의 모든 데이터 항목을 EUROCONTROL 사양에 따라 디코딩하여
파일 내부에 실제로 존재하는 모든 데이터 종류와 값 분포를 집계한다.
(현재 앱이 파싱하지 않는 항목까지 전부 포함)
"""
import sys, json, math
from collections import Counter

CAT048, CAT034, CAT008 = 0x30, 0x22, 0x08
MAX_BLOCK_LEN = 65535

# ─────────────────────── 공통 ───────────────────────
def parse_fspec(data, offset, max_items):
    present, idx = [], 0
    while True:
        if offset >= len(data):
            return None, offset
        byte = data[offset]; offset += 1
        for bit in range(7, 0, -1):
            if idx < max_items and (byte >> bit) & 1:
                present.append(idx)
            idx += 1
        if byte & 1 == 0:
            break
    return present, offset

def skip_fx(data, offset):
    pos = offset
    while pos < len(data):
        b = data[pos]; pos += 1
        if b & 1 == 0:
            break
    return pos - offset

def ia5_callsign(b):  # 6바이트 → 8문자 (ICAO 6-bit IA-5)
    bits = int.from_bytes(b[:6], 'big')
    out = []
    for i in range(8):
        v = (bits >> (42 - i*6)) & 0x3F
        if 1 <= v <= 26:   out.append(chr(64+v))
        elif v == 32:      out.append(' ')
        elif 48 <= v <= 57: out.append(chr(v))
        else:              out.append('')
    return ''.join(out).strip()

class Acc:
    """범위/집합 누적기"""
    def __init__(self): self.mn=math.inf; self.mx=-math.inf; self.n=0
    def add(self,v):
        self.mn=min(self.mn,v); self.mx=max(self.mx,v); self.n+=1
    def rng(self):
        return [None,None] if self.n==0 else [self.mn,self.mx]

# ─────────────────────── CAT048 ───────────────────────
# FSPEC bit 순서대로의 UAP
C48 = [("I010","048/010"),("I140","048/140"),("I020","048/020"),("I040","048/040"),
       ("I070","048/070"),("I090","048/090"),("I130","048/130"),("I220","048/220"),
       ("I240","048/240"),("I250","048/250"),("I161","048/161"),("I042","048/042"),
       ("I200","048/200"),("I170","048/170"),("I210","048/210"),("I030","048/030"),
       ("I080","048/080"),("I100","048/100"),("I110","048/110"),("I120","048/120"),
       ("I230","048/230"),("I260","048/260"),("I055","048/055"),("I050","048/050"),
       ("I065","048/065"),("I060","048/060"),("SP","SP"),("RE","RE")]
C48_MAX = 28

class S48:
    def __init__(s):
        s.records=0; s.truncated=0
        s.present=Counter()
        s.sac_sic=Counter()
        s.tod=Acc(); s.rho=Acc(); s.theta=Acc(); s.fl=Acc()
        s.gsp=Acc(); s.hdg=Acc(); s.x=Acc(); s.y=Acc()
        s.height3d=Acc()
        s.typ=Counter(); s.sim=Counter(); s.rdp=Counter(); s.spi=Counter(); s.rab=Counter()
        s.modes=Counter(); s.mode3a=set(); s.m3a_garbled=0
        s.callsigns=Counter()
        s.trk=set()
        s.com=Counter(); s.stat=Counter(); s.arc=Counter(); s.aic=Counter()
        s.cnf=Counter(); s.rad=Counter()
        s.modec=Acc(); s.modec_present=0
        s.bds=Counter()
        s.i260=0
        s.mode1=set(); s.mode2=set()

def dec48(block, off, s, only_sac=None):
    present, pos = parse_fspec(block, off, C48_MAX)
    if present is None: return None
    trunc=False
    sac=sic=None
    f={}  # 임시 디코드 필드
    for it in present:
        if pos>=len(block): trunc=True; break
        if it==0:  # I010 SAC/SIC
            if pos+2>len(block): trunc=True;break
            sac,sic=block[pos],block[pos+1]; pos+=2
        elif it==1:  # I140 TOD
            if pos+3>len(block): trunc=True;break
            raw=(block[pos]<<16)|(block[pos+1]<<8)|block[pos+2]; f['tod']=raw/128.0; pos+=3
        elif it==2:  # I020 target report descriptor
            if pos>=len(block): trunc=True;break
            fb=block[pos]
            f['typ']=(fb>>5)&7; f['sim']=(fb>>4)&1; f['rdp']=(fb>>3)&1
            f['spi']=(fb>>2)&1; f['rab']=(fb>>1)&1
            c=skip_fx(block,pos)
            if c==0: trunc=True;break
            pos+=c
        elif it==3:  # I040 polar
            if pos+4>len(block): trunc=True;break
            rr=(block[pos]<<8)|block[pos+1]; tt=(block[pos+2]<<8)|block[pos+3]
            f['rho']=rr/256.0; f['theta']=tt*360.0/65536.0; pos+=4
        elif it==4:  # I070 Mode-3/A
            if pos+2>len(block): trunc=True;break
            v=(block[pos]>>7)&1; g=(block[pos]>>6)&1
            if v==0 and g==0: f['m3a']=((block[pos]&0x0F)<<8)|block[pos+1]
            else: f['m3a_g']=True
            pos+=2
        elif it==5:  # I090 FL
            if pos+2>len(block): trunc=True;break
            raw=(block[pos]<<8)|block[pos+1]; u=raw&0x3FFF
            f['fl']=(u-0x4000 if u&0x2000 else u)*0.25; pos+=2
        elif it==6:  # I130 plot characteristics (subfield FSPEC + 1바이트씩)
            if pos>=len(block): trunc=True;break
            sub=block[pos]; pos+=1; ok=True
            for bit in range(7,0,-1):
                if (sub>>bit)&1:
                    if pos>=len(block): ok=False;break
                    pos+=1
            if not ok: trunc=True;break
        elif it==7:  # I220 Mode-S addr
            if pos+3>len(block): trunc=True;break
            addr=(block[pos]<<16)|(block[pos+1]<<8)|block[pos+2]
            if addr>0: f['modes']=addr
            pos+=3
        elif it==8:  # I240 Aircraft Identification
            if pos+6>len(block): trunc=True;break
            f['callsign']=ia5_callsign(block[pos:pos+6]); pos+=6
        elif it==9:  # I250 Mode-S MB
            if pos>=len(block): trunc=True;break
            rep=block[pos]; pos+=1; sz=rep*8
            if pos+sz>len(block): trunc=True;break
            bdslist=[]
            for k in range(rep):
                o=pos+k*8; bb=block[o+7]
                bdslist.append(((bb>>4)&0x0F, bb&0x0F))
            f['bds']=bdslist; pos+=sz
        elif it==10:  # I161 track number
            if pos+2>len(block): trunc=True;break
            f['trk']=((block[pos]<<8)|block[pos+1])&0x0FFF; pos+=2
        elif it==11:  # I042 cartesian
            if pos+4>len(block): trunc=True;break
            xr=int.from_bytes(block[pos:pos+2],'big',signed=True)
            yr=int.from_bytes(block[pos+2:pos+4],'big',signed=True)
            f['x']=xr/128.0; f['y']=yr/128.0; pos+=4
        elif it==12:  # I200 velocity polar
            if pos+4>len(block): trunc=True;break
            gr=(block[pos]<<8)|block[pos+1]; hr=(block[pos+2]<<8)|block[pos+3]
            f['gsp']=gr*3600.0/16384.0; f['hdg']=hr*360.0/65536.0; pos+=4
        elif it==13:  # I170 track status (FX)
            if pos>=len(block): trunc=True;break
            fb=block[pos]
            f['cnf']=(fb>>7)&1; f['rad']=(fb>>5)&3
            c=skip_fx(block,pos)
            if c==0: trunc=True;break
            pos+=c
        elif it==14:  # I210 track quality
            if pos+4>len(block): trunc=True;break
            pos+=4
        elif it==15:  # I030 warning/error (FX)
            c=skip_fx(block,pos)
            if c==0: trunc=True;break
            pos+=c
        elif it==16:  # I080 Mode-3/A confidence
            if pos+2>len(block): trunc=True;break
            pos+=2
        elif it==17:  # I100 Mode-C code & confidence
            if pos+4>len(block): trunc=True;break
            raw=(block[pos]<<8)|block[pos+1]
            v=(raw>>15)&1; g=(raw>>14)&1
            f['modec_v']=v; f['modec_g']=g
            f['modec_present']=True
            pos+=4
        elif it==18:  # I110 height 3D
            if pos+2>len(block): trunc=True;break
            raw=(block[pos]<<8)|block[pos+1]; u=raw&0x3FFF
            f['h3d']=(u-0x4000 if u&0x2000 else u)*25.0; pos+=2
        elif it==19:  # I120 radial doppler (compound)
            if pos>=len(block): trunc=True;break
            sub=block[pos]; pos+=1; ok=True
            if (sub>>7)&1:
                if pos+2>len(block): ok=False
                else: pos+=2
            if ok and (sub>>6)&1:
                if pos>=len(block): ok=False
                else:
                    rep=block[pos]; pos+=1; sz=rep*6
                    if pos+sz>len(block): ok=False
                    else: pos+=sz
            if not ok: trunc=True;break
        elif it==20:  # I230 comm/ACAS capability & flight status
            if pos+2>len(block): trunc=True;break
            raw=(block[pos]<<8)|block[pos+1]
            f['com']=(raw>>13)&7; f['stat']=(raw>>10)&7
            f['arc']=(raw>>5)&1; f['aic']=(raw>>4)&1
            pos+=2
        elif it==21:  # I260 ACAS RA
            if pos+7>len(block): trunc=True;break
            f['i260']=True; pos+=7
        elif it==22:  # I055 Mode-1
            if pos+1>len(block): trunc=True;break
            b=block[pos]
            if not ((b>>7)&1) and not ((b>>6)&1): f['mode1']=b&0x1F
            pos+=1
        elif it==23:  # I050 Mode-2
            if pos+2>len(block): trunc=True;break
            if not ((block[pos]>>7)&1) and not ((block[pos]>>6)&1):
                f['mode2']=((block[pos]&0x0F)<<8)|block[pos+1]
            pos+=2
        elif it==24:  # I065 Mode-1 confidence
            if pos+1>len(block): trunc=True;break
            pos+=1
        elif it==25:  # I060 Mode-2 confidence
            if pos+2>len(block): trunc=True;break
            pos+=2
        elif it==26:  # SP
            if pos>=len(block): trunc=True;break
            ln=block[pos]
            if ln<1 or pos+ln>len(block): trunc=True;break
            pos+=ln
        elif it==27:  # RE
            if pos>=len(block): trunc=True;break
            ln=block[pos]
            if ln<1 or pos+ln>len(block): trunc=True;break
            pos+=ln
        else:
            trunc=True;break

    for it in present: s.present[it]+=1
    if sac is not None: s.sac_sic[(sac,sic)]+=1
    # 값 통계는 (선택) 주 레이더로 필터 + truncated 제외
    clean = (not trunc) and (only_sac is None or (sac,sic)==only_sac)
    if clean:
        if 'tod' in f: s.tod.add(f['tod'])
        if 'rho' in f and 0.1<=f['rho']<256: s.rho.add(f['rho'])
        if 'theta' in f: s.theta.add(f['theta'])
        if 'fl' in f and -10<=f['fl']<=1300: s.fl.add(f['fl'])
        if 'gsp' in f and f['gsp']<=2000: s.gsp.add(f['gsp'])
        if 'hdg' in f: s.hdg.add(f['hdg'])
        if 'x' in f: s.x.add(f['x'])
        if 'y' in f: s.y.add(f['y'])
        if 'h3d' in f: s.height3d.add(f['h3d'])
        if 'typ' in f: s.typ[f['typ']]+=1
        if 'sim' in f: s.sim[f['sim']]+=1
        if 'rdp' in f: s.rdp[f['rdp']]+=1
        if 'spi' in f: s.spi[f['spi']]+=1
        if 'rab' in f: s.rab[f['rab']]+=1
        if 'modes' in f: s.modes["%06X"%f['modes']]+=1
        if 'm3a' in f: s.mode3a.add(f['m3a'])
        if f.get('m3a_g'): s.m3a_garbled+=1
        if 'callsign' in f and f['callsign']: s.callsigns[f['callsign']]+=1
        if 'trk' in f: s.trk.add(f['trk'])
        if 'com' in f: s.com[f['com']]+=1
        if 'stat' in f: s.stat[f['stat']]+=1
        if 'arc' in f: s.arc[f['arc']]+=1
        if 'aic' in f: s.aic[f['aic']]+=1
        if 'cnf' in f: s.cnf[f['cnf']]+=1
        if 'rad' in f: s.rad[f['rad']]+=1
        if f.get('modec_present'): s.modec_present+=1
        for bp in f.get('bds',[]): s.bds[bp]+=1
        if f.get('i260'): s.i260+=1
        if 'mode1' in f: s.mode1.add(f['mode1'])
        if 'mode2' in f: s.mode2.add(f['mode2'])
    return pos, trunc

# ─────────────────────── CAT034 ───────────────────────
C34 = [("I010","034/010"),("I000","034/000"),("I030","034/030"),("I020","034/020"),
       ("I041","034/041"),("I050","034/050"),("I060","034/060"),("I070","034/070"),
       ("I100","034/100"),("I110","034/110"),("I120","034/120"),("I090","034/090"),
       ("RE","RE"),("SP","SP")]
C34_MAX = 14

class S34:
    def __init__(s):
        s.records=0; s.present=Counter(); s.sac_sic=Counter()
        s.msgtype=Counter(); s.tod=Acc(); s.sector=set(); s.antspeed=Counter()

def dec34(block, off, s):
    present,pos=parse_fspec(block,off,C34_MAX)
    if present is None: return None
    sac=None
    for it in present:
        if pos>=len(block): break
        if it==0:  # I010
            if pos+2>len(block): break
            sac=(block[pos],block[pos+1]); s.sac_sic[sac]+=1; pos+=2
        elif it==1:  # I000 message type
            if pos+1>len(block): break
            s.msgtype[block[pos]]+=1; pos+=1
        elif it==2:  # I030 TOD
            if pos+3>len(block): break
            raw=(block[pos]<<16)|(block[pos+1]<<8)|block[pos+2]; s.tod.add(raw/128.0); pos+=3
        elif it==3:  # I020 sector number
            if pos+1>len(block): break
            s.sector.add(round(block[pos]*360.0/256.0,1)); pos+=1
        elif it==4:  # I041 antenna rotation speed
            if pos+2>len(block): break
            raw=(block[pos]<<8)|block[pos+1]; s.antspeed[round(raw/128.0,2)]+=1; pos+=2
        elif it==5:  # I050 system config & status (compound, FX primary subfield)
            c=skip_fx(block,pos)
            if c==0: break
            # 정확한 길이 디코드는 생략 (가변 compound) — primary subfield만 스킵 후 중단
            pos+=c; break
        else:
            break  # 이후 항목은 정밀 길이 디코드 생략
    for it in present: s.present[it]+=1
    return pos

# ─────────────────────── CAT008 ───────────────────────
C08 = [("I010","008/010"),("I000","008/000"),("I020","008/020"),("I036","008/036"),
       ("I034","008/034"),("I040","008/040"),("I050","008/050"),("I090","008/090"),
       ("I100","008/100"),("I110","008/110"),("I120","008/120"),("I038","008/038"),
       ("SP","SP"),("RE","RE")]
C08_MAX = 14

class S08:
    def __init__(s):
        s.records=0; s.present=Counter(); s.sac_sic=Counter(); s.msgtype=Counter(); s.tod=Acc()

def dec08(block, off, s):
    present,pos=parse_fspec(block,off,C08_MAX)
    if present is None: return None
    for it in present:
        if pos>=len(block): break
        if it==0:  # I010
            if pos+2>len(block): break
            s.sac_sic[(block[pos],block[pos+1])]+=1; pos+=2
        elif it==1:  # I000 message type
            if pos+1>len(block): break
            s.msgtype[block[pos]]+=1; pos+=1
        else:
            break  # 가변 벡터 항목 정밀 디코드 생략
    for it in present: s.present[it]+=1
    return pos

# ─────────────────────── 프레임/블록 스캐너 (codebase 미러) ───────────────────────
def detect_nec(data):
    scan=min(len(data),100_000)
    for i in range(scan-8):
        b0,b1,b2,b3=data[i],data[i+1],data[i+2],data[i+3]
        if not(1<=b0<=12 and 1<=b1<=31 and b2<=23 and b3<=59): continue
        if i+5>=len(data): continue
        if data[i+5] not in (CAT048,CAT034,CAT008): continue
        if i+8>len(data): continue
        blen=(data[i+6]<<8)|data[i+7]
        if blen<3 or blen>MAX_BLOCK_LEN: continue
        nxt=i+5+blen
        if nxt+4<scan and data[nxt]==b0 and data[nxt+1]==b1 and data[nxt+2]<=23 and data[nxt+3]<=59:
            return (b0,b1)
    return None

def is_nec(data,o,m,d):
    if o+5>len(data): return False
    if data[o]!=m or data[o+1]!=d: return False
    if data[o+2]>23 or data[o+3]>59: return False
    if o+5>=len(data): return True
    a=data[o+5]
    return a in (CAT048,CAT034,CAT008) or a==m

def valid_block(data,o):
    if o+3>len(data): return False
    if data[o] not in (CAT048,CAT034,CAT008): return False
    ln=(data[o+1]<<8)|data[o+2]
    return 3<=ln<=MAX_BLOCK_LEN and o+ln<=len(data)

def main():
    path=sys.argv[1]
    data=open(path,'rb').read()
    n=len(data)
    nec=detect_nec(data)
    s48,s34,s08=S48(),S34(),S08()
    cat_blocks=Counter()
    nec_frames=0; nec_times=set()
    only=(116,1)  # 주 레이더 (정밀 값 통계 필터)
    o=0
    while o<n:
        if nec and is_nec(data,o,nec[0],nec[1]):
            nec_frames+=1; nec_times.add((data[o+2],data[o+3])); o+=5; continue
        if valid_block(data,o):
            cat=data[o]; blen=(data[o+1]<<8)|data[o+2]; cat_blocks[cat]+=1
            block=data[o:o+blen]
            if cat==CAT048:
                rec=3
                while rec<len(block):
                    r=dec48(block,rec,s48,only)
                    if r is None: break
                    nxt,tr=r; s48.records+=1
                    if tr: s48.truncated+=1
                    if nxt<=rec: break
                    rec=nxt
            elif cat==CAT034:
                rec=3
                while rec<len(block):
                    r=dec34(block,rec,s34)
                    if r is None or r<=rec: break
                    s34.records+=1; rec=r
                    break  # 서비스 메시지는 보통 블록당 1레코드
            elif cat==CAT008:
                rec=3
                while rec<len(block):
                    r=dec08(block,rec,s08)
                    if r is None or r<=rec: break
                    s08.records+=1; rec=r
                    break
            o+=blen; continue
        o+=1

    out={
      "file":path,"size":n,"nec_date":nec,"nec_frames":nec_frames,
      "nec_times":sorted("%02d:%02d"%(h,m) for h,m in nec_times),
      "cat_blocks":{("CAT%03d"%c):v for c,v in cat_blocks.items()},
      "cat048":{
        "records":s48.records,"truncated":s48.truncated,
        "filter_radar":"SAC=%d/SIC=%d"%only,
        "present":{C48[i][0]:s48.present[i] for i in range(C48_MAX)},
        "sac_sic_top":sorted({("%d/%d"%k):v for k,v in s48.sac_sic.items()}.items(),key=lambda x:-x[1])[:6],
        "tod_h":[round(x/3600,3) if x is not None else None for x in s48.tod.rng()],
        "rho_nm":s48.rho.rng(),"theta_deg":s48.theta.rng(),
        "fl":s48.fl.rng(),"gsp_kts":s48.gsp.rng(),"hdg_deg":s48.hdg.rng(),
        "x_nm":s48.x.rng(),"y_nm":s48.y.rng(),"height3d_ft":s48.height3d.rng(),
        "typ":dict(s48.typ),"sim":dict(s48.sim),"rdp":dict(s48.rdp),"spi":dict(s48.spi),"rab":dict(s48.rab),
        "modes_count":len(s48.modes),
        "modes_top":s48.modes.most_common(20),
        "mode3a_count":len(s48.mode3a),"m3a_garbled":s48.m3a_garbled,
        "callsign_count":len(s48.callsigns),
        "callsign_top":s48.callsigns.most_common(50),
        "trk_count":len(s48.trk),
        "com":dict(s48.com),"stat":dict(s48.stat),"arc":dict(s48.arc),"aic":dict(s48.aic),
        "cnf":dict(s48.cnf),"rad":dict(s48.rad),
        "modec_present":s48.modec_present,
        "i260":s48.i260,
        "mode1_count":len(s48.mode1),"mode2_count":len(s48.mode2),
        "bds_top":sorted({("%d,%d"%k):v for k,v in s48.bds.items()}.items(),key=lambda x:-x[1])[:25],
      },
      "cat034":{
        "records":s34.records,
        "present":{C34[i][0]:s34.present[i] for i in range(C34_MAX)},
        "msgtype":dict(s34.msgtype),"tod_h":[round(x/3600,3) if x is not None else None for x in s34.tod.rng()],
        "sector_count":len(s34.sector),"antspeed_top":s34.antspeed.most_common(5),
        "sac_sic_top":sorted({("%d/%d"%k):v for k,v in s34.sac_sic.items()}.items(),key=lambda x:-x[1])[:4],
      },
      "cat008":{
        "records":s08.records,
        "present":{C08[i][0]:s08.present[i] for i in range(C08_MAX)},
        "msgtype":dict(s08.msgtype),
        "sac_sic_top":sorted({("%d/%d"%k):v for k,v in s08.sac_sic.items()}.items(),key=lambda x:-x[1])[:4],
      },
    }
    json.dump(out,open('asterix_report.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)
    # 콘솔 요약
    print("size=%d nec=%s frames=%d" % (n,nec,nec_frames))
    print("blocks:",out["cat_blocks"])
    print("CAT048 records=%d trunc=%d callsigns=%d modes=%d" %
          (s48.records,s48.truncated,len(s48.callsigns),len(s48.modes)))
    print("  TYP:",dict(s48.typ))
    print("  COM:",dict(s48.com)," STAT:",dict(s48.stat)," ARC:",dict(s48.arc))
    print("  CNF:",dict(s48.cnf)," RAD:",dict(s48.rad)," ModeC_present:",s48.modec_present)
    print("  callsign top:",s48.callsigns.most_common(15))
    print("  modes top:",s48.modes.most_common(10))
    print("  height3d ft:",s48.height3d.rng()," mode1:",len(s48.mode1)," mode2:",len(s48.mode2))
    print("CAT034 records=%d msgtype=%s antspeed_top=%s sectors=%d" %
          (s34.records,dict(s34.msgtype),s34.antspeed.most_common(3),len(s34.sector)))
    print("CAT008 records=%d msgtype=%s" % (s08.records,dict(s08.msgtype)))

if __name__=="__main__":
    main()
