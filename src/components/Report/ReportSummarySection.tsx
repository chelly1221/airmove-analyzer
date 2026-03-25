import EditableText from "./EditableText";
import type { Flight, LoSProfileData } from "../../types";

interface SummarySectionProps {
  sectionNum: number;
  flights: Flight[];
  losResults: LoSProfileData[];
  aircraftCount: number;
  editable: boolean;
  commentary: string;
  onCommentaryChange: (v: string) => void;
}

function getGrade(lossPercent: number): { label: string; color: string; bg: string } {
  if (lossPercent < 1) return { label: "양호", color: "text-green-700", bg: "bg-green-100 border-green-300" };
  if (lossPercent < 5) return { label: "주의", color: "text-yellow-700", bg: "bg-yellow-100 border-yellow-300" };
  return { label: "경고", color: "text-red-700", bg: "bg-red-100 border-red-300" };
}

export default function ReportSummarySection({
  sectionNum,
  flights,
  losResults,
  aircraftCount,
  editable,
  commentary,
  onCommentaryChange,
}: SummarySectionProps) {
  const totalLoss = flights.reduce((s, f) => s + f.loss_points.length, 0);
  const avgLossPercent =
    flights.length > 0
      ? flights.reduce((s, f) => s + f.loss_percentage, 0) / flights.length
      : 0;
  const totalTrackMin = flights.reduce((s, f) => s + f.total_track_time, 0) / 60;
  const totalLossTime = flights.reduce((s, f) => s + f.total_loss_time, 0);
  const grade = getGrade(avgLossPercent);

  const kpis = [
    { label: "분석 비행", value: `${flights.length}건` },
    { label: "등록 검사기", value: `${aircraftCount}대` },
    { label: "총 소실 건수", value: `${totalLoss}건`, accent: true },
    { label: "평균 소실율", value: `${avgLossPercent.toFixed(1)}%`, accent: true },
    { label: "총 추적시간", value: `${totalTrackMin.toFixed(1)}분` },
    { label: "총 소실시간", value: `${totalLossTime.toFixed(1)}초` },
    { label: "LoS 분석", value: `${losResults.length}건` },
  ];

  return (
    <div className="mb-8">
      <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[19px] font-bold text-gray-900">
        {sectionNum}. 요약
      </h2>

      {/* 판정 등급 */}
      <div className="mb-4 flex items-center gap-3">
        <span className="text-[16px] text-gray-600">종합 판정:</span>
        <span className={`rounded-md border px-3 py-1 text-[16px] font-bold ${grade.bg} ${grade.color}`}>
          {grade.label}
        </span>
        <span className="text-[14px] text-gray-400">
          (소실율 1% 미만: 양호 / 1~5%: 주의 / 5% 이상: 경고)
        </span>
      </div>

      {/* KPI 그리드 */}
      <div className="mb-4 grid grid-cols-4 gap-2">
        {kpis.map((kpi) => (
          <div
            key={kpi.label}
            className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-center"
          >
            <div className="text-[14px] text-gray-400">{kpi.label}</div>
            <div className={`text-[20px] font-bold ${kpi.accent ? "text-[#a60739]" : "text-gray-800"}`}>
              {kpi.value}
            </div>
          </div>
        ))}
      </div>

      {/* 편집 가능한 코멘트 */}
      <div className="rounded border border-gray-200 bg-gray-50 p-3">
        <div className="mb-1 text-[14px] font-medium text-gray-400">분석 소견</div>
        <EditableText
          value={commentary}
          onChange={onCommentaryChange}
          editable={editable}
          tag="p"
          className="text-[16px] leading-relaxed text-gray-700"
        />
      </div>
    </div>
  );
}
