/**
 * ASTERIX 통계 상세 — 필터 바 (controlled).
 * 필터 상태 소유는 부모(AsterixStatDetail 페이지)이고 이 컴포넌트는 표시·편집만 한다.
 * 외형은 프레임 탐색 필터바 관례(h-7 · text-[11px] · #a60739 활성)를 그대로 따른다.
 */

import { useEffect, useRef, useState } from "react";
import { Clock, ChevronDown, ChevronUp, Loader2, Search, SlidersHorizontal, X } from "lucide-react";
import DateRangePicker from "../common/DateRangePicker";
import { dtLocalToTs, KST_OFFSET_SECS, pad } from "./format";
import type { AsterixStats } from "../../types/asterix";
import type { AsterixDetailFilter, TzMode } from "../../types/asterixDetail";

/** Unix 초 → DateRangePicker 입력 문자열("YYYY-MM-DDTHH:MM") — dtLocalToTs 의 역함수 */
function tsToDtLocal(ts: number | undefined, tz: TzMode): string {
  if (ts == null) return "";
  const d = new Date((ts + (tz === "KST" ? KST_OFFSET_SECS : 0)) * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 고급 팝오버 숫자 입력 8칸 — 빈칸 = 미설정 */
type NumKey =
  | "rangeMinNm"
  | "rangeMaxNm"
  | "azMinDeg"
  | "azMaxDeg"
  | "flMin"
  | "flMax"
  | "speedMinKts"
  | "speedMaxKts";

const NUM_ROWS: { label: string; unit: string; min: NumKey; max: NumKey; hint?: string }[] = [
  { label: "거리", unit: "NM", min: "rangeMinNm", max: "rangeMaxNm" },
  { label: "방위", unit: "°", min: "azMinDeg", max: "azMaxDeg", hint: "최소 > 최대이면 0° 통과 구간" },
  { label: "고도", unit: "FL", min: "flMin", max: "flMax" },
  { label: "속도", unit: "kt", min: "speedMinKts", max: "speedMaxKts" },
];
const NUM_KEYS: NumKey[] = NUM_ROWS.flatMap((r) => [r.min, r.max]);

type NumDraft = Record<NumKey, string>;

function draftFrom(filter: AsterixDetailFilter): NumDraft {
  const d = {} as NumDraft;
  for (const k of NUM_KEYS) {
    const v = filter[k];
    d[k] = v == null ? "" : String(v);
  }
  return d;
}

/**
 * 활성 필터 존재 여부 (초기화 버튼 노출 판정).
 * 필드를 열거하지 않고 값만 훑으므로 mode3a·hasAcas·hasEmergency 등 새 필드도 자동 포함된다.
 */
export function hasActiveFilter(f: AsterixDetailFilter): boolean {
  return Object.values(f).some((v) => v !== undefined && v !== "");
}

/** Mode-3/A 입력 정규화 — 옥탈(0–7) 4자리까지만 허용 */
function sanitizeMode3a(raw: string): string {
  return raw.replace(/[^0-7]/g, "").slice(0, 4);
}

export default function DetailFilterBar({
  filter,
  onChange,
  onApply,
  busy,
  baseStats,
  tz,
  setTz,
}: {
  filter: AsterixDetailFilter;
  onChange: (next: AsterixDetailFilter) => void;
  onApply: () => void;
  busy: boolean;
  /** SAC/SIC 옵션 소스 — 필터 전 전체 스캔 결과 */
  baseStats: AsterixStats;
  tz: TzMode;
  setTz: (t: TzMode) => void;
}) {
  const [dateOpen, setDateOpen] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const [draft, setDraft] = useState<NumDraft>(() => draftFrom(filter));

  /**
   * 우리가 올려보낸 필터가 아니라 외부에서 바뀐 경우에만 드래프트 재동기화.
   * 외부 변경 = 초기화 + **토픽 본문의 퀵필터**(차트 브러시 → rangeMinNm 등). 이걸 놓치면
   * 고급 팝오버가 낡은 숫자를 보여주고, 그 상태로 다른 칸을 건드리면 낡은 값이 되살아난다.
   */
  const lastEmitted = useRef<AsterixDetailFilter>(filter);
  useEffect(() => {
    if (filter === lastEmitted.current) return;
    lastEmitted.current = filter;
    setDraft(draftFrom(filter));
  }, [filter]);

  const emit = (next: AsterixDetailFilter) => {
    lastEmitted.current = next;
    onChange(next);
  };

  /** undefined 값 키는 아예 제거 — 캐시 키(JSON.stringify) 안정화 */
  const patch = (p: Partial<AsterixDetailFilter>) => {
    const next: AsterixDetailFilter = { ...filter, ...p };
    for (const k of Object.keys(next) as (keyof AsterixDetailFilter)[]) {
      if (next[k] === undefined) delete next[k];
    }
    emit(next);
  };

  const startDt = tsToDtLocal(filter.timeMin, tz);
  const endDt = tsToDtLocal(filter.timeMax, tz);
  const sacSicValue = filter.sac != null && filter.sic != null ? `${filter.sac}/${filter.sic}` : "";
  const simValue = filter.sim === true ? "only" : filter.sim === false ? "exclude" : "";
  const advCount = NUM_KEYS.filter((k) => filter[k] != null).length;
  const anyFilter = hasActiveFilter(filter);

  const onNumChange = (k: NumKey, raw: string) => {
    const text = raw.trim();
    setDraft((d) => ({ ...d, [k]: raw }));
    if (text === "") {
      patch({ [k]: undefined } as Partial<AsterixDetailFilter>);
      return;
    }
    const n = Number(text);
    if (!Number.isFinite(n)) return; // "-" 등 입력 중간 상태는 드래프트만 유지
    patch({ [k]: n } as Partial<AsterixDetailFilter>);
  };

  const inputCls =
    "h-7 w-16 rounded-md border border-gray-200 bg-white px-1.5 text-center text-[11px] tabular-nums placeholder-gray-300 focus:border-[#a60739] focus:outline-none";

  /** 팝오버를 열 때도 드래프트를 최신 filter 로 맞춘다 (퀵필터가 바꾼 값·입력 중간 상태 정리) */
  const toggleAdv = () => {
    if (!advOpen) setDraft(draftFrom(filter));
    setAdvOpen((o) => !o);
  };

  /** 보유 여부 온오프 칩 — 켬 = true 설정, 끔 = 키 삭제(Rust 시맨틱: 보유 레코드만) */
  const flagChip = (key: "hasAcas" | "hasEmergency", label: string, title: string) => {
    const on = filter[key] === true;
    return (
      <button
        key={key}
        type="button"
        onClick={() => patch({ [key]: on ? undefined : true } as Partial<AsterixDetailFilter>)}
        title={title}
        className={`inline-flex h-7 items-center rounded-md border px-2.5 text-[10.5px] font-medium transition-colors ${
          on
            ? "border-[#a60739]/30 bg-[#a60739]/8 text-[#a60739]"
            : "border-gray-200 bg-white text-gray-500 hover:text-gray-700"
        }`}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* 기간 */}
      <div className="relative flex items-center">
        <button
          onClick={() => setDateOpen((o) => !o)}
          className={`inline-flex h-7 items-center gap-1.5 rounded-md border bg-white px-2.5 text-[10.5px] font-medium transition-colors ${
            startDt || endDt
              ? "border-[#a60739]/30 bg-[#a60739]/8 text-[#a60739]"
              : "border-gray-200 text-gray-500 hover:text-gray-700"
          }`}
        >
          <Clock size={12} />
          {startDt || endDt ? (
            <span className="font-mono tabular-nums">
              {(startDt || "…").slice(5).replace("T", " ")} ~ {(endDt || "…").slice(5).replace("T", " ")}
            </span>
          ) : (
            <span>기간</span>
          )}
          {dateOpen ? <ChevronUp size={11} className="text-gray-400" /> : <ChevronDown size={11} className="text-gray-400" />}
        </button>
        {dateOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setDateOpen(false)} />
            <div className="absolute left-0 top-[calc(100%+4px)] z-50 rounded-lg border border-gray-200 bg-white p-3 shadow-lg">
              <DateRangePicker
                startDt={startDt}
                endDt={endDt}
                tz={tz}
                onStartChange={(s) => patch({ timeMin: dtLocalToTs(s, tz) ?? undefined })}
                onEndChange={(s) => patch({ timeMax: dtLocalToTs(s, tz) ?? undefined })}
                onTzChange={setTz}
                onClear={() => patch({ timeMin: undefined, timeMax: undefined })}
                onDone={() => setDateOpen(false)}
              />
            </div>
          </>
        )}
      </div>

      {/* SAC/SIC */}
      <select
        value={sacSicValue}
        onChange={(e) => {
          if (e.target.value === "") {
            patch({ sac: undefined, sic: undefined });
            return;
          }
          const [sac, sic] = e.target.value.split("/").map(Number);
          patch({ sac, sic });
        }}
        className="h-7 rounded-md border border-gray-200 bg-white px-2 text-[11px] text-gray-700 focus:border-[#a60739] focus:outline-none"
      >
        <option value="">전체 출처 (SAC/SIC)</option>
        {baseStats.sac_sic_counts.map((s) => (
          <option key={`${s.sac}/${s.sic}`} value={`${s.sac}/${s.sic}`}>
            SAC {s.sac} · SIC {s.sic}
          </option>
        ))}
      </select>

      {/* Mode-S */}
      <div className="relative">
        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gray-400">
          <Search size={12} />
        </span>
        <input
          type="text"
          value={filter.modeS ?? ""}
          onChange={(e) => patch({ modeS: e.target.value.trim() === "" ? undefined : e.target.value })}
          onKeyDown={(e) => e.key === "Enter" && onApply()}
          placeholder="Mode-S (hex 부분일치)"
          className="h-7 w-44 rounded-md border border-gray-200 bg-white pl-7 pr-2 text-[11px] placeholder-gray-400 focus:border-[#a60739] focus:outline-none"
        />
      </div>

      {/* Mode-3/A (옥탈 4자리 정확일치 — Rust 는 유효 V/G=0 코드만 대상으로 삼는다) */}
      <input
        type="text"
        inputMode="numeric"
        value={filter.mode3a ?? ""}
        onChange={(e) => {
          const v = sanitizeMode3a(e.target.value);
          patch({ mode3a: v === "" ? undefined : v });
        }}
        onKeyDown={(e) => e.key === "Enter" && onApply()}
        placeholder="Mode-3/A"
        title="I048/070 Mode-3/A 옥탈 4자리 정확일치 (유효 V/G=0 코드만)"
        className="h-7 w-24 rounded-md border border-gray-200 bg-white px-2 text-[11px] tabular-nums placeholder-gray-400 focus:border-[#a60739] focus:outline-none"
      />

      {/* 카테고리 */}
      <select
        value={filter.cat ?? ""}
        onChange={(e) => patch({ cat: e.target.value === "" ? undefined : Number(e.target.value) })}
        className="h-7 rounded-md border border-gray-200 bg-white px-2 text-[11px] text-gray-700 focus:border-[#a60739] focus:outline-none"
      >
        <option value="">전체 카테고리</option>
        <option value={0x30}>CAT048 표적보고</option>
        <option value={0x22}>CAT034 서비스</option>
        <option value={0x08}>CAT008 기상</option>
      </select>

      {/* SIM */}
      <select
        value={simValue}
        onChange={(e) =>
          patch({ sim: e.target.value === "only" ? true : e.target.value === "exclude" ? false : undefined })
        }
        title="I048/020 SIM — 시뮬레이션 표적보고"
        className="h-7 rounded-md border border-gray-200 bg-white px-2 text-[11px] text-gray-700 focus:border-[#a60739] focus:outline-none"
      >
        <option value="">SIM 전체</option>
        <option value="only">SIM만</option>
        <option value="exclude">SIM 제외</option>
      </select>

      {/* 보유 여부 칩 */}
      {flagChip("hasAcas", "ACAS", "I048/260 ACAS RA(해결권고) 를 보유한 레코드만")}
      {flagChip("hasEmergency", "비상", "Mode-3/A 비상코드(7500/7600/7700) 레코드만")}

      <span className="mx-0.5 h-4 w-px bg-gray-200" />

      {/* 고급 (거리/방위/고도/속도 범위) */}
      <div className="relative flex items-center">
        <button
          onClick={toggleAdv}
          className={`inline-flex h-7 items-center gap-1.5 rounded-md border bg-white px-2.5 text-[10.5px] font-medium transition-colors ${
            advCount > 0
              ? "border-[#a60739]/30 bg-[#a60739]/8 text-[#a60739]"
              : "border-gray-200 text-gray-500 hover:text-gray-700"
          }`}
        >
          <SlidersHorizontal size={12} />
          고급
          {advCount > 0 && <span className="tabular-nums">({advCount})</span>}
          {advOpen ? <ChevronUp size={11} className="text-gray-400" /> : <ChevronDown size={11} className="text-gray-400" />}
        </button>
        {advOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setAdvOpen(false)} />
            <div className="absolute left-0 top-[calc(100%+4px)] z-50 w-[290px] rounded-lg border border-gray-200 bg-white p-3 shadow-lg">
              <div className="mb-2 flex items-center justify-between border-b border-gray-100 pb-2">
                <span className="text-[12px] font-semibold text-gray-800">범위 필터</span>
                <span className="text-[10px] text-gray-400">빈칸 = 미설정</span>
              </div>
              <div className="space-y-2">
                {NUM_ROWS.map((row) => (
                  <div key={row.label} className="flex items-center gap-1.5">
                    <span className="w-10 shrink-0 text-[11px] text-gray-600" title={row.hint}>
                      {row.label}
                    </span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={draft[row.min]}
                      onChange={(e) => onNumChange(row.min, e.target.value)}
                      placeholder="min"
                      className={inputCls}
                    />
                    <span className="text-[11px] text-gray-300">–</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={draft[row.max]}
                      onChange={(e) => onNumChange(row.max, e.target.value)}
                      placeholder="max"
                      className={inputCls}
                    />
                    <span className="w-6 shrink-0 text-[10px] text-gray-400">{row.unit}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-gray-100 pt-2">
                <button
                  onClick={() => {
                    const next: AsterixDetailFilter = { ...filter };
                    for (const k of NUM_KEYS) delete next[k];
                    emit(next);
                    setDraft(draftFrom(next));
                  }}
                  className="text-[11px] text-gray-500 hover:text-[#a60739]"
                >
                  범위 초기화
                </button>
                <button
                  onClick={() => {
                    setAdvOpen(false);
                    onApply();
                  }}
                  className="rounded bg-[#a60739] px-3 py-1 text-[11px] font-medium text-white hover:bg-[#8a0630]"
                >
                  적용
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      <button
        onClick={onApply}
        disabled={busy}
        className="inline-flex h-7 items-center gap-1.5 rounded-md bg-[#a60739] px-3 text-[11px] font-medium text-white transition-colors hover:bg-[#8a062f] disabled:opacity-50"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
        적용
      </button>

      {anyFilter && (
        <button
          onClick={() => {
            emit({});
            setDraft(draftFrom({}));
          }}
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[10.5px] text-gray-500 hover:bg-white hover:text-[#a60739]"
        >
          <X size={11} />
          초기화
        </button>
      )}
    </div>
  );
}
