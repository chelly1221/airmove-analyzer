/**
 * TCAS/ACAS 이벤트 생성기 — TcasReport(트랙 독립 전수 추출) 기반.
 *
 * Rust parser가 모든 CAT048 레코드에서 I260/BDS3,0/BDS1,6을 전수 추출한 TcasReport[]를
 * 받아, source별(RA / Coordination)로 분류하고 mode_s별 시간 그룹핑하여 이벤트로 만든다.
 *
 * 좌표/시간이 없는 응답 레코드도 포함되므로 ownLat/ownLon/ownAltFt는 optional.
 * 자체 계산(궤적 CPA, 위협 매칭)은 하지 않음 — 데이터값 그대로.
 */

import type { TcasReport } from "../types/track";
import { decodeRaReport, type TcasRaDecoded } from "./tcasDecoder";

const M_PER_FT = 0.3048;
const GROUP_GAP_SECS = 10;

interface RaPoint {
  ts: number;
  lat: number | null;
  lon: number | null;
  altM: number | null;
  estimated: boolean;
  decoded: TcasRaDecoded;
  rawBytes: number[];
}

export interface TcasEvent {
  id: string;
  ownModeS: string;
  startTime: number;
  endTime: number;
  raPointCount: number;
  /** 첫 RA 점의 위치 (없으면 undefined) */
  ownLat?: number;
  ownLon?: number;
  ownAltFt?: number;
  /** 시각이 추정값(I140 부재)인지 */
  timeEstimated: boolean;
  raDescription: string;
  threatTti: 0 | 1 | 2 | 3;
  threatModeS?: string;
  threatRangeNm?: number;
  threatBearingDeg?: number;
  threatAltFt?: number;
  rat: boolean;
  mte: boolean;
  corrective: boolean;
  downSense: boolean;
  araHex: string;
  racHex: string;
  rawHex: string;
}

export interface CoordEvent {
  id: string;
  ownModeS: string;
  startTime: number;
  endTime: number;
  pointCount: number;
  ownLat?: number;
  ownLon?: number;
  ownAltFt?: number;
  timeEstimated: boolean;
  description: string;
  threatTti: 0 | 1 | 2 | 3;
  threatModeS?: string;
  rat: boolean;
  mte: boolean;
  corrective: boolean;
  downSense: boolean;
  araHex: string;
  racHex: string;
  rawHex: string;
}

function altFt(altM: number | null): number | undefined {
  return altM == null ? undefined : altM / M_PER_FT;
}

function buildRaEvents(byMs: Map<string, RaPoint[]>): TcasEvent[] {
  const events: TcasEvent[] = [];
  for (const [modeS, points] of byMs.entries()) {
    if (points.length === 0) continue;
    points.sort((a, b) => a.ts - b.ts);
    let groupStart = 0;
    for (let i = 1; i <= points.length; i++) {
      const isBoundary = i === points.length || (points[i].ts - points[i - 1].ts) > GROUP_GAP_SECS;
      if (!isBoundary) continue;
      const group = points.slice(groupStart, i);
      groupStart = i;
      const first = group[0];
      const last = group[group.length - 1];
      // 대표 점: TTI 우선순위 2 > 1 > 0
      let rep = first;
      for (const p of group) {
        if (p.decoded.tti === 2 && rep.decoded.tti !== 2) rep = p;
        else if (p.decoded.tti === 1 && rep.decoded.tti === 0) rep = p;
      }
      const dec = rep.decoded;
      events.push({
        id: `ra:${modeS}:${first.ts.toFixed(3)}`,
        ownModeS: modeS,
        startTime: first.ts,
        endTime: last.ts,
        raPointCount: group.length,
        ownLat: first.lat ?? undefined,
        ownLon: first.lon ?? undefined,
        ownAltFt: altFt(first.altM),
        timeEstimated: first.estimated,
        raDescription: first.decoded.description,
        threatTti: dec.tti,
        threatModeS: dec.threatModeS,
        threatRangeNm: dec.threatRangeNm,
        threatBearingDeg: dec.threatBearingDeg,
        threatAltFt: dec.threatAltFt,
        rat: dec.rat,
        mte: dec.mte,
        corrective: ((dec.ara >> 13) & 1) === 1,
        downSense: ((dec.ara >> 12) & 1) === 1,
        araHex: dec.ara.toString(16).toUpperCase().padStart(4, "0"),
        racHex: dec.rac.toString(16).toUpperCase(),
        rawHex: rep.rawBytes.map((b) => b.toString(16).padStart(2, "0")).join(""),
      });
    }
  }
  events.sort((a, b) => a.startTime - b.startTime);
  return events;
}

