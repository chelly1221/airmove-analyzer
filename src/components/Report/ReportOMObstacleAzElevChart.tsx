/**
 * OM 보고서 — (레이더 × 분석 대상 장애물) 별 LoS 차단 양각 대비 표적소실 분포 차트.
 *
 * 분석 대상 장애물 주변 방위 윈도우만 보여주는 컴팩트 버전. (기존 전체 방위 버전인
 * ReportOMAltitudeDistribution 을 대체해서 ReportOMObstacleDetail 에 인라인으로 들어감.)
 *
 *  - 베이스(연두): 지형 + 기존 지형지물 = without 윗변 아래 영역
 *  - 추가(빨강): 분석 대상 장애물로 인해 추가된 차단 영역 = with 윗변 − without 윗변
 *    · 윗변 = 지형 + 건물 실루엣을 방위별 max 로 합성. 건물 실루엣은 레이더 시점에서 본
 *      압출 폴리곤의 가변 윗변(방위별 양각, panorama.rs build_building_silhouette).
 *  - 소실표적: 이 방위 윈도우 + 분석 대상 후방의 모든 소실표적을 빨간 점으로 통일 표시
 *      (LoS 단면도와 동일 #ff1745). 분류별 건수(장애물 추가 기인 / 지형 차단 / 장애물 무관)는
 *      별도 요약표 컴포넌트(ReportOMObstacleSummaryTable)에서 제공 — 동일 classifyObstacleLosses 공유.
 */
import { useMemo, useRef, useEffect, useCallback } from "react";
import type { ManualBuilding, BuildingGroup, RadarSite, LoSProfileData, PanoramaMergeResult, BuildingObstacle } from "../../types";
import type { LossPointGeo, TrackPointGeo } from "../../types/obstacle";
import { classifyObstacleLosses, calcBuildingAzExtent, makeTerrainSampler, pointElevAngleDeg, FT_PER_M, type SiblingBuilding } from "../../utils/obstacleAnalysisHelpers";
import { bearingDeg, haversineKm } from "../../utils/geo";
import { detectionTypeColor, PSR_TYPES } from "../../utils/radarConstants";
import OMEditable from "./OMEditable";

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

interface SilPoint { rel: number; elev: number; }
interface SilLines { withoutLine: SilPoint[]; withLine: SilPoint[]; peak: number; }

const EMPTY_MERGE: PanoramaMergeResult = { terrain: [], buildings: [] };

/**
 * 윈도우 내 방위별 실루엣 윗변 합성.
 * 지형(공유 terrain) + 건물(방위별 실루엣 폴리라인 or 단순 밴드)을 방위별 max 로 합쳐
 * with(분석 대상 포함) / without(제외) 두 윗변 폴리라인 + 피크 양각을 반환.
 *   빨강(추가 차단) = with − without, 녹색 base = without 아래.
 * 건물 silhouette = 레이더 시점에서 본 압출 폴리곤의 가변 윗변(panorama.rs build_building_silhouette).
 */
