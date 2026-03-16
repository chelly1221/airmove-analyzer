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
    return f.loss_points.map((pt) => ({ flightLabel: label, point: pt }));
  });

  if (allLoss.length === 0) return null;

  const maxRows = template === "monthly" ? 50 : allLoss.length;
  const displayRows = allLoss.slice(0, maxRows);

  return (
    <div className="mb-8">
      <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[15px] font-bold text-gray-900">
        {sectionNum}. 표적소실 포인트 상세
      </h2>

      <table className="w-full border-collapse text-[10px]">
        <thead>
          <tr className="bg-[#28283c] text-white">
            <th className="border border-gray-300 px-1.5 py-1 text-center font-medium w-6">#</th>
            <th className="border border-gray-300 px-1.5 py-1 text-left font-medium">Mode-S</th>
            <th className="border border-gray-300 px-1.5 py-1 text-left font-medium">비행</th>
            <th className="border border-gray-300 px-1.5 py-1 text-center font-medium">예상시각</th>
            <th className="border border-gray-300 px-1.5 py-1 text-center font-medium">스캔</th>
            <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">gap(초)</th>
            <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">레이더(km)</th>
            <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">고도(m)</th>
          </tr>
        </thead>
        <tbody>
          {displayRows.map((item, idx) => (
            <tr key={idx} className={idx % 2 === 0 ? "bg-white" : "bg-gray-50"}>
              <td className="border border-gray-200 px-1.5 py-1 text-center">{idx + 1}</td>
              <td className="border border-gray-200 px-1.5 py-1 font-mono">{item.point.mode_s}</td>
              <td className="border border-gray-200 px-1.5 py-1">{item.flightLabel}</td>
              <td className="border border-gray-200 px-1.5 py-1 text-center">
                {format(new Date(item.point.timestamp * 1000), "MM-dd HH:mm:ss")}
              </td>
              <td className="border border-gray-200 px-1.5 py-1 text-center">
                {item.point.scan_index}/{item.point.total_missed_scans}
              </td>
              <td className="border border-gray-200 px-1.5 py-1 text-right">{item.point.gap_duration_secs.toFixed(1)}</td>
              <td className="border border-gray-200 px-1.5 py-1 text-right">{item.point.radar_distance_km.toFixed(1)}</td>
              <td className="border border-gray-200 px-1.5 py-1 text-right">{item.point.altitude.toFixed(0)}</td>
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
