import type { TrackPoint, LossSegment } from "../types";

/** 기본 임계값 (초): 이 시간 이상 gap이면 Loss */
const DEFAULT_THRESHOLD_SECS = 7.0;

/** 레이더 최대 탐지거리의 몇 % 이상이면 범위이탈로 판단 */
const OUT_OF_RANGE_THRESHOLD = 0.88;

/** 이 횟수 이상 연속 스캔 미탐지면 범위이탈로 간주 */
const MAX_CONSECUTIVE_SIGNAL_LOSS_SCANS = 15.0;

/** 이 시간(초) 이상의 gap은 Loss가 아님 (4시간 — 비행 분리 기준과 동일) */
const MAX_LOSS_DURATION_SECS = 14400.0;

/** Haversine 거리 계산 (km) */
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371.0;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

/** 트랙의 중앙값 스캔 간격 추정 */
function estimateScanInterval(points: TrackPoint[]): number | null {
  if (points.length < 5) return null;
  const gaps: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const g = points[i].timestamp - points[i - 1].timestamp;
    if (g > 0.5 && g < 30.0) gaps.push(g);
  }
  if (gaps.length < 3) return null;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/** 레이더 최대 탐지거리 추정 (95th percentile) */
export function estimateMaxRadarRange(
  points: TrackPoint[],
  radarLat: number,
  radarLon: number,
): number {
  if (points.length === 0) return 150.0;
  const distances = points.map((p) => haversine(radarLat, radarLon, p.latitude, p.longitude));
  distances.sort((a, b) => a - b);
  const idx = Math.min(Math.floor(distances.length * 0.95), distances.length - 1);
  return Math.max(distances[idx], 50.0);
}

/** 단일 항적의 Loss 구간 탐지 */
function detectLossForTrack(
  modeS: string,
  points: TrackPoint[],
  thresholdSecs: number,
  scanIntervalSecs: number,
  radarLat: number,
  radarLon: number,
  maxRadarRangeKm: number,
): LossSegment[] {
  if (points.length < 2) return [];

  const boundaryKm = maxRadarRangeKm * OUT_OF_RANGE_THRESHOLD;
  const segments: LossSegment[] = [];

  for (let i = 0; i < points.length - 1; i++) {
    const prev = points[i];
    const next = points[i + 1];
    const gap = next.timestamp - prev.timestamp;

    if (gap > thresholdSecs && gap <= MAX_LOSS_DURATION_SECS) {
      const distanceKm = haversine(prev.latitude, prev.longitude, next.latitude, next.longitude);
      const startRadarDist = haversine(radarLat, radarLon, prev.latitude, prev.longitude);
      const endRadarDist = haversine(radarLat, radarLon, next.latitude, next.longitude);
      const missedScans = gap / scanIntervalSecs;

      let lossType: string;
      if (startRadarDist >= boundaryKm && endRadarDist >= boundaryKm) {
        lossType = "out_of_range";
      } else if (
        missedScans >= MAX_CONSECUTIVE_SIGNAL_LOSS_SCANS &&
        (startRadarDist >= boundaryKm || endRadarDist >= boundaryKm)
      ) {
        lossType = "out_of_range";
      } else {
        lossType = "signal_loss";
      }

      segments.push({
        mode_s: modeS,
        start_time: prev.timestamp,
        end_time: next.timestamp,
        start_lat: prev.latitude,
        start_lon: prev.longitude,
        end_lat: next.latitude,
        end_lon: next.longitude,
        duration_secs: gap,
        distance_km: distanceKm,
        last_altitude: prev.altitude,
        start_altitude: prev.altitude,
        end_altitude: next.altitude,
        loss_type: lossType,
        start_radar_dist_km: startRadarDist,
        end_radar_dist_km: endRadarDist,
      });
    }
  }

  return segments;
}

/** Loss 탐지 결과 */
export interface LossDetectionResult {
  lossSegments: LossSegment[];
  maxRadarRangeKm: number;
}

/**
 * 정렬된 TrackPoint 배열에 대해 Loss 탐지 수행.
 * mode_s별로 그룹핑하여 각각 loss 탐지.
 */
export function detectLoss(
  points: TrackPoint[],
  radarLat: number,
  radarLon: number,
  thresholdSecs: number = DEFAULT_THRESHOLD_SECS,
): LossDetectionResult {
  // mode_s별 그룹핑
  const groups = new Map<string, TrackPoint[]>();
  for (const p of points) {
    let arr = groups.get(p.mode_s);
    if (!arr) {
      arr = [];
      groups.set(p.mode_s, arr);
    }
    arr.push(p);
  }

  const allSegments: LossSegment[] = [];
  let overallMaxRange = 50.0;

  for (const [modeS, pts] of groups) {
    if (pts.length < 1) continue;
    pts.sort((a, b) => a.timestamp - b.timestamp);

    const rangeKm = estimateMaxRadarRange(pts, radarLat, radarLon);
    if (rangeKm > overallMaxRange) overallMaxRange = rangeKm;

    const scanInterval = estimateScanInterval(pts) ?? 5.0;
    const segs = detectLossForTrack(modeS, pts, thresholdSecs, scanInterval, radarLat, radarLon, rangeKm);
    allSegments.push(...segs);
  }

  allSegments.sort((a, b) => a.start_time - b.start_time);

  return { lossSegments: allSegments, maxRadarRangeKm: overallMaxRange };
}
