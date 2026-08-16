import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import MapGL, { NavigationControl, type MapRef } from "react-map-gl/maplibre";
import { ScatterplotLayer, LineLayer, PathLayer, PolygonLayer, TextLayer } from "@deck.gl/layers";
import { TripsLayer } from "@deck.gl/geo-layers";
import { DeckGLOverlay } from "../components/Map/DeckGLOverlay";
import { fetchBuildingsForViewport } from "../utils/buildingTileCache";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { format } from "date-fns";
import { Ghost, FolderOpen, Loader2, Search, ChevronDown, ChevronUp, Crosshair, X, RefreshCw } from "lucide-react";
import Modal from "../components/common/Modal";
import ParseFilterModal, { type ParseFilterResult } from "../components/common/ParseFilterModal";
import { useAppStore } from "../store";
import { parseAssBatch } from "../utils/parseBatch";
import {
  clearWorkerPoints,
  postPointsToWorker,
  postGhostPointsToWorker,
  startConsolidate,
  analyzeDualTargets,
  ConsolidateSuperseded,
} from "../utils/flightConsolidationWorker";
import type {
  Aircraft,
  AddressBuildingHit,
  Building3D,
  DualTargetEvent,
  FacBuildingDetail,
  Flight,
  RadarSite,
  ReflectorCluster,
} from "../types";

/**
 * 이중표적(레이더 반사 유령표적) 분석 — 메인 창 독립 페이지.
 *
 * 메인 창 Worker 에는 포인트가 없다(포인트는 창별 Worker 소유). 따라서 이 페이지는
 * ACAS 페이지와 동일하게 자체적으로 ASS 파일을 선택→파싱→자기 창 Worker 에 적재→분석한다.
 *  1. clearWorkerPoints()            — 재업로드는 "대체" 시맨틱
 *  2. parse-points-chunk / parse-ghost-chunk → radar_name 태깅 후 Worker 전송 (메인 축적 없음)
 *  3. startConsolidate()             — 비행 스트림은 **페이지 로컬 ref** 로만 수집.
 *     메인 창에는 보고서 캡처용 TrackMap 이 오프스크린 상시 마운트되어 store 를 공유하므로
 *     store.appendFlights 로 흘리면 오프스크린 지도가 항적 렌더를 시작한다 → 금지.
 *  4. analyzeDualTargets()           — Worker 소유 데이터로 계산, 결과만 store 에 보관(세션 한정)
 *
 * 결과 스냅샷은 store(dualTargetResult)에 두어 페이지 이탈 후 복귀 시에도 유지한다.
 * 파싱/분석 진행·선택 상태는 페이지 로컬.
 *
 * **분석 레이더(analysisRadarName)** — 파싱은 레이더 좌표를 원점으로 I040 극좌표(거리·방위)를
 * WGS84 로 변환하므로 레이더 선택 = 파싱 앵커 선택이다. 레이더가 달라지면 모든 포인트 좌표가
 * 달라지므로 변경 시 재파싱이 필수(확인 모달 → runParse 재실행). 전역 radarSite 는 초기값일 뿐,
 * 이 페이지의 파싱·태깅·통합은 전부 선택된 analysisSite 를 쓴다.
 */

const ACCENT = "#a60739";
const ERROR = "#e94560";

/** 그룹당 표시 행 상한 — UI 표시만 제한(통계·지도는 전수 이벤트 사용) */
const GROUP_ROW_CAP = 200;
/** 건물명 라벨링 대상 클러스터 수 (count 상위) */
const LABEL_MAX = 20;

// ── 2D 건물 표출 ────────────────────────────────────────────────────
/** 건물 표출 최소 줌 — 미만이면 뷰포트 조회 자체를 생략(광역에서 수만 동 로드 방지) */
const BUILDING_MIN_ZOOM = 13;
/** 지도 이동 후 건물 재조회 디바운스 (ms) */
const BUILDING_FETCH_DEBOUNCE_MS = 250;

// ── 반사체 줌 적응 클러스터링 ────────────────────────────────────────
/** 화면 픽셀 기준 병합 셀 크기 — 이 격자 안의 반사 위치는 한 마커로 합쳐 표시 */
const CLUSTER_CELL_PX = 56;

/** 파싱·분석 요청 epoch — 컴포넌트가 아닌 모듈 스코프.
 *  파싱 도중 페이지 이탈 후 복귀(리마운트)해 새 파싱을 시작해도 카운터가 이어지므로
 *  고아 플로우(잔존 리스너 push·invoke 후속 통합/분석/라벨링)가 확실히 무효화된다. */
let dualRunSeq = 0;

/** "#rrggbb" → [r,g,b] (파싱 불가 시 null) */
function hexToRgb(hex?: string): [number, number, number] | null {
  if (!hex) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 건물 폴리곤 표출 단위 — 커밋마다 1회 변환(원본 polygon 은 [lat,lon] 순서) */
interface DualBuildingPoly {
  b: Building3D;
  /** deck.gl 용 [lon,lat] 링 */
  path: [number, number][];
  fill: [number, number, number, number];
}

/** 줌 적응 병합 반사체 마커 — members 1개면 개별 클러스터와 동일 */
interface ZoomCluster {
  key: string;
  latitude: number;
  longitude: number;
  /** 병합된 이벤트 건수 합 */
  count: number;
  members: ReflectorCluster[];
}

/** 건축물정보 드로어 상태 — 클릭 건물의 로컬 기하 + 대장(로컬 FAC + 온라인 VWorld) 조회 결과 */
interface BldgDrawerState {
  lat: number;
  lon: number;
  /** 재클릭 재조회 논스 — 같은 좌표 재클릭 시 증가시켜 조회 effect deps 에 편입한다
   *  (실패한 대장/VWorld 조회 재시도 + 실측 임포트 후 캐시 갱신분 반영 경로) */
  attempt: number;
  /** 온라인 VWorld 조회 진행 중 */
  loading: boolean;
  info: {
    name: string; dong_name: string; road_addr: string; jibun_addr: string;
    usage: string; structure: string; floors_above: string; floors_below: string;
    height: string; area: string; total_area: string; site_area: string;
    floor_area_ratio: string; building_coverage: string; approval_date: string;
  } | null;
  /** 로컬 FAC 대장 상세 (undefined=조회 전, null=없음) */
  facDetail?: FacBuildingDetail | null;
  localName?: string;
  localHeight?: number;
  localUsage?: string;
  /** 지반 표고(AMSL, m) + 출처(fac/manual) — 클릭 시점 로컬 값 */
  localBase?: number;
  localSource?: string;
  /** 실측(1m DSM) 자료 보유 건물 */
  localMeasured?: boolean;
}

// ── 전파 반사 애니메이션 타임라인 (초) ──────────────────────────────
//   0–2 실표적(항공기) → 반사체 · 2–4 반사체 → 레이더 · 4–6 유령표적 위치 펄스
const ANIM_PERIOD_S = 6;
/** 전파가 레이더에 도달하는 시각 (= 유령표적 펄스 시작) */
const ANIM_ARRIVE_S = 4;
/** TripsLayer waypoint 타임스탬프 — [실표적, 반사체, 레이더] */
const ANIM_TIMESTAMPS = [0, 2, ANIM_ARRIVE_S];
/** 펄스 꼬리 길이 (타임스탬프 단위) */
const ANIM_TRAIL = 1.2;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DeckLayerList = any[];

type Phase = "idle" | "parsing" | "consolidating" | "analyzing";

/** Mode-S 단위 이벤트 그룹 */
interface ModeSGroup {
  modeS: string;
  label: string;
  events: DualTargetEvent[];
  highCount: number;
  maxSepKm: number;
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number };
}

/** Mode-S → "기체명 (MODE_S)" (비행검사기 레지스트리 매칭, 없으면 Mode-S 그대로) */
function labelFor(modeS: string, aircraft: Aircraft[]): string {
  const a = aircraft.find((ac) => ac.mode_s_code?.toUpperCase() === modeS.toUpperCase());
  const name = a?.name || a?.registration;
  return name ? `${name} (${modeS})` : modeS;
}

/** 전파 반사 경로 애니메이션 입력 — null 이면 애니메이션 비활성 */
interface ReflectionAnim {
  /** [실표적 → 반사체 → 레이더] 경로 (TripsLayer 데이터, 참조 고정) */
  tripData: { path: [number, number][] }[];
  /** 유령표적 도달 펄스 + 유령 방위선 (참조 고정) */
  pulseData: { lon: number; lat: number; siteLon: number; siteLat: number }[];
}

/**
 * 지도 레이어 합성 + 전파 반사 애니메이션 프레임 소유.
 *
 * animTime 을 **이 컴포넌트가** 들고 있어야 매 프레임 리렌더가 좌측 대용량 이벤트 목록까지
 * 번지지 않는다(정적 staticLayers 는 부모 useMemo 산출물 그대로 통과 — 프레임마다 재생성 없음).
 */
