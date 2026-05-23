/**
 * TCAS/ACAS 이벤트 생성기 — TcasReport(트랙 독립 전수 추출) 기반.
 *
 * Rust parser가 모든 CAT048 레코드에서 I260/BDS3,0을 전수 추출한 TcasReport[]를
 * 받아, mode_s별 시간 그룹핑하여 RA 이벤트로 만든다.
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
  frameBytes: number[];
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
  /** CAT048 레코드 원본 바이트 hex (프레임 전문) */
  frameHex: string;
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
        frameHex: rep.frameBytes.map((b) => b.toString(16).padStart(2, "0")).join(""),
      });
    }
  }
  events.sort((a, b) => a.startTime - b.startTime);
  return events;
}

/**
 * TcasReport[] → RA 이벤트 목록.
 *
 * 모든 보고를 BDS 3,0 동일 비트 매핑으로 디코드한다(I260/BDS3,0; 지상 SSR에 BDS1,6은
 * 미수록 — 실데이터 전수 검증). 유휴 패턴(`30000000` 등 비-RA)은 decodeRaReport의
 * hasRa로 걸러진다.
 */
export function buildEventsFromReports(reports: TcasReport[]): TcasEvent[] {
  const raByMs = new Map<string, RaPoint[]>();

  for (const r of reports) {
    const decoded = decodeRaReport(r.payload);
    if (!decoded || !decoded.hasRa) continue; // 유휴/비-RA 제외
    const pt: RaPoint = {
      ts: r.timestamp, lat: r.latitude, lon: r.longitude, altM: r.altitude,
      estimated: r.time_estimated, decoded, rawBytes: r.payload, frameBytes: r.raw_frame ?? [],
    };
    let raArr = raByMs.get(r.mode_s);
    if (!raArr) { raArr = []; raByMs.set(r.mode_s, raArr); }
    raArr.push(pt);
  }

  return buildRaEvents(raByMs);
}
