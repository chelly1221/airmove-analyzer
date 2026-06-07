/**
 * 추가 차단영역 소실율 산출 — Rust az×elev 시간 히스토그램을 건물별 컷오프로 슬라이스.
 *
 * 헤드라인 심각도 지표: "분석 대상 건물이 새로 가리는 노출 비행시간 중 소실된 비율"
 * = 노출 조건부 소실율. 방위 비교(교란·반사실 부재)를 대체하는 인과 지표.
 *
 * 추가 차단영역 밴드 = angleWithout(az) ≤ elev < angleWith(az) — classifyObstacleLosses 의 buildingCaused
 * 정의·AzElev 차트 빨강영역(panoWith−panoWithout)과 동일 소스(makePanoramaSampler)·동일 프레임
 * (실제지구 R=6,371,000, lossElevAngleDeg). Rust 히스토그램의 양각 빈도 같은 프레임이라 정렬된다.
 *
 *   분모(노출) = Σ(추가 차단영역 셀의 추적시간 + 소실시간),  분자 = Σ(추가 차단영역 셀의 소실시간)
 *   소실율(%) = 분자 / 분모 × 100
 *
 * v1: panoWithout 는 "전체 분석대상 제외" 한 종류(panoWithoutTargets). 단일/비중첩 건물엔 정확.
 *     방위 중첩 건물끼리는 공유 한계기여를 양쪽에 중복 귀속(차트 빨강영역과는 일치) — 알려진 한계.
 */
import type { PanoramaMergeResult } from "../types";
import type { AzSector, AzElevCell, AddedBlockageResult, AddedBlockageDay } from "../types/obstacle";
import { makePanoramaSampler } from "./obstacleAnalysisHelpers";
import { gradeAddedBlockage, weightedTrendSlope } from "./omStats";

// Rust HIST_* 상수와 반드시 일치 (obstacle_monthly.rs)
const HIST_AZ_BIN_DEG = 0.1;
const HIST_ELEV_BIN_DEG = 0.05;
const HIST_ELEV_MIN_DEG = -1.0;

/** 추세 '안정' 판정 임계 (%p/day) — omFindingsGenerator 레이더 추세와 동일 기준. */
const TREND_FLAT_THRESHOLD = 0.02;

/** 방위(0~360)가 구간에 포함되는지 — Rust AzSector::contains 와 동일(래핑 처리). */
function azInSector(az: number, s: AzSector): boolean {
  const a = ((az % 360) + 360) % 360;
  if (s.start_deg <= s.end_deg) return a >= s.start_deg && a <= s.end_deg;
  return a >= s.start_deg || a <= s.end_deg;
}

/** 일별 히스토그램 (day_of_month + 셀 배열) */
export interface BlockageDayHist {
  day: number;
  cells: AzElevCell[];
}

/**
 * 건물별 추가 차단영역 소실율 산출.
 * @param histogramsByDay  레이더의 일별 az×elev 히스토그램 (모든 관측일 포함, 빈 날은 cells=[])
 * @param panoWith         지형+기존지물+분석대상 파노라마 (해당 레이더). 없으면 추가 차단영역 0 → 항적 없음.
 * @param panoWithout      분석대상 제외 파노라마 (없으면 panoWith.terrain 으로 폴백 → without==terrain)
 * @param buildingExtent   대상 건물의 방위 노출 구간 (calcBuildingAzExtent)
 */
export function computeAddedBlockage(
  histogramsByDay: BlockageDayHist[],
  panoWith: PanoramaMergeResult | undefined,
  panoWithout: PanoramaMergeResult | undefined,
  buildingExtent: AzSector,
): AddedBlockageResult {
  // 컷오프 샘플러 — classifyObstacleLosses(차트 빨강영역)와 정확히 동일한 폴백 규칙.
  //   panoWith 없으면 차단각 0(추가 차단영역 없음 → 노출 0).
  //   panoWithout 없으면(제외대상 0) sWo=sW → without==with → 추가 차단영역 0(과대귀속 방지).
  //   ※ terrain 폴백 금지: 비대상 GIS 건물 차단까지 추가 차단영역에 포함돼 과대귀속됨.
  const sW = panoWith ? makePanoramaSampler(panoWith) : null;
  const sWo = panoWithout ? makePanoramaSampler(panoWithout) : sW;
  const angleWithAt = (az: number) => (sW ? sW(az) : 0);
  const angleWithoutAt = (az: number) => (sWo ? sWo(az) : 0);

  const series: AddedBlockageDay[] = [];
  let totalLoss = 0;
  let totalExposure = 0;
  let daysWithExposure = 0;

  for (const dh of histogramsByDay) {
    let dayLoss = 0;
    let dayExposure = 0;
    for (const c of dh.cells) {
      const azC = c.az_bin * HIST_AZ_BIN_DEG + HIST_AZ_BIN_DEG / 2;
      if (!azInSector(azC, buildingExtent)) continue;
      // 셀의 양각 범위 [elLo, elHi) 와 추가 차단영역 밴드 [without, with) 의 겹침 비율로 가중한다.
      // (셀 중심각만으로 전량 포함/배제하면 0.05° 빈 경계에서 얇은 밴드의 노출/소실이 ±반빈만큼 편향)
      const elLo = HIST_ELEV_MIN_DEG + c.elev_bin * HIST_ELEV_BIN_DEG;
      const elHi = elLo + HIST_ELEV_BIN_DEG;
      const overlap = Math.min(elHi, angleWithAt(azC)) - Math.max(elLo, angleWithoutAt(azC));
      if (overlap > 0) {
        const frac = overlap / HIST_ELEV_BIN_DEG; // 0 < frac ≤ 1 (셀이 밴드에 겹치는 비율)
        dayLoss += c.loss_time_s * frac;
        dayExposure += (c.track_time_s + c.loss_time_s) * frac;
      }
    }
    const ratePct = dayExposure > 0 ? (dayLoss / dayExposure) * 100 : 0;
    series.push({ day: dh.day, ratePct, exposureS: dayExposure });
    totalLoss += dayLoss;
    totalExposure += dayExposure;
    if (dayExposure > 0) daysWithExposure++;
  }

  const lossRatePct = totalExposure > 0 ? (totalLoss / totalExposure) * 100 : 0;
  // 추세: 노출시간 가중 최소자승 (노출 0 인 날은 weight 0 → 무영향)
  const slope = weightedTrendSlope(series.map((s) => ({ x: s.day, y: s.ratePct, w: s.exposureS })));
  const trendDir = Math.abs(slope) <= TREND_FLAT_THRESHOLD ? "안정" : slope > 0 ? "증가" : "감소";
  const dayCount = series.length;
  const g = gradeAddedBlockage(lossRatePct, dayCount, totalExposure, daysWithExposure);

  return {
    lossRatePct,
    trendSlopePctPerDay: slope,
    trendDir,
    exposureTrackTimeS: totalExposure,
    dayCount,
    daysWithExposure,
    series,
    grade: { label: g.label, color: g.color },
  };
}
