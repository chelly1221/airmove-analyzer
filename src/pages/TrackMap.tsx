import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import MapGL, { NavigationControl } from "react-map-gl/maplibre";
import { DeckGLOverlay } from "../components/Map/DeckGLOverlay";
import { PathLayer, ScatterplotLayer, LineLayer } from "@deck.gl/layers";
import {
  Filter,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Info,
  Layers,
} from "lucide-react";
import { format } from "date-fns";
import { useAppStore } from "../store";
import type { TrackPoint, LossSegment } from "../types";
import "maplibre-gl/dist/maplibre-gl.css";

/** 트랙 색상 팔레트 (Mode-S별 구분) */
const TRACK_COLORS: [number, number, number][] = [
  [59, 130, 246],   // blue
  [16, 185, 129],   // emerald
  [245, 158, 11],   // amber
  [139, 92, 246],   // violet
  [236, 72, 153],   // pink
  [6, 182, 212],    // cyan
  [132, 204, 22],   // lime
  [249, 115, 22],   // orange
  [99, 102, 241],   // indigo
  [20, 184, 166],   // teal
];

type MapStyle = "carto-dark" | "osm";

const MAP_STYLES: Record<MapStyle, string> = {
  "carto-dark":
    "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  osm:
    "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
};

interface TrackPath {
  modeS: string;
  path: [number, number][];
  color: [number, number, number];
}

