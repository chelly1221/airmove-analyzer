import React, { useMemo } from "react";
import { Building } from "lucide-react";
import type { ManualBuilding, RadarSite, LoSProfileData } from "../../types";
import { haversineKm, bearingDeg } from "../../utils/geo";
import ReportOMSectionHeader from "./ReportOMSectionHeader";

interface Props {
  sectionNum: number;
  selectedBuildings: ManualBuilding[];
  radarSites: RadarSite[];
  /** 건물별 × 레이더별 LoS 결과 (key: `${radarName}_${buildingId}`) */
  losMap: Map<string, LoSProfileData>;
  /** true면 헤더 생략 (OMSectionImage 래핑 시 외부에서 헤더 렌더) */
  hideHeader?: boolean;
}

function ReportOMBuildingLoS({ sectionNum, selectedBuildings, radarSites, losMap, hideHeader }: Props) {
  // 방위/거리 사전 계산 (렌더 중 재계산 방지)
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
    <div className="mb-8">
      {!hideHeader && <ReportOMSectionHeader sectionNum={sectionNum} title="건물별 LoS 분석" />}
      <div className="flex flex-col items-center py-12 text-gray-400">
        <Building size={28} strokeWidth={1.2} className="mb-2" />
        <p className="text-sm">분석 대상 건물 없음</p>
      </div>
    </div>
  );

  return (
    <div className="mb-8">
      {!hideHeader && <ReportOMSectionHeader sectionNum={sectionNum} title="건물별 LoS 분석" />}

      <table className="w-full border-collapse text-[13px]">
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
        <tbody>
          {selectedBuildings.map((b, i) => (
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
                        <span
                          className={`rounded px-1.5 py-0.5 text-[13px] font-medium ${
                            los.losBlocked
                              ? "bg-red-50 text-red-600"
                              : "bg-green-50 text-green-600"
                          }`}
                        >
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
          ))}
        </tbody>
      </table>

      {/* 통계 요약 */}
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
    </div>
  );
}

export default React.memo(ReportOMBuildingLoS);
