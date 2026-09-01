import { useState, useCallback, useEffect } from "react";
import {
  Loader2,
  Eye,
  Mountain,
  Construction,
  ChevronRight,
  ChevronDown,
  FilePlus,
  Settings,
} from "lucide-react";
import { useAppStore } from "../store";
import { useOmReferenceBuildStore } from "../store/omReferenceBuild";
import { emit } from "@tauri-apps/api/event";
import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import {
  writeReportConfig,
  templateDisplayLabel,
  type ReportTemplate,
} from "../utils/reportTransfer";
import OMReferenceModal from "../components/Report/OMReferenceModal";
import CraneReviewConfigModal from "../components/Report/CraneReviewConfigModal";
import type { RadarSite, TowerCrane } from "../types";

/** 템플릿 행 종류 — OM 보고서(ReportTemplate)와 별도 창(crane-review) 보고서.
 *  타워크레인 검토는 OM 보고서 창·설정(writeReportConfig) 계통을 타지 않으므로
 *  ReportTemplate 유니온에 넣지 않고 이 행 전용 값으로 구분한다. */
type TemplateRowType = ReportTemplate | "tower_crane_review";

export default function ReportGeneration() {
  const aircraft = useAppStore((s) => s.aircraft);
  const reportMetadata = useAppStore((s) => s.reportMetadata);
  const customRadarSites = useAppStore((s) => s.customRadarSites);
  const towerCranes = useAppStore((s) => s.towerCranes);
  const braAngleDeg = useAppStore((s) => s.braAngleDeg);

  // 타워크레인 목록 — 자료관리/지도에서 등록·수정된 내용을 페이지 진입 시 1회 최신화
  useEffect(() => { void useAppStore.getState().loadTowerCranes(); }, []);

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

  // 기준데이터 관리 모달
  const [referenceModalOpen, setReferenceModalOpen] = useState(false);
  // 타워크레인 검토 보고서 설정 모달
  const [craneModalOpen, setCraneModalOpen] = useState(false);

  /** 활성 시설만 검토 대상 (비활성 레이더는 분석에서 제외하는 전역 규약) */
  const activeRadarSites = customRadarSites.filter((s) => s.active !== false);

  // NOTE: 보고서 창의 생성 요청(report:generate) 수신은 App.tsx 의 useReportGenerateListener 담당.
  // 페이지에 두면 라우트 이동 시 리스너가 해제되어 요청이 유실되므로 상시 마운트 지점으로 이동했다.

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

  /** 템플릿 행 선택 — 타워크레인 검토는 자체 설정 모달, 그 외는 OM 보고서 창 */
  const handleRowSelect = useCallback((type: TemplateRowType) => {
    if (type === "tower_crane_review") {
      setCraneModalOpen(true);
      return;
    }
    void handleTemplateClick(type);
  }, [handleTemplateClick]);

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
          towerCranes={towerCranes}
          onSelect={handleRowSelect}
          onOpenReference={() => setReferenceModalOpen(true)}
          disabled={prepState.active}
        />
      </div>

      {/* 기준데이터 관리 모달 */}
      <OMReferenceModal
        open={referenceModalOpen}
        onClose={() => setReferenceModalOpen(false)}
        customRadarSites={customRadarSites}
      />

      {/* 타워크레인 전파영향 검토 보고서 설정 (별도 창 crane-review 로 생성) */}
      <CraneReviewConfigModal
        open={craneModalOpen}
        onClose={() => setCraneModalOpen(false)}
        cranes={towerCranes}
        radarSites={activeRadarSites}
        defaultBraAngleDeg={braAngleDeg}
      />
    </div>
  );
}

// ── 템플릿 테이블 (expandable list) ──

interface TemplateRowDef {
  type: TemplateRowType;
  icon: typeof Mountain;
  title: string;
  description: string;
  /** 행 우측 배지 라벨 (OM 은 templateDisplayLabel, 크레인 검토는 고정 문자열) */
  label: string;
  stats: { label: string; value: string | number }[];
  disabled: boolean;
}

function TemplateTable({
  customRadarSites,
  towerCranes,
  onSelect,
  onOpenReference,
  disabled: externalDisabled,
}: {
  customRadarSites: RadarSite[];
  towerCranes: TowerCrane[];
  onSelect: (type: TemplateRowType) => void;
  onOpenReference: () => void;
  disabled?: boolean;
}) {
  const [expandedRow, setExpandedRow] = useState<TemplateRowType | null>(null);
  // 기준데이터 빌드가 백그라운드 진행 중인지 (모달을 닫아도 스토어에서 계속) — 버튼에 스피너 표시
  const refBuilding = useOmReferenceBuildStore((s) => s.building);

  const rows: TemplateRowDef[] = [
    {
      type: "obstacle_monthly",
      icon: Mountain,
      title: "장애물 월간 보고서",
      description: "특정 장애물의 월간 영향을 분석합니다. ASS 파일을 입력하여 일별 PSR 탐지율/표적소실율 추이, 분석 대상 장애물별 LoS 단면 및 양각 분포를 생성합니다.",
      label: templateDisplayLabel("obstacle_monthly"),
      stats: [
        { label: "레이더", value: `${customRadarSites.length}개` },
        { label: "수동 건물", value: "선택식" },
      ],
      disabled: customRadarSites.length === 0,
    },
    {
      type: "tower_crane_review",
      icon: Construction,
      title: "타워크레인 전파영향 검토 보고서",
      description: "등록 타워크레인의 BRA 제한표면 침범·전방 차폐(LoS)를 지브 방위각별(최악각·최선각·전방위·지정 각도)로 검토한 보고서를 생성합니다.",
      label: "크레인검토",
      stats: [
        { label: "레이더", value: `${customRadarSites.length}개` },
        { label: "타워크레인", value: `${towerCranes.length}기` },
      ],
      disabled: customRadarSites.length === 0 || towerCranes.length === 0,
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
                  {row.label}
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
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => onSelect(row.type)}
                    className="flex items-center gap-1.5 rounded-lg bg-[#a60739] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#85062e]"
                  >
                    <Eye size={14} />
                    설정 및 생성
                  </button>
                  {/* 기준데이터 관리 (헤드라인 Δ 판정 기준월) */}
                  {row.type === "obstacle_monthly" && (
                    <button
                      onClick={() => onOpenReference()}
                      className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-4 py-1.5 text-sm text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-800"
                    >
                      {refBuilding
                        ? <Loader2 size={14} className="animate-spin text-[#a60739]" />
                        : <Settings size={14} className="text-[#a60739]" />}
                      기준데이터 관리{refBuilding ? " (빌드 중)" : ""}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
