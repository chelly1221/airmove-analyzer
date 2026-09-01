import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { useToastStore } from "../components/common/Toast";
import type {
  Aircraft,
  BuildingGroup,
  BuildingModalDraft,
  Flight,
  ManualBuilding,
  PageId,
  PanoramaPoint, BuildingObstacle,
  PlanImageBounds,
  RadarSite,
  ReportMetadata,
  TowerCrane,
} from "../types";
import type { MultiCoverageResult } from "../utils/radarCoverage";
import { readBulkJson, cleanupBulk } from "../utils/bulkIpc";
import type { BulkRef } from "../utils/bulkIpc";
import type { WeatherVector } from "../types/track";
import type { AsterixStats } from "../types/asterix";
import type { DualTargetResult } from "../types/dualTarget";

/** 설정을 DB에 비동기 저장 (fire-and-forget) */
function persistSetting(key: string, value: unknown) {
  invoke("save_setting", { key, value: JSON.stringify(value) }).catch((e) =>
    console.warn(`[Settings] ${key} 저장 실패:`, e)
  );
}

/** 비행검사기 목록 변경을 다른 창(지도·도면)에 전파 (fire-and-forget).
 *  세터 3종(add/update/removeAircraft)이 DB 영속 choke-point 이므로 발신 지점도 여기로 모은다.
 *  수신 창은 setter 가 아닌 setState 로만 반영 — 재영속·에코 루프 방지.
 *  (앱 시작 복원 경로는 setState 직접이라 세터 미경유 = 발신 없음 — 의도) */
function emitAircraftChanged(get: () => { aircraft: Aircraft[] }) {
  emit("aircraft-changed", { list: get().aircraft }).catch(() => {});
}

/** CAT008 기상 강도(1~6) 기본 색상 (NWS 스타일 강수 램프). 인덱스 0 미사용. */
export const DEFAULT_WEATHER_COLORS: [number, number, number][] = [
  [0, 0, 0],
  [40, 180, 99],   // 1 약
  [30, 132, 73],   // 2
  [241, 196, 15],  // 3 중
  [230, 126, 34],  // 4
  [231, 76, 60],   // 5 강
  [155, 30, 150],  // 6 매우 강
];

interface AppState {
  // 비행검사기 관리
  aircraft: Aircraft[];
  addAircraft: (a: Aircraft) => void;
  updateAircraft: (id: string, a: Partial<Aircraft>) => void;
  removeAircraft: (id: string) => void;

  // Worker 포인트 요약 (실제 데이터는 Worker 소유)
  workerPointCount: number;
  workerPointSummary: { modeS: string; count: number; minTs: number; maxTs: number }[] | null;

  // 비행 (핵심 분석 단위)
  flights: Flight[];
  /** 비행 점진 추가 (Worker 스트리밍용) */
  appendFlights: (newFlights: Flight[]) => void;
  /** consolidating 완료 후 최종 정렬 */
  finalizeFlights: () => void;
  /** 통합 진행 중 플래그 — true일 때 비싼 useEffect/useMemo 계산 스킵 */
  consolidating: boolean;
  setConsolidating: (v: boolean) => void;
  /** 통합 진행률 (Worker에서 수신, 복원 시 loading 단계 포함) */
  consolidationProgress: { stage: "loading" | "history" | "grouping" | "building" | "done"; current: number; total: number; flightsBuilt: number } | null;
  setConsolidationProgress: (p: { stage: "loading" | "history" | "grouping" | "building" | "done"; current: number; total: number; flightsBuilt: number } | null) => void;

  // CAT008 기상 (극좌표 강수 에코) — 트랙맵 오버레이
  /** 전체 기상 벡터 (시간순 정렬, ~0.5M로 메인 보관) */
  weatherVectors: WeatherVector[];
  setWeatherVectors: (v: WeatherVector[]) => void;
  clearWeatherVectors: () => void;
  /** 기상 레이어 표시 토글 */
  weatherVisible: boolean;
  setWeatherVisible: (v: boolean) => void;
  /** 거리 bin당 NM (SOP f 미전송 → 사용자 조정. 기본 0.5 = ASR/f6) */
  weatherNmPerBin: number;
  setWeatherNmPerBin: (v: number) => void;
  /** 기상 레이어 투명도 (0~1) */
  weatherOpacity: number;
  setWeatherOpacity: (v: number) => void;
  /** 강도(1~6)별 색상 [r,g,b] (인덱스 0 미사용, 범례 클릭으로 사용자 지정) */
  weatherColors: [number, number, number][];
  setWeatherColor: (level: number, rgb: [number, number, number]) => void;
  resetWeatherColors: () => void;