function buildCoordEventsInner(byMs: Map<string, RaPoint[]>): CoordEvent[] {
  const events: CoordEvent[] = [];
  for (const [modeS, points] of byMs.entries()) {
    if (points.length === 0) continue;
    points.sort((a, b) => a.ts - b.ts);
    let groupStart = 0;
    for (let i = 1; i <= points.length; i++) {
      const isBoundary = i === points.length || (points[i].ts - points[i - 1].ts) > GROUP_GAP_SECS;
      if (!isBoundary) continue;
      const group = points.slice(groupStart, i);
      groupStart = i;
      const first = group[0];
      const last = group[group.length - 1];
      let rep = first;
      for (const p of group) {
        if (p.decoded.tti === 2 && rep.decoded.tti !== 2) rep = p;
        else if (p.decoded.tti === 1 && rep.decoded.tti === 0) rep = p;
      }
      const dec = rep.decoded;
      events.push({
        id: `coord:${modeS}:${first.ts.toFixed(3)}`,
        ownModeS: modeS,
        startTime: first.ts,
        endTime: last.ts,
        pointCount: group.length,
        ownLat: first.lat ?? undefined,
        ownLon: first.lon ?? undefined,
        ownAltFt: altFt(first.altM),
        timeEstimated: first.estimated,
        description: first.decoded.description,
        threatTti: dec.tti,
        threatModeS: dec.threatModeS,
        rat: dec.rat,
        mte: dec.mte,
        corrective: ((dec.ara >> 13) & 1) === 1,
        downSense: ((dec.ara >> 12) & 1) === 1,
        araHex: dec.ara.toString(16).toUpperCase().padStart(4, "0"),
        racHex: dec.rac.toString(16).toUpperCase(),
        rawHex: rep.rawBytes.map((b) => b.toString(16).padStart(2, "0")).join(""),
      });
    }
  }
  events.sort((a, b) => a.startTime - b.startTime);
  return events;
}

/**
 * TcasReport[] → { raEvents, coordEvents }.
 *
 * 모든 보고를 BDS 3,0 동일 비트 매핑으로 디코드한다(I260/BDS3,0; 지상 SSR에 BDS1,6은
 * 미수록 — 실데이터 전수 검증). 협의는 별도 레지스터가 아니라 RA의 **RAC(협의 보충)≠0
 * 또는 MTE(다중 위협)** 로 판정한다. 협의 RA는 RA 탭과 협의 탭 양쪽에 나타난다(협의는
 * RA의 속성). 유휴 패턴(`30000000` 등 비-RA)은 decodeRaReport의 hasRa로 걸러진다.
 */
export function buildEventsFromReports(reports: TcasReport[]): {
  raEvents: TcasEvent[];
  coordEvents: CoordEvent[];
} {
  const raByMs = new Map<string, RaPoint[]>();
  const coordByMs = new Map<string, RaPoint[]>();

  for (const r of reports) {
    const decoded = decodeRaReport(r.payload);
    if (!decoded || !decoded.hasRa) continue; // 유휴/비-RA 제외
    const pt: RaPoint = {
      ts: r.timestamp, lat: r.latitude, lon: r.longitude, altM: r.altitude,
      estimated: r.time_estimated, decoded, rawBytes: r.payload,
    };
    // RA 탭: 실제 RA 전부
    let raArr = raByMs.get(r.mode_s);
    if (!raArr) { raArr = []; raByMs.set(r.mode_s, raArr); }
    raArr.push(pt);
    // 협의 탭: 상대기와 협의된 회피 — RAC(협의 보충)≠0 또는 MTE(다중 위협)
    if (decoded.rac !== 0 || decoded.mte) {
      let coArr = coordByMs.get(r.mode_s);
      if (!coArr) { coArr = []; coordByMs.set(r.mode_s, coArr); }
      coArr.push(pt);
    }
  }

  return {
    raEvents: buildRaEvents(raByMs),
    coordEvents: buildCoordEventsInner(coordByMs),
  };
}
