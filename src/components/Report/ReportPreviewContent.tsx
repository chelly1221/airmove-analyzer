/**
 * 보고서 프리뷰 콘텐츠 — ReportGeneration과 ReportApp 양쪽에서 공유.
 * 툴바는 포함하지 않음. 호출 측에서 previewRef와 상태를 관리.
 * 장애물 월간(OM) 보고서 단일 템플릿 전용.
 */
import { useMemo } from "react";
import { Loader2 } from "lucide-react";
import ReportPage, { ReportPageHeaderProvider } from "./ReportPage";
import { OMEditProvider } from "./OMEditable";
import ReportCoverPage from "./ReportCoverPage";
import ReportOMSummarySection from "./ReportOMSummarySection";
import ReportOMCombinedDailyChart from "./ReportOMCombinedDailyChart";
import ReportOMObstacleDetail from "./ReportOMObstacleDetail";
import ReportOMFindings from "./ReportOMFindings";
import ReportOMLossEvents from "./ReportOMLossEvents";
import type {
  RadarSite, ReportMetadata, ObstacleMonthlyResult, OMReportData,
} from "../../types";
import type { ReportTemplate, ReportSections } from "../../utils/reportTransfer";

// ── Props ──

export interface ReportPreviewContentProps {
  template: ReportTemplate;
  sections: ReportSections;

  // 데이터
  radarSite: RadarSite;
  reportMetadata: ReportMetadata;

  // 장애물 월간
  omData: OMReportData;
  omResult: ObstacleMonthlyResult | null;

  // OM 콜백
  onOmDataChange: (updater: (prev: OMReportData) => OMReportData) => void;

  // ref
  previewRef: React.RefObject<HTMLDivElement | null>;
}

// ── 섹션 토글 정의 ──

export function getSectionToggles(_template: ReportTemplate, _sections: ReportSections): { key: keyof ReportSections; label: string }[] {
  return [
    { key: "cover", label: "표지" },
    { key: "omSummary", label: "요약" },
    { key: "omDailyPsrLoss", label: "일별 PSR·표적소실" },
    { key: "omLosCrossSection", label: "장애물별 상세" },
    { key: "omLossEvents", label: "표적소실상세" },
    { key: "omFindings", label: "소견" },
  ];
}

// ── 컴포넌트 ──

