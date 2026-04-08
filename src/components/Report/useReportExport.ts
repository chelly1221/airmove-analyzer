import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save } from "@tauri-apps/plugin-dialog";

export interface ExportResult {
  success: boolean;
  error?: string;
  /** 생성된 PDF base64 (DB 저장용) — 통합 커맨드 사용 시 undefined */
  pdfBase64?: string;
}

/** 통합 커맨드에 전달할 보고서 메타데이터 */
export interface ReportSaveMeta {
  reportId: string;
  title: string;
  template: string;
  radarName: string;
  reportConfigJson: string;
  metadataJson?: string;
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
  reportMeta?: ReportSaveMeta,
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

  // DOM 복원 함수 (정상 흐름 + 비정상 종료 양쪽에서 사용)
  const restoreDOM = () => {
    styleEl.remove();
    container.id = prevContainerId;
    hiddenContainerChildren.forEach((el) => el.style.removeProperty("display"));
    hiddenBodyChildren.forEach((el) => el.style.removeProperty("display"));
    hiddenAncestorSiblings.forEach((el) => el.style.removeProperty("display"));
  };

  // 비정상 종료 시 DOM 복원 보장
  const onBeforeUnload = () => restoreDOM();
  window.addEventListener("beforeunload", onBeforeUnload);

  try {
    // 60초 타임아웃 — GPU 교착 또는 IPC 버퍼 포화 방지
    const PRINT_TIMEOUT_MS = 60_000;
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("PDF 생성 시간 초과 (60초)")), PRINT_TIMEOUT_MS),
    );

    if (reportMeta) {
      await Promise.race([
        invoke<boolean>("webview_print_and_save_report", {
          savePath,
          windowLabel: getCurrentWindow().label,
          reportId: reportMeta.reportId,
          title: reportMeta.title,
          template: reportMeta.template,
          radarName: reportMeta.radarName,
          reportConfigJson: reportMeta.reportConfigJson,
          metadataJson: reportMeta.metadataJson ?? null,
        }),
        timeoutPromise,
      ]);
      return { success: true };
    } else {
      const pdfBase64 = await Promise.race([
        invoke<string>("webview_print_to_pdf", {
          path: savePath,
          windowLabel: getCurrentWindow().label,
        }),
        timeoutPromise,
      ]);
      return { success: true, pdfBase64 };
    }
  } catch (err) {
    return {
      success: false,
      error: `WebView2 PDF 생성 실패: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    window.removeEventListener("beforeunload", onBeforeUnload);
    restoreDOM();
  }
}

export function useReportExport() {
  const exportPDF = useCallback(
    async (
      containerRef: React.RefObject<HTMLDivElement | null>,
      defaultFilename: string,
      reportMeta?: ReportSaveMeta,
    ): Promise<ExportResult> => {
      // 저장 경로 먼저 선택
      const savePath = await save({
        defaultPath: defaultFilename,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });

      if (!savePath) {
        return { success: false, error: "저장이 취소되었습니다" };
      }

      return exportViaNative(containerRef, savePath, reportMeta);
    },
    []
  );

  return { exportPDF };
}
