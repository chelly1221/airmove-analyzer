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
  Info,
  Layers,
  Clock,
  Scissors,
  Mountain,
} from "lucide-react";
import { format } from "date-fns";
import { useAppStore } from "../store";
import type { TrackPoint, LossSegment } from "../types";

/** SSR+PSR Combined 색상 팔레트 (밝은 계열) */
const COMBINED_COLORS: [number, number, number][] = [
  [59, 130, 246],   // blue
  [16, 185, 129],   // emerald
  [139, 92, 246],   // violet
  [6, 182, 212],    // cyan
  [99, 102, 241],   // indigo
  [20, 184, 166],   // teal
  [132, 204, 22],   // lime
  [236, 72, 153],   // pink
];

/** SSR Only 색상 팔레트 (따뜻한 계열) */
const SSR_ONLY_COLORS: [number, number, number][] = [
  [245, 158, 11],   // amber
  [249, 115, 22],   // orange
  [234, 179, 8],    // yellow
  [251, 146, 60],   // orange-light
  [217, 119, 6],    // amber-dark
  [245, 101, 101],  // red-light
];

type MapStyle = "carto-dark" | "osm";
type ControlMode = "playback" | "range";

const MAP_STYLES: Record<MapStyle, string> = {
  "carto-dark":
    "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  osm:
    "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
};

