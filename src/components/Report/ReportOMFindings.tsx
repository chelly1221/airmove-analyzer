import React, { useMemo } from "react";
import EditableText from "./EditableText";
import OMEditable from "./OMEditable";
import type { RadarMonthlyResult, ManualBuilding, BuildingGroup, RadarSite } from "../../types";
import type { AddedBlockageResult } from "../../types/obstacle";
import {
  weightedLossAvg, weightedLossStdDev,
  weightedPsrAvg, weightedPsrStdDev,
  weightedBaselineLossAvg, weightedBaselineLossStdDev,
  gradeWithConfidence,
  BLOCKAGE_MIN_EXPOSURE_POINTS,
  BLOCKAGE_WATCH_PCT, BLOCKAGE_CAUTION_PCT, BLOCKAGE_ALERT_PCT, BLOCKAGE_SEVERE_PCT,
  BLOCKAGE_NONE_LABEL,
} from "../../utils/omStats";
import { haversineKm } from "../../utils/geo";
import ReportOMSectionHeader from "./ReportOMSectionHeader";
import AutoPaginate from "./AutoPaginate";
import BuildingGroupBadge from "./BuildingGroupBadge";

interface Props {
  sectionNum: number;
  radarResults: RadarMonthlyResult[];
  selectedBuildings: ManualBuilding[];
  /** 건물 그룹 메타 (인라인 배지 표시용) */
  buildingGroups: BuildingGroup[];
  radarSites: RadarSite[];
  /** 편집 가능 소견 텍스트 */
  findingsText: string;
  onFindingsChange: (text: string) => void;
  editable: boolean;
  /** 분석 대상 월 (YYYY-MM) */
  analysisMonth?: string;
  /** 건물별 추가 차단영역 소실율 (key: `${radarName}_${buildingId}`) — 헤드라인 심각도 */
  addedBlockageByKey?: Record<string, AddedBlockageResult>;
}

/**
 * 종합 소견 페이지 (페이지 7).
 *
 * 레이더별 판정 카드 그리드 → 분석 대상 장애물 스트립 → 분석 소견 텍스트 →
 * 산식 근거 2×2 그리드 순서. 스타일은 reportOmStyles.css 의 `.summary-cards`,
 * `.sumcard`, `.bldg-strip`, `.findings-text`, `.formula-grid`, `.pill` 등.
 */
