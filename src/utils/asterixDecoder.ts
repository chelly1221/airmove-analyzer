/**
 * ASTERIX 프레임 디코더 — "프레임 전문" 검증/표시용.
 *
 * raw_frame(NEC 헤더 + 해당 프레임의 모든 ASTERIX 블록) 바이트를 받아
 * 사람이 읽을 수 있는 구조로 디코드한다. RAW HEX와 함께 표시할 해석 결과를 만든다.
 *
 * - CAT048: Rust parser(parse_cat048_record)와 **동일한 UAP/길이 규칙**으로 전 항목 디코드.
 *   (실데이터 정합 보장 — 같은 traversal을 그대로 옮김)
 * - CAT034/CAT008: 표준 Eurocontrol UAP의 선두 고정 항목까지 디코드. compound/가변
 *   항목은 에디션별 편차가 있어 잘못된 오프셋 위험이 있으므로 그 지점에서 안전하게
 *   중단하고 나머지를 raw로 표시한다(틀린 값 표시 방지).
 *
 * 어떤 경우에도 raw hex는 별도로 항상 보이므로, 디코드가 부분적이어도 데이터는 숨겨지지 않는다.
 */

import { decodeRaReport } from "./tcasDecoder";

const CAT048 = 0x30;
const CAT034 = 0x22;
const CAT008 = 0x08;

export interface DecodedItem {
  /** "I048/140" 등 데이터 항목 식별자 ("(raw)" = 미해석 잔여) */
  id: string;
  name: string;
  rawHex: string;
  /** 해석 결과 (없으면 미해석) */
  value?: string;
  /** 프레임 내 절대 바이트 오프셋 (RAW HEX 하이라이트용) */
  start: number;
  len: number;
}

export interface DecodedRecord {
  items: DecodedItem[];
  /** FSPEC(필드 명세) 바이트 범위 — 이 레코드에 어떤 데이터 항목이 존재하는지 나타내는 비트맵 */
  fspec?: { rawHex: string; start: number; len: number };
  /** truncation / 중단 사유 등 */
  note?: string;
}

export interface DecodedBlock {
  cat: number;
  len: number;
  rawHex: string;
  /** 블록의 프레임 절대 시작 오프셋 (CAT 1B + LEN 2B 헤더 하이라이트용) */
  start: number;
  records: DecodedRecord[];
  note?: string;
}

export interface DecodedFrame {
  necHeader?: {
    month: number; day: number; hour: number; minute: number; counter: number;
    rawHex: string; text: string; start: number; len: number;
  };
  blocks: DecodedBlock[];
  /** 블록으로 해석되지 않은 잔여 바이트 */
  trailingRawHex?: string;
  note?: string;
}

// ─── 공통 유틸 ───────────────────────────────────────

function hex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

function isCat(b: number): boolean {
  return b === CAT048 || b === CAT034 || b === CAT008;
}

