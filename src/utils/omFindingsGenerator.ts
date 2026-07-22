/**
 * 장애물 월간 보고서 — 분석 소견 자동 생성
 *
 * 종합 소견 페이지의 판정 카드·추가 차단 구간 표가 상세 수치를 이미 표시하므로,
 * 소견 텍스트는 「종합 판정」 단독으로만 구성한다 — 건물별 추가 차단영역 소실율의 최악 등급을
 * 롤업한 인과 헤드라인(파노라마 미준비 시 방위 소실율 기준 잠정 판정으로 폴백)만 담는다.
 */
import type {
  RadarMonthlyResult, ManualBuilding,
} from "../types";
import type { AddedBlockageResult } from "../types/obstacle";
import {
  weightedLossAvg,
  BLOCKAGE_WATCH_PCT, BLOCKAGE_CAUTION_PCT, BLOCKAGE_ALERT_PCT, BLOCKAGE_SEVERE_PCT,
  BLOCKAGE_DELTA_WATCH_PP, BLOCKAGE_DELTA_CAUTION_PP, BLOCKAGE_DELTA_ALERT_PP, BLOCKAGE_DELTA_SEVERE_PP,
  BLOCKAGE_NONE_LABEL,
} from "./omStats";

function gradeLabel(lossRate: number): string {
  if (lossRate < 0.5) return "양호";
  if (lossRate < 2.0) return "주의";
  return "경고";
}

interface GenerateOMFindingsParams {
  radarResults: RadarMonthlyResult[];
  selectedBuildings: ManualBuilding[];
  /** 건물별 추가 차단영역 소실율 (key: `${radarName}_${buildingId}`). 파노라마 준비 후 채워짐 — 비면 방위 소실율 기준 잠정 판정. */
  addedBlockageByKey?: Record<string, AddedBlockageResult>;
}

