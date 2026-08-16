import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Binary,
  FolderOpen,
  Loader2,
  Search,
  Clock,
  ChevronDown,
  ChevronUp,
  X,
  FileText,
  ShieldAlert,
  Siren,
} from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import Modal from "../components/common/Modal";
import DateRangePicker from "../components/common/DateRangePicker";
import { FrameInspector, CAT_LABEL } from "../components/common/FrameInspector";
import { useAppStore } from "../store";
import { decodeFrame, type DecodedFrame } from "../utils/asterixDecoder";
import { saveXlsx, type Cell } from "../utils/xlsxExport";
import { exportStrings, type ExportLang } from "../utils/exportI18n";
import { ExcelExportButton } from "../components/common/ExcelExportButton";
import {
  fmtBytes,
  fmtTod,
  formatTime,
  fmtGapDur,
  fmtShiftH,
  dtLocalToTs,
  catShort,
  labelFor,
} from "../components/asterix/format";
import {
  StatCard,
  Section,
  LabeledBars,
  TimeDensityChart,
  AzimuthRose,
} from "../components/asterix/shared";
import type {
  AsterixStats,
  AsterixFrameSummary,
  AsterixQueryResult,
  AsterixFilter,
} from "../types/asterix";
import type { AsterixStatTopic, TzMode } from "../types/asterixDetail";

type InnerTab = "dashboard" | "frames";

// ─── 업로드/스캔 훅 ──────────────────────────────────

function useAsterixScan() {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [notice, setNotice] = useState<{ title: string; message: string } | null>(null);

  const pickFiles = useCallback(async () => {
    if (scanning) return;
    const result = await open({
      multiple: true,
      filters: [{ name: "ASS Files", extensions: ["ass", "ASS"] }],
    });
    if (!result) return;
    const paths = (Array.isArray(result) ? result : [result]).filter((p): p is string => typeof p === "string");
    if (paths.length === 0) return;

    setScanning(true);
    setProgress({ done: 0, total: paths.length });

    const unlisten = await listen<{ done: number; total: number; filename: string }>(
      "asterix-scan-progress",
      (e) => setProgress({ done: e.payload.done, total: e.payload.total }),
    );

    try {
      const stats = await invoke<AsterixStats>("scan_asterix_batch", { filePaths: paths });
      useAppStore.getState().setAsterixResult(stats, paths);
      if (stats.record_count === 0) {
        setNotice({
          title: "ASTERIX 레코드 없음",
          message: `선택한 ${paths.length}개 파일에서 ASTERIX 레코드를 찾지 못했습니다.\nNEC ASS(CAT048/034/008) 형식인지 확인하세요.`,
        });
      }
    } catch (e) {
      console.error("[ASTERIX] 스캔 실패:", e);
      setNotice({ title: "스캔 실패", message: "파일을 읽지 못했습니다. ASS 파일 형식과 경로를 확인하세요." });
    } finally {
      unlisten();
      setScanning(false);
      setProgress(null);
    }
  }, [scanning]);

  return { pickFiles, scanning, progress, notice, closeNotice: () => setNotice(null) };
}

// ─── 대시보드 ────────────────────────────────────────

