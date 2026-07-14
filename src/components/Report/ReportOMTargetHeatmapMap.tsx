/**
 * OM 보고서 §1 전체 표적 히트맵 — 모든 레이더를 한 장(A4 1페이지)에 합친 결합 밀도 지도.
 *
 * §2 위치 도면·§3/§4 도면과 동일한 정적 래스터 타일 합성 방식(공유 헬퍼: composeTiles·축척/나침반/
 * 저작권 — 라이브 MapLibre/deck.gl 미사용, WebGL 컨텍스트 고갈/PDF 캡처 불안정 회피)으로 그리되,
 * 투영은 fitProjection 이 아닌 자체 구성이다(페이지 잔여 높이를 꽉 채우는 정확한 지리 창 + 분수 줌).
 *
 *  - 결합: 모든 레이더의 track_heatmap(±150NM 전방위 전수 밀도, 표시 전용) 을 하나의 강도 버퍼에 합산.
 *  - "진짜 히트맵" 룩: box blur 로 스무딩 → ln 정규화 → 붉은계열(ColorBrewer Reds) 색 램프 LUT.
 *      저강도는 은은한 살구색, 고밀도 항로는 진홍으로 타오른다(단색 alpha → 강도별 색 그라디언트 전환).
 *  - 소실표적(loss_points_summary, 전수)도 같은 강도 버퍼에 +1 스탬프 — 시각 구분 없음(기존 설계 유지).
 *  - 북한 크롭: 상단(북)을 최북단 레이더 위도 + TOP_MARGIN_DEG 에서 고정 크롭(북측 원거리 표적·
 *      원 상단은 의도적으로 숨김)하고 하단(남)을 페이지 크기에 맞춰 확장 — 지도가 A4 페이지 잔여
 *      높이를 꽉 채운다(297mm 오버플로우 금지 — ASPECT 유도 참조).
 *  - 원 밖 표적: Rust 그리드가 ±150NM 로 확장되어 60NM 원 밖 표적도 표시 창 안이면 전부 보인다.
 *  - 60NM 원·레이더 마커는 유지(상단 크롭으로 원 상단이 잘려 보이는 것 정상).
 *  - track_heatmap 부재(구버전 캐시) 시에도 소실점·마커만으로 렌더 — 크래시/배너 없음.
 *  - PDF 안전: 단일 canvas + data-map-canvas/ready/complete 게이트(§2/§3/§4 도면과 동일 자가치유).
 *    무거운 연산(강도 합산·blur·LUT·ImageData)은 전부 useMemo 1회 — 오프스크린 캔버스로 메모이즈해
 *    composeTiles 자가치유 재합성(onDone 반복)마다 drawImage 만 한다.
 */
import { useEffect, useMemo, useRef } from "react";
import type { RadarSite } from "../../types";
import type { RadarMonthlyResult } from "../../types/obstacle";
import ReportOMSectionHeader from "./ReportOMSectionHeader";
import {
  composeTiles, mercX, mercY, TILE,
  drawScaleBar, drawNorth, drawAttribution, type MapProjection,
} from "./ReportOMRadarBuildingMap";

const DEG2RAD = Math.PI / 180;
const KM_PER_NM = 1.852;
const R_KM = 6371;
/** 범위 원 = 60NM(OM 통계 스코프). 표시 유지 — 원 밖 표적도 그리드 확장으로 표시됨. */
const OM_RANGE_NM = 60;
/**
 * 뷰 상단 크롭 여유(°) — 최북단 레이더 위도 + 이 값에서 상단을 고정 크롭.
 * 북쪽(북한 방면) 데이터·60NM 원 상단은 의도적으로 잘라내고, 고정 높이(H)만큼 하단(남쪽)이 넓게 보인다.
 */
const TOP_MARGIN_DEG = 0.1;
/** 범위 원 표시용 샘플 분할 수. */
const RING_SEG = 128;

/** 가로 백킹 픽셀 — §2/§4 도면과 동일 규격(콘텐츠 폭 표시의 약 2배 밀도로 PDF 에서 또렷). */
const W = 1376;

