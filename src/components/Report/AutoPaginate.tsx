/**
 * 자식 블록을 측정해 자동으로 A4(`ReportPage`)로 분할 렌더.
 *
 * - 각 자식은 atomic 블록으로 가정 (블록 내부는 쪼개지 않음).
 *   블록 자체가 한 페이지를 넘으면 그 페이지만 오버플로우 허용.
 * - ResizeObserver 로 자식/헤더 크기 변경을 추적해 편집 가능 텍스트 등
 *   동적 콘텐츠에도 반응.
 * - 자식은 단 한 번만 렌더되며, 그룹 변경 시 React 가 부모 ReportPage 사이에서
 *   DOM 재배치(remount). ref 콜백에서 observer 를 unobserve/observe 동기화.
 *
 * 사용 예:
 *   <AutoPaginate firstHeader={<SectionHeader />}>
 *     {blocks.map((b) => <Block key={b.id} {...b} />)}
 *   </AutoPaginate>
 */
import {
  Children, isValidElement, useCallback, useEffect, useLayoutEffect,
  useRef, useState, type ReactNode,
} from "react";
import ReportPage from "./ReportPage";
import { PAGE_CONTENT_MM } from "./reportPageConstants";

// ── PDF 내보내기 임계구간 재페이지네이션 동결 ──
// 인쇄 직전 자식 블록이 다른 ReportPage(key=pi)로 재배치되면 React 가 remount → 그 안의 지도
// canvas 가 새로 생성되고 composeTiles 가 0라운드부터 재시작하며 data-map-ready 가 false 로 리셋된다.
// 그러면 내보내기 게이트(useReportExport)가 1회 스냅샷한 canvas 집합과 실제 인쇄 DOM 이 어긋나
// §4 도면이 백지/일부로딩으로 스냅샷될 수 있다(remount 는 게이트 폴링 밖에서 일어남). 인쇄 임계구간엔
// 화면에서 이미 확정된 페이지 배치를 그대로 유지(동결)해 remount 를 원천 차단한다. 배치(assign)는
// mm 기준 scale-불변이라 인쇄 레이아웃과 동일 → 동결이 페이지 나눔을 어긋나게 하지 않는다.
let paginationFrozen = false;
/** useReportExport 가 인쇄 임계구간 진입/이탈 시 호출 — 동결 중 recompute 는 무시(remount 차단). */
export function setPaginationFrozen(frozen: boolean) { paginationFrozen = frozen; }

interface AutoPaginateProps {
  children: ReactNode;
  /** 모든 페이지 상단에 반복 출력할 헤더 (예: "섹션 (계속)" 표시용) */
  repeatHeader?: ReactNode;
  /** 첫 페이지에만 출력할 헤더 (대개 SectionHeader) */
  firstHeader?: ReactNode;
}

const CONTENT_WIDTH_MM = 182; // 자식 래퍼 자신의 폭 = 210 − 14×2 (.report-page-inner 좌우 패딩 안쪽)
const SAFETY_MARGIN_MM = 2;   // 서브픽셀 측정 오차 흡수 — collapse 마진은 escapedMarginPx 로 명시 가산되므로 소폭이면 충분

/**
 * 래퍼 밖으로 margin-collapse 되어 빠져나가는 상/하단 마진(px).
 *
 * 측정용 래퍼 div 는 패딩·보더가 없어 내부 블록(.ev-block margin-bottom 18px,
 * .om-h2 margin-bottom 16px, .findings-text margin-bottom 14px 등)의 상/하 마진이
 * 래퍼 밖으로 collapse 되고, getBoundingClientRect().height 에는 포함되지 않는다.
 * 첫/마지막 자식 체인을 따라 내려가며(collapse 는 패딩·보더가 있으면 차단됨)
 * margin 최댓값을 구해 실제 점유 높이에 가산한다.
 */
