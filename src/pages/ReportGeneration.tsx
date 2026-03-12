import { useState, useRef } from "react";
import {
  FileText,
  Download,
  Loader2,
  Map,
  BarChart3,
  Table,
  CheckSquare,
  Square,
} from "lucide-react";
import { format } from "date-fns";
import { jsPDF } from "jspdf";
import html2canvas from "html2canvas";
import { SimpleCard } from "../components/common/Card";
import { useAppStore } from "../store";

interface ReportOptions {
  includeMap: boolean;
  includeStats: boolean;
  includeLossTable: boolean;
}

export default function ReportGeneration() {
  const analysisResults = useAppStore((s) => s.analysisResults);
  const aircraft = useAppStore((s) => s.aircraft);

  const [options, setOptions] = useState<ReportOptions>({
    includeMap: true,
    includeStats: true,
    includeLossTable: true,
  });
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const totalLoss = analysisResults.reduce(
    (sum, r) => sum + r.loss_segments.length,
    0
  );
  const avgLossPercent =
    analysisResults.length > 0
      ? analysisResults.reduce((sum, r) => sum + r.loss_percentage, 0) /
        analysisResults.length
      : 0;

  const allLoss = analysisResults.flatMap((r) =>
    r.loss_segments.map((seg) => ({
      filename: r.file_info.filename,
      segment: seg,
    }))
  );

  const handleGeneratePDF = async () => {
    if (!previewRef.current) return;
    setGenerating(true);
    setError(null);

    try {
      const canvas = await html2canvas(previewRef.current, {
        backgroundColor: "#1a1a2e",
        scale: 2,
        useCORS: true,
        logging: false,
      });

      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF({
        orientation: "portrait",
        unit: "mm",
        format: "a4",
      });

      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const imgWidth = pageWidth - 20;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;

      let yPos = 10;
      if (imgHeight <= pageHeight - 20) {
        pdf.addImage(imgData, "PNG", 10, yPos, imgWidth, imgHeight);
      } else {
        // 여러 페이지로 분할
        let remainingHeight = imgHeight;
        let sourceY = 0;
        while (remainingHeight > 0) {
          const sliceHeight = Math.min(
            remainingHeight,
            pageHeight - 20
          );
          const sliceRatio = sliceHeight / imgHeight;
          const sourceHeight = canvas.height * sliceRatio;

          const sliceCanvas = document.createElement("canvas");
          sliceCanvas.width = canvas.width;
          sliceCanvas.height = sourceHeight;
          const ctx = sliceCanvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(
              canvas,
              0,
              sourceY,
              canvas.width,
              sourceHeight,
              0,
              0,
              canvas.width,
              sourceHeight
            );
            const sliceData = sliceCanvas.toDataURL("image/png");
            pdf.addImage(sliceData, "PNG", 10, 10, imgWidth, sliceHeight);
          }

          remainingHeight -= sliceHeight;
          sourceY += sourceHeight;

          if (remainingHeight > 0) {
            pdf.addPage();
          }
        }
      }

      const now = format(new Date(), "yyyyMMdd_HHmmss");
      pdf.save(`NEC_레이더분석_보고서_${now}.pdf`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("PDF 생성 오류:", msg);
      setError(`PDF 생성 실패: ${msg}`);
    } finally {
      setGenerating(false);
    }
  };

  const ToggleOption = ({
    label,
    icon: Icon,
    checked,
    onChange,
  }: {
    label: string;
    icon: typeof Map;
    checked: boolean;
    onChange: () => void;
  }) => (
    <button
      onClick={onChange}
      className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-sm transition-all ${
        checked
          ? "border-[#e94560]/50 bg-[#e94560]/10 text-white"
          : "border-white/10 text-gray-400 hover:border-white/20"
      }`}
    >
      {checked ? (
        <CheckSquare size={18} className="text-[#e94560]" />
      ) : (
        <Square size={18} />
      )}
      <Icon size={16} />
      <span>{label}</span>
    </button>
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">보고서 생성</h1>
          <p className="mt-1 text-sm text-gray-400">
            분석 결과를 PDF 보고서로 생성합니다
          </p>
        </div>
        <button
          onClick={handleGeneratePDF}
          disabled={generating || analysisResults.length === 0}
          className="flex items-center gap-2 rounded-lg bg-[#e94560] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#d63851] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {generating ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Download size={16} />
          )}
          <span>{generating ? "생성 중..." : "PDF 다운로드"}</span>
        </button>
      </div>

      {/* Options */}
      <SimpleCard>
        <h2 className="mb-3 text-base font-semibold text-white">
          보고서 옵션
        </h2>
        <div className="flex flex-wrap gap-3">
          <ToggleOption
            label="지도 스크린샷"
            icon={Map}
            checked={options.includeMap}
            onChange={() =>
              setOptions((o) => ({ ...o, includeMap: !o.includeMap }))
            }
          />
          <ToggleOption
            label="분석 통계"
            icon={BarChart3}
            checked={options.includeStats}
            onChange={() =>
              setOptions((o) => ({ ...o, includeStats: !o.includeStats }))
            }
          />
          <ToggleOption
            label="Loss 상세 테이블"
            icon={Table}
            checked={options.includeLossTable}
            onChange={() =>
              setOptions((o) => ({
                ...o,
                includeLossTable: !o.includeLossTable,
              }))
            }
          />
        </div>
      </SimpleCard>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3">
          <span className="text-sm text-red-400">{error}</span>
          <button
            onClick={() => setError(null)}
            className="ml-auto text-xs text-red-400/60 hover:text-red-400"
          >
            닫기
          </button>
        </div>
      )}

      {/* Preview */}
      <div>
        <h2 className="mb-3 text-base font-semibold text-white">
          보고서 미리보기
        </h2>
        <div className="overflow-auto rounded-xl border border-white/10">
          <div
            ref={previewRef}
            className="min-w-[600px] bg-[#1a1a2e] p-8"
            style={{ fontFamily: "sans-serif" }}
          >
            {/* Report Title */}
            <div className="border-b border-white/20 pb-6 mb-6">
              <h1 className="text-xl font-bold text-white">
                NEC 레이더 비행검사기 분석 보고서
              </h1>
              <p className="mt-2 text-sm text-gray-400">
                생성 일시: {format(new Date(), "yyyy년 MM월 dd일 HH:mm:ss")}
              </p>
              <p className="text-sm text-gray-400">
                분석 파일 수: {analysisResults.length}개
              </p>
            </div>

            {/* Registered Aircraft */}
            {aircraft.length > 0 && (
              <div className="mb-6">
                <h2 className="mb-3 text-base font-semibold text-[#e94560]">
                  등록 비행검사기
                </h2>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-white/20 text-gray-400">
                      <th className="pb-2 text-left">기체명</th>
                      <th className="pb-2 text-left">Mode-S</th>
                      <th className="pb-2 text-left">운용기관</th>
                      <th className="pb-2 text-left">상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {aircraft.map((a) => (
                      <tr
                        key={a.id}
                        className="border-b border-white/5 text-gray-300"
                      >
                        <td className="py-1.5">{a.name}</td>
                        <td className="py-1.5 font-mono">{a.mode_s_code}</td>
                        <td className="py-1.5">{a.organization}</td>
                        <td className="py-1.5">
                          {a.active ? "활성" : "비활성"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Stats */}
            {options.includeStats && (
              <div className="mb-6">
                <h2 className="mb-3 text-base font-semibold text-[#e94560]">
                  분석 통계
                </h2>
                <div className="grid grid-cols-4 gap-3">
                  <div className="rounded-lg border border-white/10 bg-[#16213e] p-3 text-center">
                    <p className="text-xs text-gray-500">분석 파일</p>
                    <p className="text-lg font-bold text-white">
                      {analysisResults.length}
                    </p>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-[#16213e] p-3 text-center">
                    <p className="text-xs text-gray-500">Loss 건수</p>
                    <p className="text-lg font-bold text-[#e94560]">
                      {totalLoss}
                    </p>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-[#16213e] p-3 text-center">
                    <p className="text-xs text-gray-500">평균 Loss율</p>
                    <p className="text-lg font-bold text-yellow-400">
                      {avgLossPercent.toFixed(1)}%
                    </p>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-[#16213e] p-3 text-center">
                    <p className="text-xs text-gray-500">총 추적시간</p>
                    <p className="text-lg font-bold text-white">
                      {(
                        analysisResults.reduce(
                          (s, r) => s + r.total_track_time,
                          0
                        ) / 60
                      ).toFixed(1)}
                      분
                    </p>
                  </div>
                </div>

                {/* Per-file summary */}
                <div className="mt-4">
                  <h3 className="mb-2 text-sm font-medium text-gray-300">
                    파일별 요약
                  </h3>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-white/20 text-gray-400">
                        <th className="pb-2 text-left">파일명</th>
                        <th className="pb-2 text-right">레코드</th>
                        <th className="pb-2 text-right">Loss 건수</th>
                        <th className="pb-2 text-right">Loss 시간(초)</th>
                        <th className="pb-2 text-right">Loss율(%)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analysisResults.map((r, idx) => (
                        <tr
                          key={`summary-${idx}`}
                          className="border-b border-white/5 text-gray-300"
                        >
                          <td className="py-1.5">{r.file_info.filename}</td>
                          <td className="py-1.5 text-right">
                            {r.file_info.total_records}
                          </td>
                          <td className="py-1.5 text-right">
                            {r.loss_segments.length}
                          </td>
                          <td className="py-1.5 text-right">
                            {r.total_loss_time.toFixed(1)}
                          </td>
                          <td className="py-1.5 text-right">
                            <span
                              className={
                                r.loss_percentage > 5
                                  ? "text-[#e94560]"
                                  : "text-green-400"
                              }
                            >
                              {r.loss_percentage.toFixed(1)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Map placeholder */}
            {options.includeMap && (
              <div className="mb-6">
                <h2 className="mb-3 text-base font-semibold text-[#e94560]">
                  항적 지도
                </h2>
                <div className="flex h-40 items-center justify-center rounded-lg border border-white/10 bg-[#0f3460]/30">
                  <div className="text-center text-gray-500">
                    <Map size={32} className="mx-auto mb-2 opacity-50" />
                    <p className="text-xs">
                      지도 캡처는 항적 지도 페이지에서 확인하세요
                    </p>
                    <p className="text-xs mt-0.5">
                      (PDF에는 현재 페이지의 레이아웃이 포함됩니다)
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Loss Table */}
            {options.includeLossTable && allLoss.length > 0 && (
              <div className="mb-6">
                <h2 className="mb-3 text-base font-semibold text-[#e94560]">
                  Loss 구간 상세
                </h2>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-white/20 text-gray-400">
                      <th className="pb-2 text-left">#</th>
                      <th className="pb-2 text-left">Mode-S</th>
                      <th className="pb-2 text-left">파일</th>
                      <th className="pb-2 text-left">시작 시각</th>
                      <th className="pb-2 text-left">종료 시각</th>
                      <th className="pb-2 text-right">지속시간(초)</th>
                      <th className="pb-2 text-right">거리(km)</th>
                      <th className="pb-2 text-right">고도(m)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allLoss.map((item, idx) => (
                      <tr
                        key={`loss-tbl-${idx}`}
                        className="border-b border-white/5 text-gray-300"
                      >
                        <td className="py-1 text-gray-500">{idx + 1}</td>
                        <td className="py-1 font-mono">{item.segment.mode_s}</td>
                        <td className="py-1">{item.filename}</td>
                        <td className="py-1">
                          {format(
                            new Date(item.segment.start_time * 1000),
                            "MM-dd HH:mm:ss"
                          )}
                        </td>
                        <td className="py-1">
                          {format(
                            new Date(item.segment.end_time * 1000),
                            "HH:mm:ss"
                          )}
                        </td>
                        <td className="py-1 text-right">
                          {item.segment.duration_secs.toFixed(1)}
                        </td>
                        <td className="py-1 text-right">
                          {item.segment.distance_km.toFixed(2)}
                        </td>
                        <td className="py-1 text-right">
                          {item.segment.last_altitude.toFixed(0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Footer */}
            <div className="border-t border-white/20 pt-4 text-center">
              <p className="text-xs text-gray-600">
                NEC 레이더 비행검사기 분석체계 (AirMove Analyzer) - 자동 생성
                보고서
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* No data notice */}
      {analysisResults.length === 0 && (
        <div className="flex flex-col items-center rounded-xl border border-white/10 bg-[#16213e] py-12">
          <FileText size={40} className="mb-3 text-gray-600" />
          <p className="text-sm text-gray-400">
            보고서를 생성하려면 먼저 자료를 업로드하고 파싱하세요
          </p>
        </div>
      )}
    </div>
  );
}
