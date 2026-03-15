import { useNavigate } from "react-router-dom";
import {
  Plane,
  Upload,
  Map,
  BarChart3,
  Activity,
  AlertTriangle,
  Clock,
} from "lucide-react";
import { format } from "date-fns";
import Card from "../components/common/Card";
import { SimpleCard } from "../components/common/Card";
import { useAppStore } from "../store";
import { flightLabel } from "../utils/flightConsolidation";

export default function Dashboard() {
  const navigate = useNavigate();
  const flights = useAppStore((s) => s.flights);
  const aircraft = useAppStore((s) => s.aircraft);
  const setActivePage = useAppStore((s) => s.setActivePage);

  const totalFlights = flights.length;
  const totalLossSegments = flights.reduce(
    (sum, f) => sum + f.loss_segments.length,
    0
  );
  const avgLossPercentage =
    totalFlights > 0
      ? flights.reduce((sum, f) => sum + f.loss_percentage, 0) /
        totalFlights
      : 0;
  const totalTrackTime = flights.reduce(
    (sum, f) => sum + f.total_track_time,
    0
  );

  const handleQuickAction = (page: string, path: string) => {
    setActivePage(page as "settings" | "upload" | "map" | "analysis");
    navigate(path);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-800">대시보드</h1>
        <p className="mt-1 text-sm text-gray-500">
          레이더 비행검사기 분석체계 현황
        </p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card
          title="분석 비행 수"
          value={totalFlights}
          subtitle="식별된 비행"
          icon={Activity}
          accent="#3b82f6"
        />
        <Card
          title="Loss 구간 수"
          value={totalLossSegments}
          subtitle="탐지된 전체 Loss"
          icon={AlertTriangle}
          accent="#a60739"
        />
        <Card
          title="평균 Loss 비율"
          value={`${avgLossPercentage.toFixed(1)}%`}
          subtitle="전체 비행 대비"
          icon={BarChart3}
          accent="#f59e0b"
        />
        <Card
          title="총 추적 시간"
          value={`${(totalTrackTime / 60).toFixed(0)}분`}
          subtitle="전체 트랙 데이터"
          icon={Clock}
          accent="#10b981"
        />
      </div>

      {/* Quick Actions */}
      <SimpleCard>
        <h2 className="mb-4 text-base font-semibold text-gray-800">빠른 실행</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <button
            onClick={() => handleQuickAction("settings", "/settings")}
            className="flex flex-col items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-4 text-gray-600 transition-all hover:border-[#3b82f6]/50 hover:bg-gray-100 hover:text-gray-900"
          >
            <Plane size={24} />
            <span className="text-xs">검사기 관리</span>
          </button>
          <button
            onClick={() => handleQuickAction("upload", "/upload")}
            className="flex flex-col items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-4 text-gray-600 transition-all hover:border-[#3b82f6]/50 hover:bg-gray-100 hover:text-gray-900"
          >
            <Upload size={24} />
            <span className="text-xs">자료 업로드</span>
          </button>
          <button
            onClick={() => handleQuickAction("map", "/map")}
            className="flex flex-col items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-4 text-gray-600 transition-all hover:border-[#3b82f6]/50 hover:bg-gray-100 hover:text-gray-900"
          >
            <Map size={24} />
            <span className="text-xs">항적 지도</span>
          </button>
          <button
            onClick={() => handleQuickAction("analysis", "/analysis")}
            className="flex flex-col items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-4 text-gray-600 transition-all hover:border-[#3b82f6]/50 hover:bg-gray-100 hover:text-gray-900"
          >
            <BarChart3 size={24} />
            <span className="text-xs">Loss 분석</span>
          </button>
        </div>
      </SimpleCard>

      {/* Recent Results + Aircraft */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Recent Analysis */}
        <SimpleCard>
          <h2 className="mb-4 text-base font-semibold text-gray-800">
            최근 분석 결과
          </h2>
          {flights.length === 0 ? (
            <div className="flex flex-col items-center py-8 text-gray-500">
              <Activity size={32} className="mb-2 opacity-50" />
              <p className="text-sm">분석 결과가 없습니다</p>
              <p className="text-xs mt-1">ASS 파일을 업로드하여 분석을 시작하세요</p>
            </div>
          ) : (
            <div className="space-y-2">
              {flights.slice(-5).reverse().map((f) => (
                <div
                  key={`result-${f.id}`}
                  className="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50 px-4 py-3"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-800">
                      {flightLabel(f, aircraft)}
                    </p>
                    <p className="text-xs text-gray-500">
                      {format(
                        new Date(f.start_time * 1000),
                        "yyyy-MM-dd HH:mm"
                      )}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-[#a60739]">
                      {f.loss_percentage.toFixed(1)}%
                    </p>
                    <p className="text-xs text-gray-500">
                      Loss {f.loss_segments.length}건
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SimpleCard>

        {/* Aircraft List */}
        <SimpleCard>
          <h2 className="mb-4 text-base font-semibold text-gray-800">
            등록 비행검사기
          </h2>
          {aircraft.length === 0 ? (
            <div className="flex flex-col items-center py-8 text-gray-500">
              <Plane size={32} className="mb-2 opacity-50" />
              <p className="text-sm">등록된 비행검사기가 없습니다</p>
              <p className="text-xs mt-1">비행검사기 관리에서 등록하세요</p>
            </div>
          ) : (
            <div className="space-y-2">
              {aircraft.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50 px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`h-2 w-2 rounded-full ${a.active ? "bg-green-500" : "bg-gray-400"}`}
                    />
                    <div>
                      <p className="text-sm font-medium text-gray-800">
                        {a.name}
                      </p>
                      <p className="text-xs text-gray-500">
                        {a.model ? `${a.model} · ${a.organization}` : a.organization}
                      </p>
                    </div>
                  </div>
                  <span className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-600">
                    {a.mode_s_code}
                  </span>
                </div>
              ))}
            </div>
          )}
        </SimpleCard>
      </div>
    </div>
  );
}
