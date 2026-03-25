/**
 * Worker 래퍼 — consolidateFlights / manualMergeFlights를 Worker에서 실행
 *
 * 100% 스트리밍:
 *  - 보내기: sendPointsToWorker()로 파일 단위 즉시 전송 (메인에 축적 안 함)
 *  - Worker: 비행 1개 완성될 때마다 FLIGHT_CHUNK + yield
 *  - 받기: FLIGHT_CHUNK → onFlightChunk 콜백 → store.appendFlights → 즉시 UI
 */

import type { Aircraft, Flight, RadarSite, TrackPoint } from "../types";

// ─── Worker 싱글턴 ──────────────────────────────────

let _worker: Worker | null = null;
let _nextId = 0;
const _pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

let _consolidateReq: {
  id: number;
  onChunk: (flights: Flight[]) => void;
  resolve: () => void;
  reject: (e: Error) => void;
} | null = null;

/** 뷰포트 쿼리 결과 */
export interface ViewportQueryResult {
  points: TrackPoint[];
}

/** 뷰포트 쿼리 스트리밍 요청 */
let _viewportReq: {
  id: number;
  buffer: TrackPoint[];
  resolve: (result: ViewportQueryResult) => void;
  reject: (e: Error) => void;
  onProgress?: (loaded: number) => void;
} | null = null;

function getWorker(): Worker {
  if (_worker) return _worker;
  _worker = new Worker(
    new URL("../workers/flightConsolidation.worker.ts", import.meta.url),
    { type: "module" },
  );
  _worker.onmessage = handleWorkerMessage;
  _worker.onerror = (err) => console.error("[FlightWorker] error:", err);
  return _worker;
}

/** 외부에서 등록하는 진행률 콜백 */
let _progressCallback: ((p: { stage: string; current: number; total: number; flightsBuilt: number }) => void) | null = null;

/** consolidation 진행률 콜백 등록 */
export function setConsolidationProgressCallback(
  cb: ((p: { stage: string; current: number; total: number; flightsBuilt: number }) => void) | null,
) {
  _progressCallback = cb;
}

function handleWorkerMessage(e: MessageEvent) {
  const { type, id } = e.data;

  if (type === "CONSOLIDATE_PROGRESS" && _consolidateReq && _consolidateReq.id === id) {
    _progressCallback?.(e.data);
    return;
  }

  if (type === "FLIGHT_CHUNK" && _consolidateReq && _consolidateReq.id === id) {
    _consolidateReq.onChunk(e.data.flights as Flight[]);
    return;
  }
  if (type === "CONSOLIDATE_DONE" && _consolidateReq && _consolidateReq.id === id) {
    const req = _consolidateReq;
    _consolidateReq = null;
    req.resolve();
    return;
  }

  // 뷰포트 쿼리 스트리밍
  if (type === "QUERY_VIEWPORT_POINTS_CHUNK" && _viewportReq && _viewportReq.id === id) {
    const pts = e.data.points as TrackPoint[];
    const buf = _viewportReq.buffer;
    for (let i = 0; i < pts.length; i++) buf.push(pts[i]);
    _viewportReq.onProgress?.(buf.length);
    return;
  }
  if (type === "QUERY_VIEWPORT_POINTS_DONE" && _viewportReq && _viewportReq.id === id) {
    const req = _viewportReq;
    _viewportReq = null;
    req.resolve({ points: req.buffer });
    return;
  }

  if (type === "ERROR") {
    if (_consolidateReq && _consolidateReq.id === id) {
      const cr = _consolidateReq;
      _consolidateReq = null;
      cr.reject(new Error(e.data.error));
      return;
    }
    if (_viewportReq && _viewportReq.id === id) {
      const vr = _viewportReq;
      _viewportReq = null;
      vr.reject(new Error(e.data.error));
      return;
    }
    const req = _pending.get(id);
    if (req) {
      _pending.delete(id);
      req.reject(new Error(e.data.error));
    }
    return;
  }

  const req = _pending.get(id);
  if (!req) return;
  _pending.delete(id);
  req.resolve(e.data);
}

function workerSend(msg: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = _nextId++;
    _pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...msg, id });
  });
}

// ─── Public API ─────────────────────────────────────

/**
 * 포인트를 Worker에 직접 전송 (메인에 축적하지 않음).
 * DB에서 파일 로드 → 즉시 이 함수로 Worker에 전달 → 로컬 참조 해제.
 */
export async function sendPointsToWorker(points: TrackPoint[]): Promise<void> {
  await workerSend({ type: "ADD_POINTS", points });
}

/**
 * Worker에 축적된 포인트로 비행 통합 시작 — 완전 스트리밍.
 *
 * sendPointsToWorker()로 포인트를 미리 전송한 후 호출.
 * 비행 1개 완성될 때마다 onFlightChunk 콜백으로 즉시 UI 반영.
 */
