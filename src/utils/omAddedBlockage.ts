/**
 * 추가 차단영역 소실율 산출 — Rust az×elev 시간 히스토그램을 건물별 컷오프로 슬라이스.
 *
 * 헤드라인 심각도 지표: "분석 대상 건물이 새로 가리는 노출 비행시간 중 소실된 비율"
 * = 노출 조건부 소실율. 방위 비교(교란·반사실 부재)를 대체하는 인과 지표.
 *
 * 추가 차단영역 밴드 = angleWithout(az) ≤ elev < angleWith(az) — classifyObstacleLosses 의 buildingCaused
 * 정의·AzElev 차트 빨강영역(panoWith−panoWithout)과 동일 소스(makePanoramaSampler)·동일 프레임
 * (ITU 4/3 유효지구, pointElevAngleDeg). Rust 히스토그램의 양각 빈도 같은 프레임이라 정렬된다.
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

/**
 * 추가 차단 밴드 '형성됨' 판정 양각 임계 (도) — 부동소수 노이즈 차단용 미세값.
 * 노출 적분(overlap>0)이 angleWith>angleWithout 를 필요조건으로 하므로, 폭 임계는 노출 조건과
 * 일치하도록 사실상 0(노이즈 가드 1e-9)으로 둔다. 임의 임계(예: 0.005°)를 두면 얕은 밴드가
 * 노출>0 인데도 "추가 차단 구간 없음"으로 라벨되는 모순이 생긴다(노출 적분에는 폭 하한이 없음).
 */
const BAND_EPS_DEG = 1e-9;

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
 * @param panoWith         지형+기존지물+분석대상 파노라마 (해당 레이더). 없으면 밴드 판정 불가 → 노출 기반 등급 폴백.
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

  // 추가 차단 밴드가 실제로 형성되는지(노출 0 인 "항적 없음"과 구분) — 노출 적분과 '동일 그리드(빈 중심)·
  // 동일 양수조건'으로 판정해 노출>0 인데 "추가 차단 구간 없음"으로 라벨되는 모순을 구조적으로 차단한다.
  //   · 빈 중심 azC = az_bin·0.1 + 0.05 (Rust az_bin=floor(az/0.1) 와 정렬) + azInSector 필터 = 노출 루프와 동일
  //   · 조건 angleWith − angleWithout > BAND_EPS (노출 overlap>0 의 필요조건) — 폭 하한 없음
  //   · panoWithout 없음(sWo=sW, 제외대상 0) → without==with → 차이 0 → 미형성.
  //   · panoWith 없음(sW=null) → 밴드 기하 판정 불가 → 폴백 true (기존 노출 기반 로직 유지).
  let geometricBand = !sW; // panoWith 없으면 판정 불가 → true 폴백
  if (sW) {
    const startBin = Math.floor(buildingExtent.start_deg / HIST_AZ_BIN_DEG);
    const extentWidth = (((buildingExtent.end_deg - buildingExtent.start_deg) % 360) + 360) % 360;
    const nBins = Math.ceil(extentWidth / HIST_AZ_BIN_DEG) + 2; // 양끝 빈 경계 여유
    for (let k = 0; k <= nBins; k++) {
      const azC = ((((startBin + k) * HIST_AZ_BIN_DEG + HIST_AZ_BIN_DEG / 2) % 360) + 360) % 360;
      if (!azInSector(azC, buildingExtent)) continue; // 노출 루프와 동일한 빈-중심 포함 판정
      if (angleWithAt(azC) - angleWithoutAt(azC) > BAND_EPS_DEG) { geometricBand = true; break; }
    }
  }

  const series: AddedBlockageDay[] = [];
  let totalLoss = 0;
  let totalExposure = 0;
  // 포인트 수(밴드 겹침비율 frac 가중). 시간과 동일 셀·동일 frac으로 누적 → 시간 지표와 정렬.
  let totalLossCount = 0;
  let totalExposureCount = 0;
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
        // 포인트 수도 동일 frac 가중 — 시간 누적과 셀·조건 완전 일치 (표시 시 반올림)
        totalLossCount += c.loss_count * frac;
        totalExposureCount += (c.track_count + c.loss_count) * frac;
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
  // 노출>0 이면 밴드는 반드시 존재 — 기하 스캔의 위상 누락에도 라벨이 노출과 모순되지 않도록 OR 안전망.
  const hasBlockageBand = geometricBand || totalExposure > 0;
  // 표본 게이트는 통과 항적 포인트 수(totalExposureCount) 단일 기준 — 관측일수/노출 발생일 게이트는 폐지.
  const g = gradeAddedBlockage(lossRatePct, totalExposureCount, hasBlockageBand);

  return {
    lossRatePct,
    trendSlopePctPerDay: slope,
    trendDir,
    exposureTrackTimeS: totalExposure,
    exposurePointCount: totalExposureCount,
    lossPointCount: totalLossCount,
    dayCount,
    daysWithExposure,
    series,
    grade: { label: g.label, color: g.color },
  };
}
