import React from "react";
import type { ManualBuilding, BuildingGroup, RadarSite } from "../../types";
import { haversineKm, bearingDeg } from "../../utils/geo";
import ReportPage from "./ReportPage";
import ReportOMSectionHeader from "./ReportOMSectionHeader";
import ReportOMTargetOverviewMap from "./ReportOMTargetOverviewMap";
import BuildingGroupBadge from "./BuildingGroupBadge";
import OMEditable from "./OMEditable";
import { PAGE_CONTENT_MM } from "./reportPageConstants";

interface Props {
  sectionNum: number;
  selectedBuildings: ManualBuilding[];
  /** 건물 그룹 메타 (인라인 배지 + 위치 도면 그룹색용) */
  buildingGroups: BuildingGroup[];
  radarSites: RadarSite[];
}

/**
 * 분석 대상 페이지 (페이지 1).
 *
 * 페이지 구성 순서(data-order="table-first"):
 *   1) 분석 대상 장애물 표 (.om-table) — 건물명·높이 + 레이더별 방위/거리(단일 헤더 행)
 *   2) 분석 대상 위치 도면 (ReportOMTargetOverviewMap) — 레이더 + 전체 건물 위치 정적 지도
 *
 * 건물이 많으면 첫 페이지에 표 첫 슬라이스[+지도]를 두고 잔여 건물 표는 후속 페이지로 분할.
 * 지도가 첫 페이지 예산에 못 들어가면 표 페이지들 뒤 별도 페이지에 단독 배치.
 * (종전의 LoS 영향·추가소실율 열·참고 안내 박스·레이더별 KPI 판정 블록은 제거 — 자동 산출 추정
 *  수치는 §5 종합 소견으로 일원화, 이 페이지는 '분석 대상'의 제원·위치만 제시.)
 */
const HEADER_HEIGHT_MM = 14;
const BLOCK_H3_MM = 8;        // "분석 대상 장애물" 제목 블록 (.block-h3, 15px + 하단여백 8px)
const TABLE_HEADER_MM = 8;    // 단일 헤더 행 (# · 건물명 · 높이 · 레이더별 방위/거리)
const ROW_HEIGHT_MM = 7;
// 위치 도면 블록 = 제목(.block-h3 margin 14/8px + 15px 텍스트 ≈ 11mm) + 캔버스(콘텐츠 폭 182mm ×
//   774/1376 ≈ 102.4mm) + 범례(mt-1 + 10px 1줄 ≈ 5mm) ≈ 118mm → 119mm (과소 추정 시 첫 페이지
//   표 만행(滿行) 케이스에서 범례가 페이지 하단 overflow:hidden 에 잘리므로 보수적으로).
const MAP_MM = 119;

