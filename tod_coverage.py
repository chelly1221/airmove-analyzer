#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NEC ASS 파일 시간 커버리지 분석기 (헤더 전용 고속 스캐너).

각 NEC 프레임 헤더 [월][일][시][분] 을 절대 분(minute) 타임스탬프로 환산하고,
그 뒤에 오는 CAT048/034/008 블록을 해당 분에 귀속시켜 분 단위 커버리지를 만든다.
블록 본문은 디코드하지 않고 길이로 건너뛰므로 매우 빠르다.

목적: 원본 녹화 자체에 시간 공백이 있는지(소스 문제) vs 파서/필터 때문인지 구분.
 - CAT034(서비스 메시지: 노스마커/섹터/안테나회전)는 표적 유무와 무관하게 연속 발생
   → CAT034 분 커버리지 = 녹화가 연속인지 여부의 지표.
 - CAT048(표적 plot)은 표적이 범위 내 있을 때만 발생
   → CAT048 공백은 '교통 없음'일 수 있어 정상일 수 있음.
"""
import sys, glob, json
from collections import defaultdict

CAT048, CAT034, CAT008 = 0x30, 0x22, 0x08
MAX_BLOCK_LEN = 65535
DAYS_CUM = [0,31,59,90,120,151,181,212,243,273,304,334]  # 비윤년 월 누적일(분석 구간 2~3월용)

def detect_nec(data):
    scan = min(len(data), 100_000)
    for i in range(scan-8):
        b0,b1,b2,b3 = data[i],data[i+1],data[i+2],data[i+3]
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
    # 앱 파서 미러: 단일 (월,일)에 고정 — 자정(KST) 이후 인식 안 됨
    if o+5>len(data): return False
    if data[o]!=m or data[o+1]!=d: return False
    if data[o+2]>23 or data[o+3]>59: return False
    if o+5>=len(data): return True
    a=data[o+5]
    return a in (CAT048,CAT034,CAT008) or a==m

def is_nec_anydate(data,o):
    # 날짜 비고정 버전: 어떤 유효 날짜의 프레임도 인식 (진짜 소스 커버리지용)
    if o+6>len(data): return False
    b0,b1,b2,b3=data[o],data[o+1],data[o+2],data[o+3]
    if not(1<=b0<=12 and 1<=b1<=31 and b2<=23 and b3<=59): return False
    a=data[o+5]
    return a in (CAT048,CAT034,CAT008)

def valid_block(data,o):
    if o+3>len(data): return False
    if data[o] not in (CAT048,CAT034,CAT008): return False
    ln=(data[o+1]<<8)|data[o+2]
    return 3<=ln<=MAX_BLOCK_LEN and o+ln<=len(data)

def abs_min(mo,dy,hh,mm):
    return (DAYS_CUM[mo-1]+(dy-1))*1440 + hh*60 + mm

def min_to_str(m):
    dday = m // 1440
    rem = m % 1440
    # 월/일 역산 (분석 구간은 2~3월이라 단순 처리)
    doy = m // 1440  # day-of-year-ish (0-based from Jan1)
    mo = 1
    for i in range(11,-1,-1):
        if doy >= DAYS_CUM[i]:
            mo = i+1; break
    dy = doy - DAYS_CUM[mo-1] + 1
    return "%02d-%02d %02d:%02d" % (mo, dy, rem//60, rem%60)

def gaps_from_set(present_set, lo, hi, min_len):
    """present_set 의 [lo,hi] 범위 내 연속 빈 구간(분) 목록 (길이>=min_len)."""
    out=[]
    run_start=None
    for m in range(lo, hi+1):
        if m not in present_set:
            if run_start is None: run_start=m
        else:
            if run_start is not None:
                length=m-run_start
                if length>=min_len: out.append((run_start, m-1, length))
                run_start=None
    if run_start is not None:
        length=hi+1-run_start
        if length>=min_len: out.append((run_start, hi, length))
    return out

def analyze(path):
    data=open(path,'rb').read()
    n=len(data)
    nec=detect_nec(path and data)
    frames_per_min=defaultdict(int)
    c48_per_min=defaultdict(int)
    c34_per_min=defaultdict(int)
    c08_per_min=defaultdict(int)
    nec_frames=0; tot48=tot34=tot08=0
    c48_locked=0          # 앱(단일 날짜 고정)이 동기 유지하는 동안의 CAT048 수
    locked_end=None       # 날짜 고정 윈도우의 마지막 분
    cur=None  # 현재 절대 분
    cur_locked=False      # 현재 프레임이 detect 날짜(m0,d0)와 동일한가
    o=0
    if nec is None:
        return {"file":path,"error":"NEC 헤더 미검출"}
    m0,d0 = nec
    while o<n:
        if is_nec_anydate(data,o):
            mo=data[o]; dy=data[o+1]; hh=data[o+2]; mm=data[o+3]
            cur=abs_min(mo,dy,hh,mm)
            cur_locked=(mo==m0 and dy==d0)
            if cur_locked: locked_end=cur
            frames_per_min[cur]+=1
            nec_frames+=1
            o+=5; continue
        if valid_block(data,o):
            cat=data[o]; blen=(data[o+1]<<8)|data[o+2]
            if cur is not None:
                if cat==CAT048:
                    c48_per_min[cur]+=1; tot48+=1
                    if cur_locked: c48_locked+=1
                elif cat==CAT034: c34_per_min[cur]+=1; tot34+=1
                elif cat==CAT008: c08_per_min[cur]+=1; tot08+=1
            o+=blen; continue
        o+=1

    if not frames_per_min:
        return {"file":path,"error":"프레임 없음"}

    lo=min(frames_per_min); hi=max(frames_per_min)
    span=hi-lo+1
    fset=set(frames_per_min)
    set48=set(c48_per_min)
    set34=set(c34_per_min)

    return {
        "file":path.split('/')[-1],
        "size_mb":round(n/1048576,1),
        "nec_md":[m0,d0],
        "start":min_to_str(lo),"end":min_to_str(hi),
        "span_min":span,"span_h":round(span/60,2),
        "nec_frames":nec_frames,"cat048":tot48,"cat034":tot34,"cat008":tot08,
        "locked_end":min_to_str(locked_end) if locked_end is not None else None,
        "c48_locked":c48_locked,
        "c48_after_midnight":tot48-c48_locked,
        "loss_pct":round(100*(tot48-c48_locked)/tot48,1) if tot48 else 0.0,
        "min_with_frame":len(fset),
        "min_with_c48":len(set48),
        "min_with_c34":len(set34),
        "cover_frame_pct":round(100*len(fset)/span,1),
        "cover_c34_pct":round(100*len(set34)/span,1),
        "cover_c48_pct":round(100*len(set48)/span,1),
        # 녹화 연속성 지표: 어떤 프레임이라도 없는 빈 구간 (>=2분)
        "frame_gaps":[(min_to_str(a),min_to_str(b),L) for a,b,L in gaps_from_set(fset,lo,hi,2)],
        # CAT034(서비스) 공백 (>=2분) — 진짜 녹화 끊김 지표
        "c34_gaps":[(min_to_str(a),min_to_str(b),L) for a,b,L in gaps_from_set(set34,lo,hi,2)],
        # CAT048(표적) 공백 (>=5분) — 교통 없음일 수도
        "c48_gaps":[(min_to_str(a),min_to_str(b),L) for a,b,L in gaps_from_set(set48,lo,hi,5)],
    }

def main():
    paths=sys.argv[1:]
    results=[]
    for p in sorted(paths):
        r=analyze(p)
        results.append(r)
        if "error" in r:
            print("== %s : %s" % (r["file"] if "file" in r else p, r["error"])); continue
        print("== %s  (%sMB)  %s → %s  span=%sh" %
              (r["file"], r["size_mb"], r["start"], r["end"], r["span_h"]))
        print("   frames=%d cat048=%d cat034=%d cat008=%d" %
              (r["nec_frames"], r["cat048"], r["cat034"], r["cat008"]))
        print("   분커버리지(소스): frame=%s%% (%d/%d)  CAT034=%s%%  CAT048=%s%%" %
              (r["cover_frame_pct"], r["min_with_frame"], r["span_min"],
               r["cover_c34_pct"], r["cover_c48_pct"]))
        print("   앱(날짜고정) 윈도우 끝=%s | CAT048 자정후 손실=%d/%d (%s%%)" %
              (r["locked_end"], r["c48_after_midnight"], r["cat048"], r["loss_pct"]))
        if r["c34_gaps"]:
            print("   ★ CAT034(녹화) 공백 %d개:" % len(r["c34_gaps"]))
            for a,b,L in r["c34_gaps"][:20]:
                print("        %s ~ %s  (%d분)" % (a,b,L))
            if len(r["c34_gaps"])>20: print("        ... (+%d개)"%(len(r["c34_gaps"])-20))
        else:
            print("   ✓ CAT034 공백 없음 (녹화 연속)")
        if r["frame_gaps"] and not r["c34_gaps"]:
            print("   (참고) 프레임 공백 %d개 — 최대 %d분" %
                  (len(r["frame_gaps"]), max(L for _,_,L in r["frame_gaps"])))
        print()
    json.dump(results, open('tod_coverage.json','w',encoding='utf-8'), ensure_ascii=False, indent=2)
    print("→ tod_coverage.json 저장 (%d개 파일)"%len([r for r in results if 'error' not in r]))

if __name__=="__main__":
    main()
