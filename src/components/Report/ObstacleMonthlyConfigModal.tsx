/**
 * 장애물 월간 보고서 설정 모달 (스텝별 위자드)
 * 보고서 창에서 렌더링됨. 분석월 → 레이더 → 건물 → 파일 선택+분석.
 */
import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { CheckSquare, Square, ChevronRight, ChevronDown, MinusSquare, Loader2, BarChart3, Radio, Building2, FolderOpen, ArrowRight, ArrowLeft } from "lucide-react";
import { format, lastDayOfMonth, subMonths } from "date-fns";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import Modal from "../common/Modal";
import MonthPicker from "../common/MonthPicker";
import { haversineKm } from "../../utils/geo";
import { computeLosBatch, calcBuildingAzExtent, mergeAzSectors } from "../../utils/obstacleAnalysisHelpers";
import type { CoverageLayer } from "../../utils/radarCoverage";
import type {
  RadarSite, Aircraft as AircraftType, ReportMetadata, ManualBuilding, BuildingGroup,
  AzSector, ObstacleMonthlyResult, ObstacleMonthlyProgress, LoSProfileData,
} from "../../types";

export default function ObstacleMonthlyConfigModal({
  customRadarSites,
  aircraft,
  metadata: _metadata,
  onClose,
  onGenerate,
  onCoverageReady,
  onCoverageError,
}: {
  customRadarSites: RadarSite[];
  aircraft: AircraftType[];
  metadata: ReportMetadata;
  onClose: () => void;
  onGenerate: (
    result: ObstacleMonthlyResult,
    buildings: ManualBuilding[],
    radars: RadarSite[],
    azMap: Map<string, AzSector[]>,
    losMap: Map<string, LoSProfileData>,
    covWith: Map<string, CoverageLayer[]>,
    covWithout: Map<string, CoverageLayer[]>,
    analysisMonth?: string,
  ) => void;
  onCoverageReady: (covWith: Map<string, CoverageLayer[]>, covWithout: Map<string, CoverageLayer[]>) => void;
  onCoverageError?: () => void;
}) {
  const [step, setStep] = useState(0);
  const [checkedRadars, setCheckedRadars] = useState<Set<string>>(new Set());
  const [manualBuildings, setManualBuildings] = useState<ManualBuilding[]>([]);
  const [buildingGroups, setBuildingGroups] = useState<BuildingGroup[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<number | null>>(new Set());
  const [checkedBldgIds, setCheckedBldgIds] = useState<Set<number>>(new Set());
  const [radarFiles, setRadarFiles] = useState<Map<string, string[]>>(new Map());
  const [analysisMonth, setAnalysisMonth] = useState(() => format(new Date(), "yyyy-MM"));
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState("");
  const [progressPct, setProgressPct] = useState(0);
  const [error, setError] = useState("");
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => { cancelledRef.current = true; };
  }, []);

  useEffect(() => {
    invoke<ManualBuilding[]>("list_manual_buildings").then(setManualBuildings).catch((err) => console.warn("건물 목록 로드 실패:", err));
    invoke<BuildingGroup[]>("list_building_groups").then(setBuildingGroups).catch((err) => console.warn("건물 그룹 로드 실패:", err));
  }, []);

  const selectedRadars = useMemo(
    () => customRadarSites.filter((r) => checkedRadars.has(r.name)),
    [customRadarSites, checkedRadars],
  );
  const selectedBuildings = useMemo(
    () => manualBuildings.filter((b) => checkedBldgIds.has(b.id)),
    [manualBuildings, checkedBldgIds],
  );

  const azSectorsByRadar = useMemo(() => {
    const map = new Map<string, AzSector[]>();
    for (const r of selectedRadars) {
      const sectors = selectedBuildings.map((b) => calcBuildingAzExtent(r.latitude, r.longitude, b));
      map.set(r.name, mergeAzSectors(sectors));
    }
    return map;
  }, [selectedRadars, selectedBuildings]);

  const handleSelectFiles = useCallback(async (radarName: string) => {
    const result = await open({ multiple: true, filters: [{ name: "ASS Files", extensions: ["ass", "ASS"] }] });
    if (result && Array.isArray(result)) {
      setRadarFiles((prev) => {
        const next = new Map(prev);
        next.set(radarName, result as string[]);
        return next;
      });
    }
  }, []);

  /** 파일명에서 날짜(YYYY-MM-DD) 추출 (Rust extract_date_from_filename 미러) */
  const extractDateFromFilename = useCallback((path: string): string | null => {
    const filename = path.split(/[/\\]/).pop() ?? path;
    const stem = filename.replace(/\.[^.]+$/, "");
    for (const part of stem.split("_")) {
      if (part.length === 6) {
        const yy = parseInt(part.slice(0, 2), 10);
        const mm = parseInt(part.slice(2, 4), 10);
        const dd = parseInt(part.slice(4, 6), 10);
        if (!isNaN(yy) && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
          return `${2000 + yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
        }
      }
    }
    return null;
  }, []);

  /** 선택 월에 해당하는 파일만 필터 (전월 마지막날 포함 — 자정 이후 데이터 포함 가능) */
  const filterFilesByMonth = useCallback((files: string[], month: string): string[] => {
    // month = "YYYY-MM"
    const [y, m] = month.split("-").map(Number);
    const prevMonth = subMonths(new Date(y, m - 1, 1), 1);
    const prevLastDay = format(lastDayOfMonth(prevMonth), "yyyy-MM-dd");

    return files.filter((f) => {
      const date = extractDateFromFilename(f);
      if (!date) return true; // 날짜 추출 실패 시 포함 (안전)
      // 해당 월이거나 전월 마지막날
      return date.startsWith(month) || date === prevLastDay;
    });
  }, [extractDateFromFilename]);

  const handleAnalyze = useCallback(async () => {
    if (analyzing) return;
    cancelledRef.current = false;
    setAnalyzing(true);
    setProgress("분석 준비 중...");
    setProgressPct(0);
    setError("");

    let unlistenFn: (() => void) | null = null;
    try {
      unlistenFn = await listen<ObstacleMonthlyProgress>("obstacle-monthly-progress", (e) => {
        if (cancelledRef.current) return;
        setProgress(e.payload.message);
        if (e.payload.total > 0) setProgressPct(Math.round((e.payload.current / e.payload.total) * 100));
      });
      const excludeMs = aircraft.map((a) => a.mode_s_code).filter(Boolean);

      const radarFileSets = selectedRadars.map((r) => {
        let minObstacleDist = 0;
        for (const b of selectedBuildings) {
          const d = haversineKm(r.latitude, r.longitude, b.latitude, b.longitude);
          if (minObstacleDist === 0 || d < minObstacleDist) minObstacleDist = d;
        }
        const allFiles = radarFiles.get(r.name) ?? [];
        const monthFiles = filterFilesByMonth(allFiles, analysisMonth);
        const sectors = azSectorsByRadar.get(r.name) ?? [];

        // ── 진단 로그 ──
        console.group(`[OM 진단] 레이더 "${r.name}"`);
        console.log(`분석월: ${analysisMonth}`);
        console.log(`전체 파일: ${allFiles.length}개, 월 필터 후: ${monthFiles.length}개`);
        if (allFiles.length > 0 && monthFiles.length === 0) {
          console.warn("⚠ 월 필터로 전체 파일 제거됨! 파일명 날짜 추출 확인:");
          allFiles.slice(0, 5).forEach((f) => {
            const fname = f.split(/[/\\]/).pop() ?? f;
            console.log(`  ${fname} → 추출 날짜: ${extractDateFromFilename(f) ?? "실패"}`);
          });
        }
        console.log(`방위 섹터: ${sectors.length}개`, sectors.map((s) => `${s.start_deg.toFixed(6)}°~${s.end_deg.toFixed(6)}°`));
        console.log(`장애물 최소 거리: ${minObstacleDist.toFixed(2)} km`);
        console.log(`건물: ${selectedBuildings.map((b) => `${b.name}(${b.id})`).join(", ")}`);
        console.groupEnd();

        return {
          radar_name: r.name, radar_lat: r.latitude, radar_lon: r.longitude,
          radar_altitude: r.altitude, antenna_height: r.antenna_height,
          file_paths: monthFiles,
          azimuth_sectors: sectors,
          min_obstacle_distance_km: minObstacleDist,
        };
      });

      console.log("[OM 진단] invoke analyze_obstacle_monthly 호출...", {
        radars: radarFileSets.map((r) => ({ name: r.radar_name, files: r.file_paths.length, sectors: r.azimuth_sectors.length })),
        excludeModeS: excludeMs,
      });

      const result = await invoke<ObstacleMonthlyResult>("analyze_obstacle_monthly", { radarFileSets, excludeModeS: excludeMs });
      if (cancelledRef.current) return;

      // ── 백엔드 결과 진단 ──
      console.group("[OM 진단] 백엔드 결과");
      for (const rr of result.radar_results) {
        console.log(`레이더 "${rr.radar_name}": ${rr.daily_stats.length}일, ${rr.total_points_filtered} filtered pts, 파싱 ${rr.total_files_parsed}파일, 실패 ${rr.failed_files.length}파일`);
        if (rr.daily_stats.length > 0) {
          const dates = rr.daily_stats.map((d) => d.date);
          console.log(`  날짜 범위: ${dates[0]} ~ ${dates[dates.length - 1]}`);
        } else {
          console.warn(`  ⚠ daily_stats 비어있음 — 방위/거리 필터링 또는 파싱 실패 확인 필요`);
        }
        if (rr.failed_files.length > 0) console.warn(`  실패 파일:`, rr.failed_files);
      }
      console.groupEnd();

      setProgress("LoS 분석 중...");
      setProgressPct(0);
      const totalLosJobs = selectedRadars.length * selectedBuildings.length;
      const losJobs: { radar: RadarSite; bldg: ManualBuilding }[] = [];
      for (const radar of selectedRadars) {
        for (const bldg of selectedBuildings) losJobs.push({ radar, bldg });
      }
      const losMap = await computeLosBatch(losJobs, "om", totalLosJobs, (done) => {
        if (cancelledRef.current) return;
        setProgress(`LoS 분석 중... (${done}/${totalLosJobs})`);
        setProgressPct(Math.round((done / totalLosJobs) * 100));
      });
      if (cancelledRef.current) return;

      // LoS 계산 실패 건수 확인
      const expectedLosCount = selectedRadars.length * selectedBuildings.length;
      const actualLosCount = losMap.size;
      if (actualLosCount < expectedLosCount) {
        const failedCount = expectedLosCount - actualLosCount;
        setProgress(`LoS 분석 완료 (${failedCount}건 계산 실패 — 해당 건물 단면도 생략)`);
      }

      // 백엔드 결과에서 실제 데이터 월 자동 감지
      let effectiveMonth = analysisMonth;
      const allDates = result.radar_results.flatMap((rr) => rr.daily_stats.map((d) => d.date)).sort();
      if (allDates.length > 0) {
        const monthCounts = new Map<string, number>();
        for (const d of allDates) {
          const m = d.slice(0, 7);
          monthCounts.set(m, (monthCounts.get(m) ?? 0) + 1);
        }
        let detectedMonth = "";
        let maxCount = 0;
        for (const [m, c] of monthCounts) {
          if (c > maxCount) { detectedMonth = m; maxCount = c; }
        }
        if (detectedMonth && !allDates.some((d) => d.startsWith(analysisMonth))) {
          console.warn(`[OM 진단] 선택 월 "${analysisMonth}"에 데이터 없음, 감지 월: "${detectedMonth}"`);
          setProgress(`⚠ 선택 월(${analysisMonth})에 데이터 없음 → ${detectedMonth}로 자동 변경`);
          effectiveMonth = detectedMonth;
          setAnalysisMonth(detectedMonth);
        }
      } else {
        console.warn(`[OM 진단] ⚠ 백엔드에서 daily_stats가 전혀 없음 — 파싱/필터링 단계 확인 필요`);
      }

      // 날짜 필터링
      const filteredResult: ObstacleMonthlyResult = {
        ...result,
        radar_results: result.radar_results.map((rr) => {
          const before = rr.daily_stats.length;
          const after = effectiveMonth
            ? rr.daily_stats.filter((d) => d.date.startsWith(effectiveMonth))
            : rr.daily_stats;
          if (before > 0 && after.length === 0) {
            console.warn(`[OM 진단] ⚠ "${rr.radar_name}" 월 필터링으로 ${before}일 → 0일! effectiveMonth="${effectiveMonth}", 원본 날짜: ${rr.daily_stats.map((d) => d.date).join(", ")}`);
            setProgress(`⚠ ${rr.radar_name}: 분석월 필터링 후 데이터 0일 — 해당 레이더 섹션 비어있을 수 있음`);
          }
          return { ...rr, daily_stats: after };
        }),
      };

      if (cancelledRef.current) return;

      // 커버리지 계산 — 전체 레이더 순회 (실패해도 보고서는 생성)
      const covWithMap = new Map<string, CoverageLayer[]>();
      const covWithoutMap = new Map<string, CoverageLayer[]>();
      if (selectedRadars.length > 0) {
        const altFts = [1000, 2000, 3000, 5000, 10000, 15000, 20000, 25000, 30000];
        const excludeIds = selectedBuildings.map((b) => b.id);
        try {
          const { computeCoverageLayersOM } = await import("../../utils/gpuCoverage");
          for (let ri = 0; ri < selectedRadars.length; ri++) {
            if (cancelledRef.current) break;
            const r = selectedRadars[ri];
            setProgress(`커버리지 계산 중... (${r.name}, ${ri + 1}/${selectedRadars.length})`);
            setProgressPct(85 + Math.floor((ri / selectedRadars.length) * 8));
            const covResult = await computeCoverageLayersOM(
              { radarName: r.name, radarLat: r.latitude, radarLon: r.longitude, radarAltitude: r.altitude, antennaHeight: r.antenna_height, rangeNm: r.range_nm, bearingStepDeg: 0.01 },
              altFts, excludeIds,
              (msg) => { if (!cancelledRef.current) { setProgress(`[${r.name}] ${msg}`); } },
            );
            covWithMap.set(r.name, covResult.layersWith);
            covWithoutMap.set(r.name, covResult.layersWithout);
          }
        } catch (err) {
          console.warn("GPU 커버리지 계산 실패:", err);
          onCoverageError?.();
          try {
            const { message } = await import("@tauri-apps/plugin-dialog");
            message("커버리지 계산에 실패했습니다. 커버리지 비교 없이 보고서가 생성됩니다.", {
              title: "커버리지 계산 실패",
              kind: "warning",
            });
          } catch { /* ignore */ }
        }
      }

      if (cancelledRef.current) return;

      // 보고서 생성
      setProgress("보고서 생성 중...");
      setProgressPct(95);
      await onGenerate(filteredResult, selectedBuildings, selectedRadars, azSectorsByRadar, losMap, covWithMap, covWithoutMap, effectiveMonth);

      if (covWithMap.size > 0) onCoverageReady(covWithMap, covWithoutMap);

      setProgress("보고서 로딩 완료");
      setProgressPct(100);
    } catch (err) {
      if (!cancelledRef.current) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`분석 중 오류가 발생했습니다. 데이터 파일과 레이더 설정을 확인 후 다시 시도해주세요. (${msg})`);
      }
    } finally {
      unlistenFn?.();
      setAnalyzing(false);
    }
  }, [analyzing, selectedRadars, selectedBuildings, radarFiles, azSectorsByRadar, aircraft, onGenerate, onCoverageReady, onCoverageError, analysisMonth, filterFilesByMonth]);

  const allFilesSelected = selectedRadars.every((r) => (radarFiles.get(r.name)?.length ?? 0) > 0);
  const canAnalyze = selectedRadars.length > 0 && selectedBuildings.length > 0 && allFilesSelected && !analyzing;

  const canNext = (s: number) => {
    if (s === 0) return true; // 분석월은 항상 선택됨
    if (s === 1) return checkedRadars.size > 0;
    if (s === 2) return checkedBldgIds.size > 0;
    return false;
  };

  return (
    <Modal open onClose={onClose} title="장애물 월간 보고서 설정" width="max-w-2xl" closable={false}>
      <div className="space-y-5">
        {/* ── 스텝 콘텐츠 ── */}
        <div className="min-h-[260px]">
          {/* Step 0: 분석월 */}
          {step === 0 && (
            <div className="flex flex-col items-center gap-6 py-8">
              <div className="text-center">
                <h3 className="text-sm font-semibold text-gray-700">분석 대상 월을 선택하세요</h3>
                <p className="mt-1 text-[11px] text-gray-400">해당 월의 데이터만 보고서에 포함됩니다</p>
              </div>
              <MonthPicker value={analysisMonth} onChange={setAnalysisMonth} />
            </div>
          )}

          {/* Step 1: 레이더 선택 */}
          {step === 1 && (
            <div>
              <div className="mb-3 text-center">
                <h3 className="text-sm font-semibold text-gray-700">분석할 레이더를 선택하세요</h3>
                <p className="mt-0.5 text-[11px] text-gray-400">복수 선택 가능</p>
              </div>
              <div className="space-y-1.5 rounded-xl border border-gray-200 p-3">
                {customRadarSites.map((r) => {
                  const checked = checkedRadars.has(r.name);
                  return (
                    <button key={r.name} onClick={() => setCheckedRadars((prev) => { const next = new Set(prev); if (next.has(r.name)) next.delete(r.name); else next.add(r.name); return next; })}
                      className={`flex w-full items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-left transition-all ${checked ? "border-[#a60739] bg-[#a60739] text-white shadow-sm shadow-[#a60739]/10" : "border-gray-100 hover:border-gray-300 hover:bg-gray-50"}`}>
                      {checked ? <CheckSquare size={15} className="shrink-0 text-white" /> : <Square size={15} className="shrink-0 text-gray-300" />}
                      <span className={`text-[12px] font-medium ${checked ? "text-white" : "text-gray-600"}`}>{r.name}</span>
                      <span className={`ml-auto text-[10px] ${checked ? "text-white/70" : "text-gray-400"}`}>{r.latitude.toFixed(4)}°N {r.longitude.toFixed(4)}°E</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Step 2: 장애물 선택 */}
          {step === 2 && (
            <div>
              <div className="mb-3 text-center">
                <h3 className="text-sm font-semibold text-gray-700">분석 대상 장애물을 선택하세요</h3>
                <p className="mt-0.5 text-[11px] text-gray-400">수동 건물, 복수 선택 가능</p>
              </div>
              {manualBuildings.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-8">
                  <Building2 size={32} className="text-gray-300" />
                  <p className="text-xs text-gray-400">등록된 수동 건물이 없습니다. 그리기 도구에서 건물을 먼저 등록하세요.</p>
                </div>
              ) : (
                <>
                  <div className="mb-1.5 flex gap-2 text-[11px]">
                    <button onClick={() => setCheckedBldgIds(new Set(manualBuildings.map((b) => b.id)))} className="text-[#a60739] hover:underline">전체 선택</button>
                    <button onClick={() => setCheckedBldgIds(new Set())} className="text-gray-400 hover:underline">전체 해제</button>
                  </div>
                  <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-xl border border-gray-200 p-2.5">
                    {(() => {
                      const groupMap = new Map<number | null, ManualBuilding[]>();
                      for (const b of manualBuildings) { const gid = b.group_id ?? null; if (!groupMap.has(gid)) groupMap.set(gid, []); groupMap.get(gid)!.push(b); }
                      const orderedKeys: (number | null)[] = [
                        ...buildingGroups.map((g) => g.id).filter((id) => groupMap.has(id)),
                        ...(groupMap.has(null) ? [null as number | null] : []),
                        ...[...groupMap.keys()].filter((k) => k !== null && !buildingGroups.find((g) => g.id === k)),
                      ];

                      const renderBuilding = (b: ManualBuilding) => {
                        const checked = checkedBldgIds.has(b.id);
                        const azInfo = selectedRadars.map((r) => {
                          const sector = calcBuildingAzExtent(r.latitude, r.longitude, b);
                          return `${r.name}: ${sector.start_deg.toFixed(0)}°~${sector.end_deg.toFixed(0)}°`;
                        }).join(", ");
                        return (
                          <button key={b.id} onClick={() => setCheckedBldgIds((prev) => { const next = new Set(prev); if (next.has(b.id)) next.delete(b.id); else next.add(b.id); return next; })}
                            className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-1.5 text-left transition-all ${checked ? "border-[#a60739] bg-[#a60739] text-white shadow-sm shadow-[#a60739]/10" : "border-gray-100 hover:border-gray-300 hover:bg-gray-50"}`}>
                            {checked ? <CheckSquare size={14} className="shrink-0 text-white" /> : <Square size={14} className="shrink-0 text-gray-300" />}
                            <div className="min-w-0 flex-1">
                              <span className={`text-[12px] font-medium ${checked ? "text-white" : "text-gray-500"}`}>{b.name || `건물 ${b.id}`}</span>
                              <span className={`ml-2 text-[10px] ${checked ? "text-white/70" : "text-gray-400"}`}>{b.height.toFixed(0)}m · {b.geometry_type}</span>
                              {checked && selectedRadars.length > 0 && <p className="mt-0.5 text-[9px] text-white/60">{azInfo}</p>}
                            </div>
                          </button>
                        );
                      };

                      return orderedKeys.map((gid) => {
                        const buildings = groupMap.get(gid) ?? [];
                        if (buildings.length === 0) return null;
                        const group = gid !== null ? buildingGroups.find((g) => g.id === gid) : null;
                        const groupName = group?.name ?? (gid !== null ? `그룹 ${gid}` : "미분류");
                        const groupColor = group?.color ?? "#9ca3af";
                        const collapsed = collapsedGroups.has(gid);
                        const groupBldgIds = buildings.map((b) => b.id);
                        const allChecked = groupBldgIds.every((id) => checkedBldgIds.has(id));
                        const someChecked = groupBldgIds.some((id) => checkedBldgIds.has(id));
                        return (
                          <div key={gid ?? "ungrouped"} className="mb-1">
                            <div className="flex items-center gap-1">
                              <button onClick={() => setCheckedBldgIds((prev) => { const next = new Set(prev); if (allChecked) groupBldgIds.forEach((id) => next.delete(id)); else groupBldgIds.forEach((id) => next.add(id)); return next; })} className="shrink-0 p-0.5">
                                {allChecked ? <CheckSquare size={14} className="text-[#a60739]" /> : someChecked ? <MinusSquare size={14} className="text-[#a60739]/50" /> : <Square size={14} className="text-gray-300" />}
                              </button>
                              <button onClick={() => setCollapsedGroups((prev) => { const next = new Set(prev); if (next.has(gid)) next.delete(gid); else next.add(gid); return next; })}
                                className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] font-semibold text-gray-600 hover:bg-gray-100">
                                {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: groupColor }} />
                                <span>{groupName}</span>
                                <span className="ml-1 font-normal text-gray-400">({buildings.length})</span>
                              </button>
                            </div>
                            {!collapsed && <div className="ml-6 mt-0.5 space-y-0.5">{buildings.map(renderBuilding)}</div>}
                          </div>
                        );
                      });
                    })()}
                  </div>

                  {selectedRadars.length > 0 && selectedBuildings.length > 0 && (
                    <div className="mt-2.5 rounded-lg bg-gray-50 px-3 py-2 text-[10px]">
                      {selectedRadars.map((r) => {
                        const sectors = azSectorsByRadar.get(r.name) ?? [];
                        return (
                          <div key={r.name}>
                            <span className="text-gray-400">{r.name} 분석 구간:</span>{" "}
                            <span className="font-mono font-semibold text-[#a60739]">{sectors.map((s) => `${s.start_deg.toFixed(1)}°~${s.end_deg.toFixed(1)}°`).join(", ")}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Step 3: 파일 선택 + 분석 */}
          {step === 3 && (
            <div>
              <div className="mb-3 text-center">
                <h3 className="text-sm font-semibold text-gray-700">레이더별 ASS 파일을 선택하세요</h3>
                <p className="mt-0.5 text-[11px] text-gray-400">분석월에 해당하는 데이터 파일</p>
              </div>

              {/* 선택 요약 */}
              <div className="mb-4 grid grid-cols-3 gap-2">
                <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-center">
                  <p className="text-[10px] text-gray-400">분석월</p>
                  <p className="mt-0.5 text-[12px] font-semibold text-gray-700">{analysisMonth}</p>
                </div>
                <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-center">
                  <p className="text-[10px] text-gray-400">레이더</p>
                  <p className="mt-0.5 text-[12px] font-semibold text-gray-700">{selectedRadars.map((r) => r.name).join(", ")}</p>
                </div>
                <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-center">
                  <p className="text-[10px] text-gray-400">장애물</p>
                  <p className="mt-0.5 text-[12px] font-semibold text-gray-700">{selectedBuildings.length}개</p>
                </div>
              </div>

              <div className="space-y-2">
                {selectedRadars.map((r) => {
                  const files = radarFiles.get(r.name) ?? [];
                  const monthFiles = filterFilesByMonth(files, analysisMonth);
                  const skipped = files.length - monthFiles.length;
                  return (
                    <div key={r.name} className="rounded-xl border border-gray-200 p-3.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Radio size={14} className="text-[#a60739]" />
                          <span className="text-[12px] font-semibold text-gray-700">{r.name}</span>
                        </div>
                        <button onClick={() => handleSelectFiles(r.name)}
                          className="flex items-center gap-1.5 rounded-lg bg-gray-100 px-3 py-1.5 text-[11px] text-gray-600 hover:bg-gray-200 transition-colors">
                          <FolderOpen size={12} />
                          파일 선택
                        </button>
                      </div>
                      {files.length > 0 ? (
                        <div className="mt-1.5">
                          <p className="text-[10px] font-medium text-[#a60739]">
                            {files.length}개 파일 선택됨
                            {` (${monthFiles.length}개 파싱 예정`}
                            {skipped > 0 ? `, ${skipped}개 월 불일치 제외` : ""}
                            {")"}
                          </p>
                        </div>
                      ) : (
                        <p className="mt-1.5 text-[10px] text-gray-400">파일을 선택해주세요</p>
                      )}
                    </div>
                  );
                })}
              </div>

              {analyzing && (
                <div className="mt-4 rounded-xl border border-[#a60739]/20 bg-[#a60739]/5 p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Loader2 size={14} className="animate-spin text-[#a60739]" />
                      <span className="text-[12px] text-gray-700">{progress}</span>
                    </div>
                    <button onClick={async () => { cancelledRef.current = true; try { await invoke("cancel_analysis"); } catch { /* ignore */ } setAnalyzing(false); setProgress(""); setProgressPct(0); }}
                      className="rounded-lg border border-red-200 bg-white px-2.5 py-1 text-[11px] text-red-600 hover:bg-red-50 transition-colors">중단</button>
                  </div>
                  <div className="mt-2.5 h-2 rounded-full bg-gray-200 overflow-hidden">
                    <div className="h-full rounded-full bg-[#a60739] transition-all duration-300" style={{ width: `${progressPct}%` }} />
                  </div>
                </div>
              )}
              {!analyzing && error && (
                <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3.5">
                  <p className="text-[12px] text-red-700">{error}</p>
                  <button onClick={() => setError("")} className="mt-2 text-[11px] text-red-500 hover:underline">닫기</button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── 네비게이션 ── */}
        <div className="flex items-center justify-between border-t border-gray-100 pt-4">
          <div>
            {step > 0 && !analyzing && (
              <button onClick={() => setStep((s) => s - 1)}
                className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-4 py-2 text-[12px] text-gray-600 hover:bg-gray-50 transition-colors">
                <ArrowLeft size={14} />
                이전
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-[12px] text-gray-600 hover:bg-gray-50 transition-colors">취소</button>
            {step < 3 ? (
              <button onClick={() => setStep((s) => s + 1)} disabled={!canNext(step)}
                className="flex items-center gap-1.5 rounded-lg bg-[#a60739] px-5 py-2 text-[12px] font-medium text-white transition-colors hover:bg-[#85062e] disabled:opacity-40">
                다음
                <ArrowRight size={14} />
              </button>
            ) : (
              <button onClick={handleAnalyze} disabled={!canAnalyze}
                className="flex items-center gap-1.5 rounded-lg bg-[#a60739] px-5 py-2 text-[12px] font-medium text-white transition-colors hover:bg-[#85062e] disabled:opacity-40">
                <BarChart3 size={14} />
                분석 시작
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
