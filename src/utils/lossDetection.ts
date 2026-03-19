import type { TrackPoint, LossPoint, LossSegment } from "../types";
import { getGPUDevice, createBuffer, readBuffer, runComputeShader } from "./gpuCompute";

/** 기본 임계값 (초): 이 시간 이상 gap이면 Loss */
const DEFAULT_THRESHOLD_SECS = 7.0;

/** 레이더 최대 탐지거리의 몇 % 이상이면 범위이탈로 판단 */
const OUT_OF_RANGE_THRESHOLD = 1.0;

/** 이 횟수 이상 연속 스캔 미탐지면 범위이탈로 간주 */
const MAX_CONSECUTIVE_SIGNAL_LOSS_SCANS = 15.0;

/** 이 시간(초) 이상의 gap은 Loss가 아님 (4시간 — 비행 분리 기준과 동일) */
const MAX_LOSS_DURATION_SECS = 14400.0;

/** 보간 속도 vs 직전 속도 차이 비율이 이 값을 초과하면 범위이탈로 판정 (예: 0.5 = 50% 차이) */
const SPEED_DEVIATION_RATIO = 0.5;

// ─── WebGPU Haversine Compute Shader ──────────────────────────

const HAVERSINE_SHADER = `
@group(0) @binding(0) var<storage, read> lats1: array<f32>;
@group(0) @binding(1) var<storage, read> lons1: array<f32>;
@group(0) @binding(2) var<storage, read> lats2: array<f32>;
@group(0) @binding(3) var<storage, read> lons2: array<f32>;
@group(0) @binding(4) var<storage, read_write> distances: array<f32>;

const R: f32 = 6371.0;
const PI: f32 = 3.14159265358979;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&lats1)) { return; }

  let lat1 = lats1[i] * PI / 180.0;
  let lon1 = lons1[i] * PI / 180.0;
  let lat2 = lats2[i] * PI / 180.0;
  let lon2 = lons2[i] * PI / 180.0;

  let dlat = (lat2 - lat1) / 2.0;
  let dlon = (lon2 - lon1) / 2.0;
  let a = sin(dlat) * sin(dlat) + cos(lat1) * cos(lat2) * sin(dlon) * sin(dlon);
  distances[i] = R * 2.0 * asin(sqrt(min(a, 1.0)));
}
`;

/** GPU batch Haversine distance (WebGPU with CPU fallback) */
async function gpuHaversineBatch(
  lat1s: Float32Array, lon1s: Float32Array,
  lat2s: Float32Array, lon2s: Float32Array,
): Promise<Float32Array> {
  const n = lat1s.length;
  const device = await getGPUDevice();

  if (!device || n < 1000) {
    // CPU fallback for small batches or no GPU
    const result = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      result[i] = haversine(lat1s[i], lon1s[i], lat2s[i], lon2s[i]);
    }
    return result;
  }

  const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;
  const buf1 = createBuffer(device, lat1s, usage);
  const buf2 = createBuffer(device, lon1s, usage);
  const buf3 = createBuffer(device, lat2s, usage);
  const buf4 = createBuffer(device, lon2s, usage);
  const outBuf = device.createBuffer({
    size: n * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  await runComputeShader(device, HAVERSINE_SHADER, [
    { buffer: buf1, type: "read-only-storage" },
    { buffer: buf2, type: "read-only-storage" },
    { buffer: buf3, type: "read-only-storage" },
    { buffer: buf4, type: "read-only-storage" },
    { buffer: outBuf, type: "storage" },
  ], [Math.ceil(n / 256), 1, 1]);

  const result = await readBuffer(device, outBuf, n * 4);

  buf1.destroy(); buf2.destroy(); buf3.destroy(); buf4.destroy(); outBuf.destroy();
  return result;
}

// ─── CPU 구현 (기존) ─────────────────────────────────────────

/** Haversine 거리 계산 (km) */
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371.0;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(Math.min(a, 1)));
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
  return gaps[Math.floor(gaps.length / 2)] ?? null;
}

/** 레이더 최대 탐지거리 추정 (95th percentile) — CPU */
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

