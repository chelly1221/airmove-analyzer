import { format } from "date-fns";
import type { WeatherSnapshot } from "../../types";
import { assessDuctingRisk } from "../../utils/weatherFetch";

interface Props {
  sectionNum: number;
  weather: WeatherSnapshot;
}

/** 풍향 → 16방위 라벨 */
function windDirLabel(deg: number): string {
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

export default function ReportWeatherSection({ sectionNum, weather }: Props) {
  // 분석 기간 내 시간별 데이터만 표시
  const hourlyData = weather.hourly;

  // 요약 통계
  const avgCloud = hourlyData.length > 0
    ? hourlyData.reduce((s, h) => s + h.cloud_cover, 0) / hourlyData.length
    : 0;
  const avgVis = hourlyData.length > 0
    ? hourlyData.reduce((s, h) => s + h.visibility, 0) / hourlyData.length
    : 0;
  const avgWind = hourlyData.length > 0
    ? hourlyData.reduce((s, h) => s + h.wind_speed, 0) / hourlyData.length
    : 0;
  const avgPressure = hourlyData.length > 0
    ? hourlyData.reduce((s, h) => s + h.pressure, 0) / hourlyData.length
    : 0;

  // 덕팅 위험 시간대 식별
  const ductingHours = hourlyData.filter((h) => assessDuctingRisk(h) !== "low");

  return (
    <div className="space-y-5">
      <h2 className="text-[14px] font-bold text-gray-900 border-b-2 border-gray-800 pb-1">
        {sectionNum}. 기상 조건 분석
      </h2>

      {/* 요약 카드 */}
      <div className="grid grid-cols-4 gap-3">
        <div className="rounded border border-gray-200 p-2.5 text-center">
          <div className="text-[9px] text-gray-400">평균 운량</div>
          <div className="text-[13px] font-bold text-gray-800">{avgCloud.toFixed(0)}%</div>
        </div>
        <div className="rounded border border-gray-200 p-2.5 text-center">
          <div className="text-[9px] text-gray-400">평균 시정</div>
          <div className="text-[13px] font-bold text-gray-800">{(avgVis / 1000).toFixed(1)}km</div>
        </div>
        <div className="rounded border border-gray-200 p-2.5 text-center">
          <div className="text-[9px] text-gray-400">평균 풍속</div>
          <div className="text-[13px] font-bold text-gray-800">{avgWind.toFixed(1)}m/s</div>
        </div>
        <div className="rounded border border-gray-200 p-2.5 text-center">
          <div className="text-[9px] text-gray-400">평균 기압</div>
          <div className="text-[13px] font-bold text-gray-800">{avgPressure.toFixed(0)}hPa</div>
        </div>
      </div>

      {/* 시간별 기상 테이블 */}
      <div>
        <h3 className="text-[11px] font-semibold text-gray-700 mb-1.5">시간별 기상 현황</h3>
        <table className="w-full text-[9px] border-collapse">
          <thead>
            <tr className="bg-gray-100">
              <th className="border border-gray-300 px-1.5 py-1 text-left">시각</th>
              <th className="border border-gray-300 px-1.5 py-1 text-right">기온</th>
              <th className="border border-gray-300 px-1.5 py-1 text-right">운량</th>
              <th className="border border-gray-300 px-1.5 py-1 text-right">시정</th>
              <th className="border border-gray-300 px-1.5 py-1 text-right">풍속</th>
              <th className="border border-gray-300 px-1.5 py-1 text-right">풍향</th>
              <th className="border border-gray-300 px-1.5 py-1 text-right">기압</th>
              <th className="border border-gray-300 px-1.5 py-1 text-right">이슬점</th>
              <th className="border border-gray-300 px-1.5 py-1 text-center">덕팅</th>
            </tr>
          </thead>
          <tbody>
            {hourlyData.slice(0, 48).map((h, i) => {
              const ducting = assessDuctingRisk(h);
              return (
                <tr key={i} className={ducting === "high" ? "bg-red-50" : ducting === "moderate" ? "bg-yellow-50" : ""}>
                  <td className="border border-gray-200 px-1.5 py-0.5">
                    {format(new Date(h.timestamp * 1000), "MM-dd HH:mm")}
                  </td>
                  <td className="border border-gray-200 px-1.5 py-0.5 text-right">{h.temperature.toFixed(1)}°C</td>
                  <td className="border border-gray-200 px-1.5 py-0.5 text-right">{h.cloud_cover}%</td>
                  <td className="border border-gray-200 px-1.5 py-0.5 text-right">{(h.visibility / 1000).toFixed(1)}km</td>
                  <td className="border border-gray-200 px-1.5 py-0.5 text-right">{h.wind_speed.toFixed(1)}m/s</td>
                  <td className="border border-gray-200 px-1.5 py-0.5 text-right">{windDirLabel(h.wind_direction)}</td>
                  <td className="border border-gray-200 px-1.5 py-0.5 text-right">{h.pressure.toFixed(0)}</td>
                  <td className="border border-gray-200 px-1.5 py-0.5 text-right">{h.dewpoint.toFixed(1)}°C</td>
                  <td className="border border-gray-200 px-1.5 py-0.5 text-center">
                    {ducting === "high" && <span className="text-red-600 font-bold">높음</span>}
                    {ducting === "moderate" && <span className="text-yellow-600 font-semibold">보통</span>}
                    {ducting === "low" && <span className="text-green-600">낮음</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {hourlyData.length > 48 && (
          <p className="mt-1 text-[8px] text-gray-400">* 48시간 초과 데이터는 생략됨</p>
        )}
      </div>

      {/* 덕팅 위험 분석 */}
      {ductingHours.length > 0 && (
        <div className="rounded border border-yellow-300 bg-yellow-50 p-3">
          <h3 className="text-[11px] font-semibold text-yellow-800 mb-1">덕팅 가능 시간대 ({ductingHours.length}시간)</h3>
          <p className="text-[9px] text-yellow-700">
            온도-이슬점 차가 5°C 미만이고 해면기압이 높은 시간대에 전파 덕팅 현상이 발생할 수 있으며,
            이로 인해 레이더 탐지 범위가 비정상적으로 확장될 수 있습니다.
          </p>
          <div className="mt-1.5 text-[8px] text-yellow-600">
            시간대: {ductingHours.slice(0, 10).map((h) =>
              format(new Date(h.timestamp * 1000), "MM-dd HH시")
            ).join(", ")}
            {ductingHours.length > 10 && ` 외 ${ductingHours.length - 10}시간`}
          </div>
        </div>
      )}
    </div>
  );
}
