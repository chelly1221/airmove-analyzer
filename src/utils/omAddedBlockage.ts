/**
 * 추가 차단영역 소실율 산출 — Rust az×elev 시간 히스토그램을 건물별 컷오프로 슬라이스.
 *
 * 헤드라인 심각도 지표: "분석 대상 건물이 새로 가리는 노출 비행시간 중 소실된 비율"
 * = 노출 조건부 소실율. 방위 비교(교란·반사실 부재)를 대체하는 인과 지표.
 *
 * 추가 차단영역 밴드 = angleWithout(az) ≤ elev < angleWith(az) — classifyObstacleLosses 의 buildingCaused
 * 정의·AzElev 차트 핑크영역(건물별 panoWith−panoWithout)과 동일 소스(makePanoramaSampler)·동일 프레임
 * (ITU 4/3 유효지구, pointElevAngleDeg). Rust 히스토그램의 양각 빈도 같은 프레임이라 정렬된다.
 *
 *   일별 소실율(%) = Σ(그날 추가 차단영역 소실시간) / Σ(그날 추가 차단영역 노출시간[추적+소실]) × 100
 *   헤드라인 소실율 = 일별 소실율의 노출시간 가중 중앙값(하측) — 단발 이상일(정비·특정기체 이상)이 월 수치를
 *     지배하지 않도록 완화. 노출/소실 시간·포인트 카운트 집계는 종전대로 전량 합산(중앙값은 헤드라인 표시에만).
 *   Δ%p = 분석월 중앙값 − 기준월 중앙값 (기준데이터 일별 히스토그램에서 동일 통계량으로 산출).
 *
 * panoWith 는 호출부(ReportApp)가 건물별로 좁혀(panoWithForBuilding = without ∪ {해당 건물}) 넘긴다 —
 * 방위 중첩 인접 분석 대상의 한계기여가 양쪽 건물에 중복 귀속되던 v1 한계 해소(차트 핑크영역과 계속 일치).
 */
import type { PanoramaMergeResult } from "../types";
import type { AzSector, AzElevCell, AddedBlockageResult, AddedBlockageDay } from "../types/obstacle";
import { makePanoramaSampler } from "./obstacleAnalysisHelpers";
import {
  gradeAddedBlockageDelta, weightedTrendSlope,
  BLOCKAGE_NONE_LABEL, BLOCKAGE_NO_REF_LABEL,
} from "./omStats";

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

/** 기준데이터 참조 (헤드라인 Δ 판정용) — v2 필수: 일별 컬럼형 히스토그램(중앙값용) + 월 병합(표본 각주용). */
export interface BlockageRefDay {
  az: Uint16Array;      // az_bins
  el: Uint16Array;      // elev_bins
  tt: Float64Array;     // track_time_s
  lt: Float64Array;     // loss_time_s
}
export interface BlockageReference {
  histogram: AzElevCell[];      // 월 병합 (refExposureCount 표본 각주 전용)
  days: BlockageRefDay[];       // 일별 컬럼형 (기준월 중앙값 산출)
  monthLabel: string;
}

/**
 * 히스토그램 셀 배열을 추가 차단영역 밴드 [without, with) 로 슬라이스해 노출/소실을 누적.
 * 셀의 양각 범위 [elLo, elHi) 와 밴드의 겹침 비율(frac)로 가중 — 일별 루프와 기준(단일 패스)이
 * 동일 샘플러·동일 밴드·동일 frac 가중을 공유하도록 단일 함수로 분리.
 */
function accumulateBand(
  cells: AzElevCell[],
  angleWithAt: (az: number) => number,
  angleWithoutAt: (az: number) => number,
  buildingExtent: AzSector,
): { loss: number; exposure: number; lossCount: number; exposureCount: number } {
  let loss = 0, exposure = 0, lossCount = 0, exposureCount = 0;
  for (const c of cells) {
    const azC = c.az_bin * HIST_AZ_BIN_DEG + HIST_AZ_BIN_DEG / 2;
    if (!azInSector(azC, buildingExtent)) continue;
    const elLo = HIST_ELEV_MIN_DEG + c.elev_bin * HIST_ELEV_BIN_DEG;
    const elHi = elLo + HIST_ELEV_BIN_DEG;
    const overlap = Math.min(elHi, angleWithAt(azC)) - Math.max(elLo, angleWithoutAt(azC));
    if (overlap > 0) {
      const frac = overlap / HIST_ELEV_BIN_DEG; // 0 < frac ≤ 1 (셀이 밴드에 겹치는 비율)
      loss += c.loss_time_s * frac;
      exposure += (c.track_time_s + c.loss_time_s) * frac;
      lossCount += c.loss_count * frac;
      exposureCount += (c.track_count + c.loss_count) * frac;
    }
  }
  return { loss, exposure, lossCount, exposureCount };
}

