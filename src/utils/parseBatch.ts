/**
 * parse_and_analyze_batch 호출 프로토콜 단일 소유 헬퍼.
 *  - requestTag 생성(crypto.randomUUID — 코드베이스 표준) + invoke 전달
 *  - 리스너는 getCurrentWebviewWindow().listen 으로 등록(창 타깃) + request_tag 엄격 일치 필터(fail-closed).
 *    Rust 는 handle.emit_to(창 라벨) 로 방출하므로 이 조합이어야 배달·수신이 맞물린다
 *    (창 타깃 = 방관 창이 수십 MB 청크를 역직렬화 후 버리는 낭비 제거, 태그 = 같은 창 내
 *     다른 페이지·잔존 파싱 구분 — 이중 방어).
 *  - 완료 배리어: batch-parse-done(모든 emit 후 마지막) 대기.
 *    타임아웃은 벽시계가 아니라 **활동 기준**(마지막 수신 이벤트로부터 IDLE_MS 무활동) — 대용량
 *    드레인 중 고정 타임아웃이 승리해 꼬리 청크를 버리는 절단 방지.
 *  - done 의 방출 총계와 수신 누계를 대조해 complete 여부 반환(유실=절단 탐지).
 */
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { TrackPoint, WeatherVector } from "../types";

/** 마지막 수신 이벤트로부터 이 시간 동안 아무 이벤트도 없으면 done 유실로 보고 빠져나온다 */
const IDLE_MS = 10_000;

/** ParseFilterModal 결과(Mode-S/Mode-3A 포함·제외) */
export interface ParseBatchFilter {
  modeSInclude: string[];
  modeSExclude: string[];
  mode3aInclude: number[];
  mode3aExclude: number[];
}

/** batch-parse-result 페이로드 (file_info 는 페이지별로 좁혀 캐스팅) */
export interface ParseBatchResultPayload {
  file_path: string;
  success: boolean;
  file_info?: unknown;
  error?: string | null;
  request_tag: string;
}

export interface ParseBatchOutcome {
  /** invoke 자체가 실패 (join error 등) */
  failed: boolean;
  /** done 수신 + 방출 총계와 수신 누계 일치 (false = 이벤트 유실/타임아웃 — 호출부는 절단 경고) */
  complete: boolean;
  pointsReceived: number;
  ghostPointsReceived: number;
  weatherReceived: number;
  resultsReceived: number;
}

/** batch-parse-done 페이로드 (Rust BatchDoneEvent 미러) */
interface BatchDonePayload {
  total: number;
  succeeded: number;
  failed: number;
  points_emitted: number;
  ghost_points_emitted: number;
  weather_vectors_emitted: number;
  request_tag: string;
}

/**
 * 배치 파싱 1회 실행. **어떤 경우에도 throw 하지 않는다** — 리스너 등록·invoke·배리어 어느
 * 지점의 예외도 내부에서 흡수해 failed=true 로 반환하고, 등록된 리스너는 finally 에서 전량
 * 해제한다(예외 탈출로 호출부의 setParsing(false) 가 건너뛰어져 UI 가 영구 잠기는 것 방지).
 */
