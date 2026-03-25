import React from "react";
import type { RadarMonthlyResult, ManualBuilding, RadarSite, AzSector } from "../../types";
import { weightedLossAvg, weightedLossStdDev, weightedPsrAvg, weightedPsrStdDev, gradeWithConfidence } from "../../utils/omStats";
import ReportPage from "./ReportPage";

interface Props {
  sectionNum: number;
  radarResults: RadarMonthlyResult[];
  selectedBuildings: ManualBuilding[];
  radarSites: RadarSite[];
  /** 레이더별 방위 구간 (레이더 이름 → AzSector[]) */
  azimuthSectorsByRadar: Map<string, AzSector[]>;
  /** 분석 대상 월 (YYYY-MM) */
  analysisMonth?: string;
}

/** bearing from radar to building center */
function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * toRad) * Math.cos(lat2 * toRad);
  const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
    Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos((lon2 - lon1) * toRad);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * A4 인쇄 영역 273mm (297-12×2 패딩) 내에서 요소별 예상 높이:
 *   - 섹션 헤더: ~12mm
 *   - 건물 테이블 헤더: ~8mm, 행당: ~7mm
 *   - 방위 구간 박스: ~20mm
 *   - 산식 주석 박스: ~15mm
 *   - 레이더 KPI 블록: ~25mm (1개당)
 *
 * 건물 테이블 + 방위 + 산식 + KPI를 합산하여 273mm 초과 시,
 * 건물 테이블을 maxRowsPerPage 단위로 분할하여 여러 ReportPage를 반환한다.
 */
const HEADER_HEIGHT_MM = 12;
const TABLE_HEADER_MM = 8;
const ROW_HEIGHT_MM = 7;
const AZ_BOX_MM = 20;
const FORMULA_BOX_MM = 15;
const KPI_BLOCK_MM = 25;
const PAGE_CONTENT_MM = 273; // 297 - 12*2 패딩

