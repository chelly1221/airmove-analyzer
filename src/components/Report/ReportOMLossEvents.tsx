import React, { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import type { RadarMonthlyResult, ManualBuilding, BuildingGroup, RadarSite } from "../../types";
import type { CoverageLayer } from "../../utils/radarCoverage";
import { azimuthAndDist } from "../../utils/geo";
import ReportOMSectionHeader from "./ReportOMSectionHeader";
import AutoPaginate from "./AutoPaginate";
import BuildingGroupBadge from "./BuildingGroupBadge";

interface Props {
  sectionNum: number;
  radarResults: RadarMonthlyResult[];
  selectedBuildings: ManualBuilding[];
  /** 건물 그룹 메타 (인라인 배지 표시용) */
  buildingGroups: BuildingGroup[];
  radarSites: RadarSite[];
  /** 레이더별 건물 포함 커버리지 레이어 */
  layersWithTargets: Map<string, CoverageLayer[]>;
  /** 레이더별 건물 제외 커버리지 레이어 */
  layersWithoutTargets: Map<string, CoverageLayer[]>;
}

/** 방위별 커버리지 범위(km) lookup — O(1) 인덱스 기반 */
function coverageRangeAt(layer: CoverageLayer, azDeg: number): number {
  const n = layer.bearings.length;
  if (n === 0) return 0;
  const step = 360 / n;
  const idx = Math.round(((azDeg % 360) + 360) % 360 / step) % n;
  return layer.bearings[idx].maxRangeKm;
}

/**
 * Loss 포인트가 커버리지 차이(장애물 포함 vs 제외)로 줄어든 영역에 있는지 판정.
 * 시안의 단순 ±5° + 거리 80% 휴리스틱 대신 실제 커버리지 결과를 사용 — 더 정확.
 */
function isInCoverageDiffArea(
  lat: number, lon: number, altFt: number,
  radarLat: number, radarLon: number,
  withLayers: CoverageLayer[], withoutLayers: CoverageLayer[],
): boolean {
  const { azDeg, distKm } = azimuthAndDist(radarLat, radarLon, lat, lon);

  const interpolatedRange = (layers: CoverageLayer[]) => {
    if (layers.length === 0) return 0;
    const sorted = [...layers].sort((a, b) => a.altitudeFt - b.altitudeFt);
    if (altFt <= sorted[0].altitudeFt) return coverageRangeAt(sorted[0], azDeg);
    if (altFt >= sorted[sorted.length - 1].altitudeFt) return coverageRangeAt(sorted[sorted.length - 1], azDeg);
    for (let i = 0; i < sorted.length - 1; i++) {
      if (altFt >= sorted[i].altitudeFt && altFt <= sorted[i + 1].altitudeFt) {
        const t = (altFt - sorted[i].altitudeFt) / (sorted[i + 1].altitudeFt - sorted[i].altitudeFt);
        const r0 = coverageRangeAt(sorted[i], azDeg);
        const r1 = coverageRangeAt(sorted[i + 1], azDeg);
        return r0 + t * (r1 - r0);
      }
    }
    return coverageRangeAt(sorted[0], azDeg);
  };

  const rangeWith = interpolatedRange(withLayers);
  const rangeWithout = interpolatedRange(withoutLayers);
  return distKm <= rangeWithout && distKm > rangeWith;
}

/** 최대 표시 건수 (디자인 시안 락-인 값) */
const MAX_EVENTS = 18;

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

/**
 * 장애물 기인 표적소실 상세 페이지 (페이지 6).
 *
 * 레이더별 블록 구조: 헤더 + ev-badge → 이벤트 표(sm-table, 상위 18건) →
 * 장애물별 근접 표적소실 요약 표(상위 12개 건물). 스타일은
 * reportOmStyles.css 의 `.ev-block`, `.ev-head`, `.ev-badge`, `.om-table.sm-table`.
 */
function ReportOMLossEvents({
  sectionNum,
  radarResults,
  selectedBuildings,
  buildingGroups,
  radarSites,
  layersWithTargets,
  layersWithoutTargets,
}: Props) {
  const eventsByRadar = useMemo(() => {
    const result: { radarName: string; events: LossEvent[]; obstacleCausedCount: number; totalCount: number }[] = [];

    for (const rr of radarResults) {
      const rs = radarSites.find((r) => r.name === rr.radar_name);
      if (!rs) continue;
      const rsLayersWith = layersWithTargets.get(rr.radar_name) ?? [];
      const rsLayersWithout = layersWithoutTargets.get(rr.radar_name) ?? [];

      const events: LossEvent[] = [];
      for (const day of rr.daily_stats) {
        for (const lp of day.loss_points_summary) {
          const { azDeg, distKm } = azimuthAndDist(rs.latitude, rs.longitude, lp.lat, lp.lon);
          const obstacleCaused = isInCoverageDiffArea(
            lp.lat, lp.lon, lp.alt_ft,
            rs.latitude, rs.longitude,
            rsLayersWith, rsLayersWithout,
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

      const obstacleEvents = events.filter((e) => e.obstacleCaused);
      obstacleEvents.sort((a, b) => b.durationS - a.durationS);

      result.push({
        radarName: rr.radar_name,
        events: obstacleEvents.slice(0, MAX_EVENTS),
        obstacleCausedCount: obstacleEvents.length,
        totalCount: events.length,
      });
    }

    return result;
  }, [radarResults, radarSites, layersWithTargets, layersWithoutTargets]);

  const sectionHeader = (
    <ReportOMSectionHeader sectionNum={sectionNum} title="장애물 기인 표적소실 상세" />
  );

  if (eventsByRadar.length === 0) {
    const hasDailyData = radarResults.some((rr) => rr.daily_stats.length > 0);
    return (
      <AutoPaginate firstHeader={sectionHeader}>
        <div className="empty">
          <AlertTriangle size={28} strokeWidth={1.2} style={{ marginBottom: 8 }} />
          <p className="sm">{hasDailyData ? "분석 기간 내 표적소실 미발생 (양호)" : "분석 데이터 없음"}</p>
        </div>
      </AutoPaginate>
    );
  }

  const radarBlocks = eventsByRadar.map(({ radarName, events, obstacleCausedCount, totalCount }) => {
    if (events.length === 0) {
      return (
        <div key={radarName} className="ev-block">
          <div className="ev-head">
            <h3 className="om-h3" style={{ margin: 0 }}>{radarName}</h3>
          </div>
          <p className="muted sm">장애물 기인 표적소실 없음 (전체 {totalCount}건 중 해당 없음)</p>
        </div>
      );
    }

    const hasCovData = layersWithTargets.size > 0 && layersWithoutTargets.size > 0;
    const obstaclePct = totalCount > 0 ? (obstacleCausedCount / totalCount) * 100 : 0;
    const rs = radarSites.find((r) => r.name === radarName);

    return (
      <div key={radarName} className="ev-block">
        <div className="ev-head">
          <h3 className="om-h3" style={{ margin: 0 }}>{radarName}</h3>
          {hasCovData && (
            <span className="ev-badge">
              장애물 기인: {obstacleCausedCount}/{totalCount}건 ({obstaclePct.toFixed(1)}%)
            </span>
          )}
        </div>

        <table className="om-table sm-table">
          <thead>
            <tr>
              <th>#</th>
              <th>일자</th>
              <th className="ta-r">방위(°)</th>
              <th className="ta-r">거리(km)</th>
              <th className="ta-r">거리(NM)</th>
              <th className="ta-r">고도(ft)</th>
              <th className="ta-r">지속(초)</th>
              <th className="ta-c">좌표</th>
            </tr>
          </thead>
          <tbody>
            {events.map((ev, i) => (
              <tr key={i} className={i % 2 === 0 ? "" : "alt"}>
                <td className="ta-c muted">{i + 1}</td>
                <td className="ta-c mono">{ev.date}</td>
                <td className="ta-r mono">{ev.azDeg.toFixed(1)}</td>
                <td className="ta-r mono">{ev.distKm.toFixed(1)}</td>
                <td className="ta-r mono">{(ev.distKm / 1.852).toFixed(1)}</td>
                <td className="ta-r mono">{ev.altFt.toFixed(0)}</td>
                <td className="ta-r mono">{ev.durationS.toFixed(1)}</td>
                <td className="ta-c mono muted">{ev.lat.toFixed(4)}, {ev.lon.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {obstacleCausedCount > MAX_EVENTS && (
          <p className="muted sm" style={{ textAlign: "right", marginTop: 4 }}>
            상위 {MAX_EVENTS}건 표시 (장애물 기인 {obstacleCausedCount}건, 지속시간 내림차순)
          </p>
        )}

        {/* 장애물별 근접 표적소실 요약 — 상위 12개 건물 */}
        {selectedBuildings.length > 0 && rs && (
          <>
            <div className="block-h3" style={{ marginTop: 12 }}>장애물별 근접 표적소실</div>
            <table className="om-table sm-table">
              <thead>
                <tr>
                  <th className="ta-l">건물명</th>
                  <th className="ta-r">높이(m)</th>
                  <th className="ta-r">방위(°)</th>
                  <th className="ta-r">거리(km)</th>
                  <th className="ta-r">±5° 내 Loss</th>
                  <th className="ta-r">총 지속(초)</th>
                </tr>
              </thead>
              <tbody>
                {selectedBuildings.slice(0, 12).map((b, bi) => {
                  const { azDeg: bAz, distKm: bDist } = azimuthAndDist(rs.latitude, rs.longitude, b.latitude, b.longitude);
                  // 비대칭 거리 조건: 장애물에 의한 전파 차단은 건물 후방(레이더로부터
                  // 더 먼 쪽)에서 발생하므로 건물 거리의 80% 이상인 Loss 만 포함.
                  const nearby = events.filter((ev) => {
                    let azDiff = Math.abs(ev.azDeg - bAz);
                    if (azDiff > 180) azDiff = 360 - azDiff;
                    return azDiff <= 5 && ev.distKm >= bDist * 0.8;
                  });
                  const totalDur = nearby.reduce((s, e) => s + e.durationS, 0);
                  return (
                    <tr key={b.id} className={bi % 2 === 0 ? "" : "alt"}>
                      <td>
                        {b.name || `건물${b.id}`}
                        <BuildingGroupBadge groupId={b.group_id} groups={buildingGroups} />
                      </td>
                      <td className="ta-r mono">{b.height.toFixed(1)}</td>
                      <td className="ta-r mono">{bAz.toFixed(1)}</td>
                      <td className="ta-r mono">{bDist.toFixed(1)}</td>
                      <td
                        className="ta-r mono strong"
                        style={{ color: nearby.length > 0 ? "#dc2626" : "#374151" }}
                      >
                        {nearby.length}건
                      </td>
                      <td className="ta-r mono">{totalDur.toFixed(1)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </div>
    );
  });

  return (
    <AutoPaginate firstHeader={sectionHeader}>
      {radarBlocks}
    </AutoPaginate>
  );
}

export default React.memo(ReportOMLossEvents);
