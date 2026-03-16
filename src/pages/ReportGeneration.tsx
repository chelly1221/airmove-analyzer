import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import {
  FileText,
  Download,
  Loader2,
  CheckSquare,
  Square,
  Map,
  BarChart3,
  Crosshair,
  ArrowLeft,
  Eye,
  Plane,
  Cloud,
  Calendar,
  CalendarRange,
  ScanSearch,
  ListChecks,
  Mountain,
  Radio,
} from "lucide-react";
import { format } from "date-fns";
import { useAppStore } from "../store";
import Modal from "../components/common/Modal";
import ReportPage from "../components/Report/ReportPage";
import ReportCoverPage from "../components/Report/ReportCoverPage";
import ReportSummarySection from "../components/Report/ReportSummarySection";
import ReportMapSection from "../components/Report/ReportMapSection";
import ReportStatsSection from "../components/Report/ReportStatsSection";
import ReportLossSection from "../components/Report/ReportLossSection";
import ReportLOSSection from "../components/Report/ReportLOSSection";
import ReportAircraftSection from "../components/Report/ReportAircraftSection";
import ReportWeatherSection from "../components/Report/ReportWeatherSection";
import ReportFlightComparisonSection from "../components/Report/ReportFlightComparisonSection";
import ReportFlightProfileSection from "../components/Report/ReportFlightProfileSection";
import ReportFlightLossAnalysisSection from "../components/Report/ReportFlightLossAnalysisSection";
import ReportPanoramaSection from "../components/Report/ReportPanoramaSection";
import ReportObstacleSummarySection from "../components/Report/ReportObstacleSummarySection";
import { useReportExport } from "../components/Report/useReportExport";
import { invoke } from "@tauri-apps/api/core";
import { flightLabel } from "../utils/flightConsolidation";
import type { Flight, LOSProfileData, WeatherSnapshot, Aircraft as AircraftType, ReportMetadata, PanoramaPoint } from "../types";

type ReportTemplate = "weekly" | "monthly" | "flights" | "single" | "obstacle";
type ReportMode = "config" | "preview";

interface ReportSections {
  cover: boolean;
  summary: boolean;
  trackMap: boolean;
  stats: boolean;
  weather: boolean;
  los: boolean;
  panorama: boolean;
  aircraft: boolean;
  // 건별 보고서 전용
  flightComparison: boolean;
  lossDetail: boolean;
  // 단일 상세 전용
  flightProfile: boolean;
  flightLossAnalysis: boolean;
  // 장애물 보고서 전용
  obstacleSummary: boolean;
}

const DEFAULT_SECTIONS: ReportSections = {
  cover: true,
  summary: true,
  trackMap: true,
  stats: true,
  weather: true,
  los: true,
  panorama: true,
  aircraft: true,
  flightComparison: true,
  lossDetail: true,
  flightProfile: true,
  flightLossAnalysis: true,
  obstacleSummary: true,
};

/** 템플릿별 표시할 섹션 토글 목록 */
function getSectionToggles(template: ReportTemplate, _sections: ReportSections): { key: keyof ReportSections; label: string }[] {
  if (template === "flights") {
    return [
      { key: "cover", label: "표지" },
      { key: "flightComparison", label: "비교" },
      { key: "trackMap", label: "지도" },
      { key: "lossDetail", label: "소실" },
      { key: "weather", label: "기상" },
      { key: "los", label: "LOS" },
      { key: "panorama", label: "장애물" },
    ];
  }
  if (template === "obstacle") {
    return [
      { key: "cover", label: "표지" },
      { key: "obstacleSummary", label: "요약" },
      { key: "trackMap", label: "지도" },
      { key: "los", label: "LOS" },
      { key: "panorama", label: "파노라마" },
    ];
  }
  if (template === "single") {
    return [
      { key: "cover", label: "표지" },
      { key: "flightProfile", label: "프로파일" },
      { key: "trackMap", label: "지도" },
      { key: "flightLossAnalysis", label: "소실분석" },
      { key: "weather", label: "기상" },
      { key: "los", label: "LOS" },
      { key: "panorama", label: "장애물" },
    ];
  }
  return [
    { key: "cover", label: "표지" },
    { key: "summary", label: "요약" },
    { key: "trackMap", label: "지도" },
    { key: "stats", label: "통계" },
    { key: "weather", label: "기상" },
    { key: "los", label: "LOS" },
    { key: "panorama", label: "장애물" },
    { key: "aircraft", label: "검사기" },
  ];
}

function templateDisplayLabel(tpl: ReportTemplate): string {
  switch (tpl) {
    case "weekly": return "주간";
    case "monthly": return "월간";
    case "flights": return "건별";
    case "single": return "상세";
    case "obstacle": return "장애물";
  }
}

