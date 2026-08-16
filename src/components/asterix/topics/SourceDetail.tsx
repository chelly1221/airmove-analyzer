/**
 * 토픽: 출처·메시지·회전주기 상세.
 *
 * 데이터 출처(SAC/SIC)를 축으로 카테고리 구성·메시지 유형·CAT048 데이터 항목 출현·
 * CAT034 안테나 회전주기를 한 화면에서 본다.
 *
 * 분모 규칙(대시보드와 동일):
 * - 레이더 탐지 유형(I048/020)·CAT048 FRN 출현 → 전체 레코드 수(stats.record_count)
 * - CAT034/008 메시지 유형 → 각 카테고리 메시지 합계
 * - 출처 점유율 → 출처별 레코드 합계(SAC/SIC 미보유 레코드 제외분과 구분)
 *
 * 전수 렌더 — 다운샘플링 없이 스크롤 컨테이너로 처리.
 */

import { useMemo, useState } from "react";
import { LabeledBars, Section, StatCard } from "../shared";
import {
  compareSortVal,
  FilterChipButton,
  pctText,
  SortTh,
  TopicExcelExport,
  type ExportSheet,
  type SortDir,
  type SortState,
} from "../detailUi";
import { exportStrings, type ExportLang } from "../../../utils/exportI18n";
import type { Cell } from "../../../utils/xlsxExport";
import { formatTime } from "../format";
import { CAT_LABEL } from "../../common/FrameInspector";
import type { AsterixDetailFilter, AsterixDetailStats, SourceBreakdownRow, TzMode } from "../../../types/asterixDetail";

/** 메시지 유형(CAT034/008) 계열 색 — 대시보드 "서비스/기상 메시지 유형" 카드와 동일 */
const MSG_INK = "#7c3aed";
/** CAT048 데이터 항목 출현 색 — 대시보드와 동일 */
const FRN_INK = "#1e6fa6";

// ─── 출처별 분해 표 정렬 ───────────────────────────────────────────

type SortKey = "src" | "records" | "cat048" | "cat034" | "cat008" | "modes" | "time";

/** 컬럼을 처음 눌렀을 때의 방향 — 수치는 큰 값 우선, 식별자/시각은 오름차순 */
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  src: "asc",
  records: "desc",
  cat048: "desc",
  cat034: "desc",
  cat008: "desc",
  modes: "desc",
  time: "asc",
};

