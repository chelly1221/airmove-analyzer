import React from "react";
import EditableText from "./EditableText";
import OMEditable from "./OMEditable";
import type { ManualBuilding, BuildingGroup, RadarSite } from "../../types";
import type { AddedBlockageResult, RefFallbackReason } from "../../types/obstacle";
import {
  BLOCKAGE_MIN_EXPOSURE_POINTS,
  BLOCKAGE_WATCH_PCT, BLOCKAGE_CAUTION_PCT, BLOCKAGE_ALERT_PCT, BLOCKAGE_SEVERE_PCT,
  BLOCKAGE_DELTA_WATCH_PP, BLOCKAGE_DELTA_CAUTION_PP, BLOCKAGE_DELTA_ALERT_PP, BLOCKAGE_DELTA_SEVERE_PP,
  BLOCKAGE_NONE_LABEL,
} from "../../utils/omStats";
import { REF_FALLBACK_LABELS } from "../../utils/omReference";
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
 * 종합 소견 페이지 (페이지 7).
 *
 * 추가 차단 구간 소실율 표 → 분석 소견 텍스트 순서.
 * 스타일은 reportOmStyles.css 의 `.bldg-strip`, `.findings-text` 등.
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

  // 1) 건물별 추가 차단 구간 소실율 — 헤드라인 인과 지표 (파노라마 준비 후 표시)
  // delta/absolute 판정 방식 혼재 여부 — 각주 분기용 (delta 각주·※ 절대 임계 각주 병기 판단)
  let hasDelta = false;    // 기준월 대비 Δ 판정된 정상 등급 행 존재
  let hasAbsolute = false; // 기준데이터 미적용(절대 임계) 정상 등급 행 존재
  // 절대 임계 폴백 사유별 건수 — 렌더 루프에서 그 자리 수집(새 O(N²) 순회 없음), 각주 병기용.
  const absFallbackCounts: Partial<Record<RefFallbackReason, number>> = {};
  const blockageRows = addedBlockageByKey
    ? selectedBuildings.flatMap((b) =>
        radarSites.map((rs) => {
          const w = addedBlockageByKey[`${rs.name}_${b.id}`];
          if (!w) return null;
          const graded = w.grade.label !== "항적 없음" && w.grade.label !== "판정 불가" && w.grade.label !== BLOCKAGE_NONE_LABEL;
          // delta 모드 정상 등급 행만 기준·Δ 컬럼에 값 표시 (게이트 라벨·기준 표본 부족 폴백은 "—")
          const isDelta = graded && w.gradingMode === "delta" && w.refLossRatePct !== undefined && w.deltaPp !== undefined;
          const isAbsGraded = graded && !isDelta; // 정상 등급인데 기준데이터 미적용(절대 임계 폴백)
          if (isDelta) hasDelta = true;
          if (isAbsGraded) {
            hasAbsolute = true;
            const reason = w.refFallback ?? "none";
            absFallbackCounts[reason] = (absFallbackCounts[reason] ?? 0) + 1;
          }
          return (
            <tr key={`${rs.name}-${b.id}`}>
              <td>
                <BuildingGroupBadge groupId={b.group_id} groups={buildingGroups} placement="before" />
                {b.name || `건물${b.id}`}
              </td>
              <td className="ta-c">{rs.name}</td>
              <td className="ta-c mono strong" style={{ color: w.grade.color }}>
                {/* 추가 차단 구간 미형성(BLOCKAGE_NONE_LABEL)은 라벨 대신 0.00%로 표시 — 비율 정의상 추가 소실 없음. */}
                {graded
                  ? `${w.lossRatePct.toFixed(2)}% · ${w.grade.label}`
                  : w.grade.label === BLOCKAGE_NONE_LABEL
                  ? `${w.lossRatePct.toFixed(2)}%`
                  : w.grade.label}
              </td>
              {/* 기준 소실율(%) — delta 모드 행만 값, 그 외 "—" */}
              <td className="ta-c mono">
                {isDelta ? `${w.refLossRatePct!.toFixed(2)}%` : "—"}
              </td>
              {/* Δ(%p) — delta 모드 행만 값(등급색), 절대 임계 정상 등급 행은 "— ※"(사유 title), 나머지 "—" */}
              <td
                className="ta-c mono"
                style={isDelta ? { color: w.grade.color } : undefined}
                title={isAbsGraded ? REF_FALLBACK_LABELS[w.refFallback ?? "none"] : undefined}
              >
                {isDelta ? `${signedPp(w.deltaPp!)}%p` : isAbsGraded ? "— ※" : "—"}
              </td>
              <td className="ta-c mono">
                {graded
                  ? (w.trendDir === "안정"
                    ? "안정"
                    : `${w.trendDir} ${w.trendSlopePctPerDay > 0 ? "+" : ""}${w.trendSlopePctPerDay.toFixed(3)}%p`)
                  : "—"}
              </td>
              <td className="ta-c mono">
                {graded ? `${Math.round(w.lossPointCount).toLocaleString()} / ${Math.round(w.exposurePointCount).toLocaleString()}pt` : "—"}
              </td>
            </tr>
          );
        }),
      ).filter(Boolean)
    : [];
  // 절대 임계 폴백 사유 병기 문구 — 고정 순서(라벨 정의 순)로 집계, 1종이면 건수 생략(사유만).
  const REASON_ORDER: RefFallbackReason[] = ["none", "mismatch", "load_failed", "ref_insufficient"];
  const absReasonEntries = REASON_ORDER
    .map((r) => [r, absFallbackCounts[r] ?? 0] as [RefFallbackReason, number])
    .filter(([, n]) => n > 0);
  const absFallbackText = absReasonEntries.length === 1
    ? REF_FALLBACK_LABELS[absReasonEntries[0][0]]
    : absReasonEntries.map(([r, n]) => `${REF_FALLBACK_LABELS[r]} ${n}건`).join(" · ");
  const blockageBlock = blockageRows.length > 0 ? (
    <div className="bldg-strip">
      <OMEditable id="findings.blockageHeader" value="추가 차단 구간 소실율 — 건물 인과 헤드라인" tag="div" className="block-h3" style={{ margin: 0, marginBottom: 6 }} />
      <table className="om-table sm-table">
        <thead>
          <tr>
            <th className="ta-l"><OMEditable id="findings.blockage.colBldg" value="건물" tag="span" /></th>
            <th className="ta-c"><OMEditable id="findings.blockage.colRadar" value="레이더" tag="span" /></th>
            <th className="ta-c"><OMEditable id="findings.blockage.colRate" value="추가 차단 구간 소실율" tag="span" /></th>
            <th className="ta-c"><OMEditable id="findings.blockage.colRefRate" value="기준 소실율" tag="span" /></th>
            <th className="ta-c"><OMEditable id="findings.blockage.colDelta" value="Δ(%p)" tag="span" /></th>
            <th className="ta-c"><OMEditable id="findings.blockage.colTrend" value="추세(일당)" tag="span" /></th>
            <th className="ta-c"><OMEditable id="findings.blockage.colExp" value="소실pt/통과pt" tag="span" /></th>
          </tr>
        </thead>
        <tbody>{blockageRows}</tbody>
      </table>
      <p className="muted" style={{ fontSize: "9px", marginTop: 4 }}>
        추가 차단 구간 소실율 = 분석 대상 장애물이 새로 가리는 양각 밴드(지형·기존지물 차단각~대상 차단각)를 지나는 항적이 그 안에서 소실되는 비율.
        {" "}판정 순서 — 분석 대상이 지형·기존지물 위로 새로 가리는 구간이 없으면 0.00%(추가 차단 없음), 차단영역 통과 항적이 없으면 "항적 없음", 통과 항적이 {BLOCKAGE_MIN_EXPOSURE_POINTS.toLocaleString()}pt 이하면 "판정 불가".
        {hasDelta && (
          <>
            {" "}판정 기준(기준월 대비 편차 Δ%p) — 양호 &lt; +{BLOCKAGE_DELTA_WATCH_PP.toFixed(0)}%p · 관심 +{BLOCKAGE_DELTA_WATCH_PP.toFixed(0)}~{BLOCKAGE_DELTA_CAUTION_PP.toFixed(0)}%p · 주의 +{BLOCKAGE_DELTA_CAUTION_PP.toFixed(0)}~{BLOCKAGE_DELTA_ALERT_PP.toFixed(0)}%p · 경계 +{BLOCKAGE_DELTA_ALERT_PP.toFixed(0)}~{BLOCKAGE_DELTA_SEVERE_PP.toFixed(0)}%p · 심각 ≥ +{BLOCKAGE_DELTA_SEVERE_PP.toFixed(0)}%p.
          </>
        )}
        {(hasAbsolute || !hasDelta) && (
          <>
            {" "}{hasAbsolute ? `※ 기준데이터 미적용 행(절대 임계 — ${absFallbackText}) — ` : "등급(전구간 평균 소실율 기준과 별도) — "}양호 &lt; {BLOCKAGE_WATCH_PCT.toFixed(0)}% · 관심 {BLOCKAGE_WATCH_PCT.toFixed(0)}~{BLOCKAGE_CAUTION_PCT.toFixed(0)}% 미만 · 주의 {BLOCKAGE_CAUTION_PCT.toFixed(0)}~{BLOCKAGE_ALERT_PCT.toFixed(0)}% 미만 · 경계 {BLOCKAGE_ALERT_PCT.toFixed(0)}~{BLOCKAGE_SEVERE_PCT.toFixed(0)}% 미만 · 심각 ≥ {BLOCKAGE_SEVERE_PCT.toFixed(0)}%.
          </>
        )}
      </p>
    </div>
  ) : null;

  // 2) 분석 소견 텍스트 (편집 가능 — 시안에는 없지만 운영 기능으로 유지)
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
      {blockageBlock}
      {findingsBlock}
    </AutoPaginate>
  );
}

export default React.memo(ReportOMFindings);