/** 3바이트 TOD(LSB 1/128초) → "HH:MM:SS.mmm" (UTC, 자정 기준) */
function fmtTod3(b: number[]): string {
  const raw = (b[0] << 16) | (b[1] << 8) | b[2];
  const secs = raw / 128;
  const s = ((secs % 86400) + 86400) % 86400;
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(ms).padStart(3, "0")} UTC`;
}

function sacSic(b: number[]): string {
  return `SAC=${b[0]} SIC=${b[1]}`;
}

/** FSPEC 파싱 → 존재하는 항목의 1-기반 FRN 목록 + 다음 오프셋 */
function parseFspec(data: number[], offset: number, maxItems: number): { frns: number[]; next: number } | null {
  const frns: number[] = [];
  let pos = offset;
  let itemIdx = 0; // 0-기반
  for (;;) {
    if (pos >= data.length) return null;
    const byte = data[pos];
    pos += 1;
    for (let bit = 7; bit >= 1; bit--) {
      if (itemIdx < maxItems && ((byte >> bit) & 1) === 1) frns.push(itemIdx + 1);
      itemIdx += 1;
    }
    if ((byte & 0x01) === 0) break;
  }
  return { frns, next: pos };
}

/** FX 확장 항목의 길이(바이트) 계산 — bit1(LSB)이 1이면 다음 옥텟 계속 */
function fxLen(data: number[], offset: number): number {
  let pos = offset;
  for (;;) {
    if (pos >= data.length) return pos - offset;
    const byte = data[pos];
    pos += 1;
    if ((byte & 0x01) === 0) break;
  }
  return pos - offset;
}

// ─── CAT048 값 디코더 ────────────────────────────────

const TYP048: Record<number, string> = {
  0: "탐지없음",
  1: "Single PSR",
  2: "Single SSR",
  3: "SSR+PSR",
  4: "Mode S All-Call",
  5: "Mode S Roll-Call",
  6: "Mode S All-Call+PSR",
  7: "Mode S Roll-Call+PSR",
};

function decodeI020(b: number[]): string {
  const typ = (b[0] >> 5) & 0x07;
  const sim = (b[0] >> 4) & 0x01;
  const rdp = (b[0] >> 3) & 0x01;
  const spi = (b[0] >> 2) & 0x01;
  const rab = (b[0] >> 1) & 0x01;
  const parts = [TYP048[typ] ?? `TYP${typ}`];
  if (sim) parts.push("SIM");
  if (rdp) parts.push("RDP-chain2");
  if (spi) parts.push("SPI");
  if (rab) parts.push("RAB");
  return parts.join(", ");
}

function decodeI040(b: number[]): string {
  const rho = ((b[0] << 8) | b[1]) / 256;
  const theta = ((b[2] << 8) | b[3]) * 360 / 65536;
  return `ρ=${rho.toFixed(2)} NM, θ=${theta.toFixed(2)}°`;
}

function decodeMode3a(b: number[]): string {
  const raw = (b[0] << 8) | b[1];
  const v = (raw >> 15) & 1, g = (raw >> 14) & 1;
  const code = raw & 0x0fff;
  const oct = code.toString(8).padStart(4, "0");
  const flags = [v ? "V" : "", g ? "G" : ""].filter(Boolean).join("/");
  return flags ? `${oct} (${flags})` : oct;
}

function decodeI090(b: number[]): string {
  const raw = (b[0] << 8) | b[1];
  const v = (raw >> 15) & 1, g = (raw >> 14) & 1;
  let fl14 = raw & 0x3fff;
  if (fl14 & 0x2000) fl14 = fl14 - 0x4000; // 14비트 부호
  const fl = fl14 * 0.25;
  const flags = [v ? "V" : "", g ? "G" : ""].filter(Boolean).join("/");
  return `FL${fl.toFixed(2)} (${Math.round(fl * 100)} ft)${flags ? ` (${flags})` : ""}`;
}

function decodeI200(b: number[]): string {
  const gsp = ((b[0] << 8) | b[1]) * 3600 / 16384;
  const hdg = ((b[2] << 8) | b[3]) * 360 / 65536;
  return `${gsp.toFixed(1)} kt, ${hdg.toFixed(1)}°`;
}

function decodeI220(b: number[]): string {
  return ((b[0] << 16) | (b[1] << 8) | b[2]).toString(16).toUpperCase().padStart(6, "0");
}

function decodeI042(b: number[]): string {
  const x = (((b[0] << 8) | b[1]) << 16 >> 16) / 128; // int16
  const y = (((b[2] << 8) | b[3]) << 16 >> 16) / 128;
  return `X=${x.toFixed(2)} NM, Y=${y.toFixed(2)} NM`;
}

function decodeI161(b: number[]): string {
  return `#${((b[0] << 8) | b[1]) & 0x0fff}`;
}

function decodeI110(b: number[]): string {
  let h = ((b[0] << 8) | b[1]) & 0x3fff;
  if (h & 0x2000) h = h - 0x4000;
  return `${h * 25} ft`;
}

const IA5: Record<number, string> = {};
(function buildIa5() {
  for (let c = 1; c <= 26; c++) IA5[c] = String.fromCharCode(64 + c); // A-Z
  IA5[32] = " ";
  for (let c = 48; c <= 57; c++) IA5[c] = String.fromCharCode(c); // 0-9
})();

