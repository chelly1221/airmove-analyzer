import { useState, useCallback, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Upload,
  Map,
  PencilRuler,
  BarChart3,
  FileText,
  Settings,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Loader2,
  PlaneTakeoff,
  PlaneLanding,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { format } from "date-fns";
import { ko } from "date-fns/locale";
import { useAppStore } from "../../store";
import type { FlightRecord, PageId } from "../../types";

interface NavItem {
  id: PageId;
  label: string;
  icon: LucideIcon;
  path: string;
}

const navItems: NavItem[] = [
  { id: "upload", label: "자료 업로드", icon: Upload, path: "/" },
  { id: "map", label: "항적 지도", icon: Map, path: "/map" },
  { id: "drawing", label: "도면", icon: PencilRuler, path: "/drawing" },
  { id: "analysis", label: "통계/분석", icon: BarChart3, path: "/analysis" },
  { id: "report", label: "보고서 생성", icon: FileText, path: "/report" },
];

const settingsItem: NavItem = {
  id: "settings", label: "설정", icon: Settings, path: "/settings",
};

// ─── 항적지도 탭: 운항이력 패널 ──────────────────────────────────────

function MapFlightPanel() {
  const aircraft = useAppStore((s) => s.aircraft);
  const flightHistory = useAppStore((s) => s.flightHistory);
  const selectedFlight = useAppStore((s) => s.selectedFlight);
  const setSelectedFlight = useAppStore((s) => s.setSelectedFlight);
  const openskySync = useAppStore((s) => s.openskySync);
  const openskySyncProgress = useAppStore((s) => s.openskySyncProgress);

  const activeAircraft = useMemo(
    () => aircraft.filter((a) => a.active && a.mode_s_code),
    [aircraft]
  );

  const [selectedAcId, setSelectedAcId] = useState<string | "__ALL__">("__ALL__");
  const [dropdownOpen, setDropdownOpen] = useState(false);

  // 선택된 항공기에 따른 비행 기록 필터 (최신순)
  const flights = useMemo(() => {
    if (selectedAcId === "__ALL__") {
      return [...flightHistory].sort((a, b) => b.first_seen - a.first_seen);
    }
    const ac = activeAircraft.find((a) => a.id === selectedAcId);
    if (!ac) return [];
    const ms = ac.mode_s_code.toLowerCase();
    return flightHistory
      .filter((f) => f.icao24.toLowerCase() === ms)
      .sort((a, b) => b.first_seen - a.first_seen);
  }, [selectedAcId, activeAircraft, flightHistory]);

  // 선택 항공기 이름
  const selectedLabel = selectedAcId === "__ALL__"
    ? "전체"
    : activeAircraft.find((a) => a.id === selectedAcId)?.name ?? "전체";

  // icao24 → 항공기 이름 매핑
  const icaoToName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const ac of activeAircraft) {
      m[ac.mode_s_code.toLowerCase()] = ac.name;
    }
    return m;
  }, [activeAircraft]);

  const handleSelect = (f: FlightRecord) => {
    const isSame =
      selectedFlight?.icao24 === f.icao24 &&
      selectedFlight?.first_seen === f.first_seen;
    setSelectedFlight(isSame ? null : f);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 헤더: 항공기 드롭다운 + 동기화 상태 */}
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <div className="relative flex-1">
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex w-full items-center justify-between rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] font-medium text-gray-700 hover:border-gray-300 transition-colors"
          >
            <span className="truncate">{selectedLabel}</span>
            <ChevronDown size={12} className={`shrink-0 text-gray-400 transition-transform ${dropdownOpen ? "rotate-180" : ""}`} />
          </button>
          {dropdownOpen && (
            <div className="absolute left-0 right-0 top-full z-20 mt-0.5 rounded-md border border-gray-200 bg-white shadow-lg py-0.5">
              <button
                onClick={() => { setSelectedAcId("__ALL__"); setDropdownOpen(false); }}
                className={`w-full px-2 py-1 text-left text-[11px] hover:bg-gray-50 ${selectedAcId === "__ALL__" ? "font-semibold text-[#a60739]" : "text-gray-600"}`}
              >
                전체 ({flightHistory.length})
              </button>
              {activeAircraft.map((ac) => {
                const count = flightHistory.filter(
                  (f) => f.icao24.toLowerCase() === ac.mode_s_code.toLowerCase()
                ).length;
                return (
                  <button
                    key={ac.id}
                    onClick={() => { setSelectedAcId(ac.id); setDropdownOpen(false); }}
                    className={`w-full px-2 py-1 text-left text-[11px] hover:bg-gray-50 ${selectedAcId === ac.id ? "font-semibold text-[#a60739]" : "text-gray-600"}`}
                  >
                    {ac.name}
                    <span className="ml-1 text-gray-400">({count})</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {openskySync && (
          <Loader2 size={12} className="shrink-0 animate-spin text-[#a60739]" />
        )}
      </div>

      {/* 동기화 진행상태/에러 */}
      {openskySyncProgress && (
        <div className="px-2 pb-1">
          <p className={`text-[10px] truncate ${
            openskySyncProgress.includes("확인하세요") ? "text-red-500" : "text-gray-400"
          }`}>{openskySyncProgress}</p>
        </div>
      )}

      {/* 비행 목록 */}
      <div className="flex-1 overflow-y-auto px-1.5 pb-2 scrollbar-thin">
        {flights.length === 0 ? (
          <div className="py-6 text-center text-[11px] text-gray-400">
            {openskySync ? "조회 중..." : "운항 기록 없음"}
          </div>
        ) : (
          <div className="space-y-0.5">
            {flights.map((f) => {
              const isSelected =
                selectedFlight?.icao24 === f.icao24 &&
                selectedFlight?.first_seen === f.first_seen;
              const date = new Date(f.first_seen * 1000);
              const dur = Math.round((f.last_seen - f.first_seen) / 60);
              const acName = selectedAcId === "__ALL__"
                ? icaoToName[f.icao24.toLowerCase()]
                : undefined;
              return (
                <button
                  key={`${f.icao24}_${f.first_seen}`}
                  onClick={() => handleSelect(f)}
                  className={`w-full rounded-md px-2 py-1.5 text-left transition-colors ${
                    isSelected
                      ? "bg-[#a60739]/10 ring-1 ring-[#a60739]/30"
                      : "hover:bg-gray-50"
                  }`}
                >
                  {/* 날짜 + 콜사인/항공기명 */}
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-gray-700">
                      {format(date, "M/d (EEE)", { locale: ko })}
                    </span>
                    <span className="text-[10px] font-mono text-gray-400">
                      {acName ?? f.callsign?.trim() ?? "—"}
                    </span>
                  </div>
                  {/* 시각 + 구간 */}
                  <div className="mt-0.5 flex items-center gap-1 text-[10px] text-gray-500">
                    <span>{format(date, "HH:mm")}</span>
                    <span className="text-gray-300">·</span>
                    <span>{dur}분</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1 text-[10px]">
                    <PlaneTakeoff size={9} className="text-gray-400" />
                    <span className="font-mono text-gray-600">
                      {f.est_departure_airport || "?"}
                    </span>
                    <span className="text-gray-300 mx-0.5">&rarr;</span>
                    <PlaneLanding size={9} className="text-gray-400" />
                    <span className="font-mono text-gray-600">
                      {f.est_arrival_airport || "?"}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── 사이드바 메인 ───────────────────────────────────────────────────

export default function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const setActivePage = useAppStore((s) => s.setActivePage);
  const [collapsed, setCollapsed] = useState(false);
  const [edgeHover, setEdgeHover] = useState(false);
  const [mouseY, setMouseY] = useState(0);

  const handleNav = (item: NavItem) => {
    setActivePage(item.id);
    navigate(item.path);
  };

  const isActive = (item: NavItem) => {
    if (item.path === "/") return location.pathname === "/";
    return location.pathname.startsWith(item.path);
  };

  const handleEdgeMove = useCallback((e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setMouseY(e.clientY - rect.top);
  }, []);

  // 현재 페이지에 따른 하단 패널
  const isMapPage = location.pathname === "/map";

  return (
    <div className="relative flex h-full shrink-0">
      <aside
        className={`flex h-full flex-col bg-white transition-[width] duration-200 ${
          collapsed ? "w-14" : "w-56"
        }`}
      >
        {/* App header + 설정 */}
        <div className="flex h-8 shrink-0 items-center px-2" data-tauri-drag-region>
          <button
            onClick={() => handleNav(settingsItem)}
            title="설정"
            className={`flex h-6 items-center gap-1.5 rounded px-1.5 text-xs font-medium transition-colors pointer-events-auto ${
              isActive(settingsItem)
                ? "text-[#a60739]"
                : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            }`}
          >
            <Settings size={12} className="shrink-0" />
            {!collapsed && <span>설정</span>}
          </button>
        </div>

        {/* Navigation */}
        <nav className="px-2 py-2">
          <div className="space-y-1">
            {navItems.map((item) => {
              const active = isActive(item);
              return (
                <button
                  key={item.id}
                  onClick={() => handleNav(item)}
                  title={collapsed ? item.label : undefined}
                  className={`flex w-full items-center rounded-lg py-2.5 text-sm font-medium transition-all ${
                    collapsed ? "justify-center px-0" : "gap-3 px-3"
                  } ${
                    active
                      ? "bg-[#a60739] text-white shadow-sm"
                      : "text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                  }`}
                >
                  <item.icon size={18} className="shrink-0" />
                  {!collapsed && <span className="whitespace-nowrap">{item.label}</span>}
                </button>
              );
            })}
          </div>
        </nav>

        {/* 탭별 하단 컨텍스트 패널 */}
        {!collapsed && isMapPage && (
          <div className="flex flex-1 flex-col overflow-hidden border-t border-gray-100">
            <MapFlightPanel />
          </div>
        )}
      </aside>

      {/* 경계선 호버 토글 - 마우스 Y 위치 추적 */}
      <div
        className="absolute right-0 top-0 bottom-0 z-10 w-5 -mr-2.5 cursor-pointer"
        onMouseEnter={() => setEdgeHover(true)}
        onMouseLeave={() => setEdgeHover(false)}
        onMouseMove={handleEdgeMove}
        onClick={() => setCollapsed(!collapsed)}
      >
        <div
          className={`absolute left-1/2 -translate-x-1/2 flex h-8 w-5 items-center justify-center rounded-full border border-gray-300 bg-white shadow transition-all duration-150 ${
            edgeHover ? "opacity-100 scale-100" : "opacity-0 scale-75"
          }`}
          style={{ top: Math.max(16, Math.min(mouseY - 16, 9999)) }}
        >
          {collapsed
            ? <ChevronRight size={12} className="text-gray-500" />
            : <ChevronLeft size={12} className="text-gray-500" />
          }
        </div>
      </div>
    </div>
  );
}
