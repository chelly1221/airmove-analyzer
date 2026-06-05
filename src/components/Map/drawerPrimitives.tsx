// 트랙맵 도구 드로어 공용 프리미티브 — 디자인 핸드오프(트랙맵 도구 패널 통합) 기준
// 헤딩 테이프 · 도구 버튼(solid) · 토글 · 체크 · 스와치 · 채움 슬라이더
import { useRef, useEffect, useCallback, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export const ACCENT = "#a60739";
export const G = {
  900: "#111827", 800: "#1f2937", 700: "#374151", 600: "#4b5563", 500: "#6b7280",
  400: "#9ca3af", 300: "#d1d5db", 200: "#e5e7eb", 100: "#f3f4f6", 50: "#f9fafb",
} as const;

const wrapAz = (v: number) => (((v % 360) + 360) % 360);

// ── 토글 스위치 (36×20, thumb 14) ──
export function Toggle({ on, onClick, color = ACCENT, size = 1, disabled = false }: {
  on: boolean; onClick: () => void; color?: string; size?: number; disabled?: boolean;
}) {
  const w = 36 * size, h = 20 * size, k = 14 * size;
  return (
    <button
      onClick={onClick} role="switch" aria-checked={on} disabled={disabled}
      style={{
        position: "relative", width: w, height: h, borderRadius: h, border: "none",
        cursor: disabled ? "default" : "pointer", padding: 0, flexShrink: 0,
        background: on ? color : G[300], transition: "background .18s",
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <span style={{
        position: "absolute", top: (h - k) / 2, left: on ? w - k - (h - k) / 2 : (h - k) / 2,
        width: k, height: k, borderRadius: k, background: "#fff",
        boxShadow: "0 1px 2px rgba(0,0,0,.25)", transition: "left .18s",
      }} />
    </button>
  );
}

// ── 사각 체크박스 (레이어용, 15px) ──
export function Check({ on, color }: { on: boolean; color: string }) {
  return (
    <span style={{
      width: 15, height: 15, borderRadius: 4, flexShrink: 0,
      border: `1.5px solid ${on ? color : G[300]}`,
      background: on ? color : "transparent",
      display: "flex", alignItems: "center", justifyContent: "center", transition: "all .15s",
    }}>
      {on && (
        <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.5 6.5l2.5 2.5 4.5-5.5" />
        </svg>
      )}
    </span>
  );
}

// ── 레이어 색 스와치 (실선/점선) ──
export function Swatch({ color, dash, w = 18 }: { color: string; dash?: boolean; w?: number }) {
  return (
    <svg width={w} height={8} style={{ flexShrink: 0 }}>
      <line x1="0" y1="4" x2={w} y2="4" stroke={color} strokeWidth={dash ? 1.6 : 2}
        strokeDasharray={dash ? "5 3" : undefined} strokeLinecap="round" />
    </svg>
  );
}

// ── 채움 슬라이더 (네이티브 range, accent 채움 트랙) ──
export function DsSlider({ value, min, max, step, onChange, color = ACCENT, disabled = false }: {
  value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; color?: string; disabled?: boolean;
}) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      type="range" min={min} max={max} step={step} value={value} disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      className="ds-range"
      style={{ "--ds-pct": pct + "%", "--ds-col": color } as React.CSSProperties}
    />
  );
}

// ── 도구 드로어 버튼 (solid 변형: 활성=꽉 찬 accent + 셰브런 180°) ──
export function ToolButton({ icon: Icon, label, active, onClick }: {
  icon: LucideIcon; label: string; active: boolean; onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  // 기본: 흰색 배경/회색 아이콘 · hover: 메인 테마색(붉은) 채움 · active(드로어 열림): 동일 붉은 채움 + 셰브런 180°로 구분
  const lit = active || hover;
  const tint = lit ? "#fff" : G[400];
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        position: "relative", display: "flex", alignItems: "center", justifyContent: "space-between",
        width: "100%", padding: "9px 12px", cursor: "pointer", borderRadius: 8,
        border: `1px solid ${lit ? ACCENT : G[200]}`,
        background: lit ? ACCENT : "#fff",
        transition: "background .15s, border-color .15s",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Icon size={14} color={tint} />
        <span style={{ fontSize: 12, fontWeight: lit ? 600 : 500, color: lit ? "#fff" : G[600] }}>{label}</span>
      </span>
      <ChevronRight
        size={13} color={tint} strokeWidth={2.2}
        style={{ transform: active ? "rotate(180deg)" : `translateX(${hover ? 2 : 0}px)`, transition: "transform .3s" }}
      />
    </button>
  );
}

// ── 아날로그 헤딩 테이프 (눈금이 좌우로 흐름, 중앙 고정 지침) ──
// precise=true → 눈금 0.05°, 한 칸 확대(정밀 조정), 라벨 0.5°
export function HeadingTape({ azimuth, onChange, precise }: {
  azimuth: number; onChange: (v: number) => void; precise: boolean;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const W = 256, H = 50, cx = W / 2;
  const ppd = precise ? 70 : 8;       // viewBox 단위 / 도(°)
  const unit = precise ? 0.05 : 1;    // 최소 눈금 간격(°)
  const majorN = 10;                  // 라벨 눈금 (정밀 0.5° / 일반 10°)
  const medN = precise ? 2 : 5;       // 중간 눈금
  const wheelStep = precise ? 0.05 : 1;

  // 드래그/터치 스크럽
  const cur = useRef(azimuth); cur.current = azimuth;
  const start = useRef<{ lastX: number } | null>(null);
  useEffect(() => {
    const move = (e: MouseEvent | TouchEvent) => {
      if (!start.current || !ref.current) return;
      const pt = "touches" in e ? e.touches[0] : e;
      const rect = ref.current.getBoundingClientRect();
      const dx = pt.clientX - start.current.lastX;
      onChange(wrapAz(cur.current - dx * (W / rect.width) / ppd));
      start.current.lastX = pt.clientX;
      e.preventDefault();
    };
    const up = () => { start.current = null; document.body.style.cursor = ""; };
    window.addEventListener("mousemove", move);
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("mouseup", up);
    window.addEventListener("touchend", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("touchmove", move as EventListener);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("touchend", up);
    };
  }, [onChange, ppd]);
  const down = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    const pt = "touches" in e ? e.touches[0] : e;
    start.current = { lastX: pt.clientX };
    document.body.style.cursor = "grabbing";
    e.preventDefault();
  }, []);
  const wheel = useCallback((e: React.WheelEvent) => {
    onChange(wrapAz(cur.current + Math.sign(e.deltaY || e.deltaX) * wheelStep));
  }, [onChange, wheelStep]);

  const half = (W / 2) / ppd + 2 * unit;
  const lo = Math.ceil((azimuth - half) / unit);
  const hi = Math.floor((azimuth + half) / unit);
  const lines: React.ReactNode[] = [];
  for (let n = lo; n <= hi; n++) {
    const d = n * unit;
    const x = (d - azimuth) * ppd + cx;
    const isMajor = ((n % majorN) + majorN) % majorN === 0;
    const isMed = ((n % medN) + medN) % medN === 0;
    const len = isMajor ? 16 : isMed ? 10 : 6;
    lines.push(
      <line key={n} x1={x} y1={10} x2={x} y2={10 + len}
        stroke={isMajor ? G[500] : G[300]} strokeWidth={isMajor ? 1.1 : 0.7} />
    );
    if (isMajor) {
      const dd = (((Math.round(d * 100) / 100) % 360) + 360) % 360;
      const r0 = Math.round(dd);
      const card = r0 === 0 ? "N" : r0 === 90 ? "E" : r0 === 180 ? "S" : r0 === 270 ? "W" : null;
      const lbl = (card && Math.abs(dd - r0) < 1e-6) ? card : (precise ? (Math.round(dd * 10) / 10).toFixed(1) : String(r0));
      lines.push(
        <text key={"t" + n} x={x} y={44} textAnchor="middle" fontSize={precise ? 7.5 : 8}
          fontWeight="600" fill={G[400]} fontFamily="ui-monospace, monospace">{lbl}</text>
      );
    }
  }
  return (
    <svg
      ref={ref} width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
      style={{ display: "block", cursor: "grab", touchAction: "none", userSelect: "none", borderRadius: 7, border: `1px solid ${G[200]}`, background: "#fff" }}
      onMouseDown={down} onTouchStart={down} onWheel={wheel}
    >
      <defs>
        <linearGradient id="ds-tapeFade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="1" /><stop offset="0.12" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.88" stopColor="#fff" stopOpacity="0" /><stop offset="1" stopColor="#fff" stopOpacity="1" />
        </linearGradient>
      </defs>
      {lines}
      <rect x="0" y="0" width={W} height={H} fill="url(#ds-tapeFade)" pointerEvents="none" />
      {/* 중앙 고정 지침 */}
      <line x1={cx} y1={8} x2={cx} y2={30} stroke={ACCENT} strokeWidth="1.6" />
      <path d={`M${cx - 5} 8 L${cx + 5} 8 L${cx} 15 Z`} fill={ACCENT} />
    </svg>
  );
}
