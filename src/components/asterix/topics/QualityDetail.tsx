/**
 * 토픽: 파싱 품질 상세.
 *
 * 구성: 품질 지표 카드 → 지표 성격 안내 캡션 → 카테고리별 블록/레코드 표 → 파일별 구조 표.
 *
 * 지표 성격 구분(중요):
 * - 구조 지표(필터 무관): skipped_bytes / parse_errors / cat_counts[].blocks / files[].bytes·frames·시각범위
 * - 레코드 플래그 지표(필터 적용): truncated_records / mode3a_garbled / fl_v_invalid / fl_g_garbled /
 *   sim_records / cat_counts[].records / files[].records
 */

import { useMemo, useState } from "react";
import { Section, StatCard } from "../shared";
import {
  compareSortVal,
  SortTh,
  TopicExcelExport,
  type ExportSheet,
  type SortDir,
  type SortState,
} from "../detailUi";
import { exportStrings, type ExportLang } from "../../../utils/exportI18n";
import type { Cell } from "../../../utils/xlsxExport";
import { catShort, fmtBytes, formatTime } from "../format";
import { CAT_LABEL } from "../../common/FrameInspector";
import type { AsterixFileStat } from "../../../types/asterix";
import type { AsterixDetailFilter, AsterixDetailStats, TzMode } from "../../../types/asterixDetail";

// ─── 로컬 유틸 ───────────────────────────────────────

/** 비율 표기 — 0은 "0%", 0 초과 0.001% 미만은 "<0.001%" (품질 지표는 극소값이 흔함) */
function pctStr(n: number, d: number): string {
  if (d <= 0) return "—";
  if (n <= 0) return "0%";
  const p = (n / d) * 100;
  if (p < 0.001) return "<0.001%";
  if (p < 1) return `${p.toFixed(3)}%`;
  return `${p.toFixed(p >= 10 ? 1 : 2)}%`;
}

/** 프레임당 레코드 — 프레임이 0이면 null (표·시트 모두 결측 처리) */
const recPerFrame = (f: AsterixFileStat): number | null => (f.frames > 0 ? f.records / f.frames : null);

// ─── 파일별 구조 표 정렬 ─────────────────────────────

type SortKey = "name" | "bytes" | "frames" | "records" | "rpf";

/** 컬럼을 처음 눌렀을 때의 방향 — 수치는 큰 값 우선, 파일명은 오름차순 */
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  name: "asc",
  bytes: "desc",
  frames: "desc",
  records: "desc",
  rpf: "desc",
};

/** 정렬 키 → 비교값 (결측은 null → 방향과 무관하게 항상 뒤로) */
function sortVal(f: AsterixFileStat, k: SortKey): number | string | null {
  switch (k) {
    case "name":
      return f.filename;
    case "bytes":
      return f.bytes;
    case "frames":
      return f.frames;
    case "records":
      return f.records;
    case "rpf":
      return recPerFrame(f);
  }
}

/** 공용 SortTh 에 이 표의 컬럼별 기본 정렬 방향을 주입한 래퍼 */
function Th({
  label,
  k,
  sort,
  setSort,
  align,
  title,
}: {
  label: string;
  k: SortKey;
  sort: SortState<SortKey>;
  setSort: React.Dispatch<React.SetStateAction<SortState<SortKey>>>;
  align?: "left" | "right";
  title?: string;
}) {
  return (
    <SortTh label={label} k={k} sort={sort} setSort={setSort} defaultDir={DEFAULT_DIR[k]} align={align} title={title} />
  );
}

// ─── 본문 ────────────────────────────────────────────

