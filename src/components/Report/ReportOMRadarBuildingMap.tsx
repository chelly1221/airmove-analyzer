/**
 * OM 보고서 — (레이더 × 분석 대상 장애물) 위에서 본(top-down) 지도 도면.
 *
 * TrackMap 을 위에서 본 듯한 느낌으로, 레이더와 건물을 같은 지도(CARTO voyager 베이스맵) 위에 얹고
 * **레이더 → 건물 양쪽 끝 방위**로 뻗는 부채꼴(영향/음영 범위)을 표시한다.
 *
 *  - 베이스맵: CARTO voyager **래스터** 타일을 bbox/줌에 맞춰 canvas 에 정적 합성.
 *      (라이브 MapLibre 미사용 — 보고서는 페이지마다 도면이 반복되므로 WebGL 컨텍스트 고갈/PDF 캡처
 *       불안정을 피해 정적 래스터로 그린다. 오프라인이면 격자 폴백.)
 *  - 부채꼴: calcBuildingAzExtent(레이더↔건물 폴리곤) 의 양끝 방위(start/end) 로 두 변을 그리고,
 *      건물 뒤(거리>건물거리) 음영 구역을 진하게 채운다. 레이더→건물 구간은 옅게.
 *  - 건물 footprint: geometry_json(polygon/multi) 폴리곤을 그룹 색으로 채움. 점 건물이면 마커.
 *  - 소실표적: 이 부채꼴 + 건물 후방의 소실표적을 빨간 점으로 오버레이(보고서 통일 색 #ff1745).
 *  - 축척 막대 · 나침반(N) · 변 방위 라벨.
 *
 * PDF 안전: 모든 그래픽을 단일 <canvas> 에 그려 WebView2 PrintToPdf 가 스냅샷.
 *   타일 이미지는 crossOrigin="anonymous"(CARTO 는 CORS 허용) 로 canvas 오염 방지.
 */
import { useEffect, useMemo, useRef } from "react";
import type { ManualBuilding, BuildingGroup, RadarSite, LoSProfileData } from "../../types";
import type { LossPointGeo } from "../../types/obstacle";
import { calcBuildingAzExtent } from "../../utils/obstacleAnalysisHelpers";
import { bearingDeg, haversineKm } from "../../utils/geo";
import { groupColorOf } from "./BuildingGroupBadge";
import OMEditable from "./OMEditable";

const DEG2RAD = Math.PI / 180;
const KM_PER_NM = 1.852;
/** 웹 머케이터 타일 픽셀 크기. §1 히트맵이 자체 투영 구성에 재사용하므로 export. */
export const TILE = 256;
const R_KM = 6371;

/** canvas 백킹 픽셀(렌더 해상도) — CSS 표시폭의 약 2배 밀도로 그려 PDF 출력에서 또렷하게.
 *  표시 크기는 고정(DISP_W×자동높이)으로 두어 A4 한 페이지 높이를 넘지 않게 한다
 *  ([data-page] 가 overflow:hidden 으로 클리핑되므로 페이지 분할이 아닌 잘림 방지).
 *  §4 소실상세 도면(ReportOMLossEventsMap)은 동일 헬퍼를 정사각 백킹(w=h)으로 호출 — 아래
 *  fitProjection/composeTiles/장식 함수들의 w/h 파라미터 기본값이 이 상수(§3 규격). */
export const BACK_W = 760;
export const BACK_H = 416;
/** 화면/PDF 표시 폭(px) — 백킹의 절반(고밀도). 높이는 종횡비 자동(≈ 197px). */
const DISP_W = 360;

/** CARTO voyager 래스터 타일 (앱 베이스맵과 동일 출처 — 온라인). 오프라인이면 폴백 격자. */
const tileUrl = (z: number, x: number, y: number) =>
  `https://basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`;

// ── 머케이터 투영 (0..1 정규화) ── §1 히트맵이 자체 투영 구성에 재사용하므로 export.
export const mercX = (lonDeg: number) => (lonDeg + 180) / 360;
export const mercY = (latDeg: number) => {
  const lat = Math.max(-85.05, Math.min(85.05, latDeg)) * DEG2RAD;
  return (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2;
};

/** 출발점 + 방위(°) + 거리(km) → 도착 좌표 [lat,lon] (구면, 단거리 정확) */
function destPoint(latDeg: number, lonDeg: number, brgDeg: number, distKm: number): [number, number] {
  const d = distKm / R_KM;
  const th = brgDeg * DEG2RAD;
  const f1 = latDeg * DEG2RAD;
  const l1 = lonDeg * DEG2RAD;
  const sinF2 = Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(th);
  const f2 = Math.asin(Math.max(-1, Math.min(1, sinF2)));
  const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(f1), Math.cos(d) - Math.sin(f1) * sinF2);
  return [f2 / DEG2RAD, ((l2 / DEG2RAD + 540) % 360) - 180];
}

/** 건물 footprint 폴리곤 추출 ([[lat,lon],...] 배열들). 점 건물/파싱 실패 시 빈 배열. */
export function buildingPolygons(b: ManualBuilding): [number, number][][] {
  if (!b.geometry_json) return [];
  let geo: unknown;
  try { geo = JSON.parse(b.geometry_json); } catch { return []; }
  const asPoly = (arr: unknown): [number, number][] | null => {
    if (!Array.isArray(arr)) return null;
    const pts = arr.filter(
      (p): p is [number, number] => Array.isArray(p) && p.length === 2 && typeof p[0] === "number" && typeof p[1] === "number",
    );
    return pts.length >= 3 ? pts : null;
  };
  if (b.geometry_type === "polygon") {
    const p = asPoly(geo);
    return p ? [p] : [];
  }
  if (b.geometry_type === "multi" && Array.isArray(geo)) {
    const out: [number, number][][] = [];
    for (const sub of geo as { type?: string; json?: string }[]) {
      if (sub?.type === "polygon" && sub.json) {
        try { const p = asPoly(JSON.parse(sub.json)); if (p) out.push(p); } catch { /* skip */ }
      }
    }
    return out;
  }
  return [];
}

