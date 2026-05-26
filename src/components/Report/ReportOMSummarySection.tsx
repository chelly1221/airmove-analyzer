import React from "react";
import type { RadarMonthlyResult, ManualBuilding, RadarSite, AzSector } from "../../types";
import {
  weightedLossAvg, weightedLossStdDev,
  weightedPsrAvg, weightedPsrStdDev,
  gradeWithConfidence,
} from "../../utils/omStats";
import { haversineKm, bearingDeg } from "../../utils/geo";
import ReportPage from "./ReportPage";
import ReportOMSectionHeader from "./ReportOMSectionHeader";
import { PAGE_CONTENT_MM } from "./reportPageConstants";

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

/**
 * 분석 요약 페이지 (페이지 1).
 *
 * 페이지 구성 순서(data-order="table-first"):
 *   1) 분석 대상 장애물 표 (.om-table)
 *   2) 방위·산식 통합 박스 (.meta-merged)
 *   3) 레이더별 KPI 행 리스트 (.kpi-list, data-kpi="list")
 *
 * 건물이 많으면 첫 페이지에 KPI/방위/산식을 두고 잔여 건물 표는 후속 페이지로
 * 분할. 페이지 inner padding 16/18mm + 새 KPI 행 리스트 높이를 반영한 추정치.
 */