const SPEED_OPTIONS = [1, 2, 4, 8, 30, 60, 120, 300];

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
  const selectedModeS = useAppStore((s) => s.selectedModeS);
  const setSelectedModeS = useAppStore((s) => s.setSelectedModeS);

  const [mapStyle, setMapStyle] = useState<MapStyle>("carto-dark");
  const [styleOpen, setStyleOpen] = useState(false);
  const [sliderValue, setSliderValue] = useState(100);
  const [playing, setPlaying] = useState(false);
  const [showLegend, setShowLegend] = useState(true);
  const [altScale, setAltScale] = useState(1);
  const [playSpeed, setPlaySpeed] = useState(1);
  const [controlMode, setControlMode] = useState<ControlMode>("playback");
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(100);
  const [hoverInfo, setHoverInfo] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);
  const [terrainEnabled, setTerrainEnabled] = useState(true);
  const [modeSSearch, setModeSSearch] = useState("");
  const [modeSDropdownOpen, setModeSDropdownOpen] = useState(false);
  const mapRef = useRef<MapRef>(null);
  const terrainAdded = useRef(false);
  const playRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const modeSDropdownRef = useRef<HTMLDivElement>(null);
  const fittedRef = useRef(false);
  const prevPointsLen = useRef(0);

  // 레이더 정보 (첫 번째 분석결과에서)
  const radarInfo = useMemo(() => {
    if (analysisResults.length === 0) return null;
    const r = analysisResults[0];
    // 제원상 지원범위(NM)가 있으면 km로 변환하여 사용, 없으면 추정값
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

  // 전체 포인트/Loss 합산 (비정상 항적 제거)
  const { allPoints, allLoss } = useMemo(() => {
    const pts: TrackPoint[] = [];
    const loss: LossSegment[] = [];
    for (const r of analysisResults) {
      for (const p of r.file_info.track_points) {
        if (!validModeS.has(p.mode_s)) continue;
        if (!selectedModeS || p.mode_s === selectedModeS) {
          pts.push(p);
        }
      }
      if (!selectedModeS) {
        loss.push(...r.loss_segments.filter((s) => validModeS.has(s.mode_s)));
      } else {
        loss.push(
          ...r.loss_segments.filter((s) => s.mode_s === selectedModeS)
        );
      }
    }
    pts.sort((a, b) => a.timestamp - b.timestamp);
    return { allPoints: pts, allLoss: loss };
  }, [analysisResults, selectedModeS, validModeS]);

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
      return {
        visibleMinTs: timeRange.min,
        visibleMaxTs: sliderValue >= 100 ? Infinity : pctToTs(sliderValue),
      };
    } else {
      return {
        visibleMinTs: pctToTs(rangeStart),
        visibleMaxTs: pctToTs(rangeEnd),
      };
    }
  }, [controlMode, sliderValue, rangeStart, rangeEnd, timeRange, pctToTs]);

  // 재생 (실제 시간 기준 배속)
  useEffect(() => {
    if (playing && controlMode === "playback") {
      const totalDuration = timeRange.max - timeRange.min;
      // 100ms 인터벌마다 0.1초 * playSpeed 만큼 데이터 시간 전진 → 1x = 실시간
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
    // 스타일 변경 시 지형 다시 추가
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
    let combinedIdx = 0;
    let ssrIdx = 0;
    for (const [modeS, pts] of groups) {
      if (pts.length < 2) continue;

      // 스캔 간격 추정 (중앙값) → 1.8배 이상이면 Loss = 선 끊기
      const gaps = pts
        .slice(1)
        .map((p, i) => p.timestamp - pts[i].timestamp)
        .filter((g) => g > 0.5 && g < 30);
      gaps.sort((a, b) => a - b);
      const medianGap = gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : 5;
      const splitThreshold = medianGap * 1.8;

      const totalAlts = pts.map((p) => p.altitude);
      const avgAlt = totalAlts.reduce((s, a) => s + a, 0) / totalAlts.length;

      // SSR only 여부 판별: "ssr"이면 SSR only, 나머지(combined/modes/psr)는 combined 계열
      const isSSR = (p: TrackPoint) => p.radar_type === "ssr";

      // gap 또는 radar_type 변경 시 세그먼트 분할
      let segStart = 0;
      for (let i = 1; i <= pts.length; i++) {
        const isEnd = i === pts.length;
        const hasGap = !isEnd && pts[i].timestamp - pts[i - 1].timestamp > splitThreshold;
        const typeChanged = !isEnd && isSSR(pts[i]) !== isSSR(pts[i - 1]);

        if (isEnd || hasGap || typeChanged) {
          const seg = pts.slice(segStart, i);
          if (seg.length >= 2) {
            const segIsSSR = isSSR(seg[0]);
            const color = segIsSSR
              ? SSR_ONLY_COLORS[ssrIdx % SSR_ONLY_COLORS.length]
              : COMBINED_COLORS[combinedIdx % COMBINED_COLORS.length];
            paths.push({
              modeS,
              radarType: segIsSSR ? "ssr" : "combined",
              path: seg.map((p) => [p.longitude, p.latitude, p.altitude * altScale]),
              color,
              avgAlt,
              pointCount: seg.length,
            });
          }
          segStart = i;
        }
      }
      // Mode-S별로 색상 인덱스 증가
      combinedIdx++;
      ssrIdx++;
    }
    return paths;
  }, [allPoints, visibleMinTs, visibleMaxTs, altScale]);

  // Loss 데이터 (signal_loss만 표시)
  const signalLoss = useMemo(() => {
    return allLoss.filter(
      (s) => s.loss_type === "signal_loss" && s.start_time >= visibleMinTs && s.start_time <= visibleMaxTs
    );
  }, [allLoss, visibleMinTs, visibleMaxTs]);

  // 레이더 동심원 + 귀치도 (MapLibre 네이티브 레이어 - 지형에 밀착)
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !radarInfo) return;

    const { lat, lon, name } = radarInfo;
    // 20NM 간격, 200NM까지 고정
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
    // 레이더 중심점 (사이트 이름 포함)
    features.push({
      type: "Feature",
      properties: { isCenter: "true", name: `${name} 레이더` },
      geometry: { type: "Point", coordinates: [lon, lat] },
    });

    const geojson = { type: "FeatureCollection", features } as any;

    const addLayers = () => {
      try {
        // 기존 레이어/소스 제거 후 재생성 (스타일 변경 시 안전)
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
        // 레이더 사이트 이름 라벨
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

  // deck.gl 레이어
  const deckLayers = useMemo(() => {
    const layers = [];

    // 항적 경로 (PathLayer - billboard로 눕혀도 잘 보임)
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
            setHoverInfo({
              x: info.x,
              y: info.y,
              text: `Mode-S: ${d.modeS} | ${d.pointCount} pts | 평균고도: FL${Math.round(altFt / 100)}(${Math.round(d.avgAlt)}m)`,
            });
          } else {
            setHoverInfo(null);
          }
        },
      })
    );

    // Signal Loss 구간 (빨간색 - 실제 Loss)
    if (signalLoss.length > 0) {
      layers.push(
        new LineLayer<LossSegment>({
          id: "loss-lines",
          data: signalLoss,
          getSourcePosition: (d) => [d.start_lon, d.start_lat, d.start_altitude * altScale],
          getTargetPosition: (d) => [d.end_lon, d.end_lat, d.end_altitude * altScale],
          getColor: [233, 69, 96, 220],
          getWidth: 3,
          widthMinPixels: 2,
          widthUnits: "pixels",
          pickable: true,
          onHover: (info) => {
            if (info.object) {
              const s = info.object;
              setHoverInfo({
                x: info.x,
                y: info.y,
                text: `Signal Loss: ${s.duration_secs.toFixed(1)}s / ${s.distance_km.toFixed(2)}km / ${s.last_altitude.toFixed(0)}m`,
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
          getPosition: (d) => [d.start_lon, d.start_lat, d.start_altitude * altScale],
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
                text: `Loss 시작 ${format(new Date(s.start_time * 1000), "HH:mm:ss")} / ${s.duration_secs.toFixed(1)}s`,
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
          getPosition: (d) => [d.end_lon, d.end_lat, d.end_altitude * altScale],
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

    // 레이더 아이콘 (billboard - 항상 카메라를 향함)
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
                text: `${d.name} 레이더 | 지원범위: ${d.rangeNm}NM (${d.maxRange.toFixed(0)}km)`,
              });
            } else {
              setHoverInfo(null);
            }
          },
        })
      );
    }

    return layers;
  }, [trackPaths, signalLoss, altScale, radarInfo]);

  // Aircraft name lookup
  const getAircraftName = useCallback(
    (modeS: string): string => {
      const a = aircraft.find(
        (ac) => ac.mode_s_code.toLowerCase() === modeS.toLowerCase()
      );
      return a ? `${a.name} (${modeS})` : modeS;
    },
    [aircraft]
  );

  // Mode-S 드롭다운 외부 클릭 닫기
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modeSDropdownRef.current && !modeSDropdownRef.current.contains(e.target as Node)) {
        setModeSDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Mode-S 검색 필터
  const filteredModeS = useMemo(() => {
    if (!modeSSearch) return uniqueModeS;
    const q = modeSSearch.toLowerCase();
    return uniqueModeS.filter((ms) => {
      const name = getAircraftName(ms).toLowerCase();
      return name.includes(q) || ms.toLowerCase().includes(q);
    });
  }, [uniqueModeS, modeSSearch, getAircraftName]);

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

  // 표시 시간 포맷
  const fmtTs = useCallback(
    (ts: number) => (ts > 0 ? format(new Date(ts * 1000), "HH:mm:ss") : "--:--:--"),
    []
  );

  return (
    <div className="flex h-full flex-col">
      {/* Top toolbar */}
      <div className="flex items-center gap-3 border-b border-white/10 bg-[#0d1b2a] px-4 py-3">
        <h1 className="text-lg font-bold text-white">항적 지도</h1>
        <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-400">
          GPU
        </span>
        <div className="h-5 w-px bg-white/10" />

        {/* Aircraft filter (searchable dropdown) */}
        <div className="flex items-center gap-2">
          <Filter size={14} className="text-gray-400" />
          <div ref={modeSDropdownRef} className="relative">
            <button
              onClick={() => { setModeSDropdownOpen(!modeSDropdownOpen); setModeSSearch(""); }}
              className="flex items-center gap-2 rounded-lg border border-white/10 bg-[#16213e] px-3 py-1.5 text-sm text-white outline-none hover:border-white/20 transition-colors min-w-[140px]"
            >
              <span className="truncate">{selectedModeS ? getAircraftName(selectedModeS) : "전체 항적"}</span>
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
                  {filteredModeS.length === 0 && modeSSearch && (
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
          <span className="text-[#e94560]">Loss: {signalLoss.length}건</span>
        </div>

        {/* Terrain toggle */}
        <button
          onClick={() => setTerrainEnabled(!terrainEnabled)}
          className={`rounded-lg p-1.5 transition-colors ${terrainEnabled ? "bg-white/10 text-white" : "text-gray-400 hover:text-white"}`}
          title="3D 지형"
        >
          <Mountain size={16} />
        </button>

        {/* Legend toggle */}
        <button
          onClick={() => setShowLegend(!showLegend)}
          className={`rounded-lg p-1.5 transition-colors ${showLegend ? "bg-white/10 text-white" : "text-gray-400 hover:text-white"}`}
          title="범례"
        >
          <Info size={16} />
        </button>
      </div>

      {/* Map container */}
      <div className="relative flex-1">
        <MapGL
          ref={mapRef}
          {...viewState}
          onMove={(evt) => setViewState(evt.viewState)}
          onLoad={onMapLoad}
          mapStyle={MAP_STYLES[mapStyle]}
          maxPitch={85}
          style={{ width: "100%", height: "100%" }}
          attributionControl={{}}
        >
          <DeckGLOverlay layers={deckLayers} />
          <NavigationControl position="top-left" />
        </MapGL>

        {/* Hover tooltip */}
        {hoverInfo && (
          <div
            className="pointer-events-none absolute z-[1000] rounded-lg border border-white/20 bg-[#16213e]/95 px-3 py-2 text-xs text-white shadow-lg backdrop-blur"
            style={{ left: hoverInfo.x + 12, top: hoverInfo.y - 12 }}
          >
            {hoverInfo.text}
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

        {/* Legend */}
        {showLegend && (
          <div className="absolute bottom-20 left-3 z-[1000] max-h-[50vh] overflow-y-auto rounded-lg border border-white/20 bg-[#16213e]/95 p-3 shadow-lg backdrop-blur">
            <h3 className="mb-2 text-xs font-semibold text-white">범례</h3>
            <div className="space-y-1.5 text-xs">
              {/* SSR+PSR / SSR 구분 */}
              <div className="flex items-center gap-2">
                <div className="h-0.5 w-5 rounded-full" style={{ backgroundColor: `rgb(${COMBINED_COLORS[0].join(",")})` }} />
                <span className="text-gray-300">SSR+PSR Combined</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-0.5 w-5 rounded-full" style={{ backgroundColor: `rgb(${SSR_ONLY_COLORS[0].join(",")})` }} />
                <span className="text-gray-300">SSR Only</span>
              </div>
              <div className="my-1 h-px bg-white/10" />
              {/* 항적 색상 (Mode-S별, 중복 제거) */}
              {(() => {
                const seen = new Set<string>();
                return trackPaths.filter((tp) => {
                  if (seen.has(tp.modeS)) return false;
                  seen.add(tp.modeS);
                  return true;
                }).map((tp) => {
                  const total = trackPaths
                    .filter((p) => p.modeS === tp.modeS)
                    .reduce((s, p) => s + p.pointCount, 0);
                  return (
                    <div key={tp.modeS} className="flex items-center gap-2">
                      <div
                        className="h-0.5 w-5 rounded-full"
                        style={{ backgroundColor: `rgb(${tp.color.join(",")})` }}
                      />
                      <span className="text-gray-300">{getAircraftName(tp.modeS)}</span>
                      <span className="text-gray-600">{total}</span>
                    </div>
                  );
                });
              })()}
              {trackPaths.length > 0 && <div className="my-1 h-px bg-white/10" />}
              {/* Signal Loss */}
              <div className="flex items-center gap-2">
                <div className="h-0.5 w-5 bg-[#e94560]" />
                <span className="text-gray-300">Signal Loss</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-2.5 w-2.5 rounded-full bg-[#e94560]" />
                <span className="text-gray-300">Loss 시작/끝</span>
              </div>
              {/* Radar */}
              {radarInfo && (
                <>
                  <div className="my-1 h-px bg-white/10" />
                  <div className="flex items-center gap-2">
                    <img src="/radar-icon.png" className="h-4 w-4 object-contain" alt="" />
                    <span className="text-gray-300">{radarInfo.name} 레이더</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="h-px w-5 bg-[rgb(100,200,255)]/40" />
                    <span className="text-gray-300">동심원 ({radarInfo.rangeNm}NM)</span>
                  </div>
                </>
              )}
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

              <span className="min-w-[70px] text-center font-mono text-xs text-gray-400">
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

              <span className="min-w-[70px] text-center font-mono text-xs text-gray-400">
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
              {/* Start time */}
              <span className="min-w-[70px] text-center font-mono text-xs text-[#e94560]">
                {fmtTs(pctToTs(rangeStart))}
              </span>

              {/* Range bar with dual handles */}
              <div
                ref={rangeBarRef}
                className="relative flex-1 h-6 select-none"
                onPointerMove={handleRangeMove}
                onPointerUp={handleRangeUp}
              >
                {/* Track background */}
                <div className="absolute left-0 right-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-white/10" />

                {/* Selected range highlight */}
                <div
                  className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-[#e94560]/40"
                  style={{
                    left: `${rangeStart}%`,
                    width: `${rangeEnd - rangeStart}%`,
                  }}
                />

                {/* Start handle */}
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

                {/* End handle */}
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

              {/* End time */}
              <span className="min-w-[70px] text-center font-mono text-xs text-[#e94560]">
                {fmtTs(pctToTs(rangeEnd))}
              </span>

              {/* Duration display */}
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
