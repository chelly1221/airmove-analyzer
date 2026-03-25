import React, { useMemo } from "react";
import EditableText from "./EditableText";
import type { RadarMonthlyResult, ManualBuilding, RadarSite } from "../../types";
import { weightedLossAvg, weightedLossStdDev, weightedPsrAvg, weightedPsrStdDev, weightedBaselineLossAvg, weightedBaselineLossStdDev, gradeWithConfidence } from "../../utils/omStats";

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

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

  return (
    <div className="mb-8">
      <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[19px] font-bold text-gray-900">
        {sectionNum}. 종합 소견{monthLabel && ` (${monthLabel})`}
      </h2>

      {/* 종합 판정 카드 */}
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
                  <td className="py-0.5 text-right font-mono font-bold" style={{ color: rs.deviation > 0 ? "#dc2626" : "#16a34a" }}>
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

      {/* 분석 대상 건물 요약 */}
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

      {/* 소견 (편집 가능) */}
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

    </div>
  );
}

export default React.memo(ReportOMFindings);
