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

interface AutoPaginateProps {
  children: ReactNode;
  /** 모든 페이지 상단에 반복 출력할 헤더 (예: "섹션 (계속)" 표시용) */
  repeatHeader?: ReactNode;
  /** 첫 페이지에만 출력할 헤더 (대개 SectionHeader) */
  firstHeader?: ReactNode;
}

const CONTENT_WIDTH_MM = 182; // 210 - 14*2 (좌우 패딩)
const SAFETY_MARGIN_MM = 2;   // 측정 오차 + 마지막 mb-* 여백 흡수

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
    if (n === 0) return;
    const sample = itemRefs.current.values().next().value as HTMLElement | undefined;
    if (!sample) return;
    const parent = sample.parentElement;
    if (!parent) return;
    const widthPx = parent.offsetWidth;
    if (widthPx === 0) return;
    const pxPerMm = widthPx / CONTENT_WIDTH_MM;

    const heights: number[] = [];
    for (let i = 0; i < n; i++) {
      const el = itemRefs.current.get(i);
      heights.push(el ? el.getBoundingClientRect().height / pxPerMm : 0);
    }

    const repeatH = repeatHeader && repeatHeaderRefs.current.size > 0
      ? Math.max(...[...repeatHeaderRefs.current.values()].map((el) => el.getBoundingClientRect().height / pxPerMm))
      : 0;
    const firstH = firstHeader && firstHeaderRef.current
      ? firstHeaderRef.current.getBoundingClientRect().height / pxPerMm
      : 0;

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

  const totalPages = n === 0 ? 1 : Math.max(...assign) + 1;
  const pages: number[][] = Array.from({ length: totalPages }, () => []);
  for (let i = 0; i < n; i++) pages[assign[i]].push(i);

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
