import { useState } from "react";
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
} from "lucide-react";
import { format } from "date-fns";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { invoke } from "@tauri-apps/api/core";
import { SimpleCard } from "../components/common/Card";
import { useAppStore } from "../store";

type ReportTemplate = "weekly" | "monthly";

interface ReportOptions {
  includeMap: boolean;
  includeStats: boolean;
  includeLossTable: boolean;
  includeLOS: boolean;
}

// 한글 폰트 캐시
let cachedFontBase64: string | null = null;

async function loadKoreanFont(doc: jsPDF): Promise<boolean> {
  try {
    if (!cachedFontBase64) {
      // Windows 시스템 폰트 (맑은 고딕)에서 로드
      cachedFontBase64 = await invoke<string>("read_file_base64", {
        path: "C:\\Windows\\Fonts\\malgun.ttf",
      });
    }
    doc.addFileToVFS("MalgunGothic.ttf", cachedFontBase64);
    doc.addFont("MalgunGothic.ttf", "MalgunGothic", "normal");
    doc.setFont("MalgunGothic");
    return true;
  } catch (err) {
    console.warn("한글 폰트 로드 실패, 기본 폰트 사용:", err);
    return false;
  }
}

export default function ReportGeneration() {
  const analysisResults = useAppStore((s) => s.analysisResults);
  const aircraft = useAppStore((s) => s.aircraft);
  const losResults = useAppStore((s) => s.losResults);
  const radarSite = useAppStore((s) => s.radarSite);

  const [template, setTemplate] = useState<ReportTemplate>("weekly");
  const [options, setOptions] = useState<ReportOptions>({
    includeMap: true,
    includeStats: true,
    includeLossTable: true,
    includeLOS: true,
  });
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalLoss = analysisResults.reduce((s, r) => s + r.loss_segments.length, 0);
  const avgLossPercent =
    analysisResults.length > 0
      ? analysisResults.reduce((s, r) => s + r.loss_percentage, 0) / analysisResults.length
      : 0;

  const allLoss = analysisResults.flatMap((r) =>
    r.loss_segments
      .map((seg) => ({ filename: r.file_info.filename, segment: seg }))
  );

  // ── PDF 생성 ──
  const handleGeneratePDF = async () => {
    setGenerating(true);
    setError(null);

    try {
      const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      const hasKorean = await loadKoreanFont(doc);
      const setFont = (size: number, style: "normal" | "bold" = "normal") => {
        if (hasKorean) {
          doc.setFont("MalgunGothic", style);
        }
        doc.setFontSize(size);
      };

      const pw = doc.internal.pageSize.getWidth(); // 210
      const ph = doc.internal.pageSize.getHeight(); // 297
      const ml = 20, mr = 20, mt = 20, mb = 20;
      let y = mt;

      const checkPage = (needed: number) => {
        if (y + needed > ph - mb) {
          doc.addPage();
          y = mt;
          drawPageFooter();
        }
      };

      const drawPageFooter = () => {
        const pageNum = doc.getNumberOfPages();
        doc.setTextColor(150);
        setFont(8);
        doc.text(`- ${pageNum} -`, pw / 2, ph - 10, { align: "center" });
        doc.setTextColor(0);
      };

      const now = new Date();
      const templateLabel = template === "weekly" ? "주간" : "월간";
      const titleText = `비행검사 ${templateLabel} 보고서`;

      // ── 문서 헤더 (공공기관 스타일) ──
      doc.setDrawColor(0);
      doc.setLineWidth(0.8);
      doc.line(ml, mt, pw - mr, mt);

      y = mt + 5;
      setFont(9);
      doc.setTextColor(80);
      doc.text("비행점검센터", ml, y);
      doc.text(`문서번호: 레이더분석-${format(now, "yyyy")}-${String(now.getMonth() + 1).padStart(3, "0")}`, pw - mr, y, { align: "right" });

      y += 5;
      doc.text(`시행일자: ${format(now, "yyyy년 MM월 dd일")}`, ml, y);
      doc.text(`레이더: ${radarSite.name}`, pw - mr, y, { align: "right" });

      y += 3;
      doc.setLineWidth(0.3);
      doc.line(ml, y, pw - mr, y);

      // ── 제목 ──
      y += 10;
      setFont(18, "bold");
      doc.setTextColor(0);
      doc.text(titleText, pw / 2, y, { align: "center" });

      y += 8;
      setFont(10);
      doc.setTextColor(80);
      if (template === "weekly") {
        doc.text(`보고 기간: ${format(now, "yyyy년 MM월 dd일")} 기준 주간`, pw / 2, y, { align: "center" });
      } else {
        doc.text(`보고 기간: ${format(now, "yyyy년 MM월")}`, pw / 2, y, { align: "center" });
      }

      y += 4;
      doc.setLineWidth(0.5);
      doc.line(ml, y, pw - mr, y);
      y += 8;

      doc.setTextColor(0);

      // ── 1. 개요 ──
      setFont(12, "bold");
      doc.text("1. 개요", ml, y);
      y += 7;
      setFont(10);
      const overviewData = [
        ["분석 파일 수", `${analysisResults.length}건`],
        ["등록 비행검사기", `${aircraft.filter((a) => a.active).length}대`],
        ["총 소실 건수", `${totalLoss}건`],
        ["평균 소실율", `${avgLossPercent.toFixed(1)}%`],
        ["총 추적시간", `${(analysisResults.reduce((s, r) => s + r.total_track_time, 0) / 60).toFixed(1)}분`],
      ];
      for (const [label, value] of overviewData) {
        doc.text(`  ${label}: ${value}`, ml, y);
        y += 5;
      }
      y += 4;

      // ── 2. 비행검사기 현황 ──
      if (aircraft.length > 0) {
        checkPage(30);
        setFont(12, "bold");
        doc.text("2. 비행검사기 현황", ml, y);
        y += 3;

        autoTable(doc, {
          startY: y,
          margin: { left: ml, right: mr },
          head: [["이름", "기체 모델", "Mode-S", "운용기관", "상태"]],
          body: aircraft.map((a) => [
            a.name,
            a.model || "-",
            a.mode_s_code,
            a.organization,
            a.active ? "활성" : "비활성",
          ]),
          styles: {
            font: hasKorean ? "MalgunGothic" : "helvetica",
            fontSize: 9,
            cellPadding: 2,
            lineColor: [0, 0, 0],
            lineWidth: 0.2,
          },
          headStyles: {
            fillColor: [40, 40, 60],
            textColor: [255, 255, 255],
            fontStyle: "bold",
          },
          alternateRowStyles: { fillColor: [245, 245, 250] },
        });
        y = (doc as any).lastAutoTable.finalY + 8;
      }

      // ── 3. 분석 통계 ──
      if (options.includeStats && analysisResults.length > 0) {
        checkPage(40);
        setFont(12, "bold");
        doc.text(aircraft.length > 0 ? "3. 분석 통계" : "2. 분석 통계", ml, y);
        y += 3;

        autoTable(doc, {
          startY: y,
          margin: { left: ml, right: mr },
          head: [["파일명", "레코드", "소실 건수", "소실 시간(초)", "소실율(%)"]],
          body: analysisResults.map((r) => [
            r.file_info.filename,
            r.file_info.total_records.toString(),
            r.loss_segments.length.toString(),
            r.total_loss_time.toFixed(1),
            r.loss_percentage.toFixed(1),
          ]),
          styles: {
            font: hasKorean ? "MalgunGothic" : "helvetica",
            fontSize: 9,
            cellPadding: 2,
            lineColor: [0, 0, 0],
            lineWidth: 0.2,
          },
          headStyles: {
            fillColor: [40, 40, 60],
            textColor: [255, 255, 255],
            fontStyle: "bold",
          },
          alternateRowStyles: { fillColor: [245, 245, 250] },
        });
        y = (doc as any).lastAutoTable.finalY + 8;
      }

      // ── 4. Loss 구간 상세 ──
      if (options.includeLossTable && allLoss.length > 0) {
        checkPage(30);
        const sectionNum = 2 + (aircraft.length > 0 ? 1 : 0) + (options.includeStats ? 1 : 0);
        setFont(12, "bold");
        doc.text(`${sectionNum}. 표적소실 구간 상세`, ml, y);
        y += 3;

        const lossRows = allLoss.map((item, idx) => [
          (idx + 1).toString(),
          item.segment.mode_s,
          item.filename,
          format(new Date(item.segment.start_time * 1000), "MM-dd HH:mm:ss"),
          format(new Date(item.segment.end_time * 1000), "MM-dd HH:mm:ss"),
          item.segment.duration_secs.toFixed(1),
          item.segment.distance_km.toFixed(2),
          item.segment.last_altitude.toFixed(0),
        ]);

        // 월간 템플릿이면 상위 20건만
        const maxRows = template === "monthly" ? 20 : lossRows.length;
        const displayRows = lossRows.slice(0, maxRows);

        autoTable(doc, {
          startY: y,
          margin: { left: ml, right: mr },
          head: [["#", "Mode-S", "파일", "시작", "종료", "지속(초)", "거리(km)", "고도(m)"]],
          body: displayRows,
          styles: {
            font: hasKorean ? "MalgunGothic" : "helvetica",
            fontSize: 8,
            cellPadding: 1.5,
            lineColor: [0, 0, 0],
            lineWidth: 0.2,
          },
          headStyles: {
            fillColor: [40, 40, 60],
            textColor: [255, 255, 255],
            fontStyle: "bold",
          },
          alternateRowStyles: { fillColor: [245, 245, 250] },
          columnStyles: {
            0: { cellWidth: 8 },
            5: { halign: "right" },
            6: { halign: "right" },
            7: { halign: "right" },
          },
        });
        y = (doc as any).lastAutoTable.finalY + 3;

        if (template === "monthly" && lossRows.length > maxRows) {
          setFont(8);
          doc.setTextColor(120);
          doc.text(`... 외 ${lossRows.length - maxRows}건 (총 ${lossRows.length}건)`, ml, y + 3);
          doc.setTextColor(0);
          y += 8;
        } else {
          y += 5;
        }
      }

      // ── 5. LOS 분석 결과 ──
      if (options.includeLOS && losResults.length > 0) {
        checkPage(30);
        const sn = 2 + (aircraft.length > 0 ? 1 : 0) + (options.includeStats ? 1 : 0) + (options.includeLossTable && allLoss.length > 0 ? 1 : 0);
        setFont(12, "bold");
        doc.text(`${sn}. LOS 분석 결과`, ml, y);
        y += 3;

        autoTable(doc, {
          startY: y,
          margin: { left: ml, right: mr },
          head: [["#", "레이더", "대상 좌표", "거리(km)", "방위(°)", "결과", "차단점"]],
          body: losResults.map((r, idx) => [
            (idx + 1).toString(),
            r.radarSiteName,
            `${r.targetLat.toFixed(4)}°N ${r.targetLon.toFixed(4)}°E`,
            r.totalDistance.toFixed(1),
            r.bearing.toFixed(0),
            r.losBlocked ? "차단" : "양호",
            r.maxBlockingPoint
              ? `${r.maxBlockingPoint.name ? r.maxBlockingPoint.name + " " : ""}${r.maxBlockingPoint.elevation.toFixed(0)}m`
              : "-",
          ]),
          styles: {
            font: hasKorean ? "MalgunGothic" : "helvetica",
            fontSize: 8,
            cellPadding: 1.5,
            lineColor: [0, 0, 0],
            lineWidth: 0.2,
          },
          headStyles: {
            fillColor: [40, 40, 60],
            textColor: [255, 255, 255],
            fontStyle: "bold",
          },
          alternateRowStyles: { fillColor: [245, 245, 250] },
        });
        y = (doc as any).lastAutoTable.finalY + 8;
      }

      // ── 결재란 ──
      checkPage(35);
      y += 5;
      doc.setLineWidth(0.3);
      const signW = 30;
      const signH = 20;
      const signLabels = ["담당", "검토", "승인"];
      const startX = pw - mr - signW * signLabels.length;
      for (let i = 0; i < signLabels.length; i++) {
        const x = startX + i * signW;
        doc.rect(x, y, signW, 8);
        doc.rect(x, y + 8, signW, signH);
        setFont(8, "bold");
        doc.text(signLabels[i], x + signW / 2, y + 5.5, { align: "center" });
      }
      y += 8 + signH + 10;

      // ── 하단 선 ──
      doc.setLineWidth(0.8);
      doc.line(ml, ph - mb - 15, pw - mr, ph - mb - 15);
      setFont(8);
      doc.setTextColor(120);
      doc.text("비행검사기 항적 분석 체계 - 자동 생성 보고서", pw / 2, ph - mb - 10, { align: "center" });
      doc.setTextColor(0);

      // 모든 페이지에 페이지 번호
      const totalPages = doc.getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);
        setFont(8);
        doc.setTextColor(150);
        doc.text(`- ${i} / ${totalPages} -`, pw / 2, ph - 8, { align: "center" });
        doc.setTextColor(0);
      }

      const dateStr = format(now, "yyyyMMdd_HHmmss");
      doc.save(`비행검사_${templateLabel}_보고서_${dateStr}.pdf`);
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
          ? "border-[#a60739]/50 bg-[#a60739]/10 text-gray-800"
          : "border-gray-200 text-gray-500 hover:border-gray-300"
      }`}
    >
      {checked ? <CheckSquare size={18} className="text-[#a60739]" /> : <Square size={18} />}
      <Icon size={16} />
      <span>{label}</span>
    </button>
  );

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
          onClick={handleGeneratePDF}
          disabled={generating || analysisResults.length === 0}
          className="flex items-center gap-2 rounded-lg bg-[#a60739] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#85062e] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {generating ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
          <span>{generating ? "생성 중..." : "PDF 다운로드"}</span>
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
                ? "border-[#a60739] bg-[#a60739]/10 text-[#a60739]"
                : "border-gray-200 text-gray-500 hover:border-gray-300"
            }`}
          >
            <div className="text-base font-bold">주간 보고서</div>
            <p className="mt-1 text-xs opacity-60">
              주간 비행검사 결과 상세 보고
            </p>
          </button>
          <button
            onClick={() => setTemplate("monthly")}
            className={`flex-1 rounded-lg border px-4 py-3 text-sm font-medium transition-all ${
              template === "monthly"
                ? "border-[#a60739] bg-[#a60739]/10 text-[#a60739]"
                : "border-gray-200 text-gray-500 hover:border-gray-300"
            }`}
          >
            <div className="text-base font-bold">월간 보고서</div>
            <p className="mt-1 text-xs opacity-60">
              월간 요약 통계 및 주요 소실 보고
            </p>
          </button>
        </div>
      </SimpleCard>

      {/* Options */}
      <SimpleCard>
        <h2 className="mb-3 text-base font-semibold text-gray-800">포함 항목</h2>
        <div className="flex flex-wrap gap-3">
          <ToggleOption label="지도 스크린샷" icon={Map} checked={options.includeMap}
            onChange={() => setOptions((o) => ({ ...o, includeMap: !o.includeMap }))} />
          <ToggleOption label="분석 통계" icon={BarChart3} checked={options.includeStats}
            onChange={() => setOptions((o) => ({ ...o, includeStats: !o.includeStats }))} />
          <ToggleOption label="소실 상세 테이블" icon={Table} checked={options.includeLossTable}
            onChange={() => setOptions((o) => ({ ...o, includeLossTable: !o.includeLossTable }))} />
          <ToggleOption label="LOS 분석" icon={Crosshair} checked={options.includeLOS}
            onChange={() => setOptions((o) => ({ ...o, includeLOS: !o.includeLOS }))} />
        </div>
      </SimpleCard>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3">
          <span className="text-sm text-red-600">{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-xs text-gray-500 hover:text-gray-900">
            닫기
          </button>
        </div>
      )}

      {/* Preview summary */}
      <SimpleCard>
        <h2 className="mb-3 text-base font-semibold text-gray-800">보고서 요약</h2>
        <div className="grid grid-cols-4 gap-3">
          <div className="rounded-lg border border-gray-200 bg-gray-100 p-3 text-center">
            <p className="text-xs text-gray-400">분석 파일</p>
            <p className="text-lg font-bold text-gray-800">{analysisResults.length}</p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-100 p-3 text-center">
            <p className="text-xs text-gray-400">소실 건수</p>
            <p className="text-lg font-bold text-[#a60739]">{totalLoss}</p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-100 p-3 text-center">
            <p className="text-xs text-gray-400">평균 소실율</p>
            <p className="text-lg font-bold text-yellow-600">{avgLossPercent.toFixed(1)}%</p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-100 p-3 text-center">
            <p className="text-xs text-gray-400">LOS 분석</p>
            <p className="text-lg font-bold text-gray-800">{losResults.length}건</p>
          </div>
        </div>

        {template === "monthly" && allLoss.length > 20 && (
          <p className="mt-3 text-xs text-gray-400">
            월간 보고서: 소실 상세는 상위 20건만 포함됩니다 (전체 {allLoss.length}건)
          </p>
        )}
      </SimpleCard>

      {/* No data */}
      {analysisResults.length === 0 && (
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
