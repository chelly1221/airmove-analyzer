import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Upload,
  Map as MapIcon,
  PencilRuler,
  FileText,
  Plane,
  Radio,
  Pencil,
  Eye,
  MapPin,
  ExternalLink,
  Loader2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Modal from "../common/Modal";
import { useAppStore } from "../../store";
import type { PageId } from "../../types";

interface NavItem {
  id: PageId;
  label: string;
  icon: LucideIcon;
  path: string;
}

interface NavEntry {
  type: "item";
  item: NavItem;
}

interface NavGroup {
  type: "group";
  label: string;
  items: NavItem[];
}

type NavSection = NavEntry | NavGroup;

const navSections: NavSection[] = [
  { type: "item", item: { id: "upload", label: "자료 관리", icon: Upload, path: "/" } },
  {
    type: "group",
    label: "항적 시각화",
    items: [
      { id: "map", label: "3D 지도", icon: MapIcon, path: "/map" },
      { id: "drawing", label: "2D 항적도", icon: PencilRuler, path: "/drawing" },
    ],
  },
  {
    type: "group",
    label: "분석",
    items: [
      { id: "obstacle", label: "LoS 장애물", icon: Eye, path: "/obstacle" },
      { id: "report", label: "보고서", icon: FileText, path: "/report" },
    ],
  },
  {
    type: "group",
    label: "관리",
    items: [
      { id: "aircraft", label: "비행검사기", icon: Plane, path: "/aircraft" },
      { id: "radar", label: "레이더", icon: Radio, path: "/radar" },
    ],
  },
];

// ─── 보고서 탭: 메타데이터 패널 ──────────────────────────────────────

function ReportMetadataPanel() {
  const reportMetadata = useAppStore((s) => s.reportMetadata);
  const setReportMetadata = useAppStore((s) => s.setReportMetadata);
  const [modalOpen, setModalOpen] = useState(false);

  const fields = [
    { label: "기관", value: reportMetadata.organization },
    { label: "부서", value: reportMetadata.department },
    { label: "현장", value: reportMetadata.siteName },
    { label: "문서접두", value: reportMetadata.docPrefix },
  ];

  return (
    <>
      <div className="flex flex-col gap-0.5 px-2 py-1.5">
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">보고서 메타데이터</span>
          <button
            onClick={() => setModalOpen(true)}
            className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
            title="메타데이터 수정"
          >
            <Pencil size={11} />
          </button>
        </div>
        {fields.map(({ label, value }) => (
          <div key={label} className="flex items-center justify-between px-2 py-0.5">
            <span className="text-[11px] text-gray-400">{label}</span>
            <span className="text-[11px] font-medium text-gray-600 truncate ml-2 max-w-[120px]">{value}</span>
          </div>
        ))}
      </div>

      {modalOpen && (
        <ReportMetadataModal
          metadata={reportMetadata}
          onSave={(meta) => { setReportMetadata(meta); setModalOpen(false); }}
          onClose={() => setModalOpen(false)}
        />
      )}
    </>
  );
}

