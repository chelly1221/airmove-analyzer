import React, { useMemo } from "react";
import EditableText from "./EditableText";
import type { RadarMonthlyResult, ManualBuilding, BuildingGroup, RadarSite } from "../../types";
import {
  weightedLossAvg, weightedLossStdDev,
  weightedPsrAvg, weightedPsrStdDev,
  weightedBaselineLossAvg, weightedBaselineLossStdDev,
  gradeWithConfidence,
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
    const totalLoss = stats.flatMap((d) => d.loss_points_summary).length;
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
      title={`종합 소견${monthLabel ? ` (${monthLabel})` : ""}`}
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
                <td className="muted">분석 기간</td>
                <td className="mono ta-r">{monthLabel ? `${monthLabel} · ` : ""}{rs.dayCount}일</td>
              </tr>
              <tr>
                <td className="muted">평균 표적소실율</td>
                <td className="mono strong ta-r" style={{ color: rs.avgLoss >= 2 ? "#dc2626" : "#374151" }}>
                  {rs.avgLoss.toFixed(2)}% <span className="muted norm">±{rs.lossSigma.toFixed(2)}</span>
                </td>
              </tr>
              <tr>
                <td className="muted">기준선 표적소실율</td>
                <td className="mono ta-r">
                  {rs.avgBaseline.toFixed(2)}% <span className="muted">±{rs.baselineSigma.toFixed(2)}</span>
                </td>
              </tr>
              <tr>
                <td className="muted">편차</td>
                <td
                  className="mono strong ta-r"
                  style={{ color: rs.deviation > 0 ? "#dc2626" : rs.deviation < 0 ? "#16a34a" : "#6b7280" }}
                >
                  {rs.deviation > 0 ? "+" : ""}{rs.deviation.toFixed(2)}%p
                </td>
              </tr>
              <tr>
                <td className="muted">평균 PSR율</td>
                <td className="mono ta-r">
                  {(rs.avgPsr * 100).toFixed(1)}% <span className="muted">±{(rs.psrSigma * 100).toFixed(1)}</span>
                </td>
              </tr>
              <tr>
                <td className="muted">소실표적 건수</td>
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
      <div className="block-h3" style={{ margin: 0, marginBottom: 6 }}>분석 대상 장애물</div>
      <div className="bldg-strip-list">
        {buildingDistTexts.map((bt) => (
          <span key={bt.id}>
            <span className="strong">{bt.name}</span>
            <BuildingGroupBadge groupId={bt.groupId} groups={buildingGroups} />
            {" "}({bt.height}m) — {bt.dists.join(", ")}
          </span>
        ))}
      </div>
    </div>
  );

  // 3) 분석 소견 텍스트 (편집 가능 — 시안에는 없지만 운영 기능으로 유지)
  const findingsBlock = (
    <>
      <div className="block-h3">분석 소견</div>
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
      <p className="formula-title">산식 근거</p>
      <div className="formula-grid-inner">
        <div>
          <p className="formula-h">관측량 가중 평균</p>
          <p className="formula-math"><i>x̄ᵥᵥ = Σᵢ(wᵢ·xᵢ) / Σᵢ(wᵢ)</i></p>
          <p>Loss: <i>w</i> = 비행시간 · PSR: <i>w</i> = SSR 포인트수</p>
        </div>
        <div>
          <p className="formula-h">가중 모표준편차</p>
          <p className="formula-math"><i>σᵥᵥ = √( Σᵢ(wᵢ(xᵢ - x̄ᵥᵥ)²) / Σᵢ(wᵢ) )</i></p>
        </div>
        <div>
          <p className="formula-h">Loss 탐지</p>
          <p>스캔 주기 자동 추정 (중앙값)</p>
          <p className="formula-math"><i>임계값 = 주기 × 1.4</i></p>
        </div>
        <div>
          <p className="formula-h">판정 기준</p>
          <p>
            <span className="pill pill-ok">양호</span> &lt; 0.5% ·{" "}
            <span className="pill pill-warn">주의</span> 0.5–2% ·{" "}
            <span className="pill pill-bad">경고</span> ≥ 2% ·{" "}
            <span className="pill pill-hold">보류</span> &lt; 7일
          </p>
        </div>
      </div>
    </div>
  );

  return (
    <AutoPaginate firstHeader={sectionHeader}>
      {summaryCardsBlock}
      {buildingsBlock}
      {findingsBlock}
      {formulaBlock}
    </AutoPaginate>
  );
}

export default React.memo(ReportOMFindings);
