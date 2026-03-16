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
import type { FlightRecord, GarblePoint, ParseStatistics, RadarSite, TrackPoint, WeatherHourly, CloudGridFrame } from "./types";
import { consolidateFlights } from "./utils/flightConsolidation";

/** DB 저장 데이터 타입 */
interface SavedFileInfo {
  path: string;
  name: string;
  filename: string;
  total_records: number;
  start_time: number | null;
  end_time: number | null;
  radar_lat: number;
  radar_lon: number;
  parse_errors: string[];
  parse_stats: ParseStatistics | null;
}

interface SavedParsedData {
  files: SavedFileInfo[];
  track_points: TrackPoint[];
  garble_points?: GarblePoint[];
}

/** 앱 시작 시 DB에서 저장된 파싱 데이터 + 설정 복원 */
function useRestoreSavedData() {
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;

    const restore = async () => {
      // 1) 설정 복원 (customRadarSites, radarSite)
      try {
        const settingsToLoad = ["custom_radar_sites", "selected_radar_site", "report_metadata"];
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
          }
        }
      } catch (e) {
        console.log("[Restore] 설정 복원 실패:", e);
      }

      // 2) 파싱 데이터 복원
      try {
        const data = await invoke<SavedParsedData>("load_saved_data");
        if (data.files.length === 0) return;

        console.log(`[Restore] DB에서 ${data.files.length}개 파일, ${data.track_points.length}개 포인트 복원`);

        const store = useAppStore.getState();

        // uploadedFiles 복원
        for (const f of data.files) {
          store.addUploadedFile({
            path: f.path,
            name: f.name,
            status: "done",
            parsedFile: {
              filename: f.filename,
              total_records: f.total_records,
              track_points: [], // 별도 관리
              parse_errors: f.parse_errors,
              start_time: f.start_time,
              end_time: f.end_time,
              radar_lat: f.radar_lat,
              radar_lon: f.radar_lon,
              parse_stats: f.parse_stats ?? undefined,
              garble_points: [], // 별도 관리
            },
          });

          // parseStatsList 복원
          if (f.parse_stats) {
            store.addParseStats(f.filename, f.parse_stats, f.total_records);
          }
        }

        // rawTrackPoints 복원
        store.appendRawTrackPoints(data.track_points);

        // garblePoints 복원
        if (data.garble_points && data.garble_points.length > 0) {
          console.log(`[Restore] DB에서 ${data.garble_points.length}개 Garble 포인트 복원`);
          store.appendGarblePoints(data.garble_points);
        }

        // 3) flightHistory를 DB에서 먼저 로드 (consolidateFlights 전에 필요)
        try {
          const activeAircraft = useAppStore.getState().aircraft.filter((a) => a.active && a.mode_s_code);
          if (activeAircraft.length > 0) {
            const icao24List = activeAircraft.map((a) => a.mode_s_code.toLowerCase());
            const now = Math.floor(Date.now() / 1000);
            const fiveYears = 5 * 365 * 86400;
            const cached = await invoke<FlightRecord[]>("load_flight_history", {
              icao24List,
              start: now - fiveYears,
              end: now,
            });
            if (cached.length > 0) {
              console.log(`[Restore] DB에서 운항이력 ${cached.length}건 로드`);
              useAppStore.getState().addFlightHistory(cached);
            }
          }
        } catch (e) {
          console.log("[Restore] 운항이력 로드 실패:", e);
        }

        // flights 재생성 (flightHistory 로드 후 consolidateFlights)
        const state = useAppStore.getState();
        const flights = consolidateFlights(
          state.rawTrackPoints,
          state.flightHistory,
          state.aircraft,
          state.radarSite,
        );
        store.setFlights(flights);

        // 4) 기상 데이터 DB 캐시 복원 (비행 시간 범위 기반)
        if (flights.length > 0) {
          try {
            let minTs = Infinity, maxTs = -Infinity;
            for (const f of flights) {
              if (f.start_time < minTs) minTs = f.start_time;
              if (f.end_time > maxTs) maxTs = f.end_time;
            }
            const startDate = new Date(minTs * 1000).toISOString().slice(0, 10);
            const endDate = new Date(maxTs * 1000).toISOString().slice(0, 10);

            // 날짜 범위 생성
            const dates: string[] = [];
            const d = new Date(startDate + "T00:00:00Z");
            const endD = new Date(endDate + "T00:00:00Z");
            while (d <= endD) {
              dates.push(d.toISOString().slice(0, 10));
              d.setUTCDate(d.getUTCDate() + 1);
            }

            const { radarSite: rs } = state;

            // 기상 데이터 복원
            const weatherRows = await invoke<[string, string][]>("load_weather_cache", {
              radarLat: rs.latitude, radarLon: rs.longitude, dates,
            });
            if (weatherRows.length > 0) {
              const allHourly: WeatherHourly[] = [];
              for (const [, json] of weatherRows) {
                allHourly.push(...(JSON.parse(json) as WeatherHourly[]));
              }
              allHourly.sort((a, b) => a.timestamp - b.timestamp);
              store.setWeatherData({
                radarLat: rs.latitude,
                radarLon: rs.longitude,
                startDate, endDate,
                hourly: allHourly,
                fetchedAt: Date.now() / 1000,
              });
              console.log(`[Restore] 기상 캐시 ${weatherRows.length}일 복원 (${allHourly.length}시간)`);
            }

            // 구름 그리드 복원
            const cloudRows = await invoke<[string, string, number][]>("load_cloud_grid_cache", {
              radarLat: rs.latitude, radarLon: rs.longitude, dates,
            });
            if (cloudRows.length > 0) {
              const allFrames: CloudGridFrame[] = [];
              let gridSpacing = 50;
              for (const [, framesJson, spacing] of cloudRows) {
                allFrames.push(...(JSON.parse(framesJson) as CloudGridFrame[]));
                gridSpacing = spacing;
              }
              allFrames.sort((a, b) => a.timestamp - b.timestamp);
              store.setCloudGrid({
                radarLat: rs.latitude,
                radarLon: rs.longitude,
                frames: allFrames,
                gridSpacingKm: gridSpacing,
              });
              console.log(`[Restore] 구름 그리드 캐시 ${cloudRows.length}일 복원 (${allFrames.length}프레임)`);
            }
          } catch (e) {
            console.log("[Restore] 기상 캐시 복원 실패:", e);
          }
        }
      } catch (e) {
        console.log("[Restore] 파싱 데이터 복원 실패:", e);
      }
    };

    restore();
  }, []);
}

