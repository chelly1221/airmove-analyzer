import { useCallback, useMemo, useState } from "react";
import { ArrowUp, ArrowDown, Search, Info } from "lucide-react";
import Modal from "../common/Modal";
import { useAppStore } from "../../store";
import type { TcasEvent } from "../../utils/tcasEvents";
import type { Flight } from "../../types";

type SortKey =
  | "startTime"
  | "ownLabel"
  | "ownAltFt"
  | "threatLabel"
  | "tti"
  | "raDescription"
  | "raKind"
  | "threatRangeNm"
  | "threatBearingDeg"
  | "threatAltFt"
  | "duration"
  | "raPointCount";

interface Props {
  open: boolean;
  onClose: () => void;
  flights: Flight[];
  /** 행 클릭 시 호출 — 모달 닫고 지도 점프 */
  onSelect: (ev: TcasEvent) => void;
}

type TzMode = "UTC" | "KST";
const KST_OFFSET_SECS = 9 * 3600;

/** Unix seconds → "YY-MM-DD HH:mm:ss" (tz 기준) */
function formatTime(ts: number, tz: TzMode): string {
  const offset = tz === "KST" ? KST_OFFSET_SECS : 0;
  const d = new Date((ts + offset) * 1000);
  const yy = String(d.getUTCFullYear()).slice(2);
  const MM = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yy}-${MM}-${dd} ${hh}:${mm}:${ss}`;
}

/** datetime-local "YYYY-MM-DDTHH:mm" → Unix seconds (tz 기준 해석) */
function dtLocalToTs(s: string, tz: TzMode): number | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const utcMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const offsetMs = tz === "KST" ? KST_OFFSET_SECS * 1000 : 0;
  return (utcMs - offsetMs) / 1000;
}

/** Unix seconds → datetime-local "YYYY-MM-DDTHH:mm" (tz 기준 표시) */
function tsToDtLocal(ts: number, tz: TzMode): string {
  const offset = tz === "KST" ? KST_OFFSET_SECS : 0;
  const d = new Date((ts + offset) * 1000);
  const yy = d.getUTCFullYear();
  const MM = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yy}-${MM}-${dd}T${hh}:${mm}`;
}

function labelFor(modeS: string | undefined, flights: Flight[]): string {
  if (!modeS) return "—";
  const f = flights.find((fl) => fl.mode_s === modeS);
  if (!f) return modeS;
  const name = f.aircraft_name || f.callsign;
  return name ? `${name} (${modeS})` : modeS;
}

const TTI_LABEL: Record<number, string> = {
  0: "상대정보없음",
  1: "Mode-S",
  2: "ATCRBS",
  3: "예비",
};

const TTI_COLOR: Record<number, string> = {
  0: "bg-gray-100 text-gray-500 border-gray-300",
  1: "bg-[#a60739]/10 text-[#a60739] border-[#a60739]/30",
  2: "bg-amber-100 text-amber-700 border-amber-300",
  3: "bg-gray-100 text-gray-500 border-gray-300",
};

