/**
 * PDF 내보내기 모달 (OM 사이드바 — "PDF로 저장" 클릭 시)
 *
 * 기존 사이드바에 인라인으로 있던 PDF 옵션(페이지 범위·용지)을 모달로 이관.
 * "내보내기" 클릭 시 onConfirm 으로 상위(ReportApp)의 실제 PDF 생성을 트리거한다.
 *
 * 참고: 페이지 범위·용지 옵션은 현재 출력 파이프라인(WebView2 PrintToPdf,
 * @page 210×297mm 고정·전체 페이지)에는 아직 반영되지 않는다. UI 상태만 유지.
 */
import { Download, Loader2 } from "lucide-react";
import Modal from "../common/Modal";

interface ReportPdfExportModalProps {
  open: boolean;
  onClose: () => void;
  /** PDF 페이지 범위 */
  range: "all" | "current" | "custom";
  onRangeChange: (v: "all" | "current" | "custom") => void;
  /** PDF 용지 */
  paper: "A4" | "A3";
  onPaperChange: (v: "A4" | "A3") => void;
  /** 전체 페이지 수 (범위 라벨 표기용) */
  totalPages: number;
  /** 편집 모드(재저장) 여부 — 버튼 라벨 */
  editingMode?: boolean;
  /** 내보내기 에러 텍스트 */
  exportError?: string | null;
  /** 진행 중 여부 — 버튼 비활성/스피너 */
  generating?: boolean;
  /** 내보내기 실행 (상위에서 모달 닫기 + PDF 생성) */
  onConfirm: () => void;
}

export default function ReportPdfExportModal({
  open, onClose, range, onRangeChange, paper, onPaperChange,
  totalPages, editingMode, exportError, generating, onConfirm,
}: ReportPdfExportModalProps) {
  const pageRangeLabel = totalPages > 0 ? `전체 (1–${totalPages})` : "전체";

  return (
    <Modal open={open} onClose={onClose} title="PDF 내보내기" width="max-w-sm">
      <div className="flex flex-col gap-4">
        {/* 페이지 범위 */}
        <label className="flex items-center justify-between gap-3 text-sm text-gray-700">
          <span className="shrink-0 font-medium">페이지</span>
          <div className="relative inline-flex items-center">
            <select
              value={range}
              onChange={(e) => onRangeChange(e.target.value as "all" | "current" | "custom")}
              className="h-9 min-w-[150px] cursor-pointer appearance-none rounded-lg border border-gray-200 bg-white pl-3 pr-8 text-sm text-gray-800 outline-none focus:border-[#a60739]"
            >
              <option value="all">{pageRangeLabel}</option>
              <option value="current">현재 페이지</option>
              <option value="custom">사용자 지정</option>
            </select>
            <svg
              viewBox="0 0 24 24" width={14} height={14}
              fill="none" stroke="currentColor" strokeWidth={2}
              strokeLinecap="round" strokeLinejoin="round"
              className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>
        </label>

        {/* 용지 */}
        <label className="flex items-center justify-between gap-3 text-sm text-gray-700">
          <span className="shrink-0 font-medium">용지</span>
          <div className="inline-flex h-9 items-stretch rounded-lg bg-gray-100 p-1">
            {(["A4", "A3"] as const).map((v) => {
              const active = paper === v;
              return (
                <button
                  key={v}
                  onClick={() => onPaperChange(v)}
                  className={`rounded-md px-4 text-xs font-semibold transition-colors ${
                    active
                      ? "bg-white text-gray-900 shadow-[0_1px_1px_rgba(0,0,0,0.04)]"
                      : "text-gray-500 hover:text-gray-700"
                  }`}
                >
                  {v}
                </button>
              );
            })}
          </div>
        </label>

        {exportError && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-600">
            {exportError}
          </p>
        )}

        {/* 액션 */}
        <div className="flex gap-2 border-t border-gray-100 pt-4">
          <button
            onClick={onClose}
            disabled={generating}
            className="flex-1 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-40"
          >
            취소
          </button>
          <button
            onClick={onConfirm}
            disabled={generating}
            className="flex flex-[1.5] items-center justify-center gap-1.5 rounded-lg bg-[#a60739] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#85062e] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {generating ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            {editingMode ? "PDF 재저장" : "PDF로 저장"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
