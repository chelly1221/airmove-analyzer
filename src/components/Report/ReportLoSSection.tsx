import type { LoSProfileData } from "../../types";

interface LoSSectionProps {
  sectionNum: number;
  losResults: LoSProfileData[];
}

export default function ReportLoSSection({ sectionNum, losResults }: LoSSectionProps) {
  if (losResults.length === 0) return null;

  return (
    <div className="mb-8">
      <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[19px] font-bold text-gray-900">
        {sectionNum}. LoS 분석 결과
      </h2>

      <table className="w-full border-collapse text-[14px]">
        <thead>
          <tr className="bg-[#28283c] text-white">
            <th className="border border-gray-300 px-2 py-1.5 text-center font-medium w-6">#</th>
            <th className="border border-gray-300 px-2 py-1.5 text-left font-medium">레이더</th>
            <th className="border border-gray-300 px-2 py-1.5 text-left font-medium">대상 좌표</th>
            <th className="border border-gray-300 px-2 py-1.5 text-right font-medium">거리(km)</th>
            <th className="border border-gray-300 px-2 py-1.5 text-right font-medium">방위(°)</th>
            <th className="border border-gray-300 px-2 py-1.5 text-center font-medium">결과</th>
            <th className="border border-gray-300 px-2 py-1.5 text-left font-medium">차단점</th>
          </tr>
        </thead>
        <tbody>
          {losResults.map((r, idx) => (
            <tr key={idx} className={idx % 2 === 0 ? "bg-white" : "bg-gray-50"}>
              <td className="border border-gray-200 px-2 py-1.5 text-center">{idx + 1}</td>
              <td className="border border-gray-200 px-2 py-1.5">{r.radarSiteName}</td>
              <td className="border border-gray-200 px-2 py-1.5 font-mono text-[13px]">
                {r.targetLat.toFixed(4)}°N {r.targetLon.toFixed(4)}°E
              </td>
              <td className="border border-gray-200 px-2 py-1.5 text-right">{r.totalDistance.toFixed(1)}</td>
              <td className="border border-gray-200 px-2 py-1.5 text-right">{r.bearing.toFixed(0)}</td>
              <td className="border border-gray-200 px-2 py-1.5 text-center">
                <span className={`rounded px-1.5 py-0.5 text-[13px] font-medium ${
                  r.losBlocked
                    ? "bg-red-100 text-red-700"
                    : "bg-green-100 text-green-700"
                }`}>
                  {r.losBlocked ? "차단" : "양호"}
                </span>
              </td>
              <td className="border border-gray-200 px-2 py-1.5">
                {r.maxBlockingPoint
                  ? `${r.maxBlockingPoint.name ? r.maxBlockingPoint.name + " " : ""}${r.maxBlockingPoint.elevation.toFixed(0)}m`
                  : "-"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