export default function TcasEventsModal({ open, onClose, flights, onSelect }: Props) {
  const events = useAppStore((s) => s.tcasEvents);

  // 상세 팝업 (raw 페이로드 표시)
  const [detailEv, setDetailEv] = useState<TcasEvent | null>(null);

  // ─── 필터 상태 ───
  const [search, setSearch] = useState("");
  const [tti0, setTti0] = useState(true);
  const [tti1, setTti1] = useState(true);
  const [tti2, setTti2] = useState(true);
  const [descKeyword, setDescKeyword] = useState("");
  const [tz, setTz] = useState<TzMode>("KST");
  const [startDt, setStartDt] = useState("");
  const [endDt, setEndDt] = useState("");

  // 이벤트 시간 범위 (input 기본값/placeholder용)
  const eventRange = useMemo(() => {
    if (events.length === 0) return null;
    let min = events[0].startTime, max = events[0].startTime;
    for (const ev of events) {
      if (ev.startTime < min) min = ev.startTime;
      if (ev.startTime > max) max = ev.startTime;
    }
    return { min, max };
  }, [events]);

  // ─── 정렬 상태 ───
  const [sortKey, setSortKey] = useState<SortKey>("startTime");
  const [sortDesc, setSortDesc] = useState(false);

  const toggleSort = useCallback((key: SortKey) => {
    if (sortKey === key) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      setSortDesc(key === "threatRangeNm" || key === "threatAltFt" ? false : true);
    }
  }, [sortKey]);

  // ─── 필터링 + 정렬 ───
  const rows = useMemo(() => {
    const q = search.trim().toUpperCase();
    const desc = descKeyword.trim().toLowerCase();
    const tMin = dtLocalToTs(startDt, tz);
    const tMax = dtLocalToTs(endDt, tz);

    const filtered = events.filter((ev) => {
      // 날짜 범위 (UTC 기준 startTime 비교)
      if (tMin != null && ev.startTime < tMin) return false;
      if (tMax != null && ev.startTime > tMax) return false;
      // TID 종류
      if (ev.threatTti === 0 && !tti0) return false;
      if (ev.threatTti === 1 && !tti1) return false;
      if (ev.threatTti === 2 && !tti2) return false;
      // 검색 (mode_s / callsign / aircraft_name)
      if (q) {
        const ownLabel = labelFor(ev.ownModeS, flights).toUpperCase();
        const threatLabel = labelFor(ev.threatModeS, flights).toUpperCase();
        if (!ownLabel.includes(q) && !threatLabel.includes(q)) return false;
      }
      // RA 의도 키워드
      if (desc && !ev.raDescription.toLowerCase().includes(desc)) return false;
      return true;
    });

    const dir = sortDesc ? -1 : 1;
    filtered.sort((a, b) => {
      let av: number | string;
      let bv: number | string;
      switch (sortKey) {
        case "startTime": av = a.startTime; bv = b.startTime; break;
        case "ownLabel": av = labelFor(a.ownModeS, flights); bv = labelFor(b.ownModeS, flights); break;
        case "ownAltFt": av = a.ownAltFt; bv = b.ownAltFt; break;
        case "threatLabel": av = labelFor(a.threatModeS, flights); bv = labelFor(b.threatModeS, flights); break;
        case "tti": av = a.threatTti; bv = b.threatTti; break;
        case "raDescription": av = a.raDescription; bv = b.raDescription; break;
        case "raKind": av = (a.corrective ? 1 : 0) * 2 + (a.rat ? 1 : 0); bv = (b.corrective ? 1 : 0) * 2 + (b.rat ? 1 : 0); break;
        case "threatRangeNm": av = a.threatRangeNm ?? Infinity; bv = b.threatRangeNm ?? Infinity; break;
        case "threatBearingDeg": av = a.threatBearingDeg ?? Infinity; bv = b.threatBearingDeg ?? Infinity; break;
        case "threatAltFt": av = a.threatAltFt ?? Infinity; bv = b.threatAltFt ?? Infinity; break;
        case "duration": av = a.endTime - a.startTime; bv = b.endTime - b.startTime; break;
        case "raPointCount": av = a.raPointCount; bv = b.raPointCount; break;
      }
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });

    return filtered;
  }, [events, flights, search, tti0, tti1, tti2, descKeyword, startDt, endDt, tz, sortKey, sortDesc]);

  // ─── 통계 ───
  const stats = useMemo(() => {
    let n0 = 0, n1 = 0, n2 = 0;
    for (const ev of events) {
      if (ev.threatTti === 1) n1++;
      else if (ev.threatTti === 2) n2++;
      else n0++;
    }
    return { total: events.length, tti0: n0, tti1: n1, tti2: n2 };
  }, [events]);

  const handleRowClick = useCallback((ev: TcasEvent) => {
    onSelect(ev);
    onClose();
  }, [onSelect, onClose]);

  const SortHeader = ({ k, label, tooltip, className = "" }: { k: SortKey; label: string; tooltip?: string; className?: string }) => (
    <th
      onClick={() => toggleSort(k)}
      title={tooltip}
      className={`sticky top-0 z-10 bg-gray-50 px-3 py-2 text-left text-[11px] font-medium text-gray-600 select-none cursor-pointer hover:bg-gray-100 ${className}`}
    >
      <div className="flex items-center gap-1">
        <span>{label}</span>
        {sortKey === k && (sortDesc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
      </div>
    </th>
  );

  return (
    <Modal open={open} onClose={onClose} title={`TCAS RA 이벤트 (${stats.total}건)`} width="max-w-[95vw]">
      <div className="space-y-3">
        {/* 통계 */}
        <div className="flex flex-wrap items-center gap-3 text-[11px]">
          <div className="flex items-center gap-2">
            <span className="text-gray-500">전체</span>
            <span className="font-medium text-gray-800">{stats.total}건</span>
            <span className="text-gray-300">|</span>
            <span className="rounded border border-[#a60739]/30 bg-[#a60739]/10 px-1.5 py-0.5 text-[#a60739]">Mode-S {stats.tti1}</span>
            <span className="rounded border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-amber-700">ATCRBS {stats.tti2}</span>
            <span className="rounded border border-gray-300 bg-gray-100 px-1.5 py-0.5 text-gray-500">상대정보없음 {stats.tti0}</span>
            <span className="text-gray-300">|</span>
            <span className="text-gray-500">표시 {rows.length}건</span>
          </div>
        </div>

        {/* 날짜 필터 */}
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-gray-500">기간</span>
          {/* TZ 토글 */}
          <div className="inline-flex overflow-hidden rounded border border-gray-300 bg-white">
            <button
              onClick={() => setTz("UTC")}
              className={`px-2 py-1 text-[10px] uppercase tracking-wider transition-colors ${
                tz === "UTC" ? "bg-[#a60739] text-white" : "text-gray-500 hover:bg-gray-100"
              }`}
            >
              UTC
            </button>
            <button
              onClick={() => setTz("KST")}
              className={`px-2 py-1 text-[10px] uppercase tracking-wider transition-colors ${
                tz === "KST" ? "bg-[#a60739] text-white" : "text-gray-500 hover:bg-gray-100"
              }`}
            >
              KST
            </button>
          </div>
          <input
            type="datetime-local"
            value={startDt}
            min={eventRange ? tsToDtLocal(eventRange.min, tz) : undefined}
            max={eventRange ? tsToDtLocal(eventRange.max, tz) : undefined}
            onChange={(e) => setStartDt(e.target.value)}
            className="rounded border border-gray-300 bg-white px-2 py-1.5 text-[11px] focus:border-[#a60739] focus:outline-none"
          />
          <span className="text-gray-400">~</span>
          <input
            type="datetime-local"
            value={endDt}
            min={eventRange ? tsToDtLocal(eventRange.min, tz) : undefined}
            max={eventRange ? tsToDtLocal(eventRange.max, tz) : undefined}
            onChange={(e) => setEndDt(e.target.value)}
            className="rounded border border-gray-300 bg-white px-2 py-1.5 text-[11px] focus:border-[#a60739] focus:outline-none"
          />
          {(startDt || endDt) && (
            <button
              onClick={() => { setStartDt(""); setEndDt(""); }}
              className="rounded border border-gray-300 bg-white px-2 py-1.5 text-[11px] text-gray-500 hover:border-[#a60739]/40 hover:text-[#a60739]"
            >
              기간 초기화
            </button>
          )}
          {eventRange && !startDt && !endDt && (
            <span className="text-gray-400">
              ({formatTime(eventRange.min, tz)} ~ {formatTime(eventRange.max, tz)})
            </span>
          )}
        </div>

        {/* 필터 */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Mode-S / 콜사인 / 기체명"
              className="w-56 rounded border border-gray-300 bg-white pl-7 pr-2 py-1.5 text-[11px] placeholder-gray-400 focus:border-[#a60739] focus:outline-none"
            />
          </div>

          <input
            type="text"
            value={descKeyword}
            onChange={(e) => setDescKeyword(e.target.value)}
            placeholder="RA 의도 (예: climb)"
            className="w-40 rounded border border-gray-300 bg-white px-2 py-1.5 text-[11px] placeholder-gray-400 focus:border-[#a60739] focus:outline-none"
          />

          <div className="ml-auto flex items-center gap-2 text-[11px] text-gray-600">
            <span className="text-gray-500">TTI:</span>
            <label className="flex items-center gap-1 cursor-pointer">
              <input type="checkbox" checked={tti1} onChange={(e) => setTti1(e.target.checked)} className="accent-[#a60739]" />
              <span>Mode-S</span>
            </label>
            <label className="flex items-center gap-1 cursor-pointer">
              <input type="checkbox" checked={tti2} onChange={(e) => setTti2(e.target.checked)} className="accent-[#a60739]" />
              <span>ATCRBS</span>
            </label>
            <label className="flex items-center gap-1 cursor-pointer">
              <input type="checkbox" checked={tti0} onChange={(e) => setTti0(e.target.checked)} className="accent-[#a60739]" />
              <span>상대정보없음</span>
            </label>
          </div>
        </div>

        {/* 테이블 */}
        <div className="max-h-[78vh] overflow-auto rounded border border-gray-200">
          <table className="w-full text-[11px]">
            <thead>
              <tr>
                <SortHeader k="startTime" label={`시각 (${tz})`} tooltip={`RA 시작 시각 (${tz} 기준). CAT048 I048/140 Time of Day에서 추출.`} />
                <SortHeader k="ownLabel" label="Own (자기)" tooltip="RA를 트리거한 자기 항공기 — Mode-S 주소(I048/220) + 등록 기체명/콜사인." />
                <SortHeader k="ownAltFt" label="자기 고도(ft)" tooltip="RA 시점 자기 항공기 고도 (피트). CAT048 I048/090 Flight Level에서 변환." />
                <SortHeader k="tti" label="TID" tooltip="Threat Identity Data — BDS 3,0이 보고한 위협 식별 정보 종류." className="text-center" />
                <SortHeader k="tti" label="TTI" tooltip="Threat Type Indicator — BDS 3,0의 2비트(bits 21-22) 코드. 0=상대정보없음, 1=Mode-S 주소, 2=ATCRBS(거리·방위·고도), 3=예비(미할당)." className="text-center" />
                <SortHeader k="threatLabel" label="위협 Mode-S" tooltip="TID가 Mode-S 주소(TTI=1)일 때 위협 항공기 식별. BDS 3,0 bits 23-46." />
                <SortHeader k="raDescription" label="RA 의도" tooltip="TCAS가 조종사에게 지시한 회피 동작. BDS 3,0의 ARA(bits 1-14) + RAC(bits 15-18) 비트를 사람 친화 문자열로 해석." />
                <SortHeader k="raKind" label="종류" tooltip="RA 분류 배지 — Corr(필수변경)/Prev(유지), ↑/↓(상승/하강 sense), RAT(종료), MTE(다중위협)." className="text-center" />
                <SortHeader k="threatRangeNm" label="위협 거리(NM)" tooltip="TID가 ATCRBS(TTI=2)일 때만. 자기 ↔ 위협 수평 거리 (해리). BDS 3,0 bits 36-42, 0.1NM/LSB." />
                <SortHeader k="threatBearingDeg" label="위협 방위(°)" tooltip="TTI=2일 때만. 자기 기준 위협 방위각. BDS 3,0 bits 43-48, 6비트 = 360°/64 step." />
                <SortHeader k="threatAltFt" label="위협 고도(ft)" tooltip="TTI=2일 때만. 위협 항공기 고도 (피트). BDS 3,0 bits 23-35, Mode C 코드." />
                <SortHeader k="duration" label="지속(s)" tooltip="첫 RA 보고부터 마지막 보고까지 시간. 한 이벤트로 그룹핑된 점들의 시작-종료 차이." />
                <SortHeader k="raPointCount" label="횟수" tooltip="같은 RA가 레이더 스캔 주기마다 보고된 횟수. 1=단발성, 큰 수일수록 오래 지속." />
                <th title="BDS 3,0 raw 7바이트 + 비트별 상세 디코드 보기" className="sticky top-0 z-10 bg-gray-50 px-3 py-2 text-center text-[11px] font-medium text-gray-600 w-10">상세</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={14} className="px-3 py-8 text-center text-[11px] text-gray-400">
                    조건에 맞는 이벤트가 없습니다
                  </td>
                </tr>
              )}
              {rows.map((ev) => (
                <tr
                  key={ev.id}
                  onClick={() => handleRowClick(ev)}
                  className="cursor-pointer border-t border-gray-100 hover:bg-[#a60739]/5"
                >
                  <td className="px-3 py-1.5 text-gray-700 font-mono">{formatTime(ev.startTime, tz)}</td>
                  <td className="px-3 py-1.5 text-gray-800">{labelFor(ev.ownModeS, flights)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">
                    {Math.round(ev.ownAltFt)}
                  </td>
                  <td className="px-3 py-1.5 text-center" title={`TID 종류: ${TTI_LABEL[ev.threatTti]} (TTI=${ev.threatTti})`}>
                    <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${TTI_COLOR[ev.threatTti]}`}>
                      {TTI_LABEL[ev.threatTti]}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-center tabular-nums text-gray-700" title={`TTI raw 값 (bits 21-22) = ${ev.threatTti}`}>
                    {ev.threatTti}
                  </td>
                  <td className="px-3 py-1.5 text-gray-800">
                    {ev.threatTti === 1 ? labelFor(ev.threatModeS, flights) : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-gray-700" title={`ARA=0x${ev.araHex} · RAC=0x${ev.racHex}`}>{ev.raDescription}</td>
                  <td className="px-3 py-1.5 text-center">
                    <div className="inline-flex flex-wrap items-center gap-1">
                      <span
                        title={ev.corrective
                          ? "Corrective RA — 조종사가 현 비행을 변경해야 함 (climb/descend 명령)"
                          : "Preventive RA — 현 비행 유지로 충분 (don't climb/descend)"}
                        className={`rounded border px-1 py-0.5 text-[9px] uppercase tracking-wider ${
                          ev.corrective ? "border-[#a60739]/30 bg-[#a60739]/10 text-[#a60739]" : "border-gray-300 bg-gray-100 text-gray-500"
                        }`}
                      >
                        {ev.corrective ? "Corr" : "Prev"}
                      </span>
                      <span
                        title={ev.downSense
                          ? "Descend sense — 하강하여 위협 회피 (ARA bit 2 = 1)"
                          : "Climb sense — 상승하여 위협 회피 (ARA bit 2 = 0)"}
                        className={`rounded border px-1 py-0.5 text-[9px] uppercase tracking-wider ${
                          ev.downSense ? "border-blue-300 bg-blue-50 text-blue-700" : "border-green-300 bg-green-50 text-green-700"
                        }`}
                      >
                        {ev.downSense ? "↓" : "↑"}
                      </span>
                      {ev.rat && (
                        <span
                          title="RAT (RA Terminated, bit 19) — RA가 종료된 상태. 종료 후 약 18초간 set 유지."
                          className="rounded border border-gray-400 bg-gray-200 px-1 py-0.5 text-[9px] uppercase tracking-wider text-gray-600"
                        >
                          RAT
                        </span>
                      )}
                      {ev.mte && (
                        <span
                          title="MTE (Multiple Threat Encounter, bit 20) — 다중 위협 동시 추적 중."
                          className="rounded border border-amber-300 bg-amber-100 px-1 py-0.5 text-[9px] uppercase tracking-wider text-amber-700"
                        >
                          MTE
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">
                    {ev.threatRangeNm != null ? ev.threatRangeNm.toFixed(1) : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">
                    {ev.threatBearingDeg != null ? Math.round(ev.threatBearingDeg) : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">
                    {ev.threatAltFt != null ? Math.round(ev.threatAltFt) : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">
                    {(ev.endTime - ev.startTime).toFixed(1)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">
                    {ev.raPointCount}
                  </td>
                  <td className="px-3 py-1.5 text-center">
                    <button
                      onClick={(e) => { e.stopPropagation(); setDetailEv(ev); }}
                      className="rounded p-1 text-gray-400 hover:bg-[#a60739]/10 hover:text-[#a60739]"
                      title="raw 페이로드 상세 보기"
                    >
                      <Info size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* RAW 상세 모달 */}
      {detailEv && (
        <Modal open={true} onClose={() => setDetailEv(null)} title="RA 상세 (BDS 3,0 raw)" width="max-w-md">
          <div className="space-y-3 text-[11px]">
            <div>
              <div className="text-gray-500 mb-1">시각 ({tz}) · Own</div>
              <div className="text-gray-800 font-mono">
                {formatTime(detailEv.startTime, tz)} · {labelFor(detailEv.ownModeS, flights)}
              </div>
            </div>
            <div>
              <div className="text-gray-500 mb-1">BDS 3,0 raw 페이로드 (7바이트)</div>
              <div className="rounded bg-gray-50 border border-gray-200 px-2 py-1.5 font-mono text-gray-800 break-all">
                {detailEv.rawHex.match(/.{2}/g)?.join(" ")}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-gray-500">ARA (bits 1-14)</div>
                <div className="font-mono text-gray-800">0x{detailEv.araHex}</div>
              </div>
              <div>
                <div className="text-gray-500">RAC (bits 15-18)</div>
                <div className="font-mono text-gray-800">0x{detailEv.racHex}</div>
              </div>
              <div>
                <div className="text-gray-500">RAT (bit 19)</div>
                <div className="text-gray-800">{detailEv.rat ? "1 (종료됨)" : "0 (활성)"}</div>
              </div>
              <div>
                <div className="text-gray-500">MTE (bit 20)</div>
                <div className="text-gray-800">{detailEv.mte ? "1 (다중 위협)" : "0"}</div>
              </div>
              <div>
                <div className="text-gray-500">TTI (bits 21-22)</div>
                <div className="text-gray-800">{detailEv.threatTti} ({TTI_LABEL[detailEv.threatTti]})</div>
              </div>
              <div>
                <div className="text-gray-500">종류</div>
                <div className="text-gray-800">
                  {detailEv.corrective ? "Corrective" : "Preventive"} · {detailEv.downSense ? "Descend sense" : "Climb sense"}
                </div>
              </div>
            </div>
            <div>
              <div className="text-gray-500 mb-1">RA 의도 디코드</div>
              <div className="text-gray-800">{detailEv.raDescription}</div>
            </div>
            {detailEv.threatTti === 1 && detailEv.threatModeS && (
              <div>
                <div className="text-gray-500">위협 Mode-S (TID, bits 23-46)</div>
                <div className="text-gray-800 font-mono">{detailEv.threatModeS}</div>
              </div>
            )}
            {detailEv.threatTti === 2 && (
              <div>
                <div className="text-gray-500 mb-1">위협 위치 (TID, ATCRBS)</div>
                <div className="text-gray-800">
                  거리: {detailEv.threatRangeNm?.toFixed(1) ?? "—"} NM ·
                  방위: {detailEv.threatBearingDeg != null ? Math.round(detailEv.threatBearingDeg) : "—"}° ·
                  고도: {detailEv.threatAltFt != null ? Math.round(detailEv.threatAltFt) : "—"} ft
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}
    </Modal>
  );
}
