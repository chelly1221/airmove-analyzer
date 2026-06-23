/**
 * 장애물 월간 보고서 — 분석 소견 자동 생성
 * 각 항목별 분석 결과를 토대로 소견 템플릿을 자동 작성
 */
import type {
  RadarMonthlyResult, ManualBuilding, RadarSite, LoSProfileData,
} from "../types";
import type { AddedBlockageResult } from "../types/obstacle";
import type { CoverageLayer } from "./radarCoverage";
import { weightedLossAvg, weightedLossStdDev, weightedPsrAvg, weightedBaselineLossAvg, weightedTrendSlope, BLOCKAGE_CAUTION_PCT, BLOCKAGE_ALERT_PCT, BLOCKAGE_NONE_LABEL } from "./omStats";
import { haversineKm } from "./geo";

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
  /** 건물별 추가 차단영역 소실율 (key: `${radarName}_${buildingId}`). 파노라마 준비 후 채워짐 — 비면 추가 차단영역 프로즈 생략. */
  addedBlockageByKey?: Record<string, AddedBlockageResult>;
}

export function generateOMFindingsText(params: GenerateOMFindingsParams): string {
  const {
    radarResults, selectedBuildings, radarSites,
    losMap, covLayersWithBuildings, covLayersWithout, analysisMonth, addedBlockageByKey,
  } = params;

  const lines: string[] = [];
  const monthLabel = analysisMonth
    ? `${analysisMonth.slice(0, 4)}년 ${parseInt(analysisMonth.slice(5, 7))}월`
    : "";

  // ── 1. 분석 개요 ──
  const bldgNames = selectedBuildings.map((b) => b.name || `건물${b.id}`).join(", ");
  const radarNames = radarResults.map((r) => r.radar_name).join(", ");
  lines.push(`■ 분석 개요`);
  lines.push(`${monthLabel ? monthLabel + " " : ""}장애물 월간 분석을 수행하였으며, 분석 대상 장애물은 ${bldgNames}이고, 분석 레이더는 ${radarNames}이다.`);
  lines.push(`  - 항적 분석 고도 범위: 20,000ft(FL200) 이하 항적 (장애물 차단이 유효한 저고도 대역에 한정). FL200 초과 항적은 표적소실·PSR 등 항적 기반 통계에서 제외한다. (커버리지 비교의 FL별 분석은 별도 기준.)`);

  // 건물별 거리 정보
  for (const b of selectedBuildings) {
    const dists = radarSites.map((rs) => {
      const km = haversineKm(rs.latitude, rs.longitude, b.latitude, b.longitude);
      return `${rs.name} ${km.toFixed(1)}km`;
    });
    lines.push(`  - ${b.name || `건물${b.id}`}: 높이 ${b.height}m, ${dists.join(", ")}`);
  }
  lines.push("");

  // ── 2. 레이더별 표적소실 분석 ──
  lines.push(`■ 레이더별 표적소실 분석`);
  for (const rr of radarResults) {
    const stats = rr.daily_stats;
    if (stats.length === 0) {
      lines.push(`${rr.radar_name}: 분석 데이터 없음`);
      continue;
    }

    const avgLoss = weightedLossAvg(stats);
    const lossSigma = weightedLossStdDev(stats);
    const avgBaseline = weightedBaselineLossAvg(stats);
    const avgPsr = weightedPsrAvg(stats);
    const deviation = avgLoss - avgBaseline;
    const grade = stats.length < 7 ? "판정 보류" : gradeLabel(avgLoss);
    const totalLossEvents = stats.flatMap((d) => d.loss_points_summary).length;

    lines.push(`[${rr.radar_name}] 방위 소실율 등급(보조): ${grade}${stats.length < 7 ? ` (관측일수 ${stats.length}일 < 7일)` : ""}`);
    lines.push(`  - 분석 기간: ${stats.length}일, 평균 표적소실율: ${avgLoss.toFixed(2)}%(±${lossSigma.toFixed(2)}), 기준선: ${avgBaseline.toFixed(2)}%, 편차: ${deviation > 0 ? "+" : ""}${deviation.toFixed(2)}%p`);
    lines.push(`  - 평균 PSR 탐지율: ${(avgPsr * 100).toFixed(1)}%, 소실 이벤트: ${totalLossEvents}건`);

    // ── 건물별 추가 차단 구간 소실율 — 헤드라인 인과 지표 ──
    //   "이 건물이 새로 가리는 차단영역을 지나는 항적이 소실되는 비율". 방위 비교(아래)보다 우선.
    if (addedBlockageByKey) {
      const blockageLines: string[] = [];
      for (const b of selectedBuildings) {
        const w = addedBlockageByKey[`${rr.radar_name}_${b.id}`];
        if (!w) continue;
        const bn = b.name || `건물${b.id}`;
        const expPt = Math.round(w.exposurePointCount).toLocaleString();
        const lossPt = Math.round(w.lossPointCount).toLocaleString();
        if (w.grade.label === BLOCKAGE_NONE_LABEL) {
          blockageLines.push(`    · ${bn}: 분석 대상이 지형·기존지물 위로 새로 가리는 구간이 없어 추가 차단영역 미형성 → 영향 없음으로 판단`);
        } else if (w.grade.label === "판정 보류") {
          blockageLines.push(`    · ${bn}: 추가 차단 구간 — 관측일수 부족으로 판정 보류`);
        } else if (w.grade.label === "항적 없음") {
          blockageLines.push(`    · ${bn}: 추가 차단 구간을 지나는 항적이 거의 없어(통과 ${expPt}pt) 영향 없음으로 판단`);
        } else {
          const tr = w.trendDir === "안정"
            ? "추세 안정"
            : `추세 ${w.trendDir}(일당 ${w.trendSlopePctPerDay > 0 ? "+" : ""}${w.trendSlopePctPerDay.toFixed(3)}%p)`;
          blockageLines.push(`    · ${bn}: 추가 차단 구간 소실율 ${w.lossRatePct.toFixed(2)}% (${w.grade.label}), ${tr}, 통과 ${expPt}pt 중 소실 ${lossPt}pt/${w.daysWithExposure}일`);
        }
      }
      if (blockageLines.length > 0) {
        lines.push(`  → 분석 대상 장애물의 추가 차단영역(지형·기존지물 차단각 초과~대상 차단각 사이, 지나는 항적이 소실되는 비율):`);
        for (const wl of blockageLines) lines.push(wl);
      }
    }

    // 참고(방위 비교) — 교란요인(지형·트래픽) 많아 보조 지표로 강등
    lines.push(`  · 참고(방위 비교): 대상 방위 구간 소실율 ${avgLoss.toFixed(2)}% vs 전 방위 기준선 ${avgBaseline.toFixed(2)}% (편차 ${deviation > 0 ? "+" : ""}${deviation.toFixed(2)}%p). 방위마다 지형·트래픽이 달라 건물 인과 분리엔 한계가 있어, 위 추가 차단 구간 소실율을 우선 판단 근거로 함.`);

    // 일별 추이 분석 (가중 최소자승 회귀) — 레이더 대상 방위 소실율 추세
    if (stats.length >= 7) {
      const slope = weightedTrendSlope(stats.map((d) => ({ x: d.day_of_month, y: d.loss_rate, w: d.total_track_time_secs })));
      if (Math.abs(slope) > 0.02) {
        const trend = slope > 0 ? "증가" : "감소";
        lines.push(`  → 분석 기간 중 (대상 방위) 일별 소실율 ${trend} 추세 (일당 ${slope > 0 ? "+" : ""}${slope.toFixed(3)}%p).`);
      } else {
        lines.push(`  → 분석 기간 중 (대상 방위) 일별 소실율은 비교적 안정적.`);
      }
    }

    // 최고 소실일
    const maxDay = stats.reduce((max, d) => d.loss_rate > max.loss_rate ? d : max, stats[0]);
    if (maxDay.loss_rate > avgLoss * 1.5 && maxDay.loss_rate > 1) {
      lines.push(`  → 최대 소실일: ${maxDay.date} (${maxDay.loss_rate.toFixed(2)}%), 해당 일 특이사항 확인 필요.`);
    }

    // Loss 고도 분석
    if (rr.avg_loss_altitude_ft > 0) {
      const altM = rr.avg_loss_altitude_ft * 0.3048;
      lines.push(`  - 소실 이벤트 평균 고도: ${rr.avg_loss_altitude_ft.toFixed(0)}ft (${altM.toFixed(0)}m)`);
      if (altM < 500) {
        lines.push(`  → 저고도(500m 미만)에서 소실이 집중되어, 장애물에 의한 전파 차단 가능성이 있다.`);
      }
    }
  }
  lines.push("");

  // ── 3. LoS 분석 결과 ──
  if (losMap.size > 0) {
    lines.push(`■ LoS(가시선) 분석`);
    let hasBlocked = false;
    for (const [key, los] of losMap) {
      const blocked = los.losBlocked;
      if (blocked) hasBlocked = true;
      const distKm = los.totalDistance; // totalDistance 는 이미 km (computeLosBatch)
      const statusStr = blocked ? "차단" : "양호";
      let detail = `  - ${los.radarSiteName} → ${key.includes("__") ? key.split("__")[1] : key}: ${distKm.toFixed(1)}km, ${statusStr}`;
      if (blocked && los.maxBlockingPoint) {
        const bp = los.maxBlockingPoint;
        detail += ` (차단점: ${bp.distance.toFixed(1)}km 지점, ${bp.elevation.toFixed(0)}m${bp.name ? ` [${bp.name}]` : ""})`;
      }
      lines.push(detail);
    }
    if (hasBlocked) {
      lines.push(`  → 일부 방향에서 LoS 차단이 확인되어, 해당 방위 저고도 표적의 탐지 제한이 예상된다.`);
    } else {
      lines.push(`  → 모든 방향에서 LoS가 확보되어 있으며, 장애물에 의한 전파 차단은 확인되지 않는다.`);
    }
    lines.push("");
  }

  // ── 4. 커버리지 비교 분석 ──
  if (covLayersWithBuildings.size > 0 && covLayersWithout.size > 0) {
    lines.push(`■ 커버리지 비교 분석 (건물 유/무)`);
    let anySignificantDiff = false;
    for (const rr of radarResults) {
      const rsLayersWith = covLayersWithBuildings.get(rr.radar_name) ?? [];
      const rsLayersWithout = covLayersWithout.get(rr.radar_name) ?? [];
      if (rsLayersWith.length === 0 || rsLayersWithout.length === 0) continue;
      lines.push(`  [${rr.radar_name}]`);
      const altFts = [...new Set(rsLayersWith.map((l) => l.altitudeFt))].sort((a, b) => a - b);
      let significantDiff = false;
      for (const alt of altFts) {
        const withLayer = rsLayersWith.find((l) => l.altitudeFt === alt);
        const withoutLayer = rsLayersWithout.find((l) => l.altitudeFt === alt);
        if (!withLayer || !withoutLayer) continue;

        const avgWith = withLayer.bearings.reduce((s, b) => s + b.maxRangeKm, 0) / Math.max(withLayer.bearings.length, 1);
        const avgWithout = withoutLayer.bearings.reduce((s, b) => s + b.maxRangeKm, 0) / Math.max(withoutLayer.bearings.length, 1);
        const diff = avgWithout - avgWith;
        if (diff > 0.5) {
          significantDiff = true;
          anySignificantDiff = true;
          lines.push(`  - FL${Math.round(alt / 100).toString().padStart(3, "0")} (${alt}ft): 건물에 의해 평균 커버리지 ${diff.toFixed(1)}km 감소 (${avgWithout.toFixed(1)}km → ${avgWith.toFixed(1)}km)`);
        }
      }
      if (!significantDiff) {
        lines.push(`  - 커버리지 차이 유의미하지 않음`);
      }
    }
    if (anySignificantDiff) {
      lines.push(`  → 분석 대상 건물에 의한 커버리지 감소가 확인되며, 해당 고도/방위에서 탐지 범위가 축소된다.`);
    } else {
      lines.push(`  → 분석 대상 건물에 의한 커버리지 차이는 유의미하지 않다.`);
    }
    lines.push("");
  }

  // ── 5. 종합 판정 ──
  lines.push(`■ 종합 판정`);
  const allGrades = radarResults.map((rr) => {
    const avg = weightedLossAvg(rr.daily_stats);
    const grade = rr.daily_stats.length < 7 ? "판정 보류" : gradeLabel(avg);
    return { radar: rr.radar_name, avg, grade };
  });

  const hasPending = allGrades.some((g) => g.grade === "판정 보류");
  const gradeTexts = allGrades.map((g) => `${g.radar} '${g.grade}'(${g.avg.toFixed(2)}%)`).join(", ");

  // 헤드라인(인과 기준) — 건물별 추가 차단영역 소실율 최악 등급 롤업을 1차 결론으로.
  // 방위 소실율(아래)은 지형·트래픽 교란이 섞여 인과 분리엔 한계가 있어 보조지표로만 둔다.
  if (addedBlockageByKey) {
    const order: Record<string, number> = { "경고": 3, "주의": 2, "양호": 1 };
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
      lines.push(`[헤드라인·인과] 분석 대상 장애물의 추가 차단영역 소실율은 양호 수준(최고 ${worstName} ${worstRate.toFixed(2)}%)으로, 장애물에 의한 유의미한 탐지 영향은 확인되지 않았다.`);
    } else if (worst === "주의") {
      lines.push(`[헤드라인·인과] 분석 대상 장애물의 추가 차단영역 소실율이 주의 수준(${worstName} ${worstRate.toFixed(2)}%)으로, 해당 방위·고도 탐지 성능을 지속 모니터링할 필요가 있다.`);
    } else if (worst === "경고") {
      lines.push(`[헤드라인·인과] 분석 대상 장애물의 추가 차단영역 소실율이 경고 수준(${worstName} ${worstRate.toFixed(2)}%)으로, 장애물에 의한 탐지 성능 저하가 우려되며 운용 대책 검토가 필요하다.`);
    } else if (allBandNone) {
      lines.push(`[헤드라인·인과] 분석 대상 장애물이 지형·기존지물 위로 새로 가리는 구간을 형성하지 않아(추가 차단 구간 없음), 장애물에 의한 추가 탐지 영향은 없는 것으로 판단된다.`);
    } else {
      lines.push(`[헤드라인·인과] 분석 대상 장애물의 추가 차단영역을 지나는 유효 항적이 거의 없거나 추가 차단 구간 자체가 형성되지 않아, 장애물 인과 영향은 확인되지 않음(또는 판정 보류).`);
    }
    lines.push(`  ※ 추가 차단영역 등급 임계(주의 ${BLOCKAGE_CAUTION_PCT}% / 경고 ${BLOCKAGE_ALERT_PCT}%)는 실측 분포 보정 전 잠정 기준임.`);
    lines.push(`참고(방위 소실율, 보조지표): ${gradeTexts}. 방위마다 지형·트래픽이 달라 위 인과 헤드라인을 우선 판단 근거로 한다.`);
  } else {
    // 파노라마 미준비(생성 직후) — 인과 헤드라인 산출 전이라 방위 소실율 기준 잠정 결론.
    const worstGrade = allGrades.some((g) => g.grade === "경고") ? "경고"
      : allGrades.some((g) => g.grade === "주의") ? "주의" : "양호";
    lines.push(`레이더별 판정(대상 방위 소실율): ${gradeTexts}`);
    if (worstGrade === "양호") {
      lines.push(`분석 기간 중 모든 레이더에서 표적소실율이 양호 수준으로, 분석 대상 장애물에 의한 유의미한 운용 영향은 확인되지 않았다.`);
    } else if (worstGrade === "주의") {
      lines.push(`일부 레이더에서 표적소실율이 주의 수준이며, 분석 대상 장애물 방위 구간에서의 탐지 성능을 지속적으로 모니터링할 필요가 있다.`);
    } else {
      lines.push(`일부 레이더에서 표적소실율이 경고 수준으로, 분석 대상 장애물에 의한 탐지 성능 저하가 우려되며, 운용 관련 대책 검토가 필요하다.`);
    }
  }
  if (hasPending) {
    const pendingRadars = allGrades.filter((g) => g.grade === "판정 보류").map((g) => g.radar).join(", ");
    lines.push(`(${pendingRadars}: 관측일수 부족으로 판정 보류 — 추가 데이터 확보 후 재분석 필요)`);
  }

  return lines.join("\n");
}
