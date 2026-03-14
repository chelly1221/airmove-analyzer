import { Routes, Route, useLocation } from "react-router-dom";
import Titlebar from "./components/Layout/Titlebar";
import Sidebar from "./components/Layout/Sidebar";
import Settings from "./pages/Settings";
import FileUpload from "./pages/FileUpload";
import TrackMap from "./pages/TrackMap";
import LossAnalysis from "./pages/LossAnalysis";
import ReportGeneration from "./pages/ReportGeneration";
import Drawing from "./pages/Drawing";
import { useAppStore } from "./store";
import { Loader2 } from "lucide-react";

export default function App() {
  const loading = useAppStore((s) => s.loading);
  const loadingMessage = useAppStore((s) => s.loadingMessage);
  const location = useLocation();
  const isMapPage = location.pathname === "/map";

  return (
    <div className="flex h-full flex-col bg-[#1a1a2e]">
      <Titlebar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="relative flex-1 overflow-hidden">
          {/* TrackMap은 항상 마운트 - 탭 전환 시 상태 유지 */}
          <div className={isMapPage ? "h-full" : "hidden"}>
            <TrackMap />
          </div>
          {!isMapPage && (
            <div className="h-full overflow-auto">
              <Routes>
                <Route
                  path="/settings"
                  element={
                    <PageWrapper>
                      <Settings />
                    </PageWrapper>
                  }
                />
                <Route
                  path="/"
                  element={
                    <PageWrapper>
                      <FileUpload />
                    </PageWrapper>
                  }
                />
                <Route path="/map" element={null} />
                <Route
                  path="/drawing"
                  element={
                    <PageWrapper>
                      <Drawing />
                    </PageWrapper>
                  }
                />
                <Route
                  path="/analysis"
                  element={
                    <PageWrapper>
                      <LossAnalysis />
                    </PageWrapper>
                  }
                />
                <Route
                  path="/report"
                  element={
                    <PageWrapper>
                      <ReportGeneration />
                    </PageWrapper>
                  }
                />
              </Routes>
            </div>
          )}
        </main>
      </div>

      {/* Global loading overlay */}
      {loading && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-xl bg-[#16213e] p-8 shadow-2xl">
            <Loader2 size={32} className="animate-spin text-[#e94560]" />
            <p className="text-sm text-gray-300">
              {loadingMessage || "처리 중..."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/** 페이지 래퍼 - 패딩과 스크롤 */
function PageWrapper({ children }: { children: React.ReactNode }) {
  return <div className="h-full overflow-auto p-6">{children}</div>;
}
