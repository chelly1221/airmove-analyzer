import { useState, useCallback, useRef, useEffect } from "react";
import { Radar, Loader2, ChevronDown } from "lucide-react";
import type { MapRef } from "react-map-gl/maplibre";
import { useAppStore } from "../../store";
import type { RadarSite } from "../../types";
import { computeMainCoverage, isGPUCacheValidFor, invalidateGPUCache, COVERAGE_MIN_ALT_FT, COVERAGE_MAX_ALT_FT, COVERAGE_ALT_STEP_FT } from "../../utils/radarCoverage";

interface Props {
  radarSite: RadarSite;
  gpuCacheReady: boolean;
  setGpuCacheReady: (v: boolean) => void;
  coverageAlt: number;
  setCoverageAlt: (v: number) => void;
  coverageAltMin: number;
  setCoverageAltMin: (v: number) => void;
  coverageOpacity: number;
  setCoverageOpacity: (v: number) => void;
  coverageExpanded: boolean;
  setCoverageExpanded: (v: boolean) => void;
  coverageRendering: boolean;
  mapRef: React.RefObject<MapRef | null>;
}

export default function CoveragePanel({
  radarSite, gpuCacheReady, setGpuCacheReady,
  coverageAlt, setCoverageAlt, coverageAltMin, setCoverageAltMin,
  coverageOpacity, setCoverageOpacity,
  coverageExpanded, setCoverageExpanded,
  coverageRendering,
  mapRef,
}: Props) {
  const coverageVisible = useAppStore((s) => s.coverageVisible);
  const setCoverageVisible = useAppStore((s) => s.setCoverageVisible);
  const coverageLoading = useAppStore((s) => s.coverageLoading);
  const setCoverageLoading = useAppStore((s) => s.setCoverageLoading);
  const setCoverageProgress = useAppStore((s) => s.setCoverageProgress);
  const setCoverageProgressPct = useAppStore((s) => s.setCoverageProgressPct);
  const coverageError = useAppStore((s) => s.coverageError);
  const setCoverageError = useAppStore((s) => s.setCoverageError);
  const setCoverageData = useAppStore((s) => s.setCoverageData);

  const [coverageAltInput, setCoverageAltInput] = useState(coverageAlt);
  const [coverageAltMinInput, setCoverageAltMinInput] = useState(coverageAltMin);
  const coverageAltTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const coverageAltMinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const coverageComputeAbortRef = useRef(0);

  useEffect(() => {
    return () => {
      if (coverageAltTimerRef.current) clearTimeout(coverageAltTimerRef.current);
      if (coverageAltMinTimerRef.current) clearTimeout(coverageAltMinTimerRef.current);
    };
  }, []);

  const handleCoverageAltChange = useCallback((val: number) => {
    setCoverageAltInput(val);
    if (coverageAltTimerRef.current) clearTimeout(coverageAltTimerRef.current);
    coverageAltTimerRef.current = setTimeout(() => setCoverageAlt(val), 150);
  }, [setCoverageAlt]);

  const handleCoverageAltMinChange = useCallback((val: number) => {
    setCoverageAltMinInput(val);
    if (coverageAltMinTimerRef.current) clearTimeout(coverageAltMinTimerRef.current);
    coverageAltMinTimerRef.current = setTimeout(() => setCoverageAltMin(val), 150);
  }, [setCoverageAltMin]);

  const startCoverageCompute = useCallback(async (force = false) => {
    const computeSeq = ++coverageComputeAbortRef.current;
    setCoverageLoading(true);
    setCoverageError("");
    setCoverageProgressPct(0);
    setCoverageProgress("준비 중...");
    try {
      if (force) invalidateGPUCache();

      const result = await computeMainCoverage(
        radarSite,
        (pct, msg) => {
          if (coverageComputeAbortRef.current !== computeSeq) return;
          setCoverageProgressPct(Math.round(pct));
          setCoverageProgress(msg);
        },
      );
      if (coverageComputeAbortRef.current !== computeSeq) return;
      setGpuCacheReady(true);
      setCoverageVisible(true);
      setCoverageData(result);

      const map = mapRef.current?.getMap();
      if (map) {
        const rangeKm = radarSite.range_nm * 1.852;
        const latOff = (rangeKm * 1.05) / 111.32;
        const lonOff = (rangeKm * 1.05) / (111.32 * Math.cos(radarSite.latitude * Math.PI / 180));
        map.fitBounds(
          [[radarSite.longitude - lonOff, radarSite.latitude - latOff],
           [radarSite.longitude + lonOff, radarSite.latitude + latOff]],
          { padding: 40, duration: 800 },
        );
      }
    } catch (err) {
      if (coverageComputeAbortRef.current !== computeSeq) return;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("커버리지 계산 실패:", err);
      setCoverageError(`계산 실패: ${errMsg}`);
    } finally {
      if (coverageComputeAbortRef.current === computeSeq) {
        setCoverageLoading(false);
        setCoverageProgress("");
        setCoverageProgressPct(0);
      }
    }
  }, [radarSite, mapRef, setGpuCacheReady, setCoverageLoading, setCoverageProgress, setCoverageProgressPct, setCoverageError, setCoverageVisible, setCoverageData]);

  // 토글 ON/OFF — 계산 중에도 OFF 가능
  const handleToggle = useCallback(() => {
    if (coverageVisible || coverageLoading) {
      // OFF: 진행 중 계산 무효화 + 상태 초기화
      ++coverageComputeAbortRef.current;
      setCoverageVisible(false);
      if (coverageLoading) {
        setCoverageLoading(false);
        setCoverageProgress("");
        setCoverageProgressPct(0);
        invalidateGPUCache();
      }
    } else {
      if (!gpuCacheReady || !isGPUCacheValidFor(radarSite)) {
        startCoverageCompute(true);
      } else {
        setCoverageVisible(true);
      }
    }
  }, [coverageLoading, coverageVisible, gpuCacheReady, radarSite, setCoverageVisible, setCoverageLoading, setCoverageProgress, setCoverageProgressPct, startCoverageCompute]);

  const cacheValid = gpuCacheReady && isGPUCacheValidFor(radarSite);
  const isActive = coverageVisible && cacheValid;

  return (
    <div className={`rounded-lg border transition-colors ${isActive ? "border-[#a60739]/30 bg-[#a60739]/5" : "border-gray-200 bg-gray-50"}`}>
      {/* 헤더: 접기/펼치기 */}
      <button
        onClick={() => setCoverageExpanded(!coverageExpanded)}
        className="flex w-full items-center justify-between px-3 py-2.5"
      >
        <div className="flex items-center gap-2">
          <Radar size={14} className={isActive ? "text-[#a60739]" : "text-gray-400"} />
          <span className={`text-xs font-medium ${isActive ? "text-[#a60739]" : "text-gray-600"}`}>커버리지 맵</span>
          {(coverageLoading || coverageRendering) && <>
            <Loader2 size={12} className="animate-spin text-[#a60739]" />
            <span className="text-[10px] text-[#a60739]/70">계산중</span>
          </>}
        </div>
        <ChevronDown size={14} className={`transition-transform text-gray-400 ${coverageExpanded ? "rotate-180" : ""}`} />
      </button>

      {/* 펼친 내용: 토글 + 슬라이더 등 */}
      {coverageExpanded && (
        <div className="px-3 pb-2.5 space-y-3">
          {/* 토글 */}
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-gray-500">표시</span>
            <button
              onClick={handleToggle}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${isActive ? "bg-[#a60739]" : "bg-gray-300"}`}
              role="switch"
              aria-checked={isActive}

            >
              <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${isActive ? "translate-x-4.5" : "translate-x-0.5"}`} />
            </button>
          </div>
          {coverageError && (
            <div className="rounded-md bg-red-50 px-2.5 py-1.5 text-[11px] text-red-600">
              {coverageError}
            </div>
          )}

          {cacheValid ? (
            <div className="space-y-2.5">
              {/* 투명도 */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-gray-500">투명도</span>
                  <span className="text-[10px] font-medium text-[#a60739]">
                    {Math.round((1 - coverageOpacity) * 100)}%
                  </span>
                </div>
                <input
                  type="range" min={0.1} max={1} step={0.05}
                  value={1.1 - coverageOpacity}
                  onChange={(e) => setCoverageOpacity(1.1 - Number(e.target.value))}
                  className="w-full accent-[#a60739]"
                />
              </div>

              {/* 고도 범위 */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-gray-500">고도</span>
                  <span className="text-[10px] font-medium text-[#a60739]">
                    {coverageAltMinInput.toLocaleString()}~{coverageAltInput.toLocaleString()}ft
                  </span>
                </div>
                {(() => {
                  const totalRange = COVERAGE_MAX_ALT_FT - COVERAGE_MIN_ALT_FT;
                  const pctMin = ((Math.min(coverageAltMinInput, coverageAltInput) - COVERAGE_MIN_ALT_FT) / totalRange) * 100;
                  const pctMax = ((Math.max(coverageAltMinInput, coverageAltInput) - COVERAGE_MIN_ALT_FT) / totalRange) * 100;
                  return (
                    <div className="relative h-6">
                      <div className="absolute top-1/2 left-[8px] right-[8px] h-1.5 -translate-y-1/2 rounded-full bg-gray-200" />
                      <div
                        className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-[#a60739]"
                        style={{ left: `calc(8px + (100% - 16px) * ${pctMin / 100})`, right: `calc(8px + (100% - 16px) * ${(100 - pctMax) / 100})` }}
                      />
                      <input
                        type="range" min={COVERAGE_MIN_ALT_FT} max={COVERAGE_MAX_ALT_FT} step={COVERAGE_ALT_STEP_FT}
                        value={coverageAltMinInput}
                        onChange={(e) => { const v = Number(e.target.value); handleCoverageAltMinChange(Math.min(v, coverageAltInput)); }}
                        style={{ zIndex: coverageAltMinInput > (COVERAGE_MAX_ALT_FT + COVERAGE_MIN_ALT_FT) / 2 ? 30 : 20 }}
                        className="coverage-range-thumb absolute left-0 right-0 top-1/2 -translate-y-1/2 w-full appearance-none bg-transparent cursor-pointer pointer-events-none"
                        aria-label="최소 고도"
                      />
                      <input
                        type="range" min={COVERAGE_MIN_ALT_FT} max={COVERAGE_MAX_ALT_FT} step={COVERAGE_ALT_STEP_FT}
                        value={coverageAltInput}
                        onChange={(e) => { const v = Number(e.target.value); handleCoverageAltChange(Math.max(v, coverageAltMinInput)); }}
                        style={{ zIndex: coverageAltMinInput > (COVERAGE_MAX_ALT_FT + COVERAGE_MIN_ALT_FT) / 2 ? 20 : 30 }}
                        className="coverage-range-thumb absolute left-0 right-0 top-1/2 -translate-y-1/2 w-full appearance-none bg-transparent cursor-pointer pointer-events-none"
                        aria-label="최대 고도"
                      />
                    </div>
                  );
                })()}
                <div className="flex justify-between text-[9px] text-gray-400">
                  <span>{COVERAGE_MIN_ALT_FT.toLocaleString()}ft</span>
                  <span>{COVERAGE_MAX_ALT_FT.toLocaleString()}ft</span>
                </div>
              </div>
            </div>
          ) : !coverageLoading ? (
            <div className="text-[10px] text-gray-500 text-center py-1">
              토글을 켜면 커버리지를 자동 계산합니다
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
