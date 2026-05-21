import { useCallback, useMemo, useState } from "react";
import { ArrowUp, ArrowDown, Search, Info, ShieldAlert } from "lucide-react";
import Modal from "../components/common/Modal";
import { useAppStore } from "../store";
import { buildEventsFromReports, type TcasEvent, type CoordEvent } from "../utils/tcasEvents";
import type { Flight } from "../types";

type TabId = "ra" | "coord";
type TzMode = "UTC" | "KST";
const KST_OFFSET_SECS = 9 * 3600;

type SortKey =
  | "startTime" | "ownLabel" | "ownAltFt" | "tti" | "threatLabel"
  | "raDescription" | "raKind" | "threatRangeNm" | "threatBearingDeg"
  | "threatAltFt" | "duration" | "pointCount";

function formatTime(ts: number, tz: TzMode): string {
  const d = new Date((ts + (tz === "KST" ? KST_OFFSET_SECS : 0)) * 1000);
  const yy = String(d.getUTCFullYear()).slice(2);
  const MM = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yy}-${MM}-${dd} ${hh}:${mm}:${ss}`;
}
function dtLocalToTs(s: string, tz: TzMode): number | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const utcMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return (utcMs - (tz === "KST" ? KST_OFFSET_SECS * 1000 : 0)) / 1000;
}
function tsToDtLocal(ts: number, tz: TzMode): string {
  const d = new Date((ts + (tz === "KST" ? KST_OFFSET_SECS : 0)) * 1000);
  const yy = d.getUTCFullYear();
  const MM = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yy}-${MM}-${dd}T${hh}:${mm}`;
}
function labelFor(modeS: string | undefined, flights: Flight[]): string {
  if (!modeS || modeS === "NO_MODES") return modeS ?? "—";
  const f = flights.find((fl) => fl.mode_s === modeS);
  if (!f) return modeS;
  const name = f.aircraft_name || f.callsign;
  return name ? `${name} (${modeS})` : modeS;
}

const TTI_LABEL: Record<number, string> = { 0: "상대정보없음", 1: "Mode-S", 2: "ATCRBS", 3: "예비" };
const TTI_COLOR: Record<number, string> = {
  0: "bg-gray-100 text-gray-500 border-gray-300",
  1: "bg-[#a60739]/10 text-[#a60739] border-[#a60739]/30",
  2: "bg-amber-100 text-amber-700 border-amber-300",
  3: "bg-gray-100 text-gray-500 border-gray-300",
};

