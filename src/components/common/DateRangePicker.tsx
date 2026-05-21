import { useState } from "react";
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";

/* 테마형 단일 캘린더 기간 선택기.
   - 한 달 캘린더 + 범위 선택(시작 클릭 → 끝 클릭)
   - 범위는 brand-red 틴트 밴드로 시각화
   - 캘린더 아래 HH:MM 스피너 2조 (시작 시간 / 끝 시간) */

type Tz = "UTC" | "KST";

type DateRangePickerProps = {
  startDt: string; // "YYYY-MM-DDTHH:MM" or ""
  endDt: string; // same
  tz: Tz;
  onStartChange: (s: string) => void;
  onEndChange: (s: string) => void;
  onTzChange: (tz: Tz) => void;
  onClear: () => void;
  onDone: () => void;
};

type DtParts = { year: number; month: number; day: number; hour: number; minute: number };
type ViewMonth = { year: number; month: number };

const DAY_KO = ["일", "월", "화", "수", "목", "금", "토"];

function parseDt(s: string): DtParts | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  return { year: +m[1], month: +m[2] - 1, day: +m[3], hour: +m[4], minute: +m[5] };
}
function formatDt({ year, month, day, hour, minute }: DtParts): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${year}-${p(month + 1)}-${p(day)}T${p(hour)}:${p(minute)}`;
}
function dayUtc(y: number, mo: number, d: number): number {
  return Date.UTC(y, mo, d);
}
function cmpDate(a: DtParts | { year: number; month: number; day: number }, b: DtParts): number {
  return dayUtc(a.year, a.month, a.day) - dayUtc(b.year, b.month, b.day);
}

/* ─── HH/MM 스피너 입력 ──────────────────────────────────── */
function Spinner({
  value,
  onChange,
  min,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
}) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return (
    <div className="inline-flex h-7 items-stretch overflow-hidden rounded-md border border-gray-200 bg-white">
      <input
        type="text"
        inputMode="numeric"
        value={String(value).padStart(2, "0")}
        onChange={(e) => {
          const raw = e.target.value.replace(/\D/g, "").slice(-2);
          if (raw === "") {
            onChange(0);
            return;
          }
          const n = parseInt(raw, 10);
          if (!isNaN(n)) onChange(clamp(n));
        }}
        className="w-7 bg-transparent px-1 text-center text-[11px] tabular-nums focus:outline-none"
      />
      <div className="flex flex-col border-l border-gray-200">
        <button
          onClick={() => onChange(clamp(value + 1))}
          className="flex h-3.5 w-4 items-center justify-center text-gray-400 hover:bg-gray-100 hover:text-[#a60739]"
          tabIndex={-1}
        >
          <ChevronUp size={9} />
        </button>
        <button
          onClick={() => onChange(clamp(value - 1))}
          className="flex h-3.5 w-4 items-center justify-center border-t border-gray-200 text-gray-400 hover:bg-gray-100 hover:text-[#a60739]"
          tabIndex={-1}
        >
          <ChevronDown size={9} />
        </button>
      </div>
    </div>
  );
}

/* ─── 범위 인지 단일 월 캘린더 ───────────── */
function MonthCalendar({
  rangeStart,
  rangeEnd,
  viewMonth,
  onViewMonthChange,
  onPickDay,
}: {
  rangeStart: DtParts | null;
  rangeEnd: DtParts | null;
  viewMonth: ViewMonth;
  onViewMonthChange: (v: ViewMonth) => void;
  onPickDay: (d: { year: number; month: number; day: number }) => void;
}) {
  const { year, month } = viewMonth;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstWeekday = new Date(year, month, 1).getDay();

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const startMs = rangeStart ? dayUtc(rangeStart.year, rangeStart.month, rangeStart.day) : null;
  const endMs = rangeEnd ? dayUtc(rangeEnd.year, rangeEnd.month, rangeEnd.day) : null;
  const rangeLo = startMs != null && endMs != null ? Math.min(startMs, endMs) : null;
  const rangeHi = startMs != null && endMs != null ? Math.max(startMs, endMs) : null;

  const prevMonth = () =>
    onViewMonthChange(month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 });
  const nextMonth = () =>
    onViewMonthChange(month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 });

  return (
    <div>
      <div className="mb-2 flex items-center justify-between px-1">
        <button onClick={prevMonth} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700">
          <ChevronLeft size={14} />
        </button>
        <span className="text-[12px] font-semibold tabular-nums text-gray-800">
          {year}년 {month + 1}월
        </span>
        <button onClick={nextMonth} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700">
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-y-0.5">
        {DAY_KO.map((d, i) => (
          <div
            key={d}
            className={`pb-1 text-center text-[9.5px] font-medium ${i === 0 ? "text-[#a60739]/70" : "text-gray-400"}`}
          >
            {d}
          </div>
        ))}
        {cells.map((d, i) => {
          if (d == null) return <div key={`e-${i}`} className="h-8" />;
          const ms = dayUtc(year, month, d);
          const isStart = ms === startMs;
          const isEnd = ms === endMs;
          const isEndpoint = isStart || isEnd;
          const inRange = rangeLo != null && rangeHi != null && ms > rangeLo && ms < rangeHi;

          // 범위 밴드 — 시작 endpoint에서 페이드 인, 끝 endpoint에서 페이드 아웃
          let bandCls = "";
          if (inRange) bandCls = "bg-[#a60739]/10";
          else if (isEndpoint && rangeLo != null && rangeHi != null && rangeLo !== rangeHi) {
            bandCls =
              ms === rangeLo
                ? "bg-gradient-to-r from-transparent to-[#a60739]/10"
                : "bg-gradient-to-l from-transparent to-[#a60739]/10";
          }

          return (
            <div key={d} className={`relative flex h-8 items-center justify-center ${bandCls}`}>
              <button
                onClick={() => onPickDay({ year, month, day: d })}
                className={`relative z-10 inline-flex h-7 w-7 items-center justify-center rounded-md text-[11px] tabular-nums transition-colors ${
                  isEndpoint
                    ? "bg-[#a60739] font-semibold text-white shadow-sm"
                    : inRange
                      ? "font-medium text-[#a60739] hover:bg-[#a60739]/15"
                      : "text-gray-700 hover:bg-gray-100"
                }`}
              >
                {d}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── DateRangePicker ──────────────────────────────────────── */
export default function DateRangePicker({
  startDt,
  endDt,
  tz,
  onStartChange,
  onEndChange,
  onTzChange,
  onClear,
  onDone,
}: DateRangePickerProps) {
  const sParts = parseDt(startDt);
  const eParts = parseDt(endDt);

  const today = new Date();
  const initView: ViewMonth = sParts
    ? { year: sParts.year, month: sParts.month }
    : { year: today.getUTCFullYear(), month: today.getUTCMonth() };
  const [view, setView] = useState<ViewMonth>(initView);

  /* 범위 선택 로직:
     - 양쪽 모두 없거나 / 양쪽 모두 있는 상태에서 클릭 → 시작 새로 설정, 끝 비움
     - 시작만 있는 상태에서 클릭 → 끝 설정 (클릭이 시작보다 이르면 swap) */
  const handlePick = (d: { year: number; month: number; day: number }) => {
    if (!sParts || (sParts && eParts)) {
      // 새 범위 시작
      const newStart: DtParts = {
        ...d,
        hour: sParts ? sParts.hour : 0,
        minute: sParts ? sParts.minute : 0,
      };
      onStartChange(formatDt(newStart));
      onEndChange("");
      return;
    }
    // 시작만 있고 끝 없음 — 끝 설정 (시작보다 이르면 swap)
    if (cmpDate(d, sParts) < 0) {
      const newStart: DtParts = { ...d, hour: 0, minute: 0 };
      const newEnd: DtParts = {
        year: sParts.year,
        month: sParts.month,
        day: sParts.day,
        hour: eParts ? eParts.hour : 23,
        minute: eParts ? eParts.minute : 59,
      };
      onStartChange(formatDt(newStart));
      onEndChange(formatDt(newEnd));
    } else {
      const newEnd: DtParts = {
        ...d,
        hour: eParts ? eParts.hour : 23,
        minute: eParts ? eParts.minute : 59,
      };
      onEndChange(formatDt(newEnd));
    }
  };

  const updateStartTime = (key: "hour" | "minute", v: number) => {
    if (!sParts) {
      // 시작 시간을 먼저 만지면 시작 날짜를 view month 1일로 시드
      const seed: DtParts = { year: view.year, month: view.month, day: 1, hour: 0, minute: 0, [key]: v };
      onStartChange(formatDt(seed));
      return;
    }
    onStartChange(formatDt({ ...sParts, [key]: v }));
  };
  const updateEndTime = (key: "hour" | "minute", v: number) => {
    if (!eParts) {
      // 끝 날짜를 sParts(있으면) 또는 view month 1일로 시드
      const seedDate = sParts ?? { year: view.year, month: view.month, day: 1 };
      const seed: DtParts = { ...seedDate, hour: 23, minute: 59, [key]: v };
      onEndChange(formatDt(seed));
      return;
    }
    onEndChange(formatDt({ ...eParts, [key]: v }));
  };

  return (
    <div className="w-[280px]">
      {/* 헤더 */}
      <div className="mb-3 flex items-center justify-between border-b border-gray-100 pb-2">
        <span className="text-[12px] font-semibold text-gray-800">기간 선택</span>
        <div className="inline-flex h-6 overflow-hidden rounded-md border border-gray-200 bg-white">
          {(["UTC", "KST"] as Tz[]).map((m) => (
            <button
              key={m}
              onClick={() => onTzChange(m)}
              className={`px-2 text-[9.5px] font-medium uppercase tracking-wider ${
                tz === m ? "bg-[#a60739] text-white" : "text-gray-500 hover:bg-gray-100"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {/* 단일 캘린더 */}
      <MonthCalendar
        rangeStart={sParts}
        rangeEnd={eParts}
        viewMonth={view}
        onViewMonthChange={setView}
        onPickDay={handlePick}
      />

      {/* 시간 입력 */}
      <div className="mt-3 border-t border-gray-100 pt-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">시작 시간</span>
              {sParts && (
                <span className="text-[9.5px] tabular-nums text-gray-400">
                  {String(sParts.month + 1).padStart(2, "0")}.{String(sParts.day).padStart(2, "0")}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Spinner value={sParts ? sParts.hour : 0} onChange={(v) => updateStartTime("hour", v)} min={0} max={23} />
              <span className="text-[11px] text-gray-400">:</span>
              <Spinner value={sParts ? sParts.minute : 0} onChange={(v) => updateStartTime("minute", v)} min={0} max={59} />
            </div>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">끝 시간</span>
              {eParts && (
                <span className="text-[9.5px] tabular-nums text-gray-400">
                  {String(eParts.month + 1).padStart(2, "0")}.{String(eParts.day).padStart(2, "0")}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Spinner value={eParts ? eParts.hour : 23} onChange={(v) => updateEndTime("hour", v)} min={0} max={23} />
              <span className="text-[11px] text-gray-400">:</span>
              <Spinner value={eParts ? eParts.minute : 59} onChange={(v) => updateEndTime("minute", v)} min={0} max={59} />
            </div>
          </div>
        </div>
      </div>

      {/* 푸터 */}
      <div className="mt-3 flex items-center justify-between border-t border-gray-100 pt-2">
        <button onClick={onClear} className="text-[11px] text-gray-500 hover:text-[#a60739]">
          전체 초기화
        </button>
        <button
          onClick={onDone}
          className="rounded bg-[#a60739] px-3 py-1 text-[11px] font-medium text-white hover:bg-[#8a0630]"
        >
          완료
        </button>
      </div>
    </div>
  );
}