function decodeI240(b: number[]): string {
  // 6바이트 → 8문자 × 6비트
  let bits = 0n;
  for (let i = 0; i < 6; i++) bits = (bits << 8n) | BigInt(b[i]);
  let out = "";
  for (let i = 7; i >= 0; i--) {
    const c = Number((bits >> BigInt(i * 6)) & 0x3fn);
    out += IA5[c] ?? "?";
  }
  return out.trim();
}

function decodeI250(b: number[]): string {
  const rep = b[0];
  const regs: string[] = [];
  for (let i = 0; i < rep; i++) {
    const off = 1 + i * 8;
    if (off + 8 > b.length) break;
    const bdsByte = b[off + 7];
    const bds1 = (bdsByte >> 4) & 0x0f;
    const bds2 = bdsByte & 0x0f;
    let tag = `BDS${bds1},${bds2}`;
    if (bds1 === 3 && bds2 === 0) tag += "(ACAS RA)";
    else if (bds1 === 1 && bds2 === 6) tag += "(협의)";
    regs.push(tag);
  }
  return `${rep}건: ${regs.join(" · ") || "—"}`;
}

function decodeI260(b: number[]): string {
  const d = decodeRaReport(b.slice(0, 7));
  return d ? d.description : "RA 없음";
}

// CAT048 항목 메타 (FRN 1-28). 길이 규칙은 parse_cat048_record와 동일.
type ItemKind =
  | { k: "fixed"; len: number }
  | { k: "ext" } // FX 확장
  | { k: "i130" } // compound: 1 sub-fspec + 비트당 1바이트
  | { k: "i120" } // compound: 1 sub-fspec + (#1→2) + (#2→ 1+REP*6)
  | { k: "i250" } // repetitive: 1 + REP*8
  | { k: "explicit" }; // 1 길이옥텟(자신 포함)

interface ItemMeta {
  id: string;
  name: string;
  kind: ItemKind;
  decode?: (b: number[]) => string;
}

const CAT048_UAP: ItemMeta[] = [
  { id: "I048/010", name: "데이터 출처 식별", kind: { k: "fixed", len: 2 }, decode: sacSic },
  { id: "I048/140", name: "시각(TOD)", kind: { k: "fixed", len: 3 }, decode: fmtTod3 },
  { id: "I048/020", name: "표적보고 기술자", kind: { k: "ext" }, decode: decodeI020 },
  { id: "I048/040", name: "측정위치(극좌표)", kind: { k: "fixed", len: 4 }, decode: decodeI040 },
  { id: "I048/070", name: "Mode-3/A 코드", kind: { k: "fixed", len: 2 }, decode: decodeMode3a },
  { id: "I048/090", name: "고도(FL)", kind: { k: "fixed", len: 2 }, decode: decodeI090 },
  { id: "I048/130", name: "레이더 플롯 특성", kind: { k: "i130" } },
  { id: "I048/220", name: "항공기 주소", kind: { k: "fixed", len: 3 }, decode: decodeI220 },
  { id: "I048/240", name: "항공기 식별(콜사인)", kind: { k: "fixed", len: 6 }, decode: decodeI240 },
  { id: "I048/250", name: "Mode-S MB 데이터", kind: { k: "i250" }, decode: decodeI250 },
  { id: "I048/161", name: "트랙 번호", kind: { k: "fixed", len: 2 }, decode: decodeI161 },
  { id: "I048/042", name: "계산위치(직교)", kind: { k: "fixed", len: 4 }, decode: decodeI042 },
  { id: "I048/200", name: "계산 속도(극좌표)", kind: { k: "fixed", len: 4 }, decode: decodeI200 },
  { id: "I048/170", name: "트랙 상태", kind: { k: "ext" } },
  { id: "I048/210", name: "트랙 품질", kind: { k: "fixed", len: 4 } },
  { id: "I048/030", name: "경고/오류 조건", kind: { k: "ext" } },
  { id: "I048/080", name: "Mode-3/A 신뢰도", kind: { k: "fixed", len: 2 } },
  { id: "I048/100", name: "Mode-C 신뢰도", kind: { k: "fixed", len: 4 } },
  { id: "I048/110", name: "3D 높이", kind: { k: "fixed", len: 2 }, decode: decodeI110 },
  { id: "I048/120", name: "레이디얼 도플러 속도", kind: { k: "i120" } },
  { id: "I048/230", name: "통신/ACAS 능력", kind: { k: "fixed", len: 2 } },
  { id: "I048/260", name: "ACAS RA 보고", kind: { k: "fixed", len: 7 }, decode: decodeI260 },
  { id: "I048/055", name: "Mode-1 코드", kind: { k: "fixed", len: 1 } },
  { id: "I048/050", name: "Mode-2 코드", kind: { k: "fixed", len: 2 } },
  { id: "I048/065", name: "Mode-1 신뢰도", kind: { k: "fixed", len: 1 } },
  { id: "I048/060", name: "Mode-2 신뢰도", kind: { k: "fixed", len: 2 } },
  { id: "SP", name: "특수목적 필드", kind: { k: "explicit" } },
  { id: "RE", name: "예약확장 필드", kind: { k: "explicit" } },
];

