/**
 * 보고서 템플릿 설정 모달 (weekly/monthly/flights/single)
 * 보고서 창에서 렌더링됨.
 */
import { useState } from "react";
import {
  FileText, Map as MapIcon, BarChart3, Crosshair, Eye, Plane, Mountain, Radio,
  CheckSquare, Square,
} from "lucide-react";
import { format } from "date-fns";
import Modal from "../common/Modal";
import { flightLabel } from "../../utils/flightConsolidation";
import { isGPUCacheValidFor } from "../../utils/radarCoverage";
import {
  templateDisplayLabel, DEFAULT_SECTIONS,
  type ReportTemplate, type ReportSections,
} from "../../utils/reportTransfer";
import type { Flight, LoSProfileData, Aircraft as AircraftType, PanoramaPoint, ReportMetadata, RadarSite } from "../../types";

function SummaryPill({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-center">
      <p className="text-[10px] text-gray-400">{label}</p>
      <p className={`text-sm font-bold ${accent ? "text-[#a60739]" : "text-gray-800"}`}>{value}</p>
    </div>
  );
}

export default function TemplateConfigModal({
  template,
  flights,
  losResults,
  aircraft,
  metadata,
  radarSite,
  panoramaData,
  onClose,
  onGenerate,
}: {
  template: ReportTemplate;
  flights: Flight[];
  losResults: LoSProfileData[];
  aircraft: AircraftType[];
  metadata: ReportMetadata;
  radarSite: RadarSite;
  panoramaData: PanoramaPoint[];
  onClose: () => void;
  onGenerate: (tpl: ReportTemplate, sections: ReportSections, flightIds?: Set<string>, singleId?: string | null) => void;
}) {
  const radarName = radarSite?.name ?? "";
  const tplLabel = templateDisplayLabel(template);
  const [sections, setSections] = useState<ReportSections>({ ...DEFAULT_SECTIONS });

  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set(flights.map((f) => f.id)));
  const [radioId, setRadioId] = useState<string | null>(flights[0]?.id ?? null);

  const isFlightsMode = template === "flights";
  const isSingleMode = template === "single";
  const needsFlightSelect = isFlightsMode || isSingleMode;

  const totalLoss = flights.reduce((s, r) => s + r.loss_points.length, 0);
  const avgLossPercent = flights.length > 0
    ? flights.reduce((s, r) => s + r.loss_percentage, 0) / flights.length
    : 0;

  const sectionItems: { key: keyof ReportSections; label: string; icon: typeof MapIcon; desc: string; available: boolean }[] = (() => {
    if (isFlightsMode) {
      return [
        { key: "cover", label: "표지", icon: FileText, desc: "문서번호, 시행일자, 레이더명", available: true },
        { key: "flightComparison", label: "비행 비교", icon: BarChart3, desc: "선택 비행 비교 테이블 및 차트", available: true },
        { key: "trackMap", label: "항적 지도", icon: MapIcon, desc: "선택 비행 항적 경로 시각화", available: true },
        { key: "lossDetail", label: "소실 상세", icon: Crosshair, desc: "소실 포인트 상세 목록", available: true },
        { key: "los", label: "LoS 분석", icon: Crosshair, desc: "전파 가시선 차단 분석", available: losResults.length > 0 },
        { key: "panorama", label: "전파 장애물", icon: Mountain, desc: "360° 파노라마 장애물 분석", available: panoramaData.length > 0 },
      ];
    }
    if (template === "obstacle") {
      const hasCoverage = isGPUCacheValidFor(radarSite);
      return [
        { key: "cover", label: "표지", icon: FileText, desc: "문서번호, 시행일자, 레이더명", available: true },
        { key: "obstacleSummary", label: "장애물 종합 요약", icon: Radio, desc: "LoS·파노라마 통합 KPI, 주요 장애물 TOP 5", available: losResults.length > 0 || panoramaData.length > 0 },
        { key: "coverageMap", label: "커버리지 맵", icon: Radio, desc: "고도별 스펙트럼 커버리지 극좌표 시각화", available: hasCoverage },
        { key: "los", label: "LoS 분석", icon: Crosshair, desc: "전파 가시선 차단/양호 상세 결과", available: losResults.length > 0 },
        { key: "panorama", label: "360° 파노라마", icon: Mountain, desc: "방위별 최대 앙각 장애물 및 건물 목록", available: panoramaData.length > 0 },
      ];
    }
    if (isSingleMode) {
      return [
        { key: "cover", label: "표지", icon: FileText, desc: "문서번호, 시행일자, 레이더명", available: true },
        { key: "flightProfile", label: "비행 프로파일", icon: Plane, desc: "기본정보, KPI, 고도 추이 차트", available: true },
        { key: "trackMap", label: "항적 지도", icon: MapIcon, desc: "해당 비행 항적 경로 시각화", available: true },
        { key: "flightLossAnalysis", label: "소실 구간 분석", icon: BarChart3, desc: "구간별 상세, 분포 분석 차트", available: true },
        { key: "los", label: "LoS 분석", icon: Crosshair, desc: "전파 가시선 차단 분석", available: losResults.length > 0 },
        { key: "panorama", label: "전파 장애물", icon: Mountain, desc: "360° 파노라마 장애물 분석", available: panoramaData.length > 0 },
      ];
    }
    return [
      { key: "cover", label: "표지", icon: FileText, desc: "문서번호, 시행일자, 레이더명", available: true },
      { key: "summary", label: "분석 요약", icon: BarChart3, desc: "KPI 그리드, 종합 판정, 소견", available: true },
      { key: "trackMap", label: "항적 지도", icon: MapIcon, desc: "항적 경로 및 Loss 구간 시각화", available: true },
      { key: "stats", label: "분석 통계", icon: BarChart3, desc: `비행별 상세 ${template === "weekly" ? "통계" : "추이 차트"}`, available: flights.length > 0 },
      { key: "los", label: "LoS 분석", icon: Crosshair, desc: "전파 가시선 차단 분석", available: losResults.length > 0 },
      { key: "panorama", label: "전파 장애물", icon: Mountain, desc: "360° 파노라마 장애물 분석", available: panoramaData.length > 0 },
      { key: "aircraft", label: "검사기 현황", icon: Plane, desc: "비행검사기 운용 현황", available: aircraft.length > 0 },
    ];
  })();

  const hasRadar = radarName.length > 0;
  const canGenerate = hasRadar && (isFlightsMode ? checkedIds.size > 0 : isSingleMode ? !!radioId : true);

  return (
    <Modal open onClose={onClose} title={`${tplLabel} 보고서 설정`} width={needsFlightSelect ? "max-w-2xl" : "max-w-lg"}>
      <div className="space-y-5">
        {/* 기본 정보 */}
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px]">
            <div className="flex justify-between">
              <span className="text-gray-400">기관</span>
              <span className="font-medium text-gray-700">{metadata.organization}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">레이더</span>
              <span className="font-medium text-gray-700">{radarName || <span className="text-red-500">미선택</span>}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">부서</span>
              <span className="font-medium text-gray-700">{metadata.department}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">현장</span>
              <span className="font-medium text-gray-700">{metadata.siteName || "—"}</span>
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
          <SummaryPill label="LoS" value={`${losResults.length}건`} />
        </div>

        {/* 비행 선택 영역 */}
        {needsFlightSelect && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-700">
                {isFlightsMode ? "비행 선택 (다중)" : "비행 선택 (1건)"}
              </h3>
              {isFlightsMode && (
                <div className="flex gap-2">
                  <button onClick={() => setCheckedIds(new Set(flights.map((f) => f.id)))} className="text-[11px] text-[#a60739] hover:underline">전체 선택</button>
                  <button onClick={() => setCheckedIds(new Set())} className="text-[11px] text-gray-400 hover:underline">전체 해제</button>
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
                          if (next.has(f.id)) next.delete(f.id); else next.add(f.id);
                          return next;
                        });
                      } else {
                        setRadioId(f.id);
                      }
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-md border px-3 py-2 text-left transition-all ${
                      isChecked ? "border-[#a60739] bg-[#a60739] text-white" : "border-gray-100 hover:border-gray-200"
                    }`}
                  >
                    {isFlightsMode ? (
                      isChecked ? <CheckSquare size={14} className="shrink-0 text-white" /> : <Square size={14} className="shrink-0 text-gray-300" />
                    ) : (
                      <div className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${isChecked ? "border-white" : "border-gray-300"}`}>
                        {isChecked && <div className="h-2 w-2 rounded-full bg-white" />}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <span className={`text-[12px] font-medium ${isChecked ? "text-white" : "text-gray-500"}`}>{label}</span>
                      <span className={`ml-2 text-[10px] ${isChecked ? "text-white/70" : "text-gray-400"}`}>
                        {format(new Date(f.start_time * 1000), "MM-dd HH:mm")}~{format(new Date(f.end_time * 1000), "HH:mm")}
                      </span>
                    </div>
                    <div className="flex shrink-0 gap-2 text-[10px]">
                      <span className={isChecked ? "text-white/70" : "text-gray-400"}>{f.point_count.toLocaleString()}pt</span>
                      <span className={isChecked ? "font-semibold text-white" : f.loss_percentage > 5 ? "font-semibold text-red-600" : f.loss_percentage > 1 ? "text-yellow-600" : "text-green-600"}>
                        {f.loss_percentage.toFixed(1)}%
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>

            {isFlightsMode && (
              <p className="mt-1 text-[10px] text-gray-400">{checkedIds.size}건 선택됨</p>
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
                  !available ? "border-gray-100 bg-gray-50 opacity-40 cursor-not-allowed"
                  : sections[key] ? "border-[#a60739] bg-[#a60739] text-white"
                  : "border-gray-200 hover:border-gray-300"
                }`}
              >
                {sections[key] && available
                  ? <CheckSquare size={16} className="shrink-0 text-white" />
                  : <Square size={16} className="shrink-0 text-gray-300" />
                }
                <Icon size={14} className={`shrink-0 ${sections[key] && available ? "text-white" : "text-gray-400"}`} />
                <div className="min-w-0">
                  <span className={`text-sm font-medium ${sections[key] && available ? "text-white" : "text-gray-500"}`}>{label}</span>
                  <span className={`ml-2 text-[11px] ${sections[key] && available ? "text-white/70" : "text-gray-400"}`}>{desc}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* 생성 버튼 */}
        <div className="flex items-center justify-end gap-2 pt-1">
          {!hasRadar && (
            <span className="mr-auto text-xs text-red-500">레이더를 먼저 선택해 주세요 (설정 &gt; 레이더 사이트)</span>
          )}
          <button onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors">취소</button>
          <button
            onClick={() => onGenerate(template, sections, isFlightsMode ? checkedIds : undefined, isSingleMode ? radioId : undefined)}
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