// ── ASPECT(세로/가로) 유도 — A4 페이지 잔여 높이를 캔버스가 꽉 채우되 297mm 절대 초과 금지 ──
//   (min-height:297mm 라 넘치면 페이지가 늘어나 인쇄 잘림 연쇄 — 과거 fc9c4aa 버그. 애매하면 undershoot.)
// A4 210×297mm, .report-page-inner padding 16mm/14mm/18mm(reportOmStyles.css line 50-51)
//   → 콘텐츠 폭 182mm(=210−14·2), 콘텐츠 높이 263mm(=297−16−18).
// 섹션 헤더 실높이 — ReportOMSectionHeader 는 radarName 지정 시 .om-h2 + .om-h3 둘 다 렌더한다:
//   .om-h2: font 19px×line-height1.4=26.6px + padding 9+9=18px = 44.6px, margin-bottom 16px
//   .om-h3: font 15px×line-height1.4=21px,                            margin-bottom 8px
//   합 = 44.6 + 16 + 21 + 8 = 89.6px  → ×(25.4/96) = 23.71mm
// 캔버스 marginTop 6px = 1.59mm, 안전여유 3mm(테두리 1px·H 반올림 오차 흡수 → undershoot).
// 캔버스 가용높이 = 263 − 23.71 − 1.59 − 3 = 234.70mm → ASPECT = 234.70/182 = 1.2896.
const PX2MM = 25.4 / 96;
/** 헤더(.om-h2 + .om-h3) 실높이(px) — font·padding·margin 합. 위 유도 참조. */
const HDR_PX = 44.6 + 16 + 21 + 8;
const CANVAS_AVAIL_MM = 263 - HDR_PX * PX2MM - 6 * PX2MM - 3;
const ASPECT = CANVAS_AVAIL_MM / 182;
/** 세로 백킹 픽셀 — 콘텐츠 폭(182mm) 대비 잔여 높이 비율(ASPECT)로 산출. */
const H = Math.round(W * ASPECT);

// ── 붉은계열 색 램프 LUT (256엔트리) — ColorBrewer Reds + alpha 램프 ──
// t=0 완전투명 → 고강도 진홍. 저강도가 은은하게 깔리고 고밀도 항로가 타오르는 전형적 히트맵 룩.
// [t, r, g, b, a] — 스톱 사이 선형보간. t=0 rgb 은 0.15 와 동일(alpha 만 0)으로 다크 프린지 방지.
const HEAT_STOPS: [number, number, number, number, number][] = [
  [0.0, 254, 224, 210, 0.0],
  [0.15, 254, 224, 210, 0.35],
  [0.3, 252, 187, 161, 0.5],
  [0.45, 252, 146, 114, 0.62],
  [0.6, 251, 106, 74, 0.72],
  [0.75, 239, 59, 44, 0.8],
  [0.9, 203, 24, 29, 0.87],
  [1.0, 153, 0, 13, 0.92],
];

/** HEAT_STOPS → 256×RGBA LUT (Uint8ClampedArray, alpha 도 0..255). */
function buildHeatLut(): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 4);
  let si = 0;
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    while (si < HEAT_STOPS.length - 2 && t > HEAT_STOPS[si + 1][0]) si++;
    const a = HEAT_STOPS[si], b = HEAT_STOPS[si + 1];
    const span = b[0] - a[0] || 1;
    const f = Math.min(1, Math.max(0, (t - a[0]) / span));
    const o = i * 4;
    lut[o] = a[1] + (b[1] - a[1]) * f;
    lut[o + 1] = a[2] + (b[2] - a[2]) * f;
    lut[o + 2] = a[3] + (b[3] - a[3]) * f;
    lut[o + 3] = (a[4] + (b[4] - a[4]) * f) * 255;
  }
  return lut;
}