/** GPU 가속 레이더 최대 탐지거리 추정 (95th percentile) */
export async function estimateMaxRadarRangeGPU(
  points: TrackPoint[],
  radarLat: number,
  radarLon: number,
): Promise<number> {
  if (points.length === 0) return 150.0;

  const n = points.length;
  const lat1s = new Float32Array(n);
  const lon1s = new Float32Array(n);
  const lat2s = new Float32Array(n);
  const lon2s = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    lat1s[i] = radarLat;
    lon1s[i] = radarLon;
    lat2s[i] = points[i].latitude;
    lon2s[i] = points[i].longitude;
  }

  const distances = await gpuHaversineBatch(lat1s, lon1s, lat2s, lon2s);

  // 95th percentile
  const sorted = Array.from(distances).sort((a, b) => a - b);
  const idx = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);
  return Math.max(sorted[idx], 50.0);
}

/** 단일 항적의 Loss 포인트 탐지 (포인트 기반) — CPU */
function detectLossForTrack(
  modeS: string,
  points: TrackPoint[],
  thresholdSecs: number,
  scanIntervalSecs: number,
  radarLat: number,
  radarLon: number,
  maxRadarRangeKm: number,
): LossPoint[] {
  if (points.length < 2) return [];

  const boundaryKm = maxRadarRangeKm * OUT_OF_RANGE_THRESHOLD;
  const lossPoints: LossPoint[] = [];

  for (let i = 0; i < points.length - 1; i++) {
    const prev = points[i];
    const next = points[i + 1];
    const gap = next.timestamp - prev.timestamp;

    if (gap > thresholdSecs && gap <= MAX_LOSS_DURATION_SECS) {
      if (gap <= 0) continue; // 0 나누기 방지
      const startRadarDist = haversine(radarLat, radarLon, prev.latitude, prev.longitude);
      const endRadarDist = haversine(radarLat, radarLon, next.latitude, next.longitude);
      const missedScans = gap / scanIntervalSecs;

      // 보간 속도 계산 (knots): gap 구간의 직선거리 / 시간
      const gapDistKm = haversine(prev.latitude, prev.longitude, next.latitude, next.longitude);
      const impliedSpeedKts = (gapDistKm / gap) * 3600 / 1.852; // km/s -> knots

      // 직전 속도 대비 보간 속도 편차가 크면 범위이탈로 판정
      const prevSpeed = prev.speed; // knots
      const speedDeviation = prevSpeed > 10
        ? Math.abs(impliedSpeedKts - prevSpeed) / prevSpeed
        : 0;

      // loss_type 분류 (gap 단위)
      let lossType: string;
      if (startRadarDist >= boundaryKm && endRadarDist >= boundaryKm) {
        lossType = "out_of_range";
      } else if (
        missedScans >= MAX_CONSECUTIVE_SIGNAL_LOSS_SCANS &&
        (startRadarDist >= boundaryKm || endRadarDist >= boundaryKm)
      ) {
        lossType = "out_of_range";
      } else if (speedDeviation > SPEED_DEVIATION_RATIO) {
        // 보간 속도가 직전 속도와 크게 다르면 범위이탈 (직선 보간이 의미 없음)
        lossType = "out_of_range";
      } else {
        lossType = "signal_loss";
      }

      // 범위이탈이면 보간 포인트 생성 안 함 (직선 보간 무의미)
      if (lossType === "out_of_range") continue;

      // 미탐지 스캔 수 계산: gap 내 예상 스캔 횟수
      const totalMissed = Math.max(1, Math.round(gap / scanIntervalSecs) - 1);

      for (let si = 1; si <= totalMissed; si++) {
        const t = si / (totalMissed + 1); // 0~1 사이 보간 비율
        const ts = prev.timestamp + gap * t;
        const lat = prev.latitude + (next.latitude - prev.latitude) * t;
        const lon = prev.longitude + (next.longitude - prev.longitude) * t;
        const alt = prev.altitude + (next.altitude - prev.altitude) * t;
        const radDist = haversine(radarLat, radarLon, lat, lon);

        lossPoints.push({
          mode_s: modeS,
          timestamp: ts,
          latitude: lat,
          longitude: lon,
          altitude: alt,
          radar_distance_km: radDist,
          loss_type: lossType,
          scan_index: si,
          total_missed_scans: totalMissed,
          gap_start_time: prev.timestamp,
          gap_end_time: next.timestamp,
          gap_duration_secs: gap,
        });
      }
    }
  }

  return lossPoints;
}

