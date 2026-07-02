/**
 * 장애물 월간 보고서 — 분석 소견 자동 생성
 *
 * 종합 소견 페이지의 판정 카드·추가 차단 구간 표·장애물 스트립이 상세 수치를 이미 표시하므로,
 * 소견 텍스트는 수치를 재나열하지 않고 「개요 → 종합 판정 → 항목별 요약 → 특이사항」의
 * 압축 서술만 담는다. 특이사항 섹션은 해당 항목이 있을 때만 출력.
 */
import type {
  RadarMonthlyResult, ManualBuilding, RadarSite, LoSProfileData,
} from "../types";
import type { AddedBlockageResult } from "../types/obstacle";
import type { CoverageLayer } from "./radarCoverage";
import {
  weightedLossAvg, weightedBaselineLossAvg, weightedTrendSlope,
  BLOCKAGE_WATCH_PCT, BLOCKAGE_CAUTION_PCT, BLOCKAGE_ALERT_PCT, BLOCKAGE_SEVERE_PCT,
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
  radarSites: RadarSite[];
  losMap: Map<string, LoSProfileData>;
  covLayersWithBuildings: Map<string, CoverageLayer[]>;
  covLayersWithout: Map<string, CoverageLayer[]>;
  analysisMonth: string;
  /** 건물별 추가 차단영역 소실율 (key: `${radarName}_${buildingId}`). 파노라마 준비 후 채워짐 — 비면 방위 소실율 기준 잠정 판정. */
  addedBlockageByKey?: Record<string, AddedBlockageResult>;
  /** 건물별 LoS 차단 판정 (key: losMap 키와 동일 `${radarName}_${buildingId}`). panorama 실루엣 기반(losBlockedFromPanorama,
   *  단면도 배지·소실표적 분류와 동일 소스). 파노라마 준비 후 채워짐 — 미제공 시 los.losBlocked(chord) 폴백. */
  losBlockedByKey?: Map<string, boolean>;
}

