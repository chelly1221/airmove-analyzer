/**
 * 보고서 프리뷰 콘텐츠 — ReportGeneration과 ReportApp 양쪽에서 공유.
 * 툴바는 포함하지 않음. 호출 측에서 previewRef와 상태를 관리.
 */
import { useMemo } from "react";
import { Loader2 } from "lucide-react";
import ReportPage, { ReportPageHeaderProvider } from "./ReportPage";
import ReportCoverPage from "./ReportCoverPage";
import ReportSummarySection from "./ReportSummarySection";
import ReportMapSection from "./ReportMapSection";
import ReportStatsSection from "./ReportStatsSection";
import ReportLossSection from "./ReportLossSection";
import ReportLoSSection from "./ReportLoSSection";
import ReportAircraftSection from "./ReportAircraftSection";
import ReportFlightComparisonSection from "./ReportFlightComparisonSection";
import ReportFlightProfileSection from "./ReportFlightProfileSection";
import ReportFlightLossAnalysisSection from "./ReportFlightLossAnalysisSection";
import ReportPanoramaSection from "./ReportPanoramaSection";
import ReportOMSummarySection from "./ReportOMSummarySection";
import ReportOMCombinedDailyChart from "./ReportOMCombinedDailyChart";
import ReportOMWeeklyChart from "./ReportOMWeeklyChart";
import ReportOMCoverageDiff from "./ReportOMCoverageDiff";
import ReportOMBuildingLoS from "./ReportOMBuildingLoS";
import ReportOMObstacleDetail from "./ReportOMObstacleDetail";
import ReportOMFindings from "./ReportOMFindings";
import ReportOMLossEvents from "./ReportOMLossEvents";
import type { OMSectionCaptureHandle } from "./omCapture";
import ReportPSSummarySection from "./ReportPSSummarySection";
import ReportPSAngleHeight from "./ReportPSAngleHeight";
import ReportPSAdditionalLoss from "./ReportPSAdditionalLoss";
import type {
  Flight, LoSProfileData, Aircraft as AircraftType, ReportMetadata,
  PanoramaPoint, ManualBuilding, RadarSite, ObstacleMonthlyResult,
  PreScreeningResult, OMReportData, TrackPoint,
} from "../../types";
import type { CoverageLayer } from "../../utils/radarCoverage";
import type { ReportTemplate, ReportSections } from "../../utils/reportTransfer";

// ── Props ──

export interface ReportPreviewContentProps {
  template: ReportTemplate;
  sections: ReportSections;

  // 데이터
  flights: Flight[];
  reportFlights: Flight[];
  losResults: LoSProfileData[];
  aircraft: AircraftType[];
  radarSite: RadarSite;
  reportMetadata: ReportMetadata;
  panoramaData: PanoramaPoint[];
  panoramaPeakNames: Map<number, string>;
  coverageLayers: CoverageLayer[];
  mapImage: string | null;

  // 장애물 월간
  omData: OMReportData;
  omResultTrimmed: ObstacleMonthlyResult | null;

  // 사전검토
  psResult: PreScreeningResult | null;
  psSelectedBuildings: ManualBuilding[];
  psSelectedRadarSites: RadarSite[];
  psLosMap: Map<string, LoSProfileData>;
  psCovLayersWith: Map<string, CoverageLayer[]>;
  psCovLayersWithout: Map<string, CoverageLayer[]>;
  psAnalysisMonth: string;

  // 편집 가능 텍스트
  coverTitle: string;
  onCoverTitleChange: (v: string) => void;
  coverSubtitle: string;
  onCoverSubtitleChange: (v: string) => void;
  commentary: string;
  onCommentaryChange: (v: string) => void;

  // 상태
  forceAllVisible: boolean;

  // OM 콜백
  onOmDataChange: (updater: (prev: OMReportData) => OMReportData) => void;

  // 단일비행 차트 포인트 (보고서 윈도우용)
  singleFlightChartPoints?: TrackPoint[];

  // ref
  previewRef: React.RefObject<HTMLDivElement | null>;
  /** OM 캡처 가능 섹션의 ref 등록 콜백. 마운트 시 handle 전달, unmount 시 null. */
  setCaptureRef?: (key: string, handle: OMSectionCaptureHandle | null) => void;
}

