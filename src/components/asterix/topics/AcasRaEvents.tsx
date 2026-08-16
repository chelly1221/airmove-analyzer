/**
 * ACAS RA 이벤트 분석 — 구 독립 페이지(/acas)의 분석 UI를 통계 상세 "BDS·ACAS" 토픽으로 이관한 것.
 *
 * 자료 출처가 바뀌었다: 자체 ASS 업로드 + 전체 파싱 파이프라인 → ASTERIX 탭이 이미 스캔한
 * 파일셋(store.asterixFilePaths)을 scan_asterix_tcas 로 재파싱해 TCAS 보고만 뽑아온다.
 * 분석 로직(buildEventsFromReports · tcasDecoder)과 표시(15열 표 · RA 상세 · Excel)는 무변경.
 *
 * RA "이벤트"는 mode_s별 10초 그룹핑 결과라 상위 "ACAS RA 레코드(필터 적용 재집계)" 표의
 * 레코드 수와 분모가 다르다 — 두 표는 서로 다른 단위를 본다.
 */

import { useCallback, useMemo, useState } from "react";
import { ArrowUp, ArrowDown, Search, FileText, Clock, ChevronDown, ChevronUp, X, Loader2, Filter } from "lucide-react";
import Modal from "../../common/Modal";
import DateRangePicker from "../../common/DateRangePicker";
import { ExcelExportButton } from "../../common/ExcelExportButton";
import { FrameInspector } from "../../common/FrameInspector";
import { useAppStore } from "../../../store";
import { buildEventsFromReports, type TcasEvent } from "../../../utils/tcasEvents";
import { decodeFrame, type DecodedFrame } from "../../../utils/asterixDecoder";
import { saveXlsx, type Cell } from "../../../utils/xlsxExport";
import { exportStrings, type ExportLang } from "../../../utils/exportI18n";
import { formatTime, dtLocalToTs, labelFor } from "../format";
import type { AsterixTcasProgress } from "../../../hooks/useAsterixTcas";
import type { Aircraft } from "../../../types";
import type { TcasReport } from "../../../types/track";
import type { AsterixDetailFilter, TzMode } from "../../../types/asterixDetail";

type SortKey =
  | "startTime" | "ownLabel" | "ownAltFt" | "tti" | "threatLabel"
  | "raDescription" | "action" | "direction" | "threatRangeNm" | "threatBearingDeg"
  | "threatAltFt" | "duration" | "pointCount";

/**
 * format.ts labelFor 의 얇은 래퍼 — ACAS 보고는 Mode-S 부재(undefined / "NO_MODES")를 허용한다.
 * (공용 labelFor 는 유효 hex 만 받으므로 부재 케이스만 여기서 흡수)
 */
function acasLabel(modeS: string | undefined, aircraft: Aircraft[]): string {
  if (!modeS || modeS === "NO_MODES") return modeS ?? "—";
  return labelFor(modeS, aircraft);
}

/**
 * 페이지 필터 상속 계약 — 상단 DetailFilterBar 의 기간(timeMin/timeMax)·Mode-S 조건은
 * 이 섹션에도 그대로 적용한다. scan_asterix_tcas 는 필터를 받지 않고 TCAS 보고를 전수
 * 추출하므로(시각/전문 정합 보장을 위해 parse_ass_file 재사용) 상속은 프런트에서 건다.
 * 나머지 필터(거리·고도·SAC/SIC 등)는 RA 이벤트에 대응 필드가 없어 상속하지 않는다.
 *
 * 섹션 제목의 건수(BdsDetail)와 이 컴포넌트의 분모가 갈라지지 않도록 **단일 원천**으로 공유한다.
 */
