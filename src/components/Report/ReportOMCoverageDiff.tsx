import React, { useMemo } from "react";
import type { RadarSite, LossPointGeo, ManualBuilding } from "../../types";
import type { CoverageLayer } from "../../utils/radarCoverage";

/** 고도(ft) → 스펙트럼 HSL 색상 (빨강→파랑) */
function altToColor(altFt: number, minAlt: number, maxAlt: number): string {
  const t = maxAlt > minAlt ? (altFt - minAlt) / (maxAlt - minAlt) : 0.5;
  const hue = t * 240; // 0°(red) → 240°(blue)
  return `hsl(${hue}, 85%, 50%)`;
}

interface Props {
  sectionNum: number;
  radarSite: RadarSite;
  /** 분석 대상 건물 포함 커버리지 레이어 (다중 고도) */
  layersWithTargets: CoverageLayer[];
  /** 분석 대상 건물 제외 커버리지 레이어 (다중 고도) */
  layersWithoutTargets: CoverageLayer[];
  /** Loss 발생 좌표 */
  lossPoints: LossPointGeo[];
  /** 기본 고도 (ft) — 미사용, 호환성 유지 */
  defaultAltFt: number;
  selectedBuildings: ManualBuilding[];
}

/** 레이더→포인트 방위(°, 0=N, CW) 및 거리(km) */
function azimuthAndDist(
  radarLat: number, radarLon: number,
  lat: number, lon: number,
): { azDeg: number; distKm: number } {
  const dLat = lat - radarLat;
  const dLon = lon - radarLon;
  const latKm = dLat * 111.32;
  const lonKm = dLon * 111.32 * Math.cos((radarLat * Math.PI) / 180);
  const distKm = Math.sqrt(latKm * latKm + lonKm * lonKm);
  let azDeg = (Math.atan2(lonKm, latKm) * 180) / Math.PI;
  if (azDeg < 0) azDeg += 360;
  return { azDeg, distKm };
}

/** 방위별 커버리지 범위(km) lookup — O(1) 인덱스 기반 */
function coverageRangeAt(layer: CoverageLayer, azDeg: number): number {
  const n = layer.bearings.length;
  if (n === 0) return 0;
  const step = 360 / n;
  const idx = Math.round(((azDeg % 360) + 360) % 360 / step) % n;
  return layer.bearings[idx].maxRangeKm;
}

/** 고도별 보간 커버리지 범위(km) */
function coverageRangeAtAlt(
  layers: CoverageLayer[], altFt: number, azDeg: number,
): number {
  if (layers.length === 0) return 0;
  // 고도 정렬된 레이어에서 lo/hi 탐색 (이미 적은 수)
  let lo: CoverageLayer | null = null;
  let hi: CoverageLayer | null = null;
  for (const l of layers) {
    if (l.altitudeFt <= altFt && (!lo || l.altitudeFt > lo.altitudeFt)) lo = l;
    if (l.altitudeFt >= altFt && (!hi || l.altitudeFt < hi.altitudeFt)) hi = l;
  }
  if (!lo && !hi) return 0;
  if (!lo) return coverageRangeAt(hi!, azDeg);
  if (!hi) return coverageRangeAt(lo, azDeg);
  if (lo.altitudeFt === hi.altitudeFt) return coverageRangeAt(lo, azDeg);
  const t = (altFt - lo.altitudeFt) / (hi.altitudeFt - lo.altitudeFt);
  return coverageRangeAt(lo, azDeg) + t * (coverageRangeAt(hi, azDeg) - coverageRangeAt(lo, azDeg));
}

