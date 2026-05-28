import React, { useMemo } from "react";
import { Building } from "lucide-react";
import type { ManualBuilding, BuildingGroup, RadarSite, LoSProfileData } from "../../types";
import { haversineKm, bearingDeg } from "../../utils/geo";
import ReportOMSectionHeader from "./ReportOMSectionHeader";
import ReportPage from "./ReportPage";
import BuildingGroupBadge from "./BuildingGroupBadge";
import { PAGE_CONTENT_MM, SECTION_HEADER_MM, ROW_HEIGHT_MD } from "./reportPageConstants";

interface Props {
  sectionNum: number;
  selectedBuildings: ManualBuilding[];
  /** 건물 그룹 메타 (인라인 배지 표시용) */
  buildingGroups: BuildingGroup[];
  radarSites: RadarSite[];
  /** 건물별 × 레이더별 LoS 결과 (key: `${radarName}_${buildingId}`) */
  losMap: Map<string, LoSProfileData>;
  /** true 면 헤더 생략 (OMSectionImage 래핑 시 외부에서 헤더 렌더) */
  hideHeader?: boolean;
}

/** 표 헤더 2행 + sub 행 높이 (mm 추정치) */
const TABLE_HEADER_2ROW_MM = 16;
/** 마지막 페이지 하단 통계 카드 높이 */
const STATS_MM = 20;

/**
 * 건물별 LoS 분석 페이지 (페이지 5).
 *
 * 2단 헤더(레이더 그룹 + 방위/거리·LoS·최대차단 서브) × N 레이더 매트릭스.
 * 마지막 페이지 하단에 레이더별 차단 통계 카드 그리드(.los-stats).
 * 스타일은 reportOmStyles.css 의 `.om-table thead tr.sub`, `.badge.ok/.bad`,
 * `.los-stats`, `.cont-label`.
 */
