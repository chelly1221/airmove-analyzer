/**
 * Mode-S MB (Comm-B / BDS 레지스터) 디코더.
 * ASTERIX CAT048 I048/250 의 각 MB 블록(7바이트 페이로드 + 1바이트 BDS 코드)을
 * 레지스터별 필드로 해석한다.
 *
 * 비트 번호는 ICAO Doc 9871 / Annex 10 Vol III·IV 표기를 따른다 (bit 1 = MSB of byte 0).
 *
 * 실데이터(김포#1 gimpo_260126) 전수 분석 결과 출현 레지스터:
 *   BDS 2,0(35%) · 4,0(24%) · 5,0(20%) · 6,0(18%) · 0,0(2%) · 3,0(0.1%).
 * 위 6종은 실페이로드 비트 단위로 검증된 상세 디코더를 제공하고, 그 외 레지스터는
 * 표준 명칭 테이블로 식별만 한다(잘못된 해석 방지 — raw hex는 항상 별도 노출).
 */

import { decodeRaReport } from "./tcasDecoder";

export interface BdsField {
  /** 필드명 (빈 문자열이면 라벨 없이 value만 표시) */
  label: string;
  value: string;
}

export interface BdsDecoded {
  /** "4,0" 등 BDS 코드(16진 니블) */
  code: string;
  /** 레지스터 명칭 */
  name: string;
  /** 한 줄 요약 (I250 개요 줄에 사용) */
  summary: string;
  /** 필드별 상세 */
  fields: BdsField[];
}

// ─── 비트 읽기 (페이로드 7바이트, bit 1 = MSB of byte 0) ───

/** 1-기반 비트 [start, start+len) 을 부호 없는 정수로 */
function rd(b: number[], start: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) {
    const bn = start + i; // 1-기반 비트 번호
    const byteIdx = (bn - 1) >> 3;
    const bitInByte = 7 - ((bn - 1) & 7);
    v = (v << 1) | ((b[byteIdx] >> bitInByte) & 1);
  }
  return v >>> 0;
}

/** 부호 있는(2의 보수) 비트 필드 */
function rdS(b: number[], start: number, len: number): number {
  const v = rd(b, start, len);
  return v & (1 << (len - 1)) ? v - (1 << len) : v;
}

/** 1-기반 상태비트 검사 */
function on(b: number[], n: number): boolean {
  return rd(b, n, 1) === 1;
}

/** 6비트 IA5 문자 (항공기 식별 부호화) */
function ia5(code: number): string {
  if (code >= 1 && code <= 26) return String.fromCharCode(64 + code); // A–Z
  if (code >= 48 && code <= 57) return String.fromCharCode(code); // 0–9
  if (code === 32) return " ";
  return "";
}