/** Loss 탐지 결과 */
export interface LossDetectionResult {
  lossPoints: LossPoint[];
  lossSegments: LossSegment[];
  maxRadarRangeKm: number;
}

/** LossPoint 배열에서 LossSegment 배열 파생 (하위 호환) */
function deriveSegments(points: LossPoint[], trackPoints: TrackPoint[]): LossSegment[] {
  if (points.length === 0) return [];

  // gap_start_time 기준으로 그룹핑
  const gapMap = new Map<string, LossPoint[]>();
  for (const p of points) {
    const key = `${p.mode_s}_${p.gap_start_time}`;
    let arr = gapMap.get(key);
    if (!arr) {
      arr = [];
      gapMap.set(key, arr);
    }
    arr.push(p);
  }

  const segments: LossSegment[] = [];

  // gap 시작/끝에 해당하는 실제 트랙포인트 찾기용 인덱스
  const tpByModeS = new Map<string, TrackPoint[]>();
  for (const tp of trackPoints) {
    let arr = tpByModeS.get(tp.mode_s);
    if (!arr) {
      arr = [];
      tpByModeS.set(tp.mode_s, arr);
    }
    arr.push(tp);
  }

  for (const [, gapPoints] of gapMap) {
    const first = gapPoints[0];
    const modeS = first.mode_s;
    const pts = tpByModeS.get(modeS) ?? [];

    // gap 시작/끝 트랙포인트 찾기
    const prevPt = pts.find((p) => Math.abs(p.timestamp - first.gap_start_time) < 0.5);
    const nextPt = pts.find((p) => Math.abs(p.timestamp - first.gap_end_time) < 0.5);

    if (!prevPt || !nextPt) continue;

    const distanceKm = haversine(prevPt.latitude, prevPt.longitude, nextPt.latitude, nextPt.longitude);

    segments.push({
      mode_s: modeS,
      start_time: first.gap_start_time,
      end_time: first.gap_end_time,
      start_lat: prevPt.latitude,
      start_lon: prevPt.longitude,
      end_lat: nextPt.latitude,
      end_lon: nextPt.longitude,
      duration_secs: first.gap_duration_secs,
      distance_km: distanceKm,
      last_altitude: prevPt.altitude,
      start_altitude: prevPt.altitude,
      end_altitude: nextPt.altitude,
      loss_type: first.loss_type,
      start_radar_dist_km: first.radar_distance_km,
      end_radar_dist_km: gapPoints[gapPoints.length - 1].radar_distance_km,
    });
  }

  segments.sort((a, b) => a.start_time - b.start_time);
  return segments;
}

/**
 * CPU Loss 탐지 — 기존 구현 (동기)
 * mode_s별로 그룹핑하여 각각 loss 탐지.
 * 포인트 기반: 각 미탐지 스캔마다 LossPoint 생성.
 */
const yieldUI = () => new Promise<void>(r => setTimeout(r, 0));

export async function detectLoss(
  points: TrackPoint[],
  radarLat: number,
  radarLon: number,
  thresholdSecs: number = DEFAULT_THRESHOLD_SECS,
): Promise<LossDetectionResult> {
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

  const allPoints: LossPoint[] = [];
  let overallMaxRange = 50.0;

  let groupIdx = 0;
  for (const [modeS, pts] of groups) {
    if (pts.length < 1) continue;
    pts.sort((a, b) => a.timestamp - b.timestamp);

    const rangeKm = estimateMaxRadarRange(pts, radarLat, radarLon);
    if (rangeKm > overallMaxRange) overallMaxRange = rangeKm;

    const scanInterval = estimateScanInterval(pts) ?? 5.0;
    const lps = detectLossForTrack(modeS, pts, thresholdSecs, scanInterval, radarLat, radarLon, rangeKm);
    allPoints.push(...lps);

    if (++groupIdx % 5 === 0) await yieldUI();
  }

  allPoints.sort((a, b) => a.timestamp - b.timestamp);

  // 하위 호환용 세그먼트 파생
  const segments = deriveSegments(allPoints, points);

  return { lossPoints: allPoints, lossSegments: segments, maxRadarRangeKm: overallMaxRange };
}

/**
 * GPU 가속 Loss 탐지 (haversine 배치 사전 계산)
 * WebGPU로 대량 haversine 거리를 일괄 계산 후 CPU에서 Loss 판정
 */
