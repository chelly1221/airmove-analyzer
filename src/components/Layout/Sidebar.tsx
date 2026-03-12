import { useLocation, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Plane,
  Upload,
  Map,
  BarChart3,
  FileText,
  Radar,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAppStore } from "../../store";
import type { PageId } from "../../types";

interface NavItem {
  id: PageId;
  label: string;
  icon: LucideIcon;
  path: string;
}

const navItems: NavItem[] = [
  { id: "dashboard", label: "대시보드", icon: LayoutDashboard, path: "/" },
  { id: "aircraft", label: "비행검사기 관리", icon: Plane, path: "/aircraft" },
  { id: "upload", label: "자료 업로드", icon: Upload, path: "/upload" },
  { id: "map", label: "항적 지도", icon: Map, path: "/map" },
  { id: "analysis", label: "Loss 분석", icon: BarChart3, path: "/analysis" },
  { id: "report", label: "보고서 생성", icon: FileText, path: "/report" },
];

export default function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const setActivePage = useAppStore((s) => s.setActivePage);

  const handleNav = (item: NavItem) => {
    setActivePage(item.id);
    navigate(item.path);
  };

  const isActive = (item: NavItem) => {
    if (item.path === "/") return location.pathname === "/";
    return location.pathname.startsWith(item.path);
  };

  return (
    <aside className="flex h-full w-60 flex-col border-r border-white/10 bg-[#0d1b2a]">
      {/* App title */}
      <div className="flex items-center gap-3 border-b border-white/10 px-5 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#e94560]">
          <Radar size={20} className="text-white" />
        </div>
        <div>
          <h1 className="text-sm font-bold text-white leading-tight">
            NEC 레이더
          </h1>
          <p className="text-xs text-gray-400">분석체계</p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-3 py-4">
        {navItems.map((item) => {
          const active = isActive(item);
          return (
            <button
              key={item.id}
              onClick={() => handleNav(item)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all ${
                active
                  ? "bg-[#e94560]/15 text-[#e94560]"
                  : "text-gray-400 hover:bg-white/5 hover:text-gray-200"
              }`}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
              {active && (
                <div className="ml-auto h-1.5 w-1.5 rounded-full bg-[#e94560]" />
              )}
            </button>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-white/10 px-5 py-4">
        <p className="text-xs text-gray-600">AirMove Analyzer v0.1.0</p>
      </div>
    </aside>
  );
}
