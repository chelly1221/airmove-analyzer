import { create } from "zustand";
import type {
  Aircraft,
  AnalysisResult,
  LOSProfileData,
  PageId,
  RadarSite,
  UploadedFile,
} from "../types";

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
  clearUploadedFiles: () => void;

  // 분석 결과
  analysisResults: AnalysisResult[];
  addAnalysisResult: (r: AnalysisResult) => void;
  appendTrackPoints: (filePath: string, points: import("../types").TrackPoint[]) => void;
  clearAnalysisResults: () => void;

  // 레이더 사이트
  radarSite: RadarSite;
  setRadarSite: (site: RadarSite) => void;
  customRadarSites: RadarSite[];
  addCustomRadarSite: (site: RadarSite) => void;
  updateCustomRadarSite: (name: string, site: RadarSite) => void;
  removeCustomRadarSite: (name: string) => void;

  // 필터
  selectedModeS: string | null;
  setSelectedModeS: (modeS: string | null) => void;

  // LOS 분석
  losResults: LOSProfileData[];
  addLOSResult: (r: LOSProfileData) => void;
  removeLOSResult: (id: string) => void;
  clearLOSResults: () => void;

  // UI
  activePage: PageId;
  setActivePage: (page: PageId) => void;
  loading: boolean;
  setLoading: (loading: boolean) => void;
  loadingMessage: string;
  setLoadingMessage: (msg: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  // 비행검사기 (프리셋)
  aircraft: [
    {
      id: "preset-1",
      name: "1호기",
      model: "Embraer Praetor 600",
      mode_s_code: "71BF79",
      organization: "비행점검센터",
      memo: "",
      active: true,
    },
    {
      id: "preset-2",
      name: "2호기",
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
      return { aircraft: [...state.aircraft, a] };
    }),
  updateAircraft: (id, updates) =>
    set((state) => ({
      aircraft: state.aircraft.map((a) =>
        a.id === id ? { ...a, ...updates } : a
      ),
    })),
  removeAircraft: (id) =>
    set((state) => ({
      aircraft: state.aircraft.filter((a) => a.id !== id),
    })),

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
  removeUploadedFile: (path) =>
    set((state) => ({
      uploadedFiles: state.uploadedFiles.filter((f) => f.path !== path),
    })),
  clearUploadedFiles: () =>
    set({ uploadedFiles: [], analysisResults: [], selectedModeS: null }),

  // 분석 결과
  analysisResults: [],
  addAnalysisResult: (r) =>
    set((state) => ({ analysisResults: [...state.analysisResults, r] })),
  appendTrackPoints: (filePath, points) =>
    set((state) => ({
      analysisResults: state.analysisResults.map((r) => {
        // file_info.filename 또는 file_path의 파일명으로 매칭
        const fname = filePath.split(/[/\\]/).pop() ?? filePath;
        if (r.file_info.filename !== fname) return r;
        return {
          ...r,
          file_info: {
            ...r.file_info,
            track_points: [...r.file_info.track_points, ...points],
          },
        };
      }),
    })),
  clearAnalysisResults: () => set({ analysisResults: [] }),

  // 레이더 사이트 (기본: 김포 #1)
  radarSite: {
    name: "김포 #1",
    latitude: 37.5490,
    longitude: 126.7937,
    altitude: 9.11,
    antenna_height: 19.8,
    range_nm: 200,
  },
  setRadarSite: (site) => set({ radarSite: site }),
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
  addCustomRadarSite: (site) =>
    set((state) => ({ customRadarSites: [...state.customRadarSites, site] })),
  updateCustomRadarSite: (name, site) =>
    set((state) => ({
      customRadarSites: state.customRadarSites.map((s) =>
        s.name === name ? site : s
      ),
    })),
  removeCustomRadarSite: (name) =>
    set((state) => ({
      customRadarSites: state.customRadarSites.filter((s) => s.name !== name),
    })),

  // 필터
  selectedModeS: null,
  setSelectedModeS: (modeS) => set({ selectedModeS: modeS }),

  // LOS 분석
  losResults: [],
  addLOSResult: (r) =>
    set((state) => ({ losResults: [...state.losResults, r] })),
  removeLOSResult: (id) =>
    set((state) => ({
      losResults: state.losResults.filter((r) => r.id !== id),
    })),
  clearLOSResults: () => set({ losResults: [] }),

  // UI
  activePage: "upload",
  setActivePage: (page) => set({ activePage: page }),
  loading: false,
  setLoading: (loading) => set({ loading }),
  loadingMessage: "",
  setLoadingMessage: (msg) => set({ loadingMessage: msg }),
}));