export default function ReportGeneration() {
  const flights = useAppStore((s) => s.flights);
  const aircraft = useAppStore((s) => s.aircraft);
  const losResults = useAppStore((s) => s.losResults);
  const radarSite = useAppStore((s) => s.radarSite);
  const weatherData = useAppStore((s) => s.weatherData);
  const garblePoints = useAppStore((s) => s.garblePoints);
  const reportMetadata = useAppStore((s) => s.reportMetadata);

  const [mode, setMode] = useState<ReportMode>("config");
  const [template, setTemplate] = useState<ReportTemplate>("weekly");
  const [sections, setSections] = useState<ReportSections>({ ...DEFAULT_SECTIONS });
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mapImage, setMapImage] = useState<string | null>(null);

  // 파노라마 데이터 (캐시에서 로드)
  const [panoramaData, setPanoramaData] = useState<PanoramaPoint[]>([]);

  useEffect(() => {
    if (!radarSite) return;
    invoke<string | null>("load_panorama_cache", {
      radarLat: radarSite.latitude,
      radarLon: radarSite.longitude,
    })
      .then((json) => {
        if (json) {
          const data = JSON.parse(json) as PanoramaPoint[];
          setPanoramaData(data);
        }
      })
      .catch(() => {});
  }, [radarSite]);

  // 비행 선택 (건별/단일 상세용)
  const [selectedFlightIds, setSelectedFlightIds] = useState<Set<string>>(new Set());
  const [singleFlightId, setSingleFlightId] = useState<string | null>(null);

  // 템플릿 모달
  const [templateModalOpen, setTemplateModalOpen] = useState<ReportTemplate | null>(null);

  // 편집 가능 텍스트 상태
  const [coverTitle, setCoverTitle] = useState("비행검사 주간 보고서");
  const [coverSubtitle, setCoverSubtitle] = useState(
    `${format(new Date(), "yyyy년 MM월 dd일")} 기준 주간 보고`
  );

  const avgLossPercent =
    flights.length > 0
      ? flights.reduce((s, r) => s + r.loss_percentage, 0) / flights.length
      : 0;
  const [commentary, setCommentary] = useState(() => {
    const grade = avgLossPercent < 1 ? "양호" : avgLossPercent < 5 ? "주의" : "경고";
    return `금주 비행검사 항적 분석 결과, 평균 소실율은 ${avgLossPercent.toFixed(1)}%로 종합 판정 '${grade}' 수준입니다. 특이사항 없음.`;
  });

  const previewRef = useRef<HTMLDivElement>(null);
  const { exportPDF } = useReportExport();

  // 선택된 비행 목록 (preview용)
  const reportFlights = useMemo(() => {
    if (template === "flights") {
      return flights.filter((f) => selectedFlightIds.has(f.id));
    }
    if (template === "single") {
      const found = flights.find((f) => f.id === singleFlightId);
      return found ? [found] : [];
    }
    return flights;
  }, [template, flights, selectedFlightIds, singleFlightId]);

  // 맵 캡처
  const captureMap = useCallback((targetFlights: Flight[]): Promise<string | null> => {
    return new Promise((resolve) => {
      const mapContainer = document.querySelector(".maplibregl-map");
      if (!mapContainer) { resolve(null); return; }

      const map = (window as any).__maplibreInstance;
      if (map && targetFlights.length > 0) {
        let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
        let hasPoints = false;
        for (const f of targetFlights) {
          for (const p of f.track_points) {
            hasPoints = true;
            if (p.latitude < minLat) minLat = p.latitude;
            if (p.latitude > maxLat) maxLat = p.latitude;
            if (p.longitude < minLon) minLon = p.longitude;
            if (p.longitude > maxLon) maxLon = p.longitude;
          }
        }
        if (hasPoints && minLat < maxLat && minLon < maxLon) {
          map.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
            padding: 60, duration: 0, bearing: 0, pitch: 0,
          });
        }
      }

      setTimeout(() => {
        const canvases = mapContainer.querySelectorAll("canvas");
        if (canvases.length === 0) { resolve(null); return; }
        const w = canvases[0].width;
        const h = canvases[0].height;
        const offscreen = document.createElement("canvas");
        offscreen.width = w;
        offscreen.height = h;
        const ctx = offscreen.getContext("2d");
        if (!ctx) { resolve(null); return; }
        for (const c of canvases) {
          ctx.drawImage(c, 0, 0);
        }
        resolve(offscreen.toDataURL("image/png"));
      }, 500);
    });
  }, []);

  // 보고서 생성 (config → preview)
  const handleGenerate = useCallback(async (
    tpl: ReportTemplate,
    sects: ReportSections,
    flightIds?: Set<string>,
    singleId?: string | null,
  ) => {
    // 비행 선택 상태 저장
    if (flightIds) setSelectedFlightIds(flightIds);
    if (singleId !== undefined) setSingleFlightId(singleId);

    // 타이틀/서브타이틀 설정
    if (tpl === "weekly" || tpl === "monthly") {
      const label = tpl === "weekly" ? "주간" : "월간";
      setCoverTitle(`비행검사 ${label} 보고서`);
      setCoverSubtitle(
        tpl === "weekly"
          ? `${format(new Date(), "yyyy년 MM월 dd일")} 기준 주간 보고`
          : `${format(new Date(), "yyyy년 MM월")} 보고`
      );
      const grade = avgLossPercent < 1 ? "양호" : avgLossPercent < 5 ? "주의" : "경고";
      setCommentary(
        `금${tpl === "weekly" ? "주" : "월"} 비행검사 항적 분석 결과, 평균 소실율은 ${avgLossPercent.toFixed(1)}%로 종합 판정 '${grade}' 수준입니다. 특이사항 없음.`
      );
    } else if (tpl === "flights") {
      const ids = flightIds ?? selectedFlightIds;
      setCoverTitle("비행 건별 분석 보고서");
      setCoverSubtitle(`${format(new Date(), "yyyy년 MM월 dd일")} · 선택 ${ids.size}건 비행 분석`);
    } else if (tpl === "obstacle") {
      setCoverTitle("전파 장애물 분석 보고서");
      setCoverSubtitle(`${radarSite?.name ?? ""} 레이더 장애물 종합 분석 · ${format(new Date(), "yyyy년 MM월 dd일")}`);
    } else if (tpl === "single") {
      const f = flights.find((fl) => fl.id === (singleId ?? singleFlightId));
      if (f) {
        const label = flightLabel(f, aircraft);
        setCoverTitle("비행검사 상세 분석 보고서");
        setCoverSubtitle(`${label} · ${format(new Date(f.start_time * 1000), "yyyy-MM-dd")}`);
      }
    }

    // 맵 캡처 (선택 비행 기준)
    if (sects.trackMap) {
      let targetFlights: Flight[];
      if (tpl === "flights" && flightIds) {
        targetFlights = flights.filter((f) => flightIds.has(f.id));
      } else if (tpl === "single" && singleId) {
        const found = flights.find((f) => f.id === singleId);
        targetFlights = found ? [found] : flights;
      } else {
        targetFlights = flights;
      }
      const img = await captureMap(targetFlights);
      setMapImage(img);
    }

    setTemplate(tpl);
    setSections(sects);
    setTemplateModalOpen(null);
    setMode("preview");
  }, [avgLossPercent, captureMap, flights, aircraft, selectedFlightIds, singleFlightId, radarSite]);

  // PDF 내보내기
  const handleExportPDF = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const dateStr = format(new Date(), "yyyyMMdd_HHmmss");
      const tplLabel = templateDisplayLabel(template);
      const filename = `비행검사_${tplLabel}_보고서_${dateStr}.pdf`;
      const result = await exportPDF(previewRef, filename);
      if (!result.success && result.error && result.error !== "저장이 취소되었습니다") {
        setError(result.error);
      }
    } catch (err) {
      setError(`PDF 내보내기 실패: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGenerating(false);
    }
  }, [template, exportPDF]);

  // 활성 섹션 번호 계산
  const sectionNumbers = useMemo(() => {
    const nums: Record<string, number> = {};
    let n = 1;
    if (template === "flights") {
      if (sections.flightComparison) nums.flightComparison = n++;
      if (sections.trackMap) nums.trackMap = n++;
      if (sections.lossDetail) nums.lossDetail = n++;
      if (sections.weather && weatherData) nums.weather = n++;
      if (sections.los && losResults.length > 0) nums.los = n++;
      if (sections.panorama && panoramaData.length > 0) nums.panorama = n++;
    } else if (template === "obstacle") {
      if (sections.obstacleSummary) nums.obstacleSummary = n++;
      if (sections.trackMap) nums.trackMap = n++;
      if (sections.los && losResults.length > 0) nums.los = n++;
      if (sections.panorama && panoramaData.length > 0) nums.panorama = n++;
    } else if (template === "single") {
      if (sections.flightProfile) nums.flightProfile = n++;
      if (sections.trackMap) nums.trackMap = n++;
      if (sections.flightLossAnalysis) nums.flightLossAnalysis = n++;
      if (sections.weather && weatherData) nums.weather = n++;
      if (sections.los && losResults.length > 0) nums.los = n++;
      if (sections.panorama && panoramaData.length > 0) nums.panorama = n++;
    } else {
      if (sections.summary) nums.summary = n++;
      if (sections.trackMap) nums.trackMap = n++;
      if (sections.stats && flights.length > 0) nums.stats = n++;
      if (sections.weather && weatherData) nums.weather = n++;
      if (sections.los && losResults.length > 0) nums.los = n++;
      if (sections.panorama && panoramaData.length > 0) nums.panorama = n++;
      if (sections.aircraft && aircraft.length > 0) nums.aircraft = n++;
    }
    return nums;
  }, [template, sections, weatherData, losResults, flights, aircraft, panoramaData]);

  // ── 설정 모드 (Config) ──
  if (mode === "config") {
    const totalLoss = flights.reduce((s, r) => s + r.loss_points.length, 0);

    return (
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-gray-800">보고서 생성</h1>
          <p className="mt-1 text-sm text-gray-500">
            템플릿을 선택하여 분석 결과 PDF 보고서를 생성합니다
          </p>
        </div>

        {/* Template cards */}
        <div className="grid grid-cols-2 gap-4">
          <TemplateCard
            icon={Calendar}
            title="주간 보고서"
            description="주간 비행검사 결과를 상세하게 보고합니다. 비행별 상세 통계, 소실 구간 목록, LOS 분석 결과가 포함됩니다."
            stats={[
              { label: "분석 비행", value: flights.length },
              { label: "소실 건수", value: totalLoss },
            ]}
            disabled={flights.length === 0}
            onClick={() => setTemplateModalOpen("weekly")}
          />
          <TemplateCard
            icon={CalendarRange}
            title="월간 보고서"
            description="월간 요약 통계와 주요 소실 사항을 보고합니다. 추이 분석 차트와 종합 판정이 포함됩니다."
            stats={[
              { label: "평균 소실율", value: `${avgLossPercent.toFixed(1)}%` },
              { label: "LOS 분석", value: `${losResults.length}건` },
            ]}
            disabled={flights.length === 0}
            onClick={() => setTemplateModalOpen("monthly")}
          />
          <TemplateCard
            icon={ListChecks}
            title="비행 건별 보고서"
            description="선택한 비행들의 비교 분석 보고서입니다. 비행별 소실 통계 비교 차트와 소실 상세가 포함됩니다."
            stats={[
              { label: "선택 가능", value: `${flights.length}건` },
              { label: "소실 건수", value: totalLoss },
            ]}
            disabled={flights.length === 0}
            onClick={() => setTemplateModalOpen("flights")}
          />
          <TemplateCard
            icon={ScanSearch}
            title="단일비행 상세 보고서"
            description="1건의 비행을 심층 분석합니다. 소실 구간 상세, 시간대별 분포, 고도-거리 프로파일이 포함됩니다."
            stats={[
              { label: "선택 가능", value: `${flights.length}건` },
            ]}
            disabled={flights.length === 0}
            onClick={() => setTemplateModalOpen("single")}
          />
          <TemplateCard
            icon={Radio}
            title="전파 장애물 보고서"
            description="레이더 전파 장애물을 종합 분석합니다. LOS 차단 분석, 360° 파노라마 장애물 탐색, 건물 목록이 포함됩니다."
            stats={[
              { label: "LOS 분석", value: `${losResults.length}건` },
              { label: "파노라마", value: panoramaData.length > 0 ? "있음" : "없음" },
            ]}
            disabled={losResults.length === 0 && panoramaData.length === 0}
            onClick={() => setTemplateModalOpen("obstacle")}
          />
        </div>

        {/* No data */}
        {flights.length === 0 && (
          <div className="flex flex-col items-center rounded-xl border border-gray-200 bg-gray-50 py-12">
            <FileText size={40} className="mb-3 text-gray-600" />
            <p className="text-sm text-gray-500">
              보고서를 생성하려면 먼저 자료를 업로드하고 파싱하세요
            </p>
          </div>
        )}

        {/* Template modal */}
        {templateModalOpen && (
          <TemplateConfigModal
            template={templateModalOpen}
            flights={flights}
            losResults={losResults}
            weatherData={weatherData}
            aircraft={aircraft}
            metadata={reportMetadata}
            radarName={radarSite?.name ?? ""}
            panoramaData={panoramaData}
            onClose={() => setTemplateModalOpen(null)}
            onGenerate={handleGenerate}
          />
        )}
      </div>
    );
  }

  // ── 미리보기 모드 (Preview) ──
  const toggles = getSectionToggles(template, sections);
  const singleFlight = template === "single" ? reportFlights[0] : null;

  return (
    <div className="-m-6 flex h-[calc(100%+48px)] flex-col">
      {/* 상단 툴바 */}
      <div className="sticky top-0 z-20 flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-2">
        <button
          onClick={() => setMode("config")}
          className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 transition-colors hover:bg-gray-100"
        >
          <ArrowLeft size={14} />
          돌아가기
        </button>

        {/* 섹션 토글 (컴팩트) */}
        <div className="ml-2 flex items-center gap-1">
          {toggles.map((s) => (
            <button
              key={s.key}
              onClick={() => setSections((prev) => ({ ...prev, [s.key]: !prev[s.key] }))}
              className={`rounded px-2 py-1 text-[11px] transition-colors ${
                sections[s.key]
                  ? "bg-[#a60739]/10 text-[#a60739] font-medium"
                  : "text-gray-400 hover:bg-gray-100"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {error && (
          <span className="text-xs text-red-500">{error}</span>
        )}

        <button
          onClick={handleExportPDF}
          disabled={generating}
          className="flex items-center gap-1.5 rounded-lg bg-[#a60739] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#85062e] disabled:opacity-40"
        >
          {generating ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          {generating ? "생성 중..." : "PDF 다운로드"}
        </button>
      </div>

      {/* 보고서 미리보기 영역 */}
      <div ref={previewRef} className="flex-1 overflow-auto bg-gray-300 py-6">
        {/* 표지 (공통) */}
        {sections.cover && (
          <ReportCoverPage
            template={template}
            radarName={radarSite?.name ?? ""}
            metadata={reportMetadata}
            editable
            title={coverTitle}
            onTitleChange={setCoverTitle}
            subtitle={coverSubtitle}
            onSubtitleChange={setCoverSubtitle}
          />
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
                    onCommentaryChange={setCommentary}
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

            {sections.weather && weatherData && (
              <ReportPage>
                <ReportWeatherSection
                  sectionNum={sectionNumbers.weather ?? 4}
                  weather={weatherData}
                  garblePoints={garblePoints}
                />
              </ReportPage>
            )}

            {sections.los && losResults.length > 0 && (
              <ReportPage>
                <ReportLOSSection
                  sectionNum={sectionNumbers.los ?? 5}
                  losResults={losResults}
                />
              </ReportPage>
            )}

            {sections.panorama && panoramaData.length > 0 && radarSite && (
              <ReportPage>
                <ReportPanoramaSection
                  sectionNum={sectionNumbers.panorama ?? 6}
                  panoramaData={panoramaData}
                  radarSite={radarSite}
                />
              </ReportPage>
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

        {/* ─── 전파 장애물 ─── */}
        {template === "obstacle" && (
          <>
            {(sections.obstacleSummary || sections.trackMap) && (
              <ReportPage>
                {sections.obstacleSummary && radarSite && (
                  <ReportObstacleSummarySection
                    sectionNum={sectionNumbers.obstacleSummary ?? 1}
                    losResults={losResults}
                    panoramaData={panoramaData}
                    radarSite={radarSite}
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

            {sections.los && losResults.length > 0 && (
              <ReportPage>
                <ReportLOSSection
                  sectionNum={sectionNumbers.los ?? 3}
                  losResults={losResults}
                />
              </ReportPage>
            )}

            {sections.panorama && panoramaData.length > 0 && radarSite && (
              <ReportPage>
                <ReportPanoramaSection
                  sectionNum={sectionNumbers.panorama ?? 4}
                  panoramaData={panoramaData}
                  radarSite={radarSite}
                />
              </ReportPage>
            )}
          </>
        )}

        {/* ─── 비행 건별 ─── */}
        {template === "flights" && (
          <>
            {(sections.flightComparison || sections.trackMap) && (
              <ReportPage>
                {sections.flightComparison && (
                  <ReportFlightComparisonSection
                    sectionNum={sectionNumbers.flightComparison ?? 1}
                    flights={reportFlights}
                    radarSite={radarSite}
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

            {sections.lossDetail && reportFlights.some((f) => f.loss_points.length > 0) && (
              <ReportPage>
                <ReportLossSection
                  sectionNum={sectionNumbers.lossDetail ?? 3}
                  flights={reportFlights}
                  template="flights"
                />
              </ReportPage>
            )}

            {sections.weather && weatherData && (
              <ReportPage>
                <ReportWeatherSection
                  sectionNum={sectionNumbers.weather ?? 4}
                  weather={weatherData}
                  garblePoints={garblePoints}
                />
              </ReportPage>
            )}

            {sections.los && losResults.length > 0 && (
              <ReportPage>
                <ReportLOSSection
                  sectionNum={sectionNumbers.los ?? 5}
                  losResults={losResults}
                />
              </ReportPage>
            )}

            {sections.panorama && panoramaData.length > 0 && radarSite && (
              <ReportPage>
                <ReportPanoramaSection
                  sectionNum={sectionNumbers.panorama ?? 6}
                  panoramaData={panoramaData}
                  radarSite={radarSite}
                />
              </ReportPage>
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

            {sections.weather && weatherData && (
              <ReportPage>
                <ReportWeatherSection
                  sectionNum={sectionNumbers.weather ?? 4}
                  weather={weatherData}
                  garblePoints={garblePoints}
                />
              </ReportPage>
            )}

            {sections.los && losResults.length > 0 && (
              <ReportPage>
                <ReportLOSSection
                  sectionNum={sectionNumbers.los ?? 5}
                  losResults={losResults}
                />
              </ReportPage>
            )}

            {sections.panorama && panoramaData.length > 0 && radarSite && (
              <ReportPage>
                <ReportPanoramaSection
                  sectionNum={sectionNumbers.panorama ?? 6}
                  panoramaData={panoramaData}
                  radarSite={radarSite}
                />
              </ReportPage>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── 템플릿 카드 ──

function TemplateCard({
  icon: Icon,
  title,
  description,
  stats,
  disabled,
  onClick,
}: {
  icon: typeof Calendar;
  title: string;
  description: string;
  stats: { label: string; value: string | number }[];
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`group flex flex-col rounded-xl border p-5 text-left transition-all ${
        disabled
          ? "border-gray-200 bg-gray-50 opacity-50 cursor-not-allowed"
          : "border-gray-200 bg-white hover:border-[#a60739]/40 hover:shadow-md hover:shadow-[#a60739]/5"
      }`}
    >
      <div className="flex items-center gap-3">
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${
          disabled ? "bg-gray-100" : "bg-[#a60739]/10 group-hover:bg-[#a60739]/20"
        }`}>
          <Icon size={20} className={disabled ? "text-gray-400" : "text-[#a60739]"} />
        </div>
        <div>
          <h3 className="text-base font-bold text-gray-800">{title}</h3>
        </div>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-gray-500">{description}</p>
      <div className="mt-4 flex gap-3">
        {stats.map((s) => (
          <div key={s.label} className="rounded-md bg-gray-100 px-3 py-1.5">
            <span className="text-[10px] text-gray-400">{s.label}</span>
            <span className="ml-1.5 text-xs font-semibold text-gray-700">{s.value}</span>
          </div>
        ))}
      </div>
    </button>
  );
}

// ── 템플릿 설정 모달 ──

function TemplateConfigModal({
  template,
  flights,
  losResults,
  weatherData,
  aircraft,
  metadata,
  radarName,
  panoramaData,
  onClose,
  onGenerate,
}: {
  template: ReportTemplate;
  flights: Flight[];
  losResults: LOSProfileData[];
  weatherData: WeatherSnapshot | null;
  aircraft: AircraftType[];
  metadata: ReportMetadata;
  radarName: string;
  panoramaData: PanoramaPoint[];
  onClose: () => void;
  onGenerate: (tpl: ReportTemplate, sections: ReportSections, flightIds?: Set<string>, singleId?: string | null) => void;
}) {
  const tplLabel = templateDisplayLabel(template);
  const [sections, setSections] = useState<ReportSections>({ ...DEFAULT_SECTIONS });

  // 비행 선택 상태 (건별용: 다중, 단일용: 라디오)
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set(flights.map((f) => f.id)));
  const [radioId, setRadioId] = useState<string | null>(flights[0]?.id ?? null);

  const isFlightsMode = template === "flights";
  const isSingleMode = template === "single";
  const needsFlightSelect = isFlightsMode || isSingleMode;

  const totalLoss = flights.reduce((s, r) => s + r.loss_points.length, 0);
  const avgLossPercent =
    flights.length > 0
      ? flights.reduce((s, r) => s + r.loss_percentage, 0) / flights.length
      : 0;

  // 템플릿별 섹션 항목
  const sectionItems: { key: keyof ReportSections; label: string; icon: typeof Map; desc: string; available: boolean }[] = (() => {
    if (isFlightsMode) {
      return [
        { key: "cover", label: "표지", icon: FileText, desc: "문서번호, 시행일자, 레이더명", available: true },
        { key: "flightComparison", label: "비행 비교", icon: BarChart3, desc: "선택 비행 비교 테이블 및 차트", available: true },
        { key: "trackMap", label: "항적 지도", icon: Map, desc: "선택 비행 항적 경로 시각화", available: true },
        { key: "lossDetail", label: "소실 상세", icon: Crosshair, desc: "소실 포인트 상세 목록", available: true },
        { key: "weather", label: "기상 분석", icon: Cloud, desc: "기상 조건 및 영향 분석", available: !!weatherData },
        { key: "los", label: "LOS 분석", icon: Crosshair, desc: "전파 가시선 차단 분석", available: losResults.length > 0 },
        { key: "panorama", label: "전파 장애물", icon: Mountain, desc: "360° 파노라마 장애물 분석", available: panoramaData.length > 0 },
      ];
    }
    if (template === "obstacle") {
      return [
        { key: "cover", label: "표지", icon: FileText, desc: "문서번호, 시행일자, 레이더명", available: true },
        { key: "obstacleSummary", label: "장애물 종합 요약", icon: Radio, desc: "LOS·파노라마 통합 KPI, 주요 장애물 TOP 5", available: losResults.length > 0 || panoramaData.length > 0 },
        { key: "trackMap", label: "항적 지도", icon: Map, desc: "LOS 경로 및 장애물 위치 시각화", available: true },
        { key: "los", label: "LOS 분석", icon: Crosshair, desc: "전파 가시선 차단/양호 상세 결과", available: losResults.length > 0 },
        { key: "panorama", label: "360° 파노라마", icon: Mountain, desc: "방위별 최대 앙각 장애물 및 건물 목록", available: panoramaData.length > 0 },
      ];
    }
    if (isSingleMode) {
      return [
        { key: "cover", label: "표지", icon: FileText, desc: "문서번호, 시행일자, 레이더명", available: true },
        { key: "flightProfile", label: "비행 프로파일", icon: Plane, desc: "기본정보, KPI, 고도 추이 차트", available: true },
        { key: "trackMap", label: "항적 지도", icon: Map, desc: "해당 비행 항적 경로 시각화", available: true },
        { key: "flightLossAnalysis", label: "소실 구간 분석", icon: BarChart3, desc: "구간별 상세, 분포 분석 차트", available: true },
        { key: "weather", label: "기상 분석", icon: Cloud, desc: "기상 조건 및 영향 분석", available: !!weatherData },
        { key: "los", label: "LOS 분석", icon: Crosshair, desc: "전파 가시선 차단 분석", available: losResults.length > 0 },
        { key: "panorama", label: "전파 장애물", icon: Mountain, desc: "360° 파노라마 장애물 분석", available: panoramaData.length > 0 },
      ];
    }
    return [
      { key: "cover", label: "표지", icon: FileText, desc: "문서번호, 시행일자, 레이더명", available: true },
      { key: "summary", label: "분석 요약", icon: BarChart3, desc: "KPI 그리드, 종합 판정, 소견", available: true },
      { key: "trackMap", label: "항적 지도", icon: Map, desc: "항적 경로 및 Loss 구간 시각화", available: true },
      { key: "stats", label: "분석 통계", icon: BarChart3, desc: `비행별 상세 ${template === "weekly" ? "통계" : "추이 차트"}`, available: flights.length > 0 },
      { key: "weather", label: "기상 분석", icon: Cloud, desc: "기상 조건 및 영향 분석", available: !!weatherData },
      { key: "los", label: "LOS 분석", icon: Crosshair, desc: "전파 가시선 차단 분석", available: losResults.length > 0 },
      { key: "panorama", label: "전파 장애물", icon: Mountain, desc: "360° 파노라마 장애물 분석", available: panoramaData.length > 0 },
      { key: "aircraft", label: "검사기 현황", icon: Plane, desc: "비행검사기 운용 현황", available: aircraft.length > 0 },
    ];
  })();

  const canGenerate = isFlightsMode ? checkedIds.size > 0 : isSingleMode ? !!radioId : true;

  return (
    <Modal open onClose={onClose} title={`${tplLabel} 보고서 설정`} width={needsFlightSelect ? "max-w-2xl" : "max-w-lg"}>
      <div className="space-y-5">
        {/* 기본 정보 */}
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px]">
            <div className="flex justify-between">
              <span className="text-gray-400">부서</span>
              <span className="font-medium text-gray-700">{metadata.department}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">레이더</span>
              <span className="font-medium text-gray-700">{radarName}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">기관</span>
              <span className="font-medium text-gray-700">{metadata.organization}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">작성자</span>
              <span className="font-medium text-gray-700">{metadata.author || "—"}</span>
            </div>
          </div>
          <p className="mt-2 text-[10px] text-gray-400">
            메타데이터는 사이드바 하단에서 수정할 수 있습니다
          </p>
        </div>

        {/* 데이터 요약 */}
        <div className="flex gap-3">
          <SummaryPill label="분석 비행" value={flights.length} />
          <SummaryPill label="소실 건수" value={totalLoss} accent />
          <SummaryPill label="평균 소실율" value={`${avgLossPercent.toFixed(1)}%`} accent />
          <SummaryPill label="LOS" value={`${losResults.length}건`} />
        </div>

        {/* 비행 선택 영역 (건별/단일 모드) */}
        {needsFlightSelect && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-700">
                {isFlightsMode ? "비행 선택 (다중)" : "비행 선택 (1건)"}
              </h3>
              {isFlightsMode && (
                <div className="flex gap-2">
                  <button
                    onClick={() => setCheckedIds(new Set(flights.map((f) => f.id)))}
                    className="text-[11px] text-[#a60739] hover:underline"
                  >
                    전체 선택
                  </button>
                  <button
                    onClick={() => setCheckedIds(new Set())}
                    className="text-[11px] text-gray-400 hover:underline"
                  >
                    전체 해제
                  </button>
                </div>
              )}
            </div>

            <div className="max-h-52 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-2">
              {flights.map((f) => {
                const label = flightLabel(f, aircraft);
                const isChecked = isFlightsMode ? checkedIds.has(f.id) : radioId === f.id;
                return (
                  <button
                    key={f.id}
                    onClick={() => {
                      if (isFlightsMode) {
                        setCheckedIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(f.id)) next.delete(f.id);
                          else next.add(f.id);
                          return next;
                        });
                      } else {
                        setRadioId(f.id);
                      }
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-md border px-3 py-2 text-left transition-all ${
                      isChecked
                        ? "border-[#a60739]/30 bg-[#a60739]/5"
                        : "border-gray-100 hover:border-gray-200"
                    }`}
                  >
                    {isFlightsMode ? (
                      isChecked
                        ? <CheckSquare size={14} className="shrink-0 text-[#a60739]" />
                        : <Square size={14} className="shrink-0 text-gray-300" />
                    ) : (
                      <div className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
                        isChecked ? "border-[#a60739]" : "border-gray-300"
                      }`}>
                        {isChecked && <div className="h-2 w-2 rounded-full bg-[#a60739]" />}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <span className={`text-[12px] font-medium ${isChecked ? "text-gray-800" : "text-gray-500"}`}>
                        {label}
                      </span>
                      <span className="ml-2 text-[10px] text-gray-400">
                        {format(new Date(f.start_time * 1000), "MM-dd HH:mm")}~{format(new Date(f.end_time * 1000), "HH:mm")}
                      </span>
                    </div>
                    <div className="flex shrink-0 gap-2 text-[10px]">
                      <span className="text-gray-400">{f.track_points.length.toLocaleString()}pt</span>
                      <span className={f.loss_percentage > 5 ? "font-semibold text-red-600" : f.loss_percentage > 1 ? "text-yellow-600" : "text-green-600"}>
                        {f.loss_percentage.toFixed(1)}%
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>

            {isFlightsMode && (
              <p className="mt-1 text-[10px] text-gray-400">
                {checkedIds.size}건 선택됨
              </p>
            )}
          </div>
        )}

        {/* 포함 섹션 */}
        <div>
          <h3 className="mb-2 text-sm font-semibold text-gray-700">포함 항목</h3>
          <div className="space-y-1.5">
            {sectionItems.map(({ key, label, icon: Icon, desc, available }) => (
              <button
                key={key}
                onClick={() => available && setSections((s) => ({ ...s, [key]: !s[key] }))}
                disabled={!available}
                className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all ${
                  !available
                    ? "border-gray-100 bg-gray-50 opacity-40 cursor-not-allowed"
                    : sections[key]
                    ? "border-[#a60739]/30 bg-[#a60739]/5"
                    : "border-gray-200 hover:border-gray-300"
                }`}
              >
                {sections[key] && available ? (
                  <CheckSquare size={16} className="shrink-0 text-[#a60739]" />
                ) : (
                  <Square size={16} className="shrink-0 text-gray-300" />
                )}
                <Icon size={14} className={`shrink-0 ${sections[key] && available ? "text-[#a60739]" : "text-gray-400"}`} />
                <div className="min-w-0">
                  <span className={`text-sm font-medium ${sections[key] && available ? "text-gray-800" : "text-gray-500"}`}>{label}</span>
                  <span className="ml-2 text-[11px] text-gray-400">{desc}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* 생성 버튼 */}
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
          >
            취소
          </button>
          <button
            onClick={() => onGenerate(
              template,
              sections,
              isFlightsMode ? checkedIds : undefined,
              isSingleMode ? radioId : undefined,
            )}
            disabled={!canGenerate}
            className="flex items-center gap-2 rounded-lg bg-[#a60739] px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-[#85062e] disabled:opacity-40"
          >
            <Eye size={14} />
            보고서 생성
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── 작은 UI 컴포넌트 ──

function SummaryPill({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
}) {
  return (
    <div className="flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-center">
      <p className="text-[10px] text-gray-400">{label}</p>
      <p className={`text-sm font-bold ${accent ? "text-[#a60739]" : "text-gray-800"}`}>
        {value}
      </p>
    </div>
  );
}
