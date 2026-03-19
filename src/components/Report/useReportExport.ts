import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

export interface ExportResult {
  success: boolean;
  error?: string;
  /** 생성된 PDF base64 (DB 저장용) */
  pdfBase64?: string;
}

/** WebView2 네이티브 PrintToPdf — 벡터 PDF, GPU 가속
 *
 * DOM 직접 조작 방식:
 * 1. 보고서 [data-page] 요소들을 body 직속 래퍼로 이동
 * 2. 기존 body 자식 요소 전부 숨김
 * 3. CDP Page.printToPDF 호출
 * 4. DOM 원복
 */
async function exportViaNative(
  containerRef: React.RefObject<HTMLDivElement | null>,
  savePath: string,
): Promise<ExportResult> {
  if (!containerRef.current) {
    return { success: false, error: "미리보기 컨테이너를 찾을 수 없습니다" };
  }

  const container = containerRef.current;
  const pages = container.querySelectorAll<HTMLDivElement>("[data-page]");
  if (pages.length === 0) {
    return { success: false, error: "보고서 페이지가 없습니다" };
  }

  // 1. 프린트 래퍼 생성 (body 직속)
  const wrapper = document.createElement("div");
  wrapper.id = "__print-wrapper__";

  // 2. 페이지 요소들을 래퍼로 이동 (원래 부모 컨테이너 기록)
  const pageArray = Array.from(pages);
  pageArray.forEach((page) => wrapper.appendChild(page));

  // 3. 기존 body 자식 전부 숨김
  const bodyChildren = Array.from(document.body.children) as HTMLElement[];
  bodyChildren.forEach((el) => el.style.setProperty("display", "none", "important"));

  // 4. 래퍼를 body에 추가
  document.body.appendChild(wrapper);

  // 5. 인쇄 전용 스타일 주입
  const styleEl = document.createElement("style");
  styleEl.textContent = `
    @page {
      size: 210mm 297mm;
      margin: 0;
    }
    html, body {
      margin: 0 !important;
      padding: 0 !important;
      overflow: visible !important;
    }
    #__print-wrapper__ {
      background: white;
    }
    #__print-wrapper__ [data-page] {
      page-break-after: always;
      break-after: page;
      width: 210mm !important;
      min-height: 297mm !important;
      margin: 0 !important;
      box-shadow: none !important;
      overflow: hidden;
    }
    #__print-wrapper__ [data-page]:last-child {
      page-break-after: auto;
      break-after: auto;
    }
    * {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
  `;
  document.head.appendChild(styleEl);

  // 렌더링 안정화 대기
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  try {
    // WebView2 PrintToPdf IPC 호출 — base64 PDF 반환
    const pdfBase64 = await invoke<string>("webview_print_to_pdf", { path: savePath });

    return { success: true, pdfBase64 };
  } catch (err) {
    return {
      success: false,
      error: `WebView2 PDF 생성 실패: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    // DOM 원복
    styleEl.remove();
    bodyChildren.forEach((el) => el.style.removeProperty("display"));
    // 페이지를 원래 컨테이너로 복원
    pageArray.forEach((page) => container.appendChild(page));
    wrapper.remove();
  }
}

export function useReportExport() {
  const exportPDF = useCallback(
    async (
      containerRef: React.RefObject<HTMLDivElement | null>,
      defaultFilename: string,
    ): Promise<ExportResult> => {
      // 저장 경로 먼저 선택
      const savePath = await save({
        defaultPath: defaultFilename,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });

      if (!savePath) {
        return { success: false, error: "저장이 취소되었습니다" };
      }

      return exportViaNative(containerRef, savePath);
    },
    []
  );

  return { exportPDF };
}
