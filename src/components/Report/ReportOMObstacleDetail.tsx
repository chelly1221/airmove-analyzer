import React, { useMemo } from "react";
import type { ManualBuilding, BuildingGroup, RadarSite, LoSProfileData, PanoramaMergeResult } from "../../types";
import type { LossPointGeo, TrackPointGeo, ObstacleMonthlyResult } from "../../types/obstacle";
import { haversineKm } from "../../utils/geo";
import ReportPage from "./ReportPage";
import ReportOMSectionHeader from "./ReportOMSectionHeader";
import { LosCrossSection, projectPointsToLos } from "./ReportOMLosCrossSection";
import BuildingGroupBadge from "./BuildingGroupBadge";
import ReportOMObstacleAzElevChart from "./ReportOMObstacleAzElevChart";

interface Props {
  sectionNum: number;
  radarSite: RadarSite;
  building: ManualBuilding;
  /** 건물 그룹 메타 (인라인 배지 표시용) */
  buildingGroups: BuildingGroup[];
  /** 이 빌딩 LoS 단면 */
  los: LoSProfileData;
  /** OM 분석 결과 — 건물 노출면 방위각 윈도우 안의 항적/소실표적 투영용 */
  omResult: ObstacleMonthlyResult | null;
  /** 이 레이더의 분석 대상 포함 파노라마 (Az×Elev 차트용) */
  panoWith?: PanoramaMergeResult;
  /** 이 레이더의 분석 대상 제외 파노라마 (Az×Elev 차트용) */
  panoWithout?: PanoramaMergeResult;
}

/** 한 페이지 = (레이더, 분석 대상 장애물) 한 쌍. 빌딩 메타 + LoS 단면도 + Az×Elev 차트. */
function ReportOMObstacleDetail({
  sectionNum, radarSite, building, buildingGroups, los, omResult, panoWith, panoWithout,
}: Props) {
  // 빌딩 위치 메타
  const bDistKm = useMemo(
    () => haversineKm(radarSite.latitude, radarSite.longitude, building.latitude, building.longitude),
    [radarSite.latitude, radarSite.longitude, building.latitude, building.longitude],
  );
  const bTopElevM = building.ground_elev + building.height;
  const bTopFt = Math.round(bTopElevM * 3.28084);

  // 이 레이더 omResult 에서 항적·소실표적 수집
  const { losChartPts, allLossThisRadar } = useMemo(() => {
    if (!omResult) return { losChartPts: { track: [], loss: [] }, allLossThisRadar: [] as LossPointGeo[] };
    const rr = omResult.radar_results.find((r) => r.radar_name === radarSite.name);
    if (!rr) return { losChartPts: { track: [], loss: [] }, allLossThisRadar: [] as LossPointGeo[] };
    const allLoss: LossPointGeo[] = [];
    const allTrack: TrackPointGeo[] = [];
    for (const ds of rr.daily_stats) {
      for (const lp of ds.loss_points_summary) allLoss.push(lp);
      if (ds.track_points_geo) for (const tp of ds.track_points_geo) allTrack.push(tp);
    }
    return {
      losChartPts: projectPointsToLos(los, allTrack, allLoss, building),
      allLossThisRadar: allLoss,
    };
  }, [omResult, radarSite.name, los, building]);

  return (
    <ReportPage>
      <ReportOMSectionHeader
        sectionNum={sectionNum}
        title={`분석 대상 장애물 상세 — ${building.name || `건물 ${building.id}`}`}
        radarName={radarSite.name}
        editId={`detail.${radarSite.name}_${building.id}.title`}
      />

      {/* 빌딩 메타 정보 */}
      <div className="mb-2 flex items-center justify-between rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-[10px] text-gray-600">
        <span className="flex items-center gap-2">
          <BuildingGroupBadge groupId={building.group_id} groups={buildingGroups} />
          <span>
            위치: {building.latitude.toFixed(5)}°, {building.longitude.toFixed(5)}° ·
            높이: {bTopFt.toLocaleString()}ft ({bTopElevM.toFixed(0)}m) ·
            레이더 거리: {(bDistKm / 1.852).toFixed(1)}NM ({bDistKm.toFixed(1)}km) · 방위: {los.bearing.toFixed(1)}°
          </span>
        </span>
      </div>

      {/* LoS 단면도 */}
      <div>
        <LosCrossSection
          los={los}
          radarName={radarSite.name}
          building={building}
          buildingGroup={buildingGroups.find((g) => g.id === building.group_id) ?? null}
          trackPoints={losChartPts.track}
          lossPoints={losChartPts.loss}
        />
      </div>

      {/* LoS 차단 양각 대비 표적소실 분포 — 분석 대상 방위 윈도우만 */}
      <ReportOMObstacleAzElevChart
        radarSite={radarSite}
        building={building}
        buildingGroups={buildingGroups}
        los={los}
        panoWith={panoWith}
        panoWithout={panoWithout}
        lossPoints={allLossThisRadar}
      />
    </ReportPage>
  );
}

export default React.memo(ReportOMObstacleDetail);
