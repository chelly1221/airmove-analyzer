/**
 * 추가 차단영역 소실율 산출 — Rust az×elev 시간 히스토그램을 건물별 컷오프로 슬라이스.
 *
 * 헤드라인 심각도 지표: "그 건물 방위(노출면 각폭)를 지나는 전체 항적 시간 중, 건물이 새로
 * 가리는 밴드에서 소실된 시간의 비율" = 방위 전체 대비 소실율. 방위 비교(교란·반사실 부재)를
 * 대체하는 인과 지표.
 *
 * 추가 차단영역 밴드 = angleWithout(az) ≤ elev < angleWith(az) — classifyObstacleLosses 의 buildingCaused
 * 정의·AzElev 차트 핑크영역(건물별 panoWith−panoWithout)과 동일 소스(makePanoramaSampler)·동일 프레임
 * (ITU 4/3 유효지구, pointElevAngleDeg). Rust 히스토그램의 양각 빈도 같은 프레임이라 정렬된다.
 *
 *   분모 = Σ(건물 방위창 buildingExtent 전 양각 셀의 추적시간 + 소실시간) — 방위창 전체 항적시간
 *   분자 = Σ(추가 차단영역 밴드 셀의 소실시간)                            — 밴드 소실시간
 *   소실율(%) = 분자 / 분모 × 100
 *   Δ = 동일 정의(방위 전체 대비)로 산출한 기준월 소실율 대비 편차(%p).
 *       기준 히스토그램은 보고서 생성 시 분석월과 동일 쐐기 파이프라인으로 재집계된 것.
 *       같은 월 입력이면 Rust 계산 코어가 비트 동일(패리티 테스트 입증)하고, 일별 셀을 그대로
 *       전달해(동일 ser_s3 직렬화·정렬) 분석월과 **동일 코드·동일 연산 순서**(sumBandOverDays)로
 *       합산하므로 총계도 비트 동일 → Δ 가 정확히 0(불변식).
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
 * 밴드 노출 적분(overlap>0)이 angleWith>angleWithout 를 필요조건으로 하므로, 폭 임계는 밴드 노출
 * 조건과 일치하도록 사실상 0(노이즈 가드 1e-9)으로 둔다. 임의 임계(예: 0.005°)를 두면 얕은 밴드가
 * 밴드 노출>0 인데도 "추가 차단 구간 없음"으로 라벨되는 모순이 생긴다(밴드 노출 적분에는 폭 하한이 없음).
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
 * 기준데이터 참조 (헤드라인 Δ 판정용) — 보고서 생성 시 동일 쐐기 파이프라인으로 재집계한 **일별**
 * 히스토그램(분석월 daily_stats 와 동일 직렬화·정렬 셀) + 기준월 라벨. 호출부(ReportApp)가
 * rr.reference.daily 에서 넘긴다. 분석월 총계와 **같은 코드·같은 순서**(sumBandOverDays)로 합산 →
 * 같은 월이면 refRate 가 lossRatePct 와 비트 동일 → Δ=0 불변식.
 * daily 는 **자기 월(month_label) 날짜만** 담는다(Rust compute_reference_wedge 의 month_label date-필터로
 * 월경계 파일의 전월 말일·익월 초일 제외 — 분석월 filteredResult date-필터와 대칭).
 */
export interface BlockageReference {
  /** 일별 az×elev 셀 배열 (date 오름차순 — 분석월 histogramsByDay 와 동일 순서) */
  daysCells: AzElevCell[][];
  monthLabel: string;
}

/**
 * 건물 방위창(buildingExtent) 셀을 한 패스로 누적 — 소실율 분모/분자 + 밴드 형성 판정을 함께 산출.
 *   · exposure / exposureCount = 방위창(노출면 각폭) 전체(전 양각)의 항적시간·포인트(정상추적+소실,
 *       frac 가중 없음) → 소실율 분모. "그 건물 방위를 지나는 전체 항적".
 *   · loss / lossCount = 추가 차단영역 밴드 [without, with) 내 소실(양각 겹침비율 frac 가중) → 소실율 분자.
 *   · bandExposure = 밴드 내 노출(추적+소실, frac 가중) → hasBlockageBand 안전망 전용, 분모 아님.
 * 셀의 양각 범위 [elLo, elHi) 와 밴드의 겹침 비율(frac)로 가중 — 일별 루프와 기준(단일 패스)이
 * 동일 샘플러·동일 밴드·동일 frac 가중을 공유하도록 단일 함수로 분리.
 */
