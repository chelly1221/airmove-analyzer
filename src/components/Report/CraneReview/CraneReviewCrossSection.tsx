/**
 * 타워크레인 BRA 수직단면도 — 순수 SVG (의견서 BraReviewCrossSection 과 동일 표시 프레임).
 *
 * 표시 프레임 = **실제지구 디스플레이 프레임**:  y(d, elevMSL) = elevMSL − curvDrop(d)
 *   · BRA 제한표면 = h_ant + d·tanθ          → 이 프레임에서 정확히 직선
 *   · LoS 음영선(4/3 레이) = h_ant + maxAngle·d + curvDrop43(d) − curvDrop(d)
 *
 * 크레인은 레이더–마스트 방위 단면에 투영해 그린다(공용 craneReviewShared 헤더의 근사 규약).
 *   · 마스트   : 거리 distKm, 폭 mast_width, 지반고 → 최상단(top_height)
 *   · 지브     : [distKm, distKm + jibTipKm], 지브 설치고 → 설치고 + CRANE_JIB_TRUSS_H
 *   · 카운터지브: [distKm, distKm + counterTipKm] (반대쪽으로 뻗음)
 *   · 전방위(full): 마스트 양쪽 반경 max(지브, 카운터지브) 수평 슬래브
 * BRA 제한선 위로 넘는 부분은 빨강(#e94560/#dc2626) 오버레이 — 의견서 색 계약과 동일.
 * 차트 안 텍스트는 편집 불가 — 수치 편집은 캡션(OMEditable)이 담당한다.
 */
import { curvDrop, curvDrop43, fmt } from "../../../utils/braReviewAnalysis";
import {
  CRANE_JIB_TRUSS_H, jibRadialOffsetsKm, losMaxAngleUpTo,
  type CraneAnalysis, type CraneCaseKind, type CraneFacilityAnalysis,
} from "../../../utils/craneReviewShared";

const VB_W = 900;
const VB_H = 330;
const PAD = { top: 28, right: 24, bottom: 38, left: 62 };
const PX0 = PAD.left;
const PX1 = VB_W - PAD.right;
const PY0 = PAD.top;
const PY1 = VB_H - PAD.bottom;
const PLOT_W = PX1 - PX0;
const PLOT_H = PY1 - PY0;

/** 색 계약 — 크레인 = 진회색(초과분 빨강), 주변 건물 = 연갈색, 선회 슬래브 = 반투명 주황 */
const CRANE_FILL = "#374151";
const COUNTER_FILL = "#6b7280";
const SLAB_FILL = "#f97316";
const EXCEED_FILL = "#dc2626";
const NEAR_FILL = "#e2d3bf";
const NEAR_STROKE = "#c4ad92";

/** 눈금 간격 — 1/2/5×10ⁿ */
function niceStep(range: number, targetCount: number): number {
  const raw = range / Math.max(1, targetCount);
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return mult * mag;
}

