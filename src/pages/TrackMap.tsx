import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import MapGL, { NavigationControl, type MapRef } from "react-map-gl/maplibre";
import type maplibregl from "maplibre-gl";
import { DeckGLOverlay } from "../components/Map/DeckGLOverlay";
import { PathLayer, ScatterplotLayer, LineLayer, IconLayer } from "@deck.gl/layers";
import {
  Filter,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Layers,
  Clock,
  Scissors,
  Mountain,
  Crosshair,
  Radio,
  ChevronDown,
  CircleDot,
} from "lucide-react";
import { format } from "date-fns";
import { useAppStore } from "../store";
import type { TrackPoint, LossSegment } from "../types";
import LOSProfilePanel from "../components/Map/LOSProfilePanel";

/** Mode-S+PSR 색상 팔레트 (최고 신뢰, 밝은 계열) */
const MODES_PSR_COLORS: [number, number, number][] = [
  [59, 130, 246],   // blue
  [16, 185, 129],   // emerald
  [139, 92, 246],   // violet
  [6, 182, 212],    // cyan
  [99, 102, 241],   // indigo
  [20, 184, 166],   // teal
  [132, 204, 22],   // lime
  [236, 72, 153],   // pink
];

/** Mode-S 색상 팔레트 (밝은 계열 연한 변형) */
const MODES_COLORS: [number, number, number][] = [
  [96, 165, 250],   // light-blue
  [52, 211, 153],   // emerald-light
  [167, 139, 250],  // violet-light
  [34, 211, 238],   // cyan-light
];

/** ATCRBS+PSR 색상 팔레트 (따뜻한 계열) */
const ATCRBS_PSR_COLORS: [number, number, number][] = [
  [245, 158, 11],   // amber
  [249, 115, 22],   // orange
  [234, 179, 8],    // yellow
  [251, 146, 60],   // orange-light
];

/** ATCRBS 색상 팔레트 (따뜻한 계열 어두운 변형) */
const ATCRBS_COLORS: [number, number, number][] = [
  [217, 119, 6],    // amber-dark
  [245, 101, 101],  // red-light
  [251, 191, 146],  // peach
];

/** 레이더 탐지 유형 카테고리 */
type RadarCategory = "modes_psr" | "modes" | "atcrbs_psr" | "atcrbs";

function radarCategory(rt: string): RadarCategory {
  switch (rt) {
    case "modes_psr": return "modes_psr";
    case "modes": return "modes";
    case "atcrbs_psr": return "atcrbs_psr";
    case "atcrbs": return "atcrbs";
    default: return "modes_psr";
  }
}

function radarTypeLabel(rt: string): string {
  switch (rt) {
    case "modes_psr":  return "Mode-S+PSR";
    case "modes":      return "Mode-S";
    case "atcrbs_psr": return "SSR+PSR";
    case "atcrbs":     return "SSR(ATCRBS)";
    default:           return rt.toUpperCase();
  }
}


type MapStyle = "carto-dark" | "osm";
type ControlMode = "playback" | "range";

const MAP_STYLES: Record<MapStyle, string> = {
  "carto-dark":
    "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  osm:
    "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
};

const SPEED_OPTIONS = [1, 60, 120, 300];

interface TrackPath {
  modeS: string;
  radarType: string;
  path: [number, number, number][];
  color: [number, number, number];
  avgAlt: number;
  pointCount: number;
}