function ReportOMFindings({
  sectionNum,
  radarResults,
  selectedBuildings,
  buildingGroups,
  radarSites,
  findingsText,
  onFindingsChange,
  editable,
  analysisMonth,
  addedBlockageByKey,
}: Props) {
  const monthLabel = analysisMonth
    ? `${analysisMonth.slice(0, 4)}년 ${parseInt(analysisMonth.slice(5, 7))}월`
    : "";

  // 레이더별 요약 계산
  const radarSummaries = useMemo(() => radarResults.map((rr) => {
    const stats = rr.daily_stats;
    const avgLoss = weightedLossAvg(stats);
    const lossSigma = weightedLossStdDev(stats);
    const avgPsr = weightedPsrAvg(stats);
    const psrSigma = weightedPsrStdDev(stats);
    const avgBaseline = weightedBaselineLossAvg(stats);
    const baselineSigma = weightedBaselineLossStdDev(stats);
    const deviation = avgLoss - avgBaseline;
    // 소실표적 건수 — loss_points_summary 는 gap 당 보간점 여러 개(60초 gap → 11점)라
    //   점 개수로 세면 수 배 과대. distinct event_id(gap 고유 번호, 레이더 결과 내 유일)로 집계
    //   (omFindingsGenerator 의 '소실 이벤트 N건'과 동일 산식 — 같은 보고서 내 수치 일치).
    const eventIds = new Set<number>();
    for (const d of stats) {
      for (const lp of d.loss_points_summary) eventIds.add(lp.event_id);
    }
    const totalLoss = eventIds.size;
    const grade = gradeWithConfidence(avgLoss, stats.length);

    return {
      radarName: rr.radar_name,
      avgLoss, lossSigma,
      avgPsr, psrSigma,
      avgBaseline, baselineSigma,
      deviation,
      totalLoss,
      grade,
      dayCount: stats.length,
    };
  }), [radarResults]);

  // 건물별 거리 텍스트 사전 계산 (분석 대상 장애물 스트립)
  const buildingDistTexts = useMemo(() =>
    selectedBuildings.map((b) => ({
      id: b.id,
      name: b.name || `건물${b.id}`,
      groupId: b.group_id,
      height: b.height,
      dists: radarSites.map((rs) => {
        const km = haversineKm(rs.latitude, rs.longitude, b.latitude, b.longitude);
        return `${rs.name} ${km.toFixed(1)}km`;
      }),
    })),
  [selectedBuildings, radarSites]);

  const sectionHeader = (
    <ReportOMSectionHeader
      sectionNum={sectionNum}
      title="종합 소견"
      editId="findings.title"
    />
  );

  // 1) 레이더별 판정 카드 — N 개를 최대 3 열로 분배
  const summaryCardsBlock = (
    <div
      className="summary-cards"
      style={{ gridTemplateColumns: `repeat(${Math.min(radarSummaries.length, 3)}, 1fr)` }}
    >
      {radarSummaries.map((rs) => (
        <div key={rs.radarName} className="sumcard">
          <div className="sumcard-head">
            <span className="strong">{rs.radarName}</span>
            <span className="badge" style={{ background: rs.grade.bg, color: rs.grade.color }}>
              {rs.grade.label}
            </span>
          </div>
          <table className="sumcard-table">
            <tbody>
              <tr>
                <OMEditable id="findings.card.period" value="분석 기간" tag="td" className="muted" />
                <td className="mono ta-r">{monthLabel ? `${monthLabel} · ` : ""}{rs.dayCount}일</td>
              </tr>
              <tr>
                <OMEditable id="findings.card.avgLoss" value="평균 표적소실율" tag="td" className="muted" />
                <td className="mono strong ta-r" style={{ color: rs.avgLoss >= 2 ? "#dc2626" : "#374151" }}>
                  {rs.avgLoss.toFixed(2)}% <span className="muted norm">±{rs.lossSigma.toFixed(2)}</span>
                </td>
              </tr>
              {/* 기준선·편차(방위 비교) — 교란요인 많아 '참고' 보조 지표로 강등(색상 구동 제거) */}
              <tr>
                <OMEditable id="findings.card.baseLoss" value="기준선(전방위·참고)" tag="td" className="muted" />
                <td className="mono ta-r muted">
                  {rs.avgBaseline.toFixed(2)}% <span className="muted">±{rs.baselineSigma.toFixed(2)}</span>
                </td>
              </tr>
              <tr>
                <OMEditable id="findings.card.dev" value="편차(참고)" tag="td" className="muted" />
                <td className="mono ta-r muted">
                  {rs.deviation > 0 ? "+" : ""}{rs.deviation.toFixed(2)}%p
                </td>
              </tr>
              <tr>
                <OMEditable id="findings.card.avgPsr" value="평균 PSR율" tag="td" className="muted" />
                <td className="mono ta-r">
                  {(rs.avgPsr * 100).toFixed(1)}% <span className="muted">±{(rs.psrSigma * 100).toFixed(1)}</span>
                </td>
              </tr>
              <tr>
                <OMEditable id="findings.card.lossCount" value="소실표적 건수" tag="td" className="muted" />
                <td className="mono ta-r">{rs.totalLoss}건</td>
              </tr>
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );

  // 2) 분석 대상 장애물 스트립
  const buildingsBlock = (
    <div className="bldg-strip">
      <OMEditable id="findings.bldgHeader" value="분석 대상 장애물" tag="div" className="block-h3" style={{ margin: 0, marginBottom: 6 }} />
      <div className="bldg-strip-list">
        {buildingDistTexts.map((bt) => (
          <span key={bt.id}>
            <BuildingGroupBadge groupId={bt.groupId} groups={buildingGroups} placement="before" />
            <span className="strong">{bt.name}</span>
            {" "}({bt.height}m) — {bt.dists.join(", ")}
          </span>
        ))}
      </div>
    </div>
  );

  // 2.5) 건물별 추가 차단 구간 소실율 — 헤드라인 인과 지표 (파노라마 준비 후 표시)
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
                {graded ? `${Math.round(w.exposurePointCount).toLocaleString()}pt 중 소실 ${Math.round(w.lossPointCount).toLocaleString()}pt/${w.daysWithExposure}일` : "—"}
              </td>
            </tr>
          );
        }),
      ).filter(Boolean)
    : [];
  const blockageBlock = blockageRows.length > 0 ? (
    <div className="bldg-strip">
      <OMEditable id="findings.blockageHeader" value="추가 차단 구간 소실율 — 건물 인과 헤드라인" tag="div" className="block-h3" style={{ margin: 0, marginBottom: 6 }} />
      <table className="om-table">
        <thead>
          <tr>
            <th className="ta-l"><OMEditable id="findings.blockage.colBldg" value="건물" tag="span" /></th>
            <th className="ta-c"><OMEditable id="findings.blockage.colRadar" value="레이더" tag="span" /></th>
            <th className="ta-c"><OMEditable id="findings.blockage.colRate" value="추가 차단 구간 소실율" tag="span" /></th>
            <th className="ta-c"><OMEditable id="findings.blockage.colTrend" value="추세(일당)" tag="span" /></th>
            <th className="ta-c"><OMEditable id="findings.blockage.colExp" value="통과 항적" tag="span" /></th>
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

  // 4) 산식 근거 2×2 그리드 — 디자인 시안 그대로 Times italic 평문 사용
  const formulaBlock = (
    <div className="formula-grid">
      <OMEditable id="findings.formula.title" value="산식 근거" tag="p" className="formula-title" />
      <div className="formula-grid-inner">
        <div>
          <OMEditable id="findings.formula.h1" value="관측량 가중 평균" tag="p" className="formula-h" />
          <p className="formula-math"><i>x̄<sub>w</sub> = Σᵢ(wᵢ·xᵢ) / Σᵢ(wᵢ)</i></p>
          <p>Loss: <i>w</i> = 비행시간 · PSR: <i>w</i> = SSR 포인트수</p>
        </div>
        <div>
          <OMEditable id="findings.formula.h2" value="가중 모표준편차" tag="p" className="formula-h" />
          <p className="formula-math"><i>σ<sub>w</sub> = √( Σᵢ(wᵢ·(xᵢ - x̄<sub>w</sub>)²) / Σᵢ(wᵢ) )</i></p>
        </div>
        <div>
          <OMEditable id="findings.formula.h3" value="Loss 탐지" tag="p" className="formula-h" />
          <p>스캔 주기 자동 추정 (중앙값)</p>
          <p className="formula-math"><i>임계값 = 7초 (고정) · 상한 5분</i></p>
        </div>
        <div>
          <OMEditable id="findings.formula.h4" value="판정 기준" tag="p" className="formula-h" />
          <p>
            평균 소실율 — <span className="pill pill-ok">양호</span> &lt; 0.5% ·{" "}
            <span className="pill pill-warn">주의</span> 0.5~2% 미만 ·{" "}
            <span className="pill pill-bad">경고</span> ≥ 2% ·{" "}
            <span className="pill pill-hold">판정 불가</span> 관측 &lt; 7일
          </p>
          <p>
            추가 차단 구간 소실율 — <span className="pill pill-ok">양호</span> &lt; {BLOCKAGE_WATCH_PCT.toFixed(0)}% ·{" "}
            <span className="pill pill-watch">관심</span> {BLOCKAGE_WATCH_PCT.toFixed(0)}~{BLOCKAGE_CAUTION_PCT.toFixed(0)}% 미만 ·{" "}
            <span className="pill pill-warn">주의</span> {BLOCKAGE_CAUTION_PCT.toFixed(0)}~{BLOCKAGE_ALERT_PCT.toFixed(0)}% 미만 ·{" "}
            <span className="pill pill-alert">경계</span> {BLOCKAGE_ALERT_PCT.toFixed(0)}~{BLOCKAGE_SEVERE_PCT.toFixed(0)}% 미만 ·{" "}
            <span className="pill pill-bad">심각</span> ≥ {BLOCKAGE_SEVERE_PCT.toFixed(0)}% ·{" "}
            <span className="pill pill-hold">판정 불가</span> 통과 항적 ≤ {BLOCKAGE_MIN_EXPOSURE_POINTS.toLocaleString()}pt
          </p>
        </div>
      </div>
    </div>
  );

  return (
    <AutoPaginate firstHeader={sectionHeader}>
      {summaryCardsBlock}
      {blockageBlock}
      {buildingsBlock}
      {findingsBlock}
      {formulaBlock}
    </AutoPaginate>
  );
}

export default React.memo(ReportOMFindings);
