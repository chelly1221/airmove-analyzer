/**
 * PDF 내보내기 확인 모달 (OM 사이드바 — "PDF로 저장" 클릭 시)
 *
 * 출력은 WebView2 PrintToPdf 로 @page 210×297mm(A4) 고정·전체 페이지.
 * 용지(A3)·페이지 범위 선택은 A4 고정 레이아웃상 의미가 없어 제거했다(과거 비동작 옵션 정리).
 * 진행/에러 피드백은 사이드바 PDF 버튼·타이틀바에 표시되므로 이 모달은 확인만 담당한다.
 */
import { Download } from "lucide-react";
import Modal from "../common/Modal";

interface ReportPdfExportModalProps {
  open: boolean;
  onClose: () => void;
  /** 전체 페이지 수 (안내 표기용) */
  totalPages: number;
  /** 내보내기 실행 (상위에서 모달 닫기 + PDF 생성) */
  onConfirm: () => void;
}

export default function ReportPdfExportModal({ open, onClose, totalPages, onConfirm }: ReportPdfExportModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="PDF 내보내기" width="max-w-sm">
      <div className="flex flex-col gap-4">
        <p className="text-sm leading-relaxed text-gray-600">
          보고서 {totalPages > 0 ? `전체 ${totalPages}페이지` : "전체 페이지"}를 A4 PDF로 저장합니다.
          저장 위치를 선택하면 생성이 시작됩니다.
        </p>

        {/* 액션 */}
        <div className="flex gap-2 border-t border-gray-100 pt-4">
          <button
            onClick={onClose}
            className="flex-1 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100"
          >
            취소
          </button>
          <button
            onClick={onConfirm}
            className="flex flex-[1.5] items-center justify-center gap-1.5 rounded-lg bg-[#a60739] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#85062e]"
          >
            <Download size={14} />
            PDF로 저장
          </button>
        </div>
      </div>
    </Modal>
  );
}
