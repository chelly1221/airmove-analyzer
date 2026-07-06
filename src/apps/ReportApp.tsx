/**
 * 보고서 편집 창 — 별도 Tauri 윈도우 (label: "report")
 * IDB에서 페이로드를 읽어 프리뷰를 렌더링하고 PDF 내보내기를 처리.
 */
import { useState, useRef, useCallback, useMemo, useEffect, startTransition } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { format } from "date-fns";
import { Loader2, TriangleAlert } from "lucide-react";
import Titlebar from "../components/Layout/Titlebar";
import ReportPreviewContent, { getSectionToggles } from "../components/Report/ReportPreviewContent";
import ReportOMSidebar, { type OMSidebarTocItem } from "../components/Report/ReportOMSidebar";
import { useReportExport } from "../components/Report/useReportExport";
import ObstacleMonthlyConfigModal from "../components/Report/ObstacleMonthlyConfigModal";
import ReportSettingsModal from "../components/Report/ReportSettingsModal";
import ReportPdfExportModal from "../components/Report/ReportPdfExportModal";
import { generateOMFindingsText } from "../utils/omFindingsGenerator";
import { readBulkJson } from "../utils/bulkIpc";
import type { BulkRef } from "../utils/bulkIpc";
import { computeAddedBlockage } from "../utils/omAddedBlockage";
import { calcBuildingAzExtent, hasBldgEffectFromPanorama, panoWithForBuilding } from "../utils/obstacleAnalysisHelpers";
import {
  readReportPayload, clearReportPayload, deserializeOMData, serializeOMData,
  readReportConfig, clearReportConfig, writeGenerateRequest, clearGenerateRequest,
  templateDisplayLabel, DEFAULT_SECTIONS,
  type ReportTemplate, type ReportSections, type ReportWindowPayload,
  type ReportConfigPayload,
} from "../utils/reportTransfer";
import type {
  LoSProfileData, ReportMetadata,
  PanoramaMergeResult, PanoramaMergeDualResult, ManualBuilding, BuildingGroup, RadarSite, AzSector,
  ObstacleMonthlyResult, OMReportData,
  AddedBlockageResult,
} from "../types";
import type { CoverageLayer } from "../utils/radarCoverage";
import SourceOverlay from "../dev/SourceOverlay";

const appWindow = getCurrentWindow();


// ── 로드 상태 ──

interface LoadedState {
  template: ReportTemplate;
  sections: ReportSections;
  coverTitle: string;
  coverSubtitle: string;
  radarSite: RadarSite;
  reportMetadata: ReportMetadata;
  omData: OMReportData;
}

function payloadToState(p: ReportWindowPayload): LoadedState {
  return {
    template: p.template,
    sections: p.sections,
    coverTitle: p.coverTitle,
    coverSubtitle: p.coverSubtitle ?? format(new Date(), "yyyy년 MM월"),
    radarSite: p.radarSite,
    reportMetadata: p.reportMetadata,
    omData: deserializeOMData(p.omData),
  };
}

// ── 메인 컴포넌트 ──

