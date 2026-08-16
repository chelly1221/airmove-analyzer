/**
 * 토픽: Mode-3/A·비상코드 상세.
 *
 * 비상코드(7500/7600/7700)가 최우선 관심사라 발생 이벤트 표를 페이지 상단에 둔다.
 * mode3a_table(고유 코드 전체 ≤4,096)은 전수 렌더 — 표시 제한은 스크롤 컨테이너로만 건다.
 * 검색/정렬은 클라이언트 로컬 상태(재집계와 무관).
 */

import { useMemo, useState } from "react";
import { useAppStore } from "../../../store";
import { Section, StatCard, LabeledBars } from "../shared";
import {
  compareSortVal,
  FilterChipButton,
  SearchInput,
  SortTh,
  TopicExcelExport,
  type ExportSheet,
  type SortDir,
  type SortState,
} from "../detailUi";
import { formatTime, labelFor } from "../format";
import { exportStrings, type ExportLang } from "../../../utils/exportI18n";
import type { Cell } from "../../../utils/xlsxExport";
import type { AsterixDetailFilter, AsterixDetailStats, Mode3ADetailRow, TzMode } from "../../../types/asterixDetail";

/** Mode-3/A 비상코드 — Rust emergency_counts 가 항상 3개 고정으로 내려주는 키와 동일 */
const EMERGENCY_CODES = ["7700", "7600", "7500"] as const;
const EMERGENCY_SET = new Set<string>(EMERGENCY_CODES);
/** 코드별 의미 — 표/카드 툴팁 */
const EMERGENCY_MEANING: Record<string, string> = {
  "7700": "일반 비상 (General emergency)",
  "7600": "무선 통신두절 (Radio failure)",
  "7500": "불법 간섭·하이재킹 (Unlawful interference)",
};

type SortKey = "code" | "count" | "modes" | "first" | "last";

/** 컬럼을 처음 눌렀을 때의 방향 — 수치는 큰 값 우선, 코드/시각은 오름차순 */
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  code: "asc",
  count: "desc",
  modes: "desc",
  first: "asc",
  last: "asc",
};

/** 정렬 키 → 비교값 (결측은 null → 방향과 무관하게 항상 뒤로) */
function sortVal(r: Mode3ADetailRow, k: SortKey): number | string | null {
  switch (k) {
    case "code":
      return r.code;
    case "count":
      return r.count;
    case "modes":
      return r.distinct_mode_s;
    case "first":
      return r.first_ts;
    case "last":
      return r.last_ts;
  }
}

/** 공용 SortTh 에 이 표의 컬럼별 기본 정렬 방향을 주입한 래퍼 (호출부에서 매번 넘기지 않게) */
function Th({
  label,
  k,
  sort,
  setSort,
  align,
  title,
}: {
  label: string;
  k: SortKey;
  sort: SortState<SortKey>;
  setSort: React.Dispatch<React.SetStateAction<SortState<SortKey>>>;
  align?: "left" | "right";
  title?: string;
}) {
  return (
    <SortTh label={label} k={k} sort={sort} setSort={setSort} defaultDir={DEFAULT_DIR[k]} align={align} title={title} />
  );
}

/** 비상 이벤트 전후 관찰 여유 (초) — 이벤트는 순간이라 앞뒤 5분을 함께 본다 */
const EMG_CONTEXT_SECS = 300;