const HEADER_HEIGHT_MM = 14;
const TABLE_HEADER_MM = 8;
const ROW_HEIGHT_MM = 7;
const META_MERGED_MM = 30;   // 방위 + 산식 통합 박스 (.meta-merged)
const KPI_BLOCK_MM = 50;     // h3(6) + 5 행 × 9mm + 보더 = ~50mm

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
  const fixedContentMm = HEADER_HEIGHT_MM + TABLE_HEADER_MM + META_MERGED_MM
    + radarResults.length * KPI_BLOCK_MM;
  const availForRows = PAGE_CONTENT_MM - fixedContentMm;
  const maxRowsFirstPage = Math.max(3, Math.floor(availForRows / ROW_HEIGHT_MM));
  // 후속 페이지에 들어갈 수 있는 행 수 (섹션 헤더 + 테이블 헤더만)
  const maxRowsNextPage = Math.floor((PAGE_CONTENT_MM - HEADER_HEIGHT_MM - TABLE_HEADER_MM) / ROW_HEIGHT_MM);

  const totalBuildings = selectedBuildings.length;
  const needsSplit = totalBuildings > maxRowsFirstPage;

  // ── 분석 대상 장애물 표 ────────────────────────────────────────────────
  const renderBuildingTable = (buildings: ManualBuilding[], startIdx: number) => (
    <table className="om-table">
      <thead>
        <tr>
          <th className="w-5">#</th>
          <th className="ta-l">건물명</th>
          <th className="ta-r">높이(m)</th>
          {radarSites.map((r) => (
            <th key={r.name} className="ta-r">{r.name} 방위/거리</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {buildings.map((b, i) => {
          const idx = startIdx + i;
          return (
            <tr key={b.id} className={idx % 2 === 0 ? "" : "alt"}>
              <td className="ta-c">{idx + 1}</td>
              <td>{b.name || `건물 ${b.id}`}</td>
              <td className="ta-r mono">{b.height.toFixed(0)}</td>
              {radarSites.map((r) => {
                const az = bearingDeg(r.latitude, r.longitude, b.latitude, b.longitude);
                const dist = haversineKm(r.latitude, r.longitude, b.latitude, b.longitude);
                return (
                  <td key={r.name} className="ta-r mono">
                    {az.toFixed(1)}° / {dist.toFixed(1)}km
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  // ── 방위·산식 통합 박스 (.meta-merged) ────────────────────────────────
  const renderMetaMerged = () => (
    <div className="meta-merged">
      <div className="meta-merged-row az">
        <p className="meta-merged-label">분석 방위 구간</p>
        <div className="az-grid">
          {radarSites.map((r) => {
            const sectors = azimuthSectorsByRadar.get(r.name) ?? [];
            const sectorText = sectors.map((s) => `${s.start_deg.toFixed(1)}°~${s.end_deg.toFixed(1)}°`).join(", ") || "—";
            return (
              <div key={r.name}>
                <span className="muted">{r.name}:</span>{" "}
                <span className="mono strong">{sectorText}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="meta-merged-row formula">
        <p className="meta-merged-label">통계 산식</p>
        <div>
          <span className="strong">통계 산식 · </span>
          평균: 관측량 가중 평균 <i>x̄ᵥᵥ = Σ(wᵢ·xᵢ) / Σ(wᵢ)</i>
          {" "}(Loss: w=비행시간, PSR: w=SSR포인트수){" · "}
          <i>±σ</i>: 가중 모표준편차 <i>σᵥᵥ = √(Σ(wᵢ(xᵢ - x̄ᵥᵥ)²) / Σ(wᵢ))</i>{" · "}
          판정: 양호(&lt;0.5%) / 주의(0.5–2%) / 경고(≥2%) / 보류(&lt;7일)
        </div>
      </div>
    </div>
  );

  // ── 레이더별 KPI 행 리스트 ─────────────────────────────────────────────
  const renderKPIBlocks = () => radarResults.map((rr) => {
    const days = rr.daily_stats.length;
    const avgPsr = weightedPsrAvg(rr.daily_stats) * 100;
    const psrSigma = weightedPsrStdDev(rr.daily_stats) * 100;
    const avgLoss = weightedLossAvg(rr.daily_stats);
    const lossSigma = weightedLossStdDev(rr.daily_stats);
    const totalPts = rr.total_points_filtered;
    const grade = gradeWithConfidence(avgLoss, days);
    // 종합 판정 행에 등급 색을 인라인 CSS 변수로 주입 → .kpi.grade 에서 사용
    const gradeVars = { "--grade-bg": grade.bg, "--grade-color": grade.color } as React.CSSProperties;

    return (
      <div key={rr.radar_name} className="kpi-block">
        <h3 className="om-h3">{rr.radar_name}</h3>
        <div className="kpi-list">
          <div className="kpi grade" style={gradeVars}>
            <p className="kpi-label">종합 판정</p>
            <p className="kpi-val">{grade.label}</p>
            <p className="kpi-sigma" />
          </div>
          <div className="kpi">
            <p className="kpi-label">분석일수</p>
            <p className="kpi-val">{days}일</p>
            <p className="kpi-sigma" />
          </div>
          <div className="kpi">
            <p className="kpi-label">분석 포인트</p>
            <p className="kpi-val">{totalPts.toLocaleString()}</p>
            <p className="kpi-sigma" />
          </div>
          <div className="kpi">
            <p className="kpi-label">평균 PSR율</p>
            <p className="kpi-val" style={{ color: "var(--om-accent)" }}>{avgPsr.toFixed(2)}%</p>
            <p className="kpi-sigma">±{psrSigma.toFixed(2)}</p>
          </div>
          <div className="kpi">
            <p className="kpi-label">평균 표적소실율</p>
            <p className="kpi-val" style={{ color: "#a60739" }}>{avgLoss.toFixed(3)}%</p>
            <p className="kpi-sigma">±{lossSigma.toFixed(3)}</p>
          </div>
        </div>
        {rr.failed_files.length > 0 && (
          <p className="mt-1 text-[11px]" style={{ color: "#dc2626" }}>
            파싱 실패: {rr.failed_files.length}건 ({rr.failed_files.map((f) => f.split(/[/\\]/).pop()).join(", ")})
          </p>
        )}
      </div>
    );
  });

  // ── 분할 불필요: 한 페이지 ──
  if (!needsSplit) {
    return (
      <ReportPage>
        <ReportOMSectionHeader
          sectionNum={sectionNum}
          title={`분석 요약${monthLabel ? ` (${monthLabel})` : ""}`}
        />
        <div className="block-h3" style={{ marginTop: 0 }}>분석 대상 장애물</div>
        {renderBuildingTable(selectedBuildings, 0)}
        {renderMetaMerged()}
        {renderKPIBlocks()}
      </ReportPage>
    );
  }

  // ── 분할 필요: 첫 페이지 + 후속 페이지(잔여 건물 표) ──
  const pages: React.ReactNode[] = [];
  const firstSlice = selectedBuildings.slice(0, maxRowsFirstPage);
  pages.push(
    <ReportPage key="summary-0">
      <ReportOMSectionHeader
        sectionNum={sectionNum}
        title={`분석 요약${monthLabel ? ` (${monthLabel})` : ""}`}
      />
      <div className="block-h3" style={{ marginTop: 0 }}>
        분석 대상 장애물 ({totalBuildings}건 중 1–{maxRowsFirstPage})
      </div>
      {renderBuildingTable(firstSlice, 0)}
      {renderMetaMerged()}
      {renderKPIBlocks()}
    </ReportPage>,
  );

  let offset = maxRowsFirstPage;
  let pageIdx = 1;
  while (offset < totalBuildings) {
    const slice = selectedBuildings.slice(offset, offset + maxRowsNextPage);
    pages.push(
      <ReportPage key={`summary-${pageIdx}`}>
        <ReportOMSectionHeader
          sectionNum={sectionNum}
          title={`분석 요약 (계속) — 장애물 ${offset + 1}–${Math.min(offset + maxRowsNextPage, totalBuildings)}/${totalBuildings}`}
        />
        {renderBuildingTable(slice, offset)}
      </ReportPage>,
    );
    offset += maxRowsNextPage;
    pageIdx++;
  }

  return <>{pages}</>;
}

export default React.memo(ReportOMSummarySection);
