/**
 * TCAS RA 이벤트 생성기 — BDS 3,0 데이터-only 버전.
 *
 * 데이터에 있는 정보만 표시:
 *   - 자기 위치 (RA 발생 점의 좌표 — CAT048 I048/040 또는 I048/042)
 *   - TID (Threat Identity Data) — BDS 3,0의 TTI에 따라 다름
 *     · TTI=1: 위협 Mode-S 주소 (24비트)
 *     · TTI=2: 위협 거리(NM) / 방위(°) / 고도(ft)
 *     · TTI=0: 위협 정보 없음
 *
 * 자체 계산(궤적 분석 CPA, 위협 매칭 fallback) 제거.
 * 같은 자기-비행에서 RA가 연속으로 발생하면 시간 gap < 10s 로 1 이벤트로 묶음.
 */

import type { TcasRaDecoded } from "./tcasDecoder";

export interface RaPoint {
  ts: number;
  lat: number;
  lon: number;
  altM: number;
  decoded: TcasRaDecoded;
  /** BDS 3,0 raw 7바이트 (검증/표시용) */
  rawBytes: number[];
}

const M_PER_FT = 0.3048;

export interface TcasEvent {
  id: string;
  /** 자기 비행 Mode-S */
  ownModeS: string;
  /** RA 발생 시작/종료 시각 */
  startTime: number;
  endTime: number;
  /** RA 점 수 */
  raPointCount: number;
  /** 첫 RA 점의 위치 (자기 위치) */
  ownLat: number;
  ownLon: number;
  ownAltFt: number;

  /** RA 의도 (첫 점의 description) */
  raDescription: string;

  /** TID 종류 — 0/1/2/3 */
  threatTti: 0 | 1 | 2 | 3;

  /** TTI=1: 위협 Mode-S 주소 */
  threatModeS?: string;

  /** TTI=2: 위협 정보 (자기 항공기 TCAS가 RA 시점에 측정한 값) */
  threatRangeNm?: number;
  threatBearingDeg?: number;
  threatAltFt?: number;

  // ─── BDS 3,0 RA 메타 (대표 점 기준) ───
  /** RAT: RA Terminated (RA 종료 후 ~18초 동안 set) */
  rat: boolean;
  /** MTE: Multiple Threat Encounter */
  mte: boolean;
  /** ARA bit 1 — 1=Corrective(현 비행 변경 필요), 0=Preventive(현 비행 유지) */
  corrective: boolean;
  /** ARA bit 2 — 1=Descend sense, 0=Climb sense */
  downSense: boolean;
  /** ARA 14비트 raw 값 (hex 4자리) */
  araHex: string;
  /** RAC 4비트 raw 값 (hex 1자리) */
  racHex: string;
  /** BDS 3,0 raw 7바이트 hex (14자리) — 검증용 */
  rawHex: string;
}

const GROUP_GAP_SECS = 10;

/**
 * 비행별 RA 점들에서 이벤트 생성.
 * 위협 매칭/CPA 계산 없음 — 데이터값 그대로 사용.
 */
export function buildTcasEvents(
  raPointsByMs: Map<string, RaPoint[]>,
): TcasEvent[] {
  const events: TcasEvent[] = [];

  for (const [modeS, points] of raPointsByMs.entries()) {
    if (points.length === 0) continue;

    // 시간순 정렬
    points.sort((a, b) => a.ts - b.ts);

    // gap < GROUP_GAP_SECS 그룹핑
    let groupStart = 0;
    for (let i = 1; i <= points.length; i++) {
      const isBoundary = i === points.length || (points[i].ts - points[i - 1].ts) > GROUP_GAP_SECS;
      if (!isBoundary) continue;
      const group = points.slice(groupStart, i);
      groupStart = i;

      const first = group[0];
      const last = group[group.length - 1];

      // 그룹 내에서 가장 풍부한 TID를 가진 점을 대표로 선택
      // 우선순위: TTI=2 (거리/방위/고도) > TTI=1 (Mode-S) > TTI=0
      let rep = first;
      for (const p of group) {
        const repTti = rep.decoded.tti;
        const pTti = p.decoded.tti;
        if (pTti === 2 && repTti !== 2) rep = p;
        else if (pTti === 1 && repTti === 0) rep = p;
      }

      const dec = rep.decoded;
      const araBit1 = (dec.ara >> 13) & 1;
      const araBit2 = (dec.ara >> 12) & 1;
      const rawHex = rep.rawBytes.map((b) => b.toString(16).padStart(2, "0")).join("");

      const ev: TcasEvent = {
        id: `tcas:${modeS}:${first.ts.toFixed(3)}`,
        ownModeS: modeS,
        startTime: first.ts,
        endTime: last.ts,
        raPointCount: group.length,
        ownLat: first.lat,
        ownLon: first.lon,
        ownAltFt: first.altM / M_PER_FT,
        raDescription: first.decoded.description,
        threatTti: dec.tti,
        threatModeS: dec.threatModeS,
        threatRangeNm: dec.threatRangeNm,
        threatBearingDeg: dec.threatBearingDeg,
        threatAltFt: dec.threatAltFt,
        rat: dec.rat,
        mte: dec.mte,
        corrective: araBit1 === 1,
        downSense: araBit2 === 1,
        araHex: dec.ara.toString(16).toUpperCase().padStart(4, "0"),
        racHex: dec.rac.toString(16).toUpperCase(),
        rawHex,
      };
      events.push(ev);
    }
  }

  events.sort((a, b) => a.startTime - b.startTime);
  return events;
}
