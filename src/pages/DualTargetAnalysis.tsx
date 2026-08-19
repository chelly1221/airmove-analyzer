import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import MapGL, { NavigationControl, useMap, type MapRef } from "react-map-gl/maplibre";
import { ScatterplotLayer, LineLayer, PathLayer, PolygonLayer, TextLayer, IconLayer } from "@deck.gl/layers";
import { TripsLayer } from "@deck.gl/geo-layers";
import { DeckGLOverlay } from "../components/Map/DeckGLOverlay";
import { fetchBuildingsForViewport } from "../utils/buildingTileCache";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { format } from "date-fns";
import { Ghost, FolderOpen, Loader2, Search, ChevronDown, ChevronUp, X, RefreshCw } from "lucide-react";
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
  queryModeSTrack,
  ConsolidateSuperseded,
} from "../utils/flightConsolidationWorker";
import type {
  Aircraft,
  AddressBuildingHit,
  Building3D,
  DualTargetEvent,
  DualTargetKind,
  DualTargetReflector,
  FacBuildingDetail,
  Flight,
  ModeSTrack,
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
 *
 * **지도 클릭 시맨틱** — 반사체 마커 클릭은 (병합 마커든 개별이든) 줌인 없이 그 마커에 묶인
 * 반사 위치 **전부**를 선택 필터로 잡는다. 실표적·유령표적 클릭은 그 기체(Mode-S)로 한정하며,
 * Mode-S 가 한정되면 워커에서 그 기체의 **전체 항적**을 typed array 로 받아 오버레이한다.
 */

const ACCENT = "#a60739";
const ERROR = "#e94560";

/** 그룹당 표시 행 상한 — UI 표시만 제한(통계·지도는 전수 이벤트 사용) */
const GROUP_ROW_CAP = 200;
/** 기본 제외 Mode-S — 시험표적(site monitor) 2 + 이상주소 2.
 *  시험표적(71D703·84AB56)은 방위 지터가 이중표적으로 잡힌다.
 *  이상주소 000001(미설정 기본주소)·924924(100100 반복 비트패턴)는 김포 SSW 7~11km 저속 물체
 *  2기가 번갈아 사용해 하루 수백 건의 주소중복 이벤트를 만든다. */
const DEFAULT_EXCLUDE_MODE_S = "71D703, 84AB56, 000001, 924924";
/** 분류 배지 라벨 */
const KIND_LABEL: Record<DualTargetKind, string> = {
  reflection: "반사",
  dup_address: "주소중복",
  unknown: "미확인",
};
/** 분류 배지 색 — 반사=액센트, 주소중복=slate(지도 유령점과 동색), 미확인=회색 */
const KIND_BADGE_CLASS: Record<DualTargetKind, string> = {
  reflection: "bg-[#a60739]/10 text-[#a60739]",
  dup_address: "bg-slate-200 text-slate-600",
  unknown: "bg-gray-100 text-gray-500",
};

/** 분류 필터 칩 정의 — 건수는 stats 에서 읽는다. "전체" 칩은 없다(사용자 결정, 기본 탭 = 반사) */
const KIND_CHIPS: { k: DualTargetKind; label: string; title: string }[] = [
  { k: "reflection", label: "반사", title: "초과경로 있음 + 반사점 레이더 근방(≤25km) + (고도 비교 가능 시) 응답 내용 일치 — 올콜 응답은 기하만으로 판정" },
  { k: "dup_address", label: "주소중복", title: "고도 불일치 또는 유령 위치에 PSR 스킨 에코 — 같은 주소의 다른 항공기·물체" },
  { k: "unknown", label: "미확인", title: "반사 기하 불성립(초과경로 없음·반사점 원거리)" },
];

/** 건물명 라벨링 대상 클러스터 수 (count 상위) */
const LABEL_MAX = 20;

/** 제외 Mode-S 입력 파싱 — 콤마/공백/세미콜론 구분, 6자리 16진수만 대문자로 채택 */
function parseModeSList(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of text.split(/[\s,;]+/)) {
    if (!/^[0-9A-F]{6}$/i.test(tok)) continue;
    const up = tok.toUpperCase();
    if (seen.has(up)) continue;
    seen.add(up);
    out.push(up);
  }
  return out;
}

/** 분류 사유 한글 설명 (배지 툴팁) — 고도 차이는 ft 로 환산해 보여준다 */
function kindReasonText(e: DualTargetEvent): string {
  switch (e.kind_reason) {
    case "content_match":
      return "고도(응답 내용) 일치·초과경로 있음·반사점 레이더 근방 — 반사 기하 부합";
    case "geometry_only":
      return "올콜(All-Call) 응답은 고도가 없어 내용 비교 불가 — 초과경로·반사점 근방(≤25km) 기하만으로 반사 판정";
    case "altitude_mismatch":
      return `고도 불일치 Δ${Math.round(Math.abs(e.real.altitude - e.ghost.altitude) / 0.3048)}ft → 같은 주소의 다른 항공기`
        + (e.ghost.radar_type === "mode_ac" || e.ghost.radar_type === "mode_ac_psr" ? " (Mode 3/A 병합 표적)" : "");
    case "ghost_psr":
      return "유령 위치에 1차 레이더(PSR) 스킨 에코 동반 — 물리적 표적(같은 주소의 다른 항공기·물체)";
    case "no_extra_path":
      return "초과경로 없음(유령이 더 가깝거나 같은 거리) — 반사 기하 성립 안 함";
    case "reflector_far":
      return `역산 반사점이 레이더에서 ${e.reflector ? e.reflector.range_km.toFixed(1) : "?"}km — 근방 반사체일 수 없음(같은 주소의 다른 항공기·원거리 잡음 가능성)`;
    default:
      return "판정 근거 없음";
  }
}

/** 지도 반사 표출용 반사점 — 실반사(kind reflection)만. unknown/reflector_far 의 반사점은
 *  데이터로만 남기고 지도엔 그리지 않는다 (좌측 목록의 "· 반사 X km / N°" 는 확인용으로 유지) */
function mapReflector(e: DualTargetEvent): DualTargetReflector | null {
  return e.kind === "reflection" ? e.reflector : null;
}

// ── 2D 건물 표출 ────────────────────────────────────────────────────
/** 건물 표출 최소 줌 — 미만이면 뷰포트 조회 자체를 생략(광역에서 수만 동 로드 방지) */
const BUILDING_MIN_ZOOM = 13;
/** 지도 이동 후 건물 재조회 디바운스 (ms) */
const BUILDING_FETCH_DEBOUNCE_MS = 250;

// ── 반사면(장애물) 선 표출 ─────────────────────────────────────────
/** 반사면 선 표출 최소 줌 — 이 이상 확대하면 반사점마다 반사면을 선으로 그린다 */
const REFLECT_SURFACE_MIN_ZOOM = 16;
/** 반사면 선 반길이 (m) — 벽면 폭은 알 수 없으므로 상징적 고정 길이 */
const REFLECT_SURFACE_HALF_M = 30;

// ── 반사체 줌 적응 클러스터링 ────────────────────────────────────────
/** 화면 픽셀 기준 병합 반경 — 마커 최대 반경(26px) + 여유. 이 반경 안의 반사 위치는 한 마커로 병합.
 *  격자 비닝이 아니라 greedy 반경 병합(supercluster 방식)이라 셀 경계에서 마커가 겹치지 않는다. */
const CLUSTER_MERGE_RADIUS_PX = 40;

/** Web Mercator 투영 — scale(=512·2^zoom) 기준 화면 픽셀 좌표.
 *  위도는 메르카토르 발산 방지로 ±85° 클램프(국내 자료라 실질 무영향). */
