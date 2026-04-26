import React, { useMemo, useRef, useEffect, forwardRef, useImperativeHandle } from "react";
import { Crosshair } from "lucide-react";
import type { DailyStats, RadarSite, ManualBuilding, AzSector } from "../../types";
import ReportOMSectionHeader from "./ReportOMSectionHeader";
import { type OMSectionCaptureHandle, createDeferred } from "./omCapture";

interface Props {
  sectionNum: number;
  radarSite: RadarSite;
  dailyStats: DailyStats[];
  selectedBuildings: ManualBuilding[];
  azSectors: AzSector[];
  analysisMonth?: string;
  /** true면 헤더 생략 (외부에서 헤더 렌더) */
  hideHeader?: boolean;
  /** 사전 캡처된 캔버스 dataUrl. 있으면 라이브 캔버스 대신 <img> 표시 (캡처 진행 후 보고서 재방문 등) */
  preCapturedImage?: string;
}

/** 고도(ft) → 스펙트럼 HSL 색상 (빨강→파랑) */
function altToColor(altFt: number, minAlt: number, maxAlt: number): string {
  const t = maxAlt > minAlt ? Math.max(0, Math.min(1, (altFt - minAlt) / (maxAlt - minAlt))) : 0.5;
  const hue = t * 240;
  return `hsl(${hue}, 85%, 50%)`;
}

/** HSL 문자열 → rgba 문자열 (Canvas fillStyle용) */
function hslToRgba(hsl: string, alpha: number): string {
  const m = hsl.match(/hsl\((\d+\.?\d*),\s*(\d+\.?\d*)%,\s*(\d+\.?\d*)%\)/);
  if (!m) return `rgba(128,128,128,${alpha})`;
  const h = parseFloat(m[1]) / 360;
  const s = parseFloat(m[2]) / 100;
  const l = parseFloat(m[3]) / 100;
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
  const g = Math.round(hue2rgb(p, q, h) * 255);
  const b = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 방위 구간 내 포함 여부 */
export function _inSector(azDeg: number, sectors: AzSector[]): boolean {
  for (const s of sectors) {
    if (s.start_deg <= s.end_deg) {
      if (azDeg >= s.start_deg && azDeg <= s.end_deg) return true;
    } else {
      if (azDeg >= s.start_deg || azDeg <= s.end_deg) return true;
    }
  }
  return false;
}

// ─── 타일 유틸 ───────────────────────────────────────────────────

const DEG2RAD = Math.PI / 180;

/** WGS84 → 슬리피맵 타일 좌표 */
export function _latLonToTile(lat: number, lon: number, zoom: number) {
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lon + 180) / 360) * n);
  const yRaw = (1 - Math.log(Math.tan(lat * DEG2RAD) + 1 / Math.cos(lat * DEG2RAD)) / Math.PI) / 2;
  const y = Math.floor(yRaw * n);
  return { x, y };
}

/** 타일 좌표 → 타일 좌상단 WGS84 */
export function _tileToLatLon(x: number, y: number, zoom: number) {
  const n = Math.pow(2, zoom);
  const lon = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const lat = (latRad * 180) / Math.PI;
  return { lat, lon };
}

/** WGS84 → 해당 줌 레벨 전체 픽셀 좌표 */
function latLonToPixel(lat: number, lon: number, zoom: number, tileSize: number) {
  const n = Math.pow(2, zoom);
  const px = ((lon + 180) / 360) * n * tileSize;
  const yRaw = (1 - Math.log(Math.tan(lat * DEG2RAD) + 1 / Math.cos(lat * DEG2RAD)) / Math.PI) / 2;
  const py = yRaw * n * tileSize;
  return { px, py };
}

/** 레이더 범위 기준 적절한 줌 레벨 계산 */
function computeZoom(lat: number, rangeKm: number, canvasSize: number): number {
  // 위도에서 1px당 미터 = (지구둘레 × cos(lat)) / (2^zoom × 256)
  for (let z = 14; z >= 4; z--) {
    const metersPerPx = (40075016.686 * Math.cos(lat * DEG2RAD)) / (Math.pow(2, z) * 256);
    const coveredKm = (metersPerPx * canvasSize) / 1000;
    if (coveredKm >= rangeKm * 2.01) return z;
  }
  return 4;
}

