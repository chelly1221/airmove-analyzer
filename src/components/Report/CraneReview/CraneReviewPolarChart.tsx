/**
 * 타워크레인 지브 방위각별 초과량 폴라 차트 — 순수 SVG.
 *
 * 원점 = 마스트, 정북 위 · 시계방향(방위각 정의와 동일). 반경 = 초과량(m, 선형).
 *   화면 좌표 매핑: x = CX + ρ·sin(θ), y = CY − ρ·cos(θ)  (θ = 방위각 라디안)
 * 반경 축 범위는 [min(BRA·LoS 초과량), max(…)] 를 1/2/5 nice step 으로 감싸되 항상 0 m 를
 * 포함해 **0 m 기준원**(굵은 선 = 침범/여유 경계)을 그린다.
 * 차트 안 텍스트는 편집 불가 — 수치 편집은 캡션(OMEditable)이 담당한다(의견서 단면도와 동일 규약).
 */
import { useMemo } from "react";
import { fmt } from "../../../utils/braReviewAnalysis";
import type { CraneAngleSeries } from "../../../utils/craneReviewShared";

const VB = 520;
const CX = 260;
const CY = 248; // 하단 범례 공간만큼 위로
const R_OUT = 182;
const R_IN = 28;

/** 색 계약 — BRA 빨강(#e94560 계열) · LoS 파랑 · 침범 구간 연빨강 음영 */
const C_BRA = "#e94560";
const C_LOS = "#2563eb";
const C_WEDGE = "#fde2e6";
const C_WORST = "#dc2626";
const C_BEST = "#16a34a";
const C_REG = "#6b7280";
const C_RADAR = "#b91c1c";

/** SVG text-anchor — 각도의 sin 부호로 좌/우/중앙 결정 */
type Anchor = "start" | "end" | "middle";
function anchorOf(sinA: number): Anchor {
  return sinA > 0.25 ? "start" : sinA < -0.25 ? "end" : "middle";
}

/** 눈금 간격 — 1/2/5×10ⁿ */
function niceStep(range: number, targetCount: number): number {
  const raw = range / Math.max(1, targetCount);
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return mult * mag;
}

interface Props {
  series: CraneAngleSeries;
  /** 레이더 → 크레인 방위 (°) — 차트에는 반대 방향(크레인 → 레이더)을 화살표로 표시 */
  azimuthDeg: number;
  /** 등록 지브 방위각 (°). 선회 모드가 full 이면 null */
  registeredDeg: number | null;
}