function accumulateBand(
  cells: AzElevCell[],
  angleWithAt: (az: number) => number,
  angleWithoutAt: (az: number) => number,
  buildingExtent: AzSector,
): { loss: number; exposure: number; lossCount: number; exposureCount: number; bandExposure: number } {
  let loss = 0, exposure = 0, lossCount = 0, exposureCount = 0, bandExposure = 0;
  for (const c of cells) {
    const azC = c.az_bin * HIST_AZ_BIN_DEG + HIST_AZ_BIN_DEG / 2;
    if (!azInSector(azC, buildingExtent)) continue;
    // 분모: 방위창(노출면 각폭) 전체 — 전 양각의 정상추적+소실, frac 가중 없음
    exposure += c.track_time_s + c.loss_time_s;
    exposureCount += c.track_count + c.loss_count;
    const elLo = HIST_ELEV_MIN_DEG + c.elev_bin * HIST_ELEV_BIN_DEG;
    const elHi = elLo + HIST_ELEV_BIN_DEG;
    const overlap = Math.min(elHi, angleWithAt(azC)) - Math.max(elLo, angleWithoutAt(azC));
    if (overlap > 0) {
      const frac = overlap / HIST_ELEV_BIN_DEG; // 0 < frac ≤ 1 (셀이 밴드에 겹치는 비율)
      // 분자: 추가 차단영역 밴드 내 소실 (기존 수식 그대로)
      loss += c.loss_time_s * frac;
      lossCount += c.loss_count * frac;
      // 밴드 형성 판정 전용(hasBlockageBand 안전망) — 소실율 분모에는 미사용
      bandExposure += (c.track_time_s + c.loss_time_s) * frac;
    }
  }
  return { loss, exposure, lossCount, exposureCount, bandExposure };
}

/** accumulateBand 반환 형상 (일별 누적 단위) */
type BandAcc = { loss: number; exposure: number; lossCount: number; exposureCount: number; bandExposure: number };

/**
 * 날짜 순서대로 accumulateBand 를 호출하고 **고정 순서로 합산** — 분석월과 기준월의 총계가
 * 문자 그대로 같은 코드·같은 연산 순서로 계산되게 하는 단일 경로. perDay 는 입력 daysCells 와
 * 같은 인덱스로 정렬(현재월 series·trend 산출용). 같은 월 입력이면 Rust 가 두 경로에 비트 동일
 * 일별 셀을 같은 date 순서로 실어 오므로, 여기서 같은 순서로 합산하면 총계까지 비트 동일 → Δ=0.
 */
function sumBandOverDays(
  daysCells: AzElevCell[][],
  angleWithAt: (az: number) => number,
  angleWithoutAt: (az: number) => number,
  buildingExtent: AzSector,
): { loss: number; exposure: number; lossCount: number; exposureCount: number; bandExposure: number; perDay: BandAcc[] } {
  let loss = 0, exposure = 0, lossCount = 0, exposureCount = 0, bandExposure = 0;
  const perDay: BandAcc[] = [];
  for (const cells of daysCells) {
    const acc = accumulateBand(cells, angleWithAt, angleWithoutAt, buildingExtent);
    perDay.push(acc);
    loss += acc.loss;
    exposure += acc.exposure;
    lossCount += acc.lossCount;
    exposureCount += acc.exposureCount;
    bandExposure += acc.bandExposure;
  }
  return { loss, exposure, lossCount, exposureCount, bandExposure, perDay };
}

/**
 * 건물별 추가 차단영역 소실율 산출.
 * @param histogramsByDay  레이더의 일별 az×elev 히스토그램 (모든 관측일 포함, 빈 날은 cells=[])
 * @param panoWith         지형+기존지물+'해당' 분석대상 파노라마 — 호출부가 panoWithForBuilding 으로 건물별로
 *                         좁혀 전달. 없으면 밴드 기하 판정을 생략하고 밴드 형성됨으로 폴백.
 * @param panoWithout      분석대상 제외 파노라마 (없으면 panoWith.terrain 으로 폴백 → without==terrain)
 * @param buildingExtent   대상 건물의 방위 노출 구간 (calcBuildingAzExtent)
 * @param reference        기준데이터(참조 달) — 있으면(일별 셀 존재) 현재월과 **동일 헬퍼(sumBandOverDays)**·
 *                         동일 샘플러·동일 정의(방위 전체 대비)로 기준 소실율을 산출해 편차(Δ%p) 판정(delta).
 *                         없으면(미등록·로드 실패·정합성 불일치는 호출부가 null 로 전달) 또는 daysCells 가
 *                         비면 기준 미적용(noref).
 */