/** CAT048 레코드 디코드 — block[start..]에서 한 레코드. base = block[0]의 프레임 절대 오프셋. */
function decodeCat048Record(block: number[], start: number, base: number): { items: DecodedItem[]; next: number; fspec?: { rawHex: string; start: number; len: number }; note?: string } {
  const fspec = parseFspec(block, start, CAT048_UAP.length);
  if (!fspec) return { items: [], next: block.length, note: "FSPEC 파싱 불가" };
  const fspecInfo = { rawHex: hex(block.slice(start, fspec.next)), start: base + start, len: fspec.next - start };
  const items: DecodedItem[] = [];
  let pos = fspec.next;
  let note: string | undefined;

  for (const frn of fspec.frns) {
    const meta = CAT048_UAP[frn - 1];
    if (pos >= block.length) { note = "블록 경계 truncation"; break; }
    let len = 0;
    switch (meta.kind.k) {
      case "fixed": len = meta.kind.len; break;
      case "ext": len = fxLen(block, pos); break;
      case "explicit": len = block[pos]; break;
      case "i250": {
        const rep = block[pos];
        len = 1 + rep * 8;
        break;
      }
      case "i130": {
        const sub = block[pos];
        len = 1;
        for (let bit = 7; bit >= 1; bit--) if ((sub >> bit) & 1) len += 1;
        break;
      }
      case "i120": {
        const sub = block[pos];
        len = 1;
        if ((sub >> 7) & 1) len += 2;
        if ((sub >> 6) & 1) {
          if (pos + len >= block.length) { len = -1; break; }
          const rep = block[pos + len];
          len += 1 + rep * 6;
        }
        break;
      }
    }
    if (len <= 0 || pos + len > block.length) { note = `${meta.id} 길이 초과(truncation)`; break; }
    const raw = block.slice(pos, pos + len);
    let value: string | undefined;
    if (meta.decode) { try { value = meta.decode(raw); } catch { value = undefined; } }
    items.push({ id: meta.id, name: meta.name, rawHex: hex(raw), value, start: base + pos, len });
    pos += len;
  }
  return { items, next: pos, fspec: fspecInfo, note };
}

// ─── CAT034 / CAT008 (표준 UAP, best-effort) ─────────

const MSG_TYPE_034: Record<number, string> = {
  1: "North marker", 2: "섹터 통과", 3: "지리적 필터링", 4: "재밍 스트로브", 5: "태양 폭풍",
};
const MSG_TYPE_008: Record<number, string> = {
  1: "극좌표 벡터", 2: "직교 벡터", 3: "윤곽 기록", 4: "절대 직교 벡터", 254: "SOP 메시지", 255: "EOP 메시지",
};

function decodeSector(b: number[]): string {
  return `${(b[0] * 360 / 256).toFixed(1)}°`;
}
function decodeAntRot(b: number[]): string {
  const period = ((b[0] << 8) | b[1]) / 128;
  return `회전주기 ${period.toFixed(2)}s`;
}

