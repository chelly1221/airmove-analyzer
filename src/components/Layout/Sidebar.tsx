import { useLocation, useNavigate } from "react-router-dom";
import {
  Upload,
  Map,
  PencilRuler,
  BarChart3,
  FileText,
  Settings,
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
  { id: "upload", label: "자료 업로드", icon: Upload, path: "/" },
  { id: "map", label: "항적 지도", icon: Map, path: "/map" },
  { id: "drawing", label: "도면", icon: PencilRuler, path: "/drawing" },
  { id: "analysis", label: "표적소실 분석", icon: BarChart3, path: "/analysis" },
  { id: "report", label: "보고서 생성", icon: FileText, path: "/report" },
];

const settingsItem: NavItem = {
  id: "settings", label: "설정", icon: Settings, path: "/settings",
};

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
      {/* Navigation */}
      <nav className="flex flex-1 flex-col px-3 py-4">
        <div className="flex-1 space-y-1">
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
        </div>
        {/* 설정 - 하단 고정 */}
        <div className="border-t border-white/10 pt-2 mt-2">
          {(() => {
            const active = isActive(settingsItem);
            return (
              <button
                onClick={() => handleNav(settingsItem)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all ${
                  active
                    ? "bg-[#e94560]/15 text-[#e94560]"
                    : "text-gray-400 hover:bg-white/5 hover:text-gray-200"
                }`}
              >
                <settingsItem.icon size={18} />
                <span>{settingsItem.label}</span>
                {active && (
                  <div className="ml-auto h-1.5 w-1.5 rounded-full bg-[#e94560]" />
                )}
              </button>
            );
          })()}
        </div>
      </nav>

    </aside>
  );
}
