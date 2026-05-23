import { useCallback, useMemo, useState } from "react";
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
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import Modal from "../components/common/Modal";
import DateRangePicker from "../components/common/DateRangePicker";
import { FrameInspector, CAT_LABEL } from "../components/common/FrameInspector";
import { useAppStore } from "../store";
import { decodeFrame, type DecodedFrame } from "../utils/asterixDecoder";
import type {
  AsterixStats,
  AsterixFrameSummary,
  AsterixQueryResult,
  AsterixFilter,
  LabeledCount,
} from "../types/asterix";
import type { Aircraft } from "../types";

type TzMode = "UTC" | "KST";
type InnerTab = "dashboard" | "frames";
const KST_OFFSET_SECS = 9 * 3600;

// ─── 포맷 유틸 ───────────────────────────────────────

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${u[i]}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

function fmtTod(s: number | null): string {
  if (s == null) return "—";
  const x = ((s % 86400) + 86400) % 86400;
  return `${pad(Math.floor(x / 3600))}:${pad(Math.floor((x % 3600) / 60))}:${pad(Math.floor(x % 60))}`;
}

function formatTime(ts: number, tz: TzMode): string {
  const d = new Date((ts + (tz === "KST" ? KST_OFFSET_SECS : 0)) * 1000);
  const yy = String(d.getUTCFullYear()).slice(2);
  return `${yy}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function dtLocalToTs(s: string, tz: TzMode): number | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const utcMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return (utcMs - (tz === "KST" ? KST_OFFSET_SECS * 1000 : 0)) / 1000;
}

const CAT_SHORT: Record<number, string> = { 0x30: "048", 0x22: "034", 0x08: "008" };
const catShort = (cat: number) => CAT_SHORT[cat] ?? cat.toString(16).padStart(2, "0");

function labelFor(modeS: string, aircraft: Aircraft[]): string {
  const a = aircraft.find((ac) => ac.mode_s_code?.toUpperCase() === modeS.toUpperCase());
  const name = a?.name || a?.registration;
  return name ? `${name} (${modeS})` : modeS;
}

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

// ─── 대시보드 보조 컴포넌트 ──────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-[#f8f9fa] px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-gray-400">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-gray-800">{value}</div>
      {sub && <div className="text-[10px] text-gray-400">{sub}</div>}
    </div>
  );
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[12px] font-semibold text-gray-700">{title}</h3>
        {right}
      </div>
      {children}
    </div>
  );
}

function BarRow({ label, sub, count, total, color = "#a60739" }: { label: string; sub?: string; count: number; total: number; color?: string }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div className="flex items-center gap-2 py-0.5 text-[11px]">
      <div className="w-44 shrink-0 truncate text-gray-700" title={label}>
        {label}
        {sub && <span className="ml-1 text-gray-400">{sub}</span>}
      </div>
      <div className="relative h-3.5 flex-1 overflow-hidden rounded bg-gray-100">
        <div className="absolute inset-y-0 left-0 rounded" style={{ width: `${pct}%`, background: color, opacity: 0.85 }} />
      </div>
      <div className="w-28 shrink-0 text-right tabular-nums text-gray-600">
        {count.toLocaleString()} <span className="text-gray-400">{pct >= 0.1 ? `${pct.toFixed(1)}%` : ""}</span>
      </div>
    </div>
  );
}

function LabeledBars({ items, total, color }: { items: LabeledCount[]; total: number; color?: string }) {
  if (items.length === 0) return <div className="text-[11px] text-gray-400">없음</div>;
  return (
    <div>
      {items.map((it) => (
        <BarRow key={it.key} label={it.label} count={it.count} total={total} color={color} />
      ))}
    </div>
  );
}

// ─── 대시보드 ────────────────────────────────────────

function Dashboard({ stats, tz }: { stats: AsterixStats; tz: TzMode }) {
  const recTotal = stats.record_count || 1;
  const timeRange =
    stats.time_min != null && stats.time_max != null
      ? `${formatTime(stats.time_min, tz)} ~ ${formatTime(stats.time_max, tz)} (${tz})`
      : stats.tod_min != null && stats.tod_max != null
        ? `${fmtTod(stats.tod_min)} ~ ${fmtTod(stats.tod_max)} UTC`
        : "—";

  return (
    <div className="space-y-3">
      {/* 요약 카드 */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="파일" value={stats.file_count.toLocaleString()} sub={fmtBytes(stats.total_bytes)} />
        <StatCard label="프레임" value={stats.frame_count.toLocaleString()} />
        <StatCard label="블록" value={stats.block_count.toLocaleString()} />
        <StatCard label="레코드" value={stats.record_count.toLocaleString()} />
        <StatCard label="Mode-S(고유)" value={stats.modes_distinct.toLocaleString()} />
        <StatCard label="ACAS RA" value={stats.acas_ra_records.toLocaleString()} />
      </div>

      {/* 시간/날짜 */}
      <Section title="수집 범위">
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
      </Section>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {/* 카테고리 분포 */}
        <Section title="카테고리 분포">
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

        {/* 레이더 탐지 유형 (I020) */}
        <Section title="레이더 탐지 유형 (I048/020 TYP)">
          <LabeledBars items={stats.radar_typ_counts} total={recTotal} />
        </Section>

        {/* CAT048 데이터 항목 출현 빈도 */}
        <Section title="CAT048 데이터 항목 출현 (전체 레코드 대비)">
          <LabeledBars
            items={stats.cat048_frn_counts.map((f) => ({ key: f.id, label: `${f.id}  ${f.name}`, count: f.count }))}
            total={recTotal}
            color="#1e6fa6"
          />
        </Section>

        {/* Mode-S Top */}
        <Section title={`Mode-S 상위 (고유 ${stats.modes_distinct.toLocaleString()}개)`}>
          {stats.modes_top.length === 0 ? (
            <div className="text-[11px] text-gray-400">없음</div>
          ) : (
            <div className="max-h-72 overflow-auto">
              <LabeledBars items={stats.modes_top} total={recTotal} color="#0f766e" />
            </div>
          )}
        </Section>

        {/* SAC/SIC */}
        <Section title="데이터 출처 (SAC/SIC)">
          {stats.sac_sic_counts.length === 0 ? (
            <div className="text-[11px] text-gray-400">없음</div>
          ) : (
            <LabeledBars
              items={stats.sac_sic_counts.map((s) => ({ key: `${s.sac}/${s.sic}`, label: `SAC ${s.sac} · SIC ${s.sic}`, count: s.count }))}
              total={recTotal}
              color="#b45309"
            />
          )}
        </Section>

        {/* 메시지 유형 034/008 */}
        <Section title="서비스/기상 메시지 유형 (CAT034 · CAT008)">
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
      </div>

      {/* 품질/파싱 지표 */}
      <Section title="파싱 품질 지표">
        <div className="grid grid-cols-2 gap-2 text-[11px] md:grid-cols-4">
          <div><span className="text-gray-400">스킵 바이트 </span><span className="tabular-nums text-gray-700">{stats.skipped_bytes.toLocaleString()}</span></div>
          <div><span className="text-gray-400">파싱 오류 </span><span className="tabular-nums text-gray-700">{stats.parse_errors.toLocaleString()}</span></div>
          <div><span className="text-gray-400">절단 레코드 </span><span className="tabular-nums text-gray-700">{stats.truncated_records.toLocaleString()}</span></div>
          <div><span className="text-gray-400">Mode-3/A 무효 </span><span className="tabular-nums text-gray-700">{stats.mode3a_garbled.toLocaleString()}</span></div>
        </div>
      </Section>

      {/* 파일별 */}
      <Section title="파일별 요약">
        <div className="max-h-64 overflow-auto rounded border border-gray-100">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="sticky top-0 bg-gray-50 text-gray-500">
                <th className="px-2 py-1 text-left font-medium">파일</th>
                <th className="px-2 py-1 text-right font-medium">용량</th>
                <th className="px-2 py-1 text-right font-medium">프레임</th>
                <th className="px-2 py-1 text-right font-medium">레코드</th>
              </tr>
            </thead>
            <tbody>
              {stats.files.map((f, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="px-2 py-1 text-gray-700">{f.filename}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-gray-600">{fmtBytes(f.bytes)}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-gray-600">{f.frames.toLocaleString()}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-gray-600">{f.records.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

// ─── 프레임 탐색 ─────────────────────────────────────

function FrameBrowser({ tz, setTz }: { tz: TzMode; setTz: (t: TzMode) => void }) {
  const filePaths = useAppStore((s) => s.asterixFilePaths);
  const aircraft = useAppStore((s) => s.aircraft);

  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState<number | null>(null);
  const [startDt, setStartDt] = useState("");
  const [endDt, setEndDt] = useState("");
  const [dateOpen, setDateOpen] = useState(false);

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
  }, [querying, search, catFilter, startDt, endDt, tz, filePaths]);

  const clearFilters = () => {
    setSearch("");
    setCatFilter(null);
    setStartDt("");
    setEndDt("");
  };
  const anyFilter = !!(search || catFilter != null || startDt || endDt);

  // 상세 프레임 디코드
  const frameBytes = useMemo<number[]>(() => {
    if (!detail?.frame_hex) return [];
    return detail.frame_hex.match(/.{2}/g)?.map((h) => parseInt(h, 16)) ?? [];
  }, [detail]);
  const decoded = useMemo<DecodedFrame | null>(() => (frameBytes.length ? decodeFrame(frameBytes) : null), [frameBytes]);

  const fileName = (idx: number) => useAppStore.getState().asterixStats?.files[idx]?.filename ?? `#${idx}`;

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
          <span className="ml-auto text-[10.5px] tabular-nums text-gray-600">
            <span className="font-semibold text-gray-900">{result.frames.length.toLocaleString()}</span>
            <span className="text-gray-400"> / {result.total_matched.toLocaleString()} 매칭</span>
            {result.truncated && <span className="ml-1 text-amber-600">(상위 {result.frames.length.toLocaleString()}건만 — 필터를 좁히세요)</span>}
          </span>
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
              <th className="sticky top-0 z-10 bg-gray-50 px-3 py-2 text-center font-medium text-gray-600">ACAS</th>
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
                    {f.has_acas ? <ShieldAlert size={13} className="inline text-[#a60739]" /> : <span className="text-gray-300">—</span>}
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
    </div>
  );
}