export default function Mode3aDetail({
  detail,
  tz,
  onQuickFilter,
}: {
  detail: AsterixDetailStats;
  tz: TzMode;
  onQuickFilter: (p: Partial<AsterixDetailFilter>) => void;
}) {
  const { mode3a_table, emergency_events, emergency_events_truncated, stats } = detail;
  const aircraft = useAppStore((s) => s.aircraft);

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState<SortKey>>({ key: "count", dir: "desc" });

  /** 비상코드 건수 — 인덱스가 아닌 코드 키로 조회 (대시보드 관례) */
  const emgCount = (code: string) => stats.emergency_counts.find((e) => e.key === code)?.count ?? 0;

  // 검색(코드 부분일치) → 정렬. 전수 유지, 잘라내지 않는다.
  const rows = useMemo(() => {
    const q = query.trim();
    const base = q === "" ? mode3a_table : mode3a_table.filter((r) => r.code.includes(q));

    const arr = base.slice();
    arr.sort((a, b) => {
      // 결측(null)은 방향과 무관하게 항상 뒤로 — compareSortVal 공통 규칙
      const c = compareSortVal(sortVal(a, sort.key), sortVal(b, sort.key), sort.dir);
      return c !== 0 ? c : b.count - a.count || a.code.localeCompare(b.code);
    });
    return arr;
  }, [mode3a_table, query, sort]);

  /** Excel — 코드별 상세(현재 검색·정렬 반영) + 비상 이벤트 */
  const buildSheets = (lang: ExportLang): ExportSheet[] => {
    const L = exportStrings(lang);
    const sheets: ExportSheet[] = [];
    if (rows.length > 0) {
      const out: Cell[][] = [L.detail.mode3aTableHeader(tz)];
      for (const m of rows) {
        out.push([
          m.code,
          m.count,
          stats.mode3a_records > 0 ? Number(((m.count / stats.mode3a_records) * 100).toFixed(3)) : "",
          m.distinct_mode_s,
          m.first_ts != null ? formatTime(m.first_ts, tz) : "",
          m.last_ts != null ? formatTime(m.last_ts, tz) : "",
        ]);
      }
      sheets.push({ name: L.detail.sheet.mode3aTable, rows: out });
    }
    if (emergency_events.length > 0) {
      const out: Cell[][] = [L.detail.emergencyHeader(tz)];
      for (const e of emergency_events) {
        out.push([e.ts != null ? formatTime(e.ts, tz) : "", e.code, e.mode_s ?? "", e.sac, e.sic]);
      }
      sheets.push({ name: L.detail.sheet.emergencyEvents, rows: out });
    }
    return sheets;
  };

  return (
    <div className="space-y-3">
      <TopicExcelExport
        topic="mode3a"
        build={buildSheets}
        title="Mode-3/A 코드별 상세·비상 이벤트를 Excel(.xlsx)로 내보냅니다 — 언어 선택"
      />
      {/* 요약 카드 — 비상 3코드는 0이어도 항상 노출 (Rust 고정 3개 계약) */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatCard
          label="Mode-3/A(고유)"
          value={stats.mode3a_distinct.toLocaleString()}
          sub="V/G=0 유효 코드"
          title="I048/070 유효(V/G=0) Mode-3/A 고유 코드 수"
        />
        <StatCard
          label="유효 보유 레코드"
          value={stats.mode3a_records.toLocaleString()}
          sub={
            stats.record_count > 0
              ? `필터 레코드의 ${((stats.mode3a_records / stats.record_count) * 100).toFixed(1)}%`
              : undefined
          }
          title="유효 Mode-3/A 코드를 실은 레코드 총수 (점유율 분모)"
        />
        <StatCard
          label="무효(garbled)"
          value={stats.mode3a_garbled.toLocaleString()}
          sub="V=1 또는 G=1"
          title="I048/070 V(미검증)/G(garbled) 플래그가 선 레코드 — 코드 집계에서 제외"
        />
        <StatCard
          label="비상 레코드"
          value={stats.emergency_records.toLocaleString()}
          sub={EMERGENCY_CODES.map((c) => `${c} ${emgCount(c).toLocaleString()}`).join(" · ")}
          title="7700/7600/7500 합계 레코드 수"
        />
        {EMERGENCY_CODES.map((code) => {
          const n = emgCount(code);
          return (
            // 관측이 있을 때만 클릭 가능 — 0건 코드로 재집계하면 빈 결과라 비활성
            <button
              key={code}
              type="button"
              disabled={n === 0}
              onClick={() => onQuickFilter({ mode3a: code })}
              className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                n > 0
                  ? "cursor-pointer border-[#e94560]/40 bg-[#e94560]/5 hover:border-[#e94560]"
                  : "cursor-default border-gray-200 bg-[#f8f9fa]"
              }`}
              title={
                n > 0
                  ? `${EMERGENCY_MEANING[code]} — 클릭하면 Mode-3/A ${code} 레코드만으로 전수 재집계`
                  : `${EMERGENCY_MEANING[code]} — 관측 없음`
              }
            >
              <div className="flex items-center gap-1">
                <span
                  className={`rounded px-1 py-px text-[9px] font-semibold tabular-nums ${
                    n > 0 ? "bg-[#e94560] text-white" : "bg-gray-200 text-gray-500"
                  }`}
                >
                  {code}
                </span>
                <span className="text-[10px] uppercase tracking-wider text-gray-400">비상코드</span>
              </div>
              <div className={`mt-0.5 text-lg font-semibold tabular-nums ${n > 0 ? "text-[#e94560]" : "text-gray-800"}`}>
                {n.toLocaleString()}
              </div>
              <div className="truncate text-[10px] text-gray-400">{EMERGENCY_MEANING[code]}</div>
            </button>
          );
        })}
      </div>

      {/* 비상코드 발생 이벤트 — 최우선 관심사라 최상단 배치 */}
      <Section
        title={`비상코드 발생 이벤트 (${emergency_events.length.toLocaleString()}건)`}
        right={
          emergency_events_truncated ? (
            <span className="text-[10px] text-amber-600">
              시각순 상위 {emergency_events.length.toLocaleString()}건만 수신 — 기간 필터로 좁혀 조회
            </span>
          ) : undefined
        }
      >
        {emergency_events.length === 0 ? (
          <div className="py-6 text-center text-[11px] text-gray-400">
            비상코드 발생 없음
            <div className="mt-0.5 text-[10px] text-gray-300">필터 적용 구간에 7500/7600/7700 관측이 없습니다</div>
          </div>
        ) : (
          <div className="max-h-72 overflow-auto rounded border border-gray-100">
            <table className="w-full text-[11px]">
              <thead>
                <tr>
                  <th
                    className="sticky top-0 z-10 w-8 whitespace-nowrap bg-gray-50 px-2 py-1.5 text-left font-medium text-gray-600"
                    title="발생 시각 전후 ±5분 구간으로 재집계"
                  >
                    보기
                  </th>
                  <th className="sticky top-0 z-10 whitespace-nowrap bg-gray-50 px-2 py-1.5 text-left font-medium text-gray-600">
                    시각 ({tz})
                  </th>
                  <th className="sticky top-0 z-10 whitespace-nowrap bg-gray-50 px-2 py-1.5 text-left font-medium text-gray-600">
                    코드
                  </th>
                  <th className="sticky top-0 z-10 whitespace-nowrap bg-gray-50 px-2 py-1.5 text-left font-medium text-gray-600">
                    Mode-S
                  </th>
                  <th className="sticky top-0 z-10 whitespace-nowrap bg-gray-50 px-2 py-1.5 text-left font-medium text-gray-600">
                    출처 (SAC/SIC)
                  </th>
                </tr>
              </thead>
              <tbody>
                {emergency_events.map((e, i) => (
                  <tr key={`${e.ts}:${e.mode_s}:${e.code}:${i}`} className="border-t border-gray-100 hover:bg-[#a60739]/5">
                    <td className="px-2 py-1">
                      {/* 이벤트는 한 순간이라 앞뒤 ±5분을 붙여야 전개 과정이 보인다 */}
                      {e.ts != null && (
                        <FilterChipButton
                          title={`발생 전후 ±5분(${formatTime(e.ts - EMG_CONTEXT_SECS, tz)} ~ ${formatTime(
                            e.ts + EMG_CONTEXT_SECS,
                            tz,
                          )}) 구간으로 재집계`}
                          onClick={() =>
                            onQuickFilter({
                              timeMin: (e.ts as number) - EMG_CONTEXT_SECS,
                              timeMax: (e.ts as number) + EMG_CONTEXT_SECS,
                            })
                          }
                        />
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 font-mono text-gray-700">
                      {e.ts != null ? formatTime(e.ts, tz) : "—"}
                    </td>
                    <td className="px-2 py-1">
                      <span
                        title={EMERGENCY_MEANING[e.code] ?? "Mode-3/A 비상코드"}
                        className="rounded bg-[#e94560] px-1 py-px text-[9px] font-semibold tabular-nums text-white"
                      >
                        {e.code}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 font-mono text-gray-700">
                      {e.mode_s ? labelFor(e.mode_s, aircraft) : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 tabular-nums text-gray-600">
                      SAC {e.sac} · SIC {e.sic}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Mode-3/A 코드별 상세 — 전수 */}
      <Section
        title={`Mode-3/A 코드별 상세 (${rows.length.toLocaleString()}개${
          query.trim() !== "" ? ` / ${mode3a_table.length.toLocaleString()}` : ""
        })`}
        right={
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="코드 (옥탈 부분일치)"
            width="w-44"
            numeric
            title="표시 중인 표만 걸러냅니다 (재집계 아님)"
          />
        }
      >
        {mode3a_table.length === 0 ? (
          <div className="py-8 text-center text-[11px] text-gray-400">유효 Mode-3/A 코드 관측이 없습니다</div>
        ) : rows.length === 0 ? (
          <div className="py-8 text-center text-[11px] text-gray-400">검색 조건에 맞는 코드가 없습니다</div>
        ) : (
          <div className="max-h-[30rem] overflow-auto rounded border border-gray-100">
            <table className="w-full text-[11px]">
              <thead>
                <tr>
                  {/* 선두 액션 열 — 정렬 대상이 아니라 SortTh 대신 평범한 th */}
                  <th
                    className="sticky top-0 z-10 w-8 whitespace-nowrap bg-gray-50 px-2 py-1.5 text-left font-medium text-gray-600"
                    title="이 Mode-3/A 코드만으로 전수 재집계"
                  >
                    필터
                  </th>
                  <Th label="코드" k="code" sort={sort} setSort={setSort} title="I048/070 옥탈 4자리" />
                  <Th label="레코드" k="count" align="right" sort={sort} setSort={setSort} />
                  {/* 점유율은 레코드 수와 순서가 같아 별도 정렬 키를 두지 않는다 */}
                  <th
                    className="sticky top-0 z-10 whitespace-nowrap bg-gray-50 px-2 py-1.5 text-right font-medium text-gray-600"
                    title="유효 Mode-3/A 보유 레코드 대비 점유율 (레코드 수와 정렬 순서 동일)"
                  >
                    점유율
                  </th>
                  <Th
                    label="Mode-S 수"
                    k="modes"
                    align="right"
                    sort={sort}
                    setSort={setSort}
                    title="이 코드를 사용한 고유 Mode-S 주소 수"
                  />
                  <Th label={`최초 (${tz})`} k="first" sort={sort} setSort={setSort} />
                  <Th label={`최종 (${tz})`} k="last" sort={sort} setSort={setSort} />
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const emg = EMERGENCY_SET.has(m.code);
                  const pct = stats.mode3a_records > 0 ? (m.count / stats.mode3a_records) * 100 : 0;
                  return (
                    <tr
                      key={m.code}
                      className={`border-t border-gray-100 hover:bg-[#a60739]/5 ${
                        emg ? "border-l-2 bg-[#e94560]/5" : ""
                      }`}
                      // 좌측 보더 색은 border-gray-100(전 방향)과 순서 다툼이 없도록 인라인으로 확정
                      style={emg ? { borderLeftColor: "#e94560" } : undefined}
                    >
                      <td className="px-2 py-1">
                        <FilterChipButton
                          title={`Mode-3/A ${m.code} 레코드만으로 전수 재집계 (필터바 Mode-3/A 칸에 반영)`}
                          onClick={() => onQuickFilter({ mode3a: m.code })}
                        />
                      </td>
                      <td className="whitespace-nowrap px-2 py-1">
                        <span
                          className={`font-mono tabular-nums ${emg ? "font-semibold text-[#e94560]" : "text-gray-700"}`}
                          title={emg ? EMERGENCY_MEANING[m.code] : undefined}
                        >
                          {m.code}
                        </span>
                        {emg && <span className="ml-1 text-[10px] text-[#e94560]">비상</span>}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-gray-700">{m.count.toLocaleString()}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-gray-500">
                        {pct >= 0.1 ? `${pct.toFixed(1)}%` : pct > 0 ? "<0.1%" : "—"}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-gray-600">
                        {m.distinct_mode_s.toLocaleString()}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 font-mono text-gray-600">
                        {m.first_ts != null ? formatTime(m.first_ts, tz) : "—"}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 font-mono text-gray-600">
                        {m.last_ts != null ? formatTime(m.last_ts, tz) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* 상위 30 분포 — 대시보드 "Mode-3/A 코드 상위"와 동일 색/분모 */}
      <Section
        title={`Mode-3/A 코드 상위 ${stats.mode3a_top.length}`}
        right={
          <span className="text-[10px] text-gray-400">
            분모 = 유효 보유 레코드 {stats.mode3a_records.toLocaleString()}건
          </span>
        }
      >
        <LabeledBars items={stats.mode3a_top} total={stats.mode3a_records} color="#0369a1" />
      </Section>
    </div>
  );
}
