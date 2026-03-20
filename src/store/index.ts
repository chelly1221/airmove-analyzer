import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
  AdsbTrack,
  Aircraft,
  BuildingGroup,
  CloudGridData,
  Flight,
  FlightRecord,
  LOSProfileData,
  ManualBuilding,
  PageId,
  PanoramaPoint,
  ParseStatistics,
  PlanImageBounds,
  RadarSite,
  ReportMetadata,
  SavedReportSummary,
  TrackPoint,
  UploadedFile,
  WeatherSnapshot,
} from "../types";
import type { MultiCoverageResult } from "../utils/radarCoverage";
import { manualMergeFlights } from "../utils/flightConsolidation";

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

  // 원시 데이터 (파싱 결과 축적)
  rawTrackPoints: TrackPoint[];
  appendRawTrackPoints: (points: TrackPoint[]) => void;
  clearRawTrackPoints: () => void;

  // 파싱 통계 (FileUpload 표시용)
  parseStatsList: { filename: string; stats: ParseStatistics; totalRecords: number }[];
  addParseStats: (filename: string, stats: ParseStatistics, totalRecords: number) => void;
  clearParseStats: () => void;

  // 비행 (핵심 분석 단위)
  flights: Flight[];
  setFlights: (flights: Flight[]) => void;
  clearFlights: () => void;
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

  // LOS 분석
  losResults: LOSProfileData[];
  addLOSResult: (r: LOSProfileData) => void;
  removeLOSResult: (id: string) => void;
  clearLOSResults: () => void;

  // ADS-B
  adsbTracks: AdsbTrack[];
  setAdsbTracks: (tracks: AdsbTrack[]) => void;
  addAdsbTracks: (tracks: AdsbTrack[]) => void;
  clearAdsbTracks: () => void;
  adsbLoading: boolean;
  setAdsbLoading: (v: boolean) => void;
  adsbProgress: string;
  setAdsbProgress: (msg: string) => void;

  // 운항이력
  flightHistory: FlightRecord[];
  setFlightHistory: (records: FlightRecord[]) => void;
  addFlightHistory: (records: FlightRecord[]) => void;
  clearFlightHistory: () => void;
  flightHistoryLoading: boolean;
  setFlightHistoryLoading: (v: boolean) => void;
  flightHistoryProgress: string;
  setFlightHistoryProgress: (msg: string) => void;
  selectedFlight: FlightRecord | null;
  setSelectedFlight: (f: FlightRecord | null) => void;

  // OpenSky 동기화
  openskySync: boolean;
  setOpenskySync: (v: boolean) => void;
  openskySyncProgress: string;
  setOpenskySyncProgress: (msg: string) => void;
  openskySyncVersion: number;
  triggerOpenskySync: () => void;
  openskySyncCancelled: boolean;
  cancelOpenskySync: () => void;

  // 파노라마 (전파 장애물) 뷰
  panoramaViewActive: boolean;
  setPanoramaViewActive: (v: boolean) => void;
  panoramaActivePoint: PanoramaPoint | null;
  setPanoramaActivePoint: (pt: PanoramaPoint | null) => void;
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
  coverageLoading: boolean;
  setCoverageLoading: (v: boolean) => void;
  coverageProgress: string;
  setCoverageProgress: (msg: string) => void;
  coverageProgressPct: number;
  setCoverageProgressPct: (pct: number) => void;
  coverageError: string;
  setCoverageError: (msg: string) => void;

  // 기상 데이터
  weatherData: WeatherSnapshot | null;
  setWeatherData: (data: WeatherSnapshot | null) => void;
  weatherLoading: boolean;
  setWeatherLoading: (v: boolean) => void;

  // 구름 오버레이
  cloudGrid: CloudGridData | null;
  setCloudGrid: (data: CloudGridData | null) => void;
  cloudGridVisible: boolean;
  setCloudGridVisible: (v: boolean) => void;
  cloudGridLoading: boolean;
  setCloudGridLoading: (v: boolean) => void;
  cloudGridProgress: string;
  setCloudGridProgress: (msg: string) => void;

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
  // 토지이용계획도 오버레이
  activePlanOverlays: Map<number, { imageDataUrl: string; bounds: PlanImageBounds; opacity: number }>;
  setActivePlanOverlay: (groupId: number, data: { imageDataUrl: string; bounds: PlanImageBounds; opacity: number } | null) => void;
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
      invoke("save_aircraft", { aircraft: a }).catch((e) =>
        console.warn("[Aircraft] DB 저장 실패:", e)
      );
      return { aircraft: [...state.aircraft, a] };
    }),
  updateAircraft: (id, updates) =>
    set((state) => {
      const updated = state.aircraft.map((a) =>
        a.id === id ? { ...a, ...updates } : a
      );
      const target = updated.find((a) => a.id === id);
      if (target) {
        invoke("save_aircraft", { aircraft: target }).catch((e) =>
          console.warn("[Aircraft] DB 저장 실패:", e)
        );
      }
      return { aircraft: updated };
    }),
  removeAircraft: (id) => {
    invoke("delete_aircraft", { id }).catch((e) =>
      console.warn("[Aircraft] DB 삭제 실패:", e)
    );
    set((state) => ({
      aircraft: state.aircraft.filter((a) => a.id !== id),
    }));
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
    if (file && file.status !== "pending") {
      invoke("delete_parsed_file", { filePath: path }).catch((e) =>
        console.warn("[DB] delete file failed:", e)
      );
    }
    set((s) => ({
      uploadedFiles: s.uploadedFiles.filter((f) => f.path !== path),
      parseStatsList: s.parseStatsList.filter((ps) => ps.filename !== file?.name),
    }));
  },
  removeUploadedFiles: (paths) => {
    const dbPaths = paths.filter((p) => {
      const f = get().uploadedFiles.find((uf) => uf.path === p);
      return f && f.status !== "pending";
    });
    if (dbPaths.length > 0) {
      invoke("delete_parsed_files", { filePaths: dbPaths }).catch((e) =>
        console.warn("[DB] delete files failed:", e)
      );
    }
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
    invoke("clear_saved_data").catch((e) => console.warn("[DB] clear failed:", e));
    invoke("clear_manual_merges").catch(() => {});
    set({
      uploadedFiles: [],
      rawTrackPoints: [],
      parseStatsList: [],
      flights: [],
      selectedModeS: null,
      selectedFlightId: null,
    });
  },

  // 원시 데이터
  rawTrackPoints: [],
  appendRawTrackPoints: (points) =>
    set((state) => {
      const merged = state.rawTrackPoints.concat(points);
      return { rawTrackPoints: merged };
    }),
  clearRawTrackPoints: () => set({ rawTrackPoints: [] }),

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
  clearFlights: () => set({ flights: [] }),
  mergeFlights: (ids) => {
    const state = get();
    if (ids.length < 2) return;
    const selected = state.flights.filter((f) => ids.includes(f.id));
    if (selected.length < 2) return;
    const modeS = selected[0].mode_s.toUpperCase();
    if (!selected.every((f) => f.mode_s.toUpperCase() === modeS)) return;
    manualMergeFlights(selected, state.radarSite).then((merged) => {
      const remaining = get().flights.filter((f) => !ids.includes(f.id));
      const flights = [...remaining, merged].sort((a, b) => a.start_time - b.start_time);
      set({ flights });
      invoke("save_manual_merge", {
        sourceFlightIdsJson: JSON.stringify(ids),
        modeS,
      }).catch((e) => console.warn("[Merge] DB 저장 실패:", e));
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
    },
    {
      name: "김포 #2",
      latitude: 37.5480,
      longitude: 126.7946,
      altitude: 9.12,
      antenna_height: 24,
      range_nm: 200,
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
  selectedModeS: null,
  setSelectedModeS: (modeS) => set({ selectedModeS: modeS }),
  selectedFlightId: null,
  setSelectedFlightId: (id) => set({ selectedFlightId: id }),

  // LOS 분석 (DB 영속화)
  losResults: [],
  addLOSResult: (r) => {
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
    }).catch((e) => console.warn("[LOS] DB 저장 실패:", e));
  },
  removeLOSResult: (id) => {
    set((state) => ({
      losResults: state.losResults.filter((r) => r.id !== id),
    }));
    invoke("delete_los_result", { id }).catch((e) => console.warn("[LOS] DB 삭제 실패:", e));
  },
  clearLOSResults: () => {
    set({ losResults: [] });
    invoke("clear_los_results").catch((e) => console.warn("[LOS] DB 초기화 실패:", e));
  },

  // ADS-B
  adsbTracks: [],
  setAdsbTracks: (tracks) => set({ adsbTracks: tracks }),
  addAdsbTracks: (tracks) =>
    set((state) => ({ adsbTracks: [...state.adsbTracks, ...tracks] })),
  clearAdsbTracks: () => set({ adsbTracks: [] }),
  adsbLoading: false,
  setAdsbLoading: (v) => set({ adsbLoading: v }),
  adsbProgress: "",
  setAdsbProgress: (msg) => set({ adsbProgress: msg }),

  // 운항이력
  flightHistory: [],
  setFlightHistory: (records) => set({ flightHistory: records }),
  addFlightHistory: (records) =>
    set((state) => {
      const existing = new Set(state.flightHistory.map((f) => `${f.icao24}_${f.first_seen}`));
      const newOnes = records.filter((f) => !existing.has(`${f.icao24}_${f.first_seen}`));
      if (newOnes.length === 0) return state;
      return { flightHistory: [...state.flightHistory, ...newOnes] };
    }),
  clearFlightHistory: () => set({ flightHistory: [], selectedFlight: null }),
  flightHistoryLoading: false,
  setFlightHistoryLoading: (v) => set({ flightHistoryLoading: v }),
  flightHistoryProgress: "",
  setFlightHistoryProgress: (msg) => set({ flightHistoryProgress: msg }),
  selectedFlight: null,
  setSelectedFlight: (f) => set({ selectedFlight: f }),

  // OpenSky 동기화
  openskySync: false,
  setOpenskySync: (v) => set({ openskySync: v }),
  openskySyncProgress: "",
  setOpenskySyncProgress: (msg) => set({ openskySyncProgress: msg }),
  openskySyncVersion: 0,
  triggerOpenskySync: () =>
    set((state) => ({ openskySyncVersion: state.openskySyncVersion + 1, openskySyncCancelled: false })),
  openskySyncCancelled: false,
  cancelOpenskySync: () => set({ openskySyncCancelled: true }),

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
  setCoverageVisible: (v) => set({ coverageVisible: v }),
  coverageLoading: false,
  setCoverageLoading: (v) => set({ coverageLoading: v }),
  coverageProgress: "",
  setCoverageProgress: (msg) => set({ coverageProgress: msg }),
  coverageProgressPct: 0,
  setCoverageProgressPct: (pct) => set({ coverageProgressPct: pct }),
  coverageError: "",
  setCoverageError: (msg) => set({ coverageError: msg }),

  // 기상 데이터
  weatherData: null,
  setWeatherData: (data) => set({ weatherData: data }),
  weatherLoading: false,
  setWeatherLoading: (v) => set({ weatherLoading: v }),

  // 구름 오버레이
  cloudGrid: null,
  setCloudGrid: (data) => set({ cloudGrid: data }),
  cloudGridVisible: false,
  setCloudGridVisible: (v) => set({ cloudGridVisible: v }),
  cloudGridLoading: false,
  setCloudGridLoading: (v) => set({ cloudGridLoading: v }),
  cloudGridProgress: "",
  setCloudGridProgress: (msg) => set({ cloudGridProgress: msg }),

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
    set((state) => ({ savedReports: state.savedReports.filter((r) => r.id !== id) }));
    invoke("delete_saved_report", { id }).catch((e) => console.warn("[Report] DB 삭제 실패:", e));
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
        next.set(groupId, data);
      } else {
        next.delete(groupId);
      }
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
}));
