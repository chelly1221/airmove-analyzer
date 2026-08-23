/**
 * 토픽: PSR(1차 레이더) 채널 탐지·소실 상세.
 *
 * Rust analysis::psr_channel 이 상세 스캔 안에서 계산한 psr_channel 을 전수 렌더한다.
 * 분석 단위는 파일이 아니라 **추적기 트랙(I161)** — 같은 트랙을 공유하는 SSR 계열 보고가
 * "트랙은 살아있는데 PSR 이 못 봤다"는 증거이므로 PSR 탐지/소실을 SSR 과 독립 평가할 수 있다.
 *
 * 거리 단위는 전부 NM(레이더 원시 단위 I048/040 ρ). 소실 임계는 필터(psrLossThresholdSecs)라
 * 값을 바꾸면 onQuickFilter 를 통해 전수 재집계가 돈다 — run() 직접 호출 금지.
 * 검색·정렬·행 필터는 전부 로컬 상태(재집계 없음)이고 다운샘플링은 하지 않는다.
 */

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useAppStore } from "../../../store";
import { Section, StatCard } from "../shared";
import {
  compareSortVal,
  SearchInput,
  SortTh,
  TopicExcelExport,
  type ExportSheet,
  type SortDir,
  type SortState,
} from "../detailUi";
import PpiHeatmap from "../PpiHeatmap";
import { formatTime, labelFor } from "../format";
import { exportStrings, type ExportLang } from "../../../utils/exportI18n";
import type { Cell } from "../../../utils/xlsxExport";
import { AZ_GRID_SECTORS, RANGE_GRID_BINS } from "../../../types/asterixDetail";
import type {
  AsterixDetailFilter,
  AsterixDetailStats,
  PsrLossKind,
  PsrLossRow,
  PsrTrackRow,
  TzMode,
} from "../../../types/asterixDetail";

// ─── 상수 ──────────────────────────────────────────────────────────

/** Rust 기본 소실 임계 (AsterixDetailFilter.psrLossThresholdSecs 미지정 시) */
const DEFAULT_LOSS_THRESHOLD_S = 7.0;
/** 임계 입력 허용 범위 (초) — 스캔주기 하한보다 짧거나 비현실적으로 긴 값 차단 */
const THRESHOLD_MIN_S = 0.5;
const THRESHOLD_MAX_S = 120;
/** 거리 표를 펼칠 상한 = PSR 최대범위 + 이 여유 (NM). 그 밖은 "N+ NM" 한 행으로 합산 */
const RANGE_TABLE_MARGIN_NM = 20;

/** 소실 런 위치 한글 라벨 */
const LOSS_KIND_LABEL: Record<PsrLossKind, string> = {
  interior: "구간 내",
  head: "진입부",
  tail: "이탈부",
};
/** 소실 런 위치 배지 색 — interior(순수 공백)를 가장 강하게 */
const LOSS_KIND_CLASS: Record<PsrLossKind, string> = {
  interior: "bg-[#e94560]/10 text-[#e94560]",
  head: "bg-amber-100 text-amber-700",
  tail: "bg-sky-100 text-sky-700",
};

// ─── 표기 유틸 ─────────────────────────────────────────────────────

/** 0~1 비율 → 백분율 문자열 */
const ratePct = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "—");

/** 분자/분모 → 백분율 (분모 0 은 표본 없음) */
const sharePct = (n: number, d: number): string => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—");

