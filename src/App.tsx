import { useEffect, useRef } from "react";
import { Routes, Route, useLocation } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
import type { FlightRecord } from "./types";

/** OpenSky 자동 동기화: 등록 항공기의 최근 5년 운항이력 조회 (최신→과거) */
function useOpenskyAutoSync() {
  const syncVersion = useAppStore((s) => s.openskySyncVersion);
  const syncingRef = useRef(false);
  const lastVersion = useRef(-1);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unlistenRefs = useRef<(() => void)[]>([]);

  useEffect(() => {
    // 이벤트 리스너를 effect 레벨에서 등록 (sync 함수와 독립적으로 유지)
    let cancelled = false;
    const setupListeners = async () => {
      // 증분 결과 리스너 (백엔드가 구간별로 emit → 실시간 UI 업데이트)
      const unlisten1 = await listen<FlightRecord[]>(
        "flight-history-records",
        (event) => {
          if (!cancelled) useAppStore.getState().addFlightHistory(event.payload);
        }
      );
      // 진행 상황 리스너 (구간별 진행률 → 사이드바 표시)
      const unlisten2 = await listen<{ current: number; total: number; icao24: string }>(
        "flight-history-progress",
        (event) => {
          if (cancelled) return;
          const { current, total, icao24 } = event.payload;
          const aircraft = useAppStore.getState().aircraft;
          const ac = aircraft.find((a) => a.mode_s_code.toUpperCase() === icao24.toUpperCase());
          const name = ac?.name ?? icao24;
          useAppStore.getState().setOpenskySyncProgress(`${name} (${current}/${total})`);
        }
      );
      unlistenRefs.current = [unlisten1, unlisten2];
    };
    setupListeners();

    const runSync = async () => {
      if (syncingRef.current) return;

      // 인증정보 확인
      let creds: [string, string];
      try {
        creds = await invoke<[string, string]>("load_opensky_credentials");
      } catch {
        console.log("[OpenSky] 인증정보 로드 실패");
        return;
      }
      if (!creds[0] || !creds[1]) {
        console.log("[OpenSky] 인증정보 미설정");
        return;
      }

      // store에서 최신 aircraft를 직접 읽기 (의존성 배열 문제 회피)
      const activeAircraft = useAppStore.getState().aircraft.filter((a) => a.active && a.mode_s_code);
      if (activeAircraft.length === 0) return;

      syncingRef.current = true;
      useAppStore.getState().setOpenskySync(true);
      const now = Math.floor(Date.now() / 1000);
      const fiveYears = 5 * 365 * 86400;
      let hadRateLimit = false;

      console.log(`[OpenSky] 동기화 시작: ${activeAircraft.length}대, 최근 5년`);

      for (const ac of activeAircraft) {
        if (cancelled) break;
        useAppStore.getState().setOpenskySyncProgress(`${ac.name} 운항이력 동기화 중...`);
        try {
          const records = await invoke<FlightRecord[]>("fetch_flight_history", {
            icao24: ac.mode_s_code,
            begin: now - fiveYears,
            end: now,
          });
          console.log(`[OpenSky] ${ac.name}: ${records.length}건 완료`);
          if (records.length > 0) {
            useAppStore.getState().addFlightHistory(records);
          }
        } catch (e) {
          const msg = String(e);
          console.warn(`[OpenSky] ${ac.name} 동기화 오류:`, msg);
          if (msg.includes("인증정보") || msg.includes("접근 거부")) {
            useAppStore.getState().setOpenskySyncProgress("OpenSky 인증정보를 설정에서 확인하세요");
            break;
          }
          if (msg.includes("rate limit") || msg.includes("429")) {
            hadRateLimit = true;
          }
        }
      }

      useAppStore.getState().setOpenskySync(false);
      useAppStore.getState().setOpenskySyncProgress("");
      syncingRef.current = false;

      // 한도 초과 시 30분 후 자동 재시도
      if (hadRateLimit && !cancelled) {
        console.log("[OpenSky] Rate limit — 30분 후 재시도 예약");
        useAppStore.getState().setOpenskySyncProgress("일일 한도 초과 — 30분 후 재시도");
        retryTimerRef.current = setTimeout(() => {
          useAppStore.getState().setOpenskySyncProgress("");
          runSync();
        }, 30 * 60 * 1000);
      }
    };

    // 초기 마운트 또는 버전 변경 시 동기화
    if (lastVersion.current === syncVersion && lastVersion.current !== -1) return;
    lastVersion.current = syncVersion;
    runSync();

    return () => {
      cancelled = true;
      for (const fn of unlistenRefs.current) fn();
      unlistenRefs.current = [];
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [syncVersion]);
}

export default function App() {
  const loading = useAppStore((s) => s.loading);
  const loadingMessage = useAppStore((s) => s.loadingMessage);
  const location = useLocation();
  const isMapPage = location.pathname === "/map";

  useOpenskyAutoSync();

  return (
    <div className="flex h-full bg-white">
      {/* Sidebar - 타이틀바와 시각적으로 통합, 전체 높이 */}
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Titlebar - 윈도우 컨트롤만 */}
        <Titlebar />
        <main className="relative flex-1 overflow-hidden border-l border-t border-gray-200">
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
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-xl bg-white p-8 shadow-2xl border border-gray-200">
            <Loader2 size={32} className="animate-spin text-[#a60739]" />
            <p className="text-sm text-gray-600">
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