function buildSilhouetteLines(
  pWith: PanoramaMergeResult,
  pWithout: PanoramaMergeResult,
  azCenter: number,
  azHalfSpan: number,
  azSpan: number,
): SilLines {
  const REL = (az: number) => {
    let r = az - azCenter;
    if (r > 180) r -= 360;
    if (r < -180) r += 360;
    return r;
  };

  // 선형 보간 (rel 오름차순 배열)
  const interp = (arr: SilPoint[], rel: number): number => {
    const m = arr.length;
    if (m === 0) return -Infinity;
    if (rel <= arr[0].rel) return arr[0].elev;
    if (rel >= arr[m - 1].rel) return arr[m - 1].elev;
    let lo = 0, hi = m - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].rel <= rel) lo = mid; else hi = mid;
    }
    const a = arr[lo], b = arr[hi];
    const s = b.rel - a.rel;
    const t = s > 1e-12 ? (rel - a.rel) / s : 0;
    return a.elev + (b.elev - a.elev) * t;
  };

  // 지형 차단각 — 분류(makePanoramaSampler)와 동일한 전역 원형 보간 샘플러 공유 → 장애물 추가 기인 분류(요약 표)↔빨강영역 픽셀 일치.
  //   (rel → 절대 방위 = azCenter + rel; 샘플러가 내부에서 360° 정규화·래핑 처리)
  const terrainSampler = makeTerrainSampler(pWith.terrain);
  const terrainAt = (rel: number) => terrainSampler(azCenter + rel);

  // 건물 → rel 전처리 (방위별 실루엣 폴리라인 or 단순 밴드)
  type Prep =
    | { kind: "sil"; pts: SilPoint[] }
    | { kind: "band"; rs: number; re: number; elev: number };
  const inWindow = (b: BuildingObstacle): boolean => {
    if (b.silhouette && b.silhouette.length) {
      for (const [az] of b.silhouette) if (Math.abs(REL(az)) <= azHalfSpan + 0.5) return true;
      return false;
    }
    const rs = REL(b.azimuth_start_deg), re = REL(b.azimuth_end_deg);
    return Math.max(rs, re) + 0.1 >= -azHalfSpan && Math.min(rs, re) - 0.1 <= azHalfSpan;
  };
  const prep = (b: BuildingObstacle): Prep => {
    if (b.silhouette && b.silhouette.length >= 2) {
      const pts = b.silhouette
        .map(([az, el]) => ({ rel: REL(az), elev: Math.max(0, el) }))
        .sort((a, c) => a.rel - c.rel);
      return { kind: "sil", pts };
    }
    let rs = REL(b.azimuth_start_deg);
    let re = REL(b.azimuth_end_deg);
    if (rs > re) { const t = rs; rs = re; re = t; }
    if (Math.abs(re - rs) < 1e-6) { rs -= 0.05; re += 0.05; } // 점 건물 → 미세 밴드
    return { kind: "band", rs, re, elev: Math.max(0, b.elevation_angle_deg) };
  };
  const prepWith = (pWith.buildings ?? []).filter(inWindow).map(prep);
  const prepWithout = (pWithout.buildings ?? []).filter(inWindow).map(prep);

  const bTop = (rel: number, pb: Prep): number => {
    if (pb.kind === "band") return rel >= pb.rs && rel <= pb.re ? pb.elev : -Infinity;
    const pts = pb.pts;
    if (rel < pts[0].rel - 1e-9 || rel > pts[pts.length - 1].rel + 1e-9) return -Infinity;
    return interp(pts, rel);
  };
  const maxOver = (rel: number, arr: Prep[]) => {
    let m = -Infinity;
    for (const pb of arr) { const v = bTop(rel, pb); if (v > m) m = v; }
    return m;
  };
  const withoutTop = (rel: number) => Math.max(terrainAt(rel), maxOver(rel, prepWithout));
  const withTop = (rel: number) => Math.max(terrainAt(rel), maxOver(rel, prepWith));

  // 샘플 rel 집합 — 균일 그리드 + 건물 코너/밴드 경계 (윗변 코너 보존)
  const relSet = new Set<number>();
  const N = 320;
  for (let i = 0; i <= N; i++) relSet.add(-azHalfSpan + (azSpan * i) / N);
  const pushIn = (rel: number) => {
    if (rel >= -azHalfSpan - 1e-9 && rel <= azHalfSpan + 1e-9) relSet.add(rel);
  };
  for (const pb of [...prepWith, ...prepWithout]) {
    if (pb.kind === "sil") for (const p of pb.pts) pushIn(p.rel);
    else { pushIn(pb.rs); pushIn(pb.re); }
  }
  const rels = [...relSet].sort((a, b) => a - b);

  const withoutLine: SilPoint[] = rels.map((rel) => ({ rel, elev: withoutTop(rel) }));
  const withLine: SilPoint[] = rels.map((rel) => ({ rel, elev: withTop(rel) }));
  let peak = 0;
  for (const p of withLine) if (p.elev > peak) peak = p.elev;
  return { withoutLine, withLine, peak };
}

