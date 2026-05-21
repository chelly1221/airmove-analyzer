#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""asterix_report.json + 항목 메타데이터 → 단일 HTML 보고서 생성."""
import json, html, datetime

D = json.load(open('asterix_report.json', encoding='utf-8'))
C48, C34, C08 = D['cat048'], D['cat034'], D['cat008']

def esc(x): return html.escape(str(x))
def fmtn(x):
    try: return f"{int(x):,}"
    except: return esc(x)
def rng(r, unit='', nd=2):
    if not r or r[0] is None: return '—'
    a,b = r
    fa = f"{a:,.{nd}f}".rstrip('0').rstrip('.') if isinstance(a,float) else str(a)
    fb = f"{b:,.{nd}f}".rstrip('0').rstrip('.') if isinstance(b,float) else str(b)
    return f"{fa} ~ {fb}{unit}"

# 사용여부 배지: used / partial / unused
USED, PARTIAL, UNUSED = 'used','partial','unused'

# ─── CAT048 항목 메타데이터 (이름, 설명, 포맷/인코딩, 앱사용) ───
M48 = {
 "I010":("데이터 출처 식별자 (Data Source Identifier)",
   "이 보고를 생성한 레이더(센서)를 식별. SAC(System Area Code)+SIC(System Identification Code) 2바이트.",
   "2바이트: SAC, SIC", USED, "분석 대상 레이더 식별. 본 파일의 주 레이더는 SAC=116/SIC=1."),
 "I140":("측정 시각 (Time of Day)",
   "UTC 자정 기준 경과 시간. 24비트, LSB = 1/128초. 자정 교차·일간 보정에 사용.",
   "3바이트, LSB 1/128 s", USED, "타임스탬프 산출의 핵심. 항적 시계열·Loss 구간 계산 기준."),
 "I020":("표적 보고 기술자 (Target Report Descriptor)",
   "탐지 종류와 속성 비트필드. TYP(탐지유형 3비트), SIM(모의), RDP(처리체인), SPI(특별식별), RAB(고정변환기).",
   "가변(FX). 1바이트+확장", USED, "TYP로 6종 레이더 탐지유형 분류, SIM으로 모의표적 식별."),
 "I040":("극좌표 측정 위치 (Measured Position in Polar)",
   "레이더 기준 거리(RHO)·방위(THETA). 극좌표→WGS84 변환의 1차 입력.",
   "RHO 16비트(LSB 1/256 NM) + THETA 16비트(LSB 360/2¹⁶°)", USED, "lat/lon 변환의 주 위치원. 자북→진북 편각 보정 적용."),
 "I070":("Mode-3/A 코드 (8진 SSR 코드)",
   "관제용 4자리 8진 트랜스폰더 코드(스쿼크). V(검증)·G(garbled)·L 플래그 포함.",
   "2바이트: V,G,L + 12비트 8진", USED, "ATCRBS(Mode-S 미식별) 포인트를 Mode-S 항적에 병합할 때 매핑 키로 사용."),
 "I090":("기압고도 (Flight Level, 기압식)",
   "표준기압면 기준 비행고도. 14비트 부호화, LSB = 1/4 FL(=25ft).",
   "2바이트: V,G + 14비트 부호 LSB 0.25FL", USED, "고도(m) 산출: FL×100ft. 항적 고도·LOS·커버리지 분석에 사용."),
 "I130":("레이더 플롯 특성 (Radar Plot Characteristics)",
   "플롯 품질 지표. 부필드: SRL(SSR응답 폭), SRR(응답 수), SAM(SSR진폭), PRL(PSR런 길이), PAM(PSR진폭), RPD(거리차), APD(방위차).",
   "1바이트 부필드 FSPEC + 부필드별 1바이트", UNUSED, "플롯 신뢰도·PSR/SSR 일치도 평가에 활용 가능(현재 미사용)."),
 "I220":("항공기 주소 (Aircraft Address, Mode-S)",
   "24비트 ICAO 고유 주소(16진 6자리). 전 세계 항공기 1:1 식별자.",
   "3바이트: 24비트 ICAO 주소", USED, "항적의 1차 식별 키(mode_s). 비행 그룹핑·중복제거의 기준."),
 "I240":("항공기 식별 (Aircraft Identification, 콜사인)",
   "조종사가 입력한 호출부호/편명(예: KAL123). 8문자, ICAO 6비트 IA-5 인코딩.",
   "6바이트: 8문자 × 6비트", UNUSED, "★ 파일에 콜사인이 있으나 현재 미디코드. 항공기 자동 식별·표시에 직접 활용 가능."),
 "I250":("Mode-S MB 데이터 (Comm-B 다운링크)",
   "Mode-S 트랜스폰더가 다운링크한 BDS 레지스터 묶음. 각 7바이트 MB + BDS 라벨. ELS/EHS 향상감시 정보의 원천.",
   "1바이트 REP + REP×8바이트", PARTIAL, "★ 현재 BDS 3,0(ACAS RA)·1,6(조정응답)만 추출. BDS 2,0/4,0/5,0/6,0(콜사인·선택고도·자세·속도)는 미사용."),
 "I161":("트랙 번호 (Track Number)",
   "레이더 추적기가 부여한 12비트 로컬 트랙 ID. 동일 스캔 내 다중표적 구분.",
   "2바이트: 12비트", USED, "유령표적 탐지(동일 스캔 다중 포인트 구분) 보조 데이터로 사용."),
 "I042":("직교좌표 계산 위치 (Calculated Position Cartesian)",
   "레이더 추적기가 계산한 X/Y 좌표(시스템 직교계). 16비트 부호, LSB 1/128 NM.",
   "4바이트: X,Y 16비트 부호 LSB 1/128 NM", USED, "I040(극좌표)가 없을 때 위치 폴백으로 사용."),
 "I200":("계산 속도 (Calculated Track Velocity, 극형식)",
   "추적기 산출 대지속도(GS)·진행방위. GS LSB 2⁻¹⁴ NM/s, 방위 LSB 360/2¹⁶°.",
   "4바이트: GS 16비트 + HDG 16비트", USED, "항적 속도(kts)·방위 표시 및 통계에 사용."),
 "I170":("트랙 상태 (Track Status)",
   "추적 상태 비트필드: CNF(확정/잠정), RAD(센서종류 PSR/SSR/ModeS), DOU(의심), MAH(수평기동), CDM(상승강하), GHO(유령) 등.",
   "가변(FX). 1바이트+확장", UNUSED, "확정/잠정·기동상태로 항적 품질 필터링 가능(현재 미사용)."),
 "I210":("트랙 품질 (Track Quality)",
   "추적 추정 표준편차(σX, σY, σV, σH). 위치·속도 추정 정확도.",
   "4바이트", UNUSED, "추적 신뢰도 가중·이상치 판정에 활용 가능(현재 미사용)."),
 "I030":("경고/오류 상태 (Warning/Error Conditions)",
   "플롯/트랙 처리 중 발생한 W/E 조건 코드 목록(7비트 코드 + FX).",
   "가변(FX). 7비트 코드열", UNUSED, "데이터 품질 진단·필터링에 활용 가능(현재 미사용)."),
 "I080":("Mode-3/A 신뢰도 (Code Confidence)",
   "Mode-3/A 각 비트의 신뢰도 맵.",
   "2바이트", UNUSED, "스쿼크 garble 판정 보조(현재 미사용)."),
 "I100":("Mode-C 코드·신뢰도 (Mode-C Code and Confidence)",
   "원시 Mode-C 응답(Gray 코드 고도)과 비트 신뢰도. I090과 별개의 고도원.",
   "4바이트: V,G + 12비트 Gray + 신뢰도", UNUSED, "I090 보완 고도원·고도 garble 교차검증 가능(현재 미사용)."),
 "I110":("3D 레이더 측정 고도 (Height Measured by 3D Radar)",
   "3차원 레이더의 기하 측정 고도. 14비트 부호, LSB 25ft. (2D 레이더는 미보고)",
   "2바이트: 14비트 부호 LSB 25 ft", UNUSED, "3D 레이더 한정. 본 파일 주 레이더는 미보고(2D)."),
 "I120":("레이더 시선속도 (Radial Doppler Speed)",
   "도플러 기반 시선방향 속도(접근/이탈). 계산속도(CAL)+원시도플러(RDS) 부필드.",
   "1바이트 부필드 + CAL/RDS", UNUSED, "기상/이동표적 판별 보조(현재 미사용)."),
 "I230":("통신/ACAS 능력·비행상태 (Comm/ACAS Capability & Flight Status)",
   "COM(통신능력), STAT(비행상태: 공중/지상·경보·SPI), SI, MSSC, ARC(고도분해능 25/100ft), AIC(식별능력), B1A/B1B.",
   "2바이트 비트필드", UNUSED, "★ ACAS 탑재여부·고도분해능·지상/공중 상태 판정 가능(현재 미사용)."),
 "I260":("ACAS 충돌회피 권고 보고 (ACAS RA Report)",
   "TCAS/ACAS가 생성한 RA(Resolution Advisory) 7바이트. BDS 3,0 등가 페이로드.",
   "7바이트", USED, "★ TCAS RA 분석 페이지의 핵심 입력. 트랙 독립으로 전수 추출."),
 "I055":("Mode-1 코드 (군용)",
   "군용 Mode-1 미션 코드(5비트 8진). V,G,L 플래그.",
   "1바이트: V,G,L + 5비트", UNUSED, "군용. 본 파일 주 레이더는 미보고(민간 김포)."),
 "I050":("Mode-2 코드 (군용)",
   "군용 Mode-2 코드(12비트 8진). V,G,L 플래그.",
   "2바이트: V,G,L + 12비트", UNUSED, "군용. 본 파일 주 레이더는 미보고."),
 "I065":("Mode-1 신뢰도", "Mode-1 비트 신뢰도 맵.", "1바이트", UNUSED, "군용. 미보고."),
 "I060":("Mode-2 신뢰도", "Mode-2 비트 신뢰도 맵.", "2바이트", UNUSED, "군용. 미보고."),
 "SP":("특수목적 필드 (Special Purpose Field)",
   "벤더(NEC) 정의 비표준 데이터. 길이 지시자 + 내용.",
   "1바이트 LEN + 내용", UNUSED, "NEC 고유 확장. 사양 비공개로 미해석."),
 "RE":("예약 확장 필드 (Reserved Expansion Field)",
   "ASTERIX 확장 항목(신규 데이터 항목 컨테이너). 길이 지시자 + 내용.",
   "1바이트 LEN + 내용", UNUSED, "확장 데이터 컨테이너. 현재 미해석."),
}
# 측정 통계 매핑(있으면 표에 표시)
V48 = {
 "I010": ("주 출처 " + (C48['sac_sic_top'][0][0] if C48['sac_sic_top'] else '—')),
 "I140": rng(C48['tod_h'],' h',3),
 "I020": f"TYP {len(C48['typ'])}종 · SIM={C48['sim'].get('1',0):,}건",
 "I040": f"RHO {rng(C48['rho_nm'],' NM')} · THETA {rng(C48['theta_deg'],'°')}",
 "I070": f"고유 스쿼크 {C48['mode3a_count']:,} · garbled {C48['m3a_garbled']:,}",
 "I090": rng(C48['fl'],' FL'),
 "I220": f"고유 항공기 {C48['modes_count']:,}대",
 "I240": f"고유 콜사인 {C48['callsign_count']:,}개",
 "I250": "BDS 레지스터 다수(아래 표)",
 "I161": f"고유 트랙 {C48['trk_count']:,}",
 "I042": f"X {rng(C48['x_nm'],' NM')} · Y {rng(C48['y_nm'],' NM')}",
 "I200": f"GS {rng(C48['gsp_kts'],' kt')} · HDG {rng(C48['hdg_deg'],'°')}",
 "I170": f"CNF 확정 {C48['cnf'].get('0',0):,}/잠정 {C48['cnf'].get('1',0):,}",
 "I100": f"존재 {C48['modec_present']:,}건",
 "I110": rng(C48['height3d_ft'],' ft'),
 "I230": f"ARC 25ft={C48['arc'].get('1',0):,}/100ft={C48['arc'].get('0',0):,}",
 "I260": f"RA 보고 {C48['i260']:,}건",
 "I055": f"{C48['mode1_count']}종",
 "I050": f"{C48['mode2_count']}종",
}

