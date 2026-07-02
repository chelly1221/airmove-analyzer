import React, { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import type {
  RadarMonthlyResult, RadarSite, ManualBuilding, BuildingGroup, LoSProfileData, PanoramaMergeResult, LossPointGeo,
} from "../../types";
import { classifyObstacleLosses, buildSiblings, type ClassifiedLoss } from "../../utils/obstacleAnalysisHelpers";
import ReportOMSectionHeader from "./ReportOMSectionHeader";
import ReportOMLossEventsMap from "./ReportOMLossEventsMap";
import AutoPaginate from "./AutoPaginate";

interface Props {
  sectionNum: number;
  radarResults: RadarMonthlyResult[];
  radarSites: RadarSite[];
  /** 분석 대상 건물 — (레이더 × 건물) 별 정밀 추가 기인 분류 대상 */
  selectedBuildings: ManualBuilding[];
  /** 건물 그룹 메타 — top-down 분포 도면의 footprint 색/범례용 */
  buildingGroups: BuildingGroup[];
  /** 건물별 × 레이더별 LoS 결과 (key: `${radarName}_${buildingId}`) */
  losMap: Map<string, LoSProfileData>;
  /** 레이더별 분석대상 포함 파노라마 — buildingCaused 분류를 섹션3(차트 빨강영역)과 동일 소스로 산출 */
  panoWithByRadar?: Map<string, PanoramaMergeResult>;
  /** 레이더별 분석대상 제외 파노라마 (없으면 without==with → 추가 기인 0, 과대귀속 방지) */
  panoWithoutByRadar?: Map<string, PanoramaMergeResult>;
}

/** 표 표시 상한 — 지속시간 내림차순 상위 5건 (정사각 도면이 페이지 대부분을 차지, 표는 대표 이벤트만) */
const TABLE_TOP_N = 5;

interface LossEvent {
  buildingName: string;
  date: string;
  /** 대표 좌표 — 이벤트(gap)의 중앙 보간점 */
  lat: number;
  lon: number;
  altFt: number;
  /** 이벤트(gap) 전체 지속시간(초) — duration_s. 보간점 합산 아님 */
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
 * 표는 이벤트(event_id, 소실 gap) 단위 1행 — 같은 gap 의 보간점들이 점마다 1행씩 중복 나열되던 것을
 * distinct event_id 로 그룹핑(스키마 계약: '…건' = 이벤트 건수). 지속시간 = duration_s(부모 gap 전체),
 * 대표 좌표/방위/고도 = 그 이벤트의 중앙 보간점. 배지 비율도 이벤트/이벤트(분자·분모 동일 단위).
 *
 * 레이더별 블록: 헤더 + ev-badge → top-down 분포 도면(ReportOMLossEventsMap — 정사각 fullwidth,
 * 범례 하단, 보간점 전수) → 이벤트 표(sm-table, 지속시간 내림차순 상위 5건, 건물명 포함).
 * 같은 레이더의 여러 건물은 sibling 오귀속 방지(가장 강하게 소유한 건물에만 귀속)로 중복 카운트 없음.
 */
function ReportOMLossEvents({
  sectionNum,
  radarResults,
  radarSites,
  selectedBuildings,
  buildingGroups,
  losMap,
  panoWithByRadar,
  panoWithoutByRadar,
}: Props) {
  // radar 좌표 시그니처 — radarSites 객체가 in-place 변경(참조 유지)돼도 재계산 트리거.
  //   섹션3·요약(ReportOMSummarySection)의 sibling 오귀속 계산과 동일 민감도로 동기화.
  const radarGeoKey = radarSites.map((r) => `${r.latitude},${r.longitude},${r.name}`).join(";");

  const eventsByRadar = useMemo(() => {
    const result: {
      radarName: string; radarSite: RadarSite; events: LossEvent[];
      obstacleCausedCount: number; totalCount: number;
      /** 이 레이더에서 LoS 결과가 있는 분석 대상 건물 — 도면 footprint 표시(분류 대상과 동일 집합) */
      mapBuildings: ManualBuilding[];
      /** 추가 기인 분류 소실 보간점 전수 [lat, lon] — 도면 오버레이용 */
      lossPts: [number, number][];
    }[] = [];

    for (const rr of radarResults) {
      const rs = radarSites.find((r) => r.name === rr.radar_name);
      if (!rs) continue;

      // 레이더 소실표적 평탄화 + 일자 역참조 맵 (객체 참조 → 일자). 같은 배열을 건물마다 재사용.
      //   전체 이벤트 건수(totalCount 분모)는 distinct event_id — 보간점 수로 세면 과대(스키마 계약).
      const dateByLp = new Map<LossPointGeo, string>();
      const allLoss: LossPointGeo[] = [];
      const allEventIds = new Set<number>();
      for (const day of rr.daily_stats) {
        for (const lp of day.loss_points_summary) {
          dateByLp.set(lp, day.date);
          allLoss.push(lp);
          allEventIds.add(lp.event_id);
        }
      }

      const panoWith = panoWithByRadar?.get(rr.radar_name);
      const panoWithout = panoWithoutByRadar?.get(rr.radar_name);

      // 이벤트(event_id) 단위 수집 — 같은 gap 의 보간점들이 1행씩 중복 나열되지 않도록 그룹핑.
      //   같은 이벤트의 점이 방위 경계에서 두 건물로 나뉘어 귀속될 수 있으므로 건물별 점 목록을 모아
      //   가장 많은 점을 귀속받은 건물을 대표 건물로 삼는다(이벤트당 정확히 1행).
      const byEvent = new Map<number, Map<string, ClassifiedLoss[]>>();
      for (const b of selectedBuildings) {
        if (!losMap.has(`${rr.radar_name}_${b.id}`)) continue;
        // sibling — buildSiblings 단일 산식(섹션2·3과 동일 스킴: 방위/거리/허용각 + LoS 없는 건물 제외)
        const siblings = buildSiblings(rs, selectedBuildings, b.id, losMap);
        const { losses } = classifyObstacleLosses(rs, b, allLoss, { panoWith, panoWithout, siblings });
        const bname = b.name || `건물 ${b.id}`;
        for (const l of losses) {
          if (!l.buildingCaused) continue;
          let byBldg = byEvent.get(l.source.event_id);
          if (!byBldg) { byBldg = new Map(); byEvent.set(l.source.event_id, byBldg); }
          let arr = byBldg.get(bname);
          if (!arr) { arr = []; byBldg.set(bname, arr); }
          arr.push(l);
        }
      }

      // 이벤트당 1행 — 지속시간 = duration_s(부모 gap 전체), 대표 좌표 = 중앙 보간점(Rust 보간 순서 = 시간순).
      const events: LossEvent[] = [];
      for (const byBldg of byEvent.values()) {
        let bestName = "";
        let bestPts: ClassifiedLoss[] = [];
        for (const [name, pts] of byBldg) {
          if (pts.length > bestPts.length) { bestName = name; bestPts = pts; }
        }
        const rep = bestPts[Math.floor((bestPts.length - 1) / 2)]; // 중앙 보간점
        events.push({
          buildingName: bestName,
          date: dateByLp.get(rep.source) ?? "",
          lat: rep.source.lat,
          lon: rep.source.lon,
          altFt: rep.source.alt_ft,
          durationS: rep.durationS,
          azDeg: rep.azDeg,
          distKm: rep.distKm,
        });
      }

      events.sort((a, b) => b.durationS - a.durationS);

      // 도면용 — 추가 기인 분류 보간점 전수 [lat, lon]. 이벤트 대표점만 찍으면 공간 분포가 왜곡되므로
      //   byEvent 에 수집된 점 전부(건물별 sibling 소유권으로 점당 1회 귀속 — 중복 없음)를 그대로 넘긴다.
      const lossPts: [number, number][] = [];
      for (const byBldg of byEvent.values())
        for (const pts of byBldg.values())
          for (const l of pts) lossPts.push([l.source.lat, l.source.lon]);

      result.push({
        radarName: rr.radar_name,
        radarSite: rs,
        events: events.slice(0, TABLE_TOP_N),
        obstacleCausedCount: byEvent.size,  // 장애물 추가 기인 이벤트 건수 (distinct event_id)
        totalCount: allEventIds.size,       // 전체 소실 이벤트 건수 — 분자와 동일 단위(이벤트/이벤트 비율)
        mapBuildings: selectedBuildings.filter((b) => losMap.has(`${rr.radar_name}_${b.id}`)),
        lossPts,
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

  const radarBlocks = eventsByRadar.map(({ radarName, radarSite, events, obstacleCausedCount, totalCount, mapBuildings, lossPts }) => {
    // 파노라마 가용 여부는 '레이더별'로 검사 — 전역 any(size>0) 검사면 일부 레이더만 파노라마 실패한
    //   세션에서 그 레이더의 classify 가 panoWith 부재로 전부 buildingCaused=0 이 되어 '없음(양호)'/
    //   '0건(0.0%)'으로 단정 표기된다(실제로는 자료 없음 → 분류 불가). 미가용 레이더는 배지·표 대신
    //   '파노라마 미가용 — 분류 불가' 문구로 표기.
    const hasPano = panoWithByRadar?.has(radarName) ?? false;
    if (!hasPano) {
      return (
        <div key={radarName} className="ev-block">
          <div className="ev-head">
            <h3 className="om-h3" style={{ margin: 0 }}>{radarName}</h3>
          </div>
          <p className="muted sm">파노라마 미가용 — 장애물 추가 기인 분류 불가 (전체 소실 이벤트 {totalCount}건)</p>
        </div>
      );
    }

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
          <span className="ev-badge">
            장애물 추가 기인: {obstacleCausedCount}/{totalCount}건 ({obstaclePct.toFixed(1)}%)
          </span>
        </div>

        {/* top-down 분포 도면 — 아래 표의 이벤트가 속한 소실 보간점 전수를 지도에 표시 */}
        {lossPts.length > 0 && (
          <ReportOMLossEventsMap
            radarSite={radarSite}
            buildings={mapBuildings}
            buildingGroups={buildingGroups}
            lossPts={lossPts}
          />
        )}

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

        {obstacleCausedCount > events.length && (
          <p className="muted sm" style={{ textAlign: "right", marginTop: 4 }}>
            상위 {events.length}건 표시 (장애물 추가 기인 {obstacleCausedCount}건, 지속시간 내림차순)
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
