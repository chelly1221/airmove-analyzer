import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import MapGL, { NavigationControl, type MapRef } from "react-map-gl/maplibre";
import type maplibregl from "maplibre-gl";
import { DeckGLOverlay } from "../components/Map/DeckGLOverlay";
import { PathLayer, ScatterplotLayer, LineLayer, IconLayer } from "@deck.gl/layers";
import {
  Filter,
  Play,
  Pause,
  Mountain,
  Crosshair,
  CircleDot,
} from "lucide-react";
import { format } from "date-fns";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import type { TrackPoint, LossSegment, AdsbTrack } from "../types";
import LOSProfilePanel from "../components/Map/LOSProfilePanel";

/** 항공기별 색상 팔레트 (비행검사기 전체 모드) */
const AIRCRAFT_COLORS: [number, number, number][] = [
  [59, 130, 246],   // blue
  [16, 185, 129],   // emerald
  [139, 92, 246],   // violet
  [6, 182, 212],    // cyan
  [249, 115, 22],   // orange
  [236, 72, 153],   // pink
  [132, 204, 22],   // lime
  [245, 158, 11],   // amber
  [99, 102, 241],   // indigo
  [20, 184, 166],   // teal
];

/**
 * 탐지 유형 3색 계열:
 *   노랑 = A/C 계열, 초록 = S 계열, 파랑 = A/C+S 계열
 *   PSR 동반 시 동일 색상 + glow 효과
 */
const DETECTION_TYPE_COLORS: Record<string, [number, number, number]> = {
  mode_ac:              [234, 179, 8],    // yellow
  mode_ac_psr:          [234, 179, 8],    // yellow (glow)
  mode_s_allcall:       [34, 197, 94],    // green
  mode_s_allcall_psr:   [34, 197, 94],    // green (glow)
  mode_s_rollcall:      [139, 92, 246],   // purple
  mode_s_rollcall_psr:  [16, 185, 129],   // emerald (glow)
};

/** PSR 동반 탐지 유형 */
const PSR_TYPES = new Set(["mode_ac_psr", "mode_s_allcall_psr", "mode_s_rollcall_psr"]);

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

/** 범례 3색 계열 그룹 */
const LEGEND_GROUPS = [
  { label: "Mode A/C", color: [234, 179, 8] as [number, number, number], types: ["mode_ac", "mode_ac_psr"] },
  { label: "Mode S All-Call", color: [34, 197, 94] as [number, number, number], types: ["mode_s_allcall", "mode_s_allcall_psr"] },
  { label: "Mode S Roll-Call", color: [139, 92, 246] as [number, number, number], types: ["mode_s_rollcall", "mode_s_rollcall_psr"] },
];


const MAP_STYLE_URL = "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json";

const SPEED_OPTIONS = [1, 60, 120, 300];

/** ADS-B 보간 핀 (5초 간격) */
interface LossAdsbPin {
  position: [number, number, number]; // [lon, lat, alt]
  time: number;
  altitude: number;
  heading: number;
  modeS: string;
  secondsIntoLoss: number;
  lossDuration: number;
}

/** 방위각 보간 (360° 랩어라운드 처리) */
function interpHeading(h0: number, h1: number, t: number): number {
  let diff = h1 - h0;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return ((h0 + diff * t) % 360 + 360) % 360;
}

/** ADS-B 포인트 시간 보간 */
function interpolateAdsb(
  points: import("../types").AdsbPoint[],
  targetTime: number,
): { lat: number; lon: number; alt: number; heading: number } | null {
  if (points.length === 0) return null;
  // 범위 밖
  if (targetTime < points[0].time || targetTime > points[points.length - 1].time) return null;
  // 이진 탐색으로 앞쪽 포인트 찾기
  let lo = 0, hi = points.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].time <= targetTime) lo = mid; else hi = mid;
  }
  const p0 = points[lo], p1 = points[hi];
  if (p1.time === p0.time) {
    return { lat: p0.latitude, lon: p0.longitude, alt: p0.altitude, heading: p0.heading };
  }
  const t = (targetTime - p0.time) / (p1.time - p0.time);
  return {
    lat: p0.latitude + (p1.latitude - p0.latitude) * t,
    lon: p0.longitude + (p1.longitude - p0.longitude) * t,
    alt: p0.altitude + (p1.altitude - p0.altitude) * t,
    heading: interpHeading(p0.heading, p1.heading, t),
  };
}

