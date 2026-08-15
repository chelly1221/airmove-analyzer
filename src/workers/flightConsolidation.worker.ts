
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

import {
  type PointBatch, type FlightPointsSoA,
  batchFromObjects, pointAt, modeSOf, radarNameOf,
  unpackBatch,
} from "./pointSoA";

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
  tcas_ra?: number[];
  tcas_coord?: number[];
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

// ─── 이중표적 분석 타입 (src/types/dualTarget.ts 계약과 필드 완전 일치) ───

interface DualTargetObservation {
  timestamp: number;
  latitude: number;
  longitude: number;
  altitude: number;
  range_km: number;
  azimuth_deg: number;
  radar_type: string;
}

interface DualTargetReflector {
  latitude: number;
  longitude: number;
  range_km: number;
  azimuth_deg: number;
}

interface DualTargetEvent {
  id: number;
  mode_s: string;
  radar_name: string;
  real: DualTargetObservation;
  ghost: DualTargetObservation;
  separation_km: number;
  extra_path_km: number;
  reflector: DualTargetReflector | null;
  source: "scan" | "parser";
  confidence: "high" | "low";
  cluster_id: number | null;
}

interface ReflectorCluster {
  id: number;
  latitude: number;
  longitude: number;
  count: number;
  radar_name: string;
  building_name?: string | null;
}

interface DualTargetStats {
  flights_scanned: number;
  points_scanned: number;
  parser_ghosts: number;
  events_scan: number;
  events_parser: number;
  dropped_unmatched: number;
  aircraft_count: number;
  skipped_no_site: number;
}

interface DualTargetParams {
  scan_window_s: number;
  min_sep_km: number;
}

