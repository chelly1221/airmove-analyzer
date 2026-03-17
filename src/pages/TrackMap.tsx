import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import MapGL, { NavigationControl, type MapRef } from "react-map-gl/maplibre";
import type maplibregl from "maplibre-gl";
import { DeckGLOverlay } from "../components/Map/DeckGLOverlay";
import { PathLayer, ScatterplotLayer, LineLayer, IconLayer, PolygonLayer } from "@deck.gl/layers";
import {
  Play,
  Pause,
  Mountain,
  Crosshair,
  ChevronDown,
  Radar,
  Plane,
  Loader2,
  Cloud,
  Building2,
  X,
} from "lucide-react";

/** Dot 모드 핀 아이콘 (가느다란 선 위에 원) */
const DotPinIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <circle cx="8" cy="4" r="2.5" />
    <line x1="8" y1="6.5" x2="8" y2="14" />
  </svg>
);

/** 커버리지 맵 아이콘 (날카로운 별 형태 — 레이더 커버리지 불규칙 경계 느낌) */
const CoverageIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round">
    <polygon points="8,0.2 9,3.5 11.5,0.8 10.5,4.2 14.5,2 11.5,5 15.8,5.5 12,6.8 15.5,9 11.5,8.5 14,12 10.5,9.5 10,13.5 8.5,10 7,15 7,10.5 4,13.5 5.5,9.5 1.5,11.5 4.5,8.2 0.2,8.5 4,6.5 0.5,4.5 4.2,5 2,1.8 5.5,4 6,0.8 7,4" />
  </svg>
);
import { format } from "date-fns";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import type { TrackPoint, LossSegment, LossPoint, AdsbTrack } from "../types";
import LOSProfilePanel from "../components/Map/LOSProfilePanel";
import { computeCoverageTerrainProfile, computeLayerFromProfile, getCachedTerrainProfile, invalidateTerrainCache, isCacheValidFor, COVERAGE_MIN_ALT_FT, COVERAGE_MAX_ALT_FT, COVERAGE_ALT_STEP_FT, type CoverageTerrainProfile, type CoverageLayer } from "../utils/radarCoverage";
import { fetchCloudGridKorea, getCloudFrameAtTime, fetchHistoricalWeather } from "../utils/weatherFetch";

/**
 * 탐지 유형 색상:
 *   Roll-Call = 파란색, All-Call + PSR = 연두색, All-Call only = 하늘색
 *   A/C 계열 = 노란색
 */
const DETECTION_TYPE_COLORS: Record<string, [number, number, number]> = {
  mode_ac:              [234, 179, 8],    // yellow
  mode_ac_psr:          [234, 179, 8],    // yellow
  mode_s_allcall:       [56, 189, 248],   // sky blue (하늘색)
  mode_s_allcall_psr:   [132, 204, 22],   // lime green (연두색)
  mode_s_rollcall:      [59, 130, 246],   // blue (파란색)
  mode_s_rollcall_psr:  [34, 197, 94],    // green (초록색)
};


/** 탐지 유형 라벨 */
function radarTypeLabel(rt: string): string {
  switch (rt) {
    case "mode_ac":              return "Mode A/C";
    case "mode_ac_psr":          return "Mode A/C + PSR";
    case "mode_s_allcall":       return "Mode S All-Call";
    case "mode_s_allcall_psr":   return "Mode S All-Call + PSR";
    case "mode_s_rollcall":      return "Mode S Roll-Call";
    case "mode_s_rollcall_psr":  return "Mode S Roll-Call + PSR";
    default:                     return rt.toUpperCase();
  }
}

/** 탐지 유형 색상 조회 */
function detectionTypeColor(rt: string): [number, number, number] {
  return DETECTION_TYPE_COLORS[rt] ?? [128, 128, 128];
}


const MAP_STYLE_URL = "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json";

const SPEED_OPTIONS = [1, 60, 120, 300];

interface TrackPath {
  modeS: string;
  radarType: string;
  path: ([number, number] | [number, number, number])[];
  color: [number, number, number];
  avgAlt: number;
  pointCount: number;
}