/** 정렬 키 → 비교값 (결측은 null → 방향과 무관하게 항상 뒤로) */
function sortVal(r: SourceBreakdownRow, k: SortKey): number | string | null {
  switch (k) {
    case "src":
      // SAC/SIC 는 수치 정렬이 자연스러워 하나의 정수로 합친다
      return r.sac * 256 + r.sic;
    case "records":
      return r.records;
    case "cat048":
      return r.cat048;
    case "cat034":
      return r.cat034;
    case "cat008":
      return r.cat008;
    case "modes":
      return r.modes_distinct;
    case "time":
      return r.time_min;
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

export default function SourceDetail({
  detail,
  tz,
  onQuickFilter,
}: {
  detail: AsterixDetailStats;
  tz: TzMode;
  onQuickFilter: (p: Partial<AsterixDetailFilter>) => void;
}) {
  const { source_breakdown, stats } = detail;
  const [sort, setSort] = useState<SortState<SortKey>>({ key: "records", dir: "desc" });

  /** 카테고리별 레코드/블록 조회 (0x30 CAT048 · 0x22 CAT034 · 0x08 CAT008) */
  const catOf = useMemo(() => new Map(stats.cat_counts.map((c) => [c.cat, c])), [stats.cat_counts]);
  const catRecords = (cat: number) => catOf.get(cat)?.records ?? 0;
  const catBlocks = (cat: number) => catOf.get(cat)?.blocks ?? 0;

  /** 출처 점유율 분모 — 표에 실린 행들의 레코드 합계 */
  const srcTotal = useMemo(() => source_breakdown.reduce((a, b) => a + b.records, 0), [source_breakdown]);
  /** 히스토그램 분모 — 대시보드와 동일하게 전체 레코드 수 */
  const recTotal = stats.record_count || 1;
  const msg034Total = useMemo(() => stats.msg_type_034.reduce((a, b) => a + b.count, 0) || 1, [stats.msg_type_034]);
  const msg008Total = useMemo(() => stats.msg_type_008.reduce((a, b) => a + b.count, 0) || 1, [stats.msg_type_008]);

  /** 출처 수 — 상세 분해가 비면 대시보드 SAC/SIC 집계로 폴백 */
  const sourceCount = source_breakdown.length || stats.sac_sic_counts.length;

  // 정렬 — 원본(records 내림차순) 훼손 금지라 항상 복사본을 정렬
  const srcRows = useMemo(() => {
    const arr = source_breakdown.slice();
    arr.sort((a, b) => {
      // 결측(null)은 방향과 무관하게 항상 뒤로 — compareSortVal 공통 규칙
      const c = compareSortVal(sortVal(a, sort.key), sortVal(b, sort.key), sort.dir);
      return c !== 0 ? c : b.records - a.records || a.sac - b.sac || a.sic - b.sic;
    });
    return arr;
  }, [source_breakdown, sort]);

  /** Excel — 출처별 분해 · 회전주기 · 메시지 유형(034/008) */
  const buildSheets = (lang: ExportLang): ExportSheet[] => {
    const L = exportStrings(lang);
    const sheets: ExportSheet[] = [];

    if (srcRows.length > 0) {
      const rows: Cell[][] = [L.detail.sourceHeader(tz)];
      for (const s of srcRows) {
        rows.push([
          s.sac,
          s.sic,
          s.records,
          srcTotal > 0 ? Number(((s.records / srcTotal) * 100).toFixed(3)) : "",
          s.cat048,
          s.cat034,
          s.cat008,
          s.modes_distinct,
          s.time_min != null ? formatTime(s.time_min, tz) : "",
          s.time_max != null ? formatTime(s.time_max, tz) : "",
        ]);
      }
      sheets.push({ name: L.detail.sheet.sourceBreakdown, rows });
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

    if (stats.msg_type_034.length > 0 || stats.msg_type_008.length > 0) {
      const rows: Cell[][] = [L.msgHeader];
      for (const m of stats.msg_type_034) rows.push(["CAT034", L.msg034(m.key, m.label), m.count]);
      for (const m of stats.msg_type_008) rows.push(["CAT008", L.msg008(m.key, m.label), m.count]);
      sheets.push({ name: L.sheet.msgType, rows });
    }
    return sheets;
  };

  return (
    <div className="space-y-3">
      <TopicExcelExport
        topic="source"
        build={buildSheets}
        title="출처별 분해·회전주기·메시지 유형을 Excel(.xlsx)로 내보냅니다 — 언어 선택"
      />
      {/* 요약 */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="출처(SAC/SIC)"
          value={`${sourceCount.toLocaleString()}곳`}
          sub={
            source_breakdown.length > 0
              ? source_breakdown
                  .slice(0, 3)
                  .map((s) => `${s.sac}/${s.sic}`)
                  .join(" · ")
              : "없음"
          }
          title="I010 데이터 출처 식별자 — SAC(시스템 지역 코드)/SIC(시스템 식별 코드) 조합 수"
        />
        <StatCard
          label="블록"
          value={stats.block_count.toLocaleString()}
          sub="구조적 집계(필터 무관)"
          title="ASTERIX 데이터 블록 수 — 필터와 무관한 구조적 수치"
        />
        <StatCard
          label="레코드"
          value={stats.record_count.toLocaleString()}
          sub={`전체 ${detail.unfiltered_records.toLocaleString()} 중`}
          title="필터 적용 후 레코드 수 / 필터 전 전체 레코드 수"
        />
        <StatCard
          label="CAT048"
          value={catRecords(0x30).toLocaleString()}
          sub={`블록 ${catBlocks(0x30).toLocaleString()}`}
          title={CAT_LABEL[0x30]}
        />
        <StatCard
          label="CAT034"
          value={catRecords(0x22).toLocaleString()}
          sub={`블록 ${catBlocks(0x22).toLocaleString()}`}
          title={CAT_LABEL[0x22]}
        />
        <StatCard
          label="CAT008"
          value={catRecords(0x08).toLocaleString()}
          sub={`블록 ${catBlocks(0x08).toLocaleString()}`}
          title={CAT_LABEL[0x08]}
        />
      </div>

      {/* 출처별 분해 — 전수 스크롤 */}
      <Section
        title={`출처별 분해 (SAC/SIC · ${source_breakdown.length.toLocaleString()}곳)`}
        right={<span className="text-[10px] text-gray-400">레코드 {srcTotal.toLocaleString()}건 기준</span>}
      >
        {source_breakdown.length === 0 ? (
          <div className="text-[11px] text-gray-400">없음</div>
        ) : (
          <div className="max-h-96 overflow-auto rounded border border-gray-100">
            <table className="w-full text-[11px]">
              <thead>
                <tr>
                  {/* 선두 액션 열 — 정렬 대상이 아니라 SortTh 대신 평범한 th */}
                  <th
                    className="sticky top-0 z-10 w-8 whitespace-nowrap bg-gray-50 px-2 py-1.5 text-left font-medium text-gray-600"
                    title="이 출처(SAC/SIC)만으로 전수 재집계"
                  >
                    필터
                  </th>
                  <Th label="SAC/SIC" k="src" sort={sort} setSort={setSort} title="I010 데이터 출처 식별자" />
                  <Th label="레코드" k="records" align="right" sort={sort} setSort={setSort} />
                  {/* 점유율은 레코드 수와 순서가 같아 별도 정렬 키를 두지 않는다 */}
                  <th
                    className="sticky top-0 z-10 whitespace-nowrap bg-gray-50 px-2 py-1.5 text-right font-medium text-gray-600"
                    title="출처별 레코드 합계 대비 비중 (레코드 수와 정렬 순서 동일)"
                  >
                    점유율
                  </th>
                  <Th label="CAT048" k="cat048" align="right" sort={sort} setSort={setSort} title={CAT_LABEL[0x30]} />
                  <Th label="CAT034" k="cat034" align="right" sort={sort} setSort={setSort} title={CAT_LABEL[0x22]} />
                  <Th label="CAT008" k="cat008" align="right" sort={sort} setSort={setSort} title={CAT_LABEL[0x08]} />
                  <Th
                    label="고유 Mode-S"
                    k="modes"
                    align="right"
                    sort={sort}
                    setSort={setSort}
                    title="이 출처가 보고한 고유 Mode-S 주소 수"
                  />
                  <Th
                    label={`관측 기간 (${tz})`}
                    k="time"
                    sort={sort}
                    setSort={setSort}
                    title="정렬 기준은 관측 시작 시각"
                  />
                </tr>
              </thead>
              <tbody>
                {srcRows.map((s) => (
                  <tr key={`${s.sac}/${s.sic}`} className="border-t border-gray-100 hover:bg-[#a60739]/5">
                    <td className="px-2 py-1">
                      <FilterChipButton
                        title={`SAC ${s.sac} · SIC ${s.sic} 출처 레코드만으로 전수 재집계 (상단 필터바 출처 선택에 반영)`}
                        onClick={() => onQuickFilter({ sac: s.sac, sic: s.sic })}
                      />
                    </td>
                    <td className="px-2 py-1 tabular-nums text-gray-700">
                      SAC {s.sac} · SIC {s.sic}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-700">{s.records.toLocaleString()}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">{pctText(s.records, srcTotal)}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">{s.cat048.toLocaleString()}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">{s.cat034.toLocaleString()}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">{s.cat008.toLocaleString()}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">
                      {s.modes_distinct.toLocaleString()}
                    </td>
                    <td className="px-2 py-1 font-mono text-gray-600">
                      {s.time_min != null && s.time_max != null
                        ? `${formatTime(s.time_min, tz)} ~ ${formatTime(s.time_max, tz)}`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* 2열 — 탐지 유형 ↔ 메시지 유형 (같은 행이라 동일 size 티어로 높이 정렬) */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Section title="레이더 탐지 유형 (I048/020 TYP)" size="lg">
          <LabeledBars items={stats.radar_typ_counts} total={recTotal} />
        </Section>

        <Section title="서비스/기상 메시지 유형 (CAT034 · CAT008)" size="lg">
          <div className="space-y-2">
            <div>
              <div className="mb-0.5 text-[10px] uppercase tracking-wider text-gray-400">CAT034</div>
              <LabeledBars items={stats.msg_type_034} total={msg034Total} color={MSG_INK} />
            </div>
            <div>
              <div className="mb-0.5 text-[10px] uppercase tracking-wider text-gray-400">CAT008</div>
              <LabeledBars items={stats.msg_type_008} total={msg008Total} color={MSG_INK} />
            </div>
          </div>
        </Section>
      </div>

      {/* CAT048 데이터 항목 출현 (FRN) */}
      <Section
        title="CAT048 데이터 항목 출현 (전체 레코드 대비)"
        right={<span className="text-[10px] text-gray-400">레코드 {stats.record_count.toLocaleString()}건 기준</span>}
      >
        <LabeledBars
          items={stats.cat048_frn_counts.map((f) => ({ key: f.id, label: `${f.id}  ${f.name}`, count: f.count }))}
          total={recTotal}
          color={FRN_INK}
        />
      </Section>

      {/* 안테나 회전주기 (CAT034 North marker 간격) */}
      <Section title="안테나 회전주기 (CAT034)">
        {stats.rotation_stats.length === 0 ? (
          <div className="text-[11px] text-gray-400">없음</div>
        ) : (
          <div className="overflow-auto rounded border border-gray-100">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="sticky top-0 bg-gray-50 text-gray-500">
                  <th className="px-2 py-1 text-left font-medium">SAC/SIC</th>
                  <th
                    className="px-2 py-1 text-right font-medium"
                    title="I034/000 유형 1(North marker) 메시지 수 — 회전수 산출의 원자료"
                  >
                    North
                  </th>
                  <th className="px-2 py-1 text-right font-medium" title="North marker 간격으로 산출된 유효 회전 수">
                    회전수
                  </th>
                  <th className="px-2 py-1 text-right font-medium">평균(s)</th>
                  <th className="px-2 py-1 text-right font-medium">σ(s)</th>
                  <th className="px-2 py-1 text-right font-medium">최소–최대(s)</th>
                  <th className="px-2 py-1 text-right font-medium" title="I034/041 안테나 회전주기 보고값 평균">
                    보고주기(s)
                  </th>
                  <th
                    className="px-2 py-1 text-right font-medium"
                    title="I034/000 유형 2(섹터 통과) 메시지 수 — 섹터/회전 최빈값의 원자료"
                  >
                    섹터 메시지
                  </th>
                  <th className="px-2 py-1 text-right font-medium" title="1회전당 섹터 수 최빈값 · 누락 = Σ(최빈 섹터수 − 실제 섹터수)">
                    섹터/회전
                  </th>
                </tr>
              </thead>
              <tbody>
                {stats.rotation_stats.map((r) => (
                  <tr key={`${r.sac}/${r.sic}`} className="border-t border-gray-100">
                    <td className="px-2 py-1 tabular-nums text-gray-700">
                      SAC {r.sac} · SIC {r.sic}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">
                      {r.north_count.toLocaleString()}
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
                      {r.interval_count > 0 ? `${r.period_min_s.toFixed(2)}–${r.period_max_s.toFixed(2)}` : "—"}
                    </td>
                    <td
                      className="px-2 py-1 text-right tabular-nums text-gray-600"
                      title="I034/041 안테나 회전주기 보고값 평균"
                    >
                      {r.reported_period_s != null ? r.reported_period_s.toFixed(2) : "—"}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">
                      {r.sector_msgs.toLocaleString()}
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
        {/* 기간 필터 하 CAT034/008 시각 판정 — abs_time 이 없는 레코드는 프레임 대리 시각을 쓴다 */}
        <div className="mt-1 text-[10px] text-gray-400">
          CAT034·CAT008 레코드는 자체 시각이 없어 기간 필터에서 같은 프레임의 첫 CAT048 시각을 대리로 판정합니다(대리
          시각도 없으면 제외) — 기간을 좁히면 회전주기·메시지 유형 집계가 프레임 경계에 따라 달라질 수 있습니다.
        </div>
      </Section>
    </div>
  );
}