export function inheritPageFilter(events: TcasEvent[], filter: AsterixDetailFilter): TcasEvent[] {
  const { timeMin, timeMax, modeS } = filter;
  const q = modeS?.trim().toUpperCase();
  if (timeMin == null && timeMax == null && !q) return events;
  return events.filter((ev) => {
    if (timeMin != null && ev.startTime < timeMin) return false;
    if (timeMax != null && ev.startTime > timeMax) return false;
    if (q) {
      const own = ev.ownModeS?.toUpperCase() ?? "";
      const thr = ev.threatModeS?.toUpperCase() ?? "";
      if (!own.includes(q) && !thr.includes(q)) return false;
    }
    return true;
  });
}

const TTI_LABEL: Record<number, string> = { 0: "상대정보없음", 1: "Mode-S", 2: "ATCRBS", 3: "예비" };
const TTI_COLOR: Record<number, string> = {
  0: "bg-gray-100 text-gray-500 border-gray-300",
  1: "bg-[#a60739]/10 text-[#a60739] border-[#a60739]/30",
  2: "bg-amber-100 text-amber-700 border-amber-300",
  3: "bg-gray-100 text-gray-500 border-gray-300",
};

export default function AcasRaEvents({
  reports,
  loading,
  progress,
  error,
  tz,
  setTz,
  appliedFilter,
}: {
  reports: TcasReport[] | null;
  loading: boolean;
  progress: AsterixTcasProgress | null;
  error: string | null;
  tz: TzMode;
  setTz: (t: TzMode) => void;
  /** 페이지 상단 DetailFilterBar 에서 "적용"된 필터 (상속 계약 — 아래 raEvents 주석 참조) */
  appliedFilter: AsterixDetailFilter;
}) {
  const aircraft = useAppStore((s) => s.aircraft);
  const filePathCount = useAppStore((s) => s.asterixFilePaths.length);

  /** 페이지 필터 이전 — TCAS 보고 전수에서 만든 RA 이벤트 (빈 상태 판정용) */
  const allEvents = useMemo(() => buildEventsFromReports(reports ?? []), [reports]);

  /** 페이지 필터 상속 후 (계약은 inheritPageFilter 주석 참조 — 섹션 제목 건수와 동일 원천) */
  const raEvents = useMemo(() => inheritPageFilter(allEvents, appliedFilter), [allEvents, appliedFilter]);

  /** 상속된 조건 목록 (칩 툴팁) */
  const inherited = useMemo(() => {
    const parts: string[] = [];
    if (appliedFilter.timeMin != null) parts.push(`RA 시작 ≥ ${formatTime(appliedFilter.timeMin, tz)} (${tz})`);
    if (appliedFilter.timeMax != null) parts.push(`RA 시작 ≤ ${formatTime(appliedFilter.timeMax, tz)} (${tz})`);
    if (appliedFilter.modeS?.trim()) parts.push(`Mode-S 부분일치 "${appliedFilter.modeS.trim().toUpperCase()}" (보고/위협)`);
    return parts;
  }, [appliedFilter, tz]);

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
        const o = acasLabel(ev.ownModeS, aircraft).toUpperCase();
        const t = acasLabel(ev.threatModeS, aircraft).toUpperCase();
        if (!o.includes(q) && !t.includes(q)) return false;
      }
      if (desc && !ev.raDescription.toLowerCase().includes(desc)) return false;
      return true;
    });
    const dir = sortDesc ? -1 : 1;
    filtered.sort((a, b) => {
      let av: number | string, bv: number | string;
      switch (sortKey) {
        case "ownLabel": av = acasLabel(a.ownModeS, aircraft); bv = acasLabel(b.ownModeS, aircraft); break;
        case "ownAltFt": av = a.ownAltFt ?? Infinity; bv = b.ownAltFt ?? Infinity; break;
        case "threatLabel": av = acasLabel(a.threatModeS, aircraft); bv = acasLabel(b.threatModeS, aircraft); break;
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

  // ── 로딩 / 오류 / 빈 상태 ────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-gray-400">
        <Loader2 size={14} className="animate-spin text-[#a60739]" />
        TCAS 보고 추출 중{progress ? ` (파일 ${progress.done}/${progress.total})` : ""}...
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-lg border border-[#e94560]/30 bg-[#e94560]/5 px-3 py-2 text-[11px] text-[#e94560]">
        TCAS 보고 추출 실패 — {error}
      </div>
    );
  }
  if (reports === null) {
    return <div className="text-[11px] text-gray-400">TCAS 보고를 아직 추출하지 않았습니다.</div>;
  }
  if (allEvents.length === 0) {
    return (
      <div className="rounded border border-dashed border-gray-200 px-3 py-6 text-center text-[11px] leading-relaxed text-gray-400">
        {reports.length === 0 ? (
          <>
            ACAS(TCAS) 보고 없음 — 스캔한 {filePathCount.toLocaleString()}개 파일에서 ACAS 보고를 찾지 못했습니다.
            <br />
            파일에 ACAS RA(I048/260) 또는 BDS 3,0 데이터가 없을 수 있습니다.
          </>
        ) : (
          <>
            TCAS 보고 {reports.length.toLocaleString()}건은 있으나 RA 이벤트가 없습니다.
            <br />
            유휴/비-RA 패턴(ARA 전 0 등)만 관측됐습니다.
          </>
        )}
      </div>
    );
  }

  return (
    <div>
      {/* 필터 — 1행 압축 (평면 배경) */}
      <div className="flex flex-wrap items-center gap-2">
        {/* 페이지 필터 상속 표시 */}
        {inherited.length > 0 && (
          <span
            title={`상단 필터에서 상속된 조건:\n· ${inherited.join("\n· ")}`}
            className="inline-flex h-7 flex-shrink-0 items-center gap-1 rounded-md border border-gray-200 bg-gray-50 px-2 text-[10.5px] font-medium text-gray-500"
          >
            <Filter size={11} />
            페이지 필터 적용됨
          </span>
        )}

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

        {/* 우측: 초기화 + 카운트 + Excel */}
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
          <ExcelExportButton
            onExport={exportExcel}
            busy={exporting}
            disabled={raRows.length === 0}
            size="sm"
            title="현재 필터·정렬된 RA 목록을 Excel(.xlsx)로 내보냅니다 — 언어 선택"
          />
        </div>
      </div>

      {/* 테이블 */}
      <div className="mt-2 max-h-[32rem] overflow-auto rounded border border-gray-200">
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
                <td className="px-3 py-1.5 text-gray-800">{acasLabel(ev.ownModeS, aircraft)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">{ev.ownAltFt != null ? Math.round(ev.ownAltFt) : "—"}</td>
                <td className="px-3 py-1.5 text-center"><span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] uppercase ${TTI_COLOR[ev.threatTti]}`}>{TTI_LABEL[ev.threatTti]}</span></td>
                <td className="px-3 py-1.5 text-center tabular-nums text-gray-700">{ev.threatTti}</td>
                <td className="px-3 py-1.5 text-gray-800">{ev.threatTti === 1 ? acasLabel(ev.threatModeS, aircraft) : "—"}<MteFlag ev={ev} /></td>
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

      {/* RAW 상세 모달 */}
      {detailEv && (
        <Modal open={true} onClose={() => setDetailEv(null)} title="RA 상세 (BDS 3,0)" width="max-w-[95vw]">
          <div className="flex h-[82vh] gap-4 text-[11px]">
            {/* 좌: 보고 상세 */}
            <div className="w-[340px] shrink-0 space-y-3 overflow-auto pr-1">
              <div>
                <div className="text-gray-500 mb-1">시각 ({tz}) · Own</div>
                <div className="font-mono text-gray-800">
                  {detailEv.timeEstimated ? "~" : ""}{formatTime(detailEv.startTime, tz)} · {acasLabel(detailEv.ownModeS, aircraft)}
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
