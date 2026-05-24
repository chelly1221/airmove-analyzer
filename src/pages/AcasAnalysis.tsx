import { useCallback, useMemo, useState } from "react";
import { ArrowUp, ArrowDown, Search, FileText, ShieldAlert, Clock, ChevronDown, ChevronUp, X, FolderOpen, Loader2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import Modal from "../components/common/Modal";
import ParseFilterModal, { type ParseFilterResult } from "../components/common/ParseFilterModal";
import DateRangePicker from "../components/common/DateRangePicker";
import { useAppStore } from "../store";
import { buildEventsFromReports, type TcasEvent } from "../utils/tcasEvents";
import { decodeFrame, type DecodedFrame } from "../utils/asterixDecoder";
import { saveXlsx, type Cell } from "../utils/xlsxExport";
import { exportStrings, type ExportLang } from "../utils/exportI18n";
import { ExcelExportButton } from "../components/common/ExcelExportButton";
import { FrameInspector } from "../components/common/FrameInspector";
import type { Aircraft } from "../types";
import type { TcasReport } from "../types/track";

/**
 * ASS 파일 선택 → 필터 모달 → 배치 파싱 → TCAS 보고만 누적.
 * ACAS는 TCAS 보고만 사용. 트랙 포인트/비행 통합은 하지 않으며(라벨은 aircraft 레지스트리),
 * 항적도는 별도 업로드 로직으로 독립 관리되므로 worker/flights를 건드리지 않는다.
 */
function useAssFilePicker() {
  const [parsing, setParsing] = useState(false);
  const [fileCount, setFileCount] = useState(0);
  const [filterModalOpen, setFilterModalOpen] = useState(false);
  const [pendingPaths, setPendingPaths] = useState<string[]>([]);
  const [notice, setNotice] = useState<{ title: string; message: string } | null>(null);

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

    // 기존 ACAS 보고만 비우고 새로 불러오기. 항적도(worker 포인트/비행/커버리지)는
    // 별도 업로드 로직으로 독립 관리되므로 ACAS 업로드에서 건드리지 않는다.
    useAppStore.getState().clearTcasReports();

    setParsing(true);
    setFileCount(paths.length);

    const site = useAppStore.getState().radarSite;

    // 파일별 결과: TCAS/ACAS 보고만 누적 (트랙 독립 전수 추출). 트랙 포인트는 무시.
    const unlistenResult = await listen<{ success: boolean; file_info?: { tcas_reports?: TcasReport[] } }>(
      "batch-parse-result",
      (event) => {
        const fi = event.payload.file_info;
        if (event.payload.success && fi?.tcas_reports?.length) {
          useAppStore.getState().appendTcasReports(fi.tcas_reports);
        }
      },
    );

    let failed = false;
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
      failed = true;
      console.error("[ACAS] 배치 파싱 실패:", e);
    }

    unlistenResult();

    setParsing(false);
    setPendingPaths([]);

    // 파싱 결과 피드백 — 파싱 실패 또는 ACAS 보고 0건이면 안내
    if (failed) {
      setNotice({ title: "파싱 실패", message: "파일을 읽지 못했습니다. ASS 파일 형식과 경로를 확인하세요." });
    } else if (useAppStore.getState().tcasReports.length === 0) {
      setNotice({
        title: "ACAS 정보 없음",
        message: `선택한 ${paths.length}개 파일에서 ACAS(TCAS) 보고를 찾지 못했습니다.\n파일에 ACAS RA(I048/260) 또는 BDS 3,0 데이터가 없을 수 있습니다.`,
      });
    }
  }, [pendingPaths]);

  const closeFilterModal = useCallback(() => {
    setFilterModalOpen(false);
    setPendingPaths([]);
  }, []);

  return { pickFiles, parseWithFilter, closeFilterModal, filterModalOpen, parsing, fileCount, notice, closeNotice: () => setNotice(null) };
}

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
function labelFor(modeS: string | undefined, aircraft: Aircraft[]): string {
  if (!modeS || modeS === "NO_MODES") return modeS ?? "—";
  const a = aircraft.find((ac) => ac.mode_s_code?.toUpperCase() === modeS.toUpperCase());
  const name = a?.name || a?.registration;
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
  const aircraft = useAppStore((s) => s.aircraft);

  const { pickFiles, parseWithFilter, closeFilterModal, filterModalOpen, parsing, fileCount, notice, closeNotice } = useAssFilePicker();

  const raEvents = useMemo(
    () => buildEventsFromReports(tcasReports),
    [tcasReports],
  );

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
  const [detailEv, setDetailEv] = useState<TcasEvent | null>(null);
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
        const o = labelFor(ev.ownModeS, aircraft).toUpperCase();
        const t = labelFor(ev.threatModeS, aircraft).toUpperCase();
        if (!o.includes(q) && !t.includes(q)) return false;
      }
      if (desc && !ev.raDescription.toLowerCase().includes(desc)) return false;
      return true;
    });
    const dir = sortDesc ? -1 : 1;
    filtered.sort((a, b) => {
      let av: number | string, bv: number | string;
      switch (sortKey) {
        case "ownLabel": av = labelFor(a.ownModeS, aircraft); bv = labelFor(b.ownModeS, aircraft); break;
        case "ownAltFt": av = a.ownAltFt ?? Infinity; bv = b.ownAltFt ?? Infinity; break;
        case "threatLabel": av = labelFor(a.threatModeS, aircraft); bv = labelFor(b.threatModeS, aircraft); break;
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
  }, [raEvents, aircraft, search, descKeyword, startDt, endDt, tz, tti0, tti1, tti2, sortKey, sortDesc]);

  const stats = useMemo(() => {
    let n0 = 0, n1 = 0, n2 = 0;
    for (const ev of raEvents) { if (ev.threatTti === 1) n1++; else if (ev.threatTti === 2) n2++; else n0++; }
    return { total: raEvents.length, tti0: n0, tti1: n1, tti2: n2 };
  }, [raEvents]);

  // EXCEL 내보내기 — 현재 필터/정렬이 적용된 RA 목록을 그대로 .xlsx로 저장
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const nameOf = useCallback((modeS?: string) => {
    if (!modeS || modeS === "NO_MODES") return "";
    const a = aircraft.find((ac) => ac.mode_s_code?.toUpperCase() === modeS.toUpperCase());
    return a?.name || a?.registration || "";
  }, [aircraft]);

  const exportExcel = useCallback(async (lang: ExportLang) => {
    if (exporting || raRows.length === 0) return;
    setExporting(true);
    try {
      const L = exportStrings(lang);
      const rows: Cell[][] = [L.acasHeaders(tz)];
      for (const ev of raRows) {
        rows.push([
          formatTime(ev.startTime, tz),
          L.estimated(ev.timeEstimated),
          ev.ownModeS === "NO_MODES" ? "" : ev.ownModeS,
          nameOf(ev.ownModeS),
          ev.ownAltFt != null ? Math.round(ev.ownAltFt) : null,
          L.tti(ev.threatTti),
          ev.threatTti,
          ev.threatTti === 1 ? (ev.threatModeS ?? "") : "",
          ev.threatTti === 1 ? nameOf(ev.threatModeS) : "",
          ev.mte ? "MTE" : "",
          ev.raDescription,
          ev.corrective ? "Corrective" : "Preventive",
          ev.downSense ? "Descend" : "Climb",
          ev.threatRangeNm != null ? Number(ev.threatRangeNm.toFixed(1)) : null,
          ev.threatBearingDeg != null ? Math.round(ev.threatBearingDeg) : null,
          ev.threatAltFt != null ? Math.round(ev.threatAltFt) : null,
          Number((ev.endTime - ev.startTime).toFixed(1)),
          ev.raPointCount,
          `0x${ev.araHex}`,
          `0x${ev.racHex}`,
        ]);
      }
      const stamp = new Date().toISOString().slice(0, 10);
      await saveXlsx([{ name: L.acasSheet, rows }], `ACAS_RA_${stamp}.xlsx`);
    } catch (e) {
      console.error("[ACAS] EXCEL 내보내기 실패:", e);
      setExportError(String(e));
    } finally {
      setExporting(false);
    }
  }, [exporting, raRows, tz, nameOf]);

  const SortHeader = ({ k, label, tip, cls = "" }: { k: SortKey; label: string; tip?: string; cls?: string }) => (
    <th onClick={() => toggleSort(k)} title={tip}
      className={`sticky top-0 z-10 bg-gray-50 px-3 py-2 text-left text-[11px] font-medium text-gray-600 select-none cursor-pointer hover:bg-gray-100 ${cls}`}>
      <div className="flex items-center gap-1"><span>{label}</span>{sortKey === k && (sortDesc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}</div>
    </th>
  );

  // 「종류」 → 「동작」(Corr/Prev) + 「방향」(↑/↓) 두 셀로 분할
  const KindCell = ({ ev }: { ev: TcasEvent }) => (
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
  const MteFlag = ({ ev }: { ev: TcasEvent }) =>
    ev.mte ? (
      <span title="MTE — 다중 위협"
        className="ml-1 inline-block rounded border border-amber-300 bg-amber-100 px-1 py-0.5 text-[9px] font-medium uppercase text-amber-700">
        MTE
      </span>
    ) : null;

  const openDetail = (ev: TcasEvent) => setDetailEv(ev);

  // 선택된 보고의 프레임 전문 바이트 + 디코드 (모달용, 가벼움)
  const frameBytes = useMemo<number[]>(() => {
    if (!detailEv?.frameHex) return [];
    return detailEv.frameHex.match(/.{2}/g)?.map((h) => parseInt(h, 16)) ?? [];
  }, [detailEv]);
  const decodedFrame = useMemo<DecodedFrame | null>(
    () => (frameBytes.length ? decodeFrame(frameBytes) : null),
    [frameBytes],
  );

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
        <span className="text-[11px] text-gray-400">RA {raEvents.length}</span>
        {tcasReports.length > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <ExcelExportButton
              onExport={exportExcel}
              busy={exporting}
              disabled={raRows.length === 0}
              title="현재 필터·정렬된 RA 목록을 Excel(.xlsx)로 내보냅니다 — 언어 선택"
            />
            <button
              onClick={pickFiles}
              disabled={parsing}
              title="기존 데이터를 비우고 새 ASS 파일을 불러옵니다"
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#a60739]/30 bg-white px-3 py-1.5 text-[12px] font-medium text-[#a60739] transition-colors hover:bg-[#a60739]/5 disabled:opacity-50"
            >
              {parsing ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
              {parsing ? `파싱 중 (${fileCount})...` : "새 ASS 파일"}
            </button>
          </div>
        )}
      </div>

      {tcasReports.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-gray-400">
          <p>ACAS 데이터가 없습니다.</p>
          <button
            onClick={pickFiles}
            disabled={parsing}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#8a062f] disabled:opacity-50"
          >
            {parsing ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
            {parsing ? `파싱 중 (${fileCount})...` : "ASS 파일 열기"}
          </button>
        </div>
      ) : (
        <>
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
                <span className="font-semibold text-gray-900">{raRows.length}</span>
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
                  <SortHeader k="raDescription" label="RA 의도" tip="ARA/RAC 비트 해석" />
                  <SortHeader k="action" label="동작" tip="Corrective(즉시 행동 필요) / Preventive(현 비행 유지)" cls="text-center" />
                  <SortHeader k="direction" label="방향" tip="수직 회피 방향 (Climb/Descend)" cls="text-center" />
                  <SortHeader k="threatRangeNm" label="위협 거리(NM)" tip="TTI=2(ATCRBS)일 때만" />
                  <SortHeader k="threatBearingDeg" label="위협 방위(°)" tip="TTI=2일 때만" />
                  <SortHeader k="threatAltFt" label="위협 고도(ft)" tip="TTI=2일 때만" />
                  <SortHeader k="duration" label="지속(s)" tip="첫~마지막 보고 간격" />
                  <SortHeader k="pointCount" label="횟수" tip="보고 점 수" />
                  <th className="sticky top-0 z-10 bg-gray-50 px-3 py-2 text-center text-[11px] font-medium text-gray-600 w-24">전문</th>
                </tr>
              </thead>
              <tbody>
                {raRows.length === 0 ? (
                  <tr><td colSpan={15} className="px-3 py-8 text-center text-gray-400">조건에 맞는 RA 이벤트가 없습니다</td></tr>
                ) : raRows.map((ev) => (
                  <tr key={ev.id} className="border-t border-gray-100 hover:bg-[#a60739]/5">
                    <td className="px-3 py-1.5 font-mono text-gray-700">{ev.timeEstimated ? "~" : ""}{formatTime(ev.startTime, tz)}</td>
                    <td className="px-3 py-1.5 text-gray-800">{labelFor(ev.ownModeS, aircraft)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">{ev.ownAltFt != null ? Math.round(ev.ownAltFt) : "—"}</td>
                    <td className="px-3 py-1.5 text-center"><span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] uppercase ${TTI_COLOR[ev.threatTti]}`}>{TTI_LABEL[ev.threatTti]}</span></td>
                    <td className="px-3 py-1.5 text-center tabular-nums text-gray-700">{ev.threatTti}</td>
                    <td className="px-3 py-1.5 text-gray-800">{ev.threatTti === 1 ? labelFor(ev.threatModeS, aircraft) : "—"}<MteFlag ev={ev} /></td>
                    <td className="px-3 py-1.5 text-gray-700" title={`ARA=0x${ev.araHex} · RAC=0x${ev.racHex}`}>{ev.raDescription}</td>
                    <KindCell ev={ev} />
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">{ev.threatRangeNm != null ? ev.threatRangeNm.toFixed(1) : "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">{ev.threatBearingDeg != null ? Math.round(ev.threatBearingDeg) : "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">{ev.threatAltFt != null ? Math.round(ev.threatAltFt) : "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{(ev.endTime - ev.startTime).toFixed(1)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{ev.raPointCount}</td>
                    <td className="px-3 py-1.5 text-center">
                      <button onClick={() => openDetail(ev)} className="inline-flex items-center gap-1 rounded border border-gray-200 px-2 py-1 text-[10px] font-medium text-gray-600 transition-colors hover:border-[#a60739]/40 hover:bg-[#a60739]/5 hover:text-[#a60739]" title="프레임 전문 + 해석 보기"><FileText size={11} />전문보기</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* RAW 상세 모달 */}
      {detailEv && (
        <Modal open={true} onClose={() => setDetailEv(null)} title="RA 상세 (BDS 3,0)" width="max-w-[95vw]">
          <div className="flex h-[82vh] gap-4 text-[11px]">
            {/* 좌: 보고 상세 */}
            <div className="w-[340px] shrink-0 space-y-3 overflow-auto pr-1">
              <div>
                <div className="text-gray-500 mb-1">시각 ({tz}) · Own</div>
                <div className="font-mono text-gray-800">
                  {detailEv.timeEstimated ? "~" : ""}{formatTime(detailEv.startTime, tz)} · {labelFor(detailEv.ownModeS, aircraft)}
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
                <div className="text-gray-500 mb-1">RA 의도</div>
                <div className="text-gray-800">{detailEv.raDescription}</div>
              </div>
              {detailEv.threatTti === 1 && detailEv.threatModeS && (
                <div><div className="text-gray-500">위협 Mode-S (TID, 23-46)</div><div className="font-mono text-gray-800">{detailEv.threatModeS}</div></div>
              )}
              {detailEv.threatTti === 2 && (
                <div>
                  <div className="text-gray-500 mb-1">위협 위치 (TID, ATCRBS)</div>
                  <div className="text-gray-800">
                    거리 {detailEv.threatRangeNm?.toFixed(1) ?? "—"} NM · 방위 {detailEv.threatBearingDeg != null ? Math.round(detailEv.threatBearingDeg) : "—"}° · 고도 {detailEv.threatAltFt != null ? Math.round(detailEv.threatAltFt) : "—"} ft
                  </div>
                </div>
              )}
            </div>

            {/* 세퍼레이터 */}
            <div className="w-px shrink-0 bg-gray-200" />

            {/* 우: 프레임 전문 (RAW HEX + 해석) */}
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="mb-2 shrink-0 text-gray-500">
                프레임 전문 (해당 RA 레코드 해석 · RAW는 NEC 프레임 전체{detailEv.frameHex ? `, ${detailEv.frameHex.length / 2}바이트` : ""})
              </div>
              {detailEv.frameHex && decodedFrame ? (
                <FrameInspector
                  frameBytes={frameBytes}
                  decoded={decodedFrame}
                  focus={{ i260Hex: detailEv.rawHex, modeSHex: detailEv.ownModeS }}
                />
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

      {/* 파싱 결과 안내 (ACAS 없음 / 실패) */}
      {notice && (
        <Modal open={true} onClose={closeNotice} title={notice.title} width="max-w-md">
          <div className="space-y-4 text-sm text-gray-700">
            <p className="whitespace-pre-line leading-relaxed">{notice.message}</p>
            <div className="flex justify-end">
              <button onClick={closeNotice} className="rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#8a062f]">
                확인
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* EXCEL 내보내기 실패 */}
      {exportError && (
        <Modal open={true} onClose={() => setExportError(null)} title="EXCEL 내보내기 실패" width="max-w-md">
          <div className="space-y-4 text-sm text-gray-700">
            <p className="break-all leading-relaxed">{exportError}</p>
            <div className="flex justify-end">
              <button onClick={() => setExportError(null)} className="rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#8a062f]">
                확인
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
