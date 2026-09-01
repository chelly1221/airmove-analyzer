/**
 * 보고서 창 간 데이터 전달 — IndexedDB 기반
 * Main → Report 창으로 대량 데이터를 전달하기 위한 유틸리티.
 * Map 객체는 Array<[K,V]>로 직렬화하여 structured clone 호환.
 */
import type {
  LoSProfileData, Aircraft, RadarSite, ReportMetadata,
  PanoramaMergeResult, ManualBuilding, BuildingGroup, AzSector, ObstacleMonthlyResult,
  OMReportData,
} from "../types";
import type { CoverageLayer } from "./radarCoverage";
import type { BraReviewPayload } from "./braReviewAnalysis";
import type { CraneReviewPayload } from "./craneReviewShared";

// ── 보고서 템플릿/섹션 타입 (ReportGeneration과 공유) ──
// 장애물 월간(OM) 보고서 단일 템플릿만 제공.

export type ReportTemplate = "obstacle_monthly";

export interface ReportSections {
  cover: boolean;
  /** 전체 표적 히트맵 — §1 (분석 요약 앞). 레이더별 60NM 전방위 전수 밀도 지도. */
  omTargetHeatmap: boolean;
  omSummary: boolean;
  /** 일별 PSR·표적소실 결합 라인 차트 (페이지 2). 기존 omDailyPsr/omDailyLoss 두 토글을 합친 단일 토글. */
  omDailyPsrLoss: boolean;
  omLosCrossSection: boolean;
  omLossEvents: boolean;
  omFindings: boolean;
}

// ── 직렬화 가능한 OMReportData (Map → Array) ──

export interface SerializedOMData {
  result: ObstacleMonthlyResult | null;
  selectedBuildings: ManualBuilding[];
  /** 건물 그룹 메타 (배지 색·이름 표시용) */
  buildingGroups: BuildingGroup[];
  selectedRadarSites: RadarSite[];
  azSectorsByRadar: [string, AzSector[]][];
  losMap: [string, LoSProfileData][];
  covLayersWithBuildings: [string, CoverageLayer[]][];
  covLayersWithout: [string, CoverageLayer[]][];
  analysisMonth: string;
  findingsText: string;
  // 아래 두 필드는 OMReportData 형상 미러일 뿐 — 인라인 편집은 창 전송 후 보고서 창에서
  // 발생하므로 전송 시점엔 항상 비어 있다. addedBlockageByKey 는 의도적으로 제외(전송 후 라이브 산출).
  /** 인라인 편집 텍스트 오버라이드 (편집키 → 사용자 수정 문구) */
  textOverrides?: Record<string, string>;
  /** 차트 줌 상태 (편집키 → [시작%, 끝%]) */
  chartZooms?: Record<string, [number, number]>;
  panoWithTargets: [string, PanoramaMergeResult][];
  panoWithoutTargets: [string, PanoramaMergeResult][];
  coverageStatus: "idle" | "loading" | "done" | "error";
  panoramaStatus: "idle" | "deferred" | "loading" | "done" | "error";
}

// ── 전달 페이로드 ──

export interface ReportWindowPayload {
  // 보고서 설정
  template: ReportTemplate;
  sections: ReportSections;

  // 편집 가능 텍스트
  coverTitle: string;
  coverSubtitle?: string;

  // 데이터
  radarSite: RadarSite;
  reportMetadata: ReportMetadata;

  // 장애물 월간
  omData: SerializedOMData;
}

// ── Map ↔ Array 변환 ──

export function serializeOMData(om: OMReportData): SerializedOMData {
  return {
    result: om.result,
    selectedBuildings: om.selectedBuildings,
    buildingGroups: om.buildingGroups,
    selectedRadarSites: om.selectedRadarSites,
    azSectorsByRadar: [...om.azSectorsByRadar],
    losMap: [...om.losMap],
    covLayersWithBuildings: [...om.covLayersWithBuildings],
    covLayersWithout: [...om.covLayersWithout],
    analysisMonth: om.analysisMonth,
    findingsText: om.findingsText,
    textOverrides: om.textOverrides ?? {},
    chartZooms: om.chartZooms ?? {},
    panoWithTargets: [...om.panoWithTargets],
    panoWithoutTargets: [...om.panoWithoutTargets],
    coverageStatus: om.coverageStatus,
    panoramaStatus: om.panoramaStatus,
  };
}

