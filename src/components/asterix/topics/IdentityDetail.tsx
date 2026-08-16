/**
 * 토픽: Mode-S 식별 상세.
 *
 * Rust 가 내려준 modes_table(count 내림차순, 상한 2,000)을 전수 렌더한다.
 * 검색/정렬은 전부 클라이언트 로컬 상태 — 재집계(필터바)와 무관하게 즉시 반응한다.
 * (다운샘플링 금지 — 표시 행은 스크롤 컨테이너로만 제한)
 */

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
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
import type { AsterixDetailFilter, AsterixDetailStats, ModeSDetailRow, TzMode } from "../../../types/asterixDetail";
import type { LabeledCount } from "../../../types/asterix";

/** Mode-3/A 비상코드 — 뱃지 강조 대상 */
const EMERGENCY_CODES = new Set(["7500", "7600", "7700"]);

/** 레코드 수 상위 분포에 표시할 개수 (대시보드 Mode-S 상위와 동일 규모) */
const TOP_N = 30;

/**
 * 체공시간(최초~최종 관측 간격) 표기 — format.ts fmtGapDur 관례를 따르되
 * 1분 미만 구간은 초로 떨어뜨려 단발 관측을 "0분"으로 뭉개지 않는다.
 */
function fmtSpanDur(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "—";
  if (secs < 60) return `${Math.round(secs)}초`;
  const m = Math.round(secs / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}분`;
}

type SortKey =
  | "mode_s"
  | "callsign"
  | "count"
  | "first"
  | "last"
  | "dur"
  | "fl"
  | "speed"
  | "range"
  | "codes"
  | "acas"
  | "emg"
  | "track";

/** 컬럼을 처음 눌렀을 때의 방향 — 수치는 큰 값 우선, 문자/시각은 오름차순 */
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  mode_s: "asc",
  callsign: "asc",
  count: "desc",
  first: "asc",
  last: "asc",
  dur: "desc",
  fl: "desc",
  speed: "desc",
  range: "desc",
  codes: "desc",
  acas: "desc",
  emg: "desc",
  track: "desc",
};

/** 정렬 키 → 비교값 (결측은 null → 방향과 무관하게 항상 뒤로) */
function sortVal(r: ModeSDetailRow, k: SortKey): number | string | null {
  switch (k) {
    case "mode_s":
      return r.mode_s;
    case "callsign":
      return r.callsign && r.callsign.trim() !== "" ? r.callsign : null;
    case "count":
      return r.count;
    case "first":
      return r.first_ts;
    case "last":
      return r.last_ts;
    case "dur":
      return r.first_ts != null && r.last_ts != null ? r.last_ts - r.first_ts : null;
    case "fl":
      return r.fl_max;
    case "speed":
      return r.speed_mean_kts;
    case "range":
      return r.range_max_nm;
    case "codes":
      return r.mode3a_codes.length;
    case "acas":
      return r.acas_count;
    case "emg":
      return r.emergency_count;
    case "track":
      return r.track_numbers;
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

/** 체공시간 초 → Excel 셀용 정수 (결측은 빈 셀) */
const durCell = (r: ModeSDetailRow): Cell =>
  r.first_ts != null && r.last_ts != null ? Math.round(r.last_ts - r.first_ts) : "";

export default function IdentityDetail({
  detail,
  tz,
  onQuickFilter,
}: {
  detail: AsterixDetailStats;
  tz: TzMode;
  onQuickFilter: (p: Partial<AsterixDetailFilter>) => void;
}) {
  const { modes_table, modes_table_truncated, stats } = detail;
  const aircraft = useAppStore((s) => s.aircraft);
  const navigate = useNavigate();

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState<SortKey>>({ key: "count", dir: "desc" });

  /** 등록 비행검사기 hex → 표시명 (검색·병기용) */
  const acName = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of aircraft) {
      if (!a.mode_s_code) continue;
      const nm = a.name || a.registration;
      if (nm) m.set(a.mode_s_code.toUpperCase(), nm);
    }
    return m;
  }, [aircraft]);

  // 검색(hex·호출부호·등록 기체명 부분일치) → 정렬. 전수 유지, 잘라내지 않는다.
  const rows = useMemo(() => {
    const q = query.trim().toUpperCase();
    const base =
      q === ""
        ? modes_table
        : modes_table.filter(
            (r) =>
              r.mode_s.toUpperCase().includes(q) ||
              (r.callsign ?? "").toUpperCase().includes(q) ||
              (acName.get(r.mode_s.toUpperCase()) ?? "").toUpperCase().includes(q),
          );

    const arr = base.slice();
    arr.sort((a, b) => {
      // 결측(null)은 방향과 무관하게 항상 뒤로 — compareSortVal 공통 규칙
      const c = compareSortVal(sortVal(a, sort.key), sortVal(b, sort.key), sort.dir);
      return c !== 0 ? c : b.count - a.count || a.mode_s.localeCompare(b.mode_s);
    });
    return arr;
  }, [modes_table, query, sort, acName]);

  // 레코드 수 상위 분포 — 원본(count 내림차순) 앞에서 잘라 쓰되 방어적으로 재정렬
  const topItems = useMemo<LabeledCount[]>(() => {
    const arr = modes_table.slice().sort((a, b) => b.count - a.count);
    return arr.slice(0, TOP_N).map((m) => {
      const nm = acName.get(m.mode_s.toUpperCase());
      const cs = m.callsign && m.callsign.trim() !== "" ? m.callsign : null;
      const extra = [nm, cs].filter(Boolean).join(" · ");
      return { key: m.mode_s, label: extra ? `${m.mode_s} · ${extra}` : m.mode_s, count: m.count };
    });
  }, [modes_table, acName]);

  /** Excel — Mode-S 상세 표 전체(화면 정렬·검색 결과를 그대로 반영) */
  const buildSheets = (lang: ExportLang): ExportSheet[] => {
    const L = exportStrings(lang);
    if (rows.length === 0) return [];
    const out: Cell[][] = [L.detail.modesTableHeader(tz)];
    for (const m of rows) {
      out.push([
        m.mode_s,
        m.callsign ?? "",
        m.count,
        m.first_ts != null ? formatTime(m.first_ts, tz) : "",
        m.last_ts != null ? formatTime(m.last_ts, tz) : "",
        durCell(m),
        m.fl_min ?? "",
        m.fl_max ?? "",
        m.speed_mean_kts != null ? Number(m.speed_mean_kts.toFixed(1)) : "",
        m.range_min_nm != null ? Number(m.range_min_nm.toFixed(2)) : "",
        m.range_max_nm != null ? Number(m.range_max_nm.toFixed(2)) : "",
        m.mode3a_codes.join(" "),
        m.acas_count,
        m.emergency_count,
        m.track_numbers,
      ]);
    }
    return [{ name: L.detail.sheet.modesTable, rows: out }];
  };

  return (
    <div className="space-y-3">
      <TopicExcelExport
        topic="identity"
        build={buildSheets}
        title="Mode-S 주소별 상세 표(현재 검색·정렬 반영)를 Excel(.xlsx)로 내보냅니다 — 언어 선택"
      />

      {/* 요약 카드 */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatCard
          label="Mode-S(고유)"
          value={stats.modes_distinct.toLocaleString()}
          sub="I048/220 관측 주소"
          title="필터 적용 구간에서 관측된 고유 Mode-S 주소 수"
        />
        <StatCard
          label="호출부호 확보"
          value={stats.mode_s_callsigns.length.toLocaleString()}
          sub={
            stats.modes_distinct > 0
              ? `고유 주소의 ${((stats.mode_s_callsigns.length / stats.modes_distinct) * 100).toFixed(1)}%`
              : undefined
          }
          title="BDS 2,0(항공기 식별)에서 호출부호를 얻은 Mode-S 주소 수"
        />
        <StatCard
          label="트랙번호(고유)"
          value={stats.track_numbers_distinct.toLocaleString()}
          sub="SAC/SIC 구분"
          title="I048/161 트랙 번호 — 레이더 로컬이므로 SAC/SIC별로 구분해 집계"
        />
        <StatCard
          label="표시 행"
          value={modes_table.length.toLocaleString()}
          sub={modes_table_truncated ? `상위 ${modes_table.length.toLocaleString()} 표시` : "전체 표시"}
          title="아래 상세 테이블에 실린 Mode-S 주소 수"
        />
      </div>

      {/* Mode-S 주소별 상세 — 이 토픽의 핵심 표 */}
      <Section
        title={`Mode-S 주소별 상세 (${rows.length.toLocaleString()}행${
          query.trim() !== "" ? ` / ${modes_table.length.toLocaleString()}` : ""
        })`}
        right={
          <div className="flex items-center gap-2">
            {modes_table_truncated && (
              <span className="text-[10px] text-amber-600">
                레코드 수 상위 {modes_table.length.toLocaleString()}개만 수신 — 나머지는 필터로 좁혀 조회
              </span>
            )}
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="Mode-S hex · 호출부호 · 기체명"
              title="표시 중인 표만 걸러냅니다 (재집계 아님)"
            />
          </div>
        }
      >
        {modes_table.length === 0 ? (
          <div className="py-8 text-center text-[11px] text-gray-400">Mode-S 주소 관측이 없습니다</div>
        ) : rows.length === 0 ? (
          <div className="py-8 text-center text-[11px] text-gray-400">검색 조건에 맞는 Mode-S 주소가 없습니다</div>
        ) : (
          <div className="max-h-[34rem] overflow-auto rounded border border-gray-100">
            <table className="w-full text-[11px]">
              <thead>
                <tr>
                  {/* 선두 액션 열 — 정렬 대상이 아니라 SortTh 대신 평범한 th */}
                  <th
                    className="sticky top-0 z-10 w-8 whitespace-nowrap bg-gray-50 px-2 py-1.5 text-left font-medium text-gray-600"
                    title="이 Mode-S 주소만으로 전수 재집계"
                  >
                    필터
                  </th>
                  <Th label="Mode-S" k="mode_s" sort={sort} setSort={setSort} />
                  <Th label="호출부호" k="callsign" sort={sort} setSort={setSort} title="BDS 2,0 항공기 식별" />
                  <Th label="레코드" k="count" align="right" sort={sort} setSort={setSort} />
                  <Th label={`최초 (${tz})`} k="first" sort={sort} setSort={setSort} />
                  <Th label={`최종 (${tz})`} k="last" sort={sort} setSort={setSort} />
                  <Th
                    label="체공시간"
                    k="dur"
                    align="right"
                    sort={sort}
                    setSort={setSort}
                    title="최종 − 최초 관측 시각"
                  />
                  <Th
                    label="FL 범위"
                    k="fl"
                    align="right"
                    sort={sort}
                    setSort={setSort}
                    title="I048/090 — 정렬 기준은 최대 FL"
                  />
                  <Th
                    label="평균속도"
                    k="speed"
                    align="right"
                    sort={sort}
                    setSort={setSort}
                    title="I048/200 대지속도 평균"
                  />
                  <Th
                    label="거리범위"
                    k="range"
                    align="right"
                    sort={sort}
                    setSort={setSort}
                    title="I048/040 ρ — 정렬 기준은 최대 거리"
                  />
                  <Th
                    label="Mode-3/A"
                    k="codes"
                    sort={sort}
                    setSort={setSort}
                    title="관측된 Mode-3/A 코드 (최대 8개)"
                  />
                  <Th
                    label="ACAS"
                    k="acas"
                    align="right"
                    sort={sort}
                    setSort={setSort}
                    title="I048/260 ACAS RA 보유 레코드 수"
                  />
                  <Th
                    label="비상"
                    k="emg"
                    align="right"
                    sort={sort}
                    setSort={setSort}
                    title="Mode-3/A 비상코드(7500/7600/7700) 레코드 수"
                  />
                  <Th
                    label="트랙번호"
                    k="track"
                    align="right"
                    sort={sort}
                    setSort={setSort}
                    title="고유 트랙번호 수 (SAC/SIC 구분)"
                  />
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const nm = acName.get(m.mode_s.toUpperCase());
                  const dur = m.first_ts != null && m.last_ts != null ? m.last_ts - m.first_ts : null;
                  return (
                    <tr key={m.mode_s} className="border-t border-gray-100 hover:bg-[#a60739]/5">
                      <td className="px-2 py-1">
                        <FilterChipButton
                          title={`Mode-S ${m.mode_s} 로 전수 재집계 (필터바 Mode-S 칸에 반영)`}
                          onClick={() => onQuickFilter({ modeS: m.mode_s })}
                        />
                      </td>
                      <td className="whitespace-nowrap px-2 py-1" title={labelFor(m.mode_s, aircraft)}>
                        <span className="font-mono text-gray-700">{m.mode_s}</span>
                        {nm && <span className="ml-1 text-[10px] font-medium text-[#a60739]">{nm}</span>}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 font-mono text-gray-600">
                        {m.callsign && m.callsign.trim() !== "" ? m.callsign : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-gray-700">{m.count.toLocaleString()}</td>
                      <td className="whitespace-nowrap px-2 py-1 font-mono text-gray-600">
                        {m.first_ts != null ? formatTime(m.first_ts, tz) : "—"}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 font-mono text-gray-600">
                        {m.last_ts != null ? formatTime(m.last_ts, tz) : "—"}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-gray-600">
                        {dur != null ? fmtSpanDur(dur) : "—"}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-gray-600">
                        {m.fl_min != null && m.fl_max != null ? `${m.fl_min}–${m.fl_max}` : "—"}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-gray-600">
                        {m.speed_mean_kts != null ? `${m.speed_mean_kts.toFixed(0)} kt` : "—"}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-gray-600">
                        {m.range_min_nm != null && m.range_max_nm != null
                          ? `${m.range_min_nm.toFixed(1)}–${m.range_max_nm.toFixed(1)} NM`
                          : "—"}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1">
                        {m.mode3a_codes.length === 0 ? (
                          <span className="text-gray-300">—</span>
                        ) : (
                          <span className="inline-flex flex-wrap items-center gap-0.5">
                            {/* 코드 칩 클릭 = 그 코드로 재집계 + Mode-3/A 토픽으로 이동 (단일 라우트라 필터가 보존된다) */}
                            {m.mode3a_codes.map((c) => {
                              const emg = EMERGENCY_CODES.has(c);
                              return (
                                <button
                                  key={c}
                                  type="button"
                                  onClick={() => {
                                    onQuickFilter({ mode3a: c });
                                    navigate("/asterix/stats/mode3a");
                                  }}
                                  title={`Mode-3/A ${c}${emg ? " (비상코드)" : ""} 로 재집계하고 Mode-3/A·비상 토픽으로 이동`}
                                  className={`rounded px-1 py-px text-[9px] tabular-nums transition-opacity hover:opacity-75 ${
                                    emg
                                      ? "bg-[#e94560] font-semibold text-white"
                                      : "bg-gray-100 text-gray-600 hover:bg-[#a60739]/10 hover:text-[#a60739]"
                                  }`}
                                >
                                  {c}
                                </button>
                              );
                            })}
                          </span>
                        )}
                      </td>
                      <td
                        className={`px-2 py-1 text-right tabular-nums ${
                          m.acas_count > 0 ? "font-semibold text-[#a60739]" : "text-gray-300"
                        }`}
                      >
                        {m.acas_count.toLocaleString()}
                      </td>
                      <td
                        className={`px-2 py-1 text-right tabular-nums ${
                          m.emergency_count > 0 ? "font-semibold text-[#e94560]" : "text-gray-300"
                        }`}
                      >
                        {m.emergency_count.toLocaleString()}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-gray-600">
                        {m.track_numbers.toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* 레코드 수 상위 분포 — 분모는 필터 적용 전체 레코드 (대시보드 Mode-S 상위와 동일) */}
      <Section
        title={`레코드 수 상위 ${topItems.length} Mode-S`}
        right={<span className="text-[10px] text-gray-400">분모 = 필터 적용 레코드 {stats.record_count.toLocaleString()}건</span>}
      >
        <LabeledBars items={topItems} total={stats.record_count} color="#0f766e" />
      </Section>
    </div>
  );
}
