import type { Aircraft, Flight, FlightRecord, RadarSite, TrackPoint } from "../types";
import { correctAnomalousAltitudes } from "./altitudeCorrection";
import { detectLoss } from "./lossDetection";

/** 4시간 gap으로 비행 분리 */
const GAP_THRESHOLD_SECS = 14400;

/** OpenSky 매칭 시간 허용 오차 (초) */
const MATCH_TOLERANCE_SECS = 300; // ±5분

/** 비행 라벨 생성 */
export function flightLabel(f: Flight, aircraft: Aircraft[]): string {
  const name = f.aircraft_name ?? aircraft.find(
    (a) => a.mode_s_code.toUpperCase() === f.mode_s.toUpperCase()
  )?.name ?? f.mode_s;
  const parts = [name];
  if (f.callsign) parts.push(f.callsign);
  if (f.departure_airport || f.arrival_airport) {
    parts.push(`${f.departure_airport ?? "?"} → ${f.arrival_airport ?? "?"}`);
  }
  return parts.join(" · ");
}

/**
 * 같은 날 4시간 이내의 OpenSky FlightRecord를 하나로 병합.
 * 출발만 있는 레코드 + 도착만 있는 레코드 → 하나의 비행으로 합침.
 */
export function mergeFlightRecords(records: FlightRecord[]): FlightRecord[] {
  if (records.length <= 1) return records;

  // icao24별로 그룹핑
  const byIcao = new Map<string, FlightRecord[]>();
  for (const r of records) {
    const key = r.icao24.toUpperCase();
    let arr = byIcao.get(key);
    if (!arr) {
      arr = [];
      byIcao.set(key, arr);
    }
    arr.push(r);
  }

  const merged: FlightRecord[] = [];

  for (const [, group] of byIcao) {
    // 시간순 정렬
    group.sort((a, b) => a.first_seen - b.first_seen);

    const used = new Set<number>();

    for (let i = 0; i < group.length; i++) {
      if (used.has(i)) continue;

      let current = { ...group[i] };

      // 같은 날, 4시간 이내인 다음 레코드와 병합 시도
      for (let j = i + 1; j < group.length; j++) {
        if (used.has(j)) continue;
        const next = group[j];

        // 4시간 이내 확인
        const timeDiff = next.first_seen - current.last_seen;
        if (timeDiff > GAP_THRESHOLD_SECS || timeDiff < -GAP_THRESHOLD_SECS) continue;

        // 같은 날 확인
        const d1 = new Date(current.first_seen * 1000);
        const d2 = new Date(next.first_seen * 1000);
        if (d1.getFullYear() !== d2.getFullYear() ||
            d1.getMonth() !== d2.getMonth() ||
            d1.getDate() !== d2.getDate()) continue;

        // 병합: 시간범위 확장, 공항정보 보완
        current = {
          ...current,
          first_seen: Math.min(current.first_seen, next.first_seen),
          last_seen: Math.max(current.last_seen, next.last_seen),
          est_departure_airport: current.est_departure_airport || next.est_departure_airport,
          est_arrival_airport: current.est_arrival_airport || next.est_arrival_airport,
          callsign: current.callsign || next.callsign,
        };
        used.add(j);
      }

      merged.push(current);
      used.add(i);
    }
  }

  return merged;
}

/**
 * 모든 TrackPoint를 비행 단위로 통합.
 *
 * 1. mode_s별 그룹핑 → 시간순 정렬
 * 2. FlightRecord 병합 (같은 날 4시간 이내 출발/도착 합치기)
 * 3. FlightRecord 매칭 (icao24 일치 + 시간 겹침 ±5분)
 * 4. 미매칭 points → 4시간 gap으로 분리
 * 5. 각 Flight에 loss 탐지 + 통계 계산
 */
export function consolidateFlights(
  allTrackPoints: TrackPoint[],
  flightHistory: FlightRecord[],
  aircraft: Aircraft[],
  radarSite: RadarSite,
): Flight[] {
  if (allTrackPoints.length === 0) return [];

  // OpenSky 비행 기록 병합 (같은 날 4시간 이내)
  const mergedHistory = mergeFlightRecords(flightHistory);

  // mode_s별 그룹핑 (대소문자 정규화)
  const byModeS = new Map<string, TrackPoint[]>();
  for (const p of allTrackPoints) {
    const key = p.mode_s.toUpperCase();
    let arr = byModeS.get(key);
    if (!arr) {
      arr = [];
      byModeS.set(key, arr);
    }
    arr.push(p);
  }

  // Aircraft name 매핑
  const aircraftByModeS = new Map<string, Aircraft>();
  for (const a of aircraft) {
    if (a.active && a.mode_s_code) {
      aircraftByModeS.set(a.mode_s_code.toUpperCase(), a);
    }
  }

  const flights: Flight[] = [];

  for (const [modeS, points] of byModeS) {
    points.sort((a, b) => a.timestamp - b.timestamp);

    const ac = aircraftByModeS.get(modeS.toUpperCase());

    // 이 mode_s에 매칭 가능한 FlightRecord 찾기 (병합된 기록 사용)
    const matchingRecords = mergedHistory.filter(
      (fr) => fr.icao24.toUpperCase() === modeS.toUpperCase()
    );

    // 각 포인트를 FlightRecord에 할당하거나 미매칭으로 남김
    const assigned = new Array<number>(points.length).fill(-1); // -1 = 미매칭
    const recordPoints = new Map<number, TrackPoint[]>();

    for (let ri = 0; ri < matchingRecords.length; ri++) {
      const fr = matchingRecords[ri];
      const frStart = fr.first_seen - MATCH_TOLERANCE_SECS;
      const frEnd = fr.last_seen + MATCH_TOLERANCE_SECS;

      for (let pi = 0; pi < points.length; pi++) {
        if (assigned[pi] >= 0) continue;
        const ts = points[pi].timestamp;
        if (ts >= frStart && ts <= frEnd) {
          assigned[pi] = ri;
          let arr = recordPoints.get(ri);
          if (!arr) {
            arr = [];
            recordPoints.set(ri, arr);
          }
          arr.push(points[pi]);
        }
      }
    }

    // FlightRecord 매칭된 비행 생성
    for (const [ri, pts] of recordPoints) {
      const fr = matchingRecords[ri];
      const flight = buildFlight(
        modeS, pts, radarSite, "opensky", ac?.name,
        fr.callsign?.trim() || undefined,
        fr.est_departure_airport ?? undefined,
        fr.est_arrival_airport ?? undefined,
      );
      flights.push(flight);
    }

    // 미매칭 포인트를 4시간 gap으로 분리
    const unmatched = points.filter((_, i) => assigned[i] < 0);
    if (unmatched.length > 0) {
      const groups = splitByGap(unmatched, GAP_THRESHOLD_SECS);
      for (const group of groups) {
        const flight = buildFlight(modeS, group, radarSite, "gap", ac?.name);
        flights.push(flight);
      }
    }
  }

  // 시간순 정렬
  flights.sort((a, b) => a.start_time - b.start_time);

  return flights;
}