/** 레이어 쌍에서 diff path 생성 (분석 대상 건물 영향 차이) */
function buildDiffPath(
  layerWith: CoverageLayer, layerWithout: CoverageLayer,
  scale: number, cx: number, cy: number,
): string | null {
  const withBearings = layerWith.bearings;
  const withoutBearings = layerWithout.bearings;
  if (withBearings.length === 0 || withoutBearings.length === 0) return null;

  const segments: string[] = [];
  const every = Math.max(1, Math.floor(withoutBearings.length / 360));

  let outerPts: string[] = [];
  let innerPts: string[] = [];
  let inDiff = false;

  for (let i = 0; i < withoutBearings.length; i += every) {
    const b = withoutBearings[i];
    // 동일 인덱스 기반 매칭 (두 레이어 모두 같은 bearing_step으로 계산되므로 인덱스 일치)
    const matchWith = i < withBearings.length ? withBearings[i] : null;
    const rWithout = b.maxRangeKm * scale;
    const rWith = (matchWith?.maxRangeKm ?? b.maxRangeKm) * scale;
    const rad = (b.deg * Math.PI) / 180;
    const diff = rWithout - rWith;

    if (diff > 0) {
      outerPts.push(`${(cx + rWithout * Math.sin(rad)).toFixed(1)} ${(cy - rWithout * Math.cos(rad)).toFixed(1)}`);
      innerPts.unshift(`${(cx + rWith * Math.sin(rad)).toFixed(1)} ${(cy - rWith * Math.cos(rad)).toFixed(1)}`);
      inDiff = true;
    } else if (inDiff) {
      if (outerPts.length >= 2) {
        segments.push(`M ${outerPts[0]} L ${outerPts.slice(1).join(" L ")} L ${innerPts.join(" L ")} Z`);
      }
      outerPts = []; innerPts = []; inDiff = false;
    }
  }
  if (outerPts.length >= 2) {
    segments.push(`M ${outerPts[0]} L ${outerPts.slice(1).join(" L ")} L ${innerPts.join(" L ")} Z`);
  }
  return segments.length > 0 ? segments.join(" ") : null;
}

const SECTOR_PAD_DEG = 25;
const FIXED_ALTS = [1000, 2000, 3000, 5000, 10000, 15000, 20000];