/** 중심 c 기준 상대각 (−180, 180] */
const relTo = (x: number, c: number) => ((x - c + 540) % 360) - 180;

/** 투영 파라미터 — fitProjection 산출물. §3 부채꼴 도면·§4 소실상세 도면(ReportOMLossEventsMap) 공유. */
export interface MapProjection {
  z: number;
  originX: number;
  originY: number;
  project: (lat: number, lon: number) => [number, number];
  /** 미터/백킹픽셀 (중심 위도) — 축척 막대용 */
  mpp: number;
}

/** 표시 필수 점집합([lat,lon][]) → w×h 백킹 캔버스 머케이터 투영 파라미터 (기본 §3 규격 BACK_W×BACK_H).
 *  bbox 패딩(기본 12%) + 캔버스 종횡비에 맞춘 부족 축 확장(왜곡 없이 타일이 박스를 채움) + 줌 [3,19].
 *  opts.padRatio  — bbox 패딩 비율(기본 0.12 = 현행값).
 *  opts.fractionalZoom — true 면 Math.floor 없이 분수 줌 그대로(§1 히트맵·§2 위치도가 프레임 꽉 채우기용).
 *  기본(opts 미지정)은 padRatio 0.12 + 정수 줌(Math.floor)이라 §3 부채꼴·§4 소실상세 도면과 **비트 단위
 *  동일** — 기본 인자 경로/수치 불변. */
export function fitProjection(
  pts: [number, number][],
  w = BACK_W,
  h = BACK_H,
  opts?: { padRatio?: number; fractionalZoom?: boolean },
): MapProjection {
  const padRatio = opts?.padRatio ?? 0.12;              // 기본 0.12 = 현행값
  const fractionalZoom = opts?.fractionalZoom ?? false; // 기본 false = 현행 Math.floor 정수 줌
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const [la, lo] of pts) {
    if (la < minLat) minLat = la;
    if (la > maxLat) maxLat = la;
    if (lo < minLon) minLon = lo;
    if (lo > maxLon) maxLon = lo;
  }
  const padLat = Math.max((maxLat - minLat) * padRatio, 1e-4);
  const padLon = Math.max((maxLon - minLon) * padRatio, 1e-4);
  minLat -= padLat; maxLat += padLat; minLon -= padLon; maxLon += padLon;

  // 머케이터 span → 캔버스 종횡비에 맞춰 부족한 축 확장
  let mxMin = mercX(minLon), mxMax = mercX(maxLon);
  let myMin = mercY(maxLat), myMax = mercY(minLat); // y 는 위도 증가 시 감소
  let spanX = mxMax - mxMin, spanY = myMax - myMin;
  const targetAR = w / h;
  if (spanX / spanY > targetAR) {
    const need = spanX / targetAR;
    const cy = (myMin + myMax) / 2; myMin = cy - need / 2; myMax = cy + need / 2; spanY = need;
  } else {
    const need = spanY * targetAR;
    const cx = (mxMin + mxMax) / 2; mxMin = cx - need / 2; mxMax = cx + need / 2; spanX = need;
  }

  // 줌 — span 이 백킹 픽셀에 들어가는 최대 줌. 기본(fractionalZoom=false)은 Math.floor 정수 줌으로
  //   기존과 비트 단위 동일. true 면 floor 없이 분수 줌 그대로(clamp [3,19] 는 유지) — worldSize=
  //   TILE·2^z 등 나머지 수식은 분수 z 로도 그대로 성립(composeTiles 가 zInt=round(z)로 타일 배치).
  const zX = Math.log2(w / (spanX * TILE));
  const zY = Math.log2(h / (spanY * TILE));
  const zRaw = Math.min(zX, zY);
  const z = Math.max(3, Math.min(19, fractionalZoom ? zRaw : Math.floor(zRaw)));
  const worldSize = TILE * Math.pow(2, z);
  const cMx = (mxMin + mxMax) / 2, cMy = (myMin + myMax) / 2;
  const originX = cMx * worldSize - w / 2;
  const originY = cMy * worldSize - h / 2;
  const project = (lat: number, lon: number): [number, number] => [
    mercX(lon) * worldSize - originX,
    mercY(lat) * worldSize - originY,
  ];

  // 미터/백킹픽셀 (중심 위도) — 축척 막대용
  const cLat = (minLat + maxLat) / 2;
  const mpp = (Math.cos(cLat * DEG2RAD) * 2 * Math.PI * 6378137) / worldSize;

  return { z, originX, originY, project, mpp };
}

