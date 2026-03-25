
/**
 * Web Worker — 비행 통합 + Loss 탐지 CPU 집약 연산 오프로드
 *
 * 대량 데이터(10M+ 포인트)는 청크 스트리밍으로 수신/반환하여 OOM 방지.
 *
 * Main thread 와 통신:
 *  - ADD_POINTS    : 포인트 청크 수신 → Worker 내부 축적
 *  - CONSOLIDATE   : 축적된 포인트로 consolidateFlights 실행, 결과를 비행 단위 청크로 반환
 *  - MANUAL_MERGE  : 선택 비행 수동 병합
 *  - BUILD_FLIGHT  : 단일 비행 구축 (소규모 데이터용)
 */

// ─── 타입 (Worker 내 로컬 재선언) ───────────────────

interface TrackPoint {
  timestamp: number;
  mode_s: string;
  latitude: number;
  longitude: number;
  altitude: number;
  speed: number;
  heading: number;
  radar_type: string;
  raw_data?: string;
  radar_name?: string;
}

interface LossPoint {
  mode_s: string;
  timestamp: number;
  latitude: number;
  longitude: number;
  altitude: number;
  radar_distance_km: number;
  loss_type: string;
  scan_index: number;
  total_missed_scans: number;
  gap_start_time: number;
  gap_end_time: number;
  gap_duration_secs: number;
}

interface LossSegment {
  mode_s: string;
  start_time: number;
  end_time: number;
  start_lat: number;
  start_lon: number;
  end_lat: number;
  end_lon: number;
  duration_secs: number;
  distance_km: number;
  last_altitude: number;
  start_altitude: number;
  end_altitude: number;
  loss_type: string;
  start_radar_dist_km: number;
  end_radar_dist_km: number;
}

interface Flight {
  id: string;
  mode_s: string;
  aircraft_name?: string;
  callsign?: string;
  departure_airport?: string;
  arrival_airport?: string;
  start_time: number;
  end_time: number;
  track_points: TrackPoint[];
  loss_points: LossPoint[];
  loss_segments: LossSegment[];
  total_loss_time: number;
  total_track_time: number;
  loss_percentage: number;
  max_radar_range_km: number;
  match_type: string;
  radar_name?: string;
  point_count: number;
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  radar_type_counts: Record<string, number>;
  within_60nm_stats?: { total: number; psr: number };
}

interface FlightRecord {
  icao24: string;
  first_seen: number;
  last_seen: number;
  est_departure_airport: string | null;
  est_arrival_airport: string | null;
  callsign: string | null;
}

interface Aircraft {
  id: string;
  name: string;
  registration: string;
  model: string;
  mode_s_code: string;
  organization: string;
  memo: string;
  active: boolean;
}

interface RadarSite {
  name: string;
  latitude: number;
  longitude: number;
  altitude: number;
  antenna_height: number;
  range_nm: number;
}

// ─── 상수 ──────────────────────────────────────────

const GAP_THRESHOLD_SECS = 14400;
const MATCH_TOLERANCE_SECS = 300;

// Loss 탐지 상수
const DEFAULT_THRESHOLD_SECS = 7.0;
const OUT_OF_RANGE_THRESHOLD = 1.0;
const MAX_CONSECUTIVE_SIGNAL_LOSS_SCANS = 15.0;
const MAX_LOSS_DURATION_SECS = 14400.0;
const SPEED_DEVIATION_RATIO = 0.5;

// 이상고도 보정 상수
const MAX_VERTICAL_RATE_MS = 100;
const MIN_VALID_ALTITUDE_M = -100;
const MAX_VALID_ALTITUDE_M = 20000;
const SPIKE_DEVIATION_M = 300;

// ─── 포인트 축적 버퍼 + 비행 인덱스 ─────────────────

let _pointBuffer: TrackPoint[] = [];

/** 비행별 포인트 인덱스 (consolidation 완료 후 포인트 소유) */
interface FlightIndexEntry {
  flightId: string;
  modeS: string;
  radarName: string;
  startTime: number;
  endTime: number;
  points: TrackPoint[];
}
let _flightIndex = new Map<string, FlightIndexEntry>();
let _consolidating = false; // 통합 중 뷰포트 쿼리가 빈 결과 반환 방지

// ─── Haversine 거리 계산 ────────────────────────────

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371.0;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(Math.min(a, 1)));
}

// ─── 이상고도 보정 ──────────────────────────────────

function buildNextNormalIdx(isAnomalous: Uint8Array, n: number): Int32Array {
  const next = new Int32Array(n).fill(-1);
  for (let i = n - 2; i >= 0; i--) {
    next[i] = isAnomalous[i + 1] ? next[i + 1] : i + 1;
  }
  return next;
}

function buildPrevNormalIdx(isAnomalous: Uint8Array, n: number): Int32Array {
  const prev = new Int32Array(n).fill(-1);
  for (let i = 1; i < n; i++) {
    prev[i] = isAnomalous[i - 1] ? prev[i - 1] : i - 1;
  }
  return prev;
}

