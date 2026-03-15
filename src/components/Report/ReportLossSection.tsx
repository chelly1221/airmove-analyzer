import { format } from "date-fns";
import type { Flight } from "../../types";
import { flightLabel } from "../../utils/flightConsolidation";
import { useAppStore } from "../../store";

interface LossSectionProps {
  sectionNum: number;
  flights: Flight[];
  template: "weekly" | "monthly";
}

export default function ReportLossSection({ sectionNum, flights, template }: LossSectionProps) {
  const aircraft = useAppStore((s) => s.aircraft);

  const allLoss = flights.flatMap((f) => {
    const label = flightLabel(f, aircraft);
    return f.loss_segments.map((seg) => ({ flightLabel: label, segment: seg }));
  });

  if (allLoss.length === 0) return null;

  const maxRows = template === "monthly" ? 20 : allLoss.length;
  const displayRows = allLoss.slice(0, maxRows);

  return (
    <div className="mb-8">
      <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[15px] font-bold text-gray-900">
        {sectionNum}. 표적소실 구간 상세
      </h2>

      <table className="w-full border-collapse text-[10px]">
        <thead>
          <tr className="bg-[#28283c] text-white">
            <th className="border border-gray-300 px-1.5 py-1 text-center font-medium w-6">#</th>
            <th className="border border-gray-300 px-1.5 py-1 text-left font-medium">Mode-S</th>
            <th className="border border-gray-300 px-1.5 py-1 text-left font-medium">비행</th>
            <th className="border border-gray-300 px-1.5 py-1 text-center font-medium">시작</th>
            <th className="border border-gray-300 px-1.5 py-1 text-center font-medium">종료</th>
            <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">지속(초)</th>
            <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">거리(km)</th>
            <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">고도(m)</th>
          </tr>
        </thead>
        <tbody>
          {displayRows.map((item, idx) => (
            <tr key={idx} className={idx % 2 === 0 ? "bg-white" : "bg-gray-50"}>
              <td className="border border-gray-200 px-1.5 py-1 text-center">{idx + 1}</td>
              <td className="border border-gray-200 px-1.5 py-1 font-mono">{item.segment.mode_s}</td>
              <td className="border border-gray-200 px-1.5 py-1">{item.flightLabel}</td>
              <td className="border border-gray-200 px-1.5 py-1 text-center">
                {format(new Date(item.segment.start_time * 1000), "MM-dd HH:mm:ss")}
              </td>
              <td className="border border-gray-200 px-1.5 py-1 text-center">
                {format(new Date(item.segment.end_time * 1000), "MM-dd HH:mm:ss")}
              </td>
              <td className="border border-gray-200 px-1.5 py-1 text-right">{item.segment.duration_secs.toFixed(1)}</td>
              <td className="border border-gray-200 px-1.5 py-1 text-right">{item.segment.distance_km.toFixed(2)}</td>
              <td className="border border-gray-200 px-1.5 py-1 text-right">{item.segment.last_altitude.toFixed(0)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {template === "monthly" && allLoss.length > maxRows && (
        <p className="mt-2 text-[10px] text-gray-400">
          ... 외 {allLoss.length - maxRows}건 (총 {allLoss.length}건)
        </p>
      )}
    </div>
  );
}
