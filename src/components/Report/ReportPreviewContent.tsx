/**
 * 보고서 프리뷰 콘텐츠 — ReportGeneration과 ReportApp 양쪽에서 공유.
 * 툴바는 포함하지 않음. 호출 측에서 previewRef와 상태를 관리.
 * 장애물 월간(OM) 보고서 단일 템플릿 전용.
 */
import { useEffect, useMemo, useState } from "react";
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

  /** 추가 차단영역 산출 진행 중(ReportApp addedBlockage 비동기 루프) — true 면 [data-om-computing]
   *  센티널을 렌더해 PDF 내보내기(useReportExport)가 산출 완료까지 대기한다(§1·§3·소견 누락 방지). */
  omComputing?: boolean;
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
    omComputing,
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

  // ── §3 상세 페이지 점진 마운트 ──
  // (분석 대상 빌딩 × 레이더) 전조합 페이지가 previewMountable 게이트 해제 순간 단일 React 커밋으로
  // 폭발 마운트되면, 페이지당 캔버스 3개 + CARTO 타일 요청이 일시에 몰려 렌더러가 수 초 블로킹(백지)
  // 되고 다건물 구성에서 메모리 스파이크를 만든다(두 창 동시 blank/프리징의 트리거 지점).
  // → 유효 쌍 목록을 먼저 산출하고 DETAIL_CHUNK 개씩 시차 마운트해 레이아웃·타일·페인트를 분산한다.
  //   페이지 수/TOC 는 ReportApp 의 MutationObserver 측정이 마운트 진행에 따라 자동 갱신.
  //   PDF 내보내기는 [data-om-mounting] 센티널 소멸을 대기(useReportExport)해 페이지 누락을 방지.
  const detailPairs = useMemo(() => {
    const pairs: { key: string }[] = [];
    if (!omData) return pairs;
    for (const b of omData.selectedBuildings) {
      for (const rs of omData.selectedRadarSites) {
        if (omData.losMap.has(`${rs.name}_${b.id}`)) pairs.push({ key: `${rs.name}_${b.id}` });
      }
    }
    return pairs;
  }, [omData]);
  const DETAIL_CHUNK = 2;
  const [detailMountCount, setDetailMountCount] = useState(DETAIL_CHUNK);
  // §3 토글 오프 시 램프 즉시 재무장 — 렌더 중 파생 상태 조정 패턴(조건부라 무한 루프 없음).
  //   effect 로 리셋하면 재활성 '첫 커밋'이 이미 전량 마운트(버스트)된 후라 늦다. 오프 렌더 시점에
  //   카운트를 초기화해 두면, 다시 켤 때 첫 커밋부터 DETAIL_CHUNK 개만 마운트되고 램프가 재가동된다.
  if (!sections.omLosCrossSection && detailMountCount !== DETAIL_CHUNK) {
    setDetailMountCount(DETAIL_CHUNK);
  }
  useEffect(() => {
    if (!sections.omLosCrossSection) return; // 섹션 오프 — 램프 정지 (위 렌더 중 리셋과 쌍)
    if (detailMountCount >= detailPairs.length) return;
    // 청크 간 간격 — 직전 청크의 커밋/레이아웃/타일 발화가 이벤트 루프를 비울 틈을 준다
    const t = setTimeout(() => setDetailMountCount((c) => c + DETAIL_CHUNK), 120);
    return () => clearTimeout(t);
  }, [detailMountCount, detailPairs.length, sections.omLosCrossSection]);
  const detailMountedKeys = useMemo(
    () => new Set(detailPairs.slice(0, detailMountCount).map((p) => p.key)),
    [detailPairs, detailMountCount],
  );
  const detailMounting = detailMountCount < detailPairs.length;

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
      {/* 추가 차단영역 산출 진행 센티널 — useReportExport 가 인쇄 전 소멸을 대기 */}
      {omComputing && <div data-om-computing="true" style={{ display: "none" }} />}
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
              빌딩 메타 + LoS 단면도 + LoS 차단 양각 대비 표적소실 분포 (분석 대상 방위 윈도우).
              점진 마운트: detailMountedKeys 에 포함된 쌍만 렌더 (위 detailPairs 주석 참조). */}
          {sections.omLosCrossSection && omData.losMap.size > 0 && (
            <div data-toc-key="omLosCrossSection">
              {detailMounting && <div data-om-mounting="true" style={{ display: "none" }} />}
              {omData.selectedBuildings.map((b) => {
                return omData.selectedRadarSites.map((rs) => {
                  const los = omData.losMap.get(`${rs.name}_${b.id}`);
                  if (!los) return null;
                  if (!detailMountedKeys.has(`${rs.name}_${b.id}`)) return null;
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