interface TrackPath {
  modeS: string;
  radarType: string;
  path: [number, number, number][];
  color: [number, number, number];
  avgAlt: number;
  pointCount: number;
  hasPsr: boolean;
}

export default function TrackMap() {
  const analysisResults = useAppStore((s) => s.analysisResults);
  const aircraft = useAppStore((s) => s.aircraft);
  const radarSite = useAppStore((s) => s.radarSite);
  const setRadarSite = useAppStore((s) => s.setRadarSite);
  const customRadarSites = useAppStore((s) => s.customRadarSites);
  const selectedModeS = useAppStore((s) => s.selectedModeS);
  const setSelectedModeS = useAppStore((s) => s.setSelectedModeS);
  const adsbTracks = useAppStore((s) => s.adsbTracks);
  const setAdsbTracks = useAppStore((s) => s.setAdsbTracks);
  const adsbLoading = useAppStore((s) => s.adsbLoading);
  const adsbProgress = useAppStore((s) => s.adsbProgress);

  const [sliderValue, setSliderValue] = useState(100);
  const [playing, setPlaying] = useState(false);
  const altScale = 1;
  const [dotMode, setDotMode] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(1);
  const [rangeStart, setRangeStart] = useState(0);
  /** 재생 모드 트레일 길이 (초). 0=전체 표시, >0=최근 N초만 표시 */
  const [trailDuration, setTrailDuration] = useState(0);
  const [hoverInfo, setHoverInfo] = useState<{
    x: number;
    y: number;
    lines: { label: string; value: string; color?: string }[];
  } | null>(null);
  const [terrainEnabled, setTerrainEnabled] = useState(true);
  const [modeSSearch, setModeSSearch] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [speedDropOpen, setSpeedDropOpen] = useState(false);
  const [trailDropOpen, setTrailDropOpen] = useState(false);

  // LOS Analysis state
  const [losMode, setLosMode] = useState(false);
  const [losTarget, setLosTarget] = useState<{ lat: number; lon: number } | null>(null);
  const [losCursor, setLosCursor] = useState<{ lat: number; lon: number } | null>(null);
  const [losHoverRatio, setLosHoverRatio] = useState<number | null>(null);
  const savedTerrainRef = useRef(true); // LOS 모드 진입 전 지형 상태 저장
  const savedPitchRef = useRef(45);
  const savedBearingRef = useRef(0);

  const mapRef = useRef<MapRef>(null);
  const terrainAdded = useRef(false);
  const playRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const speedRef = useRef<HTMLDivElement>(null);
  const trailRef = useRef<HTMLDivElement>(null);
  const fittedRef = useRef(false);
  const prevPointsLen = useRef(0);

  // DB에서 ADS-B 트랙 로드 (분석 결과 변경 시)
  useEffect(() => {
    if (analysisResults.length === 0) return;
    const icao24List = aircraft.filter((a) => a.active).map((a) => a.mode_s_code);
    if (icao24List.length === 0) return;
    let minTs = Infinity, maxTs = -Infinity;
    for (const r of analysisResults) {
      if (r.file_info.start_time != null && r.file_info.start_time < minTs) minTs = r.file_info.start_time;
      if (r.file_info.end_time != null && r.file_info.end_time > maxTs) maxTs = r.file_info.end_time;
    }
    if (minTs === Infinity) return;
    invoke<AdsbTrack[]>("load_adsb_tracks_for_range", {
      icao24_list: icao24List, start: minTs, end: maxTs,
    }).then((tracks) => {
      if (tracks.length > 0) setAdsbTracks(tracks);
    }).catch(() => {});
  }, [analysisResults, aircraft]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // 색상 모드: null(비행검사기 전체) → 항공기별, 그 외 → 탐지유형별
    const colorByAircraft = !selectedModeS;
    let acIdx = 0;
    for (const [modeS, pts] of groups) {
      if (pts.length < 2) continue;

      // 레이더 5초 회전주기 기준, 8초 이상 gap이면 세그먼트 분할
      const splitThreshold = 8;

      const totalAlts = pts.map((p) => p.altitude);
      const avgAlt = totalAlts.reduce((s, a) => s + a, 0) / totalAlts.length;

      // 항공기별 고정 색상
      const acColor = AIRCRAFT_COLORS[acIdx % AIRCRAFT_COLORS.length];

      let segStart = 0;
      for (let i = 1; i <= pts.length; i++) {
        const isEnd = i === pts.length;
        const hasGap = !isEnd && pts[i].timestamp - pts[i - 1].timestamp > splitThreshold;
        const typeChanged = !colorByAircraft && !isEnd && pts[i].radar_type !== pts[i - 1].radar_type;

        if (isEnd || hasGap || typeChanged) {
          const seg = pts.slice(segStart, i);
          if (seg.length >= 2) {
            const rt = seg[0].radar_type;
            const color = colorByAircraft ? acColor : detectionTypeColor(rt);
            paths.push({
              modeS,
              radarType: rt,
              path: seg.map((p) => [p.longitude, p.latitude, losMode ? 0 : p.altitude * altScale]),
              color,
              avgAlt,
              pointCount: seg.length,
              hasPsr: PSR_TYPES.has(rt),
            });
          }
          if (typeChanged && !hasGap) {
            segStart = i - 1;
          } else {
            segStart = i;
          }
        }
      }
      acIdx++;
    }
    return paths;
  }, [allPoints, visibleMinTs, visibleMaxTs, altScale, losMode, selectedModeS]);

  // Loss 데이터 (signal_loss만 표시)
  const signalLoss = useMemo(() => {
    return allLoss.filter(
      (s) => s.loss_type === "signal_loss" && s.start_time >= visibleMinTs && s.start_time <= visibleMaxTs
    );
  }, [allLoss, visibleMinTs, visibleMaxTs]);

  // ADS-B fetch는 FileUpload에서 관리 (store 공유)

  // Loss 구간별 ADS-B 경로 매칭 (경로 좌표 + 원본 포인트 보존)
  const lossAdsbPaths = useMemo(() => {
    if (adsbTracks.length === 0) return null;
    const map = new Map<string, { loss: LossSegment; path: [number, number, number][]; adsbPoints: import("../types").AdsbPoint[] }[]>();
    for (const loss of signalLoss) {
      const matchingTrack = adsbTracks.find(
        (t) => t.icao24.toLowerCase() === loss.mode_s.toLowerCase()
      );
      if (!matchingTrack) continue;
      // Loss 시간 전후 30초 패딩 (경로 렌더링용)
      const pts = matchingTrack.path.filter(
        (p) => p.time >= loss.start_time - 30 && p.time <= loss.end_time + 30 && !p.on_ground
      );
      if (pts.length < 2) continue;
      const key = `${loss.mode_s}_${loss.start_time}`;
      map.set(key, [
        ...(map.get(key) || []),
        {
          loss,
          path: pts.map((p) => [p.longitude, p.latitude, p.altitude] as [number, number, number]),
          adsbPoints: pts,
        },
      ]);
    }
    return map;
  }, [signalLoss, adsbTracks]);

  // Loss 구간 5초 간격 핀 생성 (ADS-B 보간)
  const lossAdsbPins = useMemo(() => {
    if (!lossAdsbPaths || lossAdsbPaths.size === 0) return [];
    const pins: LossAdsbPin[] = [];
    for (const entries of lossAdsbPaths.values()) {
      for (const { loss, adsbPoints } of entries) {
        const duration = loss.end_time - loss.start_time;
        for (let sec = 0; sec <= duration; sec += 5) {
          const t = loss.start_time + sec;
          const pt = interpolateAdsb(adsbPoints, t);
          if (!pt) continue;
          pins.push({
            position: [pt.lon, pt.lat, pt.alt],
            time: t,
            altitude: pt.alt,
            heading: pt.heading,
            modeS: loss.mode_s,
            secondsIntoLoss: sec,
            lossDuration: duration,
          });
        }
      }
    }
    return pins;
  }, [lossAdsbPaths]);

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

  // 타임라인 밴드용 안정적 색상 맵 (슬라이더 위치와 무관하게 allPoints 기반)
  const bandColorMap = useMemo(() => {
    const map = new Map<string, [number, number, number]>();
    let idx = 0;
    for (const p of allPoints) {
      if (!map.has(p.mode_s)) {
        map.set(p.mode_s, AIRCRAFT_COLORS[idx % AIRCRAFT_COLORS.length]);
        idx++;
      }
    }
    return map;
  }, [allPoints]);

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

  // LOS mode map click handler + 카메라 자동 정렬
  const handleMapClick = useCallback(
    (evt: any) => {
      if (!losMode) return;
      const { lngLat } = evt;
      const target = { lat: lngLat.lat, lon: lngLat.lng };
      setLosTarget(target);
      // LOS 선이 수평으로 보이도록 카메라 자동 정렬 (레이더=좌, 타겟=우)
      const map = mapRef.current?.getMap();
      if (map) {
        const rLat = radarSite.latitude;
        const rLon = radarSite.longitude;
        const cosLat = Math.cos(((rLat + target.lat) / 2) * Math.PI / 180);
        const dLon = (target.lon - rLon) * cosLat;
        const dLat = target.lat - rLat;
        const bearing = (Math.atan2(dLon, dLat) * 180) / Math.PI;
        // LOS 방위 - 90° → LOS 선이 화면 수평 (레이더 좌, 타겟 우)
        const cameraBearing = ((bearing - 90) % 360 + 360) % 360;
        const minLat = Math.min(rLat, target.lat);
        const maxLat = Math.max(rLat, target.lat);
        const minLon = Math.min(rLon, target.lon);
        const maxLon = Math.max(rLon, target.lon);
        map.fitBounds(
          [[minLon, minLat], [maxLon, maxLat]],
          { bearing: cameraBearing, pitch: 0, padding: { top: 80, bottom: 250, left: 80, right: 80 }, duration: 800, maxZoom: 12 }
        );
      }
    },
    [losMode, radarSite]
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
      // PSR glow 링 (PSR 동반 포인트만)
      const psrDots = dotPoints.filter((d) => PSR_TYPES.has(d.radar_type));
      if (psrDots.length > 0 && selectedModeS) {
        layers.push(
          new ScatterplotLayer<TrackPoint>({
            id: "dot-psr-glow",
            data: psrDots,
            getPosition: (d) => [d.longitude, d.latitude, losMode ? 0 : d.altitude * altScale],
            getFillColor: (d) => [...detectionTypeColor(d.radar_type), 30],
            getRadius: 7,
            radiusMinPixels: 4,
            radiusMaxPixels: 10,
            radiusUnits: "pixels",
            billboard: true,
            parameters: { depthWriteEnabled: false },
          })
        );
      }
      // 고도 위치 점
      layers.push(
        new ScatterplotLayer<TrackPoint>({
          id: "dot-points",
          data: dotPoints,
          getPosition: (d) => [d.longitude, d.latitude, losMode ? 0 : d.altitude * altScale],
          getFillColor: (d) => {
            const c = selectedModeS
              ? detectionTypeColor(d.radar_type)
              : (modeSColorMap.get(d.mode_s) ?? [128, 128, 128]);
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
      // PSR glow 레이어 (PSR 동반 세그먼트만 넓은 반투명 경로)
      // depthWriteEnabled: false → glow가 depth buffer에 쓰지 않아 실선을 가리지 않음
      const psrPaths = trackPaths.filter((d) => d.hasPsr);
      if (psrPaths.length > 0) {
        layers.push(
          new PathLayer<TrackPath>({
            id: "track-psr-glow",
            data: psrPaths,
            getPath: (d) => d.path,
            getColor: (d) => [...d.color, 30],
            getWidth: 8,
            widthMinPixels: 4,
            widthMaxPixels: 12,
            widthUnits: "pixels",
            billboard: true,
            jointRounded: true,
            capRounded: true,
            parameters: { depthWriteEnabled: false },
          })
        );
      }
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

    // Signal Loss 구간: ADS-B 기반 5초 간격 dot 표시
    if (signalLoss.length > 0) {
      // ADS-B 5초 간격 핀 (주 표시 방식)
      if (lossAdsbPins.length > 0) {
        layers.push(
          new ScatterplotLayer<LossAdsbPin>({
            id: "loss-adsb-pins",
            data: lossAdsbPins,
            getPosition: (d) => losMode ? [d.position[0], d.position[1], 0] : d.position,
            getFillColor: [233, 69, 96, 230],
            getLineColor: [255, 255, 255, 200],
            getRadius: 4,
            radiusMinPixels: 3,
            radiusMaxPixels: 10,
            radiusUnits: "pixels",
            lineWidthMinPixels: 1,
            stroked: true,
            billboard: true,
            pickable: true,
            onHover: (info) => {
              if (info.object) {
                const d = info.object;
                const name = acName(d.modeS);
                setHoverInfo({
                  x: info.x,
                  y: info.y,
                  lines: [
                    { label: "표적소실", value: name !== d.modeS ? `${name} (${d.modeS})` : d.modeS, color: "#a60739" },
                    { label: "시각", value: format(new Date(d.time * 1000), "HH:mm:ss") },
                    { label: "소실 후", value: `+${d.secondsIntoLoss.toFixed(0)}초 / ${d.lossDuration.toFixed(0)}초` },
                    { label: "고도", value: `${Math.round(d.altitude)}m (FL${Math.round(d.altitude / 0.3048 / 100)})` },
                    { label: "방위", value: `${d.heading.toFixed(0)}°` },
                    { label: "좌표", value: `${d.position[1].toFixed(4)}°N ${d.position[0].toFixed(4)}°E` },
                  ],
                });
              } else {
                setHoverInfo(null);
              }
            },
          })
        );
      }

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

    }

    return layers;
  }, [trackPaths, signalLoss, altScale, radarInfo, losMode, losTarget, losCursor, dotMode, dotPoints, modeSColorMap, aircraft, adsbTracks, lossAdsbPaths, lossAdsbPins, losHoverRatio, allPoints, selectedModeS]);

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
    const tolerance = 0.015;
    const pts: { distRatio: number; altitude: number; mode_s: string; timestamp: number; radar_type: string; isLoss: boolean }[] = [];
    // 항적 포인트
    for (const p of allPoints) {
      const dx = p.latitude - rLat;
      const dy = p.longitude - rLon;
      const along = dx * cosB + dy * sinB;
      const across = Math.abs(-dx * sinB + dy * cosB);
      if (across < tolerance && along > 0 && along <= lineLen) {
        pts.push({ distRatio: along / lineLen, altitude: p.altitude, mode_s: p.mode_s, timestamp: p.timestamp, radar_type: p.radar_type, isLoss: false });
      }
    }
    // Loss 구간 시작/끝점
    for (const s of signalLoss) {
      for (const [lon, lat, alt, ts] of [
        [s.start_lon, s.start_lat, s.start_altitude, s.start_time],
        [s.end_lon, s.end_lat, s.end_altitude, s.end_time],
      ] as [number, number, number, number][]) {
        const dx = lat - rLat;
        const dy = lon - rLon;
        const along = dx * cosB + dy * sinB;
        const across = Math.abs(-dx * sinB + dy * cosB);
        if (across < tolerance && along > 0 && along <= lineLen) {
          pts.push({ distRatio: along / lineLen, altitude: alt, mode_s: s.mode_s, timestamp: ts, radar_type: "loss", isLoss: true });
        }
      }
    }
    return pts;
  }, [losTarget, radarSite, allPoints, signalLoss]);

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
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
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
      let newRange = Math.max(1, Math.min(100, (ve - vs) * factor));
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
  const fmtTs = useCallback(
    (ts: number) => (ts > 0 ? format(new Date(ts * 1000), "MM-dd HH:mm:ss") : "--/-- --:--:--"),
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
      const color = bandColorMap.get(modeS) ?? [128, 128, 128];
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
  }, [allPoints, timeRange, bandColorMap]);

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
                className="rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-semibold text-gray-600 hover:border-gray-300 transition-colors"
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
                className="rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-semibold text-gray-600 hover:border-gray-300 transition-colors"
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
          <span className="text-[#a60739]">Loss {signalLoss.length}</span>
        </div>

        {/* ADS-B 로딩 표시 */}
        {adsbLoading && adsbProgress && (
          <span className="text-[10px] text-emerald-600">{adsbProgress}</span>
        )}

        <div className="flex-1" />

        {/* Right: Filter button → 2-column dropdown */}
        <div ref={filterRef} className="relative flex items-center">
          <button
            onClick={() => { setFilterOpen(!filterOpen); setModeSSearch(""); }}
            className={`rounded-lg p-1.5 transition-colors ${
              filterOpen
                ? "bg-[#a60739] text-white shadow-sm"
                : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            }`}
            title="필터"
          >
            <Filter size={16} />
          </button>
          {filterOpen && (
            <div className="absolute right-0 top-full z-[2000] mt-1 rounded-lg border border-gray-200 bg-white/95 shadow-xl backdrop-blur-sm">
              {/* 검색 */}
              <div className="px-3 pt-3 pb-1">
                <input
                  type="text"
                  value={modeSSearch}
                  onChange={(e) => setModeSSearch(e.target.value)}
                  placeholder="Mode-S 코드 또는 기체명 검색..."
                  className="w-full rounded border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-800 outline-none placeholder:text-gray-500 focus:border-[#a60739]/50"
                  autoFocus
                />
              </div>
              {/* 2열: 비행검사기 | 레이더 사이트 */}
              <div className="flex divide-x divide-gray-200">
                {/* 왼쪽: 비행검사기 */}
                <div className="w-56">
                  <div className="px-3 pt-2 pb-1">
                    <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">비행검사기</div>
                  </div>
                  <div className="max-h-56 overflow-y-auto py-1 px-1 pb-2">
                    <button
                      onClick={() => { setSelectedModeS(null); setFilterOpen(false); }}
                      className={`w-full px-3 py-1.5 text-left text-sm rounded transition-colors ${!selectedModeS ? "bg-[#a60739] text-white" : "text-gray-600 hover:bg-gray-100"}`}
                    >
                      등록 기체 전체
                    </button>
                    {aircraft.filter((a) => a.active && (!modeSSearch || a.name.toLowerCase().includes(modeSSearch.toLowerCase()) || a.mode_s_code.toLowerCase().includes(modeSSearch.toLowerCase()))).map((a) => (
                      <button
                        key={`ac-${a.id}`}
                        onClick={() => { setSelectedModeS(a.mode_s_code.toUpperCase()); setFilterOpen(false); }}
                        className={`w-full px-3 py-1.5 text-left text-sm rounded transition-colors ${selectedModeS === a.mode_s_code.toUpperCase() ? "bg-[#a60739] text-white" : "text-gray-600 hover:bg-gray-100"}`}
                      >
                        <div className="flex items-center gap-2">
                          <span>{a.name}</span>
                          <span className={`text-[10px] ${selectedModeS === a.mode_s_code.toUpperCase() ? "text-white/60" : "text-gray-400"}`}>{a.mode_s_code}</span>
                        </div>
                      </button>
                    ))}
                    <div className="border-t border-gray-200 my-1 mx-2" />
                    <button
                      onClick={() => { setSelectedModeS("__ALL__"); setFilterOpen(false); }}
                      className={`w-full px-3 py-1.5 text-left text-sm rounded transition-colors ${selectedModeS === "__ALL__" ? "bg-[#a60739] text-white" : "text-gray-600 hover:bg-gray-100"}`}
                    >
                      전체 항적
                    </button>
                    {filteredModeS.map((ms) => (
                      <button
                        key={ms}
                        onClick={() => { setSelectedModeS(ms); setFilterOpen(false); }}
                        className={`w-full px-3 py-1.5 text-left text-sm rounded transition-colors ${selectedModeS === ms ? "bg-[#a60739] text-white" : "text-gray-600 hover:bg-gray-100"}`}
                      >
                        {getAircraftName(ms)}
                      </button>
                    ))}
                    {filteredModeS.length === 0 && aircraft.filter((a) => a.active).length === 0 && modeSSearch && (
                      <div className="px-3 py-2 text-xs text-gray-400">검색 결과 없음</div>
                    )}
                  </div>
                </div>
                {/* 오른쪽: 레이더 사이트 */}
                <div className="w-52">
                  <div className="px-3 pt-2 pb-1">
                    <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">레이더 사이트</div>
                  </div>
                  <div className="max-h-56 overflow-y-auto py-1 px-1 pb-2">
                    {allRadarSites.map((site) => (
                      <button
                        key={site.name}
                        onClick={() => { setRadarSite(site); setFilterOpen(false); }}
                        className={`w-full px-3 py-1.5 text-left text-xs rounded transition-colors ${
                          radarSite.name === site.name
                            ? "bg-[#a60739] text-white"
                            : "text-gray-600 hover:bg-gray-100"
                        }`}
                      >
                        <div className="font-medium">{site.name}</div>
                        <div className={`text-[10px] ${radarSite.name === site.name ? "text-white/60" : "text-gray-400"}`}>
                          {site.latitude.toFixed(4)}°N {site.longitude.toFixed(4)}°E | {site.range_nm}NM
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
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
          <CircleDot size={16} />
        </button>

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
            onClick={() => { setLosMode(false); setLosTarget(null); setLosCursor(null); }}
            className="ml-auto text-[10px] text-gray-500 hover:text-gray-900"
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
          mapStyle={MAP_STYLE_URL}
          maxPitch={85}
          style={{ width: "100%", height: "100%" }}
          cursor={losMode ? "crosshair" : undefined}
          attributionControl={false}
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
              {/* 항공기별 범례 (비행검사기 전체 모드) */}
              {!selectedModeS && (() => {
                const shown = new Map<string, [number,number,number]>();
                for (const tp of trackPaths) {
                  if (!shown.has(tp.modeS)) shown.set(tp.modeS, tp.color);
                }
                const entries = Array.from(shown.entries()).slice(0, 8);
                return entries.map(([ms, color]) => {
                  const name = aircraft.find((a) => a.mode_s_code.toUpperCase() === ms.toUpperCase())?.name;
                  return (
                    <div key={ms} className="flex items-center gap-1.5">
                      <span className="inline-block h-[3px] w-4 rounded-sm" style={{ backgroundColor: `rgb(${color[0]},${color[1]},${color[2]})` }} />
                      <span className="text-gray-600">{name ? `${name} (${ms})` : ms}</span>
                    </div>
                  );
                });
              })()}
              {/* 탐지 유형 범례 (3색 계열 + PSR glow) */}
              {selectedModeS && (
              <div className="space-y-1.5">
                <div className="text-[8px] text-gray-500 uppercase tracking-wider mb-0.5">탐지 유형</div>
                {LEGEND_GROUPS.map((g) => (
                  <div key={g.label} className="space-y-0.5">
                    {g.types.map((rt) => {
                      const isPsr = PSR_TYPES.has(rt);
                      return (
                        <div key={rt} className="flex items-center gap-1.5">
                          <span
                            className="inline-block h-[3px] w-4 rounded-sm"
                            style={{
                              backgroundColor: `rgb(${g.color[0]},${g.color[1]},${g.color[2]})`,
                              boxShadow: isPsr ? `0 0 4px 1px rgba(${g.color[0]},${g.color[1]},${g.color[2]},0.6)` : undefined,
                            }}
                          />
                          <span className="text-gray-500">{radarTypeLabel(rt)}</span>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
              )}
              {/* 고정 범례 항목 */}
              <div className="border-t border-gray-200 pt-1 mt-1 space-y-1">
                <div className="flex items-center gap-1.5">
                  <span className="inline-block h-[3px] w-4 rounded-sm bg-[#a60739]" />
                  <span className="text-gray-600">표적소실 구간</span>
                </div>
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
          onClose={() => { setLosTarget(null); setLosMode(false); setLosCursor(null); setLosHoverRatio(null); }}
          onHoverDistance={setLosHoverRatio}
          losTrackPoints={losTrackPoints}
        />
      )}

      {/* Bottom control bar - 타임라인 */}
      {allPoints.length > 0 && (() => {
        // Loss 구간 타임라인 마커
        const lossMarkers = allLoss
          .filter((l) => l.loss_type === "signal_loss")
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
          <div className="flex items-center gap-3 px-4 py-2">
            {/* 시작점 시각 */}
            <span className="min-w-[105px] text-center font-mono text-xs text-gray-400">
              {fmtTs(pctToTs(rangeStart))}
            </span>

            {/* 통합 타임라인 */}
            <div
              ref={timelineRef}
              className="relative flex-1 h-8 select-none cursor-pointer"
              onPointerDown={(e) => {
                if (!timelineRef.current) return;
                e.preventDefault();
                const rect = timelineRef.current.getBoundingClientRect();
                const screenPct = ((e.clientX - rect.left) / rect.width) * 100;
                const [zvs, zve] = zoomViewRef.current;
                const pct = Math.max(0, Math.min(100, zvs + (screenPct / 100) * (zve - zvs)));
                const rangeStartScreen = absToScreen(rangeStart);
                // 시작점 핸들 근처(화면 4% 이내)면 시작점 드래그
                if (Math.abs(screenPct - rangeStartScreen) < 4 && pct < sliderValue - 0.5) {
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
                const pct = Math.max(0, Math.min(sliderValue - 0.5, zvs + (sp / 100) * (zve - zvs)));
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
                className="absolute top-0 -translate-x-1/2 cursor-ew-resize z-10"
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
                className="absolute top-0 -translate-x-1/2 pointer-events-none z-[5]"
                style={{ left: `${Math.max(0, Math.min(100, absToScreen(sliderValue)))}%` }}
              >
                <div className="h-6 w-0.5 bg-[#a60739] rounded-full shadow-sm" />
                <span className="absolute -top-3.5 left-1/2 -translate-x-1/2 whitespace-nowrap font-mono text-[9px] font-semibold text-[#a60739]">
                  {fmtTs(pctToTs(sliderValue))}
                </span>
              </div>
            </div>

            {/* 줌 끝 시각 */}
            <span className="min-w-[105px] text-center font-mono text-xs text-gray-400">
              {fmtTs(pctToTs(zoomVEnd))}
            </span>

          </div>
        </div>
        );
      })()}
    </div>
  );
}