export default function ReportPreviewContent(props: ReportPreviewContentProps) {
  const {
    sections,
    radarSite, reportMetadata,
    omData, omResult,
    onOmDataChange,
    previewRef,
  } = props;

  // OM 보고서 인라인 편집 컨텍스트 — 모든 문구를 textOverrides 로 덮어쓴다.
  const omEditCtx = useMemo(() => ({
    editable: true,
    overrides: omData?.textOverrides ?? {},
    onOverride: (key: string, value: string | null) => {
      onOmDataChange((prev) => {
        const next = { ...(prev.textOverrides ?? {}) };
        if (value == null) delete next[key];
        else next[key] = value;
        return { ...prev, textOverrides: next };
      });
    },
    chartZooms: omData?.chartZooms ?? {},
    onChartZoom: (key: string, zoom: [number, number] | null) => {
      onOmDataChange((prev) => {
        const next = { ...(prev.chartZooms ?? {}) };
        if (zoom == null) delete next[key];
        else next[key] = zoom;
        return { ...prev, chartZooms: next };
      });
    },
  }), [omData?.textOverrides, omData?.chartZooms, onOmDataChange]);

  // 페이지 상단 머리띠 — 발행기관(metadata.organization) + 보고서 제목
  const pageHeaderText = useMemo(() => {
    return `${reportMetadata.organization}  |  레이더 장애물 월간 분석 보고서`;
  }, [reportMetadata.organization]);

  // 활성 섹션 번호 계산
  const sectionNumbers = useMemo(() => {
    const nums: Record<string, number> = {};
    let n = 1;
    if (sections.omSummary) nums.omSummary = n++;
    if (sections.omDailyPsrLoss) nums.omDailyPsrLoss = n++;
    if (sections.omLosCrossSection && omData?.losMap && omData.losMap.size > 0) nums.omLosCrossSection = n++;
    if (sections.omLossEvents) nums.omLossEvents = n++;
    if (sections.omFindings) nums.omFindings = n++;
    return nums;
  }, [sections, omData?.losMap]);

  // OM 레이더별 조건 텍스트 — 장애물 후방(최근접) 거리만 사용
  const omRadarConditions = useMemo(() => {
    if (!omResult) return new Map<string, { minDistNm: string }>();
    const map = new Map<string, { minDistNm: string }>();
    for (const rr of omResult.radar_results) {
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
      map.set(rr.radar_name, { minDistNm: (minDistKm / 1.852).toFixed(1) });
    }
    return map;
  }, [omResult, omData.selectedRadarSites, omData.selectedBuildings]);

  // 일별 차트 조건 박스 — 단일 레이더면 2줄, 다중 레이더면 공통 2줄 + 레이더별 장애물 후방 거리
  //   (대상 장애물·분석 방위는 표지·섹션1 표와 중복이고 분석 기준이 '전 방위'라 미표기)
  const dailyConditions = useMemo<string[]>(() => {
    if (!omResult) return [];
    const rrs = omResult.radar_results;
    if (rrs.length === 1) {
      const info = omRadarConditions.get(rrs[0].radar_name);
      return [
        `• 기준: 전 방위(분석 구간 포함 전체 방위) · 장애물 후방(${info?.minDistNm ?? "0"}NM~) 항적만 포함`,
        `• PSR: 60NM 이내 SSR+Combined 기준, 표적소실: 신호소실만 (범위이탈·트랙스왑/속도이상 오탐 제외)`,
      ];
    }
    const lines = [
      `• 기준: 전 방위(분석 구간 포함 전체 방위) · 장애물 후방 항적만 포함`,
      `• PSR: 60NM 이내 SSR+Combined 기준, 표적소실: 신호소실만 (범위이탈·트랙스왑/속도이상 오탐 제외)`,
    ];
    for (const rr of rrs) {
      const info = omRadarConditions.get(rr.radar_name);
      lines.push(`• ${rr.radar_name} — 장애물 후방 ${info?.minDistNm ?? "0"}NM~`);
    }
    return lines;
  }, [omResult, omRadarConditions]);

  return (
    <div ref={previewRef} className="relative flex-1 overflow-auto bg-gray-300 py-6">
      <ReportPageHeaderProvider value={pageHeaderText}>
      <OMEditProvider value={omEditCtx}>
      <div className="kac-report">
      {/* 표지 */}
      {sections.cover && (
        <div data-toc-key="cover">
          <ReportCoverPage
            radarName={radarSite?.name ?? ""}
            metadata={reportMetadata}
            omMonthLabel={omData.analysisMonth
              ? `${omData.analysisMonth.slice(0, 4)}년 ${parseInt(omData.analysisMonth.slice(5, 7))}월`
              : undefined}
            omRadarNames={omData.selectedRadarSites.map((r) => r.name)}
            omBuildingsCount={omData.selectedBuildings.length}
          />
        </div>
      )}

      {/* ─── 장애물 월간 ─── */}
      {omResult && (
        <>
          {sections.omSummary && (
            <div data-toc-key="omSummary">
              <ReportOMSummarySection
                sectionNum={sectionNumbers.omSummary ?? 1}
                radarResults={omResult.radar_results}
                selectedBuildings={omData.selectedBuildings}
                buildingGroups={omData.buildingGroups}
                radarSites={omData.selectedRadarSites}
                losMap={omData.losMap}
                panoWithByRadar={omData.panoWithTargets}
                panoWithoutByRadar={omData.panoWithoutTargets}
                addedBlockageByKey={omData.addedBlockageByKey}
              />
            </div>
          )}

          {sections.omDailyPsrLoss && (
            <div data-toc-key="omDailyPsrLoss">
              <ReportOMCombinedDailyChart
                sectionNum={sectionNumbers.omDailyPsrLoss ?? 2}
                radars={omResult.radar_results.map((rr) => ({
                  radarName: rr.radar_name,
                  dailyStats: rr.daily_stats,
                }))}
                analysisMonth={omData.analysisMonth}
                conditions={dailyConditions}
              />
            </div>
          )}

          {/* 장애물별 상세 — (분석 대상 빌딩 × 레이더) 한 쌍당 한 페이지.
              빌딩 바깥/레이더 안쪽 순회 → 건물별로 레이더를 번갈아 표시(건물1-레이더1, 건물1-레이더2, 건물2-레이더1 …).
              빌딩 메타 + LoS 단면도 + LoS 차단 양각 대비 표적소실 분포 (분석 대상 방위 윈도우). */}
          {sections.omLosCrossSection && omData.losMap.size > 0 && (
            <div data-toc-key="omLosCrossSection">
              {omData.selectedBuildings.map((b) => {
                return omData.selectedRadarSites.map((rs) => {
                  const los = omData.losMap.get(`${rs.name}_${b.id}`);
                  if (!los) return null;
                  return (
                    <ReportOMObstacleDetail
                      key={`obs-${rs.name}-${b.id}`}
                      sectionNum={sectionNumbers.omLosCrossSection ?? 4}
                      radarSite={rs}
                      building={b}
                      buildingGroups={omData.buildingGroups}
                      los={los}
                      omResult={omResult}
                      panoWith={omData.panoWithTargets?.get(rs.name)}
                      panoWithout={omData.panoWithoutTargets?.get(rs.name)}
                      allBuildings={omData.selectedBuildings}
                      losMap={omData.losMap}
                      blockage={omData.addedBlockageByKey?.[`${rs.name}_${b.id}`]}
                    />
                  );
                });
              })}
            </div>
          )}

          {sections.omLossEvents && (
            <div data-toc-key="omLossEvents">
              {omData.panoramaStatus === "done" ? (
                <ReportOMLossEvents
                  sectionNum={sectionNumbers.omLossEvents ?? 5}
                  radarResults={omResult.radar_results}
                  radarSites={omData.selectedRadarSites}
                  selectedBuildings={omData.selectedBuildings}
                  buildingGroups={omData.buildingGroups}
                  losMap={omData.losMap}
                  panoWithByRadar={omData.panoWithTargets}
                  panoWithoutByRadar={omData.panoWithoutTargets}
                />
              ) : omData.panoramaStatus === "error" ? (
                <ReportPage>
                  <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                    <p className="text-sm text-red-400">파노라마 계산 실패 — 표적소실 상세 표시 불가</p>
                  </div>
                </ReportPage>
              ) : (
                <ReportPage>
                  <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                    <Loader2 size={24} className="mb-3 animate-spin" />
                    <p className="text-sm">표적소실 상세 계산 중...</p>
                  </div>
                </ReportPage>
              )}
            </div>
          )}

          {sections.omFindings && (
            <div data-toc-key="omFindings">
              <ReportOMFindings
                sectionNum={sectionNumbers.omFindings ?? 6}
                radarResults={omResult.radar_results}
                selectedBuildings={omData.selectedBuildings}
                buildingGroups={omData.buildingGroups}
                radarSites={omData.selectedRadarSites}
                findingsText={omData.findingsText}
                onFindingsChange={(text) => onOmDataChange((prev) => ({ ...prev, findingsText: text }))}
                editable={true}
                analysisMonth={omData.analysisMonth}
                addedBlockageByKey={omData.addedBlockageByKey}
              />
            </div>
          )}
        </>
      )}
      </div>{/* /.kac-report */}
      </OMEditProvider>
      </ReportPageHeaderProvider>
    </div>
  );
}