  // BRA(Building Restricted Area) 분석
  /** BRA 원추면 기준각 (°, 기본 0.25 = LoS 단면도 BRA 기준선과 동일) */
  braAngleDeg: number;
  setBraAngleDeg: (v: number) => void;

  // 레이더 사이트
  radarSite: RadarSite;
  setRadarSite: (site: RadarSite) => void;
  customRadarSites: RadarSite[];
  setCustomRadarSites: (sites: RadarSite[]) => void;
  addCustomRadarSite: (site: RadarSite) => void;
  updateCustomRadarSite: (name: string, site: RadarSite) => void;
  removeCustomRadarSite: (name: string) => void;

  // 필터
  selectedModeS: string | null;
  setSelectedModeS: (modeS: string | null) => void;
  selectedFlightId: string | null;
  setSelectedFlightId: (id: string | null) => void;

  // 파노라마 (전파 장애물) 뷰
  panoramaViewActive: boolean;
  setPanoramaViewActive: (v: boolean) => void;
  panoramaActivePoint: PanoramaPoint | BuildingObstacle | null;
  setPanoramaActivePoint: (pt: PanoramaPoint | BuildingObstacle | null) => void;
  panoramaPinned: boolean;
  setPanoramaPinned: (v: boolean) => void;

  // 레이더 커버리지 (다중 고도 레이어)
  coverageData: MultiCoverageResult | null;
  setCoverageData: (data: MultiCoverageResult | null) => void;
  coverageVisible: boolean;
  setCoverageVisible: (v: boolean) => void;
  /** DB에 커버리지 캐시가 존재하는지 (lazy load용) */
  coverageCacheAvailable: boolean;
  coverageLoading: boolean;
  setCoverageLoading: (v: boolean) => void;
  coverageProgress: string;
  setCoverageProgress: (msg: string) => void;
  coverageProgressPct: number;
  setCoverageProgressPct: (pct: number) => void;
  /** 현재 진행 단계 — "srtm" | "buildings" | "bmap" | "done" | "" (Rust coverage-init-progress stage) */
  coverageStage: string;
  setCoverageStage: (stage: string) => void;
  /** 커버리지 계산 취소 시퀀스 — bump 시 진행 중 계산/콜백 무효화 (모달·패널 공용) */
  coverageAbortSeq: number;
  bumpCoverageAbortSeq: () => number;
  coverageError: string;
  setCoverageError: (msg: string) => void;

  // ASTERIX 분석 — 전수 스캔 통계 + 업로드 파일 경로(온디맨드 조회용). 자체 업로드 독립.
  asterixStats: AsterixStats | null;
  asterixFilePaths: string[];
  setAsterixResult: (stats: AsterixStats, paths: string[]) => void;

  // 이중표적(반사 유령표적) 분석 결과 스냅샷 — 세션 한정(DB 미영속).
  //   페이지 이탈 후 복귀 시 결과 유지용. 포인트는 Worker 소유이므로 여기엔 요약 결과만 둔다.
  dualTargetResult: DualTargetResult | null;
  setDualTargetResult: (r: DualTargetResult | null) => void;

  // PSR 단독(TYP=1) 플롯 — TrackMap 표출 전용. 세션 한정(DB 미영속).
  //   객체 배열이 아니라 typed array 로 보관한다(전수 수집이라 수십만 점 규모).
  //   pos = lon,lat 인터리브(count*2), time = 시간순 정렬된 Unix 초(count).
  psrOnlyPlots: { pos: Float32Array; time: Float64Array; count: number } | null;
  setPsrOnlyPlots: (p: { pos: Float32Array; time: Float64Array; count: number }) => void;
  clearPsrOnlyPlots: () => void;
  /** PSR 단독 레이어 표시 토글 */


  // 보고서 메타데이터
  reportMetadata: ReportMetadata;
  setReportMetadata: (meta: Partial<ReportMetadata>) => void;

  // 건물 그룹 + 수동 건물
  buildingGroups: BuildingGroup[];
  manualBuildings: ManualBuilding[];
  loadBuildingGroups: () => Promise<void>;
  loadManualBuildings: () => Promise<void>;

