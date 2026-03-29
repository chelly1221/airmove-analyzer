import React, { useMemo, useRef, useEffect, useCallback } from "react";
import { BarChart3 } from "lucide-react";
import type { RadarMonthlyResult, ManualBuilding, RadarSite, LoSProfileData, PanoramaPoint } from "../../types";
import { haversineKm, bearingDeg } from "../../utils/geo";
import ReportOMSectionHeader from "./ReportOMSectionHeader";

interface Props {
  sectionNum: number;
  radarResults: RadarMonthlyResult[];
  selectedBuildings: ManualBuilding[];
  radarSites: RadarSite[];
  losMap: Map<string, LoSProfileData>;
  panoWithTargets?: Map<string, PanoramaPoint[]>;
  panoWithoutTargets?: Map<string, PanoramaPoint[]>;
  /** true면 헤더 생략 (OMSectionImage 래핑 시 외부에서 헤더 렌더) */
  hideHeader?: boolean;
}

const R_EARTH = 6_371_000; // 실제 지구반경 (m)
const FT_PER_M = 3.28084;
const KM_PER_NM = 1.852;
const AZ_TOLERANCE = 10; // 방위 허용 오차 (°)

/** elevationProfile에서 running max angle 추출 (지형+건물 통합)
 *  cutoffDistKm 이전까지만 계산 (건물 전/후 분리 가능) */
function runningMaxAngle(
  profile: { distance: number; elevation: number }[],
  radarHeight: number,
  cutoffDistKm?: number,
): number {
  let maxAngle = -Infinity;
  for (const pt of profile) {
    if (pt.distance <= 0) continue;
    if (cutoffDistKm !== undefined && pt.distance > cutoffDistKm) break;
    const dM = pt.distance * 1000;
    const curvDrop = (dM * dM) / (2 * R_EARTH);
    const adjH = pt.elevation - curvDrop;
    const angle = (adjH - radarHeight) / dM;
    if (angle > maxAngle) maxAngle = angle;
  }
  return maxAngle === -Infinity ? 0 : maxAngle;
}

/** 실제 지구 구면 양각 (°) — 레이더에서 목표점까지의 기하학적 양각 */
function calcElevAngleDeg(radarH: number, targetAltM: number, distM: number): number {
  if (distM <= 0) return 0;
  const curvDrop = (distM * distM) / (2 * R_EARTH);
  return Math.atan((targetAltM - curvDrop - radarH) / distM) * 180 / Math.PI;
}

/** running max angle (tan값) → 도 변환 */
function angleToDeg(tanAngle: number): number {
  return Math.atan(tanAngle) * 180 / Math.PI;
}

interface ClassifiedLoss {
  azDeg: number;
  elevAngleDeg: number;
  distKm: number;
  altFt: number;
  durationS: number;
  inShadow: boolean;
  buildingCaused: boolean;
  buildingName: string;
}

interface BuildingInfo {
  id: number;
  name: string;
  distKm: number;
  azDeg: number;
  topM: number;
  angleTotalDeg: number;
  angleTerrainDeg: number;
  angleTotal: number;
  angleTerrain: number;
}

const CHART_W = 720;
const CHART_H = 340;
const MARGIN = { top: 24, right: 20, bottom: 48, left: 50 };
const INNER_W = CHART_W - MARGIN.left - MARGIN.right;
const INNER_H = CHART_H - MARGIN.top - MARGIN.bottom;
const DPR = 2; // Canvas 해상도 배율

const COMPASS_DIRS: Record<number, string> = {
  0: "N", 45: "NE", 90: "E", 135: "SE",
  180: "S", 225: "SW", 270: "W", 315: "NW",
};

// ─── Canvas 차트 서브컴포넌트 ───

interface AzElevChartProps {
  radarName: string;
  losses: ClassifiedLoss[];
  buildings: BuildingInfo[];
  radarSite: RadarSite | null;
  panoWith: PanoramaPoint[];
  panoWithout: PanoramaPoint[];
}

