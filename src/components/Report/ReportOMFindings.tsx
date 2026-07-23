import React from "react";
import EditableText from "./EditableText";
import OMEditable from "./OMEditable";
import type { ManualBuilding, BuildingGroup, RadarSite } from "../../types";
import type { AddedBlockageResult } from "../../types/obstacle";
import {
  BLOCKAGE_DELTA_WATCH_PP, BLOCKAGE_DELTA_CAUTION_PP, BLOCKAGE_DELTA_ALERT_PP, BLOCKAGE_DELTA_SEVERE_PP,
  BLOCKAGE_NONE_LABEL, BLOCKAGE_NO_REF_LABEL,
} from "../../utils/omStats";
import ReportOMSectionHeader from "./ReportOMSectionHeader";
import AutoPaginate from "./AutoPaginate";
import BuildingGroupBadge from "./BuildingGroupBadge";

interface Props {
  sectionNum: number;
  selectedBuildings: ManualBuilding[];
  /** 건물 그룹 메타 (인라인 배지 표시용) */
  buildingGroups: BuildingGroup[];
  radarSites: RadarSite[];
  /** 편집 가능 소견 텍스트 */
  findingsText: string;
  onFindingsChange: (text: string) => void;
  editable: boolean;
  /** 건물별 추가 차단영역 소실율 (key: `${radarName}_${buildingId}`) — 헤드라인 심각도 */
  addedBlockageByKey?: Record<string, AddedBlockageResult>;
}

/**
 * 등급 라벨 → 배지 색(글자/배경) 맵. 직렬화(gradingMode·grade.label)는 바뀌지 않으므로 레거시
 * 스냅샷도 안전하게 렌더된다 — 맵에 없는 라벨(레거시 회색 게이트 라벨 등)은 회색 기본으로 폴백.
 * 회색 3종(항적 없음·추가 차단 구간 없음·기준데이터 없음)은 동일 회색.
 */
const GRADE_BADGE: Record<string, { color: string; bg: string }> = {
  "양호": { color: "#15803d", bg: "#dcfce7" },
  "관심": { color: "#1d4ed8", bg: "#dbeafe" },
  "주의": { color: "#b45309", bg: "#fef3c7" },
  "경계": { color: "#c2410c", bg: "#ffedd5" },
  "심각": { color: "#b91c1c", bg: "#fee2e2" },
  "항적 없음": { color: "#6b7280", bg: "#f3f4f6" },
  [BLOCKAGE_NONE_LABEL]: { color: "#6b7280", bg: "#f3f4f6" },
  [BLOCKAGE_NO_REF_LABEL]: { color: "#6b7280", bg: "#f3f4f6" },
};
const GRADE_BADGE_FALLBACK = { color: "#6b7280", bg: "#f3f4f6" };

/** delta 판정된 '실제 등급' 라벨 — 이 라벨의 delta 행만 기준 소실율·Δ 컬럼에 값을 표시한다. */
const REAL_GRADES = new Set(["양호", "관심", "주의", "경계", "심각"]);

/** 페이지 분할용 청크당 최대 행수 — 초과 시 건물 경계에서 다음 bldg-strip 블록으로 넘긴다. */
const CHUNK_ROWS = 18;

/** 한 건물의 (레이더별) 행 */
interface BRow {
  radarName: string;
  w: AddedBlockageResult;
  /** delta 실제 등급 행 — 기준 소실율·Δ 컬럼 값 표시 대상 */
  isDelta: boolean;
  /** 추가 차단 구간 미형성 (BLOCKAGE_NONE_LABEL) */
  isNone: boolean;
  /** 통과 항적 없음 */
  isNoTrack: boolean;
}
/** 건물 단위 그룹 (rowSpan·줄무늬 단위) */
interface BGroup {
  building: ManualBuilding;
  rows: BRow[];
  /** 전체 통틀은 건물 인덱스 (줄무늬 alt 판정용) */
  gIdx: number;
}

/**
 * 종합 소견 페이지 (페이지 7).
 *
 * 추가 차단 구간 소실율 표 → 분석 소견 텍스트 순서.
 * 스타일은 reportOmStyles.css 의 `.bldg-strip`, `.om-grade-badge`, `.findings-text` 등.
 */