// ── 전역 타일 로드 동시성 제한 ──
// §3 상세(빌딩×레이더) 도면 + §4 소실상세 도면이 다수 마운트되면 도면당 12~49개 타일 요청이
// 한꺼번에 발화해 수백 개 Image 네트워크/디코드가 렌더러·공유 GPU 프로세스 메모리를 일시에
// 점유한다(다건물 보고서에서 두 창 동시 blank/프리징의 가중 요인). 풀 크기만큼만 동시 로드하고
// 나머지는 큐 대기.
// 첫 패스 타일 3초 데드라인은 '큐 대기 포함' 전체 예산 — 첫 합성이 항상 ≤3초에 종료해야
// PDF 게이트(useReportExport data-map-ready 4초) 안에 오버레이(부채꼴·건물·소실점)까지 그려진
// 도면이 인쇄된다. 행잉 네트워크에서 큐 대기가 예산을 소모하면 잔여 시간만 로드에 사용하고,
// 큐에서 예산이 소진된 타일은 Image 생성 없이 즉시 포기한다.
// 예산 소진으로 미수신된 타일은 '구멍(회색 조각)' 상태로 확정하지 않고 백그라운드 재시도
// (진행이 있는 한 재시도, 최대 MAX_ROUNDS 회)로 자가치유한다 — 동시 마운트 혼잡에서 뒤쪽 큐
// 타일이 대량 유실돼 일부만 로딩된 지도가 PDF 에 인쇄되던 문제 방지. 진행 상태는 data-map-complete 로 노출.
const TILE_POOL = 24;
let tileActive = 0;
const tileQueue: (() => void)[] = [];
/** 슬롯 획득 — deadline(절대시각)까지 대기. 성공 시 true(슬롯 보유 → 반드시 releaseTileSlot),
 *  큐 대기 중 예산 소진 시 큐에서 자신을 제거하고 false(슬롯 미보유 → release 금지). */
function acquireTileSlotUntil(deadline: number): Promise<boolean> {
  if (tileActive < TILE_POOL) { tileActive++; return Promise.resolve(true); }
  return new Promise((resolve) => {
    const waiter = () => { clearTimeout(timer); resolve(true); }; // 슬롯 이양받음 (tileActive 유지)
    const timer = setTimeout(() => {
      const i = tileQueue.indexOf(waiter);
      // i<0 이면 이양(waiter 호출)과 경합해 이미 슬롯을 받은 것 — resolve(true)가 선승, 여기선 무시
      if (i >= 0) { tileQueue.splice(i, 1); resolve(false); }
    }, Math.max(0, deadline - Date.now()));
    tileQueue.push(waiter);
  });
}
function releaseTileSlot() {
  const next = tileQueue.shift();
  if (next) next(); // 슬롯 이양 (tileActive 유지)
  else tileActive--;
}

/** 첫 패스 타일 예산(ms) — 큐 대기 포함. 첫 합성이 ≤3초에 끝나 data-map-ready 게이트를 연다. */
const TILE_BUDGET_FIRST_MS = 3000;
// 아래 상수들은 첫 패스 이후 백그라운드 재시도(자가치유) 스케줄을 정의한다. useReportExport 의
// 자가치유 대기 창(healWindow)이 이 값들에서 유도되므로 export 한다 — 과거 하드코딩 8초 대기가
// 재시도 스케줄보다 짧아 완료 직전 잘려 §4 도면이 일부만 인쇄되던 버그를 방지한다(상수 변경 시
// 대기 창 자동 정합).
/** 재시도 패스 타일 예산(ms) — ready 게이트 무관 백그라운드 자가치유라 여유 있게. */
export const TILE_BUDGET_RETRY_MS = 4000;
/** 재시도 지연(ms) — 동시 마운트 도면들의 첫 패스 혼잡이 풀에서 빠지길 기다렸다 재요청. */
export const RETRY_DELAY_MS = 800;
// 재시도 종료 조건 — '진행 기반 적응형'. 종전 고정 상한(RETRY_MAX=2)은 다건물 보고서에서 (레이더×건물)
// §3 도면이 수십 개 동시 마운트돼 공유 풀(TILE_POOL=24)이 심하게 혼잡하면, 아직 타일이 큐에서 빠지는
// 중인데도 2라운드만에 잘려 '일부만 로딩된(사선 해치) 지도'를 complete 로 확정했다. → 라운드가 신규
// 타일을 1개라도 얻는 한(혼잡 해소 진행 중) 계속 재시도하고, 연속 무진행(오프라인/행잉) 시에만 조기
// 종료한다. 동시성(TILE_POOL)은 그대로라 OOM 위험 불변 — 늘어나는 건 순차 라운드 수뿐.
/** 총 재시도 라운드 하드 상한(round 0=첫 패스 포함). 진행이 이어져도 이 라운드에서 확정 —
 *  대기 창(healWindow)·프리뷰 리빌이 무한 확장되지 않게 한다. healWindow 가 이 값에서 유도된다. */
export const MAX_ROUNDS = 6;
/** 연속 무진행(신규 타일 0개) 라운드 상한(round 0부터 집계). 오프라인/행잉이면 이 횟수만에 확정 —
 *  종전 RETRY_MAX=2 의 오프라인 종료 지연(round0 + 2회 ≈ 12.6초)과 동일. 무의미한 재시도 방지. */
export const NO_PROGRESS_MAX = 3;