export default function TrackMap() {
  const flights = useAppStore((s) => s.flights);
  const aircraft = useAppStore((s) => s.aircraft);
  const radarSite = useAppStore((s) => s.radarSite);
  const setRadarSite = useAppStore((s) => s.setRadarSite);
  const customRadarSites = useAppStore((s) => s.customRadarSites);
  const selectedModeS = useAppStore((s) => s.selectedModeS);
  const setSelectedModeS = useAppStore((s) => s.setSelectedModeS);
  const selectedFlightId = useAppStore((s) => s.selectedFlightId);
  const setSelectedFlightId = useAppStore((s) => s.setSelectedFlightId);
  const selectedFlight = useAppStore((s) => s.selectedFlight);
  const setSelectedFlight = useAppStore((s) => s.setSelectedFlight);
  const adsbTracks = useAppStore((s) => s.adsbTracks);
  const setAdsbTracks = useAppStore((s) => s.setAdsbTracks);
  const adsbLoading = useAppStore((s) => s.adsbLoading);
  const adsbProgress = useAppStore((s) => s.adsbProgress);
  // 기상/구름 데이터
  const cloudGrid = useAppStore((s) => s.cloudGrid);
  const setCloudGrid = useAppStore((s) => s.setCloudGrid);
  const cloudGridVisible = useAppStore((s) => s.cloudGridVisible);
  const setCloudGridVisible = useAppStore((s) => s.setCloudGridVisible);
  const cloudGridLoading = useAppStore((s) => s.cloudGridLoading);
  const setCloudGridLoading = useAppStore((s) => s.setCloudGridLoading);
  const cloudGridProgress = useAppStore((s) => s.cloudGridProgress);
  const setCloudGridProgress = useAppStore((s) => s.setCloudGridProgress);
  const setWeatherData = useAppStore((s) => s.setWeatherData);
  const setWeatherLoading = useAppStore((s) => s.setWeatherLoading);

  const [sliderValue, setSliderValue] = useState(100);
  const [playing, setPlaying] = useState(false);
  const altScale = 1;
  const [dotMode, setDotMode] = useState(false);
  const [showBuildings, setShowBuildings] = useState(false);
  const [buildingOverlayData, setBuildingOverlayData] = useState<{ lat: number; lon: number; height_m: number; name: string | null; address: string | null; usage: string | null; source: string }[]>([]);
  const [buildingsLoading, setBuildingsLoading] = useState(false);
  const [losBuildingHighlight, setLosBuildingHighlight] = useState<{ lat: number; lon: number; height_m: number; name: string | null; address: string | null; usage: string | null } | null>(null);
  const [detailBuilding, setDetailBuilding] = useState<{ lat: number; lon: number; height_m: number; ground_elev_m: number; name: string | null; address: string | null; usage: string | null; distance_km: number; isBlocking?: boolean } | null>(null);
  const [playSpeed, setPlaySpeed] = useState(1);
  const [rangeStart, setRangeStart] = useState(0);
  /** 재생 모드 트레일 길이 (초). 0=전체 표시, >0=최근 N초만 표시 */
  const [trailDuration, setTrailDuration] = useState(0);

  // 비행 선택 시 시간 바 리셋 (전체 범위 표시)
  useEffect(() => {
    setSliderValue(100);
    setRangeStart(0);
    setPlaying(false);
  }, [selectedFlightId]);
  const [hoverInfo, setHoverInfo] = useState<{
    x: number;
    y: number;
    lines: { label: string; value: string; color?: string }[];
  } | null>(null);
  const [terrainEnabled, setTerrainEnabled] = useState(true);
  const [modeSSearch, setModeSSearch] = useState("");
  const [aircraftDropOpen, setAircraftDropOpen] = useState(false);
  const [radarDropOpen, setRadarDropOpen] = useState(false);
  const [speedDropOpen, setSpeedDropOpen] = useState(false);
  const [trailDropOpen, setTrailDropOpen] = useState(false);

  // 레이더 커버리지 (범위 슬라이더: min~max)
  const [coverageAlt, setCoverageAlt] = useState(10000); // 커버리지 최대 고도 (ft)
  const [coverageAltMin, setCoverageAltMin] = useState(COVERAGE_MIN_ALT_FT); // 커버리지 최소 고도 (ft)
  const [coverageAltInput, setCoverageAltInput] = useState(10000); // 디바운스용 최대 입력값
  const [coverageAltMinInput, setCoverageAltMinInput] = useState(COVERAGE_MIN_ALT_FT); // 디바운스용 최소 입력값
  const [terrainProfile, setTerrainProfile] = useState<CoverageTerrainProfile | null>(null);
  const [coverageLayers, setCoverageLayers] = useState<CoverageLayer[]>([]);
  const coverageVisible = useAppStore((s) => s.coverageVisible);
  const setCoverageVisible = useAppStore((s) => s.setCoverageVisible);
  const coverageLoading = useAppStore((s) => s.coverageLoading);
  const setCoverageLoading = useAppStore((s) => s.setCoverageLoading);
  const coverageProgress = useAppStore((s) => s.coverageProgress);
  const setCoverageProgress = useAppStore((s) => s.setCoverageProgress);
  const coverageProgressPct = useAppStore((s) => s.coverageProgressPct);
  const setCoverageProgressPct = useAppStore((s) => s.setCoverageProgressPct);
  const coverageError = useAppStore((s) => s.coverageError);
  const setCoverageError = useAppStore((s) => s.setCoverageError);
  const setCoverageData = useAppStore((s) => s.setCoverageData);
  const [showConeOfSilence, setShowConeOfSilence] = useState(true);
  const coverageAltRef = useRef<HTMLDivElement>(null);
  const [coverageModalOpen, setCoverageModalOpen] = useState(false);
  const coverageAltTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const coverageAltMinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // LOS Analysis state
  const [losMode, setLosMode] = useState(false);
  const [losTarget, setLosTarget] = useState<{ lat: number; lon: number } | null>(null);
  const [losCursor, setLosCursor] = useState<{ lat: number; lon: number } | null>(null);
  const [losHoverRatio, setLosHoverRatio] = useState<number | null>(null);
  const [losHighlightIdx, setLosHighlightIdx] = useState<number | null>(null);
  const [losHoverIdx, setLosHoverIdx] = useState<number | null>(null);
  const savedTerrainRef = useRef(true); // LOS 모드 진입 전 지형 상태 저장
  const savedPitchRef = useRef(45);
  const savedBearingRef = useRef(0);
  const losPointClickedRef = useRef(false); // deck.gl LOS 포인트 클릭 여부 (빈 영역 클릭 구분용)

  const mapRef = useRef<MapRef>(null);
  const terrainAdded = useRef(false);
  const playRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cloudAbortRef = useRef<AbortController | null>(null);
  const aircraftDropRef = useRef<HTMLDivElement>(null);
  const radarDropRef = useRef<HTMLDivElement>(null);
  const speedRef = useRef<HTMLDivElement>(null);
  const trailRef = useRef<HTMLDivElement>(null);
  const fittedRef = useRef(false);
  const prevPointsLen = useRef(0);

  // 선택된 레이더용 비행만 필터 (radar_name이 없는 레거시 데이터는 항상 표시)
  const radarFilteredFlights = useMemo(() => {
    const name = radarSite.name;
    return flights.filter((f) => !f.radar_name || f.radar_name === name);
  }, [flights, radarSite.name]);

  // DB에서 ADS-B 트랙 로드 (비행 데이터 변경 시)
  useEffect(() => {
    if (radarFilteredFlights.length === 0) return;
    const icao24List = aircraft.filter((a) => a.active).map((a) => a.mode_s_code);
    if (icao24List.length === 0) return;
    let minTs = Infinity, maxTs = -Infinity;
    for (const f of radarFilteredFlights) {
      if (f.start_time < minTs) minTs = f.start_time;
      if (f.end_time > maxTs) maxTs = f.end_time;
    }
    if (minTs === Infinity) return;
    invoke<AdsbTrack[]>("load_adsb_tracks_for_range", {
      icao24_list: icao24List, start: minTs, end: maxTs,
    }).then((tracks) => {
      if (tracks.length > 0) setAdsbTracks(tracks);
    }).catch(() => {});
  }, [radarFilteredFlights, aircraft]); // eslint-disable-line react-hooks/exhaustive-deps

  // 레이더 정보
  const radarInfo = useMemo(() => {
    if (radarFilteredFlights.length === 0) return null;
    const maxRange = Math.max(...radarFilteredFlights.map((f) => f.max_radar_range_km));
    const rangeKm = radarSite.range_nm > 0
      ? radarSite.range_nm * 1.852
      : maxRange;
    return {
      lat: radarSite.latitude,
      lon: radarSite.longitude,
      maxRange: rangeKm,
      rangeNm: radarSite.range_nm,
      name: radarSite.name,
    };
  }, [radarFilteredFlights, radarSite]);

  // 비정상 항적 제거용: Mode-S별 포인트 수 카운트
  const validModeS = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of radarFilteredFlights) {
      for (const p of f.track_points) {
        counts.set(p.mode_s, (counts.get(p.mode_s) ?? 0) + 1);
      }
    }
    return new Set(
      Array.from(counts.entries())
        .filter(([, count]) => count >= 10)
        .map(([ms]) => ms)
    );
  }, [radarFilteredFlights]);

  // 등록된 비행검사기 Mode-S 코드 집합
  const registeredModeS = useMemo(
    () => new Set(aircraft.filter((a) => a.active).map((a) => a.mode_s_code.toUpperCase())),
    [aircraft]
  );

  // 전체 포인트/Loss 합산 (비정상 항적 + UNKNOWN 제거)
  // selectedFlightId → 해당 비행만, selectedFlight(시간범위) → 시간 필터, selectedModeS: null → 등록 비행검사기만, "__ALL__" → 전체, 그 외 → 해당 Mode-S 전체
  const { allPoints, allLoss, allLossPoints, paddedTimeRange } = useMemo(() => {
    const pts: TrackPoint[] = [];
    const loss: LossSegment[] = [];
    const lossP: LossPoint[] = [];

    // 특정 비행 선택 시 해당 비행 + 앞뒤 1시간 여유 시간 범위 표시
    if (selectedFlightId) {
      const targetFlight = radarFilteredFlights.find((f) => f.id === selectedFlightId);
      if (targetFlight) {
        const padding = 3600;
        const tMin = targetFlight.start_time - padding;
        const tMax = targetFlight.end_time + padding;
        const targetModeS = targetFlight.mode_s;
        for (const f of radarFilteredFlights) {
          for (const p of f.track_points) {
            if (!validModeS.has(p.mode_s)) continue;
            if (p.mode_s === targetModeS && p.timestamp >= tMin && p.timestamp <= tMax) {
              pts.push(p);
            }
          }
          loss.push(...f.loss_segments.filter((s) =>
            validModeS.has(s.mode_s) && s.mode_s === targetModeS && s.start_time >= tMin && s.end_time <= tMax
          ));
          lossP.push(...f.loss_points.filter((p) =>
            validModeS.has(p.mode_s) && p.mode_s === targetModeS && p.timestamp >= tMin && p.timestamp <= tMax
          ));
        }
      }
      pts.sort((a, b) => a.timestamp - b.timestamp);
      const tFlight = radarFilteredFlights.find((f) => f.id === selectedFlightId);
      const padded = tFlight ? { min: tFlight.start_time - 3600, max: tFlight.end_time + 3600 } : undefined;
      return { allPoints: pts, allLoss: loss, allLossPoints: lossP, paddedTimeRange: padded };
    }

    // 사이드바에서 비행 선택했지만 store Flight 매칭 실패 시 → 시간 범위로 필터링 (1시간 여유)
    if (selectedFlight && selectedModeS) {
      const padding = 3600;
      const tMin = selectedFlight.first_seen - padding;
      const tMax = selectedFlight.last_seen + padding;
      const modeS = selectedModeS;
      for (const f of radarFilteredFlights) {
        for (const p of f.track_points) {
          if (!validModeS.has(p.mode_s)) continue;
          if (p.mode_s === modeS && p.timestamp >= tMin && p.timestamp <= tMax) {
            pts.push(p);
          }
        }
        loss.push(...f.loss_segments.filter((s) =>
          s.mode_s === modeS && s.start_time >= tMin && s.end_time <= tMax
        ));
        lossP.push(...f.loss_points.filter((p) =>
          p.mode_s === modeS && p.timestamp >= tMin && p.timestamp <= tMax
        ));
      }
      pts.sort((a, b) => a.timestamp - b.timestamp);
      return { allPoints: pts, allLoss: loss, allLossPoints: lossP, paddedTimeRange: { min: tMin, max: tMax } };
    }

    const showAll = selectedModeS === "__ALL__";
    for (const f of radarFilteredFlights) {
      for (const p of f.track_points) {
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
        loss.push(...f.loss_segments.filter((s) => validModeS.has(s.mode_s)));
        lossP.push(...f.loss_points.filter((p) => validModeS.has(p.mode_s)));
      } else if (!selectedModeS) {
        loss.push(...f.loss_segments.filter((s) => validModeS.has(s.mode_s) && registeredModeS.has(s.mode_s.toUpperCase())));
        lossP.push(...f.loss_points.filter((p) => validModeS.has(p.mode_s) && registeredModeS.has(p.mode_s.toUpperCase())));
      } else {
        loss.push(
          ...f.loss_segments.filter((s) => s.mode_s === selectedModeS)
        );
        lossP.push(
          ...f.loss_points.filter((p) => p.mode_s === selectedModeS)
        );
      }
    }
    pts.sort((a, b) => a.timestamp - b.timestamp);
    return { allPoints: pts, allLoss: loss, allLossPoints: lossP, paddedTimeRange: undefined as { min: number; max: number } | undefined };
  }, [radarFilteredFlights, selectedModeS, selectedFlightId, selectedFlight, validModeS, registeredModeS]);

  // 고유 Mode-S 목록
  const uniqueModeS = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of radarFilteredFlights) {
      for (const p of f.track_points) {
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
  }, [radarFilteredFlights, aircraft]);

  // 시간 범위 (비행 선택 시 ±1시간 패딩 포함)
  const timeRange = useMemo(() => {
    if (allPoints.length === 0 && !paddedTimeRange) return { min: 0, max: 0 };
    const pointMin = allPoints.length > 0 ? allPoints[0].timestamp : Infinity;
    const pointMax = allPoints.length > 0 ? allPoints[allPoints.length - 1].timestamp : -Infinity;
    return {
      min: paddedTimeRange ? Math.min(paddedTimeRange.min, pointMin) : pointMin,
      max: paddedTimeRange ? Math.max(paddedTimeRange.max, pointMax) : pointMax,
    };
  }, [allPoints, paddedTimeRange]);

  // 퍼센트 → 타임스탬프
  const pctToTs = useCallback(
    (pct: number) => {
      const range = timeRange.max - timeRange.min;
      return timeRange.min + (range * pct) / 100;
    },
    [timeRange]
  );

  // 현재 표시 범위: rangeStart ~ sliderValue
  const { visibleMinTs, visibleMaxTs } = useMemo(() => {
    const maxTs = sliderValue >= 100 ? Infinity : pctToTs(sliderValue);
    const minTs = trailDuration > 0 && maxTs !== Infinity
      ? Math.max(pctToTs(rangeStart), maxTs - trailDuration)
      : pctToTs(rangeStart);
    return { visibleMinTs: minTs, visibleMaxTs: maxTs };
  }, [sliderValue, rangeStart, timeRange, pctToTs, trailDuration]);

  // 재생 (실제 시간 기준 배속)
  useEffect(() => {
    if (playing) {
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
  }, [playing, playSpeed, timeRange]);

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
    // 보고서 캡처용으로 맵 인스턴스를 window에 노출
    (window as any).__maplibreInstance = map;
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

  // 레이더 사이트 변경 시 커버리지 캐시 무효화 (이름+좌표+고도 모두 비교)
  useEffect(() => {
    if (!isCacheValidFor(radarSite)) {
      setTerrainProfile(null);
      setCoverageLayers([]);
      setCoverageVisible(false);
      setCoverageError("");
    }
  }, [radarSite.name, radarSite.latitude, radarSite.longitude, radarSite.altitude, radarSite.antenna_height]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 고도 비율 → 색상 스펙트럼 매핑 (HSL 0°→240° : 빨강→파랑) */
  const altToColor = useCallback((altFt: number): [number, number, number] => {
    const t = Math.min(1, Math.max(0, (altFt - COVERAGE_MIN_ALT_FT) / (COVERAGE_MAX_ALT_FT - COVERAGE_MIN_ALT_FT)));
    const hue = t * 240; // 0°(red) → 60°(yellow) → 120°(green) → 180°(cyan) → 240°(blue)
    const s = 0.85, l = 0.5;
    // HSL → RGB 변환
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = l - c / 2;
    let r1: number, g1: number, b1: number;
    if (hue < 60)       { r1 = c; g1 = x; b1 = 0; }
    else if (hue < 120) { r1 = x; g1 = c; b1 = 0; }
    else if (hue < 180) { r1 = 0; g1 = c; b1 = x; }
    else if (hue < 240) { r1 = 0; g1 = x; b1 = c; }
    else                { r1 = 0; g1 = 0; b1 = c; }
    return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
  }, []);

  // 커버리지 deck.gl 데이터 (합성 스펙트럼: 동심 링 방식)
  const coveragePolygonsList = useMemo(() => {
    if (!coverageVisible || coverageLayers.length === 0) return null;
    const rLat = radarSite.latitude;
    const rLon = radarSite.longitude;
    const CONE_PTS = 72;

    const isSingle = coverageLayers.length === 1;

    // 고도순 정렬 (낮→높 = 좁→넓)
    const sorted = [...coverageLayers].sort((a, b) => a.altitudeFt - b.altitudeFt);

    return sorted.map((layer, idx) => {
      const altM = layer.altitudeM;
      const zVal = isSingle ? altM * altScale : 0;
      const outerRing: [number, number, number][] = layer.bearings.map((b) => [b.lon, b.lat, zVal]);
      if (outerRing.length > 0) outerRing.push(outerRing[0]);

      const polygon: [number, number, number][][] = [outerRing];
      let coneRing: [number, number, number][] | null = null;

      // 범위 모드: 안쪽 레이어(이전 고도)를 구멍으로 뚫어 동심 링 생성
      const innerLayer = !isSingle && idx > 0 ? sorted[idx - 1] : null;
      if (innerLayer) {
        const innerHole: [number, number, number][] = innerLayer.bearings.map((b) => [b.lon, b.lat, zVal]);
        if (innerHole.length > 0) innerHole.push(innerHole[0]);
        innerHole.reverse(); // 홀은 반시계 방향
        polygon.push(innerHole);
      }

      // 최내곽 레이어(idx===0)에만 Cone of Silence 구멍 적용
      if (showConeOfSilence && layer.coneRadiusKm > 0.5 && (isSingle || idx === 0)) {
        const hole: [number, number, number][] = [];
        for (let i = CONE_PTS; i >= 0; i--) {
          const deg = (i / CONE_PTS) * 360;
          const rad = (deg * Math.PI) / 180;
          const dLat = (layer.coneRadiusKm / 6371) * (180 / Math.PI);
          const lat = rLat + dLat * Math.cos(rad);
          const lon = rLon + (dLat / Math.cos((rLat * Math.PI) / 180)) * Math.sin(rad);
          hole.push([lon, lat, zVal]);
        }
        polygon.push(hole);
        coneRing = [];
        for (let i = 0; i <= CONE_PTS; i++) {
          const deg = (i / CONE_PTS) * 360;
          const rad = (deg * Math.PI) / 180;
          const dLat = (layer.coneRadiusKm / 6371) * (180 / Math.PI);
          const lat = rLat + dLat * Math.cos(rad);
          const lon = rLon + (dLat / Math.cos((rLat * Math.PI) / 180)) * Math.sin(rad);
          coneRing.push([lon, lat, zVal]);
        }
      }

      const fillColor = altToColor(layer.altitudeFt);
      return { polygon, outerRing, coneRing, fillColor, altM, altFt: layer.altitudeFt };
    });
  }, [coverageLayers, coverageVisible, altScale, radarSite, altToColor, showConeOfSilence]);

  // 구름 오버레이 데이터 — 규칙적 격자(grid) 방식: 운량에 비례하여 점 밀도 조절
  const cloudDots = useMemo(() => {
    if (!cloudGrid || !cloudGridVisible) return null;
    const currentTs = sliderValue >= 100 ? timeRange.max : pctToTs(sliderValue);
    const frame = getCloudFrameAtTime(cloudGrid, currentTs);
    if (!frame || frame.cells.length === 0) return null;

    const halfStep = (cloudGrid.gridSpacingKm / 111.32) * 0.5;

    const dots: { position: [number, number]; cover: number }[] = [];
    const GRID_SIZE = 12; // 셀당 12×12 = 144개 격자점 (운량 100%일 때)

    for (const c of frame.cells) {
      if (c.cloud_cover <= 10) continue;
      // 셀별 cosLat 사용 (한국 전역 커버 시 위도별 보정)
      const cellCosLat = Math.cos((c.lat * Math.PI) / 180);
      const halfStepLon = halfStep / cellCosLat;
      // 운량에 따라 격자 해상도 조절: 운량 낮으면 간격 넓게 (점 적게)
      const ratio = c.cloud_cover / 100;
      const effectiveSize = Math.max(3, Math.round(GRID_SIZE * Math.sqrt(ratio)));
      const stepLat = (halfStep * 2) / effectiveSize;
      const stepLon = (halfStepLon * 2) / effectiveSize;
      const baseLat = c.lat - halfStep + stepLat * 0.5;
      const baseLon = c.lon - halfStepLon + stepLon * 0.5;

      for (let row = 0; row < effectiveSize; row++) {
        for (let col = 0; col < effectiveSize; col++) {
          dots.push({
            position: [baseLon + col * stepLon, baseLat + row * stepLat],
            cover: c.cloud_cover,
          });
        }
      }
    }
    return dots;
  }, [cloudGrid, cloudGridVisible, sliderValue, timeRange.max, pctToTs]);

  /** 구름 그리드 조회 시작 (한국 전역, 백그라운드 역순 로딩, 비행 날짜만) */
  const startCloudFetch = useCallback(async () => {
    if (radarFilteredFlights.length === 0) return;

    // 비행 데이터에서 실제 존재하는 날짜만 추출
    const dateSet = new Set<string>();
    for (const f of radarFilteredFlights) {
      // 비행 시작~종료 사이의 모든 날짜 추가 (자정 걸치는 비행 대응)
      const d = new Date(f.start_time * 1000);
      const end = new Date(f.end_time * 1000);
      while (d <= end) {
        dateSet.add(d.toISOString().slice(0, 10));
        d.setUTCDate(d.getUTCDate() + 1);
      }
    }
    const flightDates = Array.from(dateSet);
    if (flightDates.length === 0) return;

    const startDate = flightDates.sort()[0];
    const endDate = flightDates[flightDates.length - 1];

    setCloudGridLoading(true);
    setCloudGridProgress("구름 데이터 조회 중...");

    try {
      // 기상 데이터 조회 (보고서용, 일 단위 캐싱)
      setWeatherLoading(true);
      const weather = await fetchHistoricalWeather(
        radarSite.latitude, radarSite.longitude, startDate, endDate,
        (msg) => setCloudGridProgress(msg),
      );
      setWeatherData(weather);
      setWeatherLoading(false);
    } catch (err) {
      console.error("기상 데이터 조회 실패:", err);
      setWeatherLoading(false);
    }

    // 한국 전역 구름 그리드 — 비행 날짜만, 백그라운드에서 당일→과거 순차 조회
    cloudAbortRef.current?.abort();
    const abort = new AbortController();
    cloudAbortRef.current = abort;

    setCloudGridVisible(true);

    fetchCloudGridKorea(
      10, flightDates,
      (data) => setCloudGrid(data),
      (msg) => setCloudGridProgress(msg),
      abort.signal,
    ).then(() => {
      setCloudGridLoading(false);
      setCloudGridProgress("");
    }).catch((err) => {
      if (!abort.signal.aborted) console.error("구름 데이터 조회 실패:", err);
      setCloudGridLoading(false);
      setCloudGridProgress("");
    });
  }, [radarFilteredFlights, radarSite, setCloudGrid, setCloudGridVisible, setCloudGridLoading, setCloudGridProgress, setWeatherData, setWeatherLoading]);

  /** 건물 오버레이 데이터 로드 (레이더 주변 bbox) */
  const fetchBuildingOverlay = useCallback(async () => {
    setBuildingsLoading(true);
    try {
      // 레이더 제원 범위 전체 (range_nm → degree 변환)
      const bufferDeg = (radarSite.range_nm * 1.852) / 111.0;
      const cosLat = Math.cos((radarSite.latitude * Math.PI) / 180);
      const bufferLon = bufferDeg / cosLat;
      const data = await invoke<{ lat: number; lon: number; height_m: number; name: string | null; address: string | null; usage: string | null; source: string }[]>(
        "query_buildings_for_overlay",
        {
          minLat: radarSite.latitude - bufferDeg,
          maxLat: radarSite.latitude + bufferDeg,
          minLon: radarSite.longitude - bufferLon,
          maxLon: radarSite.longitude + bufferLon,
          minHeightM: 3.0,
        }
      );
      setBuildingOverlayData(data);
      setShowBuildings(true);
    } catch (err) {
      console.error("건물 오버레이 로드 실패:", err);
    } finally {
      setBuildingsLoading(false);
    }
  }, [radarSite]);

  // 레이더 사이트 변경 시 건물 오버레이 초기화
  useEffect(() => {
    if (showBuildings && buildingOverlayData.length > 0) {
      fetchBuildingOverlay();
    }
  }, [radarSite.latitude, radarSite.longitude]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 커버리지 맵 계산 시작 — 지형 프로파일 한번 계산 후 캐시 (백그라운드 작동) */
  const startCoverageCompute = useCallback(async (force = false) => {
    setCoverageLoading(true);
    setCoverageError("");
    setCoverageProgressPct(0);
    setCoverageProgress("준비 중...");
    try {
      if (force) invalidateTerrainCache();

      const profile = await computeCoverageTerrainProfile(radarSite, (pct, msg) => {
        setCoverageProgressPct(pct);
        setCoverageProgress(msg);
      });
      setTerrainProfile(profile);
      setCoverageVisible(true);

      // DB에 대표 레이어 저장 (보고서 재활용)
      const repAlts = [500, 1000, 2000, 3000, 5000, 10000, 15000, 20000];
      const repLayers = repAlts.map((alt) => computeLayerFromProfile(profile, alt));
      setCoverageData({
        radarName: radarSite.name,
        radarLat: radarSite.latitude,
        radarLon: radarSite.longitude,
        radarAltitude: radarSite.altitude,
        antennaHeight: radarSite.antenna_height,
        maxElevDeg: profile.maxElevDeg,
        layers: repLayers,
        computedAt: Date.now(),
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("커버리지 계산 실패:", err);
      setCoverageError(`계산 실패: ${errMsg}`);
    } finally {
      setCoverageLoading(false);
      setCoverageProgress("");
      setCoverageProgressPct(0);
    }
  }, [radarSite, setCoverageLoading, setCoverageProgress, setCoverageProgressPct, setCoverageError, setCoverageVisible, setCoverageData]);

  // 슬라이더 디바운스: 입력값 변경 → 150ms 후 실제 고도 반영
  const handleCoverageAltChange = useCallback((val: number) => {
    setCoverageAltInput(val);
    if (coverageAltTimerRef.current) clearTimeout(coverageAltTimerRef.current);
    coverageAltTimerRef.current = setTimeout(() => setCoverageAlt(val), 150);
  }, []);
  const handleCoverageAltMinChange = useCallback((val: number) => {
    setCoverageAltMinInput(val);
    if (coverageAltMinTimerRef.current) clearTimeout(coverageAltMinTimerRef.current);
    coverageAltMinTimerRef.current = setTimeout(() => setCoverageAltMin(val), 150);
  }, []);

  // ESC 키로 모달 닫기
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && coverageModalOpen) setCoverageModalOpen(false);
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [coverageModalOpen]);

  // 고도 슬라이더 변경 시 레이어들 재계산 (최소~최대 고도 범위 겹침)
  useEffect(() => {
    const profile = terrainProfile || getCachedTerrainProfile();
    if (!profile || !coverageVisible) return;

    const effMin = Math.min(coverageAltMin, coverageAlt);
    const effMax = Math.max(coverageAltMin, coverageAlt);
    const range = effMax - effMin;
    let step: number;
    if (range <= 2000) step = COVERAGE_ALT_STEP_FT;
    else if (range <= 5000) step = 500;
    else step = 1000;

    const layers: CoverageLayer[] = [];
    // bearingStep=10: 0.1°×10 = 1° 간격 (3600→360 포인트, 시각적 차이 없음)
    for (let alt = effMin; alt <= effMax; alt += step) {
      layers.push(computeLayerFromProfile(profile, alt, 10));
    }
    if (layers.length === 0 || layers[layers.length - 1].altitudeFt !== effMax) {
      layers.push(computeLayerFromProfile(profile, effMax, 10));
    }
    setCoverageLayers(layers);
  }, [coverageAlt, coverageAltMin, terrainProfile, coverageVisible]);

  // Mode-S별 트랙 패스 데이터 (gap + radar_type 변경 시 분할)
  /** 1포인트 항적용 데이터 */
  interface SinglePoint {
    modeS: string;
    position: [number, number] | [number, number, number];
    color: [number, number, number];
    point: TrackPoint;
  }

  // mode_s → 색상 안정 매핑 (allPoints 기반, 정렬하여 슬라이더/필터 변경에도 색상 유지)

  const { trackPaths, singlePoints } = useMemo(() => {
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
    const singles: SinglePoint[] = [];
    for (const [modeS, pts] of groups) {
      if (pts.length === 1) {
        // 1포인트 항적: ScatterplotLayer용 데이터로 수집
        const p = pts[0];
        const color = detectionTypeColor(p.radar_type);
        singles.push({
          modeS,
          position: losMode ? [p.longitude, p.latitude] : [p.longitude, p.latitude, p.altitude * altScale],
          color,
          point: p,
        });
        continue;
      }

      // Loss 탐지 임계값과 동일하게 7초 이상 gap이면 세그먼트 분할
      const splitThreshold = 7;

      const totalAlts = pts.map((p) => p.altitude);
      const avgAlt = totalAlts.reduce((s, a) => s + a, 0) / totalAlts.length;

      // 1단계: 원시 세그먼트 수집 (start/end 인덱스)
      const rawSegs: { start: number; end: number }[] = [];
      let segStart = 0;
      for (let i = 1; i <= pts.length; i++) {
        const isEnd = i === pts.length;
        const hasGap = !isEnd && pts[i].timestamp - pts[i - 1].timestamp > splitThreshold;
        const typeChanged = !isEnd && pts[i].radar_type !== pts[i - 1].radar_type;

        if (isEnd || hasGap || typeChanged) {
          rawSegs.push({ start: segStart, end: i });
          if (typeChanged && !hasGap) {
            segStart = i - 1;
          } else {
            segStart = i;
          }
        }
      }

      // 2단계: 1-포인트 세그먼트를 인접 세그먼트에 병합 (solo dot 방지)
      // 단, 인접 세그먼트와의 gap이 splitThreshold 이하일 때만 병합
      // gap이 크면 Loss 구간이므로 진짜 싱글 타겟 → singles로 유지
      for (let s = 0; s < rawSegs.length; s++) {
        if (rawSegs[s].end - rawSegs[s].start === 1) {
          const singlePt = pts[rawSegs[s].start];
          const canMergeNext = s < rawSegs.length - 1 &&
            pts[rawSegs[s + 1].start].timestamp - singlePt.timestamp <= splitThreshold;
          const canMergePrev = s > 0 &&
            singlePt.timestamp - pts[rawSegs[s - 1].end - 1].timestamp <= splitThreshold;

          if (canMergeNext) {
            // 다음 세그먼트에 흡수 (첫점으로 prepend)
            rawSegs[s + 1].start = rawSegs[s].start;
            rawSegs.splice(s, 1);
            s--;
          } else if (canMergePrev) {
            // 이전 세그먼트에 흡수
            rawSegs[s - 1].end = rawSegs[s].end;
            rawSegs.splice(s, 1);
            s--;
          }
          // 양쪽 모두 gap 초과 → 진짜 고립 싱글 타겟, path 생성에서 singles로 처리
        }
      }

      // 3단계: 세그먼트 → PathLayer 데이터 생성
      for (const seg of rawSegs) {
        const slice = pts.slice(seg.start, seg.end);
        if (slice.length >= 2) {
          const rt = slice[slice.length - 1].radar_type;
          const color = detectionTypeColor(rt);
          paths.push({
            modeS,
            radarType: rt,
            path: slice.map((p) => losMode ? [p.longitude, p.latitude] : [p.longitude, p.latitude, p.altitude * altScale]),
            color,
            avgAlt,
            pointCount: slice.length,
          });
        } else if (slice.length === 1) {
          // 병합 불가능한 진짜 단독 포인트 (전체 항적이 1포인트)
          const p = slice[0];
          const color = detectionTypeColor(p.radar_type);
          singles.push({
            modeS,
            position: losMode ? [p.longitude, p.latitude] : [p.longitude, p.latitude, p.altitude * altScale],
            color,
            point: p,
          });
        }
      }
    }
    return { trackPaths: paths, singlePoints: singles };
  }, [allPoints, visibleMinTs, visibleMaxTs, altScale, losMode]);

  // Loss 데이터 (전체 loss type 표시)
  const signalLoss = useMemo(() => {
    return allLoss.filter(
      (s) => s.start_time >= visibleMinTs && s.start_time <= visibleMaxTs
    );
  }, [allLoss, visibleMinTs, visibleMaxTs]);

  // Loss 포인트 (전체 loss type, 시간 범위 필터)
  const signalLossPoints = useMemo(() => {
    return allLossPoints.filter(
      (p) => p.timestamp >= visibleMinTs && p.timestamp <= visibleMaxTs
    );
  }, [allLossPoints, visibleMinTs, visibleMaxTs]);

  // ADS-B fetch는 FileUpload에서 관리 (store 공유)

  // Dot 모드용 색상 맵 (Mode-S → color)

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
            "line-color": "rgba(30,100,180,0.35)",
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
            "text-color": "rgba(30,80,140,0.8)",
            "text-halo-color": "rgba(255,255,255,0.9)",
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
            "text-color": "rgba(30,80,140,0.9)",
            "text-halo-color": "rgba(255,255,255,0.9)",
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
  }, [radarInfo]);

  // LOS mode map click handler (카메라 조정은 단면도 로딩 완료 후)
  const handleMapClick = useCallback(
    (evt: any) => {
      if (!losMode) return;
      // deck.gl LOS 포인트 클릭이었으면 스킵 (빈 영역 클릭만 처리)
      if (losPointClickedRef.current) {
        losPointClickedRef.current = false;
        return;
      }
      const { lngLat } = evt;
      // 이미 타겟이 있으면 하이라이트/호버 초기화 후 새 타겟으로 재생성
      if (losTarget) {
        setLosHighlightIdx(null);
        setLosHoverIdx(null);
        setLosHoverRatio(null);
        setLosBuildingHighlight(null);
        setDetailBuilding(null);
      }
      setLosTarget({ lat: lngLat.lat, lon: lngLat.lng });
    },
    [losMode, losTarget]
  );

  // LOS 단면도 로딩 완료 → 카메라 자동 정렬
  const losTargetRef = useRef(losTarget);
  losTargetRef.current = losTarget;
  const handleLosLoaded = useCallback(() => {
    const map = mapRef.current?.getMap();
    const target = losTargetRef.current;
    if (!map || !target) return;
    const rLat = radarSite.latitude;
    const rLon = radarSite.longitude;
    const cosLat = Math.cos(((rLat + target.lat) / 2) * Math.PI / 180);
    const dLon = (target.lon - rLon) * cosLat;
    const dLat = target.lat - rLat;
    const bearing = (Math.atan2(dLon, dLat) * 180) / Math.PI;
    const cameraBearing = ((bearing - 90) % 360 + 360) % 360;
    const minLat = Math.min(rLat, target.lat);
    const maxLat = Math.max(rLat, target.lat);
    const minLon = Math.min(rLon, target.lon);
    const maxLon = Math.max(rLon, target.lon);
    map.fitBounds(
      [[minLon, minLat], [maxLon, maxLat]],
      { bearing: cameraBearing, pitch: 0, padding: { top: 80, bottom: 250, left: 80, right: 80 }, duration: 800, maxZoom: 12 }
    );
  }, [radarSite]);

  // LOS mode mouse move handler (커서 추적)
  const handleMapMouseMove = useCallback(
    (evt: any) => {
      if (!losMode || losTarget) return;
      const { lngLat } = evt;
      setLosCursor({ lat: lngLat.lat, lon: lngLat.lng });
    },
    [losMode, losTarget]
  );

  // LOS 선상 항적/Loss 포인트 전체 (단면도 전달용)
  const losTrackPoints = useMemo(() => {
    if (!losTarget) return [];
    const rLat = radarSite.latitude;
    const rLon = radarSite.longitude;
    const tLat = losTarget.lat;
    const tLon = losTarget.lon;
    const bearing = Math.atan2(tLon - rLon, tLat - rLat);
    const cosB = Math.cos(bearing);
    const sinB = Math.sin(bearing);
    const lineLen = Math.sqrt((tLat - rLat) ** 2 + (tLon - rLon) ** 2);
    const tolerance = 0.27; // ~30km
    const pts: { distRatio: number; altitude: number; mode_s: string; timestamp: number; radar_type: string; isLoss: boolean; latitude: number; longitude: number }[] = [];
    // 항적 포인트 (타임라인 슬라이더 범위 적용)
    for (const p of allPoints) {
      if (p.timestamp < visibleMinTs || p.timestamp > visibleMaxTs) continue;
      const dx = p.latitude - rLat;
      const dy = p.longitude - rLon;
      const along = dx * cosB + dy * sinB;
      const across = Math.abs(-dx * sinB + dy * cosB);
      if (across < tolerance && along > 0 && along <= lineLen) {
        pts.push({ distRatio: along / lineLen, altitude: p.altitude, mode_s: p.mode_s, timestamp: p.timestamp, radar_type: p.radar_type, isLoss: false, latitude: p.latitude, longitude: p.longitude });
      }
    }
    // Loss 포인트
    for (const lp of signalLossPoints) {
      const dx = lp.latitude - rLat;
      const dy = lp.longitude - rLon;
      const along = dx * cosB + dy * sinB;
      const across = Math.abs(-dx * sinB + dy * cosB);
      if (across < tolerance && along > 0 && along <= lineLen) {
        pts.push({ distRatio: along / lineLen, altitude: lp.altitude, mode_s: lp.mode_s, timestamp: lp.timestamp, radar_type: "loss", isLoss: true, latitude: lp.latitude, longitude: lp.longitude });
      }
    }
    return pts;
  }, [losTarget, radarSite, allPoints, signalLossPoints, visibleMinTs, visibleMaxTs]);

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
          getSourcePosition: (d) => losMode ? [d.longitude, d.latitude, 0] : [d.longitude, d.latitude, 0],
          getTargetPosition: (d) => losMode ? [d.longitude, d.latitude, 0] : [d.longitude, d.latitude, d.altitude * altScale],
          updateTriggers: { getSourcePosition: [losMode], getTargetPosition: [losMode, altScale] },
          getColor: (d) => {
            const c = detectionTypeColor(d.radar_type);
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
          getPosition: (d) => losMode ? [d.longitude, d.latitude, 0] : [d.longitude, d.latitude, d.altitude * altScale],
          updateTriggers: { getPosition: [losMode, altScale] },
          getFillColor: (d) => {
            const c = detectionTypeColor(d.radar_type);
            return [...c, 200];
          },
          getRadius: 3,
          radiusMinPixels: 1.5,
          radiusMaxPixels: 5,
          radiusUnits: "pixels",
          billboard: true,
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
                  { label: "항적", value: name !== p.mode_s ? `${name} (${p.mode_s})` : p.mode_s, color: (() => { const c = detectionTypeColor(p.radar_type); return `rgb(${c[0]},${c[1]},${c[2]})`; })() },
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
            if (info.object && info.coordinate) {
              const d = info.object;
              const [hLon, hLat] = info.coordinate;
              // 해당 세그먼트의 mode_s로 가장 가까운 실제 TrackPoint 찾기
              let bestPt: TrackPoint | null = null;
              let bestDist = Infinity;
              for (const p of allPoints) {
                if (p.mode_s !== d.modeS) continue;
                const dl = p.latitude - hLat;
                const dn = p.longitude - hLon;
                const dist2 = dl * dl + dn * dn;
                if (dist2 < bestDist) {
                  bestDist = dist2;
                  bestPt = p;
                }
              }
              if (bestPt) {
                const p = bestPt;
                const altFt = Math.round(p.altitude / 0.3048);
                const name = acName(d.modeS);
                setHoverInfo({
                  x: info.x,
                  y: info.y,
                  lines: [
                    { label: "항적", value: name !== d.modeS ? `${name} (${d.modeS})` : d.modeS, color: `rgb(${d.color[0]},${d.color[1]},${d.color[2]})` },
                    { label: "시각", value: format(new Date(p.timestamp * 1000), "MM-dd HH:mm:ss") },
                    { label: "고도", value: `FL${Math.round(altFt / 100)} (${Math.round(p.altitude)}m)` },
                    { label: "속도", value: `${p.speed.toFixed(0)} kts` },
                    { label: "방위", value: `${p.heading.toFixed(0)}°` },
                    { label: "레이더", value: radarTypeLabel(p.radar_type) },
                    { label: "좌표", value: `${p.latitude.toFixed(4)}°N ${p.longitude.toFixed(4)}°E` },
                  ],
                });
              }
            } else {
              setHoverInfo(null);
            }
          },
        })
      );
    }

    // 1포인트 항적 (ScatterplotLayer)
    if (singlePoints.length > 0) {
      layers.push(
        new ScatterplotLayer({
          id: "track-single-points",
          data: singlePoints,
          getPosition: (d: any) => d.position,
          getFillColor: (d: any) => [d.color[0], d.color[1], d.color[2], 220] as [number, number, number, number],
          getLineColor: [255, 255, 255, 160],
          getRadius: 5,
          radiusMinPixels: 3,
          radiusMaxPixels: 10,
          radiusUnits: "pixels",
          stroked: true,
          lineWidthMinPixels: 1,
          billboard: true,
          pickable: true,
          onHover: (info: any) => {
            if (info.object) {
              const d = info.object;
              const p = d.point;
              const altFt = Math.round(p.altitude / 0.3048);
              const name = acName(d.modeS);
              setHoverInfo({
                x: info.x,
                y: info.y,
                lines: [
                  { label: "항적", value: name !== d.modeS ? `${name} (${d.modeS})` : d.modeS, color: `rgb(${d.color[0]},${d.color[1]},${d.color[2]})` },
                  { label: "시각", value: format(new Date(p.timestamp * 1000), "MM-dd HH:mm:ss") },
                  { label: "고도", value: `FL${Math.round(altFt / 100)} (${Math.round(p.altitude)}m)` },
                  { label: "속도", value: `${p.speed.toFixed(0)} kts` },
                  { label: "레이더", value: radarTypeLabel(p.radar_type) },
                  { label: "포인트", value: "1개 (단독)" },
                ],
              });
            } else {
              setHoverInfo(null);
            }
          },
        })
      );
    }

    // ADS-B 트랙 레이어
    if (adsbTracks.length > 0) {
      layers.push(
        new PathLayer({
          id: "adsb-tracks",
          data: adsbTracks.flatMap((t) => {
            const coords = t.path
              .filter((p) => !p.on_ground)
              .map((p) => [p.longitude, p.latitude, p.altitude] as [number, number, number]);
            return coords.length > 1 ? [{ path: coords, icao24: t.icao24, callsign: t.callsign }] : [];
          }),
          getPath: (d: any) => d.path,
          getColor: [16, 185, 129, 180],  // emerald green
          getWidth: 3,
          widthUnits: "pixels" as const,
          pickable: true,
          onHover: (info: any) => {
            if (info.object) {
              setHoverInfo({
                x: info.x,
                y: info.y,
                lines: [
                  { label: "ADS-B", value: info.object.callsign || info.object.icao24, color: "#10b981" },
                  { label: "ICAO24", value: info.object.icao24 },
                ],
              });
            } else if (!info.object) {
              setHoverInfo(null);
            }
          },
        })
      );
    }

    // Signal Loss 포인트 (개별 미탐지 스캔 — 항적 dot과 동일 스타일)
    if (signalLossPoints.length > 0) {
      layers.push(
        new ScatterplotLayer<LossPoint>({
          id: "loss-points",
          data: signalLossPoints,
          getPosition: (d) => losMode ? [d.longitude, d.latitude, 0] : [d.longitude, d.latitude, d.altitude * altScale],
          updateTriggers: { getPosition: [losMode, altScale] },
          getFillColor: [233, 69, 96, 200],
          getRadius: 3,
          radiusMinPixels: 1.5,
          radiusMaxPixels: 5,
          radiusUnits: "pixels",
          billboard: true,
          pickable: true,
          onHover: (info) => {
            if (info.object) {
              const d = info.object;
              const name = acName(d.mode_s);
              const altFt = Math.round(d.altitude / 0.3048);
              setHoverInfo({
                x: info.x,
                y: info.y,
                lines: [
                  { label: "표적소실", value: name !== d.mode_s ? `${name} (${d.mode_s})` : d.mode_s, color: "#e94560" },
                  { label: "예상시각", value: format(new Date(d.timestamp * 1000), "HH:mm:ss") },
                  { label: "미탐지", value: `${d.scan_index}/${d.total_missed_scans} 스캔` },
                  { label: "gap", value: `${d.gap_duration_secs.toFixed(1)}초` },
                  { label: "고도", value: `FL${Math.round(altFt / 100)} (${Math.round(d.altitude)}m)` },
                  { label: "레이더거리", value: `${d.radar_distance_km.toFixed(1)}km` },
                  { label: "좌표", value: `${d.latitude.toFixed(4)}°N ${d.longitude.toFixed(4)}°E` },
                ],
              });
            } else {
              setHoverInfo(null);
            }
          },
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

      // LOS 단면도 호버 위치 → 지도 위 점
      if (losTarget && losHoverRatio !== null) {
        const rLat = radarSite.latitude;
        const rLon = radarSite.longitude;
        const hoverLat = rLat + (losTarget.lat - rLat) * losHoverRatio;
        const hoverLon = rLon + (losTarget.lon - rLon) * losHoverRatio;
        layers.push(
          new ScatterplotLayer({
            id: "los-hover-dot",
            data: [{ position: [hoverLon, hoverLat] }],
            getPosition: (d: any) => d.position,
            getFillColor: [255, 255, 255, 255],
            getLineColor: [233, 69, 96, 255],
            getRadius: 6,
            radiusMinPixels: 5,
            radiusMaxPixels: 10,
            radiusUnits: "pixels",
            lineWidthMinPixels: 2,
            stroked: true,
            pickable: false,
          })
        );
      }

      // LOS 선상 항적/Loss 포인트 (맵에서 클릭 가능)
      if (losTrackPoints.length > 0) {
        const losTPData = losTrackPoints.map((tp, idx) => ({
          position: [tp.longitude, tp.latitude],
          idx,
          isLoss: tp.isLoss,
          radar_type: tp.radar_type,
        }));
        layers.push(
          new ScatterplotLayer({
            id: "los-track-points",
            data: losTPData,
            getPosition: (d: any) => d.position,
            getFillColor: (d: any) => d.isLoss ? [239, 68, 68, 180] : [...detectionTypeColor(d.radar_type), 140],
            getLineColor: [255, 255, 255, 100],
            getRadius: 3,
            radiusMinPixels: 2,
            radiusMaxPixels: 6,
            radiusUnits: "pixels",
            lineWidthMinPixels: 0.5,
            stroked: true,
            pickable: true,
            onClick: (info: any) => {
              if (info.object) {
                losPointClickedRef.current = true; // 빈 영역 클릭과 구분
                const clickedIdx = info.object.idx;
                setLosHighlightIdx((prev) => prev === clickedIdx ? null : clickedIdx);
              }
            },
            onHover: (info: any) => {
              setLosHoverIdx(info.object ? info.object.idx : null);
            },
          })
        );
      }

      // LOS 맵 호버 마커 (핀과 별도)
      const effectiveHoverIdx = losHoverIdx !== null ? losHoverIdx : null;
      if (effectiveHoverIdx !== null && effectiveHoverIdx !== losHighlightIdx && losTrackPoints[effectiveHoverIdx]) {
        const htp = losTrackPoints[effectiveHoverIdx];
        layers.push(
          new ScatterplotLayer({
            id: "los-track-hover",
            data: [{ position: [htp.longitude, htp.latitude] }],
            getPosition: (d: any) => d.position,
            getFillColor: htp.isLoss ? [239, 68, 68, 200] : [...detectionTypeColor(htp.radar_type), 200],
            getLineColor: [255, 255, 255, 200],
            getRadius: 6,
            radiusMinPixels: 5,
            radiusMaxPixels: 11,
            radiusUnits: "pixels",
            lineWidthMinPixels: 1.5,
            stroked: true,
            pickable: false,
          })
        );
      }

      // LOS 단면도 항적 포인트 하이라이트 (핀) → 지도 위 마커
      if (losHighlightIdx !== null && losTrackPoints[losHighlightIdx]) {
        const tp = losTrackPoints[losHighlightIdx];
        layers.push(
          new ScatterplotLayer({
            id: "los-track-highlight",
            data: [{ position: [tp.longitude, tp.latitude] }],
            getPosition: (d: any) => d.position,
            getFillColor: tp.isLoss ? [239, 68, 68, 255] : [...detectionTypeColor(tp.radar_type), 255],
            getLineColor: [255, 255, 255, 255],
            getRadius: 8,
            radiusMinPixels: 7,
            radiusMaxPixels: 14,
            radiusUnits: "pixels",
            lineWidthMinPixels: 2.5,
            stroked: true,
            pickable: false,
          })
        );
      }

    }

    // 커버리지 맵 (합성 스펙트럼: 동심 링 — 단일 레이어로 통합하여 GPU 오버헤드 최소화)
    if (coveragePolygonsList && coveragePolygonsList.length > 0) {
      const n = coveragePolygonsList.length;
      const isSingle = n === 1;
      const fillAlpha = isSingle ? 40 : 100;

      // 단일 PolygonLayer로 모든 커버리지 폴리곤 통합
      layers.push(
        new PolygonLayer({
          id: "coverage-fill",
          data: coveragePolygonsList,
          getPolygon: (d: any) => d.polygon,
          getFillColor: (d: any) => [...d.fillColor, fillAlpha] as [number, number, number, number],
          getLineColor: [0, 0, 0, 0],
          filled: true,
          stroked: false,
          extruded: false,
          _full3d: true,
          parameters: { depthWriteEnabled: false },
        })
      );

      // 최외곽 경계선
      const outermost = coveragePolygonsList[n - 1];
      layers.push(
        new PathLayer({
          id: "coverage-outline",
          data: [{ path: outermost.outerRing }],
          getPath: (d: any) => d.path,
          getColor: [...outermost.fillColor, isSingle ? 255 : 180],
          getWidth: isSingle ? 2.5 : 1.5,
          widthMinPixels: isSingle ? 2 : 1,
          widthMaxPixels: isSingle ? 4 : 3,
          widthUnits: "pixels" as const,
        })
      );

      // Cone of Silence 경계선 (최내곽 레이어)
      const innermost = coveragePolygonsList[0];
      if (innermost.coneRing) {
        layers.push(
          new PathLayer({
            id: "cone-outline",
            data: [{ path: innermost.coneRing }],
            getPath: (d: any) => d.path,
            getColor: [...innermost.fillColor, 100],
            getWidth: 1,
            widthMinPixels: 1,
            widthMaxPixels: 2,
            widthUnits: "pixels" as const,
          })
        );
      }
    }

    // 구름 오버레이 — 점화(stippling) 방식
    if (cloudDots && cloudDots.length > 0) {
      layers.push(
        new ScatterplotLayer({
          id: "cloud-overlay",
          data: cloudDots,
          getPosition: (d: any) => d.position,
          getRadius: 200,
          radiusUnits: "meters" as const,
          radiusMinPixels: 0.8,
          radiusMaxPixels: 2,
          getFillColor: (d: any) => {
            const alpha = Math.min(200, 80 + Math.round(d.cover * 1.2));
            return [30, 30, 40, alpha];
          },
          pickable: false,
          parameters: { depthWriteEnabled: false },
        })
      );
    }

    // 건물 오버레이
    if (showBuildings && buildingOverlayData.length > 0) {
      layers.push(
        new ScatterplotLayer({
          id: "building-overlay",
          data: buildingOverlayData,
          getPosition: (d: (typeof buildingOverlayData)[0]) => [d.lon, d.lat],
          getRadius: (d: (typeof buildingOverlayData)[0]) => Math.max(3, Math.min(8, d.height_m / 15)),
          radiusMinPixels: 2,
          radiusMaxPixels: 10,
          radiusUnits: "pixels" as const,
          getFillColor: (d: (typeof buildingOverlayData)[0]) =>
            d.source === "manual" ? [249, 115, 22, 160] : [139, 92, 246, 120],
          getLineColor: (d: (typeof buildingOverlayData)[0]) =>
            d.source === "manual" ? [249, 115, 22, 255] : [139, 92, 246, 200],
          stroked: true,
          lineWidthMinPixels: 1,
          pickable: true,
          onHover: (info: { object?: (typeof buildingOverlayData)[0]; x: number; y: number }) => {
            if (info.object) {
              const d = info.object;
              const lines: { label: string; value: string; color?: string }[] = [
                { label: "건물", value: d.name || "(이름 없음)", color: d.source === "manual" ? "#f97316" : "#8b5cf6" },
                { label: "높이", value: `${d.height_m.toFixed(1)}m` },
              ];
              if (d.address) lines.push({ label: "주소", value: d.address });
              if (d.usage) lines.push({ label: "용도", value: d.usage });
              lines.push({ label: "출처", value: d.source === "manual" ? "수동 등록" : "GIS 건물" });
              lines.push({ label: "좌표", value: `${d.lat.toFixed(5)}°N ${d.lon.toFixed(5)}°E` });
              setHoverInfo({ x: info.x, y: info.y, lines });
            } else {
              setHoverInfo(null);
            }
          },
        })
      );
    }

    // LOS 단면도 건물 호버/클릭 하이라이트 (건물 오버레이 비활성 상태에서도 표시)
    if (losBuildingHighlight) {
      layers.push(
        new IconLayer({
          id: "los-building-highlight",
          data: [losBuildingHighlight],
          getPosition: (d: typeof losBuildingHighlight) => [d!.lon, d!.lat],
          getIcon: () => ({
            url: "/building-icon.png",
            width: 128,
            height: 128,
            anchorY: 128,
          }),
          getSize: 15,
          sizeUnits: "pixels" as const,
          pickable: false,
        })
      );
    }

    return layers;
  }, [trackPaths, singlePoints, signalLoss, signalLossPoints, altScale, radarInfo, losMode, losTarget, losCursor, dotMode, dotPoints, aircraft, adsbTracks, losHoverRatio, losHighlightIdx, losHoverIdx, losTrackPoints, allPoints, selectedModeS, coveragePolygonsList, showBuildings, buildingOverlayData, cloudDots, losBuildingHighlight]);

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

  // 모달/드롭다운 외부 클릭 닫기
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (aircraftDropRef.current && !aircraftDropRef.current.contains(e.target as Node)) {
        setAircraftDropOpen(false);
      }
      if (radarDropRef.current && !radarDropRef.current.contains(e.target as Node)) {
        setRadarDropOpen(false);
      }
      if (speedRef.current && !speedRef.current.contains(e.target as Node)) {
        setSpeedDropOpen(false);
      }
      if (trailRef.current && !trailRef.current.contains(e.target as Node)) {
        setTrailDropOpen(false);
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

  // 시작점 드래그
  const [draggingStart, setDraggingStart] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);

  // 타임라인 줌 (커서 기준 스크롤 축척)
  const [zoomView, setZoomView] = useState<[number, number]>([0, 100]);
  const zoomViewRef = useRef<[number, number]>([0, 100]);
  const zoomVStart = zoomView[0];
  const zoomVEnd = zoomView[1];
  const zoomRange = zoomVEnd - zoomVStart;
  const absToScreen = (abs: number) => zoomRange > 0 ? ((abs - zoomVStart) / zoomRange) * 100 : 0;

  // 타임라인 줌: 스크롤 핸들러
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mouseRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const [vs, ve] = zoomViewRef.current;
      const cursorAbs = vs + mouseRatio * (ve - vs);
      const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
      let newRange = Math.max(0.005, Math.min(100, (ve - vs) * factor));
      let ns = cursorAbs - mouseRatio * newRange;
      let ne = ns + newRange;
      if (ns < 0) { ns = 0; ne = Math.min(100, newRange); }
      if (ne > 100) { ne = 100; ns = Math.max(0, 100 - newRange); }
      zoomViewRef.current = [ns, ne];
      setZoomView([ns, ne]);
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [allPoints.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // 데이터 변경 시 줌 리셋
  useEffect(() => {
    zoomViewRef.current = [0, 100];
    setZoomView([0, 100]);
  }, [timeRange.min, timeRange.max]);

  // 재생 중 자동 팬 (재생 헤드가 뷰 우측 15% 이내에 도달 시)
  useEffect(() => {
    if (!playing) return;
    const [vs, ve] = zoomViewRef.current;
    if (ve >= 99.5) return;
    const range = ve - vs;
    const threshold = range * 0.15;
    if (sliderValue > ve - threshold) {
      const shift = range * 0.3;
      const newEnd = Math.min(100, ve + shift);
      const newStart = Math.max(0, newEnd - range);
      zoomViewRef.current = [newStart, newEnd];
      setZoomView([newStart, newEnd]);
    }
  }, [sliderValue, playing]);

  // 표시 시간 포맷 (날짜 포함)
  const fmtDate = useCallback(
    (ts: number) => (ts > 0 ? format(new Date(ts * 1000), "yyyy-MM-dd") : "----/--/--"),
    []
  );
  const fmtTime = useCallback(
    (ts: number) => (ts > 0 ? format(new Date(ts * 1000), "HH:mm:ss") : "--:--:--"),
    []
  );

  // 타임라인 띠 데이터: 각 Mode-S별 시간 구간 (dot 형태로 시각화)
  const timelineBands = useMemo(() => {
    if (allPoints.length === 0 || timeRange.max <= timeRange.min) return [];
    const range = timeRange.max - timeRange.min;
    // Mode-S별로 포인트 그룹핑
    const byModeS = new Map<string, number[]>();
    for (const p of allPoints) {
      let arr = byModeS.get(p.mode_s);
      if (!arr) { arr = []; byModeS.set(p.mode_s, arr); }
      arr.push(p.timestamp);
    }
    const bands: { modeS: string; color: [number, number, number]; segments: { start: number; end: number }[] }[] = [];
    for (const [modeS, times] of byModeS) {
      // 해당 mode_s의 가장 많은 탐지 유형 색상 사용
      const typeCounts = new Map<string, number>();
      for (const p of allPoints) {
        if (p.mode_s !== modeS) continue;
        typeCounts.set(p.radar_type, (typeCounts.get(p.radar_type) ?? 0) + 1);
      }
      let dominantType = "mode_s_rollcall";
      let maxCount = 0;
      for (const [rt, cnt] of typeCounts) {
        if (cnt > maxCount) { maxCount = cnt; dominantType = rt; }
      }
      const color = detectionTypeColor(dominantType);
      // 연속 구간 병합 (15초 이내 gap은 연결)
      const sorted = times.sort((a, b) => a - b);
      const segments: { start: number; end: number }[] = [];
      let segStart = sorted[0], segEnd = sorted[0];
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] - segEnd <= 15) {
          segEnd = sorted[i];
        } else {
          segments.push({
            start: ((segStart - timeRange.min) / range) * 100,
            end: ((segEnd - timeRange.min) / range) * 100,
          });
          segStart = sorted[i];
          segEnd = sorted[i];
        }
      }
      segments.push({
        start: ((segStart - timeRange.min) / range) * 100,
        end: ((segEnd - timeRange.min) / range) * 100,
      });
      bands.push({ modeS, color, segments });
    }
    return bands;
  }, [allPoints, timeRange]);

  return (
    <div className="flex h-full flex-col">
      {/* Top toolbar */}
      <div className="relative z-[1500] flex items-center gap-2 border-b border-gray-200 bg-white/95 backdrop-blur-sm shadow-sm px-3 py-2">
        {/* Left: Playback controls */}
        {allPoints.length > 0 && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                if (!playing && sliderValue >= 99.9) {
                  setSliderValue(rangeStart);
                }
                setPlaying(!playing);
              }}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-[#a60739] text-white hover:bg-[#85062e] transition-colors"
              title={playing ? "일시정지" : "재생"}
            >
              {playing ? <Pause size={12} /> : <Play size={12} className="ml-0.5" />}
            </button>

            {/* 배속 뱃지 */}
            <div ref={speedRef} className="relative">
              <button
                onClick={() => { setSpeedDropOpen(!speedDropOpen); setTrailDropOpen(false); }}
                className="flex h-7 items-center justify-center rounded-md border border-gray-200 bg-gray-50 px-2 text-[11px] font-semibold leading-none text-gray-600 hover:border-gray-300 transition-colors"
              >
                {playSpeed}x
              </button>
              {speedDropOpen && (
                <div className="absolute left-1/2 -translate-x-1/2 top-full z-[2000] mt-1 w-20 rounded-lg border border-gray-200 bg-white shadow-lg py-1">
                  {SPEED_OPTIONS.map((sp) => (
                    <button
                      key={sp}
                      onClick={() => { setPlaySpeed(sp); setSpeedDropOpen(false); }}
                      className={`w-full px-3 py-1 text-left text-xs transition-colors ${
                        playSpeed === sp ? "bg-[#a60739] text-white" : "text-gray-600 hover:bg-gray-100"
                      }`}
                    >
                      {sp}x
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Trail 뱃지 */}
            <div ref={trailRef} className="relative">
              <button
                onClick={() => { setTrailDropOpen(!trailDropOpen); setSpeedDropOpen(false); }}
                className="flex h-7 items-center justify-center rounded-md border border-gray-200 bg-gray-50 px-2 text-[11px] font-semibold leading-none text-gray-600 hover:border-gray-300 transition-colors"
              >
                {trailDuration === 0 ? "전체" : "30분"}
              </button>
              {trailDropOpen && (
                <div className="absolute left-1/2 -translate-x-1/2 top-full z-[2000] mt-1 w-20 rounded-lg border border-gray-200 bg-white shadow-lg py-1">
                  {([0, 1800] as const).map((d) => (
                    <button
                      key={d}
                      onClick={() => { setTrailDuration(d); setTrailDropOpen(false); }}
                      className={`w-full px-3 py-1 text-left text-xs transition-colors ${
                        trailDuration === d ? "bg-[#a60739] text-white" : "text-gray-600 hover:bg-gray-100"
                      }`}
                    >
                      {d === 0 ? "전체" : "30분"}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="flex-1" />

        {/* Center: Compact stats */}
        <div className="flex items-center gap-3 text-[10px] text-gray-400">
          <span>{allPoints.length.toLocaleString()} pts</span>
          <span className="text-[#a60739]">Loss {signalLossPoints.length}pt/{signalLoss.length}gap</span>
        </div>

        {/* ADS-B 로딩 표시 */}
        {adsbLoading && adsbProgress && (
          <span className="text-[10px] text-emerald-600">{adsbProgress}</span>
        )}

        <div className="flex-1" />

        {/* 비행검사기 선택 드롭다운 */}
        <div ref={aircraftDropRef} className="relative flex items-center">
          <button
            onClick={() => { setAircraftDropOpen(!aircraftDropOpen); setRadarDropOpen(false); setModeSSearch(""); }}
            className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors ${
              aircraftDropOpen
                ? "border-[#a60739] bg-[#a60739]/10 text-[#a60739]"
                : "border-gray-200 bg-gray-50 text-gray-600 hover:border-gray-300"
            }`}
          >
            <Plane size={13} fill="white" />
            <span className="max-w-[120px] truncate font-medium">
              {!selectedModeS ? "등록 기체" : selectedModeS === "__ALL__" ? "전체 항적" : getAircraftName(selectedModeS)}
            </span>
            <ChevronDown size={12} className={`transition-transform ${aircraftDropOpen ? "rotate-180" : ""}`} />
          </button>
          {aircraftDropOpen && (
            <div className="absolute left-0 top-full z-[2000] mt-1 w-56 rounded-lg border border-gray-200 bg-white/95 shadow-xl backdrop-blur-sm">
              <div className="px-2 pt-2 pb-1">
                <input
                  type="text"
                  value={modeSSearch}
                  onChange={(e) => setModeSSearch(e.target.value)}
                  placeholder="검색..."
                  className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-800 outline-none placeholder:text-gray-400 focus:border-[#a60739]/50"
                  autoFocus
                />
              </div>
              <div className="max-h-56 overflow-y-auto py-1 px-1 pb-2">
                <button
                  onClick={() => { setSelectedModeS(null); setSelectedFlightId(null); setSelectedFlight(null); setAircraftDropOpen(false); }}
                  className={`w-full px-3 py-1.5 text-left text-xs rounded transition-colors ${!selectedModeS ? "bg-[#a60739] text-white" : "text-gray-600 hover:bg-gray-100"}`}
                >
                  등록 기체 전체
                </button>
                {aircraft.filter((a) => a.active && (!modeSSearch || a.name.toLowerCase().includes(modeSSearch.toLowerCase()) || a.mode_s_code.toLowerCase().includes(modeSSearch.toLowerCase()))).map((a) => (
                  <button
                    key={`ac-${a.id}`}
                    onClick={() => { setSelectedModeS(a.mode_s_code.toUpperCase()); setSelectedFlightId(null); setSelectedFlight(null); setAircraftDropOpen(false); }}
                    className={`w-full px-3 py-1.5 text-left text-xs rounded transition-colors ${selectedModeS === a.mode_s_code.toUpperCase() ? "bg-[#a60739] text-white" : "text-gray-600 hover:bg-gray-100"}`}
                  >
                    <div className="flex items-center gap-2">
                      <span>{a.name}</span>
                      <span className={`text-[10px] ${selectedModeS === a.mode_s_code.toUpperCase() ? "text-white/60" : "text-gray-400"}`}>{a.mode_s_code}</span>
                    </div>
                  </button>
                ))}
                <div className="border-t border-gray-200 my-1 mx-2" />
                <button
                  onClick={() => { setSelectedModeS("__ALL__"); setSelectedFlightId(null); setSelectedFlight(null); setAircraftDropOpen(false); }}
                  className={`w-full px-3 py-1.5 text-left text-xs rounded transition-colors ${selectedModeS === "__ALL__" ? "bg-[#a60739] text-white" : "text-gray-600 hover:bg-gray-100"}`}
                >
                  전체 항적
                </button>
                {filteredModeS.map((ms) => (
                  <button
                    key={ms}
                    onClick={() => { setSelectedModeS(ms); setSelectedFlightId(null); setSelectedFlight(null); setAircraftDropOpen(false); }}
                    className={`w-full px-3 py-1.5 text-left text-xs rounded transition-colors ${selectedModeS === ms ? "bg-[#a60739] text-white" : "text-gray-600 hover:bg-gray-100"}`}
                  >
                    {getAircraftName(ms)}
                  </button>
                ))}
                {filteredModeS.length === 0 && aircraft.filter((a) => a.active).length === 0 && modeSSearch && (
                  <div className="px-3 py-2 text-xs text-gray-400">검색 결과 없음</div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 레이더 사이트 선택 드롭다운 */}
        <div ref={radarDropRef} className="relative flex items-center">
          <button
            onClick={() => { setRadarDropOpen(!radarDropOpen); setAircraftDropOpen(false); }}
            className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors ${
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
            <div className="absolute left-0 top-full z-[2000] mt-1 w-56 rounded-lg border border-gray-200 bg-white/95 shadow-xl backdrop-blur-sm">
              <div className="max-h-56 overflow-y-auto py-1 px-1">
                {allRadarSites.map((site) => (
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

        {/* LOS Analysis toggle */}
        <button
          onClick={() => {
            const entering = !losMode;
            setLosMode(entering);
            if (entering) {
              savedPitchRef.current = viewState.pitch ?? 45;
              savedBearingRef.current = viewState.bearing ?? 0;
              savedTerrainRef.current = terrainEnabled;
              if (terrainEnabled) setTerrainEnabled(false);
              const map = mapRef.current?.getMap();
              if (map) {
                map.easeTo({ pitch: 0, bearing: 0, duration: 500 });
              }
            } else {
              setLosTarget(null);
              setLosCursor(null);
              setLosHighlightIdx(null);
              if (savedTerrainRef.current) setTerrainEnabled(true);
              const map = mapRef.current?.getMap();
              if (map) {
                map.easeTo({ pitch: savedPitchRef.current, bearing: savedBearingRef.current, duration: 500 });
              }
            }
          }}
          className={`rounded-lg p-1.5 transition-colors ${
            losMode
              ? "bg-[#a60739] text-white shadow-sm"
              : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          }`}
          title="LOS 분석 (단면도)"
        >
          <Mountain size={16} />
        </button>

        {/* Dot mode toggle */}
        <button
          onClick={() => setDotMode(!dotMode)}
          className={`rounded-lg p-1.5 transition-colors ${
            dotMode
              ? "bg-[#a60739] text-white shadow-sm"
              : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          }`}
          title="Dot 모드"
        >
          <DotPinIcon size={16} />
        </button>

        {/* 건물 오버레이 토글 */}
        {buildingsLoading ? (
          <div className="flex items-center gap-1 rounded-lg bg-violet-50 px-2 py-1.5 text-[10px] text-violet-600">
            <Loader2 size={14} className="animate-spin" />
            <span>건물...</span>
          </div>
        ) : (
          <button
            onClick={() => {
              if (buildingOverlayData.length > 0) {
                setShowBuildings(!showBuildings);
              } else {
                fetchBuildingOverlay();
              }
            }}
            className={`relative rounded-lg p-1.5 transition-colors ${
              showBuildings && buildingOverlayData.length > 0
                ? "bg-[#a60739] text-white shadow-sm"
                : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            }`}
            title={buildingOverlayData.length > 0 ? "건물 오버레이 토글" : "GIS+수동 건물 표시"}
          >
            <Building2 size={16} />
            {showBuildings && buildingOverlayData.length > 0 && (
              <span className="absolute -top-1 -right-1 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-violet-500 px-0.5 text-[8px] font-bold text-white leading-none">
                {buildingOverlayData.length > 999 ? "999+" : buildingOverlayData.length}
              </span>
            )}
          </button>
        )}

        {/* 레이더 커버리지 맵 */}
        <div ref={coverageAltRef} className="relative">
          <button
            onClick={() => setCoverageModalOpen(true)}
            className={`rounded-lg p-1.5 transition-colors relative ${
              coverageVisible && coverageLayers.length > 0
                ? "bg-[#a60739] text-white shadow-sm"
                : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            }`}
            title="레이더 커버리지 맵"
          >
            <CoverageIcon size={16} />
            {coverageLoading && (
              <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#a60739] opacity-60" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[#a60739]" />
              </span>
            )}
          </button>

        {/* 커버리지 모달 */}
        {coverageModalOpen && (
          <>
          <div
            className="fixed inset-0 z-[9998]"
            onClick={() => setCoverageModalOpen(false)}
          />
          <div
            className="absolute top-full right-0 mt-1 z-[9999] w-80 rounded-xl bg-white shadow-2xl border border-gray-200"
            role="dialog"
            aria-modal="true"
            aria-labelledby="coverage-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
              {/* 헤더 */}
              <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
                <h3 id="coverage-modal-title" className="text-sm font-semibold text-gray-800">레이더 커버리지 맵</h3>
                <button
                  onClick={() => setCoverageModalOpen(false)}
                  className="text-gray-400 hover:text-gray-600 text-lg leading-none focus:outline-2 focus:outline-[#a60739] rounded"
                  aria-label="커버리지 모달 닫기"
                >
                  &times;
                </button>
              </div>
              {/* 본문 */}
              <div className="space-y-4 px-5 py-4">

                {/* 계산 버튼 + 프로그레스 */}
                {coverageLoading ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-xs text-[#a60739]">
                      <Loader2 size={14} className="animate-spin flex-shrink-0" />
                      <span className="truncate">{coverageProgress || "계산 중..."}</span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-gray-200 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-[#a60739] transition-all duration-300"
                        style={{ width: `${Math.max(2, coverageProgressPct)}%` }}
                      />
                    </div>
                    <div className="text-right text-[10px] text-gray-400">{coverageProgressPct}%</div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {!terrainProfile || !isCacheValidFor(radarSite) ? (
                      <button
                        onClick={() => startCoverageCompute(false)}
                        className="w-full rounded-lg bg-[#a60739] py-2.5 text-xs font-medium text-white hover:bg-[#8a0630] transition-colors"
                      >
                        커버리지 계산 시작
                      </button>
                    ) : (
                      <button
                        onClick={() => startCoverageCompute(true)}
                        className="w-full rounded-lg border border-gray-200 py-2 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
                      >
                        지형 프로파일 재계산
                      </button>
                    )}
                  </div>
                )}

                {/* 에러 메시지 */}
                {coverageError && (
                  <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
                    {coverageError}
                  </div>
                )}

                {/* 아래 컨트롤은 프로파일 계산 완료 후 활성화 */}
                {terrainProfile && isCacheValidFor(radarSite) && (
                  <>
                    {/* 구분선 */}
                    <div className="border-t border-gray-100" />

                    {/* 표시/숨기기 토글 */}
                    <div className="flex items-center justify-between">
                      <label htmlFor="coverage-toggle" className="text-xs text-gray-600">커버리지 표시</label>
                      <button
                        id="coverage-toggle"
                        onClick={() => setCoverageVisible(!coverageVisible)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${coverageVisible ? "bg-[#a60739]" : "bg-gray-300"}`}
                        role="switch"
                        aria-checked={coverageVisible}
                      >
                        <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${coverageVisible ? "translate-x-4.5" : "translate-x-0.5"}`} />
                      </button>
                    </div>

                    {/* Cone of Silence 토글 */}
                    <div className="flex items-center justify-between">
                      <label htmlFor="cone-toggle" className="text-xs text-gray-600">Cone of Silence 표시</label>
                      <button
                        id="cone-toggle"
                        onClick={() => setShowConeOfSilence(!showConeOfSilence)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${showConeOfSilence ? "bg-[#a60739]" : "bg-gray-300"}`}
                        role="switch"
                        aria-checked={showConeOfSilence}
                      >
                        <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${showConeOfSilence ? "translate-x-4.5" : "translate-x-0.5"}`} />
                      </button>
                    </div>

                    {/* 고도 범위 슬라이더 */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-xs text-gray-600">표시 고도 범위</label>
                        <span className="rounded bg-[#a60739]/10 px-1.5 py-0.5 text-xs font-semibold text-[#a60739]">
                          {coverageAltMinInput.toLocaleString()}ft ~ {coverageAltInput.toLocaleString()}ft
                        </span>
                      </div>
                      {(() => {
                        const totalRange = COVERAGE_MAX_ALT_FT - COVERAGE_MIN_ALT_FT;
                        const pctMin = ((Math.min(coverageAltMinInput, coverageAltInput) - COVERAGE_MIN_ALT_FT) / totalRange) * 100;
                        const pctMax = ((Math.max(coverageAltMinInput, coverageAltInput) - COVERAGE_MIN_ALT_FT) / totalRange) * 100;
                        return (
                          <div className="relative h-6">
                            {/* 트랙 배경 — 썸 반지름(8px)만큼 좌우 여백 */}
                            <div className="absolute top-1/2 left-[8px] right-[8px] h-1.5 -translate-y-1/2 rounded-full bg-gray-200" />
                            {/* 활성 범위 — 썸 위치와 동기화 */}
                            <div
                              className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-[#a60739]"
                              style={{ left: `calc(8px + (100% - 16px) * ${pctMin / 100})`, right: `calc(8px + (100% - 16px) * ${(100 - pctMax) / 100})` }}
                            />
                            {/* 최소 핸들 */}
                            <input
                              type="range"
                              min={COVERAGE_MIN_ALT_FT}
                              max={COVERAGE_MAX_ALT_FT}
                              step={COVERAGE_ALT_STEP_FT}
                              value={coverageAltMinInput}
                              onChange={(e) => {
                                const v = Number(e.target.value);
                                handleCoverageAltMinChange(Math.min(v, coverageAltInput));
                              }}
                              style={{ zIndex: coverageAltMinInput > (COVERAGE_MAX_ALT_FT + COVERAGE_MIN_ALT_FT) / 2 ? 30 : 20 }}
                              className="coverage-range-thumb absolute left-0 right-0 top-1/2 -translate-y-1/2 w-full appearance-none bg-transparent cursor-pointer pointer-events-none"
                              aria-label="최소 고도"
                            />
                            {/* 최대 핸들 */}
                            <input
                              type="range"
                              min={COVERAGE_MIN_ALT_FT}
                              max={COVERAGE_MAX_ALT_FT}
                              step={COVERAGE_ALT_STEP_FT}
                              value={coverageAltInput}
                              onChange={(e) => {
                                const v = Number(e.target.value);
                                handleCoverageAltChange(Math.max(v, coverageAltMinInput));
                              }}
                              style={{ zIndex: coverageAltMinInput > (COVERAGE_MAX_ALT_FT + COVERAGE_MIN_ALT_FT) / 2 ? 20 : 30 }}
                              className="coverage-range-thumb absolute left-0 right-0 top-1/2 -translate-y-1/2 w-full appearance-none bg-transparent cursor-pointer pointer-events-none"
                              aria-label="최대 고도"
                            />
                          </div>
                        );
                      })()}
                      <div className="flex justify-between text-[9px] text-gray-400">
                        <span>{COVERAGE_MIN_ALT_FT.toLocaleString()}ft</span>
                        <span>{COVERAGE_MAX_ALT_FT.toLocaleString()}ft</span>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </>
        )}
        </div>

        {/* 구름 오버레이 토글 */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              if (cloudGrid) {
                setCloudGridVisible(!cloudGridVisible);
              } else {
                startCloudFetch();
              }
            }}
            className={`rounded-lg p-1.5 transition-colors ${
              cloudGridVisible && cloudGrid
                ? "bg-[#a60739] text-white shadow-sm"
                : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            }`}
            title={cloudGrid ? "구름 오버레이 토글" : "구름/기상 데이터 조회 (한국 전역)"}
          >
            <Cloud size={16} />
          </button>
          {cloudGridLoading && (
            <div className="flex items-center gap-1 text-[10px] text-blue-500">
              <Loader2 size={12} className="animate-spin" />
              <span className="max-w-[100px] truncate">{cloudGridProgress || "구름..."}</span>
            </div>
          )}
        </div>

        {/* Terrain toggle */}
        <button
          onClick={() => setTerrainEnabled(!terrainEnabled)}
          className={`rounded-lg p-1.5 transition-colors ${
            terrainEnabled
              ? "bg-[#a60739] text-white shadow-sm"
              : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          }`}
          title="3D 지형"
        >
          <span className="flex h-4 w-4 items-center justify-center text-[11px] font-bold leading-none">3D</span>
        </button>
      </div>

      {/* LOS mode indicator */}
      {losMode && !losTarget && (
        <div className="flex items-center gap-2 bg-[#a60739]/10 px-4 py-1.5 text-xs text-[#a60739]">
          <Crosshair size={12} />
          <span>LOS 분석 모드: 지도에서 분석할 지점을 클릭하세요</span>
          <button
            onClick={() => { setLosMode(false); setLosTarget(null); setLosCursor(null); setLosHighlightIdx(null); setLosBuildingHighlight(null); setDetailBuilding(null); }}
            className="ml-auto text-[10px] text-gray-500 hover:text-gray-900"
          >
            취소
          </button>
        </div>
      )}

      {/* Map + Building Detail sidebar wrapper */}
      <div className="relative flex flex-1 min-h-0">
      {/* Map container */}
      <div className="flex flex-col flex-1 min-w-0">
        <div className="relative flex-1">
        <MapGL
          ref={mapRef}
          {...viewState}
          onMove={(evt) => setViewState(evt.viewState)}
          onLoad={onMapLoad}
          onClick={handleMapClick}
          onMouseMove={handleMapMouseMove}
          mapStyle={MAP_STYLE_URL}
          maxPitch={85}
          style={{ width: "100%", height: "100%" }}
          cursor={losMode ? "crosshair" : undefined}
          attributionControl={false}
          // @ts-expect-error preserveDrawingBuffer is a valid maplibre option but not typed in react-map-gl
          preserveDrawingBuffer={true}
        >
          <DeckGLOverlay layers={deckLayers} />
          <NavigationControl position="top-right" showZoom={false} />
        </MapGL>

        {/* Hover tooltip */}
        {hoverInfo && (
          <div
            className="pointer-events-none absolute z-[1000] rounded-lg border border-gray-200 bg-white/95 px-3 py-2.5 text-xs shadow-xl backdrop-blur-sm"
            style={{ left: hoverInfo.x + 14, top: hoverInfo.y - 14 }}
          >
            {hoverInfo.lines.map((line, i) => (
              <div key={i} className={`flex items-center gap-2 ${i > 0 ? "mt-1" : ""}`}>
                {i === 0 && line.color && (
                  <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: line.color }} />
                )}
                <span className="text-gray-500">{line.label}</span>
                <span className={i === 0 ? "font-semibold text-gray-800" : "text-gray-600"}>
                  {line.value}
                </span>
              </div>
            ))}
          </div>
        )}


        {/* 범례 (왼쪽 하단) */}
        {allPoints.length > 0 && (
          <div className="absolute bottom-3 left-3 z-[1000] rounded-lg border border-gray-200 bg-white/95 px-3 py-2.5 text-[10px] backdrop-blur-sm shadow-lg">
            <div className="mb-1.5 text-[9px] font-semibold text-gray-500 uppercase tracking-wider">범례</div>
            <div className="space-y-1">
              {/* 탐지 유형 범례 (항상 표시) */}
              {(() => {
                const shown = new Map<string, [number,number,number]>();
                for (const tp of trackPaths) {
                  if (!shown.has(tp.radarType)) shown.set(tp.radarType, tp.color);
                }
                return Array.from(shown.entries()).map(([rt, color]) => (
                  <div key={rt} className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-[3px] w-4 rounded-sm"
                      style={{
                        backgroundColor: `rgb(${color[0]},${color[1]},${color[2]})`,
                      }}
                    />
                    <span className="text-gray-500">{radarTypeLabel(rt)}</span>
                  </div>
                ));
              })()}
              {/* 고정 범례 항목 */}
              <div className="border-t border-gray-200 pt-1 mt-1 space-y-1">
                <div className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-full bg-[#ef4444]" />
                  <span className="text-gray-600">표적소실</span>
                </div>
                {showBuildings && buildingOverlayData.length > 0 && (
                  <>
                    <div className="flex items-center gap-1.5">
                      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: "#8b5cf6" }} />
                      <span className="text-gray-600">GIS 건물</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: "#f97316" }} />
                      <span className="text-gray-600">수동 등록 건물</span>
                    </div>
                  </>
                )}
                {cloudGridVisible && cloudGrid && (
                  <div className="flex items-center gap-1.5">
                    <span className="inline-flex items-center justify-center h-3 w-4">
                      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: "rgba(30,30,40,0.8)" }} />
                      <span className="inline-block h-1 w-1 rounded-full ml-0.5" style={{ backgroundColor: "rgba(30,30,40,0.5)" }} />
                    </span>
                    <span className="text-gray-600">구름</span>
                  </div>
                )}
                {coverageVisible && coverageLayers.length > 0 && (() => {
                  const fmtAlt = (ft: number) => ft >= 1000 ? `${(ft / 1000).toFixed(ft % 1000 === 0 ? 0 : 1)}kft` : `${ft}ft`;
                  const effMin = Math.min(coverageAltMin, coverageAlt);
                  const effMax = Math.max(coverageAltMin, coverageAlt);
                  const colorMin = altToColor(effMin);
                  const colorMax = altToColor(effMax);
                  return (
                    <div className="flex items-center gap-1.5">
                      <span
                        className="inline-block h-3 w-5 rounded-sm"
                        style={{
                          background: `linear-gradient(to right, rgb(${colorMin}), rgb(${altToColor(effMin + (effMax - effMin) * 0.5)}), rgb(${colorMax}))`,
                          opacity: 0.7,
                        }}
                      />
                      <span className="text-gray-600">커버리지 ({fmtAlt(effMin)}~{fmtAlt(effMax)})</span>
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        )}

        {/* Empty state overlay */}
        {allPoints.length === 0 && (
          <div className="absolute inset-0 z-[500] flex items-center justify-center bg-black/20 backdrop-blur-sm">
            <div className="text-center rounded-xl bg-white/95 px-8 py-6 shadow-lg border border-gray-200">
              <p className="text-lg font-medium text-gray-700">
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
          onClose={() => { setLosTarget(null); setLosMode(false); setLosCursor(null); setLosHoverRatio(null); setLosHighlightIdx(null); setLosHoverIdx(null); setLosBuildingHighlight(null); setDetailBuilding(null); }}
          onHoverDistance={setLosHoverRatio}
          losTrackPoints={losTrackPoints}
          onLoaded={handleLosLoaded}
          onTrackPointHighlight={setLosHighlightIdx}
          externalHighlightIdx={losHighlightIdx}
          onTrackPointHover={setLosHoverIdx}
          externalHoverIdx={losHoverIdx}
          onBuildingHover={setLosBuildingHighlight}
          onBuildingDetail={setDetailBuilding}
        />
      )}
      </div>

      {/* 건물 상세보기 사이드바 (Google Street View + Maps) */}
      <div
        className="flex-shrink-0 flex flex-col border-l border-gray-200 bg-white overflow-hidden transition-[width] duration-300 ease-in-out"
        style={{ width: detailBuilding ? 360 : 0, borderLeftWidth: detailBuilding ? 1 : 0 }}
      >
        {detailBuilding && (() => {
          const lat = detailBuilding.lat;
          const lon = detailBuilding.lon;
          const label = detailBuilding.name || detailBuilding.address || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
          const dLon = lon - radarSite.longitude;
          const dLat = lat - radarSite.latitude;
          const headingFromRadar = ((Math.atan2(dLon * Math.cos(lat * Math.PI / 180), dLat) * 180 / Math.PI) + 360) % 360;
          const headingToBuilding = (headingFromRadar + 180) % 360;
          return (
            <>
            <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2" style={{ minWidth: 360 }}>
              <div className="min-w-0 flex-1">
                <h3 className="text-xs font-semibold text-gray-800 truncate">{label}</h3>
                <p className="text-[10px] text-gray-400 mt-0.5 truncate">
                  {lat.toFixed(6)}°N, {lon.toFixed(6)}°E
                  {detailBuilding.height_m > 0 && ` · ${detailBuilding.height_m.toFixed(1)}m`}
                  {detailBuilding.usage && ` · ${detailBuilding.usage}`}
                </p>
              </div>
              <button
                onClick={() => setDetailBuilding(null)}
                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors ml-2"
              >
                <X size={14} />
              </button>
            </div>
            <div className="flex-1 flex flex-col min-h-0 overflow-y-auto" style={{ minWidth: 360 }}>
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="px-2 py-1 text-[9px] font-medium text-gray-400 uppercase tracking-wider bg-gray-50">Street View</div>
                <div className="flex-1 min-h-[200px] overflow-hidden relative">
                  <iframe
                    title="Street View"
                    style={{ border: 0, position: "absolute", top: -72, left: -2, width: "calc(100% + 74px)", height: "calc(100% + 96px)" }}
                    loading="lazy"
                    referrerPolicy="no-referrer-when-downgrade"
                    src={`https://maps.google.com/maps?layer=c&cbll=${lat},${lon}&cbp=12,${headingToBuilding.toFixed(0)},0,0,0&output=svembed`}
                  />
                </div>
              </div>
              <div className="flex-1 min-h-0 flex flex-col border-t border-gray-100">
                <div className="px-2 py-1 text-[9px] font-medium text-gray-400 uppercase tracking-wider bg-gray-50">Google Maps</div>
                <div className="flex-1 min-h-[200px] overflow-hidden relative">
                  <iframe
                    title="Google Maps"
                    style={{ border: 0, position: "absolute", top: -2, left: -2, width: "calc(100% + 74px)", height: "calc(100% + 50px)" }}
                    loading="lazy"
                    referrerPolicy="no-referrer-when-downgrade"
                    src={`https://maps.google.com/maps?q=${lat},${lon}&z=18&t=k&output=embed`}
                  />
                </div>
              </div>
            </div>
            </>
          );
        })()}
      </div>
      </div>

      {/* Bottom control bar - 타임라인 */}
      {allPoints.length > 0 && (() => {
        // Loss 구간 타임라인 마커
        const lossMarkers = allLoss
          .map((l) => {
            const range = timeRange.max - timeRange.min;
            if (range <= 0) return null;
            const startPct = ((l.start_time - timeRange.min) / range) * 100;
            const endPct = ((l.end_time - timeRange.min) / range) * 100;
            return { startPct, endPct };
          })
          .filter(Boolean) as { startPct: number; endPct: number }[];

        return (
        <div className="border-t border-gray-200 bg-white/95 backdrop-blur-sm shadow-lg">
          <div className="flex items-center gap-3 px-4 py-2 min-h-[44px]">
            {/* 시작점 시각 (2행) */}
            <div className="min-w-[62px] text-center font-mono leading-tight">
              <div className="text-[10px] text-gray-300">{fmtDate(pctToTs(rangeStart))}</div>
              <div className="text-xs text-gray-400">{fmtTime(pctToTs(rangeStart))}</div>
            </div>

            {/* 통합 타임라인 */}
            <div
              ref={timelineRef}
              className="relative flex-1 h-6 select-none cursor-pointer self-center"
              onPointerDown={(e) => {
                if (!timelineRef.current) return;
                e.preventDefault();
                const rect = timelineRef.current.getBoundingClientRect();
                const screenPct = ((e.clientX - rect.left) / rect.width) * 100;
                const [zvs, zve] = zoomViewRef.current;
                const pct = Math.max(0, Math.min(100, zvs + (screenPct / 100) * (zve - zvs)));
                const rangeStartScreen = absToScreen(rangeStart);
                // 시작점 핸들 근처(화면 4% 이내)면 시작점 드래그
                if (Math.abs(screenPct - rangeStartScreen) < 4 && pct <= sliderValue) {
                  setDraggingStart(true);
                  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                } else {
                  // 시크 — 재생 중이면 재생 유지
                  setSliderValue(Math.max(pct, rangeStart));
                  setDraggingStart(false);
                  const onMove = (me: PointerEvent) => {
                    const r = timelineRef.current?.getBoundingClientRect();
                    if (!r) return;
                    const sp = ((me.clientX - r.left) / r.width) * 100;
                    const [vs2, ve2] = zoomViewRef.current;
                    const p = Math.max(0, Math.min(100, vs2 + (sp / 100) * (ve2 - vs2)));
                    setSliderValue(Math.max(p, rangeStart));
                  };
                  const onUp = () => {
                    window.removeEventListener("pointermove", onMove);
                    window.removeEventListener("pointerup", onUp);
                  };
                  window.addEventListener("pointermove", onMove);
                  window.addEventListener("pointerup", onUp);
                }
              }}
              onPointerMove={(e) => {
                if (!draggingStart || !timelineRef.current) return;
                const rect = timelineRef.current.getBoundingClientRect();
                const sp = ((e.clientX - rect.left) / rect.width) * 100;
                const [zvs, zve] = zoomViewRef.current;
                const pct = Math.max(0, Math.min(sliderValue, zvs + (sp / 100) * (zve - zvs)));
                setRangeStart(pct);
              }}
              onPointerUp={() => setDraggingStart(false)}
              onPointerCancel={() => setDraggingStart(false)}
              onDoubleClick={() => { zoomViewRef.current = [0, 100]; setZoomView([0, 100]); }}
            >
              {/* 트랙 배경 + 시간 눈금 */}
              <div className="absolute left-0 right-0 top-0 h-6 rounded bg-gray-100 overflow-hidden">
                {/* 타겟별 데이터 띠 */}
                {timelineBands.map((band, bi) => (
                  band.segments.map((seg, si) => {
                    const l = absToScreen(seg.start);
                    const r = absToScreen(seg.end);
                    if (r < -5 || l > 105) return null;
                    return (
                      <div
                        key={`${bi}-${si}`}
                        className="absolute rounded-sm"
                        style={{
                          left: `${l}%`,
                          width: `${Math.max(0.3, r - l)}%`,
                          top: `${(bi / Math.max(timelineBands.length, 1)) * 100}%`,
                          height: `${Math.max(3, 100 / Math.max(timelineBands.length, 1))}%`,
                          backgroundColor: `rgba(${band.color[0]},${band.color[1]},${band.color[2]},0.5)`,
                        }}
                      />
                    );
                  })
                ))}
                {/* Loss 마커 (빨간 틱) */}
                {lossMarkers.map((lm, i) => {
                  const l = absToScreen(lm.startPct);
                  const r = absToScreen(lm.endPct);
                  if (r < -5 || l > 105) return null;
                  return (
                    <div
                      key={`loss-${i}`}
                      className="absolute bottom-0 rounded-sm"
                      style={{
                        left: `${l}%`,
                        width: `${Math.max(0.3, r - l)}%`,
                        height: "3px",
                        backgroundColor: "rgba(239, 68, 68, 0.8)",
                      }}
                    />
                  );
                })}
                {/* 활성 구간 (시작점 ~ 현재위치) — overflow-hidden 안에서 자동 클리핑 */}
                <div
                  className="absolute top-0 h-full bg-[#a60739]/10 pointer-events-none"
                  style={{ left: `${absToScreen(rangeStart)}%`, width: `${Math.max(0, absToScreen(sliderValue) - absToScreen(rangeStart))}%` }}
                />
              </div>
              {/* 시작점 핸들 — 줌 인 시 뷰 경계에 고정 */}
              <div
                className="absolute top-0 -translate-x-1/2 cursor-ew-resize z-[100]"
                style={{ left: `${Math.max(0, Math.min(100, absToScreen(rangeStart)))}%` }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDraggingStart(true);
                  timelineRef.current?.setPointerCapture(e.pointerId);
                }}
              >
                <div className={`h-6 w-2.5 rounded-sm border transition-colors ${
                  draggingStart
                    ? "border-white bg-[#a60739]"
                    : "border-[#a60739]/60 bg-white/80 hover:bg-[#a60739]/20"
                }`}>
                  <div className="flex flex-col items-center justify-center h-full gap-[2px]">
                    <div className="w-1 h-px bg-[#a60739]/50 rounded" />
                    <div className="w-1 h-px bg-[#a60739]/50 rounded" />
                    <div className="w-1 h-px bg-[#a60739]/50 rounded" />
                  </div>
                </div>
              </div>
              {/* 재생 위치 인디케이터 + 현재 시각 — 줌 인 시 뷰 경계에 고정 */}
              <div
                className="absolute top-0 -translate-x-1/2 pointer-events-none z-[99]"
                style={{ left: `${Math.max(0, Math.min(100, absToScreen(sliderValue)))}%` }}
              >
                <div className="h-6 w-0.5 bg-[#a60739] rounded-full shadow-sm" />
              </div>
            </div>

            {/* 현재 재생 시각 */}
            <div className="min-w-[62px] text-center font-mono leading-tight">
              <div className="text-[10px] text-gray-300">{fmtDate(pctToTs(sliderValue))}</div>
              <div className="text-xs text-gray-400">{fmtTime(pctToTs(sliderValue))}</div>
            </div>

          </div>
        </div>
        );
      })()}
    </div>
  );
}