export default function QualityDetail({
  detail,
  tz,
  onQuickFilter,
}: {
  detail: AsterixDetailStats;
  tz: TzMode;
  onQuickFilter: (p: Partial<AsterixDetailFilter>) => void;
}) {
  const { stats, unfiltered_records } = detail;
  const rec = stats.record_count;
  const [sort, setSort] = useState<SortState<SortKey>>({ key: "name", dir: "asc" });

  /** 품질 지표 카드 — 앞 2장은 구조 지표, 나머지 5장은 필터 적용 레코드 플래그 */
  const cards: { key: string; label: string; value: string; sub: string; title: string }[] = [
    {
      key: "skipped",
      label: "스킵 바이트",
      value: stats.skipped_bytes.toLocaleString(),
      sub: `${fmtBytes(stats.skipped_bytes)} · 전체 용량의 ${pctStr(stats.skipped_bytes, stats.total_bytes)}`,
      title: "NEC 프레임/ASTERIX 블록 동기를 찾지 못해 건너뛴 바이트 (구조 지표 — 필터 무관)",
    },
    {
      key: "errors",
      label: "파싱 오류",
      value: stats.parse_errors.toLocaleString(),
      sub: `프레임 ${stats.frame_count.toLocaleString()} 대비 ${pctStr(stats.parse_errors, stats.frame_count)}`,
      title: "블록/레코드 해석 실패 건수 (구조 지표 — 필터 무관)",
    },
    {
      key: "truncated",
      label: "절단 레코드",
      value: stats.truncated_records.toLocaleString(),
      sub: `레코드 대비 ${pctStr(stats.truncated_records, rec)}`,
      title: "선언된 블록 길이보다 데이터가 짧아 항목 해석 도중 끝난 레코드",
    },
    {
      key: "mode3a",
      label: "Mode-3/A 무효",
      value: stats.mode3a_garbled.toLocaleString(),
      sub: `레코드 대비 ${pctStr(stats.mode3a_garbled, rec)}`,
      title: "I048/070 V=1(코드 무효) 또는 G=1(garbled) — 코드값을 신뢰할 수 없음",
    },
    {
      key: "flv",
      label: "고도 미검증(V)",
      value: stats.fl_v_invalid.toLocaleString(),
      sub: `레코드 대비 ${pctStr(stats.fl_v_invalid, rec)}`,
      title: "I048/090 V=1 — 고도값이 검증되지 않음(고도는 그대로 수용)",
    },
    {
      key: "flg",
      label: "고도 Garbled(G)",
      value: stats.fl_g_garbled.toLocaleString(),
      sub: `레코드 대비 ${pctStr(stats.fl_g_garbled, rec)}`,
      title: "I048/090 G=1 — 고도값 garbled(고도는 그대로 수용)",
    },
    {
      key: "sim",
      label: "SIM 표적",
      value: stats.sim_records.toLocaleString(),
      sub: `레코드 대비 ${pctStr(stats.sim_records, rec)}`,
      title: "I048/020 SIM=1 — 시뮬레이션 표적보고(실표적 아님)",
    },
  ];

  const catBlockTotal = stats.cat_counts.reduce((a, c) => a + c.blocks, 0);
  const catRecordTotal = stats.cat_counts.reduce((a, c) => a + c.records, 0);

  // 정렬 — 원본(스캔 순서) 훼손 금지라 항상 복사본을 정렬
  const fileRows = useMemo(() => {
    const arr = stats.files.slice();
    arr.sort((a, b) => {
      // 결측(null)은 방향과 무관하게 항상 뒤로 — compareSortVal 공통 규칙
      const c = compareSortVal(sortVal(a, sort.key), sortVal(b, sort.key), sort.dir);
      return c !== 0 ? c : a.filename.localeCompare(b.filename);
    });
    return arr;
  }, [stats.files, sort]);

  /** Excel — 카테고리별 블록·레코드 + 파일별 구조 */
  const buildSheets = (lang: ExportLang): ExportSheet[] => {
    const L = exportStrings(lang);
    const sheets: ExportSheet[] = [];

    if (stats.cat_counts.length > 0) {
      const rows: Cell[][] = [L.detail.catQualityHeader];
      for (const c of stats.cat_counts) {
        rows.push([
          L.catLabel(c.cat),
          c.blocks,
          c.records,
          c.blocks > 0 ? Number((c.records / c.blocks).toFixed(3)) : "",
          catRecordTotal > 0 ? Number(((c.records / catRecordTotal) * 100).toFixed(3)) : "",
        ]);
      }
      sheets.push({ name: L.detail.sheet.catQuality, rows });
    }

    if (fileRows.length > 0) {
      const rows: Cell[][] = [L.detail.fileStructHeader(tz)];
      for (const f of fileRows) {
        const rpf = recPerFrame(f);
        rows.push([
          f.filename,
          f.bytes,
          f.frames,
          f.records,
          rpf != null ? Number(rpf.toFixed(3)) : "",
          f.time_min != null ? formatTime(f.time_min, tz) : "",
          f.time_max != null ? formatTime(f.time_max, tz) : "",
        ]);
      }
      sheets.push({ name: L.detail.sheet.fileStruct, rows });
    }
    return sheets;
  };

  return (
    <div className="space-y-3">
      <TopicExcelExport
        topic="quality"
        build={buildSheets}
        title="카테고리별 블록·레코드와 파일별 구조를 Excel(.xlsx)로 내보냅니다 — 언어 선택"
      />

      {/* 품질 지표 카드 — SIM 카드만 퀵필터(포함/제외) 진입점 */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {cards.map((c) =>
          c.key === "sim" ? (
            // "SIM 제외" 버튼은 StatCard(버튼) 바깥 형제로 둔다 — 버튼 중첩은 잘못된 DOM
            <div key={c.key} className="relative">
              <StatCard
                label={c.label}
                value={c.value}
                sub={c.sub}
                onClick={() => onQuickFilter({ sim: true })}
                title={`${c.title} — 클릭하면 SIM 표적만으로 전수 재집계`}
              />
              <button
                type="button"
                onClick={() => onQuickFilter({ sim: false })}
                title="SIM 표적을 제외한 레코드만으로 전수 재집계"
                className="absolute right-1.5 top-1.5 rounded border border-gray-200 bg-white px-1 py-0.5 text-[9px] font-medium text-gray-500 transition-colors hover:border-[#a60739]/40 hover:bg-[#a60739]/5 hover:text-[#a60739]"
              >
                SIM 제외
              </button>
            </div>
          ) : (
            <StatCard key={c.key} label={c.label} value={c.value} sub={c.sub} title={c.title} />
          ),
        )}
      </div>

      {/* 지표 성격 안내 — 구조 지표와 레코드 플래그 지표의 분모가 다르다 */}
      <div className="rounded-lg border border-gray-200 bg-[#f8f9fa] px-3 py-2 text-[10.5px] leading-relaxed text-gray-500">
        <span className="font-medium text-gray-600">스킵 바이트 · 파싱 오류</span> 는 파일 구조를 훑어 얻는 지표라 필터와
        무관한 전체값입니다. <span className="font-medium text-gray-600">절단 레코드 · Mode-3/A 무효 · 고도 V/G · SIM</span>{" "}
        은 레코드 플래그 지표로, 현재 필터를 통과한 {rec.toLocaleString()}건(전체 {unfiltered_records.toLocaleString()}건)
        만 집계됩니다.
      </div>

      {/* 카테고리별 블록/레코드 */}
      <Section
        title="카테고리별 블록·레코드"
        right={<span className="text-[10px] text-gray-400">블록=구조(필터 무관) · 레코드=필터 적용</span>}
      >
        {stats.cat_counts.length === 0 ? (
          <div className="text-[11px] text-gray-400">없음</div>
        ) : (
          <div className="overflow-auto rounded border border-gray-100">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="sticky top-0 bg-gray-50 text-gray-500">
                  <th className="px-2 py-1 text-left font-medium">카테고리</th>
                  <th className="px-2 py-1 text-right font-medium">블록(구조)</th>
                  <th className="px-2 py-1 text-right font-medium">레코드(필터)</th>
                  <th className="px-2 py-1 text-right font-medium">블록당 레코드</th>
                  <th className="px-2 py-1 text-right font-medium">레코드 비중</th>
                </tr>
              </thead>
              <tbody>
                {stats.cat_counts.map((c) => (
                  <tr key={c.cat} className="border-t border-gray-100">
                    <td className="px-2 py-1 text-gray-700">{CAT_LABEL[c.cat] ?? `CAT${catShort(c.cat)}`}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">{c.blocks.toLocaleString()}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">{c.records.toLocaleString()}</td>
                    <td
                      className="px-2 py-1 text-right tabular-nums text-gray-600"
                      title="블록 1개에 담긴 평균 레코드 수 — 필터 적용분이라 필터가 걸리면 낮아진다"
                    >
                      {c.blocks > 0 ? (c.records / c.blocks).toFixed(2) : "—"}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-500">
                      {pctStr(c.records, catRecordTotal)}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-gray-200 bg-gray-50/60">
                  <td className="px-2 py-1 font-medium text-gray-600">합계</td>
                  <td className="px-2 py-1 text-right font-medium tabular-nums text-gray-700">
                    {catBlockTotal.toLocaleString()}
                  </td>
                  <td className="px-2 py-1 text-right font-medium tabular-nums text-gray-700">
                    {catRecordTotal.toLocaleString()}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-gray-500">
                    {catBlockTotal > 0 ? (catRecordTotal / catBlockTotal).toFixed(2) : "—"}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-gray-400">100%</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* 파일별 구조 */}
      <Section
        title={`파일별 구조 (${stats.files.length.toLocaleString()}개)`}
        right={
          <span className="text-[10px] text-gray-400">
            레코드 0 또는 시각 범위 없음 = 필터 전량 배제이거나 해석 실패 신호
          </span>
        }
      >
        {stats.files.length === 0 ? (
          <div className="text-[11px] text-gray-400">파일 없음</div>
        ) : (
          <div className="max-h-[28rem] overflow-auto rounded border border-gray-100">
            <table className="w-full text-[11px]">
              <thead>
                <tr>
                  <Th label="파일" k="name" sort={sort} setSort={setSort} />
                  <Th label="용량" k="bytes" align="right" sort={sort} setSort={setSort} />
                  <Th label="프레임" k="frames" align="right" sort={sort} setSort={setSort} />
                  <Th label="레코드(필터)" k="records" align="right" sort={sort} setSort={setSort} />
                  <Th
                    label="프레임당 레코드"
                    k="rpf"
                    align="right"
                    sort={sort}
                    setSort={setSort}
                    title="레코드(필터) ÷ 프레임 — 필터가 걸리면 낮아진다. 파일 간 편차가 크면 수집 이상 신호"
                  />
                  <th className="sticky top-0 z-10 whitespace-nowrap bg-gray-50 px-2 py-1.5 text-left font-medium text-gray-600">
                    시각 범위 ({tz})
                  </th>
                </tr>
              </thead>
              <tbody>
                {fileRows.map((f, i) => {
                  const empty = f.records === 0;
                  const rpf = recPerFrame(f);
                  return (
                    <tr key={`${f.filename}:${i}`} className={`border-t border-gray-100${empty ? " bg-amber-50/40" : ""}`}>
                      <td className="px-2 py-1 text-gray-700" title={empty ? "필터 통과 레코드 없음" : undefined}>
                        {f.filename}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-gray-600">{fmtBytes(f.bytes)}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-gray-600">{f.frames.toLocaleString()}</td>
                      <td className={`px-2 py-1 text-right tabular-nums ${empty ? "text-amber-700" : "text-gray-600"}`}>
                        {f.records.toLocaleString()}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-gray-600">
                        {rpf != null ? rpf.toFixed(2) : "—"}
                      </td>
                      <td className="px-2 py-1 text-left font-mono text-gray-600">
                        {f.time_min != null && f.time_max != null
                          ? `${formatTime(f.time_min, tz)} ~ ${formatTime(f.time_max, tz)}`
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