/** 베이스맵 래스터 타일을 canvas 에 정적 합성 — 합성(첫 패스 + 자가치유 재합성)마다
 *  onDone(online, complete) 호출: 베이스 전체를 다시 그렸으므로 호출측은 매번 오버레이를 다시 그린다.
 *    online   = 성공 타일 존재 (false 면 폴백 격자 상태)
 *    complete = 합성 확정 — 전 타일 수신 또는 재시도 소진(추가 자가치유 없음)
 *  첫 패스는 타일당 3초(큐 대기 포함) 예산으로 ≤3초 내 종료해 PDF 게이트(data-map-ready)를 열고,
 *  미수신 타일은 백그라운드 재시도(진행 기반 적응형, 최대 MAX_ROUNDS 회)로 채운 뒤 재합성 — '일부만 로딩된 지도'가
 *  화면·PDF 에 확정되는 것을 방지 (PDF 게이트는 data-map-complete 로 자가치유 완료를 잠시 대기).
 *  w/h 는 fitProjection 과 동일한 백킹 크기 (기본 §3 규격).
 *  반환: 취소 함수 — 언마운트/재계산 시 호출해 미완료 타일 요청·재시도 타이머 중단 + 고아 Image
 *  디코드 버퍼 해제(누수 방지). 취소 후엔 onDone 미호출. */
export function composeTiles(
  ctx: CanvasRenderingContext2D,
  proj: Pick<MapProjection, "z" | "originX" | "originY">,
  warnLabel: string,
  onDone: (online: boolean, complete: boolean) => void,
  w = BACK_W,
  h = BACK_H,
): () => void {
  let cancelled = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  // 연속 무진행(신규 타일 0개) 라운드 누적 — 반드시 클로저 스코프(라운드 간 유지). runRound 내부에
  //   두면 매 라운드 리셋돼 무진행 조기 종료가 발동하지 않고 항상 MAX_ROUNDS 까지 돈다.
  let noProgressStreak = 0;
  const imgs: HTMLImageElement[] = [];
  const { z, originX, originY } = proj;
  // 분수 줌 지원 — 타일은 정수 줌(zInt)에서 요청하고, 화면엔 s=2^(z−zInt) 배 스케일(T=TILE·s)로 배치.
  // 정수 z 호출(§3/§4 도면)은 s=1·T=TILE 이라 기존과 비트 단위 동일(아래 그리기 스냅 좌표도 동일). §1
  // 히트맵만 페이지 채움 위해 정확한 지리 창(분수 줌)으로 호출한다.
  const zInt = Math.round(z);
  const s = Math.pow(2, z - zInt);
  const T = TILE * s;
  const n = Math.pow(2, zInt);
  const tx0 = Math.floor(originX / T), tx1 = Math.floor((originX + w) / T);
  const ty0 = Math.floor(originY / T), ty1 = Math.floor((originY + h) / T);

  // 대상 타일 전체 목록 (머케이터 세로 범위 밖 제외) — 재시도 라운드의 잔여 목록 산출 기준
  const targets: { tx: number; ty: number }[] = [];
  for (let tx = tx0; tx <= tx1; tx++)
    for (let ty = ty0; ty <= ty1; ty++) if (ty >= 0 && ty < n) targets.push({ tx, ty });

  // 수신 성공 타일 누적 — 재합성마다 전체를 다시 그린다 (라운드 간 증분 유지)
  const loaded: { tx: number; ty: number; img: HTMLImageElement }[] = [];

  const loadTile = async (tx: number, ty: number, budgetMs: number): Promise<{ tx: number; ty: number; img: HTMLImageElement } | null> => {
    // 데드라인 = 큐 대기 + 네트워크/디코드 전체 예산 — 라운드의 Promise.all 이 예산 내 종료 보장
    const deadline = Date.now() + budgetMs;
    if (!(await acquireTileSlotUntil(deadline))) return null; // 큐 대기 중 예산 소진 — 슬롯 미보유
    if (cancelled) { releaseTileSlot(); return null; }
    try {
      return await new Promise<{ tx: number; ty: number; img: HTMLImageElement } | null>((resolve) => {
        const wx = ((tx % n) + n) % n;
        const img = new Image();
        imgs.push(img);
        img.crossOrigin = "anonymous";
        // 잔여 예산으로 로드 타임아웃 — 행잉 요청 환경에서도 데드라인 안에 종료 (onload/onerror 시 해제)
        const timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
        img.onload = () => { clearTimeout(timer); resolve({ tx, ty, img }); };
        img.onerror = () => { clearTimeout(timer); resolve(null); };
        img.src = tileUrl(zInt, wx, ty);
      });
    } finally {
      releaseTileSlot();
    }
  };

  /** 누적 loaded 로 베이스 전체 재합성 + 흰 베일 + onDone(오버레이 재그리기).
   *  complete 확정 후에도 남은 미수신 타일(재시도 소진) 자리에는 '타일 없음' 사선 해치를 덧그려
   *  회색 빈칸이 '깨진 캡처'로 보이지 않게 마감한다 — data-map-complete 는 '더 이상 재시도 없음'이지
   *  '전 타일 수신'이 아니므로, 확정 시 잔여 구멍을 명시(의도된 미표시)로 처리한다. */
  const drawAll = (complete: boolean, warnOffline: boolean) => {
    ctx.fillStyle = "#eef1f4";
    ctx.fillRect(0, 0, w, h);
    if (loaded.length > 0) {
      for (const t of loaded) {
        // 픽셀 경계 스냅(심 방지) — 정수 z 는 T=TILE 이라 x1−x0=TILE·좌표가 기존과 동일(비트 단위 동일).
        const x0 = Math.round(t.tx * T - originX), y0 = Math.round(t.ty * T - originY);
        const x1 = Math.round((t.tx + 1) * T - originX), y1 = Math.round((t.ty + 1) * T - originY);
        ctx.drawImage(t.img, x0, y0, x1 - x0, y1 - y0);
      }
      // 확정(complete)된 미수신 타일 — 사선 해치로 마감 (전 타일 수신 시 미발동)
      if (complete && loaded.length < targets.length) {
        const have = new Set(loaded.map((t) => `${t.tx},${t.ty}`));
        for (const t of targets) {
          if (have.has(`${t.tx},${t.ty}`)) continue;
          const x0 = Math.round(t.tx * T - originX), y0 = Math.round(t.ty * T - originY);
          const x1 = Math.round((t.tx + 1) * T - originX), y1 = Math.round((t.ty + 1) * T - originY);
          hatchMissingTile(ctx, x0, y0, x1 - x0, y1 - y0);
        }
      }
    } else {
      ctx.strokeStyle = "#d6dbe1";
      ctx.lineWidth = 1;
      for (let gx = 0; gx <= w; gx += 48) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke(); }
      for (let gy = 0; gy <= h; gy += 48) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke(); }
      ctx.fillStyle = "#9aa3ad";
      ctx.font = "16px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("지도 타일을 불러올 수 없습니다 (오프라인)", w / 2, 22);
      if (warnOffline) console.warn(`[OM 지도] 타일 로드 실패 — 오프라인/네트워크. 폴백 격자 표시 (${warnLabel})`);
    }

    // 베이스맵 위 옅은 흰 베일 — 오버레이 가독성
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(0, 0, w, h);

    onDone(loaded.length > 0, complete);
  };

  /** round=0 첫 패스, 이후 미수신 타일만 재시도. 라운드 종료마다 필요 시 재합성 + 다음 라운드 예약. */
  const runRound = (round: number, pending: { tx: number; ty: number }[], budgetMs: number) => {
    Promise.all(pending.map((t) => loadTile(t.tx, t.ty, budgetMs))).then((results) => {
      if (cancelled) return;
      const missing: { tx: number; ty: number }[] = [];
      let gained = 0;
      results.forEach((r, i) => {
        if (r) { loaded.push(r); gained++; }
        else missing.push(pending[i]);
      });
      // 무진행(신규 0) 라운드 누적 — 진행이 있으면 리셋. 재시도는 줄어드는 missing 만 재요청하므로
      //   진행은 단조(streak 진동 없음). 혼잡 해소가 진행되는 한(gained>0) 계속 돌고, 오프라인/행잉이면
      //   곧 NO_PROGRESS_MAX 도달로 조기 확정, 진행이 이어져도 MAX_ROUNDS 하드 상한에서 확정.
      noProgressStreak = gained > 0 ? 0 : noProgressStreak + 1;
      const settled =
        missing.length === 0 || noProgressStreak >= NO_PROGRESS_MAX || round >= MAX_ROUNDS;
      // 첫 패스는 항상 합성(폴백 포함). 재시도 라운드는 신규 타일 수신 시, 또는 확정 시(complete
      // 전환을 onDone 으로 알리기 위해) 재합성. 오프라인 경고는 첫 패스에서만 1회.
      if (round === 0 || gained > 0 || settled) drawAll(settled, round === 0);
      if (settled) {
        if (missing.length > 0)
          console.warn(`[OM 지도] 타일 ${missing.length}/${targets.length}개 미수신 상태로 확정 — 재시도 종료 (${warnLabel})`);
        return;
      }
      console.warn(`[OM 지도] 타일 ${missing.length}/${targets.length}개 미수신 — ${round + 1}차 재시도 예약 (${warnLabel})`);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!cancelled) runRound(round + 1, missing, TILE_BUDGET_RETRY_MS);
      }, RETRY_DELAY_MS);
    });
  };

  runRound(0, targets, TILE_BUDGET_FIRST_MS);

  return () => {
    cancelled = true;
    if (retryTimer != null) clearTimeout(retryTimer);
    // 미완료 타일 요청 중단 + 디코드 버퍼 해제 (언마운트/재계산 시 고아 Image 누수 방지)
    for (const im of imgs) { if (!im.complete) im.src = ""; }
  };
}