function AzElevChart({ radarName, losses, buildings, radarSite: rs, panoWith, panoWithout }: AzElevChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 축/스케일 계산
  const chartParams = useMemo(() => {
    const minAngle = 0;
    let azCenter = 180, azHalfSpan = 180;
    // 건물 + 소실표적 방위 모두 포함하여 X축 범위 결정
    const focusAzimuths: number[] = [
      ...buildings.map((b) => b.azDeg),
      ...losses.map((l) => l.azDeg),
    ];
    if (focusAzimuths.length > 0) {
      const toRad = Math.PI / 180;
      const sumS = focusAzimuths.reduce((s, az) => s + Math.sin(az * toRad), 0);
      const sumC = focusAzimuths.reduce((s, az) => s + Math.cos(az * toRad), 0);
      azCenter = (Math.atan2(sumS, sumC) / toRad + 360) % 360;
      let maxDist = 0;
      for (const az of focusAzimuths) {
        let d = az - azCenter;
        if (d > 180) d -= 360;
        if (d < -180) d += 360;
        if (Math.abs(d) > maxDist) maxDist = Math.abs(d);
      }
      azHalfSpan = Math.min(maxDist, 180);
    }
    const azSpan = azHalfSpan * 2;

    const azInRange = (az: number) => {
      let rel = az - azCenter;
      if (rel > 180) rel -= 360;
      if (rel < -180) rel += 360;
      return Math.abs(rel) <= azHalfSpan;
    };
    let panoMax = 0;
    for (const p of panoWith) {
      if (azInRange(p.azimuth_deg) && p.elevation_angle_deg > panoMax) panoMax = p.elevation_angle_deg;
    }
    for (const p of panoWithout) {
      if (azInRange(p.azimuth_deg) && p.elevation_angle_deg > panoMax) panoMax = p.elevation_angle_deg;
    }
    // 소실표적 양각도 yTop 후보에 포함
    for (const l of losses) {
      if (l.elevAngleDeg >= 0 && l.elevAngleDeg > panoMax) panoMax = l.elevAngleDeg;
    }
    const maxAngle = panoMax > 4 ? Math.ceil(panoMax) : 4;

    const yRange = maxAngle - minAngle;
    const azTickStep = azSpan > 120 ? 30 : azSpan > 60 ? 15 : azSpan > 30 ? 10 : 5;
    const azRawStart = azCenter - azHalfSpan;
    const azRawEnd = azCenter + azHalfSpan;
    const firstAzTick = Math.ceil(azRawStart / azTickStep) * azTickStep;
    const xTicks: number[] = [];
    for (let v = firstAzTick; v <= azRawEnd + 0.001; v += azTickStep) xTicks.push(v);

    const yStep = yRange > 5 ? 1 : yRange > 2 ? 0.5 : yRange > 1 ? 0.2 : 0.1;
    const yTicks: number[] = [];
    const firstYTick = Math.ceil(minAngle / yStep) * yStep;
    for (let v = firstYTick; v <= maxAngle + 0.001; v += yStep) yTicks.push(Math.round(v * 100) / 100);

    return { minAngle, maxAngle, azCenter, azHalfSpan, azSpan, yRange, xTicks, yTicks, yStep };
  }, [losses, buildings, panoWith, panoWithout]);

  const { minAngle, azCenter, azHalfSpan, azSpan, yRange, xTicks, yTicks, yStep } = chartParams;

  const xScale = useCallback((az: number) => {
    let rel = az - azCenter;
    if (rel > 180) rel -= 360;
    if (rel < -180) rel += 360;
    return MARGIN.left + ((rel + azHalfSpan) / azSpan) * INNER_W;
  }, [azCenter, azHalfSpan, azSpan]);

  const yScale = useCallback((a: number) => {
    return MARGIN.top + INNER_H - ((a - minAngle) / yRange) * INNER_H;
  }, [minAngle, yRange]);

  // Canvas 렌더링
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, CHART_W, CHART_H);

    // 배경
    ctx.fillStyle = "#fafafa";
    ctx.fillRect(MARGIN.left, MARGIN.top, INNER_W, INNER_H);
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 0.5;
    ctx.strokeRect(MARGIN.left, MARGIN.top, INNER_W, INNER_H);

    // 클립 영역 설정
    ctx.save();
    ctx.beginPath();
    ctx.rect(MARGIN.left, MARGIN.top, INNER_W, INNER_H);
    ctx.clip();

    // 그리드 — 방위
    for (const rawDeg of xTicks) {
      const dispDeg = ((rawDeg % 360) + 360) % 360;
      const compass = COMPASS_DIRS[Math.round(dispDeg)];
      const x = xScale(dispDeg);
      ctx.beginPath();
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = "#e5e7eb";
      ctx.lineWidth = compass ? 0.8 : 0.4;
      ctx.moveTo(x, MARGIN.top);
      ctx.lineTo(x, MARGIN.top + INNER_H);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 양각 그리드
    for (const v of yTicks) {
      const y = yScale(v);
      ctx.beginPath();
      if (v > 0) ctx.setLineDash([2, 2]);
      ctx.strokeStyle = "#e5e7eb";
      ctx.lineWidth = 0.5;
      ctx.moveTo(MARGIN.left, y);
      ctx.lineTo(MARGIN.left + INNER_W, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 0° 수평선
    ctx.beginPath();
    ctx.strokeStyle = "#374151";
    ctx.lineWidth = 0.8;
    ctx.moveTo(MARGIN.left, yScale(0));
    ctx.lineTo(MARGIN.left + INNER_W, yScale(0));
    ctx.stroke();

    // ─── 파노라마 프로파일 ───
    const filterSort = (pts: PanoramaPoint[]) =>
      pts
        .filter((p) => {
          let rel = p.azimuth_deg - azCenter;
          if (rel > 180) rel -= 360;
          if (rel < -180) rel += 360;
          return Math.abs(rel) <= azHalfSpan;
        })
        .sort((a, b) => {
          let ra = a.azimuth_deg - azCenter;
          if (ra > 180) ra -= 360; if (ra < -180) ra += 360;
          let rb = b.azimuth_deg - azCenter;
          if (rb > 180) rb -= 360; if (rb < -180) rb += 360;
          return ra - rb;
        });
    const withVis = filterSort(panoWith);
    const withoutVis = filterSort(panoWithout);

    const rH = rs ? rs.altitude + rs.antenna_height : 0;
    const terrainAngleOf = (p: PanoramaPoint) => {
      if (p.obstacle_type === "terrain") return Math.max(0, p.elevation_angle_deg);
      const dM = p.distance_km * 1000;
      if (dM <= 0) return 0;
      const cv = (dM * dM) / (2 * R_EARTH);
      return Math.max(0, Math.atan((p.ground_elev_m - cv - rH) / dM) * 180 / Math.PI);
    };

    const withoutMap = new Map<number, number>();
    for (const p of withoutVis) withoutMap.set(Math.round(p.azimuth_deg * 100), Math.max(0, p.elevation_angle_deg));
    const lookupWithout = (az: number) => withoutMap.get(Math.round(az * 100)) ?? 0;

    // 영역 채우기 헬퍼
    const fillArea = (
      pts: PanoramaPoint[],
      topFn: (p: PanoramaPoint) => number,
      bottomFn: (p: PanoramaPoint) => number,
      color: string,
    ) => {
      if (pts.length < 2) return;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const x = xScale(pts[i].azimuth_deg);
        const y = yScale(topFn(pts[i]));
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      for (let i = pts.length - 1; i >= 0; i--) {
        ctx.lineTo(xScale(pts[i].azimuth_deg), yScale(bottomFn(pts[i])));
      }
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    };

    // 윤곽선 헬퍼
    const drawContour = (pts: PanoramaPoint[], color: string, width: number) => {
      if (pts.length < 2) return;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const x = xScale(pts[i].azimuth_deg);
        const y = yScale(Math.max(0, pts[i].elevation_angle_deg));
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    };

    if (withoutVis.length >= 2 || withVis.length >= 2) {
      // 1) 지형 (연두색)
      fillArea(withoutVis, terrainAngleOf, () => 0, "rgba(134,239,172,0.5)");
      // 2) 건물 (하늘색)
      fillArea(withoutVis, (p) => Math.max(0, p.elevation_angle_deg), terrainAngleOf, "rgba(125,211,252,0.5)");
      // 3) 분석 대상 건물 (빨간색)
      fillArea(withVis, (p) => Math.max(0, p.elevation_angle_deg), (p) => lookupWithout(p.azimuth_deg), "rgba(252,165,165,0.6)");

      // 윤곽선 — 지형: 진한녹색, 분석대상: 빨간색
      drawContour(withoutVis, "#166534", 0.8);
      drawContour(withVis, "#dc2626", 0.8);

      // 건물 위치 마커
      for (const b of buildings) {
        const bx = xScale(b.azDeg);
        const byTop = yScale(b.angleTotalDeg);
        const byBase = yScale(0);
        ctx.beginPath();
        ctx.setLineDash([2, 1]);
        ctx.strokeStyle = "#ef4444";
        ctx.lineWidth = 1.5;
        ctx.moveTo(bx, byBase);
        ctx.lineTo(bx, byTop);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(bx, byTop, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = "#ef4444";
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }
    }

    // ─── 소실표적 (Canvas) ───
    // 1) 장애물 무관 (파란점, 매우 작게)
    ctx.fillStyle = "rgba(59,130,246,0.25)";
    for (const l of losses) {
      if (l.inShadow || l.elevAngleDeg < 0) continue;
      const x = xScale(l.azDeg);
      const y = yScale(l.elevAngleDeg);
      ctx.fillRect(x - 0.5, y - 0.5, 1, 1);
    }

    // 2) 지형 차단 (회색, 작은 원)
    ctx.fillStyle = "rgba(156,163,175,0.6)";
    for (const l of losses) {
      if (!l.inShadow || l.buildingCaused || l.elevAngleDeg < 0) continue;
      const x = xScale(l.azDeg);
      const y = yScale(l.elevAngleDeg);
      ctx.beginPath();
      ctx.arc(x, y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // 3) 건물 추가기인 (검은 × 표시)
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1.2;
    for (const l of losses) {
      if (!l.buildingCaused || l.elevAngleDeg < 0) continue;
      const x = xScale(l.azDeg);
      const y = yScale(l.elevAngleDeg);
      const s = 2.5;
      ctx.beginPath();
      ctx.moveTo(x - s, y - s);
      ctx.lineTo(x + s, y + s);
      ctx.moveTo(x + s, y - s);
      ctx.lineTo(x - s, y + s);
      ctx.stroke();
    }

    ctx.restore(); // 클립 해제

    // ─── 축 라벨 (클립 바깥) ───
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // X축 눈금 라벨
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#374151";
    for (const rawDeg of xTicks) {
      const dispDeg = ((rawDeg % 360) + 360) % 360;
      const compass = COMPASS_DIRS[Math.round(dispDeg)];
      const x = xScale(dispDeg);
      ctx.fillText(`${dispDeg.toFixed(0)}°`, x, CHART_H - MARGIN.bottom + 13);
      if (compass) {
        ctx.font = "bold 8px sans-serif";
        ctx.fillStyle = "#6b7280";
        ctx.fillText(compass, x, CHART_H - MARGIN.bottom + 24);
        ctx.font = "9px sans-serif";
        ctx.fillStyle = "#374151";
      }
    }

    // Y축 눈금 라벨
    ctx.textAlign = "end";
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#6b7280";
    for (const v of yTicks) {
      ctx.fillText(`${v.toFixed(yStep < 1 ? 1 : 0)}°`, MARGIN.left - 4, yScale(v));
    }

    // 축 제목
    ctx.textAlign = "center";
    ctx.fillStyle = "#6b7280";
    ctx.font = "10px sans-serif";
    ctx.fillText("방위", MARGIN.left + INNER_W / 2, CHART_H - 2);

    ctx.save();
    ctx.translate(14, MARGIN.top + INNER_H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("양각 (°)", 0, 0);
    ctx.restore();
  }, [losses, buildings, rs, panoWith, panoWithout, xTicks, yTicks, yStep, azCenter, azHalfSpan, xScale, yScale]);

  // 통계
  const inShadowCount = useMemo(() => losses.filter((l) => l.inShadow).length, [losses]);
  const bldgCausedCount = useMemo(() => losses.filter((l) => l.buildingCaused).length, [losses]);
  const totalCount = losses.length;
  const shadowRatio = totalCount > 0 ? (inShadowCount / totalCount) * 100 : 0;
  const bldgCausedRatio = totalCount > 0 ? (bldgCausedCount / totalCount) * 100 : 0;
  const bldgCausedDuration = useMemo(() => losses.filter((l) => l.buildingCaused).reduce((s, l) => s + l.durationS, 0), [losses]);
  const freeCount = totalCount - inShadowCount;

  return (
    <div className="mb-6">
      <h3 className="mb-2 text-[15px] font-semibold text-gray-700">{radarName}</h3>

      <canvas
        ref={canvasRef}
        width={CHART_W * DPR}
        height={CHART_H * DPR}
        style={{ width: "100%", height: "auto", display: "block" }}
      />

      {/* 범례 */}
      <div className="flex flex-wrap items-center gap-3 justify-center mt-1.5 text-[11px] text-gray-500">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-2.5 rounded-sm" style={{ backgroundColor: "#86efac", opacity: 0.5 }} />
          지형
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-2.5 rounded-sm" style={{ backgroundColor: "#7dd3fc", opacity: 0.5 }} />
          건물
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-2.5 rounded-sm" style={{ backgroundColor: "#fca5a5", opacity: 0.6 }} />
          분석 대상 건물
        </span>
        <span className="flex items-center gap-1">
          <svg width="10" height="10" viewBox="0 0 10 10" className="inline-block">
            <line x1="2" y1="2" x2="8" y2="8" stroke="#000" strokeWidth="1.5" />
            <line x1="8" y1="2" x2="2" y2="8" stroke="#000" strokeWidth="1.5" />
          </svg>
          장애물 추가 기인
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "#9ca3af", opacity: 0.6 }} />
          지형 차단
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: "rgba(59,130,246,0.5)" }} />
          장애물 무관
        </span>
      </div>

      {/* 요약 테이블 */}
      <table className="mt-3 w-full border-collapse text-[12px]">
        <thead>
          <tr className="bg-[#28283c] text-white">
            <th className="border border-gray-300 px-2 py-1 font-medium">항목</th>
            <th className="border border-gray-300 px-2 py-1 font-medium">값</th>
            <th className="border border-gray-300 px-2 py-1 font-medium">비고</th>
          </tr>
        </thead>
        <tbody>
          <tr className="bg-white">
            <td className="border border-gray-200 px-2 py-1">전체 소실표적</td>
            <td className="border border-gray-200 px-2 py-1 text-right font-mono">{totalCount}건</td>
            <td className="border border-gray-200 px-2 py-1 text-gray-500">분석 구간 내 누적</td>
          </tr>
          <tr className="bg-gray-50">
            <td className="border border-gray-200 px-2 py-1">LoS 차단 영역 내 (전체)</td>
            <td className="border border-gray-200 px-2 py-1 text-right font-mono">
              {inShadowCount}건 ({shadowRatio.toFixed(1)}%)
            </td>
            <td className="border border-gray-200 px-2 py-1 text-gray-500">지형+건물 통합 차단</td>
          </tr>
          <tr className="bg-white">
            <td className="border border-gray-200 px-2 py-1 font-semibold text-[#a60739]">장애물 추가 기인</td>
            <td className="border border-gray-200 px-2 py-1 text-right font-mono font-bold" style={{ color: bldgCausedRatio > 10 ? "#dc2626" : "#374151" }}>
              {bldgCausedCount}건 ({bldgCausedRatio.toFixed(1)}%) / {bldgCausedDuration.toFixed(1)}초
            </td>
            <td className="border border-gray-200 px-2 py-1 text-gray-500">
              분석 대상 장애물로 인한 추가 차단
            </td>
          </tr>
          <tr className="bg-gray-50">
            <td className="border border-gray-200 px-2 py-1 text-blue-600">장애물 무관</td>
            <td className="border border-gray-200 px-2 py-1 text-right font-mono">
              {freeCount}건 ({totalCount > 0 ? ((freeCount / totalCount) * 100).toFixed(1) : "0.0"}%)
            </td>
            <td className="border border-gray-200 px-2 py-1 text-gray-500">차단 영역 외 소실표적</td>
          </tr>
          {buildings.map((b) => {
            const bCaused = losses.filter((l) => l.buildingName === b.name && l.buildingCaused);
            const bDur = bCaused.reduce((s, l) => s + l.durationS, 0);
            const hasBldgEffect = b.angleTotalDeg > b.angleTerrainDeg + 0.005;
            return (
              <tr key={b.name} className="bg-white">
                <td className="border border-gray-200 px-2 py-1 pl-4">↳ {b.name}</td>
                <td className="border border-gray-200 px-2 py-1 text-right font-mono">
                  {bCaused.length}건 / {bDur.toFixed(1)}초
                </td>
                <td className="border border-gray-200 px-2 py-1 text-gray-500">
                  방위 {b.azDeg.toFixed(0)}° · {(b.distKm / KM_PER_NM).toFixed(1)}NM · 차단각 {b.angleTotalDeg.toFixed(2)}°
                  {hasBldgEffect ? ` (지형 ${b.angleTerrainDeg.toFixed(2)}°)` : " (지형 이하)"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* 판정 뱃지 */}
      <div className="mt-2 flex items-center gap-2">
        <span className="text-[12px] text-gray-500">장애물 추가 기인 판정:</span>
        {bldgCausedRatio > 20 ? (
          <span className="px-2 py-0.5 rounded text-[12px] font-bold bg-red-100 text-red-700">
            유의미 — 소실표적의 {bldgCausedRatio.toFixed(0)}%가 장애물 추가 차단 영역 내
          </span>
        ) : bldgCausedRatio > 5 ? (
          <span className="px-2 py-0.5 rounded text-[12px] font-bold bg-amber-100 text-amber-700">
            부분 영향 — 소실표적의 {bldgCausedRatio.toFixed(0)}%가 장애물 추가 차단 영역 내
          </span>
        ) : (
          <span className="px-2 py-0.5 rounded text-[12px] font-bold bg-green-100 text-green-700">
            영향 미미 — 장애물 추가 기인 {bldgCausedRatio.toFixed(0)}% (지형 또는 기타 원인 우세)
          </span>
        )}
      </div>
    </div>
  );
}

// ─── 메인 컴포넌트 ───

function ReportOMAltitudeDistribution({
  sectionNum,
  radarResults,
  selectedBuildings,
  radarSites,
  losMap,
  panoWithTargets,
  panoWithoutTargets,
  hideHeader,
}: Props) {
  const radarAnalysis = useMemo(() => {
    return radarResults.map((rr) => {
      const rs = radarSites.find((r) => r.name === rr.radar_name);
      if (!rs) return { radarName: rr.radar_name, losses: [] as ClassifiedLoss[], buildings: [] as BuildingInfo[], radarSite: null as RadarSite | null };

      const radarH = rs.altitude + rs.antenna_height;

      // 건물별 정보 + losMap 프로파일에서 angle 추출
      const bldgInfo: BuildingInfo[] = selectedBuildings.map((b) => {
        const topM = (b.ground_elev || 0) + b.height;
        const distKm = haversineKm(rs.latitude, rs.longitude, b.latitude, b.longitude);
        const key = `${rs.name}_${b.id}`;
        const los = losMap.get(key);

        let angleTotal = 0;
        let angleTerrain = 0;
        if (los && los.elevationProfile.length > 0) {
          angleTotal = runningMaxAngle(los.elevationProfile, radarH);
          angleTerrain = runningMaxAngle(los.elevationProfile, radarH, distKm);
        } else {
          const dM = distKm * 1000;
          const curvDrop = (dM * dM) / (2 * R_EARTH);
          angleTotal = (topM - curvDrop - radarH) / dM;
          angleTerrain = 0;
        }

        return {
          id: b.id,
          name: b.name || `건물${b.id}`,
          distKm,
          azDeg: bearingDeg(rs.latitude, rs.longitude, b.latitude, b.longitude),
          topM,
          angleTotalDeg: angleToDeg(angleTotal),
          angleTerrainDeg: angleToDeg(angleTerrain),
          angleTotal,
          angleTerrain,
        };
      });

      // 소실표적 분류 — 양각 기반 (altitude 비교와 수학적 등가)
      const allLoss = rr.daily_stats.flatMap((d) => d.loss_points_summary);
      const classified: ClassifiedLoss[] = [];

      for (const lp of allLoss) {
        const lpDistKm = haversineKm(rs.latitude, rs.longitude, lp.lat, lp.lon);
        const lpAz = bearingDeg(rs.latitude, rs.longitude, lp.lat, lp.lon);
        const lpAltM = lp.alt_ft / FT_PER_M;
        const lpDistM = lpDistKm * 1000;
        const lpElevDeg = calcElevAngleDeg(radarH, lpAltM, lpDistM);

        // 가장 가까운 방위의 건물
        let bestBldg: BuildingInfo | undefined = bldgInfo[0];
        let bestAzDiff = 360;
        for (const b of bldgInfo) {
          let azDiff = Math.abs(lpAz - b.azDeg);
          if (azDiff > 180) azDiff = 360 - azDiff;
          if (azDiff < bestAzDiff) { bestAzDiff = azDiff; bestBldg = b; }
        }

        let inShadow = false;
        let buildingCaused = false;

        if (bestBldg && bestAzDiff <= AZ_TOLERANCE && lpDistKm > bestBldg.distKm && bestBldg.distKm > 0.01) {
          // 양각이 차단각보다 낮으면 shadow 내
          inShadow = lpElevDeg < bestBldg.angleTotalDeg;
          if (inShadow) {
            // 지형 차단각 이상이면 건물 추가 기인
            buildingCaused = lpElevDeg >= bestBldg.angleTerrainDeg;
          }
        }

        classified.push({
          azDeg: lpAz,
          elevAngleDeg: lpElevDeg,
          distKm: lpDistKm,
          altFt: lp.alt_ft,
          durationS: lp.duration_s,
          inShadow,
          buildingCaused,
          buildingName: bestBldg?.name || "",
        });
      }

      return { radarName: rr.radar_name, losses: classified, buildings: bldgInfo, radarSite: rs };
    });
  }, [radarResults, radarSites, selectedBuildings, losMap]);

  if (radarAnalysis.every((r) => r.losses.length === 0)) {
    const hasDailyData = radarResults.some((rr) => rr.daily_stats.length > 0);
    return (
      <div className="mb-8">
        {!hideHeader && <ReportOMSectionHeader sectionNum={sectionNum} title="LoS 차단 양각 대비 표적소실 분포" />}
        <div className="flex flex-col items-center py-12 text-gray-400">
          <BarChart3 size={28} strokeWidth={1.2} className="mb-2" />
          <p className="text-sm">{hasDailyData ? "분석 기간 내 표적소실 미발생 (양호)" : "분석 데이터 없음"}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-8">
      <ReportOMSectionHeader sectionNum={sectionNum} title="LoS 차단 양각 대비 표적소실 분포" />

      {radarAnalysis.map(({ radarName, losses, buildings, radarSite: rs }) => {
        if (losses.length === 0) {
          return (
            <div key={radarName} className="mb-5">
              <h3 className="mb-2 text-[15px] font-semibold text-gray-700">{radarName}</h3>
              <p className="text-[12px] text-gray-400">표적소실 데이터 없음</p>
            </div>
          );
        }

        return (
          <AzElevChart
            key={radarName}
            radarName={radarName}
            losses={losses}
            buildings={buildings}
            radarSite={rs}
            panoWith={panoWithTargets?.get(radarName) ?? []}
            panoWithout={panoWithoutTargets?.get(radarName) ?? []}
          />
        );
      })}
    </div>
  );
}

export default React.memo(ReportOMAltitudeDistribution);