export default function TrackMap() {
  const analysisResults = useAppStore((s) => s.analysisResults);
  const aircraft = useAppStore((s) => s.aircraft);
  const selectedModeS = useAppStore((s) => s.selectedModeS);
  const setSelectedModeS = useAppStore((s) => s.setSelectedModeS);

  const [mapStyle, setMapStyle] = useState<MapStyle>("carto-dark");
  const [styleOpen, setStyleOpen] = useState(false);
  const [sliderValue, setSliderValue] = useState(100);
  const [playing, setPlaying] = useState(false);
  const [showLegend, setShowLegend] = useState(true);
  const [hoverInfo, setHoverInfo] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);
  const playRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fittedRef = useRef(false);
  const prevPointsLen = useRef(0);

  // 전체 포인트/Loss 합산
  const { allPoints, allLoss } = useMemo(() => {
    const pts: TrackPoint[] = [];
    const loss: LossSegment[] = [];
    for (const r of analysisResults) {
      for (const p of r.file_info.track_points) {
        if (!selectedModeS || p.mode_s === selectedModeS) {
          pts.push(p);
        }
      }
      if (!selectedModeS) {
        loss.push(...r.loss_segments);
      } else {
        loss.push(
          ...r.loss_segments.filter((s) => s.mode_s === selectedModeS)
        );
      }
    }
    pts.sort((a, b) => a.timestamp - b.timestamp);
    return { allPoints: pts, allLoss: loss };
  }, [analysisResults, selectedModeS]);

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

  const currentTimestamp = useMemo(() => {
    if (allPoints.length === 0) return 0;
    const range = timeRange.max - timeRange.min;
    return timeRange.min + (range * sliderValue) / 100;
  }, [sliderValue, timeRange, allPoints.length]);

  // 재생
  useEffect(() => {
    if (playing) {
      playRef.current = setInterval(() => {
        setSliderValue((v) => {
          if (v >= 100) {
            setPlaying(false);
            return 100;
          }
          return Math.min(v + 0.5, 100);
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
  }, [playing]);

  // Auto fit bounds
  const [viewState, setViewState] = useState({
    longitude: 127.0,
    latitude: 36.5,
    zoom: 6,
    pitch: 0,
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

  // Mode-S별 트랙 패스 데이터 (GPU용 - 다운샘플링 없음)
  const trackPaths: TrackPath[] = useMemo(() => {
    const groups = new Map<string, TrackPoint[]>();
    const maxTs = sliderValue < 100 ? currentTimestamp : Infinity;

    for (const p of allPoints) {
      if (p.timestamp > maxTs) continue;
      let arr = groups.get(p.mode_s);
      if (!arr) {
        arr = [];
        groups.set(p.mode_s, arr);
      }
      arr.push(p);
    }

    const paths: TrackPath[] = [];
    let colorIdx = 0;
    for (const [modeS, pts] of groups) {
      if (pts.length < 2) continue;
      paths.push({
        modeS,
        path: pts.map((p) => [p.longitude, p.latitude]),
        color: TRACK_COLORS[colorIdx % TRACK_COLORS.length],
      });
      colorIdx++;
    }
    return paths;
  }, [allPoints, sliderValue, currentTimestamp]);

  // Loss 데이터
  const filteredLoss = useMemo(() => {
    if (sliderValue >= 100) return allLoss;
    return allLoss.filter((s) => s.start_time <= currentTimestamp);
  }, [allLoss, sliderValue, currentTimestamp]);

  // deck.gl 레이어
  const deckLayers = useMemo(() => {
    const layers = [];

    // 항적 경로 (PathLayer - GPU)
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
        jointRounded: true,
        capRounded: true,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 80],
        onHover: (info) => {
          if (info.object) {
            setHoverInfo({
              x: info.x,
              y: info.y,
              text: `Mode-S: ${info.object.modeS} (${
                info.object.path.length
              } pts)`,
            });
          } else {
            setHoverInfo(null);
          }
        },
      })
    );

    // Loss 구간 라인 (LineLayer - GPU)
    if (filteredLoss.length > 0) {
      layers.push(
        new LineLayer<LossSegment>({
          id: "loss-lines",
          data: filteredLoss,
          getSourcePosition: (d) => [d.start_lon, d.start_lat],
          getTargetPosition: (d) => [d.end_lon, d.end_lat],
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
                text: `Loss: ${s.duration_secs.toFixed(1)}s / ${s.distance_km.toFixed(2)}km / ${s.last_altitude.toFixed(0)}m`,
              });
            } else {
              setHoverInfo(null);
            }
          },
        })
      );

      // Loss 시작점 (ScatterplotLayer - GPU)
      layers.push(
        new ScatterplotLayer<LossSegment>({
          id: "loss-start",
          data: filteredLoss,
          getPosition: (d) => [d.start_lon, d.start_lat],
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

      // Loss 종료점
      layers.push(
        new ScatterplotLayer<LossSegment>({
          id: "loss-end",
          data: filteredLoss,
          getPosition: (d) => [d.end_lon, d.end_lat],
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

    return layers;
  }, [trackPaths, filteredLoss]);

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

  return (
    <div className="flex h-full flex-col">
      {/* Top toolbar */}
      <div className="flex items-center gap-3 border-b border-white/10 bg-[#0d1b2a] px-4 py-3">
        <h1 className="text-lg font-bold text-white">항적 지도</h1>
        <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-400">
          GPU
        </span>
        <div className="h-5 w-px bg-white/10" />

        {/* Aircraft filter */}
        <div className="flex items-center gap-2">
          <Filter size={14} className="text-gray-400" />
          <select
            value={selectedModeS ?? ""}
            onChange={(e) => setSelectedModeS(e.target.value || null)}
            className="rounded-lg border border-white/10 bg-[#16213e] px-3 py-1.5 text-sm text-white outline-none focus:border-[#e94560]/50"
          >
            <option value="">전체 항적</option>
            {uniqueModeS.map((ms) => (
              <option key={ms} value={ms}>
                {getAircraftName(ms)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex-1" />

        {/* Stats */}
        <div className="flex items-center gap-4 text-xs text-gray-400">
          <span>포인트: {allPoints.length.toLocaleString()}</span>
          <span>Loss: {allLoss.length}건</span>
        </div>

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
          {...viewState}
          onMove={(evt) => setViewState(evt.viewState)}
          mapStyle={MAP_STYLES[mapStyle]}
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
        <div
          className="absolute right-3 top-3 z-[1000]"
        >
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
          <div className="absolute bottom-20 left-3 z-[1000] rounded-lg border border-white/20 bg-[#16213e]/95 p-3 shadow-lg backdrop-blur">
            <h3 className="mb-2 text-xs font-semibold text-white">범례</h3>
            <div className="space-y-1.5 text-xs">
              <div className="flex items-center gap-2">
                <div className="h-0.5 w-5 bg-blue-500" />
                <span className="text-gray-300">정상 항적</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-0.5 w-5 bg-[#e94560]" />
                <span className="text-gray-300">Loss 구간</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-2.5 w-2.5 rounded-full bg-[#e94560]" />
                <span className="text-gray-300">Loss 시작점</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-2.5 w-2.5 rounded-full bg-[#ff8a80]" />
                <span className="text-gray-300">Loss 종료점</span>
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
                자료 업로드에서 ASS 파일을 파싱하세요
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Time slider / playback controls */}
      {allPoints.length > 0 && (
        <div className="flex items-center gap-3 border-t border-white/10 bg-[#0d1b2a] px-4 py-3">
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
            {playing ? (
              <Pause size={14} />
            ) : (
              <Play size={14} className="ml-0.5" />
            )}
          </button>
          <button
            onClick={() => setSliderValue(100)}
            className="rounded p-1 text-gray-400 hover:text-white transition-colors"
            title="끝으로"
          >
            <SkipForward size={16} />
          </button>

          <span className="min-w-[70px] text-center font-mono text-xs text-gray-400">
            {timeRange.min > 0
              ? format(new Date(currentTimestamp * 1000), "HH:mm:ss")
              : "--:--:--"}
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
            {timeRange.max > 0
              ? format(new Date(timeRange.max * 1000), "HH:mm:ss")
              : "--:--:--"}
          </span>

          <span className="min-w-[40px] text-right font-mono text-xs text-gray-500">
            {sliderValue.toFixed(0)}%
          </span>
        </div>
      )}
    </div>
  );
}