interface MapGeom {
  proj: MapProjection;
  rLat: number; rLon: number;
  bLat: number; bLon: number;
  bDistKm: number; bAz: number;
  startAz: number; endAz: number; sweep: number;
  leftRel: number; rightRel: number;
  shadowFarKm: number;
  polys: [number, number][][];
  lossPx: [number, number][];
}

interface Props {
  radarSite: RadarSite;
  building: ManualBuilding;
  buildingGroups: BuildingGroup[];
  los: LoSProfileData;
  /** 이 레이더의 소실표적 — 부채꼴 + 건물 후방으로 필터해 점 오버레이 */
  lossPoints?: LossPointGeo[];
}

export default function ReportOMRadarBuildingMap({ radarSite, building, buildingGroups, los, lossPoints }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const groupColor = groupColorOf(building.group_id, buildingGroups) ?? "#a60739";

  // ── 기하 계산 (투영 파라미터 + 부채꼴/footprint/소실점) ──
  const geom = useMemo<MapGeom>(() => {
    const rLat = radarSite.latitude, rLon = radarSite.longitude;
    const bLat = building.latitude, bLon = building.longitude;
    const bDistKm = los.totalDistance > 0 ? los.totalDistance : haversineKm(rLat, rLon, bLat, bLon);
    const bAz = los.bearing ?? bearingDeg(rLat, rLon, bLat, bLon);

    const ext = calcBuildingAzExtent(rLat, rLon, building);
    // 변 방위 — 중심(대상 방위) 기준 좌/우로 정렬해 항상 short-arc 으로 채운다.
    let leftRel = Math.min(relTo(ext.start_deg, bAz), relTo(ext.end_deg, bAz));
    let rightRel = Math.max(relTo(ext.start_deg, bAz), relTo(ext.end_deg, bAz));

    // 음영(영향) 외곽 거리 — 건물 뒤로 보기 좋게 확장 + 레이더 제원범위 상한
    const rangeKm = radarSite.range_nm > 0 ? radarSite.range_nm * KM_PER_NM : Infinity;
    const extendKm = Math.min(Math.max(bDistKm * 0.45, 1.5), 6);
    const shadowFarKm = Math.min(bDistKm + extendKm, rangeKm);

    const polys = buildingPolygons(building);

    // 방어 — calcBuildingAzExtent 은 '최대 공백의 여집합' 구간을 돌려주므로, 레이더가 footprint 안/극근접일
    //   드문 경우 각폭이 180°를 넘어(주호 선택) 부채꼴이 뒤집힐 수 있다. 이때는 실제 코너 방위에서 대상
    //   방위(bAz) 기준 반각을 직접 산출해 소호로 보정. (원거리 장애물 정상 케이스에선 미발동)
    if (rightRel - leftRel > 180) {
      let half = 2;
      for (const poly of polys) for (const [la, lo] of poly) {
        const r = Math.abs(relTo(bearingDeg(rLat, rLon, la, lo), bAz));
        if (r < 170 && r > half) half = r;
      }
      half = Math.min(half, 45);
      leftRel = -half; rightRel = half;
    }
    const startAz = (bAz + leftRel + 360) % 360;   // 좌측 변
    const endAz = (bAz + rightRel + 360) % 360;     // 우측 변
    const sweep = Math.max(0.5, rightRel - leftRel); // 각폭(°)

    // 부채꼴 far/near 변 끝점 (구면) — bbox 산출용
    const farStart = destPoint(rLat, rLon, startAz, shadowFarKm);
    const farEnd = destPoint(rLat, rLon, endAz, shadowFarKm);
    const nearStart = destPoint(rLat, rLon, startAz, bDistKm);
    const nearEnd = destPoint(rLat, rLon, endAz, bDistKm);

    // bbox — 표시 필수 점들의 위경도 경계 → 공유 투영(fitProjection)
    const pts: [number, number][] = [[rLat, rLon], [bLat, bLon], farStart, farEnd, nearStart, nearEnd];
    for (const poly of polys) for (const p of poly) pts.push(p);
    const proj = fitProjection(pts);
    const { project } = proj;

    // 소실표적 — 부채꼴(±1°) + 건물 후방 ~ 음영 표시 범위(shadowFarKm) 이내.
    //   (shadowFarKm 밖은 표시 영향 범위 밖이라 캔버스 밖으로 투영되어 사라지므로 상한 적용)
    const lossPx: [number, number][] = [];
    for (const lp of lossPoints ?? []) {
      const d = haversineKm(rLat, rLon, lp.lat, lp.lon);
      if (d <= bDistKm * 0.98 || d > shadowFarKm) continue;
      const az = bearingDeg(rLat, rLon, lp.lat, lp.lon);
      const r = relTo(az, bAz);
      if (r < leftRel - 1 || r > rightRel + 1) continue;
      lossPx.push(project(lp.lat, lp.lon));
    }

    return {
      proj,
      rLat, rLon, bLat, bLon, bDistKm, bAz, startAz, endAz, sweep, leftRel, rightRel,
      shadowFarKm, polys, lossPx,
    };
  }, [radarSite, building, los, lossPoints]);

  // ── 렌더: 타일 합성(공유 composeTiles) + 오버레이 ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // willReadFrequently: 소프트웨어(CPU) 백킹 강제 — 이 도면은 (빌딩×레이더) 페이지마다 반복되어
    // GPU 가속 백킹이면 페이지 수만큼 공유 WebView2 GPU 프로세스에 상주, 다건물 보고서에서 GPU
    // 프로세스 메모리 고갈 → 두 창 동시 blank/프리징. 정적 1회 그리기라 CPU 래스터로 충분하고,
    // 컴포지터는 뷰포트 근처 타일만 GPU 텍스처로 올리므로 화면 밖 페이지는 GPU 를 점유하지 않는다.
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    canvas.width = BACK_W;
    canvas.height = BACK_H;
    // PDF 내보내기(useReportExport)가 이 속성으로 타일 렌더 완료를 기다린다 — 비동기 타일이
    //   PrintToPdf 스냅샷보다 늦어 백지로 캡처되는 것을 방지. 그리기 완료 시 "true" 로 전환.
    canvas.setAttribute("data-map-ready", "false");
    canvas.setAttribute("data-map-complete", "false");

    return composeTiles(ctx, geom.proj, `${radarSite.name} / 건물 ${building.id}`, (online, complete) => {
      drawOverlay(ctx, geom, groupColor);
      drawScaleBar(ctx, geom.proj.mpp);
      drawNorth(ctx);
      drawAttribution(ctx, online);

      // 렌더 완료 — 내보내기 게이트 통과 허용 (오프라인 폴백도 '완료'로 간주해 무한 대기 방지)
      canvas.setAttribute("data-map-ready", "true");
      // 타일 부분 유실 자가치유(백그라운드 재시도 재합성) 진행 여부 — 내보내기 게이트가 잠시 대기
      canvas.setAttribute("data-map-complete", complete ? "true" : "false");
    });
  }, [geom, groupColor, radarSite.name, building.id]);

  const eid = `radarmap.${radarSite.name}_${building.id}`;

  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center justify-between text-[12px]">
        <OMEditable id={`${eid}.title`} value="영향 범위 — 위에서 본 도면 (레이더 → 건물 양끝 부채꼴)" tag="span" className="font-semibold text-gray-800" />
        <span className="text-[10px] text-gray-400">
          방위 {geom.startAz.toFixed(0)}°–{geom.endAz.toFixed(0)}° · 각폭 {geom.sweep.toFixed(1)}°
        </span>
      </div>

      <div className="flex items-start gap-3">
        <canvas
          ref={canvasRef}
          width={BACK_W}
          height={BACK_H}
          data-map-canvas="1"
          data-map-ready="false"
          data-map-complete="false"
          style={{ width: DISP_W, height: "auto", display: "block", flex: "0 0 auto", border: "1px solid #e5e7eb", borderRadius: 4 }}
        />

        {/* 범례 + 부채꼴 수치 */}
        <div className="flex-1 text-[10px] text-gray-600">
          <div className="mb-1.5 flex flex-col gap-1">
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "#1d4ed8", boxShadow: "0 0 0 1px #fff" }} />
              <OMEditable id={`${eid}.legend.radar`} value="레이더" tag="span" /> ({radarSite.name})
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: groupColor, opacity: 0.7, border: `1px solid ${groupColor}` }} />
              <OMEditable id={`${eid}.legend.bldg`} value="분석 대상 건물" tag="span" />
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-2.5 rounded-sm" style={{ backgroundColor: "rgba(166,7,57,0.28)", border: "1px dashed #a60739" }} />
              <OMEditable id={`${eid}.legend.fan`} value="영향(음영) 부채꼴" tag="span" />
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "rgba(255,23,69,0.9)" }} />
              <OMEditable id={`${eid}.legend.loss`} value="소실표적" tag="span" />
            </span>
          </div>

          <table className="om-table sm-table" style={{ marginTop: 4 }}>
            <tbody>
              <tr>
                <td><OMEditable id={`${eid}.tbl.az`} value="분석 대상 방위" tag="span" /></td>
                <td className="ta-r mono">{geom.bAz.toFixed(1)}°</td>
              </tr>
              <tr className="alt">
                <td><OMEditable id={`${eid}.tbl.span`} value="부채꼴 방위 구간" tag="span" /></td>
                <td className="ta-r mono">{geom.startAz.toFixed(0)}°–{geom.endAz.toFixed(0)}° ({geom.sweep.toFixed(1)}°)</td>
              </tr>
              <tr>
                <td><OMEditable id={`${eid}.tbl.dist`} value="레이더 거리" tag="span" /></td>
                <td className="ta-r mono">{(geom.bDistKm / KM_PER_NM).toFixed(1)}NM ({geom.bDistKm.toFixed(1)}km)</td>
              </tr>
              <tr className="alt">
                <td><OMEditable id={`${eid}.tbl.far`} value="음영 표시 범위" tag="span" /></td>
                <td className="ta-r mono">~{(geom.shadowFarKm / KM_PER_NM).toFixed(1)}NM</td>
              </tr>
            </tbody>
          </table>
          <div className="mt-1 text-[9px] text-gray-400 leading-snug">
            <OMEditable id={`${eid}.tbl.note`} value="부채꼴은 레이더에서 건물 양쪽 끝 방위로 뻗는 음영(차폐) 구역 — 이 범위 후방의 표적이 차폐 영향을 받는다." tag="span" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── canvas 그리기 헬퍼 ──

