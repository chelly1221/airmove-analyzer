import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save } from "@tauri-apps/plugin-dialog";
// 자가치유 대기 창(healWindow)을 composeTiles 재시도 스케줄에서 유도하기 위한 상수
import { RETRY_MAX, RETRY_DELAY_MS, TILE_BUDGET_RETRY_MS } from "./ReportOMRadarBuildingMap";
// 인쇄 임계구간 재페이지네이션 동결 — 지도 canvas remount 로 1회 스냅샷과 어긋나는 것 차단
import { setPaginationFrozen } from "./AutoPaginate";

export interface ExportResult {
  success: boolean;
  error?: string;
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

  // 프리뷰 준비 센티널 대기 — 진행 중 인쇄하면 콘텐츠가 통째로 누락된다:
  //   [data-om-mounting]  §3 상세(빌딩×레이더) 페이지 점진 마운트(ReportPreviewContent detailPairs)
  //                       진행 중 — 미마운트 페이지가 PDF 에서 빠짐 (쌍당 ~120ms, 수 초 내 완료)
  //   [data-om-computing] 추가 차단영역 산출(ReportApp addedBlockage 비동기 루프) 진행 중 —
  //                       §1 추가소실율·§3 심각도·소견 프로즈가 '판정 불가'로 인쇄됨 (수 초~수십 초)
  //   30초는 초대형 구성 안전 여유. 타임아웃 시엔 현재 상태로 진행.
  const READY_SENTINELS = "[data-om-mounting],[data-om-computing]";
  const mountDeadline = Date.now() + 30_000;
  while (container.querySelector(READY_SENTINELS) && Date.now() < mountDeadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (container.querySelector(READY_SENTINELS)) {
    console.warn("[보고서 PDF] 프리뷰 준비 대기 타임아웃(30초) — 현재 상태로 인쇄 진행");
  }

  const pages = container.querySelectorAll<HTMLDivElement>("[data-page]");
  if (pages.length === 0) {
    return { success: false, error: "보고서 페이지가 없습니다" };
  }

  // 문서 최종 페이지 마킹 — 인쇄 CSS 의 [data-last-page] 규칙(맨 뒤 빈 시트 방지)이 섹션별
  //   마지막이 아니라 '진짜' 마지막 페이지에만 적용되도록. restoreDOM 에서 해제.
  const lastPage = pages[pages.length - 1];
  lastPage.setAttribute("data-last-page", "true");

  // 인쇄 임계구간 진입 — 재페이지네이션 동결(AutoPaginate §4·§5). 이 지점 이후 블록 remount 로
  //   지도 canvas 가 리셋돼 아래 1회 canvas 스냅샷(data-map-canvas)과 어긋나는 것을 차단한다.
  //   restoreDOM 에서 해제 — finally·beforeunload 양쪽에서 호출되어 정상/비정상 종료 모두 복원
  //   (container.id·display 복원과 동일 계약). READY_SENTINELS 소멸 후라 배치는 이미 확정 상태.
  setPaginationFrozen(true);

  // 1. 컨테이너에 프린트 래퍼 ID 부여 (페이지를 이동하지 않음)
  const prevContainerId = container.id;
  container.id = "__print-wrapper__";

  // 2. 컨테이너 내부에서 [data-page] 외 요소 숨김
  // 자기 자신이 data-page 이거나 자손에 data-page 가 있으면 보존 (중간 wrapper 보호)
  const containerChildren = Array.from(container.children) as HTMLElement[];
  const hiddenContainerChildren: HTMLElement[] = [];
  containerChildren.forEach((el) => {
    if (el.hasAttribute("data-page")) return;
    if (el.querySelector("[data-page]")) return;
    hiddenContainerChildren.push(el);
    el.style.setProperty("display", "none", "important");
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

  // 4. 컨테이너~body 사이 조상 경로의 형제 숨김 + 조상 자체 layout 제약 제거.
  // h-screen / flex-1 / min-h-0 등이 print 시 문서 높이를 1 페이지(100vh=297mm)로
  // 제한해 첫 페이지만 출력되는 문제를 막기 위함. 조상에 클래스를 부여해 CSS 로 일괄 정리.
  const hiddenAncestorSiblings: HTMLElement[] = [];
  const overriddenAncestors: HTMLElement[] = [];
  let ancestor: HTMLElement | null = container.parentElement;
  while (ancestor && ancestor !== document.body) {
    Array.from(ancestor.parentElement?.children ?? []).forEach((sibling) => {
      if (sibling !== ancestor && sibling instanceof HTMLElement) {
        hiddenAncestorSiblings.push(sibling);
        sibling.style.setProperty("display", "none", "important");
      }
    });
    ancestor.classList.add("__print-ancestor__");
    overriddenAncestors.push(ancestor);
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
      height: auto !important;
    }
    /* 조상 체인 정리 — flex / 고정 높이 제약 제거하여 print 시 모든 페이지가 흐르도록 */
    .__print-ancestor__ {
      display: block !important;
      height: auto !important;
      min-height: 0 !important;
      max-height: none !important;
      overflow: visible !important;
      flex: none !important;
      /* 조상 체인의 테두리/여백 제거 — 인쇄 흐름 시작점을 시트 좌상단(0,0)에 정확히 맞춘다.
         남겨두면(예: 미리보기 콘텐츠 영역의 border-t 1px) 그 오프셋만큼 흐름이 아래로 밀려,
         고정 높이(297mm) '첫 페이지'의 하단이 다음 시트로 스필한다(유령 반쪽 시트 → 표지만
         2장으로 나뉘고 §1 이 뒤로 밀림). 이후 [data-page] 는 break-after:page 로 매번 시트
         상단에서 새로 시작하므로 영향이 없다 — 그래서 '첫장만' 밀리는 증상이 된다. */
      border: 0 !important;
      padding: 0 !important;
      margin: 0 !important;
    }
    #__print-wrapper__ {
      background: white;
      display: block !important;
      overflow: visible !important;
      height: auto !important;
      max-height: none !important;
      flex: none !important;
      /* 화면용 여백(py-6 등) 무력화 — 첫 페이지가 시트 상단에서 밀려 297mm 를 초과하는 것 방지 */
      padding: 0 !important;
      margin: 0 !important;
    }
    /* container 직계 자식(inner wrapper) 정리 — 단, data-page 본체는 자체 스타일 유지 */
    #__print-wrapper__ > div:not([data-page]) {
      display: block !important;
      overflow: visible !important;
      max-height: none !important;
      flex: none !important;
    }
    #__print-wrapper__ [data-page] {
      page-break-after: always;
      break-after: page;
      width: 210mm !important;
      /* 고정 높이(min-height 아님) — 한 [data-page] 는 반드시 정확히 1 인쇄 시트. 콘텐츠가 297mm 를
         넘으면 overflow:hidden 로 페이지 내부에서 클립하고 다음 시트로 조각(fragment)/스필하지 않는다.
         min-height 는 박스를 콘텐츠만큼 키워 한 페이지가 2 시트에 걸쳐 인쇄되게 했고(유령 반쪽 시트),
         그 여파로 다음 섹션이 시트 중간에서 시작해 콘텐츠가 인쇄영역 밖으로 밀리는 연쇄(§3 이후 잘림)를
         일으켰다. 페이지별 콘텐츠는 §3 상세 차트 높이 축소로 297mm 안에 수납되므로 클립은 안전망. */
      height: 297mm !important;
      min-height: 0 !important;
      max-height: 297mm !important;
      margin: 0 !important;
      box-shadow: none !important;
      overflow: hidden !important;
    }
    /* 문서의 '진짜' 마지막 페이지에만 강제 개행 해제(맨 뒤 빈 시트 방지). :last-child 는 각 섹션
       래퍼(div[data-toc-key])의 마지막 페이지마다 매칭돼, 그 페이지가 오버플로우면 강제 개행이
       사라지며 다음 섹션이 시트 중간에서 시작했다. 내보내기 직전 JS 로 마지막 [data-page] 에만
       부여하는 data-last-page 로 한정한다(fix #1 로 페이지=시트가 보장되면 무해하지만, 규칙 자체를
       구조 의존이 아니라 의미(문서 최종 페이지)로 못박아 회귀에 견고하게 한다). */
    #__print-wrapper__ [data-page][data-last-page] {
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

