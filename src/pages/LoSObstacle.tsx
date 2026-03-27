import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import MapGL, { NavigationControl, type MapRef } from "react-map-gl/maplibre";
import { ScatterplotLayer, LineLayer } from "@deck.gl/layers";
import { DeckGLOverlay } from "../components/Map/DeckGLOverlay";
import { invoke } from "@tauri-apps/api/core";
import { Eye, Loader2, Radar, ChevronDown, RefreshCw } from "lucide-react";
import { SimpleCard } from "../components/common/Card";
import { useToastStore } from "../components/common/Toast";
import { useAppStore } from "../store";
import type { PanoramaPoint, NearbyPeak, RadarSite } from "../types";

/** Haversine 거리 (km) */
function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371.0;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

export default function LoSObstacle() {
  const radarSite = useAppStore((s) => s.radarSite);
  const setRadarSite = useAppStore((s) => s.setRadarSite);
  const customRadarSites = useAppStore((s) => s.customRadarSites);
  const setPanoramaViewActive = useAppStore((s) => s.setPanoramaViewActive);
  const setPanoramaActivePointStore = useAppStore((s) => s.setPanoramaActivePoint);
  const setPanoramaPinnedStore = useAppStore((s) => s.setPanoramaPinned);

  // ── LoS 파노라마 상태 ──
  const [panoramaData, setPanoramaData] = useState<PanoramaPoint[]>([]);
  const [panoramaLoading, setPanoramaLoading] = useState(false);
  const [panoramaHoverIdx, setPanoramaHoverIdx] = useState<number | null>(null);
  const [panoramaPinnedIdx, setPanoramaPinnedIdx] = useState<number | null>(null);
  const panoramaSvgRef = useRef<SVGSVGElement>(null);
  const [panoramaPeakNames, setPanoramaPeakNames] = useState<Map<number, string>>(new Map());
  const [panoramaAzRange, setPanoramaAzRange] = useState<[number, number]>([0, 360]);
  const [radarDropOpen, setRadarDropOpen] = useState(false);

  // 파노라마 뷰 활성 상태를 스토어에 동기화
  useEffect(() => {
    setPanoramaViewActive(true);
    return () => setPanoramaViewActive(false);
  }, [setPanoramaViewActive]);

  // 파노라마 계산 함수 (GPU 우선, CPU 폴백, DB 저장 포함)
  const computePanorama = useCallback(async () => {
    setPanoramaLoading(true);
    setPanoramaPinnedIdx(null);
    setPanoramaHoverIdx(null);
    setPanoramaAzRange([0, 360]);
    const radarH = radarSite.altitude + radarSite.antenna_height;
    const azStep = 0.01;
    const rangeStep = 200.0;
    const maxRange = 100.0;

    try {
      const { computePanoramaTerrainGPU } = await import("../utils/gpuPanorama");
      const terrainResults = await computePanoramaTerrainGPU(
        radarSite.latitude, radarSite.longitude, radarH,
        maxRange, azStep, rangeStep,
      );

      console.log(`[Panorama] GPU 지형 스캔 완료: ${terrainResults.length} azimuths`);
      const data = await invoke<PanoramaPoint[]>("panorama_merge_buildings", {
        radarLat: radarSite.latitude,
        radarLon: radarSite.longitude,
        radarHeightM: radarH,
        maxRangeKm: maxRange,
        azimuthStepDeg: azStep,
        terrainResults,
      });
      setPanoramaData(data);

      invoke("save_panorama_cache", {
        radarLat: radarSite.latitude,
        radarLon: radarSite.longitude,
        radarHeightM: radarH,
        dataJson: JSON.stringify(data),
      }).catch((e) => console.error("파노라마 캐시 저장 실패:", e));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("파노라마 계산 실패:", e);
      useToastStore.getState().addToast(`파노라마 GPU 계산 실패: ${msg}`, "error");
    }
  }, [radarSite]);

  const triggerPanorama = useCallback(() => {
    computePanorama().finally(() => setPanoramaLoading(false));
  }, [computePanorama]);

  // 마운트 시 DB 캐시 로드 또는 계산
  useEffect(() => {
    if (panoramaData.length > 0) return;
    let cancelled = false;
    setPanoramaLoading(true);
    invoke<string | null>("load_panorama_cache", {
      radarLat: radarSite.latitude,
      radarLon: radarSite.longitude,
    })
      .then((cached) => {
        if (cancelled) return;
        if (cached) {
          try {
            const data = JSON.parse(cached) as PanoramaPoint[];
            if (data.length > 0) {
              setPanoramaData(data);
              setPanoramaLoading(false);
              return;
            }
          } catch { /* 파싱 실패 시 재계산 */ }
        }
        if (!cancelled) triggerPanorama();
      })
      .catch(() => { if (!cancelled) triggerPanorama(); });
    return () => { cancelled = true; };
  }, [radarSite, panoramaData.length, triggerPanorama]);

  // 레이더 변경 시 파노라마 데이터 초기화
  const prevRadarRef = useRef(radarSite.name);
  useEffect(() => {
    if (prevRadarRef.current !== radarSite.name) {
      prevRadarRef.current = radarSite.name;
      setPanoramaData([]);
      setPanoramaPinnedIdx(null);
      setPanoramaHoverIdx(null);
      setPanoramaPeakNames(new Map());
    }
  }, [radarSite.name]);

  // 파노라마 지형 장애물 산 이름 조회 (로컬 DB)
  useEffect(() => {
    if (panoramaData.length === 0) return;
    let cancelled = false;

    const terrainPeaks: { idx: number; lat: number; lon: number; angle: number }[] = [];
    for (let i = 0; i < panoramaData.length; i++) {
      const pt = panoramaData[i];
      if (pt.obstacle_type !== "terrain" || pt.elevation_angle_deg <= 0.01) continue;
      let isLocalMax = true;
      for (let d = 1; d <= 5; d++) {
        const li = (i - d + panoramaData.length) % panoramaData.length;
        const ri = (i + d) % panoramaData.length;
        if (panoramaData[li].elevation_angle_deg > pt.elevation_angle_deg ||
            panoramaData[ri].elevation_angle_deg > pt.elevation_angle_deg) {
          isLocalMax = false;
          break;
        }
      }
      if (isLocalMax) {
        const isDup = terrainPeaks.some((p) => haversineKm(p.lat, p.lon, pt.lat, pt.lon) < 3);
        if (!isDup) terrainPeaks.push({ idx: i, lat: pt.lat, lon: pt.lon, angle: pt.elevation_angle_deg });
      }
    }

    terrainPeaks.sort((a, b) => b.angle - a.angle);
    const targets = terrainPeaks.slice(0, 15);
    if (targets.length === 0) return;

    (async () => {
      const names = new Map<number, string>();
      try {
        for (const target of targets) {
          if (cancelled) return;
          const peaks = await invoke<NearbyPeak[]>("query_nearby_peaks", {
            lat: target.lat, lon: target.lon, radiusKm: 3.0,
          });
          if (peaks.length > 0) {
            names.set(target.idx, peaks[0].name);
            // 인접 bin(같은 산을 가리키는 bin)에도 이름 전파
            for (let d = 1; d <= 10; d++) {
              for (const dir of [-1, 1]) {
                const adj = (target.idx + dir * d + panoramaData.length) % panoramaData.length;
                const adjPt = panoramaData[adj];
                if (adjPt.obstacle_type === "terrain" && haversineKm(adjPt.lat, adjPt.lon, target.lat, target.lon) < 3) {
                  names.set(adj, peaks[0].name);
                } else break;
              }
            }
          }
        }
        if (!cancelled && names.size > 0) setPanoramaPeakNames(names);
      } catch (e) {
        console.error("파노라마 산 이름 조회 실패:", e);
      }
    })();

    return () => { cancelled = true; };
  }, [panoramaData]);

  // 파노라마에 표시되는 건물 포인트
  const panoramaBuildingPoints = useMemo(() => {
    if (panoramaData.length === 0) return [];
    const seen = new Set<string>();
    const buildings: PanoramaPoint[] = [];
    for (const pt of panoramaData) {
      if (pt.obstacle_type === "terrain") continue;
      const key = `${pt.lat.toFixed(5)}_${pt.lon.toFixed(5)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      buildings.push(pt);
    }
    return buildings;
  }, [panoramaData]);

  const panoramaMapRef = useRef<MapRef>(null);

  // 파노라마 SVG 치수
  const panoramaSvgW = 1200;
  const panoramaSvgH = 200;
  const panoramaMargin = { top: 16, right: 30, bottom: 28, left: 50 };
  const panoramaChartW = panoramaSvgW - panoramaMargin.left - panoramaMargin.right;
  const panoramaChartH = panoramaSvgH - panoramaMargin.top - panoramaMargin.bottom;

  const panoramaVisibleRange = useMemo(() => {
    const n = panoramaData.length;
    if (n === 0) return { startIdx: 0, endIdx: 0 };
    const startIdx = Math.max(0, Math.floor((panoramaAzRange[0] / 360) * (n - 1)));
    const endIdx = Math.min(n - 1, Math.ceil((panoramaAzRange[1] / 360) * (n - 1)));
    return { startIdx, endIdx };
  }, [panoramaData.length, panoramaAzRange]);

  const panoramaMaxAngle = useMemo(() => {
    if (panoramaData.length === 0) return 1.0;
    const { startIdx, endIdx } = panoramaVisibleRange;
    let maxA = 0;
    for (let i = startIdx; i <= endIdx; i++) maxA = Math.max(maxA, panoramaData[i].elevation_angle_deg);
    return Math.max(0.5, Math.ceil(maxA * 10) / 10 + 0.1);
  }, [panoramaData, panoramaVisibleRange]);

  const panoramaMinAngle = useMemo(() => {
    if (panoramaData.length === 0) return -0.2;
    const { startIdx, endIdx } = panoramaVisibleRange;
    let minA = Infinity;
    for (let i = startIdx; i <= endIdx; i++) minA = Math.min(minA, panoramaData[i].elevation_angle_deg);
    return Math.min(-0.1, Math.floor(minA * 10) / 10 - 0.1);
  }, [panoramaData, panoramaVisibleRange]);

  const panoramaActiveIdx = panoramaPinnedIdx ?? panoramaHoverIdx;
  const panoramaActivePoint = panoramaActiveIdx !== null ? panoramaData[panoramaActiveIdx] : null;

  // 활성 포인트를 스토어에 동기화 (사이드바 표시용)
  useEffect(() => {
    if (panoramaActivePoint && panoramaActivePoint.obstacle_type === "terrain" && panoramaActiveIdx !== null) {
      const peakName = panoramaPeakNames.get(panoramaActiveIdx);
      if (peakName) {
        setPanoramaActivePointStore({ ...panoramaActivePoint, name: peakName });
      } else {
        setPanoramaActivePointStore(panoramaActivePoint);
      }
    } else {
      setPanoramaActivePointStore(panoramaActivePoint);
    }
    setPanoramaPinnedStore(panoramaPinnedIdx !== null);
  }, [panoramaActivePoint, panoramaActiveIdx, panoramaPinnedIdx, panoramaPeakNames, setPanoramaActivePointStore, setPanoramaPinnedStore]);

  // 방위 → SVG x 좌표 변환
  const azToX = useCallback((az: number) => {
    const frac = (az - panoramaAzRange[0]) / (panoramaAzRange[1] - panoramaAzRange[0]);
    return panoramaMargin.left + frac * panoramaChartW;
  }, [panoramaAzRange, panoramaChartW, panoramaMargin.left]);

  const idxToX = useCallback((idx: number) => {
    const n = panoramaData.length;
    if (n <= 1) return panoramaMargin.left;
    const az = (idx / (n - 1)) * 360;
    return azToX(az);
  }, [panoramaData.length, azToX, panoramaMargin.left]);

  // 건물 세로선 사전 계산
  const panoramaBuildingPaths = useMemo(() => {
    if (panoramaData.length === 0) return { gis: "", manual: "" };
    const { startIdx, endIdx } = panoramaVisibleRange;
    const toY = (angle: number) => panoramaMargin.top + panoramaChartH * (1 - (angle - panoramaMinAngle) / (panoramaMaxAngle - panoramaMinAngle));
    let gisD = "";
    let manualD = "";
    for (let i = startIdx; i <= endIdx; i++) {
      const pt = panoramaData[i];
      if (pt.obstacle_type === "terrain") continue;
      const x = idxToX(i);
      const yTop = toY(pt.elevation_angle_deg);
      const terrainAngle = Math.max(0, pt.elevation_angle_deg - (pt.obstacle_height_m / (pt.distance_km * 1000)) * (180 / Math.PI));
      const yBottom = toY(Math.max(terrainAngle, panoramaMinAngle));
      const seg = `M${x} ${yTop}L${x} ${yBottom}`;
      if (pt.obstacle_type === "manual_building") {
        manualD += seg;
      } else {
        gisD += seg;
      }
    }
    return { gis: gisD, manual: manualD };
  }, [panoramaData, panoramaVisibleRange, panoramaMinAngle, panoramaMaxAngle, panoramaMargin, panoramaChartH, idxToX]);

  const handlePanoramaMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (panoramaData.length === 0) return;
      const svg = panoramaSvgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const scaleX = panoramaSvgW / rect.width;
      const mx = (e.clientX - rect.left) * scaleX - panoramaMargin.left;
      if (mx < 0 || mx > panoramaChartW) {
        setPanoramaHoverIdx(null);
        return;
      }
      const azFrac = mx / panoramaChartW;
      const az = panoramaAzRange[0] + azFrac * (panoramaAzRange[1] - panoramaAzRange[0]);
      const idx = Math.round((az / 360) * (panoramaData.length - 1));
      setPanoramaHoverIdx(Math.max(0, Math.min(panoramaData.length - 1, idx)));
    },
    [panoramaData.length, panoramaChartW, panoramaMargin.left, panoramaAzRange]
  );

  const handlePanoramaClick = useCallback(
    (_e: React.MouseEvent<SVGSVGElement>) => {
      if (panoramaHoverIdx === null) return;
      setPanoramaPinnedIdx((prev) => (prev === panoramaHoverIdx ? null : panoramaHoverIdx));
    },
    [panoramaHoverIdx]
  );

  // 파노라마 SVG에 non-passive wheel 리스너
  useEffect(() => {
    const svg = panoramaSvgRef.current;
    if (!svg) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      if (panoramaData.length === 0) return;
      const rect = svg.getBoundingClientRect();
      const scaleX = panoramaSvgW / rect.width;
      const mx = (e.clientX - rect.left) * scaleX - panoramaMargin.left;
      const frac = Math.max(0, Math.min(1, mx / panoramaChartW));

      const [azMin, azMax] = panoramaAzRange;
      const azSpan = azMax - azMin;
      const azAtCursor = azMin + frac * azSpan;

      const zoomFactor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      const newSpan = Math.min(360, Math.max(1, azSpan * zoomFactor));

      let newMin = azAtCursor - frac * newSpan;
      let newMax = azAtCursor + (1 - frac) * newSpan;

      if (newMin < 0) { newMax -= newMin; newMin = 0; }
      if (newMax > 360) { newMin -= (newMax - 360); newMax = 360; }
      newMin = Math.max(0, newMin);
      newMax = Math.min(360, newMax);

      setPanoramaAzRange([newMin, newMax]);
    };
    svg.addEventListener("wheel", handler, { passive: false });
    return () => svg.removeEventListener("wheel", handler);
  }, [panoramaData.length, panoramaChartW, panoramaMargin.left, panoramaAzRange]);

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">LoS 장애물</h1>
          <p className="mt-1 text-sm text-gray-500">
            360° 파노라마 기반 전파 장애물 분석
            {panoramaData.length > 0 && (
              <span className="ml-2 text-xs text-gray-400">
                0.01° ({panoramaData.length.toLocaleString()}점)
              </span>
            )}
            {panoramaBuildingPoints.length > 0 && (
              <span className="ml-1 text-xs text-gray-500">
                · 건물 {panoramaBuildingPoints.length}개
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* 레이더 선택 */}
          <div className="relative">
            <button
              onClick={() => setRadarDropOpen(!radarDropOpen)}
              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                radarDropOpen
                  ? "border-[#a60739] bg-[#a60739]/10 text-[#a60739]"
                  : "border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300"
              }`}
            >
              <Radar size={13} />
              <span className="max-w-[120px] truncate font-medium">{radarSite.name}</span>
              <ChevronDown size={12} className={`transition-transform ${radarDropOpen ? "rotate-180" : ""}`} />
            </button>
            {radarDropOpen && (
              <div className="absolute right-0 top-full z-[2000] mt-1 w-56 rounded-lg border border-gray-200 bg-white/95 shadow-xl backdrop-blur-sm">
                <div className="max-h-56 overflow-y-auto py-1 px-1">
                  {customRadarSites.map((site: RadarSite) => (
                    <button
                      key={site.name}
                      onClick={() => { setRadarSite(site); setRadarDropOpen(false); }}
                      className={`w-full px-3 py-1.5 text-left text-xs rounded transition-colors ${
                        radarSite.name === site.name
                          ? "bg-[#a60739] text-white"
                          : "text-gray-600 hover:bg-gray-100"
                      }`}
                    >
                      <div className="font-medium">{site.name}</div>
                      <div className={`text-[10px] ${radarSite.name === site.name ? "text-white/60" : "text-gray-400"}`}>
                        {site.range_nm}NM
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          {/* 갱신 */}
          <button
            onClick={() => {
              invoke("clear_panorama_cache", {
                radarLat: radarSite.latitude,
                radarLon: radarSite.longitude,
              }).catch(() => {});
              setPanoramaData([]);
              setPanoramaPeakNames(new Map());
              triggerPanorama();
            }}
            disabled={panoramaLoading}
            className="flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-600 hover:border-gray-300 disabled:opacity-40"
          >
            <RefreshCw size={13} className={panoramaLoading ? "animate-spin" : ""} />
            갱신
          </button>
        </div>
      </div>

      {panoramaLoading ? (
        <SimpleCard>
          <div className="flex items-center justify-center gap-3 py-16 text-sm text-gray-500">
            <Loader2 className="h-5 w-5 animate-spin" />
            파노라마 계산 중... (지형 + 건물 스캔)
          </div>
        </SimpleCard>
      ) : panoramaData.length === 0 ? (
        <SimpleCard>
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-sm text-gray-500">
            <Eye className="h-8 w-8 text-gray-300" />
            <p>SRTM 지형 데이터가 필요합니다.</p>
            <p className="text-xs">설정에서 SRTM 타일을 다운로드하세요.</p>
          </div>
        </SimpleCard>
      ) : (
        <>
          {/* 파노라마 차트 + 건물 지도 통합 카드 */}
          <SimpleCard className="flex min-h-0 flex-1 flex-col p-0">
            <div className="shrink-0 px-4 py-2">
              <svg
                ref={panoramaSvgRef}
                viewBox={`0 0 ${panoramaSvgW} ${panoramaSvgH}`}
                className="w-full cursor-crosshair"
                onMouseMove={handlePanoramaMouseMove}
                onMouseLeave={() => setPanoramaHoverIdx(null)}
                onClick={handlePanoramaClick}
              >
                {/* 배경 */}
                <rect x={0} y={0} width={panoramaSvgW} height={panoramaSvgH} fill="#fafafa" rx={4} />

                {/* 차트 영역 클리핑 */}
                <defs>
                  <clipPath id="panorama-clip">
                    <rect x={panoramaMargin.left} y={panoramaMargin.top} width={panoramaChartW} height={panoramaChartH} />
                  </clipPath>
                </defs>

                {/* Y축 그리드 */}
                {(() => {
                  const range = panoramaMaxAngle - panoramaMinAngle;
                  const step = range > 2 ? 0.5 : range > 1 ? 0.2 : 0.1;
                  const lines: React.JSX.Element[] = [];
                  for (let v = Math.ceil(panoramaMinAngle / step) * step; v <= panoramaMaxAngle; v += step) {
                    const y = panoramaMargin.top + panoramaChartH * (1 - (v - panoramaMinAngle) / (panoramaMaxAngle - panoramaMinAngle));
                    lines.push(
                      <g key={`ygrid-${v.toFixed(2)}`}>
                        <line x1={panoramaMargin.left} y1={y} x2={panoramaMargin.left + panoramaChartW} y2={y}
                          stroke={Math.abs(v) < 0.001 ? "#9ca3af" : "#e5e7eb"} strokeWidth={Math.abs(v) < 0.001 ? 1 : 0.5}
                          strokeDasharray={Math.abs(v) < 0.001 ? undefined : "3,3"} />
                        <text x={panoramaMargin.left - 6} y={y + 3} textAnchor="end" fill="#6b7280" fontSize={10}>
                          {v.toFixed(1)}°
                        </text>
                      </g>
                    );
                  }
                  return lines;
                })()}

                {/* X축 방위 그리드 */}
                {(() => {
                  const [azMin, azMax] = panoramaAzRange;
                  const azSpan = azMax - azMin;
                  const step = azSpan > 300 ? 30 : azSpan > 120 ? 15 : azSpan > 60 ? 10 : azSpan > 30 ? 5 : azSpan > 15 ? 2 : 1;
                  const labels: Record<number, string> = { 0: "N", 90: "E", 180: "S", 270: "W", 360: "N" };
                  const grids: React.JSX.Element[] = [];
                  const startAz = Math.ceil(azMin / step) * step;
                  for (let az = startAz; az <= azMax; az += step) {
                    const x = azToX(az);
                    const isCardinal = az % 90 === 0;
                    grids.push(
                      <g key={`xgrid-${az}`}>
                        <line x1={x} y1={panoramaMargin.top} x2={x} y2={panoramaMargin.top + panoramaChartH}
                          stroke={isCardinal ? "#d1d5db" : "#e5e7eb"} strokeWidth={isCardinal ? 0.8 : 0.5}
                          strokeDasharray={isCardinal ? undefined : "2,4"} />
                        <text x={x} y={panoramaMargin.top + panoramaChartH + 16} textAnchor="middle"
                          fill={isCardinal ? "#374151" : "#9ca3af"} fontSize={isCardinal ? 11 : 9} fontWeight={isCardinal ? 600 : 400}>
                          {labels[az] ?? `${az}°`}
                        </text>
                      </g>
                    );
                  }
                  return grids;
                })()}

                {/* 지형/건물 면 채우기 */}
                <g clipPath="url(#panorama-clip)">
                  {/* 지형 영역 (녹색 면) */}
                  <path
                    d={(() => {
                      const { startIdx, endIdx } = panoramaVisibleRange;
                      const yBase = panoramaMargin.top + panoramaChartH;
                      const toY = (angle: number) => panoramaMargin.top + panoramaChartH * (1 - (angle - panoramaMinAngle) / (panoramaMaxAngle - panoramaMinAngle));
                      let d = `M ${panoramaMargin.left} ${yBase}`;
                      for (let i = startIdx; i <= endIdx; i++) {
                        const x = idxToX(i);
                        const pt = panoramaData[i];
                        const terrainAngle = pt.obstacle_type === "terrain"
                          ? pt.elevation_angle_deg
                          : Math.max(0, pt.elevation_angle_deg - (pt.obstacle_height_m / (pt.distance_km * 1000)) * (180 / Math.PI));
                        d += ` L ${x} ${toY(Math.max(terrainAngle, panoramaMinAngle))}`;
                      }
                      d += ` L ${panoramaMargin.left + panoramaChartW} ${yBase} Z`;
                      return d;
                    })()}
                    fill="#22c55e"
                    fillOpacity={0.2}
                  />

                  {/* 지형 실루엣 라인 */}
                  <path
                    d={(() => {
                      const { startIdx, endIdx } = panoramaVisibleRange;
                      const toY = (angle: number) => panoramaMargin.top + panoramaChartH * (1 - (angle - panoramaMinAngle) / (panoramaMaxAngle - panoramaMinAngle));
                      let d = "";
                      for (let i = startIdx; i <= endIdx; i++) {
                        const x = idxToX(i);
                        const pt = panoramaData[i];
                        const terrainAngle = pt.obstacle_type === "terrain"
                          ? pt.elevation_angle_deg
                          : Math.max(0, pt.elevation_angle_deg - (pt.obstacle_height_m / (pt.distance_km * 1000)) * (180 / Math.PI));
                        const y = toY(Math.max(terrainAngle, panoramaMinAngle));
                        d += i === startIdx ? `M ${x} ${y}` : ` L ${x} ${y}`;
                      }
                      return d;
                    })()}
                    fill="none"
                    stroke="#16a34a"
                    strokeWidth={1.2}
                  />

                  {/* 건물통합정보 세로선 */}
                  {panoramaBuildingPaths.gis && (
                    <path d={panoramaBuildingPaths.gis}
                      fill="none" stroke="#f97316" strokeWidth={2} strokeOpacity={0.7} />
                  )}

                  {/* 수동 건물 세로선 */}
                  {panoramaBuildingPaths.manual && (
                    <path d={panoramaBuildingPaths.manual}
                      fill="none" stroke="#ef4444" strokeWidth={2} strokeOpacity={0.7} />
                  )}

                  {/* 전체 실루엣 (건물 포함) */}
                  <path
                    d={(() => {
                      const { startIdx, endIdx } = panoramaVisibleRange;
                      const toY = (angle: number) => panoramaMargin.top + panoramaChartH * (1 - (angle - panoramaMinAngle) / (panoramaMaxAngle - panoramaMinAngle));
                      let d = "";
                      for (let i = startIdx; i <= endIdx; i++) {
                        const x = idxToX(i);
                        const y = toY(panoramaData[i].elevation_angle_deg);
                        d += i === startIdx ? `M ${x} ${y}` : ` L ${x} ${y}`;
                      }
                      return d;
                    })()}
                    fill="none"
                    stroke="#374151"
                    strokeWidth={0.8}
                    strokeOpacity={0.5}
                  />
                </g>

                {/* 호버/핀 크로스헤어 */}
                {panoramaActiveIdx !== null && (
                  <g>
                    {(() => {
                      const pt = panoramaData[panoramaActiveIdx];
                      const x = idxToX(panoramaActiveIdx);
                      const y = panoramaMargin.top + panoramaChartH * (1 - (pt.elevation_angle_deg - panoramaMinAngle) / (panoramaMaxAngle - panoramaMinAngle));
                      const isPinned = panoramaPinnedIdx === panoramaActiveIdx;
                      const peakName = pt.obstacle_type === "terrain" ? panoramaPeakNames.get(panoramaActiveIdx) : null;
                      const labelName = pt.name || peakName || null;
                      const line1 = `${pt.azimuth_deg.toFixed(1)}° / ${pt.elevation_angle_deg.toFixed(3)}°`;
                      const line2Parts: string[] = [];
                      if (labelName) line2Parts.push(labelName);
                      line2Parts.push(`${pt.distance_km.toFixed(1)}km`);
                      if (pt.obstacle_type === "terrain") {
                        line2Parts.push(`${Math.round(pt.obstacle_height_m)}m`);
                      } else {
                        line2Parts.push(`${Math.round(pt.obstacle_height_m)}m(건물)`);
                      }
                      const line2 = line2Parts.join(" · ");
                      const tooltipW = Math.max(90, Math.max(line1.length, line2.length) * 6.5 + 16);
                      const tooltipH = 30;
                      const tooltipX = x + tooltipW + 12 > panoramaSvgW ? x - tooltipW - 8 : x + 8;
                      return (
                        <>
                          <line x1={x} y1={panoramaMargin.top} x2={x} y2={panoramaMargin.top + panoramaChartH}
                            stroke={isPinned ? "#eab308" : "#6b7280"} strokeWidth={1} strokeDasharray="3,3" />
                          <line x1={panoramaMargin.left} y1={y} x2={panoramaMargin.left + panoramaChartW} y2={y}
                            stroke={isPinned ? "#eab308" : "#6b7280"} strokeWidth={0.5} strokeDasharray="3,3" />
                          <circle cx={x} cy={y} r={4}
                            fill={pt.obstacle_type !== "terrain" ? "#f97316" : "#22c55e"}
                            stroke={isPinned ? "#eab308" : "#fff"} strokeWidth={2} />
                          {/* 상세 툴팁 */}
                          <rect x={tooltipX} y={panoramaMargin.top - 2} width={tooltipW} height={tooltipH} rx={3}
                            fill="rgba(0,0,0,0.8)" />
                          <text x={tooltipX + 6} y={panoramaMargin.top + 10} fill="white" fontSize={10}>
                            {line1}
                          </text>
                          <text x={tooltipX + 6} y={panoramaMargin.top + 22} fill="#d1d5db" fontSize={9}>
                            {line2}
                          </text>
                        </>
                      );
                    })()}
                  </g>
                )}

                {/* 이름 있는 산 마커 */}
                {(() => {
                  const shown = new Map<string, number>();
                  for (const [idx, name] of panoramaPeakNames.entries()) {
                    if (idx >= panoramaData.length) continue;
                    const pt = panoramaData[idx];
                    if (pt.obstacle_type !== "terrain") continue;
                    const prev = shown.get(name);
                    if (prev === undefined || pt.elevation_angle_deg > panoramaData[prev].elevation_angle_deg) {
                      shown.set(name, idx);
                    }
                  }
                  return Array.from(shown.entries()).map(([name, idx]) => {
                    const { startIdx: visStart, endIdx: visEnd } = panoramaVisibleRange;
                    if (idx < visStart || idx > visEnd) return null;
                    const pt = panoramaData[idx];
                    const px = idxToX(idx);
                    const py = panoramaMargin.top + panoramaChartH * (1 - (pt.elevation_angle_deg - panoramaMinAngle) / (panoramaMaxAngle - panoramaMinAngle));
                    return (
                      <g key={`peak-${idx}`}>
                        <circle cx={px} cy={py} r={2.5} fill="#f59e0b" stroke="#fff" strokeWidth={0.5} />
                        <text x={px} y={py - 6} textAnchor="middle" fill="#92400e" fontSize={8} fontWeight="bold">
                          {name}
                        </text>
                      </g>
                    );
                  });
                })()}

                {/* 축 라벨 */}
                <text x={panoramaSvgW / 2} y={panoramaSvgH - 4} textAnchor="middle" fill="#6b7280" fontSize={11}>
                  방위 (°)
                </text>
                <text x={14} y={panoramaMargin.top + panoramaChartH / 2} textAnchor="middle" fill="#6b7280" fontSize={11}
                  transform={`rotate(-90, 14, ${panoramaMargin.top + panoramaChartH / 2})`}>
                  앙각 (°)
                </text>

                {/* 범례 */}
                <g transform={`translate(${panoramaMargin.left + 10}, ${panoramaMargin.top + 8})`}>
                  <rect x={0} y={0} width={8} height={8} fill="#22c55e" fillOpacity={0.5} rx={1} />
                  <text x={12} y={8} fill="#374151" fontSize={9}>지형</text>
                  <rect x={50} y={0} width={8} height={8} fill="#f97316" fillOpacity={0.7} rx={1} />
                  <text x={62} y={8} fill="#374151" fontSize={9}>건물통합정보</text>
                  <rect x={115} y={0} width={8} height={8} fill="#ef4444" fillOpacity={0.7} rx={1} />
                  <text x={127} y={8} fill="#374151" fontSize={9}>수동 건물</text>
                </g>
              </svg>
            </div>

            {/* 건물 위치 지도 */}
            <div className="min-h-0 flex-1 border-t border-gray-200">
              <MapGL
                ref={panoramaMapRef}
                initialViewState={{
                  latitude: radarSite.latitude,
                  longitude: radarSite.longitude,
                  zoom: 10,
                }}
                style={{ width: "100%", height: "100%" }}
                mapStyle="https://basemaps.cartocdn.com/gl/positron-gl-style/style.json"
              >
                <NavigationControl position="top-right" />
                <DeckGLOverlay
                  layers={[
                    new LineLayer({
                      id: "panorama-bldg-lines",
                      data: panoramaBuildingPoints,
                      getSourcePosition: () => [radarSite.longitude, radarSite.latitude],
                      getTargetPosition: (d: PanoramaPoint) => [d.lon, d.lat],
                      getColor: [100, 100, 100, 40],
                      getWidth: 1,
                    }),
                    new ScatterplotLayer({
                      id: "panorama-bldg-dots",
                      data: panoramaBuildingPoints,
                      getPosition: (d: PanoramaPoint) => [d.lon, d.lat],
                      getRadius: 5,
                      radiusUnits: "pixels" as const,
                      getFillColor: (d: PanoramaPoint) =>
                        d.obstacle_type === "manual_building" ? [239, 68, 68, 180] : [249, 115, 22, 180],
                      getLineColor: [255, 255, 255, 200],
                      lineWidthMinPixels: 1,
                      stroked: true,
                      pickable: true,
                      onHover: (info: { object?: PanoramaPoint }) => {
                        if (panoramaPinnedIdx !== null) return;
                        if (!info.object) {
                          setPanoramaHoverIdx(null);
                          return;
                        }
                        const hovered = info.object;
                        let bestIdx = -1;
                        let bestDist = Infinity;
                        for (let i = 0; i < panoramaData.length; i++) {
                          const pt = panoramaData[i];
                          if (pt.obstacle_type === "terrain") continue;
                          const dlat = pt.lat - hovered.lat;
                          const dlon = pt.lon - hovered.lon;
                          const dist = dlat * dlat + dlon * dlon;
                          if (dist < bestDist) {
                            bestDist = dist;
                            bestIdx = i;
                          }
                        }
                        if (bestIdx >= 0) {
                          setPanoramaHoverIdx(bestIdx);
                        }
                      },
                      onClick: (info: { object?: PanoramaPoint }) => {
                        if (!info.object) return;
                        const clicked = info.object;
                        let bestIdx = -1;
                        let bestDist = Infinity;
                        for (let i = 0; i < panoramaData.length; i++) {
                          const pt = panoramaData[i];
                          if (pt.obstacle_type === "terrain") continue;
                          const dlat = pt.lat - clicked.lat;
                          const dlon = pt.lon - clicked.lon;
                          const dist = dlat * dlat + dlon * dlon;
                          if (dist < bestDist) {
                            bestDist = dist;
                            bestIdx = i;
                          }
                        }
                        if (bestIdx >= 0) {
                          setPanoramaPinnedIdx((prev) => (prev === bestIdx ? null : bestIdx));
                          setPanoramaHoverIdx(bestIdx);
                        }
                      },
                    }),
                    ...(panoramaActivePoint
                      ? [
                          new ScatterplotLayer({
                            id: "panorama-bldg-highlight",
                            data: [panoramaActivePoint],
                            getPosition: (d: PanoramaPoint) => [d.lon, d.lat],
                            getFillColor: panoramaActivePoint.obstacle_type === "terrain"
                              ? [34, 197, 94, 220] : [239, 68, 68, 240],
                            getLineColor: [255, 255, 255, 255],
                            getRadius: 7,
                            radiusUnits: "pixels" as const,
                            stroked: true,
                            lineWidthMinPixels: 2,
                          }),
                          ...(panoramaActivePoint.obstacle_type === "terrain"
                            ? [
                                new LineLayer({
                                  id: "panorama-terrain-line",
                                  data: [panoramaActivePoint],
                                  getSourcePosition: () => [radarSite.longitude, radarSite.latitude],
                                  getTargetPosition: (d: PanoramaPoint) => [d.lon, d.lat],
                                  getColor: [34, 197, 94, 120],
                                  getWidth: 2,
                                }),
                              ]
                            : []),
                        ]
                      : []),
                    // 레이더 위치
                    new ScatterplotLayer({
                      id: "panorama-radar-dot",
                      data: [radarSite],
                      getPosition: (d: typeof radarSite) => [d.longitude, d.latitude],
                      getFillColor: [14, 165, 233, 220],
                      getLineColor: [255, 255, 255, 255],
                      getRadius: 200,
                      stroked: true,
                      lineWidthMinPixels: 2,
                      radiusMinPixels: 8,
                      radiusMaxPixels: 12,
                    }),
                  ]}
                />
              </MapGL>
            </div>
          </SimpleCard>
        </>
      )}
    </div>
  );
}
