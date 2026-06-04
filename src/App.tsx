import { useEffect, useRef } from "react";
import { Routes, Route, useLocation } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Titlebar from "./components/Layout/Titlebar";
import Sidebar from "./components/Layout/Sidebar";
import Settings from "./pages/Settings";
import FileUpload from "./pages/FileUpload";
import TrackMap from "./pages/TrackMap";
import LoSObstacle from "./pages/LoSObstacle";
import AcasAnalysis from "./pages/AcasAnalysis";
import AsterixAnalysis from "./pages/AsterixAnalysis";
import ReportGeneration from "./pages/ReportGeneration";
import AircraftManagement from "./pages/AircraftManagement";
import RadarManagement from "./pages/RadarManagement";
import { useAppStore } from "./store";
import SourceOverlay from "./dev/SourceOverlay";
import { ToastContainer } from "./components/common/Toast";
import { Loader2 } from "lucide-react";
import type { Aircraft, RadarSite, SavedReportSummary } from "./types";

/** 앱 시작 시 DB에서 설정/분석결과 복원 */
function useRestoreSettings() {
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;

    const restore = async () => {
      // 비행검사기 DB 복원
      try {
        const dbAircraft = await invoke<Aircraft[]>("get_aircraft_list");
        if (dbAircraft.length > 0) {
          useAppStore.setState({ aircraft: dbAircraft });
        } else {
          const presets = useAppStore.getState().aircraft;
          for (const a of presets) {
            await invoke("save_aircraft", { aircraft: a }).catch(() => {});
          }
        }
      } catch (e) {
        console.log("[Restore] 비행검사기 복원 실패:", e);
      }

      // 설정 복원 (customRadarSites, radarSite)
      try {
        const settingsToLoad = ["custom_radar_sites", "selected_radar_site", "report_metadata", "dev_mode"];
        for (const key of settingsToLoad) {
          const value = await invoke<string | null>("load_setting", { key });
          if (!value) continue;
          if (key === "custom_radar_sites") {
            const sites: RadarSite[] = JSON.parse(value);
            if (sites.length > 0) useAppStore.getState().setCustomRadarSites(sites);
          } else if (key === "selected_radar_site") {
            const site: RadarSite = JSON.parse(value);
            useAppStore.getState().setRadarSite(site);
          } else if (key === "report_metadata") {
            const meta = JSON.parse(value);
            useAppStore.getState().setReportMetadata(meta);
          } else if (key === "dev_mode") {
            const devMode = JSON.parse(value);
            if (devMode === true) useAppStore.setState({ devMode: true });
          }
        }
      } catch (e) {
        console.log("[Restore] 설정 복원 실패:", e);
      }

      // 저장된 보고서 목록 복원
      try {
        const reports = await invoke<SavedReportSummary[]>("list_saved_reports");
        if (reports.length > 0) {
          useAppStore.setState({ savedReports: reports });
        }
      } catch {}

      // 레이더 커버리지 캐시 존재 여부 확인 (lazy load)
      try {
        const rs = useAppStore.getState().radarSite;
        const hasCoverage = await invoke<boolean>("has_coverage_cache", { radarName: rs.name });
        if (hasCoverage) {
          useAppStore.setState({ coverageCacheAvailable: true });
        }
      } catch {
        try {
          const rs = useAppStore.getState().radarSite;
          const cachedJson = await invoke<string | null>("load_coverage_cache", { radarName: rs.name });
          if (cachedJson) {
            useAppStore.setState({ coverageData: JSON.parse(cachedJson) });
          }
        } catch {}
      }
    };

    restore();
  }, []);
}

/** Main 창 종료 시 모든 자식 창 닫고 프로세스 종료 */
function useCloseAllOnExit() {
  useEffect(() => {
    const appWindow = getCurrentWindow();
    const unlisten = appWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      const allWindows = await getAllWebviewWindows();
      await Promise.all(
        allWindows
          .filter((w) => w.label !== "main")
          .map((w) => w.close().catch(() => w.destroy().catch(() => {})))
      );
      await appWindow.destroy();
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);
}

export default function App() {
  const loading = useAppStore((s) => s.loading);
  const loadingMessage = useAppStore((s) => s.loadingMessage);
  const location = useLocation();
  const isMapPage = location.pathname === "/map";

  useRestoreSettings();
  useCloseAllOnExit();

  return (
    <div className="flex h-full bg-white">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Titlebar />
        <main className="relative flex-1 overflow-hidden border-t border-gray-200">
          {/* TrackMap은 항상 마운트 — offscreen으로 canvas 유지 (보고서 캡처용) */}
          <div className={isMapPage ? "h-full" : "absolute inset-0 -z-10 pointer-events-none opacity-0"}>
            <TrackMap />
          </div>
          {!isMapPage && (
            <div className="h-full overflow-auto">
              <Routes>
                <Route path="/" element={<PageWrapper><FileUpload /></PageWrapper>} />
                <Route path="/map" element={null} />
                <Route path="/obstacle" element={<PageWrapper><LoSObstacle /></PageWrapper>} />
                <Route path="/acas" element={<PageWrapper><AcasAnalysis /></PageWrapper>} />
                <Route path="/asterix" element={<PageWrapper><AsterixAnalysis /></PageWrapper>} />
                <Route path="/report" element={<PageWrapper><ReportGeneration /></PageWrapper>} />
                <Route path="/settings" element={<PageWrapper><Settings /></PageWrapper>} />
                <Route path="/aircraft" element={<PageWrapper><AircraftManagement /></PageWrapper>} />
                <Route path="/radar" element={<PageWrapper><RadarManagement /></PageWrapper>} />
              </Routes>
            </div>
          )}
        </main>
      </div>

      <SourceOverlay />
      <ToastContainer />

      {loading && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-xl bg-white p-8 shadow-2xl border border-gray-200">
            <Loader2 size={32} className="animate-spin text-[#a60739]" />
            <p className="text-sm text-gray-600">{loadingMessage || "처리 중..."}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function PageWrapper({ children }: { children: React.ReactNode }) {
  return <div className="relative h-full overflow-auto p-6">{children}</div>;
}