export default function CraneReviewPolarChart({ series, azimuthDeg, registeredDeg }: Props) {
  const g = useMemo(() => {
    const bra = series.braExceedByDeg;
    const los = series.losExceedByDeg;

    // ── 반경 축 범위 ──
    let dMin = Infinity;
    let dMax = -Infinity;
    for (const v of bra) {
      if (!Number.isFinite(v)) continue;
      if (v < dMin) dMin = v;
      if (v > dMax) dMax = v;
    }
    if (los) {
      for (const v of los) {
        if (!Number.isFinite(v)) continue;
        if (v < dMin) dMin = v;
        if (v > dMax) dMax = v;
      }
    }
    if (!Number.isFinite(dMin) || !Number.isFinite(dMax)) { dMin = 0; dMax = 0; }
    const step = niceStep(Math.max(dMax - dMin, 1e-6), 4);
    let vMin = Math.min(0, Math.floor(dMin / step) * step);
    let vMax = Math.max(0, Math.ceil(dMax / step) * step);
    if (vMax - vMin < step) { vMax = vMin + step; }
    // 부동소수 잔차 제거 (…9999 눈금 방지)
    vMin = Math.round(vMin / step) * step;
    vMax = Math.round(vMax / step) * step;
    const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;

    const rho = (v: number) => {
      const t = (Math.min(Math.max(v, vMin), vMax) - vMin) / (vMax - vMin);
      return R_IN + t * (R_OUT - R_IN);
    };
    const pt = (deg: number, r: number) => {
      const a = (deg * Math.PI) / 180;
      return { x: CX + r * Math.sin(a), y: CY - r * Math.cos(a) };
    };

    const ticks: { v: number; r: number; label: string }[] = [];
    for (let v = vMin; v <= vMax + step * 1e-6; v += step) {
      const rv = Math.round(v / step) * step;
      ticks.push({ v: rv, r: rho(rv), label: `${rv > 0 ? "+" : ""}${fmt(rv, digits)}` });
    }

    const curve = (arr: number[]) => {
      let d = "";
      for (let i = 0; i < arr.length; i++) {
        const p = pt(i, rho(arr[i]));
        d += `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`;
      }
      return `${d}Z`;
    };

    // ── 침범 구간 부채꼴 ──
    const wedges = series.braPenetratingRanges.map((r) => {
      const sweep = ((r.endDeg - r.startDeg + 360) % 360) + 1; // 1° 빈 폭 포함
      if (sweep >= 360) return { full: true, d: "" };
      const a0 = r.startDeg - 0.5;
      const a1 = a0 + sweep;
      const p0 = pt(a0, R_OUT);
      const p1 = pt(a1, R_OUT);
      const large = sweep > 180 ? 1 : 0;
      return {
        full: false,
        d: `M${CX},${CY} L${p0.x.toFixed(2)},${p0.y.toFixed(2)} A${R_OUT},${R_OUT} 0 ${large} 1 ${p1.x.toFixed(2)},${p1.y.toFixed(2)} Z`,
      };
    });

    // ── 최악/최선 마커 (최악은 라벨을 안쪽으로, 최선은 바깥으로 — 외곽 눈금 라벨과 분리) ──
    const marker = (deg: number, value: number, inward: boolean) => {
      const r = rho(value);
      const p = pt(deg, r);
      const lr = inward ? Math.max(R_IN + 12, r - 17) : Math.min(R_OUT - 6, r + 17);
      const lp = pt(deg, lr);
      const s = Math.sin((deg * Math.PI) / 180);
      return {
        x: p.x, y: p.y, lx: lp.x, ly: lp.y + 3,
        anchor: anchorOf(s),
      };
    };
    const worst = marker(series.braWorstDeg, bra[series.braWorstDeg] ?? 0, true);
    const best = marker(series.braBestDeg, bra[series.braBestDeg] ?? 0, false);

    // ── 방향 화살표 (레이더 방향 · 등록 방위각) — 라벨은 화살표 옆(법선 방향)에 ──
    const arrow = (deg: number) => {
      const a = (deg * Math.PI) / 180;
      const tip = pt(deg, R_OUT);
      const back = pt(deg, R_OUT - 13);
      const nx = Math.cos(a);
      const ny = Math.sin(a);
      const lp = pt(deg, R_OUT * 0.62);
      return {
        x1: CX, y1: CY, x2: tip.x, y2: tip.y,
        head: `${tip.x.toFixed(2)},${tip.y.toFixed(2)} ${(back.x + nx * 5).toFixed(2)},${(back.y + ny * 5).toFixed(2)} ${(back.x - nx * 5).toFixed(2)},${(back.y - ny * 5).toFixed(2)}`,
        lx: lp.x + nx * 13, ly: lp.y + ny * 13 + 3,
        anchor: anchorOf(nx),
      };
    };

    return {
      vMin, vMax, digits, ticks, zeroR: rho(0),
      braPath: curve(bra),
      losPath: los ? curve(los) : null,
      wedges,
      worst, best,
      radarArrow: arrow((azimuthDeg + 180) % 360),
      regArrow: registeredDeg != null ? arrow(((registeredDeg % 360) + 360) % 360) : null,
      spokes: Array.from({ length: 12 }, (_, i) => {
        const deg = i * 30;
        const a = pt(deg, R_IN);
        const b = pt(deg, R_OUT);
        const l = pt(deg, R_OUT + 13);
        const s = Math.sin((deg * Math.PI) / 180);
        return {
          deg, x1: a.x, y1: a.y, x2: b.x, y2: b.y, lx: l.x, ly: l.y + 3,
          anchor: anchorOf(s),
        };
      }),
    };
  }, [series, azimuthDeg, registeredDeg]);

  const legend: { color: string; stroke: string; label: string }[] = [
    { color: "none", stroke: C_BRA, label: "BRA 초과량 (m, 실제지구 기하)" },
    ...(g.losPath ? [{ color: "none", stroke: C_LOS, label: "LoS 초과량 (m, 4/3 음영 대비·단면 투영 근사)" }] : []),
    { color: C_WEDGE, stroke: "#f4b8c1", label: "BRA 침범 방위 구간 (초과량 > 0)" },
    { color: "none", stroke: "#111827", label: "0 m 기준원 (안쪽 = 여유 / 바깥 = 침범)" },
  ];

  return (
    <svg viewBox={`0 0 ${VB} ${VB}`} className="crv-polar" role="img" aria-label="방위각별 초과량 폴라 차트">
      <rect x={0} y={0} width={VB} height={VB} fill="#ffffff" />

      {/* ① 침범 방위 구간 음영 */}
      {g.wedges.map((w, i) =>
        w.full ? (
          <circle key={`w${i}`} cx={CX} cy={CY} r={R_OUT} fill={C_WEDGE} />
        ) : (
          <path key={`w${i}`} d={w.d} fill={C_WEDGE} />
        ),
      )}

      {/* ② 눈금원 + 방위 스포크 */}
      {g.ticks.map((t) => (
        <circle key={`t${t.v}`} cx={CX} cy={CY} r={t.r} fill="none" stroke="#e5e7eb" strokeWidth={1} />
      ))}
      {g.spokes.map((s) => (
        <line key={`s${s.deg}`} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke="#e5e7eb" strokeWidth={1} />
      ))}
      <circle cx={CX} cy={CY} r={R_OUT} fill="none" stroke="#9ca3af" strokeWidth={1} />

      {/* ③ 0 m 기준원 (침범/여유 경계) */}
      <circle cx={CX} cy={CY} r={g.zeroR} fill="none" stroke="#111827" strokeWidth={1.8} />

      {/* ④ 방향 화살표 — 레이더 방향 · 등록 방위각 */}
      {g.regArrow && (
        <g>
          <line x1={g.regArrow.x1} y1={g.regArrow.y1} x2={g.regArrow.x2} y2={g.regArrow.y2}
            stroke={C_REG} strokeWidth={1.3} strokeDasharray="5 4" />
          <polygon points={g.regArrow.head} fill={C_REG} />
          <text x={g.regArrow.lx} y={g.regArrow.ly} fontSize={9.5} fill={C_REG} textAnchor={g.regArrow.anchor}>
            등록 {registeredDeg}°
          </text>
        </g>
      )}
      <g>
        <line x1={g.radarArrow.x1} y1={g.radarArrow.y1} x2={g.radarArrow.x2} y2={g.radarArrow.y2}
          stroke={C_RADAR} strokeWidth={1.3} strokeDasharray="7 4" />
        <polygon points={g.radarArrow.head} fill={C_RADAR} />
        <text x={g.radarArrow.lx} y={g.radarArrow.ly} fontSize={9.5} fontWeight={700} fill={C_RADAR}
          textAnchor={g.radarArrow.anchor}>
          → 레이더 {((azimuthDeg + 180) % 360).toFixed(0)}°
        </text>
      </g>

      {/* ⑤ 곡선 — LoS 먼저(아래), BRA 위 */}
      {g.losPath && <path d={g.losPath} fill="none" stroke={C_LOS} strokeWidth={1.4} strokeDasharray="6 3" />}
      <path d={g.braPath} fill="none" stroke={C_BRA} strokeWidth={1.9} />

      {/* ⑥ 최악·최선 방위 마커 */}
      <circle cx={g.worst.x} cy={g.worst.y} r={4} fill={C_WORST} />
      <text x={g.worst.lx} y={g.worst.ly} fontSize={10} fontWeight={700} fill={C_WORST} textAnchor={g.worst.anchor}>
        최악 {series.braWorstDeg}°
      </text>
      <circle cx={g.best.x} cy={g.best.y} r={4} fill={C_BEST} />
      <text x={g.best.lx} y={g.best.ly} fontSize={10} fontWeight={700} fill={C_BEST} textAnchor={g.best.anchor}>
        최선 {series.braBestDeg}°
      </text>

      {/* ⑦ 마스트(원점) */}
      <circle cx={CX} cy={CY} r={3} fill="#374151" />

      {/* ⑧ 방위 라벨 (30° 간격) */}
      {g.spokes.map((s) => (
        <text key={`sl${s.deg}`} x={s.lx} y={s.ly} fontSize={9.5} fill="#6b7280" textAnchor={s.anchor}>
          {s.deg}°
        </text>
      ))}

      {/* ⑨ 반경 눈금 라벨 (정북 축 오른쪽) */}
      {g.ticks.map((t) => (
        <text key={`tl${t.v}`} x={CX + 4} y={CY - t.r + 10} fontSize={9} fill="#6b7280" textAnchor="start">
          {t.label}
        </text>
      ))}
      <text x={CX} y={CY - R_OUT - 26} fontSize={10} fontWeight={700} fill="#374151" textAnchor="middle">
        지브 방위각별 초과량 (m)
      </text>

      {/* ⑩ 범례 */}
      <g>
        <rect x={12} y={VB - 16 - legend.length * 15} width={330} height={8 + legend.length * 15}
          fill="#ffffff" fillOpacity={0.92} stroke="#d1d5db" strokeWidth={1} rx={3} />
        {legend.map((L, i) => (
          <g key={L.label}>
            <rect x={20} y={VB - 10 - legend.length * 15 + i * 15} width={13} height={9}
              fill={L.color === "none" ? "#ffffff" : L.color} stroke={L.stroke} strokeWidth={1.4} />
            <text x={38} y={VB - 2 - legend.length * 15 + i * 15} fontSize={9.5} fill="#374151">{L.label}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}