export default function ReportApp() {
  const [state, setState] = useState<LoadedState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 설정 모달 단계 (config payload가 있으면 모달 표시)
  const [configPayload, setConfigPayload] = useState<ReportConfigPayload | null>(null);
  // 설정 모달 세대 — reload-config 마다 증가, 모달 key 로 사용해 강제 리마운트.
  // 이전 플로우의 로컬 상태(step/analyzing/stage/cancelledRef 등)가 새 세션에 살아남지 않게 한다.
  const [configEpoch, setConfigEpoch] = useState(0);

  // 보고서 준비 단계 (보고서 창 내 오버레이)
  const [prepPhase, setPrepPhase] = useState<"waiting" | "loading" | null>("waiting");

  // 섹션 토글 (로컬 상태)
  const [sections, setSections] = useState<ReportSections | null>(null);

  // 편집 가능 텍스트
  const [coverTitle, setCoverTitle] = useState("");
  const [coverSubtitle, setCoverSubtitle] = useState(() => format(new Date(), "yyyy년 MM월"));

  // 편집 가능 보고서 메타데이터 — 설정 모달에서 수정 → 표지/머리말 라이브 반영.
  // null 이면 state.reportMetadata(원본)를 사용.
  const [metadata, setMetadata] = useState<ReportMetadata | null>(null);

  // OM 사이드바 모달 open 상태 (표시섹션·설정 / PDF 내보내기)
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  // omData (로컬, 비동기 업데이트 가능)
  const [omData, setOmData] = useState<OMReportData | null>(null);

  // ── 프리뷰 '완전 준비' 게이트용 상태 ──
  // 프리뷰 창을 revealing 하기 전, 구조적으로 완성될 때까지(§3 상세 페이지 전량 마운트 + 추가
  // 차단영역 산출 완료) 설정/진행 모달을 유지한다. 종전엔 omReady(커버리지+파노라마)만 되면 모달이
  // 닫혀, 아직 §3 페이지가 하나씩 튀어나오고 §1/§3/소견 수치가 뒤늦게 채워지는 '미완성 프리뷰'가
  // 사용자에게 노출됐다. detailMounting 은 ReportPreviewContent 가 콜백으로 보고한다.
  //   초깃값 true — 프리뷰가 마운트되어 실제 값을 보고하기 전에 fullyReady 가 순간 true 로 튀어
  //   모달이 조기 종료되는 레이스를 막는다 (프리뷰는 최초 effect 에서 반드시 값을 보고한다).
  const [previewDetailMounting, setPreviewDetailMounting] = useState(true);
  const handleMountingChange = useCallback((mounting: boolean) => {
    setPreviewDetailMounting(mounting);
  }, []);
  // 프리뷰 §3·§4 도면 타일 로딩 게이트 — 구조(상세 마운트+추가차단 산출)가 완성된 뒤에도 CARTO
  //   타일이 백그라운드 자가치유(composeTiles 재시도)로 채워지는 중이면 모달을 유지한다. 종전엔 이
  //   신호가 없어, 구조만 갖춰지면 모달이 닫히고 §4 소실상세 도면이 '일부만 로딩된(회색 조각)' 채
  //   노출됐다. 초깃값 true — 도면 canvas 가 complete 를 보고하기 전 조기 fullyReady 를 막는다.
  //   구조 준비(structureReady) 이후 아래 폴링 게이트가 data-map-complete 를 관측해 내린다. reload 시 리셋.
  const [previewMapsLoading, setPreviewMapsLoading] = useState(true);
  // 폴백 리빌 — 어떤 준비 신호가 (버그/행잉으로) 끝내 해제되지 않아도 모달이 영구히 걸리지 않도록,
  // 파노라마 종료(omReady) 후 일정 시간이 지나면 강제로 프리뷰를 노출한다. reload 시 리셋.
  const [forceReveal, setForceReveal] = useState(false);

  // 닫기 확인 모달
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);

  // OM 데이터 캐시 — IDB 왕복 시 커버리지 등 대용량 데이터 제외하고,
  // 보고서 창 메모리에 직접 보관하여 IDB 병목 방지
  const omDataCacheRef = useRef<OMReportData | null>(null);
  // 자동 생성된 findingsText 스냅샷 — 추가 차단영역 산출 후 재생성 시 사용자 편집 보호용(미편집일 때만 덮어씀)
  const autoFindingsRef = useRef<string>("");
  // 커버리지 실패 기록 — 모달의 커버리지 catch(onCoverageError)가 호출되는 시점엔 omData 가
  // 아직 null 이라 setOmData 만으로는 반영이 안 되므로 ref 로 기록한다.
  // handleOMGenerate 에서 진단용으로 소비 후 리셋, reload-config 시에도 리셋.
  const coverageErrorRef = useRef(false);

  // PDF 내보내기
  const [generating, setGenerating] = useState(false);
  const generatingRef = useRef(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportElapsed, setExportElapsed] = useState(0);
  const exportTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const { exportPDF } = useReportExport();

  // 파노라마 하위 단계 진행 상태 (레이더별 heightmap → GPU → merge)
  type PanoramaPhase = "heightmap" | "gpu" | "merge";
  type PanoramaProgress = {
    currentIndex: number;   // 1-based, 처리 중 레이더
    totalRadars: number;
    currentRadarName: string;
    phase: PanoramaPhase;
  };
  const [panoramaProgress, setPanoramaProgress] = useState<PanoramaProgress | null>(null);
  const [panoramaElapsedMs, setPanoramaElapsedMs] = useState(0);
  const [panoramaLastError, setPanoramaLastError] = useState<string | null>(null);
  // phaseStartedAt 은 ref 로 보관 — phase 전환 시 interval 을 재생성하지 않음
  const phaseStartedAtRef = useRef<number>(0);
  const panoramaActive = panoramaProgress !== null;
  useEffect(() => {
    if (!panoramaActive) { setPanoramaElapsedMs(0); return; }
    const id = setInterval(() => {
      setPanoramaElapsedMs(performance.now() - phaseStartedAtRef.current);
    }, 250);
    return () => clearInterval(id);
  }, [panoramaActive]);

  // ── OM 사이드바 상태 ──
  // 목차 active/페이지 추적. 페이지 인덱스는 프리뷰 컨테이너의 [data-page] / [data-toc-key]
  // 마커를 측정해 갱신. (PDF 용지/범위 옵션은 A4 고정 레이아웃상 무의미해 제거됨)
  const [omActiveTocKey, setOmActiveTocKey] = useState<string | null>(null);
  const [omCurrentPage, setOmCurrentPage] = useState(1);
  const [omTotalPages, setOmTotalPages] = useState(0);
  // tocKey → 1-based 첫 페이지 인덱스 (DOM 측정 결과)
  const [omTocPageMap, setOmTocPageMap] = useState<Map<string, number>>(new Map());

  // ── transfer 워치독 ── handleOMGenerate 의 emit("report:generate") 후 report:data-written 이
  // 오지 않는 경우(메인 창 리스너 일시 부재/이벤트 유실) 대비 재발신·최종 에러 타이머.
  // 페이로드 수신(loadFromIDB 성공)·reload-config·data-error 시 해제한다.
  const transferTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearTransferWatchdog = useCallback(() => {
    for (const t of transferTimersRef.current) clearTimeout(t);
    transferTimersRef.current = [];
  }, []);

  /** IDB에서 페이로드 읽기 → state 적용 */
  const loadingRef = useRef(false);
  // 재로드 세대 카운터 — reload-config 수신 시 증가. 진행 중이던 loadFromIDB 가
  // await 후 재개될 때 세대가 바뀌었으면 이전 보고서의(stale) 페이로드를 새 흐름 위에
  // 덮어쓰지 않도록 결과를 폐기한다 (stale omData 부활 → omReady 오판 방지).
  const loadEpochRef = useRef(0);
  const loadFromIDB = useCallback(async () => {
    // 중복 호출 방지 (fallback timer + event 동시 발생 시)
    if (loadingRef.current) return;
    loadingRef.current = true;
    const epoch = loadEpochRef.current;
    setPrepPhase("loading");
    try {
      const payload = await readReportPayload();
      // 읽는 동안 reload-config 도착 → 이 페이로드는 이전 세대 것 — 상태에 반영하지 않고 폐기.
      // loadingRef/prepPhase 는 reload 핸들러가 이미 리셋했으므로 건드리지 않는다.
      if (epoch !== loadEpochRef.current) return;
      if (!payload) {
        loadingRef.current = false;
        setPrepPhase("waiting"); // 아직 IDB에 없음 — 이벤트 대기
        return;
      }
      clearTransferWatchdog(); // 페이로드 수신 확인 — transfer 재발신/에러 타이머 해제
      const s = payloadToState(payload);
      await clearReportPayload();
      if (epoch !== loadEpochRef.current) return; // clear 대기 중 reload — stale 적용 방지

      // 캐시된 대용량 데이터가 있으면 IDB에서 받은 경량 버전 대신 원본 사용
      const cachedOm = omDataCacheRef.current;
      if (cachedOm && s.template === "obstacle_monthly") {
        s.omData = cachedOm;
        // 캐시 즉시 삭제 대신 지연 삭제 — 비동기 로드 타이밍 보호
        setTimeout(() => { omDataCacheRef.current = null; }, 5000);
      }

      startTransition(() => {
        setState(s);
        setSections(s.sections);
        setCoverTitle(s.coverTitle);
        setCoverSubtitle(s.coverSubtitle);
        setMetadata(s.reportMetadata);
        setOmData(s.omData);
        // 늦은 성공 복구 — 60초 transfer 워치독 에러 후 data-written 이 뒤늦게 도착한 경우
        //   에러 화면이 로드된 보고서를 영구히 가리지 않도록 해제 (확정 실패면 data-written 자체가 안 옴)
        setError(null);
        setLoading(false);
        setPrepPhase(null);
        loadingRef.current = false;
      });
    } catch (e) {
      if (epoch !== loadEpochRef.current) return; // stale 세대의 에러는 새 흐름에 표시하지 않음
      clearTransferWatchdog();
      setError(`데이터 로드 실패: ${e instanceof Error ? e.message : String(e)}`);
      setLoading(false);
      setPrepPhase(null);
      loadingRef.current = false;
    }
  }, [clearTransferWatchdog]);

  /** IDB에서 config 읽기 → 모달 표시 */
  const loadConfigFromIDB = useCallback(async () => {
    try {
      const config = await readReportConfig();
      if (config) {
        await clearReportConfig();

        setConfigPayload(config);
        setLoading(false);
        setPrepPhase(null);
        return true;
      }
    } catch (err) {
      // 실패 사유 기록만 — 호출부(마운트 경로/reload 재시도 루프)가 false 반환으로 폴백·재시도 처리
      console.error("[Report] config 로드 실패:", err);
    }
    return false;
  }, []);

  // 이벤트 리스너: data-written, reload-config, data-error
  useEffect(() => {
    // 보고서 창 DevTools 자동 활성화 비활성 — DevTools 가 열려 있으면 panorama-debug
    // 콘솔 로그 부하로 메인 스레드 블로킹/setTimeout throttle 가능. 필요 시 F12 로 직접 열 것.
    // invoke("open_devtools").catch(() => {});

    // 마운트 시: config 먼저 확인, 없으면 payload 확인
    (async () => {
      const hasConfig = await loadConfigFromIDB();
      if (!hasConfig) loadFromIDB();
    })();

    // report:data-written → IDB에서 전체 페이로드 읽기
    const unlistenData = listen("report:data-written", () => {
      loadFromIDB();
    });

    // Rust 파노라마/heightmap 단계별 진단 로그
    const unlistenPanoramaDebug = listen<string>("panorama-debug", (e) => {
      console.log(`[Rust] ${e.payload}`);
    });

    // report:reload-config → 기존 창 재사용 시 모달 다시 표시.
    // 이전 보고서의 stale 상태를 전수 초기화한다 — 특히 omData 를 남겨두면 이전 보고서의
    // omReady=true 가 새 모달에 그대로 전달되어, 새 분석이 transfer 단계에 도달하자마자
    // 모달이 '완료'로 조기 종료된다(파노라마 미시작 상태인데도).
    const unlistenReloadConfig = listen("report:reload-config", async () => {
      loadEpochRef.current += 1;         // 진행 중 loadFromIDB 의 이전 세대 결과 폐기
      const epoch = loadEpochRef.current;
      loadingRef.current = false;
      omDataCacheRef.current = null;
      autoFindingsRef.current = "";      // 이전 보고서 자동 소견 스냅샷 해제
      coverageErrorRef.current = false;  // 이전 커버리지 실패 기록 해제
      panoramaStartedRef.current = null; // 이전 result 참조 해제 (대용량 GC + 새 파노라마 실행 보장)
      addedBlockageStartedRef.current = null; // 이전 result 참조 해제 (새 추가차단 산출 보장)
      clearTransferWatchdog();           // 이전 플로우 transfer 재발신/에러 타이머 해제
      setPanoramaLastError(null);
      setError(null);
      setState(null);
      setPreviewDetailMounting(true); // 새 플로우 — 상세 마운트 미완으로 초기화 (조기 fullyReady 방지)
      setPreviewMapsLoading(true);    // 새 플로우 — 도면 타일 미로딩으로 초기화 (조기 fullyReady 방지)
      setForceReveal(false);          // 이전 플로우의 폴백 리빌 해제
      setOmData(null); // omData 파생 effect(파노라마) cleanup 이 진행 중 계산도 함께 취소한다
      // 이전 플로우의 모달·분석 파이프라인 완전 차단 — configPayload 를 비워 이전 모달을
      // unmount(→ cancelledRef=true, 이후 각 guard 에서 파이프라인 정지)시키고 Rust 분석도 명시 취소.
      // 새 config 적용 시 configEpoch key 로 모달이 강제 리마운트되어 step/analyzing 등
      // 로컬 상태가 초기화된다 (이전 설정의 분석 결과가 새 세션의 보고서로 둔갑하는 문제 방지).
      setConfigPayload(null);
      setConfigEpoch((e) => e + 1);
      invoke("cancel_analysis").catch(() => { /* ignore */ });
      setLoading(true);
      setPrepPhase("waiting");
      // 이전 플로우가 남긴 IDB 잔여 payload/generate-request 정리 — 새 플로우에 stale 데이터 유입 방지
      await Promise.allSettled([clearReportPayload(), clearGenerateRequest()]);
      // config 읽기 — 발신 측(handleTemplateClick)이 writeReportConfig 완료 후 emit 하므로 즉시 읽기 가능.
      // 실패·부재 시 짧은 백오프로 재시도 후 에러 표시 ('보고서 데이터 준비 중...' 영구 스피너 방지).
      for (let attempt = 0; attempt < 5; attempt++) {
        if (epoch !== loadEpochRef.current) return; // 새 reload 도착 — 이 루프는 폐기
        if (await loadConfigFromIDB()) return;
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
      if (epoch !== loadEpochRef.current) return;
      setError("보고서 설정을 불러오지 못했습니다. 창을 닫고 메인 창에서 다시 시도해주세요.");
      setLoading(false);
      setPrepPhase(null);
    });

    // report:data-error → 메인 창에서 데이터 생성 실패 시 에러 표시
    const unlistenError = listen<{ message: string }>("report:data-error", (event) => {
      clearTransferWatchdog();
      setError(`보고서 생성 실패: ${event.payload.message}`);
      setLoading(false);
      setPrepPhase(null);
      loadingRef.current = false;
      // OM 모달(z-[9999] 오버레이)이 에러 화면을 덮은 채 transfer 스피너로 무한 대기하지 않도록
      // 모달을 닫는다 — unmount 로 cancelledRef=true 가 되어 잔여 파이프라인도 함께 중단된다.
      setConfigPayload(null);
    });

    // 보고서 윈도우 닫기 전 미저장 확인
    const unlistenClose = appWindow.onCloseRequested(async (event) => {
      if (generatingRef.current) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      setCloseConfirmOpen(true);
    });

    return () => {
      unlistenData.then((fn) => fn());
      unlistenPanoramaDebug.then((fn) => fn());
      unlistenReloadConfig.then((fn) => fn());
      unlistenError.then((fn) => fn());
      unlistenClose.then((fn) => fn());
    };
  }, [loadFromIDB, loadConfigFromIDB, clearTransferWatchdog]);


  // 현재 활성 sections
  const activeSections = sections ?? state?.sections;
  const activeTemplate: ReportTemplate = state?.template ?? "obstacle_monthly";

  // 섹션 토글 목록
  const toggles = useMemo(() => {
    if (!activeSections) return [];
    return getSectionToggles(activeTemplate, activeSections);
  }, [activeTemplate, activeSections]);

  // ── 프리뷰 mount 게이트 ──
  // 파노라마 IPC 응답(20MB+ base64)이 메인 스레드 block 된 프리뷰 렌더와 경합해 영구 대기됨.
  // coverage+panorama 완료 전까지는 ReportPreviewContent 를 아예 mount 하지 않아 메인 스레드 확보.
  // panorama 'error'(전 레이더 실패)도 통과 — §4 '파노라마 계산 실패' 페이지가 도달 가능해야
  // 한다(커버리지의 done|error 게이트와 동형).
  const previewMountable = useMemo(() => {
    if (activeTemplate !== "obstacle_monthly") return true;
    if (!omData) return true;
    const covReady = omData.coverageStatus === "done" || omData.coverageStatus === "error";
    const panoReady = omData.panoramaStatus === "done" || omData.panoramaStatus === "error";
    return covReady && panoReady;
  }, [activeTemplate, omData]);

  // ── OM 준비 완료 여부 ──
  // 조건: (1) 커버리지 계산 종료 (2) 파노라마 계산 종료 — 양쪽 모두 done|error(실패 확정) 포함
  const omReady = useMemo(() => {
    if (activeTemplate !== "obstacle_monthly") return true;
    if (!omData) return false;
    const covReady = omData.coverageStatus === "done" || omData.coverageStatus === "error";
    const panoReady = omData.panoramaStatus === "done" || omData.panoramaStatus === "error";
    return covReady && panoReady;
  }, [activeTemplate, omData]);
  const omPreparing = activeTemplate === "obstacle_monthly" && !omReady;

  // ── OM 사이드바: 페이지/활성 섹션 측정 ──
  // 프리뷰 컨테이너(.bg-gray-300 overflow-auto)의 스크롤 + DOM 변화에 반응해
  //   - 전체 페이지 수
  //   - 각 toc-key 의 첫 페이지 인덱스
  //   - 현재 스크롤 위치 기준 active 페이지 / active toc-key
  // 를 갱신. rAF 스로틀로 측정 비용 최소화.
  useEffect(() => {
    if (activeTemplate !== "obstacle_monthly") return;
    if (!previewMountable) return;
    const container = previewRef.current;
    if (!container) return;

    // ── 스크롤 버벅임 근본 원인 분리 ──
    // 종전: scroll 이벤트마다(rAF 스로틀) 전체 [data-page] 를 getBoundingClientRect(O(N) 강제
    //   리플로우) + setState 4종을 실행 → 페이지가 많으면 매 스크롤 프레임이 메인 스레드를 점유해
    //   WebView2 리페인트가 끊겼다.
    // 개선: '레이아웃 측정'(오프셋/토크키/총 페이지수)은 DOM 변화(Mutation)·리사이즈 때만 계산해
    //   ref 에 캐시하고, '스크롤 핫패스'에서는 container.scrollTop(리플로우 유발 없는 단일 read) +
    //   캐시된 오프셋 배열 이진탐색으로 활성 페이지만 갱신한다. 값이 실제로 바뀔 때만 setState 해
    //   사이드바 리렌더도 최소화. (페이지엔 이미 contain:layout paint 격리가 적용됨.)
    const layout: { offsets: number[]; tocKeys: (string | null)[] } = { offsets: [], tocKeys: [] };
    let lastActiveIdx = -1;
    let lastActiveKey: string | null | undefined = undefined;
    // 재측정 시점의 콘텐츠 총 높이 — 스크롤 중 이 값이 바뀌면(차트/지도 canvas 비동기 리사이즈,
    //   편집 텍스트 reflow 등 childList 아닌 높이 변화 포함) 캐시 오프셋이 낡았다는 신호. 단일
    //   정수 read 로 감지해 자가 재측정 → 스크롤 핫패스의 저비용을 유지하면서 stale 오프셋을 치유.
    let lastScrollHeight = -1;

    // 활성 페이지 갱신 — 스크롤 핫패스. 레이아웃 read 없이 캐시 오프셋만 사용.
    const updateActive = () => {
      const offsets = layout.offsets;
      if (offsets.length === 0) return;
      // 컨테이너 상단 80px 아래 sentinel 라인 위쪽의 마지막 페이지 = active.
      const sentinel = container.scrollTop + 80;
      let lo = 0, hi = offsets.length - 1, active = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (offsets[mid] <= sentinel) { active = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      if (active !== lastActiveIdx) {
        lastActiveIdx = active;
        setOmCurrentPage(active + 1);
      }
      const key = layout.tocKeys[active] ?? null;
      if (key !== lastActiveKey) {
        lastActiveKey = key;
        setOmActiveTocKey(key);
      }
    };

    // 레이아웃 재측정 — DOM 변화/리사이즈/초기 시에만 (스크롤 경로 밖). 여기서만 O(N)
    //   getBoundingClientRect 를 수행하되, 오프셋은 현재 스크롤과 무관한 '콘텐츠 절대 오프셋'
    //   (rect.top − containerTop + scrollTop)으로 저장해 이후 스크롤이 캐시를 무효화하지 않게 한다.
    const remeasure = () => {
      const pages = Array.from(container.querySelectorAll<HTMLDivElement>("[data-page]"));
      lastScrollHeight = container.scrollHeight;
      if (pages.length === 0) {
        layout.offsets = []; layout.tocKeys = [];
        lastActiveIdx = -1; lastActiveKey = undefined;
        setOmTotalPages(0);
        setOmCurrentPage(1);
        setOmActiveTocKey(null);
        setOmTocPageMap(new Map());
        return;
      }
      const containerTop = container.getBoundingClientRect().top;
      const scrollTop = container.scrollTop;
      const offsets: number[] = new Array(pages.length);
      const tocKeys: (string | null)[] = new Array(pages.length);
      const tocMap = new Map<string, number>();
      for (let i = 0; i < pages.length; i++) {
        offsets[i] = pages[i].getBoundingClientRect().top - containerTop + scrollTop;
        // 조상 체인에서 toc-key 탐색 (페이지별 활성 토크키 + 첫 페이지 인덱스 맵)
        let el: HTMLElement | null = pages[i];
        let key: string | null = null;
        while (el && el !== container) {
          const k = el.dataset.tocKey;
          if (k) { key = k; if (!tocMap.has(k)) tocMap.set(k, i + 1); break; }
          el = el.parentElement;
        }
        tocKeys[i] = key;
      }
      layout.offsets = offsets;
      layout.tocKeys = tocKeys;
      setOmTotalPages(pages.length);
      setOmTocPageMap(tocMap);
      // 재측정 직후(스크롤 없이 콘텐츠만 변한 경우) 활성 페이지 즉시 반영
      lastActiveIdx = -1; lastActiveKey = undefined;
      updateActive();
    };

    // 스크롤: rAF 스로틀 — 캐시 오프셋 기반 활성 페이지만 갱신. 콘텐츠 총 높이가 바뀐 경우에만
    //   (드물게) O(N) 재측정, 그 외에는 scrollTop 단일 read + 이진탐색으로 레이아웃 read 0.
    let scrollRaf: number | null = null;
    const onScroll = () => {
      if (scrollRaf !== null) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = null;
        if (container.scrollHeight !== lastScrollHeight) remeasure();
        else updateActive();
      });
    };

    // DOM 변화: rAF 스로틀 재측정 (점진 마운트 중 다발 Mutation 를 1프레임 1회로 합침)
    let measureRaf: number | null = null;
    const scheduleRemeasure = () => {
      if (measureRaf !== null) return;
      measureRaf = requestAnimationFrame(() => { measureRaf = null; remeasure(); });
    };

    // 창 가장자리 리사이즈 — 컨테이너(flex-1)는 창 폭과 함께 매 프레임 크기가 바뀌지만 페이지는
    //   210mm 고정폭이라 페이지수/TOC 는 불변. 드래그가 멎은 뒤 1회만 재측정(오프셋은 컨테이너
    //   상단 기준이라 세로 배치 변화 시 갱신 필요)해 리사이즈 프레임에서 측정 경로를 분리.
    let resizeSettle: ReturnType<typeof setTimeout> | null = null;
    const scheduleResize = () => {
      if (resizeSettle !== null) clearTimeout(resizeSettle);
      resizeSettle = setTimeout(scheduleRemeasure, 150);
    };

    // 초기 측정 (DOM 안정화 시간 약간 확보)
    const initialTimer = setTimeout(remeasure, 50);

    container.addEventListener("scroll", onScroll, { passive: true });
    const mo = new MutationObserver(scheduleRemeasure);
    mo.observe(container, { childList: true, subtree: true });
    const ro = new ResizeObserver(scheduleResize);
    ro.observe(container);

    return () => {
      clearTimeout(initialTimer);
      if (resizeSettle !== null) clearTimeout(resizeSettle);
      if (scrollRaf !== null) cancelAnimationFrame(scrollRaf);
      if (measureRaf !== null) cancelAnimationFrame(measureRaf);
      container.removeEventListener("scroll", onScroll);
      mo.disconnect();
      ro.disconnect();
    };
  }, [activeTemplate, previewMountable, omReady]);

  // 사이드바 목차 클릭 → 해당 섹션 첫 페이지로 부드러운 스크롤
  const handleTocJump = useCallback((key: string) => {
    const container = previewRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>(`[data-toc-key="${key}"]`);
    if (!target) return;
    // scrollIntoView 는 부모 컨테이너(overflow:auto)에 대해 동작
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // OM 사이드바 목차 데이터
  const omTocList = useMemo<OMSidebarTocItem[]>(() => {
    if (activeTemplate !== "obstacle_monthly" || !activeSections || !omData) return [];
    const candidates: { key: string; name: string; visible: boolean }[] = [
      { key: "cover",             name: "표지",              visible: !!activeSections.cover },
      { key: "omSummary",         name: "분석 요약",         visible: !!activeSections.omSummary },
      { key: "omDailyPsrLoss",    name: "일별 PSR·표적소실", visible: !!activeSections.omDailyPsrLoss },
      { key: "omLosCrossSection", name: "장애물별 상세",     visible: !!activeSections.omLosCrossSection && omData.losMap.size > 0 },
      { key: "omLossEvents",      name: "표적소실 상세",     visible: !!activeSections.omLossEvents },
      { key: "omFindings",        name: "종합 소견",         visible: !!activeSections.omFindings },
    ];
    // 표지=00, 이후 콘텐츠 섹션은 01 부터 누적 (표지 미표시 시 첫 섹션이 01)
    let contentNum = 0;
    return candidates.filter((c) => c.visible).map((c) => ({
      key:  c.key,
      num:  c.key === "cover" ? "00" : String(++contentNum).padStart(2, "0"),
      name: c.name,
      page: omTocPageMap.get(c.key) ?? 0,
    }));
  }, [activeTemplate, activeSections, omData, omTocPageMap]);

  // OM 사이드바 표시 메타 — 발행 기간 뱃지 텍스트 ("2026년 4월" 형식)
  const omSidebarPeriod = useMemo(() => {
    const iso = omData?.analysisMonth;
    if (iso && /^\d{4}-\d{2}$/.test(iso)) {
      return `${iso.slice(0, 4)}년 ${parseInt(iso.slice(5, 7))}월`;
    }
    return coverSubtitle || undefined;
  }, [omData?.analysisMonth, coverSubtitle]);

  // 문서번호: 분석월 기반 placeholder
  const omSidebarDocNo = useMemo(() => {
    const iso = omData?.analysisMonth;
    if (iso && /^\d{4}-\d{2}$/.test(iso)) {
      return `RDR-RPT-${iso.slice(2, 4)}${iso.slice(5, 7)}-NEW`;
    }
    return "RDR-RPT-NEW";
  }, [omData?.analysisMonth]);

  // PDF 내보내기 (저장 기능 없음 — 라이브 렌더된 정적 DOM을 PrintToPdf가 스냅샷)
  const handleExportPDF = useCallback(async () => {
    if (!state || !activeSections) return;
    setGenerating(true);
    generatingRef.current = true;
    setExportError(null);
    setExportElapsed(0);
    exportTimerRef.current = setInterval(() => setExportElapsed((p) => p + 1), 1000);

    // 프리뷰가 이미 ready 상태일 때만 이 함수에 도달 (버튼 disabled 가드).
    // 라이브 렌더된 정적 DOM을 PrintToPdf가 스냅샷한다.
    // 마지막 paint 동기화로 overlay 해제 직후 레이아웃 확정.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      const dateStr = format(new Date(), "yyyyMMdd_HHmmss");
      const tplLabel = templateDisplayLabel(activeTemplate);
      const filename = `비행검사_${tplLabel}_보고서_${dateStr}.pdf`;

      const result = await exportPDF(previewRef, filename);
      if (!result.success && result.error && result.error !== "저장이 취소되었습니다") {
        setExportError(result.error);
      }
    } catch (err) {
      setExportError(`PDF 내보내기 실패: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (exportTimerRef.current) { clearInterval(exportTimerRef.current); exportTimerRef.current = null; }
      setGenerating(false);
      generatingRef.current = false;
    }
  }, [state, activeTemplate, activeSections, exportPDF]);

  // ── 장애물 월간 모달 생성 핸들러 ──
  const handleOMGenerate = useCallback(async (
    result: ObstacleMonthlyResult,
    buildings: ManualBuilding[],
    groups: BuildingGroup[],
    radars: RadarSite[],
    azMap: Map<string, AzSector[]>,
    losMap: Map<string, LoSProfileData>,
    covWith: Map<string, CoverageLayer[]>,
    covWithout: Map<string, CoverageLayer[]>,
    monthStr?: string,
  ) => {
    // 플로우 세대 — reload-config 도착 이후에도 완주하려는 stale 플로우(이전 설정의 분석)가
    // 새 세션의 보고서로 전송되는 것을 차단한다 (모달 unmount 취소 guard 를 이미 지난 경우 대비).
    const flowEpoch = loadEpochRef.current;
    // 생성 시점엔 파노라마 미준비 → addedBlockageByKey 없이 생성(추가 차단영역 프로즈 생략).
    // 파노라마 done 후 useEffect 에서 addedBlockageByKey 산출 + (미편집 시) findingsText 재생성.
    const autoFindings = generateOMFindingsText({
      radarResults: result.radar_results,
      selectedBuildings: buildings,
      radarSites: radars,
      losMap,
      covLayersWithBuildings: covWith,
      covLayersWithout: covWithout,
      analysisMonth: monthStr ?? "",
    });
    autoFindingsRef.current = autoFindings;
    // ── 커버리지 상태 확정 매핑 ──
    // 모달 흐름상 커버리지 try/catch 는 onGenerate 이전에 항상 종료된다
    // (취소 시엔 onGenerate 자체가 호출되지 않고, 성공한 레이더는 반드시 covWith 에 entry 를 남김).
    // 따라서 covWith.size===0 은 곧 전량 실패 확정 — "error" 로 매핑한다.
    // 이전의 "loading"/"idle" 매핑은 파노라마 게이트(done|error 만 통과)를 영구 차단해
    // omReady 가 영원히 false → 프리뷰 무한 로딩이 됐다. "error" 는 게이트를 통과하며,
    // 커버리지 소비처는 omFindingsGenerator(size>0 가드) 뿐이라 비교 프로즈만 생략되고
    // 보고서는 정상 생성된다.
    const coverageStatus: OMReportData["coverageStatus"] = covWith.size > 0 ? "done" : "error";
    if (coverageErrorRef.current && covWith.size > 0) {
      // 일부 레이더만 실패한 부분 실패 — 성공 레이더 데이터는 유지하고 done 으로 진행(기존 동작)
      console.warn(`[OM] 커버리지 부분 실패 — ${covWith.size}/${radars.length}개 레이더만 커버리지 보유`);
    }
    coverageErrorRef.current = false; // 이번 생성 사이클에서 소비 완료
    const newOmData: OMReportData = {
      result,
      selectedBuildings: buildings,
      buildingGroups: groups,
      selectedRadarSites: radars,
      azSectorsByRadar: azMap,
      losMap,
      covLayersWithBuildings: covWith,
      covLayersWithout: covWithout,
      analysisMonth: monthStr ?? "",
      findingsText: autoFindings,
      textOverrides: {},
      chartZooms: {},
      coverageStatus,
      panoramaStatus: "deferred",
      panoWithTargets: new Map(),
      panoWithoutTargets: new Map(),
    };

    // 풀 데이터(커버리지 레이어 + track_points_geo + az_elev_histogram)는 이 창(report 윈도우)
    // 메모리에 보관하고, 창 간 전송(IDB)에는 경량본만 실어 structured-clone 병목을 피한다.
    // 저장 기능이 없으므로 이 캐시는 라이브 세션 한정 — 로드 시 경량본 대신 이 풀버전을 사용한다.
    omDataCacheRef.current = newOmData;

    const lightResult: ObstacleMonthlyResult = {
      radar_results: result.radar_results.map((rr) => ({
        ...rr,
        daily_stats: rr.daily_stats.map((d) => ({
          ...d,
          track_points_geo: [],
          // 추가 차단영역 히스토그램(대용량 원자료)도 IDB 경량본에서 제외 — 추가 차단영역 계산은
          // omDataCacheRef(풀 버전, 메모리)로 수행되므로 IDB structured-clone 부담만 줄임.
          az_elev_histogram: [],
        })),
      })),
    };
    const lightOmData: OMReportData = {
      ...newOmData,
      result: lightResult,
      // 커버리지 레이어도 경량본에서 제외 — 레이더당 수십만 CoverageBearing 객체가 IDB 왕복
      // (보고서 창 직렬화 → IDB put → 메인 창 get/재put → 보고서 창 get)에서 4회 structured-clone
      // 되며 양 창 메인 스레드를 동시에 블로킹(백지)하고 메모리를 배가시킨다. 정상 경로에선
      // loadFromIDB 가 어차피 omDataCacheRef(풀 버전, 커버리지 포함)로 덮어쓰므로 전송분은 사용되지
      // 않는 순수 낭비. 유일 소비처인 소견 생성(omFindingsGenerator)은 size>0 가드로 안전하며,
      // 보고서 창 리로드 등 캐시 소실 경로에서도 생성 시점 findingsText(커버리지 프로즈 포함)가
      // 문자열로 이미 페이로드에 실려 있어 내용 손실이 없다.
      // coverageStatus 는 newOmData 와 동일 확정값(done|error) — 경량본이 로드되는 경로에서도
      // 파노라마 게이트가 차단되지 않도록 한다.
      covLayersWithBuildings: new Map(),
      covLayersWithout: new Map(),
    };

    // 통합 모달이 살아있는 동안에는 configPayload 를 유지 — 모달이 omReady 시점에
    // onComplete 콜백으로 setConfigPayload(null) 호출하여 unmount 시킨다.
    if (flowEpoch !== loadEpochRef.current) return; // reload 로 폐기된 플로우 — 전송하지 않음
    setLoading(true);
    setPrepPhase("waiting");
    await writeGenerateRequest({
      template: "obstacle_monthly",
      sections: { ...DEFAULT_SECTIONS },
      omData: serializeOMData(lightOmData),
    });
    if (flowEpoch !== loadEpochRef.current) {
      // write 대기 중 reload — emit/워치독 금지. 방금 쓴 stale 요청도 정리해
      // 메인 창 IDB 드레인이 이전 설정의 보고서를 생성하지 않게 한다.
      clearGenerateRequest().catch(() => { /* ignore */ });
      return;
    }
    await emit("report:generate");
    if (flowEpoch !== loadEpochRef.current) return; // emit 대기 중 reload — 워치독 미등록
    // ── transfer 워치독 ── emit 후 report:data-written 미수신(메인 창 리스너 일시 부재/
    // 이벤트 유실) 대비: 20초 간격 2회 재발신 — 메인 창은 App 셸 상시 마운트 + IDB 드레인
    // 재확인 구조라 재-emit 만으로 복구된다. 60초까지 미수신이면 에러 표시로 전환.
    // 타이머는 loadFromIDB 페이로드 수신·reload-config·data-error 에서 해제.
    clearTransferWatchdog();
    transferTimersRef.current.push(
      setTimeout(() => {
        console.warn("[OM] transfer 응답 지연 — report:generate 재발신 (1/2)");
        emit("report:generate").catch(() => { /* ignore */ });
      }, 20_000),
      setTimeout(() => {
        console.warn("[OM] transfer 응답 지연 — report:generate 재발신 (2/2)");
        emit("report:generate").catch(() => { /* ignore */ });
      }, 40_000),
      setTimeout(() => {
        setError("보고서 데이터 전송에 응답이 없습니다. 창을 닫고 다시 시도해주세요.");
        setLoading(false);
        setPrepPhase(null);
        setConfigPayload(null); // 모달(z-[9999])이 에러 화면을 덮지 않도록 닫기
      }, 60_000),
    );
  }, [clearTransferWatchdog]);

  // ── 커버리지 콜백 (모달 언마운트 후에도 동작) ──
  const handleCoverageReady = useCallback((
    covWith: Map<string, CoverageLayer[]>,
    covWithout: Map<string, CoverageLayer[]>,
  ) => {
    // 보고서 창 내부에서 직접 omData 업데이트
    setOmData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        covLayersWithBuildings: covWith,
        covLayersWithout: covWithout,
        coverageStatus: "done",
      };
    });
  }, []);

  const handleCoverageError = useCallback(() => {
    // 모달의 커버리지 catch 는 omData 생성(handleOMGenerate) 이전에 호출되므로 아래
    // setOmData 는 보통 no-op — ref 에 기록해 두고, omData 가 이미 존재하는 경로에서만 즉시 반영.
    // 전량 실패 자체는 handleOMGenerate 의 covWith.size===0 ⇒ "error" 확정 매핑이 처리한다.
    coverageErrorRef.current = true;
    setOmData((prev) => prev ? { ...prev, coverageStatus: "error" } : prev);
  }, []);

  // ── 파노라마 자동 계산 ──
  // 구조: omData.result 또는 coverageStatus 변경 시 effect 진입. ref로 동일 result 중복 실행 차단.
  // deps에 omData 전체를 넣으면 내부 setOmData(loading 진입/진행 갱신) 시 effect가 재실행되며
  // cleanup이 먼저 돌아 cancelled=true가 되고 진행 중인 invoke 결과가 전부 폐기됨 → 0/N에서 멈춤.
  // 실행 방식: 레이더별 직렬 (GPU 워커/SRTM mutex 경합 회피).
  //            레이더 내부에서는 with/without 을 단일 Rust 커맨드(dual)로 묶어 IPC 1회 처리.
  // **커버리지 게이트**: SRTM 락 경합으로 build_heightmap 이 무한 대기하는 것을 방지.
  //                    커버리지 계산(render_coverage_bitmap 등)이 SRTM mutex 를 자주 점유하므로,
  //                    coverageStatus 가 done/error 로 확정된 뒤에 파노라마 시작.
  const panoramaStartedRef = useRef<unknown>(null);
  useEffect(() => {
    if (!omData) return;
    // 동일 result 에 대해 중복 실행 방지
    if (panoramaStartedRef.current === omData.result) return;

    // 커버리지 완료 대기 — SRTM mutex 락 경합 회피
    const coverageReady = omData.coverageStatus === "done" || omData.coverageStatus === "error";
    if (!coverageReady) {
      console.log(`[Panorama] 커버리지 완료 대기 중 (status=${omData.coverageStatus}) — 파노라마 보류`);
      return;
    }

    // 레이더 없음 → 즉시 done 처리
    if (omData.selectedRadarSites.length === 0) {
      panoramaStartedRef.current = omData.result;
      if (omData.panoramaStatus !== "done") {
        setOmData((prev) => prev ? { ...prev, panoramaStatus: "done" } : prev);
      }
      return;
    }

    // 이미 완료된 omData (edit 모드 리로드 등)
    if (omData.panoramaStatus === "done") {
      panoramaStartedRef.current = omData.result;
      return;
    }

    // 실행 플래그 설정 — 이 result 에 대해 이제 책임짐
    panoramaStartedRef.current = omData.result;

    const radars = omData.selectedRadarSites;
    const excludeIds = omData.selectedBuildings.map((b) => b.id);
    console.log(`[Panorama] 시작 (${radars.length}개 레이더, GPU terrain)`, radars.map((r) => r.name));

    let cancelled = false;
    const MAX_RANGE_KM = 100;
    const AZ_STEP_DEG = 0.01;
    const RANGE_STEP_M = 200;

    (async () => {
      // loading 진입
      setOmData((prev) => prev ? { ...prev, panoramaStatus: "loading" } : prev);
      setPanoramaLastError(null);

      // GPU(heightmap+terrain)는 단일 워커/디바이스 경합으로 레이더별 직렬 실행이 안전.
      // 레이더 내 with/without 은 Rust dual 커맨드로 묶어 IPC 1회 처리.
      const { computePanoramaTerrainGPU } = await import("../utils/gpuPanorama");

      const setPhase = (index: number, name: string, phase: PanoramaPhase) => {
        phaseStartedAtRef.current = performance.now();
        setPanoramaElapsedMs(0);
        setPanoramaProgress({
          currentIndex: index,
          totalRadars: radars.length,
          currentRadarName: name,
          phase,
        });
      };

      let successCount = 0; // 전 레이더 실패(성공 0) 시 'error' 확정용

      for (let i = 0; i < radars.length; i++) {
        if (cancelled) { console.log(`[Panorama] 취소됨 — 레이더 루프 진입 전 (i=${i})`); return; }
        const radar = radars[i];
        const radarH = radar.altitude + radar.antenna_height;
        console.log(`[Panorama] === 레이더 ${i + 1}/${radars.length} 시작: ${radar.name} (h=${radarH}m, excludeIds=${excludeIds.length}) ===`);
        setPhase(i + 1, radar.name, "heightmap");
        const radarStart = performance.now();
        try {
          console.log(`[Panorama] ${radar.name}: computePanoramaTerrainGPU 호출`);
          const terrainResults = await computePanoramaTerrainGPU(
            radar.latitude, radar.longitude, radarH,
            MAX_RANGE_KM, AZ_STEP_DEG, RANGE_STEP_M,
            (phase) => {
              if (cancelled) return;
              console.log(`[Panorama] ${radar.name}: phase=${phase}`);
              setPhase(i + 1, radar.name, phase === "heightmap_done" ? "gpu" : "merge");
            },
          );
          if (cancelled) { console.log(`[Panorama] ${radar.name}: 취소됨 (terrain 후)`); return; }
          console.log(`[Panorama] ${radar.name}: terrainResults ${terrainResults.length}개, ${(performance.now() - radarStart).toFixed(0)}ms. invoke panorama_merge_buildings_dual`);

          const mergeStart = performance.now();
          // 결과(terrain 36K + 건물 실루엣 ×2, 수십 MB)는 bulk:// 파일 매개 수신 (bulkIpc.ts)
          const dualRef = await invoke<BulkRef>("panorama_merge_buildings_dual", {
            radarLat: radar.latitude,
            radarLon: radar.longitude,
            radarHeightM: radarH,
            maxRangeKm: MAX_RANGE_KM,
            terrainResults,
            excludeManualIds: excludeIds.length > 0 ? excludeIds : null,
          });
          const dual = await readBulkJson<PanoramaMergeDualResult>(dualRef);
          if (cancelled) { console.log(`[Panorama] ${radar.name}: 취소됨 (merge 후)`); return; }
          console.log(`[Panorama] ${radar.name}: merge_dual 완료 ${(performance.now() - mergeStart).toFixed(0)}ms (terrain=${dual.terrain.length}, bldg_with=${dual.buildings_with_targets.length}, bldg_without=${dual.buildings_without_targets?.length ?? "null"})`);

          // with ⊇ without 상위집합 불변식은 Rust 가 구조적으로 보장 — dual 이
          //   with = without(비대상만 컬링) ∪ 분석대상(manual_id 태깅, 비컬링) 로 반환한다.
          //   건물별 소비(핑크영역·분류·추가차단)는 panoWithForBuilding(= without ∪ {해당 건물})으로 좁힌다.
          //   (종전: with/without 독립 컬링으로 상위집합이 깨져 프론트에서 합집합 복원하던 우회 로직 제거)
          const withResult: PanoramaMergeResult = {
            terrain: dual.terrain,
            buildings: dual.buildings_with_targets,
          };
          const withoutResult: PanoramaMergeResult | null = dual.buildings_without_targets
            ? { terrain: dual.terrain, buildings: dual.buildings_without_targets }
            : null;

          // 점진 업데이트: prev Map 에 이번 레이더 결과만 추가 (O(N²) 복제 제거)
          const radarName = radar.name;
          setOmData((prev) => {
            if (!prev) return prev;
            const nextWith = new Map(prev.panoWithTargets);
            nextWith.set(radarName, withResult);
            let nextWithout = prev.panoWithoutTargets;
            if (withoutResult) {
              nextWithout = new Map(prev.panoWithoutTargets);
              nextWithout.set(radarName, withoutResult);
            }
            return {
              ...prev,
              panoWithTargets: nextWith,
              panoWithoutTargets: nextWithout,
            };
          });
          successCount += 1;
          console.log(`[Panorama] ${radar.name} 완료 (총 ${(performance.now() - radarStart).toFixed(0)}ms)`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[Panorama] ${radar.name} 실패:`, err);
          setPanoramaLastError(`${radar.name}: ${msg}`);
        }
      }

      if (cancelled) { console.log("[Panorama] 취소됨 — 루프 종료 직후"); return; }
      // 전 레이더 실패(성공 0건) → 'error' — previewMountable/omReady 게이트가 error 도
      // 통과시키므로 ReportPreviewContent 의 §4 '파노라마 계산 실패' 페이지가 실제로 렌더된다.
      // 일부만 실패한 경우는 기존대로 done — §2/§4 는 해당 레이더를 '—' 처리.
      const finalStatus: OMReportData["panoramaStatus"] = successCount === 0 ? "error" : "done";
      console.log(`[Panorama] 전체 완료 — panoramaStatus ${finalStatus} 전환 (성공 ${successCount}/${radars.length})`);
      setPanoramaProgress(null);
      startTransition(() => {
        setOmData((prev) => prev ? { ...prev, panoramaStatus: finalStatus } : prev);
      });
    })();

    return () => {
      console.log("[Panorama] effect cleanup — cancelled=true");
      cancelled = true;
      setPanoramaProgress(null);
    };
  }, [omData?.result, omData?.coverageStatus]);

  // ── 추가 차단영역 소실율 산출 ──
  // 파노라마 done 후 1회: Rust az×elev 히스토그램(풀 result)을 건물별 컷오프로 슬라이스해 addedBlockageByKey 산출.
  // 미편집 findingsText 는 추가 차단영역 프로즈 포함해 재생성(autoFindingsRef 비교로 사용자 편집 보호).
  // addedBlockageByKey 는 라이브 세션에서만 산출·소비된다(저장/직렬화 대상 아님). 히스토그램이 비면(방어) 계산을
  // 건너뛰지만, 정상 생성 경로에선 풀 result 가 omDataCacheRef 로 유지되므로 항상 산출된다.
  // 실행 방식: (레이더×건물) 쌍 단위 비동기 yield — 쌍당 전 히스토그램 셀 × 파노라마 샘플러 순회라
  //   동기 일괄 실행 시 다건물 구성에서 메인 스레드가 수 초~수십 초 블로킹(백지)된다. startedRef 로
  //   동일 result 중복 실행을 차단하고(진행 중 setOmData 재진입 대비), 최종 커밋은 result 동일성을
  //   검사해 reload 로 폐기된 stale 산출이 새 보고서에 병합되지 않게 한다.
  const addedBlockageStartedRef = useRef<unknown>(null);
  // 산출 진행 중 여부 — 프리뷰에 [data-om-computing] 센티널로 노출되어 PDF 내보내기
  // (useReportExport)가 산출 완료를 대기한다. 파노라마 done 순간 내보내기 버튼은 이미 활성이므로,
  // 게이트가 없으면 산출 중 인쇄된 PDF 에서 §1 추가소실율·§3 심각도·소견 프로즈가 통째로 빠진다.
  const [addedBlockageComputing, setAddedBlockageComputing] = useState(false);
  useEffect(() => {
    if (!omData || omData.panoramaStatus !== "done") return;
    if (omData.addedBlockageByKey) return; // 이미 산출됨(빈 {} 포함) — 재계산해도 동일 결과라 무한 setOmData 루프 방지
    const result = omData.result;
    if (!result) return;
    if (addedBlockageStartedRef.current === result) return; // 동일 result 에 대해 이미 산출 진행 중
    const hasHist = result.radar_results.some((rr) =>
      rr.daily_stats.some((d) => (d.az_elev_histogram?.length ?? 0) > 0));
    if (!hasHist) return; // 히스토그램 없음(리로드 등) → 계산 불가
    addedBlockageStartedRef.current = result;
    setAddedBlockageComputing(true);

    const flowEpoch = loadEpochRef.current;
    const radars = omData.selectedRadarSites;
    const buildings = omData.selectedBuildings;
    const panoWithTargets = omData.panoWithTargets;
    const panoWithoutTargets = omData.panoWithoutTargets;

    (async () => {
      try {
        const addedBlockageByKey: Record<string, AddedBlockageResult> = {};
        // 'LoS 영향' 판정 — §1 요약표·§3 단면도 헤드라인 배지와 동일 기준(hasBldgEffectFromPanorama):
        //   대상 건물이 기존 지형·지물(without) 위로 추가 차단각을 형성하는가. key = losMap 키.
        //   소견 'LoS 영향' 프로즈가 §1 열·§3 배지와 동일 판정을 쓰도록 통일. 판정 불가(null)는 미수록.
        const hasBldgEffectByKey = new Map<string, boolean>();
        for (const radar of radars) {
          const rr = result.radar_results.find((r) => r.radar_name === radar.name);
          if (!rr) continue;
          const histByDay = rr.daily_stats.map((d) => ({ day: d.day_of_month, cells: d.az_elev_histogram ?? [] }));
          const pWith = panoWithTargets.get(radar.name);
          const pWithout = panoWithoutTargets.get(radar.name);
          for (const b of buildings) {
            if (flowEpoch !== loadEpochRef.current) return; // reload — stale 산출 폐기
            const extent = calcBuildingAzExtent(radar.latitude, radar.longitude, b);
            const key = `${radar.name}_${b.id}`;
            // 건물별 with(= without ∪ {해당 건물}) — 방위 중첩 인접 분석 대상의 차단이 이 건물의
            //   추가 차단영역(노출/소실)에 중복 귀속되지 않는다 (차트 핑크영역·분류와 동일 필터).
            addedBlockageByKey[key] = computeAddedBlockage(
              histByDay, panoWithForBuilding(pWith, pWithout, b.id), pWithout, extent,
            );
            const eff = hasBldgEffectFromPanorama(radar, b, pWith, pWithout);
            if (eff !== null) hasBldgEffectByKey.set(key, eff);
            // 쌍 사이 이벤트 루프 양보 — 프리뷰 점진 마운트/페인트와 교차 실행
            await new Promise((r) => setTimeout(r, 0));
          }
        }
        if (flowEpoch !== loadEpochRef.current) return; // reload — stale 산출 폐기

        setOmData((prev) => {
          if (!prev || prev.result !== result) return prev; // 새 보고서로 교체됨 — stale 병합 금지
          let nextFindings = prev.findingsText;
          // 사용자 미편집(자동 생성 그대로)일 때만 추가 차단영역 프로즈 포함 재생성
          if (prev.findingsText === autoFindingsRef.current) {
            const regen = generateOMFindingsText({
              radarResults: prev.result?.radar_results ?? [],
              selectedBuildings: prev.selectedBuildings,
              radarSites: prev.selectedRadarSites,
              losMap: prev.losMap,
              covLayersWithBuildings: prev.covLayersWithBuildings,
              covLayersWithout: prev.covLayersWithout,
              analysisMonth: prev.analysisMonth,
              addedBlockageByKey,
              hasBldgEffectByKey,
            });
            autoFindingsRef.current = regen;
            nextFindings = regen;
          }
          return { ...prev, addedBlockageByKey, findingsText: nextFindings };
        });
      } catch (err) {
        // fire-and-forget 비동기라 catch 없으면 조용한 unhandledrejection(운영 빌드에선 무표시)이 되고
        // startedRef 가 이 result 에 영구 래치되어 재시도도 불가 — 빈 {} 를 종결 상태로 커밋한다
        // (line 상단 가드가 빈 {} 포함을 '산출 완료'로 취급, 소비처는 키 부재를 '판정 불가'로 표시).
        console.error("[AddedBlockage] 산출 실패 — 추가 차단영역 지표 없이 진행:", err);
        if (flowEpoch === loadEpochRef.current) {
          setOmData((prev) =>
            !prev || prev.result !== result || prev.addedBlockageByKey
              ? prev
              : { ...prev, addedBlockageByKey: {} });
        }
      } finally {
        // 모든 종료 경로(정상 커밋·reload 폐기·예외)에서 센티널 해제 — PDF 게이트 영구 대기 방지
        setAddedBlockageComputing(false);
      }
    })();
  }, [omData]);

  // ── 프리뷰 '완전 준비' 판정 ──
  // omReady(커버리지+파노라마 종료)에 더해, §3 상세 페이지 전량 마운트(!previewDetailMounting)와
  // 추가 차단영역 산출 완료(!addedBlockageComputing)까지 갖춰져야 진짜 완성. 이 시점에만 모달을 닫아
  // 프리뷰를 노출하면, 사용자는 '페이지가 튀어나오고 수치가 뒤늦게 채워지는' 과도기를 보지 않는다.
  //   forceReveal(폴백 타이머)로 신호가 끝내 안 풀려도 결국 노출되게 한다.
  // 구조 준비 — §3 상세 페이지 전량 마운트 + 추가 차단영역 산출 완료. 이 시점에 전 도면 canvas 가
  //   DOM 에 존재하므로 비로소 지도 타일 로딩(previewMapsLoading)을 관측할 수 있다(아래 폴링 게이트).
  const structureReady = omReady && !previewDetailMounting && !addedBlockageComputing;
  // 완전 준비 — 구조에 더해 §3·§4 도면 타일까지 자가치유 확정(complete)돼야 진짜 완성. '일부만
  //   로딩된(회색 조각) 지도'가 노출되는 것을 막는다(PDF 게이트 useReportExport 의 healWindow 와 동형).
  const structurallyReady = structureReady && !previewMapsLoading;
  const fullyReady = activeTemplate !== "obstacle_monthly" || structurallyReady || forceReveal;
  // finalizing — 파노라마는 끝났으나 아직 렌더/산출/타일로딩 중(모달의 마지막 '보고서 렌더링' 스테이지 표시용)
  const finalizing = activeTemplate === "obstacle_monthly" && omReady && !fullyReady;
  const finalizeDetail = addedBlockageComputing
    ? "추가 차단영역 지표 산출 중..."
    : previewDetailMounting
      ? "장애물별 상세 페이지 배치 중..."
      : previewMapsLoading
        ? "지도 타일 로딩 중..."
        : "마무리 중...";

  // ── 프리뷰 도면 타일 로딩 게이트 ──
  // structureReady 가 되면 §3·§4 도면 canvas 가 모두 DOM 에 존재한다. 이때부터 각 도면의 CARTO 타일
  // 자가치유 확정(data-map-complete="true")까지 폴링해 previewMapsLoading 을 내린다. composeTiles 는
  // 미수신 타일을 백그라운드 재시도(진행 기반 적응형, 최대 MAX_ROUNDS 회)로 채운 뒤, 오프라인/심각
  // 혼잡이면 잔여 구멍을 사선 해치로 마감한 뒤 complete 로 확정하므로(무한대기 없음), 이 게이트는
  // 최악에도 재시도 스케줄(≈30초) 안에 해제된다(+아래 120초 forceReveal 백스톱). 구조 준비 전에는
  // canvas 가 아직 다 마운트되지 않아 폴링을 시작하지 않는다(일부 canvas 만 존재하는 순간의 조기 통과
  // 방지). 도면 섹션이 전부 off 면 canvas 0개 → 공허참으로 즉시 통과. 이 게이트는 composeTiles/타일풀/
  // 재시도 상한을 건드리지 않고 data-map-complete 만 관측한다(healgate 불변식 준수).
  useEffect(() => {
    if (activeTemplate !== "obstacle_monthly") { setPreviewMapsLoading(false); return; }
    if (!structureReady) { setPreviewMapsLoading(true); return; }
    const container = previewRef.current;
    const allMapsComplete = () => {
      if (!container) return false;
      const canvases = container.querySelectorAll<HTMLCanvasElement>("canvas[data-map-canvas]");
      for (const c of canvases) if (c.getAttribute("data-map-complete") !== "true") return false;
      return true;
    };
    if (allMapsComplete()) { setPreviewMapsLoading(false); return; }
    const id = setInterval(() => {
      if (allMapsComplete()) { setPreviewMapsLoading(false); clearInterval(id); }
    }, 200);
    return () => clearInterval(id);
  }, [activeTemplate, structureReady]);

  // 폴백 리빌 타이머 — omReady(파노라마 종료) 후 상세 마운트/추가차단 산출/도면 타일 로딩은 결정적으로
  // 끝나지만, 만일의 행잉(타일 서버 무응답 등)에 대비해 최대 대기 상한을 둔다(모달 영구 정지 방지).
  // structurallyReady 는 이제 지도 타일 완료(!previewMapsLoading)까지 포함하므로, 타일 로딩 중에도
  // 타이머가 유지된다. fullyReady 달성 시/omReady 해제(reload)·언마운트 시 타이머 해제. 이미 fullyReady 면 불필요.
  useEffect(() => {
    if (activeTemplate !== "obstacle_monthly") return;
    if (!omReady || structurallyReady || forceReveal) return;
    const t = setTimeout(() => {
      console.warn("[OM] 완전 준비 대기 상한(120초) 도달 — 프리뷰 강제 노출");
      setForceReveal(true);
    }, 120_000);
    return () => clearTimeout(t);
  }, [activeTemplate, omReady, structurallyReady, forceReveal]);

  // ── 통합 OM 모달 (전체 prep 라이프사이클을 가로지름) ──
  // configPayload 가 obstacle_monthly 인 동안 항상 마운트되며, 모달이 fullyReady 시점에
  // onComplete 콜백으로 configPayload 를 비워야 unmount 된다.
  const omFlowActive = configPayload?.template === "obstacle_monthly";
  const omModal = omFlowActive && configPayload ? (
    <ObstacleMonthlyConfigModal
      key={configEpoch} // reload-config 시 세대 증가 → 강제 리마운트(이전 플로우 로컬 상태 초기화)
      customRadarSites={configPayload.customRadarSites}
      aircraft={configPayload.aircraft}
      metadata={configPayload.metadata}
      onClose={() => appWindow.destroy()}
      onGenerate={handleOMGenerate}
      onCoverageReady={handleCoverageReady}
      onCoverageError={handleCoverageError}
      coverageStatus={omData?.coverageStatus}
      panoramaStatus={omData?.panoramaStatus}
      panoramaProgress={panoramaProgress}
      panoramaElapsedMs={panoramaElapsedMs}
      panoramaLastError={panoramaLastError}
      omReady={fullyReady}
      finalizing={finalizing}
      finalizeDetail={finalizeDetail}
      onComplete={() => setConfigPayload(null)}
    />
  ) : null;

  // ── 분기별 배경 컨텐츠 결정 ──
  // 핵심 원칙: omModal 은 항상 같은 React 트리 위치(fragment 의 두 번째 자식)에 렌더되어야
  // 분기 전환(설정→로딩→메인) 시에도 unmount/remount 되지 않고 step/analyzing 등 로컬
  // state 가 보존된다. 따라서 모든 return 은 `<>{branchContent}{omModal}</>` 패턴.
  const phaseMessage = prepPhase === "waiting"
    ? "보고서 데이터 준비 중..."
    : prepPhase === "loading"
      ? "데이터 로딩 중..."
      : "보고서 데이터 로딩 중...";

  // 로딩/에러 화면 — state/omData 가 아직 없을 때
  if (loading || error || !state || !activeSections || !omData) {
    return (
      <>
        <div className="flex h-screen flex-col bg-white">
          <SourceOverlay />
          <Titlebar controlsOnly />
          <div className="flex flex-1 items-center justify-center">
            {error ? (
              <div className="flex flex-col items-center gap-3">
                <p className="text-sm text-red-500">{error}</p>
                {/* close() 는 onCloseRequested 가 가로채 확인 모달을 열지만, 이 분기(early return)에는
                    확인 모달이 렌더되지 않아 영구 무반응이 된다 — 에러 화면은 잃을 편집본이 없으므로
                    잔여 분석 취소 후 즉시 destroy. */}
                <button
                  onClick={() => { invoke("cancel_analysis").catch(() => { /* ignore */ }); appWindow.destroy(); }}
                  className="rounded-lg border border-gray-200 px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-100"
                >
                  닫기
                </button>
              </div>
            ) : !omFlowActive ? (
              <div className="flex flex-col items-center gap-3">
                <Loader2 size={24} className="animate-spin text-[#a60739]" />
                <p className="text-sm text-gray-500">{phaseMessage}</p>
              </div>
            ) : null}
          </div>
        </div>
        {omModal}
      </>
    );
  }

  // 표지·머리말에 적용할 메타데이터 — 설정 모달 편집본(metadata)이 있으면 우선.
  const effectiveMetadata = metadata ?? state.reportMetadata;

  // 설정 모달용 표시 섹션 토글 목록
  const settingsToggles = toggles.map((s) => ({
    key: s.key as string,
    label: s.label,
    active: !!activeSections[s.key],
    onToggle: () => setSections((prev) => prev ? { ...prev, [s.key]: !prev[s.key] } : prev),
  }));

  // ── 닫기 확인 모달 (공통) ──
  const closeConfirmModal = closeConfirmOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-sm rounded-xl border border-gray-200 bg-white shadow-xl">
            <div className="flex flex-col items-center gap-3 px-6 pt-6 pb-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-100">
                <TriangleAlert size={20} className="text-amber-600" />
              </div>
              <h3 className="text-base font-semibold text-gray-800">보고서 닫기</h3>
              <p className="text-center text-sm text-gray-500">
                보고서 창을 닫으시겠습니까?<br />
                이 보고서는 저장되지 않으며, 닫으면 편집 내용이 사라집니다.
              </p>
            </div>
            <div className="flex gap-2 border-t border-gray-200 px-6 py-4">
              <button
                onClick={() => setCloseConfirmOpen(false)}
                className="flex-1 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100"
              >
                취소
              </button>
              <button
                onClick={() => { setCloseConfirmOpen(false); appWindow.destroy(); }}
                className="flex-1 rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#85062e]"
              >
                닫기
              </button>
            </div>
          </div>
        </div>
  );


  // ── 보고서 프리뷰 (공통) ──
  // coverage+panorama 완료 전에는 mount 자체를 안 함.
  // 파노라마 IPC 응답(20MB+)이 프리뷰 렌더/이미지 로드와 경합해 영구 대기되는 문제 회피.
  // PDF 는 WebView2 PrintToPdf 단일 경로(useReportExport, 폴백 없음)가 라이브 렌더된 DOM 을
  // 그대로 스냅샷하므로, 프리뷰를 visibility:hidden/display:none 으로 숨겨두면 인쇄물에서도
  // 빠진다 — 숨김 대신 '완료 전 조건부 mount' 게이트를 사용한다.
  const previewBlock = previewMountable ? (
    <div
      className="flex flex-1 min-h-0"
      aria-hidden={omPreparing}
    >
      <ReportPreviewContent
        template={activeTemplate}
        sections={activeSections}
        radarSite={state.radarSite}
        reportMetadata={effectiveMetadata}
        omData={omData}
        omResult={omData?.result ?? null}
        onOmDataChange={(updater) => setOmData((prev) => prev ? updater(prev) : prev)}
        previewRef={previewRef}
        omComputing={addedBlockageComputing}
        onMountingChange={handleMountingChange}
      />
    </div>
  ) : null;

  // ── 최종 셸 ──
  // OM 보고서: 좌측 사이드바(192px) + 우측(타이틀바 + 프리뷰).
  return (
      <>
        <div className="relative flex h-screen flex-row bg-white">
          <SourceOverlay />

          {/* 좌측: OM 사이드바 (192px) — 기존 타이틀바의 토글/상태 chip 도 모두 흡수 */}
          <ReportOMSidebar
            docPeriod={omSidebarPeriod}
            docTitle={coverTitle || "장애물 월간 분석 보고서"}
            docNo={omSidebarDocNo}
            agency={effectiveMetadata?.organization || undefined}
            periodIso={omData?.analysisMonth || undefined}
            toc={omTocList}
            activeKey={omActiveTocKey}
            currentPage={omCurrentPage}
            totalPages={omTotalPages}
            onJump={handleTocJump}
            onOpenSettings={() => setSettingsOpen(true)}
            exportError={exportError}
            onSave={() => setExportOpen(true)}
            generating={generating}
            disabled={generating || omPreparing}
            disabledTitle={omPreparing ? "섹션 준비 중..." : undefined}
            elapsedSec={exportElapsed}
          />

          {/* 우측 1px 구분선 — top-8(=32px) 아래로만 그어 (이제 사실상 사이드바와 프리뷰의 경계).
              상단 32px 는 타이틀바와 사이드바 브랜드 헤더가 하나의 헤더 스트립처럼 흐른다. */}
          <div className="relative w-px shrink-0">
            <div className="absolute left-0 top-8 bottom-0 w-px bg-gray-200" />
          </div>

          {/* 우측: 타이틀바(윈도우 컨트롤만) + 프리뷰.
              기능(섹션 토글, 상태 chip, PDF 버튼)은 모두 좌측 사이드바로 이관됨.
              타이틀바 자체는 noBorder — 상단 32px 가 사이드바 브랜드 헤더와 하나의
              헤더 스트립처럼 흐르도록 한다. 그 밑(사이드바와 연결되지 않은 콘텐츠
              영역)에만 border-t 를 그어, 메인 창(App.tsx 의 <main border-t>)과 동일한
              헤더 경계선을 만든다. border-t 는 y=32 에 위치해 좌측 세로 구분선(top-8)과
              모서리에서 정확히 맞물린다. */}
          <div className="relative flex flex-1 flex-col min-w-0">
            <Titlebar controlsOnly noBorder />

            <div className="flex flex-1 flex-col min-h-0 border-t border-gray-200">
              {previewBlock}
            </div>
          </div>

          {closeConfirmModal}

          {/* 표시 섹션 + 메타데이터 설정 모달 */}
          <ReportSettingsModal
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            sectionToggles={settingsToggles}
            metadata={effectiveMetadata}
            onMetadataChange={(patch) =>
              setMetadata((prev) => ({ ...(prev ?? state.reportMetadata), ...patch }))
            }
          />

          {/* PDF 내보내기 옵션 모달 — 확인 시 실제 내보내기 트리거 */}
          <ReportPdfExportModal
            open={exportOpen}
            onClose={() => setExportOpen(false)}
            totalPages={omTotalPages}
            onConfirm={() => { setExportOpen(false); handleExportPDF(); }}
          />
        </div>
        {/* 통합 OM 모달 — fragment 의 두 번째 자식 위치에 고정. 모든 분기에서 같은 트리
            위치에 마운트되어 step/analyzing 등 로컬 state 가 분기 전환 시 보존된다. */}
        {omModal}
      </>
  );
}