function drawOverlay(ctx: CanvasRenderingContext2D, g: MapGeom, groupColor: string) {
  const { rLat, rLon, bAz, startAz, endAz, leftRel, rightRel, shadowFarKm, bDistKm, polys, lossPx } = g;
  const { project } = g.proj;
  const [rx, ry] = project(rLat, rLon);

  // 부채꼴 far/near 호 샘플 (short-arc, 좌→우)
  const K = 48;
  const farPts: [number, number][] = [];
  const nearPts: [number, number][] = [];
  for (let i = 0; i <= K; i++) {
    const rel = leftRel + ((rightRel - leftRel) * i) / K;
    const az = (bAz + rel + 360) % 360;
    farPts.push(project(...destPoint(rLat, rLon, az, shadowFarKm)));
    nearPts.push(project(...destPoint(rLat, rLon, az, bDistKm)));
  }

  // 1) 옅은 전체 부채꼴 (레이더 → far)
  ctx.beginPath();
  ctx.moveTo(rx, ry);
  for (const p of farPts) ctx.lineTo(p[0], p[1]);
  ctx.closePath();
  ctx.fillStyle = "rgba(166,7,57,0.12)";
  ctx.fill();

  // 2) 진한 음영 (건물 뒤 near→far)
  ctx.beginPath();
  for (let i = 0; i < nearPts.length; i++) { const p = nearPts[i]; if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); }
  for (let i = farPts.length - 1; i >= 0; i--) ctx.lineTo(farPts[i][0], farPts[i][1]);
  ctx.closePath();
  ctx.fillStyle = "rgba(166,7,57,0.26)";
  ctx.fill();

  // 3) 변(레이더→far) 점선 + 끝점 반환
  const edge = (az: number): [number, number] => {
    const f = project(...destPoint(rLat, rLon, az, shadowFarKm));
    ctx.beginPath();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = "#a60739";
    ctx.lineWidth = 2;
    ctx.moveTo(rx, ry); ctx.lineTo(f[0], f[1]);
    ctx.stroke();
    ctx.setLineDash([]);
    return f;
  };
  const fS = edge(startAz);
  const fE = edge(endAz);

  // 건물 footprint
  if (polys.length > 0) {
    for (const poly of polys) {
      ctx.beginPath();
      for (let i = 0; i < poly.length; i++) { const [px, py] = project(poly[i][0], poly[i][1]); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
      ctx.closePath();
      ctx.fillStyle = hexA(groupColor, 0.65);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = groupColor;
      ctx.stroke();
    }
  } else {
    const [bx, by] = project(g.bLat, g.bLon);
    ctx.beginPath();
    ctx.arc(bx, by, 5, 0, Math.PI * 2);
    ctx.fillStyle = hexA(groupColor, 0.85);
    ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = "#fff"; ctx.stroke();
  }

  // 소실표적 점
  ctx.fillStyle = "rgba(255,23,69,0.9)";
  for (const [px, py] of lossPx) { ctx.beginPath(); ctx.arc(px, py, 2.4, 0, Math.PI * 2); ctx.fill(); }

  // 레이더 마커 (◉)
  ctx.beginPath(); ctx.arc(rx, ry, 7, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
  ctx.beginPath(); ctx.arc(rx, ry, 5, 0, Math.PI * 2); ctx.fillStyle = "#1d4ed8"; ctx.fill();
  ctx.beginPath(); ctx.arc(rx, ry, 2, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();

  // 변 방위 라벨
  ctx.font = "bold 15px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  labelChip(ctx, `${startAz.toFixed(0)}°`, fS[0], fS[1]);
  labelChip(ctx, `${endAz.toFixed(0)}°`, fE[0], fE[1]);
}

function labelChip(ctx: CanvasRenderingContext2D, text: string, x: number, y: number) {
  const w = ctx.measureText(text).width + 8;
  const h = 18;
  const cx = Math.max(w / 2 + 2, Math.min(BACK_W - w / 2 - 2, x));
  const cy = Math.max(h / 2 + 2, Math.min(BACK_H - h / 2 - 2, y));
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  roundRect(ctx, cx - w / 2, cy - h / 2, w, h, 4);
  ctx.fill();
  ctx.strokeStyle = "#a60739"; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = "#a60739";
  ctx.fillText(text, cx, cy + 0.5);
}

/** 확정 미수신 타일 자리 — 옅은 배경 + 사선 해치. '일부만 로딩된 지도'의 회색 빈칸을
 *  '타일 없음(의도된 미표시)'으로 읽히게 한다. 오프라인 폴백 격자(#d6dbe1)와 톤 통일.
 *  tw/th 기본값 TILE — 분수 줌(§1) 에선 스냅된 화면 타일 크기를 넘겨 해치를 정확히 채운다. */
function hatchMissingTile(ctx: CanvasRenderingContext2D, x: number, y: number, tw = TILE, th = TILE) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, tw, th);
  ctx.clip();
  ctx.fillStyle = "#e7ebf0";
  ctx.fillRect(x, y, tw, th);
  ctx.strokeStyle = "rgba(154,163,173,0.45)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  const span = Math.max(tw, th);
  for (let d = -span; d <= span; d += 12) {
    ctx.moveTo(x + d, y);
    ctx.lineTo(x + d + th, y + th);
  }
  ctx.stroke();
  ctx.restore();
}