# ─── BDS 레지스터 의미 ───
BDS = {
 "2,0":"항공기 식별 (Aircraft Identification) — 콜사인",
 "4,0":"선택 수직 의도 (Selected Vertical Intention) — MCP/FCU 선택고도·기압설정",
 "5,0":"트랙·선회 보고 (Track and Turn Report) — 롤각·진트랙·지상속도·트랙변화율·TAS",
 "6,0":"방위·속도 보고 (Heading and Speed Report) — 자기방위·IAS·Mach·기압/관성 수직속도",
 "3,0":"ACAS 능동 RA (Active Resolution Advisory) — TCAS 회피권고",
 "1,6":"ACAS 조정 응답 (Coordination Reply)",
 "1,0":"데이터링크 능력 보고 (Data Link Capability Report)",
 "0,0":"무효/필러 (No information / filler)",
 "0,1":"BDS 0,1 (확장 능력 보고 계열)",
 "0,2":"링크 능력 보고(연속)",
 "7,4":"항법 데이터 계열",
}
def bds_name(code): return BDS.get(code, "기타 Comm-B 레지스터(라벨 추정)")

# ─── CAT048 TYP 코드 의미 ───
TYP = {0:"미탐지/무효(폐기)",1:"PSR 단독(폐기)",2:"SSR Mode A/C",3:"SSR+PSR (Mode A/C 결합)",
       4:"Mode S All-Call",5:"Mode S Roll-Call",6:"Mode S All-Call+PSR",7:"Mode S Roll-Call+PSR"}