export function generateOMFindingsText(params: GenerateOMFindingsParams): string {
  const {
    radarResults, selectedBuildings, losMap,
    covLayersWithBuildings, covLayersWithout, analysisMonth,
    addedBlockageByKey, losBlockedByKey,
  } = params;

  const lines: string[] = [];
  const monthLabel = analysisMonth
    ? `${analysisMonth.slice(0, 4)}년 ${parseInt(analysisMonth.slice(5, 7))}월`
    : "";

  // 레이더별 방위 소실율 등급 — 종합 판정(폴백)과 항목별 요약(보조지표)에서 공용
  const allGrades = radarResults.map((rr) => {
    const stats = rr.daily_stats;
    const avg = weightedLossAvg(stats);
    const dev = avg - weightedBaselineLossAvg(stats);
    const grade = stats.length < 7 ? "판정 불가" : gradeLabel(avg);
    return { radar: rr.radar_name, avg, dev, grade };
  });
  const gradeTexts = allGrades
    .map((g) => `${g.radar} '${g.grade}'(${g.avg.toFixed(2)}%, 전방위 대비 ${g.dev > 0 ? "+" : ""}${g.dev.toFixed(2)}%p)`)
    .join(" · ");

  // ── 1. 분석 개요 ──
  const bldgNames = selectedBuildings.map((b) => b.name || `건물${b.id}`).join(", ");
  const radarNames = radarResults.map((r) => r.radar_name).join(", ");
  lines.push(`■ 분석 개요`);
  lines.push(`${monthLabel ? monthLabel + " " : ""}장애물 월간 분석 — 대상 장애물: ${bldgNames} / 분석 레이더: ${radarNames}.`);
  lines.push(`표적소실·PSR 통계는 전 고도 항적 기준이며, 레이더별 상세 수치는 상단 판정 카드, 건물별 수치는 추가 차단 구간 표와 같다.`);
  lines.push("");

  // ── 2. 종합 판정 ──
  lines.push(`■ 종합 판정`);
  if (addedBlockageByKey) {
    // 인과 헤드라인 — 건물별 추가 차단영역 소실율 최악 등급 롤업.
    // 방위 소실율은 지형·트래픽 교란이 섞여 보조지표로만 두고 항목별 요약에서 언급.
    const order: Record<string, number> = { "심각": 5, "경계": 4, "주의": 3, "관심": 2, "양호": 1 };
    let worst = "", worstName = "", worstRate = 0;
    let blockageCount = 0, noneCount = 0; // 사유 분리용 — 추가 차단 구간 미형성 전부 여부
    for (const rr of radarResults) {
      for (const b of selectedBuildings) {
        const w = addedBlockageByKey[`${rr.radar_name}_${b.id}`];
        if (!w) continue;
        blockageCount++;
        if (w.grade.label === BLOCKAGE_NONE_LABEL) noneCount++;
        if (!(w.grade.label in order)) continue;
        if ((order[w.grade.label] ?? 0) > (order[worst] ?? 0)) {
          worst = w.grade.label;
          worstName = `${b.name || `건물${b.id}`}/${rr.radar_name}`;
          worstRate = w.lossRatePct;
        }
      }
    }
    const allBandNone = blockageCount > 0 && noneCount === blockageCount;
    if (worst === "양호") {
      lines.push(`분석 대상 장애물의 추가 차단영역 소실율은 양호 수준(최고 ${worstName} ${worstRate.toFixed(2)}%)으로, 장애물에 의한 유의미한 탐지 영향은 확인되지 않았다.`);
    } else if (worst === "관심") {
      lines.push(`분석 대상 장애물의 추가 차단영역 소실율이 관심 수준(${worstName} ${worstRate.toFixed(2)}%)으로, 경미하나 해당 방위·고도 탐지 성능의 지속 관찰이 필요하다.`);
    } else if (worst === "주의") {
      lines.push(`분석 대상 장애물의 추가 차단영역 소실율이 주의 수준(${worstName} ${worstRate.toFixed(2)}%)으로, 해당 방위·고도 탐지 성능을 지속 모니터링할 필요가 있다.`);
    } else if (worst === "경계") {
      lines.push(`분석 대상 장애물의 추가 차단영역 소실율이 경계 수준(${worstName} ${worstRate.toFixed(2)}%)으로, 장애물에 의한 탐지 성능 저하가 우려되며 운용 대책 검토가 필요하다.`);
    } else if (worst === "심각") {
      lines.push(`분석 대상 장애물의 추가 차단영역 소실율이 심각 수준(${worstName} ${worstRate.toFixed(2)}%)으로, 현저한 탐지 성능 저하가 확인되어 즉각적인 운용 대책이 요구된다.`);
    } else if (allBandNone) {
      lines.push(`분석 대상 장애물이 지형·기존지물 위로 새로 가리는 구간을 형성하지 않아(추가 차단 구간 없음), 장애물에 의한 추가 탐지 영향은 없는 것으로 판단된다.`);
    } else {
      lines.push(`분석 대상 장애물의 추가 차단영역을 지나는 유효 항적이 거의 없거나 추가 차단 구간 자체가 형성되지 않아, 장애물 인과 영향은 확인되지 않음(또는 판정 불가).`);
    }
    lines.push(`※ 추가 차단영역 등급 임계 — 관심 ${BLOCKAGE_WATCH_PCT}% / 주의 ${BLOCKAGE_CAUTION_PCT}% / 경계 ${BLOCKAGE_ALERT_PCT}% / 심각 ${BLOCKAGE_SEVERE_PCT}% 이상.`);
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
  lines.push("");

  // ── 3. 항목별 요약 ──
  lines.push(`■ 항목별 요약`);

  // LoS — 차단 경로만 상세, 나머지는 개수로 축약
  if (losMap.size > 0) {
    // 건물 표시명 조회 맵 — losMap 키는 `${radarName}_${buildingId}` (computeLosBatch, 단일 '_').
    //   radarName 자체에 '_' 가 있어도 los.radarSiteName 접두사를 정확히 벗겨 건물 ID 를 얻는다.
    const bldgNameById = new Map<string, string>();
    for (const b of selectedBuildings) bldgNameById.set(String(b.id), b.name || `건물${b.id}`);
    const blockedDescs: string[] = [];
    for (const [key, los] of losMap) {
      // 차단 판정 — panorama 실루엣(단면도 배지·소실표적 분류와 동일 소스) 우선, 없으면 chord(los.losBlocked) 폴백.
      const blocked = losBlockedByKey?.get(key) ?? los.losBlocked;
      if (!blocked) continue;
      const radarPrefix = `${los.radarSiteName}_`;
      const bldgIdStr = key.startsWith(radarPrefix) ? key.slice(radarPrefix.length) : key;
      const targetName = bldgNameById.get(bldgIdStr) ?? `건물 #${bldgIdStr}`;
      let desc = `${los.radarSiteName}→${targetName}`;
      if (los.maxBlockingPoint) {
        const bp = los.maxBlockingPoint;
        desc += `(차단점 ${bp.distance.toFixed(1)}km, ${bp.elevation.toFixed(0)}m${bp.name ? ` [${bp.name}]` : ""})`;
      }
      blockedDescs.push(desc);
    }
    if (blockedDescs.length === 0) {
      lines.push(`- LoS(가시선): 전 ${losMap.size}개 경로 가시선 확보 — 장애물에 의한 전파 차단 없음.`);
    } else {
      lines.push(`- LoS(가시선): ${losMap.size}개 경로 중 ${blockedDescs.length}건 차단 — ${blockedDescs.join(", ")}. 해당 방위 저고도 탐지 제한 예상.`);
    }
  }

  // 커버리지(건물 유/무) — 유의미한 감소(평균 0.5km 초과)만 나열
  if (covLayersWithBuildings.size > 0 && covLayersWithout.size > 0) {
    const diffDescs: string[] = [];
    for (const rr of radarResults) {
      const rsLayersWith = covLayersWithBuildings.get(rr.radar_name) ?? [];
      const rsLayersWithout = covLayersWithout.get(rr.radar_name) ?? [];
      if (rsLayersWith.length === 0 || rsLayersWithout.length === 0) continue;
      const flDescs: string[] = [];
      const altFts = [...new Set(rsLayersWith.map((l) => l.altitudeFt))].sort((a, b) => a - b);
      for (const alt of altFts) {
        const withLayer = rsLayersWith.find((l) => l.altitudeFt === alt);
        const withoutLayer = rsLayersWithout.find((l) => l.altitudeFt === alt);
        if (!withLayer || !withoutLayer) continue;
        const avgWith = withLayer.bearings.reduce((s, b) => s + b.maxRangeKm, 0) / Math.max(withLayer.bearings.length, 1);
        const avgWithout = withoutLayer.bearings.reduce((s, b) => s + b.maxRangeKm, 0) / Math.max(withoutLayer.bearings.length, 1);
        const diff = avgWithout - avgWith;
        if (diff > 0.5) {
          flDescs.push(`FL${Math.round(alt / 100).toString().padStart(3, "0")} 평균 ${diff.toFixed(1)}km 감소(${avgWithout.toFixed(1)}→${avgWith.toFixed(1)}km)`);
        }
      }
      if (flDescs.length > 0) diffDescs.push(`${rr.radar_name} ${flDescs.join(" · ")}`);
    }
    if (diffDescs.length === 0) {
      lines.push(`- 커버리지(건물 유/무): 전 고도에서 유의미한 차이 없음.`);
    } else {
      lines.push(`- 커버리지(건물 유/무): ${diffDescs.join(" / ")} — 해당 고도·방위 탐지범위 축소.`);
    }
  }

  // 방위 소실율 — 교란요인(지형·트래픽) 많아 보조지표
  lines.push(`- 방위 소실율(보조지표): ${gradeTexts}. 방위별 지형·트래픽 차이로 건물 인과 분리에 한계가 있어 참고용.`);

  // ── 4. 특이사항 ── (해당 항목이 있을 때만 섹션 출력)
  const notes: string[] = [];
  for (const rr of radarResults) {
    const stats = rr.daily_stats;
    if (stats.length === 0) {
      notes.push(`- ${rr.radar_name}: 분석 데이터 없음.`);
      continue;
    }
    const avgLoss = weightedLossAvg(stats);
    // 일별 소실율 악화(증가) 추세만 보고 — 감소·안정은 생략(추가 차단 표의 추세 열로 충분)
    if (stats.length >= 7) {
      const slope = weightedTrendSlope(stats.map((d) => ({ x: d.day_of_month, y: d.loss_rate, w: d.total_track_time_secs })));
      if (slope > 0.02) {
        notes.push(`- ${rr.radar_name}: (대상 방위) 일별 소실율 증가 추세(일당 +${slope.toFixed(3)}%p) — 지속 관찰 필요.`);
      }
    }
    // 최고 소실일
    const maxDay = stats.reduce((max, d) => (d.loss_rate > max.loss_rate ? d : max), stats[0]);
    if (maxDay.loss_rate > avgLoss * 1.5 && maxDay.loss_rate > 1) {
      notes.push(`- ${rr.radar_name}: 최대 소실일 ${maxDay.date}(${maxDay.loss_rate.toFixed(2)}%) — 해당 일 특이사항 확인 필요.`);
    }
    // 저고도 소실 집중 — 이벤트 0건이면 평균고도 자체가 무의미(Rust 기본값 0.0)라 생략 (이중 안전)
    let hasLossEvent = false;
    for (const d of stats) {
      if (d.loss_points_summary.length > 0) { hasLossEvent = true; break; }
    }
    if (hasLossEvent && rr.avg_loss_altitude_ft > 0) {
      const altM = rr.avg_loss_altitude_ft * 0.3048;
      if (altM < 500) {
        notes.push(`- ${rr.radar_name}: 소실 이벤트 평균고도 ${rr.avg_loss_altitude_ft.toFixed(0)}ft(${altM.toFixed(0)}m) — 저고도 집중, 장애물에 의한 전파 차단 가능성.`);
      }
    }
  }
  if (notes.length > 0) {
    lines.push("");
    lines.push(`■ 특이사항`);
    for (const n of notes) lines.push(n);
  }

  return lines.join("\n");
}