export function drawScaleBar(ctx: CanvasRenderingContext2D, mpp: number, h = BACK_H) {
  const targetPx = 110;
  const targetM = mpp * targetPx;
  const niceM = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
  let chosen = niceM[0];
  for (const m of niceM) if (m <= targetM) chosen = m;
  const barPx = chosen / mpp;
  const x0 = 14, y0 = h - 16;
  ctx.strokeStyle = "#1f2937"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + barPx, y0); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x0, y0 - 4); ctx.lineTo(x0, y0 + 4); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x0 + barPx, y0 - 4); ctx.lineTo(x0 + barPx, y0 + 4); ctx.stroke();
  const label = chosen >= 1000 ? `${(chosen / 1000).toFixed(chosen % 1000 === 0 ? 0 : 1)} km` : `${chosen} m`;
  ctx.font = "13px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
  ctx.fillStyle = "#1f2937";
  ctx.fillText(label, x0 + 2, y0 - 5);
}

export function drawNorth(ctx: CanvasRenderingContext2D, w = BACK_W) {
  const x = w - 22, y = 26;
  ctx.beginPath();
  ctx.moveTo(x, y - 14); ctx.lineTo(x - 6, y + 6); ctx.lineTo(x, y + 1); ctx.lineTo(x + 6, y + 6);
  ctx.closePath();
  ctx.fillStyle = "#1f2937"; ctx.fill();
  ctx.font = "bold 13px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.fillStyle = "#1f2937";
  ctx.fillText("N", x, y + 7);
}

export function drawAttribution(ctx: CanvasRenderingContext2D, online: boolean, w = BACK_W, h = BACK_H) {
  if (!online) return;
  const text = "© OpenStreetMap · © CARTO";
  ctx.font = "10px sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "bottom";
  const tw = ctx.measureText(text).width + 6;
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.fillRect(w - tw - 2, h - 14, tw, 13);
  ctx.fillStyle = "#6b7280";
  ctx.fillText(text, w - 4, h - 2);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** #rrggbb + alpha → rgba() */
export function hexA(hex: string, a: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return `rgba(166,7,57,${a})`;
  const num = parseInt(m[1], 16);
  return `rgba(${(num >> 16) & 255},${(num >> 8) & 255},${num & 255},${a})`;
}