/**
 * accumulateBand 의 컬럼형 변형 — 일별 기준 히스토그램(BlockageRefDay 병렬 배열)을 밴드로 슬라이스.
 * 셀 수학(azC 빈중심·elLo·overlap·frac)은 accumulateBand 와 문자 그대로 동일. 카운트 없음(시간만).
 * (AzElevCell 객체화 없이 TypedArray 를 인덱스 순회 — 수백만 셀 OOM 방지, CLAUDE.md 스트리밍 원칙)
 */
function accumulateBandColumnar(
  d: BlockageRefDay,
  angleWithAt: (az: number) => number,
  angleWithoutAt: (az: number) => number,
  buildingExtent: AzSector,
): { loss: number; exposure: number } {
  let loss = 0, exposure = 0;
  const n = d.az.length;
  for (let i = 0; i < n; i++) {
    const azC = d.az[i] * HIST_AZ_BIN_DEG + HIST_AZ_BIN_DEG / 2;
    if (!azInSector(azC, buildingExtent)) continue;
    const elLo = HIST_ELEV_MIN_DEG + d.el[i] * HIST_ELEV_BIN_DEG;
    const elHi = elLo + HIST_ELEV_BIN_DEG;
    const overlap = Math.min(elHi, angleWithAt(azC)) - Math.max(elLo, angleWithoutAt(azC));
    if (overlap > 0) {
      const frac = overlap / HIST_ELEV_BIN_DEG; // 0 < frac ≤ 1 (셀이 밴드에 겹치는 비율)
      loss += d.lt[i] * frac;
      exposure += (d.tt[i] + d.lt[i]) * frac;
    }
  }
  return { loss, exposure };
}

/** 노출시간 가중 중앙값 (lower weighted median) — w>0 항목만, (rate, day순) 정렬 후 누적가중 ≥ W/2 첫 항목. 빈 입력 → 0. */
function weightedMedianRate(items: { rate: number; w: number }[]): number {
  const xs = items.filter((it) => it.w > 0);
  if (xs.length === 0) return 0;
  // rate 오름차순 안정 정렬(동률은 입력순=일자순 유지) — 누적 노출가중이 전체의 절반에 처음 도달하는 항목(하측).
  const sorted = [...xs].sort((a, b) => a.rate - b.rate);
  let total = 0;
  for (const s of sorted) total += s.w;
  if (total <= 0) return 0; // Σw=0 → 0
  const half = total / 2;
  let cum = 0;
  for (const s of sorted) {
    cum += s.w;
    if (cum >= half) return s.rate;
  }
  return sorted[sorted.length - 1].rate;
}

/**
 * 건물별 추가 차단영역 소실율 산출.
 * @param histogramsByDay  레이더의 일별 az×elev 히스토그램 (모든 관측일 포함, 빈 날은 cells=[])
 * @param panoWith         지형+기존지물+'해당' 분석대상 파노라마 — 호출부가 panoWithForBuilding 으로 건물별로
 *                         좁혀 전달. 없으면 밴드 기하 판정을 생략하고 노출>0 여부로 폴백.
 * @param panoWithout      분석대상 제외 파노라마 (없으면 panoWith.terrain 으로 폴백 → without==terrain)
 * @param buildingExtent   대상 건물의 방위 노출 구간 (calcBuildingAzExtent)
 * @param reference        기준데이터(참조 달) — 있으면(히스토그램 존재) 동일 샘플러·밴드·frac 가중으로
 *                         기준 소실율을 산출해 편차(Δ%p) 판정(delta). 없으면(미등록·로드 실패·정합성
 *                         불일치는 호출부가 null 로 전달) 또는 히스토그램이 비면 기준 미적용(noref).
 */