// ── 섹션 토글 정의 ──

export function getSectionToggles(template: ReportTemplate, _sections: ReportSections): { key: keyof ReportSections; label: string }[] {
  if (template === "flights") {
    return [
      { key: "cover", label: "표지" },
      { key: "flightComparison", label: "비교" },
      { key: "trackMap", label: "지도" },
      { key: "lossDetail", label: "소실" },
      { key: "los", label: "LoS" },
      { key: "panorama", label: "장애물" },
    ];
  }
  if (template === "obstacle") {
    return [
      { key: "cover", label: "표지" },
      { key: "obstacleSummary", label: "요약" },
      { key: "psAngleHeight", label: "앙각/높이" },
      { key: "psAdditionalLoss", label: "추가Loss" },
      { key: "coverageMap", label: "커버리지" },
      { key: "los", label: "LoS" },
    ];
  }
  if (template === "obstacle_monthly") {
    return [
      { key: "cover", label: "표지" },
      { key: "omSummary", label: "요약" },
      { key: "omDailyPsrLoss", label: "일별 PSR·표적소실" },
      { key: "omWeekly", label: "주차" },
      { key: "omBuildingLos", label: "LoS" },
      { key: "omLosCrossSection", label: "장애물별 상세" },
      { key: "omLossEvents", label: "표적소실상세" },
      { key: "omFindings", label: "소견" },
    ];
  }
  if (template === "single") {
    return [
      { key: "cover", label: "표지" },
      { key: "flightProfile", label: "프로파일" },
      { key: "trackMap", label: "지도" },
      { key: "flightLossAnalysis", label: "소실분석" },
      { key: "los", label: "LoS" },
      { key: "panorama", label: "장애물" },
    ];
  }
  return [
    { key: "cover", label: "표지" },
    { key: "summary", label: "요약" },
    { key: "trackMap", label: "지도" },
    { key: "stats", label: "통계" },
    { key: "los", label: "LoS" },
    { key: "panorama", label: "장애물" },
    { key: "aircraft", label: "검사기" },
  ];
}

// ── 컴포넌트 ──