/** 분리형 box blur(반경 r) 1패스 — 슬라이딩 윈도우 O(W·H). 경계는 가장자리 값 확장. in-place(src 갱신). */
function boxBlur(src: Float32Array, w: number, h: number, r: number) {
  const win = 2 * r + 1;
  const tmp = new Float32Array(w * h);
  // 수평
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / win;
      const xout = Math.min(w - 1, Math.max(0, x - r));
      const xin = Math.min(w - 1, Math.max(0, x + r + 1));
      acc += src[row + xin] - src[row + xout];
    }
  }
  // 수직
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      src[y * w + x] = acc / win;
      const yout = Math.min(h - 1, Math.max(0, y - r));
      const yin = Math.min(h - 1, Math.max(0, y + r + 1));
      acc += tmp[yin * w + x] - tmp[yout * w + x];
    }
  }
}

/** mercY 역변환 (0..1 → 위도 deg) — 뷰 중심 위도 산출(mpp)용. */
const mercYinv = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / DEG2RAD;

interface RadarPx {
  /** 60NM 범위 원 폴리라인(픽셀) — 등장방형 타원 근사(옅은 외곽선용) */
  ringPx: [number, number][];
  /** 레이더 마커 픽셀 */
  px: [number, number];
  name: string;
}

interface Geom {
  proj: MapProjection;
  /** 히트맵을 1회 렌더한 오프스크린 캔버스(W×H) — 재합성마다 drawImage 만 */
  offscreen: HTMLCanvasElement;
  radars: RadarPx[];
}

interface Props {
  sectionNum: number;
  /** 결합할 레이더들 — 각 레이더의 site(좌표) + result(track_heatmap·소실점) */
  radars: { site: RadarSite; result: RadarMonthlyResult }[];
}

