/**
 * 장애물 월간 보고서 — 분석 소견 자동 생성
 * 각 항목별 분석 결과를 토대로 소견 템플릿을 자동 작성
 */
import type {
  RadarMonthlyResult, ManualBuilding, RadarSite, LoSProfileData,
} from "../types";
import type { CoverageLayer } from "./radarCoverage";
import { weightedLossAvg, weightedLossStdDev, weightedPsrAvg, weightedBaselineLossAvg, LOSS_DEV_THRESHOLD } from "./omStats";
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
}

export function generateOMFindingsText(params: GenerateOMFindingsParams): string {
  const {
    radarResults, selectedBuildings, radarSites,
    losMap, covLayersWithBuildings, covLayersWithout, analysisMonth,
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

    lines.push(`[${rr.radar_name}] 종합 판정: ${grade}${stats.length < 7 ? ` (관측일수 ${stats.length}일 < 7일)` : ""}`);
    lines.push(`  - 분석 기간: ${stats.length}일, 평균 표적소실율: ${avgLoss.toFixed(2)}%(±${lossSigma.toFixed(2)}), 기준선: ${avgBaseline.toFixed(2)}%, 편차: ${deviation > 0 ? "+" : ""}${deviation.toFixed(2)}%p`);
    lines.push(`  - 평균 PSR 탐지율: ${(avgPsr * 100).toFixed(1)}%, 소실 이벤트: ${totalLossEvents}건`);

    // 편차 해석
    if (Math.abs(deviation) < LOSS_DEV_THRESHOLD) {
      lines.push(`  → 대상 방위 구간의 소실율이 기준선과 유사하여, 분석 대상 장애물에 의한 추가적인 표적소실 영향은 미미한 것으로 판단된다.`);
    } else if (deviation > 0) {
      lines.push(`  → 대상 방위 구간의 소실율이 기준선 대비 ${deviation.toFixed(2)}%p 높아, 분석 대상 장애물이 표적소실에 영향을 미치는 것으로 판단된다.`);
    } else {
      lines.push(`  → 대상 방위 구간의 소실율이 기준선 대비 오히려 낮아, 분석 대상 장애물에 의한 표적소실 영향은 확인되지 않는다.`);
    }

    // 일별 추이 분석 (가중 최소자승 회귀, day_of_month 기반 — 비행시간 가중치로 소수 관측일 편향 방지)
    if (stats.length >= 7) {
      // 가중 최소자승 회귀 — 비행시간 가중치로 소수 관측일 편향 방지
      const weights = stats.map((d) => d.total_track_time_secs);
      const sumW = weights.reduce((a, b) => a + b, 0);
      if (sumW > 0) {
        const xMeanW = stats.reduce((s, d, i) => s + d.day_of_month * weights[i], 0) / sumW;
        const yMeanW = stats.reduce((s, d, i) => s + d.loss_rate * weights[i], 0) / sumW;
        let num = 0, den = 0;
        stats.forEach((d, i) => {
          const w = weights[i];
          num += w * (d.day_of_month - xMeanW) * (d.loss_rate - yMeanW);
          den += w * (d.day_of_month - xMeanW) ** 2;
        });
        const slope = den > 0 ? num / den : 0;
        if (Math.abs(slope) > 0.02) {
          const trend = slope > 0 ? "증가" : "감소";
          lines.push(`  → 분석 기간 중 일별 소실율 ${trend} 추세가 관찰된다 (일당 ${slope > 0 ? "+" : ""}${slope.toFixed(3)}%p).`);
        } else {
          lines.push(`  → 분석 기간 중 일별 소실율은 비교적 안정적인 추세를 보인다.`);
        }
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
      const distKm = los.totalDistance / 1000;
      const statusStr = blocked ? "차단" : "양호";
      let detail = `  - ${los.radarSiteName} → ${key.includes("__") ? key.split("__")[1] : key}: ${distKm.toFixed(1)}km, ${statusStr}`;
      if (blocked && los.maxBlockingPoint) {
        const bp = los.maxBlockingPoint;
        detail += ` (차단점: ${(bp.distance / 1000).toFixed(1)}km 지점, ${bp.elevation.toFixed(0)}m${bp.name ? ` [${bp.name}]` : ""})`;
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
  const worstGrade = allGrades.some((g) => g.grade === "경고")
    ? "경고"
    : allGrades.some((g) => g.grade === "주의")
    ? "주의"
    : "양호";

  const gradeTexts = allGrades.map((g) => `${g.radar} '${g.grade}'(${g.avg.toFixed(2)}%)`).join(", ");
  lines.push(`레이더별 판정: ${gradeTexts}`);

  if (worstGrade === "양호") {
    lines.push(`분석 기간 중 모든 레이더에서 표적소실율이 양호 수준으로, 분석 대상 장애물에 의한 유의미한 운용 영향은 확인되지 않았다.`);
  } else if (worstGrade === "주의") {
    lines.push(`일부 레이더에서 표적소실율이 주의 수준이며, 분석 대상 장애물 방위 구간에서의 탐지 성능을 지속적으로 모니터링할 필요가 있다.`);
  } else {
    lines.push(`일부 레이더에서 표적소실율이 경고 수준으로, 분석 대상 장애물에 의한 탐지 성능 저하가 우려되며, 운용 관련 대책 검토가 필요하다.`);
  }
  if (hasPending) {
    const pendingRadars = allGrades.filter((g) => g.grade === "판정 보류").map((g) => g.radar).join(", ");
    lines.push(`(${pendingRadars}: 관측일수 부족으로 판정 보류 — 추가 데이터 확보 후 재분석 필요)`);
  }

  return lines.join("\n");
}
