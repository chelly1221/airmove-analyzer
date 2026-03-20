import type { PreScreeningResult } from "../../types";

interface Props {
  sectionNum: number;
  result: PreScreeningResult;
}

/** 기존 지형 앙각 및 최대 건축가능 높이 분석 섹션 */
export default function ReportPSAngleHeight({ sectionNum, result }: Props) {
  const allBldgResults = result.radar_results.flatMap((rr) =>
    rr.building_results.map((br) => ({ radarName: rr.radar_name, ...br })),
  );

  return (
    <div className="mb-8">
      <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[19px] font-bold text-gray-900">
        {sectionNum}. 지형 앙각 및 건축가능 높이 분석
      </h2>

      <p className="mb-4 text-[11px] leading-relaxed text-gray-500">
        각 제안 건물 위치에서 레이더 기준 기존 지형 앙각(최소 0.25° 적용)과
        건물 완공 시 앙각을 비교하여 최대 건축가능 높이를 산출합니다.
        건축가능 높이는 기존 지형 앙각을 초과하지 않는 최대 건물 높이입니다.
      </p>

      <table className="w-full text-[11px]">
        <thead>
          <tr className="border-b-2 border-gray-300 bg-gray-100 text-gray-600">
            <th className="px-2 py-1.5 text-left">레이더</th>
            <th className="px-2 py-1.5 text-left">건물명</th>
            <th className="px-2 py-1.5 text-right">거리 (km)</th>
            <th className="px-2 py-1.5 text-right">방위 (°)</th>
            <th className="px-2 py-1.5 text-right">지형 앙각 (°)</th>
            <th className="px-2 py-1.5 text-right">건물 앙각 (°)</th>
            <th className="px-2 py-1.5 text-right">건물 높이 (m)</th>
            <th className="px-2 py-1.5 text-right">최대 건축가능 (m)</th>
            <th className="px-2 py-1.5 text-center">판정</th>
          </tr>
        </thead>
        <tbody>
          {allBldgResults.map((br, idx) => {
            const exceedsAngle = br.building_elevation_angle_deg > br.terrain_elevation_angle_deg;
            const ratio = br.building_height_m / br.max_buildable_height_m;
            return (
              <tr key={idx} className={`border-b border-gray-100 ${exceedsAngle ? "bg-red-50" : ""}`}>
                <td className="px-2 py-1.5 font-medium text-gray-700">{br.radarName}</td>
                <td className="px-2 py-1.5 text-gray-700">{br.building_name || `건물 ${br.building_id}`}</td>
                <td className="px-2 py-1.5 text-right font-mono text-gray-600">{br.distance_km.toFixed(2)}</td>
                <td className="px-2 py-1.5 text-right font-mono text-gray-600">{br.azimuth_deg.toFixed(1)}</td>
                <td className="px-2 py-1.5 text-right font-mono text-blue-700 font-semibold">{br.terrain_elevation_angle_deg.toFixed(3)}</td>
                <td className={`px-2 py-1.5 text-right font-mono font-semibold ${exceedsAngle ? "text-red-600" : "text-green-600"}`}>
                  {br.building_elevation_angle_deg.toFixed(3)}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-gray-600">{br.building_height_m.toFixed(1)}</td>
                <td className="px-2 py-1.5 text-right font-mono font-semibold text-[#a60739]">{br.max_buildable_height_m.toFixed(1)}</td>
                <td className="px-2 py-1.5 text-center">
                  {exceedsAngle ? (
                    <span className="inline-block rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">
                      초과 ({(ratio * 100).toFixed(0)}%)
                    </span>
                  ) : (
                    <span className="inline-block rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-700">
                      적합
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* 범례 */}
      <div className="mt-3 flex gap-4 text-[10px] text-gray-400">
        <span>* 지형 앙각: 레이더→건물 경로 상 기존 지형의 최대 앙각 (최소 0.25° 적용)</span>
      </div>
      <div className="mt-1 flex gap-4 text-[10px] text-gray-400">
        <span>* 최대 건축가능 높이: 기존 지형 앙각을 초과하지 않는 건물 최대 높이 (4/3 유효지구 모델)</span>
      </div>
    </div>
  );
}
