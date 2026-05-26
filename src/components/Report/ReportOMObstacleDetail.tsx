import React, { useMemo } from "react";
import type { ManualBuilding, RadarSite, LoSProfileData } from "../../types";
import type { LossPointGeo, TrackPointGeo, ObstacleMonthlyResult } from "../../types/obstacle";
import type { CoverageLayer } from "../../utils/radarCoverage";
import { haversineKm } from "../../utils/geo";
import ReportPage from "./ReportPage";
import ReportOMSectionHeader from "./ReportOMSectionHeader";
import ReportOMCoverageDiff from "./ReportOMCoverageDiff";
import { LosCrossSection, projectPointsToLos } from "./ReportOMLosCrossSection";
import type { OMSectionCaptureHandle } from "./omCapture";

interface Props {
  sectionNum: number;
  radarSite: RadarSite;
  building: ManualBuilding;
  /** 베이스라인(전체 빌딩 포함) 커버리지 — diff 의 "with" */
  layersWith: CoverageLayer[];
  /** 빌딩 단독 제외 카운터팩추얼 — diff 의 "without" */
  layersWithoutThis: CoverageLayer[];
  /** 이 빌딩 LoS 단면 */
  los: LoSProfileData;
  /** 페이지 캡처 동기화 ref (커버리지 다이프 SVG 캡처용) */
  captureRef?: React.Ref<OMSectionCaptureHandle>;
  /** 사전 캡처된 다이프 PNG (있으면 라이브 SVG 대신 표시) */
  preCapturedImage?: string;
  /** OM 분석 결과 — 빌딩 베어링 ±5° 안의 항적/소실표적 투영용 */
  omResult: ObstacleMonthlyResult | null;
}