function correctAnomalousAltitudes(
  points: TrackPoint[],
): { points: TrackPoint[]; correctedCount: number } {
  if (points.length < 3) return { points, correctedCount: 0 };

  const n = points.length;
  // Uint8Array: boolean[] 대비 메모리 8배 절감, 캐시 효율 향상
  const isAnomalous = new Uint8Array(n);
  let hasAny = false;

  // 1단계: 절대 범위 검사
  for (let i = 0; i < n; i++) {
    const alt = points[i].altitude;
    if (alt < MIN_VALID_ALTITUDE_M || alt > MAX_VALID_ALTITUDE_M) {
      isAnomalous[i] = 1;
      hasAny = true;
    }
  }

  // 2단계: 수직속도 기반 이상값 감지
  {
    let lastSeenNormal = -1;
    if (!isAnomalous[0]) lastSeenNormal = 0;
    for (let i = 1; i < n - 1; i++) {
      if (isAnomalous[i]) continue;
      const curr = points[i];
      const next = points[i + 1];
      const prevIdx = lastSeenNormal;
      if (prevIdx < 0) { lastSeenNormal = i; continue; }
      const prev = points[prevIdx];
      const dtPrev = curr.timestamp - prev.timestamp;
      const dtNext = next.timestamp - curr.timestamp;
      if (dtPrev <= 0 || dtNext <= 0) { lastSeenNormal = i; continue; }
      const vrPrev = Math.abs(curr.altitude - prev.altitude) / dtPrev;
      const vrNext = Math.abs(next.altitude - curr.altitude) / dtNext;
      if ((vrPrev > MAX_VERTICAL_RATE_MS && vrNext > MAX_VERTICAL_RATE_MS) || vrPrev > 500 || vrNext > 500) {
        isAnomalous[i] = 1;
        hasAny = true;
      }
      if (!isAnomalous[i]) lastSeenNormal = i;
    }
  }

  // 이상값이 전혀 없으면 2.5단계 이후 전부 스킵 → 즉시 리턴
  if (!hasAny) return { points, correctedCount: 0 };

  // 2.5단계: 단일 포인트 스파이크 탐지
  {
    const nextNormal = buildNextNormalIdx(isAnomalous, n);
    let lastSeen25 = -1;
    if (!isAnomalous[0]) lastSeen25 = 0;
    for (let i = 1; i < n - 1; i++) {
      if (isAnomalous[i]) continue;
      const leftIdx = lastSeen25;
      const rightIdx = nextNormal[i];
      if (leftIdx < 0 || rightIdx < 0) { lastSeen25 = i; continue; }
      const left = points[leftIdx], right = points[rightIdx], curr = points[i];
      const totalDt = right.timestamp - left.timestamp;
      if (totalDt <= 0) { lastSeen25 = i; continue; }
      const t = (curr.timestamp - left.timestamp) / totalDt;
      const expectedAlt = left.altitude + (right.altitude - left.altitude) * t;
      if (Math.abs(curr.altitude - expectedAlt) > SPIKE_DEVIATION_M) isAnomalous[i] = 1;
      if (!isAnomalous[i]) lastSeen25 = i;
    }
  }

  // 첫 포인트 검사
  if (!isAnomalous[0] && n >= 2) {
    let firstNormal = -1, secondNormal = -1;
    for (let j = 1; j < n; j++) {
      if (!isAnomalous[j]) {
        if (firstNormal < 0) firstNormal = j;
        else { secondNormal = j; break; }
      }
    }
    if (firstNormal >= 0) {
      const dt01 = points[firstNormal].timestamp - points[0].timestamp;
      if (dt01 > 0) {
        const vr01 = Math.abs(points[firstNormal].altitude - points[0].altitude) / dt01;
        if (vr01 > MAX_VERTICAL_RATE_MS) {
          if (secondNormal >= 0) {
            const dt12 = points[secondNormal].timestamp - points[firstNormal].timestamp;
            const vr12 = dt12 > 0 ? Math.abs(points[secondNormal].altitude - points[firstNormal].altitude) / dt12 : 0;
            if (vr12 <= MAX_VERTICAL_RATE_MS) isAnomalous[0] = 1;
          } else {
            isAnomalous[0] = 1;
          }
        }
      }
    }
  }

  // 끝 포인트 검사
  if (!isAnomalous[n - 1] && n >= 2) {
    let firstNormal = -1, secondNormal = -1;
    for (let j = n - 2; j >= 0; j--) {
      if (!isAnomalous[j]) {
        if (firstNormal < 0) firstNormal = j;
        else { secondNormal = j; break; }
      }
    }
    if (firstNormal >= 0) {
      const dtLast = points[n - 1].timestamp - points[firstNormal].timestamp;
      if (dtLast > 0) {
        const vrLast = Math.abs(points[n - 1].altitude - points[firstNormal].altitude) / dtLast;
        if (vrLast > MAX_VERTICAL_RATE_MS) {
          if (secondNormal >= 0) {
            const dtPrev = points[firstNormal].timestamp - points[secondNormal].timestamp;
            const vrPrev = dtPrev > 0 ? Math.abs(points[firstNormal].altitude - points[secondNormal].altitude) / dtPrev : 0;
            if (vrPrev <= MAX_VERTICAL_RATE_MS) isAnomalous[n - 1] = 1;
          } else {
            isAnomalous[n - 1] = 1;
          }
        }
      }
    }
  }

  // lookup 재빌드 + 전파
  let nextNormalIdx = buildNextNormalIdx(isAnomalous, n);
  let prevNormalIdx = buildPrevNormalIdx(isAnomalous, n);

  if (isAnomalous[0]) {
    for (let i = 1; i < n - 1; i++) {
      if (isAnomalous[i]) continue;
      const nextIdx = nextNormalIdx[i];
      if (nextIdx < 0) continue;
      const dtNext = points[nextIdx].timestamp - points[i].timestamp;
      if (dtNext <= 0) continue;
      const vrNext = Math.abs(points[nextIdx].altitude - points[i].altitude) / dtNext;
      if (vrNext > MAX_VERTICAL_RATE_MS) { isAnomalous[i] = 1; } else { break; }
    }
  }
  if (isAnomalous[n - 1]) {
    for (let i = n - 2; i > 0; i--) {
      if (isAnomalous[i]) continue;
      const pIdx = prevNormalIdx[i];
      if (pIdx < 0) continue;
      const dtPrev = points[i].timestamp - points[pIdx].timestamp;
      if (dtPrev <= 0) continue;
      const vrPrev = Math.abs(points[i].altitude - points[pIdx].altitude) / dtPrev;
      if (vrPrev > MAX_VERTICAL_RATE_MS) { isAnomalous[i] = 1; } else { break; }
    }
  }

  // 3단계: 보정 — in-place 수정 (새 배열 할당 없음)
  prevNormalIdx = buildPrevNormalIdx(isAnomalous, n);
  nextNormalIdx = buildNextNormalIdx(isAnomalous, n);

  let correctedCount = 0;
  for (let i = 0; i < n; i++) {
    if (!isAnomalous[i]) continue;
    const leftIdx = prevNormalIdx[i];
    const rightIdx = nextNormalIdx[i];
    let newAlt: number;
    if (leftIdx >= 0 && rightIdx >= 0) {
      const left = points[leftIdx], right = points[rightIdx];
      const totalDt = right.timestamp - left.timestamp;
      newAlt = totalDt > 0
        ? left.altitude + (right.altitude - left.altitude) * ((points[i].timestamp - left.timestamp) / totalDt)
        : left.altitude;
    } else if (leftIdx >= 0) {
      newAlt = points[leftIdx].altitude;
    } else if (rightIdx >= 0) {
      newAlt = points[rightIdx].altitude;
    } else {
      continue;
    }
    points[i] = { ...points[i], altitude: Math.round(newAlt) };
    correctedCount++;
  }

  return { points, correctedCount };
}