COM = {0:"통신능력 없음",1:"Comm-A/Comm-B",2:"+Uplink ELM",3:"+Downlink ELM",4:"Level-5 트랜스폰더"}
STAT= {0:"경보無·SPI無·공중",1:"경보無·SPI無·지상",2:"경보有·SPI無·공중",3:"경보有·SPI無·지상",4:"경보有·SPI有",5:"경보無·SPI有",7:"미정의/불명"}

# ─── CAT034 / CAT008 메시지 타입 ───
MT34 = {1:"북마커 (North Marker) — 안테나 1회전 기준점",2:"섹터 통과 (Sector Crossing)",
        3:"지리적 필터링 (Geographical Filtering)",4:"재밍 스트로브 (Jamming Strobe)"}
MT08 = {1:"극좌표 벡터 (Polar Vector) — 기상 에코",2:"직교 시작/길이 벡터",3:"윤곽 레코드 (Contour)",
        4:"직교 시작/끝 벡터",254:"화면 시작 (SOP)",255:"화면 종료 (EOP)"}

M34 = {
 "I010":("데이터 출처 식별자","서비스 메시지를 보낸 레이더(SAC/SIC).","2바이트"),
 "I000":("메시지 타입","서비스 메시지 종류(북마커/섹터통과/필터링 등).","1바이트"),
 "I030":("측정 시각","메시지 생성 UTC 시각.","3바이트 LSB 1/128 s"),
 "I020":("섹터 번호","안테나가 통과한 방위 섹터(LSB 360/2⁸°).","1바이트"),
 "I041":("안테나 회전 주기","안테나 1회전 시간. LSB 1/128 s.","2바이트"),
 "I050":("시스템 구성·상태","COM/PSR/SSR/Mode-S 채널 운용상태(가변 compound).","가변"),
 "I060":("시스템 처리 모드","센서 처리 파라미터/모드(가변 compound).","가변"),
 "I070":("메시지 카운트 값","플롯/트랙 카운트 통계(REP×2).","가변"),
 "I100":("일반 극좌표 윈도우","서비스 적용 거리/방위 범위.","8바이트"),
 "I110":("데이터 필터","적용 중인 데이터 필터 종류.","1바이트"),
 "I120":("데이터 출처 3D 위치","센서 위경도·고도.","8바이트"),
 "I090":("콜리메이션 오차","거리·방위 보정값.","2바이트"),
 "RE":("예약 확장","확장 컨테이너.","가변"),
 "SP":("특수목적","벤더 정의.","가변"),
}
M08 = {
 "I010":("데이터 출처 식별자","기상정보를 보낸 레이더(SAC/SIC).","2바이트"),
 "I000":("메시지 타입","기상 메시지 종류(극좌표벡터/윤곽/SOP/EOP).","1바이트"),
 "I020":("벡터 한정자","강수 강도 레벨·도면 식별 등 벡터 속성.","가변(FX)"),
 "I036":("직교 벡터 시퀀스","직교계 기상 벡터 묶음.","REP×가변"),
 "I034":("극좌표 벡터 시퀀스","극좌표 기상 에코 벡터(방위·시작거리·길이).","REP×4바이트"),
 "I040":("윤곽 식별자","기상 윤곽(컨투어) ID.","4바이트"),
 "I050":("윤곽점 시퀀스","윤곽 구성 점열.","REP×2바이트"),
 "I090":("측정 시각","기상 화면 생성 UTC 시각.","3바이트 LSB 1/128 s"),
 "I100":("처리 상태","기상 처리 상태 플래그.","가변"),
 "I110":("스테이션 구성 상태","기상 채널 구성/상태.","가변"),
 "I120":("기상 화면 총 항목 수","1개 기상 화면을 구성하는 항목 총수.","2바이트"),
 "I038":("기상 벡터 시퀀스","강수 레벨별 벡터.","REP×가변"),
 "SP":("특수목적","벤더 정의.","가변"),
 "RE":("예약 확장","확장 컨테이너.","가변"),
}