  // 지도 도면(ReportOMRadarBuildingMap) 의 비동기 CARTO 타일 렌더 완료 대기.
  //   canvas 가 data-map-ready="true" 가 될 때까지(또는 4초 타임아웃) 폴링 — 그래야 PrintToPdf 가
  //   백지/폴백 격자가 아닌 완성된 베이스맵을 스냅샷한다. 오프라인이면 폴백 격자로 즉시 "true" 가 되어 통과.
  const mapCanvases = Array.from(container.querySelectorAll<HTMLCanvasElement>('canvas[data-map-canvas]'));
  if (mapCanvases.length > 0) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (mapCanvases.every((c) => c.getAttribute("data-map-ready") === "true")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    // 타임아웃 폴백 — 타일 요청이 '느리게 실패'(행잉)하면 composeTiles 의 배경/폴백 격자가
    //   그려지기 전이라 캔버스가 투명(백지) 상태다. 미완료 캔버스에 최소 폴백(단색 배경 +
    //   격자 + 안내 문구)을 직접 그려 백지 인쇄를 방지. 이후 타일 로드가 늦게 완료되면
    //   composeTiles 가 전체를 다시 그리므로 화면 상태는 자가 복구된다.
    const notReady = mapCanvases.filter((c) => c.getAttribute("data-map-ready") !== "true");
    if (notReady.length > 0) {
      console.warn(`[보고서 PDF] 지도 타일 렌더 타임아웃(4초) — 캔버스 ${notReady.length}개 폴백 배경으로 인쇄 진행`);
      for (const c of notReady) {
        const ctx = c.getContext("2d");
        if (!ctx) continue;
        const w = c.width, h = c.height;
        ctx.fillStyle = "#eef1f4";
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = "#d6dbe1";
        ctx.lineWidth = 1;
        for (let gx = 0; gx <= w; gx += 48) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke(); }
        for (let gy = 0; gy <= h; gy += 48) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke(); }
        ctx.fillStyle = "#9aa3ad";
        ctx.font = "16px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("지도 타일 로드 시간 초과 — 베이스맵 미표시", w / 2, 22);
      }
    }

    // 타일 부분 유실 자가치유 대기 — 첫 합성에서 일부 타일이 미수신이면(data-map-complete="false")
    //   composeTiles 백그라운드 재시도(최대 RETRY_MAX 회)가 도면을 재합성한다. 확정까지 추가 대기해
    //   '일부만 로딩된(회색 조각) 지도'가 인쇄되는 것을 방지. ready 미달 캔버스(위 폴백 처리)는
    //   제외 — 이미 수동 폴백을 그렸고 complete 를 기다릴 근거가 없다.
    //   정상 네트워크에선 complete="true"가 이미 세팅돼 있어 대기 0초로 통과.
    const isHealing = () => mapCanvases.some(
      (c) => c.getAttribute("data-map-ready") === "true" && c.getAttribute("data-map-complete") === "false",
    );
    // 대기 창은 composeTiles 재시도 스케줄 전체를 덮어야 한다 — ready 이후 최악
    //   RETRY_MAX×(RETRY_DELAY_MS+TILE_BUDGET_RETRY_MS)(= 2×(800+4000) = 9600ms) 소요.
    //   과거 하드코딩 8000ms 는 이보다 짧아 round-2 완료(≈9.6s) 직전 잘려 §4 소실상세 도면이
    //   일부만 로딩된 채 인쇄됐다(1376² 최대 49타일이 공유 풀에서 첫 패스에 다 못 채워지는 케이스).
    //   상수에서 유도(+여유)해 향후 스케줄 변경에도 자동 정합.
    const HEAL_MARGIN_MS = 1500;
    const healWindow = RETRY_MAX * (RETRY_DELAY_MS + TILE_BUDGET_RETRY_MS) + HEAL_MARGIN_MS;
    const healDeadline = Date.now() + healWindow;
    while (isHealing() && Date.now() < healDeadline) {
      await new Promise((r) => setTimeout(r, 150));
    }
    if (isHealing()) {
      console.warn(`[보고서 PDF] 지도 타일 자가치유 대기 타임아웃(${(healWindow / 1000).toFixed(1)}초) — 현재 상태로 인쇄 진행`);
    }
  }

  // DOM 복원 함수 (정상 흐름 + 비정상 종료 양쪽에서 사용)
  const restoreDOM = () => {
    styleEl.remove();
    container.id = prevContainerId;
    lastPage.removeAttribute("data-last-page");
    hiddenContainerChildren.forEach((el) => el.style.removeProperty("display"));
    hiddenBodyChildren.forEach((el) => el.style.removeProperty("display"));
    hiddenAncestorSiblings.forEach((el) => el.style.removeProperty("display"));
    overriddenAncestors.forEach((el) => el.classList.remove("__print-ancestor__"));
    setPaginationFrozen(false); // 재페이지네이션 동결 해제
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

    await Promise.race([
      invoke("webview_print_to_pdf", {
        path: savePath,
        windowLabel: getCurrentWindow().label,
      }),
      timeoutPromise,
    ]);
    return { success: true };
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