function ReportOMBuildingLoS({ sectionNum, selectedBuildings, buildingGroups, radarSites, losMap, hideHeader }: Props) {
  const buildingRadarInfo = useMemo(() => {
    const info = new Map<string, { az: number; dist: number }>();
    for (const b of selectedBuildings) {
      for (const r of radarSites) {
        info.set(`${r.name}_${b.id}`, {
          az: bearingDeg(r.latitude, r.longitude, b.latitude, b.longitude),
          dist: haversineKm(r.latitude, r.longitude, b.latitude, b.longitude),
        });
      }
    }
    return info;
  }, [selectedBuildings, radarSites]);

  if (selectedBuildings.length === 0) return (
    <ReportPage>
      {!hideHeader && <ReportOMSectionHeader sectionNum={sectionNum} title="건물별 LoS 분석" />}
      <div className="empty">
        <Building size={28} strokeWidth={1.2} style={{ marginBottom: 8 }} />
        <p className="sm">분석 대상 건물 없음</p>
      </div>
    </ReportPage>
  );

  // ── 2단 헤더 ───────────────────────────────────────────────────────────
  const renderTableHeaders = () => (
    <thead>
      <tr>
        <th className="w-5">#</th>
        <th className="ta-l">건물명</th>
        <th className="ta-r">높이(m)</th>
        {radarSites.map((r) => (
          <th key={r.name} colSpan={3} className="ta-c">{r.name}</th>
        ))}
      </tr>
      <tr className="sub">
        <th />
        <th />
        <th />
        {radarSites.map((r) => (
          <React.Fragment key={`sh-${r.name}`}>
            <th className="ta-c sm">방위/거리</th>
            <th className="ta-c sm">LoS</th>
            <th className="ta-c sm">최대차단</th>
          </React.Fragment>
        ))}
      </tr>
    </thead>
  );

  // ── 본문 행 ───────────────────────────────────────────────────────────
  const renderRow = (b: ManualBuilding, i: number) => (
    <tr key={b.id} className={i % 2 === 0 ? "" : "alt"}>
      <td className="ta-c">{i + 1}</td>
      <td className="strong">
        {b.name || `건물 ${b.id}`}
        <BuildingGroupBadge groupId={b.group_id} groups={buildingGroups} />
      </td>
      <td className="ta-r mono">{b.height.toFixed(0)}</td>
      {radarSites.map((r) => {
        const key = `${r.name}_${b.id}`;
        const los = losMap.get(key);
        const info = buildingRadarInfo.get(key);
        const az = info?.az ?? 0;
        const dist = info?.dist ?? 0;
        return (
          <React.Fragment key={`cell-${r.name}-${b.id}`}>
            <td className="ta-c mono sm">{az.toFixed(1)}° / {dist.toFixed(1)}km</td>
            <td className="ta-c sm">
              {los ? (
                <span className={`badge ${los.losBlocked ? "bad" : "ok"}`}>
                  {los.losBlocked ? "차단" : "양호"}
                </span>
              ) : (
                <span className="muted">—</span>
              )}
            </td>
            <td className="ta-c mono sm">
              {los?.maxBlockingPoint ? (
                <>
                  {los.maxBlockingPoint.distance.toFixed(1)}km / {los.maxBlockingPoint.elevation.toFixed(0)}m
                  {los.maxBlockingPoint.name && (
                    <span className="muted"> ({los.maxBlockingPoint.name.slice(0, 6)})</span>
                  )}
                </>
              ) : (
                <span className="muted">—</span>
              )}
            </td>
          </React.Fragment>
        );
      })}
    </tr>
  );

  // ── 하단 통계 카드 그리드 (마지막 페이지) ────────────────────────────────
  const statsSection = (
    <div
      className="los-stats"
      style={{ gridTemplateColumns: `repeat(${radarSites.length}, 1fr)` }}
    >
      {radarSites.map((r) => {
        const total = selectedBuildings.length;
        let blocked = 0;
        for (const b of selectedBuildings) {
          const los = losMap.get(`${r.name}_${b.id}`);
          if (los?.losBlocked) blocked++;
        }
        return (
          <div key={r.name} className="los-stat">
            <p className="muted">{r.name}</p>
            <p className="los-stat-val">
              <span style={{ color: "#dc2626" }}>{blocked}</span>{" "}
              <span className="muted">/ {total} 차단</span>
            </p>
          </div>
        );
      })}
    </div>
  );

  // ── 페이지 분할 계산 ──────────────────────────────────────────────────
  const headerMM = hideHeader ? 0 : SECTION_HEADER_MM;
  const firstPageRows = Math.floor((PAGE_CONTENT_MM - headerMM - TABLE_HEADER_2ROW_MM - STATS_MM) / ROW_HEIGHT_MD);
  const nextPageRows = Math.floor((PAGE_CONTENT_MM - TABLE_HEADER_2ROW_MM) / ROW_HEIGHT_MD);

  // 단일 페이지
  if (selectedBuildings.length <= firstPageRows) {
    return (
      <ReportPage>
        {!hideHeader && <ReportOMSectionHeader sectionNum={sectionNum} title="건물별 LoS 분석" />}
        <table className="om-table">
          {renderTableHeaders()}
          <tbody>{selectedBuildings.map((b, i) => renderRow(b, i))}</tbody>
        </table>
        {statsSection}
      </ReportPage>
    );
  }

  // 멀티페이지
  const pages: React.ReactNode[] = [];

  // 첫 페이지
  const firstChunk = selectedBuildings.slice(0, firstPageRows);
  pages.push(
    <ReportPage key="blos-0">
      {!hideHeader && <ReportOMSectionHeader sectionNum={sectionNum} title="건물별 LoS 분석" />}
      <table className="om-table">
        {renderTableHeaders()}
        <tbody>{firstChunk.map((b, i) => renderRow(b, i))}</tbody>
      </table>
    </ReportPage>,
  );
  let offset = firstPageRows;

  while (offset < selectedBuildings.length) {
    const remaining = selectedBuildings.length - offset;
    const isLast = remaining <= nextPageRows;
    const rowsThisPage = isLast
      ? Math.floor((PAGE_CONTENT_MM - TABLE_HEADER_2ROW_MM - STATS_MM) / ROW_HEIGHT_MD)
      : nextPageRows;
    const chunk = selectedBuildings.slice(offset, offset + Math.min(rowsThisPage, remaining));
    const lastPage = offset + chunk.length >= selectedBuildings.length;
    const pageIdx = pages.length;

    pages.push(
      <ReportPage key={`blos-${pageIdx}`}>
        <div className="cont-label">
          건물별 LoS 분석 (계속 — {offset + 1}~{offset + chunk.length}/{selectedBuildings.length})
        </div>
        <table className="om-table">
          {renderTableHeaders()}
          <tbody>{chunk.map((b, i) => renderRow(b, offset + i))}</tbody>
        </table>
        {lastPage && statsSection}
      </ReportPage>,
    );
    offset += chunk.length;
  }

  return <>{pages}</>;
}

export default React.memo(ReportOMBuildingLoS);