// ─── Loss 탐지 ──────────────────────────────────────

function estimateScanInterval(points: TrackPoint[]): number | null {
  if (points.length < 5) return null;
  const gaps: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const g = points[i].timestamp - points[i - 1].timestamp;
    if (g > 0.5 && g < 30.0) gaps.push(g);
  }
  if (gaps.length < 3) return null;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] ?? null;
}

function estimateMaxRadarRange(points: TrackPoint[], radarLat: number, radarLon: number): number {
  if (points.length === 0) return 150.0;
  const distances = points.map((p) => haversine(radarLat, radarLon, p.latitude, p.longitude));
  distances.sort((a, b) => a - b);
  const idx = Math.min(Math.floor(distances.length * 0.95), distances.length - 1);
  return Math.max(distances[idx], 50.0);
}

function detectLossForTrack(
  modeS: string, points: TrackPoint[], thresholdSecs: number,
  scanIntervalSecs: number, radarLat: number, radarLon: number, maxRadarRangeKm: number,
): LossPoint[] {
  if (points.length < 2) return [];
  const boundaryKm = maxRadarRangeKm * OUT_OF_RANGE_THRESHOLD;
  const lossPoints: LossPoint[] = [];

  for (let i = 0; i < points.length - 1; i++) {
    const prev = points[i], next = points[i + 1];
    const gap = next.timestamp - prev.timestamp;
    if (gap > thresholdSecs && gap <= MAX_LOSS_DURATION_SECS) {
      if (gap <= 0) continue;
      const startRadarDist = haversine(radarLat, radarLon, prev.latitude, prev.longitude);
      const endRadarDist = haversine(radarLat, radarLon, next.latitude, next.longitude);
      const missedScans = gap / scanIntervalSecs;
      const gapDistKm = haversine(prev.latitude, prev.longitude, next.latitude, next.longitude);
      const impliedSpeedKts = (gapDistKm / gap) * 3600 / 1.852;
      const prevSpeed = prev.speed;
      const speedDeviation = prevSpeed > 10 ? Math.abs(impliedSpeedKts - prevSpeed) / prevSpeed : 0;

      let lossType: string;
      if (startRadarDist >= boundaryKm && endRadarDist >= boundaryKm) {
        lossType = "out_of_range";
      } else if (missedScans >= MAX_CONSECUTIVE_SIGNAL_LOSS_SCANS && (startRadarDist >= boundaryKm || endRadarDist >= boundaryKm)) {
        lossType = "out_of_range";
      } else if (speedDeviation > SPEED_DEVIATION_RATIO) {
        lossType = "out_of_range";
      } else {
        lossType = "signal_loss";
      }
      if (lossType === "out_of_range") continue;

      const totalMissed = Math.max(1, Math.round(gap / scanIntervalSecs) - 1);
      for (let si = 1; si <= totalMissed; si++) {
        const t = si / (totalMissed + 1);
        lossPoints.push({
          mode_s: modeS, timestamp: prev.timestamp + gap * t,
          latitude: prev.latitude + (next.latitude - prev.latitude) * t,
          longitude: prev.longitude + (next.longitude - prev.longitude) * t,
          altitude: prev.altitude + (next.altitude - prev.altitude) * t,
          radar_distance_km: startRadarDist + (endRadarDist - startRadarDist) * t,
          loss_type: lossType, scan_index: si, total_missed_scans: totalMissed,
          gap_start_time: prev.timestamp, gap_end_time: next.timestamp, gap_duration_secs: gap,
        });
      }
    }
  }
  return lossPoints;
}