function DualDeckLayers({ staticLayers, anim }: { staticLayers: DeckLayerList; anim: ReflectionAnim | null }) {
  const [animTime, setAnimTime] = useState(0);

  // rAF 루프 — 선택 이벤트에 반사점이 있을 때만 구동, 해제/언마운트 시 취소
  useEffect(() => {
    if (!anim) {
      setAnimTime((t) => (t === 0 ? t : 0)); // 불필요한 리렌더 방지
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      setAnimTime(((now - t0) / 1000) % ANIM_PERIOD_S);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [anim]);

  const animLayers = useMemo<DeckLayerList>(() => {
    if (!anim) return [];
    // 0–4초: 전파 펄스가 항공기 → 반사체 → 레이더 이동
    if (animTime < ANIM_ARRIVE_S) {
      return [
        new TripsLayer<{ path: [number, number][] }>({
          id: "dual-anim-trip",
          data: anim.tripData,
          getPath: (d) => d.path,
          getTimestamps: () => ANIM_TIMESTAMPS,
          getColor: [233, 69, 96],
          currentTime: animTime,
          trailLength: ANIM_TRAIL,
          fadeTrail: true,
          getWidth: 4,
          widthUnits: "pixels" as const,
          widthMinPixels: 4,
          capRounded: true,
          jointRounded: true,
          pickable: false,
        }),
      ];
    }
    // 4–6초: 유령표적 위치 확장 펄스 링 + 유령 방위선 강조
    const p = (animTime - ANIM_ARRIVE_S) / (ANIM_PERIOD_S - ANIM_ARRIVE_S); // 0 → 1
    const alpha = Math.round(255 * (1 - p));
    return [
      new LineLayer<ReflectionAnim["pulseData"][number]>({
        id: "dual-anim-ghostline",
        data: anim.pulseData,
        getSourcePosition: (d) => [d.siteLon, d.siteLat],
        getTargetPosition: (d) => [d.lon, d.lat],
        getColor: [233, 69, 96, Math.max(120, alpha)],
        getWidth: 3,
        widthUnits: "pixels" as const,
        widthMinPixels: 3,
        updateTriggers: { getColor: alpha },
        pickable: false,
      }),
      new ScatterplotLayer<ReflectionAnim["pulseData"][number]>({
        id: "dual-anim-pulse",
        data: anim.pulseData,
        getPosition: (d) => [d.lon, d.lat],
        stroked: true,
        filled: false,
        radiusUnits: "pixels" as const,
        getRadius: 6 + 20 * p,
        radiusMinPixels: 0,
        getLineColor: [233, 69, 96, alpha],
        lineWidthMinPixels: 2,
        updateTriggers: { getRadius: p, getLineColor: alpha },
        pickable: false,
      }),
    ];
  }, [anim, animTime]);

  return <DeckGLOverlay layers={[...staticLayers, ...animLayers]} />;
}

export default function DualTargetAnalysis() {
  const radarSite = useAppStore((s) => s.radarSite);
  const customRadarSites = useAppStore((s) => s.customRadarSites);
  const aircraft = useAppStore((s) => s.aircraft);
  const dualResult = useAppStore((s) => s.dualTargetResult);
  const setDualResult = useAppStore((s) => s.setDualTargetResult);

  const mapRef = useRef<MapRef>(null);
  /** 비행 스트림 로컬 수집 — store.flights 오염 방지 (오프스크린 TrackMap 렌더 유발 차단) */
  const flightsRef = useRef<Flight[]>([]);
  /** 지도 로드 전에 확정된 fitBounds 예약 (파싱 직후 분석 완료 대비) */
  const pendingFitRef = useRef<[[number, number], [number, number]] | null>(null);
  /** 직전 파싱 입력 — 분석 레이더 변경 시 같은 파일·필터로 재파싱하기 위해 보관 */
  const lastPathsRef = useRef<string[]>([]);
  const lastFilterRef = useRef<ParseFilterResult | null>(null);
  /** 건물 뷰포트 조회 시퀀스 — 늦게 도착한 progressive 커밋 폐기 */
  const buildingSeqRef = useRef(0);
  const buildingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [fileCount, setFileCount] = useState(0);
  const [flightCount, setFlightCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ title: string; message: string } | null>(null);

  // 분석 파라미터
  const [scanWindowS, setScanWindowS] = useState(0.5);
  const [minSepKm, setMinSepKm] = useState(1.0);

  // 선택/표시 상태
  const [search, setSearch] = useState("");
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);
  const [selectedClusterId, setSelectedClusterId] = useState<number | null>(null);
  /** 지도 표출을 특정 기체(Mode-S)로 한정 — 좌측 그룹 목록은 계속 전 기체를 보여준다 */
  const [selectedModeS, setSelectedModeS] = useState<string | null>(null);
  const [expandedModeS, setExpandedModeS] = useState<Set<string>>(new Set());

  // ── 지도 부수 상태 (건물 표출 / 줌 적응 클러스터링) ────────────────
  /** MapGL onLoad 완료 — 지도 이벤트 구독 게이트 */
  const [mapReady, setMapReady] = useState(false);
  /** 0.25 단위로 반올림한 줌 — 반사체 병합 격자 계산 입력(과도 리렌더 방지) */
  const [mapZoom, setMapZoom] = useState(9);
  /** 뷰포트 건물 (줌 ≥ BUILDING_MIN_ZOOM 에서만 채워짐) */
  const [viewBuildings, setViewBuildings] = useState<Building3D[]>([]);
  /** 건축물정보 드로어 — 건물 폴리곤 클릭으로만 열린다 */
  const [bldgDrawer, setBldgDrawer] = useState<BldgDrawerState | null>(null);
  /** 닫힘 애니메이션 중 내용 유지용 마지막 드로어 값 */
  const lastBldgRef = useRef<BldgDrawerState | null>(null);
  if (bldgDrawer) lastBldgRef.current = bldgDrawer;

  /**
   * 분석 기준 레이더 이름 — 파싱(극좌표→WGS84)의 원점.
   * 페이지 재진입으로 결과만 복원된 경우 셀렉터가 결과와 어긋나지 않도록
   * 기존 결과의 레이더를 초기값으로 채운다(없으면 전역 선택 레이더).
   */
  const [analysisRadarName, setAnalysisRadarName] = useState<string>(
    () => dualResult?.events[0]?.radar_name ?? dualResult?.clusters[0]?.radar_name ?? radarSite.name,
  );
  /** 레이더 변경 확인 모달 대상 이름 — null 이면 닫힘 */
  const [radarConfirm, setRadarConfirm] = useState<string | null>(null);

  // 파일 선택 → 필터 모달
  const [filterModalOpen, setFilterModalOpen] = useState(false);
  const [pendingPaths, setPendingPaths] = useState<string[]>([]);

  const busy = phase !== "idle";

  // ── 레이더 사이트 목록 ────────────────────────────────────────────
  // Worker 는 비행의 radar_name 으로 사이트 좌표를 찾아 극좌표(거리·방위)를 재계산한다.
  //   현재 선택 사이트 + 등록 사이트 전부를 이름 기준 dedupe 해 넘겨야 여러 레이더가 섞인
  //   자료에서도 사이트 미매칭(skipped_no_site)으로 통째 누락되는 비행이 생기지 않는다.
  //   지도 강조 레이어도 같은 목록에서 레이더 좌표를 찾으므로 단일 원천이다.
  const dualSites = useMemo(() => {
    const out: { name: string; latitude: number; longitude: number }[] = [];
    const seen = new Set<string>();
    for (const s of [radarSite, ...customRadarSites]) {
      if (!s || !s.name || seen.has(s.name)) continue;
      seen.add(s.name);
      out.push({ name: s.name, latitude: s.latitude, longitude: s.longitude });
    }
    return out;
  }, [radarSite, customRadarSites]);

  /**
   * 분석 기준 레이더의 **원본** 사이트 객체 — 파싱 원점·비행 통합 인자로 그대로 쓴다.
   * startConsolidate 는 RadarSite 전체(고도·안테나고·range_nm)를 요구하므로 좌표만 담은
   * dualSites 항목이 아니라 store 원본을 찾아야 한다. 미등록 이름이면 전역 선택 레이더로 폴백.
   */
  const analysisSite = useMemo<RadarSite>(() => {
    for (const s of [radarSite, ...customRadarSites]) {
      if (s?.name === analysisRadarName) return s;
    }
    return radarSite;
  }, [radarSite, customRadarSites, analysisRadarName]);

  /** 지도 범위 맞춤 — 지도가 아직 로드 전이면 예약 후 onLoad 에서 적용 */
  const fitBounds = useCallback((bounds: [[number, number], [number, number]]) => {
    const map = mapRef.current?.getMap();
    if (!map) {
      pendingFitRef.current = bounds;
      return;
    }
    try {
      map.fitBounds(bounds, { padding: 60, duration: 600, maxZoom: 14 });
    } catch {
      pendingFitRef.current = bounds;
    }
  }, []);

  // ── 2D 건물 표출 ──────────────────────────────────────────────────
  /**
   * 뷰포트 건물 조회 — TrackMap 과 동일한 모듈 글로벌 타일 캐시를 공유한다(포맷 동일).
   * 이 페이지는 캐시를 **무효화하지 않는다**(메인 창 오프스크린 TrackMap 의 로드를 헛돌게 함).
   * 늦게 도착한 progressive 커밋은 seq 로 폐기.
   */
  const loadBuildings = useCallback(async () => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    const zoom = map.getZoom();
    const seq = ++buildingSeqRef.current;

    // 광역 줌에서는 표출하지 않는다 — 조회 생략 + 기존 표출 해제
    if (zoom < BUILDING_MIN_ZOOM) {
      setViewBuildings((prev) => (prev.length === 0 ? prev : []));
      return;
    }

    const bounds = map.getBounds();
    const center = map.getCenter();
    try {
      const res = await fetchBuildingsForViewport(
        {
          south: bounds.getSouth(),
          north: bounds.getNorth(),
          west: bounds.getWest(),
          east: bounds.getEast(),
          zoom,
        },
        [], // 출처 제외 없음 — 출처 토글은 TrackMap 창 로컬 기능
        (list) => {
          if (seq !== buildingSeqRef.current) return; // 늦은 커밋 폐기
          setViewBuildings(list);
        },
        { lat: center.lat, lon: center.lng },
      );
      // 전 타일 캐시 히트면 onProgress 가 호출되지 않으므로 최종 결과로 한 번 더 커밋
      if (seq === buildingSeqRef.current) setViewBuildings(res.buildings);
    } catch (err) {
      console.warn("[DualTarget] 건물 타일 로드 실패:", err);
    }
  }, []);

  // 지도 이벤트 구독 — 건물 재조회(디바운스) + 줌 추적(0.25 단위 변화만 반영)
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current?.getMap();
    if (!map) return;

    const scheduleBuildings = () => {
      if (buildingTimerRef.current) clearTimeout(buildingTimerRef.current);
      buildingTimerRef.current = setTimeout(() => {
        buildingTimerRef.current = null;
        void loadBuildings();
      }, BUILDING_FETCH_DEBOUNCE_MS);
    };
    const trackZoom = () => {
      const z = Math.round(map.getZoom() * 4) / 4;
      setMapZoom((prev) => (prev === z ? prev : z));
    };

    map.on("moveend", scheduleBuildings);
    map.on("zoom", trackZoom);
    trackZoom();
    void loadBuildings(); // 최초 1회

    return () => {
      map.off("moveend", scheduleBuildings);
      map.off("zoom", trackZoom);
      if (buildingTimerRef.current) {
        clearTimeout(buildingTimerRef.current);
        buildingTimerRef.current = null;
      }
    };
  }, [mapReady, loadBuildings]);

  /** 건물 폴리곤 표출 데이터 — 커밋마다 1회만 [lat,lon]→[lon,lat] 변환 + 색상 확정 */
  const buildingPolys = useMemo<DualBuildingPoly[]>(() => {
    const out: DualBuildingPoly[] = [];
    for (const b of viewBuildings) {
      const poly = b.polygon;
      if (!poly || poly.length < 3) continue;
      const path: [number, number][] = new Array(poly.length);
      for (let i = 0; i < poly.length; i++) path[i] = [poly[i][1], poly[i][0]];
      const rgb = hexToRgb(b.group_color);
      out.push({
        b,
        path,
        fill: rgb ? [rgb[0], rgb[1], rgb[2], 90] : [148, 163, 184, 70],
      });
    }
    return out;
  }, [viewBuildings]);

  /** 건물 클릭 → 우측 건축물정보 드로어 (로컬 값 시드 후 대장 조회 effect 가 채운다) */
  const openBuildingDrawer = useCallback((b: Building3D) => {
    setBldgDrawer((prev) => ({
      lat: b.lat,
      lon: b.lon,
      // 같은 건물 재클릭 = 재조회(재시도) — attempt 증가로 effect deps 가 바뀌어
      // loading 고착 없이 대장/VWorld 조회가 다시 돈다. 다른 건물이면 0 으로 시작.
      attempt: prev && prev.lat === b.lat && prev.lon === b.lon ? prev.attempt + 1 : 0,
      loading: true,
      info: null,
      localName: b.name ?? undefined,
      localHeight: b.height_m,
      localUsage: b.usage ?? undefined,
      localBase: b.ground_elev_m,
      localSource: b.source,
      localMeasured: !!b.measured,
    }));
  }, []);

  // 드로어 좌표 설정 시 건물정보 조회 — 로컬 FAC 대장(오프라인) + 온라인 VWorld 병렬
  useEffect(() => {
    if (!bldgDrawer) return;
    const lat = bldgDrawer.lat, lon = bldgDrawer.lon;
    let cancelled = false;
    if (bldgDrawer.facDetail === undefined) {
      invoke<FacBuildingDetail | null>("get_fac_building_detail", { lat, lon })
        .then((res) => { if (!cancelled) setBldgDrawer((prev) => prev ? { ...prev, facDetail: res ?? null } : null); })
        .catch(() => { if (!cancelled) setBldgDrawer((prev) => prev ? { ...prev, facDetail: null } : null); });
    }
    if (bldgDrawer.loading) {
      invoke<BldgDrawerState["info"]>("get_vworld_building_info", { lat, lon })
        .then((res) => { if (!cancelled) setBldgDrawer((prev) => prev ? { ...prev, loading: false, info: res ?? null } : null); })
        .catch(() => { if (!cancelled) setBldgDrawer((prev) => prev ? { ...prev, loading: false, info: null } : null); });
    }
    return () => { cancelled = true; };
  }, [bldgDrawer?.lat, bldgDrawer?.lon, bldgDrawer?.attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 분석 실행 ─────────────────────────────────────────────────────
  //   Worker 소유 포인트로 계산(메인 스레드 축적 없음). 결과 수신 후 상위 클러스터에 한해
  //   건물명을 순차 라벨링한다(전 클러스터 라벨링은 find_building_near_point 호출 과다).
  const runAnalysis = useCallback(async () => {
    const seq = ++dualRunSeq;
    setPhase("analyzing");
    setError(null);
    try {
      const result = await analyzeDualTargets({ sites: dualSites, scanWindowS, minSepKm });
      if (seq !== dualRunSeq) return; // 최신 요청만 반영
      setDualResult(result);
      setSelectedEventId(null);
      setSelectedClusterId(null);
      setSelectedModeS(null);

      // 기본 접힘 + 최다 이벤트 그룹 1개만 펼침 (그룹 정렬 기준과 동일: 건수 desc → Mode-S asc)
      const counts = new Map<string, number>();
      for (const ev of result.events) counts.set(ev.mode_s, (counts.get(ev.mode_s) ?? 0) + 1);
      let topModeS = "";
      let topCount = -1;
      for (const [k, v] of counts) {
        if (v > topCount || (v === topCount && k < topModeS)) { topModeS = k; topCount = v; }
      }
      setExpandedModeS(topModeS ? new Set([topModeS]) : new Set());
      setPhase("idle"); // 라벨링은 결과 표시 후 진행 (버튼 잠금 해제)

      // 전체 이벤트 bbox 로 1회 지도 맞춤 (실표적·유령표적 양쪽 포함)
      if (result.events.length > 0) {
        let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
        for (const ev of result.events) {
          for (const o of [ev.real, ev.ghost]) {
            if (o.latitude < minLat) minLat = o.latitude;
            if (o.latitude > maxLat) maxLat = o.latitude;
            if (o.longitude < minLon) minLon = o.longitude;
            if (o.longitude > maxLon) maxLon = o.longitude;
          }
        }
        fitBounds([[minLon, minLat], [maxLon, maxLat]]);
      }

      // ── 클러스터 건물명 라벨링 (count 상위 LABEL_MAX 개소, 순차 호출) ──
      const targets = [...result.clusters].sort((a, b) => b.count - a.count).slice(0, LABEL_MAX);
      const names = new Map<number, string>();
      for (const c of targets) {
        try {
          const hit = await invoke<AddressBuildingHit | null>("find_building_near_point", {
            lat: c.latitude,
            lon: c.longitude,
          });
          if (seq !== dualRunSeq) return; // 재실행/재업로드 → 라벨링 중단
          if (hit?.name) names.set(c.id, hit.name);
        } catch {
          // 라벨 조회 실패는 조용히 무시 — 좌표 표기로 폴백
        }
      }
      if (seq !== dualRunSeq || names.size === 0) return;
      const cur = useAppStore.getState().dualTargetResult;
      if (!cur) return;
      setDualResult({
        ...cur,
        clusters: cur.clusters.map((c) => (names.has(c.id) ? { ...c, building_name: names.get(c.id)! } : c)),
      });
    } catch (e) {
      if (seq !== dualRunSeq) return;
      console.error("[DualTarget] 분석 실패:", e);
      setError(String(e));
      setDualResult(null);
    } finally {
      if (seq === dualRunSeq) setPhase("idle");
    }
  }, [dualSites, scanWindowS, minSepKm, setDualResult, fitBounds]);

  // ── ASS 파일 선택 ─────────────────────────────────────────────────
  const pickFiles = useCallback(async () => {
    if (busy) return;
    const result = await open({
      multiple: true,
      filters: [{ name: "ASS Files", extensions: ["ass", "ASS"] }],
    });
    if (!result) return;
    const paths = (Array.isArray(result) ? result : [result]).filter((p): p is string => typeof p === "string");
    if (paths.length === 0) return;
    setPendingPaths(paths);
    setFilterModalOpen(true);
  }, [busy]);

  // ── 파싱 → Worker 적재 → 비행 통합 → 자동 분석 ────────────────────
  /**
   * 단일 파싱 경로 — 파일 목록·필터·**기준 레이더**를 모두 인자로 받는다.
   * site 는 극좌표 변환 원점(radarLat/radarLon)이자 포인트 radar_name 태그이자
   * 비행 통합 사이트다. 전역 radarSite 를 직접 참조하지 않는다(레이더 변경 재파싱 지원).
   */
  const runParse = useCallback(async (paths: string[], filter: ParseFilterResult, site: RadarSite) => {
    if (paths.length === 0) return;

    const seq = ++dualRunSeq;
    setError(null);
    setDualResult(null);
    setSelectedEventId(null);
    setSelectedClusterId(null);
    setSelectedModeS(null);
    setExpandedModeS(new Set());
    setSearch("");
    setBldgDrawer(null); // 새 파싱 시작 = 건축물정보 드로어 닫기
    flightsRef.current = [];
    setFlightCount(0);
    setFileCount(paths.length);
    setPhase("parsing");

    // 레이더 변경 재파싱용 입력 보관 (동일 파일·필터 재실행)
    lastPathsRef.current = paths;
    lastFilterRef.current = filter;

    // 재업로드 = 대체 시맨틱 — Worker 축적분(포인트·비행 인덱스·유령 보존분) 전량 폐기
    clearWorkerPoints();

    // 파싱 프로토콜(태그·창 타깃 리스너·완료 배리어)은 parseAssBatch 단일 소유.
    // 항적 포인트 / 파서 보존 유령표적 — 둘 다 radar_name 태깅 후 Worker 로 즉시 전송.
    // totalForwarded 는 outcome.pointsReceived 가 아니라 로컬 누적을 쓴다(고아 가드로 스킵된 분 제외).
    let totalForwarded = 0;
    const outcome = await parseAssBatch({
      paths,
      radarLat: site.latitude,
      radarLon: site.longitude,
      filter,
      // 선점 취소 — 새 파싱이 시작되면 남은 청크 수신을 즉시 끊는다(역직렬화 CPU 를 새 파싱에 양보).
      // 취소 outcome(complete=false)은 아래 seq 가드가 먼저 return 하므로 notice 로 뜨지 않는다.
      isStale: () => seq !== dualRunSeq,
      onPoints: (pts) => {
        if (seq !== dualRunSeq) return; // 새 파싱이 시작됨 — 고아 리스너의 Worker push 차단
        for (const p of pts) p.radar_name = site.name;
        totalForwarded += pts.length;
        postPointsToWorker(pts);
      },
      onGhostPoints: (pts) => {
        if (seq !== dualRunSeq) return; // 새 파싱이 시작됨 — 고아 리스너의 Worker push 차단
        for (const p of pts) p.radar_name = site.name;
        postGhostPointsToWorker(pts);
      },
    });
    setPendingPaths([]);

    if (seq !== dualRunSeq) return; // 새 업로드가 시작됨
    if (outcome.failed) {
      setPhase("idle");
      setNotice({ title: "파싱 실패", message: "파일을 읽지 못했습니다. ASS 파일 형식과 경로를 확인하세요." });
      return;
    }
    // 이벤트 유실(수신 절단) — 절단된 자료로 분석하면 이중표적 탐지 결과가 조용히 축소된다
    if (!outcome.complete) {
      setPhase("idle");
      setNotice({
        title: "파싱 수신 불완전",
        message: "일부 데이터가 수신되지 않았을 수 있습니다. 다시 시도하세요.",
      });
      return;
    }
    // 파싱은 성공했으나 유효 포인트가 0건 — 통합·분석까지 진행하면 "이중표적 미탐지"로 오도된다
    if (totalForwarded === 0) {
      setPhase("idle");
      setNotice({
        title: "파싱 결과 없음",
        message: "유효한 표적 포인트가 없습니다.\nASS 파일 형식과 Mode-S/Mode-3A 필터를 확인하세요.",
      });
      return;
    }

    // 비행 통합 — 청크는 페이지 로컬 ref 로만 수집 (store.flights 미사용)
    setPhase("consolidating");
    try {
      await startConsolidate([], useAppStore.getState().aircraft, site, (fl) => {
        const arr = flightsRef.current;
        for (let i = 0; i < fl.length; i++) arr.push(fl[i]);
        if (arr.length % 50 === 0) setFlightCount(arr.length);
      });
    } catch (e) {
      if (e instanceof ConsolidateSuperseded) return; // 새 파싱으로 교체됨 — 정상 취소
      console.error("[DualTarget] 비행 통합 실패:", e);
      if (seq !== dualRunSeq) return;
      setPhase("idle");
      setError(String(e));
      return;
    }
    if (seq !== dualRunSeq) return;
    setFlightCount(flightsRef.current.length);

    await runAnalysis();
  }, [setDualResult, runAnalysis]);

  /** 필터 모달 확인 → 현재 선택된 분석 레이더 기준으로 파싱 */
  const parseWithFilter = useCallback((filter: ParseFilterResult) => {
    setFilterModalOpen(false);
    void runParse(pendingPaths, filter, analysisSite);
  }, [pendingPaths, analysisSite, runParse]);

  const closeFilterModal = useCallback(() => {
    setFilterModalOpen(false);
    setPendingPaths([]);
  }, []);

  // ── 분석 레이더 변경 ──────────────────────────────────────────────
  /** 지도를 해당 레이더 위치로 이동 (줌은 유지하되 최소 9) */
  const easeToSite = useCallback((name: string) => {
    const s = dualSites.find((x) => x.name === name);
    const map = mapRef.current?.getMap();
    if (!s || !map) return;
    map.easeTo({ center: [s.longitude, s.latitude], zoom: Math.max(map.getZoom(), 9), duration: 600 });
  }, [dualSites]);

  /**
   * 분석 레이더 선택 — 드롭다운·지도 마커 클릭 공용 경로.
   * 이미 파싱된 자료가 있으면 좌표 재변환(재파싱)이 필요하므로 확인 모달을 띄우고,
   * 확정 전까지 셀렉터 값(analysisRadarName)은 바꾸지 않는다(controlled select → 자동 복귀).
   */
  const handleRadarChange = useCallback((name: string) => {
    if (busy) return;
    if (name === analysisRadarName) {
      easeToSite(name); // 같은 레이더 재선택 = 위치 확인만
      return;
    }
    // 파싱된 자료가 없으면 다시 만들 것도 없다 — 즉시 전환
    if (!dualResult && flightsRef.current.length === 0) {
      setAnalysisRadarName(name);
      easeToSite(name);
      return;
    }
    setRadarConfirm(name);
  }, [busy, analysisRadarName, dualResult, easeToSite]);

  /** 확인 모달 확정 — 직전 파일 정보가 있으면 새 레이더 기준으로 재파싱, 없으면 레이더만 전환 */
  const confirmRadarChange = useCallback(() => {
    const name = radarConfirm;
    if (!name) return;
    setRadarConfirm(null);
    setAnalysisRadarName(name);

    let site: RadarSite = radarSite;
    for (const s of [radarSite, ...customRadarSites]) {
      if (s?.name === name) { site = s; break; }
    }

    const paths = lastPathsRef.current;
    const filter = lastFilterRef.current;
    if (paths.length > 0 && filter) {
      void runParse(paths, filter, site);
      return;
    }
    // 재파싱할 파일 정보가 없는 경우(결과만 복원된 재진입) — 다음 파싱부터 적용
    easeToSite(name);
  }, [radarConfirm, radarSite, customRadarSites, runParse, easeToSite]);

  // ── 파생 데이터 ───────────────────────────────────────────────────

  // 필터 2종은 순차 교집합. 목록(groups)은 Mode-S 필터 **이전** 단계(listEvents)를 쓰므로
  // 한 기체를 선택해도 다른 기체 그룹이 목록에 남아 곧바로 바꿔 선택할 수 있다.
  // (한 파싱 세션의 포인트는 전부 단일 레이더로 태깅되므로 레이더 표출 필터는 두지 않는다 —
  //  레이더 선택은 "표출 한정"이 아니라 파싱 앵커 선택이다.)

  /** 좌측 그룹 목록 모집단 — 반사 위치 필터 적용 */
  const listEvents = useMemo(() => {
    const all = dualResult?.events ?? [];
    if (selectedClusterId == null) return all;
    return all.filter((e) => e.cluster_id === selectedClusterId);
  }, [dualResult, selectedClusterId]);

  /** 지도 표출 이벤트 — 반사 위치 ∩ Mode-S */
  const baseEvents = useMemo(() => {
    if (selectedModeS == null) return listEvents;
    return listEvents.filter((e) => e.mode_s === selectedModeS);
  }, [listEvents, selectedModeS]);

  /**
   * 표출용 반사 위치 클러스터 — count 내림차순.
   * Mode-S 선택 시엔 그 기체 이벤트가 참조하는 클러스터만 남기고 count 도 그 기체 기준으로
   * 재계산한다(원본 클러스터 객체는 mutate 금지 — 복제본 생성). 반사 위치 선택 필터는
   * 여기에 적용하지 않는다(다른 클러스터로 갈아탈 수 있어야 하므로).
   */
  const displayClusters = useMemo<ReflectorCluster[]>(() => {
    const all = dualResult?.clusters ?? [];
    if (selectedModeS == null) return [...all].sort((a, b) => b.count - a.count);

    const counts = new Map<number, number>();
    for (const e of dualResult?.events ?? []) {
      if (e.mode_s !== selectedModeS || e.cluster_id == null) continue;
      counts.set(e.cluster_id, (counts.get(e.cluster_id) ?? 0) + 1);
    }
    const out: ReflectorCluster[] = [];
    for (const c of all) {
      const n = counts.get(c.id);
      if (n == null) continue;
      out.push({ ...c, count: n });
    }
    out.sort((a, b) => b.count - a.count);
    return out;
  }, [dualResult, selectedModeS]);

  /**
   * 지도 표출용 줌 적응 병합 반사체 — Web Mercator 픽셀 좌표를 CLUSTER_CELL_PX 격자로 비닝.
   * 줌아웃에서 겹쳐 뭉개지던 마커가 하나로 합쳐지고, 줌인하면 자연히 풀린다.
   * 좌측 "예상 반사 위치" 리스트는 병합 없이 displayClusters 를 그대로 쓴다.
   */
  const zoomClusters = useMemo<ZoomCluster[]>(() => {
    const scale = 512 * Math.pow(2, mapZoom);
    // 비닝 중 latitude/longitude 필드는 **가중합 누산기**로 쓰고 마지막에 wSum 으로 나눠 centroid 확정
    const bins = new Map<string, ZoomCluster & { wSum: number }>();
    for (const c of displayClusters) {
      // 위도는 메르카토르 발산 방지를 위해 ±85° 로 클램프 (국내 자료라 실질 무영향)
      const lat = Math.min(85, Math.max(-85, c.latitude));
      const x = ((c.longitude + 180) / 360) * scale;
      const phi = (lat * Math.PI) / 180;
      const y = ((1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2) * scale;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const key = `${Math.floor(x / CLUSTER_CELL_PX)}_${Math.floor(y / CLUSTER_CELL_PX)}`;
      const w = c.count > 0 ? c.count : 1; // centroid 가중치(건수)
      const bin = bins.get(key);
      if (bin) {
        bin.latitude += c.latitude * w;
        bin.longitude += c.longitude * w;
        bin.count += c.count;
        bin.wSum += w;
        bin.members.push(c);
      } else {
        bins.set(key, {
          key,
          latitude: c.latitude * w,
          longitude: c.longitude * w,
          count: c.count,
          members: [c],
          wSum: w,
        });
      }
    }
    const out: ZoomCluster[] = [];
    for (const b of bins.values()) {
      out.push({
        key: b.key,
        latitude: b.latitude / b.wSum,
        longitude: b.longitude / b.wSum,
        count: b.count,
        members: b.members,
      });
    }
    out.sort((a, b) => b.count - a.count);
    return out;
  }, [displayClusters, mapZoom]);

  /**
   * 반사 위치 선택 — 지도 마커·좌측 리스트 공용.
   * Mode-S 한정을 함께 해제한다: 반사체를 고르면 그 반사체에 속한 **모든 기체**의 이벤트가
   * 나와야 하므로, Mode-S 필터와 교집합이 되어 목록이 비는 것을 막는다.
   */
  const selectCluster = useCallback((id: number) => {
    setSelectedEventId(null);
    setSelectedModeS(null);
    setSelectedClusterId((prev) => (prev === id ? null : id));
  }, []);

  /** 병합 마커(2개 이상) 클릭 — 소속 반사 위치 bbox 로 줌인해 자연히 풀리게 한다 */
  const zoomIntoCluster = useCallback((zc: ZoomCluster) => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (const m of zc.members) {
      if (m.latitude < minLat) minLat = m.latitude;
      if (m.latitude > maxLat) maxLat = m.latitude;
      if (m.longitude < minLon) minLon = m.longitude;
      if (m.longitude > maxLon) maxLon = m.longitude;
    }
    // 완전 동일 좌표(퇴화 bbox) 대비 최소 폭 부여
    const eps = 1e-4;
    if (maxLat - minLat < eps) { minLat -= eps; maxLat += eps; }
    if (maxLon - minLon < eps) { minLon -= eps; maxLon += eps; }
    try {
      map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 80, duration: 600, maxZoom: 16 });
    } catch {
      // 지도 미준비 등 — 무시(다음 클릭에서 재시도)
    }
  }, []);

  /**
   * 실표적·유령표적 클릭 공용 — 그 항공기(Mode-S) 전체로 지도·목록을 한정한다.
   * 같은 이벤트 재클릭은 이벤트 선택만 해제(Mode-S 한정은 유지).
   * 사용자가 보고 있는 화면을 유지해야 하므로 지도 이동(fitBounds/easeTo)은 하지 않는다.
   */
  const selectEventFromMap = useCallback((ev: DualTargetEvent) => {
    if (selectedEventId === ev.id) {
      setSelectedEventId(null);
      return;
    }
    // 지도 클릭 = 해당 기체로 명시 이동 — 검색 필터가 선택 그룹을 가리지 않게 해제
    setSearch("");
    setSelectedClusterId(null);
    setSelectedModeS(ev.mode_s);
    setSelectedEventId(ev.id);
    setExpandedModeS((prev) => (prev.has(ev.mode_s) ? prev : new Set(prev).add(ev.mode_s)));
    // 좌측 목록에서 해당 이벤트 행(없으면 그룹)이 보이도록 스크롤.
    // 펼침·상한 밖 행 덧붙임까지 반영되려면 2프레임 필요 → 더블 rAF
    const modeS = ev.mode_s;
    const evId = ev.id;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = document.getElementById(`dual-ev-${evId}`) ?? document.getElementById(`dual-group-${modeS}`);
      el?.scrollIntoView({ block: "nearest" });
    }));
  }, [selectedEventId]);

  /** Mode-S 단위 이벤트 그룹 — 건수 내림차순(동수 시 Mode-S 오름차순) */
  const groups = useMemo<ModeSGroup[]>(() => {
    const byModeS = new Map<string, DualTargetEvent[]>();
    for (const ev of listEvents) {
      const arr = byModeS.get(ev.mode_s);
      if (arr) arr.push(ev);
      else byModeS.set(ev.mode_s, [ev]);
    }
    const out: ModeSGroup[] = [];
    for (const [modeS, events] of byModeS) {
      let highCount = 0;
      let maxSepKm = 0;
      let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
      for (const ev of events) {
        if (ev.confidence === "high") highCount++;
        if (ev.separation_km > maxSepKm) maxSepKm = ev.separation_km;
        for (const o of [ev.real, ev.ghost]) {
          if (o.latitude < minLat) minLat = o.latitude;
          if (o.latitude > maxLat) maxLat = o.latitude;
          if (o.longitude < minLon) minLon = o.longitude;
          if (o.longitude > maxLon) maxLon = o.longitude;
        }
      }
      events.sort((a, b) => a.ghost.timestamp - b.ghost.timestamp);
      out.push({
        modeS,
        label: labelFor(modeS, aircraft),
        events,
        highCount,
        maxSepKm,
        bbox: { minLat, maxLat, minLon, maxLon },
      });
    }
    out.sort((a, b) => (b.events.length - a.events.length) || a.modeS.localeCompare(b.modeS));
    return out;
  }, [listEvents, aircraft]);

  /** 검색 필터 (Mode-S·기체명 부분일치) — 목록 표시만 좁힌다(지도는 baseEvents 전수) */
  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) => g.modeS.toLowerCase().includes(q) || g.label.toLowerCase().includes(q));
  }, [groups, search]);

  // 워커가 id = 정렬 인덱스로 부여하므로 dense 배열 O(1) 조회 (id 불일치 시 안전하게 무시).
  // 선택 이벤트의 Mode-S 를 미리 뽑아 두면 그룹 렌더가 자기 그룹인지 O(1) 로 판정한다
  // (이벤트 선택 경로는 모두 반사 위치 필터를 해제하므로 선택 이벤트는 항상 자기 그룹 안에 있다).
  const selectedEv = selectedEventId != null ? dualResult?.events[selectedEventId] : undefined;
  const selectedEvModeS = selectedEv && selectedEv.id === selectedEventId ? selectedEv.mode_s : undefined;

  const toggleGroup = useCallback((modeS: string) => {
    setExpandedModeS((prev) => {
      const next = new Set(prev);
      if (next.has(modeS)) next.delete(modeS);
      else next.add(modeS);
      return next;
    });
  }, []);

  /**
   * 그룹 헤더 클릭 = 지도 표출을 이 기체로 한정 + 펼침 보장.
   * 이미 선택된 그룹 재클릭이면 선택만 해제하고 펼침 상태는 유지한다.
   * 선택 시 지도는 이벤트 bbox ∪ 해당 이벤트들의 레이더 좌표로 맞춘다
   * (레이더 ↔ 반사체 ↔ 항적 기하가 한 화면에 들어와야 반사 경로가 읽힌다).
   */
  const selectGroup = useCallback((g: ModeSGroup) => {
    if (selectedModeS === g.modeS) {
      setSelectedModeS(null);
      return;
    }
    setSelectedModeS(g.modeS);
    setSelectedEventId(null);
    setExpandedModeS((prev) => (prev.has(g.modeS) ? prev : new Set(prev).add(g.modeS)));

    let { minLat, maxLat, minLon, maxLon } = g.bbox;
    const names = new Set<string>();
    for (const ev of g.events) names.add(ev.radar_name);
    for (const s of dualSites) {
      if (!names.has(s.name)) continue;
      if (s.latitude < minLat) minLat = s.latitude;
      if (s.latitude > maxLat) maxLat = s.latitude;
      if (s.longitude < minLon) minLon = s.longitude;
      if (s.longitude > maxLon) maxLon = s.longitude;
    }
    if (minLat <= maxLat && minLon <= maxLon) fitBounds([[minLon, minLat], [maxLon, maxLat]]);
  }, [selectedModeS, dualSites, fitBounds]);

  /**
   * 전파 반사 애니메이션 입력 — 선택 이벤트에 반사점·레이더 좌표가 모두 있을 때만 생성.
   * 데이터 배열을 여기서 만들어 참조를 고정한다(프레임마다 새 배열이면 deck.gl 이 매번 재업로드).
   */
  const reflectionAnim = useMemo<ReflectionAnim | null>(() => {
    if (selectedEventId == null || !dualResult) return null;
    const ev = dualResult.events.find((e) => e.id === selectedEventId);
    if (!ev?.reflector) return null;
    const site = dualSites.find((s) => s.name === ev.radar_name);
    if (!site) return null;
    return {
      tripData: [{
        path: [
          [ev.real.longitude, ev.real.latitude],
          [ev.reflector.longitude, ev.reflector.latitude],
          [site.longitude, site.latitude],
        ] as [number, number][],
      }],
      pulseData: [{
        lon: ev.ghost.longitude,
        lat: ev.ghost.latitude,
        siteLon: site.longitude,
        siteLat: site.latitude,
      }],
    };
  }, [selectedEventId, dualResult, dualSites]);

  // ── deck.gl 레이어 ────────────────────────────────────────────────
  //   전부 2D 지면 표현(고도 z 미사용). 반사 기하는 수평면 문제라 3D 고도 축을 쓰면
  //   실표적/유령표적 짝이 서로 다른 높이로 떠서 짝 관계가 읽히지 않는다.
  //   그리기 순서(뒤 → 앞): 건물 → 사이트 → 짝선 → 실표적 → 유령표적 → 반사 위치 → 개수 → 선택 강조.
  //   (deck.gl 픽은 나중에 그린 레이어가 이기므로 건물이 표적·반사체 클릭을 가리지 않는다)
  const deckLayers = useMemo<DeckLayerList>(() => {
    /** 클러스터 원 반경(px) — count 로 완만히 증가, 26px 상한 */
    const clusterRadius = (count: number) => Math.min(26, 7 + Math.sqrt(count) * 3);

    const layers: DeckLayerList = [];

    // ── 2D 건물 (최하단) ──
    //   레이어 배열 맨 앞에 두어 표적·반사체 픽이 항상 건물보다 우선되게 한다.
    if (buildingPolys.length > 0) {
      layers.push(
        new PolygonLayer<DualBuildingPoly>({
          id: "dual-buildings",
          data: buildingPolys,
          getPolygon: (d) => d.path,
          extruded: false,
          filled: true,
          stroked: true,
          getFillColor: (d) => d.fill,
          getLineColor: [100, 116, 139, 130],
          lineWidthMinPixels: 0.5,
          pickable: true,
          onClick: (info: { object?: DualBuildingPoly }) => {
            if (info.object) openBuildingDrawer(info.object.b);
          },
        })
      );
    }

    // 사이트 마커·라벨은 결과 유무와 무관하게 상시 표시 — 파싱 전에도 지도에서
    // 분석 기준 레이더를 고를 수 있어야 한다(마커 클릭 = 드롭다운과 동일 경로).
    layers.push(
      new ScatterplotLayer<{ name: string; latitude: number; longitude: number }>({
        id: "dual-sites",
        data: dualSites,
        getPosition: (d) => [d.longitude, d.latitude],
        getFillColor: [55, 65, 81, 235],
        getLineColor: [255, 255, 255, 255],
        stroked: true,
        lineWidthMinPixels: 1.5,
        radiusUnits: "pixels" as const,
        getRadius: 8,
        pickable: true,
        onClick: (info: { object?: { name: string } }) => {
          const d = info.object;
          if (!d) return;
          handleRadarChange(d.name);
        },
      }),
      new TextLayer<{ name: string; latitude: number; longitude: number }>({
        id: "dual-site-labels",
        data: dualSites,
        getPosition: (d) => [d.longitude, d.latitude],
        getText: (d) => d.name,
        // 기본 characterSet 은 ASCII 뿐이라 한글 레이더명이 렌더되지 않는다 — 데이터 기반 자동 아틀라스
        characterSet: "auto" as const,
        getColor: [55, 65, 81, 255],
        getSize: 11,
        sizeUnits: "pixels" as const,
        getTextAnchor: "middle" as const,
        getAlignmentBaseline: "top" as const,
        getPixelOffset: [0, 10],
        outlineWidth: 3,
        outlineColor: [255, 255, 255, 220],
        fontSettings: { sdf: true },
        billboard: true,
        pickable: false,
      }),
    );

    if (dualResult) layers.push(
      new LineLayer<DualTargetEvent>({
        id: "dual-pair-lines",
        data: baseEvents,
        getSourcePosition: (d) => [d.real.longitude, d.real.latitude],
        getTargetPosition: (d) => [d.ghost.longitude, d.ghost.latitude],
        getColor: [107, 114, 128, 110],
        getWidth: 1,
        widthUnits: "pixels" as const,
        widthMinPixels: 1,
        pickable: false,
      }),
      new ScatterplotLayer<DualTargetEvent>({
        id: "dual-real-pts",
        data: baseEvents,
        getPosition: (d) => [d.real.longitude, d.real.latitude],
        getFillColor: [59, 130, 246, 200],
        getRadius: 60,
        radiusMinPixels: 3,
        radiusMaxPixels: 6,
        pickable: true,
        onClick: (info: { object?: DualTargetEvent }) => {
          if (info.object) selectEventFromMap(info.object);
        },
      }),
      new ScatterplotLayer<DualTargetEvent>({
        id: "dual-ghost-pts",
        data: baseEvents,
        getPosition: (d) => [d.ghost.longitude, d.ghost.latitude],
        getFillColor: [233, 69, 96, 220],
        getRadius: 90,
        radiusMinPixels: 4,
        radiusMaxPixels: 8,
        pickable: true,
        onClick: (info: { object?: DualTargetEvent }) => {
          if (info.object) selectEventFromMap(info.object);
        },
      }),
      new ScatterplotLayer<ZoomCluster>({
        id: "dual-reflectors",
        data: zoomClusters,
        getPosition: (d) => [d.longitude, d.latitude],
        getFillColor: [166, 7, 57, 235],
        getLineColor: [255, 255, 255, 255],
        stroked: true,
        filled: true,
        // 병합 마커(2개 이상)는 흰 테두리를 두껍게 — 개별 반사 위치와 시각 구분
        lineWidthUnits: "pixels" as const,
        getLineWidth: (d) => (d.members.length > 1 ? 2 : 1.5),
        lineWidthMinPixels: 1.5,
        radiusUnits: "pixels" as const,
        getRadius: (d) => clusterRadius(d.count),
        pickable: true,
        onClick: (info: { object?: ZoomCluster }) => {
          const d = info.object;
          if (!d) return;
          if (d.members.length > 1) {
            zoomIntoCluster(d); // 줌인 → 병합 해제
            return;
          }
          selectCluster(d.members[0].id);
        },
      }),
      new TextLayer<ZoomCluster>({
        id: "dual-reflector-count",
        data: zoomClusters,
        getPosition: (d) => [d.longitude, d.latitude],
        getText: (d) => String(d.count),
        getColor: [255, 255, 255, 255],
        getSize: 11,
        sizeUnits: "pixels" as const,
        getTextAnchor: "middle" as const,
        getAlignmentBaseline: "center" as const,
        fontWeight: 700,
        billboard: true,
        pickable: false,
      }),
    );

    // ── 분석 기준 레이더 강조 링 (결과 없어도 상시) ──
    const anchorSite = dualSites.find((m) => m.name === analysisRadarName);
    if (anchorSite) {
      layers.push(
        new ScatterplotLayer<{ name: string; latitude: number; longitude: number }>({
          id: "dual-selected-site-ring",
          data: [anchorSite],
          getPosition: (d) => [d.longitude, d.latitude],
          stroked: true,
          filled: false,
          radiusUnits: "pixels" as const,
          getRadius: 12,
          radiusMinPixels: 12,
          getLineColor: [166, 7, 57, 255],
          lineWidthMinPixels: 2,
          pickable: false,
        })
      );
    }

    // ── Mode-S 선택(이벤트 미선택) 시 반사 기하 분포: 실표적 → 반사점 정적 기하선 ──
    //   개별 이벤트를 고르지 않아도 이 기체의 반사가 어디로 모이는지 한눈에 드러난다.
    if (selectedModeS != null && selectedEventId == null) {
      const withReflector = baseEvents.filter((e) => e.reflector != null);
      if (withReflector.length > 0) {
        layers.push(
          new LineLayer<DualTargetEvent>({
            id: "dual-reflect-geometry",
            data: withReflector,
            getSourcePosition: (d) => [d.real.longitude, d.real.latitude],
            getTargetPosition: (d) => [d.reflector!.longitude, d.reflector!.latitude],
            getColor: [166, 7, 57, 60],
            getWidth: 1,
            widthUnits: "pixels" as const,
            widthMinPixels: 1,
            pickable: false,
          })
        );
      }
    }

    // ── 선택 이벤트 강조: 반사 경로(레이더→반사면→실표적) + 유령 방위선 + 실/유령 링 ──
    if (selectedEventId != null) {
      const ev = dualResult?.events.find((e) => e.id === selectedEventId);
      const site = ev ? dualSites.find((s) => s.name === ev.radar_name) : undefined;
      if (ev && site) {
        if (ev.reflector) {
          layers.push(
            new PathLayer<{ path: [number, number][] }>({
              id: "dual-selected-path",
              data: [{
                path: [
                  [site.longitude, site.latitude],
                  [ev.reflector.longitude, ev.reflector.latitude],
                  [ev.real.longitude, ev.real.latitude],
                ] as [number, number][],
              }],
              getPath: (d) => d.path,
              getColor: [166, 7, 57, 255],
              getWidth: 2.5,
              widthUnits: "pixels" as const,
              widthMinPixels: 2.5,
              pickable: false,
            })
          );
        }
        // 유령이 찍힌 방위선 — 레이더는 반사 경로 전체 거리를 이 방위에 그대로 투영한다
        layers.push(
          new LineLayer<DualTargetEvent>({
            id: "dual-selected-ghostline",
            data: [ev],
            getSourcePosition: () => [site.longitude, site.latitude],
            getTargetPosition: (d) => [d.ghost.longitude, d.ghost.latitude],
            getColor: [233, 69, 96, 200],
            getWidth: 1.5,
            widthUnits: "pixels" as const,
            widthMinPixels: 1.5,
            pickable: false,
          })
        );
        layers.push(
          new ScatterplotLayer<{ lon: number; lat: number; color: [number, number, number, number] }>({
            id: "dual-selected-rings",
            data: [
              { lon: ev.real.longitude, lat: ev.real.latitude, color: [59, 130, 246, 255] as [number, number, number, number] },
              { lon: ev.ghost.longitude, lat: ev.ghost.latitude, color: [233, 69, 96, 255] as [number, number, number, number] },
            ],
            getPosition: (d) => [d.lon, d.lat],
            stroked: true,
            filled: false,
            radiusUnits: "pixels" as const,
            getRadius: 9,
            radiusMinPixels: 9,
            getLineColor: (d) => d.color,
            lineWidthMinPixels: 2,
            pickable: false,
          })
        );
      }
    }

    // ── 선택 클러스터 강조: 반사 위치 링 ──
    //   병합 마커에 묻힌 경우에도 보이도록, 선택 클러스터를 품은 **병합 마커** 위치·반경 기준.
    if (selectedClusterId != null) {
      const zc = zoomClusters.find((z) => z.members.some((m) => m.id === selectedClusterId));
      if (zc) {
        layers.push(
          new ScatterplotLayer<ZoomCluster>({
            id: "dual-selected-cluster-ring",
            data: [zc],
            getPosition: (d) => [d.longitude, d.latitude],
            stroked: true,
            filled: false,
            radiusUnits: "pixels" as const,
            getRadius: (d) => clusterRadius(d.count) + 6,
            getLineColor: [166, 7, 57, 255],
            lineWidthMinPixels: 2,
            pickable: false,
          })
        );
      }
    }

    return layers;
    // animTime 은 의도적으로 의존성에서 제외 — 애니메이션은 DualDeckLayers 가 따로 합성한다
  }, [
    dualResult, baseEvents, zoomClusters, dualSites, buildingPolys,
    selectedEventId, selectedClusterId, selectedModeS, analysisRadarName,
    handleRadarChange, openBuildingDrawer, selectEventFromMap, selectCluster, zoomIntoCluster,
  ]);

  // ── 렌더 ──────────────────────────────────────────────────────────

  const stats = dualResult?.stats;
  /** 클러스터 행 라벨 — 라벨링된 건물명이 없으면 좌표 표기로 폴백 */
  const clusterLabel = (c: ReflectorCluster) =>
    c.building_name?.trim() || `${c.latitude.toFixed(4)}, ${c.longitude.toFixed(4)}`;

  const phaseLabel =
    phase === "parsing" ? `ASS 파싱 중 (${fileCount}개 파일)…`
    : phase === "consolidating" ? `비행 통합 중 (${flightCount.toLocaleString()}편)…`
    : phase === "analyzing" ? "이중표적 분석 중…"
    : "";

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden">
      {/* ── 헤더 ── */}
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Ghost size={20} className="shrink-0 text-[#a60739]" />
            <h1 className="text-2xl font-bold text-gray-800">이중표적 분석</h1>
          </div>
          <p className="mt-1 text-sm text-gray-500">
            동일 Mode-S 이중 탐지에서 반사 유령표적과 예상 반사 위치를 역산
          </p>
        </div>
        <button
          onClick={pickFiles}
          disabled={busy}
          title="기존 데이터를 비우고 새 ASS 파일을 불러옵니다"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[#a60739]/30 bg-white px-3 py-2 text-[12px] font-medium text-[#a60739] transition-colors hover:bg-[#a60739]/5 disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
          {busy ? phaseLabel : "ASS 파일 선택"}
        </button>
      </div>

      {/* ── 파라미터 ── */}
      <div className="flex shrink-0 flex-wrap items-center gap-4 rounded-lg border border-gray-200 bg-[#f8f9fa] px-3 py-2">
        <label className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-gray-600">분석 레이더</span>
          <select
            value={analysisRadarName}
            onChange={(e) => handleRadarChange(e.target.value)}
            disabled={busy}
            title="극좌표(거리·방위)를 WGS84 로 변환할 기준 레이더 — 변경하면 재파싱이 필요합니다"
            className="h-6 max-w-[160px] rounded-md border border-gray-200 bg-white px-1.5 text-[11px] font-medium text-gray-700 focus:border-[#a60739] focus:outline-none disabled:opacity-50"
          >
            {/* 등록 목록에서 사라진 레이더로 분석된 결과가 복원된 경우에도 값이 비지 않도록 */}
            {!dualSites.some((s) => s.name === analysisRadarName) && (
              <option value={analysisRadarName}>{analysisRadarName}</option>
            )}
            {dualSites.map((s) => (
              <option key={s.name} value={s.name}>{s.name}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-gray-600">동일스캔 윈도우</span>
          <input
            type="range" min={0.2} max={2.0} step={0.1} value={scanWindowS}
            onChange={(e) => setScanWindowS(Number(e.target.value))}
            style={{ accentColor: ACCENT }}
            className="h-1 w-32 cursor-pointer"
          />
          <span className="w-10 font-mono text-[11px] font-bold tabular-nums text-[#a60739]">{scanWindowS.toFixed(1)}s</span>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-gray-600">최소 이격</span>
          <input
            type="range" min={0.5} max={5.0} step={0.5} value={minSepKm}
            onChange={(e) => setMinSepKm(Number(e.target.value))}
            style={{ accentColor: ACCENT }}
            className="h-1 w-32 cursor-pointer"
          />
          <span className="w-12 font-mono text-[11px] font-bold tabular-nums text-[#a60739]">{minSepKm.toFixed(1)}km</span>
        </label>
        <span className="text-[10.5px] text-gray-400">
          동일 Mode-S 가 같은 스캔 주기 내 두 위치로 탐지되면 이중표적(반사)으로 판정합니다.
        </span>
        {dualResult && (
          <button
            onClick={runAnalysis}
            disabled={busy}
            title="파라미터를 바꾼 뒤 Worker 에 남아 있는 자료로 다시 분석합니다 (재파싱 없음)"
            className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[#a60739] px-3 py-1.5 text-[11.5px] font-semibold text-white transition-colors hover:bg-[#8a062f] disabled:opacity-50"
          >
            {phase === "analyzing" ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            재분석
          </button>
        )}
      </div>

      {error && (
        <div className="shrink-0 rounded-lg border border-[#e94560]/30 bg-[#e94560]/5 px-3 py-2 text-[11.5px] break-all" style={{ color: ERROR }}>
          {error}
        </div>
      )}

      {/* ── 본문: 좌 패널 + 우 지도 ── */}
      <div className="flex min-h-0 flex-1 gap-3">
        {/* 좌측 패널 */}
        <div className="flex w-[400px] shrink-0 flex-col overflow-hidden rounded-lg border border-gray-200 bg-white">
          {!dualResult ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              {busy ? (
                <>
                  <Loader2 size={40} className="animate-spin text-[#a60739]" />
                  <p className="text-sm text-gray-600">{phaseLabel}</p>
                  <p className="text-[11px] text-gray-400">
                    포인트는 Worker 가 보관합니다 — 파싱·통합·분석 순으로 진행됩니다.
                  </p>
                </>
              ) : (
                <>
                  <Ghost size={48} className="text-gray-300" />
                  <p className="text-sm text-gray-500">ASS 파일을 선택해 분석을 시작하세요</p>
                  <button
                    onClick={pickFiles}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#8a062f]"
                  >
                    <FolderOpen size={14} />ASS 파일 열기
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              {/* 요약 */}
              <div className="shrink-0 border-b border-gray-200 p-3">
                <div className="rounded-lg border border-gray-200 bg-[#f8f9fa] px-3 py-2 text-[11px] leading-relaxed text-gray-600">
                  이벤트 <span className="font-mono font-bold tabular-nums" style={{ color: ERROR }}>{dualResult.events.length.toLocaleString()}</span>건
                  <span className="text-gray-400"> (잔존 {(stats?.events_scan ?? 0).toLocaleString()}·파서 보존 {(stats?.events_parser ?? 0).toLocaleString()})</span>
                  {" · "}항공기 <span className="font-mono font-bold tabular-nums text-gray-800">{(stats?.aircraft_count ?? 0).toLocaleString()}</span>대
                  {" · "}예상 반사 위치 <span className="font-mono font-bold tabular-nums text-[#a60739]">{dualResult.clusters.length.toLocaleString()}</span>개소
                  {stats && stats.dropped_unmatched > 0 && (
                    <div className="mt-0.5 text-[10px] text-gray-400">
                      실표적 짝 매칭 불가 {stats.dropped_unmatched.toLocaleString()}점 제외
                      {stats.skipped_no_site > 0 && ` · 사이트 미매칭 비행 ${stats.skipped_no_site.toLocaleString()}편 건너뜀`}
                    </div>
                  )}
                </div>
              </div>

              {/* 예상 반사 위치 — Mode-S 선택 시 그 기체가 참조하는 클러스터만 (건수도 재계산) */}
              {dualResult.clusters.length > 0 && (
                <div className="shrink-0 border-b border-gray-200 p-3">
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                      Reflectors · 예상 반사 위치
                    </span>
                    <span className="ml-auto font-mono text-[10px] font-bold tabular-nums text-[#a60739]">
                      {displayClusters.length.toLocaleString()}
                      {displayClusters.length !== dualResult.clusters.length && (
                        <span className="text-gray-400"> / {dualResult.clusters.length.toLocaleString()}</span>
                      )}
                    </span>
                  </div>
                  {displayClusters.length === 0 && (
                    <div className="px-1.5 py-2 text-[10.5px] text-gray-400">
                      선택한 필터에 해당하는 반사 위치가 없습니다
                    </div>
                  )}
                  <div className="max-h-[168px] overflow-y-auto">
                    {displayClusters.map((c) => {
                      const sel = selectedClusterId === c.id;
                      return (
                        <div
                          key={c.id}
                          onClick={() => {
                            const map = mapRef.current?.getMap();
                            if (map) map.easeTo({ center: [c.longitude, c.latitude], zoom: 14, duration: 600 });
                            // Mode-S 한정도 함께 해제 — 이 반사체에 속한 모든 기체의 항목을 보여준다
                            selectCluster(c.id);
                          }}
                          className={`cursor-pointer rounded px-1.5 py-1 transition-colors ${sel ? "bg-[#a60739]/8" : "hover:bg-gray-50"}`}
                        >
                          <div className="flex items-center gap-1.5">
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#a60739]" />
                            <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-gray-700">
                              {clusterLabel(c)}
                            </span>
                            <span className="shrink-0 font-mono text-[10px] font-bold tabular-nums text-[#a60739]">
                              {c.count.toLocaleString()}건
                            </span>
                          </div>
                          <div className="pl-3 text-[9.5px] text-gray-400">{c.radar_name}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Mode-S별 이벤트 그룹 */}
              <div className="flex min-h-0 flex-1 flex-col p-3">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                    Events · Mode-S별 이벤트
                  </span>
                  <div className="ml-auto flex min-w-0 items-center gap-2">
                    {selectedModeS != null && (
                      <button
                        onClick={() => setSelectedModeS(null)}
                        title="지도 표출 기체 한정을 해제합니다"
                        className="min-w-0 shrink truncate text-[10px] text-[#a60739] hover:underline"
                      >
                        Mode-S 필터 해제 ({labelFor(selectedModeS, aircraft)})
                      </button>
                    )}
                    {selectedClusterId != null ? (
                      <button
                        onClick={() => setSelectedClusterId(null)}
                        className="shrink-0 text-[10px] text-[#a60739] hover:underline"
                      >
                        반사 위치 필터 해제 ({listEvents.length.toLocaleString()}건)
                      </button>
                    ) : (
                      <span className="shrink-0 font-mono text-[10px] font-bold tabular-nums" style={{ color: ERROR }}>
                        {groups.length.toLocaleString()}대 / {listEvents.length.toLocaleString()}건
                      </span>
                    )}
                  </div>
                </div>

                {/* 검색 */}
                <div className="relative mb-1.5 shrink-0">
                  <Search size={11} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    type="text" value={search} onChange={(e) => setSearch(e.target.value)}
                    placeholder="Mode-S · 기체명 검색"
                    className="h-7 w-full rounded-md border border-gray-200 bg-white pl-6 pr-6 text-[11px] placeholder-gray-400 focus:border-[#a60739] focus:outline-none"
                  />
                  {search && (
                    <button
                      onClick={() => setSearch("")} title="검색 지우기"
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>

                {filteredGroups.length === 0 ? (
                  <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px] leading-relaxed text-gray-400">
                    {search.trim()
                      ? "검색과 일치하는 항공기가 없습니다"
                      : "이중표적이 탐지되지 않았습니다"}
                  </div>
                ) : (
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {filteredGroups.map((g) => {
                      const open = expandedModeS.has(g.modeS);
                      const picked = selectedModeS === g.modeS;
                      // 표시 행은 펼친 그룹에서만 계산 (접힌 그룹은 slice 자체가 불필요)
                      let shown: DualTargetEvent[] = [];
                      // 선택 이벤트가 표시 상한 밖이면 마지막에 덧붙여 항상 목록에서 보이게 한다.
                      // pinnedId = 그렇게 덧붙인 행(시간순서 밖 위치) — 구분선 라벨 + 해제 토글 생략 대상
                      let pinnedId: number | null = null;
                      if (open) {
                        shown = g.events.slice(0, GROUP_ROW_CAP);
                        // 자기 그룹의 선택 이벤트가 상한 안에 없을 때만 덧붙임
                        // (상한 초과 조건은 !some 이 포섭 — 상한 이내면 항상 shown 에 들어 있다)
                        if (selectedEv && g.modeS === selectedEvModeS && !shown.some((ev) => ev.id === selectedEventId)) {
                          shown.push(selectedEv);
                          pinnedId = selectedEv.id;
                        }
                      }
                      return (
                        <div
                          key={g.modeS}
                          id={`dual-group-${g.modeS}`}
                          className={`mb-1 rounded-md border ${picked ? "border-l-[3px] border-[#a60739] bg-[#a60739]/[0.03]" : "border-gray-200"}`}
                        >
                          {/* 그룹 헤더 — 클릭 = 지도 표출 한정(선택), 셰브런 = 접기/펼치기 */}
                          <div
                            onClick={() => selectGroup(g)}
                            title={picked ? "클릭하면 지도 표출 한정을 해제합니다" : "클릭하면 이 기체만 지도에 표출합니다"}
                            className={`flex cursor-pointer items-center gap-1.5 rounded-t-md px-2 py-1.5 transition-colors ${
                              picked ? "bg-[#a60739]/10" : open ? "bg-[#a60739]/5" : "hover:bg-gray-50"
                            }`}
                          >
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleGroup(g.modeS);
                              }}
                              title={open ? "접기" : "펼치기"}
                              className="shrink-0 rounded p-0.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-[#a60739]"
                            >
                              {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                            </button>
                            <span
                              className={`min-w-0 flex-1 truncate text-[11.5px] font-semibold ${picked ? "text-[#a60739]" : "text-gray-800"}`}
                              title={g.label}
                            >
                              {g.label}
                            </span>
                            <span className="shrink-0 font-mono text-[10px] font-bold tabular-nums" style={{ color: ERROR }}>
                              {g.events.length.toLocaleString()}건
                            </span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                fitBounds([[g.bbox.minLon, g.bbox.minLat], [g.bbox.maxLon, g.bbox.maxLat]]);
                              }}
                              title="이 항공기의 이벤트 범위로 지도 맞춤"
                              className="shrink-0 rounded p-0.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-[#a60739]"
                            >
                              <Crosshair size={12} />
                            </button>
                          </div>
                          <div className="flex items-center gap-2 px-2 pb-1 pl-[30px] text-[9.5px] text-gray-400">
                            <span>high {g.highCount.toLocaleString()}건</span>
                            <span>·</span>
                            <span>최대 이격 {g.maxSepKm.toFixed(2)}km</span>
                          </div>

                          {/* 그룹 본문 */}
                          {open && (
                            <div className="border-t border-gray-100 px-1 py-1">
                              {shown.map((e) => {
                                const sel = selectedEventId === e.id;
                                const high = e.confidence === "high";
                                const pinned = e.id === pinnedId;
                                return (
                                  <Fragment key={e.id}>
                                    {pinned && (
                                      <div className="mt-1 border-t border-dashed border-gray-200 pt-1 text-center text-[9px] text-gray-400">선택 이벤트 (목록 상한 밖)</div>
                                    )}
                                    <div
                                      id={`dual-ev-${e.id}`}
                                      onClick={() => {
                                        const map = mapRef.current?.getMap();
                                        if (map) {
                                          map.easeTo({
                                            center: [e.ghost.longitude, e.ghost.latitude],
                                            zoom: Math.max(map.getZoom(), 12),
                                            duration: 600,
                                          });
                                        }
                                        setSelectedClusterId(null);
                                        // 고정 행은 선택 해제 토글을 생략 — 해제하면 이 행 자체가 상한 밖으로
                                        // 사라져 커서 아래에서 행이 없어진다(지도 이동만 수행).
                                        // pinned ⇒ sel 불변식(고정 행은 선택 이벤트 자신뿐)이라 pinned 만 보면 된다.
                                        if (!pinned) setSelectedEventId(sel ? null : e.id);
                                        // Mode-S 한정 중에 다른 기체 행을 고르면 한정 대상도 그 기체로 옮긴다
                                        // (선택 강조만 필터 밖에 떠 있는 어긋난 상태 방지)
                                        if (!sel && selectedModeS != null && selectedModeS !== e.mode_s) {
                                          setSelectedModeS(e.mode_s);
                                        }
                                      }}
                                      className={`cursor-pointer rounded px-1.5 py-1 transition-colors ${sel ? "bg-[#a60739]/8" : "hover:bg-gray-50"}`}
                                    >
                                      <div className="flex items-center gap-1.5">
                                        <span
                                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                                          style={{ background: high ? ERROR : "#d1d5db" }}
                                          title={high ? "반사 기하 부합" : "기하 불부합·모호"}
                                        />
                                        <span className="shrink-0 font-mono text-[10px] tabular-nums text-gray-600">
                                          {format(new Date(e.ghost.timestamp * 1000), "HH:mm:ss")}
                                        </span>
                                        <span className="shrink-0 rounded bg-gray-100 px-1 text-[9px] font-bold text-gray-500">
                                          {e.source === "scan" ? "잔존" : "파서"}
                                        </span>
                                        <span className="ml-auto shrink-0 font-mono text-[10px] font-bold tabular-nums" style={{ color: ERROR }}>
                                          {e.separation_km.toFixed(2)}km
                                        </span>
                                      </div>
                                      <div className="truncate pl-3 text-[9.5px] text-gray-400">
                                        초과경로 {e.extra_path_km >= 0 ? "+" : ""}{e.extra_path_km.toFixed(2)}km
                                        {e.reflector
                                          ? ` · 반사 ${e.reflector.range_km.toFixed(1)}km / ${e.reflector.azimuth_deg.toFixed(0)}°`
                                          : " · 반사점 미산출"}
                                      </div>
                                    </div>
                                  </Fragment>
                                );
                              })}
                              {g.events.length > shown.length && (
                                <div className="py-1 text-center text-[9.5px] text-gray-400">
                                  …외 {(g.events.length - shown.length).toLocaleString()}건
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 우측 지도 — 건축물정보 드로어를 내부에 도킹하므로 relative */}
        <div className="relative min-w-0 flex-1 overflow-hidden rounded-lg border border-gray-200">
          <MapGL
            ref={mapRef}
            initialViewState={{
              latitude: analysisSite.latitude,
              longitude: analysisSite.longitude,
              zoom: 9,
            }}
            style={{ width: "100%", height: "100%" }}
            mapStyle="https://basemaps.cartocdn.com/gl/positron-gl-style/style.json"
            onLoad={() => {
              setMapReady(true); // 지도 이벤트(건물 재조회·줌 추적) 구독 게이트
              // 지도 로드 전에 확정된 범위 예약분 적용
              const b = pendingFitRef.current;
              if (!b) return;
              pendingFitRef.current = null;
              mapRef.current?.getMap().fitBounds(b, { padding: 60, duration: 0, maxZoom: 14 });
            }}
          >
            <NavigationControl position="top-right" />
            <DualDeckLayers staticLayers={deckLayers} anim={reflectionAnim} />
          </MapGL>

          {/* ── 우측 건축물정보 드로어 (건물 폴리곤 클릭) ── */}
          <div
            className="absolute bottom-0 right-0 top-0 z-[760] flex flex-col bg-white"
            style={{
              width: 300,
              borderLeft: "1px solid #e5e7eb",
              boxShadow: bldgDrawer ? "-6px 0 28px rgba(0,0,0,.14)" : "none",
              transform: bldgDrawer ? "translateX(0)" : "translateX(316px)",
              transition: "transform .4s cubic-bezier(.4,0,.2,1), box-shadow .3s",
              pointerEvents: bldgDrawer ? "auto" : "none",
            }}
          >
            {(() => {
              // 닫힘 애니메이션 중에도 마지막 내용 유지
              const bd = bldgDrawer ?? lastBldgRef.current;
              if (!bd) return null;
              const bi = bd.info;
              const fac = bd.facDetail;
              const pick = (...vals: (string | null | undefined)[]): string => {
                for (const v of vals) if (v != null && v !== "") return v;
                return "-";
              };
              // 과거 DB 의 '실측(1m DSM)' 표기는 용도로 취급하지 않음
              const realUsage = (v?: string | null) => (v === "실측(1m DSM)" ? null : v);
              const displayName = pick(fac?.name, bi?.name, bd.localName);
              // 거리·방위는 **분석 기준 레이더(analysisSite)** 기준 — 전역 선택 레이더가 아니다
              const cosLat = Math.cos((analysisSite.latitude * Math.PI) / 180);
              const dLat = bd.lat - analysisSite.latitude;
              const dLon = bd.lon - analysisSite.longitude;
              const az = ((Math.atan2(dLon * cosLat, dLat) * 180) / Math.PI + 360) % 360;
              const distKm = Math.sqrt((dLat * 111.32) ** 2 + (dLon * 111.32 * cosLat) ** 2);
              // 실측 지붕고(1m DSM)가 있으면 최우선 — 옥상표고도 동일 값 사용
              const heightMeasured = fac?.height_measured_m ?? null;
              const height = heightMeasured ?? bd.localHeight ?? fac?.height_m;
              const base = bd.localBase ?? fac?.ground_elev_m;
              const src = bd.localSource ?? (fac ? "fac" : undefined);
              const srcLabel = src === "fac" ? "건물통합정보" : src === "manual" ? "수동 등록" : "-";
              const row = (k: string, v: ReactNode, k2?: string, v2?: ReactNode) => (
                <tr className="border-b border-gray-100">
                  <td className="w-[62px] bg-gray-50 px-2 py-1.5 text-gray-500">{k}</td>
                  <td className="px-2 py-1.5 text-gray-700" colSpan={k2 != null ? 1 : 3}>{v}</td>
                  {k2 != null && <td className="w-[62px] bg-gray-50 px-2 py-1.5 text-gray-500">{k2}</td>}
                  {k2 != null && <td className="px-2 py-1.5 text-gray-700">{v2}</td>}
                </tr>
              );
              const secLabel = "px-3 pt-2.5 pb-0.5 text-[9px] font-semibold uppercase tracking-wider text-gray-400";
              return (
                <>
                  {/* 헤더 */}
                  <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2">
                    <span className="text-[12px] font-bold text-gray-800">건축물정보</span>
                    <button
                      onClick={() => setBldgDrawer(null)}
                      title="닫기"
                      className="rounded p-0.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                    >
                      <X size={13} />
                    </button>
                  </div>
                  {/* 본문 — 기하 정보(항상) + 대장 정보(로컬 FAC + 온라인 VWorld) */}
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {/* 건물명/주소 배너 */}
                    {(displayName !== "-" || bi?.road_addr || bi?.jibun_addr) && (
                      <div className="mx-3 mb-2 mt-3 space-y-1 rounded border border-gray-200 bg-gray-50 px-2.5 py-2">
                        {displayName !== "-" && <div className="text-[12px] font-semibold text-gray-800">{displayName}</div>}
                        {bi?.road_addr && (
                          <div className="flex items-start gap-1.5 text-[10.5px]">
                            <span className="shrink-0 rounded-sm bg-[#a60739] px-1.5 py-[1px] text-[9px] font-semibold text-white">도로명</span>
                            <span className="leading-[14px] text-gray-700">{bi.road_addr}</span>
                          </div>
                        )}
                        {bi?.jibun_addr && (
                          <div className="flex items-start gap-1.5 text-[10.5px]">
                            <span className="shrink-0 rounded-sm bg-gray-500 px-1.5 py-[1px] text-[9px] font-semibold text-white">지번</span>
                            <span className="leading-[14px] text-gray-700">{bi.jibun_addr}</span>
                          </div>
                        )}
                      </div>
                    )}
                    {/* 기하 정보 (분석 레이더 기준 — 항상 표시) */}
                    <div className={secLabel + " pt-1"}>기하 정보</div>
                    <table className="w-full border-t border-gray-200 text-[10.5px]">
                      <tbody>
                        {row("출처", srcLabel, heightMeasured != null ? "건물높이(실측)" : "건물높이", height != null ? `${height.toFixed(1)} m` : "-")}
                        {(heightMeasured != null || bd.localMeasured) && row("실측자료", "실측 3D (1m DSM)")}
                        {row("지반표고", base != null ? `${base.toFixed(1)} m` : "-", "옥상표고", (base != null && height != null) ? `${(base + height).toFixed(1)} m` : "-")}
                        {row("레이더거리", `${(distKm / 1.852).toFixed(1)} NM`, "레이더방위", `${az.toFixed(1)}°`)}
                      </tbody>
                    </table>
                    <div className="px-3 pb-1 pt-0.5 text-[9px] text-gray-400">기준 레이더 · {analysisSite.name}</div>
                    {/* 대장 정보 (로컬 건물통합정보 + 온라인 VWorld) */}
                    <div className={secLabel + " flex items-center gap-1.5"}>
                      대장 정보
                      {bd.loading && <Loader2 size={9} className="animate-spin text-gray-300" />}
                    </div>
                    <table className="w-full border-t border-gray-200 text-[10.5px]">
                      <tbody>
                        {row("건물명칭", pick(fac?.name, bi?.name))}
                        {row("동명칭", pick(fac?.dong_name, bi?.dong_name), "용도", pick(realUsage(fac?.usage), bi?.usage, realUsage(bd.localUsage)))}
                        {row("구조", pick(bi?.structure))}
                        {row("지상층수", bi?.floors_above ? `${bi.floors_above} 층` : "-", "지하층수", bi?.floors_below ? `${bi.floors_below} 층` : "-")}
                        {row("건물면적", bi?.area ? `${bi.area} ㎡` : "-", "연면적", bi?.total_area ? `${bi.total_area} ㎡` : "-")}
                        {row("PNU", pick(fac?.pnu))}
                        {row("관리번호", pick(fac?.bd_mgt_sn))}
                      </tbody>
                    </table>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      </div>

      {/* 파싱 필터 모달 */}
      <ParseFilterModal open={filterModalOpen} onClose={closeFilterModal} onConfirm={parseWithFilter} aircraft={aircraft} />

      {/* 분석 레이더 변경 확인 — 좌표 재변환이 필요하므로 재파싱 여부를 확인받는다 */}
      {radarConfirm && (
        <Modal open={true} onClose={() => setRadarConfirm(null)} title="분석 레이더 변경" width="max-w-md">
          <div className="space-y-4 text-sm text-gray-700">
            <p className="leading-relaxed">
              ASS 자료는 레이더 기준 극좌표(거리·방위)로 기록되어 있어, 기준 레이더가 바뀌면
              모든 표적 좌표를 <span className="font-semibold text-[#a60739]">다시 변환(재파싱)</span>해야 합니다.
            </p>
            {lastPathsRef.current.length > 0 && lastFilterRef.current ? (
              <p className="rounded-lg border border-gray-200 bg-[#f8f9fa] px-3 py-2 text-[12.5px] leading-relaxed">
                현재 불러온 ASS 파일 <span className="font-mono font-bold tabular-nums">{lastPathsRef.current.length.toLocaleString()}</span>개를{" "}
                <span className="font-semibold text-[#a60739]">{radarConfirm}</span> 기준으로 다시 파싱합니다.
              </p>
            ) : (
              <p className="rounded-lg border border-gray-200 bg-[#f8f9fa] px-3 py-2 text-[12.5px] leading-relaxed">
                다시 파싱할 파일 정보가 없습니다 — 레이더만 변경하고 새 ASS 파일을 선택하세요.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setRadarConfirm(null)}
                className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50"
              >
                취소
              </button>
              <button
                onClick={confirmRadarChange}
                className="rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#8a062f]"
              >
                {lastPathsRef.current.length > 0 && lastFilterRef.current ? "재파싱 실행" : "레이더만 변경"}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* 파싱 결과 안내 */}
      {notice && (
        <Modal open={true} onClose={() => setNotice(null)} title={notice.title} width="max-w-md">
          <div className="space-y-4 text-sm text-gray-700">
            <p className="whitespace-pre-line leading-relaxed">{notice.message}</p>
            <div className="flex justify-end">
              <button
                onClick={() => setNotice(null)}
                className="rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#8a062f]"
              >
                확인
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