  // 타워크레인 (자료관리 등록) — BRA 침범 검사·3D 표출용 (LoS·파노라마 미반영, 1단계)
  towerCranes: TowerCrane[];
  loadTowerCranes: () => Promise<void>;

  // 건물 수동 등록/수정 모달 (페이지 이동에도 열림/작성 내용 유지)
  buildingModalOpen: boolean;
  buildingModalEditTarget: ManualBuilding | null;
  buildingModalAddGroupId: number | null;
  buildingModalDraft: BuildingModalDraft | null;
  openBuildingModal: (target: ManualBuilding | null, groupId: number | null, draft: BuildingModalDraft) => void;
  closeBuildingModal: () => void;
  setBuildingModalDraft: (
    updater: BuildingModalDraft | null | ((d: BuildingModalDraft | null) => BuildingModalDraft | null),
  ) => void;
  activePlanOverlays: Map<number, { imageDataUrl: string; bounds: PlanImageBounds; opacity: number; rotation: number }>;
  // UI
  activePage: PageId;
  setActivePage: (page: PageId) => void;
  loading: boolean;
  setLoading: (loading: boolean) => void;
  loadingMessage: string;

  // 개발자 모드
  devMode: boolean;
  setDevMode: (v: boolean) => void;

  // 건물통합정보 자동 다운로드 (백그라운드 지속)
  facBuildingDownloading: boolean;
  facBuildingProgress: { stage: string; message: string; current: number; total: number } | null;
  facBuildingResult: { type: "success" | "error"; message: string } | null;
  startFacBuildingDownload: () => Promise<void>;

  // N3P 자동 다운로드 (백그라운드 지속)
  n3pDownloading: boolean;
  n3pProgress: { stage: string; message: string; current: number; total: number } | null;
  n3pResult: { type: "success" | "error"; message: string } | null;
  startN3pDownload: () => Promise<void>;

  // 토지이용계획 타일 다운로드 (백그라운드 지속)
  landuseDownloading: boolean;
  landuseProgress: { stage: string; message: string; current: number; total: number } | null;
  landuseResult: { type: "success" | "error"; message: string } | null;
  startLanduseDownload: () => Promise<void>;

  // SRTM 다운로드 (백그라운드 지속)
  srtmDownloading: boolean;
  srtmProgress: { total: number; downloaded: number; skipped?: number; current_tile?: string; status: string } | null;
  srtmResult: { type: "success" | "error"; message: string } | null;
  startSrtmDownload: () => Promise<void>;

  // 산 데이터 ZIP 임포트 (백그라운드 지속)
  peakImporting: boolean;
  peakImportProgress: { total: number; processed: number; status: string } | null;
  peakImportResult: { type: "success" | "error"; message: string } | null;
  startPeakImport: (zipPath: string) => Promise<void>;

}