function escapedMarginPx(root: HTMLElement, side: "top" | "bottom"): number {
  let max = 0;
  let el: HTMLElement | null = root;
  while (el) {
    const cs = getComputedStyle(el);
    max = Math.max(max, parseFloat(side === "top" ? cs.marginTop : cs.marginBottom) || 0);
    const pad = parseFloat(side === "top" ? cs.paddingTop : cs.paddingBottom) || 0;
    const border = parseFloat(side === "top" ? cs.borderTopWidth : cs.borderBottomWidth) || 0;
    if (pad > 0 || border > 0) break;
    // flex/grid 컨테이너·BFC(overflow≠visible) 내부 자식 마진은 밖으로 collapse 되지 않음
    if (cs.display === "flex" || cs.display === "grid" || cs.overflow !== "visible") break;
    el = (side === "top" ? el.firstElementChild : el.lastElementChild) as HTMLElement | null;
  }
  return max;
}

/** 블록 실제 점유 높이(px) — rect 높이 + collapse 로 래퍼 밖에 생기는 상/하 마진.
 *  인접 블록 경계에서는 collapse 로 두 마진 중 max 만 실제 점유하지만, 배치(페이지
 *  할당)에 따라 측정값이 달라지는 방식(offsetTop 차분)은 재배치↔재측정 오실레이션
 *  위험이 있어 결정적·소폭 과대측정(안전 방향 — 페이지를 약간 일찍 넘김) 방식을 택했다. */
function occupiedHeightPx(el: HTMLElement): number {
  return el.getBoundingClientRect().height
    + escapedMarginPx(el, "top")
    + escapedMarginPx(el, "bottom");
}