function ReportOMFindings({
  sectionNum,
  selectedBuildings,
  buildingGroups,
  radarSites,
  findingsText,
  onFindingsChange,
  editable,
  addedBlockageByKey,
}: Props) {
  const sectionHeader = (
    <ReportOMSectionHeader
      sectionNum={sectionNum}
      title="종합 소견"
      editId="findings.title"
    />
  );

  // Δ%p 부호 표기 — 양수 +, 음수는 − (U+2212)
  const signedPp = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`;

  // 1) 행 데이터 수집 — 건물 정의 순 × 레이더 순 유지(정렬 안 함). 렌더 사이드이펙트 없이 배열로 먼저 구성.
  const groups: BGroup[] = [];
  if (addedBlockageByKey) {
    for (const b of selectedBuildings) {
      const rows: BRow[] = [];
      for (const rs of radarSites) {
        const w = addedBlockageByKey[`${rs.name}_${b.id}`];
        if (!w) continue;
        const isDelta = w.gradingMode === "delta" && REAL_GRADES.has(w.grade.label)
          && w.refLossRatePct !== undefined && w.deltaPp !== undefined;
        rows.push({
          radarName: rs.name,
          w,
          isDelta,
          isNone: w.grade.label === BLOCKAGE_NONE_LABEL,
          isNoTrack: w.grade.label === "항적 없음",
        });
      }
      if (rows.length > 0) groups.push({ building: b, rows, gIdx: groups.length });
    }
  }

  // delta 행 존재 여부 + 기준월 라벨(레이더별) — 각주 판정 기준 줄 표시용.
  const hasDelta = groups.some((g) => g.rows.some((r) => r.isDelta));
  const refLabelByRadar = new Map<string, string>();
  for (const g of groups) for (const r of g.rows) {
    if (r.isDelta && r.w.refMonthLabel) refLabelByRadar.set(r.radarName, r.w.refMonthLabel);
  }
  const distinctRefLabels = new Set(refLabelByRadar.values());
  const refMonthText = distinctRefLabels.size <= 1
    ? `기준월 ${[...distinctRefLabels][0] ?? ""}`
    : [...refLabelByRadar.entries()].map(([rn, lb]) => `${rn} ${lb}`).join(" · ");

  // 판정 기준 색칩 범례(delta 임계) — 상수 보간. 칩은 등급 잉크색.
  const legendItems = [
    { color: "#15803d", text: `양호 <+${BLOCKAGE_DELTA_WATCH_PP.toFixed(0)}` },
    { color: "#1d4ed8", text: `관심 +${BLOCKAGE_DELTA_WATCH_PP.toFixed(0)}~${BLOCKAGE_DELTA_CAUTION_PP.toFixed(0)}` },
    { color: "#b45309", text: `주의 +${BLOCKAGE_DELTA_CAUTION_PP.toFixed(0)}~${BLOCKAGE_DELTA_ALERT_PP.toFixed(0)}` },
    { color: "#c2410c", text: `경계 +${BLOCKAGE_DELTA_ALERT_PP.toFixed(0)}~${BLOCKAGE_DELTA_SEVERE_PP.toFixed(0)}` },
    { color: "#b91c1c", text: `심각 ≥+${BLOCKAGE_DELTA_SEVERE_PP.toFixed(0)}` },
  ];

  // 2) 건물 경계에서 청크 분할 — 누적 행수가 CHUNK_ROWS 초과 시 새 블록. 건물은 쪼개지 않음(rowSpan 보존).
  const chunks: BGroup[][] = [];
  {
    let cur: BGroup[] = [];
    let curRows = 0;
    for (const g of groups) {
      if (cur.length > 0 && curRows + g.rows.length > CHUNK_ROWS) {
        chunks.push(cur);
        cur = [];
        curRows = 0;
      }
      cur.push(g);
      curRows += g.rows.length;
    }
    if (cur.length > 0) chunks.push(cur);
  }

  // 각 청크 = 독립 bldg-strip 블록(thead 반복) — AutoPaginate 자식이라 페이지 넘김이 자연 발생.
  const blockageBlocks = chunks.map((chunk, ci) => (
    <div className="bldg-strip" key={ci}>
      <OMEditable id="findings.blockageHeader" value="추가 차단 구간 소실율 — 건물 인과 헤드라인" tag="div" className="block-h3" style={{ margin: 0, marginBottom: 6 }} />
      {ci > 0 && <div className="cont-label">(계속)</div>}
      <table className="om-table sm-table">
        <thead>
          <tr>
            <th className="ta-l"><OMEditable id="findings.blockage.colBldg" value="건물" tag="span" /></th>
            <th className="ta-c"><OMEditable id="findings.blockage.colRadar" value="레이더" tag="span" /></th>
            <th className="ta-c"><OMEditable id="findings.blockage.colRate" value="추가 차단 구간 소실율" tag="span" /></th>
            <th className="ta-c"><OMEditable id="findings.blockage.colRefRate" value="기준 소실율" tag="span" /></th>
            <th className="ta-c"><OMEditable id="findings.blockage.colDelta" value="Δ(%p)" tag="span" /></th>
            <th className="ta-c"><OMEditable id="findings.blockage.colGrade" value="등급" tag="span" /></th>
            <th className="ta-c"><OMEditable id="findings.blockage.colTrend" value="추세(일당)" tag="span" /></th>
          </tr>
        </thead>
        <tbody>
          {chunk.map((g) =>
            g.rows.map((r, ri) => {
              const w = r.w;
              const badge = GRADE_BADGE[w.grade.label] ?? GRADE_BADGE_FALLBACK;
              const hasExposure = w.exposurePointCount > 0;
              return (
                <tr key={`${r.radarName}-${g.building.id}`} className={g.gIdx % 2 === 1 ? "alt" : ""}>
                  {/* 건물 셀 — 그룹 첫 행에만 rowSpan */}
                  {ri === 0 && (
                    <td rowSpan={g.rows.length}>
                      <BuildingGroupBadge groupId={g.building.group_id} groups={buildingGroups} placement="before" />
                      {g.building.name || `건물${g.building.id}`}
                    </td>
                  )}
                  <td className="ta-c">{r.radarName}</td>
                  {/* 소실율 — 값만 중립 잉크. 항적 없음 → "—", 미형성 → 0.00%(=lossRatePct) */}
                  <td className="ta-c mono">{r.isNoTrack ? "—" : `${w.lossRatePct.toFixed(2)}%`}</td>
                  {/* 기준 소실율 — delta 실제 등급 행만 */}
                  <td className="ta-c mono">{r.isDelta ? `${w.refLossRatePct!.toFixed(2)}%` : "—"}</td>
                  {/* Δ(%p) — delta 행만(등급색) */}
                  <td className="ta-c mono" style={r.isDelta ? { color: w.grade.color } : undefined}>
                    {r.isDelta ? `${signedPp(w.deltaPp!)}%p` : "—"}
                  </td>
                  {/* 등급 배지 — 라벨→스타일 맵(레거시 안전) */}
                  <td className="ta-c">
                    <span className="om-grade-badge" style={{ color: badge.color, background: badge.bg }}>{w.grade.label}</span>
                  </td>
                  {/* 추세 — 노출>0 이면 표시 */}
                  <td className="ta-c mono">
                    {hasExposure
                      ? (w.trendDir === "안정"
                        ? "안정"
                        : `${w.trendDir} ${w.trendSlopePctPerDay > 0 ? "+" : ""}${w.trendSlopePctPerDay.toFixed(3)}%p`)
                      : "—"}
                  </td>
                </tr>
              );
            }),
          )}
        </tbody>
      </table>
      {/* 각주는 마지막 청크에만 */}
      {ci === chunks.length - 1 && (
        <div className="om-blockage-notes">
          <p>
            추가 차단 구간 소실율 = 분석 대상 장애물이 새로 가리는 양각 밴드(지형·기존지물 차단각~대상 차단각)를 지나는 항적이 그 안에서 소실되는 비율.
          </p>
          <p>
            판정 순서 — 추가 차단 구간 미형성 시 0.00%(추가 차단 없음) · 통과 항적 없으면 "항적 없음" · 기준데이터 미적용 행은 등급 없이 "기준데이터 없음".
          </p>
          {hasDelta && (
            <p>
              판정 기준 — {refMonthText} 대비 Δ%p:
              {legendItems.map((it, i) => (
                <span key={i} className="om-legend-item">
                  <span className="om-legend-chip" style={{ background: it.color }} />{it.text}
                </span>
              ))}
            </p>
          )}
        </div>
      )}
    </div>
  ));

  // 3) 분석 소견 텍스트 (편집 가능 — 시안에는 없지만 운영 기능으로 유지)
  const findingsBlock = (
    <>
      <OMEditable id="findings.findingsHeader" value="분석 소견" tag="div" className="block-h3" />
      <EditableText
        value={findingsText}
        onChange={onFindingsChange}
        editable={editable}
        tag="div"
        className="findings-text"
      />
    </>
  );

  return (
    <AutoPaginate firstHeader={sectionHeader}>
      {blockageBlocks}
      {findingsBlock}
    </AutoPaginate>
  );
}

export default React.memo(ReportOMFindings);
