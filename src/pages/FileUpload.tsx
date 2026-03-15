import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import {
  Upload,
  FileUp,
  Trash2,
  Play,
  CheckCircle2,
  XCircle,
  Loader2,
  FolderOpen,
  AlertCircle,
  Radar,
  Plane,
  Globe,
  Satellite,
  RefreshCw,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store";
import { consolidateFlights } from "../utils/flightConsolidation";
import type { AdsbTrack, AnalysisResult, FlightRecord, UploadedFile } from "../types";

export default function FileUpload() {
  const uploadedFiles = useAppStore((s) => s.uploadedFiles);
  const addUploadedFile = useAppStore((s) => s.addUploadedFile);
  const updateUploadedFile = useAppStore((s) => s.updateUploadedFile);
  const clearUploadedFiles = useAppStore((s) => s.clearUploadedFiles);
  const appendRawTrackPoints = useAppStore((s) => s.appendRawTrackPoints);
  const addParseStats = useAppStore((s) => s.addParseStats);
  const rawTrackPoints = useAppStore((s) => s.rawTrackPoints);
  const setFlights = useAppStore((s) => s.setFlights);
  const aircraft = useAppStore((s) => s.aircraft);
  const radarSite = useAppStore((s) => s.radarSite);
  const setRadarSite = useAppStore((s) => s.setRadarSite);
  const customRadarSites = useAppStore((s) => s.customRadarSites);
  const adsbTracks = useAppStore((s) => s.adsbTracks);
  const setAdsbTracks = useAppStore((s) => s.setAdsbTracks);
  const adsbLoading = useAppStore((s) => s.adsbLoading);
  const setAdsbLoading = useAppStore((s) => s.setAdsbLoading);
  const adsbProgress = useAppStore((s) => s.adsbProgress);
  const setAdsbProgress = useAppStore((s) => s.setAdsbProgress);
  const flightHistory = useAppStore((s) => s.flightHistory);
  const setFlightHistory = useAppStore((s) => s.setFlightHistory);
  const flightHistoryLoading = useAppStore((s) => s.flightHistoryLoading);
  const setFlightHistoryLoading = useAppStore((s) => s.setFlightHistoryLoading);
  const flightHistoryProgress = useAppStore((s) => s.flightHistoryProgress);
  const setFlightHistoryProgress = useAppStore((s) => s.setFlightHistoryProgress);
  const [dragOver, setDragOver] = useState(false);
  const [errorLog, setErrorLog] = useState<string[]>([]);
  // 파싱 모드: "aircraft" = 등록 비행검사기만, "all" = 전체 데이터
  const [parseMode, setParseMode] = useState<"aircraft" | "all">("aircraft");

  // 레이더 선택 모달 상태
  const [showRadarModal, setShowRadarModal] = useState(false);
  const [radarModalAction, setRadarModalAction] = useState<"single" | "all">("all");
  const [modalSelectedSite, setModalSelectedSite] = useState(radarSite);
  const pendingParseFileRef = useRef<UploadedFile | null>(null);

  // 모달에 표시할 전체 레이더 사이트 목록
  const allRadarSites = customRadarSites;

  // 등록 항공기별 비행 시간 범위
  const registeredTrackRanges = useMemo(() => {
    const ranges = new Map<string, { name: string; minTs: number; maxTs: number; points: number }>();
    for (const a of aircraft) {
      if (!a.active || !a.mode_s_code) continue;
      const ms = a.mode_s_code.toUpperCase();
      for (const p of rawTrackPoints) {
        if (p.mode_s.toUpperCase() !== ms) continue;
        const prev = ranges.get(ms);
        if (!prev) {
          ranges.set(ms, { name: a.name, minTs: p.timestamp, maxTs: p.timestamp, points: 1 });
        } else {
          if (p.timestamp < prev.minTs) prev.minTs = p.timestamp;
          if (p.timestamp > prev.maxTs) prev.maxTs = p.timestamp;
          prev.points++;
        }
      }
    }
    return ranges;
  }, [aircraft, rawTrackPoints]);

  // 비행 통합 실행
  const runConsolidation = useCallback(() => {
    const state = useAppStore.getState();
    if (state.rawTrackPoints.length === 0) return;
    const consolidated = consolidateFlights(
      state.rawTrackPoints,
      state.flightHistory,
      state.aircraft,
      state.radarSite,
    );
    setFlights(consolidated);
  }, [setFlights]);

  // flightHistory가 변경되면 재통합 (DB 캐시 로드 또는 API 동기화 결과 반영)
  useEffect(() => {
    if (rawTrackPoints.length > 0) {
      runConsolidation();
    }
  }, [flightHistory]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchAdsb = useCallback(async () => {
    if (registeredTrackRanges.size === 0) return;
    setAdsbLoading(true);
    try {
      const seen = new Set<string>();
      const queries: { icao24: string; time: number }[] = [];
      for (const [ms, { minTs, maxTs }] of registeredTrackRanges) {
        for (let t = minTs; t <= maxTs; t += 3600) {
          const key = `${ms}_${Math.round(t / 3600)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          queries.push({ icao24: ms, time: Math.round(t) });
        }
        const lastKey = `${ms}_${Math.round(maxTs / 3600)}`;
        if (!seen.has(lastKey)) {
          seen.add(lastKey);
          queries.push({ icao24: ms, time: Math.round(maxTs) });
        }
      }
      if (queries.length === 0) { setAdsbLoading(false); return; }
      await invoke("fetch_adsb_tracks", { queries });
      const icao24List = [...registeredTrackRanges.keys()];
      const ranges = [...registeredTrackRanges.values()];
      const start = Math.min(...ranges.map((r) => r.minTs));
      const end = Math.max(...ranges.map((r) => r.maxTs));
      const tracks = await invoke<AdsbTrack[]>("load_adsb_tracks_for_range", {
        icao24_list: icao24List, start, end,
      });
      setAdsbTracks(tracks);
    } catch (e) {
      console.warn("ADS-B fetch failed:", e);
    } finally {
      setAdsbLoading(false);
      setAdsbProgress("");
    }
  }, [registeredTrackRanges, setAdsbTracks, setAdsbLoading, setAdsbProgress]);

  const fetchFlightHistory = useCallback(async () => {
    if (registeredTrackRanges.size === 0) return;
    setFlightHistoryLoading(true);
    try {
      for (const [ms, { minTs, maxTs }] of registeredTrackRanges) {
        await invoke("fetch_flight_history", {
          icao24: ms,
          begin: Math.round(minTs),
          end: Math.round(maxTs),
        });
      }
      const icao24List = [...registeredTrackRanges.keys()];
      const ranges = [...registeredTrackRanges.values()];
      const start = Math.min(...ranges.map((r) => r.minTs));
      const end = Math.max(...ranges.map((r) => r.maxTs));
      const records = await invoke<FlightRecord[]>("load_flight_history", {
        icao24_list: icao24List, start, end,
      });
      setFlightHistory(records);
    } catch (e) {
      const msg = String(e);
      console.warn("Flight history fetch failed:", msg);
      if (msg.includes("인증정보") || msg.includes("접근 거부")) {
        setFlightHistoryProgress("OpenSky 인증정보를 설정에서 확인하세요");
      }
    } finally {
      setFlightHistoryLoading(false);
    }
  }, [registeredTrackRanges, setFlightHistory, setFlightHistoryLoading, setFlightHistoryProgress]);

  useEffect(() => {
    const unlisten1 = listen<{ current: number; total: number; icao24: string }>(
      "adsb-progress",
      (e) => setAdsbProgress(`${e.payload.icao24} (${e.payload.current}/${e.payload.total})`)
    );
    const unlisten2 = listen<{ current: number; total: number; icao24: string }>(
      "flight-history-progress",
      (e) => setFlightHistoryProgress(`${e.payload.icao24} (${e.payload.current}/${e.payload.total})`)
    );
    return () => {
      unlisten1.then((fn) => fn());
      unlisten2.then((fn) => fn());
    };
  }, [setAdsbProgress, setFlightHistoryProgress]);

  // rawTrackPoints 변경 시 DB에서 기존 데이터 자동 로드 + 비행 통합
  useEffect(() => {
    if (registeredTrackRanges.size === 0) {
      // 등록 항공기 없어도 rawTrackPoints가 있으면 통합 실행
      if (rawTrackPoints.length > 0) runConsolidation();
      return;
    }
    const icao24List = [...registeredTrackRanges.keys()];
    const ranges = [...registeredTrackRanges.values()];
    const start = Math.min(...ranges.map((r) => r.minTs));
    const end = Math.max(...ranges.map((r) => r.maxTs));
    // ADS-B 트랙
    invoke<AdsbTrack[]>("load_adsb_tracks_for_range", {
      icao24_list: icao24List, start, end,
    }).then((tracks) => {
      if (tracks.length > 0) setAdsbTracks(tracks);
    }).catch(() => {});
    // 운항이력 — DB에서 로드 후 setFlightHistory → flightHistory useEffect가 재통합 트리거
    invoke<FlightRecord[]>("load_flight_history", {
      icao24_list: icao24List, start, end,
    }).then((records) => {
      if (records.length > 0) {
        setFlightHistory(records);
      } else {
        // DB에 운항이력 없어도 통합 실행 (gap 분리로라도)
        runConsolidation();
      }
    }).catch(() => {
      // DB 로드 실패 시에도 통합 실행
      runConsolidation();
    });
  }, [registeredTrackRanges]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFilePick = async () => {
    try {
      const result = await open({
        multiple: true,
        filters: [
          { name: "ASS Files", extensions: ["ass", "ASS"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });
      if (result) {
        const paths = Array.isArray(result) ? result : [result];
        for (const filePath of paths) {
          if (typeof filePath === "string") {
            const name = filePath.split(/[/\\]/).pop() ?? filePath;
            if (!uploadedFiles.find((f) => f.path === filePath)) {
              addUploadedFile({
                path: filePath,
                name,
                status: "pending",
              });
            }
          }
        }
      }
    } catch (err) {
      setErrorLog((prev) => [
        ...prev,
        `파일 선택 오류: ${err instanceof Error ? err.message : String(err)}`,
      ]);
    }
  };

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      setErrorLog((prev) => [
        ...prev,
        "드래그 앤 드롭은 Tauri 환경에서 제한될 수 있습니다. 파일 선택 버튼을 사용하세요.",
      ]);
    },
    []
  );

  // 파싱 전 레이더 선택 모달 표시
  const requestParseSingle = (file: UploadedFile) => {
    pendingParseFileRef.current = file;
    setRadarModalAction("single");
    setModalSelectedSite(radarSite);
    setShowRadarModal(true);
  };

  const requestParseAll = () => {
    pendingParseFileRef.current = null;
    setRadarModalAction("all");
    setModalSelectedSite(radarSite);
    setShowRadarModal(true);
  };

  const handleRadarConfirm = async () => {
    setShowRadarModal(false);
    setRadarSite(modalSelectedSite);
    if (radarModalAction === "single" && pendingParseFileRef.current) {
      await parseFile(pendingParseFileRef.current);
      // 단일 파일 파싱 후에도 비행 통합 (DB 로드는 registeredTrackRanges useEffect에서 처리)
      runConsolidation();
    } else {
      parseAllInternal();
    }
  };

  // Mode-S 필터 생성
  const getModeSFilter = (): string[] => {
    if (parseMode === "all") return [];
    const activeAircraft = useAppStore.getState().aircraft.filter((a) => a.active);
    if (activeAircraft.length === 0) return [];
    return activeAircraft.map((a) => a.mode_s_code.toUpperCase());
  };

  const parseFile = async (file: UploadedFile) => {
    updateUploadedFile(file.path, { status: "parsing" });

    try {
      const currentSite = useAppStore.getState().radarSite;
      const modeSFilter = getModeSFilter();
      const result: AnalysisResult = await invoke("parse_and_analyze", {
        filePath: file.path,
        radarLat: currentSite.latitude,
        radarLon: currentSite.longitude,
        modeSFilter,
      });

      // 원시 포인트 축적
      appendRawTrackPoints(result.file_info.track_points);

      // 파싱 통계 저장
      if (result.file_info.parse_stats) {
        addParseStats(
          result.file_info.filename,
          result.file_info.parse_stats,
          result.file_info.total_records,
        );
      }

      updateUploadedFile(file.path, {
        status: "done",
        parsedFile: result.file_info,
      });

      if (result.file_info.parse_errors.length > 0) {
        setErrorLog((prev) => [
          ...prev,
          ...result.file_info.parse_errors.map(
            (e) => `[${file.name}] ${e}`
          ),
        ]);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      updateUploadedFile(file.path, { status: "error", error: errMsg });
      setErrorLog((prev) => [...prev, `[${file.name}] 파싱 오류: ${errMsg}`]);
    }
  };

  const parseAllInternal = async () => {
    const pending = useAppStore.getState().uploadedFiles.filter((f) => f.status === "pending");
    if (pending.length === 0) return;

    for (const file of pending) {
      await parseFile(file);
    }

    // 모든 파일 파싱 완료 후 비행 통합
    runConsolidation();
  };

  const pendingCount = uploadedFiles.filter(
    (f) => f.status === "pending"
  ).length;
  const parsingCount = uploadedFiles.filter(
    (f) => f.status === "parsing"
  ).length;

  const statusIcon = (status: UploadedFile["status"]) => {
    switch (status) {
      case "pending":
        return <FileUp size={16} className="text-gray-500" />;
      case "parsing":
        return <Loader2 size={16} className="animate-spin text-blue-600" />;
      case "done":
        return <CheckCircle2 size={16} className="text-green-600" />;
      case "error":
        return <XCircle size={16} className="text-red-600" />;
    }
  };

  const statusText = (file: UploadedFile) => {
    switch (file.status) {
      case "pending":
        return "대기 중";
      case "parsing":
        return "파싱 중...";
      case "done":
        return `완료 (${file.parsedFile?.total_records ?? 0} 레코드)`;
      case "error":
        return file.error ?? "오류";
    }
  };

  return (
    <>
    <div className="flex gap-6">
      {/* Left column: Upload + File list */}
      <div className="flex-1 min-w-0 space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-gray-800">자료 업로드</h1>
          <p className="mt-1 text-sm text-gray-500">
            NEC ASS 파일을 업로드하여 파싱합니다
          </p>
        </div>

        {/* Drop Zone */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={handleFilePick}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-16 transition-all ${
            dragOver
              ? "border-[#a60739] bg-[#a60739]/10"
              : "border-gray-300 bg-gray-50 hover:border-gray-400 hover:bg-gray-100"
          }`}
        >
          <div
            className={`mb-4 flex h-16 w-16 items-center justify-center rounded-full ${dragOver ? "bg-[#a60739]/15" : "bg-gray-100"}`}
          >
            <Upload
              size={28}
              className={dragOver ? "text-[#a60739]" : "text-gray-500"}
            />
          </div>
          <p className="text-sm font-medium text-gray-600">
            클릭하여 NEC ASS 파일 선택
          </p>
          <p className="mt-1 text-xs text-gray-500">
            또는 파일을 이 영역에 드래그 앤 드롭
          </p>
        </div>

        {/* File List */}
        {uploadedFiles.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-800">
                업로드 파일 ({uploadedFiles.length}개)
              </h2>
              <div className="flex items-center gap-2">
                {pendingCount > 0 && (
                  <button
                    onClick={requestParseAll}
                    disabled={parsingCount > 0}
                    className="flex items-center gap-2 rounded-lg bg-[#a60739] px-3 py-2 text-sm font-medium text-white hover:bg-[#85062e] disabled:opacity-50 transition-colors"
                  >
                    <Play size={14} />
                    <span>전체 파싱 ({pendingCount}건)</span>
                  </button>
                )}
                <button
                  onClick={clearUploadedFiles}
                  className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-500 hover:bg-gray-100 transition-colors"
                >
                  <Trash2 size={14} />
                  <span>전체 삭제</span>
                </button>
              </div>
            </div>

            <div className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-gray-50">
              {uploadedFiles.map((file) => (
                <div key={file.path} className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    {statusIcon(file.status)}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <FolderOpen size={12} className="text-gray-400 shrink-0" />
                        <p className="truncate text-sm text-gray-800">{file.name}</p>
                      </div>
                      <p className="text-xs text-gray-500 truncate">{file.path}</p>
                    </div>
                    <span
                      className={`shrink-0 text-xs ${
                        file.status === "done"
                          ? "text-green-600"
                          : file.status === "error"
                            ? "text-red-600"
                            : file.status === "parsing"
                              ? "text-blue-600"
                              : "text-gray-500"
                      }`}
                    >
                      {statusText(file)}
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                      {file.status === "pending" && (
                        <button
                          onClick={() => requestParseSingle(file)}
                          className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900 transition-colors"
                          title="파싱"
                        >
                          <Play size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Error Log */}
        {errorLog.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-base font-semibold text-gray-800">
                <AlertCircle size={16} className="text-yellow-600" />
                오류 로그
              </h2>
              <button
                onClick={() => setErrorLog([])}
                className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
              >
                로그 삭제
              </button>
            </div>
            <div className="max-h-48 overflow-auto rounded-xl border border-gray-200 bg-gray-100 p-4">
              {errorLog.map((msg, idx) => (
                <p
                  key={`err-${idx}`}
                  className="font-mono text-xs text-yellow-600/80 leading-relaxed"
                >
                  {msg}
                </p>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Right column: ADS-B */}
      <div className="w-80 shrink-0 space-y-4">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Satellite size={16} className="text-emerald-600" />
              <h3 className="text-sm font-semibold text-gray-800">ADS-B 데이터</h3>
            </div>
            <button
              onClick={fetchAdsb}
              disabled={adsbLoading || registeredTrackRanges.size === 0}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40 transition-colors"
            >
              <RefreshCw size={12} className={adsbLoading ? "animate-spin" : ""} />
              {adsbLoading ? "조회 중..." : "조회"}
            </button>
          </div>

          {/* Progress */}
          {adsbLoading && adsbProgress && (
            <div className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              {adsbProgress}
            </div>
          )}

          {/* 등록 항공기 목록 + ADS-B 수신 현황 */}
          {registeredTrackRanges.size === 0 ? (
            <p className="text-xs text-gray-400 py-4 text-center">
              파싱된 등록 항공기 데이터가 없습니다
            </p>
          ) : (
            <div className="space-y-2">
              {Array.from(registeredTrackRanges.entries()).map(([ms, info]) => {
                const matched = adsbTracks.filter((t) => t.icao24.toLowerCase() === ms.toLowerCase());
                const totalAdsbPoints = matched.reduce((sum, t) => sum + t.path.length, 0);
                return (
                  <div key={ms} className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-gray-800">{info.name}</span>
                      <span className="font-mono text-[10px] text-gray-500">{ms}</span>
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-gray-500">
                      <span>레이더: {info.points.toLocaleString()} pts</span>
                      <span className={totalAdsbPoints > 0 ? "text-emerald-600 font-medium" : "text-gray-400"}>
                        ADS-B: {totalAdsbPoints > 0 ? `${totalAdsbPoints} pts (${matched.length}건)` : "없음"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* 전체 요약 */}
          {adsbTracks.length > 0 && (
            <div className="mt-3 pt-3 border-t border-gray-100 text-xs text-gray-500">
              총 {adsbTracks.length}건 ADS-B 트랙 수신
            </div>
          )}
        </div>

        {/* 운항이력 */}
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Globe size={16} className="text-blue-600" />
              <h3 className="text-sm font-semibold text-gray-800">운항이력</h3>
            </div>
            <button
              onClick={fetchFlightHistory}
              disabled={flightHistoryLoading || registeredTrackRanges.size === 0}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40 transition-colors"
            >
              <RefreshCw size={12} className={flightHistoryLoading ? "animate-spin" : ""} />
              {flightHistoryLoading ? "조회 중..." : "조회"}
            </button>
          </div>

          {flightHistoryProgress && (
            <div className={`mb-3 rounded-lg px-3 py-2 text-xs ${
              flightHistoryProgress.includes("확인하세요")
                ? "bg-red-50 text-red-700"
                : "bg-blue-50 text-blue-700"
            }`}>
              {flightHistoryProgress}
            </div>
          )}

          {flightHistory.length === 0 ? (
            <p className="text-xs text-gray-400 py-2 text-center">
              {registeredTrackRanges.size === 0 ? "파싱된 등록 항공기 데이터가 없습니다" : "운항이력 없음"}
            </p>
          ) : (
            <div className="max-h-48 overflow-y-auto space-y-1">
              {flightHistory.map((f, i) => {
                const dep = f.est_departure_airport ?? "—";
                const arr = f.est_arrival_airport ?? "—";
                const dur = Math.round((f.last_seen - f.first_seen) / 60);
                const d = new Date(f.first_seen * 1000);
                const dateStr = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
                return (
                  <div key={i} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-gray-800">{dep} → {arr}</span>
                      <span className="text-[10px] text-gray-400">{dateStr}</span>
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-gray-500 mt-0.5">
                      <span>{f.callsign?.trim() || f.icao24}</span>
                      <span>{dur}분</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {flightHistory.length > 0 && (
            <div className="mt-2 pt-2 border-t border-gray-100 text-xs text-gray-500">
              총 {flightHistory.length}건
            </div>
          )}
        </div>
      </div>
    </div>

    {/* 레이더 사이트 선택 모달 */}
    {showRadarModal && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-2xl">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#a60739]/10">
              <Radar size={20} className="text-[#a60739]" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-800">
                레이더 사이트 선택
              </h3>
              <p className="text-xs text-gray-500">
                파싱에 사용할 레이더 사이트를 확인하세요
              </p>
            </div>
          </div>

          {/* 파싱 대상 선택 */}
          <div className="mb-4">
            <p className="text-xs text-gray-500 mb-2">파싱 대상</p>
            <div className="flex gap-2">
              <button
                onClick={() => setParseMode("aircraft")}
                className={`flex-1 flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-all ${
                  parseMode === "aircraft"
                    ? "border-[#a60739] bg-[#a60739] text-white"
                    : "border-gray-200 bg-gray-50 text-gray-500 hover:border-gray-300"
                }`}
              >
                <Plane size={14} />
                <span>비행검사기만</span>
                {parseMode === "aircraft" && (
                  <span className="text-[10px] text-white/80">
                    ({aircraft.filter((a) => a.active).length}대)
                  </span>
                )}
              </button>
              <button
                onClick={() => setParseMode("all")}
                className={`flex-1 flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-all ${
                  parseMode === "all"
                    ? "border-[#a60739] bg-[#a60739] text-white"
                    : "border-gray-200 bg-gray-50 text-gray-500 hover:border-gray-300"
                }`}
              >
                <Globe size={14} />
                <span>전체 데이터</span>
              </button>
            </div>
            {parseMode === "aircraft" && aircraft.filter((a) => a.active).length === 0 && (
              <p className="mt-1.5 text-xs text-yellow-600">
                등록된 활성 비행검사기가 없어 전체 데이터를 파싱합니다
              </p>
            )}
          </div>

          {/* 레이더 사이트 목록 */}
          <div className="space-y-2 mb-5 max-h-60 overflow-auto">
            {allRadarSites.map((site) => (
              <button
                key={site.name}
                onClick={() => setModalSelectedSite(site)}
                className={`w-full rounded-lg border px-4 py-3 text-left transition-all ${
                  site.name === modalSelectedSite.name
                    ? "border-[#a60739] bg-[#a60739] text-white"
                    : "border-gray-200 bg-gray-50 hover:border-gray-300 hover:bg-gray-100"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className={`text-sm font-medium ${site.name === modalSelectedSite.name ? "text-white" : "text-gray-800"}`}>
                    {site.name}
                  </span>
                  {site.name === modalSelectedSite.name && (
                    <span className="text-xs text-white/80">선택됨</span>
                  )}
                </div>
                <p className={`mt-0.5 text-xs ${site.name === modalSelectedSite.name ? "text-white/70" : "text-gray-500"}`}>
                  {site.latitude.toFixed(4)}°N, {site.longitude.toFixed(4)}°E
                  {site.range_nm ? ` · ${site.range_nm}NM` : ""}
                </p>
              </button>
            ))}
          </div>

          {/* 버튼 */}
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => setShowRadarModal(false)}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 transition-colors"
            >
              취소
            </button>
            <button
              onClick={handleRadarConfirm}
              className="rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white hover:bg-[#85062e] transition-colors"
            >
              파싱 시작
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