export default function AutoPaginate({ children, repeatHeader, firstHeader }: AutoPaginateProps) {
  const childArray = Children.toArray(children).filter(isValidElement);
  const n = childArray.length;

  // 자식 idx → 페이지 idx 매핑. 초기엔 모두 첫 페이지에 배치.
  const [assign, setAssign] = useState<number[]>(() => Array(n).fill(0));

  const itemRefs = useRef<Map<number, HTMLElement>>(new Map());
  const repeatHeaderRefs = useRef<Map<number, HTMLElement>>(new Map());
  const firstHeaderRef = useRef<HTMLElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  const recompute = useCallback(() => {
    if (paginationFrozen) return; // 인쇄 임계구간 — 확정 배치 유지(remount 차단)
    if (n === 0) return;
    const sample = itemRefs.current.values().next().value as HTMLElement | undefined;
    if (!sample) return;
    // px→mm 환산: 자식 래퍼 '자신'의 폭이 정확히 CONTENT_WIDTH_MM(182mm).
    // 부모(.report-page-inner)는 좌우 14mm 패딩을 자신이 가진 210mm 폭 요소라
    // 그 offsetWidth 를 182 로 나누면 pxPerMm 이 210/182≈1.15배 과대 → 블록 높이
    // ~13% 과소측정으로 페이지 하단 클리핑이 발생했다. 높이 측정과 동일한
    // getBoundingClientRect 기준을 써서 조상 transform scale 에도 비율이 유지된다.
    const widthPx = sample.getBoundingClientRect().width;
    if (widthPx === 0) return;
    const pxPerMm = widthPx / CONTENT_WIDTH_MM;

    const heights: number[] = [];
    for (let i = 0; i < n; i++) {
      const el = itemRefs.current.get(i);
      heights.push(el ? occupiedHeightPx(el) / pxPerMm : 0);
    }

    const repeatH = repeatHeader && repeatHeaderRefs.current.size > 0
      ? Math.max(...[...repeatHeaderRefs.current.values()].map((el) => occupiedHeightPx(el) / pxPerMm))
      : 0;
    const firstH = firstHeader && firstHeaderRef.current
      ? occupiedHeightPx(firstHeaderRef.current) / pxPerMm
      : 0;

    // 한 페이지 한계 — PAGE_CONTENT_MM(263mm = 297 − 상단 16mm − 하단 18mm 패딩)이
    // .report-page-inner 의 실제 콘텐츠 영역 높이와 일치. 블록 높이가 collapse 마진까지
    // 포함해 182mm 기준으로 정확히 mm 환산되므로, limit 까지 채워도 물리 페이지
    // (overflow:hidden)를 넘지 않는다.
    const limit = PAGE_CONTENT_MM - SAFETY_MARGIN_MM;
    const next: number[] = [];
    let page = 0;
    let used = firstH + repeatH;
    let pageHasItem = false;
    for (let i = 0; i < n; i++) {
      const h = heights[i];
      if (pageHasItem && used + h > limit) {
        page++;
        used = repeatH;
        pageHasItem = false;
      }
      next.push(page);
      used += h;
      pageHasItem = true;
    }

    setAssign((prev) => {
      if (prev.length === next.length && prev.every((v, i) => v === next[i])) return prev;
      return next;
    });
  }, [n, firstHeader, repeatHeader]);

  // observer callback 에서 최신 recompute 사용
  const recomputeRef = useRef(recompute);
  recomputeRef.current = recompute;

  useEffect(() => {
    let scheduled = false;
    observerRef.current = new ResizeObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        recomputeRef.current();
      });
    });
    return () => observerRef.current?.disconnect();
  }, []);

  useLayoutEffect(() => { recompute(); }, [recompute]);

  // ref 콜백 캐시 — JSX 매 렌더 새 함수 생성 시 React 가 ref(null)→ref(new) churn 유발
  const itemRefCache = useRef<Map<number, (el: HTMLElement | null) => void>>(new Map());
  const getItemRef = useCallback((idx: number) => {
    let cb = itemRefCache.current.get(idx);
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        const prev = itemRefs.current.get(idx);
        if (prev && prev !== el) observerRef.current?.unobserve(prev);
        if (el) {
          itemRefs.current.set(idx, el);
          observerRef.current?.observe(el);
        } else {
          itemRefs.current.delete(idx);
        }
      };
      itemRefCache.current.set(idx, cb);
    }
    return cb;
  }, []);

  const repeatHeaderRefCache = useRef<Map<number, (el: HTMLElement | null) => void>>(new Map());
  const getRepeatHeaderRef = useCallback((pi: number) => {
    let cb = repeatHeaderRefCache.current.get(pi);
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        const prev = repeatHeaderRefs.current.get(pi);
        if (prev && prev !== el) observerRef.current?.unobserve(prev);
        if (el) {
          repeatHeaderRefs.current.set(pi, el);
          observerRef.current?.observe(el);
        } else {
          repeatHeaderRefs.current.delete(pi);
        }
      };
      repeatHeaderRefCache.current.set(pi, cb);
    }
    return cb;
  }, []);

  const setFirstHeaderRef = useCallback((el: HTMLElement | null) => {
    const prev = firstHeaderRef.current;
    if (prev && prev !== el) observerRef.current?.unobserve(prev);
    firstHeaderRef.current = el;
    if (el) observerRef.current?.observe(el);
  }, []);

  // 자식 수(n)가 마운트 이후 변하면(예: 파노라마 후 추가 차단영역 블록이 null→element 로 추가) assign(useState)이
  // 한 렌더 늦게 갱신된다. 그 사이 assign[i] 가 undefined 가 되면 pages[undefined].push 로 크래시하므로,
  // 갱신 전 자식은 일단 0페이지로 안전 배치하고 직후 useLayoutEffect 의 recompute 가 정확히 재배치한다.
  const pageOf = (i: number) => assign[i] ?? 0;
  const totalPages = n === 0 ? 1 : Math.max(0, ...Array.from({ length: n }, (_, i) => pageOf(i))) + 1;
  const pages: number[][] = Array.from({ length: totalPages }, () => []);
  for (let i = 0; i < n; i++) pages[pageOf(i)].push(i);

  return (
    <>
      {pages.map((indices, pi) => (
        <ReportPage key={pi}>
          {pi === 0 && firstHeader && <div ref={setFirstHeaderRef}>{firstHeader}</div>}
          {repeatHeader && <div ref={getRepeatHeaderRef(pi)}>{repeatHeader}</div>}
          {indices.map((idx) => (
            <div key={idx} ref={getItemRef(idx)}>
              {childArray[idx]}
            </div>
          ))}
        </ReportPage>
      ))}
    </>
  );
}