function ReportMetadataModal({
  metadata,
  onSave,
  onClose,
}: {
  metadata: { department: string; docPrefix: string; organization: string; siteName: string; footer: string };
  onSave: (meta: Partial<typeof metadata>) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState({ ...metadata });

  const fields: { key: keyof typeof form; label: string; placeholder: string }[] = [
    { key: "organization", label: "기관명", placeholder: "예: 김포공항" },
    { key: "department", label: "부서명", placeholder: "예: 레이더관제부" },
    { key: "siteName", label: "현장명", placeholder: "예: 레이더송신소" },
    { key: "docPrefix", label: "문서번호 접두사", placeholder: "예: RDR-RPT" },
    { key: "footer", label: "하단 푸터", placeholder: "보고서 하단 문구" },
  ];

  return (
    <Modal open onClose={onClose} title="보고서 기본 메타데이터" width="max-w-md">
      <div className="space-y-3">
        {fields.map(({ key, label, placeholder }) => (
          <div key={key}>
            <label className="mb-1 block text-xs font-medium text-gray-600">{label}</label>
            <input
              type="text"
              value={form[key]}
              onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
              placeholder={placeholder}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800 placeholder:text-gray-400 focus:border-[#a60739] focus:outline-none focus:ring-1 focus:ring-[#a60739]/20"
            />
          </div>
        ))}
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
          >
            취소
          </button>
          <button
            onClick={() => onSave(form)}
            className="rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white hover:bg-[#85062e] transition-colors"
          >
            저장
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── 전파 장애물 (파노라마) 패널 ─────────────────────────────────────

function PanoramaObstaclePanel() {
  const pt = useAppStore((s) => s.panoramaActivePoint);
  const pinned = useAppStore((s) => s.panoramaPinned);

  if (!pt) {
    return (
      <div className="flex flex-col items-center justify-center gap-1.5 py-4 text-center">
        <Eye size={16} className="text-gray-300" />
        <p className="text-[10px] text-gray-400">
          차트 위를 호버하거나 클릭하여<br />장애물 정보를 확인하세요
        </p>
      </div>
    );
  }

  const isBuilding = pt.obstacle_type !== "terrain";
  const typeLabel =
    pt.obstacle_type === "terrain" ? "지형"
    : pt.obstacle_type === "gis_building" ? "건물통합정보"
    : "수동 건물";
  const typeColor =
    pt.obstacle_type === "terrain" ? "bg-green-100 text-green-700"
    : pt.obstacle_type === "gis_building" ? "bg-orange-100 text-orange-700"
    : "bg-red-100 text-red-700";
  const elevASL = isBuilding
    ? pt.ground_elev_m + pt.obstacle_height_m
    : pt.ground_elev_m;

  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      {/* 유형 뱃지 + 이름 + 고정 상태 */}
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={`shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium ${typeColor}`}>
          {typeLabel}
        </span>
        {pinned && (
          <span className="shrink-0 whitespace-nowrap rounded bg-yellow-100 px-1 py-0.5 text-[9px] text-yellow-700">
            고정
          </span>
        )}
        {pt.name && (
          <span className="min-w-0 text-[11px] font-semibold text-gray-800 truncate" title={pt.name}>
            {pt.name}
          </span>
        )}
      </div>

      {/* 공통 수치 — 모든 유형 동일 위치 */}
      <div className="grid grid-cols-3 gap-x-2 gap-y-1">
        <div>
          <span className="text-[9px] text-gray-400">방위</span>
          <p className="font-mono text-[11px] font-medium text-gray-700">{pt.azimuth_deg.toFixed(1)}°</p>
        </div>
        <div>
          <span className="text-[9px] text-gray-400">앙각</span>
          <p className="font-mono text-[11px] font-medium text-gray-700">{pt.elevation_angle_deg.toFixed(3)}°</p>
        </div>
        <div>
          <span className="text-[9px] text-gray-400">거리</span>
          <p className="font-mono text-[11px] font-medium text-gray-700">{pt.distance_km.toFixed(2)} km</p>
        </div>
      </div>

      {/* 높이 정보 — 동일 그리드, 유형별 추가 필드 */}
      <div className="grid grid-cols-3 gap-x-2 gap-y-1">
        <div>
          <span className="text-[9px] text-gray-400">해발고도</span>
          <p className="font-mono text-[11px] font-medium text-gray-700">{elevASL.toFixed(0)} m</p>
        </div>
        <div>
          <span className="text-[9px] text-gray-400">지면표고</span>
          <p className="font-mono text-[11px] font-medium text-gray-700">{pt.ground_elev_m.toFixed(0)} m</p>
        </div>
        {isBuilding ? (
          <div>
            <span className="text-[9px] text-gray-400">건물높이</span>
            <p className="font-mono text-[11px] font-medium text-gray-700">{pt.obstacle_height_m.toFixed(1)} m</p>
          </div>
        ) : (
          <div />
        )}
      </div>

      {/* 좌표 */}
      <div className="flex items-center gap-1 text-[10px] text-gray-500">
        <MapPin size={10} className="shrink-0 text-gray-400" />
        <span className="font-mono">{pt.lat.toFixed(5)}°N {pt.lon.toFixed(5)}°E</span>
      </div>

      {/* 건물 추가 정보: 주소/용도 */}
      {isBuilding && (pt.address || pt.usage) && (
        <div className="border-t border-gray-100 pt-1.5 space-y-0.5">
          {pt.address && (
            <div>
              <span className="text-[9px] text-gray-400">주소</span>
              <p className="text-[10px] text-gray-600 break-words">{pt.address}</p>
            </div>
          )}
          {pt.usage && (
            <div>
              <span className="text-[9px] text-gray-400">용도</span>
              <p className="text-[10px] text-gray-600">{pt.usage}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── 백그라운드 작업 패널 ─────────────────────────────────────────────

function BackgroundTasksPanel() {
  const navigate = useNavigate();
  const setActivePage = useAppStore((s) => s.setActivePage);

  const srtmDownloading = useAppStore((s) => s.srtmDownloading);
  const srtmProgress = useAppStore((s) => s.srtmProgress);
  const n3pDownloading = useAppStore((s) => s.n3pDownloading);
  const n3pProgress = useAppStore((s) => s.n3pProgress);
  const landuseDownloading = useAppStore((s) => s.landuseDownloading);
  const landuseProgress = useAppStore((s) => s.landuseProgress);
  const facBuildingDownloading = useAppStore((s) => s.facBuildingDownloading);
  const facBuildingProgress = useAppStore((s) => s.facBuildingProgress);
  const peakImporting = useAppStore((s) => s.peakImporting);
  const peakImportProgress = useAppStore((s) => s.peakImportProgress);

  // 진행 중인 작업 목록 빌드
  const tasks: { label: string; pct: number }[] = [];

  if (srtmDownloading) {
    const done = srtmProgress ? (srtmProgress.downloaded + (srtmProgress.skipped ?? 0)) : 0;
    const pct = srtmProgress && srtmProgress.total > 0 ? Math.round((done / srtmProgress.total) * 100) : 0;
    tasks.push({ label: "SRTM 다운로드", pct });
  }
  if (n3pDownloading) {
    const pct = n3pProgress && n3pProgress.total > 0 ? Math.round((n3pProgress.current / n3pProgress.total) * 100) : 0;
    tasks.push({ label: "산 이름 다운로드", pct });
  }
  if (landuseDownloading) {
    const pct = landuseProgress && landuseProgress.total > 0 ? Math.round((landuseProgress.current / landuseProgress.total) * 100) : 0;
    tasks.push({ label: "토지이용 다운로드", pct });
  }
  if (facBuildingDownloading) {
    const pct = facBuildingProgress && facBuildingProgress.total > 0 ? Math.round((facBuildingProgress.current / facBuildingProgress.total) * 100) : 0;
    tasks.push({ label: "건물통합정보 다운로드", pct });
  }
  if (peakImporting) {
    const pct = peakImportProgress && peakImportProgress.total > 0 ? Math.round((peakImportProgress.processed / peakImportProgress.total) * 100) : 0;
    tasks.push({ label: "산 데이터 임포트", pct });
  }

  if (tasks.length === 0) return null;

  const goToSettings = () => {
    setActivePage("upload");
    navigate("/");
  };

  return (
    <div
      className="mt-auto border-t border-gray-100 px-2 py-2 cursor-pointer hover:bg-gray-50 transition-colors"
      onClick={goToSettings}
      title="설정 페이지로 이동"
    >
      <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
        백그라운드 작업
      </div>
      <div className="space-y-1.5">
        {tasks.map((t) => (
          <div key={t.label} className="px-1">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1">
                <Loader2 size={10} className="animate-spin text-[#a60739]" />
                <span className="text-[11px] text-gray-600">{t.label}</span>
              </div>
              {t.pct > 0 && (
                <span className="text-[10px] font-mono text-gray-400">{t.pct}%</span>
              )}
            </div>
            <div className="mt-0.5 h-1 w-full rounded-full bg-gray-200 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${t.pct > 0 ? "bg-[#a60739]" : "bg-[#a60739]/40 animate-pulse"}`}
                style={{ width: t.pct > 0 ? `${t.pct}%` : "60%" }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── 사이드바 메인 ───────────────────────────────────────────────────

export default function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const setActivePage = useAppStore((s) => s.setActivePage);

  const handleNav = async (item: NavItem) => {
    // 지도/도면은 별도 창으로 열기
    if (item.id === "map" || item.id === "drawing") {
      const { WebviewWindow, getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow");
      const label = item.id === "map" ? "trackmap" : "drawing";
      const title = item.id === "map" ? "Track Map — AirMove Analyzer" : "Drawing — AirMove Analyzer";
      const existing = (await getAllWebviewWindows()).find((w) => w.label === label);
      if (existing) {
        await existing.setFocus();
      } else {
        new WebviewWindow(label, {
          url: "index.html", title, width: 1400, height: 900,
          minWidth: 1024, minHeight: 768, decorations: false, center: true,
        });
      }
      return;
    }
    setActivePage(item.id);
    navigate(item.path);
  };

  const isActive = (item: NavItem) => {
    if (item.path === "/") return location.pathname === "/";
    return location.pathname.startsWith(item.path);
  };

  // 현재 페이지에 따른 하단 패널
  const isReportPage = location.pathname === "/report";
  const panoramaViewActive = useAppStore((s) => s.panoramaViewActive);

  return (
    <div className="relative flex h-full shrink-0">
      <aside className="flex h-full w-48 flex-col bg-white">
        {/* App header */}
        <div className="flex h-8 shrink-0 items-center" data-tauri-drag-region>
          <div className="flex-1 h-full flex items-center pl-3" data-tauri-drag-region>
            <span className="text-[13px] font-bold tracking-wide text-[#a60739] pointer-events-none">공항감시레이더 종합분석체계</span>
          </div>
        </div>

        {/* Navigation */}
        <nav className="px-2 py-2 space-y-1">
          {navSections.map((section, si) => {
            if (section.type === "item") {
              const item = section.item;
              const active = isActive(item);
              return (
                <button
                  key={item.id}
                  onClick={() => handleNav(item)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all ${
                    active
                      ? "bg-[#a60739] text-white shadow-sm"
                      : "text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                  }`}
                >
                  <item.icon size={18} className="shrink-0" />
                  <span className="whitespace-nowrap">{item.label}</span>
                </button>
              );
            }
            return (
              <div key={`group-${si}`} className={si > 0 ? "pt-2" : ""}>
                <div className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                  {section.label}
                </div>
                <div className="space-y-0.5">
                  {section.items.map((item) => {
                    const active = isActive(item);
                    return (
                      <button
                        key={item.id}
                        onClick={() => handleNav(item)}
                        className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all ${
                          active
                            ? "bg-[#a60739] text-white shadow-sm"
                            : "text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                        }`}
                      >
                        <item.icon size={16} className="shrink-0" />
                        <span className="whitespace-nowrap">{item.label}</span>
                        {(item.id === "map" || item.id === "drawing") && (
                          <ExternalLink size={12} className="ml-auto shrink-0 opacity-40" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>

        {/* 전파 장애물 (파노라마) 활성 시 장애물 정보 패널 */}
        {panoramaViewActive && (
          <div className="border-t border-gray-100 overflow-y-auto">
            <PanoramaObstaclePanel />
          </div>
        )}

        {/* 보고서 탭: 메타데이터 패널 */}
        {isReportPage && (
          <div className="mt-auto border-t border-gray-100">
            <ReportMetadataPanel />
          </div>
        )}

        {/* 백그라운드 작업 진행률 (항상 최하단) */}
        <BackgroundTasksPanel />
      </aside>

      {/* 경계선 */}
      <div className="relative flex-shrink-0 w-px">
        <div className="absolute left-0 top-8 bottom-0 w-px bg-gray-200" />
      </div>
    </div>
  );
}