function deriveSegments(points: LossPoint[], trackPoints: TrackPoint[]): LossSegment[] {
  if (points.length === 0) return [];
  const gapMap = new Map<string, LossPoint[]>();
  for (const p of points) {
    const key = `${p.mode_s}_${p.gap_start_time}`;
    let arr = gapMap.get(key);
    if (!arr) { arr = []; gapMap.set(key, arr); }
    arr.push(p);
  }
  const segments: LossSegment[] = [];
  const tpByModeS = new Map<string, TrackPoint[]>();
  for (const tp of trackPoints) {
    let arr = tpByModeS.get(tp.mode_s);
    if (!arr) { arr = []; tpByModeS.set(tp.mode_s, arr); }
    arr.push(tp);
  }
  for (const [, gapPoints] of gapMap) {
    const first = gapPoints[0];
    const modeS = first.mode_s;
    const pts = tpByModeS.get(modeS) ?? [];
    const prevPt = pts.find((p) => Math.abs(p.timestamp - first.gap_start_time) < 0.5);
    const nextPt = pts.find((p) => Math.abs(p.timestamp - first.gap_end_time) < 0.5);
    if (!prevPt || !nextPt) continue;
    segments.push({
      mode_s: modeS, start_time: first.gap_start_time, end_time: first.gap_end_time,
      start_lat: prevPt.latitude, start_lon: prevPt.longitude,
      end_lat: nextPt.latitude, end_lon: nextPt.longitude,
      duration_secs: first.gap_duration_secs,
      distance_km: haversine(prevPt.latitude, prevPt.longitude, nextPt.latitude, nextPt.longitude),
      last_altitude: prevPt.altitude, start_altitude: prevPt.altitude, end_altitude: nextPt.altitude,
      loss_type: first.loss_type, start_radar_dist_km: first.radar_distance_km,
      end_radar_dist_km: gapPoints[gapPoints.length - 1].radar_distance_km,
    });
  }
  segments.sort((a, b) => a.start_time - b.start_time);
  return segments;
}

function detectLoss(
  points: TrackPoint[], radarLat: number, radarLon: number,
  thresholdSecs: number = DEFAULT_THRESHOLD_SECS,
): { lossPoints: LossPoint[]; lossSegments: LossSegment[]; maxRadarRangeKm: number } {
  const groups = new Map<string, TrackPoint[]>();
  for (const p of points) {
    let arr = groups.get(p.mode_s);
    if (!arr) { arr = []; groups.set(p.mode_s, arr); }
    arr.push(p);
  }
  const allPoints: LossPoint[] = [];
  let overallMaxRange = 50.0;
  for (const [modeS, pts] of groups) {
    if (pts.length < 1) continue;
    pts.sort((a, b) => a.timestamp - b.timestamp);
    const rangeKm = estimateMaxRadarRange(pts, radarLat, radarLon);
    if (rangeKm > overallMaxRange) overallMaxRange = rangeKm;
    const scanInterval = estimateScanInterval(pts) ?? 5.0;
    const detected = detectLossForTrack(modeS, pts, thresholdSecs, scanInterval, radarLat, radarLon, rangeKm);
    for (let i = 0; i < detected.length; i++) allPoints.push(detected[i]);
  }
  allPoints.sort((a, b) => a.timestamp - b.timestamp);
  return { lossPoints: allPoints, lossSegments: deriveSegments(allPoints, points), maxRadarRangeKm: overallMaxRange };
}

// ─── buildFlight ────────────────────────────────────

