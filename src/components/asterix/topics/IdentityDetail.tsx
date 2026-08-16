/**
 * 토픽: Mode-S 식별 상세.
 *
 * Rust 가 내려준 modes_table(count 내림차순, 상한 2,000)을 전수 렌더한다.
 * 검색/정렬은 전부 클라이언트 로컬 상태 — 재집계(필터바)와 무관하게 즉시 반응한다.
 * (다운샘플링 금지 — 표시 행은 스크롤 컨테이너로만 제한)
 */

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useAppStore } from "../../../store";
import { Section, StatCard, LabeledBars } from "../shared";
import { formatTime, labelFor } from "../format";
import type { AsterixDetailStats, ModeSDetailRow, TzMode } from "../../../types/asterixDetail";
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
type SortDir = "asc" | "desc";

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

type SortState = { key: SortKey; dir: SortDir };

/**
 * 정렬 가능한 헤더 셀 — 컴포넌트 밖에 두어 검색어 입력마다 헤더가 재마운트되지 않게 한다.
 * 같은 컬럼 재클릭=방향 토글, 다른 컬럼=해당 컬럼 기본 방향.
 */
function SortTh({
  label,
  k,
  sort,
  setSort,
  align = "left",
  title,
}: {
  label: string;
  k: SortKey;
  sort: SortState;
  setSort: React.Dispatch<React.SetStateAction<SortState>>;
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
          setSort((s) =>
            s.key === k ? { key: k, dir: s.dir === "asc" ? "desc" : "asc" } : { key: k, dir: DEFAULT_DIR[k] },
          )
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

export default function IdentityDetail({ detail, tz }: { detail: AsterixDetailStats; tz: TzMode }) {
  const { modes_table, modes_table_truncated, stats } = detail;
  const aircraft = useAppStore((s) => s.aircraft);

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState>({ key: "count", dir: "desc" });

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

    const dir = sort.dir === "asc" ? 1 : -1;
    const arr = base.slice();
    arr.sort((a, b) => {
      const va = sortVal(a, sort.key);
      const vb = sortVal(b, sort.key);
      if (va == null || vb == null) {
        // 결측 우선순위는 정렬 방향과 무관 (항상 아래로)
        if (va != null) return -1;
        if (vb != null) return 1;
      } else {
        const c =
          typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
        if (c !== 0) return c * dir;
      }
      return b.count - a.count || a.mode_s.localeCompare(b.mode_s);
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

  return (
    <div className="space-y-3">
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
            <div className="relative flex items-center">
              <Search size={11} className="pointer-events-none absolute left-2 text-gray-400" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Mode-S hex · 호출부호 · 기체명"
                className="h-7 w-52 rounded-md border border-gray-200 bg-white pl-7 pr-6 text-[11px] placeholder-gray-400 focus:border-[#a60739] focus:outline-none"
              />
              {query !== "" && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="absolute right-1.5 text-gray-400 transition-colors hover:text-[#a60739]"
                  title="검색어 지우기"
                >
                  <X size={11} />
                </button>
              )}
            </div>
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
                  <SortTh label="Mode-S" k="mode_s" sort={sort} setSort={setSort} />
                  <SortTh label="호출부호" k="callsign" sort={sort} setSort={setSort} title="BDS 2,0 항공기 식별" />
                  <SortTh label="레코드" k="count" align="right" sort={sort} setSort={setSort} />
                  <SortTh label={`최초 (${tz})`} k="first" sort={sort} setSort={setSort} />
                  <SortTh label={`최종 (${tz})`} k="last" sort={sort} setSort={setSort} />
                  <SortTh
                    label="체공시간"
                    k="dur"
                    align="right"
                    sort={sort}
                    setSort={setSort}
                    title="최종 − 최초 관측 시각"
                  />
                  <SortTh
                    label="FL 범위"
                    k="fl"
                    align="right"
                    sort={sort}
                    setSort={setSort}
                    title="I048/090 — 정렬 기준은 최대 FL"
                  />
                  <SortTh
                    label="평균속도"
                    k="speed"
                    align="right"
                    sort={sort}
                    setSort={setSort}
                    title="I048/200 대지속도 평균"
                  />
                  <SortTh
                    label="거리범위"
                    k="range"
                    align="right"
                    sort={sort}
                    setSort={setSort}
                    title="I048/040 ρ — 정렬 기준은 최대 거리"
                  />
                  <SortTh
                    label="Mode-3/A"
                    k="codes"
                    sort={sort}
                    setSort={setSort}
                    title="관측된 Mode-3/A 코드 (최대 8개)"
                  />
                  <SortTh
                    label="ACAS"
                    k="acas"
                    align="right"
                    sort={sort}
                    setSort={setSort}
                    title="I048/260 ACAS RA 보유 레코드 수"
                  />
                  <SortTh
                    label="비상"
                    k="emg"
                    align="right"
                    sort={sort}
                    setSort={setSort}
                    title="Mode-3/A 비상코드(7500/7600/7700) 레코드 수"
                  />
                  <SortTh
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
                            {m.mode3a_codes.map((c) =>
                              EMERGENCY_CODES.has(c) ? (
                                <span
                                  key={c}
                                  title="Mode-3/A 비상코드"
                                  className="rounded bg-[#e94560] px-1 py-px text-[9px] font-semibold tabular-nums text-white"
                                >
                                  {c}
                                </span>
                              ) : (
                                <span
                                  key={c}
                                  className="rounded bg-gray-100 px-1 py-px text-[9px] tabular-nums text-gray-600"
                                >
                                  {c}
                                </span>
                              ),
                            )}
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
