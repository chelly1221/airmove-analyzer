import { useEffect, useRef } from "react";
import { Routes, Route, useLocation } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Titlebar from "./components/Layout/Titlebar";
import Sidebar from "./components/Layout/Sidebar";
import Settings from "./pages/Settings";
import FileUpload from "./pages/FileUpload";
import Guide from "./pages/Guide";
import TrackMap from "./pages/TrackMap";
import LoSObstacle from "./pages/LoSObstacle";
import AsterixAnalysis from "./pages/AsterixAnalysis";
import AsterixStatDetail from "./pages/AsterixStatDetail";
import DualTargetAnalysis from "./pages/DualTargetAnalysis";
import ReportGeneration from "./pages/ReportGeneration";
import AircraftManagement from "./pages/AircraftManagement";
import RadarManagement from "./pages/RadarManagement";
import { useAppStore } from "./store";
import { writeReportPayload, readGenerateRequest, clearGenerateRequest } from "./utils/reportTransfer";
import { readBulkJson } from "./utils/bulkIpc";
import type { BulkRef } from "./utils/bulkIpc";
import SourceOverlay from "./dev/SourceOverlay";
import { ToastContainer } from "./components/common/Toast";
import TourHost from "./tour/TourHost";
import { Loader2 } from "lucide-react";
import type { Aircraft, RadarSite } from "./types";
import type { MultiCoverageResult } from "./utils/radarCoverage";

// 설정 복원 완료 신호 — report:generate 처리가 스토어(radarSite/reportMetadata)를 복원 전
//   기본값(김포 #1·기본 메타) 상태에서 읽어 잘못된 표지/머리말로 페이로드를 조립하지 않도록,
//   processRequest 가 이 promise 를 await 한다. (복원 실패 시에도 resolve — 무한 대기 방지)
let resolveRestoreDone: () => void = () => {};
const restoreDone = new Promise<void>((r) => { resolveRestoreDone = r; });

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
            // 스냅샷 재해석 — selected_radar_site 는 저장 시점 스냅샷이라 이후 편집분이 빠져 있다.
            // 위 키 순서상 목록(custom_radar_sites)이 먼저 로드돼 있으므로 이름으로 최신 항목을 찾아 쓴다
            // (삭제된 사이트는 목록에 없으므로 스냅샷 폴백). setRadarSite 로 재영속 → 스냅샷 자가 치유
            const parsed: RadarSite = JSON.parse(value);
            const resolved = useAppStore.getState().customRadarSites.find((s) => s.name === parsed.name) ?? parsed;
            useAppStore.getState().setRadarSite(resolved);
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
          // 캐시 JSON(수십 MB)은 bulk:// 파일 매개 수신 (bulkIpc.ts)
          const cachedRef = await invoke<BulkRef | null>("load_coverage_cache", { radarName: rs.name });
          if (cachedRef) {
            useAppStore.setState({ coverageData: await readBulkJson<MultiCoverageResult>(cachedRef) });
          }
        } catch {}
      }
    };

    restore().finally(() => resolveRestoreDone());
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

/**
 * 보고서 창의 생성 요청(report:generate) 수신 — 메인 창 상시 마운트 리스너.
 * 라우트 페이지(ReportGeneration)에 두면 분석(수 분) 중 페이지 이동 시 리스너가 해제되어
 * emit 이 유실되고 보고서 창이 transfer 단계에서 영구 대기하므로, App 셸에서 항상 수신한다.
 * 등록 시점에는 IDB 의 미처리 생성 요청(REQUEST_KEY)을 1회 확인해 유실된 요청을 복구한다.
 * 요청 처리: 보고서 창이 산출한 omData 에 메인 창 스토어의 레이더/메타데이터를 더해
 * 최종 페이로드를 조립 → IDB 저장 → report:data-written emit.
 */
