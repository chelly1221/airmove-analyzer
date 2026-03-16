import type { LOSProfileData, PanoramaPoint, RadarSite } from "../../types";

interface ObstacleSummaryProps {
  sectionNum: number;
  losResults: LOSProfileData[];
  panoramaData: PanoramaPoint[];
  radarSite: RadarSite;
}

/** 방위 라벨 */
function azLabel(deg: number): string {
  const dirs: [number, string][] = [
    [0, "N"], [45, "NE"], [90, "E"], [135, "SE"],
    [180, "S"], [225, "SW"], [270, "W"], [315, "NW"], [360, "N"],
  ];
  for (const [d, l] of dirs) {
    if (Math.abs(deg - d) < 5) return l;
  }
  return `${deg.toFixed(0)}°`;
}

export default function ReportObstacleSummarySection({
  sectionNum,
  losResults,
  panoramaData,
  radarSite,
}: ObstacleSummaryProps) {
  // LOS 통계
  const totalLOS = losResults.length;
  const blockedLOS = losResults.filter((r) => r.losBlocked).length;
  const clearLOS = totalLOS - blockedLOS;
  const blockRate = totalLOS > 0 ? (blockedLOS / totalLOS) * 100 : 0;

  // 파노라마 통계
  const buildings = panoramaData.filter((p) => p.obstacle_type !== "terrain");
  const gisBuildings = buildings.filter((p) => p.obstacle_type === "gis_building");
  const manualBuildings = buildings.filter((p) => p.obstacle_type === "manual_building");
  const maxAnglePt = panoramaData.length > 0
    ? panoramaData.reduce((a, b) => a.elevation_angle_deg > b.elevation_angle_deg ? a : b)
    : null;
  const avgAngle = panoramaData.length > 0
    ? panoramaData.reduce((s, p) => s + p.elevation_angle_deg, 0) / panoramaData.length
    : 0;

  // 종합 판정
  const grade = (() => {
    if (blockedLOS === 0 && buildings.length === 0) return "양호";
    if (blockRate > 30 || buildings.length > 20) return "경고";
    if (blockedLOS > 0 || buildings.length > 5) return "주의";
    return "양호";
  })();
  const gradeColor = grade === "양호" ? "text-green-600 bg-green-50 border-green-200"
    : grade === "주의" ? "text-yellow-600 bg-yellow-50 border-yellow-200"
    : "text-red-600 bg-red-50 border-red-200";

  // 주요 차단 방위 (앙각 상위 5개 건물)
  const topObstacles = [...buildings]
    .sort((a, b) => b.elevation_angle_deg - a.elevation_angle_deg)
    .slice(0, 5);

  // 방위별 건물 수 (8방위)
  const sectorSize = 45;
  const sectorLabels = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const sectorBuildingCounts = sectorLabels.map((label, i) => {
    const start = i * sectorSize;
    const end = start + sectorSize;
    const bldgs = buildings.filter((p) => p.azimuth_deg >= start && p.azimuth_deg < end);
    return { label, count: bldgs.length };
  });
  const worstSector = sectorBuildingCounts.reduce((a, b) => a.count > b.count ? a : b, { label: "-", count: 0 });

  return (
    <div className="mb-8">
      <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[15px] font-bold text-gray-900">
        {sectionNum}. 전파 장애물 종합 요약
      </h2>

      {/* 레이더 기본 정보 */}
      <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
        <div className="grid grid-cols-4 gap-3 text-[10px]">
          <div>
            <span className="text-gray-400">레이더</span>
            <span className="ml-2 font-bold text-gray-800">{radarSite.name}</span>
          </div>
          <div>
            <span className="text-gray-400">좌표</span>
            <span className="ml-2 font-mono text-gray-700">
              {radarSite.latitude.toFixed(4)}°N {radarSite.longitude.toFixed(4)}°E
            </span>
          </div>
          <div>
            <span className="text-gray-400">해발고도</span>
            <span className="ml-2 font-bold text-gray-800">{radarSite.altitude.toFixed(0)}m</span>
          </div>
          <div>
            <span className="text-gray-400">안테나 높이</span>
            <span className="ml-2 font-bold text-gray-800">
              {(radarSite.altitude + radarSite.antenna_height).toFixed(0)}m ASL
            </span>
          </div>
        </div>
      </div>

      {/* KPI 그리드 */}
      <div className="mb-4 grid grid-cols-6 gap-2">
        <KPICard label="종합 판정" value={grade} className={gradeColor} large />
        <KPICard label="LOS 분석" value={`${totalLOS}건`} />
        <KPICard label="LOS 차단" value={`${blockedLOS}건`} accent={blockedLOS > 0} />
        <KPICard label="LOS 양호" value={`${clearLOS}건`} />
        <KPICard label="건물 장애물" value={`${buildings.length}건`} accent={buildings.length > 0} />
        <KPICard
          label="최대 앙각"
          value={maxAnglePt ? `${maxAnglePt.elevation_angle_deg.toFixed(3)}°` : "-"}
          accent={!!maxAnglePt && maxAnglePt.elevation_angle_deg > 0.5}
        />
      </div>

      {/* 상세 통계 테이블 */}
      <div className="mb-4 grid grid-cols-2 gap-4">
        {/* LOS 분석 요약 */}
        <div>
          <p className="mb-1.5 text-[10px] font-semibold text-gray-600">LOS 분석 요약</p>
          <table className="w-full border-collapse text-[9px]">
            <tbody>
              <tr className="bg-gray-50">
                <td className="border border-gray-200 px-2 py-1 text-gray-500">총 분석 건수</td>
                <td className="border border-gray-200 px-2 py-1 text-right font-bold">{totalLOS}건</td>
              </tr>
              <tr>
                <td className="border border-gray-200 px-2 py-1 text-gray-500">차단 건수</td>
                <td className="border border-gray-200 px-2 py-1 text-right font-bold text-red-600">{blockedLOS}건</td>
              </tr>
              <tr className="bg-gray-50">
                <td className="border border-gray-200 px-2 py-1 text-gray-500">양호 건수</td>
                <td className="border border-gray-200 px-2 py-1 text-right font-bold text-green-600">{clearLOS}건</td>
              </tr>
              <tr>
                <td className="border border-gray-200 px-2 py-1 text-gray-500">차단율</td>
                <td className="border border-gray-200 px-2 py-1 text-right font-bold">{blockRate.toFixed(1)}%</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* 파노라마 요약 */}
        <div>
          <p className="mb-1.5 text-[10px] font-semibold text-gray-600">파노라마 장애물 요약</p>
          <table className="w-full border-collapse text-[9px]">
            <tbody>
              <tr className="bg-gray-50">
                <td className="border border-gray-200 px-2 py-1 text-gray-500">GIS 건물</td>
                <td className="border border-gray-200 px-2 py-1 text-right font-bold">{gisBuildings.length}건</td>
              </tr>
              <tr>
                <td className="border border-gray-200 px-2 py-1 text-gray-500">수동 건물</td>
                <td className="border border-gray-200 px-2 py-1 text-right font-bold">{manualBuildings.length}건</td>
              </tr>
              <tr className="bg-gray-50">
                <td className="border border-gray-200 px-2 py-1 text-gray-500">평균 앙각</td>
                <td className="border border-gray-200 px-2 py-1 text-right font-bold">{avgAngle.toFixed(3)}°</td>
              </tr>
              <tr>
                <td className="border border-gray-200 px-2 py-1 text-gray-500">최다 건물 방위</td>
                <td className="border border-gray-200 px-2 py-1 text-right font-bold">
                  {worstSector.count > 0 ? `${worstSector.label} (${worstSector.count}건)` : "-"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* 주요 장애물 TOP 5 */}
      {topObstacles.length > 0 && (
        <div>
          <p className="mb-1.5 text-[10px] font-semibold text-gray-600">주요 장애물 (앙각 상위 5건)</p>
          <table className="w-full border-collapse text-[9px]">
            <thead>
              <tr className="bg-[#28283c] text-white">
                <th className="border border-gray-300 px-1.5 py-1 text-center font-medium w-5">#</th>
                <th className="border border-gray-300 px-1.5 py-1 text-center font-medium">유형</th>
                <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">방위</th>
                <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">앙각(°)</th>
                <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">거리(km)</th>
                <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">높이(m)</th>
                <th className="border border-gray-300 px-1.5 py-1 text-left font-medium">이름/주소</th>
              </tr>
            </thead>
            <tbody>
              {topObstacles.map((pt, idx) => (
                <tr key={idx} className={idx % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                  <td className="border border-gray-200 px-1.5 py-1 text-center">{idx + 1}</td>
                  <td className="border border-gray-200 px-1.5 py-1 text-center">
                    <span className={`rounded px-1 py-0.5 text-[8px] font-medium ${
                      pt.obstacle_type === "gis_building"
                        ? "bg-orange-50 text-orange-600"
                        : "bg-red-50 text-red-600"
                    }`}>
                      {pt.obstacle_type === "gis_building" ? "GIS" : "수동"}
                    </span>
                  </td>
                  <td className="border border-gray-200 px-1.5 py-1 text-right font-mono">
                    {pt.azimuth_deg.toFixed(1)}° <span className="text-[7px] text-gray-400">{azLabel(pt.azimuth_deg)}</span>
                  </td>
                  <td className="border border-gray-200 px-1.5 py-1 text-right font-mono font-medium text-[#a60739]">
                    {pt.elevation_angle_deg.toFixed(3)}
                  </td>
                  <td className="border border-gray-200 px-1.5 py-1 text-right font-mono">{pt.distance_km.toFixed(2)}</td>
                  <td className="border border-gray-200 px-1.5 py-1 text-right font-mono">
                    {(pt.ground_elev_m + pt.obstacle_height_m).toFixed(0)}
                  </td>
                  <td className="border border-gray-200 px-1.5 py-1 truncate max-w-[160px]" title={pt.address ?? pt.name ?? ""}>
                    {pt.name || pt.address || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function KPICard({
  label,
  value,
  accent,
  className,
  large,
}: {
  label: string;
  value: string;
  accent?: boolean;
  className?: string;
  large?: boolean;
}) {
  return (
    <div className={`rounded-md border px-2 py-1.5 text-center ${className ?? "border-gray-200 bg-gray-50"}`}>
      <p className="text-[8px] text-gray-400">{label}</p>
      <p className={`font-bold ${large ? "text-[12px]" : "text-[10px]"} ${
        accent ? "text-[#a60739]" : className ? "" : "text-gray-800"
      }`}>
        {value}
      </p>
    </div>
  );
}
