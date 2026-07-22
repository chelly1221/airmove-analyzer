import React, { useMemo } from "react";
import type { ManualBuilding, BuildingGroup, RadarSite, LoSProfileData, PanoramaMergeResult } from "../../types";
import type { LossPointGeo, TrackPointGeo, ObstacleMonthlyResult, AddedBlockageResult } from "../../types/obstacle";
import ReportPage from "./ReportPage";
import ReportOMSectionHeader from "./ReportOMSectionHeader";
import { LosCrossSection, projectPointsToLos } from "./ReportOMLosCrossSection";
import { buildSiblings, classifyObstacleLosses } from "../../utils/obstacleAnalysisHelpers";
import BuildingGroupBadge from "./BuildingGroupBadge";
import ReportOMObstacleAzElevChart from "./ReportOMObstacleAzElevChart";
import ReportOMObstacleSummaryTable from "./ReportOMObstacleSummaryTable";
import ReportOMRadarBuildingMap from "./ReportOMRadarBuildingMap";

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
  /** 선택된 전체 분석 대상 건물 — 소실표적 오귀속 방지(가장 강하게 소유한 건물에 귀속)용 sibling 계산 */
  allBuildings: ManualBuilding[];
  /** 건물별 × 레이더별 LoS 결과 (key: `${radarName}_${buildingId}`) — sibling 에서 LoS 결과 없는(=classify 미실행)
   *  건물을 제외하기 위한 조회용(§2·§4 와 동일 규칙). 미제공 시 전체 건물을 sibling 으로 사용(구 호출부 호환). */
  losMap?: Map<string, LoSProfileData>;
  /** 추가 차단영역 소실율 — 헤드라인 심각도 지표 (ReportApp 에서 산출, 이 건물 키) */
  blockage?: AddedBlockageResult;
}

/** 한 페이지 = (레이더, 분석 대상 장애물) 한 쌍. ①영향범위 도면 + ②분류 요약표 + ③LoS 단면도 + ④Az×Elev 차트. */
function ReportOMObstacleDetail({
  sectionNum, radarSite, building, buildingGroups, los, omResult, panoWith, panoWithout, allBuildings, losMap, blockage,
}: Props) {
  // 같은 레이더의 '다른' 분석 대상 건물 — buildSiblings(§2 요약·§4 소실상세와 동일 산식: 방위/거리/허용각 +
  //   losMap 제공 시 LoS 결과 없는 건물 제외). 더 강하게 소유하는(claim 가능한) 건물 있으면 본 건물 집계서 제외.
  const siblings = useMemo(
    () => buildSiblings(radarSite, allBuildings, building.id, losMap),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- radarSite 는 좌표·이름 granular 의존(객체 in-place 변경 대응) — §2·§4 sibling 계산과 동일 민감도.
    [allBuildings, building.id, radarSite.latitude, radarSite.longitude, radarSite.name, losMap],
  );
  // 이 레이더 omResult 에서 항적·소실표적 수집
  const { losChartPts, allLossThisRadar, allTrackThisRadar } = useMemo(() => {
    const empty = { losChartPts: { track: [], loss: [] }, allLossThisRadar: [] as LossPointGeo[], allTrackThisRadar: [] as TrackPointGeo[] };
    if (!omResult) return empty;
    const rr = omResult.radar_results.find((r) => r.radar_name === radarSite.name);
    if (!rr) return empty;
    const allLoss: LossPointGeo[] = [];
    const allTrack: TrackPointGeo[] = [];
    for (const ds of rr.daily_stats) {
      for (const lp of ds.loss_points_summary) allLoss.push(lp);
      if (ds.track_points_geo) for (const tp of ds.track_points_geo) allTrack.push(tp);
    }
    return {
      losChartPts: projectPointsToLos(los, allTrack, allLoss, building),
      allLossThisRadar: allLoss,
      allTrackThisRadar: allTrack,
    };
  }, [omResult, radarSite.name, los, building]);

  // ② 요약표·메타 스트립 공용 분류 결과 — 차트(AzElev)와 동일 인자·동일 분류 (표 내부 호출을 리프트)
  const computed = useMemo(
    () => classifyObstacleLosses(radarSite, building, allLossThisRadar, { panoWith, panoWithout, siblings }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- radarSite 는 좌표 granular 의존(객체 in-place 변경 대응) — sibling 계산과 동일 민감도.
    [allLossThisRadar, building, panoWith, panoWithout, siblings, radarSite.latitude, radarSite.longitude],
  );

  return (
    <ReportPage>
      <ReportOMSectionHeader
        sectionNum={sectionNum}
        title="분석 대상 장애물 상세"
        titleSuffix={
          <span>{"— "}<BuildingGroupBadge groupId={building.group_id} groups={buildingGroups} placement="before" />{building.name || `건물 ${building.id}`}</span>
        }
        radarName={radarSite.name}
        editId={`detail.${radarSite.name}_${building.id}.title`}
      />

      {/* ① 영향 범위 — 위에서 본 도면 (레이더 → 건물 양끝 부채꼴). §4 최상단 배치 */}
      <ReportOMRadarBuildingMap
        radarSite={radarSite}
        building={building}
        buildingGroups={buildingGroups}
        los={los}
      />

      {/* ② 소실표적 분류 요약표 — 아래 Az×Elev 차트와 동일 분류 결과(동일 classifyObstacleLosses, computed 리프트) */}
      <ReportOMObstacleSummaryTable
        radarSite={radarSite}
        building={building}
        computed={computed}
        blockage={blockage}
      />

      {/* ③ LoS 단면도 */}
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

      {/* ④ LoS 차단 양각 대비 표적소실 분포 — 분석 대상 방위 윈도우만 (요약표는 ②로 분리) */}
      <ReportOMObstacleAzElevChart
        radarSite={radarSite}
        building={building}
        buildingGroups={buildingGroups}
        panoWith={panoWith}
        panoWithout={panoWithout}
        lossPoints={allLossThisRadar}
        trackPoints={allTrackThisRadar}
        siblings={siblings}
      />
    </ReportPage>
  );
}

export default React.memo(ReportOMObstacleDetail);