function ReportOMSummarySection({
  sectionNum,
  radarResults,
  selectedBuildings,
  radarSites,
  azimuthSectorsByRadar,
  analysisMonth,
}: Props) {
  const monthLabel = analysisMonth
    ? `${analysisMonth.slice(0, 4)}년 ${parseInt(analysisMonth.slice(5, 7))}월`
    : "";

  // 첫 페이지에 들어갈 수 있는 건물 행 수 계산
  const fixedContentMm = HEADER_HEIGHT_MM + TABLE_HEADER_MM + AZ_BOX_MM + FORMULA_BOX_MM
    + radarResults.length * KPI_BLOCK_MM;
  const availForRows = PAGE_CONTENT_MM - fixedContentMm;
  const maxRowsFirstPage = Math.max(3, Math.floor(availForRows / ROW_HEIGHT_MM));
  // 후속 페이지에 들어갈 수 있는 행 수 (섹션 헤더 + 테이블 헤더만)
  const maxRowsNextPage = Math.floor((PAGE_CONTENT_MM - HEADER_HEIGHT_MM - TABLE_HEADER_MM) / ROW_HEIGHT_MM);

  const totalBuildings = selectedBuildings.length;
  const needsSplit = totalBuildings > maxRowsFirstPage;

  // 건물 테이블 렌더 (지정 범위)
  const renderBuildingTable = (buildings: ManualBuilding[], startIdx: number) => (
    <table className="w-full border-collapse text-[13px]">
      <thead>
        <tr className="bg-[#28283c] text-white">
          <th className="border border-gray-300 px-2 py-1 text-center font-medium w-5">#</th>
          <th className="border border-gray-300 px-2 py-1 text-left font-medium">건물명</th>
          <th className="border border-gray-300 px-2 py-1 text-right font-medium">높이(m)</th>
          {radarSites.map((r) => (
            <th key={r.name} className="border border-gray-300 px-2 py-1 text-right font-medium">
              {r.name} 방위/거리
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {buildings.map((b, i) => (
          <tr key={b.id} className={(startIdx + i) % 2 === 0 ? "bg-white" : "bg-gray-50"}>
            <td className="border border-gray-200 px-2 py-1 text-center">{startIdx + i + 1}</td>
            <td className="border border-gray-200 px-2 py-1">{b.name || `건물 ${b.id}`}</td>
            <td className="border border-gray-200 px-2 py-1 text-right font-mono">{b.height.toFixed(0)}</td>
            {radarSites.map((r) => {
              const az = bearingDeg(r.latitude, r.longitude, b.latitude, b.longitude);
              const dist = haversineKm(r.latitude, r.longitude, b.latitude, b.longitude);
              return (
                <td key={r.name} className="border border-gray-200 px-2 py-1 text-right font-mono">
                  {az.toFixed(1)}° / {dist.toFixed(1)}km
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );

  // 레이더별 KPI 블록 렌더
  const renderKPIBlocks = () => radarResults.map((rr) => {
    const days = rr.daily_stats.length;
    const avgPsr = weightedPsrAvg(rr.daily_stats) * 100;
    const psrSigma = weightedPsrStdDev(rr.daily_stats) * 100;
    const avgLoss = weightedLossAvg(rr.daily_stats);
    const lossSigma = weightedLossStdDev(rr.daily_stats);
    const totalPts = rr.total_points_filtered;
    const grade = gradeWithConfidence(avgLoss, days);

    return (
      <div key={rr.radar_name} className="mb-3">
        <h3 className="mb-2 text-[15px] font-semibold text-gray-700">{rr.radar_name}</h3>
        <div className="grid grid-cols-5 gap-2">
          <div className="rounded-md border px-2 py-1.5 text-center" style={{ backgroundColor: grade.bg, color: grade.color }}>
            <p className="text-[13px] text-gray-400">종합 판정</p>
            <p className="text-[15px] font-bold">{grade.label}</p>
          </div>
          <div className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 text-center">
            <p className="text-[13px] text-gray-400">분석일수</p>
            <p className="text-[13px] font-bold text-gray-800">{days}일</p>
          </div>
          <div className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 text-center">
            <p className="text-[13px] text-gray-400">분석 포인트</p>
            <p className="text-[13px] font-bold text-gray-800">{totalPts.toLocaleString()}</p>
          </div>
          <div className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 text-center">
            <p className="text-[13px] text-gray-400">평균 PSR율</p>
            <p className="text-[13px] font-bold text-blue-600">{avgPsr.toFixed(2)}%</p>
            <p className="text-[10px] text-gray-400">±{psrSigma.toFixed(2)}</p>
          </div>
          <div className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 text-center">
            <p className="text-[13px] text-gray-400">평균 표적소실율</p>
            <p className="text-[13px] font-bold text-[#a60739]">{avgLoss.toFixed(3)}%</p>
            <p className="text-[10px] text-gray-400">±{lossSigma.toFixed(3)}</p>
          </div>
        </div>
        {rr.failed_files.length > 0 && (
          <p className="mt-1 text-[13px] text-red-500">
            파싱 실패: {rr.failed_files.length}건 ({rr.failed_files.map((f) => f.split(/[/\\]/).pop()).join(", ")})
          </p>
        )}
      </div>
    );
  });

  // 방위 구간 + 산식 주석 렌더
  const renderAzAndFormula = () => (
    <>
      <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
        <h3 className="mb-2 text-[15px] font-semibold text-gray-700">분석 방위 구간</h3>
        <div className="grid grid-cols-2 gap-2 text-[13px]">
          {radarSites.map((r) => {
            const sectors = azimuthSectorsByRadar.get(r.name) ?? [];
            return (
              <div key={r.name}>
                <span className="text-gray-400">{r.name}:</span>{" "}
                <span className="font-mono font-semibold text-gray-700">
                  {sectors.map((s) => `${s.start_deg.toFixed(1)}°~${s.end_deg.toFixed(1)}°`).join(", ") || "—"}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {/* 통계 산식 주석 (보고서 인쇄 시 근거 명시) */}
      <div className="mb-4 rounded border border-gray-200 bg-gray-50/70 px-3 py-2 text-[10px] leading-relaxed text-gray-500">
        <span className="font-semibold text-gray-600">통계 산식 · </span>
        평균: 관측량 가중 평균 x̄<sub>w</sub> = Σ(w<sub>i</sub>·x<sub>i</sub>)/Σw<sub>i</sub>
        {" "}(Loss: w=비행시간, PSR: w=SSR포인트수)
        {" · "}±σ: 가중 모표준편차
        {" · "}N: 일별 총 탐지포인트
        {" · "}판정: 양호(&lt;0.5%) / 주의(0.5–2%) / 경고(≥2%) / 보류(&lt;7일)
      </div>
    </>
  );

  // ── 분할 불필요: 모두 한 페이지 ──
  if (!needsSplit) {
    return (
      <ReportPage>
        <div className="mb-8">
          <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[19px] font-bold text-gray-900">
            {sectionNum}. 분석 요약{monthLabel && ` (${monthLabel})`}
          </h2>
          <div className="mb-4">
            <h3 className="mb-2 text-[15px] font-semibold text-gray-700">분석 대상 장애물</h3>
            {renderBuildingTable(selectedBuildings, 0)}
          </div>
          {renderAzAndFormula()}
          {renderKPIBlocks()}
        </div>
      </ReportPage>
    );
  }

  // ── 분할 필요: 건물 테이블을 여러 페이지로 ──
  const pages: React.ReactNode[] = [];

  // 첫 페이지: 건물 테이블(일부) + 방위 + 산식 + KPI
  const firstSlice = selectedBuildings.slice(0, maxRowsFirstPage);
  pages.push(
    <ReportPage key="summary-0">
      <div className="mb-8">
        <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[19px] font-bold text-gray-900">
          {sectionNum}. 분석 요약{monthLabel && ` (${monthLabel})`}
        </h2>
        <div className="mb-4">
          <h3 className="mb-2 text-[15px] font-semibold text-gray-700">
            분석 대상 장애물 ({totalBuildings}건 중 1–{maxRowsFirstPage})
          </h3>
          {renderBuildingTable(firstSlice, 0)}
        </div>
        {renderAzAndFormula()}
        {renderKPIBlocks()}
      </div>
    </ReportPage>
  );

  // 후속 페이지: 잔여 건물 테이블
  let offset = maxRowsFirstPage;
  let pageIdx = 1;
  while (offset < totalBuildings) {
    const slice = selectedBuildings.slice(offset, offset + maxRowsNextPage);
    pages.push(
      <ReportPage key={`summary-${pageIdx}`}>
        <div className="mb-8">
          <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[19px] font-bold text-gray-900">
            {sectionNum}. 분석 요약 (계속) — 장애물 {offset + 1}–{Math.min(offset + maxRowsNextPage, totalBuildings)}/{totalBuildings}
          </h2>
          {renderBuildingTable(slice, offset)}
        </div>
      </ReportPage>
    );
    offset += maxRowsNextPage;
    pageIdx++;
  }

  return <>{pages}</>;
}

export default React.memo(ReportOMSummarySection);