export default function TrackMap() {
  const analysisResults = useAppStore((s) => s.analysisResults);
  const aircraft = useAppStore((s) => s.aircraft);
  const radarSite = useAppStore((s) => s.radarSite);
  const setRadarSite = useAppStore((s) => s.setRadarSite);
  const customRadarSites = useAppStore((s) => s.customRadarSites);
  const selectedModeS = useAppStore((s) => s.selectedModeS);
  const setSelectedModeS = useAppStore((s) => s.setSelectedModeS);

  const [mapStyle, setMapStyle] = useState<MapStyle>("carto-dark");
  const [styleOpen, setStyleOpen] = useState(false);
  const [sliderValue, setSliderValue] = useState(100);
  const [playing, setPlaying] = useState(false);
  const [altScale, setAltScale] = useState(1);
  const [dotMode, setDotMode] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(1);
  const [controlMode, setControlMode] = useState<ControlMode>("playback");
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(100);
  /** 재생 모드 트레일 길이 (초). 0=전체 표시, >0=최근 N초만 표시 */
  const [trailDuration, setTrailDuration] = useState(0);
  const [hoverInfo, setHoverInfo] = useState<{
    x: number;
    y: number;
    lines: { label: string; value: string; color?: string }[];
  } | null>(null);
  const [terrainEnabled, setTerrainEnabled] = useState(true);
  const [modeSSearch, setModeSSearch] = useState("");
  const [modeSDropdownOpen, setModeSDropdownOpen] = useState(false);
  const [radarDropdownOpen, setRadarDropdownOpen] = useState(false);
  const [gpuRenderer, setGpuRenderer] = useState<string | null>(null);

  // LOS Analysis state
  const [losMode, setLosMode] = useState(false);
  const [losTarget, setLosTarget] = useState<{ lat: number; lon: number } | null>(null);
  const [losCursor, setLosCursor] = useState<{ lat: number; lon: number } | null>(null);
  const savedTerrainRef = useRef(true); // LOS 모드 진입 전 지형 상태 저장
  const savedPitchRef = useRef(45);

  const mapRef = useRef<MapRef>(null);
  const terrainAdded = useRef(false);
  const playRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const modeSDropdownRef = useRef<HTMLDivElement>(null);
  const radarDropdownRef = useRef<HTMLDivElement>(null);
  const fittedRef = useRef(false);
  const prevPointsLen = useRef(0);

  // GPU detection
  useEffect(() => {
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      if (gl) {
        const ext = gl.getExtension("WEBGL_debug_renderer_info");
        if (ext) {
          const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
          setGpuRenderer(renderer);
        } else {
          setGpuRenderer("WebGL");
        }
      }
    } catch {
      setGpuRenderer(null);
    }
  }, []);

  const isHardwareGPU = useMemo(() => {
    if (!gpuRenderer) return false;
    const sw = gpuRenderer.toLowerCase();
    return !sw.includes("swiftshader") && !sw.includes("llvmpipe") && !sw.includes("software");
  }, [gpuRenderer]);

  // 레이더 정보 (첫 번째 분석결과에서)
  const radarInfo = useMemo(() => {
    if (analysisResults.length === 0) return null;
    const r = analysisResults[0];
    const rangeKm = radarSite.range_nm > 0
      ? radarSite.range_nm * 1.852
      : r.max_radar_range_km;
    return {
      lat: r.file_info.radar_lat,
      lon: r.file_info.radar_lon,
      maxRange: rangeKm,
      rangeNm: radarSite.range_nm,
      name: radarSite.name,
    };
  }, [analysisResults, radarSite.name, radarSite.range_nm]);

  // 비정상 항적 제거용: Mode-S별 포인트 수 카운트
  const validModeS = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of analysisResults) {
      for (const p of r.file_info.track_points) {
        counts.set(p.mode_s, (counts.get(p.mode_s) ?? 0) + 1);
      }
    }
    return new Set(
      Array.from(counts.entries())
        .filter(([, count]) => count >= 10)
        .map(([ms]) => ms)
    );
  }, [analysisResults]);

  // 등록된 비행검사기 Mode-S 코드 집합
  const registeredModeS = useMemo(
    () => new Set(aircraft.filter((a) => a.active).map((a) => a.mode_s_code.toUpperCase())),
    [aircraft]
  );

  // 전체 포인트/Loss 합산 (비정상 항적 + UNKNOWN 제거)
  // selectedModeS: null → 등록된 비행검사기만, "__ALL__" → 전체, 그 외 → 해당 항적만
  const { allPoints, allLoss } = useMemo(() => {
    const pts: TrackPoint[] = [];
    const loss: LossSegment[] = [];
    const showAll = selectedModeS === "__ALL__";
    for (const r of analysisResults) {
      for (const p of r.file_info.track_points) {
        if (!validModeS.has(p.mode_s)) continue;
        if (showAll) {
          pts.push(p);
        } else if (!selectedModeS) {
          if (registeredModeS.has(p.mode_s.toUpperCase())) pts.push(p);
        } else {
          if (p.mode_s === selectedModeS) pts.push(p);
        }
      }
      if (showAll) {
        loss.push(...r.loss_segments.filter((s) => validModeS.has(s.mode_s)));
      } else if (!selectedModeS) {
        loss.push(...r.loss_segments.filter((s) => validModeS.has(s.mode_s) && registeredModeS.has(s.mode_s.toUpperCase())));
      } else {
        loss.push(
          ...r.loss_segments.filter((s) => s.mode_s === selectedModeS)
        );
      }
    }
    pts.sort((a, b) => a.timestamp - b.timestamp);
    return { allPoints: pts, allLoss: loss };
  }, [analysisResults, selectedModeS, validModeS, registeredModeS]);

  // 고유 Mode-S 목록
  const uniqueModeS = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of analysisResults) {
      for (const p of r.file_info.track_points) {
        counts.set(p.mode_s, (counts.get(p.mode_s) ?? 0) + 1);
      }
    }
    const registered = new Set(aircraft.map((a) => a.mode_s_code.toUpperCase()));
    return Array.from(counts.entries())
      .filter(([, count]) => count >= 10)
      .sort(([a, ca], [b, cb]) => {
        const aReg = registered.has(a) ? 1 : 0;
        const bReg = registered.has(b) ? 1 : 0;
        if (aReg !== bReg) return bReg - aReg;
        return cb - ca;
      })
      .slice(0, 200)
      .map(([ms]) => ms);
  }, [analysisResults, aircraft]);

  // 시간 범위
  const timeRange = useMemo(() => {
    if (allPoints.length === 0) return { min: 0, max: 0 };
    return {
      min: allPoints[0].timestamp,
      max: allPoints[allPoints.length - 1].timestamp,
    };
  }, [allPoints]);

  // 퍼센트 → 타임스탬프
  const pctToTs = useCallback(
    (pct: number) => {
      const range = timeRange.max - timeRange.min;
      return timeRange.min + (range * pct) / 100;
    },
    [timeRange]
  );

  // 현재 표시 범위 (모드별)
  const { visibleMinTs, visibleMaxTs } = useMemo(() => {
    if (controlMode === "playback") {
      const maxTs = sliderValue >= 100 ? Infinity : pctToTs(sliderValue);
      // 트레일 길이가 0이면 전체 표시, >0이면 최근 N초만 표시
      const minTs = trailDuration > 0 && maxTs !== Infinity
        ? maxTs - trailDuration
        : timeRange.min;
      return { visibleMinTs: minTs, visibleMaxTs: maxTs };
    } else {
      return {
        visibleMinTs: pctToTs(rangeStart),
        visibleMaxTs: pctToTs(rangeEnd),
      };
    }
  }, [controlMode, sliderValue, rangeStart, rangeEnd, timeRange, pctToTs, trailDuration]);

  // 재생 (실제 시간 기준 배속)
  useEffect(() => {
    if (playing && controlMode === "playback") {
      const totalDuration = timeRange.max - timeRange.min;
      const stepPct = totalDuration > 0 ? (0.1 * playSpeed / totalDuration) * 100 : 0.1;
      playRef.current = setInterval(() => {
        setSliderValue((v) => {
          if (v >= 100) {
            setPlaying(false);
            return 100;
          }
          return Math.min(v + stepPct, 100);
        });
      }, 100);
    } else {
      if (playRef.current) {
        clearInterval(playRef.current);
        playRef.current = null;
      }
    }
    return () => {
      if (playRef.current) clearInterval(playRef.current);
    };
  }, [playing, playSpeed, controlMode, timeRange]);

  // Auto fit bounds
  const [viewState, setViewState] = useState({
    longitude: 127.0,
    latitude: 36.5,
    zoom: 6,
    pitch: 45,
    bearing: 0,
  });

  useEffect(() => {
    if (allPoints.length > 0 && allPoints.length !== prevPointsLen.current) {
      prevPointsLen.current = allPoints.length;
      fittedRef.current = false;
    }
    if (allPoints.length > 0 && !fittedRef.current) {
      let minLat = Infinity,
        maxLat = -Infinity,
        minLon = Infinity,
        maxLon = -Infinity;
      for (const p of allPoints) {
        if (p.latitude < minLat) minLat = p.latitude;
        if (p.latitude > maxLat) maxLat = p.latitude;
        if (p.longitude < minLon) minLon = p.longitude;
        if (p.longitude > maxLon) maxLon = p.longitude;
      }
      const cLat = (minLat + maxLat) / 2;
      const cLon = (minLon + maxLon) / 2;
      const latSpan = maxLat - minLat;
      const lonSpan = maxLon - minLon;
      const span = Math.max(latSpan, lonSpan, 0.01);
      const zoom = Math.max(2, Math.min(15, Math.log2(360 / span) - 0.5));
      setViewState((v) => ({ ...v, latitude: cLat, longitude: cLon, zoom }));
      fittedRef.current = true;
    }
  }, [allPoints]);

  // 지형 DEM 소스/레이어 추가 헬퍼
  const setupTerrain = useCallback((map: maplibregl.Map) => {
    if (!map.getSource("terrain-dem")) {
      map.addSource("terrain-dem", {
        type: "raster-dem",
        tiles: [
          "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
        ],
        encoding: "terrarium",
        tileSize: 256,
        maxzoom: 15,
      });
    }
    if (!map.getLayer("hillshade")) {
      const firstSymbol = map.getStyle().layers?.find((l) => l.type === "symbol")?.id;
      map.addLayer(
        {
          id: "hillshade",
          type: "hillshade",
          source: "terrain-dem",
          paint: {
            "hillshade-shadow-color": "#000000",
            "hillshade-highlight-color": "#ffffff",
            "hillshade-exaggeration": 0.3,
          },
        },
        firstSymbol
      );
    }
    if (terrainEnabled) {
      map.setTerrain({ source: "terrain-dem", exaggeration: 1.5 });
    }
    terrainAdded.current = true;
  }, [terrainEnabled]);

  // 맵 로드 시 지형 설정
  const onMapLoad = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    setupTerrain(map);
    map.on("style.load", () => {
      terrainAdded.current = false;
      setupTerrain(map);
    });
  }, [setupTerrain]);

  // 지형 on/off 토글
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !terrainAdded.current) return;
    if (terrainEnabled) {
      map.setTerrain({ source: "terrain-dem", exaggeration: 1.5 });
      if (map.getLayer("hillshade")) {
        map.setLayoutProperty("hillshade", "visibility", "visible");
      }
    } else {
      map.setTerrain(undefined as any);
      if (map.getLayer("hillshade")) {
        map.setLayoutProperty("hillshade", "visibility", "none");
      }
    }
  }, [terrainEnabled]);

  // Mode-S별 트랙 패스 데이터 (gap + radar_type 변경 시 분할)
  const trackPaths: TrackPath[] = useMemo(() => {
    const groups = new Map<string, TrackPoint[]>();

    for (const p of allPoints) {
      if (p.timestamp > visibleMaxTs) continue;
      if (p.timestamp < visibleMinTs) continue;
      let arr = groups.get(p.mode_s);
      if (!arr) {
        arr = [];
        groups.set(p.mode_s, arr);
      }
      arr.push(p);
    }

    const paths: TrackPath[] = [];
    // 카테고리별 인덱스 추적
    const catIdx: Record<RadarCategory, number> = { modes_psr: 0, modes: 0, atcrbs_psr: 0, atcrbs: 0 };
    for (const [modeS, pts] of groups) {
      if (pts.length < 2) continue;

      // 레이더 5초 회전주기 기준, 8초 이상 gap이면 세그먼트 분할
      const splitThreshold = 8;

      const totalAlts = pts.map((p) => p.altitude);
      const avgAlt = totalAlts.reduce((s, a) => s + a, 0) / totalAlts.length;

      // Mode-S별 카테고리별 색상 결정 (고정)
      const msColors: Record<RadarCategory, [number, number, number]> = {
        modes_psr: MODES_PSR_COLORS[catIdx.modes_psr % MODES_PSR_COLORS.length],
        modes: MODES_COLORS[catIdx.modes % MODES_COLORS.length],
        atcrbs_psr: ATCRBS_PSR_COLORS[catIdx.atcrbs_psr % ATCRBS_PSR_COLORS.length],
        atcrbs: ATCRBS_COLORS[catIdx.atcrbs % ATCRBS_COLORS.length],
      };

      let segStart = 0;
      for (let i = 1; i <= pts.length; i++) {
        const isEnd = i === pts.length;
        const hasGap = !isEnd && pts[i].timestamp - pts[i - 1].timestamp > splitThreshold;
        const typeChanged = !isEnd && radarCategory(pts[i].radar_type) !== radarCategory(pts[i - 1].radar_type);

        if (isEnd || hasGap || typeChanged) {
          const seg = pts.slice(segStart, i);
          if (seg.length >= 2) {
            const cat = radarCategory(seg[0].radar_type);
            const color = msColors[cat];
            paths.push({
              modeS,
              radarType: cat,
              path: seg.map((p) => [p.longitude, p.latitude, losMode ? 0 : p.altitude * altScale]),
              color,
              avgAlt,
              pointCount: seg.length,
            });
          }
          if (typeChanged && !hasGap) {
            segStart = i - 1;
          } else {
            segStart = i;
          }
        }
      }
      catIdx.modes_psr++;
      catIdx.modes++;
      catIdx.atcrbs_psr++;
      catIdx.atcrbs++;
    }
    return paths;
  }, [allPoints, visibleMinTs, visibleMaxTs, altScale, losMode]);

  // Loss 데이터 (signal_loss만 표시)
  const signalLoss = useMemo(() => {
    return allLoss.filter(
      (s) => s.loss_type === "signal_loss" && s.start_time >= visibleMinTs && s.start_time <= visibleMaxTs
    );
  }, [allLoss, visibleMinTs, visibleMaxTs]);

  // Dot 모드용 색상 맵 (Mode-S → color)
  const modeSColorMap = useMemo(() => {
    const map = new Map<string, [number, number, number]>();
    for (const tp of trackPaths) {
      if (!map.has(tp.modeS)) {
        map.set(tp.modeS, tp.color);
      }
    }
    return map;
  }, [trackPaths]);

  // Dot 모드용 가시 포인트
  const dotPoints = useMemo(() => {
    if (!dotMode) return [];
    return allPoints.filter(
      (p) => p.timestamp >= visibleMinTs && p.timestamp <= visibleMaxTs
    );
  }, [dotMode, allPoints, visibleMinTs, visibleMaxTs]);

  // 레이더 동심원 + 귀치도 (MapLibre 네이티브 레이어 - 지형에 밀착)
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !radarInfo) return;

    const { lat, lon, name } = radarInfo;
    const intervalNm = 20;
    const maxNm = 200;
    const features: any[] = [];

    for (let nm = intervalNm; nm <= maxNm + intervalNm * 0.5; nm += intervalNm) {
      const rKm = nm * 1.852;
      const coords: [number, number][] = [];
      for (let i = 0; i <= 120; i++) {
        const angle = (i / 120) * 2 * Math.PI;
        const dLat = (rKm / 111.32) * Math.cos(angle);
        const dLon =
          (rKm / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.sin(angle);
        coords.push([lon + dLon, lat + dLat]);
      }
      features.push({
        type: "Feature",
        properties: { label: `${nm}NM` },
        geometry: { type: "LineString", coordinates: coords },
      });
    }
    features.push({
      type: "Feature",
      properties: { isCenter: "true", name },
      geometry: { type: "Point", coordinates: [lon, lat] },
    });

    const geojson = { type: "FeatureCollection", features } as any;

    const addLayers = () => {
      try {
        for (const lid of ["radar-center-label", "range-ring-labels", "range-ring-lines"]) {
          if (map.getLayer(lid)) map.removeLayer(lid);
        }
        if (map.getSource("range-rings")) map.removeSource("range-rings");

        map.addSource("range-rings", { type: "geojson", data: geojson });
        map.addLayer({
          id: "range-ring-lines",
          type: "line",
          source: "range-rings",
          filter: ["==", ["geometry-type"], "LineString"],
          paint: {
            "line-color": "rgba(100,200,255,0.4)",
            "line-width": 1.5,
          },
        });
        map.addLayer({
          id: "range-ring-labels",
          type: "symbol",
          source: "range-rings",
          filter: ["==", ["geometry-type"], "LineString"],
          layout: {
            "symbol-placement": "line",
            "text-field": ["get", "label"],
            "text-size": 11,
            "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
          },
          paint: {
            "text-color": "rgba(100,200,255,0.6)",
            "text-halo-color": "rgba(0,0,0,0.9)",
            "text-halo-width": 1.5,
          },
        });
        map.addLayer({
          id: "radar-center-label",
          type: "symbol",
          source: "range-rings",
          filter: ["==", ["get", "isCenter"], "true"],
          layout: {
            "text-field": ["get", "name"],
            "text-size": 13,
            "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
            "text-offset": [0, -1.5],
            "text-anchor": "bottom",
          },
          paint: {
            "text-color": "#ffffff",
            "text-halo-color": "rgba(0,0,0,0.9)",
            "text-halo-width": 2,
          },
        });
      } catch (e) {
        console.warn("Range ring layer error:", e);
      }
    };

    if (map.isStyleLoaded()) addLayers();
    const onStyle = () => addLayers();
    map.on("style.load", onStyle);
    return () => { map.off("style.load", onStyle); };
  }, [radarInfo, mapStyle]);

  // LOS mode map click handler
  const handleMapClick = useCallback(
    (evt: any) => {
      if (!losMode) return;
      const { lngLat } = evt;
      setLosTarget({ lat: lngLat.lat, lon: lngLat.lng });
    },
    [losMode]
  );

  // LOS mode mouse move handler (커서 추적)
  const handleMapMouseMove = useCallback(
    (evt: any) => {
      if (!losMode || losTarget) return;
      const { lngLat } = evt;
      setLosCursor({ lat: lngLat.lat, lon: lngLat.lng });
    },
    [losMode, losTarget]
  );

  // deck.gl 레이어
  const deckLayers = useMemo(() => {
    const layers = [];
    const acName = (ms: string) => {
      const a = aircraft.find((ac) => ac.mode_s_code.toLowerCase() === ms.toLowerCase());
      return a ? a.name : ms;
    };

    // 항적 경로 또는 Dot 모드
    if (dotMode) {
      // 수직선 (지면 → 고도)
      layers.push(
        new LineLayer<TrackPoint>({
          id: "dot-stems",
          data: dotPoints,
          getSourcePosition: (d) => [d.longitude, d.latitude, 0],
          getTargetPosition: (d) => [d.longitude, d.latitude, losMode ? 0 : d.altitude * altScale],
          getColor: (d) => {
            const c = modeSColorMap.get(d.mode_s) ?? [128, 128, 128];
            return [...c, 60];
          },
          getWidth: 1,
          widthMinPixels: 0.5,
          widthMaxPixels: 1.5,
          widthUnits: "pixels" as const,
        })
      );
      // 고도 위치 점
      layers.push(
        new ScatterplotLayer<TrackPoint>({
          id: "dot-points",
          data: dotPoints,
          getPosition: (d) => [d.longitude, d.latitude, losMode ? 0 : d.altitude * altScale],
          getFillColor: (d) => {
            const c = modeSColorMap.get(d.mode_s) ?? [128, 128, 128];
            return [...c, 200];
          },
          getRadius: 3,
          radiusMinPixels: 1.5,
          radiusMaxPixels: 5,
          radiusUnits: "pixels",
          pickable: true,
          onHover: (info) => {
            if (info.object) {
              const p = info.object;
              const altFt = Math.round(p.altitude / 0.3048);
              const name = acName(p.mode_s);
              setHoverInfo({
                x: info.x,
                y: info.y,
                lines: [
                  { label: "항적", value: name !== p.mode_s ? `${name} (${p.mode_s})` : p.mode_s, color: (() => { const c = modeSColorMap.get(p.mode_s); return c ? `rgb(${c[0]},${c[1]},${c[2]})` : undefined; })() },
                  { label: "시각", value: format(new Date(p.timestamp * 1000), "MM-dd HH:mm:ss") },
                  { label: "고도", value: `FL${Math.round(altFt / 100)} (${Math.round(p.altitude)}m)` },
                  { label: "속도", value: `${p.speed.toFixed(0)} kts` },
                  { label: "방위", value: `${p.heading.toFixed(0)}°` },
                  { label: "레이더", value: radarTypeLabel(p.radar_type) },
                  { label: "좌표", value: `${p.latitude.toFixed(4)}°N ${p.longitude.toFixed(4)}°E` },
                ],
              });
            } else {
              setHoverInfo(null);
            }
          },
        })
      );
    } else {
      layers.push(
        new PathLayer<TrackPath>({
          id: "track-paths",
          data: trackPaths,
          getPath: (d) => d.path,
          getColor: (d) => [...d.color, 200],
          getWidth: 2,
          widthMinPixels: 1.5,
          widthMaxPixels: 4,
          widthUnits: "pixels",
          billboard: true,
          jointRounded: true,
          capRounded: true,
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 255, 255, 80],
          onHover: (info) => {
            if (info.object) {
              const d = info.object;
              const altFt = Math.round(d.avgAlt / 0.3048);
              const name = acName(d.modeS);
              setHoverInfo({
                x: info.x,
                y: info.y,
                lines: [
                  { label: "항적", value: name !== d.modeS ? `${name} (${d.modeS})` : d.modeS, color: `rgb(${d.color[0]},${d.color[1]},${d.color[2]})` },
                  { label: "포인트", value: `${d.pointCount.toLocaleString()}개` },
                  { label: "평균고도", value: `FL${Math.round(altFt / 100)} (${Math.round(d.avgAlt)}m)` },
                  { label: "레이더", value: radarTypeLabel(d.radarType) },
                ],
              });
            } else {
              setHoverInfo(null);
            }
          },
        })
      );
    }

    // Signal Loss 구간
    if (signalLoss.length > 0) {
      layers.push(
        new LineLayer<LossSegment>({
          id: "loss-lines",
          data: signalLoss,
          getSourcePosition: (d) => [d.start_lon, d.start_lat, losMode ? 0 : d.start_altitude * altScale],
          getTargetPosition: (d) => [d.end_lon, d.end_lat, losMode ? 0 : d.end_altitude * altScale],
          getColor: [233, 69, 96, 220],
          getWidth: 3,
          widthMinPixels: 2,
          widthUnits: "pixels",
          pickable: true,
          onHover: (info) => {
            if (info.object) {
              const s = info.object;
              const name = acName(s.mode_s);
              setHoverInfo({
                x: info.x,
                y: info.y,
                lines: [
                  { label: "표적소실", value: name !== s.mode_s ? `${name} (${s.mode_s})` : s.mode_s, color: "#e94560" },
                  { label: "시작", value: format(new Date(s.start_time * 1000), "MM-dd HH:mm:ss") },
                  { label: "종료", value: format(new Date(s.end_time * 1000), "MM-dd HH:mm:ss") },
                  { label: "지속시간", value: `${s.duration_secs.toFixed(1)}초` },
                  { label: "거리", value: `${s.distance_km.toFixed(2)}km` },
                  { label: "고도", value: `${s.last_altitude.toFixed(0)}m` },
                ],
              });
            } else {
              setHoverInfo(null);
            }
          },
        })
      );

      layers.push(
        new ScatterplotLayer<LossSegment>({
          id: "loss-start",
          data: signalLoss,
          getPosition: (d) => [d.start_lon, d.start_lat, losMode ? 0 : d.start_altitude * altScale],
          getFillColor: [233, 69, 96, 230],
          getLineColor: [255, 255, 255, 180],
          getRadius: 5,
          radiusMinPixels: 4,
          radiusMaxPixels: 12,
          radiusUnits: "pixels",
          lineWidthMinPixels: 1,
          stroked: true,
          pickable: true,
          onHover: (info) => {
            if (info.object) {
              const s = info.object;
              setHoverInfo({
                x: info.x,
                y: info.y,
                lines: [
                  { label: "Loss 시작", value: format(new Date(s.start_time * 1000), "MM-dd HH:mm:ss"), color: "#e94560" },
                  { label: "지속시간", value: `${s.duration_secs.toFixed(1)}초` },
                  { label: "시작 고도", value: `${s.start_altitude.toFixed(0)}m` },
                  { label: "좌표", value: `${s.start_lat.toFixed(4)}°N ${s.start_lon.toFixed(4)}°E` },
                ],
              });
            } else {
              setHoverInfo(null);
            }
          },
        })
      );

      layers.push(
        new ScatterplotLayer<LossSegment>({
          id: "loss-end",
          data: signalLoss,
          getPosition: (d) => [d.end_lon, d.end_lat, losMode ? 0 : d.end_altitude * altScale],
          getFillColor: [255, 138, 128, 200],
          getLineColor: [255, 255, 255, 150],
          getRadius: 4,
          radiusMinPixels: 3,
          radiusMaxPixels: 10,
          radiusUnits: "pixels",
          lineWidthMinPixels: 1,
          stroked: true,
          pickable: false,
        })
      );
    }

    // 레이더 아이콘
    if (radarInfo) {
      layers.push(
        new IconLayer({
          id: "radar-icon",
          data: [radarInfo],
          getPosition: (d: typeof radarInfo) => [d.lon, d.lat, 0],
          getIcon: () => ({
            url: "/radar-icon.png",
            width: 570,
            height: 620,
            anchorY: 620,
          }),
          getSize: 50,
          sizeMinPixels: 24,
          sizeMaxPixels: 60,
          sizeUnits: "meters",
          billboard: true,
          pickable: true,
          onHover: (info) => {
            if (info.object) {
              const d = info.object as typeof radarInfo;
              setHoverInfo({
                x: info.x,
                y: info.y,
                lines: [
                  { label: "레이더", value: d!.name, color: "#22d3ee" },
                  { label: "지원범위", value: `${d!.rangeNm}NM (${d!.maxRange.toFixed(0)}km)` },
                  { label: "좌표", value: `${d!.lat.toFixed(4)}°N ${d!.lon.toFixed(4)}°E` },
                ],
              });
            } else {
              setHoverInfo(null);
            }
          },
        })
      );
    }

    // LOS 모드: 레이더 → 커서 미리보기 선
    const losPreviewTarget = losTarget ?? losCursor;
    const losRadarPos = radarInfo
      ? [radarInfo.lon, radarInfo.lat]
      : [radarSite.longitude, radarSite.latitude];
    if (losMode && losPreviewTarget) {
      layers.push(
        new LineLayer({
          id: "los-preview-line",
          data: [{ from: losRadarPos, to: [losPreviewTarget.lon, losPreviewTarget.lat] }],
          getSourcePosition: (d: any) => d.from,
          getTargetPosition: (d: any) => d.to,
          getColor: losTarget ? [233, 69, 96, 200] : [233, 69, 96, 120],
          getWidth: losTarget ? 2 : 1,
          widthUnits: "pixels" as const,
        })
      );
    }

    return layers;
  }, [trackPaths, signalLoss, altScale, radarInfo, losMode, losTarget, losCursor, dotMode, dotPoints, modeSColorMap, aircraft]);

  // Aircraft name lookup
  const getAircraftName = useCallback(
    (modeS: string): string => {
      const a = aircraft.find(
        (ac) => ac.mode_s_code.toLowerCase() === modeS.toLowerCase()
      );
      return a ? `${a.name}` : modeS;
    },
    [aircraft]
  );

  // Dropdown 외부 클릭 닫기
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modeSDropdownRef.current && !modeSDropdownRef.current.contains(e.target as Node)) {
        setModeSDropdownOpen(false);
      }
      if (radarDropdownRef.current && !radarDropdownRef.current.contains(e.target as Node)) {
        setRadarDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Mode-S 검색 필터
  const filteredModeS = useMemo(() => {
    // 등록된 비행검사기는 상단 섹션에 표시되므로 제외
    const withoutRegistered = uniqueModeS.filter((ms) => !registeredModeS.has(ms));
    if (!modeSSearch) return withoutRegistered;
    const q = modeSSearch.toLowerCase();
    return withoutRegistered.filter((ms) => {
      const name = getAircraftName(ms).toLowerCase();
      return name.includes(q) || ms.toLowerCase().includes(q);
    });
  }, [uniqueModeS, modeSSearch, getAircraftName, registeredModeS]);

  // 레이더 사이트 목록
  const allRadarSites = customRadarSites;

  // 구간모드 드래그 중인 핸들
  const [draggingHandle, setDraggingHandle] = useState<"start" | "end" | null>(null);
  const rangeBarRef = useRef<HTMLDivElement>(null);

  const handleRangePointer = useCallback(
    (e: React.PointerEvent, handle: "start" | "end") => {
      e.preventDefault();
      setDraggingHandle(handle);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    []
  );

  const handleRangeMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingHandle || !rangeBarRef.current) return;
      const rect = rangeBarRef.current.getBoundingClientRect();
      const pct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
      if (draggingHandle === "start") {
        setRangeStart(Math.min(pct, rangeEnd - 0.5));
      } else {
        setRangeEnd(Math.max(pct, rangeStart + 0.5));
      }
    },
    [draggingHandle, rangeStart, rangeEnd]
  );

  const handleRangeUp = useCallback(() => {
    setDraggingHandle(null);
  }, []);

  // 표시 시간 포맷 (날짜 포함)
  const fmtTs = useCallback(
    (ts: number) => (ts > 0 ? format(new Date(ts * 1000), "MM-dd HH:mm:ss") : "--/-- --:--:--"),
    []
  );

  return (
    <div className="flex h-full flex-col">
      {/* Top toolbar */}
      <div className="flex items-center gap-3 border-b border-white/10 bg-[#0d1b2a] px-4 py-3">
        <h1 className="text-lg font-bold text-white">항적 지도</h1>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
            isHardwareGPU
              ? "bg-emerald-500/20 text-emerald-400"
              : "bg-yellow-500/20 text-yellow-400"
          }`}
          title={gpuRenderer || "GPU 감지 안됨"}
        >
          {isHardwareGPU ? "GPU" : "SW"}
        </span>
        <div className="h-5 w-px bg-white/10" />

        {/* Radar site selector */}
        <div ref={radarDropdownRef} className="relative">
          <button
            onClick={() => setRadarDropdownOpen(!radarDropdownOpen)}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#16213e] px-2.5 py-1.5 text-xs text-gray-300 transition-colors hover:border-white/20"
          >
            <Radio size={12} className="text-cyan-400" />
            <span>{radarSite.name}</span>
            <ChevronDown size={10} className={`text-gray-500 transition-transform ${radarDropdownOpen ? "rotate-180" : ""}`} />
          </button>
          {radarDropdownOpen && (
            <div className="absolute left-0 top-full z-[2000] mt-1 w-48 rounded-lg border border-white/20 bg-[#16213e]/95 shadow-xl backdrop-blur">
              <div className="max-h-48 overflow-y-auto py-1">
                {allRadarSites.map((site) => (
                  <button
                    key={site.name}
                    onClick={() => {
                      setRadarSite(site);
                      setRadarDropdownOpen(false);
                    }}
                    className={`w-full px-3 py-1.5 text-left text-xs transition-colors ${
                      radarSite.name === site.name
                        ? "bg-cyan-500/20 text-cyan-400"
                        : "text-gray-300 hover:bg-white/10"
                    }`}
                  >
                    <div>{site.name}</div>
                    <div className="text-[10px] text-gray-500">
                      {site.latitude.toFixed(4)}°N {site.longitude.toFixed(4)}°E | {site.range_nm}NM
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="h-5 w-px bg-white/10" />

        {/* Aircraft filter (searchable dropdown) */}
        <div className="flex items-center gap-2">
          <Filter size={14} className="text-gray-400" />
          <div ref={modeSDropdownRef} className="relative">
            <button
              onClick={() => { setModeSDropdownOpen(!modeSDropdownOpen); setModeSSearch(""); }}
              className="flex items-center gap-2 rounded-lg border border-white/10 bg-[#16213e] px-3 py-1.5 text-sm text-white outline-none hover:border-white/20 transition-colors min-w-[140px]"
            >
              <span className="truncate">{!selectedModeS ? "비행검사기" : selectedModeS === "__ALL__" ? "전체 항적" : getAircraftName(selectedModeS)}</span>
              <svg className={`h-3 w-3 shrink-0 text-gray-400 transition-transform ${modeSDropdownOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
            {modeSDropdownOpen && (
              <div className="absolute left-0 top-full z-[2000] mt-1 w-72 rounded-lg border border-white/20 bg-[#16213e]/95 shadow-xl backdrop-blur">
                <div className="border-b border-white/10 p-2">
                  <input
                    type="text"
                    value={modeSSearch}
                    onChange={(e) => setModeSSearch(e.target.value)}
                    placeholder="Mode-S 코드 또는 기체명 검색..."
                    className="w-full rounded border border-white/10 bg-[#0d1b2a] px-2.5 py-1.5 text-sm text-white outline-none placeholder:text-gray-500 focus:border-[#e94560]/50"
                    autoFocus
                  />
                </div>
                <div className="max-h-60 overflow-y-auto py-1">
                  <button
                    onClick={() => { setSelectedModeS(null); setModeSDropdownOpen(false); }}
                    className={`w-full px-3 py-1.5 text-left text-sm transition-colors ${!selectedModeS ? "bg-[#e94560]/20 text-[#e94560]" : "text-gray-300 hover:bg-white/10"}`}
                  >
                    비행검사기 (전체)
                  </button>
                  {/* 등록된 비행검사기 개별 항목 */}
                  {aircraft.filter((a) => a.active && (!modeSSearch || a.name.toLowerCase().includes(modeSSearch.toLowerCase()) || a.mode_s_code.toLowerCase().includes(modeSSearch.toLowerCase()))).map((a) => (
                    <button
                      key={`ac-${a.id}`}
                      onClick={() => { setSelectedModeS(a.mode_s_code.toUpperCase()); setModeSDropdownOpen(false); }}
                      className={`w-full px-3 py-1.5 text-left text-sm transition-colors ${selectedModeS === a.mode_s_code.toUpperCase() ? "bg-[#e94560]/20 text-[#e94560]" : "text-gray-300 hover:bg-white/10"}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-gray-500">┗</span>
                        <span>{a.name}</span>
                        <span className="text-[10px] text-gray-500">{a.model ? `${a.model} · ` : ""}{a.mode_s_code}</span>
                      </div>
                    </button>
                  ))}
                  <div className="border-t border-white/10 my-1" />
                  <button
                    onClick={() => { setSelectedModeS("__ALL__"); setModeSDropdownOpen(false); }}
                    className={`w-full px-3 py-1.5 text-left text-sm transition-colors ${selectedModeS === "__ALL__" ? "bg-[#e94560]/20 text-[#e94560]" : "text-gray-300 hover:bg-white/10"}`}
                  >
                    전체 항적
                  </button>
                  {filteredModeS.map((ms) => (
                    <button
                      key={ms}
                      onClick={() => { setSelectedModeS(ms); setModeSDropdownOpen(false); }}
                      className={`w-full px-3 py-1.5 text-left text-sm transition-colors ${selectedModeS === ms ? "bg-[#e94560]/20 text-[#e94560]" : "text-gray-300 hover:bg-white/10"}`}
                    >
                      {getAircraftName(ms)}
                    </button>
                  ))}
                  {filteredModeS.length === 0 && aircraft.filter((a) => a.active).length === 0 && modeSSearch && (
                    <div className="px-3 py-2 text-xs text-gray-500">검색 결과 없음</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex-1" />

        {/* Altitude scale */}
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span>고도</span>
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={altScale}
            onChange={(e) => setAltScale(Number(e.target.value))}
            className="w-20 accent-[#e94560]"
            title="고도 배율"
          />
          <span className="w-8 text-right">{altScale}x</span>
        </div>

        <div className="h-5 w-px bg-white/10" />

        {/* Stats */}
        <div className="flex items-center gap-4 text-xs text-gray-400">
          <span>포인트: {allPoints.length.toLocaleString()}</span>
          <span>세그: {trackPaths.length}</span>
          <span>파일: {analysisResults.length}</span>
          <span>Mode-S: {(() => { const s = new Set(allPoints.map(p => p.mode_s)); return s.size; })()}</span>
          <span className="text-[#e94560]">Loss: {signalLoss.length}건</span>
        </div>

        {/* LOS Analysis toggle */}
        <button
          onClick={() => {
            const entering = !losMode;
            setLosMode(entering);
            if (entering) {
              // 현재 pitch/지형 저장 후 2D 탑다운 뷰로 전환
              savedPitchRef.current = viewState.pitch ?? 45;
              savedTerrainRef.current = terrainEnabled;
              if (terrainEnabled) setTerrainEnabled(false);
              const map = mapRef.current?.getMap();
              if (map) {
                map.easeTo({ pitch: 0, bearing: 0, duration: 500 });
              }
            } else {
              // 3D 뷰/지형 복원
              setLosTarget(null);
              setLosCursor(null);
              if (savedTerrainRef.current) setTerrainEnabled(true);
              const map = mapRef.current?.getMap();
              if (map) {
                map.easeTo({ pitch: savedPitchRef.current, duration: 500 });
              }
            }
          }}
          className={`rounded-lg p-1.5 transition-colors ${
            losMode
              ? "bg-[#e94560]/20 text-[#e94560]"
              : "text-gray-400 hover:text-white"
          }`}
          title="LOS 분석 (단면도)"
        >
          <Mountain size={16} />
        </button>

        {/* Dot mode toggle */}
        <button
          onClick={() => setDotMode(!dotMode)}
          className={`rounded-lg p-1.5 transition-colors ${dotMode ? "bg-white/10 text-white" : "text-gray-400 hover:text-white"}`}
          title="Dot 모드 (개별 표적 표시)"
        >
          <CircleDot size={16} />
        </button>

        {/* Terrain toggle */}
        <button
          onClick={() => setTerrainEnabled(!terrainEnabled)}
          className={`rounded-lg px-1.5 py-1 text-xs font-bold transition-colors ${terrainEnabled ? "bg-white/10 text-white" : "text-gray-400 hover:text-white"}`}
          title="3D 지형"
        >
          3D
        </button>
      </div>

      {/* LOS mode indicator */}
      {losMode && !losTarget && (
        <div className="flex items-center gap-2 bg-[#e94560]/10 px-4 py-1.5 text-xs text-[#e94560]">
          <Crosshair size={12} />
          <span>LOS 분석 모드: 지도에서 분석할 지점을 클릭하세요</span>
          <button
            onClick={() => { setLosMode(false); setLosTarget(null); setLosCursor(null); }}
            className="ml-auto text-[10px] text-gray-400 hover:text-white"
          >
            취소
          </button>
        </div>
      )}

      {/* Map container */}
      <div className="relative flex-1">
        <MapGL
          ref={mapRef}
          {...viewState}
          onMove={(evt) => setViewState(evt.viewState)}
          onLoad={onMapLoad}
          onClick={handleMapClick}
          onMouseMove={handleMapMouseMove}
          mapStyle={MAP_STYLES[mapStyle]}
          maxPitch={85}
          style={{ width: "100%", height: "100%" }}
          cursor={losMode ? "crosshair" : undefined}
          attributionControl={false}
        >
          <DeckGLOverlay layers={deckLayers} />
          <NavigationControl position="top-left" />
        </MapGL>

        {/* Hover tooltip */}
        {hoverInfo && (
          <div
            className="pointer-events-none absolute z-[1000] rounded-lg border border-white/20 bg-[#0d1b2a]/95 px-3 py-2.5 text-xs shadow-xl backdrop-blur-sm"
            style={{ left: hoverInfo.x + 14, top: hoverInfo.y - 14 }}
          >
            {hoverInfo.lines.map((line, i) => (
              <div key={i} className={`flex items-center gap-2 ${i > 0 ? "mt-1" : ""}`}>
                {i === 0 && line.color && (
                  <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: line.color }} />
                )}
                <span className="text-gray-500">{line.label}</span>
                <span className={i === 0 ? "font-semibold text-white" : "text-gray-200"}>
                  {line.value}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Map style toggle */}
        <div className="absolute right-3 top-3 z-[1000]">
          <div className="relative">
            <button
              onClick={() => setStyleOpen(!styleOpen)}
              className="flex items-center gap-2 rounded-lg border border-white/20 bg-[#16213e]/95 px-3 py-2 text-sm text-white shadow-lg backdrop-blur hover:bg-[#16213e] transition-colors"
            >
              <Layers size={16} />
              <span>{mapStyle === "osm" ? "표준" : "다크"}</span>
            </button>
            {styleOpen && (
              <div className="absolute right-0 top-full mt-1 w-36 overflow-hidden rounded-lg border border-white/20 bg-[#16213e]/95 shadow-xl backdrop-blur">
                <button
                  onClick={() => { setMapStyle("osm"); setStyleOpen(false); }}
                  className={`flex w-full items-center px-3 py-2 text-sm transition-colors ${mapStyle === "osm" ? "bg-[#e94560]/20 text-[#e94560]" : "text-gray-300 hover:bg-white/10"}`}
                >
                  표준 (밝은)
                </button>
                <button
                  onClick={() => { setMapStyle("carto-dark"); setStyleOpen(false); }}
                  className={`flex w-full items-center px-3 py-2 text-sm transition-colors ${mapStyle === "carto-dark" ? "bg-[#e94560]/20 text-[#e94560]" : "text-gray-300 hover:bg-white/10"}`}
                >
                  다크
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 범례 (왼쪽 하단) */}
        {allPoints.length > 0 && (
          <div className="absolute bottom-3 left-3 z-[1000] rounded-lg border border-white/15 bg-[#0d1b2a]/90 px-3 py-2.5 text-[10px] backdrop-blur-sm shadow-lg">
            <div className="mb-1.5 text-[9px] font-semibold text-gray-400 uppercase tracking-wider">범례</div>
            <div className="space-y-1">
              {/* 동적: 현재 표시 중인 항적 */}
              {(() => {
                // Mode-S별로 첫 번째 세그먼트의 색상을 수집
                const shown = new Map<string, { color: [number,number,number]; type: string }>();
                for (const tp of trackPaths) {
                  if (!shown.has(tp.modeS)) {
                    shown.set(tp.modeS, { color: tp.color, type: tp.radarType });
                  }
                }
                const entries = Array.from(shown.entries()).slice(0, 8); // 최대 8개
                return entries.map(([ms, { color }]) => {
                  const name = aircraft.find((a) => a.mode_s_code.toUpperCase() === ms.toUpperCase())?.name;
                  return (
                    <div key={ms} className="flex items-center gap-1.5">
                      <span className="inline-block h-[3px] w-4 rounded-sm" style={{ backgroundColor: `rgb(${color[0]},${color[1]},${color[2]})` }} />
                      <span className="text-gray-300">{name ? `${name} (${ms})` : ms}</span>
                    </div>
                  );
                });
              })()}
              {/* 레이더 탐지 유형 범례 */}
              <div className="border-t border-white/10 pt-1 mt-1 space-y-1">
                <div className="text-[8px] text-gray-500 uppercase tracking-wider mb-0.5">탐지 유형</div>
                {([
                  { cat: "modes_psr" as const, label: "Mode-S+PSR", color: MODES_PSR_COLORS[0] },
                  { cat: "modes" as const, label: "Mode-S", color: MODES_COLORS[0] },
                  { cat: "atcrbs_psr" as const, label: "SSR+PSR", color: ATCRBS_PSR_COLORS[0] },
                  { cat: "atcrbs" as const, label: "SSR(ATCRBS)", color: ATCRBS_COLORS[0] },
                ]).map(({ cat, label, color }) => (
                  <div key={cat} className="flex items-center gap-1.5">
                    <span className="inline-block h-[3px] w-4 rounded-sm" style={{ backgroundColor: `rgb(${color[0]},${color[1]},${color[2]})` }} />
                    <span className="text-gray-400">{label}</span>
                  </div>
                ))}
              </div>
              {/* 고정 범례 항목 */}
              <div className="border-t border-white/10 pt-1 mt-1 space-y-1">
                <div className="flex items-center gap-1.5">
                  <span className="inline-block h-[3px] w-4 rounded-sm bg-[#e94560]" />
                  <span className="text-gray-300">표적소실 구간</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-full bg-[#e94560] border border-white/60" />
                  <span className="text-gray-300">소실 시작점</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="inline-block h-[3px] w-4 rounded-sm" style={{ backgroundColor: "rgba(100,200,255,0.5)" }} />
                  <span className="text-gray-300">레이더 동심원 (20NM)</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Empty state overlay */}
        {allPoints.length === 0 && (
          <div className="absolute inset-0 z-[500] flex items-center justify-center bg-black/40 backdrop-blur-sm">
            <div className="text-center">
              <p className="text-lg font-medium text-gray-300">
                표시할 항적 데이터가 없습니다
              </p>
              <p className="mt-1 text-sm text-gray-500">
                자료 업로드에서 NEC ASS 파일을 파싱하세요
              </p>
            </div>
          </div>
        )}
      </div>

      {/* LOS Profile Panel */}
      {losTarget && (
        <LOSProfilePanel
          radarSite={radarSite}
          targetLat={losTarget.lat}
          targetLon={losTarget.lon}
          onClose={() => { setLosTarget(null); setLosMode(false); setLosCursor(null); }}
        />
      )}

      {/* Bottom control bar */}
      {allPoints.length > 0 && (
        <div className="border-t border-white/10 bg-[#0d1b2a]">
          {/* Mode tabs */}
          <div className="flex items-center gap-1 border-b border-white/5 px-4 pt-2">
            <button
              onClick={() => { setControlMode("playback"); setPlaying(false); }}
              className={`flex items-center gap-1.5 rounded-t-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                controlMode === "playback"
                  ? "bg-white/10 text-white"
                  : "text-gray-500 hover:text-gray-300"
              }`}
            >
              <Clock size={12} />
              재생모드
            </button>
            <button
              onClick={() => { setControlMode("range"); setPlaying(false); }}
              className={`flex items-center gap-1.5 rounded-t-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                controlMode === "range"
                  ? "bg-white/10 text-white"
                  : "text-gray-500 hover:text-gray-300"
              }`}
            >
              <Scissors size={12} />
              구간모드
            </button>
          </div>

          {/* Playback mode */}
          {controlMode === "playback" && (
            <div className="flex items-center gap-3 px-4 py-3">
              <button
                onClick={() => setSliderValue(0)}
                className="rounded p-1 text-gray-400 hover:text-white transition-colors"
                title="처음으로"
              >
                <SkipBack size={16} />
              </button>
              <button
                onClick={() => setPlaying(!playing)}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-[#e94560] text-white hover:bg-[#d63851] transition-colors"
                title={playing ? "일시정지" : "재생"}
              >
                {playing ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
              </button>
              <button
                onClick={() => setSliderValue(100)}
                className="rounded p-1 text-gray-400 hover:text-white transition-colors"
                title="끝으로"
              >
                <SkipForward size={16} />
              </button>

              {/* Speed selector */}
              <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-[#16213e] px-1 py-0.5">
                {SPEED_OPTIONS.map((sp) => (
                  <button
                    key={sp}
                    onClick={() => setPlaySpeed(sp)}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold transition-colors ${
                      playSpeed === sp
                        ? "bg-[#e94560] text-white"
                        : "text-gray-400 hover:text-white"
                    }`}
                  >
                    {sp}x
                  </button>
                ))}
              </div>

              {/* Trail duration selector */}
              <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-[#16213e] px-1 py-0.5">
                <span className="text-[9px] text-gray-500 px-0.5">Trail</span>
                {[0, 600].map((d) => (
                  <button
                    key={d}
                    onClick={() => setTrailDuration(d)}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold transition-colors ${
                      trailDuration === d
                        ? "bg-cyan-600 text-white"
                        : "text-gray-400 hover:text-white"
                    }`}
                  >
                    {d === 0 ? "All" : "10m"}
                  </button>
                ))}
              </div>

              <span className="min-w-[110px] text-center font-mono text-xs text-gray-400">
                {fmtTs(pctToTs(sliderValue))}
              </span>

              <input
                type="range"
                min={0}
                max={100}
                step={0.1}
                value={sliderValue}
                onChange={(e) => {
                  setSliderValue(Number(e.target.value));
                  setPlaying(false);
                }}
                className="flex-1 accent-[#e94560]"
              />

              <span className="min-w-[110px] text-center font-mono text-xs text-gray-400">
                {fmtTs(timeRange.max)}
              </span>

              <span className="min-w-[40px] text-right font-mono text-xs text-gray-500">
                {sliderValue.toFixed(0)}%
              </span>
            </div>
          )}

          {/* Range mode */}
          {controlMode === "range" && (
            <div className="flex items-center gap-3 px-4 py-3">
              <span className="min-w-[110px] text-center font-mono text-xs text-[#e94560]">
                {fmtTs(pctToTs(rangeStart))}
              </span>

              <div
                ref={rangeBarRef}
                className="relative flex-1 h-6 select-none"
                onPointerMove={handleRangeMove}
                onPointerUp={handleRangeUp}
              >
                <div className="absolute left-0 right-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-white/10" />
                <div
                  className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-[#e94560]/40"
                  style={{
                    left: `${rangeStart}%`,
                    width: `${rangeEnd - rangeStart}%`,
                  }}
                />
                <div
                  className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize"
                  style={{ left: `${rangeStart}%` }}
                  onPointerDown={(e) => handleRangePointer(e, "start")}
                >
                  <div className={`h-4 w-4 rounded-full border-2 transition-colors ${
                    draggingHandle === "start"
                      ? "border-white bg-[#e94560] scale-125"
                      : "border-[#e94560] bg-[#16213e] hover:bg-[#e94560]/50"
                  }`} />
                </div>
                <div
                  className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize"
                  style={{ left: `${rangeEnd}%` }}
                  onPointerDown={(e) => handleRangePointer(e, "end")}
                >
                  <div className={`h-4 w-4 rounded-full border-2 transition-colors ${
                    draggingHandle === "end"
                      ? "border-white bg-[#e94560] scale-125"
                      : "border-[#e94560] bg-[#16213e] hover:bg-[#e94560]/50"
                  }`} />
                </div>
              </div>

              <span className="min-w-[110px] text-center font-mono text-xs text-[#e94560]">
                {fmtTs(pctToTs(rangeEnd))}
              </span>

              <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-[#16213e] px-3 py-1.5">
                <span className="text-[10px] text-gray-500">구간</span>
                <span className="font-mono text-xs text-white">
                  {(() => {
                    const durSec = pctToTs(rangeEnd) - pctToTs(rangeStart);
                    const m = Math.floor(durSec / 60);
                    const s = Math.floor(durSec % 60);
                    return `${m}분 ${s}초`;
                  })()}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
