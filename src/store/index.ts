import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useToastStore } from "../components/common/Toast";
import type {
  Aircraft,
  BuildingGroup,
  Flight,
  LoSProfileData,
  ManualBuilding,
  PageId,
  PanoramaPoint, BuildingObstacle,
  ParseStatistics,
  PlanImageBounds,
  RadarSite,
  ReportMetadata,
  SavedReportSummary,
  UploadedFile,
} from "../types";
import type { MultiCoverageResult } from "../utils/radarCoverage";
import { manualMergeFlightsAsync, clearWorkerPoints } from "../utils/flightConsolidationWorker";

/** 설정을 DB에 비동기 저장 (fire-and-forget) */
function persistSetting(key: string, value: unknown) {
  invoke("save_setting", { key, value: JSON.stringify(value) }).catch((e) =>
    console.warn(`[Settings] ${key} 저장 실패:`, e)
  );
}

interface AppState {
  // 비행검사기 관리
  aircraft: Aircraft[];
  addAircraft: (a: Aircraft) => void;
  updateAircraft: (id: string, a: Partial<Aircraft>) => void;
  removeAircraft: (id: string) => void;

  // 업로드 파일
  uploadedFiles: UploadedFile[];
  addUploadedFile: (f: UploadedFile) => void;
  updateUploadedFile: (path: string, update: Partial<UploadedFile>) => void;
  removeUploadedFile: (path: string) => void;
  removeUploadedFiles: (paths: string[]) => void;
  clearUploadedFiles: () => void;

  // Worker 포인트 요약 (실제 데이터는 Worker 소유)
  workerPointCount: number;
  setWorkerPointCount: (n: number) => void;
  workerPointSummary: { modeS: string; count: number; minTs: number; maxTs: number }[] | null;
  setWorkerPointSummary: (s: { modeS: string; count: number; minTs: number; maxTs: number }[] | null) => void;

  // 파싱 통계 (FileUpload 표시용)
  parseStatsList: { filename: string; stats: ParseStatistics; totalRecords: number }[];
  addParseStats: (filename: string, stats: ParseStatistics, totalRecords: number) => void;
  clearParseStats: () => void;

  // 비행 (핵심 분석 단위)
  flights: Flight[];
  setFlights: (flights: Flight[]) => void;
  /** 비행 점진 추가 (Worker 스트리밍용) */
  appendFlights: (newFlights: Flight[]) => void;
  /** consolidating 완료 후 최종 정렬 */
  finalizeFlights: () => void;
  clearFlights: () => void;
  /** 통합 진행 중 플래그 — true일 때 비싼 useEffect/useMemo 계산 스킵 */
  consolidating: boolean;
  setConsolidating: (v: boolean) => void;
  /** 통합 진행률 (Worker에서 수신, 복원 시 loading 단계 포함) */
  consolidationProgress: { stage: "loading" | "history" | "grouping" | "building" | "done"; current: number; total: number; flightsBuilt: number } | null;
  setConsolidationProgress: (p: { stage: "loading" | "history" | "grouping" | "building" | "done"; current: number; total: number; flightsBuilt: number } | null) => void;
  /** 선택된 비행들을 하나로 수동 병합 */
  mergeFlights: (ids: string[]) => void;

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

  // LoS 분석
  losResults: LoSProfileData[];
  addLoSResult: (r: LoSProfileData) => void;
  removeLoSResult: (id: string) => void;
  clearLoSResults: () => void;

  // 파노라마 (전파 장애물) 뷰
  panoramaViewActive: boolean;
  setPanoramaViewActive: (v: boolean) => void;
  panoramaActivePoint: PanoramaPoint | BuildingObstacle | null;
  setPanoramaActivePoint: (pt: PanoramaPoint | BuildingObstacle | null) => void;
  panoramaPinned: boolean;
  setPanoramaPinned: (v: boolean) => void;
  // 파노라마 맵 오버레이 (장애물 경계 폴리곤)
  panoramaOverlayData: PanoramaPoint[] | null;
  setPanoramaOverlayData: (data: PanoramaPoint[] | null) => void;
  panoramaOverlayVisible: boolean;
  setPanoramaOverlayVisible: (v: boolean) => void;

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
  coverageError: string;
  setCoverageError: (msg: string) => void;


  // 보고서 메타데이터
  reportMetadata: ReportMetadata;
  setReportMetadata: (meta: Partial<ReportMetadata>) => void;

  // 저장된 보고서
  savedReports: SavedReportSummary[];
  setSavedReports: (reports: SavedReportSummary[]) => void;
  addSavedReport: (report: SavedReportSummary) => void;
  removeSavedReport: (id: string) => void;