/** TrackPoint 배열에서 Flight 객체 생성 */
function buildFlight(
  modeS: string,
  points: TrackPoint[],
  radarSite: RadarSite,
  matchType: "opensky" | "gap" | "manual",
  aircraftName?: string,
  callsign?: string,
  departure?: string,
  arrival?: string,
): Flight {
  points.sort((a, b) => a.timestamp - b.timestamp);

  // 이상고도 보정 (앞뒤 정상 포인트 기준 선형 보간)
  const { points: correctedPoints, correctedCount } = correctAnomalousAltitudes(points);
  if (correctedCount > 0) {
    console.log(`[고도보정] ${modeS}: ${correctedCount}개 포인트 보정됨`);
  }

  const { lossPoints, lossSegments, maxRadarRangeKm } = detectLoss(
    correctedPoints, radarSite.latitude, radarSite.longitude,
  );

  const startTime = correctedPoints[0].timestamp;
  const endTime = correctedPoints[correctedPoints.length - 1].timestamp;
  const totalTrackTime = endTime - startTime;

  // gap별 고유 지속시간 합산 (signal_loss만)
  const gapDurations = new Map<string, number>();
  for (const lp of lossPoints) {
    if (lp.loss_type === "out_of_range") continue;
    const key = `${lp.mode_s}_${lp.gap_start_time}`;
    if (!gapDurations.has(key)) gapDurations.set(key, lp.gap_duration_secs);
  }
  const totalLossTime = Array.from(gapDurations.values()).reduce((s, d) => s + d, 0);

  const lossPercentage = totalTrackTime > 0 ? (totalLossTime / totalTrackTime) * 100 : 0;

  return {
    id: `${modeS}_${startTime}`,
    mode_s: modeS,
    aircraft_name: aircraftName,
    callsign,
    departure_airport: departure,
    arrival_airport: arrival,
    start_time: startTime,
    end_time: endTime,
    track_points: correctedPoints,
    loss_points: lossPoints,
    loss_segments: lossSegments,
    total_loss_time: totalLossTime,
    total_track_time: totalTrackTime,
    loss_percentage: lossPercentage,
    max_radar_range_km: maxRadarRangeKm,
    match_type: matchType,
  };
}

/**
 * 수동 병합: 선택된 Flight들을 하나로 합침.
 * - track_points 합산 후 시간순 정렬
 * - loss 재탐지
 * - callsign/공항 정보는 가장 먼저 존재하는 값 사용
 */
export function manualMergeFlights(
  selectedFlights: Flight[],
  radarSite: RadarSite,
): Flight {
  // 시간순으로 정렬
  const sorted = [...selectedFlights].sort((a, b) => a.start_time - b.start_time);

  // 모든 track_points 합산
  const allPoints = sorted.flatMap((f) => f.track_points);
  const modeS = sorted[0].mode_s;

  // 메타 정보: 첫 번째로 존재하는 값 사용
  const aircraftName = sorted.find((f) => f.aircraft_name)?.aircraft_name;
  const callsign = sorted.find((f) => f.callsign)?.callsign;
  const departure = sorted.find((f) => f.departure_airport)?.departure_airport;
  const arrival = [...sorted].reverse().find((f) => f.arrival_airport)?.arrival_airport;

  return buildFlight(
    modeS, allPoints, radarSite, "manual", aircraftName,
    callsign, departure, arrival,
  );
}

/** 정렬된 포인트를 gap 기준으로 분리 */
function splitByGap(points: TrackPoint[], gapSecs: number): TrackPoint[][] {
  if (points.length === 0) return [];
  const groups: TrackPoint[][] = [[points[0]]];
  for (let i = 1; i < points.length; i++) {
    const gap = points[i].timestamp - points[i - 1].timestamp;
    if (gap >= gapSecs) {
      groups.push([points[i]]);
    } else {
      groups[groups.length - 1].push(points[i]);
    }
  }
  return groups;
}
