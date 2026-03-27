/**
 * 장애물 전파영향 사전검토 설정 모달 (스텝별 위자드)
 * 보고서 창에서 렌더링됨. 분석월 → 레이더 → 건물 → 파일 선택+분석.
 */
import { useState, useRef, useCallback, useEffect } from "react";
import { CheckSquare, Square, ChevronRight, ChevronDown, MinusSquare, Loader2, BarChart3, Calendar, Radio, Building2, FolderOpen, ArrowRight, ArrowLeft } from "lucide-react";
import { format } from "date-fns";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import Modal from "../common/Modal";
import MonthPicker from "../common/MonthPicker";
import { computeLosBatch, calcBuildingAzExtent, mergeAzSectors } from "../../utils/obstacleAnalysisHelpers";
import type { CoverageLayer } from "../../utils/radarCoverage";
import type {
  RadarSite, Aircraft as AircraftType, ReportMetadata, ManualBuilding, BuildingGroup,
  AzSector, ObstacleMonthlyProgress, PreScreeningResult, LoSProfileData,
} from "../../types";

export default function ObstaclePreScreeningModal({
  customRadarSites,
  aircraft,
  metadata,
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
    result: PreScreeningResult,
    buildings: ManualBuilding[],
    radars: RadarSite[],
    losMap: Map<string, LoSProfileData>,
    covWith: CoverageLayer[],
    covWithout: CoverageLayer[],
    analysisMonth?: string,
  ) => void;
  onCoverageReady: (covWith: CoverageLayer[], covWithout: CoverageLayer[]) => void;
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
  const psCancelledRef = useRef(false);
  useEffect(() => { psCancelledRef.current = false; return () => { psCancelledRef.current = true; }; }, []);

  useEffect(() => {
    invoke<ManualBuilding[]>("list_manual_buildings").then(setManualBuildings).catch(() => {});
    invoke<BuildingGroup[]>("list_building_groups").then(setBuildingGroups).catch(() => {});
  }, []);

  const selectedRadars = customRadarSites.filter((r) => checkedRadars.has(r.name));
  const selectedBuildings = manualBuildings.filter((b) => checkedBldgIds.has(b.id));

  const handleSelectFiles = useCallback(async (radarName: string) => {
    const result = await open({ multiple: true, filters: [{ name: "ASS Files", extensions: ["ass", "ASS"] }] });
    if (result && Array.isArray(result)) {
      setRadarFiles((prev) => { const next = new Map(prev); next.set(radarName, result.map((r) => typeof r === "string" ? r : r)); return next; });
    }
  }, []);

  const handleAnalyze = useCallback(async () => {
    if (analyzing) return;
    setAnalyzing(true);
    setProgress("분석 준비 중...");
    setProgressPct(0);

    let unlistenFn: (() => void) | null = null;
    try {
      unlistenFn = await listen<ObstacleMonthlyProgress>("pre-screening-progress", (e) => {
        setProgress(e.payload.message);
        if (e.payload.total > 0) setProgressPct(Math.round((e.payload.current / e.payload.total) * 100));
      });

      const excludeMs = aircraft.map((a) => a.mode_s_code).filter(Boolean);

      const azSectorsByRadar = new Map<string, AzSector[]>();
      for (const r of selectedRadars) {
        const sectors = selectedBuildings.map((b) => calcBuildingAzExtent(r.latitude, r.longitude, b));
        azSectorsByRadar.set(r.name, mergeAzSectors(sectors));
      }

      const radarFileSets = selectedRadars.map((r) => ({
        radar_name: r.name, radar_lat: r.latitude, radar_lon: r.longitude,
        radar_altitude: r.altitude, antenna_height: r.antenna_height,
        file_paths: radarFiles.get(r.name) ?? [],
        azimuth_sectors: azSectorsByRadar.get(r.name) ?? [],
      }));

      const proposedBuildings = selectedBuildings.map((b) => ({
        id: b.id, name: b.name || `건물 ${b.id}`,
        latitude: b.latitude, longitude: b.longitude,
        height_m: b.height, ground_elev_m: b.ground_elev,
      }));

      const result = await invoke<PreScreeningResult>("analyze_pre_screening", { radarFileSets, proposedBuildings, excludeModeS: excludeMs });
      if (psCancelledRef.current) return;

      setProgress("LoS 분석 중...");
      const losJobs: { radar: RadarSite; bldg: ManualBuilding }[] = [];
      for (const radar of selectedRadars) {
        for (const bldg of selectedBuildings) losJobs.push({ radar, bldg });
      }
      const losMap = await computeLosBatch(losJobs, "ps", losJobs.length, (done) => {
        setProgress(`LoS 분석 중... (${done}/${losJobs.length})`);
      });

      onGenerate(result, selectedBuildings, selectedRadars, losMap, [], [], analysisMonth);

      if (selectedRadars.length > 0) {
        const r = selectedRadars[0];
        const altFts = [1000, 2000, 3000, 5000, 10000, 15000, 20000, 25000, 30000];
        const excludeIds = selectedBuildings.map((b) => b.id);
        import("../../utils/gpuCoverage").then(({ computeCoverageLayersOM }) =>
          computeCoverageLayersOM(
            { radarName: r.name, radarLat: r.latitude, radarLon: r.longitude, radarAltitude: r.altitude, antennaHeight: r.antenna_height, rangeNm: r.range_nm, bearingStepDeg: 0.01 },
            altFts, excludeIds,
          ).then(({ layersWith, layersWithout }) => {
            onCoverageReady(layersWith, layersWithout);
          }).catch((err) => {
            console.warn("커버리지 계산 실패:", err);
            onCoverageError?.();
          }),
        );
      }
    } catch (err) {
      setProgress(`분석 중 오류가 발생했습니다. 데이터 파일과 레이더 설정을 확인 후 다시 시도해주세요. (${err instanceof Error ? err.message : String(err)})`);
    } finally {
      unlistenFn?.();
      setAnalyzing(false);
    }
  }, [analyzing, selectedRadars, selectedBuildings, radarFiles, aircraft, onGenerate, onCoverageError, analysisMonth]);

  const allFilesSelected = selectedRadars.every((r) => (radarFiles.get(r.name)?.length ?? 0) > 0);
  const canAnalyze = selectedRadars.length > 0 && selectedBuildings.length > 0 && allFilesSelected && !analyzing;

  const canNext = (s: number) => {
    if (s === 0) return true;
    if (s === 1) return checkedRadars.size > 0;
    if (s === 2) return checkedBldgIds.size > 0;
    return false;
  };

  return (
    <Modal open onClose={onClose} title="장애물 전파영향 사전검토 설정" width="max-w-2xl" closable={false}>
      <div className="space-y-5">
        {/* 기관 정보 */}
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-2.5 text-[12px]">
          <span className="text-gray-400">기관</span>
          <span className="ml-3 font-medium text-gray-700">{metadata.organization}</span>
        </div>

        {/* ── 스텝 콘텐츠 ── */}
        <div className="min-h-[260px]">
          {/* Step 0: 분석월 */}
          {step === 0 && (
            <div className="flex flex-col items-center gap-6 py-8">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[#a60739]/10">
                <Calendar size={28} className="text-[#a60739]" />
              </div>
              <div className="text-center">
                <h3 className="text-sm font-semibold text-gray-700">분석 대상 월을 선택하세요</h3>
                <p className="mt-1 text-[11px] text-gray-400">한달분 ASS 데이터를 선택하세요</p>
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

          {/* Step 2: 검토 대상 건물 선택 */}
          {step === 2 && (
            <div>
              <div className="mb-3 text-center">
                <h3 className="text-sm font-semibold text-gray-700">검토 대상 건물을 선택하세요</h3>
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
                        return (
                          <button key={b.id} onClick={() => setCheckedBldgIds((prev) => { const next = new Set(prev); if (next.has(b.id)) next.delete(b.id); else next.add(b.id); return next; })}
                            className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-1.5 text-left transition-all ${checked ? "border-[#a60739] bg-[#a60739] text-white shadow-sm shadow-[#a60739]/10" : "border-gray-100 hover:border-gray-300 hover:bg-gray-50"}`}>
                            {checked ? <CheckSquare size={14} className="shrink-0 text-white" /> : <Square size={14} className="shrink-0 text-gray-300" />}
                            <div className="min-w-0 flex-1">
                              <span className={`text-[12px] font-medium ${checked ? "text-white" : "text-gray-500"}`}>{b.name || `건물 ${b.id}`}</span>
                              <span className={`ml-2 text-[10px] ${checked ? "text-white/70" : "text-gray-400"}`}>{b.height.toFixed(0)}m · {b.geometry_type}</span>
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
                </>
              )}
            </div>
          )}

          {/* Step 3: 파일 선택 + 분석 */}
          {step === 3 && (
            <div>
              <div className="mb-3 text-center">
                <h3 className="text-sm font-semibold text-gray-700">레이더별 ASS 파일을 선택하세요</h3>
                <p className="mt-0.5 text-[11px] text-gray-400">한달분 데이터 파일</p>
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
                  <p className="text-[10px] text-gray-400">검토 대상</p>
                  <p className="mt-0.5 text-[12px] font-semibold text-gray-700">{selectedBuildings.length}개</p>
                </div>
              </div>

              <div className="space-y-2">
                {selectedRadars.map((r) => {
                  const files = radarFiles.get(r.name) ?? [];
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
                        <p className="mt-1.5 text-[10px] font-medium text-[#a60739]">{files.length}개 파일 선택됨</p>
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
                    <button onClick={async () => { try { await invoke("cancel_analysis"); } catch { /* ignore */ } setAnalyzing(false); setProgress(""); setProgressPct(0); }}
                      className="rounded-lg border border-red-200 bg-white px-2.5 py-1 text-[11px] text-red-600 hover:bg-red-50 transition-colors">중단</button>
                  </div>
                  <div className="mt-2.5 h-2 rounded-full bg-gray-200 overflow-hidden">
                    <div className="h-full rounded-full bg-[#a60739] transition-all duration-300" style={{ width: `${progressPct}%` }} />
                  </div>
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
