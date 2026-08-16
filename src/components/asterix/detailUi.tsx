/**
 * ASTERIX 통계 상세(/asterix/stats/:topic) 토픽 공용 UI 프리미티브.
 *
 * shared.tsx 는 대시보드와 공유하는 동결 모듈이라 상세 페이지 전용 재사용 요소는 전부 여기에 모은다.
 * - SortTh / SearchInput : Identity·Mode3a 에 중복 정의돼 있던 것을 일반화 (Source·Quality 도 재사용)
 * - pctText             : Source·Bds 중복 제거
 * - FilterChipButton    : 퀵필터(드릴다운) 트리거 공통 버튼
 * - useBrush            : 차트 드래그 브러시(가로/세로 공통) 상태 기계
 * - TopicExcelExport    : 토픽별 Excel 내보내기 버튼 + 파일명 규칙
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Filter, Search, X } from "lucide-react";
import { ExcelExportButton } from "../common/ExcelExportButton";
import { saveXlsx, type Cell } from "../../utils/xlsxExport";
import type { ExportLang } from "../../utils/exportI18n";
import { ASTERIX_STAT_TOPICS, type AsterixStatTopic } from "../../types/asterixDetail";

// ─── 정렬 헤더 ─────────────────────────────────────────────────────

export type SortDir = "asc" | "desc";
export interface SortState<K extends string> {
  key: K;
  dir: SortDir;
}

/**
 * 정렬 가능한 헤더 셀 (sticky).
 * 같은 컬럼 재클릭 = 방향 토글, 다른 컬럼 = 그 컬럼의 기본 방향(defaultDir).
 * 컴포넌트 밖(모듈 최상위)에 두어 검색어 입력마다 헤더가 재마운트되지 않게 한다.
 */
export function SortTh<K extends string>({
  label,
  k,
  sort,
  setSort,
  defaultDir = "desc",
  align = "left",
  title,
}: {
  label: string;
  k: K;
  sort: SortState<K>;
  setSort: React.Dispatch<React.SetStateAction<SortState<K>>>;
  /** 이 컬럼을 처음 눌렀을 때의 방향 — 수치는 desc, 문자/시각은 asc 가 관례 */
  defaultDir?: SortDir;
  align?: "left" | "right";
  title?: string;
}) {
  const active = sort.key === k;
  return (
    <th
      className={`sticky top-0 z-10 whitespace-nowrap bg-gray-50 px-2 py-1.5 font-medium ${
        align === "right" ? "text-right" : "text-left"
      } ${active ? "text-[#a60739]" : "text-gray-600"}`}
      title={title}
    >
      <button
        type="button"
        onClick={() =>
          setSort((s) => (s.key === k ? { key: k, dir: s.dir === "asc" ? "desc" : "asc" } : { key: k, dir: defaultDir }))
        }
        className={`inline-flex items-center gap-0.5 transition-colors hover:text-[#a60739] ${
          align === "right" ? "flex-row-reverse" : ""
        }`}
      >
        {label}
        {active ? sort.dir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} /> : <span className="w-2.5" />}
      </button>
    </th>
  );
}

/**
 * 결측(null) 우선순위가 정렬 방향과 무관하게 항상 뒤로 가는 공통 비교자.
 * 두 값이 같거나 둘 다 결측이면 0 을 돌려주므로 호출측에서 2차 정렬을 이어 붙인다.
 */
export function compareSortVal(
  va: number | string | null,
  vb: number | string | null,
  dir: SortDir,
): number {
  if (va == null || vb == null) {
    if (va != null) return -1;
    if (vb != null) return 1;
    return 0;
  }
  const c = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
  return c === 0 ? 0 : c * (dir === "asc" ? 1 : -1);
}

// ─── 검색 입력 ─────────────────────────────────────────────────────

/** 돋보기 + 지우기(X) 가 붙은 표 검색 박스 */
export function SearchInput({
  value,
  onChange,
  placeholder,
  width = "w-52",
  numeric = false,
  title,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Tailwind 폭 클래스 */
  width?: string;
  /** 숫자 코드 검색이면 tabular-nums 로 자릿수를 맞춘다 */
  numeric?: boolean;
  title?: string;
}) {
  return (
    <div className="relative flex items-center" title={title}>
      <Search size={11} className="pointer-events-none absolute left-2 text-gray-400" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`h-7 ${width} rounded-md border border-gray-200 bg-white pl-7 pr-6 text-[11px] ${
          numeric ? "tabular-nums " : ""
        }placeholder-gray-400 focus:border-[#a60739] focus:outline-none`}
      />
      {value !== "" && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute right-1.5 text-gray-400 transition-colors hover:text-[#a60739]"
          title="검색어 지우기"
        >
          <X size={11} />
        </button>
      )}
    </div>
  );
}

// ─── 표시 유틸 ─────────────────────────────────────────────────────

/** 점유율 표기 — 표 셀용 (0 분모 방어) */
export function pctText(count: number, total: number): string {
  if (total <= 0) return "—";
  const p = (count / total) * 100;
  return p >= 0.01 ? `${p.toFixed(2)}%` : "<0.01%";
}

// ─── 퀵필터 트리거 ─────────────────────────────────────────────────

/**
 * 퀵필터(드릴다운) 버튼 — 깔때기 아이콘.
 * title 은 필수: "무엇으로 재집계되는지"를 반드시 한글로 설명한다(사용자가 전수 재스캔을 유발하므로).
 */
