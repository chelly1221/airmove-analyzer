import { create } from "zustand";
import type {
  Aircraft,
  AnalysisResult,
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
  clearAnalysisResults: () => void;

  // 레이더 사이트
  radarSite: RadarSite;
  setRadarSite: (site: RadarSite) => void;

  // 필터
  selectedModeS: string | null;
  setSelectedModeS: (modeS: string | null) => void;

  // UI
  activePage: PageId;
  setActivePage: (page: PageId) => void;
  loading: boolean;
  setLoading: (loading: boolean) => void;
  loadingMessage: string;
  setLoadingMessage: (msg: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  // 비행검사기
  aircraft: [],
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
  clearAnalysisResults: () => set({ analysisResults: [] }),

  // 레이더 사이트 (기본: 김포)
  radarSite: {
    name: "김포",
    latitude: 37.5585,
    longitude: 126.7906,
    altitude: 0,
    antenna_height: 0,
  },
  setRadarSite: (site) => set({ radarSite: site }),

  // 필터
  selectedModeS: null,
  setSelectedModeS: (modeS) => set({ selectedModeS: modeS }),

  // UI
  activePage: "dashboard",
  setActivePage: (page) => set({ activePage: page }),
  loading: false,
  setLoading: (loading) => set({ loading }),
  loadingMessage: "",
  setLoadingMessage: (msg) => set({ loadingMessage: msg }),
}));