export async function parseAssBatch(args: {
  paths: string[];
  radarLat: number;
  radarLon: number;
  filter: ParseBatchFilter;
  onPoints?: (pts: TrackPoint[]) => void;
  onGhostPoints?: (pts: TrackPoint[]) => void;
  onWeather?: (vectors: WeatherVector[]) => void;
  onResult?: (payload: ParseBatchResultPayload) => void;
  /**
   * 선점(supersede) 판정 — true 면 이 파싱은 이미 새 파싱에 밀려난 것이므로 즉시 취소한다
   * (리스너 해제 → Tauri 배달 중단, 배리어 즉시 탈출). 취소는 절단이 아니므로 경고 없이
   * complete=false 로 반환한다 — 호출부는 이미 자기 seq 가드로 결과를 버린다.
   */
  isStale?: () => boolean;
}): Promise<ParseBatchOutcome> {
  const { paths, radarLat, radarLon, filter, onPoints, onGhostPoints, onWeather, onResult, isStale } = args;

  // 파싱 요청 고유 태그 — 같은 창의 다른 페이지·잔존 파싱과 자기 이벤트를 구분한다
  const requestTag = crypto.randomUUID();
  const win = getCurrentWebviewWindow();

  let pointsReceived = 0;
  let ghostPointsReceived = 0;
  let weatherReceived = 0;
  let resultsReceived = 0;
  let lastActivity = Date.now();
  let failed = false;
  let cancelled = false;

  // 완료 배리어 — Rust 는 모든 청크·결과 emit 후 마지막에 batch-parse-done 을 보낸다.
  // (totals 는 콜백에서 채우므로 홀더 객체 — 지역 let 은 TS 흐름분석이 null 로 좁혀버린다)
  const done: { totals: BatchDonePayload | null } = { totals: null };
  let doneResolve: () => void = () => {};
  const doneP = new Promise<void>((r) => { doneResolve = r; });

  const unlistens: Array<() => void> = [];

  /**
   * 선점 취소 — 멱등. 리스너를 즉시 전부 해제해 Tauri 의 이 창 배달을 끊고(= 남은 청크를
   * 역직렬화하며 새 파싱과 CPU 를 다투지 않게 한다), 배리어를 풀어 호출부를 즉시 반환시킨다.
   */
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    for (const u of unlistens) u();
    unlistens.length = 0;
    doneResolve();
  };

  try {
    const unlistenDone = await win.listen<BatchDonePayload>("batch-parse-done", (ev) => {
      if (ev.payload.request_tag !== requestTag) return;
      if (isStale?.()) { cancel(); return; }
      lastActivity = Date.now();
      done.totals = ev.payload;
      doneResolve();
    });
    unlistens.push(unlistenDone);

    // 핸들러가 없는 채널은 리스너 자체를 등록하지 않는다 — 관심 없는 페이지가 청크를 역직렬화하지 않도록.
    // (등록하지 않은 채널은 done 총계 대조에서도 제외한다 — 그 채널의 완전성은 이 페이지 관심사가 아님)
    if (onPoints) {
      unlistens.push(await win.listen<{ points: TrackPoint[]; request_tag: string }>("parse-points-chunk", (ev) => {
        if (ev.payload.request_tag !== requestTag) return;
        if (isStale?.()) { cancel(); return; }
        lastActivity = Date.now();
        const pts = ev.payload.points;
        pointsReceived += pts.length;
        onPoints(pts);
      }));
    }
    if (onGhostPoints) {
      unlistens.push(await win.listen<{ points: TrackPoint[]; request_tag: string }>("parse-ghost-chunk", (ev) => {
        if (ev.payload.request_tag !== requestTag) return;
        if (isStale?.()) { cancel(); return; }
        lastActivity = Date.now();
        const pts = ev.payload.points;
        ghostPointsReceived += pts.length;
        onGhostPoints(pts);
      }));
    }
    if (onWeather) {
      unlistens.push(await win.listen<{ vectors: WeatherVector[]; request_tag: string }>("parse-weather-chunk", (ev) => {
        if (ev.payload.request_tag !== requestTag) return;
        if (isStale?.()) { cancel(); return; }
        lastActivity = Date.now();
        const vs = ev.payload.vectors;
        weatherReceived += vs.length;
        onWeather(vs);
      }));
    }
    if (onResult) {
      unlistens.push(await win.listen<ParseBatchResultPayload>("batch-parse-result", (ev) => {
        if (ev.payload.request_tag !== requestTag) return;
        if (isStale?.()) { cancel(); return; }
        lastActivity = Date.now();
        resultsReceived++;
        onResult(ev.payload);
      }));
    }

    try {
      await invoke("parse_and_analyze_batch", {
        requestTag,
        filePaths: paths,
        radarLat,
        radarLon,
        modeSInclude: filter.modeSInclude,
        modeSExclude: filter.modeSExclude,
        mode3aInclude: filter.mode3aInclude,
        mode3aExclude: filter.mode3aExclude,
        // 관심 채널 플래그 — Rust 는 want 인 채널만 청크를 직렬화·emit 한다.
        // (리스너를 등록하지 않은 채널의 50k 포인트 청크 clone+JSON 직렬화 비용 제거)
        wantPoints: !!onPoints,
        wantGhostPoints: !!onGhostPoints,
        wantWeather: !!onWeather,
      });
    } catch (e) {
      failed = true;
      console.error("[parseAssBatch] 배치 파싱 실패:", e);
    }

    // invoke 응답(소형)이 대형 청크 큐를 추월할 수 있다 — done 이벤트까지 대기하면
    // 이벤트 채널 순서 보존상 모든 청크가 리스너를 통과한 상태가 보장된다(마지막 청크 유실 방지).
    if (!failed && !cancelled) {
      let doneFlag = false;
      void doneP.then(() => { doneFlag = true; });
      while (!doneFlag) {
        const idle = Date.now() - lastActivity;
        if (idle >= IDLE_MS) {
          // 장시간 정지 직후엔 타이머가 밀린 이벤트보다 먼저 돈다 — 한 턴 더 양보해
          // 큐에 밀린 청크/done 이 lastActivity 를 갱신할 기회를 준 뒤 재판정한다
          await new Promise<void>((r) => setTimeout(r, 0));
          if (doneFlag || Date.now() - lastActivity < IDLE_MS) continue;
          break; // done 유실 — 무활동 폴백 (활동 중엔 절대 끊지 않는다)
        }
        await Promise.race([doneP, new Promise<void>((r) => setTimeout(r, IDLE_MS - idle))]);
      }
    }
  } catch (e) {
    // 리스너 등록·배리어 어느 지점의 예외도 여기서 흡수 — 호출부로 throw 하지 않는 계약
    console.error("[parseAssBatch] 프로토콜 오류:", e);
    failed = true;
  } finally {
    // 예외·취소·정상 종료 모두 동일 경로로 리스너 해제 (누수 차단)
    for (const u of unlistens) u();
  }

  // 완전성 판정 — 등록한 채널만 대조 (미등록 채널은 수신 누계 0 이 정상)
  const totals = done.totals;
  const complete = !failed && !cancelled && totals !== null
    && (!onPoints || pointsReceived === totals.points_emitted)
    && (!onGhostPoints || ghostPointsReceived === totals.ghost_points_emitted)
    && (!onWeather || weatherReceived === totals.weather_vectors_emitted)
    && (!onResult || resultsReceived === totals.total);

  if (!failed && !cancelled && !complete) {
    console.warn("[parseAssBatch] 수신 절단 감지", {
      requestTag,
      doneReceived: totals !== null,
      pointsReceived, ghostPointsReceived, weatherReceived, resultsReceived,
      emitted: totals,
    });
  }

  return { failed, complete, pointsReceived, ghostPointsReceived, weatherReceived, resultsReceived };
}