/** -180..180 트랙/방위를 0..360 나침반각으로 */
function compass(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

type RegResult = { summary: string; fields: BdsField[] };

// ─── 레지스터별 디코더 ──────────────────────────────

/** BDS 2,0 — 항공기 식별(콜사인). bits 9–56 = 8문자 × 6비트 */
function bds20(b: number[]): RegResult {
  let cs = "";
  for (let i = 0; i < 8; i++) cs += ia5(rd(b, 9 + i * 6, 6));
  cs = cs.trim();
  return { summary: cs || "(공백)", fields: [{ label: "호출부호", value: cs || "(공백)" }] };
}

/** BDS 3,0 — ACAS 해결권고(RA). decodeRaReport 재사용 */
function bds30(b: number[]): RegResult {
  const d = decodeRaReport(b.slice(0, 7));
  if (!d) return { summary: "RA 없음", fields: [{ label: "", value: "빈 RA (모두 0)" }] };
  const f: BdsField[] = [
    { label: "권고(ARA)", value: d.description },
    { label: "ARA 비트", value: "0x" + d.ara.toString(16).padStart(4, "0") },
  ];
  if (d.rac) f.push({ label: "RAC 보충", value: "0b" + d.rac.toString(2).padStart(4, "0") });
  if (d.rat) f.push({ label: "RAT", value: "RA 종료(18초 유지)" });
  if (d.mte) f.push({ label: "MTE", value: "다중 위협 동시" });
  f.push({ label: "위협유형(TTI)", value: ["없음", "Mode-S 주소", "고도/거리/방위", "예약"][d.tti] });
  if (d.threatModeS) f.push({ label: "위협 주소", value: d.threatModeS });
  if (d.threatAltFt != null) f.push({ label: "위협 고도", value: `${d.threatAltFt} ft` });
  if (d.threatRangeNm != null) f.push({ label: "위협 거리", value: `${d.threatRangeNm.toFixed(1)} NM` });
  if (d.threatBearingDeg != null) f.push({ label: "위협 방위", value: `${d.threatBearingDeg.toFixed(0)}°` });
  return { summary: d.description, fields: f };
}

/** BDS 4,0 — 선택 수직의도 (EHS) */
function bds40(b: number[]): RegResult {
  const f: BdsField[] = [];
  let sum = "";
  if (on(b, 1)) {
    const alt = rd(b, 2, 12) * 16;
    f.push({ label: "MCP/FCU 선택고도", value: `${alt.toLocaleString()} ft` });
    sum = `MCP ${alt.toLocaleString()}ft`;
  }
  if (on(b, 14)) f.push({ label: "FMS 선택고도", value: `${(rd(b, 15, 12) * 16).toLocaleString()} ft` });
  if (on(b, 27)) f.push({ label: "기압설정(QNH)", value: `${(rd(b, 28, 12) * 0.1 + 800).toFixed(1)} hPa` });
  if (on(b, 48)) {
    const modes: string[] = [];
    if (on(b, 49)) modes.push("VNAV");
    if (on(b, 50)) modes.push("ALT HOLD");
    if (on(b, 51)) modes.push("APPROACH");
    f.push({ label: "MCP 모드", value: modes.join(" + ") || "없음" });
  }
  if (on(b, 54)) {
    f.push({ label: "목표고도 출처", value: ["미상", "항공기 고도", "MCP/FCU 선택고도", "FMS 선택고도"][rd(b, 55, 2)] });
  }
  if (f.length === 0) return { summary: "유효필드 없음", fields: [{ label: "", value: "모든 상태비트 0 (유효 데이터 없음)" }] };
  return { summary: sum || `${f.length}개 필드`, fields: f };
}

/** BDS 5,0 — 트랙·선회 보고 (EHS) */
function bds50(b: number[]): RegResult {
  const f: BdsField[] = [];
  let trk = "", gs = "";
  if (on(b, 1)) {
    const roll = rdS(b, 2, 10) * 45 / 256;
    f.push({ label: "Roll각", value: `${roll.toFixed(1)}°${roll < -0.05 ? " (좌선회)" : roll > 0.05 ? " (우선회)" : ""}` });
  }
  if (on(b, 12)) {
    trk = `${compass(rdS(b, 13, 11) * 90 / 512).toFixed(1)}°`;
    f.push({ label: "진트랙각", value: trk });
  }
  if (on(b, 24)) {
    gs = `${rd(b, 25, 10) * 2} kt`;
    f.push({ label: "대지속도", value: gs });
  }
  if (on(b, 35)) f.push({ label: "트랙각 변화율", value: `${(rdS(b, 36, 10) * 8 / 256).toFixed(2)}°/s` });
  if (on(b, 46)) f.push({ label: "진대기속도(TAS)", value: `${rd(b, 47, 10) * 2} kt` });
  if (f.length === 0) return { summary: "유효필드 없음", fields: [{ label: "", value: "모든 상태비트 0 (유효 데이터 없음)" }] };
  const sum = [trk && `Trk ${trk}`, gs && `GS ${gs}`].filter(Boolean).join(" ") || `${f.length}개 필드`;
  return { summary: sum, fields: f };
}

/** BDS 6,0 — 방위·속도 보고 (EHS) */
function bds60(b: number[]): RegResult {
  const f: BdsField[] = [];
  let hdg = "", ias = "";
  if (on(b, 1)) {
    hdg = `${compass(rdS(b, 2, 11) * 90 / 512).toFixed(1)}°`;
    f.push({ label: "자기방위", value: hdg });
  }
  if (on(b, 13)) {
    ias = `${rd(b, 14, 10)} kt`;
    f.push({ label: "지시대기속도(IAS)", value: ias });
  }
  if (on(b, 24)) f.push({ label: "마하수", value: `M ${(rd(b, 25, 10) * 2.048 / 512).toFixed(3)}` });
  if (on(b, 35)) f.push({ label: "기압고도 변화율", value: `${(rdS(b, 36, 10) * 32).toLocaleString()} ft/min` });
  if (on(b, 46)) f.push({ label: "관성수직속도", value: `${(rdS(b, 47, 10) * 32).toLocaleString()} ft/min` });
  if (f.length === 0) return { summary: "유효필드 없음", fields: [{ label: "", value: "모든 상태비트 0 (유효 데이터 없음)" }] };
  const sum = [hdg && `Hdg ${hdg}`, ias && `IAS ${ias}`].filter(Boolean).join(" ") || `${f.length}개 필드`;
  return { summary: sum, fields: f };
}

// ─── 레지스터 명칭 테이블 (BDS 코드 = (BDS1<<4)|BDS2) ───
const BDS_NAMES: Record<number, string> = {
  0x00: "빈 레지스터 (데이터 없음)",
  0x05: "확장스퀴터 공중위치",
  0x06: "확장스퀴터 지상위치",
  0x07: "확장스퀴터 상태",
  0x08: "확장스퀴터 식별/카테고리",
  0x09: "확장스퀴터 공중속도",
  0x0a: "확장스퀴터 이벤트구동",
  0x10: "데이터링크 능력 보고 (ELS)",
  0x17: "공통 GICB 능력 보고",
  0x18: "Mode S 특정서비스 GICB 능력",
  0x19: "Mode S 특정서비스 GICB 능력",
  0x1a: "Mode S 특정서비스 GICB 능력",
  0x1b: "Mode S 특정서비스 GICB 능력",
  0x1c: "Mode S 특정서비스 GICB 능력",
  0x20: "항공기 식별 (콜사인)",
  0x21: "항공기/항공사 등록부호",
  0x30: "ACAS 해결권고 (RA)",
  0x40: "선택 수직의도 (EHS)",
  0x41: "다음 경로점 식별",
  0x42: "다음 경로점 위치",
  0x43: "다음 경로점 정보",
  0x44: "기상 정시 보고 (MRAR)",
  0x45: "기상 위험 보고 (MHR)",
  0x48: "VHF 채널 보고",
  0x50: "트랙·선회 보고 (EHS)",
  0x51: "위치 보고 (coarse)",
  0x52: "위치 보고 (fine)",
  0x53: "공기준 상태벡터",
  0x54: "경로점 1",
  0x55: "경로점 2",
  0x56: "경로점 3",
  0x5f: "준정적 파라미터 감시",
  0x60: "방위·속도 보고 (EHS)",
  0x61: "비상/우선순위 상태",
  0x62: "목표 상태/상태 정보",
  0x65: "항공기 운용상태",
  0xe1: "예약 (Mode S BITE)",
  0xe2: "예약 (Mode S BITE)",
  0xf1: "군용 사용",
  0xf2: "군용 사용",
};

/**
 * 한 MB 블록(7바이트 페이로드 + BDS1/BDS2 니블)을 디코드.
 * payload 는 7바이트, b1/b2 는 byte 8 상·하위 니블(0–15).
 */
export function decodeBds(b1: number, b2: number, payload: number[]): BdsDecoded {
  const code = `${b1.toString(16).toUpperCase()},${b2.toString(16).toUpperCase()}`;
  const regByte = (b1 << 4) | b2;
  const name = BDS_NAMES[regByte] ?? `BDS ${code} 레지스터`;

  let r: RegResult;
  if (regByte === 0x00) r = { summary: "빈 레지스터", fields: [{ label: "", value: "데이터 없음 (모두 0)" }] };
  else if (regByte === 0x20) r = bds20(payload);
  else if (regByte === 0x30) r = bds30(payload);
  else if (regByte === 0x40) r = bds40(payload);
  else if (regByte === 0x50) r = bds50(payload);
  else if (regByte === 0x60) r = bds60(payload);
  else r = { summary: "", fields: [{ label: "", value: "상세 필드 디코더 미정의 — raw 참조" }] };

  return { code, name, summary: r.summary, fields: r.fields };
}
