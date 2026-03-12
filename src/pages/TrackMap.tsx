import { useState, useMemo, useEffect, useRef } from "react";
import {
  MapContainer,
  TileLayer,
  useMap,
} from "react-leaflet";
import {
  Filter,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Info,
} from "lucide-react";
import { format } from "date-fns";
import TrackLayer from "../components/Map/TrackLayer";
import LossMarkers from "../components/Map/LossMarkers";
import MapStyleToggle, {
  MAP_TILE_URLS,
  type MapStyle,
} from "../components/Map/MapStyleToggle";
import { useAppStore } from "../store";
import type { TrackPoint, LossSegment } from "../types";

/** 지도 타일 교체 컴포넌트 */
function TileUpdater({ style }: { style: MapStyle }) {
  const map = useMap();
  const tile = MAP_TILE_URLS[style];

  useEffect(() => {
    // react-leaflet 의 TileLayer 는 key 교체로 처리
    map.invalidateSize();
  }, [map, style]);

  return (
    <TileLayer
      key={style}
      url={tile.url}
      attribution={tile.attribution}
    />
  );
}

/** 데이터에 맞춰 지도 범위 자동 조정 */
function FitBounds({ points }: { points: TrackPoint[] }) {
  const map = useMap();
  const fitted = useRef(false);

  useEffect(() => {
    if (points.length > 0 && !fitted.current) {
      let minLat = Infinity, maxLat = -Infinity;
      let minLon = Infinity, maxLon = -Infinity;
      for (const p of points) {
        if (p.latitude < minLat) minLat = p.latitude;
        if (p.latitude > maxLat) maxLat = p.latitude;
        if (p.longitude < minLon) minLon = p.longitude;
        if (p.longitude > maxLon) maxLon = p.longitude;
      }
      map.fitBounds([[minLat, minLon], [maxLat, maxLon]], { padding: [40, 40] });
      fitted.current = true;
    }
  }, [map, points]);

  useEffect(() => {
    fitted.current = false;
  }, [points.length]);

  return null;
}

export default function TrackMap() {
  const analysisResults = useAppStore((s) => s.analysisResults);
  const aircraft = useAppStore((s) => s.aircraft);
  const selectedModeS = useAppStore((s) => s.selectedModeS);
  const setSelectedModeS = useAppStore((s) => s.setSelectedModeS);

  const [mapStyle, setMapStyle] = useState<MapStyle>("carto-dark");
  const [sliderValue, setSliderValue] = useState(100);
  const [playing, setPlaying] = useState(false);
  const [showLegend, setShowLegend] = useState(true);
  const playRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // 고유 Mode-S 목록 (포인트 수 기준으로 정렬, 최소 10개 이상만)
  const uniqueModeS = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of analysisResults) {
      for (const p of r.file_info.track_points) {
        counts.set(p.mode_s, (counts.get(p.mode_s) ?? 0) + 1);
      }
    }
    // Show registered aircraft first, then top Mode-S codes by point count
    const registered = new Set(aircraft.map((a) => a.mode_s_code.toUpperCase()));
    return Array.from(counts.entries())
      .filter(([, count]) => count >= 10)
      .sort(([a, ca], [b, cb]) => {
        const aReg = registered.has(a) ? 1 : 0;
        const bReg = registered.has(b) ? 1 : 0;
        if (aReg !== bReg) return bReg - aReg;
        return cb - ca;
      })
      .slice(0, 200) // Limit dropdown to top 200
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

  // Aircraft name lookup
  const getAircraftName = (modeS: string): string => {
    const a = aircraft.find(
      (ac) => ac.mode_s_code.toLowerCase() === modeS.toLowerCase()
    );
    return a ? `${a.name} (${modeS})` : modeS;
  };

  // 한국 중심 기본 좌표
  const defaultCenter: [number, number] = [36.5, 127.0];

  return (
    <div className="flex h-full flex-col">
      {/* Top toolbar */}
      <div className="flex items-center gap-3 border-b border-white/10 bg-[#0d1b2a] px-4 py-3">
        <h1 className="text-lg font-bold text-white">항적 지도</h1>
        <div className="h-5 w-px bg-white/10" />

        {/* Aircraft filter */}
        <div className="flex items-center gap-2">
          <Filter size={14} className="text-gray-400" />
          <select
            value={selectedModeS ?? ""}
            onChange={(e) =>
              setSelectedModeS(e.target.value || null)
            }
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
        <MapContainer
          center={defaultCenter}
          zoom={7}
          className="h-full w-full"
          zoomControl={true}
        >
          <TileUpdater style={mapStyle} />
          <FitBounds points={allPoints} />
          <TrackLayer
            points={allPoints}
            maxTimestamp={sliderValue < 100 ? currentTimestamp : undefined}
          />
          <LossMarkers
            segments={allLoss}
            maxTimestamp={sliderValue < 100 ? currentTimestamp : undefined}
          />
        </MapContainer>

        {/* Map style toggle */}
        <MapStyleToggle style={mapStyle} onChange={setMapStyle} />

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
                <div
                  className="h-0.5 w-5"
                  style={{
                    backgroundImage:
                      "repeating-linear-gradient(90deg, #e94560 0, #e94560 4px, transparent 4px, transparent 7px)",
                  }}
                />
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
          {/* Playback buttons */}
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

          {/* Time display */}
          <span className="min-w-[70px] text-center font-mono text-xs text-gray-400">
            {timeRange.min > 0
              ? format(new Date(currentTimestamp * 1000), "HH:mm:ss")
              : "--:--:--"}
          </span>

          {/* Slider */}
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

          {/* End time */}
          <span className="min-w-[70px] text-center font-mono text-xs text-gray-400">
            {timeRange.max > 0
              ? format(new Date(timeRange.max * 1000), "HH:mm:ss")
              : "--:--:--"}
          </span>

          {/* Percentage */}
          <span className="min-w-[40px] text-right font-mono text-xs text-gray-500">
            {sliderValue.toFixed(0)}%
          </span>
        </div>
      )}
    </div>
  );
}