function projMerc(lon: number, lat: number, scale: number): [number, number] {
  const clamped = Math.min(85, Math.max(-85, lat));
  const phi = (clamped * Math.PI) / 180;
  return [
    ((lon + 180) / 360) * scale,
    ((1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2) * scale,
  ];
}

/**
 * 반사면 선분 끝점 — 반사점 P 에서 실표적 A 방향과 레이더 S 방향의 이등분선(반사면 법선)에
 * **수직**인 선분(P 중심, ±halfM). 국지 ENU 평면 근사(수십 m 라 오차 무시). 두 방향이
 * 정반대(법선 소실)면 null.
 */
function reflectSurfaceSegment(
  p: { latitude: number; longitude: number },
  a: { latitude: number; longitude: number },
  s: { latitude: number; longitude: number },
  halfM: number,
): [[number, number], [number, number]] | null {
  const cosLat = Math.cos((p.latitude * Math.PI) / 180);
  const mPerDegLat = 110_540;
  const mPerDegLon = 111_320 * cosLat;
  const ax = (a.longitude - p.longitude) * mPerDegLon, ay = (a.latitude - p.latitude) * mPerDegLat;
  const sx = (s.longitude - p.longitude) * mPerDegLon, sy = (s.latitude - p.latitude) * mPerDegLat;
  const la = Math.hypot(ax, ay), ls = Math.hypot(sx, sy);
  if (!(la > 0) || !(ls > 0)) return null;
  const nx = ax / la + sx / ls, ny = ay / la + sy / ls; // 법선(이등분선)
  const ln = Math.hypot(nx, ny);
  if (ln < 1e-6) return null;
  const tx = -ny / ln, ty = nx / ln; // 반사면 방향 = 법선에 수직
  const dLon = (tx * halfM) / mPerDegLon, dLat = (ty * halfM) / mPerDegLat;
  return [
    [p.longitude - dLon, p.latitude - dLat],
    [p.longitude + dLon, p.latitude + dLat],
  ];
}

/** projMerc 역변환 — 화면 픽셀 좌표 → [lon, lat] */
function unprojMerc(x: number, y: number, scale: number): [number, number] {
  return [
    (x / scale) * 360 - 180,
    ((2 * Math.atan(Math.exp(Math.PI * (1 - (2 * y) / scale))) - Math.PI / 2) * 180) / Math.PI,
  ];
}

// ── 유령표적 방사선 점선 ─────────────────────────────────────────────
/** 점선 한 칸: 그려지는 길이 / 비는 길이 (px) — 주기 10px */
const DASH_ON_PX = 6;
const DASH_GAP_PX = 4;
/** 점선 세그먼트 총량 상한 — 초과 시 주기를 늘려 흡수(아래 ghostDashSegments 주석 참조) */
const MAX_GHOST_DASH_SEGMENTS = 200_000;

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
  /** 시드 클러스터 id 기반 안정 키 (`zc-<seedId>`) — 격자 좌표가 아니라 데이터에서 유도 */
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
//   **6초 주기 무한 반복** — 선택 해제·언마운트 시에만 종료.
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
  /** kind === "reflection" 건수 (헤더 표기) */
  reflectionCount: number;
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
  // overlaid 모드의 deck 컨테이너는 pointer-events:none 이라 deck getCursor 가 무효 —
  // 픽 가능한 객체 호버 시 지도 캔버스 커서를 직접 바꿔 클릭 가능함을 알린다.
  const { current: map } = useMap();

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

  /**
   * 타임라인 0–4 트립(항공기 → 반사체 → 레이더) · 4–6 펄스(유령표적 위치),
   * **6초 주기 무한 반복** — 선택 해제·언마운트 시에만 종료.
   *
   * 세 레이어를 항상 같은 id 로 전부 반환하고 국면은 visible 로만 전환한다.
   * 레이어를 교체(swap)하면 주기가 넘어갈 때마다 deck.gl 이 인스턴스를 파기·재생성해
   * 반복 재생이 첫 주기에서 끊길 수 있다 — 인스턴스를 유지해 재초기화 없이 무한 반복.
   */
  const animLayers = useMemo<DeckLayerList>(() => {
    if (!anim) return [];
    // 펄스 국면(4–6초) — 진행도 p 와 페이드 알파. 트립 국면에서는 0(비표출).
    const pulseOn = animTime >= ANIM_ARRIVE_S;
    const p = pulseOn ? (animTime - ANIM_ARRIVE_S) / (ANIM_PERIOD_S - ANIM_ARRIVE_S) : 0; // 0 → 1
    const alpha = pulseOn ? Math.round(255 * (1 - p)) : 0;
    return [
      new TripsLayer<{ path: [number, number][] }>({
        id: "dual-anim-trip",
        data: anim.tripData,
        getPath: (d) => d.path,
        getTimestamps: () => ANIM_TIMESTAMPS,
        getColor: [233, 69, 96],
        // 셰이더가 시간창 밖 정점을 버리므로 ARRIVE+TRAIL 이후엔 아무것도 그려지지 않는다
        currentTime: animTime,
        trailLength: ANIM_TRAIL,
        fadeTrail: true,
        visible: animTime < ANIM_ARRIVE_S + ANIM_TRAIL,
        getWidth: 4,
        widthUnits: "pixels" as const,
        widthMinPixels: 4,
        capRounded: true,
        jointRounded: true,
        pickable: false,
      }),
      new LineLayer<ReflectionAnim["pulseData"][number]>({
        id: "dual-anim-ghostline",
        data: anim.pulseData,
        getSourcePosition: (d) => [d.siteLon, d.siteLat],
        getTargetPosition: (d) => [d.lon, d.lat],
        getColor: [233, 69, 96, Math.max(120, alpha)],
        getWidth: 3,
        widthUnits: "pixels" as const,
        widthMinPixels: 3,
        visible: pulseOn,
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
        visible: pulseOn,
        updateTriggers: { getRadius: p, getLineColor: alpha },
        pickable: false,
      }),
    ];
  }, [anim, animTime]);

  return (
    <DeckGLOverlay
      layers={[...staticLayers, ...animLayers]}
      // 표적 점이 작아 정확히 못 눌러도 잡히도록 근접 픽 허용
      pickingRadius={6}
      onHover={(info) => {
        const canvas = map?.getCanvas();
        if (canvas) canvas.style.cursor = info.picked ? "pointer" : "";
      }}
    />
  );
}

// ── 지도 범례 ────────────────────────────────────────────────────────
/** 범례 점 스와치 — 지도 레이어와 같은 색·테두리를 인라인 SVG 로 재현 */
function LegendDot({ fill, stroke, r = 4.5 }: { fill?: string; stroke?: string; r?: number }) {
  return (
    <svg width={16} height={12} viewBox="0 0 16 12" className="shrink-0">
      <circle
        cx={8} cy={6} r={r}
        fill={fill ?? "none"}
        stroke={stroke ?? "none"}
        strokeWidth={stroke ? 1.5 : 0}
      />
    </svg>
  );
}

/** 범례 선 스와치 — dashed 면 점선(지도의 유령표적 방사선과 동일 표현) */
function LegendLine({ color, width = 2, dashed = false }: { color: string; width?: number; dashed?: boolean }) {
  return (
    <svg width={16} height={12} viewBox="0 0 16 12" className="shrink-0">
      <line
        x1={1} y1={6} x2={15} y2={6}
        stroke={color}
        strokeWidth={width}
        strokeLinecap={dashed ? "butt" : "round"}
        strokeDasharray={dashed ? "3 2" : undefined}
      />
    </svg>
  );
}

/** 범례 한 줄 */
function LegendRow({ swatch, label }: { swatch: ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap">
      {swatch}
      <span>{label}</span>
    </div>
  );
}

/**
 * 지도 좌하단 범례 — 표시 항목은 현재 표출 상태에 맞춰 가감한다.
 * (결과 없이도 유효한 사이트·건물 항목은 항상, 표적·반사체는 결과가 있을 때만)
 */
