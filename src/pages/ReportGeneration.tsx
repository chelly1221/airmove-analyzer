import { useState, useCallback, useEffect, useRef } from "react";
import {
  Loader2,
  Eye,
  Mountain,
  ChevronRight,
  ChevronDown,
  FilePlus,
} from "lucide-react";
import { useAppStore } from "../store";
import { emit, listen } from "@tauri-apps/api/event";
import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import {
  writeReportPayload, writeReportConfig, readGenerateRequest, clearGenerateRequest,
  templateDisplayLabel,
  type ReportTemplate, type ReportGenerateRequest,
} from "../utils/reportTransfer";
import type { RadarSite } from "../types";

export default function ReportGeneration() {
  const radarSite = useAppStore((s) => s.radarSite);
  const aircraft = useAppStore((s) => s.aircraft);
  const reportMetadata = useAppStore((s) => s.reportMetadata);
  const customRadarSites = useAppStore((s) => s.customRadarSites);

  /** 보고서 창 열기 헬퍼 */
  const openReportWindow = useCallback(async () => {
    const existing = (await getAllWebviewWindows()).find((w) => w.label === "report");
    if (existing) {
      // 기존 창이 있으면 설정 모달 다시 표시 후 포커스
      await emit("report:reload-config");
      await existing.setFocus();
    } else {
      new WebviewWindow("report", {
        url: "index.html",
        title: "보고서 편집 — AirMove Analyzer",
        width: 900,
        height: 1000,
        minWidth: 800,
        minHeight: 700,
        decorations: false,
        shadow: true,
        center: true,
      });
    }
  }, []);

  // 보고서 준비 중 — 상세 상태 (오버레이 + 버튼 disable)
  const [prepState, setPrepState] = useState<{ active: boolean; message: string }>({ active: false, message: "" });

  // 보고서 생성 요청 수신 → 페이로드 조립 + IDB 저장 + data-written emit.
  // 분석 결과(omData)는 보고서 창의 OM 모달에서 산출되어 요청에 실려 오고,
  // 여기서는 메인 창 스토어의 레이더/메타데이터를 더해 최종 페이로드를 완성한다.
  const handleGenerate = useCallback(async (req: ReportGenerateRequest) => {
    if (!req.omData) return;
    setPrepState({ active: true, message: "보고서 준비 중..." });
    try {
      setPrepState({ active: true, message: "데이터 저장 중..." });
      await writeReportPayload({
        template: "obstacle_monthly",
        sections: req.sections,
        coverTitle: "장애물 월간 분석 보고서",
        radarSite,
        reportMetadata,
        omData: req.omData,
      });
      // 이미 열려있는 보고서 창에 data-written 이벤트 전달
      await emit("report:data-written");
    } finally {
      setPrepState({ active: false, message: "" });
    }
  }, [radarSite, reportMetadata]);

  // 템플릿 클릭 → config 저장 → 보고서 창 열기 (모달은 보고서 창에서 표시)
  const handleTemplateClick = useCallback(async (tpl: ReportTemplate) => {
    setPrepState({ active: true, message: "보고서 설정 창 열기..." });
    try {
      await writeReportConfig({
        template: tpl,
        aircraft,
        metadata: reportMetadata,
        customRadarSites,
      });
      await openReportWindow();
    } finally {
      setPrepState({ active: false, message: "" });
    }
  }, [aircraft, reportMetadata, customRadarSites, openReportWindow]);

  // ref로 최신 handleGenerate 참조 — 리스너 재등록 없이 항상 최신 클로저 사용
  const handleGenerateRef = useRef(handleGenerate);
  useEffect(() => { handleGenerateRef.current = handleGenerate; }, [handleGenerate]);

  // 보고서 창에서 생성 요청 수신 → 데이터 조립 + IDB 저장 + data-written emit
  useEffect(() => {
    const unlisten = listen("report:generate", async () => {
      try {
        const req = await readGenerateRequest();
        if (!req) return;
        await clearGenerateRequest();
        await handleGenerateRef.current(req);
      } catch (e) {
        console.error("[ReportGeneration] report:generate 처리 실패:", e);
        // 보고서 창에 에러 전달 — 로딩 화면에서 벗어날 수 있도록
        await emit("report:data-error", { message: e instanceof Error ? e.message : String(e) });
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []); // 안정적 의존성 — ref를 통해 최신 함수 참조

  return (
    <div className="relative space-y-6">
      {/* 보고서 준비 오버레이 */}
      {prepState.active && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/80">
          <div className="flex flex-col items-center gap-3">
            <Loader2 size={28} className="animate-spin text-[#a60739]" />
            <p className="text-sm font-medium text-gray-600">{prepState.message}</p>
          </div>
        </div>
      )}
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-800">보고서 생성</h1>
        <p className="mt-1 text-sm text-gray-500">
          템플릿을 선택하여 분석 결과 PDF 보고서를 생성합니다
        </p>
      </div>

      {/* Template list */}
      <div>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-700">
          <FilePlus size={16} className="text-[#a60739]" />
          보고서 템플릿
        </h2>
        <TemplateTable
          customRadarSites={customRadarSites}
          onSelect={handleTemplateClick}
          disabled={prepState.active}
        />
      </div>
    </div>
  );
}

// ── 템플릿 테이블 (expandable list) ──

interface TemplateRowDef {
  type: ReportTemplate;
  icon: typeof Mountain;
  title: string;
  description: string;
  stats: { label: string; value: string | number }[];
  disabled: boolean;
}

function TemplateTable({
  customRadarSites,
  onSelect,
  disabled: externalDisabled,
}: {
  customRadarSites: RadarSite[];
  onSelect: (tpl: ReportTemplate) => void;
  disabled?: boolean;
}) {
  const [expandedRow, setExpandedRow] = useState<ReportTemplate | null>(null);

  const rows: TemplateRowDef[] = [
    {
      type: "obstacle_monthly",
      icon: Mountain,
      title: "장애물 월간 보고서",
      description: "특정 장애물의 월간 영향을 분석합니다. ASS 파일을 입력하여 일별 PSR 탐지율/표적소실율 추이, 분석 대상 장애물별 LoS 단면 및 양각 분포를 생성합니다.",
      stats: [
        { label: "레이더", value: `${customRadarSites.length}개` },
        { label: "수동 건물", value: "선택식" },
      ],
      disabled: customRadarSites.length === 0,
    },
  ];

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
      {rows.map((row, idx) => {
        const isExpanded = expandedRow === row.type;
        const Icon = row.icon;
        return (
          <div key={row.type}>
            {idx > 0 && <div className="border-t border-gray-100" />}
            <button
              onClick={() => setExpandedRow(isExpanded ? null : row.type)}
              disabled={row.disabled || externalDisabled}
              className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${
                row.disabled || externalDisabled
                  ? "opacity-40 cursor-not-allowed"
                  : isExpanded
                  ? "bg-[#a60739]/5"
                  : "hover:bg-gray-50"
              }`}
            >
              {isExpanded
                ? <ChevronDown size={14} className="shrink-0 text-[#a60739]" />
                : <ChevronRight size={14} className="shrink-0 text-gray-400" />
              }
              <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                row.disabled ? "bg-gray-100" : "bg-[#a60739]/10"
              }`}>
                <Icon size={16} className={row.disabled ? "text-gray-400" : "text-[#a60739]"} />
              </div>
              <div className="min-w-0 flex-1">
                <span className="text-sm font-semibold text-gray-800">{row.title}</span>
                <span className="ml-3 text-[11px] text-gray-400">
                  {templateDisplayLabel(row.type)}
                </span>
              </div>
              <div className="flex shrink-0 gap-2">
                {row.stats.map((s) => (
                  <div key={s.label} className="rounded-md bg-gray-100 px-2 py-1">
                    <span className="text-[9px] text-gray-400">{s.label}</span>
                    <span className="ml-1 text-[11px] font-semibold text-gray-600">{s.value}</span>
                  </div>
                ))}
              </div>
            </button>

            {/* Expanded detail */}
            {isExpanded && !row.disabled && (
              <div className="border-t border-gray-100 bg-gray-50/50 px-4 py-3">
                <p className="mb-3 text-xs leading-relaxed text-gray-500">{row.description}</p>
                <button
                  onClick={() => onSelect(row.type)}
                  className="flex items-center gap-1.5 rounded-lg bg-[#a60739] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#85062e]"
                >
                  <Eye size={14} />
                  설정 및 생성
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