// ─── 페이지 ──────────────────────────────────────────

export default function AsterixAnalysis() {
  const stats = useAppStore((s) => s.asterixStats);
  const { pickFiles, scanning, progress, notice, closeNotice } = useAsterixScan();

  const [tab, setTab] = useState<InnerTab>("dashboard");
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
        <>
          <div className="flex items-center gap-1 border-b border-gray-200">
            <button
              onClick={() => setTab("dashboard")}
              className={`px-4 py-2 text-[12px] font-medium border-b-2 -mb-px ${tab === "dashboard" ? "border-[#a60739] text-[#a60739]" : "border-transparent text-gray-500 hover:text-gray-700"}`}
            >
              통계 대시보드
            </button>
            <button
              onClick={() => setTab("frames")}
              className={`px-4 py-2 text-[12px] font-medium border-b-2 -mb-px ${tab === "frames" ? "border-[#a60739] text-[#a60739]" : "border-transparent text-gray-500 hover:text-gray-700"}`}
            >
              프레임 탐색
            </button>
          </div>

          <div className="mt-3 min-h-0 flex-1 overflow-auto">
            {tab === "dashboard" ? <Dashboard stats={stats} tz={tz} /> : <FrameBrowser tz={tz} setTz={setTz} />}
          </div>
        </>
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