export function computeAddedBlockage(
  histogramsByDay: BlockageDayHist[],
  panoWith: PanoramaMergeResult | undefined,
  panoWithout: PanoramaMergeResult | undefined,
  buildingExtent: AzSector,
  reference?: BlockageReference | null,
): AddedBlockageResult {
  // 컷오프 샘플러 — classifyObstacleLosses(차트 빨강영역)와 정확히 동일한 폴백 규칙.
  //   panoWith 없으면 차단각 0(추가 차단영역 없음 → 밴드 소실 0; 방위창 전체 노출은 그대로).
  //   panoWithout 없으면(제외대상 0) sWo=sW → without==with → 추가 차단영역 0(과대귀속 방지).
  //   ※ terrain 폴백 금지: 비대상 GIS 건물 차단까지 추가 차단영역에 포함돼 과대귀속됨.
  const sW = panoWith ? makePanoramaSampler(panoWith) : null;
  const sWo = panoWithout ? makePanoramaSampler(panoWithout) : sW;
  const angleWithAt = (az: number) => (sW ? sW(az) : 0);
  const angleWithoutAt = (az: number) => (sWo ? sWo(az) : 0);

  // 추가 차단 밴드가 실제로 형성되는지 — 밴드 노출 적분(bandExposure, overlap>0 셀)과 '동일 그리드(빈 중심)·
  // 동일 양수조건'으로 판정해 밴드 노출>0 인데 "추가 차단 구간 없음"으로 라벨되는 모순을 구조적으로 차단한다.
  //   · 빈 중심 azC = az_bin·0.1 + 0.05 (Rust az_bin=floor(az/0.1) 와 정렬) + azInSector 필터 = 밴드 루프와 동일
  //   · 조건 angleWith − angleWithout > BAND_EPS (밴드 overlap>0 의 필요조건) — 폭 하한 없음
  //   · panoWithout 없음(sWo=sW, 제외대상 0) → without==with → 차이 0 → 미형성.
  //   · panoWith 없음(sW=null) → 밴드 기하 판정 생략 → 폴백 true (밴드 노출>0 로 재판정).
  let geometricBand = !sW; // panoWith 없으면 밴드 기하 미상 → true 폴백
  if (sW) {
    const startBin = Math.floor(buildingExtent.start_deg / HIST_AZ_BIN_DEG);
    const extentWidth = (((buildingExtent.end_deg - buildingExtent.start_deg) % 360) + 360) % 360;
    const nBins = Math.ceil(extentWidth / HIST_AZ_BIN_DEG) + 2; // 양끝 빈 경계 여유
    for (let k = 0; k <= nBins; k++) {
      const azC = ((((startBin + k) * HIST_AZ_BIN_DEG + HIST_AZ_BIN_DEG / 2) % 360) + 360) % 360;
      if (!azInSector(azC, buildingExtent)) continue; // 누적 루프와 동일한 빈-중심 포함 판정
      if (angleWithAt(azC) - angleWithoutAt(azC) > BAND_EPS_DEG) { geometricBand = true; break; }
    }
  }

  // 현재월 총계 — 기준월과 **완전히 같은 헬퍼·같은 연산 순서**(sumBandOverDays)로 산출.
  // 분모(방위창 전체)와 분자(밴드 소실)를 셀 양각범위 [elLo, elHi) 와 추가 차단영역 밴드
  // [without, with) 의 겹침 비율(frac)로 가중해 한 패스로 누적한다. 합산 순서는 histogramsByDay
  // (=date 순) 그대로 — 종전 일별 루프와 동일한 값·같은 덧셈 순서(수치 불변).
  const daysCells = histogramsByDay.map((dh) => dh.cells);
  const cur = sumBandOverDays(daysCells, angleWithAt, angleWithoutAt, buildingExtent);
  const totalLoss = cur.loss;
  const totalExposure = cur.exposure;
  // 밴드 형성 판정 전용 누적(일별 bandExposure 합) — 분모(방위창 전체 exposure)와 별개.
  const totalBandExposure = cur.bandExposure;
  // 포인트 수(방위창 전체·밴드 소실은 frac 가중). 각각 대응 셀·조건으로 누적 → 시간 지표와 정렬.
  const totalLossCount = cur.lossCount;
  const totalExposureCount = cur.exposureCount;

  // perDay 를 histogramsByDay 의 day 번호와 zip 해 series(일별 소실율·노출시간)·daysWithExposure 산출.
  const series: AddedBlockageDay[] = [];
  let daysWithExposure = 0;
  for (let i = 0; i < histogramsByDay.length; i++) {
    const acc = cur.perDay[i];
    const dayLoss = acc.loss;
    const dayExposure = acc.exposure; // 방위창 전체(전 양각) 항적시간
    const ratePct = dayExposure > 0 ? (dayLoss / dayExposure) * 100 : 0;
    series.push({ day: histogramsByDay[i].day, ratePct, exposureS: dayExposure });
    if (dayExposure > 0) daysWithExposure++;
  }

  const lossRatePct = totalExposure > 0 ? (totalLoss / totalExposure) * 100 : 0;
  // 추세: 노출시간 가중 최소자승 (노출 0 인 날은 weight 0 → 무영향)
  const slope = weightedTrendSlope(series.map((s) => ({ x: s.day, y: s.ratePct, w: s.exposureS })));
  const trendDir = Math.abs(slope) <= TREND_FLAT_THRESHOLD ? "안정" : slope > 0 ? "증가" : "감소";
  const dayCount = series.length;
  // 밴드 노출>0(overlap>0 셀 존재)이면 밴드는 반드시 형성 — 기하 스캔의 위상 누락에도 라벨이
  // 밴드 노출과 모순되지 않도록 OR 안전망. 분모인 방위창 전체 exposure 가 아니라 totalBandExposure 를
  // 쓴다: 새 정의에선 방위창 항적만 있어도 exposure>0 이므로, exposure 로 판정하면 밴드 미형성인데도
  // "추가 차단 구간 있음"으로 오판된다(옛 의미에서 노출>0⟹밴드존재였던 가정이 깨짐).
  const hasBlockageBand = geometricBand || totalBandExposure > 0;

  // ── 기준데이터 대비 편차(Δ%p) 판정 ──
  // 기준데이터가 있고(정합성 게이트는 호출부에서 통과) 기준 일별 셀이 있으면 현재월과 동일 헬퍼·동일
  // 샘플러·동일 정의(방위 전체 대비: 분모=기준월 방위창 전체 항적시간, 분자=밴드 소실시간)로 기준월
  // 소실율을 산출해 편차 임계로 판정한다(delta 모드). 표본 게이트는 폐지 — 기준 노출 0이면 refRate=0
  // 을 그대로 쓴다. 기준이 없거나 daysCells 가 비면 기준 미적용(noref).
  let gradingMode: "delta" | "noref" = "noref";
  let refLossRatePct: number | undefined;
  let deltaPp: number | undefined;
  let refExposureCount: number | undefined;
  let refMonthLabel: string | undefined;
  let g: { label: string; color: string };

  if (reference && reference.daysCells.length > 0) {
    // 기준 일별 셀이 있으면 무조건 delta — 기준 노출 0이면 refRate=0 을 그대로 사용(표본 게이트 폐지).
    // 현재월과 **완전히 같은 헬퍼·같은 연산 순서**(sumBandOverDays)로 합산 → 같은 월이면 refRate 가
    // lossRatePct 와 비트 동일(Rust 비트 동일 셀 + 동일 date 순서) → deltaPp 정확히 0.
    const ref = sumBandOverDays(reference.daysCells, angleWithAt, angleWithoutAt, buildingExtent);
    const refRate = ref.exposure > 0 ? (ref.loss / ref.exposure) * 100 : 0;
    gradingMode = "delta";
    refLossRatePct = refRate;
    refExposureCount = ref.exposureCount;
    refMonthLabel = reference.monthLabel;
    deltaPp = lossRatePct - refRate;
    g = gradeAddedBlockageDelta(deltaPp, totalExposureCount, hasBlockageBand);
  } else {
    // 기준데이터 없음(미등록·로드 실패·정합성 불일치는 호출부가 reference=null 로 전달) 또는 기준
    //   일별 셀(daysCells)이 비었음 → 기준 미적용(noref). 우선순위 게이트만 적용: 미형성 → "추가 차단 구간 없음",
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
