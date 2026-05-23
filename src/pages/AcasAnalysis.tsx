import { useCallback, useMemo, useRef, useState } from "react";
import { ArrowUp, ArrowDown, Search, Info, ShieldAlert, Clock, ChevronDown, ChevronUp, X, FolderOpen, Loader2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import Modal from "../components/common/Modal";
import ParseFilterModal, { type ParseFilterResult } from "../components/common/ParseFilterModal";
import DateRangePicker from "../components/common/DateRangePicker";
import { useAppStore } from "../store";
import { buildEventsFromReports, type TcasEvent, type CoordEvent } from "../utils/tcasEvents";
import { decodeFrame, type DecodedFrame } from "../utils/asterixDecoder";
import {
  postPointsToWorker, startConsolidate, getPointSummary,
  createThrottledChunkHandler, setConsolidationProgressCallback,
} from "../utils/flightConsolidationWorker";
import type { Flight, TrackPoint } from "../types";
import type { TcasReport } from "../types/track";

/**
 * ASS 파일 선택 → 필터 모달 → 배치 스트리밍 파싱 → Worker 전송 + TCAS 누적 → 비행 통합.
 * 3D 지도·2D 항적도(useAssFilePicker)와 동일 패턴이며, ACAS용으로 TCAS 보고 수집을 추가.
 */
function useAssFilePicker() {
  const [parsing, setParsing] = useState(false);
  const [fileCount, setFileCount] = useState(0);
  const [filterModalOpen, setFilterModalOpen] = useState(false);
  const [pendingPaths, setPendingPaths] = useState<string[]>([]);
  const consolidatingRef = useRef(false);

  const pickFiles = useCallback(async () => {
    if (parsing) return;
    const result = await open({
      multiple: true,
      filters: [{ name: "ASS Files", extensions: ["ass", "ASS"] }],
    });
    if (!result) return;
    const paths = (Array.isArray(result) ? result : [result]).filter((p): p is string => typeof p === "string");
    if (paths.length === 0) return;
    setPendingPaths(paths);
    setFilterModalOpen(true);
  }, [parsing]);

  const parseWithFilter = useCallback(async (filter: ParseFilterResult) => {
    setFilterModalOpen(false);
    const paths = pendingPaths;
    if (paths.length === 0) return;

    // 기존 데이터 전체 비우고 새로 불러오기 (worker 포인트/비행/커버리지/업로드목록 + TCAS 보고)
    useAppStore.getState().clearUploadedFiles();
    useAppStore.getState().clearTcasReports();

    setParsing(true);
    setFileCount(paths.length);

    const site = useAppStore.getState().radarSite;

    // 트랙 포인트: 청크 즉시 Worker로 fire-and-forget (메모리 일괄 보유 방지)
    let totalForwarded = 0;
    const unlistenPoints = await listen<{ points: TrackPoint[] }>("parse-points-chunk", (event) => {
      const pts = event.payload.points;
      for (const p of pts) p.radar_name = site.name;
      totalForwarded += pts.length;
      postPointsToWorker(pts);
    });
    // 파일별 결과: TCAS/ACAS 보고 누적 (트랙 독립 전수 추출)
    const unlistenResult = await listen<{ success: boolean; file_info?: { tcas_reports?: TcasReport[] } }>(
      "batch-parse-result",
      (event) => {
        const fi = event.payload.file_info;
        if (event.payload.success && fi?.tcas_reports?.length) {
          useAppStore.getState().appendTcasReports(fi.tcas_reports);
        }
      },
    );

    try {
      await invoke("parse_and_analyze_batch", {
        filePaths: paths,
        radarLat: site.latitude,
        radarLon: site.longitude,
        modeSInclude: filter.modeSInclude,
        modeSExclude: filter.modeSExclude,
        mode3aInclude: filter.mode3aInclude,
        mode3aExclude: filter.mode3aExclude,
      });
    } catch (e) {
      console.error("[ACAS] 배치 파싱 실패:", e);
    }

    unlistenPoints();
    unlistenResult();

    if (totalForwarded > 0) {
      const summary = await getPointSummary();
      useAppStore.setState({ workerPointCount: summary.totalPoints, workerPointSummary: summary.entries });
    }

    // 비행 통합 — 위협/보고 항공기 라벨용 flights 생성
    if (!consolidatingRef.current && useAppStore.getState().workerPointCount > 0) {
      consolidatingRef.current = true;
      useAppStore.getState().setConsolidating(true);
      useAppStore.getState().setConsolidationProgress({ stage: "grouping", current: 0, total: 0, flightsBuilt: 0 });
      setConsolidationProgressCallback((p) => useAppStore.getState().setConsolidationProgress(p as any));
      try {
        const state = useAppStore.getState();
        const { handler, flush } = createThrottledChunkHandler(
          (batch) => useAppStore.getState().appendFlights(batch), 250,
        );
        await startConsolidate([], state.aircraft, state.radarSite, handler);
        flush();
      } finally {
        consolidatingRef.current = false;
        setConsolidationProgressCallback(null);
        useAppStore.getState().setConsolidating(false);
        useAppStore.getState().setConsolidationProgress(null);
        useAppStore.getState().finalizeFlights();
      }
    }

    setParsing(false);
    setPendingPaths([]);
  }, [pendingPaths]);

  const closeFilterModal = useCallback(() => {
    setFilterModalOpen(false);
    setPendingPaths([]);
  }, []);

  return { pickFiles, parseWithFilter, closeFilterModal, filterModalOpen, parsing, fileCount };
}

type TabId = "ra" | "coord";
type TzMode = "UTC" | "KST";
const KST_OFFSET_SECS = 9 * 3600;

type SortKey =
  | "startTime" | "ownLabel" | "ownAltFt" | "tti" | "threatLabel"
  | "raDescription" | "action" | "direction" | "threatRangeNm" | "threatBearingDeg"
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

const CAT_LABEL: Record<number, string> = { 0x30: "CAT048 표적보고", 0x22: "CAT034 서비스", 0x08: "CAT008 기상" };

/** 프레임 디코드 결과 트리 렌더러 */
function FrameDecodeView({ frame }: { frame: DecodedFrame }) {
  return (
    <div className="space-y-2 text-[10.5px]">
      {frame.necHeader && (
        <div className="flex items-baseline gap-2">
          <span className="rounded bg-[#a60739]/10 px-1.5 py-0.5 font-medium text-[#a60739]">NEC 헤더</span>
          <span className="text-gray-800">{frame.necHeader.text}</span>
          <span className="font-mono text-gray-400">{frame.necHeader.rawHex}</span>
        </div>
      )}
      {frame.blocks.length === 0 && <div className="text-gray-400">디코드된 블록 없음</div>}
      {frame.blocks.map((blk, bi) => (
        <div key={bi} className="rounded border border-gray-100">
          <div className="flex items-baseline justify-between bg-gray-50 px-2 py-1">
            <span className="font-medium text-gray-700">{CAT_LABEL[blk.cat] ?? `CAT${blk.cat.toString(16)}`}</span>
            <span className="text-gray-400">len {blk.len} · rec {blk.records.length}</span>
          </div>
          <div className="divide-y divide-gray-50">
            {blk.records.map((rec, ri) => (
              <div key={ri} className="px-2 py-1">
                {blk.records.length > 1 && <div className="mb-0.5 text-[9.5px] uppercase tracking-wider text-gray-400">레코드 {ri + 1}</div>}
                <table className="w-full">
                  <tbody>
                    {rec.items.map((it, ii) => (
                      <tr key={ii} className="align-top">
                        <td className="whitespace-nowrap py-0.5 pr-2 font-mono text-gray-500">{it.id}</td>
                        <td className="whitespace-nowrap py-0.5 pr-2 text-gray-600">{it.name}</td>
                        <td className="py-0.5 pr-2 text-gray-900">{it.value ?? <span className="text-gray-300">—</span>}</td>
                        <td className="py-0.5 font-mono text-[9.5px] text-gray-400 break-all">{it.rawHex}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rec.note && <div className="mt-0.5 text-[9.5px] text-amber-600">※ {rec.note}</div>}
              </div>
            ))}
          </div>
          {blk.note && <div className="px-2 py-1 text-[9.5px] text-amber-600">※ {blk.note}</div>}
        </div>
      ))}
      {frame.trailingRawHex && (
        <div className="text-gray-400">
          <span className="text-[9.5px] uppercase tracking-wider">잔여 </span>
          <span className="font-mono">{frame.trailingRawHex}</span>
        </div>
      )}
      {frame.note && <div className="text-[9.5px] text-amber-600">※ {frame.note}</div>}
    </div>
  );
}

export default function AcasAnalysis() {
  const tcasReports = useAppStore((s) => s.tcasReports);
  const flights = useAppStore((s) => s.flights);
  const aircraft = useAppStore((s) => s.aircraft);
  const consolidating = useAppStore((s) => s.consolidating);
  const consolidationProgress = useAppStore((s) => s.consolidationProgress);

  const { pickFiles, parseWithFilter, closeFilterModal, filterModalOpen, parsing, fileCount } = useAssFilePicker();

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
  const [dateOpen, setDateOpen] = useState(false);

  const toggleSort = useCallback((k: SortKey) => {
    if (sortKey === k) setSortDesc((d) => !d);
    else { setSortKey(k); setSortDesc(k === "threatRangeNm" || k === "threatAltFt" ? false : true); }
  }, [sortKey]);

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
        case "action":    av = a.corrective ? 1 : 0; bv = b.corrective ? 1 : 0; break;
        case "direction": av = a.downSense  ? 1 : 0; bv = b.downSense  ? 1 : 0; break;
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
        case "action":    av = a.corrective ? 1 : 0; bv = b.corrective ? 1 : 0; break;
        case "direction": av = a.downSense  ? 1 : 0; bv = b.downSense  ? 1 : 0; break;
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

  // 「종류」 → 「동작」(Corr/Prev) + 「방향」(↑/↓) 두 셀로 분할
  const KindCell = ({ ev }: { ev: TcasEvent | CoordEvent }) => (
    <>
      <td className="px-3 py-1.5 text-center">
        <span title={ev.corrective ? "Corrective — 즉시 회피 동작 필요" : "Preventive — 현 비행 유지"}
          className={`inline-block rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${ev.corrective ? "bg-[#a60739] text-white" : "border border-gray-300 bg-white text-gray-500"}`}>
          {ev.corrective ? "Corr" : "Prev"}
        </span>
      </td>
      <td className="px-3 py-1.5 text-center">
        <span title={ev.downSense ? "Descend — 하강 회피" : "Climb — 상승 회피"}
          className={`inline-flex items-center justify-center ${ev.downSense ? "text-blue-600" : "text-[#a60739]"}`}>
          {ev.downSense ? <ArrowDown size={16} strokeWidth={3} /> : <ArrowUp size={16} strokeWidth={3} />}
        </span>
      </td>
    </>
  );

  // MTE — 위협 Mode-S 셀 끝 인라인 칩
  const MteFlag = ({ ev }: { ev: TcasEvent | CoordEvent }) =>
    ev.mte ? (
      <span title="MTE — 다중 위협"
        className="ml-1 inline-block rounded border border-amber-300 bg-amber-100 px-1 py-0.5 text-[9px] font-medium uppercase text-amber-700">
        MTE
      </span>
    ) : null;

  const openDetail = (ev: TcasEvent | CoordEvent, kind: TabId) => { setDetailEv(ev); setDetailKind(kind); };

  // 선택된 보고의 프레임 전문 디코드 (모달 펼칠 때만 의미, 가벼움)
  const decodedFrame = useMemo<DecodedFrame | null>(() => {
    if (!detailEv?.frameHex) return null;
    const bytes = detailEv.frameHex.match(/.{2}/g)?.map((h) => parseInt(h, 16)) ?? [];
    return decodeFrame(bytes);
  }, [detailEv]);

  const anyFilterActive = !!(search || descKeyword || startDt || endDt || !tti0 || !tti1 || !tti2);
  const clearAllFilters = () => {
    setSearch(""); setDescKeyword(""); setStartDt(""); setEndDt("");
    setTti0(true); setTti1(true); setTti2(true);
  };

  // TTI 세그먼트 컨트롤 메타
  const TTI_META = [
    { key: "modes",  label: "Mode-S",     active: tti1, toggle: () => setTti1(!tti1), color: "#a60739" },
    { key: "atcrbs", label: "ATCRBS",     active: tti2, toggle: () => setTti2(!tti2), color: "#d97706" },
    { key: "none",   label: "상대정보없음", active: tti0, toggle: () => setTti0(!tti0), color: "#9ca3af" },
  ];

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="mb-3 flex items-center gap-2">
        <ShieldAlert size={20} className="text-[#a60739]" />
        <h1 className="text-lg font-semibold text-gray-800">ACAS 분석</h1>
        <span className="text-[11px] text-gray-400">RA {raEvents.length} · 협의 {coordEvents.length}</span>
        {tcasReports.length > 0 && (
          <button
            onClick={pickFiles}
            disabled={parsing || consolidating}
            title="기존 데이터를 비우고 새 ASS 파일을 불러옵니다"
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-[#a60739]/30 bg-white px-3 py-1.5 text-[12px] font-medium text-[#a60739] transition-colors hover:bg-[#a60739]/5 disabled:opacity-50"
          >
            {parsing ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
            {parsing ? `파싱 중 (${fileCount})...` : "새 ASS 파일"}
          </button>
        )}
      </div>

      {tcasReports.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-gray-400">
          <p>ACAS 데이터가 없습니다.</p>
          <button
            onClick={pickFiles}
            disabled={parsing || consolidating}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#8a062f] disabled:opacity-50"
          >
            {parsing ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
            {parsing ? `파싱 중 (${fileCount})...` : "ASS 파일 열기"}
          </button>
        </div>
      ) : (
        <>
          {/* 탭 */}
          <div className="flex items-center gap-1 border-b border-gray-200">
            <button onClick={() => setTab("ra")} title="BDS 3,0 / I048/260 — 항공기가 보고한 ACAS Active RA"
              className={`px-4 py-2 text-[12px] font-medium border-b-2 -mb-px ${tab === "ra" ? "border-[#a60739] text-[#a60739]" : "border-transparent text-gray-500 hover:text-gray-700"}`}>
              RA 보고 (BDS 3,0) · {raEvents.length}
            </button>
            <button onClick={() => setTab("coord")} title="협의 — RA 중 RAC(협의 보충)≠0 또는 MTE(다중 위협). BDS 3,0에서 도출(별도 BDS 1,6 미수록)"
              className={`px-4 py-2 text-[12px] font-medium border-b-2 -mb-px ${tab === "coord" ? "border-[#a60739] text-[#a60739]" : "border-transparent text-gray-500 hover:text-gray-700"}`}>
              협의 (RAC/MTE) · {coordEvents.length}
            </button>
          </div>

          {/* 필터 — 1행 압축 (평면 배경) */}
          <div className="mt-3 flex items-center gap-2">
            {/* 검색 */}
            <div className="relative flex-shrink-0">
              <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gray-400">
                <Search size={12} />
              </span>
              <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Mode-S / 콜사인 / 기체명"
                className="h-7 w-48 rounded-md border border-gray-200 bg-white pl-7 pr-2 text-[11px] placeholder-gray-400 focus:border-[#a60739] focus:outline-none" />
            </div>
            <input type="text" value={descKeyword} onChange={(e) => setDescKeyword(e.target.value)} placeholder="RA 의도"
              className="h-7 w-28 flex-shrink-0 rounded-md border border-gray-200 bg-white px-2 text-[11px] placeholder-gray-400 focus:border-[#a60739] focus:outline-none" />

            {/* 세퍼레이터 */}
            <span className="mx-0.5 h-4 w-px flex-shrink-0 bg-gray-200" />

            {/* 기간 (팝오버) */}
            <div className="relative flex flex-shrink-0 items-center">
              <button onClick={() => setDateOpen((o) => !o)}
                className={`inline-flex h-7 items-center gap-1.5 rounded-md border bg-white px-2.5 text-[10.5px] font-medium transition-colors ${
                  startDt || endDt
                    ? "border-[#a60739]/30 bg-[#a60739]/8 text-[#a60739]"
                    : "border-gray-200 text-gray-500 hover:text-gray-700"
                }`}>
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
                      startDt={startDt} endDt={endDt} tz={tz}
                      onStartChange={setStartDt}
                      onEndChange={setEndDt}
                      onTzChange={setTz}
                      onClear={() => { setStartDt(""); setEndDt(""); }}
                      onDone={() => setDateOpen(false)} />
                  </div>
                </>
              )}
            </div>

            {/* 세퍼레이터 */}
            <span className="mx-0.5 h-4 w-px flex-shrink-0 bg-gray-200" />

            {/* TTI (세그먼트) */}
            <div className="inline-flex h-7 flex-shrink-0 overflow-hidden rounded-md border border-gray-200 bg-white">
              {TTI_META.map((m, i) => (
                <button key={m.key} onClick={m.toggle} title={`${m.label}: ${m.active ? "" : "비"}활성`}
                  className={`relative px-2.5 text-[10.5px] font-medium transition-colors ${i > 0 ? "border-l border-gray-200" : ""} ${
                    m.active ? "text-[#a60739]" : "text-gray-400 hover:text-gray-600"
                  }`}>
                  {m.active && (
                    <span className="absolute left-1.5 top-1/2 -translate-y-1/2 h-1.5 w-1.5 rounded-full" style={{ background: m.color }} />
                  )}
                  <span className={m.active ? "pl-3" : ""}>{m.label}</span>
                </button>
              ))}
            </div>

            {/* 우측: 초기화 + 카운트 */}
            <div className="ml-auto flex flex-shrink-0 items-center gap-2 pr-1 text-[10.5px]">
              {anyFilterActive && (
                <button onClick={clearAllFilters} title="모든 필터 초기화"
                  className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-gray-500 hover:bg-white hover:text-[#a60739]">
                  <X size={11} />초기화
                </button>
              )}
              <span className="tabular-nums text-gray-600">
                <span className="font-semibold text-gray-900">{tab === "ra" ? raRows.length : coordRows.length}</span>
                <span className="text-gray-400"> / {stats.total}</span>
              </span>
            </div>
          </div>

          {/* 테이블 */}
          <div className="mt-2 flex-1 overflow-auto rounded border border-gray-200">
            <table className="w-full text-[11px]">
              <thead>
                <tr>
                  <SortHeader k="startTime" label={`시각 (${tz})`} tip={`RA 시작 시각 (${tz}). 추정 시각은 ~ 표기.`} />
                  <SortHeader k="ownLabel" label="보고 항공기" tip="보고 항공기 Mode-S + 기체명/콜사인" />
                  <SortHeader k="ownAltFt" label="고도(ft)" tip="레코드에 좌표/고도 있을 때만" />
                  <SortHeader k="tti" label="TID" tip="Threat Identity Data 종류" cls="text-center" />
                  <SortHeader k="tti" label="TTI" tip="BDS bits 21-22 raw 값 (0/1/2/3)" cls="text-center" />
                  <SortHeader k="threatLabel" label="위협 Mode-S" tip="TTI=1일 때 위협 식별" />
                  <SortHeader k="raDescription" label={tab === "ra" ? "RA 의도" : "협의 의도"} tip="ARA/RAC 비트 해석" />
                  <SortHeader k="action" label="동작" tip="Corrective(즉시 행동 필요) / Preventive(현 비행 유지)" cls="text-center" />
                  <SortHeader k="direction" label="방향" tip="수직 회피 방향 (Climb/Descend)" cls="text-center" />
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
                    <tr><td colSpan={15} className="px-3 py-8 text-center text-gray-400">조건에 맞는 RA 이벤트가 없습니다</td></tr>
                  ) : raRows.map((ev) => (
                    <tr key={ev.id} className="border-t border-gray-100 hover:bg-[#a60739]/5">
                      <td className="px-3 py-1.5 font-mono text-gray-700">{ev.timeEstimated ? "~" : ""}{formatTime(ev.startTime, tz)}</td>
                      <td className="px-3 py-1.5 text-gray-800">{labelFor(ev.ownModeS, flights)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">{ev.ownAltFt != null ? Math.round(ev.ownAltFt) : "—"}</td>
                      <td className="px-3 py-1.5 text-center"><span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] uppercase ${TTI_COLOR[ev.threatTti]}`}>{TTI_LABEL[ev.threatTti]}</span></td>
                      <td className="px-3 py-1.5 text-center tabular-nums text-gray-700">{ev.threatTti}</td>
                      <td className="px-3 py-1.5 text-gray-800">{ev.threatTti === 1 ? labelFor(ev.threatModeS, flights) : "—"}<MteFlag ev={ev} /></td>
                      <td className="px-3 py-1.5 text-gray-700" title={`ARA=0x${ev.araHex} · RAC=0x${ev.racHex}`}>{ev.raDescription}</td>
                      <KindCell ev={ev} />
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
                    <tr><td colSpan={12} className="px-3 py-8 text-center text-gray-400">조건에 맞는 협의 이벤트가 없습니다</td></tr>
                  ) : coordRows.map((ev) => (
                    <tr key={ev.id} className="border-t border-gray-100 hover:bg-[#a60739]/5">
                      <td className="px-3 py-1.5 font-mono text-gray-700">{ev.timeEstimated ? "~" : ""}{formatTime(ev.startTime, tz)}</td>
                      <td className="px-3 py-1.5 text-gray-800">{labelFor(ev.ownModeS, flights)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">{ev.ownAltFt != null ? Math.round(ev.ownAltFt) : "—"}</td>
                      <td className="px-3 py-1.5 text-center"><span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] uppercase ${TTI_COLOR[ev.threatTti]}`}>{TTI_LABEL[ev.threatTti]}</span></td>
                      <td className="px-3 py-1.5 text-center tabular-nums text-gray-700">{ev.threatTti}</td>
                      <td className="px-3 py-1.5 text-gray-800">{ev.threatTti === 1 ? labelFor(ev.threatModeS, flights) : "—"}<MteFlag ev={ev} /></td>
                      <td className="px-3 py-1.5 text-gray-700" title={`ARA=0x${ev.araHex} · RAC=0x${ev.racHex}`}>{ev.description}</td>
                      <KindCell ev={ev} />
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
        <Modal open={true} onClose={() => setDetailEv(null)} title={detailKind === "ra" ? "RA 상세 (BDS 3,0)" : "협의 상세 (BDS 3,0 · RAC/MTE)"} width="max-w-[95vw]">
          <div className="flex h-[82vh] gap-4 text-[11px]">
            {/* 좌: 보고 상세 */}
            <div className="w-[340px] shrink-0 space-y-3 overflow-auto pr-1">
              <div>
                <div className="text-gray-500 mb-1">시각 ({tz}) · Own</div>
                <div className="font-mono text-gray-800">
                  {detailEv.timeEstimated ? "~" : ""}{formatTime(detailEv.startTime, tz)} · {labelFor(detailEv.ownModeS, flights)}
                  {detailEv.timeEstimated && <span className="ml-1 text-gray-400">(시각 추정 — I140 부재)</span>}
                </div>
              </div>
              <div>
                <div className="text-gray-500 mb-1">BDS 3,0 raw 페이로드 (7바이트)</div>
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
                <div className="text-[10px] text-gray-500 border-t border-gray-100 pt-2">참고: 협의는 별도 BDS 1,6 메시지가 아니라 이 RA(BDS 3,0)의 RAC(협의 보충)≠0 또는 MTE(다중 위협)로 판정합니다. 지상 SSR은 공대공 BDS 1,6을 다운링크하지 않습니다.</div>
              )}
            </div>

            {/* 세퍼레이터 */}
            <div className="w-px shrink-0 bg-gray-200" />

            {/* 우: 프레임 전문 (RAW HEX + 해석) */}
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="mb-2 shrink-0 text-gray-500">
                프레임 전문 (NEC 프레임 · 전체 블록{detailEv.frameHex ? `, ${detailEv.frameHex.length / 2}바이트` : ""})
              </div>
              {detailEv.frameHex ? (
                <div className="flex min-h-0 flex-1 flex-col gap-2">
                  {/* RAW HEX */}
                  <div className="flex max-h-[32%] shrink-0 flex-col">
                    <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-gray-400">RAW HEX</div>
                    <div className="flex-1 overflow-auto rounded border border-gray-200 bg-gray-50 px-2 py-1.5 font-mono text-[10.5px] leading-relaxed text-gray-800 break-all">
                      {detailEv.frameHex.match(/.{2}/g)?.join(" ")}
                    </div>
                  </div>
                  {/* 해석 */}
                  <div className="flex min-h-0 flex-1 flex-col">
                    <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-gray-400">해석</div>
                    <div className="flex-1 overflow-auto rounded border border-gray-200 bg-white px-2 py-1.5">
                      {decodedFrame ? <FrameDecodeView frame={decodedFrame} /> : <span className="text-[10.5px] text-gray-400">해석 불가</span>}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-1 items-center justify-center rounded border border-dashed border-gray-200 text-gray-400">
                  프레임 데이터 없음 (재파싱 필요)
                </div>
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* 파싱 필터 모달 */}
      <ParseFilterModal open={filterModalOpen} onClose={closeFilterModal} onConfirm={parseWithFilter} aircraft={aircraft} />

      {/* 비행 통합 진행 오버레이 */}
      {consolidating && consolidationProgress && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="flex min-w-[280px] flex-col items-center gap-3 rounded-xl border border-gray-200 bg-white p-8 shadow-2xl">
            <Loader2 size={28} className="animate-spin text-[#a60739]" />
            <p className="text-sm text-gray-600">
              {consolidationProgress.stage === "grouping" && "포인트 그룹핑 중..."}
              {consolidationProgress.stage === "building" && `비행 생성 중... (${consolidationProgress.flightsBuilt}건)`}
              {consolidationProgress.stage === "history" && "운항이력 로드 중..."}
              {consolidationProgress.stage === "loading" && "DB에서 항적 로드 중..."}
              {consolidationProgress.stage === "done" && "완료"}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