/** OpenSky 자동 동기화: 등록 항공기의 최근 5년 운항이력 조회 (최신→과거) */
function useOpenskyAutoSync() {
  const syncVersion = useAppStore((s) => s.openskySyncVersion);
  const syncingRef = useRef(false);
  const lastVersion = useRef(-1);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unlistenRefs = useRef<(() => void)[]>([]);

  useEffect(() => {
    let cancelled = false;

    const setupAndSync = async () => {
      // 1) 이벤트 리스너를 먼저 등록 (await 완료 후 sync 시작 → 이벤트 놓침 방지)
      const unlisten1 = await listen<FlightRecord[]>(
        "flight-history-records",
        (event) => {
          if (!cancelled) useAppStore.getState().addFlightHistory(event.payload);
        }
      );
      let lastRetryAfterSecs: number | null = null;
      const unlisten2 = await listen<{ current: number; total: number; icao24: string; retry_after_secs?: number }>(
        "flight-history-progress",
        (event) => {
          if (cancelled) return;
          const { current, total, icao24, retry_after_secs } = event.payload;
          if (retry_after_secs != null) {
            lastRetryAfterSecs = retry_after_secs;
          }
          const aircraft = useAppStore.getState().aircraft;
          const ac = aircraft.find((a) => a.mode_s_code.toUpperCase() === icao24.toUpperCase());
          const name = ac?.name ?? icao24;
          useAppStore.getState().setOpenskySyncProgress(`${name} (${current}/${total})`);
        }
      );
      unlistenRefs.current = [unlisten1, unlisten2];
      if (cancelled) return;

      // 2) DB에서 기존 캐싱된 이력 즉시 로드 (API 호출 전에 UI에 표시)
      try {
        const activeAircraft = useAppStore.getState().aircraft.filter((a) => a.active && a.mode_s_code);
        if (activeAircraft.length > 0) {
          const icao24List = activeAircraft.map((a) => a.mode_s_code.toLowerCase());
          const now = Math.floor(Date.now() / 1000);
          const fiveYears = 5 * 365 * 86400;
          const cached = await invoke<FlightRecord[]>("load_flight_history", {
            icao24List,
            start: now - fiveYears,
            end: now,
          });
          if (!cancelled && cached.length > 0) {
            console.log(`[OpenSky] DB 캐시 로드: ${cached.length}건`);
            useAppStore.getState().addFlightHistory(cached);
          }
        }
      } catch (e) {
        console.log("[OpenSky] DB 캐시 로드 실패:", e);
      }

      // 3) API 동기화 시작
      if (cancelled || syncingRef.current) return;

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

      const activeAircraft = useAppStore.getState().aircraft.filter((a) => a.active && a.mode_s_code);
      if (activeAircraft.length === 0) return;

      syncingRef.current = true;
      useAppStore.getState().setOpenskySync(true);
      const now = Math.floor(Date.now() / 1000);
      const fiveYears = 5 * 365 * 86400;
      let hadRateLimit = false;

      // 30일 단위 시간 윈도우를 최신→과거 순으로, 모든 항공기 교차 조회
      const chunkSize = 30 * 86400; // 30일
      const totalChunks = Math.ceil(fiveYears / chunkSize);
      console.log(`[OpenSky] 동기화 시작: ${activeAircraft.length}대, ${totalChunks}개 월별 윈도우 (최신→과거)`);

      const isCancelled = () => cancelled || useAppStore.getState().openskySyncCancelled;

      let authFailed = false;
      for (let ci = 0; ci < totalChunks; ci++) {
        if (isCancelled() || authFailed) break;
        const chunkEnd = now - ci * chunkSize;
        const chunkBegin = Math.max(now - (ci + 1) * chunkSize, now - fiveYears);

        for (const ac of activeAircraft) {
          if (isCancelled() || authFailed) break;
          const progressLabel = `${ac.name} (${ci + 1}/${totalChunks})`;
          useAppStore.getState().setOpenskySyncProgress(progressLabel);
          try {
            const records = await invoke<FlightRecord[]>("fetch_flight_history", {
              icao24: ac.mode_s_code,
              begin: chunkBegin,
              end: chunkEnd,
            });
            if (records.length > 0) {
              console.log(`[OpenSky] ${ac.name} [${ci + 1}/${totalChunks}]: ${records.length}건`);
              useAppStore.getState().addFlightHistory(records);
            }
          } catch (e) {
            const msg = String(e);
            console.warn(`[OpenSky] ${ac.name} 동기화 오류:`, msg);
            if (msg.includes("인증정보") || msg.includes("접근 거부")) {
              useAppStore.getState().setOpenskySyncProgress("OpenSky 인증정보를 설정에서 확인하세요");
              authFailed = true;
              break;
            }
            if (msg.includes("rate_limit") || msg.includes("rate limit") || msg.includes("429")) {
              hadRateLimit = true;
            }
          }
        }
      }

      useAppStore.getState().setOpenskySync(false);
      useAppStore.getState().setOpenskySyncProgress("");
      syncingRef.current = false;

      if (isCancelled()) {
        console.log("[OpenSky] 동기화 취소됨 (DB 가져오기 등)");
      }

      // 한도 초과 시 자동 재시도 (API 헤더 기반 대기 시간, 기본 30분)
      if (hadRateLimit && !isCancelled()) {
        const retrySecs = lastRetryAfterSecs ?? 1800;
        const retryMins = Math.ceil(retrySecs / 60);
        console.log(`[OpenSky] Rate limit — ${retryMins}분 후 재시도 예약 (${retrySecs}초)`);
        useAppStore.getState().setOpenskySyncProgress(`일일 한도 초과 — ${retryMins}분 후 재시도`);
        retryTimerRef.current = setTimeout(() => {
          useAppStore.getState().setOpenskySyncProgress("");
          setupAndSync();
        }, retrySecs * 1000);
      }
    };

    // 초기 마운트 또는 버전 변경 시 동기화
    if (lastVersion.current === syncVersion && lastVersion.current !== -1) return;
    lastVersion.current = syncVersion;
    setupAndSync();

    return () => {
      cancelled = true;
      for (const fn of unlistenRefs.current) fn();
      unlistenRefs.current = [];
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [syncVersion]);
}

/** Garble 포인트 청크 이벤트 리스너 */
function useGarbleChunkListener() {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    (async () => {
      const unlistenGarble = await listen<{ file_path: string; points: GarblePoint[] }>(
        "garble-points-chunk",
        (event) => {
          if (!cancelled) {
            console.log(`[Garble] 수신: ${event.payload.points.length}개 garble points (${event.payload.file_path})`);
            useAppStore.getState().appendGarblePoints(event.payload.points);
          }
        }
      );
      if (cancelled) {
        unlistenGarble();
      } else {
        unlisten = unlistenGarble;
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);
}

export default function App() {
  const loading = useAppStore((s) => s.loading);
  const loadingMessage = useAppStore((s) => s.loadingMessage);
  const location = useLocation();
  const isMapPage = location.pathname === "/map";

  useRestoreSavedData();
  useOpenskyAutoSync();
  useGarbleChunkListener();

  return (
    <div className="flex h-full bg-white">
      {/* Sidebar - 타이틀바와 시각적으로 통합, 전체 높이 */}
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Titlebar - 윈도우 컨트롤만 */}
        <Titlebar />
        <main className="relative flex-1 overflow-hidden border-t border-gray-200">
          {/* TrackMap은 항상 마운트 - 탭 전환 시 상태 유지 */}
          {/* TrackMap은 항상 렌더링 - hidden 대신 offscreen으로 canvas 유지 (보고서 캡처용) */}
          <div className={isMapPage ? "h-full" : "absolute inset-0 -z-10 pointer-events-none opacity-0"}>
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