# ───────────────── HTML 조립 ─────────────────
def badge(kind):
    t={'used':('사용중','b-used'),'partial':('부분사용','b-part'),'unused':('미사용','b-unused')}[kind]
    return f'<span class="badge {t[1]}">{t[0]}</span>'

def bar(count, total):
    pct = 0 if not total else min(100, count*100.0/total)
    return f'<div class="bar"><div class="barfill" style="width:{pct:.1f}%"></div></div><span class="barpct">{pct:.0f}%</span>'

total48 = C48['present'].get('I020', C48['records'])

# CAT048 항목 행
rows48=[]
for key,(name,desc,fmt,use,note) in M48.items():
    cnt=C48['present'].get(key,0)
    val=V48.get(key,'—')
    rows48.append(f"""
    <tr class="r-{use}">
      <td class="c-code">{esc(key)}<div class="sub">I048/{esc(key[1:]) if key[0]=='I' else esc(key)}</div></td>
      <td><div class="c-name">{esc(name)} {badge(use)}</div>
          <div class="c-desc">{esc(desc)}</div>
          <div class="c-fmt">📐 {esc(fmt)}</div>
          <div class="c-note">💡 {esc(note)}</div></td>
      <td class="c-count">{fmtn(cnt)}<div class="barwrap">{bar(cnt,total48)}</div></td>
      <td class="c-val">{esc(val)}</td>
    </tr>""")

