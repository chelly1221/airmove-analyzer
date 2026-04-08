/**
 * 보고서 창 간 데이터 전달 — IndexedDB 기반
 * Main → Report 창으로 대량 데이터를 전달하기 위한 유틸리티.
 * Map 객체는 Array<[K,V]>로 직렬화하여 structured clone 호환.
 */
import type {
  Flight, LoSProfileData, Aircraft, RadarSite, ReportMetadata,
  PanoramaPoint, PanoramaMergeResult, ManualBuilding, AzSector, ObstacleMonthlyResult,
  PreScreeningResult, OMReportData, TrackPoint,
} from "../types";
import type { CoverageLayer } from "./radarCoverage";

// ── 보고서 템플릿/섹션 타입 (ReportGeneration과 공유) ──

export type ReportTemplate = "weekly" | "monthly" | "flights" | "single" | "obstacle" | "obstacle_monthly";

export interface ReportSections {
  cover: boolean;
  summary: boolean;
  trackMap: boolean;
  stats: boolean;
  los: boolean;
  panorama: boolean;
  aircraft: boolean;
  flightComparison: boolean;
  lossDetail: boolean;
  flightProfile: boolean;
  flightLossAnalysis: boolean;
  obstacleSummary: boolean;
  coverageMap: boolean;
  psAdditionalLoss: boolean;
  psAngleHeight: boolean;
  omSummary: boolean;
  omDailyPsr: boolean;
  omDailyLoss: boolean;
  omWeekly: boolean;
  omCoverageDiff: boolean;
  omAzDistScatter: boolean;
  omBuildingLos: boolean;
  omLosCrossSection: boolean;
  omAltitude: boolean;
  omLossEvents: boolean;
  omFindings: boolean;
}

// ── 직렬화 가능한 OMReportData (Map → Array) ──

export interface SerializedOMData {
  result: ObstacleMonthlyResult | null;
  selectedBuildings: ManualBuilding[];
  selectedRadarSites: RadarSite[];
  azSectorsByRadar: [string, AzSector[]][];
  losMap: [string, LoSProfileData][];
  covLayersWithBuildings: [string, CoverageLayer[]][];
  covLayersWithout: [string, CoverageLayer[]][];
  analysisMonth: string;
  findingsText: string;
  recommendText: string;
  panoWithTargets: [string, PanoramaMergeResult][];
  panoWithoutTargets: [string, PanoramaMergeResult][];
  coverageStatus: "idle" | "loading" | "done" | "error";
  panoramaStatus: "idle" | "deferred" | "loading" | "done" | "error";
  sectionImages: [string, string][];
}

// ── 전달 페이로드 ──

export interface ReportWindowPayload {
  // 보고서 설정
  template: ReportTemplate;
  sections: ReportSections;
  selectedFlightIds: string[];
  singleFlightId: string | null;
  editingReportId: string | null;

  // 편집 가능 텍스트
  coverTitle: string;
  coverSubtitle?: string;
  commentary: string;

  // 데이터
  flights: Flight[];
  reportFlights: Flight[];
  losResults: LoSProfileData[];
  aircraft: Aircraft[];
  radarSite: RadarSite;
  reportMetadata: ReportMetadata;
  panoramaData: PanoramaPoint[];
  panoramaPeakNames: [number, string][];
  coverageLayers: CoverageLayer[];
  mapImage: string | null;

  // 장애물 월간
  omData: SerializedOMData;

  // 사전검토
  psResult: PreScreeningResult | null;
  psSelectedBuildings: ManualBuilding[];
  psSelectedRadarSites: RadarSite[];
  psLosMap: [string, LoSProfileData][];
  psCovLayersWith: [string, CoverageLayer[]][];
  psCovLayersWithout: [string, CoverageLayer[]][];
  psAnalysisMonth: string;

  // 단일비행 차트 포인트 (보고서 윈도우에서 Worker가 없으므로 사전 전달)
  singleFlightChartPoints?: TrackPoint[];
}

// ── Map ↔ Array 변환 ──

export function serializeOMData(om: OMReportData): SerializedOMData {
  return {
    result: om.result,
    selectedBuildings: om.selectedBuildings,
    selectedRadarSites: om.selectedRadarSites,
    azSectorsByRadar: [...om.azSectorsByRadar],
    losMap: [...om.losMap],
    covLayersWithBuildings: [...om.covLayersWithBuildings],
    covLayersWithout: [...om.covLayersWithout],
    analysisMonth: om.analysisMonth,
    findingsText: om.findingsText,
    recommendText: om.recommendText,
    panoWithTargets: [...om.panoWithTargets],
    panoWithoutTargets: [...om.panoWithoutTargets],
    coverageStatus: om.coverageStatus,
    panoramaStatus: om.panoramaStatus,
    // IDB 전송 시 sectionImages 제외 — 보고서 윈도우에서 자체 캡처
    sectionImages: [],
  };
}