export async function detectLossGPU(
  points: TrackPoint[],
  radarLat: number,
  radarLon: number,
  thresholdSecs: number = DEFAULT_THRESHOLD_SECS,
): Promise<LossDetectionResult> {
  // mode_s별 그룹핑
  const groups = new Map<string, TrackPoint[]>();
  for (const p of points) {
    let arr = groups.get(p.mode_s);
    if (!arr) { arr = []; groups.set(p.mode_s, arr); }
    arr.push(p);
  }

  const allPoints: LossPoint[] = [];
  let overallMaxRange = 50.0;

  for (const [modeS, pts] of groups) {
    if (pts.length < 2) continue;
    pts.sort((a, b) => a.timestamp - b.timestamp);

    // GPU 배치: 모든 포인트의 레이더 거리 + 인접 포인트간 거리 사전 계산
    const n = pts.length;
    const radarLats = new Float32Array(n).fill(radarLat);
    const radarLons = new Float32Array(n).fill(radarLon);
    const ptLats = new Float32Array(n);
    const ptLons = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      ptLats[i] = pts[i].latitude;
      ptLons[i] = pts[i].longitude;
    }

    // 1. 레이더-포인트 거리 (GPU)
    const radarDists = await gpuHaversineBatch(radarLats, radarLons, ptLats, ptLons);

    // 2. 인접 포인트간 거리 (GPU)
    const prevLats = ptLats.slice(0, n - 1);
    const prevLons = ptLons.slice(0, n - 1);
    const nextLats = ptLats.slice(1);
    const nextLons = ptLons.slice(1);
    const gapDists = await gpuHaversineBatch(prevLats, prevLons, nextLats, nextLons);

    // Range estimation from pre-computed distances
    const distArr = Array.from(radarDists).sort((a, b) => a - b);
    const rangeIdx = Math.min(Math.floor(distArr.length * 0.95), distArr.length - 1);
    const rangeKm = Math.max(distArr[rangeIdx], 50.0);
    if (rangeKm > overallMaxRange) overallMaxRange = rangeKm;

    const scanInterval = estimateScanInterval(pts) ?? 5.0;
    const boundaryKm = rangeKm * OUT_OF_RANGE_THRESHOLD;

    // Loss detection using pre-computed distances
    for (let i = 0; i < n - 1; i++) {
      const prev = pts[i];
      const next = pts[i + 1];
      const gap = next.timestamp - prev.timestamp;

      if (gap > thresholdSecs && gap <= MAX_LOSS_DURATION_SECS) {
        if (gap <= 0) continue;
        const startRadarDist = radarDists[i];
        const endRadarDist = radarDists[i + 1];
        const missedScans = gap / scanInterval;
        const gapDistKm = gapDists[i];
        const impliedSpeedKts = (gapDistKm / gap) * 3600 / 1.852;
        const prevSpeed = prev.speed;
        const speedDeviation = prevSpeed > 10
          ? Math.abs(impliedSpeedKts - prevSpeed) / prevSpeed
          : 0;

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

        const totalMissed = Math.max(1, Math.round(gap / scanInterval) - 1);
        for (let si = 1; si <= totalMissed; si++) {
          const t = si / (totalMissed + 1);
          const ts = prev.timestamp + gap * t;
          const lat = prev.latitude + (next.latitude - prev.latitude) * t;
          const lon = prev.longitude + (next.longitude - prev.longitude) * t;
          const alt = prev.altitude + (next.altitude - prev.altitude) * t;
          // Linear interpolation of radar distances for interpolated points
          const radDist = startRadarDist + (endRadarDist - startRadarDist) * t;

          allPoints.push({
            mode_s: modeS,
            timestamp: ts,
            latitude: lat,
            longitude: lon,
            altitude: alt,
            radar_distance_km: radDist,
            loss_type: lossType,
            scan_index: si,
            total_missed_scans: totalMissed,
            gap_start_time: prev.timestamp,
            gap_end_time: next.timestamp,
            gap_duration_secs: gap,
          });
        }
      }
    }
  }

  allPoints.sort((a, b) => a.timestamp - b.timestamp);
  const segments = deriveSegments(allPoints, points);
  return { lossPoints: allPoints, lossSegments: segments, maxRadarRangeKm: overallMaxRange };
}
