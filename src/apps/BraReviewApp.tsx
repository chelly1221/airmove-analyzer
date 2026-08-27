/**
 * 전파영향성 검토 의견서 창 — 별도 Tauri 윈도우 (label: "bra-review").
 *
 * TrackMap 건축물정보 드로어에서 선택한 건물 1동의 입력(좌표·높이·지반고·대장 속성)을
 * IndexedDB 로 전달받아 **이 창에서 직접 분석**(fetch_elevation / query_buildings_along_path /
 * query_nearby_peaks)한 뒤 A4 문서로 미리보기하고 PDF(WebView2 PrintToPdf)로 저장한다.
 *
 * 프레임 규약(산식 단일 원천 = utils/braReviewAnalysis.ts):
 *   BRA 제한고도 = 실제지구 기하(4/3 미적용) / LoS 차폐 = 4/3 유효지구 / 단면도 표시 = 실제지구 프레임.
 *
 * OM 보고서 창(ReportApp)과는 완전히 분리된 창이다 — 재사용은 표현 계층(ReportPage/AutoPaginate/
 * OMEditable/useReportExport/ReportPdfExportModal/Titlebar)과 `.kac-report` 토큰뿐.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { format } from "date-fns";
import { Loader2, TriangleAlert, RefreshCw, FileDown } from "lucide-react";
import Titlebar from "../components/Layout/Titlebar";
import ReportPage, { ReportPageHeaderProvider } from "../components/Report/ReportPage";
import { OMEditProvider } from "../components/Report/OMEditable";
import ReportPdfExportModal from "../components/Report/ReportPdfExportModal";
import { useReportExport } from "../components/Report/useReportExport";
import BraReviewDocument from "../components/Report/BraReview/BraReviewDocument";
import { readBraReviewPayload } from "../utils/reportTransfer";
import { analyzeBraReview, type BraReviewPayload, type BraReviewResult } from "../utils/braReviewAnalysis";
import { useAppStore } from "../store";
import type { ReportMetadata } from "../types";
import SourceOverlay from "../dev/SourceOverlay";

const appWindow = getCurrentWindow();

type Phase = "loading" | "analyzing" | "ready" | "error";

export default function BraReviewApp() {
  const [payload, setPayload] = useState<BraReviewPayload | null>(null);
  const [result, setResult] = useState<BraReviewResult | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<ReportMetadata>(() => useAppStore.getState().reportMetadata);
  /** 인라인 편집 오버라이드 (편집키 → 사용자 문구). 대상 건물이 바뀌면 초기화 */
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [exportOpen, setExportOpen] = useState(false);
  const [totalPages, setTotalPages] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);

  const previewRef = useRef<HTMLDivElement>(null);
  const exportingRef = useRef(false);
  /** 마지막으로 분석한 대상 키 — 동일하면 편집본 유지 */
  const buildingKeyRef = useRef<string | null>(null);
  /** 재로드 레이스 방지 세대 */
  const runSeqRef = useRef(0);
  const { exportPDF } = useReportExport();

  // ── 페이로드 로드 + 분석 ──
  const load = useCallback(async () => {
    const seq = ++runSeqRef.current;
    setPhase("loading");
    setErrorMsg(null);
    try {
      const p = await readBraReviewPayload();
      if (seq !== runSeqRef.current) return;
      if (!p) {
        setPhase("error");
        setErrorMsg("전달 데이터 없음 — TrackMap 건축물정보 드로어에서 「전파영향성 검토 의견서」를 다시 실행하세요.");
        return;
      }
      // 보고서 메타데이터 — DB 설정 우선, 없으면 스토어 기본값 (App.tsx:63-80 패턴)
      try {
        const raw = await invoke<string | null>("load_setting", { key: "report_metadata" });
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<ReportMetadata>;
          if (seq === runSeqRef.current) {
            setMetadata({ ...useAppStore.getState().reportMetadata, ...parsed });
          }
        }
      } catch {
        // 설정 미저장/파싱 실패 — 스토어 기본 메타데이터를 그대로 사용
      }
      if (seq !== runSeqRef.current) return;
      if (buildingKeyRef.current !== p.buildingKey) {
        setOverrides({});
        buildingKeyRef.current = p.buildingKey;
      }
      setPayload(p);
      setPhase("analyzing");
      const r = await analyzeBraReview(p);
      if (seq !== runSeqRef.current) return;
      setResult(r);
      setPhase("ready");
    } catch (e) {
      if (seq !== runSeqRef.current) return;
      setResult(null);
      setPhase("error");
      setErrorMsg(`분석 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // TrackMap 에서 같은 창을 재사용해 다시 열 때 (brareview:reload) — 페이로드 재로드 + 재분석
  useEffect(() => {
    const un = listen("brareview:reload", () => { void load(); });
    return () => { un.then((f) => f()); };
  }, [load]);

  // 닫기 확인 — 편집 내용은 저장되지 않으므로 확인 모달을 거친다 (ReportApp 과 동일 문구)
  useEffect(() => {
    const un = appWindow.onCloseRequested((event) => {
      event.preventDefault();
      if (exportingRef.current) return; // PDF 생성 중에는 닫기 무시
      setCloseConfirmOpen(true);
    });
    return () => { un.then((f) => f()); };
  }, []);

  const onOverride = useCallback((key: string, value: string | null) => {
    setOverrides((prev) => {
      const next = { ...prev };
      if (value == null) delete next[key];
      else next[key] = value;
      return next;
    });
  }, []);

  const editCtx = useMemo(() => ({
    editable: true,
    overrides,
    onOverride,
    chartZooms: {} as Record<string, [number, number]>,
    onChartZoom: () => { /* 의견서 단면도는 줌 편집 대상 아님 */ },
  }), [overrides, onOverride]);

  const pageHeaderText = `${metadata.organization}  |  전파영향성 검토 의견서`;

  const handleExport = useCallback(async () => {
    if (!payload) return;
    setExporting(true);
    exportingRef.current = true;
    setExportError(null);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      const safeName = (payload.building.name || "구조물").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40);
      const filename = `전파영향성_검토의견서_${safeName}_${format(new Date(), "yyyyMMdd")}.pdf`;
      const res = await exportPDF(previewRef, filename);
      if (!res.success && res.error && res.error !== "저장이 취소되었습니다") setExportError(res.error);
    } catch (e) {
      setExportError(`PDF 내보내기 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(false);
      exportingRef.current = false;
    }
  }, [payload, exportPDF]);

  const openExportModal = useCallback(() => {
    setTotalPages(previewRef.current?.querySelectorAll("[data-page]").length ?? 0);
    setExportOpen(true);
  }, []);

  const busy = phase === "loading" || phase === "analyzing";
  const statusText = exporting
    ? "PDF 생성 중…"
    : phase === "loading"
      ? "전달 데이터 로딩 중…"
      : phase === "analyzing"
        ? "지형·건물 단면 분석 중…"
        : null;

  return (
    <>
      <div className="flex h-screen flex-col bg-white">
        <SourceOverlay />
        <Titlebar controlsOnly>
          {/* 제목 span 에 드래그 영역 부여 — Titlebar children 래퍼엔 drag-region 이 없어 창 이동이 안 됨 */}
          <span data-tauri-drag-region className="flex-1 truncate text-[12px] font-semibold text-gray-800">
            전파영향성 검토 의견서{payload ? ` · ${payload.building.name}` : ""}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {statusText && (
              <span className="flex items-center gap-1 text-[11px] text-gray-500">
                <Loader2 size={11} className="animate-spin" /> {statusText}
              </span>
            )}
            {exportError && <span className="max-w-[280px] truncate text-[11px] text-[#e94560]">{exportError}</span>}
            <button
              onClick={() => void load()}
              disabled={busy || exporting}
              className="flex items-center gap-1 rounded-md border border-gray-200 px-2.5 py-1 text-[11px] font-medium text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-40"
            >
              <RefreshCw size={11} /> 다시 계산
            </button>
            <button
              onClick={openExportModal}
              disabled={phase !== "ready" || exporting}
              className="flex items-center gap-1 rounded-md bg-[#a60739] px-2.5 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-[#85062e] disabled:opacity-40"
            >
              <FileDown size={11} /> PDF 저장
            </button>
          </div>
        </Titlebar>

        {/* 편집 안내줄 — previewRef 밖(=인쇄 대상 제외) */}
        <div className="shrink-0 border-y border-gray-200 bg-[#f8f9fa] px-4 py-1 text-[11px] text-gray-500">
          본문을 클릭하면 바로 수정할 수 있습니다 (PDF 에 반영)
        </div>

        {phase === "error" ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="flex max-w-md flex-col items-center gap-3 px-6 text-center">
              <TriangleAlert size={22} className="text-amber-500" />
              <p className="text-sm text-red-500">{errorMsg}</p>
              <button
                onClick={() => appWindow.destroy()}
                className="rounded-lg border border-gray-200 px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-100"
              >
                닫기
              </button>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-auto bg-gray-300 py-6">
            <div ref={previewRef}>
              <ReportPageHeaderProvider value={pageHeaderText}>
                <OMEditProvider value={editCtx}>
                  <div className="kac-report">
                    {result ? (
                      <BraReviewDocument result={result} metadata={metadata} />
                    ) : (
                      <ReportPage>
                        <div className="empty">
                          <Loader2 size={22} className="animate-spin text-[#a60739]" />
                          <p className="mt-3 text-sm">{statusText ?? "준비 중…"}</p>
                        </div>
                      </ReportPage>
                    )}
                  </div>
                </OMEditProvider>
              </ReportPageHeaderProvider>
            </div>
          </div>
        )}
      </div>

      {/* 닫기 확인 — 편집본은 저장되지 않음 */}
      {closeConfirmOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-sm rounded-xl border border-gray-200 bg-white shadow-xl">
            <div className="flex flex-col items-center gap-3 px-6 pt-6 pb-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-100">
                <TriangleAlert size={20} className="text-amber-600" />
              </div>
              <h3 className="text-base font-semibold text-gray-800">의견서 닫기</h3>
              <p className="text-center text-sm text-gray-500">
                의견서 창을 닫으시겠습니까?<br />
                이 의견서는 저장되지 않으며, 닫으면 편집 내용이 사라집니다.
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
      )}

      <ReportPdfExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        totalPages={totalPages}
        onConfirm={() => { setExportOpen(false); void handleExport(); }}
      />
    </>
  );
}