function useReportGenerateListener() {
  const processingRef = useRef(false);
  const rerunRef = useRef(false);

  useEffect(() => {
    const processRequest = async () => {
      // 처리 중 새 emit 도착 → 현재 처리 종료 후 IDB 재확인 (요청 누락 방지)
      if (processingRef.current) {
        rerunRef.current = true;
        return;
      }
      processingRef.current = true;
      try {
        // 설정 복원(selected_radar_site/report_metadata) 완료 보장 — 복원 전 기본값으로
        //   페이로드가 조립되는 것을 방지 (요청은 clear 후 재조립 기회가 없으므로 필수)
        await restoreDone;
        do {
          rerunRef.current = false;
          const req = await readGenerateRequest();
          if (!req) break;
          await clearGenerateRequest();
          if (!req.omData) continue;
          const { radarSite, reportMetadata } = useAppStore.getState();
          useAppStore.setState({ loading: true, loadingMessage: "보고서 데이터 저장 중..." });
          await writeReportPayload({
            template: "obstacle_monthly",
            sections: req.sections,
            coverTitle: "장애물 월간 분석 보고서",
            radarSite,
            reportMetadata,
            omData: req.omData,
          });
          // 이미 열려있는 보고서 창에 data-written 이벤트 전달
          await emit("report:data-written");
        } while (rerunRef.current);
      } catch (e) {
        console.error("[App] report:generate 처리 실패:", e);
        // 보고서 창에 에러 전달 — 로딩 화면에서 벗어날 수 있도록
        try {
          await emit("report:data-error", { message: e instanceof Error ? e.message : String(e) });
        } catch { /* ignore */ }
      } finally {
        useAppStore.setState({ loading: false, loadingMessage: "" });
        processingRef.current = false;
      }
    };

    const unlisten = listen("report:generate", processRequest);

    // 유실 요청 복구 — 리스너 부재 중(메인 창 리로드 등) 도착한 미처리 요청 1회 확인.
    // 복원 완료는 processRequest 의 await restoreDone 이 보장 — 1초는 스케줄링 여유일 뿐.
    // 보고서 창이 살아있을 때만 처리한다.
    const recoveryTimer = window.setTimeout(async () => {
      try {
        const req = await readGenerateRequest();
        if (!req) return;
        const reportWin = (await getAllWebviewWindows()).find((w) => w.label === "report");
        if (reportWin) {
          await processRequest();
        } else {
          // 보고서 창이 없는 고아 요청(이전 세션 잔재) — 정리만 수행
          await clearGenerateRequest();
        }
      } catch (e) {
        console.error("[App] 미처리 보고서 생성 요청 복구 실패:", e);
      }
    }, 1000);

    return () => {
      window.clearTimeout(recoveryTimer);
      unlisten.then((fn) => fn());
    };
  }, []);
}

export default function App() {
  const loading = useAppStore((s) => s.loading);
  const loadingMessage = useAppStore((s) => s.loadingMessage);
  const location = useLocation();
  const isMapPage = location.pathname === "/map";

  useRestoreSettings();
  useCloseAllOnExit();
  useReportGenerateListener();

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
                <Route path="/guide" element={<PageWrapper><Guide /></PageWrapper>} />
                <Route path="/map" element={null} />
                <Route path="/obstacle" element={<PageWrapper><LoSObstacle /></PageWrapper>} />
                {/* 통계 상세는 :tab? 보다 먼저 — 토픽 파라미터 1개짜리 단일 라우트(토픽 전환 시 필터 보존) */}
                <Route path="/asterix/stats/:topic" element={<PageWrapper><AsterixStatDetail /></PageWrapper>} />
                {/* 옵셔널 탭 파라미터(stats/frames) — 단일 라우트 유지(탭 전환 시 리마운트 방지) */}
                <Route path="/asterix/:tab?" element={<PageWrapper><AsterixAnalysis /></PageWrapper>} />
                <Route path="/dualtarget" element={<PageWrapper><DualTargetAnalysis /></PageWrapper>} />
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
      <TourHost window="main" />

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