export function deserializeOMData(s: SerializedOMData): OMReportData {
  return {
    result: s.result,
    selectedBuildings: s.selectedBuildings,
    selectedRadarSites: s.selectedRadarSites,
    azSectorsByRadar: new Map(s.azSectorsByRadar),
    losMap: new Map(s.losMap),
    covLayersWithBuildings: new Map(s.covLayersWithBuildings),
    covLayersWithout: new Map(s.covLayersWithout),
    analysisMonth: s.analysisMonth,
    findingsText: s.findingsText,
    recommendText: s.recommendText,
    panoWithTargets: new Map(s.panoWithTargets),
    panoWithoutTargets: new Map(s.panoWithoutTargets),
    coverageStatus: s.coverageStatus,
    panoramaStatus: s.panoramaStatus,
    sectionImages: new Map(s.sectionImages),
  };
}

// ── 공유 유틸 ──

export function templateDisplayLabel(tpl: ReportTemplate): string {
  switch (tpl) {
    case "weekly": return "주간";
    case "monthly": return "월간";
    case "flights": return "건별";
    case "single": return "상세";
    case "obstacle": return "사전검토";
    case "obstacle_monthly": return "장애물월간";
  }
}

export const DEFAULT_SECTIONS: ReportSections = {
  cover: true,
  summary: true,
  trackMap: true,
  stats: true,
  los: true,
  panorama: true,
  aircraft: true,
  flightComparison: true,
  lossDetail: true,
  flightProfile: true,
  flightLossAnalysis: true,
  obstacleSummary: true,
  coverageMap: true,
  psAdditionalLoss: true,
  psAngleHeight: true,
  omSummary: true,
  omDailyPsr: true,
  omDailyLoss: true,
  omWeekly: true,
  omCoverageDiff: true,
  omAzDistScatter: true,
  omBuildingLos: true,
  omLosCrossSection: true,
  omAltitude: true,
  omLossEvents: true,
  omFindings: true,
};

// ── 모달 설정 페이로드 (메인 → 보고서 창, 모달 표시용) ──

export interface ReportConfigPayload {
  template: ReportTemplate;
  flights: Flight[];
  losResults: LoSProfileData[];
  aircraft: Aircraft[];
  metadata: ReportMetadata;
  radarSite: RadarSite;
  panoramaData: PanoramaPoint[];
  panoramaPeakNames: [number, string][];
  coverageLayers: CoverageLayer[];
  customRadarSites: RadarSite[];
}

// ── 생성 요청 (보고서 창 → 메인, 모달 설정 완료 후) ──

export interface ReportGenerateRequest {
  template: ReportTemplate;
  sections: ReportSections;
  selectedFlightIds?: string[];
  singleFlightId?: string | null;
  // 장애물 월간 분석 결과 (serialized)
  omData?: SerializedOMData;
  // 사전검토 분석 결과
  psResult?: PreScreeningResult | null;
  psSelectedBuildings?: ManualBuilding[];
  psSelectedRadarSites?: RadarSite[];
  psLosMap?: [string, LoSProfileData][];
  psCovLayersWith?: [string, CoverageLayer[]][];
  psCovLayersWithout?: [string, CoverageLayer[]][];
  psAnalysisMonth?: string;
}

// ── IndexedDB 헬퍼 ──

const DB_NAME = "report-transfer";
const STORE_NAME = "data";
const KEY = "current";
const CONFIG_KEY = "config";
const REQUEST_KEY = "request";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 메인 창 → IDB에 보고서 페이로드 저장 */
export async function writeReportPayload(payload: ReportWindowPayload): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).put(payload, KEY);
    req.onerror = () => {
      db.close();
      // DOMException: QuotaExceededError
      const err = req.error;
      if (err?.name === "QuotaExceededError") {
        reject(new Error("보고서 데이터가 너무 큽니다. 브라우저 저장소 용량을 초과했습니다. 불필요한 저장 보고서를 삭제 후 다시 시도하세요."));
      } else {
        reject(err);
      }
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/** 보고서 창 → IDB에서 페이로드 읽기 */
export async function readReportPayload(): Promise<ReportWindowPayload | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(KEY);
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/** 로드 후 IDB 정리 */
export async function clearReportPayload(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// ── 설정 페이로드 (모달용) ──

/** 메인 창 → IDB에 설정 페이로드 저장 (보고서 창 모달 표시용) */
export async function writeReportConfig(payload: ReportConfigPayload): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(payload, CONFIG_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/** 보고서 창 → IDB에서 설정 페이로드 읽기 */
export async function readReportConfig(): Promise<ReportConfigPayload | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(CONFIG_KEY);
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/** 설정 페이로드 정리 */
export async function clearReportConfig(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(CONFIG_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// ── 생성 요청 (보고서 창 → 메인) ──

/** 보고서 창 → IDB에 생성 요청 저장 */
export async function writeGenerateRequest(req: ReportGenerateRequest): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(req, REQUEST_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/** 메인 창 → IDB에서 생성 요청 읽기 */
export async function readGenerateRequest(): Promise<ReportGenerateRequest | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(REQUEST_KEY);
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

/** 생성 요청 정리 */
export async function clearGenerateRequest(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(REQUEST_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