// 선두 고정/확장 항목만 신뢰. compound/가변은 "stop"으로 표시 → 그 지점에서 중단.
type GenKind =
  | { k: "fixed"; len: number; decode?: (b: number[]) => string }
  | { k: "ext"; decode?: (b: number[]) => string }
  | { k: "stop" }; // compound/가변 — 안전 중단

interface GenMeta { id: string; name: string; kind: GenKind; }

const CAT034_UAP: GenMeta[] = [
  { id: "I034/010", name: "데이터 출처 식별", kind: { k: "fixed", len: 2, decode: sacSic } },
  { id: "I034/000", name: "메시지 유형", kind: { k: "fixed", len: 1, decode: (b) => MSG_TYPE_034[b[0]] ?? `유형 ${b[0]}` } },
  { id: "I034/030", name: "시각(TOD)", kind: { k: "fixed", len: 3, decode: fmtTod3 } },
  { id: "I034/020", name: "섹터 번호", kind: { k: "fixed", len: 1, decode: decodeSector } },
  { id: "I034/041", name: "안테나 회전속도", kind: { k: "fixed", len: 2, decode: decodeAntRot } },
  { id: "I034/050", name: "시스템 구성/상태", kind: { k: "stop" } },
  { id: "I034/060", name: "시스템 처리 모드", kind: { k: "stop" } },
  { id: "I034/070", name: "메시지 카운트", kind: { k: "stop" } },
  { id: "I034/100", name: "범용 극좌표 윈도우", kind: { k: "stop" } },
  { id: "I034/110", name: "데이터 필터", kind: { k: "stop" } },
  { id: "I034/120", name: "데이터 출처 3D 위치", kind: { k: "stop" } },
  { id: "I034/090", name: "시준 오차", kind: { k: "stop" } },
  { id: "RE", name: "예약확장 필드", kind: { k: "stop" } },
  { id: "SP", name: "특수목적 필드", kind: { k: "stop" } },
];

const CAT008_UAP: GenMeta[] = [
  { id: "I008/010", name: "데이터 출처 식별", kind: { k: "fixed", len: 2, decode: sacSic } },
  { id: "I008/000", name: "메시지 유형", kind: { k: "fixed", len: 1, decode: (b) => MSG_TYPE_008[b[0]] ?? `유형 ${b[0]}` } },
  { id: "I008/020", name: "벡터 한정자", kind: { k: "ext" } },
  { id: "I008/036", name: "극좌표 벡터열", kind: { k: "stop" } },
  { id: "I008/034", name: "직교 벡터열", kind: { k: "stop" } },
  { id: "I008/040", name: "윤곽 식별자", kind: { k: "stop" } },
  { id: "I008/050", name: "윤곽 점열", kind: { k: "stop" } },
  { id: "I008/090", name: "시각(TOD)", kind: { k: "stop" } },
  { id: "I008/100", name: "처리 상태", kind: { k: "stop" } },
  { id: "I008/110", name: "스테이션 구성 상태", kind: { k: "stop" } },
  { id: "I008/120", name: "총 항목 수", kind: { k: "stop" } },
  { id: "SP", name: "특수목적 필드", kind: { k: "stop" } },
  { id: "RE", name: "예약확장 필드", kind: { k: "stop" } },
];