function buildFlight(
  modeS: string, points: TrackPoint[], radarLat: number, radarLon: number,
  matchType: string, aircraftName?: string, callsign?: string,
  departure?: string, arrival?: string, radarName?: string,
): Flight {
  points.sort((a, b) => a.timestamp - b.timestamp);
  const { points: correctedPoints, correctedCount } = correctAnomalousAltitudes(points);
  if (correctedCount > 0) console.log(`[Worker 고도보정] ${modeS}: ${correctedCount}개 보정`);

  if (correctedPoints.length === 0) {
    return {
      id: `${modeS}_0`, mode_s: modeS, aircraft_name: aircraftName,
      callsign, departure_airport: departure, arrival_airport: arrival,
      start_time: 0, end_time: 0, track_points: [], loss_points: [], loss_segments: [],
      total_loss_time: 0, total_track_time: 0, loss_percentage: 0,
      max_radar_range_km: 0, match_type: matchType, radar_name: radarName,
      point_count: 0,
      bbox: { minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 },
      radar_type_counts: {},
    };
  }

  const { lossPoints, lossSegments, maxRadarRangeKm } = detectLoss(correctedPoints, radarLat, radarLon);
  const startTime = correctedPoints[0].timestamp;
  const endTime = correctedPoints[correctedPoints.length - 1].timestamp;
  const totalTrackTime = endTime - startTime;

  const gapDurations = new Map<string, number>();
  for (const lp of lossPoints) {
    if (lp.loss_type === "out_of_range") continue;
    const key = `${lp.mode_s}_${lp.gap_start_time}`;
    if (!gapDurations.has(key)) gapDurations.set(key, lp.gap_duration_secs);
  }
  const totalLossTime = Array.from(gapDurations.values()).reduce((s, d) => s + d, 0);

  // 메타데이터 사전 계산 (bbox, radar_type_counts, 60NM PSR)
  const NM60_KM = 60 * 1.852;
  const psrTypes = new Set(["mode_ac_psr", "mode_s_allcall_psr", "mode_s_rollcall_psr"]);
  const bbox = { minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity };
  const radarTypeCounts: Record<string, number> = {};
  let w60Total = 0, w60Psr = 0;
  for (let i = 0; i < correctedPoints.length; i++) {
    const p = correctedPoints[i];
    if (p.latitude < bbox.minLat) bbox.minLat = p.latitude;
    if (p.latitude > bbox.maxLat) bbox.maxLat = p.latitude;
    if (p.longitude < bbox.minLon) bbox.minLon = p.longitude;
    if (p.longitude > bbox.maxLon) bbox.maxLon = p.longitude;
    radarTypeCounts[p.radar_type] = (radarTypeCounts[p.radar_type] ?? 0) + 1;
    const dist = haversine(radarLat, radarLon, p.latitude, p.longitude);
    if (dist <= NM60_KM) {
      w60Total++;
      if (psrTypes.has(p.radar_type)) w60Psr++;
    }
  }

  return {
    id: `${modeS}_${startTime}`, mode_s: modeS, aircraft_name: aircraftName,
    callsign, departure_airport: departure, arrival_airport: arrival,
    start_time: startTime, end_time: endTime, track_points: correctedPoints,
    loss_points: lossPoints, loss_segments: lossSegments,
    total_loss_time: totalLossTime, total_track_time: totalTrackTime,
    loss_percentage: totalTrackTime > 0 ? (totalLossTime / totalTrackTime) * 100 : 0,
    max_radar_range_km: maxRadarRangeKm, match_type: matchType, radar_name: radarName,
    point_count: correctedPoints.length,
    bbox,
    radar_type_counts: radarTypeCounts,
    within_60nm_stats: { total: w60Total, psr: w60Psr },
  };
}

// ─── consolidateFlights (Worker 내부) ───────────────

function splitByGap(points: TrackPoint[], gapSecs: number): TrackPoint[][] {
  if (points.length === 0) return [];
  const groups: TrackPoint[][] = [[points[0]]];
  for (let i = 1; i < points.length; i++) {
    if (points[i].timestamp - points[i - 1].timestamp >= gapSecs) {
      groups.push([points[i]]);
    } else {
      groups[groups.length - 1].push(points[i]);
    }
  }
  return groups;
}

