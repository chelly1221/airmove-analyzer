import React from "react";
import type { RadarMonthlyResult, ManualBuilding, RadarSite, AzSector } from "../../types";

interface Props {
  sectionNum: number;
  radarResults: RadarMonthlyResult[];
  selectedBuildings: ManualBuilding[];
  radarSites: RadarSite[];
  /** 레이더별 방위 구간 (레이더 이름 → AzSector[]) */
  azimuthSectorsByRadar: Map<string, AzSector[]>;
  /** 분석 대상 월 (YYYY-MM) */
  analysisMonth?: string;
}

/** bearing from radar to building center */
function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * toRad) * Math.cos(lat2 * toRad);
  const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
    Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos((lon2 - lon1) * toRad);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function ReportOMSummarySection({
  sectionNum,
  radarResults,
  selectedBuildings,
  radarSites,
  azimuthSectorsByRadar,
  analysisMonth,
}: Props) {
  const monthLabel = analysisMonth
    ? `${analysisMonth.slice(0, 4)}년 ${parseInt(analysisMonth.slice(5, 7))}월`
    : "";

  return (
    <div className="mb-8">
      <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[19px] font-bold text-gray-900">
        {sectionNum}. 분석 요약{monthLabel && ` (${monthLabel})`}
      </h2>

      {/* 선택 장애물 테이블 */}
      <div className="mb-4">
        <h3 className="mb-2 text-[15px] font-semibold text-gray-700">분석 대상 장애물</h3>
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="bg-[#28283c] text-white">
              <th className="border border-gray-300 px-2 py-1 text-center font-medium w-5">#</th>
              <th className="border border-gray-300 px-2 py-1 text-left font-medium">건물명</th>
              <th className="border border-gray-300 px-2 py-1 text-right font-medium">높이(m)</th>
              {radarSites.map((r) => (
                <th key={r.name} className="border border-gray-300 px-2 py-1 text-right font-medium">
                  {r.name} 방위/거리
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {selectedBuildings.map((b, i) => (
              <tr key={b.id} className={i % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                <td className="border border-gray-200 px-2 py-1 text-center">{i + 1}</td>
                <td className="border border-gray-200 px-2 py-1">{b.name || `건물 ${b.id}`}</td>
                <td className="border border-gray-200 px-2 py-1 text-right font-mono">{b.height.toFixed(0)}</td>
                {radarSites.map((r) => {
                  const az = bearingDeg(r.latitude, r.longitude, b.latitude, b.longitude);
                  const dist = haversineKm(r.latitude, r.longitude, b.latitude, b.longitude);
                  return (
                    <td key={r.name} className="border border-gray-200 px-2 py-1 text-right font-mono">
                      {az.toFixed(1)}° / {dist.toFixed(1)}km
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 분석 방위 구간 */}
      <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
        <h3 className="mb-2 text-[15px] font-semibold text-gray-700">분석 방위 구간</h3>
        <div className="grid grid-cols-2 gap-2 text-[13px]">
          {radarSites.map((r) => {
            const sectors = azimuthSectorsByRadar.get(r.name) ?? [];
            return (
              <div key={r.name}>
                <span className="text-gray-400">{r.name}:</span>{" "}
                <span className="font-mono font-semibold text-gray-700">
                  {sectors.map((s) => `${s.start_deg.toFixed(1)}°~${s.end_deg.toFixed(1)}°`).join(", ") || "—"}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* 레이더별 KPI */}
      {radarResults.map((rr) => {
        const days = rr.daily_stats.length;
        const avgPsr = days > 0 ? rr.daily_stats.reduce((s, d) => s + d.psr_rate * 100, 0) / days : 0;
        const avgLoss = days > 0 ? rr.daily_stats.reduce((s, d) => s + d.loss_rate, 0) / days : 0;
        const totalPts = rr.total_points_filtered;
        const grade = avgLoss < 0.5 ? "양호" : avgLoss < 2 ? "주의" : "경고";
        const gradeColor = grade === "양호" ? "text-green-600 bg-green-50 border-green-200"
          : grade === "주의" ? "text-yellow-600 bg-yellow-50 border-yellow-200"
          : "text-red-600 bg-red-50 border-red-200";

        return (
          <div key={rr.radar_name} className="mb-3">
            <h3 className="mb-2 text-[15px] font-semibold text-gray-700">{rr.radar_name}</h3>
            <div className="grid grid-cols-5 gap-2">
              <div className={`rounded-md border px-2 py-1.5 text-center ${gradeColor}`}>
                <p className="text-[13px] text-gray-400">종합 판정</p>
                <p className="text-[15px] font-bold">{grade}</p>
              </div>
              <div className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 text-center">
                <p className="text-[13px] text-gray-400">분석일수</p>
                <p className="text-[13px] font-bold text-gray-800">{days}일</p>
              </div>
              <div className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 text-center">
                <p className="text-[13px] text-gray-400">분석 포인트</p>
                <p className="text-[13px] font-bold text-gray-800">{totalPts.toLocaleString()}</p>
              </div>
              <div className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 text-center">
                <p className="text-[13px] text-gray-400">평균 PSR율</p>
                <p className="text-[13px] font-bold text-blue-600">{avgPsr.toFixed(2)}%</p>
              </div>
              <div className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 text-center">
                <p className="text-[13px] text-gray-400">평균 표적소실율</p>
                <p className="text-[13px] font-bold text-[#a60739]">{avgLoss.toFixed(3)}%</p>
              </div>
            </div>
            {rr.failed_files.length > 0 && (
              <p className="mt-1 text-[13px] text-red-500">
                파싱 실패: {rr.failed_files.length}건 ({rr.failed_files.map((f) => f.split(/[/\\]/).pop()).join(", ")})
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default React.memo(ReportOMSummarySection);
