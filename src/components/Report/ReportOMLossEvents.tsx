import React, { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import type {
  RadarMonthlyResult, RadarSite, ManualBuilding, LoSProfileData, PanoramaMergeResult, LossPointGeo,
} from "../../types";
import { bearingDeg, haversineKm } from "../../utils/geo";
import { classifyObstacleLosses } from "../../utils/obstacleAnalysisHelpers";
import ReportOMSectionHeader from "./ReportOMSectionHeader";
import AutoPaginate from "./AutoPaginate";

interface Props {
  sectionNum: number;
  radarResults: RadarMonthlyResult[];
  radarSites: RadarSite[];
  /** 분석 대상 건물 — (레이더 × 건물) 별 정밀 추가 기인 분류 대상 */
  selectedBuildings: ManualBuilding[];
  /** 건물별 × 레이더별 LoS 결과 (key: `${radarName}_${buildingId}`) */
  losMap: Map<string, LoSProfileData>;
  /** 레이더별 분석대상 포함 파노라마 — buildingCaused 분류를 섹션3(차트 빨강영역)과 동일 소스로 산출 */
  panoWithByRadar?: Map<string, PanoramaMergeResult>;
  /** 레이더별 분석대상 제외 파노라마 (없으면 without==with → 추가 기인 0, 과대귀속 방지) */
  panoWithoutByRadar?: Map<string, PanoramaMergeResult>;
}

/** 최대 표시 건수 */
const MAX_EVENTS = 30;

interface LossEvent {
  buildingName: string;
  date: string;
  lat: number;
  lon: number;
  altFt: number;
  durationS: number;
  azDeg: number;
  distKm: number;
}

/**
 * 장애물 추가 기인 표적소실 상세 페이지.
 *
 * 섹션3(장애물별 상세)과 동일한 정밀 분류(classifyObstacleLosses 의 `buildingCaused`)를 사용한다.
 *   buildingCaused = 통합 차단(with) 음영 안 && 양각 ≥ 분석대상 제외(without) 차단각
 *   = [without, with] '대상 추가 차단' 밴드에 든 소실표적 = 차트 빨강영역·검은× 점과 by-construction 일치.
 * 커버리지 차이 휴리스틱(이전)이 아닌, 파노라마 실루엣 기반 양각 차단 비교로 산출 — 훨씬 정확.
 *
 * 레이더별 블록: 헤더 + ev-badge → 이벤트 표(sm-table, 상위 30건, 건물명 포함, 지속시간 내림차순).
 * 같은 레이더의 여러 건물은 sibling 오귀속 방지(가장 강하게 소유한 건물에만 귀속)로 중복 카운트 없음.
 */
function ReportOMLossEvents({
  sectionNum,
  radarResults,
  radarSites,
  selectedBuildings,
  losMap,
  panoWithByRadar,
  panoWithoutByRadar,
}: Props) {
  // radar 좌표 시그니처 — radarSites 객체가 in-place 변경(참조 유지)돼도 재계산 트리거.
  //   섹션3·요약(ReportOMSummarySection)의 sibling 오귀속 계산과 동일 민감도로 동기화.
  const radarGeoKey = radarSites.map((r) => `${r.latitude},${r.longitude},${r.name}`).join(";");

  const eventsByRadar = useMemo(() => {
    const result: { radarName: string; events: LossEvent[]; obstacleCausedCount: number; totalCount: number }[] = [];

    for (const rr of radarResults) {
      const rs = radarSites.find((r) => r.name === rr.radar_name);
      if (!rs) continue;

      // 레이더 소실표적 평탄화 + 일자 역참조 맵 (객체 참조 → 일자). 같은 배열을 건물마다 재사용.
      const dateByLp = new Map<LossPointGeo, string>();
      const allLoss: LossPointGeo[] = [];
      for (const day of rr.daily_stats) {
        for (const lp of day.loss_points_summary) {
          dateByLp.set(lp, day.date);
          allLoss.push(lp);
        }
      }

      // 같은 레이더의 건물별 방위/거리 — sibling 오귀속 방지(섹션3·요약과 동일 스킴: 정확히 한 건물만 카운트)
      const azByBldg = selectedBuildings.map((b) => ({
        id: b.id,
        azDeg: bearingDeg(rs.latitude, rs.longitude, b.latitude, b.longitude),
        distKm: haversineKm(rs.latitude, rs.longitude, b.latitude, b.longitude),
      }));

      const panoWith = panoWithByRadar?.get(rr.radar_name);
      const panoWithout = panoWithoutByRadar?.get(rr.radar_name);

      const events: LossEvent[] = [];
      for (const b of selectedBuildings) {
        const los = losMap.get(`${rr.radar_name}_${b.id}`);
        if (!los) continue;
        const siblings = azByBldg.filter((x) => x.id !== b.id);
        const { losses } = classifyObstacleLosses(rs, b, los, allLoss, { panoWith, panoWithout, siblings });
        const bname = b.name || `건물 ${b.id}`;
        for (const l of losses) {
          if (!l.buildingCaused) continue;
          events.push({
            buildingName: bname,
            date: dateByLp.get(l.source) ?? "",
            lat: l.source.lat,
            lon: l.source.lon,
            altFt: l.source.alt_ft,
            durationS: l.durationS,
            azDeg: l.azDeg,
            distKm: l.distKm,
          });
        }
      }

      events.sort((a, b) => b.durationS - a.durationS);
      result.push({
        radarName: rr.radar_name,
        events: events.slice(0, MAX_EVENTS),
        obstacleCausedCount: events.length,
        totalCount: allLoss.length,
      });
    }

    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- radarGeoKey 는 radarSites 가 참조 유지된 채 좌표만 in-place 변경돼도 재계산시키기 위함. 섹션3/요약 sibling 분류와 동기화 보장.
  }, [radarResults, radarSites, radarGeoKey, selectedBuildings, losMap, panoWithByRadar, panoWithoutByRadar]);

  const sectionHeader = (
    <ReportOMSectionHeader sectionNum={sectionNum} title="장애물 추가 기인 표적소실 상세" editId="lossEvents.title" />
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

  const hasPanoData = (panoWithByRadar?.size ?? 0) > 0;

  const radarBlocks = eventsByRadar.map(({ radarName, events, obstacleCausedCount, totalCount }) => {
    if (events.length === 0) {
      return (
        <div key={radarName} className="ev-block">
          <div className="ev-head">
            <h3 className="om-h3" style={{ margin: 0 }}>{radarName}</h3>
          </div>
          <p className="muted sm">장애물 추가 기인 표적소실 없음 (전체 {totalCount}건 중 해당 없음)</p>
        </div>
      );
    }

    const obstaclePct = totalCount > 0 ? (obstacleCausedCount / totalCount) * 100 : 0;

    return (
      <div key={radarName} className="ev-block">
        <div className="ev-head">
          <h3 className="om-h3" style={{ margin: 0 }}>{radarName}</h3>
          {hasPanoData && (
            <span className="ev-badge">
              장애물 추가 기인: {obstacleCausedCount}/{totalCount}건 ({obstaclePct.toFixed(1)}%)
            </span>
          )}
        </div>

        <table className="om-table sm-table">
          <thead>
            <tr>
              <th>#</th>
              <th>건물명</th>
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
                <td>{ev.buildingName}</td>
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
            상위 {MAX_EVENTS}건 표시 (장애물 추가 기인 {obstacleCausedCount}건, 지속시간 내림차순)
          </p>
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