/** CAT034/008 레코드 디코드 — 선두 신뢰 항목까지. 나머지는 raw로 1건 추가하고 종료. base=절대 오프셋. */
function decodeGenericRecord(block: number[], start: number, base: number, uap: GenMeta[]): { items: DecodedItem[]; next: number; fspec?: { rawHex: string; start: number; len: number }; note?: string } {
  const fspec = parseFspec(block, start, uap.length);
  if (!fspec) return { items: [], next: block.length, note: "FSPEC 파싱 불가" };
  const fspecInfo = { rawHex: hex(block.slice(start, fspec.next)), start: base + start, len: fspec.next - start };
  const items: DecodedItem[] = [];
  let pos = fspec.next;
  let note: string | undefined;

  for (const frn of fspec.frns) {
    const meta = uap[frn - 1];
    if (pos >= block.length) { note = "블록 경계 truncation"; break; }
    if (meta.kind.k === "stop") {
      note = `${meta.id}(${meta.name}) 이후 compound/가변 — raw 참조`;
      break;
    }
    let len = 0;
    if (meta.kind.k === "fixed") len = meta.kind.len;
    else if (meta.kind.k === "ext") len = fxLen(block, pos);
    if (len <= 0 || pos + len > block.length) { note = `${meta.id} 길이 초과(truncation)`; break; }
    const raw = block.slice(pos, pos + len);
    let value: string | undefined;
    const dec = meta.kind.k === "fixed" || meta.kind.k === "ext" ? meta.kind.decode : undefined;
    if (dec) { try { value = dec(raw); } catch { value = undefined; } }
    items.push({ id: meta.id, name: meta.name, rawHex: hex(raw), value, start: base + pos, len });
    pos += len;
  }
  // 남은 바이트는 raw로 노출 (블록 끝까지를 한 레코드로 간주 — 서비스/기상 메시지는 보통 단일 레코드)
  if (pos < block.length) {
    items.push({ id: "(raw)", name: "미해석 잔여", rawHex: hex(block.slice(pos)), start: base + pos, len: block.length - pos });
  }
  return { items, next: block.length, fspec: fspecInfo, note };
}

// ─── 블록/프레임 ─────────────────────────────────────

function decodeBlock(data: number[], offset: number): { block: DecodedBlock; next: number } {
  const cat = data[offset];
  const len = (data[offset + 1] << 8) | data[offset + 2];
  const end = Math.min(offset + len, data.length);
  const blockBytes = data.slice(offset, end);
  const block: DecodedBlock = { cat, len, rawHex: hex(blockBytes), start: offset, records: [] };

  let recPos = 3; // CAT(1)+LEN(2) 이후
  let guard = 0;
  while (recPos < blockBytes.length && guard < 1000) {
    guard += 1;
    let res;
    if (cat === CAT048) res = decodeCat048Record(blockBytes, recPos, offset);
    else if (cat === CAT034) res = decodeGenericRecord(blockBytes, recPos, offset, CAT034_UAP);
    else if (cat === CAT008) res = decodeGenericRecord(blockBytes, recPos, offset, CAT008_UAP);
    else { block.note = `CAT${cat.toString(16)} 미지원`; break; }

    block.records.push({ items: res.items, fspec: res.fspec, note: res.note });
    if (res.next <= recPos) break; // 진행 불가 → 무한루프 방지
    recPos = res.next;
  }
  return { block, next: offset + len };
}

export function decodeFrame(bytes: number[]): DecodedFrame {
  const frame: DecodedFrame = { blocks: [] };
  if (!bytes || bytes.length === 0) return frame;

  let pos = 0;
  // NEC 헤더 우선 판정: [월(1-12)][일(1-31)][시(0-23)][분(0-59)][카운터] + 다음 바이트가 CAT
  if (
    bytes.length >= 6 &&
    bytes[0] >= 1 && bytes[0] <= 12 &&
    bytes[1] >= 1 && bytes[1] <= 31 &&
    bytes[2] <= 23 && bytes[3] <= 59 &&
    isCat(bytes[5])
  ) {
    const h = bytes.slice(0, 5);
    frame.necHeader = {
      month: h[0], day: h[1], hour: h[2], minute: h[3], counter: h[4],
      rawHex: hex(h),
      text: `${String(h[0]).padStart(2, "0")}-${String(h[1]).padStart(2, "0")} ${String(h[2]).padStart(2, "0")}:${String(h[3]).padStart(2, "0")} (KST) #${h[4]}`,
      start: 0, len: 5,
    };
    pos = 5;
  }

  let guard = 0;
  while (pos + 3 <= bytes.length && isCat(bytes[pos]) && guard < 1000) {
    guard += 1;
    const { block, next } = decodeBlock(bytes, pos);
    frame.blocks.push(block);
    if (next <= pos) break;
    pos = next;
  }

  if (pos < bytes.length) frame.trailingRawHex = hex(bytes.slice(pos));
  return frame;
}