function DualLegend({ hasResult, hasDup, hasUnknown, hasModeS, hasEvent, showBuildings, showSurfaces, isolated }: {
  hasResult: boolean;
  /** 주소중복(다른 항공기) 이벤트 보유 — 유령점이 slate 로도 찍힌다 */
  hasDup: boolean;
  /** 미확인(반사 기하 불성립) 이벤트 보유 — 유령점이 amber 로도 찍힌다 */
  hasUnknown: boolean;
  hasModeS: boolean;
  hasEvent: boolean;
  showBuildings: boolean;
  /** 반사면(장애물) 선 표출 중 — 줌 ≥ REFLECT_SURFACE_MIN_ZOOM 이면 줌 변화에 따라 즉시 가감 */
  showSurfaces: boolean;
  /** 지도 표적 클릭으로 이벤트 하나만 표출 중 */
  isolated: boolean;
}) {
  // 좁은 화면에서 지도를 가리지 않도록 접을 수 있다 (기본 펼침)
  const [open, setOpen] = useState(true);
  return (
    <div
      className="absolute bottom-3 left-3 z-[700] rounded-lg border border-gray-200 bg-white/95 px-2.5 py-2 text-[10.5px] text-gray-700 shadow-sm"
      style={{ pointerEvents: "auto" }}
    >
      <div className="flex items-center gap-2">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-gray-400">범례</span>
        <button
          onClick={() => setOpen((v) => !v)}
          title={open ? "접기" : "펼치기"}
          className="ml-auto rounded p-0.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-[#a60739]"
        >
          {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        </button>
      </div>
      {open && (
        <div className="mt-1.5 space-y-[3px]">
          {hasResult && (
            <>
              <LegendRow swatch={<LegendDot fill="rgb(59,130,246)" />} label="실표적" />
              <LegendRow swatch={<LegendDot fill="rgb(233,69,96)" r={5} />} label="유령표적(반사)" />
              {hasDup && (
                <LegendRow swatch={<LegendDot fill="rgb(100,116,139)" r={5} />} label="주소중복 유령(다른 항공기)" />
              )}
              {hasUnknown && (
                <LegendRow swatch={<LegendDot fill="rgb(245,158,11)" r={5} />} label="미확인 유령(기하 불성립)" />
              )}
              <LegendRow swatch={<LegendLine color="rgb(59,130,246)" width={1.5} />} label="실표적–(반사점)–레이더 경로" />
              <LegendRow
                swatch={<LegendLine color="rgb(233,69,96)" width={1.5} dashed />}
                label="유령표적–레이더 (점선)"
              />
              <LegendRow
                swatch={
                  <svg width={16} height={12} viewBox="0 0 16 12" className="shrink-0">
                    <circle cx={8} cy={6} r={5.5} fill={ACCENT} stroke="#ffffff" strokeWidth={1.5} />
                    <text
                      x={8} y={6} textAnchor="middle" dominantBaseline="central"
                      fill="#ffffff" fontSize={7} fontWeight={700}
                    >n</text>
                  </svg>
                }
                label="예상 반사 위치"
              />
              <div className="pl-[22px] text-[9px] leading-tight text-gray-400">
                숫자 = 이벤트 건수, 줌아웃 시 인접 위치 병합
              </div>
              {showSurfaces && (
                <LegendRow swatch={<LegendLine color={ACCENT} width={4} />} label="반사면(장애물) — 이등분선 수직" />
              )}
            </>
          )}
          <LegendRow
            swatch={<img src="/radar-icon.png" alt="" style={{ height: 13, width: "auto" }} className="shrink-0" />}
            label="레이더 사이트"
          />
          <LegendRow swatch={<LegendDot fill={ACCENT} stroke="#ffffff" r={4} />} label="분석 기준 레이더 (위치점)" />
          {hasModeS && (
            <LegendRow swatch={<LegendLine color="rgb(132,204,22)" width={2} />} label="항적(선택 기체)" />
          )}
          {hasEvent && (
            <>
              <LegendRow swatch={<LegendLine color={ACCENT} width={2.5} />} label="반사 경로(레이더→반사면→실표적)" />
              <LegendRow swatch={<LegendLine color={ERROR} width={1.5} />} label="유령 방위선" />
            </>
          )}
          {showBuildings && (
            <LegendRow
              swatch={
                <svg width={16} height={12} viewBox="0 0 16 12" className="shrink-0">
                  <rect
                    x={2} y={2} width={12} height={8}
                    fill="rgba(148,163,184,.42)" stroke="rgba(100,116,139,.65)" strokeWidth={1}
                  />
                </svg>
              }
              label="건물(2D)"
            />
          )}
          {isolated && (
            <div className="pl-[22px] text-[9px] leading-tight text-gray-400">
              선택 이벤트만 표출 중 · 표적 재클릭으로 해제
            </div>
          )}
        </div>
      )}
    </div>
  );
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
  /** 항적 조회 순번 — 빠르게 기체를 바꿀 때 늦게 도착한 응답 폐기 */
  const trackSeqRef = useRef(0);
  /** 항적 도착 시 1회 지도 맞춤 예약 (그룹 헤더 클릭 경로에서만 세운다) */
  const fitOnTrackRef = useRef(false);
  /** 항적 조회 effect 가 최신 그룹·사이트를 읽기 위한 미러 (deps 에 넣으면 불필요한 재조회) */
  const groupsRef = useRef<ModeSGroup[]>([]);
  const sitesRef = useRef<{ name: string; latitude: number; longitude: number }[]>([]);

  const [phase, setPhase] = useState<Phase>("idle");
  const [fileCount, setFileCount] = useState(0);
  const [flightCount, setFlightCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ title: string; message: string } | null>(null);

  // 분석 파라미터
  const [scanWindowS, setScanWindowS] = useState(0.5);
  const [minSepKm, setMinSepKm] = useState(1.0);
  /** 제외 Mode-S 원문 입력 — 분석 실행 시 parseModeSList 로 정규화 */
  const [excludeText, setExcludeText] = useState(DEFAULT_EXCLUDE_MODE_S);

  // 선택/표시 상태
  const [search, setSearch] = useState("");
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);
  /** 지도 표적 클릭으로 고른 이벤트 id — 그 이벤트 하나만 지도에 표출(단일 표출).
   *  반사체·그룹 헤더·목록 행 경로는 세우지 않는다. */
  const [isolatedEventId, setIsolatedEventId] = useState<number | null>(null);
  /** 반사 위치 선택 필터 — 병합 마커를 고르면 그 마커의 반사 위치 전부가 들어온다
   *  (오름차순 정렬된 id 배열, null = 필터 없음) */
  const [selectedClusterIds, setSelectedClusterIds] = useState<number[] | null>(null);
  /** 분류 필터 — 필터 체인 최상단(반사/주소중복/미확인). 요약 칩으로 전환 */
  /** 분류 탭 — 기본 "반사"(사용자 결정: 전체 탭 없음, 도구의 목적이 반사 유령 확인) */
  const [kindFilter, setKindFilter] = useState<DualTargetKind>("reflection");
  /** 지도 표출을 특정 기체(Mode-S)로 한정 — 좌측 그룹 목록은 계속 전 기체를 보여준다.
   *  좌측 카드의 **펼침 상태도 여기서 파생**한다(선택=펼침, 해제=접힘 — 별도 펼침 state 없음). */
  const [selectedModeS, setSelectedModeS] = useState<string | null>(null);
  /** 선택 기체(Mode-S)의 전체 항적 — 워커 typed array (메인에 TrackPoint 객체 미생성) */
  const [modeSTrack, setModeSTrack] = useState<ModeSTrack | null>(null);

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
  sitesRef.current = dualSites;

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
      const result = await analyzeDualTargets({
        sites: dualSites, scanWindowS, minSepKm, excludeModeS: parseModeSList(excludeText),
      });
      if (seq !== dualRunSeq) return; // 최신 요청만 반영
      setDualResult(result);
      setSelectedEventId(null);
      setSelectedClusterIds(null);
      setSelectedModeS(null); // 분석 직후엔 선택 없음 = 좌측 카드 전부 접힘(펼침은 선택에서 파생)
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
  }, [dualSites, scanWindowS, minSepKm, excludeText, setDualResult, fitBounds]);

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
    setSelectedClusterIds(null);
    setSelectedModeS(null);
    setModeSTrack(null); // 이전 자료의 항적 오버레이 즉시 해제 (선택 해제와 별개로 명시)
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

  /** 선택 반사 위치 id 집합 — 필터·강조 판정을 O(1) 로 (병합 마커는 여러 id 를 한꺼번에 잡는다) */
  const selectedClusterSet = useMemo(
    () => (selectedClusterIds ? new Set(selectedClusterIds) : null),
    [selectedClusterIds],
  );

  /** 분류 필터 적용 이벤트 — 필터 체인 최상단(반사/주소중복/미확인) */
  const kindEvents = useMemo(() => {
    const all = dualResult?.events ?? [];
    return all.filter((e) => e.kind === kindFilter);
  }, [dualResult, kindFilter]);

  /** 좌측 그룹 목록 모집단 — 분류 필터 뒤 반사 위치 필터 적용 */
  const listEvents = useMemo(() => {
    if (selectedClusterSet == null) return kindEvents;
    return kindEvents.filter((e) => e.cluster_id != null && selectedClusterSet.has(e.cluster_id));
  }, [kindEvents, selectedClusterSet]);

  /** 지도 표출 이벤트 — 반사 위치 ∩ Mode-S */
  const baseEvents = useMemo(() => {
    if (selectedModeS == null) return listEvents;
    return listEvents.filter((e) => e.mode_s === selectedModeS);
  }, [listEvents, selectedModeS]);

  /** 단일 표출 이벤트 — 지도 표적 클릭 선택이 유효한 동안만(다른 경로로 선택·Mode-S 가 바뀌면 자동 해제) */
  const isolatedEv = useMemo<DualTargetEvent | undefined>(() => {
    if (isolatedEventId == null || isolatedEventId !== selectedEventId || !dualResult) return undefined;
    // 워커가 id = 정렬 인덱스로 부여하므로 dense 배열 O(1) 조회 (id 불일치 시 안전하게 무시)
    const ev = dualResult.events[isolatedEventId];
    if (!ev || ev.id !== isolatedEventId) return undefined;
    if (selectedModeS !== ev.mode_s) return undefined; // 그룹 헤더 토글 등으로 Mode-S 한정이 풀리면 단일 표출도 해제
    if (ev.kind !== kindFilter) return undefined; // 분류 필터 밖이면 단일 표출도 해제
    return ev;
  }, [isolatedEventId, selectedEventId, selectedModeS, kindFilter, dualResult]);

  /** 지도 표출 이벤트 — 단일 표출 중이면 그 하나, 아니면 baseEvents */
  const mapEvents = useMemo<DualTargetEvent[]>(() => (isolatedEv ? [isolatedEv] : baseEvents), [isolatedEv, baseEvents]);

  /**
   * 표출용 반사 위치 클러스터 — count 내림차순.
   * 분류 필터·Mode-S 선택이 걸리면 그 부분집합이 참조하는 클러스터만 남기고 count 도 같은
   * 기준으로 재계산한다(원본 클러스터 객체는 mutate 금지 — 복제본 생성). 반사 위치 선택
   * 필터는 여기에 적용하지 않는다(다른 클러스터로 갈아탈 수 있어야 하므로).
   */
  const displayClusters = useMemo<ReflectorCluster[]>(() => {
    const all = dualResult?.clusters ?? [];
    const counts = new Map<number, number>();
    for (const e of kindEvents) {
      if (selectedModeS != null && e.mode_s !== selectedModeS) continue;
      if (e.cluster_id == null) continue;
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
  }, [dualResult, kindEvents, selectedModeS]);

  /** 지도 반사체 원천 — 단일 표출 중이면 그 이벤트의 클러스터 하나(count 1), 좌측 리스트는 displayClusters 그대로 */
  const mapClusters = useMemo<ReflectorCluster[]>(() => {
    if (!isolatedEv) return displayClusters;
    if (isolatedEv.cluster_id == null) return [];
    const c =
      displayClusters.find((x) => x.id === isolatedEv.cluster_id) ??
      dualResult?.clusters.find((x) => x.id === isolatedEv.cluster_id);
    return c ? [{ ...c, count: 1 }] : [];
  }, [isolatedEv, displayClusters, dualResult]);

  /**
   * 지도 표출용 줌 적응 병합 반사체 — greedy 반경 병합(supercluster 방식).
   * 화면 픽셀 좌표(Web Mercator)에서 count 내림차순 시드를 잡고, CLUSTER_MERGE_RADIUS_PX
   * 안의 미배정 반사 위치를 전부 흡수한다. 격자 비닝과 달리 셀 경계에서 마커가 겹치지 않고
   * 병합 위치가 데이터(시드)에서 유도되어 안정적이다. 줌인하면 자연히 풀린다.
   * 좌측 "예상 반사 위치" 리스트는 병합 없이 displayClusters 를 그대로 쓴다(지도는 mapClusters).
   * 복잡도 O(n·이웃) — n 은 반사 클러스터 수(수백 이하)라 부담 없음.
   */
  const zoomClusters = useMemo<ZoomCluster[]>(() => {
    const scale = 512 * Math.pow(2, mapZoom);

    // 1) 화면 픽셀 좌표 투영
    const items: ReflectorCluster[] = [];
    const px: number[] = [];
    const py: number[] = [];
    for (const c of mapClusters) {
      const [x, y] = projMerc(c.longitude, c.latitude, scale);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      items.push(c);
      px.push(x);
      py.push(y);
    }

    // 2) 이웃 탐색용 격자 인덱스 (셀 크기 = 병합 반경 → 3×3 이웃이면 반경 전부 포함)
    const grid = new Map<string, number[]>();
    const cellOf = (v: number) => Math.floor(v / CLUSTER_MERGE_RADIUS_PX);
    for (let i = 0; i < items.length; i++) {
      const key = `${cellOf(px[i])}_${cellOf(py[i])}`;
      const cell = grid.get(key);
      if (cell) cell.push(i);
      else grid.set(key, [i]);
    }

    // 3) count 내림차순(mapClusters 정렬 그대로) greedy 병합
    const taken = new Uint8Array(items.length);
    const r2 = CLUSTER_MERGE_RADIUS_PX * CLUSTER_MERGE_RADIUS_PX;
    const out: ZoomCluster[] = [];
    for (let i = 0; i < items.length; i++) {
      if (taken[i]) continue;
      taken[i] = 1;
      const seed = items[i];
      const members: ReflectorCluster[] = [seed];
      let w = seed.count > 0 ? seed.count : 1; // centroid 가중치(건수)
      let latAcc = seed.latitude * w;
      let lonAcc = seed.longitude * w;
      let wSum = w;
      let count = seed.count;
      const cx = cellOf(px[i]);
      const cy = cellOf(py[i]);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const cell = grid.get(`${gx}_${gy}`);
          if (!cell) continue;
          for (const j of cell) {
            if (taken[j]) continue;
            const dx = px[j] - px[i];
            const dy = py[j] - py[i];
            if (dx * dx + dy * dy > r2) continue;
            taken[j] = 1;
            const m = items[j];
            w = m.count > 0 ? m.count : 1;
            latAcc += m.latitude * w;
            lonAcc += m.longitude * w;
            wSum += w;
            count += m.count;
            members.push(m);
          }
        }
      }
      out.push({
        key: `zc-${seed.id}`, // 시드 id 기반 안정 키
        latitude: latAcc / wSum,
        longitude: lonAcc / wSum,
        count,
        members,
      });
    }
    out.sort((a, b) => b.count - a.count);
    return out;
  }, [mapClusters, mapZoom]);

  /**
   * 유령표적 → 레이더 방사선의 **점선 세그먼트**(deck.gl 바이너리 속성).
   * PathStyleExtension(@deck.gl/extensions)은 미설치이고 의존성 추가가 금지돼 있어,
   * 화면 픽셀(Web Mercator) 공간에서 선을 직접 잘라 점선을 흉내 낸다. 픽셀 기준이라
   * 줌이 변해도 점선 간격이 시각적으로 일정하며, 그 대가로 mapZoom 변경 시 재계산한다.
   * 세그먼트 총량은 MAX_GHOST_DASH_SEGMENTS(20만) 로 제한 — 고줌에서는 선 하나가 수만 px
   * 이라 고정 주기(10px)를 그대로 쓰면 세그먼트가 폭증한다. 넘치면 주기를 늘려(듀티 60/40
   * 유지) 흡수한다. 반환은 평탄 interleaved lon/lat 두 배열(전수 — 표본 추출 없음).
   */
  const ghostDashSegments = useMemo<{ length: number; source: Float64Array; target: Float64Array } | null>(() => {
    if (mapEvents.length === 0 || dualSites.length === 0) return null;
    const siteMap = new Map<string, { name: string; latitude: number; longitude: number }>();
    for (const s of dualSites) siteMap.set(s.name, s);
    const scale = 512 * Math.pow(2, mapZoom);

    // 1) 픽셀 선분 수집 — 사이트를 못 찾은 이벤트는 방사선을 그릴 수 없어 제외
    const gx: number[] = [];
    const gy: number[] = [];
    const dirX: number[] = [];
    const dirY: number[] = [];
    const lens: number[] = [];
    let totalLenPx = 0;
    for (const e of mapEvents) {
      const site = siteMap.get(e.radar_name);
      if (!site) continue;
      const [ax, ay] = projMerc(e.ghost.longitude, e.ghost.latitude, scale);
      const [bx, by] = projMerc(site.longitude, site.latitude, scale);
      if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) continue;
      const len = Math.hypot(bx - ax, by - ay);
      if (!(len > 0)) continue;
      gx.push(ax);
      gy.push(ay);
      dirX.push((bx - ax) / len); // 단위 방향(유령표적 → 레이더)
      dirY.push((by - ay) / len);
      lens.push(len);
      totalLenPx += len;
    }
    if (lens.length === 0) return null;

    // 2) 적응 주기 — 기본 10px 주기로 상한을 넘으면 주기를 늘리고 듀티(60%)는 유지
    let period = DASH_ON_PX + DASH_GAP_PX;
    let onPx = DASH_ON_PX;
    if (totalLenPx / period > MAX_GHOST_DASH_SEGMENTS) {
      period = totalLenPx / MAX_GHOST_DASH_SEGMENTS;
      onPx = period * 0.6;
    }

    // 3) 1차 패스 — 세그먼트 수를 세어 배열을 선할당(성장 배열 재할당 회피)
    const counts: number[] = [];
    let segCount = 0;
    for (let i = 0; i < lens.length; i++) {
      const n = Math.ceil(lens[i] / period);
      counts.push(n);
      segCount += n;
    }
    if (segCount === 0) return null;

    // 4) 2차 패스 — 유령표적 끝에서 시작해 주기 단위로 잘라 채운다
    //    (첫 dash 가 유령표적에 붙어야 점선이 그 점에서 뻗어 나가는 것으로 읽힌다)
    const source = new Float64Array(segCount * 2);
    const target = new Float64Array(segCount * 2);
    let w = 0;
    for (let i = 0; i < lens.length; i++) {
      const len = lens[i];
      const n = counts[i];
      for (let k = 0; k < n; k++) {
        const t0 = k * period;
        const t1 = Math.min(t0 + onPx, len);
        const [aLon, aLat] = unprojMerc(gx[i] + dirX[i] * t0, gy[i] + dirY[i] * t0, scale);
        const [bLon, bLat] = unprojMerc(gx[i] + dirX[i] * t1, gy[i] + dirY[i] * t1, scale);
        source[w] = aLon;
        source[w + 1] = aLat;
        target[w] = bLon;
        target[w + 1] = bLat;
        w += 2;
      }
    }
    return { length: segCount, source, target };
  }, [mapEvents, dualSites, mapZoom]);

  /** 반사면 선분(고줌 전용) — mapEvents 중 **실반사** 반사점 보유분 전수. 줌 미달이면 빈 배열(레이어 생략). */
  const reflectSurfaces = useMemo<{ path: [number, number][] }[]>(() => {
    if (mapZoom < REFLECT_SURFACE_MIN_ZOOM || mapEvents.length === 0) return [];
    const siteMap = new Map<string, { name: string; latitude: number; longitude: number }>();
    for (const s of dualSites) siteMap.set(s.name, s);
    const out: { path: [number, number][] }[] = [];
    for (const e of mapEvents) {
      const r = mapReflector(e);
      if (!r) continue;
      const site = siteMap.get(e.radar_name);
      if (!site) continue;
      const seg = reflectSurfaceSegment(r, e.real, site, REFLECT_SURFACE_HALF_M);
      if (seg) out.push({ path: seg });
    }
    return out;
  }, [mapEvents, dualSites, mapZoom]);

  /**
   * 반사 위치 선택 — 지도 마커·좌측 리스트 공용. 지도 이동은 하지 않는다(줌인 금지).
   * 병합 마커를 누르면 그 마커에 묶인 반사 위치 **전부**가 한 번에 선택된다.
   * Mode-S 한정을 함께 해제한다: 반사체를 고르면 그 반사체에 속한 **모든 기체**의 이벤트가
   * 나와야 하므로, Mode-S 필터와 교집합이 되어 목록이 비는 것을 막는다.
   */
  const selectCluster = useCallback((ids: number[]) => {
    setSelectedEventId(null);
    setSelectedModeS(null);
    const next = [...ids].sort((a, b) => a - b);
    // 같은 선택을 다시 누르면 해제 (길이·원소 모두 일치)
    const same =
      selectedClusterIds != null &&
      selectedClusterIds.length === next.length &&
      selectedClusterIds.every((v, i) => v === next[i]);
    if (same) {
      setSelectedClusterIds(null);
      return;
    }
    setSelectedClusterIds(next);
    // 지도에서 병합 마커를 고른 경우 좌측 리스트가 첫 선택 멤버 행으로 오도록 스크롤
    const first = next[0];
    if (first == null) return;
    requestAnimationFrame(() => {
      document.getElementById(`dual-cl-${first}`)?.scrollIntoView({ block: "nearest" });
    });
  }, [selectedClusterIds]);

  /**
   * 실표적·유령표적 클릭 공용 — 그 항공기(Mode-S) 전체로 지도·목록을 한정한다.
   * 같은 이벤트 재클릭은 이벤트 선택만 해제(Mode-S 한정은 유지).
   * 사용자가 보고 있는 화면을 유지해야 하므로 지도 이동(fitBounds/easeTo)은 하지 않는다.
   */
  const selectEventFromMap = useCallback((ev: DualTargetEvent) => {
    if (selectedEventId === ev.id) {
      setSelectedEventId(null);
      setIsolatedEventId(null); // 단일 표출 해제
      return;
    }
    // 지도 클릭 = 해당 기체로 명시 이동 — 검색 필터가 선택 그룹을 가리지 않게 해제
    setSearch("");
    setSelectedClusterIds(null);
    setSelectedModeS(ev.mode_s);
    setSelectedEventId(ev.id); // Mode-S 선택 = 그 그룹 카드 펼침(파생)
    setIsolatedEventId(ev.id); // 지도 표적 클릭 경로에서만 단일 표출
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
      let reflectionCount = 0;
      let highCount = 0;
      let maxSepKm = 0;
      let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
      for (const ev of events) {
        if (ev.kind === "reflection") reflectionCount++;
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
        reflectionCount,
        highCount,
        maxSepKm,
        bbox: { minLat, maxLat, minLon, maxLon },
      });
    }
    out.sort((a, b) => (b.events.length - a.events.length) || a.modeS.localeCompare(b.modeS));
    return out;
  }, [listEvents, aircraft]);
  groupsRef.current = groups;

  // ── 선택 기체(Mode-S) 전체 항적 오버레이 ──────────────────────────
  //   워커가 positions/startIndices 를 typed array 로 transfer 하므로 메인 스레드에는
  //   TrackPoint 객체가 만들어지지 않는다(10M+ 규모 스트리밍 원칙).
  //   요청 순번(trackSeqRef) + 파싱 epoch(dualRunSeq)로 늦게 도착한 응답을 폐기한다.
  //   groups·dualSites 는 ref 미러로 읽어 deps 를 selectedModeS 로만 좁힌다(불필요한 재조회 방지).
  useEffect(() => {
    if (selectedModeS == null) {
      // 해제 시에도 순번을 올려 직전 조회의 늦은 응답이 오버레이로 되살아나지 않게 한다
      ++trackSeqRef.current;
      setModeSTrack(null);
      fitOnTrackRef.current = false;
      return;
    }
    const seq = ++trackSeqRef.current;
    const run = dualRunSeq;
    const modeS = selectedModeS;
    queryModeSTrack(modeS)
      .then((track) => {
        if (seq !== trackSeqRef.current || run !== dualRunSeq) return; // 재선택·재파싱 → 폐기
        setModeSTrack(track);
        if (!fitOnTrackRef.current) return; // 지도 이동 없는 경로(지도 클릭·이벤트 행)
        fitOnTrackRef.current = false;

        // 항적 ∪ 그 기체 이벤트 ∪ 관련 레이더 좌표로 1회 맞춤
        let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
        const acc = (lat: number, lon: number) => {
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
        };
        if (track.bbox) {
          acc(track.bbox.minLat, track.bbox.minLon);
          acc(track.bbox.maxLat, track.bbox.maxLon);
        }
        const g = groupsRef.current.find((x) => x.modeS === modeS || x.modeS.toUpperCase() === modeS);
        if (g) {
          acc(g.bbox.minLat, g.bbox.minLon);
          acc(g.bbox.maxLat, g.bbox.maxLon);
          const names = new Set<string>();
          for (const ev of g.events) names.add(ev.radar_name);
          for (const s of sitesRef.current) {
            if (names.has(s.name)) acc(s.latitude, s.longitude);
          }
        }
        if (minLat <= maxLat && minLon <= maxLon) fitBounds([[minLon, minLat], [maxLon, maxLat]]);
      })
      .catch((err) => {
        if (seq !== trackSeqRef.current || run !== dualRunSeq) return;
        console.warn("[DualTarget] 항적 조회 실패:", err);
        setModeSTrack(null);
      });
  }, [selectedModeS, fitBounds]);

  /** 검색 필터 (Mode-S·기체명 부분일치) — 목록 표시만 좁힌다(지도는 mapEvents 전수) */
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

  /**
   * 그룹 헤더 클릭 = 지도 표출을 이 기체로 한정(선택 토글).
   * 카드 펼침은 선택에서 파생하므로 선택되면 자동으로 펼쳐지고, 재클릭(해제)이면 접힌다.
   * 지도 맞춤은 **항적이 도착한 뒤 1회** 수행한다(항적 ∪ 이벤트 ∪ 레이더 bbox) —
   * 레이더 ↔ 반사체 ↔ 항적 기하가 한 화면에 들어와야 반사 경로가 읽히기 때문.
   * (지도 클릭·이벤트 행 경로는 fitOnTrackRef 를 세우지 않으므로 지도가 움직이지 않는다.)
   */
  const selectGroup = useCallback((g: ModeSGroup) => {
    if (selectedModeS === g.modeS) {
      setSelectedModeS(null);
      return;
    }
    setSelectedModeS(g.modeS);
    setSelectedEventId(null);
    fitOnTrackRef.current = true; // 항적 조회 effect 가 도착 시 1회 fitBounds
  }, [selectedModeS]);

  /**
   * 전파 반사 애니메이션 입력 — 선택 이벤트에 반사점·레이더 좌표가 모두 있을 때만 생성.
   * 데이터 배열을 여기서 만들어 참조를 고정한다(프레임마다 새 배열이면 deck.gl 이 매번 재업로드).
   */
  const reflectionAnim = useMemo<ReflectionAnim | null>(() => {
    if (selectedEventId == null || !dualResult) return null;
    const ev = dualResult.events.find((e) => e.id === selectedEventId);
    if (!ev) return null;
    const refl = mapReflector(ev); // 실반사만 애니메이션 — 기하 불성립 이벤트는 전파 경로가 없다
    if (!refl) return null;
    const site = dualSites.find((s) => s.name === ev.radar_name);
    if (!site) return null;
    return {
      tripData: [{
        path: [
          [ev.real.longitude, ev.real.latitude],
          [refl.longitude, refl.latitude],
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
  //   그리기 순서(뒤 → 앞): 건물 → 사이트 → 방사선(실·유령→레이더) → 반사면 → 실표적 →
  //   유령표적 → 반사 위치 → 개수 → 선택 강조.
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
      new IconLayer<{ name: string; latitude: number; longitude: number }>({
        id: "dual-sites",
        data: dualSites,
        getPosition: (d) => [d.longitude, d.latitude],
        getIcon: () => ({ url: "/radar-icon.png", width: 570, height: 620, anchorY: 620 }),
        // 분석 기준 레이더는 크게·불투명, 나머지는 작게·반투명 (mask:false 라 getColor 는 알파만 적용)
        getSize: (d) => (d.name === analysisRadarName ? 40 : 30),
        sizeUnits: "pixels" as const,
        getColor: (d) => (d.name === analysisRadarName ? [255, 255, 255, 255] : [255, 255, 255, 150]),
        billboard: true,
        pickable: true,
        onClick: (info: { object?: { name: string } }) => {
          const d = info.object;
          if (!d) return;
          handleRadarChange(d.name);
        },
        updateTriggers: { getSize: analysisRadarName, getColor: analysisRadarName },
      }),
      // 정확한 레이더 좌표점 — 방사선이 모이는 지점(아이콘은 이 점을 밑변으로 세워진다).
      // 분석 기준 레이더만 액센트색으로 구분.
      new ScatterplotLayer<{ name: string; latitude: number; longitude: number }>({
        id: "dual-site-anchors",
        data: dualSites,
        getPosition: (d) => [d.longitude, d.latitude],
        filled: true,
        stroked: true,
        getFillColor: (d) => (d.name === analysisRadarName ? [166, 7, 57, 255] : [55, 65, 81, 220]),
        getLineColor: [255, 255, 255, 255],
        lineWidthMinPixels: 1.5,
        radiusUnits: "pixels" as const,
        getRadius: 4,
        pickable: false,
        updateTriggers: { getFillColor: analysisRadarName },
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
        getPixelOffset: [0, 12], // 좌표점(반경 4px) 아래로 라벨을 내린다
        outlineWidth: 3,
        outlineColor: [255, 255, 255, 220],
        fontSettings: { sdf: true },
        billboard: true,
        pickable: false,
      }),
    );

    // ── 선택 기체(Mode-S) 전체 항적 (워커 typed array 바이너리 속성) ──
    //   방사선·표적보다 **아래**에 둔다. pickable:false 라 픽 버퍼에 그려지지 않으므로
    //   실표적 점 위에 항적 점이 겹쳐도 클릭은 항상 표적으로 간다.
    if (modeSTrack && modeSTrack.pointCount > 0) {
      layers.push(
        new PathLayer({
          id: "dual-modes-track",
          data: {
            length: modeSTrack.flightCount,
            startIndices: modeSTrack.startIndices,
            attributes: { getPath: { value: modeSTrack.positions, size: 2 } },
          },
          getColor: [132, 204, 22, 210],
          getWidth: 1.5,
          widthUnits: "pixels" as const,
          widthMinPixels: 1.5,
          jointRounded: true,
          capRounded: true,
          pickable: false,
        }),
        new ScatterplotLayer({
          id: "dual-modes-track-pts",
          data: {
            length: modeSTrack.pointCount,
            attributes: { getPosition: { value: modeSTrack.positions, size: 2 } },
          },
          getFillColor: [132, 204, 22, 170],
          radiusUnits: "pixels" as const,
          getRadius: 1.5,
          radiusMinPixels: 1.5,
          radiusMaxPixels: 1.5,
          pickable: false,
        }),
      );
    }

    // ── 방사선: 실표적→(반사점)→레이더(실선) · 유령표적→레이더(점선) ──
    //   실선은 실제 전파 경로를 그린다 — **실반사**면 실표적→반사점→레이더 두 마디(꺾인 선),
    //   그 외(주소중복·초과경로 없음·반사점 원거리)는 반사가 아니므로 레이더까지 직선.
    //   유령 점선은 레이더 기점 유령 방위선이라 두 선이 벌어진 각이 곧 반사로 생긴 방위 오차다.
    //   사이트 좌표를 찾을 수 없는 이벤트(미등록 레이더명)는 그릴 수 없으므로 제외한다.
    const siteByName = new Map<string, { name: string; latitude: number; longitude: number }>();
    for (const s of dualSites) siteByName.set(s.name, s);
    const radialEvents = mapEvents.filter((e) => siteByName.has(e.radar_name));

    if (radialEvents.length > 0) {
      layers.push(
        new PathLayer<DualTargetEvent>({
          id: "dual-real-radials",
          data: radialEvents,
          getPath: (d): [number, number][] => {
            const site = siteByName.get(d.radar_name)!; // radialEvents 는 사이트 보유분만
            const path: [number, number][] = [[d.real.longitude, d.real.latitude]];
            const refl = mapReflector(d);
            if (refl) path.push([refl.longitude, refl.latitude]);
            path.push([site.longitude, site.latitude]);
            return path;
          },
          getColor: [59, 130, 246, 150],
          getWidth: 1,
          widthUnits: "pixels" as const,
          widthMinPixels: 1,
          jointRounded: true,
          pickable: false,
          // 접근자가 dualSites 를 캡처한다 — deck.gl 은 id 기준으로 접근자를 캐시하므로 명시
          updateTriggers: { getPath: dualSites },
        })
      );
    }
    // 점선은 픽셀 공간에서 미리 잘라 둔 세그먼트를 바이너리 속성으로 한 번에 올린다
    if (ghostDashSegments && ghostDashSegments.length > 0) {
      layers.push(
        new LineLayer({
          id: "dual-ghost-radials",
          data: {
            length: ghostDashSegments.length,
            attributes: {
              getSourcePosition: { value: ghostDashSegments.source, size: 2 },
              getTargetPosition: { value: ghostDashSegments.target, size: 2 },
            },
          },
          getColor: [233, 69, 96, 170],
          getWidth: 1,
          widthUnits: "pixels" as const,
          widthMinPixels: 1,
          pickable: false,
        })
      );
    }

    // ── 반사면(장애물) — 이등분선에 수직인 선분, 줌 ≥ REFLECT_SURFACE_MIN_ZOOM 에서만 ──
    if (reflectSurfaces.length > 0) {
      layers.push(
        new PathLayer<{ path: [number, number][] }>({
          id: "dual-reflect-surfaces",
          data: reflectSurfaces,
          getPath: (d) => d.path,
          getColor: [166, 7, 57, 235],
          getWidth: 4,
          widthUnits: "pixels" as const,
          widthMinPixels: 4,
          capRounded: true,
          pickable: false,
        })
      );
    }

    if (dualResult) layers.push(
      new ScatterplotLayer<DualTargetEvent>({
        id: "dual-real-pts",
        data: mapEvents,
        getPosition: (d) => [d.real.longitude, d.real.latitude],
        getFillColor: [59, 130, 246, 200],
        getRadius: 60,
        // 클릭 표적 확대 — 좁은 화면에서도 실표적을 정확히 집을 수 있게 한다
        radiusMinPixels: 4,
        radiusMaxPixels: 7,
        pickable: true,
        onClick: (info: { object?: DualTargetEvent }) => {
          if (info.object) selectEventFromMap(info.object);
        },
      }),
      new ScatterplotLayer<DualTargetEvent>({
        id: "dual-ghost-pts",
        data: mapEvents,
        getPosition: (d) => [d.ghost.longitude, d.ghost.latitude],
        // 분류별 색 구분 — 반사=빨강, 주소중복(다른 항공기·물체)=slate, 미확인(기하 불성립)=amber.
        // data 참조가 바뀌면 재계산된다
        getFillColor: (d): [number, number, number, number] =>
          d.kind === "reflection" ? [233, 69, 96, 220]
            : d.kind === "dup_address" ? [100, 116, 139, 200]
              : [245, 158, 11, 210],
        getRadius: 90,
        // 클릭 표적 확대 — 유령표적은 실표적보다 한 단계 크게(실표적과 구분)
        radiusMinPixels: 5,
        radiusMaxPixels: 9,
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
        // 병합 마커든 개별 마커든 동일 경로 — 소속 반사 위치 전부를 선택(지도 이동 없음)
        onClick: (info: { object?: ZoomCluster }) => {
          const d = info.object;
          if (!d) return;
          selectCluster(d.members.map((m) => m.id));
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

    // ── Mode-S 선택(이벤트 미선택) 시 반사 기하 분포: 실표적 → 반사점 정적 기하선 ──
    //   개별 이벤트를 고르지 않아도 이 기체의 반사가 어디로 모이는지 한눈에 드러난다.
    if (selectedModeS != null && selectedEventId == null) {
      const withReflector = mapEvents.filter((e) => mapReflector(e) != null);
      if (withReflector.length > 0) {
        layers.push(
          new LineLayer<DualTargetEvent>({
            id: "dual-reflect-geometry",
            data: withReflector,
            getSourcePosition: (d) => [d.real.longitude, d.real.latitude],
            getTargetPosition: (d) => {
              const r = mapReflector(d)!; // withReflector 는 실반사 반사점 보유분만
              return [r.longitude, r.latitude];
            },
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
      const selRefl = ev ? mapReflector(ev) : null; // 실반사만 반사 경로 강조
      if (ev && site) {
        if (selRefl) {
          layers.push(
            new PathLayer<{ path: [number, number][] }>({
              id: "dual-selected-path",
              data: [{
                path: [
                  [site.longitude, site.latitude],
                  [selRefl.longitude, selRefl.latitude],
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
    //   병합 상태든 줌인으로 풀린 상태든, 선택 멤버를 품은 **모든 마커**에 링을 그린다
    //   (data 참조가 바뀌므로 updateTriggers 불필요).
    if (selectedClusterSet != null) {
      const rings = zoomClusters.filter((z) => z.members.some((m) => selectedClusterSet.has(m.id)));
      if (rings.length > 0) {
        layers.push(
          new ScatterplotLayer<ZoomCluster>({
            id: "dual-selected-cluster-ring",
            data: rings,
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
    dualResult, mapEvents, zoomClusters, ghostDashSegments, dualSites, buildingPolys, modeSTrack,
    reflectSurfaces,
    selectedEventId, selectedClusterSet, selectedModeS, analysisRadarName,
    handleRadarChange, openBuildingDrawer, selectEventFromMap, selectCluster,
  ]);

  // ── 렌더 ──────────────────────────────────────────────────────────

  const stats = dualResult?.stats;
  /** 레이더별 스캔주기 표기 — 미추정이면 고정 윈도우 폴백임을 밝힌다 (레이더 수 개 수준) */
  const scanPeriodText = (() => {
    const map = stats?.scan_period_by_radar;
    if (!map) return "";
    const parts: string[] = [];
    for (const [rn, t] of Object.entries(map)) {
      parts.push(`스캔주기 ${rn}: ${t != null ? `${t.toFixed(2)}s` : "미추정 → 고정 윈도우"}`);
    }
    return parts.join(" · ");
  })();
  /** 이 그룹(기체)의 항적 오버레이 — 다른 기체가 선택됐거나 미로드면 null.
   *  워커가 Mode-S 를 대문자로 정규화해 돌려주므로 대문자 기준으로 비교한다. */
  const trackOfGroup = (modeS: string) =>
    modeSTrack && modeSTrack.modeS === modeS.toUpperCase() ? modeSTrack : null;
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
          <span
            className="text-[11px] font-medium text-gray-600"
            title="스캔주기 T 를 추정하면 잔존 중복은 한 회전 폭(0.75T) 안에서 짝짓고, 이 값은 T 미추정 폴백과 파서 보존분의 실표적 짝 매칭 허용 시간으로 쓰입니다"
          >
            동일스캔 윈도우
          </span>
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
        <label className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-gray-600">제외 Mode-S</span>
          <input
            type="text" value={excludeText}
            onChange={(e) => setExcludeText(e.target.value)}
            title="시험표적(site monitor) 등 분석에서 제외할 Mode-S — 콤마 구분"
            className="h-6 w-36 rounded-md border border-gray-200 bg-white px-1.5 font-mono text-[11px] text-gray-700 focus:border-[#a60739] focus:outline-none"
          />
        </label>
        <span className="text-[10.5px] text-gray-400">
          동일 Mode-S 가 같은 안테나 회전 안에서 두 위치로 탐지되면 후보로 잡고, 고도 일치·거리 순서로 반사/주소중복을 분류합니다.
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
                  {scanPeriodText && (
                    <div className="mt-0.5 text-[10px] text-gray-400">{scanPeriodText}</div>
                  )}
                  {stats && (stats.skipped_excluded_flights > 0 || stats.skipped_excluded_ghosts > 0) && (
                    <div className="mt-0.5 text-[10px] text-gray-400">
                      제외 Mode-S 비행 {stats.skipped_excluded_flights.toLocaleString()}편·파서보존 {stats.skipped_excluded_ghosts.toLocaleString()}점
                    </div>
                  )}
                </div>

                {/* 분류 필터 칩 — 반사/주소중복/미확인. 전환 시 이벤트·반사 위치 선택은 해제(필터 밖으로 갈 수 있음) */}
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  {KIND_CHIPS.map((c) => {
                    const on = kindFilter === c.k;
                    const n = c.k === "reflection" ? (stats?.events_reflection ?? 0)
                      : c.k === "dup_address" ? (stats?.events_dup_address ?? 0)
                      : (stats?.events_unknown ?? 0);
                    return (
                      <button
                        key={c.k}
                        onClick={() => {
                          setKindFilter(c.k);
                          setSelectedEventId(null);      // 필터 밖으로 갈 수 있는 이벤트 선택 해제
                          setSelectedClusterIds(null);   // 반사 위치 선택도 해제(빈 목록 혼동 방지) — Mode-S 선택은 유지
                        }}
                        title={c.title}
                        className={`rounded-full px-2 py-[2px] text-[10px] font-semibold transition-colors ${
                          on ? "bg-[#a60739] text-white" : "border border-gray-200 text-gray-500 hover:bg-gray-50"
                        }`}
                      >
                        {c.label} <span className="font-mono tabular-nums">{n.toLocaleString()}</span>
                      </button>
                    );
                  })}
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
                      const sel = selectedClusterSet?.has(c.id) ?? false;
                      return (
                        <div
                          key={c.id}
                          id={`dual-cl-${c.id}`}
                          onClick={() => {
                            const map = mapRef.current?.getMap();
                            if (map) map.easeTo({ center: [c.longitude, c.latitude], zoom: 14, duration: 600 });
                            // Mode-S 한정도 함께 해제 — 이 반사체에 속한 모든 기체의 항목을 보여준다
                            selectCluster([c.id]);
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
                    {selectedClusterIds != null ? (
                      <button
                        onClick={() => setSelectedClusterIds(null)}
                        title="선택한 반사 위치 한정을 해제합니다"
                        className="shrink-0 text-[10px] text-[#a60739] hover:underline"
                      >
                        반사 위치 필터 해제 ({selectedClusterIds.length.toLocaleString()}개소 · {listEvents.length.toLocaleString()}건)
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
                      // 펼침은 선택에서 파생 — 선택=펼침, 해제=접힘 (별도 펼침 state 없음)
                      const open = selectedModeS === g.modeS;
                      // 이 기체의 항적 오버레이(선택 시에만 로드됨) — 헤더 툴팁 표기용
                      const tr = open ? trackOfGroup(g.modeS) : null;
                      const headTitle =
                        `${g.label} · 반사 ${g.reflectionCount.toLocaleString()}건 · high ${g.highCount.toLocaleString()}건 · 최대 이격 ${g.maxSepKm.toFixed(2)}km`
                        + (tr && tr.pointCount > 0
                          ? ` · 항적 ${tr.pointCount.toLocaleString()}점/${tr.flightCount.toLocaleString()}편`
                          : "");
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
                          className={`mb-1 rounded-md border ${open ? "border-l-[3px] border-[#a60739] bg-[#a60739]/[0.03]" : "border-gray-200"}`}
                        >
                          {/* 그룹 헤더 한 줄 — 클릭 = 지도 표출 한정(선택) 토글 = 펼침/접힘.
                              셰브런은 상태 표시용(클릭 핸들러 없음), 상세 수치는 라벨 툴팁으로 뺀다. */}
                          <div
                            onClick={() => selectGroup(g)}
                            title={open ? "클릭하면 지도 표출 한정을 해제합니다" : "클릭하면 이 기체만 지도에 표출합니다"}
                            className={`flex cursor-pointer items-center gap-1.5 px-2 py-1.5 transition-colors ${
                              open ? "rounded-t-md bg-[#a60739]/10" : "rounded-md hover:bg-gray-50"
                            }`}
                          >
                            <span className="shrink-0 text-gray-400">
                              {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                            </span>
                            <span
                              className={`min-w-0 flex-1 truncate text-[11.5px] font-semibold ${open ? "text-[#a60739]" : "text-gray-800"}`}
                              title={headTitle}
                            >
                              {g.label}
                            </span>
                            <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-gray-400">
                              반사 {g.reflectionCount.toLocaleString()}·{g.maxSepKm.toFixed(1)}km
                            </span>
                            <span className="shrink-0 font-mono text-[10px] font-bold tabular-nums" style={{ color: ERROR }}>
                              {g.events.length.toLocaleString()}건
                            </span>
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
                                        setSelectedClusterIds(null);
                                        // 고정 행은 선택 해제 토글을 생략 — 해제하면 이 행 자체가 상한 밖으로
                                        // 사라져 커서 아래에서 행이 없어진다(지도 이동만 수행).
                                        // pinned ⇒ sel 불변식(고정 행은 선택 이벤트 자신뿐)이라 pinned 만 보면 된다.
                                        if (!pinned) setSelectedEventId(sel ? null : e.id);
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
                                        <span
                                          className={`shrink-0 rounded px-1 text-[9px] font-bold ${KIND_BADGE_CLASS[e.kind]}`}
                                          title={kindReasonText(e)}
                                        >
                                          {KIND_LABEL[e.kind]}
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

          {/* ── 좌하단 범례 (건축물정보 드로어 z-[760] 보다 낮게) ── */}
          <DualLegend
            hasResult={dualResult != null}
            hasDup={(stats?.events_dup_address ?? 0) > 0}
            hasUnknown={(stats?.events_unknown ?? 0) > 0}
            hasModeS={selectedModeS != null}
            hasEvent={selectedEventId != null}
            showBuildings={mapZoom >= BUILDING_MIN_ZOOM}
            showSurfaces={mapZoom >= REFLECT_SURFACE_MIN_ZOOM && dualResult != null}
            isolated={isolatedEv != null}
          />

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
