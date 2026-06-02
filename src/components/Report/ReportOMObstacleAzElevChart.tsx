/**
 * OM 보고서 — (레이더 × 분석 대상 장애물) 별 LoS 차단 양각 대비 표적소실 분포 차트.
 *
 * 분석 대상 장애물 주변 방위 윈도우만 보여주는 컴팩트 버전. (기존 전체 방위 버전인
 * ReportOMAltitudeDistribution 을 대체해서 ReportOMObstacleDetail 에 인라인으로 들어감.)
 *
 *  - 베이스(연두): 지형 + 기존 지형지물 = panoWithout 의 silhouette 아래 영역
 *  - 추가(빨강): 분석 대상 장애물로 인해 추가된 차단 영역 = panoWith − panoWithout
 *  - 소실표적: 이 방위 윈도우 + 분석 대상 후방만, 분류별로 점 색 구분
 *      · 검은 ×  — 장애물 추가 기인 (지형 차단각 ≤ 양각 < 대상 차단각)
 *      · 회색 ○  — 지형 차단 (양각 < 지형 차단각)
 *      · 파란 ▫  — 장애물 무관 (양각 ≥ 대상 차단각, 차단 영역 밖)
 */
import { useMemo, useRef, useEffect, useCallback } from "react";
import type { ManualBuilding, BuildingGroup, RadarSite, LoSProfileData, PanoramaPoint } from "../../types";
import type { LossPointGeo } from "../../types/obstacle";
import { classifyObstacleLosses } from "../../utils/obstacleAnalysisHelpers";
import OMEditable from "./OMEditable";

const KM_PER_NM = 1.852;
const AZ_TOLERANCE = 10;

const CHART_W = 720;
const CHART_H = 240;
const MARGIN = { top: 16, right: 16, bottom: 34, left: 50 };
const INNER_W = CHART_W - MARGIN.left - MARGIN.right;
const INNER_H = CHART_H - MARGIN.top - MARGIN.bottom;
const DPR = 2;

const COMPASS_DIRS: Record<number, string> = {
  0: "N", 45: "NE", 90: "E", 135: "SE",
  180: "S", 225: "SW", 270: "W", 315: "NW",
};

interface Props {
  radarSite: RadarSite;
  building: ManualBuilding;
  /** 그룹 메타 (현재는 미사용, 향후 색 라벨용) */
  buildingGroups?: BuildingGroup[];
  los: LoSProfileData;
  /** panoWithTargets[radar].terrain — 분석 대상 포함 silhouette */
  panoWith: PanoramaPoint[];
  /** panoWithoutTargets[radar].terrain — 분석 대상 제외 silhouette */
  panoWithout: PanoramaPoint[];
  /** 이 레이더의 모든 소실표적 (방위 윈도우 + 대상 후방 필터링은 내부에서) */
  lossPoints: LossPointGeo[];
}

