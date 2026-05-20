/**
 * BDS 3,0 (ACAS Active Resolution Advisory) 디코더.
 * ASTERIX CAT048 I048/260 또는 I048/250 의 BDS 3,0 MB 블록에서 추출한
 * 7바이트(56비트) 페이로드를 사람-친화적 구조로 변환한다.
 *
 * 표준: ICAO Annex 10 Vol IV / RTCA DO-185B 부속서.
 *
 * 비트 번호는 ASTERIX 표기를 따른다 (1 = MSB of byte 0).
 *   bits 1–14 : ARA  (Active RAs)
 *   bits 15–18: RAC  (RA Complement Record)
 *   bit  19   : RAT  (RA Terminated)
 *   bit  20   : MTE  (Multiple Threat Encounter)
 *   bits 21–22: TTI  (Threat Type Indicator)
 *               0 = no threat identity data
 *               1 = TID = Mode-S address (24비트)
 *               2 = TID = altitude/range/bearing
 *               3 = reserved
 *   bits 23–56: TID  (TTI 값에 따라 해석)
 */

export interface TcasRaDecoded {
  /** ARA 비트가 하나라도 set 되었는지 */
  hasRa: boolean;
  /** ARA 14비트 raw 값 (bits 1–14, bit 1 = MSB) */
  ara: number;
  /** RAC 4비트 raw 값 */
  rac: number;
  /** RAT — RA 종료 후 18초 동안 set */
  rat: boolean;
  /** MTE — 다수 위협 동시 추적 */
  mte: boolean;
  /** TTI 2비트 */
  tti: 0 | 1 | 2 | 3;
  /** TTI=1: 위협 Mode-S 주소 (6자리 hex, 대문자) */
  threatModeS?: string;
  /** TTI=2: 위협 고도 (ft, 13비트 Mode C 코드 변환) */
  threatAltFt?: number;
  /** TTI=2: 위협 거리 (NM, 0.1 LSB) */
  threatRangeNm?: number;
  /** TTI=2: 위협 방위 (도, 6비트, 1 LSB) */
  threatBearingDeg?: number;
  /** ARA + RAC + 센스를 종합한 사람-친화적 설명 (예: "Climb", "Don't descend") */
  description: string;
}

/**
 * 56-bit 페이로드에서 비트 번호 1-based로 [startBit, endBit] 구간 읽기 (inclusive).
 * 표준 비트 번호는 1=MSB.
 */
function readBits(bytes: number[], start: number, end: number): number {
  let v = 0;
  for (let b = start; b <= end; b++) {
    const byteIdx = Math.floor((b - 1) / 8);
    const bitInByte = 7 - ((b - 1) % 8); // MSB = bit 7
    const bit = (bytes[byteIdx] >> bitInByte) & 1;
    v = (v << 1) | bit;
  }
  return v;
}

function bitSet(bytes: number[], b: number): boolean {
  const byteIdx = Math.floor((b - 1) / 8);
  const bitInByte = 7 - ((b - 1) % 8);
  return ((bytes[byteIdx] >> bitInByte) & 1) === 1;
}

/**
 * 13-bit Mode C 고도 코드 → ft.
 * Gillham code (Gray-encoded). 매우 단순화된 변환: 100ft 단위 raw 그대로
 * 사용(완전한 Gillham 변환은 ATC 게이트웨이가 수행한 후의 BDS 3,0 페이로드에서
 * 보통 100ft 단위로 등장한다).
 *
 * 대부분의 ASTERIX 게이트웨이는 이 13-bit 필드를 이미 정렬된 형태로 전달하므로
 * 직접 raw × 100 ft 로 처리.
 */
function decodeModeCAltitude(raw: number): number | undefined {
  if (raw === 0) return undefined;
  return raw * 100;
}

/** ARA / RAC 비트로 RA 의도를 사람-친화적 문자열로 변환. */
function describeRa(ara: number, rac: number, rat: boolean): string {
  if (rat) return "RA Terminated";
  if (ara === 0) return "No RA";

  // ARA bit 1 (MSB) = ARA1: 1이면 corrective(현 비행 변경 필요), 0이면 preventive
  // ARA bit 2 = down sense: 1=descend sense, 0=climb sense
  // ARA bit 3 = increased rate
  // ARA bit 4 = reversal
  // ARA bit 5 = crossing
  // ARA bit 6 = sense reversal
  // 위 단순화 매핑은 DO-185B의 정확한 다중 RA 부호화 표를 줄여 표현한 것.
  const ara1 = (ara >> 13) & 1; // corrective
  const downSense = (ara >> 12) & 1;
  const increasedRate = (ara >> 11) & 1;
  const reversal = (ara >> 10) & 1;
  const crossing = (ara >> 9) & 1;

  // RAC complements: 4비트 — 0001=Don't descend, 0010=Don't climb, ... (단순 매핑)
  const racParts: string[] = [];
  if (rac & 0b1000) racParts.push("Don't descend");
  if (rac & 0b0100) racParts.push("Don't climb");
  if (rac & 0b0010) racParts.push("Don't turn left");
  if (rac & 0b0001) racParts.push("Don't turn right");

  let main = "RA";
  if (ara1 === 1) {
    main = downSense ? "Descend" : "Climb";
    if (increasedRate) main = `Increase ${main.toLowerCase()}`;
    if (reversal) main = `Reverse to ${main.toLowerCase()}`;
    if (crossing) main = `Crossing ${main.toLowerCase()}`;
  } else {
    // Preventive RA: 유지
    main = downSense ? "Maintain (don't climb)" : "Maintain (don't descend)";
  }

  return racParts.length > 0 ? `${main}, ${racParts.join(", ")}` : main;
}

/**
 * 7바이트 BDS 3,0 페이로드를 디코드. null = 모든 바이트가 0(공 RA).
 */
export function decodeRaReport(bytes: number[] | undefined | null): TcasRaDecoded | null {
  if (!bytes || bytes.length < 7) return null;
  // 모두 0이면 RA 없음
  let allZero = true;
  for (let i = 0; i < 7; i++) if (bytes[i] !== 0) { allZero = false; break; }
  if (allZero) return null;

  const ara = readBits(bytes, 1, 14);
  const rac = readBits(bytes, 15, 18);
  const rat = bitSet(bytes, 19);
  const mte = bitSet(bytes, 20);
  const tti = readBits(bytes, 21, 22) as 0 | 1 | 2 | 3;

  const decoded: TcasRaDecoded = {
    hasRa: ara !== 0 || rac !== 0,
    ara, rac, rat, mte, tti,
    description: describeRa(ara, rac, rat),
  };

  if (tti === 1) {
    // TID = Mode-S address (24 bits) → bits 23–46
    const addr = readBits(bytes, 23, 46);
    if (addr > 0) {
      decoded.threatModeS = addr.toString(16).toUpperCase().padStart(6, "0");
    }
  } else if (tti === 2) {
    // TID = altitude (13b) + range (7b) + bearing (6b) + reserved (8b)
    const altRaw = readBits(bytes, 23, 35);
    const rngRaw = readBits(bytes, 36, 42);
    const brgRaw = readBits(bytes, 43, 48);
    const alt = decodeModeCAltitude(altRaw);
    if (alt !== undefined) decoded.threatAltFt = alt;
    if (rngRaw > 0) decoded.threatRangeNm = rngRaw * 0.1;
    if (brgRaw > 0) decoded.threatBearingDeg = (brgRaw * 360) / 64; // 6비트 = 64
  }

  return decoded;
}