# BDS 표
bds_rows=[]
for code,cnt in C48['bds_top']:
    bds_rows.append(f"<tr><td class='c-code'>BDS {esc(code)}</td><td>{esc(bds_name(code))}</td><td class='c-count'>{fmtn(cnt)}</td></tr>")

# 콜사인 표
cs_rows=[]
for cs,cnt in C48['callsign_top'][:40]:
    cs_rows.append(f"<tr><td>{esc(cs)}</td><td class='c-count'>{fmtn(cnt)}</td></tr>")

# Mode-S 표
ms_rows=[]
for ms,cnt in C48['modes_top']:
    flag = "🇰🇷 한국" if ms.startswith('71') else ("🇺🇸 미국" if ms.startswith('A') else "")
    ms_rows.append(f"<tr><td class='c-code'>{esc(ms)}</td><td>{esc(flag)}</td><td class='c-count'>{fmtn(cnt)}</td></tr>")

# TYP 분포
typ_rows=[]
for t in sorted(C48['typ'], key=lambda k:-C48['typ'][k]):
    typ_rows.append(f"<tr><td class='c-code'>{esc(t)}</td><td>{esc(TYP.get(int(t),'?'))}</td><td class='c-count'>{fmtn(C48['typ'][t])}</td></tr>")

# CAT034 항목
rows34=[]
for key,(name,desc,fmt) in M34.items():
    cnt=C34['present'].get(key,0)
    rows34.append(f"<tr><td class='c-code'>{esc(key)}</td><td><div class='c-name'>{esc(name)}</div><div class='c-desc'>{esc(desc)}</div><div class='c-fmt'>📐 {esc(fmt)}</div></td><td class='c-count'>{fmtn(cnt)}</td></tr>")
mt34_rows=[]
for t in sorted(C34['msgtype'], key=lambda k:-C34['msgtype'][k])[:6]:
    mt34_rows.append(f"<tr><td class='c-code'>{esc(t)}</td><td>{esc(MT34.get(int(t),'기타/노이즈'))}</td><td class='c-count'>{fmtn(C34['msgtype'][t])}</td></tr>")

# CAT008 항목
rows08=[]
for key,(name,desc,fmt) in M08.items():
    cnt=C08['present'].get(key,0)
    rows08.append(f"<tr><td class='c-code'>{esc(key)}</td><td><div class='c-name'>{esc(name)}</div><div class='c-desc'>{esc(desc)}</div><div class='c-fmt'>📐 {esc(fmt)}</div></td><td class='c-count'>{fmtn(cnt)}</td></tr>")
mt08_rows=[]
for t in sorted(C08['msgtype'], key=lambda k:-C08['msgtype'][k])[:5]:
    mt08_rows.append(f"<tr><td class='c-code'>{esc(t)}</td><td>{esc(MT08.get(int(t),'기타/노이즈'))}</td><td class='c-count'>{fmtn(C08['msgtype'][t])}</td></tr>")

ant = C34['antspeed_top'][0][0] if C34['antspeed_top'] else None
total_blocks = sum(D['cat_blocks'].values())
fname = D['file'].split('/')[-1]
gen_time = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')