interface DualTargetResult {
  events: DualTargetEvent[];
  clusters: ReflectorCluster[];
  stats: DualTargetStats;
  params: DualTargetParams;
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

// 이중표적(반사 유령표적) 분석 상수
/** 반사 기하 역산 최소 초과경로 (km) — 이하면 해가 무의미하여 reflector = null */
const DUAL_MIN_EXTRA_PATH_KM = 0.05;
/** confidence "high" 판정 초과경로 (km) */
const DUAL_HIGH_CONFIDENCE_EXTRA_KM = 0.2;
/** 반사점 클러스터 그리드 (deg, ≈250m) */
const DUAL_CLUSTER_GRID_DEG = 0.0025;
/** 파서 보존분 ↔ 실항적 매칭 허용 시간 (초) */
const DUAL_PARSER_MATCH_WINDOW_S = 60;
/** 반사점 이분법 반복 횟수 / 수렴 허용오차 (km) */
const DUAL_BISECT_ITERS = 48;
const DUAL_BISECT_TOL_KM = 0.001;

// 이상고도 보정 상수
const MAX_VERTICAL_RATE_MS = 100;
const MIN_VALID_ALTITUDE_M = -100;
const MAX_VALID_ALTITUDE_M = 20000;
const SPIKE_DEVIATION_M = 300;

// ─── 포인트 축적 버퍼 + 비행 인덱스 (SoA 기반) ─────────

/** ADD_POINTS로 누적된 SoA 청크. CONSOLIDATE 시 그룹화 후 비움. */
let _pointBatches: PointBatch[] = [];

/** 비행별 포인트 인덱스 — points는 SoA로 보관 (consolidation 후) */
interface FlightIndexEntry {
  flightId: string;
  modeS: string;
  radarName: string;
  startTime: number;
  endTime: number;
  points: FlightPointsSoA;
}
let _flightIndex = new Map<string, FlightIndexEntry>();

/** 파서가 제거하되 보존한 유령표적 포인트 (ADD_GHOST_POINTS 누적).
 *  소량(통상 수천 이하)이므로 객체 배열로 보관해도 메모리 부담 없음. */
let _ghostPoints: TrackPoint[] = [];

/** SoA → TrackPoint[]로 한 비행씩 unpack — 외부 함수 호출 시 사용 */
function pointsArrayOf(entry: FlightIndexEntry): TrackPoint[] {
  return unpackBatch(entry.points) as TrackPoint[];
}


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

/** 구면 initial bearing — 진북 기준 0–360° */
function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** 구면 destination — (lat,lon)에서 방위 bearing 으로 distKm 이동한 지점 */
function destPointDeg(
  lat: number, lon: number, bearing: number, distKm: number,
): { latitude: number; longitude: number } {
  const R = 6371.0;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const p1 = toRad(lat);
  const l1 = toRad(lon);
  const brg = toRad(bearing);
  const d = distKm / R;
  const sinP2 = Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(brg);
  const p2 = Math.asin(Math.min(1, Math.max(-1, sinP2)));
  const l2 = l1 + Math.atan2(
    Math.sin(brg) * Math.sin(d) * Math.cos(p1),
    Math.cos(d) - Math.sin(p1) * Math.sin(p2),
  );
  return {
    latitude: (p2 * 180) / Math.PI,
    longitude: (((l2 * 180) / Math.PI + 540) % 360) - 180,
  };
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

/** SoA용 이진탐색: timestamp >= target인 첫 인덱스 */
function lowerBoundSoA(soa: PointBatch, target: number): number {
  let lo = 0, hi = soa.count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (soa.timestamp[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** SoA용 이진탐색: timestamp > target인 첫 인덱스 */
function upperBoundSoA(soa: PointBatch, target: number): number {
  let lo = 0, hi = soa.count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (soa.timestamp[mid] <= target) lo = mid + 1;
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
  sourceBatches: PointBatch[],
  flightHistory: FlightRecord[],
  aircraft: Aircraft[],
  radarSite: RadarSite,
  requestId: number,
) {
  const radarLat = radarSite.latitude;
  const radarLon = radarSite.longitude;

  // 이전 인덱스 해제 (consolidateAndStream 시작 시점에서 클리어)
  _flightIndex.clear();

  // 총 포인트 수
  let totalPoints = 0;
  for (const b of sourceBatches) totalPoints += b.count;
  if (totalPoints === 0) {
    self.postMessage({ type: "CONSOLIDATE_DONE", id: requestId, totalFlights: 0 });
    return;
  }

  const mergedHistory = mergeFlightRecords(flightHistory);

  self.postMessage({ type: "CONSOLIDATE_PROGRESS", id: requestId, stage: "grouping", current: 0, total: totalPoints, flightsBuilt: 0 });

  // mode_s + radar_name 그룹핑 — SoA 참조(ref) 단위로 보관 (객체 생성 X).
  // refs: { b: batchIdx, i: pointIdx } 16B/point 정도, 객체 250B 대비 메모리 절약.
  const byModeSRadar = new Map<string, Array<{ b: number; i: number }>>();
  let processed = 0;
  for (let bi = 0; bi < sourceBatches.length; bi++) {
    const batch = sourceBatches[bi];
    for (let pi = 0; pi < batch.count; pi++) {
      const ms = modeSOf(batch, pi).toUpperCase();
      const rn = radarNameOf(batch, pi);
      const key = `${ms}|${rn}`;
      let arr = byModeSRadar.get(key);
      if (!arr) { arr = []; byModeSRadar.set(key, arr); }
      arr.push({ b: bi, i: pi });
      processed++;
      if (processed % 200_000 === 0) {
        self.postMessage({ type: "CONSOLIDATE_PROGRESS", id: requestId, stage: "grouping", current: processed, total: totalPoints, flightsBuilt: 0 });
      }
    }
  }

  const aircraftByModeS = new Map<string, Aircraft>();
  for (const a of aircraft) {
    if (a.active && a.mode_s_code) aircraftByModeS.set(a.mode_s_code.toUpperCase(), a);
  }

  let totalFlights = 0;

  const groupKeys = Array.from(byModeSRadar.keys());
  const totalGroups = groupKeys.length;

  self.postMessage({ type: "CONSOLIDATE_PROGRESS", id: requestId, stage: "building", current: 0, total: totalGroups, flightsBuilt: 0 });

  for (let gi = 0; gi < groupKeys.length; gi++) {
    const groupKey = groupKeys[gi];
    const refs = byModeSRadar.get(groupKey)!;
    const [modeS, radarName] = groupKey.split("|");
    // ref 정렬 (시간순)
    refs.sort((a, b) => sourceBatches[a.b].timestamp[a.i] - sourceBatches[b.b].timestamp[b.i]);
    const ac = aircraftByModeS.get(modeS.toUpperCase());

    // 이 그룹의 객체 배열 일시 unpacking (한 그룹만 — 피크 메모리 제한)
    const points: TrackPoint[] = new Array(refs.length);
    for (let k = 0; k < refs.length; k++) {
      const r = refs[k];
      points[k] = pointAt(sourceBatches[r.b], r.i) as TrackPoint;
    }

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
      // flight.track_points(객체)를 SoA로 다시 패킹하여 _flightIndex에 저장
      const soa = batchFromObjects(flight.track_points);
      _flightIndex.set(flight.id, {
        flightId: flight.id, modeS: flight.mode_s, radarName: flight.radar_name ?? "",
        startTime: flight.start_time, endTime: flight.end_time,
        points: soa,
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
        const soa = batchFromObjects(flight.track_points);
        _flightIndex.set(flight.id, {
          flightId: flight.id, modeS: flight.mode_s, radarName: flight.radar_name ?? "",
          startTime: flight.start_time, endTime: flight.end_time,
          points: soa,
        });
        const { track_points: _, ...meta } = flight;
        self.postMessage({ type: "FLIGHT_CHUNK", id: requestId, flights: [{ ...meta, track_points: [] }] });
        totalFlights++;
        await yieldWorker();
      }
    }

    // 이 그룹 처리 완료 — refs/points 객체 배열 GC 허용
    byModeSRadar.delete(groupKey);

    self.postMessage({ type: "CONSOLIDATE_PROGRESS", id: requestId, stage: "building", current: gi + 1, total: totalGroups, flightsBuilt: totalFlights });
  }

  // SoA 입력 배치들도 해제
  for (let i = 0; i < sourceBatches.length; i++) sourceBatches[i] = null as unknown as PointBatch;
  sourceBatches.length = 0;

  self.postMessage({ type: "CONSOLIDATE_PROGRESS", id: requestId, stage: "done", current: totalGroups, total: totalGroups, flightsBuilt: totalFlights });
  self.postMessage({ type: "CONSOLIDATE_DONE", id: requestId, totalFlights });
}

// ─── 이중표적(레이더 반사 유령표적) 분석 ─────────────

/** 궤적 이탈도 (km) — target 이 prev→next 시간비례 보간 위치에서 벗어난 거리.
 *  ass.rs `trajectory_deviation` 과 동일 로직 (한쪽만 있으면 그 점과의 거리, 둘 다 없으면 0). */
function trajectoryDeviationSoA(
  soa: PointBatch, target: number, prevIdx: number, nextIdx: number,
): number {
  const tLat = soa.latitude[target];
  const tLon = soa.longitude[target];
  if (prevIdx >= 0 && nextIdx >= 0) {
    const dtTotal = soa.timestamp[nextIdx] - soa.timestamp[prevIdx];
    if (dtTotal <= 0) return 0;
    const ratio = (soa.timestamp[target] - soa.timestamp[prevIdx]) / dtTotal;
    const iLat = soa.latitude[prevIdx] + (soa.latitude[nextIdx] - soa.latitude[prevIdx]) * ratio;
    const iLon = soa.longitude[prevIdx] + (soa.longitude[nextIdx] - soa.longitude[prevIdx]) * ratio;
    return haversine(tLat, tLon, iLat, iLon);
  }
  if (prevIdx >= 0) return haversine(tLat, tLon, soa.latitude[prevIdx], soa.longitude[prevIdx]);
  if (nextIdx >= 0) return haversine(tLat, tLon, soa.latitude[nextIdx], soa.longitude[nextIdx]);
  return 0;
}

/** 반사점 역산 — 레이더 S·실표적 A 를 초점으로 하는 타원(경로합 = Rg)과 유령 방위선 θg 의 교점.
 *  f(r) = r + |dest(S,θg,r) − A| − Rg 는 r 에 대해 단조증가, f(0) = −extra_path < 0 이므로 이분법 수렴. */
function solveReflector(
  siteLat: number, siteLon: number, realLat: number, realLon: number,
  thetaG: number, rangeG: number,
): DualTargetReflector {
  let lo = 0;
  let hi = rangeG;
  let mid = rangeG / 2;
  for (let it = 0; it < DUAL_BISECT_ITERS; it++) {
    mid = (lo + hi) / 2;
    const p = destPointDeg(siteLat, siteLon, thetaG, mid);
    const f = mid + haversine(p.latitude, p.longitude, realLat, realLon) - rangeG;
    if (Math.abs(f) < DUAL_BISECT_TOL_KM) break;
    if (f < 0) lo = mid;
    else hi = mid;
  }
  const p = destPointDeg(siteLat, siteLon, thetaG, mid);
  return { latitude: p.latitude, longitude: p.longitude, range_km: mid, azimuth_deg: thetaG };
}

/** 관측(TrackPoint) → DualTargetObservation (레이더 기준 극좌표 재계산) */
function makeDualObservation(
  p: { timestamp: number; latitude: number; longitude: number; altitude: number; radar_type: string },
  siteLat: number, siteLon: number,
): DualTargetObservation {
  return {
    timestamp: p.timestamp,
    latitude: p.latitude,
    longitude: p.longitude,
    altitude: p.altitude,
    range_km: haversine(siteLat, siteLon, p.latitude, p.longitude),
    azimuth_deg: bearingDeg(siteLat, siteLon, p.latitude, p.longitude),
    radar_type: p.radar_type,
  };
}

/** 실/유령 관측 쌍 → 이벤트 조립 (id·cluster_id 는 후처리에서 부여) */
function buildDualEvent(
  modeS: string, radarName: string,
  realP: { timestamp: number; latitude: number; longitude: number; altitude: number; radar_type: string },
  ghostP: { timestamp: number; latitude: number; longitude: number; altitude: number; radar_type: string },
  siteLat: number, siteLon: number,
  source: "scan" | "parser",
): DualTargetEvent {
  const real = makeDualObservation(realP, siteLat, siteLon);
  const ghost = makeDualObservation(ghostP, siteLat, siteLon);
  const extraPath = ghost.range_km - real.range_km;
  return {
    id: 0,
    mode_s: modeS,
    radar_name: radarName,
    real,
    ghost,
    separation_km: haversine(real.latitude, real.longitude, ghost.latitude, ghost.longitude),
    extra_path_km: extraPath,
    reflector: extraPath <= DUAL_MIN_EXTRA_PATH_KM
      ? null
      : solveReflector(siteLat, siteLon, real.latitude, real.longitude, ghost.azimuth_deg, ghost.range_km),
    source,
    confidence: extraPath > DUAL_HIGH_CONFIDENCE_EXTRA_KM ? "high" : "low",
    cluster_id: null,
  };
}

/**
 * 이중표적 분석 — 잔존 동일스캔 중복(scan) + 파서 보존 유령표적(parser) 병합.
 *
 * 전수 처리(다운샘플링·상한 없음), 20만 포인트마다 이벤트 루프 양보.
 */
async function analyzeDualTargets(
  sites: { name: string; latitude: number; longitude: number }[],
  scanWindowS: number,
  minSepKm: number,
): Promise<DualTargetResult> {
  const siteMap = new Map<string, { lat: number; lon: number }>();
  for (let i = 0; i < sites.length; i++) {
    siteMap.set(sites[i].name, { lat: sites[i].latitude, lon: sites[i].longitude });
  }

  const events: DualTargetEvent[] = [];
  const stats: DualTargetStats = {
    flights_scanned: 0,
    points_scanned: 0,
    parser_ghosts: _ghostPoints.length,
    events_scan: 0,
    events_parser: 0,
    dropped_unmatched: 0,
    aircraft_count: 0,
    skipped_no_site: 0,
  };

  // ── Phase 1: 잔존 동일스캔 중복 전수 탐지 (scan 소스) ──
  let sinceYield = 0;
  for (const entry of _flightIndex.values()) {
    const site = siteMap.get(entry.radarName);
    if (!site) { stats.skipped_no_site++; continue; }
    if (!entry.modeS) continue;

    stats.flights_scanned++;
    const soa = entry.points;
    const n = soa.count;

    // 파서와 동일한 슬라이딩 클러스터 — 시작점 기준 scanWindowS 이내 연속 포인트
    let clusterStart = 0;
    for (let i = 1; i <= n; i++) {
      const endCluster = i === n
        || Math.abs(soa.timestamp[i] - soa.timestamp[clusterStart]) > scanWindowS;
      if (!endCluster) continue;

      const clusterLen = i - clusterStart;
      stats.points_scanned += clusterLen;
      sinceYield += clusterLen;

      if (clusterLen >= 2) {
        const prevIdx = clusterStart > 0 ? clusterStart - 1 : -1;
        const nextIdx = i < n ? i : -1;
        // 한 클러스터에서 ghost 로 확정된 인덱스는 이후 쌍 검사에서 제외 (중복 이벤트 방지)
        let ghostSet: Set<number> | null = null;

        for (let a = clusterStart; a < i; a++) {
          if (ghostSet && ghostSet.has(a)) continue;
          for (let b = a + 1; b < i; b++) {
            if (ghostSet && ghostSet.has(b)) continue;
            const sep = haversine(
              soa.latitude[a], soa.longitude[a], soa.latitude[b], soa.longitude[b],
            );
            if (sep < minSepKm) continue;

            // 궤적 이탈도가 큰 쪽 = ghost. 동률이면 레이더 거리 먼 쪽 = ghost
            const devA = trajectoryDeviationSoA(soa, a, prevIdx, nextIdx);
            const devB = trajectoryDeviationSoA(soa, b, prevIdx, nextIdx);
            let gi: number;
            let ri: number;
            if (devA > devB) { gi = a; ri = b; }
            else if (devB > devA) { gi = b; ri = a; }
            else {
              const dA = haversine(site.lat, site.lon, soa.latitude[a], soa.longitude[a]);
              const dB = haversine(site.lat, site.lon, soa.latitude[b], soa.longitude[b]);
              if (dA >= dB) { gi = a; ri = b; } else { gi = b; ri = a; }
            }

            events.push(buildDualEvent(
              entry.modeS, entry.radarName,
              pointAt(soa, ri) as TrackPoint, pointAt(soa, gi) as TrackPoint,
              site.lat, site.lon, "scan",
            ));
            stats.events_scan++;

            if (!ghostSet) ghostSet = new Set<number>();
            ghostSet.add(gi);
            if (gi === a) break; // a 가 ghost 로 확정 → 이 a 의 나머지 쌍 검사 중단
          }
        }
      }

      clusterStart = i;

      if (sinceYield >= 200_000) {
        sinceYield = 0;
        await yieldWorker();
      }
    }
  }

  // ── Phase 2: 파서 보존분 병합 (parser 소스) ──
  if (_ghostPoints.length > 0) {
    // modeS|radarName → 후보 비행 인덱스
    const byKey = new Map<string, FlightIndexEntry[]>();
    for (const entry of _flightIndex.values()) {
      if (!entry.modeS) continue;
      const key = `${entry.modeS.toUpperCase()}|${entry.radarName}`;
      let arr = byKey.get(key);
      if (!arr) { arr = []; byKey.set(key, arr); }
      arr.push(entry);
    }

    for (let gi = 0; gi < _ghostPoints.length; gi++) {
      const g = _ghostPoints[gi];
      const rn = g.radar_name ?? "";
      const site = siteMap.get(rn);
      if (!site) { stats.dropped_unmatched++; continue; }

      const candidates = byKey.get(`${(g.mode_s ?? "").toUpperCase()}|${rn}`);
      if (!candidates) { stats.dropped_unmatched++; continue; }

      // g.timestamp 최근접 실포인트 탐색 (이진탐색) — 후보 중 |dt| 최소인 비행 채택
      let best: FlightIndexEntry | null = null;
      let bestNear = -1;
      let bestDt = Infinity;
      let bestPrev = -1;
      let bestNext = -1;
      for (let ci = 0; ci < candidates.length; ci++) {
        const entry = candidates[ci];
        if (g.timestamp < entry.startTime - DUAL_PARSER_MATCH_WINDOW_S) continue;
        if (g.timestamp > entry.endTime + DUAL_PARSER_MATCH_WINDOW_S) continue;
        const soa = entry.points;
        if (soa.count === 0) continue;
        const lb = lowerBoundSoA(soa, g.timestamp); // ts >= g.ts 인 첫 인덱스
        const ub = upperBoundSoA(soa, g.timestamp); // ts >  g.ts 인 첫 인덱스
        const prev = lb - 1;                        // ts <  g.ts 인 마지막
        const next = ub < soa.count ? ub : -1;      // ts >  g.ts 인 첫
        let near = -1;
        let dt = Infinity;
        if (lb < soa.count) { near = lb; dt = Math.abs(soa.timestamp[lb] - g.timestamp); }
        if (prev >= 0) {
          const dPrev = Math.abs(g.timestamp - soa.timestamp[prev]);
          if (dPrev < dt) { near = prev; dt = dPrev; }
        }
        if (dt < bestDt) {
          bestDt = dt; best = entry; bestNear = near; bestPrev = prev; bestNext = next;
        }
      }

      if (!best) { stats.dropped_unmatched++; continue; }

      const soa = best.points;
      let realP: { timestamp: number; latitude: number; longitude: number; altitude: number; radar_type: string } | null = null;

      if (bestNear >= 0 && bestDt <= scanWindowS) {
        // 동일스캔 실측 짝
        realP = pointAt(soa, bestNear) as TrackPoint;
      } else if (
        bestPrev >= 0 && bestNext >= 0
        && g.timestamp - soa.timestamp[bestPrev] <= DUAL_PARSER_MATCH_WINDOW_S
        && soa.timestamp[bestNext] - g.timestamp <= DUAL_PARSER_MATCH_WINDOW_S
      ) {
        // 전후 실포인트 선형보간 위치를 real 로 사용
        const t0 = soa.timestamp[bestPrev];
        const t1 = soa.timestamp[bestNext];
        const ratio = t1 > t0 ? (g.timestamp - t0) / (t1 - t0) : 0;
        const prevPt = pointAt(soa, bestPrev) as TrackPoint;
        realP = {
          timestamp: g.timestamp,
          latitude: soa.latitude[bestPrev] + (soa.latitude[bestNext] - soa.latitude[bestPrev]) * ratio,
          longitude: soa.longitude[bestPrev] + (soa.longitude[bestNext] - soa.longitude[bestPrev]) * ratio,
          altitude: soa.altitude[bestPrev] + (soa.altitude[bestNext] - soa.altitude[bestPrev]) * ratio,
          radar_type: prevPt.radar_type,
        };
      }

      if (!realP) { stats.dropped_unmatched++; continue; }

      // parser 소스는 minSepKm 재필터 금지 (파서 기준을 이미 통과한 확정 유령)
      events.push(buildDualEvent(
        best.modeS, best.radarName, realP, g, site.lat, site.lon, "parser",
      ));
      stats.events_parser++;

      if ((gi & 4095) === 4095) await yieldWorker();
    }
  }

  // ── 정렬·id 부여 (유령 관측 시각 오름차순) ──
  events.sort((a, b) => a.ghost.timestamp - b.ghost.timestamp);
  const modeSSet = new Set<string>();
  for (let i = 0; i < events.length; i++) {
    events[i].id = i;
    modeSSet.add(events[i].mode_s.toUpperCase());
  }
  stats.aircraft_count = modeSSet.size;

  // ── 반사점 클러스터링 (≈250m 그리드 → count 내림차순 id 부여) ──
  interface CellAcc {
    sumLat: number; sumLon: number; count: number; radarName: string; members: number[];
  }
  const cells = new Map<string, CellAcc>();
  for (let i = 0; i < events.length; i++) {
    const r = events[i].reflector;
    if (!r) continue;
    const key = `${events[i].radar_name}|${Math.round(r.latitude / DUAL_CLUSTER_GRID_DEG)}|${Math.round(r.longitude / DUAL_CLUSTER_GRID_DEG)}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { sumLat: 0, sumLon: 0, count: 0, radarName: events[i].radar_name, members: [] };
      cells.set(key, cell);
    }
    cell.sumLat += r.latitude;
    cell.sumLon += r.longitude;
    cell.count++;
    cell.members.push(i);
  }

  const cellList = Array.from(cells.values());
  cellList.sort((a, b) => b.count - a.count);
  const clusters: ReflectorCluster[] = new Array(cellList.length);
  for (let ci = 0; ci < cellList.length; ci++) {
    const cell = cellList[ci];
    clusters[ci] = {
      id: ci,
      latitude: cell.sumLat / cell.count,
      longitude: cell.sumLon / cell.count,
      count: cell.count,
      radar_name: cell.radarName,
    };
    for (let mi = 0; mi < cell.members.length; mi++) events[cell.members[mi]].cluster_id = ci;
  }

  return {
    events,
    clusters,
    stats,
    params: { scan_window_s: scanWindowS, min_sep_km: minSepKm },
  };
}

// ─── Worker 메시지 핸들러 ───────────────────────────

self.onmessage = async (e: MessageEvent) => {
  const { type, id } = e.data;

  try {
    switch (type) {
      case "ADD_POINTS": {
        // fire-and-forget — ACK 없음. 객체 → SoA 변환 즉시, pts는 listener scope 후 GC.
        const pts: TrackPoint[] = e.data.points;
        if (pts.length > 0) {
          _pointBatches.push(batchFromObjects(pts));
        }
        break;
      }

      case "ADD_GHOST_POINTS": {
        // fire-and-forget — 파서가 제거한 유령표적 보존분. 소량이라 객체 배열로 축적.
        const pts: TrackPoint[] = e.data.points;
        for (let i = 0; i < pts.length; i++) _ghostPoints.push(pts[i]);
        break;
      }

      case "ANALYZE_DUAL_TARGETS": {
        const { sites, scanWindowS, minSepKm } = e.data;
        const t0 = performance.now();
        const result = await analyzeDualTargets(sites, scanWindowS, minSepKm);
        console.log(
          `[Worker] analyzeDualTargets: ${(performance.now() - t0).toFixed(0)}ms, ` +
          `events=${result.events.length} clusters=${result.clusters.length}`,
        );
        self.postMessage({ type: "ANALYZE_DUAL_TARGETS_RESULT", id, result });
        break;
      }

      case "CONSOLIDATE": {
        const { flightHistory, aircraft, radarSite } = e.data;
        const t0 = performance.now();
        // _pointBatches가 있으면 초기 통합, 비어있으면 _flightIndex에서 재통합 (SoA 직접 사용).
        // consolidateAndStream은 (sourceBatches: PointBatch[]) 형태를 받음.
        // 1) 초기 통합: _pointBatches 그대로 사용 후 클리어.
        // 2) 재통합: 각 _flightIndex.points(SoA)를 그대로 batches 배열로 묶음.
        let sourceBatches: PointBatch[];
        if (_pointBatches.length > 0) {
          sourceBatches = _pointBatches;
          _pointBatches = [];
        } else {
          sourceBatches = [];
          for (const entry of _flightIndex.values()) {
            sourceBatches.push(entry.points);
          }
        }
        await consolidateAndStream(sourceBatches, flightHistory, aircraft, radarSite, id);
        console.log(`[Worker] consolidateFlights: ${(performance.now() - t0).toFixed(0)}ms`);
        break;
      }

      case "BUILD_FLIGHT": {
        const { modeS, points, radarLat, radarLon, matchType, aircraftName, callsign, departure, arrival, radarName } = e.data;
        const flight = buildFlight(modeS, points, radarLat, radarLon, matchType, aircraftName, callsign, departure, arrival, radarName);
        self.postMessage({ type: "BUILD_FLIGHT_RESULT", id, flight });
        break;
      }

      case "GET_POINT_SUMMARY": {
        // mode_s별 카운트 + 시간 범위 요약 (경량). SoA 직접 접근.
        const summary = new Map<string, { count: number; minTs: number; maxTs: number }>();
        let totalPts = 0;
        if (_pointBatches.length > 0) {
          for (const b of _pointBatches) {
            totalPts += b.count;
            for (let i = 0; i < b.count; i++) {
              const ms = modeSOf(b, i).toUpperCase();
              const ts = b.timestamp[i];
              const prev = summary.get(ms);
              if (!prev) {
                summary.set(ms, { count: 1, minTs: ts, maxTs: ts });
              } else {
                prev.count++;
                if (ts < prev.minTs) prev.minTs = ts;
                if (ts > prev.maxTs) prev.maxTs = ts;
              }
            }
          }
        } else {
          for (const entry of _flightIndex.values()) {
            totalPts += entry.points.count;
            const ms = entry.modeS.toUpperCase();
            const prev = summary.get(ms);
            if (!prev) {
              summary.set(ms, { count: entry.points.count, minTs: entry.startTime, maxTs: entry.endTime });
            } else {
              prev.count += entry.points.count;
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

        // SoA에서 직접 범위 이진탐색 후 청크 단위로 객체 unpacking
        for (const entry of _flightIndex.values()) {
          if (!matchesFilter(entry)) continue;
          const soa = entry.points;
          let lo = 0;
          let hi = soa.count;
          if (timeRange) {
            const [tMin, tMax] = timeRange as [number, number];
            if (entry.endTime < tMin || entry.startTime > tMax) continue;
            lo = lowerBoundSoA(soa, tMin);
            hi = upperBoundSoA(soa, tMax);
            if (paddingPoints) {
              if (lo > 0) lo--;
              if (hi < soa.count) hi++;
            }
          }
          for (let i = lo; i < hi; i++) {
            chunk.push(pointAt(soa, i) as TrackPoint);
            if (chunk.length >= CHUNK_SIZE) flushChunk();
          }
        }
        flushChunk();
        self.postMessage({ type: "QUERY_VIEWPORT_POINTS_DONE", id, totalPoints: totalSent });
        break;
      }

      case "QUERY_FLIGHT_POINTS": {
        const entry = _flightIndex.get(e.data.flightId as string);
        const points: TrackPoint[] = entry ? pointsArrayOf(entry) : [];
        self.postMessage({ type: "QUERY_FLIGHT_POINTS_RESULT", id, points });
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