export function deserializeOMData(s: SerializedOMData): OMReportData {
  return {
    result: s.result,
    selectedBuildings: s.selectedBuildings,
    buildingGroups: s.buildingGroups ?? [],
    selectedRadarSites: s.selectedRadarSites,
    azSectorsByRadar: new Map(s.azSectorsByRadar),
    losMap: new Map(s.losMap),
    covLayersWithBuildings: new Map(s.covLayersWithBuildings),
    covLayersWithout: new Map(s.covLayersWithout),
    analysisMonth: s.analysisMonth,
    findingsText: s.findingsText,
    textOverrides: s.textOverrides ?? {},
    chartZooms: s.chartZooms ?? {},
    panoWithTargets: new Map(s.panoWithTargets),
    panoWithoutTargets: new Map(s.panoWithoutTargets),
    coverageStatus: s.coverageStatus,
    panoramaStatus: s.panoramaStatus,
  };
}

// ── 공유 유틸 ──

export function templateDisplayLabel(_tpl: ReportTemplate): string {
  return "장애물월간";
}

export const DEFAULT_SECTIONS: ReportSections = {
  cover: true,
  omTargetHeatmap: true,
  omSummary: true,
  omDailyPsrLoss: true,
  omLosCrossSection: true,
  omLossEvents: true,
  omFindings: true,
};

// ── 모달 설정 페이로드 (메인 → 보고서 창, 모달 표시용) ──

export interface ReportConfigPayload {
  template: ReportTemplate;
  aircraft: Aircraft[];
  metadata: ReportMetadata;
  customRadarSites: RadarSite[];
}

// ── 생성 요청 (보고서 창 → 메인, 모달 설정 완료 후) ──

export interface ReportGenerateRequest {
  template: ReportTemplate;
  sections: ReportSections;
  // 장애물 월간 분석 결과 (serialized)
  omData?: SerializedOMData;
}

// ── IndexedDB 헬퍼 ──

const DB_NAME = "report-transfer";
const STORE_NAME = "data";
const KEY = "current";
const CONFIG_KEY = "config";
const REQUEST_KEY = "request";
/** 전파영향성 검토 의견서 페이로드 (TrackMap → bra-review 창) */
const BRAREVIEW_KEY = "brareview";
/** 타워크레인 전파영향 검토 보고서 페이로드 키 (메인 창 → crane-review 창) */
const CRANEREVIEW_KEY = "cranereview";

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
        reject(new Error("보고서 데이터가 브라우저 저장소 용량을 초과했습니다. 분석 레이더/기간을 줄이거나 앱을 재시작 후 다시 시도하세요."));
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

// ── 전파영향성 검토 의견서 페이로드 (TrackMap → bra-review 창) ──
// 같은 IDB(report-transfer/data)를 키만 달리해 공유한다. 타입 단일 원천은 braReviewAnalysis.ts.

/** TrackMap → IDB 에 의견서 입력 페이로드 저장 */
export async function writeBraReviewPayload(payload: BraReviewPayload): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(payload, BRAREVIEW_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/** 의견서 창 → IDB 에서 입력 페이로드 읽기 */
export async function readBraReviewPayload(): Promise<BraReviewPayload | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(BRAREVIEW_KEY);
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

// ── 타워크레인 전파영향 검토 보고서 페이로드 (메인 창 보고서 생성 → crane-review 창) ──
// 의견서와 같은 IDB(report-transfer/data)를 키만 달리해 공유한다. 타입 단일 원천은 craneReviewShared.ts.

/** 메인 창 → IDB 에 크레인 검토 입력 페이로드 저장 */
export async function writeCraneReviewPayload(payload: CraneReviewPayload): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(payload, CRANEREVIEW_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/** 크레인 검토 창 → IDB 에서 입력 페이로드 읽기 */
export async function readCraneReviewPayload(): Promise<CraneReviewPayload | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(CRANEREVIEW_KEY);
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}
