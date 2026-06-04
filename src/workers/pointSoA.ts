/**
 * Structure-of-Arrays(SoA) 형식의 TrackPoint 청크.
 * Worker 내부에서 10M+ 포인트를 메모리 효율적으로 보관하기 위해 사용.
 *
 * 비교:
 *   객체 배열: ~250B/point × 10M = ~2.5GB
 *   SoA:       ~47B/point × 10M  = ~470MB (5배 절약)
 *
 * 메인 인터페이스(IPC)는 그대로 TrackPoint 객체. Worker는 입력 즉시 SoA로 변환,
 * 외부 반환 시점에 객체로 unpacking 한다.
 */

interface TrackPointLike {
  timestamp: number;
  mode_s: string;
  latitude: number;
  longitude: number;
  altitude: number;
  speed: number;
  heading: number;
  radar_type: string;
  radar_name?: string;
}

export interface PointBatch {
  count: number;
  timestamp: Float64Array;
  latitude: Float64Array;
  longitude: Float64Array;
  altitude: Float32Array;
  speed: Float32Array;
  heading: Float32Array;
  /** _modeSTable 인덱스 */
  modeSIdx: Uint32Array;
  /** _radarTypeTable 인덱스 */
  radarTypeIdx: Uint8Array;
  /** _radarNameTable 인덱스. 0xFFFF = 없음 */
  radarNameIdx: Uint16Array;
}

// ─── 전역 문자열 테이블 (interning) ───────────────────

const _modeSTable: string[] = [];
const _modeSMap = new Map<string, number>();

const _radarTypeTable: string[] = [];
const _radarTypeMap = new Map<string, number>();

const _radarNameTable: string[] = [];
const _radarNameMap = new Map<string, number>();

const NO_RADAR_NAME = 0xFFFF;

function intern(table: string[], map: Map<string, number>, value: string): number {
  let idx = map.get(value);
  if (idx === undefined) {
    idx = table.length;
    table.push(value);
    map.set(value, idx);
  }
  return idx;
}

// ─── 객체 배열 → SoA 변환 ─────────────────────────────

export function batchFromObjects(pts: TrackPointLike[]): PointBatch {
  const n = pts.length;
  const batch: PointBatch = {
    count: n,
    timestamp: new Float64Array(n),
    latitude: new Float64Array(n),
    longitude: new Float64Array(n),
    altitude: new Float32Array(n),
    speed: new Float32Array(n),
    heading: new Float32Array(n),
    modeSIdx: new Uint32Array(n),
    radarTypeIdx: new Uint8Array(n),
    radarNameIdx: new Uint16Array(n),
  };
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    batch.timestamp[i] = p.timestamp;
    batch.latitude[i] = p.latitude;
    batch.longitude[i] = p.longitude;
    batch.altitude[i] = p.altitude;
    batch.speed[i] = p.speed;
    batch.heading[i] = p.heading;
    batch.modeSIdx[i] = intern(_modeSTable, _modeSMap, p.mode_s);
    batch.radarTypeIdx[i] = intern(_radarTypeTable, _radarTypeMap, p.radar_type);
    batch.radarNameIdx[i] = p.radar_name
      ? intern(_radarNameTable, _radarNameMap, p.radar_name)
      : NO_RADAR_NAME;
  }
  return batch;
}

// ─── SoA → 객체 변환 (한 포인트씩 — 외부 반환용) ─────

export function pointAt(batch: PointBatch, idx: number): TrackPointLike {
  const radarNameIdx = batch.radarNameIdx[idx];
  return {
    timestamp: batch.timestamp[idx],
    mode_s: _modeSTable[batch.modeSIdx[idx]],
    latitude: batch.latitude[idx],
    longitude: batch.longitude[idx],
    altitude: batch.altitude[idx],
    speed: batch.speed[idx],
    heading: batch.heading[idx],
    radar_type: _radarTypeTable[batch.radarTypeIdx[idx]],
    radar_name: radarNameIdx === NO_RADAR_NAME ? undefined : _radarNameTable[radarNameIdx],
  };
}

// ─── 직접 필드 접근 (객체 변환 없이) ──────────────────

export function modeSOf(batch: PointBatch, idx: number): string {
  return _modeSTable[batch.modeSIdx[idx]];
}

export function radarNameOf(batch: PointBatch, idx: number): string {
  const i = batch.radarNameIdx[idx];
  return i === NO_RADAR_NAME ? "" : _radarNameTable[i];
}

// ─── 단일 비행용 SoA 컨테이너 (_flightIndex.points 보관용) ─

/**
 * 한 비행의 포인트들을 SoA로 보관. 시간순 정렬 보장.
 * PointBatch와 동일 구조지만 단일 비행 단위.
 */
export type FlightPointsSoA = PointBatch;

/**
 * SoA → TrackPoint[] (전체 비행 unpacking, buildFlight/loss 등 기존 로직 입력용)
 */
export function unpackBatch(batch: PointBatch): TrackPointLike[] {
  const out = new Array<TrackPointLike>(batch.count);
  for (let i = 0; i < batch.count; i++) out[i] = pointAt(batch, i);
  return out;
}
