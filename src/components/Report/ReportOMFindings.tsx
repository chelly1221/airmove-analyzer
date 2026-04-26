import React, { useMemo } from "react";
import EditableText from "./EditableText";
import KatexMath from "./KatexMath";
import type { RadarMonthlyResult, ManualBuilding, RadarSite } from "../../types";
import { weightedLossAvg, weightedLossStdDev, weightedPsrAvg, weightedPsrStdDev, weightedBaselineLossAvg, weightedBaselineLossStdDev, gradeWithConfidence } from "../../utils/omStats";
import { haversineKm } from "../../utils/geo";
import ReportOMSectionHeader from "./ReportOMSectionHeader";
import AutoPaginate from "./AutoPaginate";

interface Props {
  sectionNum: number;
  radarResults: RadarMonthlyResult[];
  selectedBuildings: ManualBuilding[];
  radarSites: RadarSite[];
  /** 편집 가능 소견 텍스트 */
  findingsText: string;
  onFindingsChange: (text: string) => void;
  editable: boolean;
  /** 분석 대상 월 (YYYY-MM) */
  analysisMonth?: string;
}


function ReportOMFindings({
  sectionNum,
  radarResults,
  selectedBuildings,
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

  // 건물별 거리 텍스트 사전 계산
  const buildingDistTexts = useMemo(() =>
    selectedBuildings.map((b) => ({
      id: b.id,
      name: b.name || `건물${b.id}`,
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

  const summaryCardsBlock = (
    <div className="mb-4 grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(radarSummaries.length, 3)}, 1fr)` }}>
      {radarSummaries.map((rs) => (
        <div key={rs.radarName} className="border border-gray-200 rounded-md p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[13px] font-bold text-gray-700">{rs.radarName}</span>
            <span className="px-2 py-0.5 rounded text-[13px] font-bold"
              style={{ backgroundColor: rs.grade.bg, color: rs.grade.color }}>
              {rs.grade.label}
            </span>
          </div>
          <table className="w-full text-[12px] border-collapse">
            <tbody>
              <tr>
                <td className="py-0.5 text-gray-500">분석 기간</td>
                <td className="py-0.5 text-right font-mono">{monthLabel ? `${monthLabel} · ` : ""}{rs.dayCount}일</td>
              </tr>
              <tr>
                <td className="py-0.5 text-gray-500">평균 표적소실율</td>
                <td className="py-0.5 text-right font-mono font-bold" style={{ color: rs.avgLoss >= 2 ? "#dc2626" : "#374151" }}>
                  {rs.avgLoss.toFixed(2)}% <span className="text-gray-400 font-normal">±{rs.lossSigma.toFixed(2)}</span>
                </td>
              </tr>
              <tr>
                <td className="py-0.5 text-gray-500">기준선 표적소실율</td>
                <td className="py-0.5 text-right font-mono">{rs.avgBaseline.toFixed(2)}% <span className="text-gray-400">±{rs.baselineSigma.toFixed(2)}</span></td>
              </tr>
              <tr>
                <td className="py-0.5 text-gray-500">편차</td>
                <td className="py-0.5 text-right font-mono font-bold" style={{ color: rs.deviation > 0 ? "#dc2626" : rs.deviation < 0 ? "#16a34a" : "#6b7280" }}>
                  {rs.deviation > 0 ? "+" : ""}{rs.deviation.toFixed(2)}%p
                </td>
              </tr>
              <tr>
                <td className="py-0.5 text-gray-500">평균 PSR율</td>
                <td className="py-0.5 text-right font-mono">{(rs.avgPsr * 100).toFixed(1)}% <span className="text-gray-400">±{(rs.psrSigma * 100).toFixed(1)}</span></td>
              </tr>
              <tr>
                <td className="py-0.5 text-gray-500">소실표적 건수</td>
                <td className="py-0.5 text-right font-mono">{rs.totalLoss}건</td>
              </tr>
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );

  const buildingsBlock = (
    <div className="mb-4 p-2 bg-gray-50 rounded border border-gray-200">
      <h3 className="mb-2 text-[15px] font-semibold text-gray-700">분석 대상 장애물</h3>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
        {buildingDistTexts.map((bt) => (
          <span key={bt.id} className="text-gray-700">
            <span className="font-semibold">{bt.name}</span>
            {" "}({bt.height}m) — {bt.dists.join(", ")}
          </span>
        ))}
      </div>
    </div>
  );

  const findingsBlock = (
    <div className="mb-4">
      <h3 className="mb-2 text-[15px] font-semibold text-gray-700">분석 소견</h3>
      <div className="border border-gray-200 rounded p-3 bg-white min-h-[60px]">
        <EditableText
          value={findingsText}
          onChange={onFindingsChange}
          editable={editable}
          tag="p"
          className="text-[13px] leading-relaxed text-gray-800 whitespace-pre-wrap"
        />
      </div>
    </div>
  );

  const formulaBlock = (
    <div className="rounded-lg border border-gray-200 bg-gray-50/70 px-4 py-3">
      <p className="mb-2 text-[11px] font-semibold text-gray-600 tracking-wide">산식 근거</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[10px] text-gray-500">
        <div>
          <p className="mb-0.5 font-medium text-gray-600">관측량 가중 평균</p>
          <KatexMath math="\bar{x}_w = \dfrac{\displaystyle\sum_{i} w_i \cdot x_i}{\displaystyle\sum_{i} w_i}" display className="text-gray-700" />
          <p className="mt-1">Loss: <KatexMath math="w_i" /> = 비행시간 · PSR: <KatexMath math="w_i" /> = SSR 포인트수</p>
        </div>
        <div>
          <p className="mb-0.5 font-medium text-gray-600">가중 모표준편차</p>
          <KatexMath math="\sigma_w = \sqrt{\dfrac{\displaystyle\sum_{i} w_i \left( x_i - \bar{x}_w \right)^2}{\displaystyle\sum_{i} w_i}}" display className="text-gray-700" />
        </div>
        <div>
          <p className="mb-0.5 font-medium text-gray-600">Loss 탐지</p>
          <p>스캔 주기 자동 추정 (중앙값)</p>
          <KatexMath math="\text{임계값} = \text{주기} \times 1.4" display className="text-gray-700" />
        </div>
        <div>
          <p className="mb-0.5 font-medium text-gray-600">판정 기준</p>
          <p>
            <span className="inline-block rounded bg-green-100 px-1 text-green-700">양호</span>{" < 0.5% · "}
            <span className="inline-block rounded bg-yellow-100 px-1 text-yellow-700">주의</span>{" 0.5–2% · "}
            <span className="inline-block rounded bg-red-100 px-1 text-red-700">경고</span>{" ≥ 2% · "}
            <span className="inline-block rounded bg-gray-200 px-1 text-gray-600">보류</span>{" < 7일"}
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