function ReportOMCoverageDiff({
  sectionNum,
  radarSite,
  layersWithTargets,
  layersWithoutTargets,
  lossPoints,
  selectedBuildings,
}: Props) {
  const MIN_ALT = 1000;
  const MAX_ALT = 20000;

  // 고정 20개 레이어 선택 (가장 가까운 고도 매칭)
  const { fixedWith, fixedWithout } = useMemo(() => {
    const pick = (layers: CoverageLayer[], targetAlt: number) => {
      if (layers.length === 0) return null;
      return layers.reduce((prev, curr) =>
        Math.abs(curr.altitudeFt - targetAlt) < Math.abs(prev.altitudeFt - targetAlt) ? curr : prev,
      );
    };
    return {
      fixedWith: FIXED_ALTS.map((alt) => pick(layersWithTargets, alt)).filter(Boolean) as CoverageLayer[],
      fixedWithout: FIXED_ALTS.map((alt) => pick(layersWithoutTargets, alt)).filter(Boolean) as CoverageLayer[],
    };
  }, [layersWithTargets, layersWithoutTargets]);

  // 건물 방위 범위 → 섹터 크롭
  const { sectorStart, sectorEnd, sectorSpan, hasSector } = useMemo(() => {
    if (selectedBuildings.length === 0)
      return { sectorStart: 0, sectorEnd: 360, sectorSpan: 360, hasSector: false };

    const azimuths = selectedBuildings.map((b) =>
      azimuthAndDist(radarSite.latitude, radarSite.longitude, b.latitude, b.longitude).azDeg,
    );
    const sorted = [...azimuths].sort((a, b) => a - b);
    let bestGap = 0, gapEnd = 0;
    for (let i = 0; i < sorted.length; i++) {
      const next = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + 360;
      const gap = next - sorted[i];
      if (gap > bestGap) { bestGap = gap; gapEnd = next % 360; }
    }
    const span = 360 - bestGap;
    const start = (gapEnd - SECTOR_PAD_DEG + 360) % 360;
    const end = (gapEnd + span + SECTOR_PAD_DEG) % 360;
    const totalSpan = Math.min(span + SECTOR_PAD_DEG * 2, 360);
    return { sectorStart: start, sectorEnd: end, sectorSpan: totalSpan, hasSector: totalSpan < 350 };
  }, [selectedBuildings, radarSite]);

  const inSector = (azDeg: number) => {
    if (!hasSector) return true;
    if (sectorStart <= sectorEnd) return azDeg >= sectorStart && azDeg <= sectorEnd;
    return azDeg >= sectorStart || azDeg <= sectorEnd;
  };

  // 최저 레이어 (Cone of Silence 판정)
  const lowestWith = fixedWith.length > 0 ? fixedWith[0] : null;

  // Loss 3D 차이 필터: 분석 대상 건물 때문에 커버리지가 줄어든 영역의 Loss만
  const filteredLoss = useMemo(() => {
    if (layersWithTargets.length === 0 || layersWithoutTargets.length === 0) return [];
    return lossPoints.filter((pt) => {
      if (pt.alt_ft < MIN_ALT || pt.alt_ft > MAX_ALT) return false;
      const { azDeg, distKm } = azimuthAndDist(radarSite.latitude, radarSite.longitude, pt.lat, pt.lon);
      if (lowestWith && lowestWith.coneRadiusKm > 0.5 && distKm < lowestWith.coneRadiusKm) return false;
      const rangeWith = coverageRangeAtAlt(layersWithTargets, pt.alt_ft, azDeg);
      const rangeWithout = coverageRangeAtAlt(layersWithoutTargets, pt.alt_ft, azDeg);
      return distKm <= rangeWithout && distKm > rangeWith;
    });
  }, [lossPoints, radarSite, lowestWith, layersWithTargets, layersWithoutTargets]);

  if (fixedWith.length === 0 && fixedWithout.length === 0) return null;

  // SVG 레이아웃
  const svgSize = 700;
  const fullCx = svgSize / 2;
  const fullCy = svgSize / 2;
  const fullMaxR = svgSize / 2 - 30;

  // globalMaxRange: 루프 기반 최대값 (Math.max spread 콜스택 폭발 방지)
  const { globalMaxRange, scale } = useMemo(() => {
    let maxR = Math.max(radarSite.range_nm * 1.852, 1);
    for (const l of fixedWith) for (const b of l.bearings) { if (b.maxRangeKm > maxR) maxR = b.maxRangeKm; }
    for (const l of fixedWithout) for (const b of l.bearings) { if (b.maxRangeKm > maxR) maxR = b.maxRangeKm; }
    return { globalMaxRange: maxR, scale: fullMaxR / maxR };
  }, [fixedWith, fixedWithout, radarSite.range_nm, fullMaxR]);

  // 섹터 viewBox
  const { vbX, vbY, vbW, vbH, cx, cy, maxR } = useMemo(() => {
    if (!hasSector)
      return { vbX: 0, vbY: 0, vbW: svgSize, vbH: svgSize, cx: fullCx, cy: fullCy, maxR: fullMaxR };

    const pts: { x: number; y: number }[] = [{ x: fullCx, y: fullCy }];
    const outerR = fullMaxR + 20;
    for (let i = 0; i <= sectorSpan; i += 1) {
      const deg = (sectorStart + i) % 360;
      const rad = (deg * Math.PI) / 180;
      pts.push({ x: fullCx + outerR * Math.sin(rad), y: fullCy - outerR * Math.cos(rad) });
    }
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const p of pts) {
      if (p.x < xMin) xMin = p.x; if (p.x > xMax) xMax = p.x;
      if (p.y < yMin) yMin = p.y; if (p.y > yMax) yMax = p.y;
    }
    const pad = 25;
    xMin -= pad; yMin -= pad; xMax += pad; yMax += pad;
    const side = Math.max(xMax - xMin, yMax - yMin);
    const cx2 = (xMin + xMax) / 2;
    const cy2 = (yMin + yMax) / 2;
    return { vbX: cx2 - side / 2, vbY: cy2 - side / 2, vbW: side, vbH: side, cx: fullCx, cy: fullCy, maxR: fullMaxR };
  }, [hasSector, sectorStart, sectorSpan, fullCx, fullCy, fullMaxR, svgSize]);

  // 거리 링
  const ringIntervalKm = 20 * 1.852;
  const rings: { km: number; nm: number }[] = [];
  for (let km = ringIntervalKm; km <= globalMaxRange; km += ringIntervalKm) {
    rings.push({ km, nm: km / 1.852 });
  }

  // 각 레이어별 diff path (분석 대상 건물 영향 차이)
  const diffPaths = useMemo(() => {
    const result: { altFt: number; color: string; path: string }[] = [];
    for (let i = 0; i < fixedWith.length; i++) {
      const lw = fixedWith[i];
      const lwo = fixedWithout.find((l) => Math.abs(l.altitudeFt - lw.altitudeFt) < 200);
      if (!lwo) continue;
      const dp = buildDiffPath(lw, lwo, scale, cx, cy);
      if (dp) {
        result.push({
          altFt: lw.altitudeFt,
          color: altToColor(lw.altitudeFt, MIN_ALT, MAX_ALT),
          path: dp,
        });
      }
    }
    return result;
  }, [fixedWith, fixedWithout, scale, cx, cy]);

  // 섹터 경계선
  const sectorLines = hasSector ? [sectorStart, sectorEnd].map((deg) => {
    const rad = (deg * Math.PI) / 180;
    return { x2: cx + (maxR + 15) * Math.sin(rad), y2: cy - (maxR + 15) * Math.cos(rad) };
  }) : [];

  // 방위 라벨
  const compassPoints = [
    { deg: 0, label: "N" }, { deg: 45, label: "NE" }, { deg: 90, label: "E" },
    { deg: 135, label: "SE" }, { deg: 180, label: "S" }, { deg: 225, label: "SW" },
    { deg: 270, label: "W" }, { deg: 315, label: "NW" },
  ].filter(({ deg }) => !hasSector || inSector(deg));

  // 레이어 SVG 경로 메모이제이션 (렌더마다 재계산 방지)
  const layerPathCache = useMemo(() => {
    const cache = new Map<CoverageLayer, string>();
    const buildPath = (layer: CoverageLayer) => {
      const bearings = layer.bearings;
      const every = Math.max(1, Math.floor(bearings.length / 360));
      const pts: string[] = [];
      for (let i = 0; i < bearings.length; i += every) {
        const b = bearings[i];
        const r = b.maxRangeKm * scale;
        const rad = (b.deg * Math.PI) / 180;
        pts.push(`${(cx + r * Math.sin(rad)).toFixed(1)} ${(cy - r * Math.cos(rad)).toFixed(1)}`);
      }
      return `M ${pts[0]} L ${pts.slice(1).join(" L ")} Z`;
    };
    for (const l of fixedWith) cache.set(l, buildPath(l));
    for (const l of fixedWithout) cache.set(l, buildPath(l));
    return cache;
  }, [fixedWith, fixedWithout, scale, cx, cy]);

  const layerPath = (layer: CoverageLayer) => layerPathCache.get(layer) ?? "";

  // 높은 고도 먼저 → 낮은 고도가 위에
  const drawOrderWith = useMemo(() => [...fixedWith].sort((a, b) => b.altitudeFt - a.altitudeFt), [fixedWith]);
  const drawOrderWithout = useMemo(() => [...fixedWithout].sort((a, b) => b.altitudeFt - a.altitudeFt), [fixedWithout]);

  return (
    <div className="mb-8">
      <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[17px] font-bold text-gray-900">
        {sectionNum}. 커버리지 비교맵
      </h2>

      {/* 정보 요약 바 */}
      <div className="mb-2 flex items-center justify-between rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-[10px] text-gray-500">
        <span>분석 고도: {MIN_ALT.toLocaleString()} — {MAX_ALT.toLocaleString()} ft ({fixedWith.length}레이어)</span>
        <span>
          장애물 기인 Loss {filteredLoss.length}건 / 전체 {lossPoints.length}건
          {hasSector && <> · 섹터 {sectorStart.toFixed(0)}°–{sectorEnd.toFixed(0)}°</>}
        </span>
      </div>

      {/* 커버리지 비교맵 */}
      <div className="rounded-md border border-gray-200 p-2">
        <svg viewBox={`${vbX.toFixed(1)} ${vbY.toFixed(1)} ${vbW.toFixed(1)} ${vbH.toFixed(1)}`} className="w-full">
          {/* 배경 */}
          <rect x={vbX} y={vbY} width={vbW} height={vbH} fill="#fafafa" rx={4} />

          {/* 거리 링 */}
          {rings.map((ring, i) => {
            const r = ring.km * scale;
            const labelDeg = hasSector ? (sectorStart + sectorSpan / 2) % 360 : 45;
            const labelRad = (labelDeg * Math.PI) / 180;
            return (
              <g key={`ring-${i}`}>
                <circle cx={cx} cy={cy} r={r} fill="none" stroke="#d1d5db" strokeWidth={0.4} strokeDasharray="3,3" />
                <text
                  x={cx + (r + 3) * Math.sin(labelRad)}
                  y={cy - (r + 3) * Math.cos(labelRad)}
                  fill="#9ca3af" fontSize={hasSector ? 8 : 7} textAnchor="start"
                >{ring.nm.toFixed(0)}NM</text>
              </g>
            );
          })}

          {/* 방위선 + 라벨 */}
          {compassPoints.map(({ deg, label }) => {
            const rad = (deg * Math.PI) / 180;
            return (
              <g key={deg}>
                <line x1={cx} y1={cy} x2={cx + (maxR + 10) * Math.sin(rad)} y2={cy - (maxR + 10) * Math.cos(rad)}
                  stroke="#c0c0c8" strokeWidth={0.4} />
                <text x={cx + (maxR + 20) * Math.sin(rad)} y={cy - (maxR + 20) * Math.cos(rad) + 3}
                  textAnchor="middle" fill="#6b7280" fontSize={9} fontWeight={600}>{label}</text>
              </g>
            );
          })}

          {/* 섹터 경계선 */}
          {sectorLines.map((sl, i) => (
            <line key={`sec-${i}`} x1={cx} y1={cy} x2={sl.x2} y2={sl.y2}
              stroke="#a60739" strokeWidth={0.6} strokeDasharray="4,3" strokeOpacity={0.5} />
          ))}

          {/* Cone of Silence */}
          {lowestWith && lowestWith.coneRadiusKm > 0.5 && (
            <circle cx={cx} cy={cy} r={lowestWith.coneRadiusKm * scale}
              fill="#fafafa" stroke="#9ca3af" strokeWidth={0.5} strokeDasharray="2,2" />
          )}

          {/* 분석 대상 제외 — 스펙트럼 (높은 고도 먼저, 불투명, 점선 stroke) */}
          {drawOrderWithout.map((layer, idx) => {
            const color = altToColor(layer.altitudeFt, MIN_ALT, MAX_ALT);
            return (
              <path key={`wo-${idx}`} d={layerPath(layer)}
                fill={color} fillOpacity={1}
                stroke={color} strokeWidth={0.5} strokeDasharray="3,3" />
            );
          })}

          {/* 분석 대상 포함 — 스펙트럼 (높은 고도 먼저, 불투명, 실선 stroke) */}
          {drawOrderWith.map((layer, idx) => {
            const color = altToColor(layer.altitudeFt, MIN_ALT, MAX_ALT);
            return (
              <path key={`cw-${idx}`} d={layerPath(layer)}
                fill={color} fillOpacity={1}
                stroke={color} strokeWidth={0.6} />
            );
          })}

          {/* 각 고도별 장애물 영향 차이 */}
          {diffPaths.map((dp, i) => (
            <path key={`diff-${i}`} d={dp.path}
              fill="none" stroke="#ffffff" strokeWidth={1.2} strokeDasharray="4,2" />
          ))}
          {diffPaths.map((dp, i) => (
            <path key={`diffF-${i}`} d={dp.path}
              fill="#ef4444" fillOpacity={0.5} stroke="#ef4444" strokeWidth={0.4} />
          ))}

          {/* Loss 포인트 (장애물 기인 Loss만) */}
          {filteredLoss.map((pt, i) => {
            const { azDeg, distKm } = azimuthAndDist(radarSite.latitude, radarSite.longitude, pt.lat, pt.lon);
            if (distKm > globalMaxRange) return null;
            const rad = (azDeg * Math.PI) / 180;
            const r = distKm * scale;
            const px = cx + r * Math.sin(rad);
            const py = cy - r * Math.cos(rad);
            return (
              <g key={`loss-${i}`}>
                <circle cx={px} cy={py} r={4} fill="none" stroke="#ffffff" strokeWidth={1} />
                <circle cx={px} cy={py} r={2.5} fill="#ef4444" stroke="#b91c1c" strokeWidth={0.5} />
              </g>
            );
          })}

          {/* 건물 위치 */}
          {selectedBuildings.map((b, i) => {
            const { azDeg, distKm } = azimuthAndDist(radarSite.latitude, radarSite.longitude, b.latitude, b.longitude);
            if (distKm > globalMaxRange) return null;
            const rad = (azDeg * Math.PI) / 180;
            const r = distKm * scale;
            const bx = cx + r * Math.sin(rad);
            const by = cy - r * Math.cos(rad);
            return (
              <g key={`bld-${i}`}>
                <rect x={bx - 4} y={by - 4} width={8} height={8} fill="#f59e0b" stroke="#ffffff" strokeWidth={0.8} rx={1.5} />
                <text x={bx + 7} y={by + 3} fill="#92400e" fontSize={7} fontWeight={600}
                  stroke="#ffffff" strokeWidth={2} paintOrder="stroke">{b.name || `B${i + 1}`}</text>
              </g>
            );
          })}

          {/* 레이더 중심 */}
          <circle cx={cx} cy={cy} r={4} fill="#a60739" stroke="white" strokeWidth={1.2} />
          <text x={cx} y={cy + 14} textAnchor="middle" fill="#a60739" fontSize={8} fontWeight={600}
            stroke="#ffffff" strokeWidth={2} paintOrder="stroke">{radarSite.name}</text>

          {/* 스펙트럼 범례 (7개 고도별 개별 표시) */}
          {(() => {
            const legendW = FIXED_ALTS.length * 36;
            const lx = vbX + vbW / 2 - legendW / 2;
            const ly = vbY + vbH - 26;
            return (
              <g>
                {FIXED_ALTS.map((alt, i) => {
                  const x = lx + i * 36;
                  const color = altToColor(alt, MIN_ALT, MAX_ALT);
                  return (
                    <g key={alt}>
                      <rect x={x} y={ly} width={12} height={8} fill={color} rx={1.5} />
                      <text x={x + 6} y={ly + 17} textAnchor="middle" fill="#6b7280" fontSize={7}>
                        {alt >= 1000 ? `${(alt / 1000).toFixed(0)}k` : alt}
                      </text>
                    </g>
                  );
                })}
                <text x={lx + legendW / 2} y={ly - 4} textAnchor="middle" fill="#6b7280" fontSize={7}>
                  고도 (ft)
                </text>
              </g>
            );
          })()}
        </svg>
      </div>

      {/* 범례 */}
      <div className="mt-2 flex flex-wrap justify-center gap-4 text-[10px] text-gray-600">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-6 rounded-sm" style={{
            background: "linear-gradient(to right, hsl(0,85%,50%), hsl(120,85%,50%), hsl(240,85%,50%))",
          }} />
          분석 대상 포함 (실선)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-6 rounded-sm border border-dashed" style={{
            background: "linear-gradient(to right, hsl(0,85%,50%,.4), hsl(120,85%,50%,.4), hsl(240,85%,50%,.4))",
            borderColor: "#9ca3af",
          }} />
          분석 대상 제외 (점선)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-4 rounded-sm bg-red-500/50 border border-white border-dashed" />
          장애물 영향 차이
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-red-500 border border-white" />
          장애물 기인 Loss ({filteredLoss.length}건)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded bg-amber-400 border border-white" />
          분석 대상 장애물
        </span>
        {lowestWith && lowestWith.coneRadiusKm > 0.5 && (
          <span className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-full border border-gray-400 border-dashed" />
            Cone of Silence
          </span>
        )}
      </div>
    </div>
  );
}

export default React.memo(ReportOMCoverageDiff);