export const useAppStore = create<AppState>((set, get) => ({
  // 비행검사기 (프리셋)
  aircraft: [
    {
      id: "preset-1",
      name: "1호기",
      registration: "FL7779",
      model: "Embraer Praetor 600",
      mode_s_code: "71BF79",
      organization: "비행점검센터",
      memo: "",
      active: true,
    },
    {
      id: "preset-2",
      name: "2호기",
      registration: "FL7778",
      model: "Hawker 750",
      mode_s_code: "71BF78",
      organization: "비행점검센터",
      memo: "",
      active: true,
    },
  ],
  addAircraft: (a) => {
    set((state) => {
      if (state.aircraft.length >= 10) return state;
      invoke("save_aircraft", { aircraft: a }).catch((e) => {
        console.warn("[Aircraft] DB 저장 실패:", e);
        useToastStore.getState().addToast("비행검사기 저장에 실패했습니다");
      });
      return { aircraft: [...state.aircraft, a] };
    });
    emitAircraftChanged(get);
  },
  updateAircraft: (id, updates) => {
    set((state) => {
      const updated = state.aircraft.map((a) =>
        a.id === id ? { ...a, ...updates } : a
      );
      const target = updated.find((a) => a.id === id);
      if (target) {
        invoke("save_aircraft", { aircraft: target }).catch((e) => {
          console.warn("[Aircraft] DB 저장 실패:", e);
          useToastStore.getState().addToast("비행검사기 저장에 실패했습니다");
        });
      }
      return { aircraft: updated };
    });
    emitAircraftChanged(get);
  },
  removeAircraft: (id) => {
    const prev = get().aircraft;
    set((state) => ({
      aircraft: state.aircraft.filter((a) => a.id !== id),
    }));
    emitAircraftChanged(get);
    invoke("delete_aircraft", { id }).catch((e) => {
      console.warn("[Aircraft] DB 삭제 실패:", e);
      useToastStore.getState().addToast("비행검사기 삭제에 실패했습니다");
      set({ aircraft: prev }); // 롤백
      emitAircraftChanged(get); // 롤백된 목록 재전파
    });
  },

  // Worker 포인트 요약
  workerPointCount: 0,
  workerPointSummary: null,

  // 비행
  flights: [],
  appendFlights: (newFlights) =>
    set((state) => {
      const flights = state.flights.concat(newFlights);
      // consolidating 중에는 sort 스킵 — 완료 후 finalizeFlight에서 1회 sort
      if (!state.consolidating) {
        flights.sort((a, b) => a.start_time - b.start_time);
      }
      return { flights };
    }),
  /** consolidating 완료 후 최종 정렬 */
  finalizeFlights: () =>
    set((state) => {
      const flights = [...state.flights];
      flights.sort((a, b) => a.start_time - b.start_time);
      return { flights };
    }),
  consolidating: false,
  setConsolidating: (v) => set({ consolidating: v }),
  consolidationProgress: null,
  setConsolidationProgress: (p) => set({ consolidationProgress: p }),
  // CAT008 기상
  weatherVectors: [],
  setWeatherVectors: (v) => set({ weatherVectors: v }),
  clearWeatherVectors: () => set({ weatherVectors: [] }),
  weatherVisible: false,
  setWeatherVisible: (v) => set({ weatherVisible: v }),
  weatherNmPerBin: 0.5,
  setWeatherNmPerBin: (v) => {
    set({ weatherNmPerBin: v });
    persistSetting("weather_nm_per_bin", v);
  },
  weatherOpacity: 0.55,
  setWeatherOpacity: (v) => set({ weatherOpacity: v }),
  weatherColors: DEFAULT_WEATHER_COLORS,
  setWeatherColor: (level, rgb) => {
    // 불변 업데이트 — 새 배열 참조여야 useMemo/updateTriggers가 반응
    const next = get().weatherColors.slice() as [number, number, number][];
    next[level] = rgb;
    set({ weatherColors: next });
    persistSetting("weather_colors", next);
  },
  resetWeatherColors: () => {
    set({ weatherColors: DEFAULT_WEATHER_COLORS });
    persistSetting("weather_colors", DEFAULT_WEATHER_COLORS);
  },

  // BRA 기준각 — 0.25°(장애물 제한표면 기본). 변경 시 영속화.
  braAngleDeg: 0.25,
  setBraAngleDeg: (v) => {
    set({ braAngleDeg: v });
    persistSetting("bra_angle_deg", v);
  },

  // 레이더 사이트 (기본: 김포 #1)
  radarSite: {
    name: "김포 #1",
    latitude: 37.5490,
    longitude: 126.7937,
    altitude: 9.11,
    antenna_height: 19.8,
    range_nm: 200,
  },
  setRadarSite: (site) => {
    set({ radarSite: site });
    persistSetting("selected_radar_site", site);
  },
  customRadarSites: [
    {
      name: "김포 #1",
      latitude: 37.5490,
      longitude: 126.7937,
      altitude: 9.11,
      antenna_height: 19.8,
      range_nm: 200,
      active: true,
    },
    {
      name: "김포 #2",
      latitude: 37.5480,
      longitude: 126.7946,
      altitude: 9.12,
      antenna_height: 24,
      range_nm: 200,
      active: true,
    },
  ],
  setCustomRadarSites: (sites) => {
    set({ customRadarSites: sites });
    persistSetting("custom_radar_sites", sites);
  },
  addCustomRadarSite: (site) =>
    set((state) => {
      const updated = [...state.customRadarSites, site];
      persistSetting("custom_radar_sites", updated);
      return { customRadarSites: updated };
    }),
  updateCustomRadarSite: (name, site) =>
    set((state) => {
      const updated = state.customRadarSites.map((s) => s.name === name ? site : s);
      persistSetting("custom_radar_sites", updated);
      return { customRadarSites: updated };
    }),
  removeCustomRadarSite: (name) =>
    set((state) => {
      const updated = state.customRadarSites.filter((s) => s.name !== name);
      persistSetting("custom_radar_sites", updated);
      return { customRadarSites: updated };
    }),

  // 필터
  selectedModeS: "__ALL__",
  setSelectedModeS: (modeS) => set({ selectedModeS: modeS }),
  selectedFlightId: null,
  setSelectedFlightId: (id) => set({ selectedFlightId: id }),

  // 파노라마 (전파 장애물) 뷰
  panoramaViewActive: false,
  setPanoramaViewActive: (v) => set({ panoramaViewActive: v }),
  panoramaActivePoint: null,
  setPanoramaActivePoint: (pt) => set({ panoramaActivePoint: pt }),
  panoramaPinned: false,
  setPanoramaPinned: (v) => set({ panoramaPinned: v }),

  // 레이더 커버리지 (다중 고도 레이어)
  coverageData: null,
  setCoverageData: (data) => {
    set({ coverageData: data });
    if (data) {
      invoke("save_coverage_cache", {
        radarName: data.radarName,
        radarLat: data.radarLat,
        radarLon: data.radarLon,
        radarHeight: data.radarAltitude + data.antennaHeight,
        maxElevDeg: data.maxElevDeg,
        layersJson: JSON.stringify(data),
      }).catch((e) => console.warn("[Coverage] DB 저장 실패:", e));
    }
  },
  coverageVisible: false,
  setCoverageVisible: (v) => {
    set({ coverageVisible: v });
    // lazy load: 커버리지 표시 시 캐시에서 로드 (아직 메모리에 없으면)
    if (v && !get().coverageData && get().coverageCacheAvailable && !get().coverageLoading) {
      set({ coverageLoading: true });
      const radarName = get().radarSite.name;
      // 캐시 JSON(수십 MB)은 bulk:// 파일 매개 수신 (bulkIpc.ts)
      invoke<BulkRef | null>("load_coverage_cache", { radarName }).then(async (ref) => {
        // 로드 완료 시 현재 레이더가 변경되었으면 무시 (stale closure 방지)
        if (get().radarSite.name !== radarName) {
          console.log(`[Coverage] 레이더 변경됨 (${radarName} → ${get().radarSite.name}), 캐시 무시`);
          if (ref) cleanupBulk(ref);
          return;
        }
        if (ref) {
          try {
            const data = await readBulkJson<MultiCoverageResult>(ref);
            // 본문 수신 동안 레이더가 바뀌었을 수 있음 — 재확인
            if (get().radarSite.name !== radarName) return;
            set({ coverageData: data });
            console.log(`[Coverage] 캐시 lazy load 완료 (${radarName})`);
          } catch (e) {
            console.warn("[Coverage] 캐시 파싱 실패:", e);
          }
        }
      }).catch((e) => console.warn("[Coverage] 캐시 로드 실패:", e)).finally(() => {
        set({ coverageLoading: false });
      });
    }
  },
  coverageCacheAvailable: false,
  coverageLoading: false,
  setCoverageLoading: (v) => set({ coverageLoading: v }),
  coverageProgress: "",
  setCoverageProgress: (msg) => set({ coverageProgress: msg }),
  coverageProgressPct: 0,
  setCoverageProgressPct: (pct) => set({ coverageProgressPct: pct }),
  coverageStage: "",
  setCoverageStage: (stage) => set({ coverageStage: stage }),
  coverageAbortSeq: 0,
  bumpCoverageAbortSeq: () => {
    const next = get().coverageAbortSeq + 1;
    set({ coverageAbortSeq: next });
    return next;
  },
  coverageError: "",
  setCoverageError: (msg) => set({ coverageError: msg }),

  asterixStats: null,
  asterixFilePaths: [],
  setAsterixResult: (stats, paths) => set({ asterixStats: stats, asterixFilePaths: paths }),

  // 이중표적 분석 결과 (세션 한정)
  dualTargetResult: null,
  setDualTargetResult: (r) => set({ dualTargetResult: r }),

  // PSR 단독 플롯 (세션 한정)
  psrOnlyPlots: null,
  setPsrOnlyPlots: (p) => set({ psrOnlyPlots: p }),
  clearPsrOnlyPlots: () => set({ psrOnlyPlots: null }),


  // 보고서 메타데이터
  reportMetadata: {
    department: "레이더관제부",
    docPrefix: "RDRPT",
    organization: "김포공항",
    siteName: "레이더송신소",
    footer: "비행검사기 항적 분석 체계 - 자동 생성 보고서",
  },
  setReportMetadata: (meta) =>
    set((state) => {
      const updated = { ...state.reportMetadata, ...meta };
      persistSetting("report_metadata", updated);
      return { reportMetadata: updated };
    }),

  // 건물 그룹 + 수동 건물
  buildingGroups: [],
  manualBuildings: [],
  loadBuildingGroups: async () => {
    try {
      const groups = await invoke<BuildingGroup[]>("list_building_groups");
      set({ buildingGroups: groups });
    } catch (e) {
      console.warn("[BuildingGroups] 로드 실패:", e);
    }
  },
  loadManualBuildings: async () => {
    try {
      const buildings = await invoke<ManualBuilding[]>("list_manual_buildings");
      set({ manualBuildings: buildings });
    } catch (e) {
      console.warn("[ManualBuildings] 로드 실패:", e);
    }
  },

  // 타워크레인 — loadManualBuildings 와 동일 패턴(DB 재조회 후 set 만).
  //   크로스윈도우 'tower-cranes-changed' 수신 시에도 이 액션만 호출한다 (재영속 금지).
  towerCranes: [],
  loadTowerCranes: async () => {
    try {
      const cranes = await invoke<TowerCrane[]>("list_tower_cranes");
      set({ towerCranes: cranes });
    } catch (e) {
      console.warn("[TowerCranes] 로드 실패:", e);
    }
  },

  // 건물 모달 상태 — 자료관리 페이지를 떠났다 돌아와도 유지
  buildingModalOpen: false,
  buildingModalEditTarget: null,
  buildingModalAddGroupId: null,
  buildingModalDraft: null,
  openBuildingModal: (target, groupId, draft) => set({
    buildingModalOpen: true,
    buildingModalEditTarget: target,
    buildingModalAddGroupId: groupId,
    buildingModalDraft: draft,
  }),
  closeBuildingModal: () => set({
    buildingModalOpen: false,
    buildingModalEditTarget: null,
    buildingModalAddGroupId: null,
    buildingModalDraft: null,
  }),
  setBuildingModalDraft: (updater) => set((state) => ({
    buildingModalDraft: typeof updater === "function" ? updater(state.buildingModalDraft) : updater,
  })),
  activePlanOverlays: new Map(),
  // UI
  activePage: "upload",
  setActivePage: (page) => set({ activePage: page }),
  loading: false,
  setLoading: (loading) => set({ loading }),
  loadingMessage: "",

  // 개발자 모드
  devMode: false,
  setDevMode: (v) => {
    set({ devMode: v });
    persistSetting("dev_mode", v);
    // 다른 창(지도·도면) SourceOverlay 즉시 반영 — 수신측은 setState 만(재영속 금지)
    emit("dev-mode-changed", { value: v }).catch(() => {});
  },

  // 건물통합정보 자동 다운로드
  facBuildingDownloading: false,
  facBuildingProgress: null,
  facBuildingResult: null,
  startFacBuildingDownload: async () => {
    if (get().facBuildingDownloading) return;
    set({ facBuildingDownloading: true, facBuildingResult: null, facBuildingProgress: null });

    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listen<{ stage: string; message: string; current: number; total: number }>(
        "fac-building-vworld-progress",
        (e) => set({ facBuildingProgress: e.payload }),
      );
    } catch { /* 리스너 실패 시 진행률 없이 진행 */ }

    try {
      const savedId = await invoke<string | null>("load_setting", { key: "vworld_id" });
      const savedPw = await invoke<string | null>("load_setting", { key: "vworld_pw" });
      if (!savedId || !savedPw) {
        set({
          facBuildingResult: { type: "error", message: "vworld 계정이 설정되지 않았습니다. 설정 페이지에서 계정을 입력해 주세요." },
          facBuildingDownloading: false,
          facBuildingProgress: null,
        });
        unlisten?.();
        return;
      }
      const pw = atob(savedPw);
      const msg = await invoke<string>("vworld_download_fac_buildings", {
        id: savedId,
        pw,
        regionCodes: ["서울", "인천", "경기"],
      });
      set({ facBuildingResult: { type: "success", message: msg } });
    } catch (e) {
      set({ facBuildingResult: { type: "error", message: String(e) } });
    } finally {
      set({ facBuildingDownloading: false, facBuildingProgress: null });
      unlisten?.();
    }
  },

  // N3P 자동 다운로드
  n3pDownloading: false,
  n3pProgress: null,
  n3pResult: null,
  startN3pDownload: async () => {
    if (get().n3pDownloading) return;
    set({ n3pDownloading: true, n3pResult: null, n3pProgress: null });

    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listen<{ stage: string; message: string; current: number; total: number }>(
        "n3p-download-progress",
        (e) => set({ n3pProgress: e.payload }),
      );
    } catch { /* 리스너 실패 시 진행률 없이 진행 */ }

    try {
      const savedId = await invoke<string | null>("load_setting", { key: "vworld_id" });
      const savedPw = await invoke<string | null>("load_setting", { key: "vworld_pw" });
      if (!savedId || !savedPw) {
        set({
          n3pResult: { type: "error", message: "vworld 계정이 설정되지 않았습니다. 설정 페이지에서 계정을 입력해 주세요." },
          n3pDownloading: false,
          n3pProgress: null,
        });
        unlisten?.();
        return;
      }
      const pw = atob(savedPw);
      const msg = await invoke<string>("vworld_download_n3p", { id: savedId, pw });
      set({ n3pResult: { type: "success", message: msg } });
    } catch (e) {
      set({ n3pResult: { type: "error", message: String(e) } });
    } finally {
      set({ n3pDownloading: false, n3pProgress: null });
      unlisten?.();
    }
  },

  // 토지이용계획 타일 다운로드 (로그인 불필요)
  landuseDownloading: false,
  landuseProgress: null,
  landuseResult: null,
  startLanduseDownload: async () => {
    if (get().landuseDownloading) return;
    set({ landuseDownloading: true, landuseResult: null, landuseProgress: null });

    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listen<{ message: string; current: number; total: number }>(
        "landuse-tile-progress",
        (e) => set({ landuseProgress: { stage: "downloading", ...e.payload } }),
      );
    } catch { /* 리스너 실패 시 진행률 없이 진행 */ }

    try {
      const msg = await invoke<string>("download_landuse_tiles", {
        south: 37.0, west: 126.5, north: 37.8, east: 127.3,
        minZoom: 12, maxZoom: 15,
      });
      set({ landuseResult: { type: "success", message: msg } });
    } catch (e) {
      set({ landuseResult: { type: "error", message: String(e) } });
    } finally {
      set({ landuseDownloading: false, landuseProgress: null });
      unlisten?.();
    }
  },

  // SRTM 다운로드
  srtmDownloading: false,
  srtmProgress: null,
  srtmResult: null,
  startSrtmDownload: async () => {
    if (get().srtmDownloading) return;
    set({ srtmDownloading: true, srtmResult: null, srtmProgress: null });

    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listen<{ total: number; downloaded: number; skipped?: number; current_tile?: string; status: string }>(
        "srtm-download-progress",
        (e) => set({ srtmProgress: e.payload }),
      );
    } catch { /* 리스너 실패 시 진행률 없이 진행 */ }

    try {
      const msg = await invoke<string>("download_srtm_korea");
      set({ srtmResult: { type: "success", message: msg } });
    } catch (e) {
      set({ srtmResult: { type: "error", message: String(e) } });
    } finally {
      set({ srtmDownloading: false, srtmProgress: null });
      unlisten?.();
    }
  },

  // 산 데이터 ZIP 임포트
  peakImporting: false,
  peakImportProgress: null,
  peakImportResult: null,
  startPeakImport: async (zipPath: string) => {
    if (get().peakImporting) return;
    set({ peakImporting: true, peakImportResult: null, peakImportProgress: null });

    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listen<{ total: number; processed: number; status: string }>(
        "peak-import-progress",
        (e) => set({ peakImportProgress: e.payload }),
      );
    } catch { /* 리스너 실패 시 진행률 없이 진행 */ }

    try {
      const msg = await invoke<string>("import_peak_data", { zipPath });
      set({ peakImportResult: { type: "success", message: msg } });
    } catch (e) {
      set({ peakImportResult: { type: "error", message: `임포트 실패: ${e}` } });
    } finally {
      set({ peakImporting: false, peakImportProgress: null });
      unlisten?.();
    }
  },

}));