function ReportOMSummarySection({
  sectionNum,
  selectedBuildings,
  buildingGroups,
  radarSites,
}: Props) {
  // 첫 페이지에 표 ≥3행 + 지도가 함께 들어갈 예산이 되면 동거, 아니면 지도는 별도 페이지.
  const fixedFirstMm = HEADER_HEIGHT_MM + BLOCK_H3_MM + TABLE_HEADER_MM;
  const mapOnFirstPage = PAGE_CONTENT_MM - fixedFirstMm - MAP_MM >= 3 * ROW_HEIGHT_MM;
  const availForRows = PAGE_CONTENT_MM - fixedFirstMm - (mapOnFirstPage ? MAP_MM : 0);
  const maxRowsFirstPage = Math.max(3, Math.floor(availForRows / ROW_HEIGHT_MM));
  // 후속 페이지에 들어갈 수 있는 행 수 (섹션 헤더 + 테이블 헤더만)
  const maxRowsNextPage = Math.floor((PAGE_CONTENT_MM - HEADER_HEIGHT_MM - TABLE_HEADER_MM) / ROW_HEIGHT_MM);

  const totalBuildings = selectedBuildings.length;
  const needsSplit = totalBuildings > maxRowsFirstPage;

  // ── 분석 대상 장애물 표 (단일 헤더: # · 건물명 · 높이 · {레이더명} 방위/거리) ──────────
  const renderBuildingTable = (buildings: ManualBuilding[], startIdx: number) => (
    <table className="om-table">
      <thead>
        <tr>
          <th className="w-5">#</th>
          <th className="ta-l">건물명</th>
          <th className="ta-r">높이(m)</th>
          {radarSites.map((r) => (
            <th key={r.name} className="ta-c">{r.name} 방위/거리</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {buildings.map((b, i) => {
          const idx = startIdx + i;
          return (
            <tr key={b.id} className={idx % 2 === 0 ? "" : "alt"}>
              <td className="ta-c">{idx + 1}</td>
              <td>
                <BuildingGroupBadge groupId={b.group_id} groups={buildingGroups} placement="before" />
                {b.name || `건물 ${b.id}`}
              </td>
              <td className="ta-r mono">{b.height.toFixed(0)}</td>
              {radarSites.map((r) => {
                const az = bearingDeg(r.latitude, r.longitude, b.latitude, b.longitude);
                const dist = haversineKm(r.latitude, r.longitude, b.latitude, b.longitude);
                return (
                  <td key={r.name} className="ta-c mono sm">{az.toFixed(1)}° / {dist.toFixed(1)}km</td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  // ── 분석 대상 위치 도면 (레이더 + 전체 건물 정적 지도) ──
  const renderMap = () => (
    <ReportOMTargetOverviewMap
      buildings={selectedBuildings}
      buildingGroups={buildingGroups}
      radarSites={radarSites}
    />
  );

  // ── 분할 불필요 + 지도 동거: 한 페이지 (표 전량 + 지도) ──
  if (!needsSplit && mapOnFirstPage) {
    return (
      <ReportPage>
        <ReportOMSectionHeader
          sectionNum={sectionNum}
          title="분석 대상"
          editId="summary.title"
        />
        <OMEditable id="summary.bldgHeader" value="분석 대상 장애물" tag="div" className="block-h3" style={{ marginTop: 0 }} />
        {renderBuildingTable(selectedBuildings, 0)}
        {renderMap()}
      </ReportPage>
    );
  }

  // ── 분할/별도 지도 페이지: 첫 페이지(표 [+지도]) + 후속 페이지(잔여 표) [+ 지도 단독 페이지] ──
  const pages: React.ReactNode[] = [];
  const firstSlice = selectedBuildings.slice(0, maxRowsFirstPage);
  pages.push(
    <ReportPage key="summary-0">
      <ReportOMSectionHeader
        sectionNum={sectionNum}
        title="분석 대상"
        editId="summary.title"
      />
      <div className="block-h3" style={{ marginTop: 0 }}>
        <OMEditable id="summary.bldgHeader" value="분석 대상 장애물" tag="span" />
        {needsSplit && <>{" "}({totalBuildings}건 중 1–{maxRowsFirstPage})</>}
      </div>
      {renderBuildingTable(firstSlice, 0)}
      {mapOnFirstPage && renderMap()}
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
          title={`분석 대상 (계속) — 장애물 ${offset + 1}–${Math.min(offset + maxRowsNextPage, totalBuildings)}/${totalBuildings}`}
        />
        {renderBuildingTable(slice, offset)}
      </ReportPage>,
    );
    offset += maxRowsNextPage;
    pageIdx++;
  }

  // 지도를 첫 페이지에 못 실은 경우 — 표 페이지들 뒤에 위치 도면 단독 페이지 추가
  if (!mapOnFirstPage) {
    pages.push(
      <ReportPage key="summary-map">
        <ReportOMSectionHeader
          sectionNum={sectionNum}
          title="분석 대상 (계속) — 위치 도면"
        />
        {renderMap()}
      </ReportPage>,
    );
  }

  return <>{pages}</>;
}

export default React.memo(ReportOMSummarySection);
