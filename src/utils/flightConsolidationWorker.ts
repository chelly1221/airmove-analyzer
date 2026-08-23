/**
 * Worker 래퍼 — consolidateFlights / manualMergeFlights를 Worker에서 실행
 *
 * 100% 스트리밍:
 *  - 보내기: sendPointsToWorker()로 파일 단위 즉시 전송 (메인에 축적 안 함)
 *  - Worker: 비행 1개 완성될 때마다 FLIGHT_CHUNK + yield
 *  - 받기: FLIGHT_CHUNK → onFlightChunk 콜백 → store.appendFlights → 즉시 UI
 */

import type { Aircraft, Flight, RadarSite, TrackPoint } from "../types";
import type { DualTargetResult, ModeSTrack } from "../types";

// ─── Worker 싱글턴 ──────────────────────────────────

let _worker: Worker | null = null;
let _nextId = 0;
const _pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

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

/** 진행 중이던 뷰포트 쿼리가 새 쿼리로 교체(취소)될 때 reject되는 마커 에러.
 *  실제 오류가 아닌 정상적인 취소이므로 호출부에서 조용히 무시한다. */
export class ViewportQuerySuperseded extends Error {
  constructor() {
    super("새 뷰포트 쿼리로 교체됨");
    this.name = "ViewportQuerySuperseded";
  }
}

/** 진행 중이던 통합 요청이 새 통합 요청으로 교체(취소)될 때 reject되는 마커 에러.
 *  실제 오류가 아닌 정상적인 취소이므로 호출부에서 조용히 무시한다. */
export class ConsolidateSuperseded extends Error {
  constructor() {
    super("새 통합 요청으로 교체됨");
    this.name = "ConsolidateSuperseded";
  }
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
    // aborted = 워커가 세대 변경(새 통합·CLEAR_POINTS)으로 중단 → 절단된 부분 결과를 완료로 오인하지 않게 reject
    if (e.data.aborted) req.reject(new ConsolidateSuperseded());
    else req.resolve();
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

/** 요청-응답 1왕복 — 응답 모양은 메시지 종류마다 달라 호출부가 타입 인자로 지정한다 */
function workerSend<T>(msg: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = _nextId++;
    _pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    getWorker().postMessage({ ...msg, id });
  });
}

// ─── Public API ─────────────────────────────────────

/**
 * Fire-and-forget — listener에서 직접 호출. Promise chain capture 없이 즉시 반환.
 * 메인 메모리에 청크 closure가 누적되지 않도록 한다.
 */
export function postPointsToWorker(points: TrackPoint[]): void {
  getWorker().postMessage({ type: "ADD_POINTS", points });
}

/**
 * 파서가 제거한 유령표적 보존분을 Worker에 전달 — 이중표적 분석용.
 * postPointsToWorker와 동일한 fire-and-forget 패턴.
 */
export function postGhostPointsToWorker(points: TrackPoint[]): void {
  getWorker().postMessage({ type: "ADD_GHOST_POINTS", points });
}

/**
 * Worker 축적 데이터(포인트 배치·비행 인덱스·유령 보존분) 전체 폐기.
 * 재업로드가 "대체" 시맨틱을 갖는 페이지(이중표적 분석)에서 파싱 직전에 호출.
 */
export function clearWorkerPoints(): void {
  getWorker().postMessage({ type: "CLEAR_POINTS" });
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
  // 이전 요청이 남아 있으면 reject하여 Promise 누수 방지
  // (고아 파싱 플로우의 await startConsolidate 가 영구 pending 으로 남는 것을 막는다)
  if (_consolidateReq) {
    const prev = _consolidateReq;
    _consolidateReq = null;
    prev.reject(new ConsolidateSuperseded());
  }
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
  const result = await workerSend<{ totalPoints: number; entries: PointSummaryEntry[] }>({ type: "GET_POINT_SUMMARY" });
  return { totalPoints: result.totalPoints, entries: result.entries };
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
    _viewportReq.reject(new ViewportQuerySuperseded());
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
  const result = await workerSend<{ points: TrackPoint[] }>({ type: "QUERY_FLIGHT_POINTS", flightId });
  return result.points;
}

/**
 * 한 기체(Mode-S)의 전체 항적을 typed array 로 조회 — 이중표적 페이지 항적 오버레이용.
 * 워커가 positions(lon,lat 인터리브)·startIndices 를 transfer 하므로 메인 스레드에
 * TrackPoint 객체가 만들어지지 않는다(10M+ 규모 대비 스트리밍 원칙).
 */
export async function queryModeSTrack(modeS: string): Promise<ModeSTrack> {
  const r = await workerSend<ModeSTrack>({ type: "QUERY_MODE_S_TRACK", modeS });
  return {
    modeS: r.modeS,
    flightCount: r.flightCount,
    pointCount: r.pointCount,
    positions: r.positions,
    startIndices: r.startIndices,
    bbox: r.bbox,
  };
}

// ─── 이중표적(반사 유령표적) 분석 ─────────────────────

/**
 * Worker에 축적된 항적 + 파서 보존 유령표적으로 이중표적 분석 실행.
 * 잔존 동일스캔 중복(scan) + 파서 제거분(parser) 병합 → 반사점 역산·클러스터링.
 * excludeModeS: 시험표적(site monitor) 등 분석에서 제외할 Mode-S 목록.
 */
export async function analyzeDualTargets(params: {
  sites: { name: string; latitude: number; longitude: number }[];
  scanWindowS: number;
  minSepKm: number;
  excludeModeS: string[];
}): Promise<DualTargetResult> {
  const result = await workerSend<{ result: DualTargetResult }>({ type: "ANALYZE_DUAL_TARGETS", ...params });
  return result.result as DualTargetResult;
}

