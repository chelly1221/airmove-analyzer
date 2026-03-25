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
 * DOM 숨김 방식 (페이지 이동 없음):
 * 1. 컨테이너에 프린트 래퍼 ID 부여, 내부 비페이지 요소 숨김
 * 2. 컨테이너~body 경로 외 모든 형제 요소 숨김
 * 3. CDP Page.printToPDF 호출
 * 4. 숨김 해제 (페이지가 원래 위치에 그대로 있으므로 detach 위험 없음)
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

  // 1. 컨테이너에 프린트 래퍼 ID 부여 (페이지를 이동하지 않음)
  const prevContainerId = container.id;
  container.id = "__print-wrapper__";

  // 2. 컨테이너 내부에서 [data-page] 외 요소 숨김
  const containerChildren = Array.from(container.children) as HTMLElement[];
  const hiddenContainerChildren: HTMLElement[] = [];
  containerChildren.forEach((el) => {
    if (!el.hasAttribute("data-page")) {
      hiddenContainerChildren.push(el);
      el.style.setProperty("display", "none", "important");
    }
  });

  // 3. body 자식 중 컨테이너 조상 경로 외 전부 숨김
  const hiddenBodyChildren: HTMLElement[] = [];
  const bodyChildren = Array.from(document.body.children) as HTMLElement[];
  bodyChildren.forEach((el) => {
    if (!el.contains(container) && el !== container) {
      hiddenBodyChildren.push(el);
      el.style.setProperty("display", "none", "important");
    }
  });

  // 4. 컨테이너~body 사이 조상 경로의 형제도 숨김
  const hiddenAncestorSiblings: HTMLElement[] = [];
  let ancestor: HTMLElement | null = container.parentElement;
  while (ancestor && ancestor !== document.body) {
    Array.from(ancestor.parentElement?.children ?? []).forEach((sibling) => {
      if (sibling !== ancestor && sibling instanceof HTMLElement) {
        hiddenAncestorSiblings.push(sibling);
        sibling.style.setProperty("display", "none", "important");
      }
    });
    ancestor = ancestor.parentElement;
  }

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
    // DOM 원복 — 페이지는 이동하지 않았으므로 숨김만 해제
    styleEl.remove();
    container.id = prevContainerId;
    hiddenContainerChildren.forEach((el) => el.style.removeProperty("display"));
    hiddenBodyChildren.forEach((el) => el.style.removeProperty("display"));
    hiddenAncestorSiblings.forEach((el) => el.style.removeProperty("display"));
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
