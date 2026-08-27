/**
 * BRA 수직단면도 (ICAO EUR DOC 015 Figure 3.3 준용) — 순수 SVG.
 *
 * 표시 프레임 = **실제지구 디스플레이 프레임**(LoSProfilePanel 차트와 동일):
 *   y(d, elevMSL) = elevMSL − curvDrop(d)
 * 이 프레임에서
 *   · BRA 제한표면 = h_ant + d·tanθ  → 정확히 직선 (coneMSL 의 d²/2R 항이 curvDrop 과 상쇄)
 *   · LoS 음영선(4/3 레이) = h_ant + maxAngle·d + curvDrop43(d) − curvDrop(d)  → 완만한 곡선
 * 차트 안 텍스트는 편집 불가 — 수치 편집은 캡션 문단(OMEditable)이 담당한다.
 */
import { curvDrop, curvDrop43, fmt, type BraReviewFacility } from "../../../utils/braReviewAnalysis";

const VB_W = 900;
const VB_H = 320; // 340 → 320: 시설별 차트 블록(제목+차트+캡션)이 A4 잔여 공간 경계에 걸려 다음 쪽으로 밀리는 빈도 완화
const PAD = { top: 28, right: 24, bottom: 36, left: 60 };
const PX0 = PAD.left;
const PX1 = VB_W - PAD.right;
const PY0 = PAD.top;
const PY1 = VB_H - PAD.bottom;
const PLOT_W = PX1 - PX0;
const PLOT_H = PY1 - PY0;

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
  facility: BraReviewFacility;
  buildingName: string;
  groundElevM: number;
  rooftopAmslM: number;
  braAngleDeg: number;
}

