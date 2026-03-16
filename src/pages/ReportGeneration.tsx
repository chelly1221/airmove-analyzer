import { useState, useRef, useCallback } from "react";
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
} from "lucide-react";
import { format } from "date-fns";
import { useAppStore } from "../store";
import Modal from "../components/common/Modal";
import ReportPage from "../components/Report/ReportPage";
import ReportCoverPage from "../components/Report/ReportCoverPage";
import ReportSummarySection from "../components/Report/ReportSummarySection";
import ReportMapSection from "../components/Report/ReportMapSection";
import ReportStatsSection from "../components/Report/ReportStatsSection";
import ReportLOSSection from "../components/Report/ReportLOSSection";
import ReportAircraftSection from "../components/Report/ReportAircraftSection";
import ReportWeatherSection from "../components/Report/ReportWeatherSection";
import { useReportExport } from "../components/Report/useReportExport";
import type { Flight, LOSProfileData, WeatherSnapshot, Aircraft as AircraftType, ReportMetadata } from "../types";

type ReportTemplate = "weekly" | "monthly";
type ReportMode = "config" | "preview";

interface ReportSections {
  cover: boolean;
  summary: boolean;
  trackMap: boolean;
  stats: boolean;
  weather: boolean;
  los: boolean;
  aircraft: boolean;
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
  const [sections, setSections] = useState<ReportSections>({
    cover: true,
    summary: true,
    trackMap: true,
    stats: true,
    weather: true,
    los: true,
    aircraft: true,
  });
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mapImage, setMapImage] = useState<string | null>(null);

  // 템플릿 모달
  const [templateModalOpen, setTemplateModalOpen] = useState<ReportTemplate | null>(null);

  // 편집 가능 텍스트 상태
  const templateLabel = template === "weekly" ? "주간" : "월간";
  const [coverTitle, setCoverTitle] = useState(`비행검사 ${templateLabel} 보고서`);
  const [coverSubtitle, setCoverSubtitle] = useState(
    template === "weekly"
      ? `${format(new Date(), "yyyy년 MM월 dd일")} 기준 주간 보고`
      : `${format(new Date(), "yyyy년 MM월")} 보고`
  );

  const avgLossPercent =
    flights.length > 0
      ? flights.reduce((s, r) => s + r.loss_percentage, 0) / flights.length
      : 0;
  const [commentary, setCommentary] = useState(() => {
    const grade = avgLossPercent < 1 ? "양호" : avgLossPercent < 5 ? "주의" : "경고";
    return `금${template === "weekly" ? "주" : "월"} 비행검사 항적 분석 결과, 평균 소실율은 ${avgLossPercent.toFixed(1)}%로 종합 판정 '${grade}' 수준입니다. 특이사항 없음.`;
  });

  const previewRef = useRef<HTMLDivElement>(null);
  const { exportPDF } = useReportExport();

  // 맵 캡처
  const captureMap = useCallback((): Promise<string | null> => {
    return new Promise((resolve) => {
      const mapContainer = document.querySelector(".maplibregl-map");
      if (!mapContainer) { resolve(null); return; }

      const map = (window as any).__maplibreInstance;
      if (map && flights.length > 0) {
        let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
        let hasPoints = false;
        for (const f of flights) {
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
  }, [flights]);

  // 보고서 생성 (config → preview)
  const handleGenerate = useCallback(async (tpl: ReportTemplate, sects: ReportSections) => {
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

    if (sects.trackMap) {
      const img = await captureMap();
      setMapImage(img);
    }

    setTemplate(tpl);
    setSections(sects);
    setTemplateModalOpen(null);
    setMode("preview");
  }, [avgLossPercent, captureMap]);

  // PDF 내보내기
  const handleExportPDF = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const dateStr = format(new Date(), "yyyyMMdd_HHmmss");
      const filename = `비행검사_${templateLabel}_보고서_${dateStr}.pdf`;
      const result = await exportPDF(previewRef, filename);
      if (!result.success && result.error && result.error !== "저장이 취소되었습니다") {
        setError(result.error);
      }
    } catch (err) {
      setError(`PDF 내보내기 실패: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGenerating(false);
    }
  }, [templateLabel, exportPDF]);

  // 활성 섹션 번호 계산
  const sectionNumbers: Record<string, number> = {};
  let num = 1;
  if (sections.summary) sectionNumbers.summary = num++;
  if (sections.trackMap) sectionNumbers.trackMap = num++;
  if (sections.stats && flights.length > 0) sectionNumbers.stats = num++;
  if (sections.weather && weatherData) sectionNumbers.weather = num++;
  if (sections.los && losResults.length > 0) sectionNumbers.los = num++;
  if (sections.aircraft && aircraft.length > 0) sectionNumbers.aircraft = num++;

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
            type="weekly"
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
            type="monthly"
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
            onClose={() => setTemplateModalOpen(null)}
            onGenerate={handleGenerate}
          />
        )}
      </div>
    );
  }

  // ── 미리보기 모드 (Preview) ──
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
          {[
            { key: "cover" as const, label: "표지" },
            { key: "summary" as const, label: "요약" },
            { key: "trackMap" as const, label: "지도" },
            { key: "stats" as const, label: "통계" },
            { key: "weather" as const, label: "기상" },
            { key: "los" as const, label: "LOS" },
            { key: "aircraft" as const, label: "검사기" },
          ].map((s) => (
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
  type: ReportTemplate;
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
  onClose: () => void;
  onGenerate: (tpl: ReportTemplate, sections: ReportSections) => void;
}) {
  const templateLabel = template === "weekly" ? "주간" : "월간";
  const [sections, setSections] = useState<ReportSections>({
    cover: true,
    summary: true,
    trackMap: true,
    stats: true,
    weather: true,
    los: true,
    aircraft: true,
  });

  const totalLoss = flights.reduce((s, r) => s + r.loss_points.length, 0);
  const avgLossPercent =
    flights.length > 0
      ? flights.reduce((s, r) => s + r.loss_percentage, 0) / flights.length
      : 0;

  const sectionItems: { key: keyof ReportSections; label: string; icon: typeof Map; desc: string; available: boolean }[] = [
    { key: "cover", label: "표지", icon: FileText, desc: "문서번호, 시행일자, 레이더명", available: true },
    { key: "summary", label: "분석 요약", icon: BarChart3, desc: "KPI 그리드, 종합 판정, 소견", available: true },
    { key: "trackMap", label: "항적 지도", icon: Map, desc: "항적 경로 및 Loss 구간 시각화", available: true },
    { key: "stats", label: "분석 통계", icon: BarChart3, desc: `비행별 상세 ${template === "weekly" ? "통계" : "추이 차트"}`, available: flights.length > 0 },
    { key: "weather", label: "기상 분석", icon: Cloud, desc: "기상 조건 및 영향 분석", available: !!weatherData },
    { key: "los", label: "LOS 분석", icon: Crosshair, desc: "전파 가시선 차단 분석", available: losResults.length > 0 },
    { key: "aircraft", label: "검사기 현황", icon: Plane, desc: "비행검사기 운용 현황", available: aircraft.length > 0 },
  ];

  return (
    <Modal open onClose={onClose} title={`${templateLabel} 보고서 설정`} width="max-w-lg">
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
            onClick={() => onGenerate(template, sections)}
            className="flex items-center gap-2 rounded-lg bg-[#a60739] px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-[#85062e]"
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
