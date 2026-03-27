import React, { useMemo } from "react";
import { Building } from "lucide-react";
import type { ManualBuilding, RadarSite, LoSProfileData } from "../../types";
import { haversineKm, bearingDeg } from "../../utils/geo";
import ReportOMSectionHeader from "./ReportOMSectionHeader";
import ReportPage from "./ReportPage";
import { PAGE_CONTENT_MM, SECTION_HEADER_MM, ROW_HEIGHT_MD } from "./reportPageConstants";

interface Props {
  sectionNum: number;
  selectedBuildings: ManualBuilding[];
  radarSites: RadarSite[];
  /** 건물별 × 레이더별 LoS 결과 (key: `${radarName}_${buildingId}`) */
  losMap: Map<string, LoSProfileData>;
  /** true면 헤더 생략 (OMSectionImage 래핑 시 외부에서 헤더 렌더) */
  hideHeader?: boolean;
}

// 테이블헤더: 2행(16mm) — 레이더명 + 서브헤더
const TABLE_HEADER_2ROW_MM = 16;
// 통계 요약: 20mm
const STATS_MM = 20;

function ReportOMBuildingLoS({ sectionNum, selectedBuildings, radarSites, losMap, hideHeader }: Props) {
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
      <div className="mb-8">
        {!hideHeader && <ReportOMSectionHeader sectionNum={sectionNum} title="건물별 LoS 분석" />}
        <div className="flex flex-col items-center py-12 text-gray-400">
          <Building size={28} strokeWidth={1.2} className="mb-2" />
          <p className="text-sm">분석 대상 건물 없음</p>
        </div>
      </div>
    </ReportPage>
  );

  const renderTableHeaders = () => (
    <thead>
      <tr className="bg-[#28283c] text-white">
        <th className="border border-gray-300 px-2 py-1 font-medium">#</th>
        <th className="border border-gray-300 px-2 py-1 text-left font-medium">건물명</th>
        <th className="border border-gray-300 px-2 py-1 text-right font-medium">높이(m)</th>
        {radarSites.map((r) => (
          <th key={r.name} className="border border-gray-300 px-1.5 py-1 text-center font-medium" colSpan={3}>
            {r.name}
          </th>
        ))}
      </tr>
      <tr className="bg-gray-100 text-gray-600">
        <th className="border border-gray-300 px-2 py-0.5" />
        <th className="border border-gray-300 px-2 py-0.5" />
        <th className="border border-gray-300 px-2 py-0.5" />
        {radarSites.map((r) => (
          <React.Fragment key={`sub-${r.name}`}>
            <th className="border border-gray-200 px-1 py-0.5 text-center text-[13px]">방위/거리</th>
            <th className="border border-gray-200 px-1 py-0.5 text-center text-[13px]">LoS</th>
            <th className="border border-gray-200 px-1 py-0.5 text-center text-[13px]">최대차단</th>
          </React.Fragment>
        ))}
      </tr>
    </thead>
  );

  const renderRow = (b: ManualBuilding, i: number) => (
    <tr key={b.id} className={i % 2 === 0 ? "bg-white" : "bg-gray-50"}>
      <td className="border border-gray-200 px-2 py-1 text-center">{i + 1}</td>
      <td className="border border-gray-200 px-2 py-1 font-medium">{b.name || `건물 ${b.id}`}</td>
      <td className="border border-gray-200 px-2 py-1 text-right font-mono">{b.height.toFixed(0)}</td>
      {radarSites.map((r) => {
        const key = `${r.name}_${b.id}`;
        const los = losMap.get(key);
        const info = buildingRadarInfo.get(key);
        const az = info?.az ?? 0;
        const dist = info?.dist ?? 0;
        return (
          <React.Fragment key={`cell-${r.name}-${b.id}`}>
            <td className="border border-gray-200 px-1 py-1 text-center font-mono text-[13px]">
              {az.toFixed(1)}° / {dist.toFixed(1)}km
            </td>
            <td className="border border-gray-200 px-1 py-1 text-center">
              {los ? (
                <span className={`rounded px-1.5 py-0.5 text-[13px] font-medium ${
                  los.losBlocked ? "bg-red-50 text-red-600" : "bg-green-50 text-green-600"
                }`}>
                  {los.losBlocked ? "차단" : "양호"}
                </span>
              ) : (
                <span className="text-gray-400">—</span>
              )}
            </td>
            <td className="border border-gray-200 px-1 py-1 text-center text-[13px]">
              {los?.maxBlockingPoint ? (
                <span className="font-mono">
                  {los.maxBlockingPoint.distance.toFixed(1)}km / {los.maxBlockingPoint.elevation.toFixed(0)}m
                  {los.maxBlockingPoint.name && (
                    <span className="ml-0.5 text-gray-400">({los.maxBlockingPoint.name})</span>
                  )}
                </span>
              ) : (
                <span className="text-gray-400">—</span>
              )}
            </td>
          </React.Fragment>
        );
      })}
    </tr>
  );

  const statsSection = (
    <div className="mt-3 grid grid-cols-3 gap-3">
      {radarSites.map((r) => {
        const total = selectedBuildings.length;
        let blocked = 0;
        for (const b of selectedBuildings) {
          const los = losMap.get(`${r.name}_${b.id}`);
          if (los?.losBlocked) blocked++;
        }
        return (
          <div key={r.name} className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-center">
            <p className="text-[13px] text-gray-400">{r.name}</p>
            <p className="text-[13px] font-bold">
              <span className="text-red-600">{blocked}</span>
              <span className="text-gray-400"> / {total} 차단</span>
            </p>
          </div>
        );
      })}
    </div>
  );

  // 페이지 분할 계산
  const headerMM = hideHeader ? 0 : SECTION_HEADER_MM;
  const firstPageRows = Math.floor((PAGE_CONTENT_MM - headerMM - TABLE_HEADER_2ROW_MM - STATS_MM) / ROW_HEIGHT_MD);
  const nextPageRows = Math.floor((PAGE_CONTENT_MM - TABLE_HEADER_2ROW_MM) / ROW_HEIGHT_MD);

  // 단일 페이지
  if (selectedBuildings.length <= firstPageRows) {
    return (
      <ReportPage>
        <div className="mb-8">
          {!hideHeader && <ReportOMSectionHeader sectionNum={sectionNum} title="건물별 LoS 분석" />}
          <table className="w-full border-collapse text-[13px]">
            {renderTableHeaders()}
            <tbody>{selectedBuildings.map((b, i) => renderRow(b, i))}</tbody>
          </table>
          {statsSection}
        </div>
      </ReportPage>
    );
  }

  // 멀티페이지
  const pages: React.ReactNode[] = [];
  let offset = 0;

  // 첫 페이지
  const firstChunk = selectedBuildings.slice(0, firstPageRows);
  pages.push(
    <ReportPage key="blos-0">
      <div className="mb-8">
        {!hideHeader && <ReportOMSectionHeader sectionNum={sectionNum} title="건물별 LoS 분석" />}
        <table className="w-full border-collapse text-[13px]">
          {renderTableHeaders()}
          <tbody>{firstChunk.map((b, i) => renderRow(b, i))}</tbody>
        </table>
      </div>
    </ReportPage>
  );
  offset = firstPageRows;

  // 이후 페이지
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
        <div className="mb-2 text-[10px] text-gray-400">
          건물별 LoS 분석 (계속 — {offset + 1}~{offset + chunk.length}/{selectedBuildings.length})
        </div>
        <table className="w-full border-collapse text-[13px]">
          {renderTableHeaders()}
          <tbody>{chunk.map((b, i) => renderRow(b, offset + i))}</tbody>
        </table>
        {lastPage && statsSection}
      </ReportPage>
    );
    offset += chunk.length;
  }

  return <>{pages}</>;
}

export default React.memo(ReportOMBuildingLoS);