function Dashboard({
  stats,
  tz,
  onOpenTopic,
}: {
  stats: AsterixStats;
  tz: TzMode;
  /** 카드/섹션 드릴다운 — 통계 상세 페이지(/asterix/stats/:topic)로 이동 */
  onOpenTopic: (topic: AsterixStatTopic) => void;
}) {
  const recTotal = stats.record_count || 1;
  const timeRange =
    stats.time_min != null && stats.time_max != null
      ? `${formatTime(stats.time_min, tz)} ~ ${formatTime(stats.time_max, tz)} (${tz})`
      : stats.tod_min != null && stats.tod_max != null
        ? `${fmtTod(stats.tod_min)} ~ ${fmtTod(stats.tod_max)} UTC`
        : "—";

  // I140 TOD→UTC 자동보정이 적용된 파일 (보정량별 묶음)
  const todShiftGroups = useMemo(() => {
    const g = new Map<number, string[]>();
    for (const f of stats.files) {
      if (f.tod_shift_hours !== 0) {
        const list = g.get(f.tod_shift_hours);
        if (list) list.push(f.filename);
        else g.set(f.tod_shift_hours, [f.filename]);
      }
    }
    return [...g.entries()].sort((a, b) => a[0] - b[0]);
  }, [stats.files]);
  const rangeTotal = useMemo(() => stats.range_hist.reduce((a, b) => a + b.count, 0), [stats.range_hist]);
  const flTotal = useMemo(() => stats.fl_hist.reduce((a, b) => a + b.count, 0), [stats.fl_hist]);
  const speedTotal = useMemo(() => stats.speed_hist.reduce((a, b) => a + b.count, 0), [stats.speed_hist]);
  const bdsTotal = useMemo(() => stats.bds_reg_counts.reduce((a, b) => a + b.count, 0), [stats.bds_reg_counts]);

  // 비상코드 요약 — Rust가 [7700, 7600, 7500] 3개 고정으로 내려주므로 0도 그대로 표기
  const emergencySub = useMemo(
    () => stats.emergency_counts.map((e) => `${e.key} ${e.count.toLocaleString()}`).join(" · "),
    [stats.emergency_counts],
  );

  // BDS 2,0 호출부호 — Mode-S 상위 라벨에 병기
  const callsignMap = useMemo(
    () => new Map(stats.mode_s_callsigns.map((c) => [c.mode_s, c.callsign])),
    [stats.mode_s_callsigns],
  );
  const modesTopItems = useMemo(
    () =>
      stats.modes_top.map((m) => {
        const cs = callsignMap.get(m.key);
        return cs ? { ...m, label: `${m.label} · ${cs}` } : m;
      }),
    [stats.modes_top, callsignMap],
  );

  // EXCEL 내보내기 — 대시보드 통계를 항목별 시트로 분리해 저장
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const exportExcel = useCallback(async (lang: ExportLang) => {
    if (exporting) return;
    setExporting(true);
    try {
      const L = exportStrings(lang);
      // 비상코드는 항상 3개 고정이지만 인덱스가 아닌 코드 키로 조회
      const emg = (code: string) => stats.emergency_counts.find((e) => e.key === code)?.count ?? 0;
      const summary: Cell[][] = [
        L.sumHeader,
        [L.sum.files, stats.file_count],
        [L.sum.totalBytes, stats.total_bytes],
        [L.sum.frames, stats.frame_count],
        [L.sum.blocks, stats.block_count],
        [L.sum.records, stats.record_count],
        [L.sum.distinctModeS, stats.modes_distinct],
        [L.sum.acasRa, stats.acas_ra_records],
        [L.sum.emg7700, emg("7700")],
        [L.sum.emg7600, emg("7600")],
        [L.sum.emg7500, emg("7500")],
        [L.sum.simRecords, stats.sim_records],
        [L.sum.trackNumbers, stats.track_numbers_distinct],
        [L.sum.mode3aDistinct, stats.mode3a_distinct],
        [L.sum.timeRange, timeRange],
        [L.sum.necDates, stats.nec_dates.join(", ")],
        [L.sum.skippedBytes, stats.skipped_bytes],
        [L.sum.parseErrors, stats.parse_errors],
        [L.sum.truncated, stats.truncated_records],
        [L.sum.mode3aGarbled, stats.mode3a_garbled],
        [L.sum.flVInvalid, stats.fl_v_invalid],
        [L.sum.flGGarbled, stats.fl_g_garbled],
        [L.sum.todShiftFiles, stats.files.filter((f) => f.tod_shift_hours !== 0).length],
      ];
      const cats: Cell[][] = [L.catsHeader];
      for (const c of stats.cat_counts) cats.push([L.catLabel(c.cat), c.blocks, c.records]);

      const radarTyp: Cell[][] = [L.radarTypHeader];
      for (const r of stats.radar_typ_counts) radarTyp.push([L.radarTyp(r.key, r.label), r.count]);

      const frn: Cell[][] = [L.frnHeader];
      for (const f of stats.cat048_frn_counts) frn.push([f.id, L.frnName(f.id, f.name), f.count]);

      const modes: Cell[][] = [L.modesHeader];
      for (const m of stats.modes_top) modes.push([m.label, m.count, callsignMap.get(m.key) ?? ""]);

      const sacSic: Cell[][] = [L.sacSicHeader];
      for (const s of stats.sac_sic_counts) sacSic.push([s.sac, s.sic, s.count]);

      const msg: Cell[][] = [L.msgHeader];
      for (const m of stats.msg_type_034) msg.push(["CAT034", L.msg034(m.key, m.label), m.count]);
      for (const m of stats.msg_type_008) msg.push(["CAT008", L.msg008(m.key, m.label), m.count]);

      const files: Cell[][] = [L.filesHeader(tz)];
      for (const f of stats.files) {
        files.push([
          f.filename,
          f.bytes,
          f.frames,
          f.records,
          f.time_min != null ? formatTime(f.time_min, tz) : "",
          f.time_max != null ? formatTime(f.time_max, tz) : "",
          f.tod_shift_hours || 0,
        ]);
      }

      const sheets: { name: string; rows: Cell[][] }[] = [
        { name: L.sheet.summary, rows: summary },
        { name: L.sheet.categories, rows: cats },
        { name: L.sheet.radarTyp, rows: radarTyp },
        { name: L.sheet.frn, rows: frn },
        { name: L.sheet.modesTop, rows: modes },
        { name: L.sheet.sacSic, rows: sacSic },
        { name: L.sheet.msgType, rows: msg },
      ];

      // 신규 분포 시트 — 데이터 있을 때만 (빈 시트 생성 금지)
      const td = stats.time_density;
      if (td && td.counts.length > 0) {
        const rows: Cell[][] = [L.timeDensityHeader(tz)];
        for (let i = 0; i < td.counts.length; i++) {
          rows.push([formatTime(td.start_ts + i * td.bucket_secs, tz), td.counts[i]]);
        }
        sheets.push({ name: L.sheet.timeDensity, rows });
      }
      if (stats.range_hist.length > 0) {
        const rows: Cell[][] = [L.rangeHeader];
        for (const r of stats.range_hist) rows.push([r.label, r.count]);
        sheets.push({ name: L.sheet.rangeHist, rows });
      }
      if (stats.azimuth_hist.length > 0) {
        const rows: Cell[][] = [L.azimuthHeader];
        stats.azimuth_hist.forEach((c, s) => rows.push([`${s * 10}–${s * 10 + 10}°`, c]));
        sheets.push({ name: L.sheet.azimuthHist, rows });
      }
      if (stats.fl_hist.length > 0) {
        const rows: Cell[][] = [L.flHeader];
        for (const f of stats.fl_hist) rows.push([f.label, f.count]);
        sheets.push({ name: L.sheet.flHist, rows });
      }
      if (stats.mode3a_top.length > 0) {
        const rows: Cell[][] = [L.mode3aHeader];
        for (const m of stats.mode3a_top) rows.push([m.label, m.count]);
        sheets.push({ name: L.sheet.mode3aTop, rows });
      }
      if (stats.speed_hist.length > 0) {
        const rows: Cell[][] = [L.speedHeader];
        for (const s of stats.speed_hist) rows.push([s.label, s.count]);
        sheets.push({ name: L.sheet.speedHist, rows });
      }
      if (stats.bds_reg_counts.length > 0) {
        const rows: Cell[][] = [L.bdsHeader];
        // Rust 라벨은 "키 이름" 형식 — 시트엔 키 열이 따로 있으므로 이름만 분리해 언어 매핑
        for (const b of stats.bds_reg_counts) {
          const koName = b.label.startsWith(`${b.key} `) ? b.label.slice(b.key.length + 1) : b.label;
          rows.push([b.key, L.bdsName(b.key, koName), b.count]);
        }
        sheets.push({ name: L.sheet.bdsRegs, rows });
      }
      if (stats.rotation_stats.length > 0) {
        const rows: Cell[][] = [L.rotationHeader];
        for (const r of stats.rotation_stats) {
          rows.push([
            r.sac,
            r.sic,
            r.north_count,
            r.interval_count,
            Number(r.period_mean_s.toFixed(3)),
            Number(r.period_std_s.toFixed(4)),
            Number(r.period_min_s.toFixed(3)),
            Number(r.period_max_s.toFixed(3)),
            r.reported_period_s != null ? Number(r.reported_period_s.toFixed(3)) : "",
            r.sector_msgs,
            r.expected_sectors ?? "",
            r.missing_sectors,
          ]);
        }
        sheets.push({ name: L.sheet.rotation, rows });
      }
      if (stats.gaps.length > 0) {
        const rows: Cell[][] = [L.gapsHeader(tz)];
        for (const g of stats.gaps) {
          rows.push([formatTime(g.start_ts, tz), formatTime(g.end_ts, tz), g.duration_secs]);
        }
        sheets.push({ name: L.sheet.gaps, rows });
      }

      sheets.push({ name: L.sheet.files, rows: files });

      const stamp = new Date().toISOString().slice(0, 10);
      await saveXlsx(sheets, `ASTERIX_통계_${stamp}.xlsx`);
    } catch (e) {
      console.error("[ASTERIX] 대시보드 EXCEL 내보내기 실패:", e);
      setExportError(String(e));
    } finally {
      setExporting(false);
    }
  }, [exporting, stats, timeRange, tz, callsignMap]);

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <ExcelExportButton
          onExport={exportExcel}
          busy={exporting}
          title="통계를 Excel(.xlsx)로 내보냅니다 — 언어 선택"
        />
      </div>

      {/* 요약 카드 — 클릭 시 해당 토픽 상세 페이지로 드릴다운 */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatCard
          label="파일"
          value={stats.file_count.toLocaleString()}
          sub={fmtBytes(stats.total_bytes)}
          onClick={() => onOpenTopic("time")}
          title="수집 시간·공백 상세"
        />
        <StatCard
          label="프레임"
          value={stats.frame_count.toLocaleString()}
          onClick={() => onOpenTopic("time")}
          title="수집 시간·공백 상세"
        />
        <StatCard
          label="블록"
          value={stats.block_count.toLocaleString()}
          onClick={() => onOpenTopic("source")}
          title="출처·메시지·회전주기 상세"
        />
        <StatCard
          label="레코드"
          value={stats.record_count.toLocaleString()}
          onClick={() => onOpenTopic("source")}
          title="출처·메시지·회전주기 상세"
        />
        <StatCard
          label="Mode-S(고유)"
          value={stats.modes_distinct.toLocaleString()}
          onClick={() => onOpenTopic("identity")}
          title="Mode-S 식별 상세"
        />
        <StatCard
          label="트랙번호(고유)"
          value={stats.track_numbers_distinct.toLocaleString()}
          sub="SAC/SIC 구분"
          onClick={() => onOpenTopic("identity")}
          title="I048/161 트랙 번호 — 레이더 로컬이므로 SAC/SIC별로 구분해 집계"
        />
        <StatCard
          label="ACAS RA"
          value={stats.acas_ra_records.toLocaleString()}
          onClick={() => onOpenTopic("bds")}
          title="BDS 레지스터·ACAS 상세"
        />
        <StatCard
          label="비상코드"
          value={stats.emergency_records.toLocaleString()}
          sub={emergencySub}
          onClick={() => onOpenTopic("mode3a")}
          title="I048/070 Mode-3/A 비상코드 7500(하이재킹)/7600(통신두절)/7700(비상)"
        />
      </div>

      {/* 시간/날짜 */}
      <Section title="수집 범위" onOpen={() => onOpenTopic("time")}>
        <div className="grid grid-cols-1 gap-1 text-[11px] text-gray-700 md:grid-cols-2">
          <div>
            <span className="text-gray-400">시각 범위 </span>
            <span className="font-mono">{timeRange}</span>
          </div>
          <div>
            <span className="text-gray-400">NEC 프레임 날짜 </span>
            <span className="font-mono">{stats.nec_dates.length ? stats.nec_dates.join(", ") : "—"}</span>
          </div>
        </div>
        {todShiftGroups.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {todShiftGroups.map(([h, files]) => (
              <span
                key={h}
                title={`${files.slice(0, 10).join(", ")}${files.length > 10 ? ` 외 ${files.length - 10}개` : ""}`}
                className="rounded border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700"
              >
                I140 TOD {fmtShiftH(h)} → UTC 보정 · {files.length}개 파일
              </span>
            ))}
          </div>
        )}
        {stats.time_density && <TimeDensityChart density={stats.time_density} tz={tz} />}
        {stats.gaps.length > 0 && (
          <div className="mt-2">
            <div className="mb-0.5 flex items-baseline justify-between">
              <span className="text-[10px] uppercase tracking-wider text-gray-400">
                수집 공백 {stats.gap_count.toLocaleString()}곳 (분 해상도)
              </span>
              {stats.gap_count > stats.gaps.length && (
                <span className="text-[10px] text-gray-400">상위 {stats.gaps.length}곳만 표시</span>
              )}
            </div>
            <div className="max-h-40 overflow-auto rounded border border-gray-100">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="sticky top-0 bg-gray-50 text-gray-500">
                    <th className="px-2 py-1 text-left font-medium">시작 ({tz})</th>
                    <th className="px-2 py-1 text-left font-medium">끝 ({tz})</th>
                    <th className="px-2 py-1 text-right font-medium">길이</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.gaps.map((g, i) => (
                    <tr key={`${g.start_ts}:${i}`} className="border-t border-gray-100">
                      <td className="px-2 py-1 font-mono text-gray-600">{formatTime(g.start_ts, tz)}</td>
                      <td className="px-2 py-1 font-mono text-gray-600">{formatTime(g.end_ts, tz)}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-gray-700">{fmtGapDur(g.duration_secs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Section>

      {/* 2열 그리드 — 같은 행에 오는 두 카드는 동일 size 티어로 높이를 맞춘다 */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {/* 1행 (sm) — 카테고리 분포 */}
        <Section title="카테고리 분포" size="sm" onOpen={() => onOpenTopic("source")}>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-gray-500">
                <th className="py-1 text-left font-medium">카테고리</th>
                <th className="py-1 text-right font-medium">블록</th>
                <th className="py-1 text-right font-medium">레코드</th>
              </tr>
            </thead>
            <tbody>
              {stats.cat_counts.map((c) => (
                <tr key={c.cat} className="border-t border-gray-100">
                  <td className="py-1 text-gray-700">{CAT_LABEL[c.cat] ?? `CAT${catShort(c.cat)}`}</td>
                  <td className="py-1 text-right tabular-nums text-gray-600">{c.blocks.toLocaleString()}</td>
                  <td className="py-1 text-right tabular-nums text-gray-600">{c.records.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        {/* 1행 (sm) — SAC/SIC */}
        <Section title="데이터 출처 (SAC/SIC)" size="sm" onOpen={() => onOpenTopic("source")}>
          <LabeledBars
            items={stats.sac_sic_counts.map((s) => ({ key: `${s.sac}/${s.sic}`, label: `SAC ${s.sac} · SIC ${s.sic}`, count: s.count }))}
            total={recTotal}
            color="#b45309"
          />
        </Section>

        {/* 2행 (md) — 레이더 탐지 유형 (I020) */}
        <Section title="레이더 탐지 유형 (I048/020 TYP)" size="md" onOpen={() => onOpenTopic("source")}>
          <LabeledBars items={stats.radar_typ_counts} total={recTotal} />
        </Section>

        {/* 2행 (md) — 메시지 유형 034/008 */}
        <Section title="서비스/기상 메시지 유형 (CAT034 · CAT008)" size="md" onOpen={() => onOpenTopic("source")}>
          <div className="space-y-2">
            <div>
              <div className="mb-0.5 text-[10px] uppercase tracking-wider text-gray-400">CAT034</div>
              <LabeledBars items={stats.msg_type_034} total={stats.msg_type_034.reduce((a, b) => a + b.count, 0) || 1} color="#7c3aed" />
            </div>
            <div>
              <div className="mb-0.5 text-[10px] uppercase tracking-wider text-gray-400">CAT008</div>
              <LabeledBars items={stats.msg_type_008} total={stats.msg_type_008.reduce((a, b) => a + b.count, 0) || 1} color="#7c3aed" />
            </div>
          </div>
        </Section>

        {/* 3행 (lg) — 거리 분포 (I040 ρ) · 분모는 I040 보유 레코드 */}
        <Section title="거리 분포 (I048/040 ρ)" size="lg" onOpen={() => onOpenTopic("traffic")}>
          <LabeledBars items={stats.range_hist} total={rangeTotal} labelWidth="w-28" />
        </Section>

        {/* 3행 (lg) — 방위 분포 (I040 θ) · 차트 툴팁 잘림 방지로 스크롤 off */}
        <Section title="방위 분포 (I048/040 θ)" size="lg" scroll={false} onOpen={() => onOpenTopic("traffic")}>
          {stats.azimuth_hist.length === 0 ? (
            <div className="text-[11px] text-gray-400">없음</div>
          ) : (
            <AzimuthRose bins={stats.azimuth_hist} />
          )}
        </Section>

        {/* 4행 (lg) — 고도 분포 (I090) · 분모는 I090 보유 레코드 */}
        <Section title="고도 분포 (I048/090)" size="lg" onOpen={() => onOpenTopic("altspeed")}>
          <LabeledBars items={stats.fl_hist} total={flTotal} labelWidth="w-28" />
        </Section>

        {/* 4행 (lg) — 속도 분포 (I200) · 분모는 I200 보유 레코드 */}
        <Section title="속도 분포 (I048/200)" size="lg" scroll={false} onOpen={() => onOpenTopic("altspeed")}>
          {/* 이상치 각주를 하단 고정하려 body 스크롤은 리스트에만 건다 */}
          <div className="flex h-full flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <LabeledBars items={stats.speed_hist} total={speedTotal} color="#0f766e" labelWidth="w-28" />
            </div>
            <div className="mt-1 shrink-0 text-[10px] text-gray-400">
              정지 미만(&lt;10kt) {stats.speed_low_records.toLocaleString()}건 · 600kt 초과{" "}
              {stats.speed_high_records.toLocaleString()}건
            </div>
          </div>
        </Section>

        {/* 5행 (lg) — Mode-3/A 코드 상위 (I070) · 분모는 유효 Mode-3/A 보유 레코드 */}
        <Section
          title="Mode-3/A 코드 상위 (I048/070)"
          size="lg"
          onOpen={() => onOpenTopic("mode3a")}
          right={<span className="text-[10px] text-gray-400">고유 {stats.mode3a_distinct.toLocaleString()}개</span>}
        >
          <LabeledBars items={stats.mode3a_top} total={stats.mode3a_records} color="#0369a1" />
        </Section>

        {/* 5행 (lg) — Mode-S Top */}
        <Section title={`Mode-S 상위 (고유 ${stats.modes_distinct.toLocaleString()}개)`} size="lg" onOpen={() => onOpenTopic("identity")}>
          <LabeledBars items={modesTopItems} total={recTotal} color="#0f766e" />
        </Section>

        {/* 6행 (lg) — BDS 레지스터 분포 (I250) · 분모는 MB 블록 총수 */}
        <Section title="BDS 레지스터 (I048/250)" size="lg" onOpen={() => onOpenTopic("bds")}>
          <LabeledBars items={stats.bds_reg_counts} total={bdsTotal} color="#7c3aed" />
        </Section>

        {/* 6행 (lg) — CAT048 데이터 항목 출현 빈도 */}
        <Section title="CAT048 데이터 항목 출현 (전체 레코드 대비)" size="lg" onOpen={() => onOpenTopic("source")}>
          <LabeledBars
            items={stats.cat048_frn_counts.map((f) => ({ key: f.id, label: `${f.id}  ${f.name}`, count: f.count }))}
            total={recTotal}
            color="#1e6fa6"
          />
        </Section>
      </div>

      {/* 안테나 회전주기 (CAT034 North marker 간격) */}
      <Section title="안테나 회전주기 (CAT034)" onOpen={() => onOpenTopic("source")}>
        {stats.rotation_stats.length === 0 ? (
          <div className="text-[11px] text-gray-400">없음</div>
        ) : (
          <div className="overflow-auto rounded border border-gray-100">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="bg-gray-50 text-gray-500">
                  <th className="px-2 py-1 text-left font-medium">SAC/SIC</th>
                  <th className="px-2 py-1 text-right font-medium">회전수</th>
                  <th className="px-2 py-1 text-right font-medium">평균(s)</th>
                  <th className="px-2 py-1 text-right font-medium">σ(s)</th>
                  <th className="px-2 py-1 text-right font-medium">최소–최대(s)</th>
                  <th className="px-2 py-1 text-right font-medium">보고주기(s)</th>
                  <th className="px-2 py-1 text-right font-medium">섹터/회전</th>
                </tr>
              </thead>
              <tbody>
                {stats.rotation_stats.map((r) => (
                  <tr key={`${r.sac}/${r.sic}`} className="border-t border-gray-100">
                    <td className="px-2 py-1 text-gray-700">
                      SAC {r.sac} · SIC {r.sic}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">
                      {r.interval_count.toLocaleString()}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">
                      {r.interval_count > 0 ? r.period_mean_s.toFixed(2) : "—"}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">
                      {r.interval_count > 0 ? r.period_std_s.toFixed(3) : "—"}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">
                      {r.interval_count > 0
                        ? `${r.period_min_s.toFixed(2)}–${r.period_max_s.toFixed(2)}`
                        : "—"}
                    </td>
                    <td
                      className="px-2 py-1 text-right tabular-nums text-gray-600"
                      title="I034/041 안테나 회전주기 보고값 평균"
                    >
                      {r.reported_period_s != null ? r.reported_period_s.toFixed(2) : "—"}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">
                      {r.expected_sectors != null ? r.expected_sectors.toLocaleString() : "—"}
                      {r.missing_sectors > 0 && (
                        <span className="ml-1 text-[#e94560]" title="Σ(최빈 섹터수 − 실제 섹터수)">
                          · 누락 {r.missing_sectors.toLocaleString()}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* 품질/파싱 지표 */}
      <Section title="파싱 품질 지표" onOpen={() => onOpenTopic("quality")}>
        <div className="grid grid-cols-2 gap-2 text-[11px] md:grid-cols-4">
          <div><span className="text-gray-400">스킵 바이트 </span><span className="tabular-nums text-gray-700">{stats.skipped_bytes.toLocaleString()}</span></div>
          <div><span className="text-gray-400">파싱 오류 </span><span className="tabular-nums text-gray-700">{stats.parse_errors.toLocaleString()}</span></div>
          <div><span className="text-gray-400">절단 레코드 </span><span className="tabular-nums text-gray-700">{stats.truncated_records.toLocaleString()}</span></div>
          <div><span className="text-gray-400">Mode-3/A 무효 </span><span className="tabular-nums text-gray-700">{stats.mode3a_garbled.toLocaleString()}</span></div>
          <div title="I048/090 V=1 — 고도값이 검증되지 않음(고도는 그대로 수용)"><span className="text-gray-400">고도 미검증(V) </span><span className="tabular-nums text-gray-700">{stats.fl_v_invalid.toLocaleString()}</span></div>
          <div title="I048/090 G=1 — 고도값 garbled(고도는 그대로 수용)"><span className="text-gray-400">고도 Garbled(G) </span><span className="tabular-nums text-gray-700">{stats.fl_g_garbled.toLocaleString()}</span></div>
          <div title="I048/020 SIM=1 — 시뮬레이션 표적보고"><span className="text-gray-400">SIM 표적 </span><span className="tabular-nums text-gray-700">{stats.sim_records.toLocaleString()}</span></div>
        </div>
      </Section>

      {/* 파일별 */}
      <Section title="파일별 요약" onOpen={() => onOpenTopic("time")}>
        <div className="max-h-64 overflow-auto rounded border border-gray-100">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="sticky top-0 bg-gray-50 text-gray-500">
                <th className="px-2 py-1 text-left font-medium">파일</th>
                <th className="px-2 py-1 text-left font-medium">시각 범위 ({tz})</th>
                <th className="px-2 py-1 text-right font-medium">용량</th>
                <th className="px-2 py-1 text-right font-medium">프레임</th>
                <th className="px-2 py-1 text-right font-medium">레코드</th>
              </tr>
            </thead>
            <tbody>
              {stats.files.map((f, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="px-2 py-1 text-gray-700">
                    {f.filename}
                    {f.tod_shift_hours !== 0 && (
                      <span
                        title="I140 TOD→UTC 보정 적용"
                        className="ml-1 rounded border border-amber-200 bg-amber-50 px-1 text-[9px] tabular-nums text-amber-700"
                      >
                        {fmtShiftH(f.tod_shift_hours)}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1 text-left font-mono text-gray-600">
                    {f.time_min != null && f.time_max != null
                      ? `${formatTime(f.time_min, tz)} ~ ${formatTime(f.time_max, tz)}`
                      : "—"}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-gray-600">{fmtBytes(f.bytes)}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-gray-600">{f.frames.toLocaleString()}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-gray-600">{f.records.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* EXCEL 내보내기 실패 */}
      {exportError && (
        <Modal open onClose={() => setExportError(null)} title="EXCEL 내보내기 실패" width="max-w-md">
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

// ─── 프레임 탐색 ─────────────────────────────────────

function FrameBrowser({
  tz,
  setTz,
  acasSignal,
  onAcasHandled,
  emergencySignal,
  onEmergencyHandled,
}: {
  tz: TzMode;
  setTz: (t: TzMode) => void;
  /** 대시보드 ACAS RA 카드에서 넘어온 점프 신호 (0 = 없음) */
  acasSignal: number;
  onAcasHandled: () => void;
  /** 대시보드 비상코드 카드에서 넘어온 점프 신호 (0 = 없음) */
  emergencySignal: number;
  onEmergencyHandled: () => void;
}) {
  const filePaths = useAppStore((s) => s.asterixFilePaths);
  const aircraft = useAppStore((s) => s.aircraft);

  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState<number | null>(null);
  const [startDt, setStartDt] = useState("");
  const [endDt, setEndDt] = useState("");
  const [dateOpen, setDateOpen] = useState(false);
  const [acasOnly, setAcasOnly] = useState(false);
  const [emergencyOnly, setEmergencyOnly] = useState(false);

  const [querying, setQuerying] = useState(false);
  const [result, setResult] = useState<AsterixQueryResult | null>(null);
  const [searched, setSearched] = useState(false);
  const [detail, setDetail] = useState<AsterixFrameSummary | null>(null);

  const runQuery = useCallback(async () => {
    if (querying) return;
    const filter: AsterixFilter = {};
    if (search.trim()) filter.modeS = search.trim();
    if (catFilter != null) filter.cat = catFilter;
    const tMin = dtLocalToTs(startDt, tz);
    const tMax = dtLocalToTs(endDt, tz);
    if (tMin != null) filter.timeMin = tMin;
    if (tMax != null) filter.timeMax = tMax;
    if (acasOnly) filter.hasAcas = true;
    if (emergencyOnly) filter.hasEmergency = true;

    setQuerying(true);
    try {
      const res = await invoke<AsterixQueryResult>("query_asterix_frames", { filePaths, filter });
      setResult(res);
      setSearched(true);
    } catch (e) {
      console.error("[ASTERIX] 조회 실패:", e);
      setResult({ total_matched: 0, truncated: false, frames: [] });
      setSearched(true);
    } finally {
      setQuerying(false);
    }
  }, [querying, search, catFilter, startDt, endDt, acasOnly, emergencyOnly, tz, filePaths]);

  // 파일 업로드 시 필터 없는 전체 검색을 1회 자동 실행 (동일 파일셋 중복 방지)
  const autoSearchedPaths = useRef<string[] | null>(null);
  useEffect(() => {
    if (filePaths.length === 0) {
      autoSearchedPaths.current = null;
      return;
    }
    if (autoSearchedPaths.current === filePaths) return;
    // ACAS/비상코드 점프로 진입한 마운트면 아래 점프 effect가 대신 조회 (경합 방지)
    if (acasSignal > 0 || emergencySignal > 0) {
      autoSearchedPaths.current = filePaths;
      return;
    }
    autoSearchedPaths.current = filePaths;

    // 필터 초기화 후 무필터 조회
    setSearch("");
    setCatFilter(null);
    setStartDt("");
    setEndDt("");
    setAcasOnly(false);
    setEmergencyOnly(false);
    setQuerying(true);
    invoke<AsterixQueryResult>("query_asterix_frames", { filePaths, filter: {} })
      .then((res) => {
        setResult(res);
        setSearched(true);
      })
      .catch((e) => {
        console.error("[ASTERIX] 자동 조회 실패:", e);
        setResult({ total_matched: 0, truncated: false, frames: [] });
        setSearched(true);
      })
      .finally(() => setQuerying(false));
  }, [filePaths]);

  // 대시보드 ACAS RA 카드 → 이 탭으로 점프: 필터를 ACAS 전용으로 바꾸고 즉시 조회
  useEffect(() => {
    if (acasSignal <= 0) return;
    setSearch("");
    setCatFilter(null);
    setStartDt("");
    setEndDt("");
    setAcasOnly(true);
    setEmergencyOnly(false);
    onAcasHandled();

    // 상태 반영을 기다리지 않고 명시 필터로 즉시 조회
    setQuerying(true);
    invoke<AsterixQueryResult>("query_asterix_frames", { filePaths, filter: { hasAcas: true } })
      .then((res) => {
        setResult(res);
        setSearched(true);
      })
      .catch((e) => {
        console.error("[ASTERIX] ACAS 조회 실패:", e);
        setResult({ total_matched: 0, truncated: false, frames: [] });
        setSearched(true);
      })
      .finally(() => setQuerying(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acasSignal]);

  // 대시보드 비상코드 카드 → 이 탭으로 점프: 필터를 비상코드 전용으로 바꾸고 즉시 조회
  useEffect(() => {
    if (emergencySignal <= 0) return;
    setSearch("");
    setCatFilter(null);
    setStartDt("");
    setEndDt("");
    setAcasOnly(false);
    setEmergencyOnly(true);
    onEmergencyHandled();

    setQuerying(true);
    invoke<AsterixQueryResult>("query_asterix_frames", { filePaths, filter: { hasEmergency: true } })
      .then((res) => {
        setResult(res);
        setSearched(true);
      })
      .catch((e) => {
        console.error("[ASTERIX] 비상코드 조회 실패:", e);
        setResult({ total_matched: 0, truncated: false, frames: [] });
        setSearched(true);
      })
      .finally(() => setQuerying(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emergencySignal]);

  const clearFilters = () => {
    setSearch("");
    setCatFilter(null);
    setStartDt("");
    setEndDt("");
    setAcasOnly(false);
    setEmergencyOnly(false);
  };
  const anyFilter = !!(search || catFilter != null || startDt || endDt || acasOnly || emergencyOnly);

  // 상세 프레임 디코드
  const frameBytes = useMemo<number[]>(() => {
    if (!detail?.frame_hex) return [];
    return detail.frame_hex.match(/.{2}/g)?.map((h) => parseInt(h, 16)) ?? [];
  }, [detail]);
  const decoded = useMemo<DecodedFrame | null>(() => (frameBytes.length ? decodeFrame(frameBytes) : null), [frameBytes]);

  const fileName = (idx: number) => useAppStore.getState().asterixStats?.files[idx]?.filename ?? `#${idx}`;

  // EXCEL 내보내기 — 현재 조회된 프레임 목록을 그대로 .xlsx로 저장
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const exportExcel = useCallback(async (lang: ExportLang) => {
    if (exporting || !result || result.frames.length === 0) return;
    setExporting(true);
    try {
      const L = exportStrings(lang);
      const rows: Cell[][] = [L.framesHeaders(tz)];
      for (const f of result.frames) {
        rows.push([
          f.abs_time != null ? formatTime(f.abs_time, tz) : f.tod != null ? `${fmtTod(f.tod)} UTC` : "",
          fileName(f.file_index),
          f.cats.map(catShort).join(", "),
          f.record_count,
          f.mode_s_list.join(", "),
          f.has_acas ? "Y" : "",
          f.emergency_codes.join(", "),
          f.byte_len,
          `0x${f.frame_offset.toString(16)}`,
          f.tod != null ? Number(f.tod.toFixed(3)) : null,
        ]);
      }
      const stamp = new Date().toISOString().slice(0, 10);
      await saveXlsx([{ name: L.framesSheet, rows }], `ASTERIX_프레임_${stamp}.xlsx`);
    } catch (e) {
      console.error("[ASTERIX] 프레임 EXCEL 내보내기 실패:", e);
      setExportError(String(e));
    } finally {
      setExporting(false);
    }
  }, [exporting, result, tz]);

  return (
    <div className="flex h-full flex-col">
      {/* 필터 바 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gray-400">
            <Search size={12} />
          </span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runQuery()}
            placeholder="Mode-S (hex 부분일치)"
            className="h-7 w-48 rounded-md border border-gray-200 bg-white pl-7 pr-2 text-[11px] placeholder-gray-400 focus:border-[#a60739] focus:outline-none"
          />
        </div>

        <select
          value={catFilter ?? ""}
          onChange={(e) => setCatFilter(e.target.value === "" ? null : Number(e.target.value))}
          className="h-7 rounded-md border border-gray-200 bg-white px-2 text-[11px] text-gray-700 focus:border-[#a60739] focus:outline-none"
        >
          <option value="">전체 카테고리</option>
          <option value={0x30}>CAT048 표적보고</option>
          <option value={0x22}>CAT034 서비스</option>
          <option value={0x08}>CAT008 기상</option>
        </select>

        <span className="mx-0.5 h-4 w-px bg-gray-200" />

        {/* 기간 */}
        <div className="relative flex items-center">
          <button
            onClick={() => setDateOpen((o) => !o)}
            className={`inline-flex h-7 items-center gap-1.5 rounded-md border bg-white px-2.5 text-[10.5px] font-medium transition-colors ${
              startDt || endDt ? "border-[#a60739]/30 bg-[#a60739]/8 text-[#a60739]" : "border-gray-200 text-gray-500 hover:text-gray-700"
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
                  onStartChange={setStartDt}
                  onEndChange={setEndDt}
                  onTzChange={setTz}
                  onClear={() => {
                    setStartDt("");
                    setEndDt("");
                  }}
                  onDone={() => setDateOpen(false)}
                />
              </div>
            </>
          )}
        </div>

        {/* ACAS RA 전용 토글 */}
        <button
          onClick={() => setAcasOnly((v) => !v)}
          title="ACAS RA(I048/260 · BDS 3,0) 포함 프레임만 조회"
          className={`inline-flex h-7 items-center gap-1.5 rounded-md border bg-white px-2.5 text-[10.5px] font-medium transition-colors ${
            acasOnly ? "border-[#a60739]/30 bg-[#a60739]/8 text-[#a60739]" : "border-gray-200 text-gray-500 hover:text-gray-700"
          }`}
        >
          <ShieldAlert size={12} />
          ACAS RA
        </button>

        {/* Mode-3/A 비상코드 전용 토글 */}
        <button
          onClick={() => setEmergencyOnly((v) => !v)}
          title="Mode-3/A 비상코드(7500 하이재킹 · 7600 통신두절 · 7700 비상) 포함 프레임만 조회"
          className={`inline-flex h-7 items-center gap-1.5 rounded-md border bg-white px-2.5 text-[10.5px] font-medium transition-colors ${
            emergencyOnly ? "border-[#a60739]/30 bg-[#a60739]/8 text-[#a60739]" : "border-gray-200 text-gray-500 hover:text-gray-700"
          }`}
        >
          <Siren size={12} />
          비상코드
        </button>

        <button
          onClick={runQuery}
          disabled={querying}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-[#a60739] px-3 text-[11px] font-medium text-white transition-colors hover:bg-[#8a062f] disabled:opacity-50"
        >
          {querying ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
          검색
        </button>

        {anyFilter && (
          <button onClick={clearFilters} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[10.5px] text-gray-500 hover:bg-white hover:text-[#a60739]">
            <X size={11} />
            초기화
          </button>
        )}

        {result && (
          <div className="ml-auto flex items-center gap-3">
            <span className="text-[10.5px] tabular-nums text-gray-600">
              <span className="font-semibold text-gray-900">{result.frames.length.toLocaleString()}</span>
              <span className="text-gray-400"> / {result.total_matched.toLocaleString()} 매칭</span>
              {result.truncated && <span className="ml-1 text-amber-600">(상위 {result.frames.length.toLocaleString()}건만 — 필터를 좁히세요)</span>}
            </span>
            <ExcelExportButton
              onExport={exportExcel}
              busy={exporting}
              disabled={result.frames.length === 0}
              title="현재 조회된 프레임 목록을 Excel(.xlsx)로 내보냅니다 — 언어 선택"
              size="sm"
            />
          </div>
        )}
      </div>

      {/* 결과 테이블 */}
      <div className="mt-2 flex-1 overflow-auto rounded border border-gray-200">
        <table className="w-full text-[11px]">
          <thead>
            <tr>
              <th className="sticky top-0 z-10 bg-gray-50 px-3 py-2 text-left font-medium text-gray-600">시각 ({tz})</th>
              <th className="sticky top-0 z-10 bg-gray-50 px-3 py-2 text-left font-medium text-gray-600">파일</th>
              <th className="sticky top-0 z-10 bg-gray-50 px-3 py-2 text-left font-medium text-gray-600">카테고리</th>
              <th className="sticky top-0 z-10 bg-gray-50 px-3 py-2 text-right font-medium text-gray-600">레코드</th>
              <th className="sticky top-0 z-10 bg-gray-50 px-3 py-2 text-left font-medium text-gray-600">Mode-S</th>
              <th className="sticky top-0 z-10 bg-gray-50 px-3 py-2 text-center font-medium text-gray-600">경보</th>
              <th className="sticky top-0 z-10 bg-gray-50 px-3 py-2 text-right font-medium text-gray-600">바이트</th>
              <th className="sticky top-0 z-10 w-24 bg-gray-50 px-3 py-2 text-center font-medium text-gray-600">전문</th>
            </tr>
          </thead>
          <tbody>
            {!searched ? (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-gray-400">필터를 설정하고 검색하세요</td></tr>
            ) : result && result.frames.length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-gray-400">조건에 맞는 프레임이 없습니다</td></tr>
            ) : (
              result?.frames.map((f, i) => (
                <tr key={`${f.file_index}:${f.frame_offset}:${i}`} className="border-t border-gray-100 hover:bg-[#a60739]/5">
                  <td className="px-3 py-1.5 font-mono text-gray-700">
                    {f.abs_time != null ? formatTime(f.abs_time, tz) : f.tod != null ? `${fmtTod(f.tod)} UTC` : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-gray-600" title={fileName(f.file_index)}>{fileName(f.file_index)}</td>
                  <td className="px-3 py-1.5 text-gray-700">{f.cats.map(catShort).join(", ")}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-600">{f.record_count}</td>
                  <td className="px-3 py-1.5 text-gray-700" title={f.mode_s_list.join(", ")}>
                    {f.mode_s_list.length === 0
                      ? "—"
                      : f.mode_s_list.length === 1
                        ? labelFor(f.mode_s_list[0], aircraft)
                        : `${f.mode_s_list.slice(0, 2).join(", ")}${f.mode_s_list.length > 2 ? ` +${f.mode_s_list.length - 2}` : ""}`}
                  </td>
                  <td className="px-3 py-1.5 text-center">
                    {f.has_acas || f.emergency_codes.length > 0 ? (
                      <span className="inline-flex items-center justify-center gap-1">
                        {f.has_acas && (
                          <span title="ACAS RA" className="inline-flex">
                            <ShieldAlert size={13} className="text-[#a60739]" />
                          </span>
                        )}
                        {f.emergency_codes.length > 0 && (
                          <span
                            title="Mode-3/A 비상코드"
                            className="rounded bg-[#e94560] px-1 py-px text-[9px] font-semibold tabular-nums text-white"
                          >
                            {f.emergency_codes.join(", ")}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{f.byte_len}</td>
                  <td className="px-3 py-1.5 text-center">
                    <button
                      onClick={() => setDetail(f)}
                      className="inline-flex items-center gap-1 rounded border border-gray-200 px-2 py-1 text-[10px] font-medium text-gray-600 transition-colors hover:border-[#a60739]/40 hover:bg-[#a60739]/5 hover:text-[#a60739]"
                    >
                      <FileText size={11} />
                      전문보기
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* 전문 상세 모달 */}
      {detail && (
        <Modal open onClose={() => setDetail(null)} title="프레임 전문 (ASTERIX)" width="max-w-[95vw]">
          <div className="flex h-[82vh] flex-col text-[11px]">
            <div className="mb-2 shrink-0 text-gray-600">
              <span className="text-gray-400">파일 </span>{fileName(detail.file_index)}
              <span className="mx-2 text-gray-300">·</span>
              <span className="text-gray-400">오프셋 </span>0x{detail.frame_offset.toString(16)}
              <span className="mx-2 text-gray-300">·</span>
              <span className="text-gray-400">길이 </span>{detail.byte_len}바이트
              <span className="mx-2 text-gray-300">·</span>
              <span className="text-gray-400">카테고리 </span>{detail.cats.map(catShort).join(", ")}
              {detail.abs_time != null && (
                <>
                  <span className="mx-2 text-gray-300">·</span>
                  <span className="text-gray-400">시각 </span>{formatTime(detail.abs_time, tz)} ({tz})
                </>
              )}
            </div>
            {decoded ? (
              <FrameInspector frameBytes={frameBytes} decoded={decoded} />
            ) : (
              <div className="flex flex-1 items-center justify-center rounded border border-dashed border-gray-200 text-gray-400">
                프레임 데이터 없음
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* EXCEL 내보내기 실패 */}
      {exportError && (
        <Modal open onClose={() => setExportError(null)} title="EXCEL 내보내기 실패" width="max-w-md">
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

// ─── 페이지 ──────────────────────────────────────────

export default function AsterixAnalysis() {
  const stats = useAppStore((s) => s.asterixStats);
  const { pickFiles, scanning, progress, notice, closeNotice } = useAsterixScan();

  const { tab: tabParam } = useParams();
  const navigate = useNavigate();
  // 라우트 파라미터 → 내부 탭 (기본값: 프레임 탐색)
  const tab: InnerTab = tabParam === "stats" ? "dashboard" : "frames";
  const [tz, setTz] = useState<TzMode>("KST");

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="mb-3 flex items-center gap-2">
        <Binary size={20} className="text-[#a60739]" />
        <h1 className="text-lg font-semibold text-gray-800">ASTERIX 분석</h1>
        {stats && (
          <span className="text-[11px] text-gray-400">
            레코드 {stats.record_count.toLocaleString()} · 프레임 {stats.frame_count.toLocaleString()}
          </span>
        )}
        {stats && (
          <button
            onClick={pickFiles}
            disabled={scanning}
            title="기존 데이터를 비우고 새 ASS 파일을 스캔합니다"
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-[#a60739]/30 bg-white px-3 py-1.5 text-[12px] font-medium text-[#a60739] transition-colors hover:bg-[#a60739]/5 disabled:opacity-50"
          >
            {scanning ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
            {scanning ? `스캔 중 (${progress?.done ?? 0}/${progress?.total ?? 0})...` : "새 ASS 파일"}
          </button>
        )}
      </div>

      {!stats ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-gray-400">
          <p>ASTERIX 데이터가 없습니다. ASS 파일을 열어 전수 분석을 시작하세요.</p>
          <button
            onClick={pickFiles}
            disabled={scanning}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#8a062f] disabled:opacity-50"
          >
            {scanning ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
            {scanning ? `스캔 중 (${progress?.done ?? 0}/${progress?.total ?? 0})...` : "ASS 파일 열기"}
          </button>
        </div>
      ) : (
        /* 탭 전환은 사이드바 하위 항목(/asterix/stats · /asterix/frames)이 담당 */
        <div className="mt-3 min-h-0 flex-1 overflow-auto">
          {tab === "dashboard" ? (
            <Dashboard stats={stats} tz={tz} onOpenTopic={(topic) => navigate(`/asterix/stats/${topic}`)} />
          ) : (
            /* ACAS/비상코드 카드는 상세 페이지로 이동하도록 바뀌었지만, 프레임 탐색의
               점프 처리 경로(acasSignal/emergencySignal)는 추후 재사용을 위해 남겨둔다 */
            <FrameBrowser
              tz={tz}
              setTz={setTz}
              acasSignal={0}
              onAcasHandled={() => {}}
              emergencySignal={0}
              onEmergencyHandled={() => {}}
            />
          )}
        </div>
      )}

      {notice && (
        <Modal open onClose={closeNotice} title={notice.title} width="max-w-md">
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
    </div>
  );
}