export default function AcasAnalysis() {
  const tcasReports = useAppStore((s) => s.tcasReports);
  const flights = useAppStore((s) => s.flights);

  const { raEvents, coordEvents } = useMemo(
    () => buildEventsFromReports(tcasReports),
    [tcasReports],
  );

  const [tab, setTab] = useState<TabId>("ra");
  const [tz, setTz] = useState<TzMode>("KST");
  const [search, setSearch] = useState("");
  const [descKeyword, setDescKeyword] = useState("");
  const [tti0, setTti0] = useState(true);
  const [tti1, setTti1] = useState(true);
  const [tti2, setTti2] = useState(true);
  const [startDt, setStartDt] = useState("");
  const [endDt, setEndDt] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("startTime");
  const [sortDesc, setSortDesc] = useState(false);
  const [detailEv, setDetailEv] = useState<TcasEvent | CoordEvent | null>(null);
  const [detailKind, setDetailKind] = useState<TabId>("ra");

  const toggleSort = useCallback((k: SortKey) => {
    if (sortKey === k) setSortDesc((d) => !d);
    else { setSortKey(k); setSortDesc(k === "threatRangeNm" || k === "threatAltFt" ? false : true); }
  }, [sortKey]);

  const eventRange = useMemo(() => {
    let min = Infinity, max = -Infinity;
    for (const ev of raEvents) { if (ev.startTime < min) min = ev.startTime; if (ev.startTime > max) max = ev.startTime; }
    for (const ev of coordEvents) { if (ev.startTime < min) min = ev.startTime; if (ev.startTime > max) max = ev.startTime; }
    return min === Infinity ? null : { min, max };
  }, [raEvents, coordEvents]);

  // 공통 필터/정렬 (RA용)
  const raRows = useMemo(() => {
    const q = search.trim().toUpperCase();
    const desc = descKeyword.trim().toLowerCase();
    const tMin = dtLocalToTs(startDt, tz), tMax = dtLocalToTs(endDt, tz);
    const filtered = raEvents.filter((ev) => {
      if (tMin != null && ev.startTime < tMin) return false;
      if (tMax != null && ev.startTime > tMax) return false;
      if (ev.threatTti === 0 && !tti0) return false;
      if (ev.threatTti === 1 && !tti1) return false;
      if (ev.threatTti === 2 && !tti2) return false;
      if (q) {
        const o = labelFor(ev.ownModeS, flights).toUpperCase();
        const t = labelFor(ev.threatModeS, flights).toUpperCase();
        if (!o.includes(q) && !t.includes(q)) return false;
      }
      if (desc && !ev.raDescription.toLowerCase().includes(desc)) return false;
      return true;
    });
    const dir = sortDesc ? -1 : 1;
    filtered.sort((a, b) => {
      let av: number | string, bv: number | string;
      switch (sortKey) {
        case "ownLabel": av = labelFor(a.ownModeS, flights); bv = labelFor(b.ownModeS, flights); break;
        case "ownAltFt": av = a.ownAltFt ?? Infinity; bv = b.ownAltFt ?? Infinity; break;
        case "threatLabel": av = labelFor(a.threatModeS, flights); bv = labelFor(b.threatModeS, flights); break;
        case "tti": av = a.threatTti; bv = b.threatTti; break;
        case "raDescription": av = a.raDescription; bv = b.raDescription; break;
        case "raKind": av = (a.corrective ? 2 : 0) + (a.rat ? 1 : 0); bv = (b.corrective ? 2 : 0) + (b.rat ? 1 : 0); break;
        case "threatRangeNm": av = a.threatRangeNm ?? Infinity; bv = b.threatRangeNm ?? Infinity; break;
        case "threatBearingDeg": av = a.threatBearingDeg ?? Infinity; bv = b.threatBearingDeg ?? Infinity; break;
        case "threatAltFt": av = a.threatAltFt ?? Infinity; bv = b.threatAltFt ?? Infinity; break;
        case "duration": av = a.endTime - a.startTime; bv = b.endTime - b.startTime; break;
        case "pointCount": av = a.raPointCount; bv = b.raPointCount; break;
        default: av = a.startTime; bv = b.startTime;
      }
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return filtered;
  }, [raEvents, flights, search, descKeyword, startDt, endDt, tz, tti0, tti1, tti2, sortKey, sortDesc]);

  const coordRows = useMemo(() => {
    const q = search.trim().toUpperCase();
    const desc = descKeyword.trim().toLowerCase();
    const tMin = dtLocalToTs(startDt, tz), tMax = dtLocalToTs(endDt, tz);
    const filtered = coordEvents.filter((ev) => {
      if (tMin != null && ev.startTime < tMin) return false;
      if (tMax != null && ev.startTime > tMax) return false;
      if (ev.threatTti === 0 && !tti0) return false;
      if (ev.threatTti === 1 && !tti1) return false;
      if (ev.threatTti === 2 && !tti2) return false;
      if (q) {
        const o = labelFor(ev.ownModeS, flights).toUpperCase();
        const t = labelFor(ev.threatModeS, flights).toUpperCase();
        if (!o.includes(q) && !t.includes(q)) return false;
      }
      if (desc && !ev.description.toLowerCase().includes(desc)) return false;
      return true;
    });
    const dir = sortDesc ? -1 : 1;
    filtered.sort((a, b) => {
      let av: number | string, bv: number | string;
      switch (sortKey) {
        case "ownLabel": av = labelFor(a.ownModeS, flights); bv = labelFor(b.ownModeS, flights); break;
        case "ownAltFt": av = a.ownAltFt ?? Infinity; bv = b.ownAltFt ?? Infinity; break;
        case "threatLabel": av = labelFor(a.threatModeS, flights); bv = labelFor(b.threatModeS, flights); break;
        case "tti": av = a.threatTti; bv = b.threatTti; break;
        case "raDescription": av = a.description; bv = b.description; break;
        case "raKind": av = (a.corrective ? 2 : 0) + (a.rat ? 1 : 0); bv = (b.corrective ? 2 : 0) + (b.rat ? 1 : 0); break;
        case "duration": av = a.endTime - a.startTime; bv = b.endTime - b.startTime; break;
        case "pointCount": av = a.pointCount; bv = b.pointCount; break;
        default: av = a.startTime; bv = b.startTime;
      }
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return filtered;
  }, [coordEvents, flights, search, descKeyword, startDt, endDt, tz, tti0, tti1, tti2, sortKey, sortDesc]);

  const stats = useMemo(() => {
    const src = tab === "ra" ? raEvents : coordEvents;
    let n0 = 0, n1 = 0, n2 = 0;
    for (const ev of src) { if (ev.threatTti === 1) n1++; else if (ev.threatTti === 2) n2++; else n0++; }
    return { total: src.length, tti0: n0, tti1: n1, tti2: n2 };
  }, [tab, raEvents, coordEvents]);

  const SortHeader = ({ k, label, tip, cls = "" }: { k: SortKey; label: string; tip?: string; cls?: string }) => (
    <th onClick={() => toggleSort(k)} title={tip}
      className={`sticky top-0 z-10 bg-gray-50 px-3 py-2 text-left text-[11px] font-medium text-gray-600 select-none cursor-pointer hover:bg-gray-100 ${cls}`}>
      <div className="flex items-center gap-1"><span>{label}</span>{sortKey === k && (sortDesc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}</div>
    </th>
  );

  const KindBadges = ({ ev }: { ev: TcasEvent | CoordEvent }) => (
    <div className="inline-flex flex-wrap items-center gap-1">
      <span title={ev.corrective ? "Corrective — 현 비행 변경 필요" : "Preventive — 현 비행 유지"}
        className={`rounded border px-1 py-0.5 text-[9px] uppercase tracking-wider ${ev.corrective ? "border-[#a60739]/30 bg-[#a60739]/10 text-[#a60739]" : "border-gray-300 bg-gray-100 text-gray-500"}`}>
        {ev.corrective ? "Corr" : "Prev"}
      </span>
      <span title={ev.downSense ? "Descend sense (하강 회피)" : "Climb sense (상승 회피)"}
        className={`rounded border px-1 py-0.5 text-[9px] ${ev.downSense ? "border-blue-300 bg-blue-50 text-blue-700" : "border-green-300 bg-green-50 text-green-700"}`}>
        {ev.downSense ? "↓" : "↑"}
      </span>
      {ev.rat && <span title="RAT — RA 종료" className="rounded border border-gray-400 bg-gray-200 px-1 py-0.5 text-[9px] uppercase text-gray-600">RAT</span>}
      {ev.mte && <span title="MTE — 다중 위협" className="rounded border border-amber-300 bg-amber-100 px-1 py-0.5 text-[9px] uppercase text-amber-700">MTE</span>}
    </div>
  );

  const openDetail = (ev: TcasEvent | CoordEvent, kind: TabId) => { setDetailEv(ev); setDetailKind(kind); };

  return (
    <div className="flex h-full flex-col bg-white p-5">
      <div className="mb-3 flex items-center gap-2">
        <ShieldAlert size={20} className="text-[#a60739]" />
        <h1 className="text-lg font-semibold text-gray-800">ACAS 분석</h1>
        <span className="text-[11px] text-gray-400">RA {raEvents.length} · 협의 {coordEvents.length}</span>
      </div>

      {tcasReports.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
          ACAS 데이터가 없습니다. "자료 관리"에서 ASS 파일을 로드하세요.
        </div>
      ) : (
        <>
          {/* 탭 */}
          <div className="flex items-center gap-1 border-b border-gray-200">
            <button onClick={() => setTab("ra")} title="BDS 3,0 / I048/260 — 항공기가 보고한 ACAS Active RA"
              className={`px-4 py-2 text-[12px] font-medium border-b-2 -mb-px ${tab === "ra" ? "border-[#a60739] text-[#a60739]" : "border-transparent text-gray-500 hover:text-gray-700"}`}>
              RA 보고 (BDS 3,0) · {raEvents.length}
            </button>
            <button onClick={() => setTab("coord")} title="BDS 1,6 — TCAS↔TCAS 협의 메시지 (BDS 3,0과 동일 매핑 가정)"
              className={`px-4 py-2 text-[12px] font-medium border-b-2 -mb-px ${tab === "coord" ? "border-[#a60739] text-[#a60739]" : "border-transparent text-gray-500 hover:text-gray-700"}`}>
              협의 (BDS 1,6) · {coordEvents.length}
            </button>
          </div>

          {/* 필터 */}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="text-gray-500">기간</span>
            <div className="inline-flex overflow-hidden rounded border border-gray-300 bg-white">
              {(["UTC", "KST"] as TzMode[]).map((m) => (
                <button key={m} onClick={() => setTz(m)}
                  className={`px-2 py-1 text-[10px] uppercase tracking-wider ${tz === m ? "bg-[#a60739] text-white" : "text-gray-500 hover:bg-gray-100"}`}>{m}</button>
              ))}
            </div>
            <input type="datetime-local" value={startDt} min={eventRange ? tsToDtLocal(eventRange.min, tz) : undefined} max={eventRange ? tsToDtLocal(eventRange.max, tz) : undefined}
              onChange={(e) => setStartDt(e.target.value)} className="rounded border border-gray-300 bg-white px-2 py-1.5 text-[11px] focus:border-[#a60739] focus:outline-none" />
            <span className="text-gray-400">~</span>
            <input type="datetime-local" value={endDt} min={eventRange ? tsToDtLocal(eventRange.min, tz) : undefined} max={eventRange ? tsToDtLocal(eventRange.max, tz) : undefined}
              onChange={(e) => setEndDt(e.target.value)} className="rounded border border-gray-300 bg-white px-2 py-1.5 text-[11px] focus:border-[#a60739] focus:outline-none" />
            {(startDt || endDt) && <button onClick={() => { setStartDt(""); setEndDt(""); }} className="rounded border border-gray-300 bg-white px-2 py-1.5 text-gray-500 hover:text-[#a60739]">기간 초기화</button>}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
              <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Mode-S / 콜사인 / 기체명"
                className="w-56 rounded border border-gray-300 bg-white pl-7 pr-2 py-1.5 text-[11px] placeholder-gray-400 focus:border-[#a60739] focus:outline-none" />
            </div>
            <input type="text" value={descKeyword} onChange={(e) => setDescKeyword(e.target.value)} placeholder="RA 의도 (예: climb)"
              className="w-40 rounded border border-gray-300 bg-white px-2 py-1.5 text-[11px] placeholder-gray-400 focus:border-[#a60739] focus:outline-none" />
            <div className="ml-auto flex items-center gap-2 text-[11px] text-gray-600">
              <span className="text-gray-500">TTI:</span>
              <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={tti1} onChange={(e) => setTti1(e.target.checked)} className="accent-[#a60739]" />Mode-S</label>
              <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={tti2} onChange={(e) => setTti2(e.target.checked)} className="accent-[#a60739]" />ATCRBS</label>
              <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={tti0} onChange={(e) => setTti0(e.target.checked)} className="accent-[#a60739]" />상대정보없음</label>
              <span className="text-gray-300">|</span>
              <span className="text-gray-500">표시 {tab === "ra" ? raRows.length : coordRows.length} / 전체 {stats.total}</span>
            </div>
          </div>

          {/* 테이블 */}
          <div className="mt-2 flex-1 overflow-auto rounded border border-gray-200">
            <table className="w-full text-[11px]">
              <thead>
                <tr>
                  <SortHeader k="startTime" label={`시각 (${tz})`} tip={`RA 시작 시각 (${tz}). 추정 시각은 ~ 표기.`} />
                  <SortHeader k="ownLabel" label="Own (자기)" tip="보고 항공기 Mode-S + 기체명/콜사인" />
                  <SortHeader k="ownAltFt" label="자기 고도(ft)" tip="레코드에 좌표/고도 있을 때만" />
                  <SortHeader k="tti" label="TID" tip="Threat Identity Data 종류" cls="text-center" />
                  <SortHeader k="tti" label="TTI" tip="BDS bits 21-22 raw 값 (0/1/2/3)" cls="text-center" />
                  <SortHeader k="threatLabel" label="위협 Mode-S" tip="TTI=1일 때 위협 식별" />
                  <SortHeader k="raDescription" label={tab === "ra" ? "RA 의도" : "협의 의도"} tip="ARA/RAC 비트 해석" />
                  <SortHeader k="raKind" label="종류" tip="Corr/Prev · sense · RAT · MTE" cls="text-center" />
                  {tab === "ra" && <>
                    <SortHeader k="threatRangeNm" label="위협 거리(NM)" tip="TTI=2(ATCRBS)일 때만" />
                    <SortHeader k="threatBearingDeg" label="위협 방위(°)" tip="TTI=2일 때만" />
                    <SortHeader k="threatAltFt" label="위협 고도(ft)" tip="TTI=2일 때만" />
                  </>}
                  <SortHeader k="duration" label="지속(s)" tip="첫~마지막 보고 간격" />
                  <SortHeader k="pointCount" label="횟수" tip="보고 점 수" />
                  <th className="sticky top-0 z-10 bg-gray-50 px-3 py-2 text-center text-[11px] font-medium text-gray-600 w-10">상세</th>
                </tr>
              </thead>
              <tbody>
                {tab === "ra" ? (
                  raRows.length === 0 ? (
                    <tr><td colSpan={14} className="px-3 py-8 text-center text-gray-400">조건에 맞는 RA 이벤트가 없습니다</td></tr>
                  ) : raRows.map((ev) => (
                    <tr key={ev.id} className="border-t border-gray-100 hover:bg-[#a60739]/5">
                      <td className="px-3 py-1.5 font-mono text-gray-700">{ev.timeEstimated ? "~" : ""}{formatTime(ev.startTime, tz)}</td>
                      <td className="px-3 py-1.5 text-gray-800">{labelFor(ev.ownModeS, flights)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">{ev.ownAltFt != null ? Math.round(ev.ownAltFt) : "—"}</td>
                      <td className="px-3 py-1.5 text-center"><span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] uppercase ${TTI_COLOR[ev.threatTti]}`}>{TTI_LABEL[ev.threatTti]}</span></td>
                      <td className="px-3 py-1.5 text-center tabular-nums text-gray-700">{ev.threatTti}</td>
                      <td className="px-3 py-1.5 text-gray-800">{ev.threatTti === 1 ? labelFor(ev.threatModeS, flights) : "—"}</td>
                      <td className="px-3 py-1.5 text-gray-700" title={`ARA=0x${ev.araHex} · RAC=0x${ev.racHex}`}>{ev.raDescription}</td>
                      <td className="px-3 py-1.5 text-center"><KindBadges ev={ev} /></td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">{ev.threatRangeNm != null ? ev.threatRangeNm.toFixed(1) : "—"}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">{ev.threatBearingDeg != null ? Math.round(ev.threatBearingDeg) : "—"}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">{ev.threatAltFt != null ? Math.round(ev.threatAltFt) : "—"}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{(ev.endTime - ev.startTime).toFixed(1)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{ev.raPointCount}</td>
                      <td className="px-3 py-1.5 text-center">
                        <button onClick={() => openDetail(ev, "ra")} className="rounded p-1 text-gray-400 hover:bg-[#a60739]/10 hover:text-[#a60739]" title="raw 페이로드 상세"><Info size={12} /></button>
                      </td>
                    </tr>
                  ))
                ) : (
                  coordRows.length === 0 ? (
                    <tr><td colSpan={11} className="px-3 py-8 text-center text-gray-400">조건에 맞는 협의 이벤트가 없습니다</td></tr>
                  ) : coordRows.map((ev) => (
                    <tr key={ev.id} className="border-t border-gray-100 hover:bg-[#a60739]/5">
                      <td className="px-3 py-1.5 font-mono text-gray-700">{ev.timeEstimated ? "~" : ""}{formatTime(ev.startTime, tz)}</td>
                      <td className="px-3 py-1.5 text-gray-800">{labelFor(ev.ownModeS, flights)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">{ev.ownAltFt != null ? Math.round(ev.ownAltFt) : "—"}</td>
                      <td className="px-3 py-1.5 text-center"><span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] uppercase ${TTI_COLOR[ev.threatTti]}`}>{TTI_LABEL[ev.threatTti]}</span></td>
                      <td className="px-3 py-1.5 text-center tabular-nums text-gray-700">{ev.threatTti}</td>
                      <td className="px-3 py-1.5 text-gray-800">{ev.threatTti === 1 ? labelFor(ev.threatModeS, flights) : "—"}</td>
                      <td className="px-3 py-1.5 text-gray-700" title={`ARA=0x${ev.araHex} · RAC=0x${ev.racHex}`}>{ev.description}</td>
                      <td className="px-3 py-1.5 text-center"><KindBadges ev={ev} /></td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{(ev.endTime - ev.startTime).toFixed(1)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{ev.pointCount}</td>
                      <td className="px-3 py-1.5 text-center">
                        <button onClick={() => openDetail(ev, "coord")} className="rounded p-1 text-gray-400 hover:bg-[#a60739]/10 hover:text-[#a60739]" title="raw 페이로드 상세"><Info size={12} /></button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* RAW 상세 모달 */}
      {detailEv && (
        <Modal open={true} onClose={() => setDetailEv(null)} title={detailKind === "ra" ? "RA 상세 (BDS 3,0)" : "협의 상세 (BDS 1,6)"} width="max-w-md">
          <div className="space-y-3 text-[11px]">
            <div>
              <div className="text-gray-500 mb-1">시각 ({tz}) · Own</div>
              <div className="font-mono text-gray-800">
                {detailEv.timeEstimated ? "~" : ""}{formatTime(detailEv.startTime, tz)} · {labelFor(detailEv.ownModeS, flights)}
                {detailEv.timeEstimated && <span className="ml-1 text-gray-400">(시각 추정 — I140 부재)</span>}
              </div>
            </div>
            <div>
              <div className="text-gray-500 mb-1">{detailKind === "ra" ? "BDS 3,0" : "BDS 1,6"} raw 페이로드 (7바이트)</div>
              <div className="rounded bg-gray-50 border border-gray-200 px-2 py-1.5 font-mono text-gray-800 break-all">{detailEv.rawHex.match(/.{2}/g)?.join(" ")}</div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div><div className="text-gray-500">ARA (1-14)</div><div className="font-mono text-gray-800">0x{detailEv.araHex}</div></div>
              <div><div className="text-gray-500">RAC (15-18)</div><div className="font-mono text-gray-800">0x{detailEv.racHex}</div></div>
              <div><div className="text-gray-500">RAT (19)</div><div className="text-gray-800">{detailEv.rat ? "1 (종료)" : "0 (활성)"}</div></div>
              <div><div className="text-gray-500">MTE (20)</div><div className="text-gray-800">{detailEv.mte ? "1 (다중)" : "0"}</div></div>
              <div><div className="text-gray-500">TTI (21-22)</div><div className="text-gray-800">{detailEv.threatTti} ({TTI_LABEL[detailEv.threatTti]})</div></div>
              <div><div className="text-gray-500">종류</div><div className="text-gray-800">{detailEv.corrective ? "Corrective" : "Preventive"} · {detailEv.downSense ? "Descend" : "Climb"}</div></div>
            </div>
            <div>
              <div className="text-gray-500 mb-1">{detailKind === "ra" ? "RA 의도" : "협의 의도"}</div>
              <div className="text-gray-800">{detailKind === "ra" ? (detailEv as TcasEvent).raDescription : (detailEv as CoordEvent).description}</div>
            </div>
            {detailEv.threatTti === 1 && detailEv.threatModeS && (
              <div><div className="text-gray-500">위협 Mode-S (TID, 23-46)</div><div className="font-mono text-gray-800">{detailEv.threatModeS}</div></div>
            )}
            {detailKind === "ra" && detailEv.threatTti === 2 && (
              <div>
                <div className="text-gray-500 mb-1">위협 위치 (TID, ATCRBS)</div>
                <div className="text-gray-800">
                  거리 {(detailEv as TcasEvent).threatRangeNm?.toFixed(1) ?? "—"} NM · 방위 {(detailEv as TcasEvent).threatBearingDeg != null ? Math.round((detailEv as TcasEvent).threatBearingDeg!) : "—"}° · 고도 {(detailEv as TcasEvent).threatAltFt != null ? Math.round((detailEv as TcasEvent).threatAltFt!) : "—"} ft
                </div>
              </div>
            )}
            {detailKind === "coord" && (
              <div className="text-[10px] text-gray-500 border-t border-gray-100 pt-2">참고: BDS 1,6의 정확한 비트 매핑은 표준에 따라 다를 수 있어 BDS 3,0과 동일 매핑을 가정한 결과입니다.</div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