/** 한 페이지 = (레이더, 분석 대상 장애물) 한 쌍. 상단: 빌딩 단독 영향 커버리지 다이프. 하단: 빌딩 LoS 단면도. */
function ReportOMObstacleDetail({
  sectionNum, radarSite, building, layersWith, layersWithoutThis, los,
  captureRef, preCapturedImage, omResult,
}: Props) {
  // 빌딩 위치 메타
  const bDistKm = useMemo(
    () => haversineKm(radarSite.latitude, radarSite.longitude, building.latitude, building.longitude),
    [radarSite.latitude, radarSite.longitude, building.latitude, building.longitude],
  );
  const bTopElevM = building.ground_elev + building.height;
  const bTopFt = Math.round(bTopElevM * 3.28084);

  // 이 레이더 omResult 에서 항적·소실표적 수집 → LoS 베어링 ±5° 로 투영
  const losChartPts = useMemo(() => {
    if (!omResult) return { track: [], loss: [] };
    const rr = omResult.radar_results.find((r) => r.radar_name === radarSite.name);
    if (!rr) return { track: [], loss: [] };
    const allLoss: LossPointGeo[] = [];
    const allTrack: TrackPointGeo[] = [];
    for (const ds of rr.daily_stats) {
      for (const lp of ds.loss_points_summary) allLoss.push(lp);
      if (ds.track_points_geo) for (const tp of ds.track_points_geo) allTrack.push(tp);
    }
    return projectPointsToLos(los, allTrack, allLoss);
  }, [omResult, radarSite.name, los]);

  // 다이프에 사용할 소실표적: 레이더 전체 소실표적을 그대로 넘김.
  // ReportOMCoverageDiff 내부의 filteredLoss 가 (rWithout > rWith) 영역에 떨어지는 점만 자동 선별 →
  // 결과적으로 "이 빌딩의 단독 영향 안에 떨어진 소실표적"만 표시됨.
  const allLossForRadar: LossPointGeo[] = useMemo(() => {
    if (!omResult) return [];
    const rr = omResult.radar_results.find((r) => r.radar_name === radarSite.name);
    if (!rr) return [];
    const out: LossPointGeo[] = [];
    for (const ds of rr.daily_stats) for (const lp of ds.loss_points_summary) out.push(lp);
    return out;
  }, [omResult, radarSite.name]);

  // 카운터팩추얼 데이터가 없거나 다이프 = 0 이면 "영향 없음" 안내.
  // (전수 베어링 max diff 로 미리 한 번 체크 — buildDiffPath 와 동일 기준)
  const impactSummary = useMemo(() => {
    if (layersWith.length === 0 || layersWithoutThis.length === 0) {
      return { hasData: false, maxDiffKm: 0 };
    }
    let maxDiffKm = 0;
    for (let i = 0; i < layersWith.length; i++) {
      const lw = layersWith[i];
      const lwo = layersWithoutThis.find((l) => Math.abs(l.altitudeFt - lw.altitudeFt) < 200);
      if (!lwo) continue;
      const wByDeg = new Map<number, number>();
      for (const wb of lw.bearings) wByDeg.set(Math.round(wb.deg * 100), wb.maxRangeKm);
      for (const b of lwo.bearings) {
        const rW = wByDeg.get(Math.round(b.deg * 100)) ?? b.maxRangeKm;
        const d = b.maxRangeKm - rW;
        if (d > maxDiffKm) maxDiffKm = d;
      }
    }
    return { hasData: true, maxDiffKm };
  }, [layersWith, layersWithoutThis]);

  return (
    <ReportPage>
      <ReportOMSectionHeader
        sectionNum={sectionNum}
        title={`분석 대상 장애물 상세 — ${building.name || `건물 ${building.id}`}`}
        radarName={radarSite.name}
      />

      {/* 빌딩 메타 정보 */}
      <div className="mb-2 flex items-center justify-between rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-[10px] text-gray-600">
        <span>
          위치: {building.latitude.toFixed(5)}°, {building.longitude.toFixed(5)}° ·
          높이: {bTopFt.toLocaleString()}ft ({bTopElevM.toFixed(0)}m) ·
          레이더 거리: {(bDistKm / 1.852).toFixed(1)}NM ({bDistKm.toFixed(1)}km) · 방위: {los.bearing.toFixed(1)}°
        </span>
        <span className={`rounded px-1.5 py-0.5 font-medium ${
          impactSummary.hasData && impactSummary.maxDiffKm > 0
            ? "bg-amber-50 text-amber-700"
            : "bg-emerald-50 text-emerald-700"
        }`}>
          {impactSummary.hasData
            ? impactSummary.maxDiffKm > 0
              ? `단독 영향 max ${impactSummary.maxDiffKm.toFixed(2)}km`
              : "단독 영향 없음"
            : "데이터 없음"}
        </span>
      </div>

      {/* 상단: 빌딩 단독 커버리지 다이프 */}
      <div className="mb-3" style={{ maxHeight: "55%" }}>
        {impactSummary.hasData && impactSummary.maxDiffKm > 0 ? (
          <ReportOMCoverageDiff
            ref={captureRef}
            sectionNum={sectionNum}
            radarSite={radarSite}
            layersWithTargets={layersWith}
            layersWithoutTargets={layersWithoutThis}
            lossPoints={allLossForRadar}
            defaultAltFt={5000}
            selectedBuildings={[building]}
            hideHeader
            preCapturedImage={preCapturedImage}
            focusOnDiffOnly
          />
        ) : (
          <div className="flex flex-col items-center justify-center rounded-md border border-emerald-200 bg-emerald-50 py-10 text-center">
            <div className="text-[20px] font-bold text-emerald-700">영향 없음</div>
            <div className="mt-1 text-[11px] text-emerald-600">
              {impactSummary.hasData
                ? "이 장애물 단독으로는 커버리지 차이가 발생하지 않습니다."
                : "카운터팩추얼 커버리지 데이터가 없습니다."}
            </div>
          </div>
        )}
      </div>

      {/* 하단: LoS 단면도 */}
      <div>
        <LosCrossSection
          los={los}
          radarName={radarSite.name}
          building={building}
          trackPoints={losChartPts.track}
          lossPoints={losChartPts.loss}
        />
      </div>
    </ReportPage>
  );
}

export default React.memo(ReportOMObstacleDetail);
