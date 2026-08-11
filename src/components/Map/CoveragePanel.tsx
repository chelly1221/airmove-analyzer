import { useState, useCallback, useRef, useEffect } from "react";
import { Radar, Loader2, RefreshCw, X } from "lucide-react";
import type { MapRef } from "react-map-gl/maplibre";
import { useAppStore } from "../../store";
import type { RadarSite } from "../../types";
import { computeMainCoverage, isGPUCacheValidFor, invalidateGPUCache, COVERAGE_MIN_ALT_FT, COVERAGE_MAX_ALT_FT, COVERAGE_ALT_STEP_FT } from "../../utils/radarCoverage";
import { Toggle, DsSlider, ACCENT, G } from "./drawerPrimitives";

/** 최고 탐지고도 기준각 (CoS) */
const MAX_ELEV_DEG = 70;

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
  coverageRendering: boolean;
  mapRef: React.RefObject<MapRef | null>;
  /** 드로어 닫기 (X) */
  onClose: () => void;
}

export default function CoveragePanel({
  radarSite, gpuCacheReady, setGpuCacheReady,
  coverageAlt, setCoverageAlt, coverageAltMin, setCoverageAltMin,
  coverageOpacity, setCoverageOpacity,
  coverageRendering,
  mapRef, onClose,
}: Props) {
  const coverageVisible = useAppStore((s) => s.coverageVisible);
  const setCoverageVisible = useAppStore((s) => s.setCoverageVisible);
  const coverageLoading = useAppStore((s) => s.coverageLoading);
  const setCoverageLoading = useAppStore((s) => s.setCoverageLoading);
  const coverageProgress = useAppStore((s) => s.coverageProgress);
  const setCoverageProgress = useAppStore((s) => s.setCoverageProgress);
  const coverageProgressPct = useAppStore((s) => s.coverageProgressPct);
  const setCoverageProgressPct = useAppStore((s) => s.setCoverageProgressPct);
  const coverageError = useAppStore((s) => s.coverageError);
  const setCoverageError = useAppStore((s) => s.setCoverageError);
  const setCoverageData = useAppStore((s) => s.setCoverageData);
  const setCoverageStage = useAppStore((s) => s.setCoverageStage);
  const bumpCoverageAbortSeq = useAppStore((s) => s.bumpCoverageAbortSeq);

  const [coverageAltInput, setCoverageAltInput] = useState(coverageAlt);
  const [coverageAltMinInput, setCoverageAltMinInput] = useState(coverageAltMin);
  const coverageAltTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const coverageAltMinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 취소 시퀀스는 store(coverageAbortSeq) 단일 원천 — 진행 모달의 취소 버튼과 공유

  // 외부(슬라이더 리셋 등)에서 alt 값이 바뀌면 입력 동기화
  useEffect(() => { setCoverageAltInput(coverageAlt); }, [coverageAlt]);
  useEffect(() => { setCoverageAltMinInput(coverageAltMin); }, [coverageAltMin]);

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
    const computeSeq = bumpCoverageAbortSeq();
    setCoverageLoading(true);
    setCoverageError("");
    setCoverageProgressPct(0);
    setCoverageProgress("준비 중...");
    setCoverageStage("srtm");
    try {
      if (force) invalidateGPUCache();

      const result = await computeMainCoverage(
        radarSite,
        (pct, msg, stage) => {
          if (useAppStore.getState().coverageAbortSeq !== computeSeq) return;
          setCoverageProgressPct(Math.round(pct));
          setCoverageProgress(msg);
          if (stage) setCoverageStage(stage);
        },
      );
      if (useAppStore.getState().coverageAbortSeq !== computeSeq) return;
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
      if (useAppStore.getState().coverageAbortSeq !== computeSeq) return;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("커버리지 계산 실패:", err);
      setCoverageError(`계산 실패: ${errMsg}`);
    } finally {
      if (useAppStore.getState().coverageAbortSeq === computeSeq) {
        setCoverageLoading(false);
        setCoverageProgress("");
        setCoverageProgressPct(0);
        setCoverageStage("");
      }
    }
  }, [radarSite, mapRef, setGpuCacheReady, setCoverageLoading, setCoverageProgress, setCoverageProgressPct, setCoverageError, setCoverageVisible, setCoverageData, setCoverageStage, bumpCoverageAbortSeq]);

  // 토글 ON/OFF — 계산 중에도 OFF 가능
  const handleToggle = useCallback(() => {
    if (coverageVisible || coverageLoading) {
      // OFF: 진행 중 계산 무효화 + 상태 초기화 (모달 취소와 동일한 store 시퀀스)
      bumpCoverageAbortSeq();
      setCoverageVisible(false);
      if (coverageLoading) {
        setCoverageLoading(false);
        setCoverageProgress("");
        setCoverageProgressPct(0);
        setCoverageStage("");
        invalidateGPUCache();
      }
    } else {
      if (!gpuCacheReady || !isGPUCacheValidFor(radarSite)) {
        startCoverageCompute(true);
      } else {
        setCoverageVisible(true);
      }
    }
  }, [coverageLoading, coverageVisible, gpuCacheReady, radarSite, setCoverageVisible, setCoverageLoading, setCoverageProgress, setCoverageProgressPct, setCoverageStage, bumpCoverageAbortSeq, startCoverageCompute]);

  const cacheValid = gpuCacheReady && isGPUCacheValidFor(radarSite);
  const isActive = coverageVisible && cacheValid;
  const status: "on" | "off" | "loading" = coverageLoading ? "loading" : (isActive ? "on" : "off");
  const dim = !isActive;
  const transparencyPct = Math.round((1 - coverageOpacity) * 100);

  const micro: React.CSSProperties = { fontSize: 8.5, fontWeight: 700, letterSpacing: ".06em", color: G[400], textTransform: "uppercase" };
  const num: React.CSSProperties = { fontFamily: "ui-monospace, monospace", fontVariantNumeric: "tabular-nums", fontWeight: 700 };

  const chip = {
    on: { t: "표시중", c: ACCENT, bg: "rgba(166,7,57,.10)" },
    off: { t: "꺼짐", c: G[500], bg: G[100] },
    loading: { t: "계산중", c: "#2563eb", bg: "rgba(37,99,235,.10)" },
  }[status];

  return (
    <>
      {/* 헤더 */}
      <div style={{ padding: "10px 12px", borderBottom: `1px solid ${G[200]}`, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: G[800], lineHeight: 1.15 }}>커버리지 맵</span>
            <span style={{ fontSize: 9.5, color: G[400], lineHeight: 1.2 }}>
              {radarSite.name} · {Math.round(radarSite.range_nm)}NM · 안테나 {Math.round(radarSite.antenna_height)}m
            </span>
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9.5, fontWeight: 700, padding: "3px 7px", borderRadius: 5, flexShrink: 0, color: chip.c, background: chip.bg }}>
            {status === "loading" && <Loader2 size={10} color={chip.c} className="animate-spin" />}
            {chip.t}
          </span>
          <button
            onClick={onClose} title="닫기"
            style={{ width: 24, height: 24, borderRadius: 6, border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: G[400] }}
            onMouseEnter={(e) => { e.currentTarget.style.background = G[100]; e.currentTarget.style.color = G[600]; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = G[400]; }}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflowY: "auto" }}>
        {/* 계측 스트립 */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", borderBottom: `1px solid ${G[200]}` }}>
          {([["사거리", Math.round(radarSite.range_nm), "NM"], ["안테나고", Math.round(radarSite.antenna_height), "m"], ["최고탐지", MAX_ELEV_DEG, "°"]] as const).map(([k, v, u], i) => (
            <div key={k} style={{ padding: "7px 9px", borderRight: i < 2 ? `1px solid ${G[200]}` : "none" }}>
              <div style={micro}>{k}</div>
              <div style={{ ...num, fontSize: 14, color: G[800], marginTop: 1 }}>{v}<span style={{ fontSize: 8, color: G[400], marginLeft: 1 }}>{u}</span></div>
            </div>
          ))}
        </div>

        {/* 표시 + 재계산 */}
        <div style={{ padding: "9px 11px", borderBottom: `1px solid ${G[200]}` }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: coverageLoading ? 8 : 0 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Radar size={14} color={!dim ? ACCENT : G[400]} />
              <span style={{ fontSize: 12, color: G[600] }}>커버리지 표시</span>
              {coverageRendering && !coverageLoading && <Loader2 size={11} color={ACCENT} className="animate-spin" />}
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                onClick={() => startCoverageCompute(true)} title="GPU 재계산" disabled={coverageLoading}
                style={{ display: "flex", alignItems: "center", gap: 4, height: 24, padding: "0 8px", borderRadius: 6, border: `1px solid ${G[200]}`, background: "#fff", color: coverageLoading ? G[300] : G[600], fontSize: 10, fontWeight: 600, cursor: coverageLoading ? "default" : "pointer" }}
                onMouseEnter={(e) => { if (!coverageLoading) e.currentTarget.style.borderColor = G[300]; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = G[200]; }}
              >
                <RefreshCw size={11} color={coverageLoading ? G[300] : G[500]} className={coverageLoading ? "animate-spin" : ""} />
                재계산
              </button>
              <Toggle on={!dim} onClick={handleToggle} />
            </span>
          </div>
          {coverageLoading && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ height: 5, borderRadius: 3, background: G[200], overflow: "hidden" }}>
                <div style={{ height: "100%", width: coverageProgressPct + "%", background: ACCENT, borderRadius: 3, transition: "width .12s linear" }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 9.5, fontWeight: 500, color: G[500] }}>{coverageProgress || "GPU 음영분석 중…"}</span>
                <span style={{ ...num, fontSize: 9.5, color: "#2563eb" }}>{coverageProgressPct}%</span>
              </div>
            </div>
          )}
          {coverageError && (
            <div style={{ marginTop: 8, borderRadius: 6, background: "#fef2f2", padding: "6px 10px", fontSize: 11, color: "#dc2626" }}>
              {coverageError}
            </div>
          )}
        </div>

        {/* 투명도 */}
        <div style={{ padding: "9px 11px", borderBottom: `1px solid ${G[200]}`, opacity: dim ? 0.5 : 1, pointerEvents: dim ? "none" : "auto" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{ fontSize: 11, color: G[500] }}>투명도</span>
            <span style={{ ...num, fontSize: 10.5, color: ACCENT }}>{transparencyPct}%</span>
          </div>
          <DsSlider value={Math.min(1, Math.max(0.1, 1.1 - coverageOpacity))} min={0.1} max={1} step={0.05} onChange={(v) => setCoverageOpacity(1.1 - v)} />
        </div>

        {/* 고도 범위 */}
        <div style={{ padding: "9px 11px 11px", borderBottom: `1px solid ${G[200]}`, opacity: dim ? 0.5 : 1, pointerEvents: dim ? "none" : "auto" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{ fontSize: 11, color: G[500] }}>고도 범위</span>
            <span style={{ ...num, fontSize: 10.5, color: ACCENT }}>{coverageAltMinInput.toLocaleString()}~{coverageAltInput.toLocaleString()}ft</span>
          </div>
          {(() => {
            const totalRange = COVERAGE_MAX_ALT_FT - COVERAGE_MIN_ALT_FT;
            const pctMin = ((Math.min(coverageAltMinInput, coverageAltInput) - COVERAGE_MIN_ALT_FT) / totalRange) * 100;
            const pctMax = ((Math.max(coverageAltMinInput, coverageAltInput) - COVERAGE_MIN_ALT_FT) / totalRange) * 100;
            const loTop = coverageAltMinInput > (COVERAGE_MAX_ALT_FT + COVERAGE_MIN_ALT_FT) / 2;
            return (
              <div className="relative h-[22px]">
                <div className="absolute top-1/2 left-[8px] right-[8px] h-[5px] -translate-y-1/2 rounded-full" style={{ background: G[200] }} />
                <div
                  className="absolute top-1/2 h-[5px] -translate-y-1/2 rounded-full"
                  style={{ background: ACCENT, left: `calc(8px + (100% - 16px) * ${pctMin / 100})`, right: `calc(8px + (100% - 16px) * ${(100 - pctMax) / 100})` }}
                />
                <input
                  type="range" min={COVERAGE_MIN_ALT_FT} max={COVERAGE_MAX_ALT_FT} step={COVERAGE_ALT_STEP_FT}
                  value={coverageAltMinInput}
                  onChange={(e) => { const v = Number(e.target.value); handleCoverageAltMinChange(Math.min(v, coverageAltInput)); }}
                  style={{ zIndex: loTop ? 30 : 20 }}
                  className="coverage-range-thumb absolute left-0 right-0 top-1/2 -translate-y-1/2 w-full appearance-none bg-transparent cursor-pointer pointer-events-none"
                  aria-label="최소 고도"
                />
                <input
                  type="range" min={COVERAGE_MIN_ALT_FT} max={COVERAGE_MAX_ALT_FT} step={COVERAGE_ALT_STEP_FT}
                  value={coverageAltInput}
                  onChange={(e) => { const v = Number(e.target.value); handleCoverageAltChange(Math.max(v, coverageAltMinInput)); }}
                  style={{ zIndex: loTop ? 20 : 30 }}
                  className="coverage-range-thumb absolute left-0 right-0 top-1/2 -translate-y-1/2 w-full appearance-none bg-transparent cursor-pointer pointer-events-none"
                  aria-label="최대 고도"
                />
              </div>
            );
          })()}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8.5, color: G[400], marginTop: 1 }}>
            <span>{COVERAGE_MIN_ALT_FT.toLocaleString()}ft</span>
            <span>{COVERAGE_MAX_ALT_FT.toLocaleString()}ft</span>
          </div>
        </div>
      </div>
    </>
  );
}
