import { useState, useRef, useCallback } from "react";
import {
  FileText,
  Download,
  Loader2,
  CheckSquare,
  Square,
  Map,
  BarChart3,
  Table,
  Crosshair,
  ArrowLeft,
  Eye,
  Plane,
} from "lucide-react";
import { format } from "date-fns";
import { SimpleCard } from "../components/common/Card";
import { useAppStore } from "../store";
import ReportPage from "../components/Report/ReportPage";
import ReportCoverPage from "../components/Report/ReportCoverPage";
import ReportSummarySection from "../components/Report/ReportSummarySection";
import ReportMapSection from "../components/Report/ReportMapSection";
import ReportStatsSection from "../components/Report/ReportStatsSection";
import ReportLossSection from "../components/Report/ReportLossSection";
import ReportLOSSection from "../components/Report/ReportLOSSection";
import ReportAircraftSection from "../components/Report/ReportAircraftSection";
import { useReportExport } from "../components/Report/useReportExport";

type ReportTemplate = "weekly" | "monthly";
type ReportMode = "config" | "preview";

interface ReportSections {
  cover: boolean;
  summary: boolean;
  trackMap: boolean;
  stats: boolean;
  lossDetail: boolean;
  los: boolean;
  aircraft: boolean;
}

export default function ReportGeneration() {
  const flights = useAppStore((s) => s.flights);
  const aircraft = useAppStore((s) => s.aircraft);
  const losResults = useAppStore((s) => s.losResults);
  const radarSite = useAppStore((s) => s.radarSite);

  const [mode, setMode] = useState<ReportMode>("config");
  const [template, setTemplate] = useState<ReportTemplate>("weekly");
  const [sections, setSections] = useState<ReportSections>({
    cover: true,
    summary: true,
    trackMap: true,
    stats: true,
    lossDetail: true,
    los: true,
    aircraft: true,
  });
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mapImage, setMapImage] = useState<string | null>(null);

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

  // 맵 캡처 (항적 범위로 뷰포트 맞춤 후 캡처)
  const captureMap = useCallback((): Promise<string | null> => {
    return new Promise((resolve) => {
      const mapContainer = document.querySelector(".maplibregl-map");
      if (!mapContainer) { resolve(null); return; }

      // 맵 인스턴스를 통해 항적 범위로 뷰포트 이동
      const map = (window as any).__maplibreInstance;
      if (map && flights.length > 0) {
        // 모든 항적 포인트의 bounds 계산
        let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
        for (const f of flights) {
          for (const p of f.track_points) {
            if (p.latitude < minLat) minLat = p.latitude;
            if (p.latitude > maxLat) maxLat = p.latitude;
            if (p.longitude < minLon) minLon = p.longitude;
            if (p.longitude > maxLon) maxLon = p.longitude;
          }
        }
        if (minLat < maxLat && minLon < maxLon) {
          map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 60, duration: 0 });
        }
      }

      // 렌더링 대기 후 캡처
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
  const handleGenerate = useCallback(async () => {
    // 제목/부제 업데이트
    const label = template === "weekly" ? "주간" : "월간";
    setCoverTitle(`비행검사 ${label} 보고서`);
    setCoverSubtitle(
      template === "weekly"
        ? `${format(new Date(), "yyyy년 MM월 dd일")} 기준 주간 보고`
        : `${format(new Date(), "yyyy년 MM월")} 보고`
    );

    // 코멘트 업데이트
    const grade = avgLossPercent < 1 ? "양호" : avgLossPercent < 5 ? "주의" : "경고";
    setCommentary(
      `금${template === "weekly" ? "주" : "월"} 비행검사 항적 분석 결과, 평균 소실율은 ${avgLossPercent.toFixed(1)}%로 종합 판정 '${grade}' 수준입니다. 특이사항 없음.`
    );

    // 맵 캡처 (항적 범위로 뷰포트 맞춤 후 비동기 캡처)
    if (sections.trackMap) {
      const img = await captureMap();
      setMapImage(img);
    }

    setMode("preview");
  }, [template, avgLossPercent, sections.trackMap, captureMap]);

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
  if (sections.lossDetail && flights.some((r) => r.loss_segments.length > 0)) sectionNumbers.lossDetail = num++;
  if (sections.los && losResults.length > 0) sectionNumbers.los = num++;
  if (sections.aircraft && aircraft.length > 0) sectionNumbers.aircraft = num++;

  // ── 설정 모드 (Config) ──
  if (mode === "config") {
    const totalLoss = flights.reduce((s, r) => s + r.loss_segments.length, 0);
    const allLossCount = flights.flatMap((r) => r.loss_segments).length;

    return (
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-800">보고서 생성</h1>
            <p className="mt-1 text-sm text-gray-500">
              분석 결과를 공공기관 양식 PDF 보고서로 생성합니다
            </p>
          </div>
          <button
            onClick={handleGenerate}
            disabled={flights.length === 0}
            className="flex items-center gap-2 rounded-lg bg-[#a60739] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#85062e] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Eye size={16} />
            <span>보고서 생성</span>
          </button>
        </div>

        {/* Template selector */}
        <SimpleCard>
          <h2 className="mb-3 text-base font-semibold text-gray-800">보고서 템플릿</h2>
          <div className="flex gap-3">
            <button
              onClick={() => setTemplate("weekly")}
              className={`flex-1 rounded-lg border px-4 py-3 text-sm font-medium transition-all ${
                template === "weekly"
                  ? "border-[#a60739] bg-[#a60739] text-white"
                  : "border-gray-200 text-gray-500 hover:border-gray-300"
              }`}
            >
              <div className="text-base font-bold">주간 보고서</div>
              <p className="mt-1 text-xs opacity-60">주간 비행검사 결과 상세 보고</p>
            </button>
            <button
              onClick={() => setTemplate("monthly")}
              className={`flex-1 rounded-lg border px-4 py-3 text-sm font-medium transition-all ${
                template === "monthly"
                  ? "border-[#a60739] bg-[#a60739] text-white"
                  : "border-gray-200 text-gray-500 hover:border-gray-300"
              }`}
            >
              <div className="text-base font-bold">월간 보고서</div>
              <p className="mt-1 text-xs opacity-60">월간 요약 통계 및 주요 소실 보고</p>
            </button>
          </div>
        </SimpleCard>

        {/* Section toggles */}
        <SimpleCard>
          <h2 className="mb-3 text-base font-semibold text-gray-800">포함 항목</h2>
          <div className="flex flex-wrap gap-3">
            <SectionToggle label="표지" icon={FileText} checked={sections.cover}
              onChange={() => setSections((s) => ({ ...s, cover: !s.cover }))} />
            <SectionToggle label="요약" icon={BarChart3} checked={sections.summary}
              onChange={() => setSections((s) => ({ ...s, summary: !s.summary }))} />
            <SectionToggle label="항적 지도" icon={Map} checked={sections.trackMap}
              onChange={() => setSections((s) => ({ ...s, trackMap: !s.trackMap }))} />
            <SectionToggle label="분석 통계" icon={BarChart3} checked={sections.stats}
              onChange={() => setSections((s) => ({ ...s, stats: !s.stats }))} />
            <SectionToggle label="소실 상세" icon={Table} checked={sections.lossDetail}
              onChange={() => setSections((s) => ({ ...s, lossDetail: !s.lossDetail }))} />
            <SectionToggle label="LOS 분석" icon={Crosshair} checked={sections.los}
              onChange={() => setSections((s) => ({ ...s, los: !s.los }))} />
            <SectionToggle label="검사기 현황" icon={Plane} checked={sections.aircraft}
              onChange={() => setSections((s) => ({ ...s, aircraft: !s.aircraft }))} />
          </div>
        </SimpleCard>

        {/* Preview summary */}
        <SimpleCard>
          <h2 className="mb-3 text-base font-semibold text-gray-800">보고서 요약</h2>
          <div className="grid grid-cols-4 gap-3">
            <SummaryCard label="분석 비행" value={flights.length} />
            <SummaryCard label="소실 건수" value={totalLoss} accent />
            <SummaryCard label="평균 소실율" value={`${avgLossPercent.toFixed(1)}%`} accent />
            <SummaryCard label="LOS 분석" value={`${losResults.length}건`} />
          </div>
          {template === "monthly" && allLossCount > 20 && (
            <p className="mt-3 text-xs text-gray-400">
              월간 보고서: 소실 상세는 상위 20건만 포함됩니다 (전체 {allLossCount}건)
            </p>
          )}
        </SimpleCard>

        {/* No data */}
        {flights.length === 0 && (
          <div className="flex flex-col items-center rounded-xl border border-gray-200 bg-gray-50 py-12">
            <FileText size={40} className="mb-3 text-gray-600" />
            <p className="text-sm text-gray-500">
              보고서를 생성하려면 먼저 자료를 업로드하고 파싱하세요
            </p>
          </div>
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
            { key: "lossDetail" as const, label: "소실" },
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

        {/* 에러 표시 */}
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
        {/* 표지 */}
        {sections.cover && (
          <ReportCoverPage
            template={template}
            radarName={radarSite.name}
            editable
            title={coverTitle}
            onTitleChange={setCoverTitle}
            subtitle={coverSubtitle}
            onSubtitleChange={setCoverSubtitle}
          />
        )}

        {/* 요약 + 항적지도 */}
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

        {/* 분석 통계 (별도 페이지) */}
        {sections.stats && flights.length > 0 && (
          <ReportPage>
            <ReportStatsSection
              sectionNum={sectionNumbers.stats ?? 3}
              flights={flights}
              template={template}
            />
          </ReportPage>
        )}

        {/* 소실 상세 (별도 페이지) */}
        {sections.lossDetail && flights.some((r) => r.loss_segments.length > 0) && (
          <ReportPage>
            <ReportLossSection
              sectionNum={sectionNumbers.lossDetail ?? 4}
              flights={flights}
              template={template}
            />
          </ReportPage>
        )}

        {/* LOS 분석 (별도 페이지) */}
        {sections.los && losResults.length > 0 && (
          <ReportPage>
            <ReportLOSSection
              sectionNum={sectionNumbers.los ?? 5}
              losResults={losResults}
            />
          </ReportPage>
        )}

        {/* 검사기 현황 (별도 페이지) */}
        {sections.aircraft && aircraft.length > 0 && (
          <ReportPage>
            <ReportAircraftSection
              sectionNum={sectionNumbers.aircraft ?? 6}
              aircraft={aircraft}
            />

            {/* 하단 */}
            <div className="absolute bottom-[20mm] left-[20mm] right-[20mm]">
              <div className="border-t-[2px] border-gray-300" />
              <p className="mt-2 text-center text-[9px] text-gray-400">
                비행검사기 항적 분석 체계 - 자동 생성 보고서
              </p>
            </div>
          </ReportPage>
        )}
      </div>
    </div>
  );
}

// ── 작은 UI 컴포넌트 ──

function SectionToggle({
  label,
  icon: Icon,
  checked,
  onChange,
}: {
  label: string;
  icon: typeof Map;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <button
      onClick={onChange}
      className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-sm transition-all ${
        checked
          ? "border-[#a60739] bg-[#a60739] text-white"
          : "border-gray-200 text-gray-500 hover:border-gray-300"
      }`}
    >
      {checked ? <CheckSquare size={18} /> : <Square size={18} />}
      <Icon size={16} />
      <span>{label}</span>
    </button>
  );
}

function SummaryCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-100 p-3 text-center">
      <p className="text-xs text-gray-400">{label}</p>
      <p className={`text-lg font-bold ${accent ? "text-[#a60739]" : "text-gray-800"}`}>
        {value}
      </p>
    </div>
  );
}