export default function ReportOMObstacleAzElevChart({
  radarSite, building, los, panoWith, panoWithout, lossPoints,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 건물 메타 + 소실표적 분류 — obstacleAnalysisHelpers 의 단일 소스 사용
  // (요약 표의 '음영 소실' 건수와 이 차트의 빨강 점 분류가 항상 일치)
  const computed = useMemo(
    () => classifyObstacleLosses(radarSite, building, los, lossPoints),
    [radarSite, building, los, lossPoints],
  );

  // 축/스케일 — 분석 대상 방위 중심.
  // 분석 대상으로 인한 추가 차단(빨강, panoWith>panoWithout) + 지형(녹색) 영역이 차트에
  // 꽉 차도록 축을 그 영역에 맞추고 각 축 10% 여백만 둔다. (멀리 떨어진 무관 소실표적이
  // 축을 넓히던 동작은 제거 — 음영 내 소실표적까지만 X 범위에 반영.)
  const chartParams = useMemo(() => {
    const azCenter = computed.bAzDeg;
    const SEARCH_CAP = AZ_TOLERANCE + 5; // 15° — 탐색·최대 한계

    const relAz = (az: number) => {
      let rel = az - azCenter;
      if (rel > 180) rel -= 360;
      if (rel < -180) rel += 360;
      return rel;
    };

    // panoWithout(분석 대상 제외 실루엣) 룩업
    const withoutMap = new Map<number, number>();
    for (const p of panoWithout) withoutMap.set(Math.round(p.azimuth_deg * 100), Math.max(0, p.elevation_angle_deg));
    const lookupWithout = (az: number) => withoutMap.get(Math.round(az * 100)) ?? 0;

    // 추가 차단(빨강) 영역 + 음영 내 소실표적의 방위 폭 → 콘텐츠 반폭
    let contentHalf = 0;
    for (const p of panoWith) {
      const rel = relAz(p.azimuth_deg);
      if (Math.abs(rel) > SEARCH_CAP) continue;
      const add = Math.max(0, p.elevation_angle_deg) - lookupWithout(p.azimuth_deg);
      if (add > 0.01 && Math.abs(rel) > contentHalf) contentHalf = Math.abs(rel);
    }
    for (const l of computed.losses) {
      if (!l.inShadow) continue; // 음영(지형/장애물 차단) 내 소실표적만 — 무관 소실표적은 제외
      const absRel = Math.abs(relAz(l.azDeg));
      if (absRel <= SEARCH_CAP && absRel > contentHalf) contentHalf = absRel;
    }
    // 콘텐츠 폭 + 10% 여백, 문맥 확보용 최소 4°, 최대 15°
    const azHalfSpan = Math.min(Math.max(contentHalf * 1.1, 4), SEARCH_CAP);
    const azSpan = azHalfSpan * 2;

    const azInRange = (az: number) => Math.abs(relAz(az)) <= azHalfSpan;

    // Y 최대 — 윈도우 내 panoWith silhouette + 대상 차단각 (소실표적 양각은 Y 확장 제외)
    let panoMax = 0;
    for (const p of panoWith) {
      if (azInRange(p.azimuth_deg) && p.elevation_angle_deg > panoMax) panoMax = p.elevation_angle_deg;
    }
    if (computed.angleTotalDeg > panoMax) panoMax = computed.angleTotalDeg;
    // 영역이 Y축에도 꽉 차도록 — 상단 10% 여백만
    const maxAngle = panoMax > 0.05 ? panoMax * 1.1 : 0.6;

    const yRange = maxAngle;
    const yStep = yRange > 5 ? 1 : yRange > 2 ? 0.5 : yRange > 1 ? 0.2 : yRange > 0.5 ? 0.1 : 0.05;
    const yTicks: number[] = [];
    for (let v = 0; v <= maxAngle + 0.001; v += yStep) yTicks.push(Math.round(v * 1000) / 1000);

    const azTickStep = azSpan >= 24 ? 5 : azSpan >= 10 ? 2 : 1;
    const azStart = azCenter - azHalfSpan;
    const azEnd = azCenter + azHalfSpan;
    const firstTick = Math.ceil(azStart / azTickStep) * azTickStep;
    const xTicks: number[] = [];
    for (let v = firstTick; v <= azEnd + 0.001; v += azTickStep) xTicks.push(v);

    return { azCenter, azHalfSpan, azSpan, yRange, yStep, yTicks, xTicks };
  }, [computed, panoWith, panoWithout]);

  const { azCenter, azHalfSpan, azSpan, yRange, yStep, yTicks, xTicks } = chartParams;

  const xScale = useCallback((az: number) => {
    let rel = az - azCenter;
    if (rel > 180) rel -= 360;
    if (rel < -180) rel += 360;
    return MARGIN.left + ((rel + azHalfSpan) / azSpan) * INNER_W;
  }, [azCenter, azHalfSpan, azSpan]);

  const yScale = useCallback((a: number) => {
    return MARGIN.top + INNER_H - (a / yRange) * INNER_H;
  }, [yRange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, CHART_W, CHART_H);

    ctx.fillStyle = "#fafafa";
    ctx.fillRect(MARGIN.left, MARGIN.top, INNER_W, INNER_H);
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 0.5;
    ctx.strokeRect(MARGIN.left, MARGIN.top, INNER_W, INNER_H);

    ctx.save();
    ctx.beginPath();
    ctx.rect(MARGIN.left, MARGIN.top, INNER_W, INNER_H);
    ctx.clip();

    // 방위 그리드
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

    // 파노라마 윈도우 필터+정렬
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

    const withoutMap = new Map<number, number>();
    for (const p of withoutVis) withoutMap.set(Math.round(p.azimuth_deg * 100), Math.max(0, p.elevation_angle_deg));
    const lookupWithout = (az: number) => withoutMap.get(Math.round(az * 100)) ?? 0;

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
      // 1) 베이스: 지형 + 기존 지형지물 = panoWithout silhouette 아래 (연두)
      fillArea(withoutVis, (p) => Math.max(0, p.elevation_angle_deg), () => 0, "rgba(134,239,172,0.55)");
      // 2) 분석 대상 추가 차단 = panoWith silhouette 와 without 사이 (빨강)
      fillArea(withVis, (p) => Math.max(0, p.elevation_angle_deg), (p) => lookupWithout(p.azimuth_deg), "rgba(252,165,165,0.65)");
      drawContour(withoutVis, "#166534", 0.8);
      drawContour(withVis, "#dc2626", 1);
    }

    // 분석 대상 방위 마커
    {
      const bx = xScale(computed.bAzDeg);
      const byTop = yScale(computed.angleTotalDeg);
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
      ctx.arc(bx, byTop, 2.8, 0, Math.PI * 2);
      ctx.fillStyle = "#ef4444";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }

    // 소실표적
    // 1) 장애물 무관 (파란점)
    ctx.fillStyle = "rgba(59,130,246,0.3)";
    for (const l of computed.losses) {
      if (l.inShadow || l.elevAngleDeg < 0) continue;
      const x = xScale(l.azDeg);
      const y = yScale(l.elevAngleDeg);
      ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
    }
    // 2) 지형 차단 (회색 원)
    ctx.fillStyle = "rgba(107,114,128,0.7)";
    for (const l of computed.losses) {
      if (!l.inShadow || l.buildingCaused || l.elevAngleDeg < 0) continue;
      const x = xScale(l.azDeg);
      const y = yScale(l.elevAngleDeg);
      ctx.beginPath();
      ctx.arc(x, y, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    // 3) 장애물 추가 기인 (검은 ×)
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1.4;
    for (const l of computed.losses) {
      if (!l.buildingCaused || l.elevAngleDeg < 0) continue;
      const x = xScale(l.azDeg);
      const y = yScale(l.elevAngleDeg);
      const s = 2.8;
      ctx.beginPath();
      ctx.moveTo(x - s, y - s);
      ctx.lineTo(x + s, y + s);
      ctx.moveTo(x + s, y - s);
      ctx.lineTo(x - s, y + s);
      ctx.stroke();
    }

    ctx.restore();

    // 축 라벨
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#374151";
    for (const rawDeg of xTicks) {
      const dispDeg = ((rawDeg % 360) + 360) % 360;
      const compass = COMPASS_DIRS[Math.round(dispDeg)];
      const x = xScale(dispDeg);
      ctx.fillText(`${dispDeg.toFixed(0)}°`, x, CHART_H - MARGIN.bottom + 11);
      if (compass) {
        ctx.font = "bold 8px sans-serif";
        ctx.fillStyle = "#6b7280";
        ctx.fillText(compass, x, CHART_H - MARGIN.bottom + 20);
        ctx.font = "9px sans-serif";
        ctx.fillStyle = "#374151";
      }
    }

    ctx.textAlign = "end";
    ctx.fillStyle = "#6b7280";
    for (const v of yTicks) {
      ctx.fillText(`${v.toFixed(yStep < 1 ? (yStep < 0.1 ? 2 : 1) : 0)}°`, MARGIN.left - 4, yScale(v));
    }

    ctx.textAlign = "center";
    ctx.fillStyle = "#6b7280";
    ctx.font = "10px sans-serif";
    ctx.fillText("방위", MARGIN.left + INNER_W / 2, CHART_H - 2);
    ctx.save();
    ctx.translate(13, MARGIN.top + INNER_H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("양각 (°)", 0, 0);
    ctx.restore();
  }, [computed, panoWith, panoWithout, xTicks, yTicks, yStep, azCenter, azHalfSpan, xScale, yScale, yRange]);

  // 요약 수치
  const total = computed.losses.length;
  const shadowCount = computed.shadowCount;
  const bldgCount = computed.buildingCount;
  const bldgDuration = computed.buildingDurationS;
  const freeCount = total - shadowCount;
  const shadowRatio = total > 0 ? (shadowCount / total) * 100 : 0;
  const bldgRatio = total > 0 ? (bldgCount / total) * 100 : 0;
  const hasBldgEffect = computed.angleTotalDeg > computed.angleTerrainDeg + 0.005;

  // 인라인 편집키 접두사 — (레이더 × 건물) 페이지마다 독립 편집 (detail.* 헤더 키와 동일 스킴)
  const eid = `azelev.${radarSite.name}_${building.id}`;

  return (
    <div className="mt-2">
      {/* 차트 제목 */}
      <div className="mb-1 flex items-center justify-between text-[12px]">
        <OMEditable id={`${eid}.title`} value="LoS 차단 양각 대비 표적소실 분포" tag="span" className="font-semibold text-gray-800" />
        <span className="text-[10px] text-gray-400">
          분석 대상 방위 {computed.bAzDeg.toFixed(0)}° ± {azHalfSpan.toFixed(0)}°
        </span>
      </div>

      <canvas
        ref={canvasRef}
        width={CHART_W * DPR}
        height={CHART_H * DPR}
        style={{ width: "100%", height: "auto", display: "block" }}
      />

      {/* 범례 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 justify-center mt-1 text-[10px] text-gray-500">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-2.5 rounded-sm" style={{ backgroundColor: "#86efac", opacity: 0.55 }} />
          <OMEditable id={`${eid}.legend.terrain`} value="지형 + 기존 지형지물" tag="span" />
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-2.5 rounded-sm" style={{ backgroundColor: "#fca5a5", opacity: 0.65 }} />
          <OMEditable id={`${eid}.legend.added`} value="분석 대상 추가 차단" tag="span" />
        </span>
        <span className="flex items-center gap-1">
          <svg width="10" height="10" viewBox="0 0 10 10" className="inline-block">
            <line x1="2" y1="2" x2="8" y2="8" stroke="#000" strokeWidth="1.4" />
            <line x1="8" y1="2" x2="2" y2="8" stroke="#000" strokeWidth="1.4" />
          </svg>
          <OMEditable id={`${eid}.legend.bldgCaused`} value="장애물 추가 기인" tag="span" />
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "#6b7280", opacity: 0.7 }} />
          <OMEditable id={`${eid}.legend.terrainBlock`} value="지형 차단" tag="span" />
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: "rgba(59,130,246,0.5)" }} />
          <OMEditable id={`${eid}.legend.free`} value="장애물 무관" tag="span" />
        </span>
      </div>

      {/* 요약 테이블 */}
      <table className="mt-2 w-full border-collapse text-[11px]">
        <thead>
          <tr className="bg-[#28283c] text-white">
            <th className="border border-gray-300 px-2 py-1 font-medium"><OMEditable id={`${eid}.tbl.colItem`} value="항목" tag="span" /></th>
            <th className="border border-gray-300 px-2 py-1 font-medium"><OMEditable id={`${eid}.tbl.colVal`} value="값" tag="span" /></th>
            <th className="border border-gray-300 px-2 py-1 font-medium"><OMEditable id={`${eid}.tbl.colNote`} value="비고" tag="span" /></th>
          </tr>
        </thead>
        <tbody>
          <tr className="bg-white">
            <td className="border border-gray-200 px-2 py-1">방위 ±{azHalfSpan.toFixed(0)}° · <OMEditable id={`${eid}.tbl.r1.label`} value="후방 소실표적" tag="span" /></td>
            <td className="border border-gray-200 px-2 py-1 text-right font-mono">{total}건</td>
            <td className="border border-gray-200 px-2 py-1 text-gray-500"><OMEditable id={`${eid}.tbl.r1.note`} value="분석 대상 후방 영역" tag="span" /></td>
          </tr>
          <tr className="bg-gray-50">
            <td className="border border-gray-200 px-2 py-1"><OMEditable id={`${eid}.tbl.r2.label`} value="LoS 차단 영역 내" tag="span" /></td>
            <td className="border border-gray-200 px-2 py-1 text-right font-mono">
              {shadowCount}건 ({shadowRatio.toFixed(1)}%)
            </td>
            <td className="border border-gray-200 px-2 py-1 text-gray-500"><OMEditable id={`${eid}.tbl.r2.note`} value="지형+장애물 통합 차단" tag="span" /></td>
          </tr>
          <tr className="bg-white">
            <td className="border border-gray-200 px-2 py-1 font-semibold text-[#a60739]"><OMEditable id={`${eid}.tbl.r3.label`} value="장애물 추가 기인" tag="span" /></td>
            <td className="border border-gray-200 px-2 py-1 text-right font-mono font-bold"
                style={{ color: bldgRatio > 10 ? "#dc2626" : "#374151" }}>
              {bldgCount}건 ({bldgRatio.toFixed(1)}%) / {bldgDuration.toFixed(1)}초
            </td>
            <td className="border border-gray-200 px-2 py-1 text-gray-500">
              <OMEditable id={`${eid}.tbl.r3.note`} value="지형 차단각 초과 ~ 대상 차단각 사이" tag="span" />
            </td>
          </tr>
          <tr className="bg-gray-50">
            <td className="border border-gray-200 px-2 py-1 text-blue-600"><OMEditable id={`${eid}.tbl.r4.label`} value="장애물 무관" tag="span" /></td>
            <td className="border border-gray-200 px-2 py-1 text-right font-mono">
              {freeCount}건 ({total > 0 ? ((freeCount / total) * 100).toFixed(1) : "0.0"}%)
            </td>
            <td className="border border-gray-200 px-2 py-1 text-gray-500"><OMEditable id={`${eid}.tbl.r4.note`} value="차단 영역 외 소실표적" tag="span" /></td>
          </tr>
          <tr className="bg-white">
            <td className="border border-gray-200 px-2 py-1">↳ <OMEditable id={`${eid}.tbl.r5.label`} value="대상 차단각" tag="span" /></td>
            <td className="border border-gray-200 px-2 py-1 text-right font-mono">
              {computed.angleTotalDeg.toFixed(2)}°
              {hasBldgEffect ? ` (지형 ${computed.angleTerrainDeg.toFixed(2)}°)` : " (지형 이하)"}
            </td>
            <td className="border border-gray-200 px-2 py-1 text-gray-500">
              {(computed.bDistKm / KM_PER_NM).toFixed(1)}NM · 추가 기인 판정:
              {" "}
              {bldgRatio > 20
                ? <span className="font-bold text-red-600">유의미</span>
                : bldgRatio > 5
                  ? <span className="font-bold text-amber-600">부분 영향</span>
                  : <span className="font-bold text-green-600">영향 미미</span>}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
