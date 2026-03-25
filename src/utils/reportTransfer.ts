/**
 * 보고서 창 간 데이터 전달 — IndexedDB 기반
 * Main → Report 창으로 대량 데이터를 전달하기 위한 유틸리티.
 * Map 객체는 Array<[K,V]>로 직렬화하여 structured clone 호환.
 */
import type {
  Flight, LoSProfileData, Aircraft, RadarSite, ReportMetadata,
  PanoramaPoint, ManualBuilding, AzSector, ObstacleMonthlyResult,
  PreScreeningResult, OMReportData,
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
  omAltitude: boolean;
  omLossEvents: boolean;
  omFindings: boolean;
}

// ── 직렬화 가능한 OMReportData (Map → Array) ──

interface SerializedOMData {
  result: ObstacleMonthlyResult | null;
  selectedBuildings: ManualBuilding[];
  selectedRadarSites: RadarSite[];
  azSectorsByRadar: [string, AzSector[]][];
  losMap: [string, LoSProfileData][];
  covLayersWithBuildings: CoverageLayer[];
  covLayersWithout: CoverageLayer[];
  analysisMonth: string;
  findingsText: string;
  recommendText: string;
  panoWithTargets: [string, PanoramaPoint[]][];
  panoWithoutTargets: [string, PanoramaPoint[]][];
  coverageStatus: "idle" | "loading" | "done" | "error";
  panoramaStatus: "idle" | "loading" | "done" | "error";
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
  coverSubtitle: string;
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
  psCovLayersWith: CoverageLayer[];
  psCovLayersWithout: CoverageLayer[];
  psAnalysisMonth: string;
}

// ── Map ↔ Array 변환 ──

export function serializeOMData(om: OMReportData): SerializedOMData {
  return {
    result: om.result,
    selectedBuildings: om.selectedBuildings,
    selectedRadarSites: om.selectedRadarSites,
    azSectorsByRadar: [...om.azSectorsByRadar],
    losMap: [...om.losMap],
    covLayersWithBuildings: om.covLayersWithBuildings,
    covLayersWithout: om.covLayersWithout,
    analysisMonth: om.analysisMonth,
    findingsText: om.findingsText,
    recommendText: om.recommendText,
    panoWithTargets: [...om.panoWithTargets],
    panoWithoutTargets: [...om.panoWithoutTargets],
    coverageStatus: om.coverageStatus,
    panoramaStatus: om.panoramaStatus,
    sectionImages: [...om.sectionImages],
  };
}

export function deserializeOMData(s: SerializedOMData): OMReportData {
  return {
    result: s.result,
    selectedBuildings: s.selectedBuildings,
    selectedRadarSites: s.selectedRadarSites,
    azSectorsByRadar: new Map(s.azSectorsByRadar),
    losMap: new Map(s.losMap),
    covLayersWithBuildings: s.covLayersWithBuildings,
    covLayersWithout: s.covLayersWithout,
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
  omAltitude: true,
  omLossEvents: true,
  omFindings: true,
};

// ── IndexedDB 헬퍼 ──

const DB_NAME = "report-transfer";
const STORE_NAME = "data";
const KEY = "current";

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
    tx.objectStore(STORE_NAME).put(payload, KEY);
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