export function generateOMFindingsText(params: GenerateOMFindingsParams): string {
  const {
    radarResults, selectedBuildings, addedBlockageByKey,
  } = params;

  const lines: string[] = [];

  // 레이더별 방위 소실율 등급 — 종합 판정 폴백(파노라마 미준비) 및 관측일수 부족 노트에서 사용
  const allGrades = radarResults.map((rr) => {
    const stats = rr.daily_stats;
    const grade = stats.length < 7 ? "판정 불가" : gradeLabel(weightedLossAvg(stats));
    return { radar: rr.radar_name, grade };
  });

  // ── 종합 판정 ──
  lines.push(`■ 종합 판정`);
  if (addedBlockageByKey) {
    // 인과 헤드라인 — 건물별 추가 차단영역 소실율 최악 등급 롤업.
    // 방위 소실율은 지형·트래픽 교란이 섞여 보조지표로만 두고 항목별 요약에서 언급.
    const order: Record<string, number> = { "심각": 5, "경계": 4, "주의": 3, "관심": 2, "양호": 1 };
    let worst = "", worstName = "", worstRate = 0;
    let worstW: AddedBlockageResult | null = null; // 최악 등급 항목 — delta 표현 구성용
    let blockageCount = 0, noneCount = 0; // 사유 분리용 — 추가 차단 구간 미형성 전부 여부
    let anyDelta = false; // 기준월 대비 편차(Δ%p) 판정 항목 존재 여부 — 임계 각주 분기용
    for (const rr of radarResults) {
      for (const b of selectedBuildings) {
        const w = addedBlockageByKey[`${rr.radar_name}_${b.id}`];
        if (!w) continue;
        blockageCount++;
        if (w.gradingMode === "delta") anyDelta = true;
        if (w.grade.label === BLOCKAGE_NONE_LABEL) noneCount++;
        if (!(w.grade.label in order)) continue;
        // 동률 등급은 lossRatePct 최대치로 갱신(타이브레이크) — '최고 …%' 문구가 추가 차단 구간 표의
        //   실제 최고 수치와 일치하도록. (종전: 강부등호만 비교해 같은 등급에선 먼저 순회된 항목이 대표로 남았음)
        const o = order[w.grade.label] ?? 0;
        const cur = order[worst] ?? 0;
        if (o > cur || (o === cur && w.lossRatePct > worstRate)) {
          worst = w.grade.label;
          worstName = `${b.name || `건물${b.id}`}/${rr.radar_name}`;
          worstRate = w.lossRatePct;
          worstW = w;
        }
      }
    }
    const allBandNone = blockageCount > 0 && noneCount === blockageCount;
    // 최악 항목이 delta 판정이면 '기준월(라벨) 대비 ±X.XX%p' 중립 병기 (참조 달의 성격은 가정하지 않음)
    const deltaPhrase = worstW && worstW.gradingMode === "delta" && worstW.refMonthLabel && worstW.deltaPp !== undefined
      ? ` (기준월(${worstW.refMonthLabel}) 대비 ${worstW.deltaPp >= 0 ? "+" : "−"}${Math.abs(worstW.deltaPp).toFixed(2)}%p)`
      : "";
    if (worst === "양호") {
      lines.push(`분석 대상 장애물의 추가 차단영역 소실율은 양호 수준(최고 ${worstName} ${worstRate.toFixed(2)}%${deltaPhrase})으로, 장애물에 의한 유의미한 탐지 영향은 확인되지 않았다.`);
    } else if (worst === "관심") {
      lines.push(`분석 대상 장애물의 추가 차단영역 소실율이 관심 수준(${worstName} ${worstRate.toFixed(2)}%${deltaPhrase})으로, 경미하나 해당 방위·고도 탐지 성능의 지속 관찰이 필요하다.`);
    } else if (worst === "주의") {
      lines.push(`분석 대상 장애물의 추가 차단영역 소실율이 주의 수준(${worstName} ${worstRate.toFixed(2)}%${deltaPhrase})으로, 해당 방위·고도 탐지 성능을 지속 모니터링할 필요가 있다.`);
    } else if (worst === "경계") {
      lines.push(`분석 대상 장애물의 추가 차단영역 소실율이 경계 수준(${worstName} ${worstRate.toFixed(2)}%${deltaPhrase})으로, 장애물에 의한 탐지 성능 저하가 우려되며 운용 대책 검토가 필요하다.`);
    } else if (worst === "심각") {
      lines.push(`분석 대상 장애물의 추가 차단영역 소실율이 심각 수준(${worstName} ${worstRate.toFixed(2)}%${deltaPhrase})으로, 현저한 탐지 성능 저하가 확인되어 즉각적인 운용 대책이 요구된다.`);
    } else if (allBandNone) {
      lines.push(`분석 대상 장애물이 지형·기존지물 위로 새로 가리는 구간을 형성하지 않아(추가 차단 구간 없음), 장애물에 의한 추가 탐지 영향은 없는 것으로 판단된다.`);
    } else {
      lines.push(`분석 대상 장애물의 추가 차단영역을 지나는 유효 항적이 거의 없거나 추가 차단 구간 자체가 형성되지 않아, 장애물 인과 영향은 확인되지 않음(또는 판정 불가).`);
    }
    if (anyDelta) {
      lines.push(`※ 추가 차단영역 등급 임계(기준월 대비 편차 Δ%p) — 관심 +${BLOCKAGE_DELTA_WATCH_PP}%p / 주의 +${BLOCKAGE_DELTA_CAUTION_PP}%p / 경계 +${BLOCKAGE_DELTA_ALERT_PP}%p / 심각 +${BLOCKAGE_DELTA_SEVERE_PP}%p 이상.`);
    } else {
      lines.push(`※ 추가 차단영역 등급 임계 — 관심 ${BLOCKAGE_WATCH_PCT}% / 주의 ${BLOCKAGE_CAUTION_PCT}% / 경계 ${BLOCKAGE_ALERT_PCT}% / 심각 ${BLOCKAGE_SEVERE_PCT}% 이상.`);
    }
  } else {
    // 파노라마 미준비(생성 직후) — 방위 소실율 기준 잠정 결론. 파노라마 완료 시 인과 헤드라인으로 자동 재생성.
    const worstGrade = allGrades.some((g) => g.grade === "경고") ? "경고"
      : allGrades.some((g) => g.grade === "주의") ? "주의" : "양호";
    if (worstGrade === "양호") {
      lines.push(`(잠정) 분석 기간 중 모든 레이더에서 표적소실율이 양호 수준으로, 분석 대상 장애물에 의한 유의미한 운용 영향은 확인되지 않았다.`);
    } else if (worstGrade === "주의") {
      lines.push(`(잠정) 일부 레이더에서 표적소실율이 주의 수준이며, 분석 대상 장애물 방위 구간에서의 탐지 성능을 지속적으로 모니터링할 필요가 있다.`);
    } else {
      lines.push(`(잠정) 일부 레이더에서 표적소실율이 경고 수준으로, 분석 대상 장애물에 의한 탐지 성능 저하가 우려되며, 운용 관련 대책 검토가 필요하다.`);
    }
    lines.push(`※ 건물 인과 헤드라인(추가 차단영역 소실율)은 장애물 음영 분석 완료 후 자동 반영된다.`);
  }
  const pendingRadars = allGrades.filter((g) => g.grade === "판정 불가");
  if (pendingRadars.length > 0) {
    lines.push(`※ ${pendingRadars.map((g) => g.radar).join(", ")}: 관측일수 부족(7일 미만)으로 판정 불가 — 추가 데이터 확보 후 재분석 필요.`);
  }

  return lines.join("\n");
}