export default function ReportPreviewContent(props: ReportPreviewContentProps) {
  const {
    template, sections,
    flights, reportFlights, losResults, aircraft, radarSite, reportMetadata,
    panoramaData, panoramaPeakNames, mapImage,
    omData, omResultTrimmed,
    psResult, psSelectedBuildings, psSelectedRadarSites, psLosMap, psCovLayersWith, psCovLayersWithout, psAnalysisMonth,
    coverTitle, onCoverTitleChange, coverSubtitle, onCoverSubtitleChange,
    commentary, onCommentaryChange,
    forceAllVisible: _forceAllVisible,
    onOmDataChange,
    singleFlightChartPoints,
    previewRef,
  } = props;

  const singleFlight = template === "single" ? reportFlights[0] : null;

  // 페이지 상단 머리띠 — 발행기관(metadata.organization) + 템플릿별 보고서 제목
  const pageHeaderText = useMemo(() => {
    const titles: Record<string, string> = {
      obstacle_monthly: "레이더 장애물 월간 분석 보고서",
      monthly: "월간 분석 보고서",
      weekly: "주간 분석 보고서",
      flights: "비행 분석 보고서",
      single: "단일 비행 분석 보고서",
      obstacle: "장애물 사전검토 보고서",
    };
    const title = titles[template] ?? "분석 보고서";
    return `${reportMetadata.organization}  |  ${title}`;
  }, [template, reportMetadata.organization]);

  // 활성 섹션 번호 계산
  const sectionNumbers = useMemo(() => {
    const nums: Record<string, number> = {};
    let n = 1;
    if (template === "flights") {
      if (sections.flightComparison) nums.flightComparison = n++;
      if (sections.trackMap) nums.trackMap = n++;
      if (sections.lossDetail) nums.lossDetail = n++;
      if (sections.los && losResults.length > 0) nums.los = n++;
      if (sections.panorama && panoramaData.length > 0) nums.panorama = n++;
    } else if (template === "obstacle") {
      if (sections.obstacleSummary) nums.obstacleSummary = n++;
      if (sections.psAngleHeight && psResult) nums.psAngleHeight = n++;
      if (sections.psAdditionalLoss && psResult) nums.psAdditionalLoss = n++;
      if (sections.coverageMap && (psCovLayersWith.size > 0 || psCovLayersWithout.size > 0)) nums.coverageMap = n++;
      if (sections.los && psLosMap.size > 0) nums.los = n++;
    } else if (template === "obstacle_monthly") {
      if (sections.omSummary) nums.omSummary = n++;
      if (sections.omDailyPsrLoss) nums.omDailyPsrLoss = n++;
      if (sections.omWeekly) nums.omWeekly = n++;
      if (sections.omBuildingLos) nums.omBuildingLos = n++;
      if (sections.omLosCrossSection && omData?.losMap && omData.losMap.size > 0) nums.omLosCrossSection = n++;
      if (sections.omLossEvents) nums.omLossEvents = n++;
      if (sections.omFindings) nums.omFindings = n++;
    } else if (template === "single") {
      if (sections.flightProfile) nums.flightProfile = n++;
      if (sections.trackMap) nums.trackMap = n++;
      if (sections.flightLossAnalysis) nums.flightLossAnalysis = n++;
      if (sections.los && losResults.length > 0) nums.los = n++;
      if (sections.panorama && panoramaData.length > 0) nums.panorama = n++;
    } else {
      if (sections.summary) nums.summary = n++;
      if (sections.trackMap) nums.trackMap = n++;
      if (sections.stats && flights.length > 0) nums.stats = n++;
      if (sections.los && losResults.length > 0) nums.los = n++;
      if (sections.panorama && panoramaData.length > 0) nums.panorama = n++;
      if (sections.aircraft && aircraft.length > 0) nums.aircraft = n++;
    }
    return nums;
  }, [template, sections, losResults, flights, aircraft, panoramaData, psResult, psCovLayersWith, psCovLayersWithout, psLosMap, omData?.losMap]);

  // OM 레이더별 조건 텍스트
  const omRadarConditions = useMemo(() => {
    if (!omResultTrimmed) return new Map<string, { azText: string; bldgNames: string; minDistNm: string }>();
    const map = new Map<string, { azText: string; bldgNames: string; minDistNm: string }>();
    for (const rr of omResultTrimmed.radar_results) {
      const sectors = omData.azSectorsByRadar.get(rr.radar_name) ?? [];
      const azText = sectors.map((s) => `${s.start_deg.toFixed(1)}°~${s.end_deg.toFixed(1)}°`).join(", ");
      const bldgNames = omData.selectedBuildings.map((b) => b.name || `건물${b.id}`).join(", ");
      const rs = omData.selectedRadarSites.find((r) => r.name === rr.radar_name);
      let minDistKm = Infinity;
      if (rs) {
        const toRad = Math.PI / 180;
        for (const b of omData.selectedBuildings) {
          const dLat = (b.latitude - rs.latitude) * toRad;
          const dLon = (b.longitude - rs.longitude) * toRad;
          const a = Math.sin(dLat / 2) ** 2 + Math.cos(rs.latitude * toRad) * Math.cos(b.latitude * toRad) * Math.sin(dLon / 2) ** 2;
          const d = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          if (d < minDistKm) minDistKm = d;
        }
      }
      if (!isFinite(minDistKm)) minDistKm = 0;
      map.set(rr.radar_name, { azText, bldgNames, minDistNm: (minDistKm / 1.852).toFixed(1) });
    }
    return map;
  }, [omResultTrimmed, omData.azSectorsByRadar, omData.selectedRadarSites, omData.selectedBuildings]);

  return (
    <div ref={previewRef} className="relative flex-1 overflow-auto bg-gray-300 py-6">
      <ReportPageHeaderProvider value={pageHeaderText}>
      <div className="kac-report">
      {/* 표지 (공통) */}
      {sections.cover && (
        <div data-toc-key="cover">
          <ReportCoverPage
            template={template}
            radarName={radarSite?.name ?? ""}
            metadata={reportMetadata}
            editable
            title={coverTitle}
            onTitleChange={onCoverTitleChange}
            subtitle={coverSubtitle}
            onSubtitleChange={onCoverSubtitleChange}
            omMonthLabel={template === "obstacle_monthly" && omData.analysisMonth
              ? `${omData.analysisMonth.slice(0, 4)}년 ${parseInt(omData.analysisMonth.slice(5, 7))}월`
              : undefined}
            omRadarNames={template === "obstacle_monthly"
              ? omData.selectedRadarSites.map((r) => r.name)
              : undefined}
            omBuildingsCount={template === "obstacle_monthly"
              ? omData.selectedBuildings.length
              : undefined}
          />
        </div>
      )}

      {/* ─── 주간/월간 ─── */}
      {(template === "weekly" || template === "monthly") && (
        <>
          {(sections.summary || sections.trackMap) && (
            <ReportPage>
              {sections.summary && (
                <ReportSummarySection
                  sectionNum={sectionNumbers.summary ?? 1}
                  flights={flights}
                  losResults={losResults}
                  aircraftCount={aircraft.filter((a) => a.active).length}
                  editable
                  commentary={commentary}
                  onCommentaryChange={onCommentaryChange}
                />
              )}
              {sections.trackMap && (
                <ReportMapSection
                  sectionNum={sectionNumbers.trackMap ?? 2}
                  mapImage={mapImage}
                />
              )}
            </ReportPage>
          )}

          {sections.stats && flights.length > 0 && (
            <ReportPage>
              <ReportStatsSection
                sectionNum={sectionNumbers.stats ?? 3}
                flights={flights}
                template={template}
              />
            </ReportPage>
          )}

          {sections.los && losResults.length > 0 && (
            <ReportLoSSection
              sectionNum={sectionNumbers.los ?? 5}
              losResults={losResults}
            />
          )}

          {sections.panorama && panoramaData.length > 0 && radarSite && (
            <ReportPanoramaSection
              sectionNum={sectionNumbers.panorama ?? 6}
              panoramaData={panoramaData}
              radarSite={radarSite}
              peakNames={panoramaPeakNames}
            />
          )}

          {sections.aircraft && aircraft.length > 0 && (
            <ReportPage>
              <ReportAircraftSection
                sectionNum={sectionNumbers.aircraft ?? 6}
                aircraft={aircraft}
              />
              <div className="absolute bottom-[20mm] left-[20mm] right-[20mm]">
                <div className="border-t-[2px] border-gray-300" />
                <p className="mt-2 text-center text-[9px] text-gray-400">
                  {reportMetadata.footer}
                </p>
              </div>
            </ReportPage>
          )}
        </>
      )}

      {/* ─── 장애물 전파영향 사전검토 ─── */}
      {template === "obstacle" && psResult && (
        <>
          {sections.obstacleSummary && (
            <ReportPage>
              <ReportPSSummarySection
                sectionNum={sectionNumbers.obstacleSummary ?? 1}
                result={psResult}
                buildings={psSelectedBuildings}
                radars={psSelectedRadarSites}
                analysisMonth={psAnalysisMonth}
              />
            </ReportPage>
          )}

          {sections.psAngleHeight && (
            <ReportPage>
              <ReportPSAngleHeight
                sectionNum={sectionNumbers.psAngleHeight ?? 2}
                result={psResult}
              />
            </ReportPage>
          )}

          {sections.psAdditionalLoss && (
            <ReportPage>
              <ReportPSAdditionalLoss
                sectionNum={sectionNumbers.psAdditionalLoss ?? 3}
                result={psResult}
              />
            </ReportPage>
          )}

          {sections.coverageMap && (psCovLayersWith.size > 0 || psCovLayersWithout.size > 0) && psSelectedRadarSites.map((rs) => {
            const rsLayers = psCovLayersWith.get(rs.name) ?? [];
            const rsLayersWithout = psCovLayersWithout.get(rs.name) ?? [];
            if (rsLayers.length === 0 && rsLayersWithout.length === 0) return null;
            return (
              <ReportPage key={`ps-cov-${rs.name}`}>
                <ReportOMCoverageDiff
                  sectionNum={sectionNumbers.coverageMap ?? 4}
                  layersWithTargets={rsLayers}
                  layersWithoutTargets={rsLayersWithout}
                  radarSite={rs}
                  lossPoints={[]}
                  defaultAltFt={5000}
                  selectedBuildings={psSelectedBuildings}
                  buildingGroups={omData.buildingGroups}
                />
              </ReportPage>
            );
          })}

          {sections.los && psLosMap.size > 0 && (
            <ReportLoSSection
              sectionNum={sectionNumbers.los ?? 5}
              losResults={[...psLosMap.values()]}
            />
          )}
        </>
      )}

      {/* ─── 장애물 월간 ─── */}
      {template === "obstacle_monthly" && omResultTrimmed && (
        <>
          {sections.omSummary && (
            <div data-toc-key="omSummary">
              <ReportOMSummarySection
                sectionNum={sectionNumbers.omSummary ?? 1}
                radarResults={omResultTrimmed.radar_results}
                selectedBuildings={omData.selectedBuildings}
                buildingGroups={omData.buildingGroups}
                radarSites={omData.selectedRadarSites}
                azimuthSectorsByRadar={omData.azSectorsByRadar}
              />
            </div>
          )}

          {sections.omDailyPsrLoss && (
            <div data-toc-key="omDailyPsrLoss">
              {omResultTrimmed.radar_results.map((rr) => {
                const info = omRadarConditions.get(rr.radar_name);
                return (
                  <ReportOMCombinedDailyChart
                    key={`psrloss-${rr.radar_name}`}
                    sectionNum={sectionNumbers.omDailyPsrLoss ?? 2}
                    radarName={rr.radar_name}
                    dailyStats={rr.daily_stats}
                    analysisMonth={omData.analysisMonth}
                    conditions={[
                      `• 대상 장애물: ${info?.bldgNames ?? ""}`,
                      `• 영향 방위: ${info?.azText || "전체"} · 장애물 후방(${info?.minDistNm ?? "0"}NM~) 항적만 포함`,
                      `• PSR: 60NM 이내 SSR+Combined 기준, 표적소실: 신호소실만 (범위이탈 제외)`,
                    ]}
                  />
                );
              })}
            </div>
          )}

          {sections.omWeekly && (
            <div data-toc-key="omWeekly">
              {omResultTrimmed.radar_results.map((rr) => {
                const imgKey = `wk-${rr.radar_name}`;
                return (
                  <ReportPage key={imgKey}>
                    <ReportOMWeeklyChart
                      sectionNum={sectionNumbers.omWeekly ?? 4}
                      radarName={rr.radar_name}
                      dailyStats={rr.daily_stats}
                    />
                  </ReportPage>
                );
              })}
            </div>
          )}

          {sections.omBuildingLos && (
            <div data-toc-key="omBuildingLos">
              <ReportOMBuildingLoS
                sectionNum={sectionNumbers.omBuildingLos ?? 7}
                selectedBuildings={omData.selectedBuildings}
                buildingGroups={omData.buildingGroups}
                radarSites={omData.selectedRadarSites}
                losMap={omData.losMap}
              />
            </div>
          )}

          {/* 장애물별 상세 — (레이더 × 분석 대상 빌딩) 한 쌍당 한 페이지.
              빌딩 메타 + LoS 단면도 + LoS 차단 양각 대비 표적소실 분포 (분석 대상 방위 윈도우). */}
          {sections.omLosCrossSection && omData.losMap.size > 0 && (
            <div data-toc-key="omLosCrossSection">
              {omData.selectedRadarSites.map((rs) => {
                return omData.selectedBuildings.map((b) => {
                  const los = omData.losMap.get(`${rs.name}_${b.id}`);
                  if (!los) return null;
                  return (
                    <ReportOMObstacleDetail
                      key={`obs-${rs.name}-${b.id}`}
                      sectionNum={sectionNumbers.omLosCrossSection ?? 8}
                      radarSite={rs}
                      building={b}
                      buildingGroups={omData.buildingGroups}
                      los={los}
                      omResult={omResultTrimmed}
                      panoWith={omData.panoWithTargets?.get(rs.name)}
                      panoWithout={omData.panoWithoutTargets?.get(rs.name)}
                    />
                  );
                });
              })}
            </div>
          )}

          {sections.omLossEvents && (
            <div data-toc-key="omLossEvents">
              {omData.coverageStatus === "done" && omData.covLayersWithBuildings.size > 0 ? (
                <ReportOMLossEvents
                  sectionNum={sectionNumbers.omLossEvents ?? 10}
                  radarResults={omResultTrimmed.radar_results}
                  selectedBuildings={omData.selectedBuildings}
                  buildingGroups={omData.buildingGroups}
                  radarSites={omData.selectedRadarSites}
                  layersWithTargets={omData.covLayersWithBuildings}
                  layersWithoutTargets={omData.covLayersWithout}
                />
              ) : omData.coverageStatus === "error" ? (
                <ReportPage>
                  <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                    <p className="text-sm text-red-400">커버리지 계산 실패 — Loss 상세 표시 불가</p>
                  </div>
                </ReportPage>
              ) : (
                <ReportPage>
                  <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                    <Loader2 size={24} className="mb-3 animate-spin" />
                    <p className="text-sm">Loss 상세 계산 중...</p>
                  </div>
                </ReportPage>
              )}
            </div>
          )}

          {sections.omFindings && (
            <div data-toc-key="omFindings">
              <ReportOMFindings
                sectionNum={sectionNumbers.omFindings ?? 11}
                radarResults={omResultTrimmed.radar_results}
                selectedBuildings={omData.selectedBuildings}
                buildingGroups={omData.buildingGroups}
                radarSites={omData.selectedRadarSites}
                findingsText={omData.findingsText}
                onFindingsChange={(text) => onOmDataChange((prev) => ({ ...prev, findingsText: text }))}
                editable={true}
                analysisMonth={omData.analysisMonth}
              />
            </div>
          )}
        </>
      )}

      {/* ─── 비행 건별 ─── */}
      {template === "flights" && (
        <>
          {sections.flightComparison && (
            <ReportFlightComparisonSection
              sectionNum={sectionNumbers.flightComparison ?? 1}
              flights={reportFlights}
              radarSite={radarSite}
            />
          )}
          {sections.trackMap && (
            <ReportPage>
              <ReportMapSection
                sectionNum={sectionNumbers.trackMap ?? 2}
                mapImage={mapImage}
              />
            </ReportPage>
          )}

          {sections.lossDetail && reportFlights.some((f) => f.loss_points.length > 0) && (
            <ReportPage>
              <ReportLossSection
                sectionNum={sectionNumbers.lossDetail ?? 3}
                flights={reportFlights}
                template="flights"
              />
            </ReportPage>
          )}

          {sections.los && losResults.length > 0 && (
            <ReportLoSSection
              sectionNum={sectionNumbers.los ?? 5}
              losResults={losResults}
            />
          )}

          {sections.panorama && panoramaData.length > 0 && radarSite && (
            <ReportPanoramaSection
              sectionNum={sectionNumbers.panorama ?? 6}
              panoramaData={panoramaData}
              radarSite={radarSite}
              peakNames={panoramaPeakNames}
            />
          )}
        </>
      )}

      {/* ─── 단일비행 상세 ─── */}
      {template === "single" && singleFlight && (
        <>
          {(sections.flightProfile || sections.trackMap) && (
            <ReportPage>
              {sections.flightProfile && (
                <ReportFlightProfileSection
                  sectionNum={sectionNumbers.flightProfile ?? 1}
                  flight={singleFlight}
                  radarSite={radarSite}
                  preloadedPoints={singleFlightChartPoints}
                />
              )}
              {sections.trackMap && (
                <ReportMapSection
                  sectionNum={sectionNumbers.trackMap ?? 2}
                  mapImage={mapImage}
                />
              )}
            </ReportPage>
          )}

          {sections.flightLossAnalysis && (
            <ReportPage>
              <ReportFlightLossAnalysisSection
                sectionNum={sectionNumbers.flightLossAnalysis ?? 3}
                flight={singleFlight}
              />
            </ReportPage>
          )}

          {sections.los && losResults.length > 0 && (
            <ReportLoSSection
              sectionNum={sectionNumbers.los ?? 5}
              losResults={losResults}
            />
          )}

          {sections.panorama && panoramaData.length > 0 && radarSite && (
            <ReportPanoramaSection
              sectionNum={sectionNumbers.panorama ?? 6}
              panoramaData={panoramaData}
              radarSite={radarSite}
              peakNames={panoramaPeakNames}
            />
          )}
        </>
      )}
      </div>{/* /.kac-report */}
      </ReportPageHeaderProvider>
    </div>
  );
}