export function FilterChipButton({
  title,
  onClick,
  label,
  disabled,
}: {
  /** 재집계 동작 설명 (필수) */
  title: string;
  onClick: () => void;
  /** 아이콘 옆 짧은 라벨 (생략 시 아이콘만) */
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex shrink-0 items-center gap-0.5 rounded border border-gray-200 bg-white px-1 py-0.5 text-[10px] font-medium text-gray-500 transition-colors hover:border-[#a60739]/40 hover:bg-[#a60739]/5 hover:text-[#a60739] disabled:cursor-default disabled:opacity-35 disabled:hover:border-gray-200 disabled:hover:bg-white disabled:hover:text-gray-500"
    >
      <Filter size={9} />
      {label}
    </button>
  );
}

/** 차트 상호작용 안내 캡션 — 브러시/클릭이 가능한 차트 아래에 통일된 문구로 붙인다 */
export function ChartHint({ text }: { text: string }) {
  return <div className="mt-1 text-[10px] text-gray-400">{text}</div>;
}

// ─── 차트 브러시 ───────────────────────────────────────────────────

export interface BrushRange {
  a: number;
  b: number;
}

/**
 * 인덱스 축(가로·세로 공통) 드래그 브러시 상태 기계.
 *
 * 차트는 포인터 좌표 → 빈 인덱스 변환만 담당하고, 캡처/취소/확정 규칙은 여기에 모은다.
 * - pointerdown: begin(idx) → 캡처 시작
 * - pointermove: move(idx) → 라이브 하이라이트 (true 반환 시 호버 갱신 생략)
 * - pointerup:   end() → 1빈 미만이면 취소, 아니면 onCommit(lo, hi+1) (반열린 [lo,hi) 경계)
 * - Escape:      드래그 취소
 */
export function useBrush(onCommit: (lo: number, hi: number) => void) {
  const [drag, setDrag] = useState<BrushRange | null>(null);
  // 포인터 콜백은 렌더 사이 상태를 즉시 읽어야 해 ref 를 원천으로 둔다
  const dragRef = useRef<BrushRange | null>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  const cancel = useCallback(() => {
    dragRef.current = null;
    setDrag(null);
  }, []);

  // Esc 취소 — 드래그 중일 때만 구독
  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drag, cancel]);

  const begin = useCallback((idx: number, e: React.PointerEvent<SVGSVGElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const d = { a: idx, b: idx };
    dragRef.current = d;
    setDrag(d);
  }, []);

  const move = useCallback((idx: number): boolean => {
    const cur = dragRef.current;
    if (!cur) return false;
    if (cur.b === idx) return true;
    const d = { a: cur.a, b: idx };
    dragRef.current = d;
    setDrag(d);
    return true;
  }, []);

  const end = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d) return;
    const lo = Math.min(d.a, d.b);
    const hi = Math.max(d.a, d.b);
    // 1빈 미만 드래그(사실상 클릭)는 확정하지 않는다 — 오조작으로 전수 재집계가 도는 것을 막는다
    if (hi - lo < 1) return;
    commitRef.current(lo, hi + 1);
  }, []);

  /** 하이라이트용 반열린 구간 [lo, hi) — 드래그 중이 아니면 null */
  const span = drag ? { lo: Math.min(drag.a, drag.b), hi: Math.max(drag.a, drag.b) + 1 } : null;

  return { drag, span, dragging: drag != null, begin, move, end, cancel };
}

// ─── 토픽 Excel 내보내기 ───────────────────────────────────────────

/**
 * 토픽 Excel 파일명 — `ASTERIX_<토픽라벨>_<YYYY-MM-DD>.xlsx`.
 * 라벨에 파일명 금지문자가 있으므로(예: "Mode-3/A·비상" 의 "/") 반드시 치환한다.
 */
export function detailXlsxName(topic: AsterixStatTopic): string {
  const label = ASTERIX_STAT_TOPICS.find((t) => t.id === topic)?.label ?? topic;
  const safe = label.replace(/[\\/:*?"<>|]/g, "-");
  return `ASTERIX_${safe}_${new Date().toISOString().slice(0, 10)}.xlsx`;
}

export interface ExportSheet {
  name: string;
  rows: Cell[][];
}

/**
 * 토픽 본문 최상단 우측 Excel 내보내기 버튼.
 * build 는 "선택 언어 → 시트 배열" 클로저로, 호출 시점의 최신 데이터를 읽는다(차트 비트맵 없음).
 */
export function TopicExcelExport({
  topic,
  build,
  title,
}: {
  topic: AsterixStatTopic;
  build: (lang: ExportLang) => ExportSheet[];
  title?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // build 는 매 렌더 새 클로저 — ref 로 최신본만 유지해 콜백 identity 를 고정한다
  const buildRef = useRef(build);
  buildRef.current = build;

  const onExport = useCallback(
    async (lang: ExportLang) => {
      setBusy(true);
      setError(null);
      try {
        const sheets = buildRef.current(lang);
        if (sheets.length === 0) {
          setError("내보낼 자료가 없습니다");
          return;
        }
        await saveXlsx(sheets, detailXlsxName(topic));
      } catch (e) {
        console.error("[ASTERIX] 상세 EXCEL 내보내기 실패:", e);
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [topic],
  );

  return (
    <div className="flex items-center justify-end gap-2">
      {error && <span className="text-[10px] text-[#e94560]">내보내기 실패 — {error}</span>}
      <ExcelExportButton
        onExport={onExport}
        busy={busy}
        size="sm"
        title={title ?? "이 토픽의 표·분포를 Excel(.xlsx)로 내보냅니다 — 언어 선택"}
      />
    </div>
  );
}