export async function startConsolidate(
  flightHistory: unknown[],
  aircraft: Aircraft[],
  radarSite: RadarSite,
  onFlightChunk: (flights: Flight[]) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const id = _nextId++;
    _consolidateReq = { id, onChunk: onFlightChunk, resolve, reject };
    getWorker().postMessage({
      type: "CONSOLIDATE",
      id,
      flightHistory,
      aircraft,
      radarSite,
    });
  });
}

/**
 * Worker 버퍼 재사용하여 재통합 (flightHistory 변경 시).
 * _pointBuffer는 항상 보존되므로 startConsolidate와 동일하게 동작.
 */
export const reconsolidate = startConsolidate;

/**
 * Worker 포인트 버퍼 전체 삭제
 */
export async function clearWorkerPoints(): Promise<void> {
  await workerSend({ type: "CLEAR_POINTS" });
}

export interface PointSummaryEntry {
  modeS: string;
  count: number;
  minTs: number;
  maxTs: number;
}

/**
 * Worker에서 포인트 요약 조회 (경량, 메인 스레드에 데이터 축적 없음)
 */
export async function getPointSummary(): Promise<{
  totalPoints: number;
  entries: PointSummaryEntry[];
}> {
  const result = await workerSend({ type: "GET_POINT_SUMMARY" });
  return { totalPoints: result.totalPoints, entries: result.entries };
}

/**
 * Worker에서 수동 비행 병합 실행.
 * Worker가 _flightIndex에서 포인트를 수집하므로 ID만 전달.
 * selectedFlights는 메타데이터(이름, callsign 등) 참조용.
 */
export async function manualMergeFlightsAsync(
  selectedFlights: Flight[],
  radarSite: RadarSite,
): Promise<Flight> {
  const flightIds = selectedFlights.map((f) => f.id);
  const result = await workerSend({
    type: "MANUAL_MERGE",
    selectedFlights,
    flightIds,
    radarSite,
  });
  return result.flight;
}

// ─── Throttled Chunk Handler ────────────────────────

/**
 * 비행 청크를 로컬 버퍼에 모아 throttle 간격(기본 250ms)마다 한 번에 flush.
 * Worker가 비행 1개씩 보내도 store 업데이트는 250ms당 최대 1회 → 리렌더 최소화.
 *
 * @param onFlush 실제 store.appendFlights (또는 필터 적용된 콜백)
 * @param intervalMs flush 간격 (ms)
 * @returns { handler, flush } — handler를 startConsolidate에 전달, 완료 후 flush() 호출
 */
export function createThrottledChunkHandler(
  onFlush: (flights: Flight[]) => void,
  intervalMs = 250,
): { handler: (flights: Flight[]) => void; flush: () => void } {
  let buffer: Flight[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length > 0) {
      const batch = buffer;
      buffer = [];
      onFlush(batch);
    }
  };

  const handler = (flights: Flight[]) => {
    for (let i = 0; i < flights.length; i++) buffer.push(flights[i]);
    if (timer === null) {
      timer = setTimeout(flush, intervalMs);
    }
  };

  return { handler, flush };
}

// ─── Viewport Query API ─────────────────────────────

export interface ViewportQueryParams {
  radarName?: string;
  selectedModeS?: string | null;
  registeredModeS?: string[];
  timeRange?: [number, number];
  paddingPoints?: boolean;
}

/**
 * Worker에 뷰포트 범위 포인트 쿼리 (청크 스트리밍).
 * _flightIndex에서 필터링된 포인트를 200K 청크로 수신 → 합산 반환.
 * onProgress: 청크 수신 시마다 누적 포인트 수 콜백
 */
export function queryViewportPoints(params: ViewportQueryParams & { onProgress?: (loaded: number) => void }): Promise<ViewportQueryResult> {
  const { onProgress, ...queryParams } = params;
  // 이전 요청이 있으면 reject하여 Promise 누수 방지
  if (_viewportReq) {
    _viewportReq.reject(new Error("새 뷰포트 쿼리로 교체됨"));
    _viewportReq = null;
  }
  return new Promise<ViewportQueryResult>((resolve, reject) => {
    const id = _nextId++;
    _viewportReq = { id, buffer: [], resolve, reject, onProgress };
    getWorker().postMessage({ type: "QUERY_VIEWPORT_POINTS", id, ...queryParams });
  });
}

/** 특정 비행의 전체 포인트 쿼리 */
export async function queryFlightPoints(flightId: string): Promise<TrackPoint[]> {
  const result = await workerSend({ type: "QUERY_FLIGHT_POINTS", flightId });
  return result.points;
}

/** 다중 비행 포인트 일괄 쿼리 (timestamp 정렬) */
export async function queryFlightPointsBatch(flightIds: string[]): Promise<TrackPoint[]> {
  const result = await workerSend({ type: "QUERY_FLIGHT_POINTS_BATCH", flightIds });
  return result.points;
}
