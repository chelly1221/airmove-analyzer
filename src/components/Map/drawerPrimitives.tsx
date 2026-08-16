// 트랙맵 도구 드로어 공용 프리미티브 — 디자인 핸드오프(트랙맵 도구 패널 통합) 기준
// 도구 버튼(solid) · 토글 · 체크 · 스와치 · 채움 슬라이더
import { useRef, useEffect, useCallback, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export const ACCENT = "#a60739";
export const G = {
  900: "#111827", 800: "#1f2937", 700: "#374151", 600: "#4b5563", 500: "#6b7280",
  400: "#9ca3af", 300: "#d1d5db", 200: "#e5e7eb", 100: "#f3f4f6", 50: "#f9fafb",
} as const;

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
//   드래그 성능: input 이벤트마다 부모(거대 트리)를 리렌더하면 썸 위치가 부모 렌더 완료 뒤에야
//   갱신돼 포인터를 못 따라간다. 두 단계로 분리한다.
//     ① 로컬 에코(local) — 입력 즉시 자신만 리렌더(저렴). 썸이 포인터에 바로 붙는다.
//     ② 부모 onChange 는 rAF 당 최대 1회로 병합 — 프레임당 한 번만 부모를 갱신한다.
//   rAF 콜백에서 onChange 직후 같은 콜백 안에서 setLocal(null) 을 호출한다. React 18+ 자동
//   배칭으로 부모 상태 반영과 에코 해제가 한 렌더에 묶여 썸 깜빡임(스냅백)이 없고, 부모가 값을
//   변환/클램프하는 사용처(역방향 슬라이더 등)에서도 로컬 값이 눌어붙지 않는다.
export function DsSlider({ value, min, max, step, onChange, color = ACCENT, disabled = false }: {
  value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; color?: string; disabled?: boolean;
}) {
  const [local, setLocal] = useState<number | null>(null);
  const pending = useRef<number | null>(null); // rAF 대기 중인 최신 값
  const rafId = useRef<number | null>(null);
  const cbRef = useRef(onChange); cbRef.current = onChange; // 최신 onChange 참조(핸들러 identity 고정)

  // 언마운트 시 예약된 rAF 취소 — 아직 전달 못 한 값이 있으면 마지막으로 flush(최종 커밋 값 유실 방지)
  useEffect(() => () => {
    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
      if (pending.current !== null) { cbRef.current(pending.current); pending.current = null; }
    }
  }, []);

  const handle = useCallback((v: number) => {
    setLocal(v);            // 즉시 에코 (이 컴포넌트만 리렌더)
    pending.current = v;
    if (rafId.current !== null) return; // 이미 예약됨 — 값만 갱신하고 병합
    rafId.current = requestAnimationFrame(() => {
      rafId.current = null;
      const next = pending.current;
      pending.current = null;
      if (next === null) return;
      cbRef.current(next);  // 부모 커밋 (프레임당 1회)
      setLocal(null);       // 같은 콜백 = 자동 배칭 → 부모 값 반영과 한 렌더로 교체
    });
  }, []);

  const shown = local ?? value;
  const pct = max > min ? ((shown - min) / (max - min)) * 100 : 0;
  return (
    <input
      type="range" min={min} max={max} step={step} value={shown} disabled={disabled}
      onChange={(e) => handle(Number(e.target.value))}
      className="ds-range"
      style={{ "--ds-pct": pct + "%", "--ds-col": color } as React.CSSProperties}
    />
  );
}

// ── 도구 드로어 버튼 (solid 변형: 활성=꽉 찬 accent + 셰브런 180°) ──
export function ToolButton({ icon: Icon, label, active, onClick, dataTour }: {
  icon: LucideIcon; label: string; active: boolean; onClick: () => void;
  /** 투어 앵커(src/tour) — 지정 시 button 에 data-tour 속성 부여 (표출·동작 무영향) */
  dataTour?: string;
}) {
  const [hover, setHover] = useState(false);
  // 기본: 흰색 배경/회색 아이콘 · hover: 메인 테마색(붉은) 채움 · active(드로어 열림): 동일 붉은 채움 + 셰브런 180°로 구분
  const lit = active || hover;
  const tint = lit ? "#fff" : G[400];
  return (
    <button
      onClick={onClick}
      data-tour={dataTour}
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
