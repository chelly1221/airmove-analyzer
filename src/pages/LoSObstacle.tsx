import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import MapGL, { NavigationControl, type MapRef } from "react-map-gl/maplibre";
import maplibregl from "maplibre-gl";
import { ScatterplotLayer, LineLayer } from "@deck.gl/layers";
import { DeckGLOverlay } from "../components/Map/DeckGLOverlay";
import { invoke } from "@tauri-apps/api/core";
import { Eye, Loader2, Radar, ChevronDown, RefreshCw } from "lucide-react";
import { SimpleCard } from "../components/common/Card";
import { useToastStore } from "../components/common/Toast";
import { useAppStore } from "../store";
import type { PanoramaPoint, BuildingObstacle, PanoramaMergeResult, NearbyPeak, RadarSite } from "../types";
import { haversineKm } from "../utils/geo";

export default function LoSObstacle() {
  const radarSite = useAppStore((s) => s.radarSite);
  const setRadarSite = useAppStore((s) => s.setRadarSite);
  const customRadarSites = useAppStore((s) => s.customRadarSites);
  const setPanoramaViewActive = useAppStore((s) => s.setPanoramaViewActive);
  const setPanoramaActivePointStore = useAppStore((s) => s.setPanoramaActivePoint);
  const setPanoramaPinnedStore = useAppStore((s) => s.setPanoramaPinned);

  // ── LoS 파노라마 상태 ──
  const [panoramaData, setPanoramaData] = useState<PanoramaPoint[]>([]);
  const [buildingObstacles, setBuildingObstacles] = useState<BuildingObstacle[]>([]);
  const [panoramaLoading, setPanoramaLoading] = useState(false);
  const [panoramaProgress, setPanoramaProgress] = useState({ percent: 0, label: "" });
  const [panoramaHoverIdx, setPanoramaHoverIdx] = useState<number | null>(null);
  const [panoramaPinnedIdx, setPanoramaPinnedIdx] = useState<number | null>(null);
  // 건물 hover/pin (별도 인덱스)
  const [bldgHoverIdx, setBldgHoverIdx] = useState<number | null>(null);
  const [bldgPinnedIdx, setBldgPinnedIdx] = useState<number | null>(null);
  const panoramaSvgRef = useRef<SVGSVGElement>(null);
  const [panoramaPeakNames, setPanoramaPeakNames] = useState<Map<number, string>>(new Map());
  const [panoramaAzRange, setPanoramaAzRange] = useState<[number, number]>([0, 360]);
  const [radarDropOpen, setRadarDropOpen] = useState(false);

  // 파노라마 뷰 활성 상태를 스토어에 동기화
  useEffect(() => {
    setPanoramaViewActive(true);
    return () => setPanoramaViewActive(false);
  }, [setPanoramaViewActive]);

  // 산 이름 조회 (파노라마 데이터에서 로컬 최대값 → DB 쿼리)
  const fetchPeakNames = useCallback(async (terrain: PanoramaPoint[]): Promise<Map<number, string>> => {
    const names = new Map<number, string>();
    const terrainPeaks: { idx: number; lat: number; lon: number; angle: number }[] = [];
    for (let i = 0; i < terrain.length; i++) {
      const pt = terrain[i];
      if (pt.elevation_angle_deg <= 0.01) continue;
      let isLocalMax = true;
      for (let d = 1; d <= 5; d++) {
        const li = (i - d + terrain.length) % terrain.length;
        const ri = (i + d) % terrain.length;
        if (terrain[li].elevation_angle_deg > pt.elevation_angle_deg ||
            terrain[ri].elevation_angle_deg > pt.elevation_angle_deg) {
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
    for (const target of terrainPeaks.slice(0, 15)) {
      try {
        const peaks = await invoke<NearbyPeak[]>("query_nearby_peaks", {
          lat: target.lat, lon: target.lon, radiusKm: 3.0,
        });
        if (peaks.length > 0) {
          names.set(target.idx, peaks[0].name);
          for (let d = 1; d <= 10; d++) {
            for (const dir of [-1, 1]) {
              const adj = (target.idx + dir * d + terrain.length) % terrain.length;
              const adjPt = terrain[adj];
              if (haversineKm(adjPt.lat, adjPt.lon, target.lat, target.lon) < 3) {
                names.set(adj, peaks[0].name);
              } else break;
            }
          }
        }
      } catch { /* skip */ }
    }
    return names;
  }, []);

  // 파노라마 계산 함수 (GPU 우선, CPU 폴백, DB 저장 포함)
  const computePanorama = useCallback(async () => {
    setPanoramaLoading(true);
    setPanoramaProgress({ percent: 0, label: "초기화 중..." });
    setPanoramaPinnedIdx(null);
    setPanoramaHoverIdx(null);
    setBldgPinnedIdx(null);
    setBldgHoverIdx(null);
    setPanoramaAzRange([0, 360]);
    const radarH = radarSite.altitude + radarSite.antenna_height;
    const azStep = 0.01;
    const rangeStep = 200.0;
    const maxRange = 100.0;

    try {
      setPanoramaProgress({ percent: 5, label: "GPU 모듈 로드 중..." });
      const { computePanoramaTerrainGPU } = await import("../utils/gpuPanorama");

      setPanoramaProgress({ percent: 10, label: "SRTM Heightmap 생성 중..." });
      const terrainResults = await computePanoramaTerrainGPU(
        radarSite.latitude, radarSite.longitude, radarH,
        maxRange, azStep, rangeStep,
        (phase) => {
          if (phase === "heightmap_done") setPanoramaProgress({ percent: 30, label: "GPU 지형 스캔 중 (36,000 레이)..." });
          else if (phase === "gpu_done") setPanoramaProgress({ percent: 50, label: "지형 결과 변환 중..." });
        },
      );

      setPanoramaProgress({ percent: 55, label: `건물 장애물 스캔 중...` });
      const result = await invoke<PanoramaMergeResult>("panorama_merge_buildings", {
        radarLat: radarSite.latitude,
        radarLon: radarSite.longitude,
        radarHeightM: radarH,
        maxRangeKm: maxRange,
        azimuthStepDeg: azStep,
        terrainResults,
      });

      setPanoramaProgress({ percent: 70, label: `산 이름 조회 중...` });
      const peakNames = await fetchPeakNames(result.terrain);

      setPanoramaProgress({ percent: 85, label: `건물 3D 데이터 준비 중 (${result.buildings.length}개)...` });
      // state 일괄 업데이트 (React batch)
      setPanoramaData(result.terrain);
      setBuildingObstacles(result.buildings);
      setPanoramaPeakNames(peakNames);

      setPanoramaProgress({ percent: 95, label: "캐시 저장 중..." });
      await invoke("save_panorama_cache", {
        radarLat: radarSite.latitude,
        radarLon: radarSite.longitude,
        radarHeightM: radarH,
        dataJson: JSON.stringify(result),
      }).catch((e) => console.error("파노라마 캐시 저장 실패:", e));

      setPanoramaProgress({ percent: 100, label: "완료" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("파노라마 계산 실패:", e);
      useToastStore.getState().addToast(`파노라마 GPU 계산 실패: ${msg}`, "error");
    }
  }, [radarSite, fetchPeakNames]);

  const triggerPanorama = useCallback(() => {
    computePanorama().finally(() => setPanoramaLoading(false));
  }, [computePanorama]);

  // 마운트 시 DB 캐시 로드 또는 계산 (수동 갱신 중이면 skip)
  useEffect(() => {
    if (panoramaData.length > 0 || panoramaLoading) return;
    let cancelled = false;
    setPanoramaLoading(true);
    setPanoramaProgress({ percent: 5, label: "캐시 확인 중..." });
    (async () => {
      try {
        const cached = await invoke<string | null>("load_panorama_cache", {
          radarLat: radarSite.latitude,
          radarLon: radarSite.longitude,
        });
        if (cancelled) return;
        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.terrain) && parsed.terrain.length > 0) {
              setPanoramaProgress({ percent: 40, label: "캐시 로드 완료 · 산 이름 조회 중..." });
              const peakNames = await fetchPeakNames(parsed.terrain);
              if (cancelled) return;
              setPanoramaProgress({ percent: 85, label: "건물 3D 데이터 준비 중..." });
              setPanoramaData(parsed.terrain);
              setBuildingObstacles(parsed.buildings ?? []);
              setPanoramaPeakNames(peakNames);
              setPanoramaProgress({ percent: 100, label: "완료" });
              setPanoramaLoading(false);
              return;
            }
          } catch { /* 파싱 실패 시 재계산 */ }
        }
        if (!cancelled) triggerPanorama();
      } catch {
        if (!cancelled) triggerPanorama();
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [radarSite, panoramaData.length, triggerPanorama, fetchPeakNames]);

  // 레이더 변경 시 파노라마 데이터 초기화
  const prevRadarRef = useRef(radarSite.name);
  useEffect(() => {
    if (prevRadarRef.current !== radarSite.name) {
      prevRadarRef.current = radarSite.name;
      setPanoramaData([]);
      setBuildingObstacles([]);
      setPanoramaPinnedIdx(null);
      setPanoramaHoverIdx(null);
      setBldgPinnedIdx(null);
      setBldgHoverIdx(null);
      setPanoramaPeakNames(new Map());
    }
  }, [radarSite.name]);

  // 캐시 로드 시 산 이름 조회 (computePanorama 경로에서는 이미 통합됨)
  useEffect(() => {
    if (panoramaData.length === 0 || panoramaPeakNames.size > 0) return;
    let cancelled = false;

    const terrainPeaks: { idx: number; lat: number; lon: number; angle: number }[] = [];
    for (let i = 0; i < panoramaData.length; i++) {
      const pt = panoramaData[i];
      if (pt.elevation_angle_deg <= 0.01) continue;
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

  // 건물 목록 (buildingObstacles 직접 사용)
  const panoramaBuildingPoints = buildingObstacles;

  const panoramaMapRef = useRef<MapRef>(null);

  // 건물 3D GeoJSON 변환 (폴리곤 있는 건물만)
  const bldg3dGeoJSON = useMemo((): GeoJSON.FeatureCollection | null => {
    const withPoly = panoramaBuildingPoints.filter((p) => p.polygon && p.polygon.length >= 3);
    if (withPoly.length === 0) return null;
    const features: GeoJSON.Feature[] = [];
    for (const p of withPoly) {
      const coords = p.polygon!.map(([lat, lon]) => [lon, lat]);
      const first = coords[0];
      const last = coords[coords.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) coords.push([...first]);
      features.push({
        type: "Feature",
        properties: {
          height: p.height_m,
          lat: p.lat,
          lon: p.lon,
          obstacle_type: p.obstacle_type,
          name: p.name || "",
        },
        geometry: { type: "Polygon", coordinates: [coords] },
      });
    }
    return { type: "FeatureCollection", features };
  }, [panoramaBuildingPoints]);

  // 폴리곤 없는 건물 (ScatterplotLayer 폴백)
  const bldgNoPoly = useMemo(
    () => panoramaBuildingPoints.filter((p) => !p.polygon || p.polygon.length < 3),
    [panoramaBuildingPoints],
  );

  // MapLibre fill-extrusion 레이어 동기화
  useEffect(() => {
    const map = panoramaMapRef.current?.getMap();
    if (!map || !map.isStyleLoaded()) return;

    const sourceId = "panorama-bldg-3d-src";
    const layerId = "panorama-bldg-3d-fill";

    if (bldg3dGeoJSON) {
      const source = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
      if (source) {
        source.setData(bldg3dGeoJSON);
      } else {
        map.addSource(sourceId, { type: "geojson", data: bldg3dGeoJSON });
        map.addLayer({
          id: layerId,
          type: "fill-extrusion",
          source: sourceId,
          paint: {
            "fill-extrusion-color": [
              "case",
              ["==", ["get", "obstacle_type"], "manual_building"],
              "#ef4444",
              "#f97316",
            ],
            "fill-extrusion-height": ["get", "height"],
            "fill-extrusion-base": 0,
            "fill-extrusion-opacity": 0.85,
          },
        });
      }
    } else {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    }
  }, [bldg3dGeoJSON]);

  // fill-extrusion 호버/클릭 이벤트
  useEffect(() => {
    const map = panoramaMapRef.current?.getMap();
    if (!map) return;
    const layerId = "panorama-bldg-3d-fill";

    const findBldgIdx = (lat: number, lon: number): number => {
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < buildingObstacles.length; i++) {
        const b = buildingObstacles[i];
        const dlat = b.lat - lat;
        const dlon = b.lon - lon;
        const dist = dlat * dlat + dlon * dlon;
        if (dist < bestDist) { bestDist = dist; bestIdx = i; }
      }
      return bestIdx;
    };

    const onMouseMove = (e: maplibregl.MapMouseEvent) => {
      if (!map.getLayer(layerId)) return;
      if (bldgPinnedIdx !== null) return;
      const features = map.queryRenderedFeatures(e.point, { layers: [layerId] });
      if (features.length === 0) {
        map.getCanvas().style.cursor = "";
        setBldgHoverIdx(null);
        return;
      }
      map.getCanvas().style.cursor = "pointer";
      const props = features[0].properties;
      const idx = findBldgIdx(props.lat, props.lon);
      if (idx >= 0) setBldgHoverIdx(idx);
    };

    const onClick = (e: maplibregl.MapMouseEvent) => {
      if (!map.getLayer(layerId)) return;
      const features = map.queryRenderedFeatures(e.point, { layers: [layerId] });
      if (features.length === 0) return;
      const props = features[0].properties;
      const idx = findBldgIdx(props.lat, props.lon);
      if (idx >= 0) {
        setBldgPinnedIdx((prev) => (prev === idx ? null : idx));
        setBldgHoverIdx(idx);
      }
    };

    map.on("mousemove", onMouseMove);
    map.on("click", onClick);
    return () => {
      map.off("mousemove", onMouseMove);
      map.off("click", onClick);
    };
  }, [buildingObstacles, bldgPinnedIdx]);

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
  // 활성 건물 (별도 인덱스)
  const activeBldgIdx = bldgPinnedIdx ?? bldgHoverIdx;
  const activeBldg = activeBldgIdx !== null ? buildingObstacles[activeBldgIdx] : null;
  // 통합 활성 포인트 (건물 우선)
  const activeItem: (PanoramaPoint | BuildingObstacle | null) = activeBldg ?? panoramaActivePoint;

  // 활성 건물 하이라이트 fill-extrusion
  useEffect(() => {
    const map = panoramaMapRef.current?.getMap();
    if (!map || !map.isStyleLoaded()) return;

    const hlSourceId = "panorama-bldg-hl-src";
    const hlLayerId = "panorama-bldg-hl-fill";

    if (map.getLayer(hlLayerId)) map.removeLayer(hlLayerId);
    if (map.getSource(hlSourceId)) map.removeSource(hlSourceId);

    if (!activeBldg || !activeBldg.polygon || activeBldg.polygon.length < 3) return;

    const coords = activeBldg.polygon.map(([lat, lon]) => [lon, lat]);
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) coords.push([...first]);

    const geojson: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: { height: activeBldg.height_m },
        geometry: { type: "Polygon", coordinates: [coords] },
      }],
    };

    map.addSource(hlSourceId, { type: "geojson", data: geojson });
    map.addLayer({
      id: hlLayerId,
      type: "fill-extrusion",
      source: hlSourceId,
      paint: {
        "fill-extrusion-color": activeBldg.obstacle_type === "manual_building" ? "#ef4444" : "#f97316",
        "fill-extrusion-height": ["get", "height"],
        "fill-extrusion-base": 0,
        "fill-extrusion-opacity": 1.0,
      },
    });
  }, [activeBldg]);

  // 활성 포인트 pin 마커 (원+막대)
  const pinMarkerRef = useRef<maplibregl.Marker | null>(null);
  useEffect(() => {
    const map = panoramaMapRef.current?.getMap();
    if (!map) { pinMarkerRef.current?.remove(); pinMarkerRef.current = null; return; }

    if (!activeItem) {
      pinMarkerRef.current?.remove();
      pinMarkerRef.current = null;
      return;
    }

    const isBuilding = activeItem.obstacle_type !== "terrain";
    const color = isBuilding
      ? (activeItem.obstacle_type === "manual_building" ? "#ef4444" : "#f97316")
      : "#22c55e";

    const el = document.createElement("div");
    el.style.cssText = "display:flex;flex-direction:column;align-items:center;pointer-events:none;";
    el.innerHTML = `
      <div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);"></div>
      <div style="width:2px;height:12px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,0.3);"></div>
    `;

    pinMarkerRef.current?.remove();
    pinMarkerRef.current = new maplibregl.Marker({ element: el, anchor: "bottom" })
      .setLngLat([activeItem.lon, activeItem.lat])
      .addTo(map);

    return () => { pinMarkerRef.current?.remove(); pinMarkerRef.current = null; };
  }, [activeItem]);

  // 활성 포인트를 스토어에 동기화 (사이드바 표시용)
  useEffect(() => {
    if (activeBldg) {
      setPanoramaActivePointStore(activeBldg);
    } else if (panoramaActivePoint && panoramaActiveIdx !== null) {
      const peakName = panoramaPeakNames.get(panoramaActiveIdx);
      if (peakName) {
        setPanoramaActivePointStore({ ...panoramaActivePoint, name: peakName });
      } else {
        setPanoramaActivePointStore(panoramaActivePoint);
      }
    } else {
      setPanoramaActivePointStore(null);
    }
    setPanoramaPinnedStore(panoramaPinnedIdx !== null || bldgPinnedIdx !== null);
  }, [activeBldg, panoramaActivePoint, panoramaActiveIdx, panoramaPinnedIdx, bldgPinnedIdx, panoramaPeakNames, setPanoramaActivePointStore, setPanoramaPinnedStore]);

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
  // 건물 직사각형 (정확한 방위 범위 × 앙각, 지형 가림 처리)
  const panoramaBuildingRects = useMemo(() => {
    if (buildingObstacles.length === 0 || panoramaData.length === 0) return [];
    const [azMin, azMax] = panoramaAzRange;
    const n = panoramaData.length;
    const toY = (angle: number) => panoramaMargin.top + panoramaChartH * (1 - (angle - panoramaMinAngle) / (panoramaMaxAngle - panoramaMinAngle));
    const toX = (az: number) => panoramaMargin.left + ((az - azMin) / (azMax - azMin)) * panoramaChartW;

    // 방위 → 해당 지형 앙각 조회
    const terrainAngleAt = (azDeg: number): number => {
      const idx = Math.round((azDeg % 360) / 360 * (n - 1));
      const clamped = Math.max(0, Math.min(n - 1, idx));
      return panoramaData[clamped].elevation_angle_deg;
    };

    return buildingObstacles.map((b, idx) => {
      let start = b.azimuth_start_deg;
      let end = b.azimuth_end_deg;
      if (start === end) { start -= 0.02; end += 0.02; }
      if (end < start) end += 360;

      const midAz = ((start + end) / 2) % 360;
      const terrainAngle = terrainAngleAt(midAz);

      if (b.elevation_angle_deg <= terrainAngle) return null;

      if (end < azMin || start > azMax) return null;
      start = Math.max(start, azMin);
      end = Math.min(end, azMax);

      const x1 = toX(start);
      const x2 = toX(end);
      const w = Math.max(x2 - x1, 2);
      const yTop = toY(b.elevation_angle_deg);
      // 건물 지반고 앙각 (건물 전체 높이 표현)
      const groundAngleDeg = b.ground_elev_m > 0
        ? Math.atan2(b.ground_elev_m - (radarSite.altitude + radarSite.antenna_height), b.distance_km * 1000) * (180 / Math.PI)
        : panoramaMinAngle;
      const yBase = toY(Math.max(groundAngleDeg, panoramaMinAngle));
      // 지형이 건물을 가리는 높이 (녹색 오버레이용)
      const yTerrain = toY(Math.max(terrainAngle, panoramaMinAngle));

      return { idx, x: x1, w, yTop, yBase, yTerrain, type: b.obstacle_type };
    }).filter(Boolean) as { idx: number; x: number; w: number; yTop: number; yBase: number; yTerrain: number; type: string }[];
  }, [buildingObstacles, panoramaData, panoramaAzRange, panoramaMinAngle, panoramaMaxAngle, panoramaMargin, panoramaChartH, panoramaChartW]);

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
      e.stopPropagation();
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
  }, [panoramaData.length, panoramaLoading, panoramaChartW, panoramaMargin.left, panoramaAzRange]);

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden">
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
            onClick={async () => {
              await invoke("clear_panorama_cache", {
                radarLat: radarSite.latitude,
                radarLon: radarSite.longitude,
              }).catch(() => {});
              setPanoramaData([]);
              setBuildingObstacles([]);
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
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-sm text-gray-500">
            <Loader2 className="h-5 w-5 animate-spin" />
            <p>{panoramaProgress.label || "파노라마 계산 중..."}</p>
            <div className="w-64 h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-[#a60739] rounded-full transition-all duration-300 ease-out"
                style={{ width: `${panoramaProgress.percent}%` }}
              />
            </div>
            <p className="text-xs text-gray-400">{panoramaProgress.percent}%</p>
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
            <div className="shrink-0 px-4 py-2" style={{ overscrollBehavior: "contain" }}>
              <svg
                ref={panoramaSvgRef}
                viewBox={`0 0 ${panoramaSvgW} ${panoramaSvgH}`}
                className="w-full cursor-crosshair"
                style={{ touchAction: "none" }}
                onMouseMove={handlePanoramaMouseMove}
                onMouseLeave={() => setPanoramaHoverIdx(null)}
                onClick={handlePanoramaClick}
              >
                {/* 배경 */}
                <rect x={0} y={0} width={panoramaSvgW} height={panoramaSvgH} fill="#fafafa" rx={4} />

                {/* 차트 영역 클리핑 */}
                <defs>
                  <clipPath id="panorama-clip">
                    <rect x={panoramaMargin.left} y={panoramaMargin.top} width={panoramaChartW} height={
                      panoramaMinAngle < 0
                        ? panoramaChartH * (1 - (0 - panoramaMinAngle) / (panoramaMaxAngle - panoramaMinAngle))
                        : panoramaChartH
                    } />
                  </clipPath>
                </defs>

                {/* Y축 그리드 */}
                {(() => {
                  const range = panoramaMaxAngle - panoramaMinAngle;
                  const maxTicks = Math.max(3, Math.floor(panoramaChartH / 20));
                  const candidates = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20];
                  const step = candidates.find(s => range / s <= maxTicks) ?? candidates[candidates.length - 1];
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

                {/* 공간적 레이어 순서: 하늘(배경) → 지형(불투명) → 건물(지형 위 돌출) */}
                <g clipPath="url(#panorama-clip)">
                  {/* 하늘 배경 (연한 파랑) */}
                  <rect x={panoramaMargin.left} y={panoramaMargin.top}
                    width={panoramaChartW} height={panoramaChartH} fill="#e8f4f8" />

                  {/* 지형 영역 (불투명 녹색) — 하늘을 가림 */}
                  <path
                    d={(() => {
                      const { startIdx, endIdx } = panoramaVisibleRange;
                      const yBase = panoramaMargin.top + panoramaChartH;
                      const toY = (angle: number) => panoramaMargin.top + panoramaChartH * (1 - (angle - panoramaMinAngle) / (panoramaMaxAngle - panoramaMinAngle));
                      let d = `M ${panoramaMargin.left} ${yBase}`;
                      for (let i = startIdx; i <= endIdx; i++) {
                        const x = idxToX(i);
                        d += ` L ${x} ${toY(Math.max(panoramaData[i].elevation_angle_deg, panoramaMinAngle))}`;
                      }
                      d += ` L ${panoramaMargin.left + panoramaChartW} ${yBase} Z`;
                      return d;
                    })()}
                    fill="#4ade80"
                  />

                  {/* 지형 실루엣 윤곽선 */}
                  <path
                    d={(() => {
                      const { startIdx, endIdx } = panoramaVisibleRange;
                      const toY = (angle: number) => panoramaMargin.top + panoramaChartH * (1 - (angle - panoramaMinAngle) / (panoramaMaxAngle - panoramaMinAngle));
                      let d = "";
                      for (let i = startIdx; i <= endIdx; i++) {
                        const x = idxToX(i);
                        const y = toY(Math.max(panoramaData[i].elevation_angle_deg, panoramaMinAngle));
                        d += i === startIdx ? `M ${x} ${y}` : ` L ${x} ${y}`;
                      }
                      return d;
                    })()}
                    fill="none"
                    stroke="#16a34a"
                    strokeWidth={1.2}
                  />

                  {/* 건물 (전체 높이 표현) + 지반고 아래 녹색 오버레이 */}
                  {panoramaBuildingRects.map((r) => (
                    <g key={`bldg-${r.idx}`}>
                      {/* 건물 전체 (지반고~꼭대기) */}
                      <rect
                        x={r.x} y={r.yTop} width={r.w} height={Math.max(0, r.yBase - r.yTop)}
                        fill={r.type === "manual_building" ? "#ef4444" : "#f97316"}
                        stroke={r.idx === activeBldgIdx ? "#fff" : "none"}
                        strokeWidth={r.idx === activeBldgIdx ? 1.5 : 0}
                        style={{ cursor: "pointer" }}
                        onMouseEnter={() => { if (bldgPinnedIdx === null) setBldgHoverIdx(r.idx); }}
                        onMouseLeave={() => { if (bldgPinnedIdx === null) setBldgHoverIdx(null); }}
                        onClick={() => setBldgPinnedIdx((prev) => (prev === r.idx ? null : r.idx))}
                      />
                      {/* 지형 아래 부분 녹색 덮기 (양옆 0.5px 확장하여 건물 가장자리 완전히 덮기) */}
                      {r.yTerrain < r.yBase && (
                        <rect
                          x={r.x - 0.5} y={r.yTerrain} width={r.w + 1} height={Math.max(0, r.yBase - r.yTerrain)}
                          fill="#4ade80" pointerEvents="none"
                        />
                      )}
                    </g>
                  ))}

                </g>

                {/* 지형 호버/핀 크로스헤어 + 툴팁 */}
                {panoramaActiveIdx !== null && !activeBldg && (
                  <g>
                    {(() => {
                      const pt = panoramaData[panoramaActiveIdx];
                      const x = idxToX(panoramaActiveIdx);
                      const y = panoramaMargin.top + panoramaChartH * (1 - (pt.elevation_angle_deg - panoramaMinAngle) / (panoramaMaxAngle - panoramaMinAngle));
                      const isPinned = panoramaPinnedIdx === panoramaActiveIdx;
                      const peakName = panoramaPeakNames.get(panoramaActiveIdx);
                      const labelName = pt.name || peakName || null;
                      const line1 = `${pt.azimuth_deg.toFixed(1)}° / ${pt.elevation_angle_deg.toFixed(3)}°`;
                      const line2Parts: string[] = [];
                      if (labelName) line2Parts.push(labelName);
                      line2Parts.push(`${pt.distance_km.toFixed(1)}km`);
                      line2Parts.push(`${Math.round(pt.obstacle_height_m)}m (NASA)`);
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
                          <circle cx={x} cy={y} r={4} fill="#22c55e"
                            stroke={isPinned ? "#eab308" : "#fff"} strokeWidth={2} />
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

                {/* 건물 호버/핀 툴팁 */}
                {activeBldg && (() => {
                  const b = activeBldg;
                  const midAz = ((b.azimuth_start_deg + b.azimuth_end_deg) / 2) % 360;
                  const x = panoramaMargin.left + ((midAz - panoramaAzRange[0]) / (panoramaAzRange[1] - panoramaAzRange[0])) * panoramaChartW;
                  const y = panoramaMargin.top + panoramaChartH * (1 - (b.elevation_angle_deg - panoramaMinAngle) / (panoramaMaxAngle - panoramaMinAngle));
                  const isPinned = bldgPinnedIdx !== null;
                  const groundLabel = b.ground_source === "manual" ? "수동 등록" : "NASA";
                  const line1 = `${midAz.toFixed(1)}° / ${b.elevation_angle_deg.toFixed(3)}°`;
                  const line2 = `${b.distance_km.toFixed(1)}km · ${b.name || b.address || "건물"}`;
                  const line3 = `지반고 ${Math.round(b.ground_elev_m)}m (${groundLabel}) · 건물높이 ${b.height_m.toFixed(1)}m`;
                  const maxLen = Math.max(line1.length, line2.length, line3.length);
                  const tooltipW = Math.max(120, maxLen * 6.2 + 16);
                  const tooltipH = 42;
                  const tooltipX = x + tooltipW + 12 > panoramaSvgW ? x - tooltipW - 8 : x + 8;
                  return (
                    <g>
                      <line x1={x} y1={panoramaMargin.top} x2={x} y2={panoramaMargin.top + panoramaChartH}
                        stroke={isPinned ? "#eab308" : "#6b7280"} strokeWidth={1} strokeDasharray="3,3" />
                      <line x1={panoramaMargin.left} y1={y} x2={panoramaMargin.left + panoramaChartW} y2={y}
                        stroke={isPinned ? "#eab308" : "#6b7280"} strokeWidth={0.5} strokeDasharray="3,3" />
                      <circle cx={x} cy={y} r={4}
                        fill={b.obstacle_type === "manual_building" ? "#ef4444" : "#f97316"}
                        stroke={isPinned ? "#eab308" : "#fff"} strokeWidth={2} />
                      <rect x={tooltipX} y={panoramaMargin.top - 2} width={tooltipW} height={tooltipH} rx={3}
                        fill="rgba(0,0,0,0.85)" />
                      <text x={tooltipX + 6} y={panoramaMargin.top + 10} fill="white" fontSize={10}>
                        {line1}
                      </text>
                      <text x={tooltipX + 6} y={panoramaMargin.top + 22} fill="#d1d5db" fontSize={9}>
                        {line2}
                      </text>
                      <text x={tooltipX + 6} y={panoramaMargin.top + 34} fill="#93c5fd" fontSize={9}>
                        {line3}
                      </text>
                    </g>
                  );
                })()}

                {/* 이름 있는 산 — 바닥 눈금선 + 라벨 */}
                {(() => {
                  const shown = new Map<string, number>();
                  for (const [idx, name] of panoramaPeakNames.entries()) {
                    if (idx >= panoramaData.length) continue;
                    const prev = shown.get(name);
                    if (prev === undefined || panoramaData[idx].elevation_angle_deg > panoramaData[prev].elevation_angle_deg) {
                      shown.set(name, idx);
                    }
                  }
                  const { startIdx: visStart, endIdx: visEnd } = panoramaVisibleRange;
                  const yBottom = panoramaMargin.top + panoramaChartH;
                  return Array.from(shown.entries()).map(([name, idx]) => {
                    if (idx < visStart || idx > visEnd) return null;
                    const px = idxToX(idx);
                    return (
                      <g key={`peak-${idx}`}>
                        <line x1={px} y1={panoramaMargin.top} x2={px} y2={yBottom}
                          stroke="#f59e0b" strokeWidth={0.7} strokeDasharray="2,3" strokeOpacity={0.6} />
                        <text x={px} y={yBottom + 26} textAnchor="middle" fill="#92400e" fontSize={7.5} fontWeight="600">
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
                  <rect x={0} y={0} width={8} height={8} fill="#22c55e" rx={1} />
                  <text x={12} y={8} fill="#374151" fontSize={9}>지형</text>
                  <rect x={50} y={0} width={8} height={8} fill="#f97316" rx={1} />
                  <text x={62} y={8} fill="#374151" fontSize={9}>건물통합정보</text>
                  <rect x={115} y={0} width={8} height={8} fill="#ef4444" rx={1} />
                  <text x={127} y={8} fill="#374151" fontSize={9}>수동 건물</text>
                </g>
              </svg>
            </div>

            {/* 건물 위치 지도 (3D fill-extrusion) */}
            <div className="min-h-0 flex-1 border-t border-gray-200">
              <MapGL
                ref={panoramaMapRef}
                initialViewState={{
                  latitude: radarSite.latitude,
                  longitude: radarSite.longitude,
                  zoom: 12,
                  pitch: 45,
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
                      getTargetPosition: (d: BuildingObstacle) => [d.lon, d.lat],
                      getColor: [100, 100, 100, 40],
                      getWidth: 1,
                    }),
                    // 폴리곤 없는 건물만 점으로 표시 (폴백)
                    new ScatterplotLayer({
                      id: "panorama-bldg-dots",
                      data: bldgNoPoly,
                      getPosition: (d: BuildingObstacle) => [d.lon, d.lat],
                      getRadius: 5,
                      radiusUnits: "pixels" as const,
                      getFillColor: (d: BuildingObstacle) =>
                        d.obstacle_type === "manual_building" ? [239, 68, 68, 180] : [249, 115, 22, 180],
                      getLineColor: [255, 255, 255, 200],
                      lineWidthMinPixels: 1,
                      stroked: true,
                      pickable: true,
                      onHover: (info: { object?: BuildingObstacle; index?: number }) => {
                        if (bldgPinnedIdx !== null) return;
                        if (!info.object) { setBldgHoverIdx(null); return; }
                        // bldgNoPoly의 원본 인덱스 찾기
                        const hovered = info.object;
                        const idx = buildingObstacles.indexOf(hovered);
                        if (idx >= 0) setBldgHoverIdx(idx);
                      },
                      onClick: (info: { object?: BuildingObstacle }) => {
                        if (!info.object) return;
                        const idx = buildingObstacles.indexOf(info.object);
                        if (idx >= 0) {
                          setBldgPinnedIdx((prev) => (prev === idx ? null : idx));
                          setBldgHoverIdx(idx);
                        }
                      },
                    }),
                    // 활성 지형 하이라이트
                    ...(panoramaActivePoint && !activeBldg
                      ? [
                          new ScatterplotLayer({
                            id: "panorama-bldg-highlight",
                            data: [panoramaActivePoint],
                            getPosition: (d: PanoramaPoint) => [d.lon, d.lat],
                            getFillColor: [34, 197, 94, 220] as [number, number, number, number],
                            getLineColor: [255, 255, 255, 255],
                            getRadius: 7,
                            radiusUnits: "pixels" as const,
                            stroked: true,
                            lineWidthMinPixels: 2,
                          }),
                        ]
                      : []),
                    ...(panoramaActivePoint && !activeBldg
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