export default function BraReviewCrossSection({
  facility, buildingName, groundElevM, rooftopAmslM, braAngleDeg,
}: Props) {
  const { profile, pathBuildings, targetOnPath, chartMaxKm, distKm, hAntM, coneMslM, los, site } = facility;
  const tanT = Math.tan((braAngleDeg * Math.PI) / 180);

  // ── 표시 프레임 값 ──
  const dropD = curvDrop(distKm);
  const rooftopDisp = rooftopAmslM - dropD;
  const groundDisp = groundElevM - dropD;
  const coneDisp = coneMslM - dropD;              // = hAntM + distKm*1000*tanθ (표시 프레임 직선상 값)
  const braAtMaxDisp = hAntM + chartMaxKm * 1000 * tanT;
  const shadowDisp = los ? los.shadowAmslM - dropD : groundDisp;

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
    const d = b.distance_km;
    const v = b.ground_elev_m + b.height_m - curvDrop(d);
    if (v > bldgMax) bldgMax = v;
  }
  const minY = Math.max(-10, terrainMin - 10);
  const rawMax = Math.max(
    rooftopDisp, braAtMaxDisp, shadowDisp, terrainMax,
    Number.isFinite(bldgMax) ? bldgMax : -Infinity, hAntM,
  );
  const maxY = Math.max(minY + 20, rawMax * 1.12);

  const X = (dKm: number) => PX0 + (Math.min(Math.max(dKm, 0), chartMaxKm) / chartMaxKm) * PLOT_W;
  const Y = (v: number) => PY1 - ((Math.min(Math.max(v, minY), maxY) - minY) / (maxY - minY)) * PLOT_H;

  // ── 눈금 ──
  const xStepM = niceStep(chartMaxKm * 1000, 7);
  const xTicks: number[] = [];
  for (let m = 0; m <= chartMaxKm * 1000 + 1e-6; m += xStepM) xTicks.push(m);
  const yStep = niceStep(maxY - minY, 5);
  const yTicks: number[] = [];
  for (let v = Math.ceil(minY / yStep) * yStep; v <= maxY; v += yStep) yTicks.push(v);

  // ── 대상 건물 rect 폭 (near/far, 없으면 80 m) — 표시 지형 평탄화 구간에도 사용 ──
  const halfKm = 0.04;
  const tNearKm = targetOnPath?.near_dist_km ?? distKm - halfKm;
  const tFarKm = targetOnPath?.far_dist_km ?? distKm + halfKm;

  // ── 표시 지형 = 프로파일 샘플 + 건물 기저 앵커 + footprint 구간 평탄화 — **표시 전용** ──
  //   건물 지반고(ground_elev_m)는 백엔드가 centroid 융합 SRTM(실측 보정 머지)으로 주고, 지형선은 경로상
  //   ≈20 m 샘플이라 두 값이 수 m 어긋나면 건물이 떠 보이거나 파묻힌다(LoSProfilePanel 367c4f4 동일 증상).
  //   → 각 건물(대상 포함)의 near/far 에 지반고 앵커를 끼우고, footprint 안쪽 샘플은 버려 그 구간을
  //     건물 지반고로 평탄화한다(대지 정지면 = 건물 바닥). 분석(음영고도·blocker)은 원본 profile 그대로.
  const displayTerrain = (() => {
    type Span = { near: number; far: number; g: number };
    const spans: Span[] = [];
    for (const b of pathBuildings) {
      if (!Number.isFinite(b.ground_elev_m)) continue;
      const n = b.near_dist_km ?? b.distance_km;
      const f = b.far_dist_km ?? b.distance_km;
      spans.push({ near: Math.min(n, f), far: Math.max(n, f), g: b.ground_elev_m });
    }
    spans.push({ near: Math.min(tNearKm, tFarKm), far: Math.max(tNearKm, tFarKm), g: groundElevM });
    const EPS = 1e-6;
    const pts: { d: number; e: number; anchor: boolean }[] = [];
    for (const p of profile) {
      // footprint 안쪽(양 끝 제외) 샘플은 평탄화 구간으로 대체
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
    // 거리순 정렬 — 같은 거리는 앵커(정밀 융합 지반) 우선, 앵커끼리는 삽입 순서(뒤 = 대상 건물) 우선
    pts.sort((a, b) => a.d - b.d || (a.anchor === b.anchor ? 0 : a.anchor ? 1 : -1));
    const merged: { d: number; e: number }[] = [];
    for (const p of pts) {
      const last = merged[merged.length - 1];
      if (last && p.d - last.d < EPS) { last.e = p.e; continue; }
      merged.push({ d: p.d, e: p.e });
    }
    return merged;
  })();
  // ── 지형 폴리곤 (표시 지형) ──
  const terrainPts: string[] = [];
  for (const p of displayTerrain) terrainPts.push(`${X(p.d).toFixed(2)},${Y(p.e - curvDrop(p.d)).toFixed(2)}`);
  const terrainPoly = terrainPts.length > 0
    ? `${PX0},${PY1} ${terrainPts.join(" ")} ${PX1},${PY1}`
    : "";

  // ── LoS 음영선 (4/3 레이 → 디스플레이 프레임) ──
  const rayPts: string[] = [];
  if (los && Number.isFinite(los.maxAngle)) {
    for (const p of profile) {
      if (p.distKm > distKm) break;
      const v = hAntM + los.maxAngle * p.distKm * 1000 + curvDrop43(p.distKm) - curvDrop(p.distKm);
      rayPts.push(`${X(p.distKm).toFixed(2)},${Y(v).toFixed(2)}`);
    }
  }

  // ── 대상 건물 rect ──
  const tX = X(tNearKm);
  const tW = Math.max(3, X(tFarKm) - tX);
  const grayTop = Math.min(rooftopDisp, coneDisp);
  const exceeded = rooftopDisp > coneDisp;

  // 라벨 좌우 배치 — 대상이 우측 절반이면 라벨을 왼쪽으로
  const targetOnRight = X(distKm) > PX0 + PLOT_W * 0.5;
  const tLabelX = targetOnRight ? tX - 8 : tX + tW + 8;
  const tAnchor = targetOnRight ? "end" : "start";

  const blk = los?.blocker ?? null;
  const blkX = blk ? X(blk.distKm) : 0;
  const blkY = blk ? Y(blk.topAmslM - curvDrop(blk.distKm)) : 0;
  // 차폐점은 항상 대상보다 앞(d < D)이므로 라벨을 대상 반대쪽(왼쪽)으로 뻗어 대상 라벨과의 충돌을 피한다.
  //   단, 좌측 여백이 부족하면(안테나 근처 차폐) 오른쪽으로 — 이때 안테나 라벨과 겹치지 않게 안테나 라벨은 마커 아래에 둔다.
  const blkLabelLeft = blkX - PX0 > 170;

  // 색 계약: 검토 대상 = 진한 회색(#374151) + 초과분 빨강, 주변 건물 = 연한 갈색(#e2d3bf/#c4ad92) — 대상이 한눈에 구분되게
  const NEAR_FILL = "#e2d3bf";
  const NEAR_STROKE = "#c4ad92";
  const TARGET_FILL = "#374151";
  const legend = [
    { color: "#dbeafe", stroke: "#1d4ed8", label: "BRA 제한표면 (허용 천장고, MSL)" },
    { color: TARGET_FILL, stroke: "#dc2626", label: "검토 대상 건물 (빨강 = 제한고도 초과분)" },
    { color: NEAR_FILL, stroke: NEAR_STROKE, label: "주변 건물 (경로 코리도 100 m)" },
    { color: "#e8dccb", stroke: "#8b6b4a", label: "지형 (SRTM, 건물 바닥 = 건물 지반고)" },
    { color: "none", stroke: "#16a34a", label: "차폐 가시선(음영선) · ● 차폐 발생 위치" },
  ];

  return (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className="brv-chart" role="img" aria-label="BRA 수직단면도">
      <rect x={0} y={0} width={VB_W} height={VB_H} fill="#ffffff" />

      {/* 격자 */}
      {yTicks.map((v) => (
        <line key={`gy${v}`} x1={PX0} y1={Y(v)} x2={PX1} y2={Y(v)} stroke="#eef1f5" strokeWidth={1} />
      ))}
      {xTicks.map((m) => (
        <line key={`gx${m}`} x1={X(m / 1000)} y1={PY0} x2={X(m / 1000)} y2={PY1} stroke="#f3f5f8" strokeWidth={1} />
      ))}

      {/* ① BRA 허용영역 (제한선 아래) */}
      <polygon
        points={`${PX0},${Y(hAntM)} ${PX1},${Y(braAtMaxDisp)} ${PX1},${PY1} ${PX0},${PY1}`}
        fill="#dbeafe" opacity={0.55}
      />

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
        // 하단 = 건물 지반고 그대로. 건물 지반고가 확인된 값이므로 건물을 지형에 맞추지 않고
        //   지형선(displayTerrain: near/far 앵커 + footprint 평탄화)을 건물 지반고에 맞춘다(사용자 원칙 2026-08-27)
        const bot = Y(b.ground_elev_m - drop);
        if (bot - top < 0.4) return null;
        // blocker 는 건물의 near/far 엣지 거리로 기록되므로(analyzeFacility) 두 엣지와 대조한다
        const isBlocker =
          blk?.kind === "building" &&
          (Math.abs(blk.distKm - nKm) < 1e-9 || Math.abs(blk.distKm - fKm) < 1e-9);
        return (
          <rect
            key={`b${i}`} x={bx} y={top} width={bw} height={Math.max(0.6, bot - top)}
            fill={NEAR_FILL} stroke={isBlocker ? "#16a34a" : NEAR_STROKE} strokeWidth={isBlocker ? 2 : 0.6}
          />
        );
      })}

      {/* ④ BRA 제한표면 (표시 프레임 직선) */}
      <line x1={PX0} y1={Y(hAntM)} x2={PX1} y2={Y(braAtMaxDisp)} stroke="#1d4ed8" strokeWidth={2} />

      {/* ⑤ 대상 건물 — 진한 회색(주변 건물과 구분), 하단 = 검토 지반고(지형선이 이 값에 맞춰 평탄화됨) */}
      <rect x={tX} y={Y(grayTop)} width={tW} height={Math.max(1, Y(groundDisp) - Y(grayTop))}
        fill={TARGET_FILL} stroke="#111827" strokeWidth={0.8} />
      {exceeded && (
        <rect x={tX} y={Y(rooftopDisp)} width={tW} height={Math.max(1, Y(coneDisp) - Y(rooftopDisp))} fill="#dc2626" />
      )}

      {/* ⑥ 제한고도 수평 점선 (대상 주변 ±600 m) */}
      <line
        x1={X(Math.max(0, distKm - 0.6))} y1={Y(coneDisp)}
        x2={X(Math.min(chartMaxKm, distKm + 0.6))} y2={Y(coneDisp)}
        stroke="#1d4ed8" strokeWidth={1} strokeDasharray="5 3"
      />
      {(() => {
        // 라벨 위치 규칙: BRA 선은 오른쪽으로 상승하므로 대상 오른쪽에 붙일 땐 점선 **아래**(선이 위로 지나감),
        //   왼쪽에 붙일 땐 점선 **위**(선이 아래로 지나감). 오른쪽-아래가 음영고도 라벨(Y(shadow)−5)과
        //   겹치면 왼쪽-위로 회피한다.
        const leftX = X(Math.max(0, distKm - 0.6)) - 6;
        const rightX = X(Math.min(chartMaxKm, distKm + 0.6)) + 6;
        let right = !targetOnRight;
        let ly = right ? Y(coneDisp) + 13 : Y(coneDisp) - 4;
        if (right && los && rayPts.length > 1 && Math.abs((Y(shadowDisp) - 5) - ly) < 14) {
          right = false;
          ly = Y(coneDisp) - 4;
        }
        return (
          <text x={right ? rightX : leftX} y={ly} fontSize={10} fill="#1d4ed8" textAnchor={right ? "start" : "end"}>
            제한고도 {fmt(coneMslM, 2)} m
          </text>
        );
      })()}

      {/* ⑦ LoS 음영선 + 차폐 발생 위치 */}
      {rayPts.length > 1 && (
        <polyline points={rayPts.join(" ")} fill="none" stroke="#16a34a" strokeWidth={1.6} strokeDasharray="6 4" />
      )}
      {blk && (
        <>
          <circle cx={blkX} cy={blkY} r={3.5} fill="#16a34a" />
          <text x={blkLabelLeft ? blkX - 7 : blkX + 7} y={blkY - 16} fontSize={10} fontWeight={700}
            fill="#15803d" textAnchor={blkLabelLeft ? "end" : "start"}>
            차폐 발생 위치
          </text>
          <text x={blkLabelLeft ? blkX - 7 : blkX + 7} y={blkY - 5} fontSize={9.5} fill="#15803d"
            textAnchor={blkLabelLeft ? "end" : "start"}>
            {blk.kind === "building" ? `건물 「${blk.name ?? "무명"}」` : `지형(${blk.name ?? "능선"})`}
            {` d=${fmt(blk.distKm * 1000, 0)} m, 표고 ${fmt(blk.topAmslM, 1)} m`}
          </text>
        </>
      )}
      {los && rayPts.length > 1 && (
        <text x={targetOnRight ? X(distKm) - 8 : X(distKm) + 8} y={Y(shadowDisp) - 5} fontSize={10}
          fontWeight={700} fill="#15803d" textAnchor={targetOnRight ? "end" : "start"}>
          음영고도 {fmt(los.shadowAmslM, 2)} m
        </text>
      )}

      {/* ⑧ 안테나 */}
      <polygon
        points={`${PX0},${Y(hAntM) - 8} ${PX0 - 6},${Y(hAntM) + 2} ${PX0 + 6},${Y(hAntM) + 2}`}
        fill="#dc2626"
      />
      {/* 안테나 라벨은 마커 아래 — 근거리 차폐 라벨(마커 위)과 분리 */}
      <text x={PX0 + 9} y={Y(hAntM) + 14} fontSize={10} fontWeight={700} fill="#b91c1c">
        안테나 {site.name} (정점표고 {fmt(hAntM, 2)} m)
      </text>

      {/* ⑨ 수평거리 화살표 */}
      <line x1={X(0)} y1={PY1 - 9} x2={X(distKm)} y2={PY1 - 9} stroke="#374151" strokeWidth={1} />
      <polygon points={`${X(0)},${PY1 - 9} ${X(0) + 6},${PY1 - 12} ${X(0) + 6},${PY1 - 6}`} fill="#374151" />
      <polygon points={`${X(distKm)},${PY1 - 9} ${X(distKm) - 6},${PY1 - 12} ${X(distKm) - 6},${PY1 - 6}`} fill="#374151" />
      <text x={(X(0) + X(distKm)) / 2} y={PY1 - 13} fontSize={10} fontWeight={700} fill="#374151" textAnchor="middle">
        d = {fmt(distKm * 1000, 0)} m
      </text>

      {/* ⑩ 대상 라벨 */}
      <text x={tLabelX} y={Y(rooftopDisp) - 26} fontSize={10.5} fontWeight={700} fill="#111827" textAnchor={tAnchor}>
        {buildingName}
      </text>
      <text x={tLabelX} y={Y(rooftopDisp) - 15} fontSize={9.5} fill="#374151" textAnchor={tAnchor}>
        옥상고 {fmt(rooftopAmslM, 2)} m (지반 {fmt(groundElevM, 1)} + 높이 {fmt(rooftopAmslM - groundElevM, 2)})
      </text>
      {exceeded && (
        <text x={tLabelX} y={Y(rooftopDisp) - 4} fontSize={10} fontWeight={700} fill="#dc2626" textAnchor={tAnchor}>
          침범 +{fmt(rooftopAmslM - coneMslM, 2)} m
        </text>
      )}

      {/* 축 */}
      <line x1={PX0} y1={PY1} x2={PX1} y2={PY1} stroke="#9ca3af" strokeWidth={1} />
      <line x1={PX0} y1={PY0} x2={PX0} y2={PY1} stroke="#9ca3af" strokeWidth={1} />
      {xTicks.map((m) => (
        <text key={`tx${m}`} x={X(m / 1000)} y={PY1 + 13} fontSize={9.5} fill="#6b7280" textAnchor="middle">
          {m.toLocaleString("en-US")}
        </text>
      ))}
      {yTicks.map((v) => (
        <text key={`ty${v}`} x={PX0 - 6} y={Y(v) + 3} fontSize={9.5} fill="#6b7280" textAnchor="end">
          {(Math.round(v) || 0).toLocaleString("en-US")}{/* -0 → 0 */}
        </text>
      ))}
      <text x={(PX0 + PX1) / 2} y={VB_H - 6} fontSize={10} fill="#4b5563" textAnchor="middle">
        안테나 기준 수평거리 (m)
      </text>
      <text x={14} y={(PY0 + PY1) / 2} fontSize={10} fill="#4b5563" textAnchor="middle"
        transform={`rotate(-90 14 ${(PY0 + PY1) / 2})`}>
        표고 (m, MSL·곡률보정)
      </text>

      {/* ⑪ 범례 */}
      <g>
        <rect x={PX1 - 262} y={PY0 + 4} width={254} height={10 + legend.length * 14} fill="#ffffff" fillOpacity={0.92}
          stroke="#d1d5db" strokeWidth={1} rx={3} />
        {legend.map((L, i) => (
          <g key={L.label}>
            <rect x={PX1 - 254} y={PY0 + 11 + i * 14} width={12} height={8}
              fill={L.color === "none" ? "#ffffff" : L.color} stroke={L.stroke} strokeWidth={1.2} />
            <text x={PX1 - 238} y={PY0 + 18 + i * 14} fontSize={9.5} fill="#374151">{L.label}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}