export function computeAddedBlockage(
  histogramsByDay: BlockageDayHist[],
  panoWith: PanoramaMergeResult | undefined,
  panoWithout: PanoramaMergeResult | undefined,
  buildingExtent: AzSector,
  reference?: BlockageReference | null,
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
  //   · panoWith 없음(sW=null) → 밴드 기하 판정 생략 → 폴백 true (노출>0 로 재판정).
  let geometricBand = !sW; // panoWith 없으면 밴드 기하 미상 → true 폴백
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
    // 셀의 양각 범위 [elLo, elHi) 와 추가 차단영역 밴드 [without, with) 의 겹침 비율로 가중한다.
    // (셀 중심각만으로 전량 포함/배제하면 0.05° 빈 경계에서 얇은 밴드의 노출/소실이 ±반빈만큼 편향)
    const acc = accumulateBand(dh.cells, angleWithAt, angleWithoutAt, buildingExtent);
    const dayLoss = acc.loss;
    const dayExposure = acc.exposure;
    // 포인트 수도 동일 frac 가중 — 시간 누적과 셀·조건 완전 일치 (표시 시 반올림)
    totalLossCount += acc.lossCount;
    totalExposureCount += acc.exposureCount;
    const ratePct = dayExposure > 0 ? (dayLoss / dayExposure) * 100 : 0;
    series.push({ day: dh.day, ratePct, exposureS: dayExposure });
    totalLoss += dayLoss;
    totalExposure += dayExposure;
    if (dayExposure > 0) daysWithExposure++;
  }

  // 헤드라인 소실율 = 일별 소실율의 노출시간 가중 중앙값(하측) — 단발 이상일(정비·특정기체 이상)이 월 수치를
  // 지배하지 않도록 완화. 노출 0 인 날은 제외. (totalLoss/totalExposure 합산·카운트·series·추세는 종전대로 유지)
  const lossRatePct = weightedMedianRate(
    series.filter((s) => s.exposureS > 0).map((s) => ({ rate: s.ratePct, w: s.exposureS })),
  );
  // 추세: 노출시간 가중 최소자승 (노출 0 인 날은 weight 0 → 무영향)
  const slope = weightedTrendSlope(series.map((s) => ({ x: s.day, y: s.ratePct, w: s.exposureS })));
  const trendDir = Math.abs(slope) <= TREND_FLAT_THRESHOLD ? "안정" : slope > 0 ? "증가" : "감소";
  const dayCount = series.length;
  // 노출>0 이면 밴드는 반드시 존재 — 기하 스캔의 위상 누락에도 라벨이 노출과 모순되지 않도록 OR 안전망.
  const hasBlockageBand = geometricBand || totalExposure > 0;

  // ── 기준데이터 대비 편차(Δ%p) 판정 ──
  // 기준데이터가 있고(정합성 게이트는 호출부에서 통과) 기준 히스토그램이 있으면 동일 샘플러·동일 밴드·
  // 동일 frac 가중으로 기준월 '일별 소실율의 노출가중 중앙값'을 산출해(분석월과 동일 통계량) 편차 임계로
  // 판정한다(delta 모드). 표본 게이트는 폐지 — 기준 노출 0이면 refRate=0 을 그대로 쓴다. refExposureCount(표본
  // 각주)는 월 병합 히스토그램의 노출 카운트를 유지. 기준이 없거나 히스토그램이 비면 기준 미적용(noref).
  let gradingMode: "delta" | "noref" = "noref";
  let refLossRatePct: number | undefined;
  let deltaPp: number | undefined;
  let refExposureCount: number | undefined;
  let refMonthLabel: string | undefined;
  let g: { label: string; color: string };

  if (reference && reference.histogram.length > 0) {
    // 기준 히스토그램이 있으면 무조건 delta — 기준 노출 0이면 refRate=0 을 그대로 사용(표본 게이트 폐지).
    // 기준월 소실율도 분석월과 동일 통계량(일별 소실율의 노출가중 중앙값)으로 산출 — Δ 는 중앙값 − 중앙값.
    const refRate = weightedMedianRate(
      reference.days
        .map((d) => accumulateBandColumnar(d, angleWithAt, angleWithoutAt, buildingExtent))
        .map((a) => ({ rate: a.exposure > 0 ? (a.loss / a.exposure) * 100 : 0, w: a.exposure })),
    );
    // 표본 각주(refExposureCount)는 종전대로 월 병합 히스토그램의 노출 카운트 사용.
    const ref = accumulateBand(reference.histogram, angleWithAt, angleWithoutAt, buildingExtent);
    gradingMode = "delta";
    refLossRatePct = refRate;
    refExposureCount = ref.exposureCount;
    refMonthLabel = reference.monthLabel;
    deltaPp = lossRatePct - refRate;
    g = gradeAddedBlockageDelta(deltaPp, totalExposureCount, hasBlockageBand);
  } else {
    // 기준데이터 없음(미등록·로드 실패·정합성 불일치는 호출부가 reference=null 로 전달) 또는 기준
    //   히스토그램이 비었음 → 기준 미적용(noref). 우선순위 게이트만 적용: 미형성 → "추가 차단 구간 없음",
    //   노출 0 → "항적 없음", 그 외 → 회색 "기준데이터 없음"(Δ 판정 근거 부재). 전부 회색(#6b7280).
    gradingMode = "noref";
    const norefLabel = !hasBlockageBand ? BLOCKAGE_NONE_LABEL
      : totalExposureCount <= 0 ? "항적 없음"
      : BLOCKAGE_NO_REF_LABEL;
    g = { label: norefLabel, color: "#6b7280" };
  }

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
    gradingMode,
    refLossRatePct,
    deltaPp,
    refExposureCount,
    refMonthLabel,
  };
}
