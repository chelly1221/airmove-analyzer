import React, { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import type { RadarMonthlyResult, ManualBuilding, RadarSite } from "../../types";
import type { CoverageLayer } from "../../utils/radarCoverage";
import { azimuthAndDist } from "../../utils/geo";

interface Props {
  sectionNum: number;
  radarResults: RadarMonthlyResult[];
  selectedBuildings: ManualBuilding[];
  radarSites: RadarSite[];
  /** 건물 포함 커버리지 레이어 */
  layersWithTargets: CoverageLayer[];
  /** 건물 제외 커버리지 레이어 */
  layersWithoutTargets: CoverageLayer[];
}

/** 방위별 커버리지 범위(km) lookup — O(1) 인덱스 기반 */
function coverageRangeAt(layer: CoverageLayer, azDeg: number): number {
  const n = layer.bearings.length;
  if (n === 0) return 0;
  const step = 360 / n;
  const idx = Math.round(((azDeg % 360) + 360) % 360 / step) % n;
  return layer.bearings[idx].maxRangeKm;
}

/** Loss 포인트가 커버리지 차이(장애물로 인해 줄어든) 영역에 있는지 판정 */
function isInCoverageDiffArea(
  lat: number, lon: number, altFt: number,
  radarLat: number, radarLon: number,
  withLayers: CoverageLayer[], withoutLayers: CoverageLayer[],
): boolean {
  const { azDeg, distKm } = azimuthAndDist(radarLat, radarLon, lat, lon);

  // 해당 고도에 가장 가까운 레이어 찾기
  const findClosest = (layers: CoverageLayer[]) => {
    if (layers.length === 0) return null;
    let best = layers[0];
    let bestDiff = Math.abs(layers[0].altitudeFt - altFt);
    for (const l of layers) {
      const d = Math.abs(l.altitudeFt - altFt);
      if (d < bestDiff) { bestDiff = d; best = l; }
    }
    return best;
  };

  const withLayer = findClosest(withLayers);
  const withoutLayer = findClosest(withoutLayers);
  if (!withLayer || !withoutLayer) return false;

  const rangeWith = coverageRangeAt(withLayer, azDeg);
  const rangeWithout = coverageRangeAt(withoutLayer, azDeg);

  // 건물 제외 시 커버리지에 포함되지만 건물 포함 시 커버리지 밖 → 장애물 기인
  return distKm <= rangeWithout && distKm > rangeWith;
}

/** 최대 표시 건수 */
const MAX_EVENTS = 30;

interface LossEvent {
  date: string;
  lat: number;
  lon: number;
  altFt: number;
  durationS: number;
  azDeg: number;
  distKm: number;
  obstacleCaused: boolean;
}

function ReportOMLossEvents({
  sectionNum,
  radarResults,
  selectedBuildings,
  radarSites,
  layersWithTargets,
  layersWithoutTargets,
}: Props) {
  const eventsByRadar = useMemo(() => {
    const result: { radarName: string; events: LossEvent[]; obstacleCausedCount: number; totalCount: number }[] = [];

    for (const rr of radarResults) {
      const rs = radarSites.find((r) => r.name === rr.radar_name);
      if (!rs) continue;

      const events: LossEvent[] = [];
      for (const day of rr.daily_stats) {
        for (const lp of day.loss_points_summary) {
          const { azDeg, distKm } = azimuthAndDist(rs.latitude, rs.longitude, lp.lat, lp.lon);
          const obstacleCaused = isInCoverageDiffArea(
            lp.lat, lp.lon, lp.alt_ft,
            rs.latitude, rs.longitude,
            layersWithTargets, layersWithoutTargets,
          );
          events.push({
            date: day.date,
            lat: lp.lat,
            lon: lp.lon,
            altFt: lp.alt_ft,
            durationS: lp.duration_s,
            azDeg,
            distKm,
            obstacleCaused,
          });
        }
      }

      // 지속시간 내림차순 정렬
      events.sort((a, b) => b.durationS - a.durationS);
      const obstacleCausedCount = events.filter((e) => e.obstacleCaused).length;

      result.push({
        radarName: rr.radar_name,
        events: events.slice(0, MAX_EVENTS),
        obstacleCausedCount,
        totalCount: events.length,
      });
    }

    return result;
  }, [radarResults, radarSites, layersWithTargets, layersWithoutTargets]);

  if (eventsByRadar.length === 0) {
    const hasDailyData = radarResults.some((rr) => rr.daily_stats.length > 0);
    return (
      <div className="mb-8">
        <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[19px] font-bold text-gray-900">
          {sectionNum}. 장애물 기인 표적소실 상세
        </h2>
        <div className="flex flex-col items-center py-12 text-gray-400">
          <AlertTriangle size={28} strokeWidth={1.2} className="mb-2" />
          <p className="text-sm">{hasDailyData ? "분석 기간 내 표적소실 미발생 (양호)" : "분석 데이터 없음"}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-8">
      <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[19px] font-bold text-gray-900">
        {sectionNum}. 장애물 기인 표적소실 상세
      </h2>

      {eventsByRadar.map(({ radarName, events, obstacleCausedCount, totalCount }) => {
        if (events.length === 0) {
          return (
            <div key={radarName} className="mb-5">
              <h3 className="mb-2 text-[15px] font-semibold text-gray-700">{radarName}</h3>
              <p className="text-[12px] text-gray-400">표적소실 이벤트 없음</p>
            </div>
          );
        }

        const hasCovData = layersWithTargets.length > 0 && layersWithoutTargets.length > 0;
        const obstaclePct = totalCount > 0 ? (obstacleCausedCount / totalCount) * 100 : 0;

        return (
          <div key={radarName} className="mb-6">
            <div className="flex items-center gap-3 mb-2">
              <h3 className="text-[15px] font-semibold text-gray-700">{radarName}</h3>
              {hasCovData && (
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="px-1.5 py-0.5 rounded bg-red-50 text-red-700 font-semibold">
                    장애물 기인: {obstacleCausedCount}/{totalCount}건 ({obstaclePct.toFixed(1)}%)
                  </span>
                </div>
              )}
            </div>

            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="bg-[#28283c] text-white">
                  <th className="border border-gray-300 px-1.5 py-1 text-center font-medium w-4">#</th>
                  <th className="border border-gray-300 px-1.5 py-1 text-center font-medium">일자</th>
                  <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">방위(°)</th>
                  <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">거리(km)</th>
                  <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">거리(NM)</th>
                  <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">고도(ft)</th>
                  <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">지속(초)</th>
                  <th className="border border-gray-300 px-1.5 py-1 text-center font-medium">좌표</th>
                  {hasCovData && (
                    <th className="border border-gray-300 px-1.5 py-1 text-center font-medium">판정</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {events.map((ev, i) => (
                  <tr key={i} className={i % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                    <td className="border border-gray-200 px-1.5 py-0.5 text-center text-gray-400">{i + 1}</td>
                    <td className="border border-gray-200 px-1.5 py-0.5 text-center font-mono">{ev.date}</td>
                    <td className="border border-gray-200 px-1.5 py-0.5 text-right font-mono">{ev.azDeg.toFixed(1)}</td>
                    <td className="border border-gray-200 px-1.5 py-0.5 text-right font-mono">{ev.distKm.toFixed(1)}</td>
                    <td className="border border-gray-200 px-1.5 py-0.5 text-right font-mono">{(ev.distKm / 1.852).toFixed(1)}</td>
                    <td className="border border-gray-200 px-1.5 py-0.5 text-right font-mono">{ev.altFt.toFixed(0)}</td>
                    <td className="border border-gray-200 px-1.5 py-0.5 text-right font-mono">{ev.durationS.toFixed(1)}</td>
                    <td className="border border-gray-200 px-1.5 py-0.5 text-center font-mono text-gray-500">
                      {ev.lat.toFixed(4)}, {ev.lon.toFixed(4)}
                    </td>
                    {hasCovData && (
                      <td className="border border-gray-200 px-1.5 py-0.5 text-center">
                        {ev.obstacleCaused ? (
                          <span className="px-1.5 py-0.5 rounded text-[11px] font-bold bg-red-100 text-red-700">장애물</span>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded text-[11px] font-bold bg-gray-100 text-gray-500">기타</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>

            {totalCount > MAX_EVENTS && (
              <p className="mt-1 text-[11px] text-gray-400 text-right">
                상위 {MAX_EVENTS}건 표시 (전체 {totalCount}건, 지속시간 내림차순)
              </p>
            )}

            {/* 장애물별 근접 표적소실 요약 */}
            {selectedBuildings.length > 0 && (() => {
              const rs = radarSites.find((r) => r.name === radarName);
              if (!rs) return null;
              return (
                <div className="mt-3">
                  <h3 className="mb-2 text-[15px] font-semibold text-gray-700">장애물별 근접 표적소실</h3>
                  <table className="w-full border-collapse text-[12px]">
                    <thead>
                      <tr className="bg-[#28283c] text-white">
                        <th className="border border-gray-300 px-2 py-1 text-left font-medium">건물명</th>
                        <th className="border border-gray-300 px-2 py-1 text-right font-medium">높이(m)</th>
                        <th className="border border-gray-300 px-2 py-1 text-right font-medium">방위(°)</th>
                        <th className="border border-gray-300 px-2 py-1 text-right font-medium">거리(km)</th>
                        <th className="border border-gray-300 px-2 py-1 text-right font-medium">±5° 내 Loss</th>
                        <th className="border border-gray-300 px-2 py-1 text-right font-medium">총 지속시간(초)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedBuildings.map((b, bi) => {
                        const { azDeg: bAz, distKm: bDist } = azimuthAndDist(rs.latitude, rs.longitude, b.latitude, b.longitude);
                        // 방위 ±5° 이내 + 건물 후방(거리 ≥ 건물거리) Loss 필터
                        const nearby = events.filter((ev) => {
                          let azDiff = Math.abs(ev.azDeg - bAz);
                          if (azDiff > 180) azDiff = 360 - azDiff;
                          return azDiff <= 5 && ev.distKm >= bDist * 0.8;
                        });
                        const totalDur = nearby.reduce((s, e) => s + e.durationS, 0);
                        return (
                          <tr key={b.id} className={bi % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                            <td className="border border-gray-200 px-2 py-0.5">{b.name || `건물${b.id}`}</td>
                            <td className="border border-gray-200 px-2 py-0.5 text-right font-mono">{b.height.toFixed(1)}</td>
                            <td className="border border-gray-200 px-2 py-0.5 text-right font-mono">{bAz.toFixed(1)}</td>
                            <td className="border border-gray-200 px-2 py-0.5 text-right font-mono">{bDist.toFixed(1)}</td>
                            <td className="border border-gray-200 px-2 py-0.5 text-right font-mono font-bold"
                              style={{ color: nearby.length > 0 ? "#dc2626" : "#374151" }}>
                              {nearby.length}건
                            </td>
                            <td className="border border-gray-200 px-2 py-0.5 text-right font-mono">
                              {totalDur.toFixed(1)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })()}
          </div>
        );
      })}
    </div>
  );
}

export default React.memo(ReportOMLossEvents);