HTML = f"""<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ASTERIX 데이터 분석 — {esc(fname)}</title>
<style>
:root{{--bg:#ffffff;--card:#f8f9fa;--accent:#a60739;--err:#e94560;--ink:#1a1a2e;--mut:#6b7280;--line:#e5e7eb;}}
*{{box-sizing:border-box;}}
body{{font-family:'Pretendard','Segoe UI',-apple-system,sans-serif;margin:0;background:var(--bg);color:var(--ink);line-height:1.6;}}
.wrap{{max-width:1180px;margin:0 auto;padding:32px 24px 80px;}}
header.hero{{background:linear-gradient(135deg,#a60739,#6d0426);color:#fff;border-radius:18px;padding:34px 36px;margin-bottom:28px;}}
header.hero h1{{margin:0 0 6px;font-size:26px;font-weight:800;letter-spacing:-.3px;}}
header.hero .file{{font-family:ui-monospace,Menlo,monospace;opacity:.92;font-size:14px;}}
header.hero .sub{{margin-top:14px;font-size:13.5px;opacity:.9;}}
.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin:0 0 30px;}}
.kpi{{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;}}
.kpi .v{{font-size:23px;font-weight:800;color:var(--accent);}}
.kpi .l{{font-size:12.5px;color:var(--mut);margin-top:3px;}}
h2{{font-size:20px;margin:42px 0 6px;padding-bottom:8px;border-bottom:3px solid var(--accent);display:flex;align-items:center;gap:10px;}}
h2 .tag{{font-size:12px;font-weight:600;background:var(--accent);color:#fff;padding:2px 10px;border-radius:20px;}}
h3{{font-size:16px;margin:26px 0 10px;color:var(--accent);}}
p.lead{{color:#374151;font-size:14.5px;margin:6px 0 18px;}}
table{{width:100%;border-collapse:collapse;font-size:13.5px;background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden;}}
th{{background:#fafafa;text-align:left;padding:11px 13px;font-size:12.5px;color:var(--mut);border-bottom:2px solid var(--line);font-weight:700;}}
td{{padding:11px 13px;border-bottom:1px solid var(--line);vertical-align:top;}}
tr:last-child td{{border-bottom:none;}}
.c-code{{font-family:ui-monospace,monospace;font-weight:700;color:var(--ink);white-space:nowrap;}}
.c-code .sub{{font-weight:400;font-size:11px;color:var(--mut);}}
.c-name{{font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}}
.c-desc{{color:#374151;margin-top:3px;}}
.c-fmt{{color:var(--mut);font-size:12px;margin-top:5px;font-family:ui-monospace,monospace;}}
.c-note{{color:#7c3aed;font-size:12.5px;margin-top:5px;}}
.c-count{{font-family:ui-monospace,monospace;font-weight:700;text-align:right;white-space:nowrap;}}
.c-val{{font-size:12.5px;color:#374151;}}
.badge{{font-size:11px;font-weight:700;padding:2px 9px;border-radius:20px;white-space:nowrap;}}
.b-used{{background:#dcfce7;color:#166534;}}
.b-part{{background:#fef9c3;color:#854d0e;}}
.b-unused{{background:#fee2e2;color:#991b1b;}}
.r-unused{{background:#fffafa;}}
.barwrap{{display:flex;align-items:center;gap:6px;margin-top:6px;justify-content:flex-end;}}
.bar{{width:80px;height:6px;background:#eee;border-radius:4px;overflow:hidden;}}
.barfill{{height:100%;background:var(--accent);}}
.barpct{{font-size:11px;color:var(--mut);width:30px;text-align:right;}}
.cols{{display:grid;grid-template-columns:1fr 1fr;gap:22px;}}
@media(max-width:760px){{.cols{{grid-template-columns:1fr;}}}}
.note{{background:#fff7ed;border:1px solid #fed7aa;border-left:4px solid #f59e0b;border-radius:10px;padding:14px 16px;font-size:13px;color:#7c2d12;margin:16px 0;}}
.note.info{{background:#eff6ff;border-color:#bfdbfe;border-left-color:#3b82f6;color:#1e3a5f;}}
.note.warn{{background:#fef2f2;border-color:#fecaca;border-left-color:#ef4444;color:#7f1d1d;}}
.legend{{display:flex;gap:14px;flex-wrap:wrap;margin:10px 0 0;font-size:12.5px;color:var(--mut);}}
footer{{margin-top:50px;padding-top:20px;border-top:1px solid var(--line);font-size:12px;color:var(--mut);}}
.struct{{font-family:ui-monospace,monospace;font-size:12.5px;background:#1a1a2e;color:#e2e8f0;border-radius:12px;padding:18px 20px;overflow-x:auto;}}
.struct .k{{color:#fbbf24;}} .struct .c{{color:#86efac;}} .struct .m{{color:#93c5fd;}}
ul.takeaway{{font-size:13.5px;}} ul.takeaway li{{margin:7px 0;}}
</style></head>
<body><div class="wrap">

<header class="hero">
  <h1>NEC ASTERIX 데이터 종류 분석 보고서</h1>
  <div class="file">📄 {esc(fname)}</div>
  <div class="sub">파일 크기 {D['size']/1024/1024:.1f} MB · NEC 프레임 날짜 {D['nec_date'][0]:02d}월 {D['nec_date'][1]:02d}일 ·
  ASTERIX 3개 카테고리(CAT048/CAT034/CAT008) 전수 디코딩 결과. 현재 앱이 파싱하지 않는 항목까지 포함하여 모든 데이터 종류를 정리.</div>
</header>

<div class="grid">
  <div class="kpi"><div class="v">{total_blocks:,}</div><div class="l">ASTERIX 블록 총수</div></div>
  <div class="kpi"><div class="v">{C48['records']:,}</div><div class="l">CAT048 표적보고 레코드</div></div>
  <div class="kpi"><div class="v">{D['nec_frames']:,}</div><div class="l">NEC 프레임 수</div></div>
  <div class="kpi"><div class="v">{C48['modes_count']:,}</div><div class="l">고유 항공기(Mode-S)</div></div>
  <div class="kpi"><div class="v">{C48['callsign_count']:,}</div><div class="l">고유 콜사인</div></div>
  <div class="kpi"><div class="v">{ant if ant else '—'}s</div><div class="l">안테나 회전주기</div></div>
</div>

<div class="note info"><b>분석 방법</b> — 코드베이스의 ASS 파서(<code>src-tauri/src/parser/ass.rs</code>) 로직을 그대로 재현하되,
현재 미디코드 항목(콜사인·BDS 레지스터·트랙상태·CAT034/CAT008 등)까지 EUROCONTROL ASTERIX 사양에 따라 전부 디코딩했다.
값 범위/분포 통계는 노이즈 억제를 위해 주 레이더 <b>{esc(C48['filter_radar'])}</b> 레코드 기준으로 집계했다.</div>

<h2>① 파일 구조 <span class="tag">NEC 프레이밍 + ASTERIX</span></h2>
<p class="lead">파일은 <b>NEC 프레임 헤더(5바이트)</b> 와 <b>ASTERIX 데이터 블록</b> 이 교대로 반복되는 구조다.
각 ASTERIX 블록은 카테고리 1바이트 + 길이 2바이트 + 레코드(들)로 구성된다.</p>
<div class="struct">
<span class="k">[NEC 프레임]</span> <span class="m">월(1) 일(1) 시(1) 분(1) 카운터(1)</span>  ← KST 기준, 분단위<br>
<span class="c">[ASTERIX 블록]</span> CAT(1) LEN(2) <span class="m">FSPEC + 데이터항목…</span>  ← CAT048/034/008<br>
&nbsp;&nbsp;&nbsp;&nbsp;└ <b>FSPEC</b>: 어떤 데이터 항목이 존재하는지 비트맵(FX 확장)<br>
… 반복 …
</div>
<table style="margin-top:16px">
<tr><th>카테고리</th><th>의미</th><th>블록 수</th><th>앱 처리</th></tr>
<tr><td class="c-code">CAT048</td><td><b>단일레이더 표적 보고</b> (Monoradar Target Reports) — 항공기 플롯/트랙. 분석의 핵심 데이터.</td><td class="c-count">{D['cat_blocks'].get('CAT048',0):,}</td><td>{badge('used')}</td></tr>
<tr><td class="c-code">CAT034</td><td><b>단일레이더 서비스 메시지</b> (Service Messages) — 북마커·섹터통과·안테나회전·시스템상태.</td><td class="c-count">{D['cat_blocks'].get('CAT034',0):,}</td><td>{badge('unused')}</td></tr>
<tr><td class="c-code">CAT008</td><td><b>단일레이더 기상 정보</b> (Derived Weather Information) — 강수 에코를 극좌표 벡터로 표현.</td><td class="c-count">{D['cat_blocks'].get('CAT008',0):,}</td><td>{badge('unused')}</td></tr>
</table>
<div class="legend">범례: {badge('used')} 앱이 추출·활용 &nbsp; {badge('partial')} 일부만 추출 &nbsp; {badge('unused')} 파일에 존재하나 미사용</div>

<h2>② CAT048 — 표적 보고 데이터 항목 (28종) <span class="tag">{C48['records']:,} 레코드</span></h2>
<p class="lead">항공기 1개 플롯/트랙당 1레코드. 아래는 ASTERIX UAP 순서의 전체 데이터 항목과 본 파일 내 실측 존재율·디코드 값이다.
<b>존재율</b>은 I020(표적기술자) 보유 레코드 대비 비율.</p>
<table>
<tr><th style="width:11%">항목</th><th>설명 · 포맷 · 활용</th><th style="width:17%">존재 레코드</th><th style="width:20%">실측 값</th></tr>
{''.join(rows48)}
</table>

<h3>2-1. Mode-S MB (I250) — Comm-B 레지스터별 분포</h3>
<p class="lead">Mode-S 트랜스폰더가 다운링크하는 BDS 레지스터. <b>현재 앱은 BDS 3,0/1,6(ACAS)만 사용</b>하지만,
콜사인·선택고도·자세·속도 등 풍부한 항공기 상태 정보(ELS/EHS)가 함께 들어 있다.</p>
<table><tr><th style="width:14%">BDS</th><th>의미</th><th style="width:18%">출현 수</th></tr>{''.join(bds_rows)}</table>
<div class="note"><b>미활용 데이터 기회</b> — BDS 2,0(콜사인)·4,0(선택고도)·5,0(롤각/트랙/속도)·6,0(방위/IAS/Mach/수직속도)는
모두 본 파일에 다량 존재하나 현재 미디코드. 항공기 의도·자세 기반 고급 분석에 활용 가능하다.</div>

<div class="cols">
<div>
<h3>2-2. 탐지 유형 분포 (I020 TYP)</h3>
<table><tr><th>TYP</th><th>의미</th><th>건수</th></tr>{''.join(typ_rows)}</table>
</div>
<div>
<h3>2-3. 상위 항공기 (I220 Mode-S, 출현순)</h3>
<table><tr><th>Mode-S</th><th>국적</th><th>출현</th></tr>{''.join(ms_rows)}</table>
</div>
</div>

<h3>2-4. 콜사인 (I240 Aircraft Identification) — 출현 상위 40</h3>
<div class="note warn"><b>★ 미사용 핵심 데이터</b> — 콜사인은 파일에 명확히 존재(고유 {C48['callsign_count']:,}개)하지만
현재 앱은 I240을 디코드하지 않는다. 최다 출현 <b>{esc(C48['callsign_top'][0][0]) if C48['callsign_top'] else '—'}</b>는 비행검사기로 추정된다.</div>
<table><tr><th>콜사인</th><th>출현 수</th></tr>{''.join(cs_rows)}</table>

<h2>③ CAT034 — 서비스 메시지 <span class="tag">{C34['records']:,} 레코드</span></h2>
<p class="lead">레이더 운용 상태·기하 정보. <b>전체 미사용</b>이지만, 특히 <b>안테나 회전주기(I041={ant}s)</b>는
현재 앱이 데이터 간격으로 <i>추정</i>하는 스캔주기를 직접 제공한다.</p>
<div class="cols">
<div><table><tr><th style="width:13%">항목</th><th>설명 · 포맷</th><th style="width:20%">존재</th></tr>{''.join(rows34)}</table></div>
<div>
<h3>메시지 타입 분포 (I000)</h3>
<table><tr><th>타입</th><th>의미</th><th>건수</th></tr>{''.join(mt34_rows)}</table>
<div class="note info" style="margin-top:14px"><b>북마커(타입1)</b>는 안테나 1회전마다 1회 발생 → 회전수 카운터로 활용 가능.
<b>섹터통과(타입2)</b>는 방위 섹터별 발생.</div>
</div>
</div>

<h2>④ CAT008 — 기상 정보 <span class="tag">{C08['records']:,} 레코드</span></h2>
<p class="lead">레이더가 추출한 강수/기상 에코를 벡터로 표현. <b>전체 미사용</b>. 본 파일은 대부분 극좌표 벡터(타입1)다.</p>
<div class="cols">
<div><table><tr><th style="width:13%">항목</th><th>설명 · 포맷</th><th style="width:20%">존재</th></tr>{''.join(rows08)}</table></div>
<div>
<h3>메시지 타입 분포 (I000)</h3>
<table><tr><th>타입</th><th>의미</th><th>건수</th></tr>{''.join(mt08_rows)}</table>
<div class="note" style="margin-top:14px">기상 에코를 지도에 오버레이하면 항적 Loss 구간과 강수의 상관관계 분석이 가능하다(현재 미사용).</div>
</div>
</div>

<h2>⑤ 종합 — 미활용 데이터 요약</h2>
<p class="lead">파일에 존재하지만 현재 분석 파이프라인이 사용하지 않는 데이터와 잠재 활용처.</p>
<ul class="takeaway">
<li><b>I240 콜사인</b> — 항공기 자동 식별·표시(현재 Mode-S 16진만 사용). 고유 {C48['callsign_count']:,}개 존재.</li>
<li><b>I250 BDS 2,0/4,0/5,0/6,0</b> — 선택고도·롤각·진트랙·IAS·Mach·수직속도 등 EHS 향상감시. 의도/자세 분석.</li>
<li><b>I230 통신/ACAS 능력</b> — ACAS 탑재여부·고도분해능(25/100ft)·공중/지상 상태.</li>
<li><b>I170 트랙 상태 / I210 트랙 품질</b> — 확정/잠정·기동·추정 표준편차로 항적 신뢰도 필터링.</li>
<li><b>I100 Mode-C</b> — I090 기압고도와 교차검증 가능한 별도 고도원.</li>
<li><b>CAT034 I041 안테나 회전주기 ({ant}s)</b> — 스캔주기를 추정 대신 직접 사용 → Loss 임계값 정밀화.</li>
<li><b>CAT008 기상 벡터</b> — 강수와 표적소실(Loss)의 상관 분석.</li>
</ul>

<footer>
생성: {gen_time} · 분석기: full_asterix_analyze.py (EUROCONTROL ASTERIX CAT048/034/008 디코더) ·
값 통계 필터: {esc(C48['filter_radar'])} · truncated 레코드 {C48['truncated']:,}건 제외.<br>
※ 일부 값 범위의 극단치는 바이트 정렬 복구 과정의 잔여 노이즈를 포함할 수 있으며, 출현빈도 기반 표(콜사인·Mode-S·BDS)는 신뢰도가 높다.
</footer>

</div></body></html>"""

out_path = "/mnt/c/Users/chell/OneDrive/바탕 화면/1Data/gimpo_260201_0957_데이터분석.html"
open(out_path,'w',encoding='utf-8').write(HTML)
print("WROTE", out_path, len(HTML),"bytes")