/** 초 → 사람이 읽는 구간 길이 (1시간 이상 h/m, 1분 이상 m/s, 그 미만 초) */
function fmtDur(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "—";
  if (secs < 60) return `${secs.toFixed(secs < 10 ? 1 : 0)}초`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}분 ${Math.round(secs - m * 60)}초`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** NM 표기 — 소수 1자리 고정(5NM 격자와 자릿수 통일) */
const nm = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : "—");

// ─── 트랙 표 정렬 ──────────────────────────────────────────────────

type TrackSortKey = "loss" | "start" | "rate" | "scans";

/** 컬럼 첫 클릭 방향 — 소실/스캔은 큰 값, 시작은 이른 시각, 탐지율은 낮은 값(문제 트랙)이 먼저 */
const TRACK_DEFAULT_DIR: Record<TrackSortKey, SortDir> = {
  loss: "desc",
  start: "asc",
  rate: "asc",
  scans: "desc",
};

function trackSortVal(r: PsrTrackRow, k: TrackSortKey): number | string | null {
  switch (k) {
    case "loss":
      return r.loss_time_s;
    case "start":
      return r.start_ts;
    case "rate":
      return r.psr_rate;
    case "scans":
      return r.report_count;
  }
}

// ─── 소실 표 정렬 ──────────────────────────────────────────────────

type LossSortKey = "dur" | "start" | "minr";

const LOSS_DEFAULT_DIR: Record<LossSortKey, SortDir> = { dur: "desc", start: "asc", minr: "asc" };

function lossSortVal(r: PsrLossRow, k: LossSortKey): number | string | null {
  switch (k) {
    case "dur":
      return r.duration_s;
    case "start":
      return r.start_ts;
    case "minr":
      return r.min_range_nm;
  }
}

// ─── 소실 임계 입력 ────────────────────────────────────────────────

/**
 * 소실 임계(초) 입력 + 적용. 적용은 반드시 onQuickFilter 를 탄다 —
 * 상세 페이지가 appliedFilter 갱신과 재집계를 한 곳에서 묶고 있기 때문(run 직접 호출 금지).
 */
function LossThresholdField({
  applied,
  busyValue,
  onApply,
}: {
  /** 현재 적용된 값 (필터 미지정이면 Rust 기본값) */
  applied: number;
  /** 백엔드가 실제로 쓴 값 — 적용 확인 표기용 */
  busyValue: number;
  onApply: (v: number | undefined) => void;
}) {
  const [text, setText] = useState(String(applied));
  // 외부(필터바 초기화·다른 토픽 경유)에서 적용값이 바뀌면 입력도 따라간다
  useEffect(() => {
    setText(String(applied));
  }, [applied]);

  const parsed = Number(text);
  const valid = text.trim() !== "" && Number.isFinite(parsed) && parsed >= THRESHOLD_MIN_S && parsed <= THRESHOLD_MAX_S;
  const dirty = valid && parsed !== applied;

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-gray-500" title="연속 PSR 탐지 사이가 이 시간을 넘으면 소실 런으로 계상한다">
        소실 임계
      </span>
      <input
        type="number"
        step={0.5}
        min={THRESHOLD_MIN_S}
        max={THRESHOLD_MAX_S}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && dirty) onApply(parsed === DEFAULT_LOSS_THRESHOLD_S ? undefined : parsed);
        }}
        className={`h-7 w-20 rounded-md border bg-white px-2 text-[11px] tabular-nums focus:outline-none ${
          valid ? "border-gray-200 focus:border-[#a60739]" : "border-[#e94560] text-[#e94560]"
        }`}
        title={`${THRESHOLD_MIN_S}~${THRESHOLD_MAX_S}초`}
      />
      <span className="text-[11px] text-gray-400">초</span>
      <button
        type="button"
        disabled={!dirty}
        onClick={() => onApply(parsed === DEFAULT_LOSS_THRESHOLD_S ? undefined : parsed)}
        title="이 임계로 PSR 채널을 전수 재집계합니다 (파일 재스캔)"
        className="h-7 rounded-md bg-[#a60739] px-2.5 text-[11px] font-medium text-white transition-colors hover:bg-[#8a062f] disabled:cursor-default disabled:bg-gray-200 disabled:text-gray-400"
      >
        적용
      </button>
      <span className="text-[10px] text-gray-400 tabular-nums">집계 적용값 {busyValue.toFixed(1)}s</span>
    </div>
  );
}

// ─── 본문 ──────────────────────────────────────────────────────────

export default function PsrDetail({
  detail,
  tz,
  appliedFilter,
  onQuickFilter,
}: {
  detail: AsterixDetailStats;
  tz: TzMode;
  /** 적용된 필터 — 임계 입력 초기값 + PPI 격자 위 방위·거리 창 표시 */
  appliedFilter: AsterixDetailFilter;
  onQuickFilter: (p: Partial<AsterixDetailFilter>) => void;
}) {
  const psr = detail.psr_channel;
  const aircraft = useAppStore((s) => s.aircraft);

  const [trackSort, setTrackSort] = useState<SortState<TrackSortKey>>({ key: "loss", dir: "desc" });
  const [trackQuery, setTrackQuery] = useState("");
  const [hideNoPsr, setHideNoPsr] = useState(true);
  const [exclusiveOnly, setExclusiveOnly] = useState(false);
  const [lossSort, setLossSort] = useState<SortState<LossSortKey>>({ key: "dur", dir: "desc" });

  const appliedThreshold = appliedFilter.psrLossThresholdSecs ?? DEFAULT_LOSS_THRESHOLD_S;
  const skipped = psr.analysis_skipped_reason;

  /** PPI 탐지율 격자 — 보고 0 셀은 NaN(표본 없음)으로 두어 히트맵이 그리지 않게 한다 */
  const ppiRatio = useMemo(() => {
    const n = AZ_GRID_SECTORS * RANGE_GRID_BINS;
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const rep = psr.ppi_reports[i] ?? 0;
      out[i] = rep > 0 ? (psr.ppi_psr[i] ?? 0) / rep : NaN;
    }
    return out;
  }, [psr.ppi_reports, psr.ppi_psr]);

  /**
   * 거리 표 — PSR 최대범위 + 여유까지는 5NM 행을 펼치고, 그 밖은 한 행으로 합산한다.
   * (합산 행도 반드시 표시 — 원거리 보고를 화면에서 지우지 않는다)
   */
  const rangeView = useMemo(() => {
    const limitNm = Math.ceil((psr.psr_max_range_nm + RANGE_TABLE_MARGIN_NM) / 5) * 5;
    const rows: { key: string; label: string; reports: number; psr: number; loss: number }[] = [];
    let tailFrom = Number.POSITIVE_INFINITY;
    let tReports = 0;
    let tPsr = 0;
    let tLoss = 0;
    let tailCount = 0;
    for (const b of psr.range_bins) {
      if (b.to_nm <= limitNm) {
        rows.push({
          key: `${b.from_nm}`,
          label: `${b.from_nm}–${b.to_nm}`,
          reports: b.reports,
          psr: b.psr,
          loss: b.loss_time_s,
        });
      } else {
        tailCount++;
        if (b.from_nm < tailFrom) tailFrom = b.from_nm;
        tReports += b.reports;
        tPsr += b.psr;
        tLoss += b.loss_time_s;
      }
    }
    if (tailCount > 0) {
      rows.push({ key: "tail", label: `${tailFrom}+`, reports: tReports, psr: tPsr, loss: tLoss });
    }
    return rows;
  }, [psr.range_bins, psr.psr_max_range_nm]);

  const rangeTotals = useMemo(() => {
    let reports = 0;
    let hit = 0;
    for (const b of psr.range_bins) {
      reports += b.reports;
      hit += b.psr;
    }
    return { reports, psr: hit };
  }, [psr.range_bins]);

  const azTotals = useMemo(() => {
    let reports = 0;
    let hit = 0;
    for (const b of psr.az_bins) {
      reports += b.reports;
      hit += b.psr;
    }
    return { reports, psr: hit };
  }, [psr.az_bins]);

  /** 등록 비행검사기 hex → 표시명 (검색·병기용) */
  const acName = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of aircraft) {
      if (!a.mode_s_code) continue;
      const label = a.name || a.registration;
      if (label) m.set(a.mode_s_code.toUpperCase(), label);
    }
    return m;
  }, [aircraft]);

  // 트랙 표 — 검색·행 필터 후 정렬. 전수 유지(스크롤 컨테이너로만 제한)
  const trackRows = useMemo(() => {
    const q = trackQuery.trim().toUpperCase();
    const base = psr.tracks.filter((r) => {
      if (hideNoPsr && r.never_psr) return false;
      if (exclusiveOnly && !r.psr_exclusive) return false;
      if (q === "") return true;
      const ms = (r.mode_s ?? "").toUpperCase();
      return (
        ms.includes(q) ||
        String(r.track_number).includes(q) ||
        (acName.get(ms) ?? "").toUpperCase().includes(q)
      );
    });
    const arr = base.slice();
    arr.sort((a, b) => {
      const c = compareSortVal(trackSortVal(a, trackSort.key), trackSortVal(b, trackSort.key), trackSort.dir);
      return c !== 0 ? c : b.loss_time_s - a.loss_time_s || a.track_number - b.track_number;
    });
    return arr;
  }, [psr.tracks, trackQuery, hideNoPsr, exclusiveOnly, trackSort, acName]);

  const lossRows = useMemo(() => {
    const arr = psr.losses.slice();
    arr.sort((a, b) => {
      const c = compareSortVal(lossSortVal(a, lossSort.key), lossSortVal(b, lossSort.key), lossSort.dir);
      return c !== 0 ? c : b.duration_s - a.duration_s || a.track_number - b.track_number;
    });
    return arr;
  }, [psr.losses, lossSort]);

  /** Excel — 요약 / 거리별(전수 52빈) / 방위별(전수 72빈) / PPI 탐지율 격자 / 트랙 / 소실 */
  const buildSheets = (lang: ExportLang): ExportSheet[] => {
    const L = exportStrings(lang);
    const sheets: ExportSheet[] = [];
    const P = L.detail.psrSum;

    const summary: Cell[][] = [
      L.sumHeader,
      [P.reportsTotal, psr.reports_total],
      [P.reportsPsr, psr.reports_psr],
      [P.reportsPsrOnly, psr.reports_psr_only],
      [P.reportsSsrOnly, psr.reports_ssr_only],
      [P.sameScanMerged, psr.same_scan_merged],
      [P.tracksTotal, psr.tracks_total],
      [P.tracksWithPsr, psr.tracks_with_psr],
      [P.tracksNeverPsr, psr.tracks_never_psr],
      [P.tracksPsrExclusive, psr.tracks_psr_exclusive],
      [P.splitGap, psr.tracks_split_gap],
      [P.splitModeS, psr.tracks_split_mode_s],
      [P.splitSpeed, psr.tracks_split_speed],
      [P.scanPeriod, psr.scan_period_s != null ? Number(psr.scan_period_s.toFixed(3)) : ""],
      [P.psrMaxRange, Number(psr.psr_max_range_nm.toFixed(2))],
      [P.lossThreshold, Number(psr.loss_threshold_s.toFixed(2))],
      [P.detectRateInRange, Number((psr.psr_detect_rate_in_range * 100).toFixed(2))],
      [P.trackTime, Math.round(psr.total_track_time_s)],
      [P.lossTime, Math.round(psr.total_loss_time_s)],
      [P.lossRate, Number((psr.loss_rate * 100).toFixed(3))],
      [P.lossRunsSignal, psr.loss_runs_signal],
      [P.lossRunsOutOfRange, psr.loss_runs_out_of_range],
      [P.skippedReason, skipped ?? ""],
    ];
    sheets.push({ name: L.detail.sheet.psrSummary, rows: summary });

    if (psr.range_bins.length > 0) {
      const rows: Cell[][] = [L.detail.psrRangeHeader];
      for (const b of psr.range_bins) {
        rows.push([
          b.from_nm,
          b.to_nm,
          b.reports,
          b.psr,
          b.reports > 0 ? Number(((b.psr / b.reports) * 100).toFixed(3)) : "",
          Math.round(b.loss_time_s),
        ]);
      }
      sheets.push({ name: L.detail.sheet.psrRange, rows });
    }

    if (psr.az_bins.length > 0) {
      const rows: Cell[][] = [L.detail.psrAzHeader];
      for (const b of psr.az_bins) {
        rows.push([
          b.from_deg,
          b.to_deg,
          b.reports,
          b.psr,
          b.reports > 0 ? Number(((b.psr / b.reports) * 100).toFixed(3)) : "",
          Math.round(b.loss_time_s),
        ]);
      }
      sheets.push({ name: L.detail.sheet.psrAzimuth, rows });
    }

    if (psr.ppi_reports.length > 0) {
      // 행 = 방위 5° 섹터, 열 = 거리 5NM 구간. 값 = 탐지율(%) — 보고 0 셀은 빈칸
      const head: Cell[] = [L.detail.ppiCorner];
      for (let r = 0; r < RANGE_GRID_BINS; r++) head.push(`${r * 5}–${r * 5 + 5}`);
      const rows: Cell[][] = [head];
      for (let az = 0; az < AZ_GRID_SECTORS; az++) {
        const row: Cell[] = [`${az * 5}–${az * 5 + 5}`];
        for (let r = 0; r < RANGE_GRID_BINS; r++) {
          const i = az * RANGE_GRID_BINS + r;
          const rep = psr.ppi_reports[i] ?? 0;
          row.push(rep > 0 ? Number((((psr.ppi_psr[i] ?? 0) / rep) * 100).toFixed(2)) : "");
        }
        rows.push(row);
      }
      sheets.push({ name: L.detail.sheet.psrPpi, rows });
    }

    if (trackRows.length > 0) {
      const rows: Cell[][] = [L.detail.psrTrackHeader(tz)];
      for (const r of trackRows) {
        rows.push([
          r.track_number,
          r.mode_s ?? "",
          r.mode_s ? (acName.get(r.mode_s.toUpperCase()) ?? "") : "",
          r.mode3a ?? "",
          formatTime(r.start_ts, tz),
          formatTime(r.end_ts, tz),
          r.report_count,
          r.psr_count,
          r.psr_only_count,
          r.ssr_only_count,
          Number((r.psr_rate * 100).toFixed(2)),
          r.loss_count,
          Math.round(r.loss_time_s),
          Number(r.min_range_nm.toFixed(2)),
          Number(r.max_range_nm.toFixed(2)),
          r.never_psr ? 1 : 0,
          r.psr_exclusive ? 1 : 0,
        ]);
      }
      sheets.push({ name: L.detail.sheet.psrTracks, rows });
    }

    if (lossRows.length > 0) {
      const rows: Cell[][] = [L.detail.psrLossHeader(tz)];
      for (const r of lossRows) {
        rows.push([
          r.track_number,
          r.mode_s ?? "",
          L.detail.psrLossKind(r.kind),
          formatTime(r.start_ts, tz),
          formatTime(r.end_ts, tz),
          Number(r.duration_s.toFixed(1)),
          r.missed_scans,
          r.ssr_reports_inside,
          Number(r.start_range_nm.toFixed(2)),
          Number(r.end_range_nm.toFixed(2)),
          Number(r.min_range_nm.toFixed(2)),
          Number(r.mid_azimuth_deg.toFixed(1)),
        ]);
      }
      sheets.push({ name: L.detail.sheet.psrLosses, rows });
    }

    return sheets;
  };

  const splitTotal = psr.tracks_split_gap + psr.tracks_split_mode_s + psr.tracks_split_speed;

  return (
    <div className="space-y-3">
      {/* 상단 — 소실 임계 + Excel */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <LossThresholdField
          applied={appliedThreshold}
          busyValue={psr.loss_threshold_s}
          onApply={(v) => onQuickFilter({ psrLossThresholdSecs: v })}
        />
        <TopicExcelExport
          topic="psr"
          build={buildSheets}
          title="PSR 요약·거리별·방위별·탐지율 격자·트랙·소실을 Excel(.xlsx)로 내보냅니다 — 언어 선택"
        />
      </div>

      {/* 분석 생략 — 폴백 없이 사유를 드러낸다 */}
      {skipped && (
        <div className="flex items-start gap-2 rounded-lg border border-[#e94560]/30 bg-[#e94560]/5 px-3 py-2 text-[11px] text-[#e94560]">
          <AlertTriangle size={13} className="mt-px shrink-0" />
          <span>
            소실 분석 생략 — {skipped}. 아래 소실·탐지율 지표는 집계되지 않았습니다(대체 추정값을 쓰지 않습니다).
          </span>
        </div>
      )}

      {/* 요약 카드 */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">
        <StatCard
          label="보고(스캔)"
          value={psr.reports_total.toLocaleString()}
          sub={`동일스캔 병합 ${psr.same_scan_merged.toLocaleString()}건`}
          title="트랙 분할·동일스캔(Δt<1s) 병합 후의 스캔 수 — 아래 모든 비율의 분모"
        />
        <StatCard
          label="PSR 탐지"
          value={psr.reports_psr.toLocaleString()}
          sub={`보고의 ${sharePct(psr.reports_psr, psr.reports_total)}`}
          title="I020 TYP ∈ {1,3,6,7} — 1차 레이더 스킨 에코가 함께 잡힌 스캔"
        />
        <StatCard
          label="PSR 단독"
          value={psr.reports_psr_only.toLocaleString()}
          sub={`보고의 ${sharePct(psr.reports_psr_only, psr.reports_total)}`}
          title="TYP=1 — SSR 응답 없이 1차 에코만 잡힌 스캔"
        />
        <StatCard
          label="SSR 단독"
          value={psr.reports_ssr_only.toLocaleString()}
          sub={`보고의 ${sharePct(psr.reports_ssr_only, psr.reports_total)}`}
          title="TYP ∈ {2,4,5} — 트랙은 살아있는데 PSR 이 못 본 스캔(소실 근거)"
        />
        <StatCard
          label="트랙"
          value={psr.tracks_total.toLocaleString()}
          sub={`PSR 있음 ${psr.tracks_with_psr.toLocaleString()} · 없음 ${psr.tracks_never_psr.toLocaleString()}`}
          title="I161 추적기 트랙 (번호 재사용·Mode-S 변경·속도 이상으로 분할한 뒤의 수)"
        />
        <StatCard
          label="PSR 전용 트랙"
          value={psr.tracks_psr_exclusive.toLocaleString()}
          sub={`트랙의 ${sharePct(psr.tracks_psr_exclusive, psr.tracks_total)}`}
          title="모든 스캔이 TYP=1 인 트랙 — SSR 응답이 전무한 표적(비협조 표적·클러터 후보)"
        />
        <StatCard
          label="트랙 분할"
          value={splitTotal.toLocaleString()}
          sub={`공백 ${psr.tracks_split_gap} · MS ${psr.tracks_split_mode_s} · 속도 ${psr.tracks_split_speed}`}
          title="트랙번호 재사용 분리 횟수 — 60초 공백 / 양쪽 Mode-S 상이 / 암시속도 초과"
        />
        <StatCard
          label="스캔주기"
          value={psr.scan_period_s != null ? `${psr.scan_period_s.toFixed(2)} s` : "—"}
          sub={psr.scan_period_s != null ? "트랙별 Δt 중앙값들의 중앙값" : "표본 부족 — 추정 불가"}
          title="스캔 5회 이상 트랙의 Δt(0.5~30초) 중앙값들의 중앙값. 추정 불가 시 폴백 없이 생략"
        />
        <StatCard
          label="PSR 최대범위"
          value={`${psr.psr_max_range_nm.toFixed(1)} NM`}
          sub="PSR 탐지 ρ 의 p95"
          title="PSR 탐지 스캔 거리의 95백분위수 — 범위내/밖 판정 기준(클램프 없음)"
        />
        <StatCard
          label="범위내 PSR 탐지율"
          value={ratePct(psr.psr_detect_rate_in_range)}
          sub="PSR 있는 트랙 한정"
          title="Σ(p95 이내 PSR 스캔) / Σ(p95 이내 전 스캔) — PSR 없는 트랙은 분모에서 제외"
        />
        <StatCard
          label="추적시간"
          value={fmtDur(psr.total_track_time_s)}
          sub={`PSR 있는 트랙 ${psr.tracks_with_psr.toLocaleString()}건 합`}
          title="PSR 탐지가 있는 트랙의 (마지막−첫) 시각 합 — 소실율의 분모"
        />
        <StatCard
          label="소실시간"
          value={fmtDur(psr.total_loss_time_s)}
          sub={`임계 ${psr.loss_threshold_s.toFixed(1)}초 초과 구간`}
          title="signal_loss 런의 지속시간 합 (범위 밖 런은 제외)"
        />
        <StatCard
          label="소실율"
          value={ratePct(psr.loss_rate)}
          sub="소실시간 / 추적시간"
          title="PSR 채널이 표적을 놓친 시간 비중"
        />
        <StatCard
          label="소실 건수"
          value={psr.loss_runs_signal.toLocaleString()}
          sub={`범위밖 ${psr.loss_runs_out_of_range.toLocaleString()}건 제외`}
          title="signal_loss 런 수 — 런 전 구간이 p95 밖이면 out_of_range 로 분류해 목록에서 뺀다"
        />
      </div>

      {/* PPI 탐지율 히트맵 */}
      <Section
        title="PSR 탐지율 PPI (방위 5° × 거리 5NM)"
        right={<span className="text-[10px] text-gray-400">셀 값 = PSR 스캔 / 전 스캔 · 전 스캔 기준</span>}
      >
        <PpiHeatmap
          grid={ppiRatio}
          filter={appliedFilter}
          onQuickFilter={onQuickFilter}
          valueMode="ratio"
          emptyText="PSR 채널 표본 없음 — I161 트랙번호와 I040 극좌표를 가진 CAT048 레코드가 필요합니다"
          formatValue={(v, i) =>
            `탐지율 ${(v * 100).toFixed(1)}% (${(psr.ppi_psr[i] ?? 0).toLocaleString()} / ${(
              psr.ppi_reports[i] ?? 0
            ).toLocaleString()})`
          }
        />
      </Section>

      {/* 거리별 · 방위별 */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Section
          title="거리별 탐지·소실 (5NM)"
          right={
            <span className="text-[10px] text-gray-400">
              전 스캔 {rangeTotals.reports.toLocaleString()}건 · {`PSR 최대범위+${RANGE_TABLE_MARGIN_NM}NM 밖은 합산`}
            </span>
          }
        >
          <div className="max-h-[26rem] overflow-auto rounded border border-gray-100">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="sticky top-0 z-10 bg-gray-50 text-gray-500">
                  <th className="px-2 py-1 text-left font-medium">거리(NM)</th>
                  <th className="px-2 py-1 text-right font-medium">보고</th>
                  <th className="px-2 py-1 text-right font-medium">PSR</th>
                  <th className="px-2 py-1 text-right font-medium">탐지율</th>
                  <th className="px-2 py-1 text-right font-medium">소실시간</th>
                </tr>
              </thead>
              <tbody>
                {rangeView.map((r) => (
                  <tr key={r.key} className={`border-t border-gray-100${r.key === "tail" ? " bg-gray-50/60" : ""}`}>
                    <td className="px-2 py-1 tabular-nums text-gray-700">{r.label}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">{r.reports.toLocaleString()}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">{r.psr.toLocaleString()}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">{sharePct(r.psr, r.reports)}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-500">
                      {r.loss > 0 ? fmtDur(r.loss) : "—"}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-gray-200 bg-gray-50/60">
                  <td className="px-2 py-1 font-medium text-gray-600">합계</td>
                  <td className="px-2 py-1 text-right font-medium tabular-nums text-gray-700">
                    {rangeTotals.reports.toLocaleString()}
                  </td>
                  <td className="px-2 py-1 text-right font-medium tabular-nums text-gray-700">
                    {rangeTotals.psr.toLocaleString()}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-gray-500">
                    {sharePct(rangeTotals.psr, rangeTotals.reports)}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-gray-400">
                    {fmtDur(psr.total_loss_time_s)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Section>

        <Section
          title="방위별 탐지·소실 (5°)"
          right={<span className="text-[10px] text-gray-400">보고·PSR 은 PSR 최대범위(p95) 이내 스캔만</span>}
        >
          <div className="max-h-[26rem] overflow-auto rounded border border-gray-100">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="sticky top-0 z-10 bg-gray-50 text-gray-500">
                  <th className="px-2 py-1 text-left font-medium">방위(°)</th>
                  <th className="px-2 py-1 text-right font-medium">보고</th>
                  <th className="px-2 py-1 text-right font-medium">PSR</th>
                  <th className="px-2 py-1 text-right font-medium">탐지율</th>
                  <th className="px-2 py-1 text-right font-medium">소실시간</th>
                </tr>
              </thead>
              <tbody>
                {psr.az_bins.map((b) => (
                  <tr key={b.from_deg} className="border-t border-gray-100">
                    <td className="px-2 py-1 tabular-nums text-gray-700">
                      {b.from_deg}–{b.to_deg}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">{b.reports.toLocaleString()}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">{b.psr.toLocaleString()}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">{sharePct(b.psr, b.reports)}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-500">
                      {b.loss_time_s > 0 ? fmtDur(b.loss_time_s) : "—"}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-gray-200 bg-gray-50/60">
                  <td className="px-2 py-1 font-medium text-gray-600">합계</td>
                  <td className="px-2 py-1 text-right font-medium tabular-nums text-gray-700">
                    {azTotals.reports.toLocaleString()}
                  </td>
                  <td className="px-2 py-1 text-right font-medium tabular-nums text-gray-700">
                    {azTotals.psr.toLocaleString()}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-gray-500">
                    {sharePct(azTotals.psr, azTotals.reports)}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-gray-400">
                    {fmtDur(psr.total_loss_time_s)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Section>
      </div>

      {/* 트랙 표 */}
      <Section
        title={`트랙별 PSR 탐지 (${trackRows.length.toLocaleString()} / ${psr.tracks.length.toLocaleString()}행)`}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex cursor-pointer items-center gap-1 text-[10px] text-gray-500 select-none">
              <input
                type="checkbox"
                checked={hideNoPsr}
                onChange={(e) => setHideNoPsr(e.target.checked)}
                className="h-3 w-3 accent-[#a60739]"
              />
              PSR 없는 트랙 숨김
            </label>
            <label className="flex cursor-pointer items-center gap-1 text-[10px] text-gray-500 select-none">
              <input
                type="checkbox"
                checked={exclusiveOnly}
                onChange={(e) => setExclusiveOnly(e.target.checked)}
                className="h-3 w-3 accent-[#a60739]"
              />
              PSR 전용만
            </label>
            <SearchInput
              value={trackQuery}
              onChange={setTrackQuery}
              placeholder="Mode-S · 트랙번호"
              width="w-40"
              numeric
              title="Mode-S hex · 트랙번호 · 등록 기체명 부분일치 (로컬 검색 — 재집계 없음)"
            />
            {psr.tracks_truncated && (
              <span className="text-[10px] text-amber-600" title="소실시간 상위 2,000 트랙만 내려왔습니다">
                상한 절단
              </span>
            )}
          </div>
        }
      >
        {psr.tracks.length === 0 ? (
          <div className="text-[11px] text-gray-400">트랙 없음</div>
        ) : (
          <div className="max-h-[30rem] overflow-auto rounded border border-gray-100">
            <table className="w-full text-[11px]">
              <thead>
                <tr>
                  <th className="sticky top-0 z-10 whitespace-nowrap bg-gray-50 px-2 py-1.5 text-left font-medium text-gray-600">
                    트랙번호
                  </th>
                  <th className="sticky top-0 z-10 whitespace-nowrap bg-gray-50 px-2 py-1.5 text-left font-medium text-gray-600">
                    Mode-S
                  </th>
                  <SortTh
                    label={`시작~끝 (${tz})`}
                    k="start"
                    sort={trackSort}
                    setSort={setTrackSort}
                    defaultDir={TRACK_DEFAULT_DIR.start}
                  />
                  <SortTh
                    label="스캔"
                    k="scans"
                    align="right"
                    sort={trackSort}
                    setSort={setTrackSort}
                    defaultDir={TRACK_DEFAULT_DIR.scans}
                    title="동일스캔 병합 후 스캔 수 (PSR / SSR 단독 내역은 툴팁)"
                  />
                  <SortTh
                    label="PSR%"
                    k="rate"
                    align="right"
                    sort={trackSort}
                    setSort={setTrackSort}
                    defaultDir={TRACK_DEFAULT_DIR.rate}
                    title="PSR 탐지 스캔 / 전체 스캔 — 낮을수록 1차 채널이 놓친 트랙"
                  />
                  <SortTh
                    label="소실"
                    k="loss"
                    align="right"
                    sort={trackSort}
                    setSort={setTrackSort}
                    defaultDir={TRACK_DEFAULT_DIR.loss}
                    title="signal_loss 런 건수 / 시간 합"
                  />
                  <th className="sticky top-0 z-10 whitespace-nowrap bg-gray-50 px-2 py-1.5 text-right font-medium text-gray-600">
                    거리(NM)
                  </th>
                </tr>
              </thead>
              <tbody>
                {trackRows.map((r) => (
                  <tr
                    key={`${r.track_number}:${r.start_ts}`}
                    className={`border-t border-gray-100${r.never_psr ? " bg-amber-50/40" : ""}`}
                  >
                    <td className="px-2 py-1 tabular-nums text-gray-700">
                      {r.track_number}
                      {r.psr_exclusive && (
                        <span
                          className="ml-1 rounded bg-[#a60739]/10 px-1 text-[9px] font-medium text-[#a60739]"
                          title="모든 스캔이 TYP=1 — SSR 응답 전무"
                        >
                          전용
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 text-gray-600" title={r.mode3a ? `Mode-3/A ${r.mode3a}` : undefined}>
                      {r.mode_s ? labelFor(r.mode_s, aircraft) : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 font-mono text-gray-600">
                      {formatTime(r.start_ts, tz)} ~ {formatTime(r.end_ts, tz)}
                    </td>
                    <td
                      className="px-2 py-1 text-right tabular-nums text-gray-600"
                      title={`PSR ${r.psr_count} · PSR 단독 ${r.psr_only_count} · SSR 단독 ${r.ssr_only_count}`}
                    >
                      {r.report_count.toLocaleString()}
                    </td>
                    <td
                      className={`px-2 py-1 text-right tabular-nums ${
                        r.never_psr ? "text-amber-700" : r.psr_rate < 0.5 ? "text-[#e94560]" : "text-gray-600"
                      }`}
                    >
                      {r.never_psr ? "0%" : ratePct(r.psr_rate)}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">
                      {r.loss_count > 0 ? `${r.loss_count}건 · ${fmtDur(r.loss_time_s)}` : "—"}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-500">
                      {nm(r.min_range_nm)}–{nm(r.max_range_nm)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* 소실 표 */}
      <Section
        title={`PSR 소실 구간 (${lossRows.length.toLocaleString()}건)`}
        right={
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-gray-400">signal_loss 만 · 범위 밖 런 제외</span>
            {psr.losses_truncated && (
              <span className="text-[10px] text-amber-600" title="지속시간 상위 2,000 런만 내려왔습니다">
                상한 절단
              </span>
            )}
          </div>
        }
      >
        {lossRows.length === 0 ? (
          <div className="text-[11px] text-gray-400">
            {skipped ? "분석이 생략되어 소실 목록이 없습니다" : "임계를 넘는 PSR 소실 구간이 없습니다"}
          </div>
        ) : (
          <div className="max-h-[30rem] overflow-auto rounded border border-gray-100">
            <table className="w-full text-[11px]">
              <thead>
                <tr>
                  <th className="sticky top-0 z-10 whitespace-nowrap bg-gray-50 px-2 py-1.5 text-left font-medium text-gray-600">
                    트랙번호
                  </th>
                  <th className="sticky top-0 z-10 whitespace-nowrap bg-gray-50 px-2 py-1.5 text-left font-medium text-gray-600">
                    Mode-S
                  </th>
                  <th className="sticky top-0 z-10 whitespace-nowrap bg-gray-50 px-2 py-1.5 text-left font-medium text-gray-600">
                    구간
                  </th>
                  <SortTh
                    label={`시작~끝 (${tz})`}
                    k="start"
                    sort={lossSort}
                    setSort={setLossSort}
                    defaultDir={LOSS_DEFAULT_DIR.start}
                  />
                  <SortTh
                    label="지속"
                    k="dur"
                    align="right"
                    sort={lossSort}
                    setSort={setLossSort}
                    defaultDir={LOSS_DEFAULT_DIR.dur}
                  />
                  <th className="sticky top-0 z-10 whitespace-nowrap bg-gray-50 px-2 py-1.5 text-right font-medium text-gray-600">
                    결측 스캔
                  </th>
                  <th
                    className="sticky top-0 z-10 whitespace-nowrap bg-gray-50 px-2 py-1.5 text-right font-medium text-gray-600"
                    title="런 구간의 SSR 단독 스캔 수 — 0이면 순수 공백(트랙 자체가 끊긴 구간)"
                  >
                    내부 SSR
                  </th>
                  <SortTh
                    label="최소거리(NM)"
                    k="minr"
                    align="right"
                    sort={lossSort}
                    setSort={setLossSort}
                    defaultDir={LOSS_DEFAULT_DIR.minr}
                    title="런 전 구간의 최소 ρ — 전 구간이 p95 밖이면 범위 밖으로 분류돼 목록에서 빠진다"
                  />
                  <th className="sticky top-0 z-10 whitespace-nowrap bg-gray-50 px-2 py-1.5 text-right font-medium text-gray-600">
                    방위(°)
                  </th>
                </tr>
              </thead>
              <tbody>
                {lossRows.map((r, i) => (
                  <tr key={`${r.track_number}:${r.start_ts}:${i}`} className="border-t border-gray-100">
                    <td className="px-2 py-1 tabular-nums text-gray-700">{r.track_number}</td>
                    <td className="whitespace-nowrap px-2 py-1 text-gray-600">
                      {r.mode_s ? labelFor(r.mode_s, aircraft) : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-2 py-1">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${LOSS_KIND_CLASS[r.kind]}`}>
                        {LOSS_KIND_LABEL[r.kind]}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 font-mono text-gray-600">
                      {formatTime(r.start_ts, tz)} ~ {formatTime(r.end_ts, tz)}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-700">{fmtDur(r.duration_s)}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">
                      {r.missed_scans.toLocaleString()}
                    </td>
                    <td
                      className={`px-2 py-1 text-right tabular-nums ${
                        r.ssr_reports_inside > 0 ? "text-gray-600" : "text-gray-300"
                      }`}
                    >
                      {r.ssr_reports_inside.toLocaleString()}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">{nm(r.min_range_nm)}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-500">
                      {r.mid_azimuth_deg.toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