  // 건물 그룹 + 수동 건물
  buildingGroups: BuildingGroup[];
  manualBuildings: ManualBuilding[];
  loadBuildingGroups: () => Promise<void>;
  loadManualBuildings: () => Promise<void>;
  activePlanOverlays: Map<number, { imageDataUrl: string; bounds: PlanImageBounds; opacity: number; rotation: number }>;
  setActivePlanOverlay: (groupId: number, data: { imageDataUrl: string; bounds: PlanImageBounds; opacity: number; rotation?: number } | null) => void;
  updatePlanOverlayProps: (groupId: number, props: { opacity?: number; rotation?: number }) => void;
  // UI
  activePage: PageId;
  setActivePage: (page: PageId) => void;
  loading: boolean;
  setLoading: (loading: boolean) => void;
  loadingMessage: string;
  setLoadingMessage: (msg: string) => void;

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
  addAircraft: (a) =>
    set((state) => {
      if (state.aircraft.length >= 10) return state;
      invoke("save_aircraft", { aircraft: a }).catch((e) => {
        console.warn("[Aircraft] DB 저장 실패:", e);
        useToastStore.getState().addToast("비행검사기 저장에 실패했습니다");
      });
      return { aircraft: [...state.aircraft, a] };
    }),
  updateAircraft: (id, updates) =>
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
    }),
  removeAircraft: (id) => {
    const prev = get().aircraft;
    set((state) => ({
      aircraft: state.aircraft.filter((a) => a.id !== id),
    }));
    invoke("delete_aircraft", { id }).catch((e) => {
      console.warn("[Aircraft] DB 삭제 실패:", e);
      useToastStore.getState().addToast("비행검사기 삭제에 실패했습니다");
      set({ aircraft: prev }); // 롤백
    });
  },

  // 업로드 파일
  uploadedFiles: [],
  addUploadedFile: (f) =>
    set((state) => ({ uploadedFiles: [...state.uploadedFiles, f] })),
  updateUploadedFile: (path, update) =>
    set((state) => ({
      uploadedFiles: state.uploadedFiles.map((f) =>
        f.path === path ? { ...f, ...update } : f
      ),
    })),
  removeUploadedFile: (path) => {
    const file = get().uploadedFiles.find((f) => f.path === path);
    set((s) => ({
      uploadedFiles: s.uploadedFiles.filter((f) => f.path !== path),
      parseStatsList: s.parseStatsList.filter((ps) => ps.filename !== file?.name),
    }));
  },
  removeUploadedFiles: (paths) => {
    const pathSet = new Set(paths);
    set((s) => ({
      uploadedFiles: s.uploadedFiles.filter((f) => !pathSet.has(f.path)),
      parseStatsList: s.parseStatsList.filter((ps) => {
        const file = s.uploadedFiles.find((f) => f.name === ps.filename);
        return !file || !pathSet.has(file.path);
      }),
    }));
  },
  clearUploadedFiles: () => {
    invoke("clear_manual_merges").catch(() => {});
    clearWorkerPoints().catch(() => {}); // Worker 포인트 버퍼도 해제
    set({
      uploadedFiles: [],
      workerPointCount: 0,
      workerPointSummary: null,
      parseStatsList: [],
      flights: [],
      selectedModeS: "__ALL__",
      selectedFlightId: null,
      coverageData: null,
      coverageVisible: false,
      coverageCacheAvailable: false,
      losResults: [],
    });
  },

  // Worker 포인트 요약
  workerPointCount: 0,
  setWorkerPointCount: (n) => set({ workerPointCount: n }),
  workerPointSummary: null,
  setWorkerPointSummary: (s) => set({ workerPointSummary: s }),

  // 파싱 통계
  parseStatsList: [],
  addParseStats: (filename, stats, totalRecords) =>
    set((state) => ({
      parseStatsList: [...state.parseStatsList, { filename, stats, totalRecords }],
    })),
  clearParseStats: () => set({ parseStatsList: [] }),

  // 비행
  flights: [],
  setFlights: (flights) => set({ flights }),
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
  clearFlights: () => set({ flights: [] }),
  consolidating: false,
  setConsolidating: (v) => set({ consolidating: v }),
  consolidationProgress: null,
  setConsolidationProgress: (p) => set({ consolidationProgress: p }),
  mergeFlights: (ids) => {
    const state = get();
    if (ids.length < 2) return;
    const selected = state.flights.filter((f) => ids.includes(f.id));
    if (selected.length < 2) return;
    const modeS = selected[0].mode_s.toUpperCase();
    if (!selected.every((f) => f.mode_s.toUpperCase() === modeS)) return;
    manualMergeFlightsAsync(selected, state.radarSite).then((merged) => {
      // set((s) => ...) 패턴으로 최신 상태를 원자적으로 읽고 업데이트
      set((s) => {
        const remaining = s.flights.filter((f) => !ids.includes(f.id));
        const flights = [...remaining, merged].sort((a, b) => a.start_time - b.start_time);
        return { flights };
      });
      invoke("save_manual_merge", {
        sourceFlightIdsJson: JSON.stringify(ids),
        modeS,
      }).catch((e) => {
        console.warn("[Merge] DB 저장 실패:", e);
        useToastStore.getState().addToast("비행 병합 저장에 실패했습니다");
      });
    });
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

  // LoS 분석 (DB 영속화)
  losResults: [],
  addLoSResult: (r) => {
    set((state) => ({ losResults: [...state.losResults, r] }));
    invoke("save_los_result", {
      id: r.id,
      radarSiteName: r.radarSiteName,
      radarLat: r.radarLat,
      radarLon: r.radarLon,
      radarHeight: r.radarHeight,
      targetLat: r.targetLat,
      targetLon: r.targetLon,
      bearing: r.bearing,
      totalDistance: r.totalDistance,
      elevationProfileJson: JSON.stringify(r.elevationProfile),
      losBlocked: r.losBlocked,
      maxBlockingJson: r.maxBlockingPoint ? JSON.stringify(r.maxBlockingPoint) : null,
      mapScreenshot: r.mapScreenshot ?? null,
      chartScreenshot: r.chartScreenshot ?? null,
    }).catch((e) => console.warn("[LoS] DB 저장 실패:", e));
  },
  removeLoSResult: (id) => {
    const prev = get().losResults;
    set((state) => ({
      losResults: state.losResults.filter((r) => r.id !== id),
    }));
    invoke("delete_los_result", { id }).catch((e) => {
      console.warn("[LoS] DB 삭제 실패:", e);
      useToastStore.getState().addToast("LoS 결과 삭제에 실패했습니다");
      set({ losResults: prev }); // 롤백
    });
  },
  clearLoSResults: () => {
    const prev = get().losResults;
    set({ losResults: [] });
    invoke("clear_los_results").catch((e) => {
      console.warn("[LoS] DB 초기화 실패:", e);
      useToastStore.getState().addToast("LoS 결과 초기화에 실패했습니다");
      set({ losResults: prev }); // 롤백
    });
  },

  // 파노라마 (전파 장애물) 뷰
  panoramaViewActive: false,
  setPanoramaViewActive: (v) => set({ panoramaViewActive: v }),
  panoramaActivePoint: null,
  setPanoramaActivePoint: (pt) => set({ panoramaActivePoint: pt }),
  panoramaPinned: false,
  setPanoramaPinned: (v) => set({ panoramaPinned: v }),
  panoramaOverlayData: null,
  setPanoramaOverlayData: (data) => set({ panoramaOverlayData: data }),
  panoramaOverlayVisible: false,
  setPanoramaOverlayVisible: (v) => set({ panoramaOverlayVisible: v }),

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
      invoke<string | null>("load_coverage_cache", { radarName }).then((json) => {
        // 로드 완료 시 현재 레이더가 변경되었으면 무시 (stale closure 방지)
        if (get().radarSite.name !== radarName) {
          console.log(`[Coverage] 레이더 변경됨 (${radarName} → ${get().radarSite.name}), 캐시 무시`);
          return;
        }
        if (json) {
          try {
            const data = JSON.parse(json);
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
  coverageError: "",
  setCoverageError: (msg) => set({ coverageError: msg }),


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

  // 저장된 보고서
  savedReports: [],
  setSavedReports: (reports) => set({ savedReports: reports }),
  addSavedReport: (report) =>
    set((state) => ({ savedReports: [report, ...state.savedReports] })),
  removeSavedReport: (id) => {
    const prev = get().savedReports;
    set((state) => ({ savedReports: state.savedReports.filter((r) => r.id !== id) }));
    invoke("delete_saved_report", { id }).catch((e) => {
      console.warn("[Report] DB 삭제 실패:", e);
      useToastStore.getState().addToast("보고서 삭제에 실패했습니다");
      set({ savedReports: prev }); // 롤백
    });
  },

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
  activePlanOverlays: new Map(),
  setActivePlanOverlay: (groupId, data) =>
    set((state) => {
      const next = new Map(state.activePlanOverlays);
      if (data) {
        next.set(groupId, { ...data, rotation: data.rotation ?? 0 });
      } else {
        next.delete(groupId);
      }
      return { activePlanOverlays: next };
    }),
  updatePlanOverlayProps: (groupId, props) =>
    set((state) => {
      const existing = state.activePlanOverlays.get(groupId);
      if (!existing) return state;
      const next = new Map(state.activePlanOverlays);
      const updated = {
        ...existing,
        opacity: props.opacity ?? existing.opacity,
        rotation: props.rotation ?? existing.rotation,
      };
      next.set(groupId, updated);
      // DB 영속화 (fire-and-forget)
      invoke("update_plan_overlay_props", {
        groupId,
        opacity: props.opacity ?? null,
        rotation: props.rotation ?? null,
      }).catch(() => {});
      return { activePlanOverlays: next };
    }),
  // UI
  activePage: "upload",
  setActivePage: (page) => set({ activePage: page }),
  loading: false,
  setLoading: (loading) => set({ loading }),
  loadingMessage: "",
  setLoadingMessage: (msg) => set({ loadingMessage: msg }),

  // 개발자 모드
  devMode: false,
  setDevMode: (v) => {
    set({ devMode: v });
    persistSetting("dev_mode", v);
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
      const { listen } = await import("@tauri-apps/api/event");
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
      const { listen } = await import("@tauri-apps/api/event");
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
      const { listen } = await import("@tauri-apps/api/event");
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
      const { listen } = await import("@tauri-apps/api/event");
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
      const { listen } = await import("@tauri-apps/api/event");
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