const TILE_URL = "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png";
const TILE_SIZE = 512; // @2x

const FIXED_ALTS = [1000, 2000, 3000, 5000, 10000, 15000, 20000];
const DOT_RADIUS = 2.5; // 고정 크기 작은 점
const MIN_ALT = 1000;
const MAX_ALT = 20000;

const ReportOMAzDistScatter = forwardRef<OMSectionCaptureHandle, Props>(function ReportOMAzDistScatter({
  sectionNum, radarSite, dailyStats, selectedBuildings, azSectors, analysisMonth, hideHeader, preCapturedImage,
}: Props, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const genRef = useRef(0);
  // 캡처 readiness deferred — drawAll() 완료 시 resolve. capture() 가 await.
  const readyDeferredRef = useRef(createDeferred<void>());
  const readyFiredRef = useRef(false);

  const monthLabel = analysisMonth
    ? `${analysisMonth.slice(0, 4)}년 ${parseInt(analysisMonth.slice(5, 7))}월`
    : "";

  // 전체 Loss 포인트 (섹터 구분 없이 통합)
  const allLoss = useMemo(() => {
    const pts: { lat: number; lon: number; altFt: number; durationS: number }[] = [];
    for (const d of dailyStats) {
      for (const lp of d.loss_points_summary) {
        if (lp.lat === 0 && lp.lon === 0) continue;
        pts.push({ lat: lp.lat, lon: lp.lon, altFt: lp.alt_ft, durationS: lp.duration_s });
      }
      if (d.baseline_loss_points) {
        for (const lp of d.baseline_loss_points) {
          if (lp.lat === 0 && lp.lon === 0) continue;
          pts.push({ lat: lp.lat, lon: lp.lon, altFt: lp.alt_ft, durationS: lp.duration_s });
        }
      }
    }
    return pts;
  }, [dailyStats]);

  // 캔버스 크기
  const canvasW = 1400;
  const canvasH = 1400;

  // 줌 & 바운드 계산
  const mapParams = useMemo(() => {
    const rangeKm = radarSite.range_nm * 1.852;
    const zoom = computeZoom(radarSite.latitude, rangeKm, canvasW / 2); // @2x이므로 논리 크기 기준
    const center = latLonToPixel(radarSite.latitude, radarSite.longitude, zoom, TILE_SIZE);

    // 캔버스 범위에 해당하는 타일 인덱스
    const halfW = canvasW / 2;
    const halfH = canvasH / 2;
    const tileMinX = Math.floor((center.px - halfW) / TILE_SIZE);
    const tileMaxX = Math.floor((center.px + halfW) / TILE_SIZE);
    const tileMinY = Math.floor((center.py - halfH) / TILE_SIZE);
    const tileMaxY = Math.floor((center.py + halfH) / TILE_SIZE);

    // 캔버스 원점 (타일 그리드 좌상단)의 전역 픽셀 좌표
    const originPx = center.px - halfW;
    const originPy = center.py - halfH;

    return { zoom, center, originPx, originPy, tileMinX, tileMaxX, tileMinY, tileMaxY, rangeKm };
  }, [radarSite, canvasW, canvasH]);

  // geo → canvas 좌표 변환
  const geoToCanvas = useMemo(() => {
    const { zoom, originPx, originPy } = mapParams;
    return (lat: number, lon: number) => {
      const { px, py } = latLonToPixel(lat, lon, zoom, TILE_SIZE);
      return { x: px - originPx, y: py - originPy };
    };
  }, [mapParams]);

  // 고정 크기 작은 점
  const dotR = DOT_RADIUS;

  // 캔버스 렌더링
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || allLoss.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const gen = ++genRef.current;

    const { zoom, tileMinX, tileMaxX, tileMinY, tileMaxY, originPx, originPy, rangeKm } = mapParams;

    // 타일 로드
    const tiles: { img: HTMLImageElement; dx: number; dy: number }[] = [];
    let loaded = 0;
    const totalTiles = (tileMaxX - tileMinX + 1) * (tileMaxY - tileMinY + 1);

    const drawAll = () => {
      if (gen !== genRef.current) return; // stale — 이전 타일 로드 무시
      ctx.clearRect(0, 0, canvasW, canvasH);
      // 배경
      ctx.fillStyle = "#f0f0f0";
      ctx.fillRect(0, 0, canvasW, canvasH);

      // 타일
      for (const t of tiles) {
        ctx.drawImage(t.img, t.dx, t.dy, TILE_SIZE, TILE_SIZE);
      }

      // 레이더 범위 원 (NM 단위 링)
      const radarCanvas = geoToCanvas(radarSite.latitude, radarSite.longitude);
      const ringIntervalKm = 20 * 1.852;
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = "rgba(150,150,160,0.5)";
      ctx.lineWidth = 1;
      ctx.font = "18px sans-serif";
      ctx.fillStyle = "rgba(120,120,130,0.7)";
      for (let km = ringIntervalKm; km <= rangeKm * 1.3; km += ringIntervalKm) {
        // km → 위도 차이 → 픽셀 차이로 반지름 계산
        const edgeLat = radarSite.latitude + km / 111.32;
        const edgeCanvas = geoToCanvas(edgeLat, radarSite.longitude);
        const r = Math.abs(edgeCanvas.y - radarCanvas.y);
        ctx.beginPath();
        ctx.arc(radarCanvas.x, radarCanvas.y, r, 0, Math.PI * 2);
        ctx.stroke();
        // NM 라벨
        const nm = km / 1.852;
        ctx.fillText(`${nm.toFixed(0)}NM`, radarCanvas.x + r + 4, radarCanvas.y - 4);
      }
      ctx.setLineDash([]);

      // 방위 섹터 경계선
      if (azSectors.length > 0) {
        const sectorR = rangeKm * 1.3; // km

        // 섹터 영역 채우기
        for (const s of azSectors) {
          ctx.beginPath();
          ctx.moveTo(radarCanvas.x, radarCanvas.y);
          const startDeg = s.start_deg;
          const endDeg = s.start_deg <= s.end_deg ? s.end_deg : s.end_deg + 360;
          for (let d = startDeg; d <= endDeg; d += 1) {
            const dd = d % 360;
            const rad = (dd * Math.PI) / 180;
            const eLat = radarSite.latitude + (sectorR / 111.32) * Math.cos(rad);
            const eLon = radarSite.longitude + (sectorR / (111.32 * Math.cos(radarSite.latitude * DEG2RAD))) * Math.sin(rad);
            const ep = geoToCanvas(eLat, eLon);
            ctx.lineTo(ep.x, ep.y);
          }
          ctx.closePath();
          ctx.fillStyle = "rgba(239,68,68,0.10)";
          ctx.fill();
        }

        // 섹터 경계선
        ctx.strokeStyle = "rgba(220,38,38,0.9)";
        ctx.lineWidth = 3;
        ctx.setLineDash([12, 6]);
        for (const s of azSectors) {
          for (const deg of [s.start_deg, s.end_deg]) {
            const rad = (deg * Math.PI) / 180;
            const endLat = radarSite.latitude + (sectorR / 111.32) * Math.cos(rad);
            const endLon = radarSite.longitude + (sectorR / (111.32 * Math.cos(radarSite.latitude * DEG2RAD))) * Math.sin(rad);
            const end = geoToCanvas(endLat, endLon);
            ctx.beginPath();
            ctx.moveTo(radarCanvas.x, radarCanvas.y);
            ctx.lineTo(end.x, end.y);
            ctx.stroke();
            // 경계선 끝에 각도 라벨
            const label = `${deg.toFixed(1)}°`;
            ctx.font = "bold 18px sans-serif";
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 4;
            ctx.setLineDash([]);
            const dx = end.x - radarCanvas.x;
            const dy = end.y - radarCanvas.y;
            const len = Math.sqrt(dx * dx + dy * dy);
            const ox = len > 0 ? (dx / len) * 16 : 0;
            const oy = len > 0 ? (dy / len) * 16 : 0;
            const lx = end.x + ox;
            const ly = end.y + oy;
            ctx.strokeText(label, lx - ctx.measureText(label).width / 2, ly + 6);
            ctx.fillStyle = "rgba(220,38,38,0.9)";
            ctx.fillText(label, lx - ctx.measureText(label).width / 2, ly + 6);
            // 경계선 스타일 복원
            ctx.strokeStyle = "rgba(220,38,38,0.9)";
            ctx.lineWidth = 3;
            ctx.setLineDash([12, 6]);
          }
        }
        ctx.setLineDash([]);
      }

      // 건물 차폐 영역 + 마커
      for (const b of selectedBuildings) {
        const bp = geoToCanvas(b.latitude, b.longitude);
        const bDistKm = Math.sqrt(
          Math.pow((b.latitude - radarSite.latitude) * 111.32, 2) +
          Math.pow((b.longitude - radarSite.longitude) * 111.32 * Math.cos(radarSite.latitude * DEG2RAD), 2)
        );
        const bAzRad = Math.atan2(
          (b.longitude - radarSite.longitude) * Math.cos(radarSite.latitude * DEG2RAD),
          b.latitude - radarSite.latitude
        );

        // 차폐 삼각형
        const halfAngle = Math.max(1, Math.min(5, (b.height / bDistKm) * 0.5)) * DEG2RAD;
        const shadowR = rangeKm * 1.2;
        const startAz = bAzRad - halfAngle;
        const endAz = bAzRad + halfAngle;
        ctx.beginPath();
        // 건물 위치에서 시작
        const bStartLat = radarSite.latitude + (bDistKm / 111.32) * Math.cos(startAz);
        const bStartLon = radarSite.longitude + (bDistKm / (111.32 * Math.cos(radarSite.latitude * DEG2RAD))) * Math.sin(startAz);
        const bs = geoToCanvas(bStartLat, bStartLon);
        ctx.moveTo(bs.x, bs.y);
        // 먼 쪽 호
        for (let a = startAz; a <= endAz; a += 0.01) {
          const eLat = radarSite.latitude + (shadowR / 111.32) * Math.cos(a);
          const eLon = radarSite.longitude + (shadowR / (111.32 * Math.cos(radarSite.latitude * DEG2RAD))) * Math.sin(a);
          const ep = geoToCanvas(eLat, eLon);
          ctx.lineTo(ep.x, ep.y);
        }
        // 돌아오기
        const bEndLat = radarSite.latitude + (bDistKm / 111.32) * Math.cos(endAz);
        const bEndLon = radarSite.longitude + (bDistKm / (111.32 * Math.cos(radarSite.latitude * DEG2RAD))) * Math.sin(endAz);
        const be = geoToCanvas(bEndLat, bEndLon);
        ctx.lineTo(be.x, be.y);
        ctx.closePath();
        ctx.fillStyle = "rgba(245,158,11,0.18)";
        ctx.fill();
        ctx.strokeStyle = "rgba(217,119,6,0.6)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // 건물 마커
        ctx.fillStyle = "#f59e0b";
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.fillRect(bp.x - 7, bp.y - 7, 14, 14);
        ctx.strokeRect(bp.x - 7, bp.y - 7, 14, 14);
        // 건물명
        ctx.font = "bold 16px sans-serif";
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 4;
        ctx.strokeText(b.name || `B${b.id}`, bp.x + 12, bp.y + 5);
        ctx.fillStyle = "#92400e";
        ctx.fillText(b.name || `B${b.id}`, bp.x + 12, bp.y + 5);
      }

      // 소실표적
      for (const pt of allLoss) {
        const { x, y } = geoToCanvas(pt.lat, pt.lon);
        if (x < 0 || x > canvasW || y < 0 || y > canvasH) continue;
        const color = altToColor(pt.altFt, MIN_ALT, MAX_ALT);
        ctx.beginPath();
        ctx.arc(x, y, dotR, 0, Math.PI * 2);
        ctx.fillStyle = hslToRgba(color, 0.85);
        ctx.fill();
      }

      // 레이더 중심
      ctx.beginPath();
      ctx.arc(radarCanvas.x, radarCanvas.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = "#a60739";
      ctx.fill();
      ctx.strokeStyle = "white";
      ctx.lineWidth = 2;
      ctx.stroke();
      // 레이더 이름
      ctx.font = "bold 18px sans-serif";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 4;
      ctx.strokeText(radarSite.name, radarCanvas.x - ctx.measureText(radarSite.name).width / 2, radarCanvas.y + 24);
      ctx.fillStyle = "#a60739";
      ctx.fillText(radarSite.name, radarCanvas.x - ctx.measureText(radarSite.name).width / 2, radarCanvas.y + 24);

      // 방위 라벨 (N, NE, E, ...)
      const compassPts = [
        { deg: 0, label: "N" }, { deg: 45, label: "NE" }, { deg: 90, label: "E" },
        { deg: 135, label: "SE" }, { deg: 180, label: "S" }, { deg: 225, label: "SW" },
        { deg: 270, label: "W" }, { deg: 315, label: "NW" },
      ];
      ctx.font = "bold 20px sans-serif";
      ctx.fillStyle = "rgba(80,80,90,0.8)";
      for (const cp of compassPts) {
        const rad = (cp.deg * Math.PI) / 180;
        const labelR = rangeKm * 1.2;
        const eLat = radarSite.latitude + (labelR / 111.32) * Math.cos(rad);
        const eLon = radarSite.longitude + (labelR / (111.32 * Math.cos(radarSite.latitude * DEG2RAD))) * Math.sin(rad);
        const ep = geoToCanvas(eLat, eLon);
        if (ep.x >= 0 && ep.x <= canvasW && ep.y >= 0 && ep.y <= canvasH) {
          const tw = ctx.measureText(cp.label).width;
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 3;
          ctx.strokeText(cp.label, ep.x - tw / 2, ep.y + 7);
          ctx.fillStyle = "rgba(80,80,90,0.8)";
          ctx.fillText(cp.label, ep.x - tw / 2, ep.y + 7);
        }
      }

      // 캡처 readiness 신호 — capture() 가 await 중인 deferred 를 resolve.
      if (!readyFiredRef.current) {
        readyFiredRef.current = true;
        readyDeferredRef.current.resolve();
      }
    };

    // 타일 비동기 로드
    const n = Math.pow(2, zoom);
    for (let tx = tileMinX; tx <= tileMaxX; tx++) {
      for (let ty = tileMinY; ty <= tileMaxY; ty++) {
        // 타일 범위 클램프
        const cx = ((tx % n) + n) % n;
        const cy = ty;
        if (cy < 0 || cy >= n) { loaded++; continue; }
        const url = TILE_URL.replace("{z}", String(zoom)).replace("{x}", String(cx)).replace("{y}", String(cy));
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          if (gen !== genRef.current) return;
          const dx = tx * TILE_SIZE - originPx;
          const dy = ty * TILE_SIZE - originPy;
          tiles.push({ img, dx, dy });
          loaded++;
          if (loaded >= totalTiles) drawAll();
        };
        img.onerror = () => {
          if (gen !== genRef.current) return;
          loaded++;
          if (loaded >= totalTiles) drawAll();
        };
        img.src = url;
      }
    }

    // 타일 0개인 경우
    if (totalTiles === 0) drawAll();

    return () => { genRef.current++; };
  }, [allLoss, mapParams, geoToCanvas, radarSite, azSectors, selectedBuildings, canvasW, canvasH]);

  const totalCount = allLoss.length;

  // 빈 상태 즉시 readiness 신호 (캡처 대상 없음 — capture() 는 null 반환)
  useEffect(() => {
    if (totalCount === 0 && !readyFiredRef.current) {
      readyFiredRef.current = true;
      readyDeferredRef.current.resolve();
    }
  }, [totalCount]);

  // 명령형 capture 핸들 — 외부 오케스트레이터가 await 시퀀스로 호출
  useImperativeHandle(ref, () => ({
    async capture(): Promise<string | null> {
      // 데이터 없으면 캡처 대신 null (라이브 빈 상태 메시지를 PDF 에 그대로 인쇄)
      if (totalCount === 0) return null;
      // 타일 로드 + drawAll 완료까지 대기
      await readyDeferredRef.current.promise;
      const canvas = canvasRef.current;
      if (!canvas) throw new Error("ReportOMAzDistScatter: canvas not mounted");
      return canvas.toDataURL("image/png");
    },
  }), [totalCount]);

  // unmount 시 readiness 가 미해결이면 reject — 외부 await 가 영구 hang 되지 않도록.
  useEffect(() => {
    const deferred = readyDeferredRef.current;
    return () => {
      deferred.reject(new Error("ReportOMAzDistScatter unmounted before ready"));
    };
  }, []);

  if (totalCount === 0) {
    const hasDailyData = dailyStats.length > 0;
    return (
      <div ref={containerRef} className="mb-8">
        {!hideHeader && (
          <ReportOMSectionHeader
            sectionNum={sectionNum}
            title="방위별 표적소실 산점도"
            radarName={radarSite.name}
          />
        )}
        <div className="flex flex-col items-center py-12 text-gray-400">
          <Crosshair size={28} strokeWidth={1.2} className="mb-2" />
          <p className="text-sm">{hasDailyData ? "분석 기간 내 표적소실 미발생 (양호)" : "분석 데이터 없음"}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-8">
      {!hideHeader && (
        <ReportOMSectionHeader
          sectionNum={sectionNum}
          title={`방위-거리 소실표적 산점도${monthLabel ? ` (${monthLabel})` : ""}`}
          radarName={radarSite.name}
        />
      )}

      {/* 정보 요약 */}
      <div className="mb-2 flex items-center justify-between rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-[10px] text-gray-500">
        <span>소실 이벤트 총 {totalCount}건</span>
        <span>
          방위 구간: {azSectors.map((s) => `${s.start_deg.toFixed(1)}°~${s.end_deg.toFixed(1)}°`).join(", ") || "전방위"}
        </span>
      </div>

      <div className="rounded-md border border-gray-200 p-2">
        {preCapturedImage ? (
          <img
            src={preCapturedImage}
            alt=""
            className="w-full"
            style={{ aspectRatio: "1/1", imageRendering: "auto" }}
          />
        ) : (
          <canvas
            ref={canvasRef}
            width={canvasW}
            height={canvasH}
            className="w-full"
            style={{ aspectRatio: "1/1", imageRendering: "auto" }}
          />
        )}
      </div>

      {/* 하단 범례 */}
      <div className="mt-2 space-y-1.5">
        {/* 고도 스펙트럼 */}
        <div className="flex items-center justify-center gap-1 text-[10px] text-gray-500">
          <span className="mr-1 font-medium text-gray-600">고도(ft):</span>
          {FIXED_ALTS.map((alt) => {
            const color = altToColor(alt, MIN_ALT, MAX_ALT);
            return (
              <span key={alt} className="flex items-center gap-0.5">
                <span className="inline-block h-2.5 w-3 rounded-sm" style={{ background: color }} />
                <span>{alt >= 1000 ? `${(alt / 1000).toFixed(0)}k` : alt}</span>
              </span>
            );
          })}
        </div>

        {/* 크기 범례 + 기호 범례 */}
        <div className="flex flex-wrap justify-center gap-4 text-[10px] text-gray-600">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{
              background: "linear-gradient(135deg, hsl(0,85%,50%), hsl(120,85%,50%), hsl(240,85%,50%))",
            }} />
            소실 표적 ({totalCount}건)
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded bg-amber-400 border border-white" />
            장애물
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-4 bg-amber-500/20 border border-amber-600/60 border-dashed" />
            차폐 영역
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-0 w-4 border-t-2 border-dashed border-red-600" />
            방위 구간
          </span>
        </div>
      </div>
    </div>
  );
});

export default React.memo(ReportOMAzDistScatter);
