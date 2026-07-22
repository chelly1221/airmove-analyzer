import React from "react";
import EditableText from "./EditableText";
import OMEditable from "./OMEditable";
import type { ManualBuilding, BuildingGroup, RadarSite } from "../../types";
import type { AddedBlockageResult } from "../../types/obstacle";
import {
  BLOCKAGE_MIN_EXPOSURE_POINTS,
  BLOCKAGE_WATCH_PCT, BLOCKAGE_CAUTION_PCT, BLOCKAGE_ALERT_PCT, BLOCKAGE_SEVERE_PCT,
  BLOCKAGE_NONE_LABEL,
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

  // 1) 건물별 추가 차단 구간 소실율 — 헤드라인 인과 지표 (파노라마 준비 후 표시)
  const blockageRows = addedBlockageByKey
    ? selectedBuildings.flatMap((b) =>
        radarSites.map((rs) => {
          const w = addedBlockageByKey[`${rs.name}_${b.id}`];
          if (!w) return null;
          const graded = w.grade.label !== "항적 없음" && w.grade.label !== "판정 불가" && w.grade.label !== BLOCKAGE_NONE_LABEL;
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
  const blockageBlock = blockageRows.length > 0 ? (
    <div className="bldg-strip">
      <OMEditable id="findings.blockageHeader" value="추가 차단 구간 소실율 — 건물 인과 헤드라인" tag="div" className="block-h3" style={{ margin: 0, marginBottom: 6 }} />
      <table className="om-table sm-table">
        <thead>
          <tr>
            <th className="ta-l"><OMEditable id="findings.blockage.colBldg" value="건물" tag="span" /></th>
            <th className="ta-c"><OMEditable id="findings.blockage.colRadar" value="레이더" tag="span" /></th>
            <th className="ta-c"><OMEditable id="findings.blockage.colRate" value="추가 차단 구간 소실율" tag="span" /></th>
            <th className="ta-c"><OMEditable id="findings.blockage.colTrend" value="추세(일당)" tag="span" /></th>
            <th className="ta-c"><OMEditable id="findings.blockage.colExp" value="소실pt/통과pt" tag="span" /></th>
          </tr>
        </thead>
        <tbody>{blockageRows}</tbody>
      </table>
      <p className="muted" style={{ fontSize: "9px", marginTop: 4 }}>
        추가 차단 구간 소실율 = 분석 대상 장애물이 새로 가리는 양각 밴드(지형·기존지물 차단각~대상 차단각)를 지나는 항적이 그 안에서 소실되는 비율.
        {" "}판정 순서 — 분석 대상이 지형·기존지물 위로 새로 가리는 구간이 없으면 0.00%(추가 차단 없음), 차단영역 통과 항적이 없으면 "항적 없음", 통과 항적이 {BLOCKAGE_MIN_EXPOSURE_POINTS.toLocaleString()}pt 이하면 "판정 불가".
        {" "}등급(전구간 평균 소실율 기준과 별도) — 양호 &lt; {BLOCKAGE_WATCH_PCT.toFixed(0)}% · 관심 {BLOCKAGE_WATCH_PCT.toFixed(0)}~{BLOCKAGE_CAUTION_PCT.toFixed(0)}% 미만 · 주의 {BLOCKAGE_CAUTION_PCT.toFixed(0)}~{BLOCKAGE_ALERT_PCT.toFixed(0)}% 미만 · 경계 {BLOCKAGE_ALERT_PCT.toFixed(0)}~{BLOCKAGE_SEVERE_PCT.toFixed(0)}% 미만 · 심각 ≥ {BLOCKAGE_SEVERE_PCT.toFixed(0)}%.
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