/** 방위 차 Δ = (a − b) 를 (−180, 180] 로 정규화 */
function deltaDeg(a: number, b: number): number {
  let d = ((a - b) % 360 + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

interface Props {
  facility: CraneFacilityAnalysis;
  analysis: CraneAnalysis;
  caseKind: CraneCaseKind;
  /** 케이스의 지브 방위각 (°). full·mast 는 null */
  jibDeg: number | null;
  braAngleDeg: number;
}

export default function CraneReviewCrossSection({ facility, analysis, caseKind, jibDeg, braAngleDeg }: Props) {
  const { profile, pathBuildings, chartMaxKm, distKm, hAntM, coneMslAtMastM, site, azimuthDeg } = facility;
  const crane = analysis.crane;
  const tanT = Math.tan((braAngleDeg * Math.PI) / 180);

  // ── 표시 프레임 값 (마스트 거리 기준 곡률강하 — 지브 길이 ≤ 100 m 구간의 곡률차는 mm 수준) ──
  const dropD = curvDrop(distKm);
  const groundDisp = crane.ground_elev - dropD;
  const mastTopDisp = analysis.mastTopMslM - dropD;
  const jibBotMslM = crane.ground_elev + crane.jib_height;
  const jibBotDisp = jibBotMslM - dropD;
  const jibTopDisp = analysis.jibTopMslM - dropD;
  const coneDispAtMast = coneMslAtMastM - dropD;
  const braAtMaxDisp = hAntM + chartMaxKm * 1000 * tanT;

  // ── 케이스 기하 (반경 방향 구간) ──
  const isFull = caseKind === "full";
  const slabRadiusKm = Math.max(crane.jib_length, crane.counter_jib_length) / 1000;
  // jibDeg 가 없는 케이스(mast)는 지브를 그리지 않으므로 오프셋 0 — 마스트 단독 기하
  const offs = jibDeg != null
    ? jibRadialOffsetsKm(crane, azimuthDeg, jibDeg)
    : { jibTipKm: 0, counterTipKm: 0 };
  const halfMastKm = crane.mast_width / 2000;
  const spanNearKm = isFull
    ? distKm - slabRadiusKm
    : distKm + Math.min(0, offs.jibTipKm, offs.counterTipKm) - halfMastKm;
  // ── LoS 음영 (케이스 최근접 부위 지점 기준) ──
  const dNearKm = Math.max(0.001, spanNearKm);
  const maxAngle = losMaxAngleUpTo(profile, pathBuildings, hAntM, dNearKm);
  const hasShadow = Number.isFinite(maxAngle);
  const shadowMslM = hasShadow ? hAntM + maxAngle * dNearKm * 1000 + curvDrop43(dNearKm) : null;
  const shadowDisp = shadowMslM != null ? shadowMslM - curvDrop(dNearKm) : null;

  // ── Y 범위 ──
  let terrainMin = Infinity;
  let terrainMax = -Infinity;
  for (const p of profile) {
    const v = p.elevM - curvDrop(p.distKm);
    if (v < terrainMin) terrainMin = v;
    if (v > terrainMax) terrainMax = v;
  }
  if (!Number.isFinite(terrainMin)) { terrainMin = 0; terrainMax = 0; }
  let bldgMax = -Infinity;
  for (const b of pathBuildings) {
    const v = b.ground_elev_m + b.height_m - curvDrop(b.distance_km);
    if (v > bldgMax) bldgMax = v;
  }
  const minY = Math.max(-10, Math.min(terrainMin, groundDisp) - 10);
  const rawMax = Math.max(
    mastTopDisp, jibTopDisp, braAtMaxDisp, terrainMax, hAntM,
    shadowDisp ?? -Infinity, Number.isFinite(bldgMax) ? bldgMax : -Infinity,
  );
  const maxY = Math.max(minY + 20, rawMax * 1.12);

  const X = (dKm: number) => PX0 + (Math.min(Math.max(dKm, 0), chartMaxKm) / chartMaxKm) * PLOT_W;
  const Y = (v: number) => PY1 - ((Math.min(Math.max(v, minY), maxY) - minY) / (maxY - minY)) * PLOT_H;
  /** 픽셀 x → 거리(km) — 최소 폭 보정(3px)된 도형에도 제한선 값을 일관되게 맞추기 위함 */
  const dOfX = (x: number) => ((x - PX0) / PLOT_W) * chartMaxKm;
  const coneAtX = (x: number) => hAntM + dOfX(x) * 1000 * tanT;

  /** [x0,x1] × [botV,topV] 사각형 중 BRA 제한선 **위**(초과) 영역 폴리곤.
   *  제한선은 x 에 대해 단조증가하므로 초과 영역은 항상 왼쪽부터 이어지는 한 덩어리다. */
  const exceedPoints = (x0: number, x1: number, topV: number, botV: number): string | null => {
    if (!(tanT > 0)) return null; // 기준각 0 = 제한표면 수평 — 모달 입력 범위(0.05° 이상)에서는 발생하지 않음
    const lo = (x: number) => Math.max(coneAtX(x), botV);
    if (topV <= lo(x0)) return null;
    let xEnd = x1;
    if (topV <= lo(x1)) {
      const xStar = PX0 + ((topV - hAntM) / (tanT * 1000) / chartMaxKm) * PLOT_W;
      xEnd = Math.min(x1, Math.max(x0, xStar));
    }
    const pts: string[] = [`${x0.toFixed(2)},${Y(topV).toFixed(2)}`, `${xEnd.toFixed(2)},${Y(topV).toFixed(2)}`];
    const N = 8;
    for (let i = N; i >= 0; i--) {
      const x = x0 + ((xEnd - x0) * i) / N;
      pts.push(`${x.toFixed(2)},${Y(lo(x)).toFixed(2)}`);
    }
    return pts.join(" ");
  };

  // ── 표시 지형 = 프로파일 + 건물/마스트 지반고 앵커 + footprint 평탄화 (표시 전용) ──
  //   건물·크레인 지반고와 ≈20 m 경로 샘플이 어긋나면 구조물이 떠 보이므로, 각 footprint 구간을
  //   해당 지반고로 평탄화한다(의견서 단면도와 동일 규약). 분석(음영고도)은 원본 profile 그대로.
  const displayTerrain = (() => {
    type Span = { near: number; far: number; g: number };
    const spans: Span[] = [];
    for (const b of pathBuildings) {
      if (!Number.isFinite(b.ground_elev_m)) continue;
      const n = b.near_dist_km ?? b.distance_km;
      const f = b.far_dist_km ?? b.distance_km;
      spans.push({ near: Math.min(n, f), far: Math.max(n, f), g: b.ground_elev_m });
    }
    spans.push({ near: distKm - halfMastKm, far: distKm + halfMastKm, g: crane.ground_elev });
    const EPS = 1e-6;
    const pts: { d: number; e: number; anchor: boolean }[] = [];
    for (const p of profile) {
      let inside = false;
      for (const s of spans) {
        if (p.distKm > s.near + EPS && p.distKm < s.far - EPS) { inside = true; break; }
      }
      if (!inside) pts.push({ d: p.distKm, e: p.elevM, anchor: false });
    }
    for (const s of spans) {
      if (s.far - s.near > EPS) {
        pts.push({ d: s.near, e: s.g, anchor: true });
        pts.push({ d: s.far, e: s.g, anchor: true });
      } else {
        pts.push({ d: s.near, e: s.g, anchor: true });
      }
    }
    pts.sort((a, b) => a.d - b.d || (a.anchor === b.anchor ? 0 : a.anchor ? 1 : -1));
    const merged: { d: number; e: number }[] = [];
    for (const p of pts) {
      const last = merged[merged.length - 1];
      if (last && p.d - last.d < EPS) { last.e = p.e; continue; }
      merged.push({ d: p.d, e: p.e });
    }
    return merged;
  })();
  const terrainPts: string[] = [];
  for (const p of displayTerrain) terrainPts.push(`${X(p.d).toFixed(2)},${Y(p.e - curvDrop(p.d)).toFixed(2)}`);
  const terrainPoly = terrainPts.length > 0 ? `${PX0},${PY1} ${terrainPts.join(" ")} ${PX1},${PY1}` : "";

  // ── LoS 음영선 (안테나 → 최근접 부위 지점) ──
  const rayPts: string[] = [];
  if (hasShadow) {
    for (const p of profile) {
      if (p.distKm > dNearKm) break;
      const v = hAntM + maxAngle * p.distKm * 1000 + curvDrop43(p.distKm) - curvDrop(p.distKm);
      rayPts.push(`${X(p.distKm).toFixed(2)},${Y(v).toFixed(2)}`);
    }
    if (shadowDisp != null) rayPts.push(`${X(dNearKm).toFixed(2)},${Y(shadowDisp).toFixed(2)}`);
  }

  // ── 눈금 (X = km, Y = m MSL 표시프레임) ──
  const xStep = niceStep(chartMaxKm, 7);
  const xDigits = xStep >= 1 ? 0 : xStep >= 0.1 ? 1 : 2;
  const xTicks: number[] = [];
  for (let d = 0; d <= chartMaxKm + 1e-9; d += xStep) xTicks.push(Math.round(d / xStep) * xStep);
  const yStep = niceStep(maxY - minY, 5);
  const yTicks: number[] = [];
  for (let v = Math.ceil(minY / yStep) * yStep; v <= maxY; v += yStep) yTicks.push(v);

  // ── 크레인 도형 (픽셀) ──
  const mastX0 = X(distKm - halfMastKm);
  const mastX1 = Math.max(mastX0 + 3, X(distKm + halfMastKm));
  const barX = (aKm: number, bKm: number) => {
    const x0 = X(Math.min(aKm, bKm));
    const x1 = X(Math.max(aKm, bKm));
    return { x0, x1: Math.max(x0 + 2, x1) };
  };
  const jibBar = jibDeg != null && !isFull ? barX(distKm, distKm + offs.jibTipKm) : null;
  const counterBar = jibDeg != null && !isFull ? barX(distKm, distKm + offs.counterTipKm) : null;
  const slabBar = isFull ? barX(distKm - slabRadiusKm, distKm + slabRadiusKm) : null;

  const jibBarY = Y(jibTopDisp);
  const jibBarH = Math.max(2, Y(jibBotDisp) - Y(jibTopDisp));

  // 라벨 좌우 배치 — 크레인이 우측 절반이면 라벨을 왼쪽으로 (의견서 규약)
  const craneOnRight = X(distKm) > PX0 + PLOT_W * 0.5;
  const labelX = craneOnRight ? mastX0 - 8 : mastX1 + 8;
  const labelAnchor = craneOnRight ? "end" : "start";

  const legend = [
    { color: "#dbeafe", stroke: "#1d4ed8", label: "BRA 제한표면 (허용 천장고, MSL)" },
    { color: CRANE_FILL, stroke: EXCEED_FILL, label: "타워크레인 (빨강 = 제한고도 초과분)" },
    ...(isFull
      ? [{ color: SLAB_FILL, stroke: "#c2410c", label: `선회 범위 슬래브 (반경 ${fmt(slabRadiusKm * 1000, 0)} m)` }]
      : [{ color: COUNTER_FILL, stroke: "#4b5563", label: "카운터지브" }]),
    { color: NEAR_FILL, stroke: NEAR_STROKE, label: "주변 건물 (경로 코리도 100 m)" },
    { color: "#e8dccb", stroke: "#8b6b4a", label: "지형 (SRTM, 구조물 바닥 = 등록 지반고)" },
    { color: "none", stroke: "#16a34a", label: "차폐 가시선 (음영선, 4/3 유효지구)" },
  ];

  return (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className="brv-chart" role="img" aria-label="타워크레인 BRA 수직단면도">
      <rect x={0} y={0} width={VB_W} height={VB_H} fill="#ffffff" />

      {/* 격자 */}
      {yTicks.map((v) => (
        <line key={`gy${v}`} x1={PX0} y1={Y(v)} x2={PX1} y2={Y(v)} stroke="#eef1f5" strokeWidth={1} />
      ))}
      {xTicks.map((d) => (
        <line key={`gx${d}`} x1={X(d)} y1={PY0} x2={X(d)} y2={PY1} stroke="#f3f5f8" strokeWidth={1} />
      ))}

      {/* ① BRA 허용영역 (제한선 아래) */}
      <polygon points={`${PX0},${Y(hAntM)} ${PX1},${Y(braAtMaxDisp)} ${PX1},${PY1} ${PX0},${PY1}`}
        fill="#dbeafe" opacity={0.55} />

      {/* ② 지형 */}
      {terrainPoly && <polygon points={terrainPoly} fill="#e8dccb" stroke="#8b6b4a" strokeWidth={1} />}

      {/* ③ 경로 건물 */}
      {pathBuildings.map((b, i) => {
        const nKm = b.near_dist_km ?? b.distance_km;
        const fKm = b.far_dist_km ?? b.distance_km;
        if (nKm > chartMaxKm) return null;
        const bx = X(nKm);
        const bw = Math.max(3, X(fKm) - bx);
        const drop = curvDrop(b.distance_km);
        const top = Y(b.ground_elev_m + b.height_m - drop);
        const bot = Y(b.ground_elev_m - drop);
        if (bot - top < 0.4) return null;
        return (
          <rect key={`b${i}`} x={bx} y={top} width={bw} height={Math.max(0.6, bot - top)}
            fill={NEAR_FILL} stroke={NEAR_STROKE} strokeWidth={0.6} />
        );
      })}

      {/* ④ BRA 제한표면 (표시 프레임 직선) */}
      <line x1={PX0} y1={Y(hAntM)} x2={PX1} y2={Y(braAtMaxDisp)} stroke="#1d4ed8" strokeWidth={2} />

      {/* ⑤ 크레인 — 선회 슬래브(full) 또는 지브·카운터지브 + 마스트 */}
      {slabBar && (
        <>
          <rect x={slabBar.x0} y={jibBarY} width={slabBar.x1 - slabBar.x0} height={jibBarH}
            fill={SLAB_FILL} fillOpacity={0.35} stroke="#c2410c" strokeWidth={0.8} />
          {(() => {
            const p = exceedPoints(slabBar.x0, slabBar.x1, jibTopDisp, jibBotDisp);
            return p ? <polygon points={p} fill={EXCEED_FILL} fillOpacity={0.55} /> : null;
          })()}
        </>
      )}
      {counterBar && (
        <>
          <rect x={counterBar.x0} y={jibBarY} width={counterBar.x1 - counterBar.x0} height={jibBarH}
            fill={COUNTER_FILL} stroke="#4b5563" strokeWidth={0.6} />
          {(() => {
            const p = exceedPoints(counterBar.x0, counterBar.x1, jibTopDisp, jibBotDisp);
            return p ? <polygon points={p} fill={EXCEED_FILL} /> : null;
          })()}
        </>
      )}
      {jibBar && (
        <>
          <rect x={jibBar.x0} y={jibBarY} width={jibBar.x1 - jibBar.x0} height={jibBarH}
            fill={CRANE_FILL} stroke="#111827" strokeWidth={0.6} />
          {(() => {
            const p = exceedPoints(jibBar.x0, jibBar.x1, jibTopDisp, jibBotDisp);
            return p ? <polygon points={p} fill={EXCEED_FILL} /> : null;
          })()}
        </>
      )}
      <rect x={mastX0} y={Y(mastTopDisp)} width={mastX1 - mastX0}
        height={Math.max(1, Y(groundDisp) - Y(mastTopDisp))} fill={CRANE_FILL} stroke="#111827" strokeWidth={0.8} />
      {(() => {
        const p = exceedPoints(mastX0, mastX1, mastTopDisp, groundDisp);
        return p ? <polygon points={p} fill={EXCEED_FILL} /> : null;
      })()}

      {/* ⑥ 제한고도 수평 점선 (마스트 주변 ±600 m) + 라벨 */}
      <line x1={X(Math.max(0, distKm - 0.6))} y1={Y(coneDispAtMast)}
        x2={X(Math.min(chartMaxKm, distKm + 0.6))} y2={Y(coneDispAtMast)}
        stroke="#1d4ed8" strokeWidth={1} strokeDasharray="5 3" />
      {(() => {
        // BRA 선은 오른쪽으로 상승 — 라벨을 오른쪽에 붙이면 점선 아래, 왼쪽이면 점선 위.
        const leftX = X(Math.max(0, distKm - 0.6)) - 6;
        const rightX = X(Math.min(chartMaxKm, distKm + 0.6)) + 6;
        const right = !craneOnRight;
        const ly = right ? Y(coneDispAtMast) + 13 : Y(coneDispAtMast) - 4;
        return (
          <text x={right ? rightX : leftX} y={ly} fontSize={10} fill="#1d4ed8" textAnchor={right ? "start" : "end"}>
            제한고도 {fmt(coneMslAtMastM, 2)} m
          </text>
        );
      })()}

      {/* ⑦ LoS 음영선 + 음영고도 라벨 */}
      {rayPts.length > 1 && (
        <polyline points={rayPts.join(" ")} fill="none" stroke="#16a34a" strokeWidth={1.6} strokeDasharray="6 4" />
      )}
      {shadowMslM != null && shadowDisp != null && rayPts.length > 1 && (
        <text x={craneOnRight ? X(dNearKm) - 8 : X(dNearKm) + 8} y={Y(shadowDisp) - 5} fontSize={10}
          fontWeight={700} fill="#15803d" textAnchor={craneOnRight ? "end" : "start"}>
          음영고도 {fmt(shadowMslM, 2)} m
        </text>
      )}

      {/* ⑧ 안테나 */}
      <polygon points={`${PX0},${Y(hAntM) - 8} ${PX0 - 6},${Y(hAntM) + 2} ${PX0 + 6},${Y(hAntM) + 2}`} fill="#dc2626" />
      <text x={PX0 + 9} y={Y(hAntM) + 14} fontSize={10} fontWeight={700} fill="#b91c1c">
        안테나 {site.name} (정점표고 {fmt(hAntM, 2)} m)
      </text>

      {/* ⑨ 수평거리 화살표 */}
      <line x1={X(0)} y1={PY1 - 9} x2={X(distKm)} y2={PY1 - 9} stroke="#374151" strokeWidth={1} />
      <polygon points={`${X(0)},${PY1 - 9} ${X(0) + 6},${PY1 - 12} ${X(0) + 6},${PY1 - 6}`} fill="#374151" />
      <polygon points={`${X(distKm)},${PY1 - 9} ${X(distKm) - 6},${PY1 - 12} ${X(distKm) - 6},${PY1 - 6}`} fill="#374151" />
      <text x={(X(0) + X(distKm)) / 2} y={PY1 - 13} fontSize={10} fontWeight={700} fill="#374151" textAnchor="middle">
        d = {fmt(distKm, 3)} km
      </text>

      {/* ⑩ 크레인 라벨 */}
      <text x={labelX} y={Y(mastTopDisp) - 27} fontSize={10.5} fontWeight={700} fill="#111827" textAnchor={labelAnchor}>
        {crane.name}
      </text>
      <text x={labelX} y={Y(mastTopDisp) - 16} fontSize={9.5} fill="#374151" textAnchor={labelAnchor}>
        최상단 {fmt(analysis.mastTopMslM, 2)} m · 지브 상단 {fmt(analysis.jibTopMslM, 2)} m (지반 {fmt(crane.ground_elev, 1)})
      </text>
      <text x={labelX} y={Y(mastTopDisp) - 5} fontSize={9.5} fill="#374151" textAnchor={labelAnchor}>
        {isFull
          ? `선회 전방위 최악조건 · 반경 ${fmt(slabRadiusKm * 1000, 0)} m 슬래브`
          : jibDeg != null
            ? `지브 방위 ${jibDeg}° (레이더 방위 ${azimuthDeg.toFixed(0)}° 대비 Δ ${deltaDeg(jibDeg, azimuthDeg).toFixed(0)}°)`
            : "마스트 단독 (지브 미고려)"}
      </text>

      {/* 축 */}
      <line x1={PX0} y1={PY1} x2={PX1} y2={PY1} stroke="#9ca3af" strokeWidth={1} />
      <line x1={PX0} y1={PY0} x2={PX0} y2={PY1} stroke="#9ca3af" strokeWidth={1} />
      {xTicks.map((d) => (
        <text key={`tx${d}`} x={X(d)} y={PY1 + 13} fontSize={9.5} fill="#6b7280" textAnchor="middle">
          {d.toFixed(xDigits)}
        </text>
      ))}
      {yTicks.map((v) => (
        <text key={`ty${v}`} x={PX0 - 6} y={Y(v) + 3} fontSize={9.5} fill="#6b7280" textAnchor="end">
          {(Math.round(v) || 0).toLocaleString("en-US")}
        </text>
      ))}
      <text x={(PX0 + PX1) / 2} y={VB_H - 6} fontSize={10} fill="#4b5563" textAnchor="middle">
        안테나 기준 수평거리 (km)
      </text>
      <text x={14} y={(PY0 + PY1) / 2} fontSize={10} fill="#4b5563" textAnchor="middle"
        transform={`rotate(-90 14 ${(PY0 + PY1) / 2})`}>
        표고 (m, MSL·곡률보정)
      </text>

      {/* ⑪ 범례 */}
      <g>
        <rect x={PX1 - 268} y={PY0 + 4} width={260} height={10 + legend.length * 14} fill="#ffffff" fillOpacity={0.92}
          stroke="#d1d5db" strokeWidth={1} rx={3} />
        {legend.map((L, i) => (
          <g key={L.label}>
            <rect x={PX1 - 260} y={PY0 + 11 + i * 14} width={12} height={8}
              fill={L.color === "none" ? "#ffffff" : L.color} stroke={L.stroke} strokeWidth={1.2} />
            <text x={PX1 - 244} y={PY0 + 18 + i * 14} fontSize={9.5} fill="#374151">{L.label}</text>
          </g>
        ))}
      </g>

      {/* 지브 트러스 높이 각주 (도형 해석) */}
      <text x={PX0 + 4} y={PY0 - 8} fontSize={9} fill="#6b7280">
        지브 상단 = 지브 설치고 + 트러스 {CRANE_JIB_TRUSS_H} m · 지브/카운터지브는 레이더 방위 단면에 투영
      </text>
    </svg>
  );
}