export default function ReportOMTargetHeatmapMap({ sectionNum, radars }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ── 기하 + 히트맵 오프스크린 — 전부 useMemo 1회(렌더 핫패스 방지) ──
  const geom = useMemo<Geom>(() => {
    // ── 자체 투영 구성 ──
    const lats = radars.map((r) => r.site.latitude);
    const lons = radars.map((r) => r.site.longitude);
    const radarMaxLat = lats.length ? Math.max(...lats) : 37.5;         // radars 소수(spread 안전)
    const centerLon = lons.length ? lons.reduce((s, v) => s + v, 0) / lons.length : 127;

    // 가로: 모든 레이더 60NM 원 동서 극점 + 양측 4% 패딩을 centerLon 중심으로 커버.
    const mxCenter = mercX(centerLon);
    let halfMerc = 1e-6;
    for (const { site } of radars) {
      const dLat = (OM_RANGE_NM * KM_PER_NM) / R_KM / DEG2RAD;
      const dLon = dLat / Math.max(0.1, Math.cos(site.latitude * DEG2RAD));
      const east = mercX(site.longitude + dLon), west = mercX(site.longitude - dLon);
      halfMerc = Math.max(halfMerc, east - mxCenter, mxCenter - west);
    }
    halfMerc *= 1.04;                          // 양측 4% 패딩
    const spanXMerc = 2 * halfMerc;
    const worldSize = W / spanXMerc;           // 가로 W 픽셀이 이 지리 창을 담도록
    const z = Math.max(3, Math.min(19, Math.log2(worldSize / TILE))); // 분수 줌(composeTiles 가 처리)
    const originX = mxCenter * worldSize - W / 2;

    // 세로 상단(북한 크롭): 데이터와 무관하게 최북단 레이더 위도 + TOP_MARGIN_DEG 로 고정 크롭.
    //   북측 원거리 표적·60NM 원 상단은 의도적으로 숨기고, 고정 높이(H)만큼 하단(남쪽)이 넓게 보인다.
    const topLat = radarMaxLat + TOP_MARGIN_DEG;
    const originY = mercY(topLat) * worldSize; // 상단 = topLat, 이후 H 픽셀만큼 남쪽으로

    const project = (lat: number, lon: number): [number, number] => [
      mercX(lon) * worldSize - originX,
      mercY(lat) * worldSize - originY,
    ];
    // mpp — 뷰 중심 위도(픽셀 y=H/2) 기준, fitProjection 과 동일 공식
    const centerLat = mercYinv((originY + H / 2) / worldSize);
    const mpp = (Math.cos(centerLat * DEG2RAD) * 2 * Math.PI * 6378137) / worldSize;
    const proj: MapProjection = { z, originX, originY, project, mpp };

    // ── 강도 버퍼(W×H) — 각 레이더 희소 셀을 단일 패스로 직접 누적(중간 배열 없음) ──
    const buf = new Float32Array(W * H);
    for (const { result } of radars) {
      const hm = result.track_heatmap ?? null;
      if (!hm || hm.cells.length === 0) continue;
      const { min_lat, min_lon, cell_deg_lat, cell_deg_lon, nx, cells, counts } = hm;
      for (let i = 0; i < cells.length; i++) {
        const idx = cells[i], cnt = counts[i];
        const ix = idx % nx, iy = (idx / nx) | 0;
        const lat0 = min_lat + iy * cell_deg_lat, lon0 = min_lon + ix * cell_deg_lon;
        const lat1 = lat0 + cell_deg_lat, lon1 = lon0 + cell_deg_lon;
        // NW(위=작은 y) → SE(아래·동) 화면 사각형
        const [xa, ya] = project(lat1, lon0);
        const [xb, yb] = project(lat0, lon1);
        let px0 = Math.floor(xa), py0 = Math.floor(ya);
        let px1 = Math.ceil(xb), py1 = Math.ceil(yb);
        if (px1 <= 0 || py1 <= 0 || px0 >= W || py0 >= H) continue; // 화면 밖 스킵
        if (px0 < 0) px0 = 0; if (py0 < 0) py0 = 0;
        if (px1 > W) px1 = W; if (py1 > H) py1 = H;
        for (let py = py0; py < py1; py++) {
          const rowoff = py * W;
          for (let px = px0; px < px1; px++) buf[rowoff + px] += cnt;
        }
      }
    }
    // 소실점(전수) — 같은 버퍼에 픽셀당 +1 스탬프
    for (const { result } of radars) {
      for (const day of result.daily_stats) {
        for (const lp of day.loss_points_summary) {
          const [x, y] = project(lp.lat, lp.lon);
          const px = Math.floor(x), py = Math.floor(y);
          if (px >= 0 && py >= 0 && px < W && py < H) buf[py * W + px] += 1;
        }
      }
    }

    // 스무딩(box blur 반경 2 × 2패스 ≈ gaussian)
    boxBlur(buf, W, H, 2);
    boxBlur(buf, W, H, 2);

    // 정규화 max(블러 후) + LUT 적용 → ImageData → 오프스크린 캔버스(1회)
    let vmax = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] > vmax) vmax = buf[i];
    const off = document.createElement("canvas");
    off.width = W; off.height = H;
    const octx = off.getContext("2d");
    if (octx && vmax > 0) {
      const img = octx.createImageData(W, H); // zero-fill(투명) — v≤0 픽셀은 그대로 둠
      const data = img.data;
      const lut = buildHeatLut();
      const lnMax = Math.log(1 + vmax);
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i];
        if (v <= 0) continue;
        let t = Math.log(1 + v) / lnMax;
        if (t > 1) t = 1; else if (t < 0) t = 0;
        const lo = ((t * 255) | 0) * 4;
        const o = i * 4;
        data[o] = lut[lo]; data[o + 1] = lut[lo + 1]; data[o + 2] = lut[lo + 2]; data[o + 3] = lut[lo + 3];
      }
      octx.putImageData(img, 0, 0);
    }

    // ── 레이더별 60NM 원 + 마커 픽셀 사전투영 ──
    const dLat = (OM_RANGE_NM * KM_PER_NM) / R_KM / DEG2RAD;
    const radarsPx: RadarPx[] = radars.map(({ site }) => {
      const dLon = dLat / Math.max(0.1, Math.cos(site.latitude * DEG2RAD));
      const ringPx: [number, number][] = [];
      for (let i = 0; i <= RING_SEG; i++) {
        const th = (2 * Math.PI * i) / RING_SEG;
        ringPx.push(project(site.latitude + dLat * Math.cos(th), site.longitude + dLon * Math.sin(th)));
      }
      return { ringPx, px: project(site.latitude, site.longitude), name: site.name };
    });

    return { proj, offscreen: off, radars: radarsPx };
  }, [radars]);

  // ── 렌더: 타일 합성(공유 composeTiles) + 오버레이 ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // willReadFrequently: 소프트웨어(CPU) 백킹 강제 — GPU 가속 백킹이면 공유 GPU 프로세스 상주
    //   메모리를 점유(§2/§3/§4 도면과 동일 근거).
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    canvas.width = W;
    canvas.height = H;
    // PDF 내보내기(useReportExport)가 data-map-ready/complete 폴링 — §2/§3/§4 도면과 동일 게이트
    canvas.setAttribute("data-map-ready", "false");
    canvas.setAttribute("data-map-complete", "false");

    const showLabels = geom.radars.length >= 2;
    return composeTiles(ctx, geom.proj, "전체 표적 히트맵", (online, complete) => {
      // 1) 히트맵 — 메모이즈된 오프스크린 1회 그리기(재합성마다 재계산 없음)
      ctx.drawImage(geom.offscreen, 0, 0);

      // 2) 레이더별 60NM 원 — 옅은 회색 외곽선(상단 크롭으로 잘려 보이는 것 정상)
      for (const r of geom.radars) {
        ctx.beginPath();
        for (let i = 0; i < r.ringPx.length; i++) {
          const [px, py] = r.ringPx[i];
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.strokeStyle = "rgba(100,116,139,0.5)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // 3) 레이더 마커(◉) + (2개 이상이면) 이름 라벨(흰 halo)
      for (const r of geom.radars) {
        const [rx, ry] = r.px;
        ctx.beginPath(); ctx.arc(rx, ry, 7, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
        ctx.beginPath(); ctx.arc(rx, ry, 5, 0, Math.PI * 2); ctx.fillStyle = "#1d4ed8"; ctx.fill();
        ctx.beginPath(); ctx.arc(rx, ry, 2, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
        if (showLabels) drawRadarNameLabel(ctx, rx, ry, r.name);
      }

      drawScaleBar(ctx, geom.proj.mpp, H);
      drawNorth(ctx, W);
      drawAttribution(ctx, online, W, H);

      // 렌더 완료 — 내보내기 게이트 통과 허용 (오프라인 폴백도 '완료'로 간주해 무한 대기 방지)
      canvas.setAttribute("data-map-ready", "true");
      // 타일 부분 유실 자가치유(백그라운드 재시도 재합성) 진행 여부 — 내보내기 게이트가 잠시 대기
      canvas.setAttribute("data-map-complete", complete ? "true" : "false");
    }, W, H);
  }, [geom]);

  const radarNames = radars.map((r) => r.site.name).join(" · ");

  return (
    <>
      <ReportOMSectionHeader
        sectionNum={sectionNum}
        title="전체 표적 히트맵"
        radarName={radarNames}
        editId="heatmap.title"
      />
      {/* 페이지 잔여 높이를 꽉 채우는 결합 히트맵(콘텐츠 폭 전체, 범례 없음) */}
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        data-map-canvas="1"
        data-map-ready="false"
        data-map-complete="false"
        style={{ width: "100%", height: "auto", display: "block", border: "1px solid #e5e7eb", borderRadius: 4, marginTop: 6 }}
      />
    </>
  );
}

// ── canvas 그리기 헬퍼 ──

/** 레이더명 라벨 — 마커 우측에 흰 halo 텍스트(작게). 오른쪽 넘치면 좌측으로 반전. */
function drawRadarNameLabel(ctx: CanvasRenderingContext2D, x: number, y: number, name: string) {
  ctx.font = "bold 13px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const tw = ctx.measureText(name).width;
  let tx = x + 11;
  if (tx + tw > W - 4) tx = x - 11 - tw;
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.strokeText(name, tx, y);
  ctx.fillStyle = "#1e3a8a";
  ctx.fillText(name, tx, y);
}