interface Props {
  radarSite: RadarSite;
  building: ManualBuilding;
  /** 그룹 메타 (현재는 미사용, 향후 색 라벨용) */
  buildingGroups?: BuildingGroup[];
  los: LoSProfileData;
  /** 분석 대상 포함 파노라마 (terrain 공유 + buildings = 전체) */
  panoWith?: PanoramaMergeResult;
  /** 분석 대상 제외 파노라마 (terrain 공유 + buildings = 대상 제외) */
  panoWithout?: PanoramaMergeResult;
  /** 이 레이더의 모든 소실표적 (방위 윈도우 + 대상 후방 필터링은 내부에서) */
  lossPoints: LossPointGeo[];
  /** 이 레이더의 모든 항적 포인트 — 소실표적과 동일 방위창+대상 후방 영역으로 필터해 배경 점으로 표시
   *  (LoS 단면도와 동일한 detection type 색·작은 점). 방위/양각 투영은 내부에서. */
  trackPoints?: TrackPointGeo[];
  /** 같은 레이더의 '다른' 분석 대상 건물(방위°+거리km) — 소실표적 오귀속 방지용 (분류 내부에서 사용) */
  siblings?: SiblingBuilding[];
}

export default function ReportOMObstacleAzElevChart({
  radarSite, building, los, panoWith, panoWithout, lossPoints, trackPoints, siblings,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 건물 메타 + 소실표적 분류 — obstacleAnalysisHelpers 의 단일 소스 사용.
  //  panoWith/panoWithout 제공 시 차단각을 panorama(빨강영역과 동일 소스)에서 산출 → 장애물 추가 기인 분류가 빨강영역과 픽셀 일치.
  //  (요약 표의 '음영 소실'(장애물 추가 기인) 건수가 빨강 영역과 항상 일치 — 양쪽 동일 panorama·sibling 인자.
  //   소실표적 점은 분류와 무관하게 모두 빨간 점으로 표시)
  const computed = useMemo(
    () => classifyObstacleLosses(radarSite, building, los, lossPoints, { panoWith, panoWithout, siblings }),
    [radarSite, building, los, lossPoints, panoWith, panoWithout, siblings],
  );

  // 분석 대상 포함/제외 파노라마 (terrain 공유 + buildings 배열만 다름)
  const pWith = panoWith ?? EMPTY_MERGE;
  const pWithout = panoWithout ?? EMPTY_MERGE;

  // 1) 방위 윈도우 (기하 전용) — 분석 대상 건물의 노출면 방위 각폭.
  //    calcBuildingAzExtent 로 건물 폴리곤의 레이더 방향 방위 구간을 구하고, 중심(대상 방위)
  //    기준 좌우 최대 편차 + 정렬오차 흡수용 1° 마진. (LoS 단면도 항적 윈도우와 동일 스킴)
  const azParams = useMemo(() => {
    const azCenter = computed.bAzDeg;
    const relAz = (az: number) => {
      let rel = az - azCenter;
      if (rel > 180) rel -= 360;
      if (rel < -180) rel += 360;
      return rel;
    };
    const ext = calcBuildingAzExtent(radarSite.latitude, radarSite.longitude, building);
    const AZ_MARGIN = 1; // 정렬오차/빔폭 흡수 마진
    const halfFromExtent = Math.max(Math.abs(relAz(ext.start_deg)), Math.abs(relAz(ext.end_deg)));
    // 빌딩 각폭 + 마진, 최소 가독 폭 2° (점 건물 기본 ±2° 와 정합)
    const azHalfSpan = Math.max(halfFromExtent + AZ_MARGIN, 2);
    const azSpan = azHalfSpan * 2;

    const azTickStep = azSpan >= 24 ? 5 : azSpan >= 10 ? 2 : 1;
    const azStart = azCenter - azHalfSpan;
    const azEnd = azCenter + azHalfSpan;
    const firstTick = Math.ceil(azStart / azTickStep) * azTickStep;
    const xTicks: number[] = [];
    for (let v = firstTick; v <= azEnd + 0.001; v += azTickStep) xTicks.push(v);
    return { azCenter, azHalfSpan, azSpan, xTicks };
  }, [computed.bAzDeg, radarSite.latitude, radarSite.longitude, building]);

  const { azCenter, azHalfSpan, azSpan, xTicks } = azParams;

  // 1b) 항적 점 투영 — 소실표적과 동일 도메인(차트 방위창 + 대상 후방)으로 필터해 (방위, 양각)으로 투영.
  //     양각은 소실표적과 동일 헬퍼(pointElevAngleDeg, ITU 4/3 유효지구 곡률 프레임)로 산출 → 같은 좌표계에서 겹쳐 표시.
  //     색은 LoS 단면도와 동일하게 detection type 별. (전수 포인트 — 다운샘플 없음)
  const trackDots = useMemo(() => {
    const out: { az: number; elev: number; radarType: string }[] = [];
    if (!trackPoints || trackPoints.length === 0) return out;
    const radarH = radarSite.altitude + radarSite.antenna_height;
    const bDistKm = computed.bDistKm;
    const rel = (az: number) => {
      let r = az - azCenter;
      if (r > 180) r -= 360;
      if (r < -180) r += 360;
      return r;
    };
    for (const tp of trackPoints) {
      const distKm = haversineKm(radarSite.latitude, radarSite.longitude, tp.lat, tp.lon);
      if (distKm <= bDistKm + 0.01) continue;                  // 대상 후방만 (소실표적 분류와 동일)
      const az = bearingDeg(radarSite.latitude, radarSite.longitude, tp.lat, tp.lon);
      if (Math.abs(rel(az)) > azHalfSpan + 0.5) continue;      // 차트 방위창 밖 제외
      const elev = pointElevAngleDeg(radarH, tp.alt_ft / FT_PER_M, distKm * 1000);
      if (elev < 0) continue;                                  // 0° 미만은 비표시 (소실표적과 동일)
      out.push({ az, elev, radarType: tp.radar_type });
    }
    return out;
  }, [trackPoints, radarSite.latitude, radarSite.longitude, radarSite.altitude, radarSite.antenna_height, computed.bDistKm, azCenter, azHalfSpan]);

  // 2) 방위별 실루엣 합성 — 지형 + 건물(실루엣/밴드)을 방위별 max 로 합쳐 with/without 윗변 폴리라인.
  const sil = useMemo(
    () => buildSilhouetteLines(pWith, pWithout, azCenter, azHalfSpan, azSpan),
    [pWith, pWithout, azCenter, azHalfSpan, azSpan],
  );

  // 3) Y 스케일 — with 윗변 피크 + 대상 차단각 (소실표적 양각은 Y 확장 제외)
  const yParams = useMemo(() => {
    let panoMax = sil.peak;
    if (computed.angleTotalDeg > panoMax) panoMax = computed.angleTotalDeg;
    // 영역이 Y축에도 꽉 차도록 — 상단 10% 여백만
    const maxAngle = panoMax > 0.05 ? panoMax * 1.1 : 0.6;
    const yRange = maxAngle;
    const yStep = yRange > 5 ? 1 : yRange > 2 ? 0.5 : yRange > 1 ? 0.2 : yRange > 0.5 ? 0.1 : 0.05;
    const yTicks: number[] = [];
    for (let v = 0; v <= maxAngle + 0.001; v += yStep) yTicks.push(Math.round(v * 1000) / 1000);
    return { yRange, yStep, yTicks };
  }, [sil.peak, computed.angleTotalDeg]);
  const { yRange, yStep, yTicks } = yParams;

  const relOf = useCallback((az: number) => {
    let rel = az - azCenter;
    if (rel > 180) rel -= 360;
    if (rel < -180) rel += 360;
    return rel;
  }, [azCenter]);

  const xScaleRel = useCallback(
    (rel: number) => MARGIN.left + ((rel + azHalfSpan) / azSpan) * INNER_W,
    [azHalfSpan, azSpan],
  );
  const xScale = useCallback((az: number) => xScaleRel(relOf(az)), [xScaleRel, relOf]);

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

    ctx.fillStyle = "#ffffff";
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

    const { withoutLine, withLine } = sil;
    const clamp0 = (e: number) => (e < 0 ? 0 : e);

    // 항적 — 배경 레이어(소실표적/실루엣 아래). LoS 단면도와 동일 detection type 색·작은 점.
    //   대상 후방·방위창 내 전수 항적을 깔아 소실표적 분포의 모집단(전체 통과 항적)을 시각화.
    for (const tp of trackDots) {
      const x = xScale(tp.az);
      const y = yScale(tp.elev);
      const col = detectionTypeColor(tp.radarType);
      ctx.beginPath();
      ctx.arc(x, y, 1.3, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},0.5)`;
      ctx.fill();
      if (PSR_TYPES.has(tp.radarType)) {
        ctx.lineWidth = 0.6;
        ctx.strokeStyle = "rgba(255,255,255,0.6)";
        ctx.stroke();
      }
    }

    // 소실표적 — 모든 소실표적을 빨간 점으로 통일 (LoS 단면도와 동일 #ff1745).
    //   항적 위·실루엣 영역(지형/추가차단) 아래로 깔린다. 크기는 항적점(r=1.3)과 동일.
    //   (분류별 건수는 별도 요약표 컴포넌트에서 제공)
    ctx.fillStyle = "rgba(255,23,69,0.9)";
    for (const l of computed.losses) {
      if (l.elevAngleDeg < 0) continue;
      const x = xScale(l.azDeg);
      const y = yScale(l.elevAngleDeg);
      ctx.beginPath();
      ctx.arc(x, y, 1.3, 0, Math.PI * 2);
      ctx.fill();
    }

    // 방위별 실루엣 윗변 — 소실표적 위에 겹쳐 그림 (반투명 영역이 분포 위로 올라와 잘 보임).
    // without(녹색 base) / with(분석 대상 포함). 동일 rel 격자.
    if (withoutLine.length >= 2) {
      // 1) 베이스: 지형 + 기존 지형지물 (without 윗변 아래, 연두)
      ctx.beginPath();
      for (let i = 0; i < withoutLine.length; i++) {
        const x = xScaleRel(withoutLine[i].rel);
        const y = yScale(clamp0(withoutLine[i].elev));
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.lineTo(xScaleRel(withoutLine[withoutLine.length - 1].rel), yScale(0));
      ctx.lineTo(xScaleRel(withoutLine[0].rel), yScale(0));
      ctx.closePath();
      ctx.fillStyle = "rgba(134,239,172,0.55)";
      ctx.fill();

      // 2) 분석 대상 추가 차단 = with − without (빨강). 위(with) 따라가고 아래(without) 역순.
      ctx.beginPath();
      for (let i = 0; i < withLine.length; i++) {
        const x = xScaleRel(withLine[i].rel);
        const y = yScale(clamp0(withLine[i].elev));
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      for (let i = withoutLine.length - 1; i >= 0; i--) {
        ctx.lineTo(xScaleRel(withoutLine[i].rel), yScale(clamp0(withoutLine[i].elev)));
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(252,165,165,0.65)";
      ctx.fill();

      // 3) 외곽선 — without(짙은 녹색) / with(밝은 녹색, LoS 단면 지형선과 동일)
      const drawLine = (line: SilPoint[], color: string, width: number) => {
        ctx.beginPath();
        for (let i = 0; i < line.length; i++) {
          const x = xScaleRel(line[i].rel);
          const y = yScale(clamp0(line[i].elev));
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.stroke();
      };
      drawLine(withoutLine, "#166534", 0.8);
      drawLine(withLine, "#22c55e", 1);
    }

    // (분석 대상 방위 마커 제거 — 대상 차단각 높이는 연홍색 '추가 차단' 영역이 표현)

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
  }, [computed, sil, trackDots, xTicks, yTicks, yStep, azCenter, azHalfSpan, xScale, xScaleRel, yScale, yRange]);

  // 인라인 편집키 접두사 — (레이더 × 건물) 페이지마다 독립 편집 (detail.* 헤더 키와 동일 스킴)
  const eid = `azelev.${radarSite.name}_${building.id}`;

  return (
    <div className="mt-2">
      {/* 차트 제목 */}
      <div className="mb-1 flex items-center justify-between text-[12px]">
        <OMEditable id={`${eid}.title`} value="LoS 차단 양각 대비 표적소실 분포" tag="span" className="font-semibold text-gray-800" />
        <span className="text-[10px] text-gray-400">
          분석 대상 방위 {computed.bAzDeg.toFixed(0)}° · 건물 각폭 ±{azHalfSpan.toFixed(1)}°
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
        {trackDots.length > 0 && (
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: "rgba(34,197,94,0.7)" }} />
            <OMEditable id={`${eid}.legend.track`} value="항적" tag="span" />
          </span>
        )}
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "rgba(255,23,69,0.9)" }} />
          <OMEditable id={`${eid}.legend.loss`} value="소실표적" tag="span" />
        </span>
      </div>
    </div>
  );
}
