import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MapGL, { NavigationControl, type MapRef } from "react-map-gl/maplibre";
import { ScatterplotLayer, LineLayer, PathLayer, TextLayer } from "@deck.gl/layers";
import { TripsLayer } from "@deck.gl/geo-layers";
import { DeckGLOverlay } from "../components/Map/DeckGLOverlay";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { format } from "date-fns";
import { Ghost, FolderOpen, Loader2, Search, ChevronDown, ChevronUp, Crosshair, X, RefreshCw } from "lucide-react";
import Modal from "../components/common/Modal";
import ParseFilterModal, { type ParseFilterResult } from "../components/common/ParseFilterModal";
import { useAppStore } from "../store";
import {
  clearWorkerPoints,
  postPointsToWorker,
  postGhostPointsToWorker,
  startConsolidate,
  analyzeDualTargets,
} from "../utils/flightConsolidationWorker";
import type {
  Aircraft,
  AddressBuildingHit,
  DualTargetEvent,
  Flight,
  ReflectorCluster,
  TrackPoint,
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
 */

const ACCENT = "#a60739";
const ERROR = "#e94560";

/** 그룹당 표시 행 상한 — UI 표시만 제한(통계·지도는 전수 이벤트 사용) */
const GROUP_ROW_CAP = 200;
/** 건물명 라벨링 대상 클러스터 수 (count 상위) */
const LABEL_MAX = 20;

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
  /** 최신 요청만 반영 (재업로드/재분석 시 늦게 도착한 결과·라벨링 폐기) */
  const seqRef = useRef(0);
  /** 지도 로드 전에 확정된 fitBounds 예약 (파싱 직후 분석 완료 대비) */
  const pendingFitRef = useRef<[[number, number], [number, number]] | null>(null);

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
  /** 지도 표출을 특정 레이더로 한정 (지도 레이더 마커 클릭 토글) */
  const [selectedRadarName, setSelectedRadarName] = useState<string | null>(null);
  const [expandedModeS, setExpandedModeS] = useState<Set<string>>(new Set());

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

  // ── 분석 실행 ─────────────────────────────────────────────────────
  //   Worker 소유 포인트로 계산(메인 스레드 축적 없음). 결과 수신 후 상위 클러스터에 한해
  //   건물명을 순차 라벨링한다(전 클러스터 라벨링은 find_building_near_point 호출 과다).
  const runAnalysis = useCallback(async () => {
    const seq = ++seqRef.current;
    setPhase("analyzing");
    setError(null);
    try {
      const result = await analyzeDualTargets({ sites: dualSites, scanWindowS, minSepKm });
      if (seq !== seqRef.current) return; // 최신 요청만 반영
      setDualResult(result);
      setSelectedEventId(null);
      setSelectedClusterId(null);
      setSelectedModeS(null);
      setSelectedRadarName(null);

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
          if (seq !== seqRef.current) return; // 재실행/재업로드 → 라벨링 중단
          if (hit?.name) names.set(c.id, hit.name);
        } catch {
          // 라벨 조회 실패는 조용히 무시 — 좌표 표기로 폴백
        }
      }
      if (seq !== seqRef.current || names.size === 0) return;
      const cur = useAppStore.getState().dualTargetResult;
      if (!cur) return;
      setDualResult({
        ...cur,
        clusters: cur.clusters.map((c) => (names.has(c.id) ? { ...c, building_name: names.get(c.id)! } : c)),
      });
    } catch (e) {
      if (seq !== seqRef.current) return;
      console.error("[DualTarget] 분석 실패:", e);
      setError(String(e));
      setDualResult(null);
    } finally {
      if (seq === seqRef.current) setPhase("idle");
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
  const parseWithFilter = useCallback(async (filter: ParseFilterResult) => {
    setFilterModalOpen(false);
    const paths = pendingPaths;
    if (paths.length === 0) return;

    const seq = ++seqRef.current;
    setError(null);
    setDualResult(null);
    setSelectedEventId(null);
    setSelectedClusterId(null);
    setSelectedModeS(null);
    setSelectedRadarName(null);
    setExpandedModeS(new Set());
    setSearch("");
    flightsRef.current = [];
    setFlightCount(0);
    setFileCount(paths.length);
    setPhase("parsing");

    // 재업로드 = 대체 시맨틱 — Worker 축적분(포인트·비행 인덱스·유령 보존분) 전량 폐기
    clearWorkerPoints();

    const site = useAppStore.getState().radarSite;

    // 항적 포인트 / 파서 보존 유령표적 — 둘 다 radar_name 태깅 후 Worker 로 즉시 전송
    const unlistenPoints = await listen<{ points: TrackPoint[] }>("parse-points-chunk", (event) => {
      const pts = event.payload.points;
      for (const p of pts) p.radar_name = site.name;
      postPointsToWorker(pts);
    });
    const unlistenGhost = await listen<{ points: TrackPoint[] }>("parse-ghost-chunk", (event) => {
      const pts = event.payload.points;
      for (const p of pts) p.radar_name = site.name;
      postGhostPointsToWorker(pts);
    });

    let failed = false;
    try {
      await invoke("parse_and_analyze_batch", {
        filePaths: paths,
        radarLat: site.latitude,
        radarLon: site.longitude,
        modeSInclude: filter.modeSInclude,
        modeSExclude: filter.modeSExclude,
        mode3aInclude: filter.mode3aInclude,
        mode3aExclude: filter.mode3aExclude,
      });
    } catch (e) {
      failed = true;
      console.error("[DualTarget] 배치 파싱 실패:", e);
    }

    unlistenPoints();
    unlistenGhost();
    setPendingPaths([]);

    if (seq !== seqRef.current) return; // 새 업로드가 시작됨
    if (failed) {
      setPhase("idle");
      setNotice({ title: "파싱 실패", message: "파일을 읽지 못했습니다. ASS 파일 형식과 경로를 확인하세요." });
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
      console.error("[DualTarget] 비행 통합 실패:", e);
      if (seq !== seqRef.current) return;
      setPhase("idle");
      setError(String(e));
      return;
    }
    if (seq !== seqRef.current) return;
    setFlightCount(flightsRef.current.length);

    await runAnalysis();
  }, [pendingPaths, setDualResult, runAnalysis]);

  const closeFilterModal = useCallback(() => {
    setFilterModalOpen(false);
    setPendingPaths([]);
  }, []);

  // ── 파생 데이터 ───────────────────────────────────────────────────

  // 필터 3종은 순차 교집합. 목록(groups)은 Mode-S 필터 **이전** 단계(listEvents)를 쓰므로
  // 한 기체를 선택해도 다른 기체 그룹이 목록에 남아 곧바로 바꿔 선택할 수 있다.

  /** 레이더 선택 필터 (지도 레이더 마커 클릭) */
  const radarEvents = useMemo(() => {
    const all = dualResult?.events ?? [];
    if (selectedRadarName == null) return all;
    return all.filter((e) => e.radar_name === selectedRadarName);
  }, [dualResult, selectedRadarName]);

  /** 좌측 그룹 목록 모집단 — 레이더 + 반사 위치 필터 적용 */
  const listEvents = useMemo(() => {
    if (selectedClusterId == null) return radarEvents;
    return radarEvents.filter((e) => e.cluster_id === selectedClusterId);
  }, [radarEvents, selectedClusterId]);

  /** 지도 표출 이벤트 — 반사 위치 ∩ Mode-S ∩ 레이더 */
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
    const byRadar = selectedRadarName == null ? all : all.filter((c) => c.radar_name === selectedRadarName);
    if (selectedModeS == null) return [...byRadar].sort((a, b) => b.count - a.count);

    const counts = new Map<number, number>();
    for (const e of radarEvents) {
      if (e.mode_s !== selectedModeS || e.cluster_id == null) continue;
      counts.set(e.cluster_id, (counts.get(e.cluster_id) ?? 0) + 1);
    }
    const out: ReflectorCluster[] = [];
    for (const c of byRadar) {
      const n = counts.get(c.id);
      if (n == null) continue;
      out.push({ ...c, count: n });
    }
    out.sort((a, b) => b.count - a.count);
    return out;
  }, [dualResult, radarEvents, selectedModeS, selectedRadarName]);

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

  /** 결과에 등장하는 레이더 사이트만 지도에 표기 */
  const siteMarkers = useMemo(() => {
    if (!dualResult) return [];
    const names = new Set<string>();
    for (const e of dualResult.events) names.add(e.radar_name);
    for (const c of dualResult.clusters) names.add(c.radar_name);
    return dualSites.filter((s) => names.has(s.name));
  }, [dualResult, dualSites]);

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

  /** 레이더 마커 클릭 토글 — 선택 레이더로 지도 표출을 한정 */
  const toggleRadar = useCallback((name: string) => {
    setSelectedEventId(null);
    setSelectedRadarName((prev) => (prev === name ? null : name));
  }, []);

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
  //   그리기 순서(뒤 → 앞): 사이트 → 짝선 → 실표적 → 유령표적 → 반사 위치 → 개수 → 선택 강조.
  const deckLayers = useMemo<DeckLayerList>(() => {
    if (!dualResult) return [];
    /** 클러스터 원 반경(px) — count 로 완만히 증가, 26px 상한 */
    const clusterRadius = (count: number) => Math.min(26, 7 + Math.sqrt(count) * 3);
    const layers: DeckLayerList = [
      new ScatterplotLayer<{ name: string; latitude: number; longitude: number }>({
        id: "dual-sites",
        data: siteMarkers,
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
          toggleRadar(d.name);
        },
      }),
      new TextLayer<{ name: string; latitude: number; longitude: number }>({
        id: "dual-site-labels",
        data: siteMarkers,
        getPosition: (d) => [d.longitude, d.latitude],
        getText: (d) => d.name,
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
        pickable: false,
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
          const d = info.object;
          if (!d) return;
          setSelectedClusterId(null);
          setSelectedEventId((prev) => (prev === d.id ? null : d.id));
          // 선택된 이벤트 행이 목록에서 보이도록 소속 Mode-S 그룹을 펼친다
          setExpandedModeS((prev) => new Set(prev).add(d.mode_s));
        },
      }),
      new ScatterplotLayer<ReflectorCluster>({
        id: "dual-reflectors",
        data: displayClusters,
        getPosition: (d) => [d.longitude, d.latitude],
        getFillColor: [166, 7, 57, 235],
        getLineColor: [255, 255, 255, 255],
        stroked: true,
        filled: true,
        lineWidthMinPixels: 1.5,
        radiusUnits: "pixels" as const,
        getRadius: (d) => clusterRadius(d.count),
        pickable: true,
        onClick: (info: { object?: ReflectorCluster }) => {
          const d = info.object;
          if (!d) return;
          setSelectedEventId(null);
          setSelectedClusterId((prev) => (prev === d.id ? null : d.id));
        },
      }),
      new TextLayer<ReflectorCluster>({
        id: "dual-reflector-count",
        data: displayClusters,
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
    ];

    // ── 선택 레이더 강조 링 ──
    if (selectedRadarName != null) {
      const s = siteMarkers.find((m) => m.name === selectedRadarName);
      if (s) {
        layers.push(
          new ScatterplotLayer<{ name: string; latitude: number; longitude: number }>({
            id: "dual-selected-site-ring",
            data: [s],
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
      const ev = dualResult.events.find((e) => e.id === selectedEventId);
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

    // ── 선택 클러스터 강조: 반사 위치 링 (소속 이벤트 필터는 baseEvents 에서 적용) ──
    if (selectedClusterId != null) {
      const cl = displayClusters.find((c) => c.id === selectedClusterId);
      if (cl) {
        layers.push(
          new ScatterplotLayer<ReflectorCluster>({
            id: "dual-selected-cluster-ring",
            data: [cl],
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
    dualResult, baseEvents, displayClusters, siteMarkers, dualSites,
    selectedEventId, selectedClusterId, selectedModeS, selectedRadarName, toggleRadar,
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

              {/* 예상 반사 위치 — Mode-S·레이더 선택 시 그 선택이 참조하는 클러스터만 (건수도 재계산) */}
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
                            setSelectedEventId(null);
                            setSelectedClusterId(sel ? null : c.id);
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
                    {selectedRadarName != null && (
                      <button
                        onClick={() => toggleRadar(selectedRadarName)}
                        title="레이더 선택을 해제합니다"
                        className="min-w-0 shrink truncate text-[10px] text-[#a60739] hover:underline"
                      >
                        레이더 필터 해제 ({selectedRadarName})
                      </button>
                    )}
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
                      const shown = g.events.slice(0, GROUP_ROW_CAP);
                      return (
                        <div
                          key={g.modeS}
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
                                return (
                                  <div
                                    key={e.id}
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
                                      setSelectedEventId(sel ? null : e.id);
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
                                );
                              })}
                              {g.events.length > GROUP_ROW_CAP && (
                                <div className="py-1 text-center text-[9.5px] text-gray-400">
                                  …외 {(g.events.length - GROUP_ROW_CAP).toLocaleString()}건
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

        {/* 우측 지도 */}
        <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-gray-200">
          <MapGL
            ref={mapRef}
            initialViewState={{
              latitude: radarSite.latitude,
              longitude: radarSite.longitude,
              zoom: 9,
            }}
            style={{ width: "100%", height: "100%" }}
            mapStyle="https://basemaps.cartocdn.com/gl/positron-gl-style/style.json"
            onLoad={() => {
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
        </div>
      </div>

      {/* 파싱 필터 모달 */}
      <ParseFilterModal open={filterModalOpen} onClose={closeFilterModal} onConfirm={parseWithFilter} aircraft={aircraft} />

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
