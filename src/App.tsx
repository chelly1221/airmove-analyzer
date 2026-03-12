import { Routes, Route } from "react-router-dom";
import Sidebar from "./components/Layout/Sidebar";
import Dashboard from "./pages/Dashboard";
import AircraftManagement from "./pages/AircraftManagement";
import FileUpload from "./pages/FileUpload";
import TrackMap from "./pages/TrackMap";
import LossAnalysis from "./pages/LossAnalysis";
import ReportGeneration from "./pages/ReportGeneration";
import { useAppStore } from "./store";
import { Loader2 } from "lucide-react";

export default function App() {
  const loading = useAppStore((s) => s.loading);
  const loadingMessage = useAppStore((s) => s.loadingMessage);

  return (
    <div className="flex h-full bg-[#1a1a2e]">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <div className="h-full">
          <Routes>
            <Route
              path="/"
              element={
                <PageWrapper>
                  <Dashboard />
                </PageWrapper>
              }
            />
            <Route
              path="/aircraft"
              element={
                <PageWrapper>
                  <AircraftManagement />
                </PageWrapper>
              }
            />
            <Route
              path="/upload"
              element={
                <PageWrapper>
                  <FileUpload />
                </PageWrapper>
              }
            />
            <Route path="/map" element={<TrackMap />} />
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
      </main>

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