function mergeFlightRecords(records: FlightRecord[]): FlightRecord[] {
  if (records.length <= 1) return records;
  const byIcao = new Map<string, FlightRecord[]>();
  for (const r of records) {
    const key = r.icao24.toUpperCase();
    let arr = byIcao.get(key);
    if (!arr) { arr = []; byIcao.set(key, arr); }
    arr.push(r);
  }
  const merged: FlightRecord[] = [];
  for (const [, group] of byIcao) {
    group.sort((a, b) => a.first_seen - b.first_seen);
    const used = new Set<number>();
    for (let i = 0; i < group.length; i++) {
      if (used.has(i)) continue;
      let current = { ...group[i] };
      for (let j = i + 1; j < group.length; j++) {
        if (used.has(j)) continue;
        const next = group[j];
        const timeDiff = next.first_seen - current.last_seen;
        if (timeDiff > GAP_THRESHOLD_SECS || timeDiff < -GAP_THRESHOLD_SECS) continue;
        const d1 = new Date(current.first_seen * 1000);
        const d2 = new Date(next.first_seen * 1000);
        if (d1.getFullYear() !== d2.getFullYear() || d1.getMonth() !== d2.getMonth() || d1.getDate() !== d2.getDate()) continue;
        current = { ...current,
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

/** 이벤트 루프 양보 — postMessage 전달 + GC 허용 */
const yieldWorker = () => new Promise<void>(r => setTimeout(r, 0));

/** 이진탐색: timestamp >= target인 첫 인덱스 */
function lowerBound(pts: TrackPoint[], target: number): number {
  let lo = 0, hi = pts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (pts[mid].timestamp < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 이진탐색: timestamp > target인 첫 인덱스 */
function upperBound(pts: TrackPoint[], target: number): number {
  let lo = 0, hi = pts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (pts[mid].timestamp <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * consolidateFlights를 비동기로 실행, 비행 단위 진짜 스트리밍 반환.
 *
 * 각 buildFlight 완료 후 setTimeout(0)으로 이벤트 루프에 양보하여:
 *  1. postMessage가 메인 스레드로 실제 전달됨
 *  2. Worker 쪽 GC가 이전 비행의 중간 데이터를 수거 가능
 */
async function consolidateAndStream(
  allTrackPoints: TrackPoint[],
  flightHistory: FlightRecord[],
  aircraft: Aircraft[],
  radarSite: RadarSite,
  requestId: number,
) {
  const radarLat = radarSite.latitude;
  const radarLon = radarSite.longitude;

  // 이전 인덱스 해제 (consolidateAndStream 시작 시점에서 클리어)
  _flightIndex.clear();

  if (allTrackPoints.length === 0) {
    self.postMessage({ type: "CONSOLIDATE_DONE", id: requestId, totalFlights: 0 });
    return;
  }

  const mergedHistory = mergeFlightRecords(flightHistory);

  // 진행률 보고: 그룹핑 단계
  const totalPoints = allTrackPoints.length;
  self.postMessage({ type: "CONSOLIDATE_PROGRESS", id: requestId, stage: "grouping", current: 0, total: totalPoints, flightsBuilt: 0 });

  // mode_s + radar_name 그룹핑
  const byModeSRadar = new Map<string, TrackPoint[]>();
  for (let i = 0; i < allTrackPoints.length; i++) {
    const p = allTrackPoints[i];
    const key = `${p.mode_s.toUpperCase()}|${p.radar_name ?? ""}`;
    let arr = byModeSRadar.get(key);
    if (!arr) { arr = []; byModeSRadar.set(key, arr); }
    arr.push(p);
    if (i > 0 && i % 200_000 === 0) {
      self.postMessage({ type: "CONSOLIDATE_PROGRESS", id: requestId, stage: "grouping", current: i, total: totalPoints, flightsBuilt: 0 });
    }
  }

  // 그룹핑 완료 → 원본 배열 참조 해제 (byModeSRadar가 포인트 소유)
  allTrackPoints.length = 0;

  const aircraftByModeS = new Map<string, Aircraft>();
  for (const a of aircraft) {
    if (a.active && a.mode_s_code) aircraftByModeS.set(a.mode_s_code.toUpperCase(), a);
  }

  let totalFlights = 0;

  const groupKeys = Array.from(byModeSRadar.keys());
  const totalGroups = groupKeys.length;

  // 진행률 보고: 비행 생성 단계
  self.postMessage({ type: "CONSOLIDATE_PROGRESS", id: requestId, stage: "building", current: 0, total: totalGroups, flightsBuilt: 0 });

  for (let gi = 0; gi < groupKeys.length; gi++) {
    const groupKey = groupKeys[gi];
    const points = byModeSRadar.get(groupKey)!;
    const [modeS, radarName] = groupKey.split("|");
    points.sort((a, b) => a.timestamp - b.timestamp);
    const ac = aircraftByModeS.get(modeS.toUpperCase());

    const matchingRecords = mergedHistory.filter(
      (fr) => fr.icao24.toUpperCase() === modeS.toUpperCase()
    );

    const assigned = new Array<number>(points.length).fill(-1);
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
          if (!arr) { arr = []; recordPoints.set(ri, arr); }
          arr.push(points[pi]);
        }
      }
    }

    for (const [ri, pts] of recordPoints) {
      const fr = matchingRecords[ri];
      const flight = buildFlight(
        modeS, pts, radarLat, radarLon, "gap", ac?.name,
        fr.callsign?.trim() || undefined,
        fr.est_departure_airport ?? undefined,
        fr.est_arrival_airport ?? undefined,
        radarName || undefined,
      );
      // 포인트를 인덱스에 저장, 메인에는 메타만 전송
      _flightIndex.set(flight.id, {
        flightId: flight.id, modeS: flight.mode_s, radarName: flight.radar_name ?? "",
        startTime: flight.start_time, endTime: flight.end_time,
        points: flight.track_points,
      });
      const { track_points: _, ...meta } = flight;
      self.postMessage({ type: "FLIGHT_CHUNK", id: requestId, flights: [{ ...meta, track_points: [] }] });
      totalFlights++;
      await yieldWorker();
    }

    const unmatched = points.filter((_, i) => assigned[i] < 0);
    if (unmatched.length > 0) {
      const gapGroups = splitByGap(unmatched, GAP_THRESHOLD_SECS);
      for (const group of gapGroups) {
        const flight = buildFlight(
          modeS, group, radarLat, radarLon, "gap", ac?.name,
          undefined, undefined, undefined, radarName || undefined,
        );
        _flightIndex.set(flight.id, {
          flightId: flight.id, modeS: flight.mode_s, radarName: flight.radar_name ?? "",
          startTime: flight.start_time, endTime: flight.end_time,
          points: flight.track_points,
        });
        const { track_points: _, ...meta } = flight;
        self.postMessage({ type: "FLIGHT_CHUNK", id: requestId, flights: [{ ...meta, track_points: [] }] });
        totalFlights++;
        await yieldWorker();
      }
    }

    // 이 그룹의 원본 포인트 참조 해제 → GC 허용
    byModeSRadar.delete(groupKey);

    // 진행률 보고
    self.postMessage({ type: "CONSOLIDATE_PROGRESS", id: requestId, stage: "building", current: gi + 1, total: totalGroups, flightsBuilt: totalFlights });
  }

  self.postMessage({ type: "CONSOLIDATE_PROGRESS", id: requestId, stage: "done", current: totalGroups, total: totalGroups, flightsBuilt: totalFlights });
  self.postMessage({ type: "CONSOLIDATE_DONE", id: requestId, totalFlights });
}

// ─── manualMergeFlights ─────────────────────────────

function manualMergeFlights(selectedFlights: Flight[], radarLat: number, radarLon: number): Flight {
  const sorted = [...selectedFlights].sort((a, b) => a.start_time - b.start_time);
  const allPoints = sorted.flatMap((f) => f.track_points);
  const modeS = sorted[0].mode_s;
  const aircraftName = sorted.find((f) => f.aircraft_name)?.aircraft_name;
  const callsign = sorted.find((f) => f.callsign)?.callsign;
  const departure = sorted.find((f) => f.departure_airport)?.departure_airport;
  const arrival = [...sorted].reverse().find((f) => f.arrival_airport)?.arrival_airport;
  const radarNameVal = sorted.find((f) => f.radar_name)?.radar_name;
  return buildFlight(modeS, allPoints, radarLat, radarLon, "manual", aircraftName, callsign, departure, arrival, radarNameVal);
}

// ─── Worker 메시지 핸들러 ───────────────────────────

self.onmessage = async (e: MessageEvent) => {
  const { type, id } = e.data;

  try {
    switch (type) {
      case "ADD_POINTS": {
        const pts: TrackPoint[] = e.data.points;
        for (let i = 0; i < pts.length; i++) _pointBuffer.push(pts[i]);
        self.postMessage({ type: "ADD_POINTS_ACK", id });
        break;
      }

      case "CONSOLIDATE": {
        const { flightHistory, aircraft, radarSite } = e.data;
        const t0 = performance.now();
        // _pointBuffer가 있으면 초기 통합, 비어있으면 _flightIndex에서 재통합
        let sourcePoints: TrackPoint[];
        if (_pointBuffer.length > 0) {
          sourcePoints = _pointBuffer;
          _pointBuffer = []; // 소유권 이전 (복사 없음)
        } else {
          // 재통합: _flightIndex에서 포인트 추출
          sourcePoints = [];
          for (const entry of _flightIndex.values()) {
            for (const p of entry.points) sourcePoints.push(p);
          }
        }
        // 통합 중 QUERY_VIEWPORT_POINTS에서 빈 결과를 반환하지 않도록
        // _flightIndex 클리어를 consolidateAndStream 완료 후로 이동
        _consolidating = true;
        await consolidateAndStream(sourcePoints, flightHistory, aircraft, radarSite, id);
        _consolidating = false;
        console.log(`[Worker] consolidateFlights: ${(performance.now() - t0).toFixed(0)}ms`);
        break;
      }

      case "BUILD_FLIGHT": {
        const { modeS, points, radarLat, radarLon, matchType, aircraftName, callsign, departure, arrival, radarName } = e.data;
        const flight = buildFlight(modeS, points, radarLat, radarLon, matchType, aircraftName, callsign, departure, arrival, radarName);
        self.postMessage({ type: "BUILD_FLIGHT_RESULT", id, flight });
        break;
      }

      case "MANUAL_MERGE": {
        const { selectedFlights, flightIds, radarSite } = e.data;
        let flight: Flight;
        if (flightIds && flightIds.length > 0) {
          // 새 방식: ID로 _flightIndex에서 포인트 수집
          const allPts: TrackPoint[] = [];
          const metas: Flight[] = selectedFlights ?? [];
          for (const fid of flightIds as string[]) {
            const entry = _flightIndex.get(fid);
            if (entry) for (const p of entry.points) allPts.push(p);
          }
          const sorted = [...metas].sort((a: Flight, b: Flight) => a.start_time - b.start_time);
          const modeS = sorted[0]?.mode_s ?? (allPts[0]?.mode_s ?? "");
          const acName = sorted.find((f: Flight) => f.aircraft_name)?.aircraft_name;
          const cs = sorted.find((f: Flight) => f.callsign)?.callsign;
          const dep = sorted.find((f: Flight) => f.departure_airport)?.departure_airport;
          const arr = [...sorted].reverse().find((f: Flight) => f.arrival_airport)?.arrival_airport;
          const rn = sorted.find((f: Flight) => f.radar_name)?.radar_name;
          flight = buildFlight(modeS, allPts, radarSite.latitude, radarSite.longitude, "manual", acName, cs, dep, arr, rn);
          // 인덱스 업데이트: 기존 삭제 + 새 항목 추가
          for (const fid of flightIds as string[]) _flightIndex.delete(fid);
          _flightIndex.set(flight.id, {
            flightId: flight.id, modeS: flight.mode_s, radarName: flight.radar_name ?? "",
            startTime: flight.start_time, endTime: flight.end_time,
            points: flight.track_points,
          });
        } else {
          // 레거시 방식: 전체 Flight 객체 전달 (호환)
          flight = manualMergeFlights(selectedFlights, radarSite.latitude, radarSite.longitude);
        }
        // 메인에는 track_points 제거한 메타 반환
        const { track_points: _, ...meta } = flight;
        self.postMessage({ type: "MANUAL_MERGE_RESULT", id, flight: { ...meta, track_points: [] } });
        break;
      }

      case "CLEAR_POINTS": {
        _pointBuffer.length = 0;
        _pointBuffer = [];
        _flightIndex.clear();
        self.postMessage({ type: "CLEAR_POINTS_ACK", id });
        break;
      }

      case "GET_POINT_SUMMARY": {
        // mode_s별 카운트 + 시간 범위 요약 (경량)
        const summary = new Map<string, { count: number; minTs: number; maxTs: number }>();
        let totalPts = 0;
        // _pointBuffer 또는 _flightIndex 중 데이터가 있는 쪽 사용
        if (_pointBuffer.length > 0) {
          totalPts = _pointBuffer.length;
          for (let i = 0; i < _pointBuffer.length; i++) {
            const p = _pointBuffer[i];
            const ms = p.mode_s.toUpperCase();
            const prev = summary.get(ms);
            if (!prev) {
              summary.set(ms, { count: 1, minTs: p.timestamp, maxTs: p.timestamp });
            } else {
              prev.count++;
              if (p.timestamp < prev.minTs) prev.minTs = p.timestamp;
              if (p.timestamp > prev.maxTs) prev.maxTs = p.timestamp;
            }
          }
        } else {
          for (const entry of _flightIndex.values()) {
            totalPts += entry.points.length;
            const ms = entry.modeS.toUpperCase();
            const prev = summary.get(ms);
            if (!prev) {
              summary.set(ms, { count: entry.points.length, minTs: entry.startTime, maxTs: entry.endTime });
            } else {
              prev.count += entry.points.length;
              if (entry.startTime < prev.minTs) prev.minTs = entry.startTime;
              if (entry.endTime > prev.maxTs) prev.maxTs = entry.endTime;
            }
          }
        }
        const entries = Array.from(summary.entries()).map(([modeS, v]) => ({
          modeS, count: v.count, minTs: v.minTs, maxTs: v.maxTs,
        }));
        self.postMessage({
          type: "GET_POINT_SUMMARY_RESULT", id,
          totalPoints: totalPts,
          entries,
        });
        break;
      }

      // ─── 뷰포트 쿼리 API ──────────────────────────────

      case "QUERY_VIEWPORT_POINTS": {
        const { radarName, selectedModeS, registeredModeS, timeRange, paddingPoints } = e.data;
        const CHUNK_SIZE = 200_000;
        let chunk: TrackPoint[] = [];
        let totalSent = 0;

        const flushChunk = () => {
          if (chunk.length === 0) return;
          self.postMessage({ type: "QUERY_VIEWPORT_POINTS_CHUNK", id, points: chunk });
          totalSent += chunk.length;
          chunk = [];
        };

        // 필터 매칭 여부 판정 함수
        const matchesFilter = (entry: FlightIndexEntry): boolean => {
          if (radarName && entry.radarName && entry.radarName !== radarName) return false;
          if (selectedModeS !== undefined && selectedModeS !== "__ALL__") {
            if (selectedModeS === null) {
              if (!registeredModeS || !(registeredModeS as string[]).includes(entry.modeS.toUpperCase())) return false;
            } else {
              if (entry.modeS.toUpperCase() !== selectedModeS.toUpperCase()) return false;
            }
          }
          return true;
        };

        // 전체 포인트 전송 (샘플링 없음)
        for (const entry of _flightIndex.values()) {
          if (!matchesFilter(entry)) continue;
          const pts = entry.points;
          if (timeRange) {
            const [tMin, tMax] = timeRange as [number, number];
            if (entry.endTime < tMin || entry.startTime > tMax) continue;
            let lo = lowerBound(pts, tMin);
            let hi = upperBound(pts, tMax);
            if (paddingPoints) {
              if (lo > 0) lo--;
              if (hi < pts.length) hi++;
            }
            for (let i = lo; i < hi; i++) {
              chunk.push(pts[i]);
              if (chunk.length >= CHUNK_SIZE) flushChunk();
            }
          } else {
            for (let i = 0; i < pts.length; i++) {
              chunk.push(pts[i]);
              if (chunk.length >= CHUNK_SIZE) flushChunk();
            }
          }
        }
        flushChunk();
        self.postMessage({ type: "QUERY_VIEWPORT_POINTS_DONE", id, totalPoints: totalSent });
        break;
      }

      case "QUERY_FLIGHT_POINTS": {
        const entry = _flightIndex.get(e.data.flightId as string);
        self.postMessage({
          type: "QUERY_FLIGHT_POINTS_RESULT", id,
          points: entry ? entry.points : [],
        });
        break;
      }

      case "QUERY_FLIGHT_POINTS_BATCH": {
        const batchIds = e.data.flightIds as string[];
        const allPts: TrackPoint[] = [];
        for (const fid of batchIds) {
          const entry = _flightIndex.get(fid);
          if (entry) for (const p of entry.points) allPts.push(p);
        }
        allPts.sort((a, b) => a.timestamp - b.timestamp);
        self.postMessage({ type: "QUERY_FLIGHT_POINTS_BATCH_RESULT", id, points: allPts });
        break;
      }

      default:
        self.postMessage({ type: "ERROR", id, error: `Unknown message type: ${type}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Worker] ${type} 오류:`, err);
    self.postMessage({ type: "ERROR", id, error: msg });
  }
};
