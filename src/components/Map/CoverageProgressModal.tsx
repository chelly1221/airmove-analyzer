// 커버리지 맵 생성 진행 모달 — 지도 위 중앙 오버레이
// 표시 조건: init 계산 중(coverageLoading) 또는 init 완료 후 첫 비트맵 렌더 중(bitmapPhase)
// 드로어와 독립적으로 TrackMap 레벨에 배치 — 드로어를 닫아도 진행 상황이 유지된다.
import { useEffect, useState } from "react";
import { Loader2, Radar, X } from "lucide-react";
import { useAppStore } from "../../store";
import type { RadarSite } from "../../types";
import { invalidateGPUCache } from "../../utils/radarCoverage";
import { ACCENT, G } from "./drawerPrimitives";

interface Props {
  radarSite: RadarSite;
  /** init 완료 후 첫 비트맵 렌더가 진행 중인지 (TrackMap 판정) */
  bitmapPhase: boolean;
  /** 취소 시 TrackMap 로컬 상태 정리 (gpuCacheReady/렌더 시퀀스/렌더 키) */
  onCancel?: () => void;
}

/** 진행 단계 체크리스트 — Rust stage("srtm"/"buildings"/"bmap") + 프론트 비트맵 단계 */
const STEPS = [
  { key: "srtm", label: "지형 타일 로드" },
  { key: "buildings", label: "건물 데이터 조회" },
  { key: "bmap", label: "차폐맵 구축" },
  { key: "bitmap", label: "비트맵 렌더링" },
] as const;

/** stage 문자열 → 체크리스트 인덱스 ("done" = init 완료 → 비트맵 단계) */
function stageIndex(stage: string): number {
  switch (stage) {
    case "srtm": return 0;
    case "buildings": return 1;
    case "bmap": return 2;
    case "done": return 3;
    default: return 0;
  }
}

export default function CoverageProgressModal({ radarSite, bitmapPhase, onCancel }: Props) {
  const coverageLoading = useAppStore((s) => s.coverageLoading);
  const coverageProgress = useAppStore((s) => s.coverageProgress);
  const coverageProgressPct = useAppStore((s) => s.coverageProgressPct);
  const coverageStage = useAppStore((s) => s.coverageStage);
  const setCoverageLoading = useAppStore((s) => s.setCoverageLoading);
  const setCoverageVisible = useAppStore((s) => s.setCoverageVisible);
  const setCoverageProgress = useAppStore((s) => s.setCoverageProgress);
  const setCoverageProgressPct = useAppStore((s) => s.setCoverageProgressPct);
  const setCoverageStage = useAppStore((s) => s.setCoverageStage);
  const bumpCoverageAbortSeq = useAppStore((s) => s.bumpCoverageAbortSeq);

  // init 단계 판정에 stage 를 함께 요구 — coverageLoading 은 DB 캐시 lazy load(store setCoverageVisible)
  // 에서도 켜지므로, 실제 계산(startCoverageCompute → stage 세팅)일 때만 모달을 띄운다.
  const open = (coverageLoading && coverageStage !== "") || bitmapPhase;

  // 비트맵 렌더 구간(90~99%) — Rust 진행 이벤트가 없는 단계라 완만한 램프로 표시
  const [bitmapPct, setBitmapPct] = useState(90);
  useEffect(() => {
    if (!bitmapPhase) { setBitmapPct(90); return; }
    setBitmapPct(90);
    const t = setInterval(() => setBitmapPct((p) => Math.min(99, p + 0.5)), 250);
    return () => clearInterval(t);
  }, [bitmapPhase]);

  if (!open) return null;

  const pct = bitmapPhase ? bitmapPct : Math.max(0, Math.min(90, coverageProgressPct));
  const msg = bitmapPhase ? "지도 비트맵 렌더링 중..." : (coverageProgress || "준비 중...");
  const activeIdx = bitmapPhase ? 3 : stageIndex(coverageStage);

  const handleCancel = () => {
    bumpCoverageAbortSeq();
    setCoverageLoading(false);
    setCoverageVisible(false);
    setCoverageProgress("");
    setCoverageProgressPct(0);
    setCoverageStage("");
    invalidateGPUCache();
    onCancel?.();
  };

  const num: React.CSSProperties = { fontFamily: "ui-monospace, monospace", fontVariantNumeric: "tabular-nums", fontWeight: 700 };

  return (
    <div
      style={{
        position: "absolute", inset: 0, zIndex: 1500,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,.35)",
      }}
    >
      <div
        style={{
          width: 380, background: "#ffffff", borderRadius: 12,
          boxShadow: "0 18px 48px rgba(0,0,0,.28)", border: `1px solid ${G[200]}`,
          padding: "16px 18px 14px",
        }}
      >
        {/* 헤더 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <span style={{
            width: 28, height: 28, borderRadius: 8, flexShrink: 0,
            background: "rgba(166,7,57,.10)", display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <Radar size={15} color={ACCENT} />
          </span>
          <span style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 13.5, fontWeight: 700, color: G[800], lineHeight: 1.2 }}>커버리지 맵 생성</span>
            <span style={{ fontSize: 10, color: G[400], lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {radarSite.name} · {Math.round(radarSite.range_nm)}NM · 안테나 {Math.round(radarSite.antenna_height)}m
            </span>
          </span>
        </div>

        {/* 프로그레스바 */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <div style={{ flex: 1, height: 8, borderRadius: 4, background: G[200], overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${pct}%`, background: ACCENT, borderRadius: 4, transition: "width .18s linear" }} />
          </div>
          <span style={{ ...num, fontSize: 12.5, color: ACCENT, minWidth: 38, textAlign: "right" }}>{Math.round(pct)}%</span>
        </div>

        {/* 현재 진행 메시지 */}
        <div style={{ fontSize: 10.5, color: G[500], lineHeight: 1.4, minHeight: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {msg}
        </div>

        {/* 단계 체크리스트 */}
        <div style={{ marginTop: 12, borderTop: `1px solid ${G[100]}`, paddingTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
          {STEPS.map((s, i) => {
            const done = i < activeIdx;
            const active = i === activeIdx;
            const color = done ? G[600] : active ? G[800] : G[300];
            return (
              <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color, fontWeight: active ? 700 : 500 }}>
                <span style={{ width: 14, height: 14, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {done ? (
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke={ACCENT} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2 6.3l2.6 2.7L10 3.2" />
                    </svg>
                  ) : active ? (
                    <Loader2 size={12} color={ACCENT} className="animate-spin" />
                  ) : (
                    <span style={{ width: 5, height: 5, borderRadius: 5, background: G[300] }} />
                  )}
                </span>
                {s.label}
              </div>
            );
          })}
        </div>

        {/* 취소 */}
        <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
          <button
            onClick={handleCancel}
            style={{
              display: "flex", alignItems: "center", gap: 5, height: 27, padding: "0 11px",
              borderRadius: 7, border: `1px solid ${G[200]}`, background: "#fff",
              color: G[600], fontSize: 11, fontWeight: 600, cursor: "pointer",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = G[300]; e.currentTarget.style.color = G[800]; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = G[200]; e.currentTarget.style.color = G[600]; }}
          >
            <X size={12} />
            취소
          </button>
        </div>
      </div>
    </div>
  );
}
