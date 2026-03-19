import type { Aircraft } from "../../types";

interface AircraftSectionProps {
  sectionNum: number;
  aircraft: Aircraft[];
}

export default function ReportAircraftSection({ sectionNum, aircraft }: AircraftSectionProps) {
  if (aircraft.length === 0) return null;

  // 이름 기준 오름차순 정렬 (1호기 → 2호기 순서)
  const sorted = [...aircraft].sort((a, b) => a.name.localeCompare(b.name, "ko"));

  return (
    <div className="mb-8">
      <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[19px] font-bold text-gray-900">
        {sectionNum}. 비행검사기 현황
      </h2>

      <table className="w-full border-collapse text-[14px]">
        <thead>
          <tr className="bg-[#28283c] text-white">
            <th className="border border-gray-300 px-2 py-1.5 text-left font-medium">이름</th>
            <th className="border border-gray-300 px-2 py-1.5 text-left font-medium">등록번호</th>
            <th className="border border-gray-300 px-2 py-1.5 text-left font-medium">기체 모델</th>
            <th className="border border-gray-300 px-2 py-1.5 text-left font-medium">Mode-S</th>
            <th className="border border-gray-300 px-2 py-1.5 text-left font-medium">운용기관</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((a, idx) => (
            <tr key={a.id} className={idx % 2 === 0 ? "bg-white" : "bg-gray-50"}>
              <td className="border border-gray-200 px-2 py-1.5 font-medium">{a.name}</td>
              <td className="border border-gray-200 px-2 py-1.5">{a.registration}</td>
              <td className="border border-gray-200 px-2 py-1.5">{a.model || "-"}</td>
              <td className="border border-gray-200 px-2 py-1.5 font-mono">{a.mode_s_code}</td>
              <td className="border border-gray-200 px-2 py-1.5">{a.organization}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
