/**
 * 타워크레인 전파영향 검토 — 분석 진입점 (크레인 × 시설).
 *
 * 산식 프레임은 `craneReviewShared.ts` 헤더 규약을 따른다:
 *   · BRA 초과량 = Rust `analyze_crane_sweep`(2D 직사각 최근접 경계, 실제지구 기하) 값 그대로
 *   · LoS 초과량 = 지브·카운터지브를 레이더–마스트 방위 단면에 **투영**한 근사
 *     (부위의 레이더 쪽 최근접 반경에서 4/3 음영고도와 비교, 지면 클램프는 의견서와 동일)
 *
 * 단면 코리도(SRTM 전수 프로파일 + 경로 건물 + 제외 규칙)는 의견서와 **같은 함수**
 * (`fetchFacilityCorridor`)를 쓴다 — 산식·제외 규칙이 양쪽에서 함께 움직이도록.
 *
 * 폴백 금지(CLAUDE.md): 시설별 실패(BRA 스윕/단면)는 조용히 제외하지 않고 `error` 로 남겨
 * 문서에 표기한다. BRA 스윕이 실패하면 초과량을 추정하지 않고 케이스 자체를 내지 않는다
 * (0 이나 NaN 을 채우면 "적합" 판정으로 읽히는 오판이 된다).
 */
import { invoke } from "@tauri-apps/api/core";
import { corridorGeometry, fetchFacilityCorridor, R_EARTH_M } from "./braReviewAnalysis";
import {
  CRANE_JIB_TRUSS_H,
  CRANE_SELF_EXCLUDE_M,
  jibRadialOffsetsKm,
  penetratingRanges,
  shadowMslAt,
  type CraneAngleSeries,
  type CraneCaseKind,
  type CraneCaseVerdict,
  type CraneFacilityAnalysis,
  type CraneProfilePoint,
  type CraneReviewPayload,
  type CraneReviewResult,
} from "./craneReviewShared";
import type { BuildingOnPath, RadarSite, TowerCrane } from "../types";
import type { BraCraneSweep } from "../types/bra";

const DEG2RAD = Math.PI / 180;

/** 예외 → 문구 */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 크레인 1기 × 시설 1개 분석 */
async function analyzeCraneFacility(
  crane: TowerCrane,
  site: RadarSite,
  payload: CraneReviewPayload,
  mastTopMslM: number,
  jibTopMslM: number,
): Promise<CraneFacilityAnalysis> {
  // 거리·방위·차트 범위·샘플 간격은 의견서와 동일 원천(corridorGeometry)
  const { hAntM, distKm, azimuthDeg, chartMaxKm, sampleStepM } = corridorGeometry(
    site, crane.latitude, crane.longitude,
  );
  const dM = distKm * 1000;
  // BRA 제한고도 — 실제지구 기하(4/3 미적용), bra.rs cone_msl 동일 정의
  const coneMslAtMastM =
    hAntM + dM * Math.tan(payload.braAngleDeg * DEG2RAD) + (dM * dM) / (2 * R_EARTH_M);

  const errors: string[] = [];

  // ── ① BRA 방위각 스윕 (Rust, 정확 2D 기하) ──
  let sweep: BraCraneSweep | null = null;
  try {
    sweep = await invoke<BraCraneSweep>("analyze_crane_sweep", {
      radarLat: site.latitude,
      radarLon: site.longitude,
      radarHeightM: hAntM,
      angleDeg: payload.braAngleDeg,
      craneId: crane.id,
    });
  } catch (e) {
    errors.push(`BRA 스윕 산출 실패: ${errText(e)}`);
  }

  // ── ② 단면 코리도 (SRTM 전수 프로파일 + 경로 건물) ──
  let profile: CraneProfilePoint[] = [];
  let pathBuildings: BuildingOnPath[] = [];
  let nearRadarExcluded = 0;
  let selfExcluded = 0;
  let corridorOk = false;
  if (!(distKm > 0.02)) {
    errors.push("레이더와 크레인의 수평거리가 너무 가까워 단면 분석을 수행할 수 없습니다");
  } else {
    try {
      const corridor = await fetchFacilityCorridor(site, crane.latitude, crane.longitude, {
        selfLat: crane.latitude,
        selfLon: crane.longitude,
        selfExcludeM: CRANE_SELF_EXCLUDE_M,
      });
      profile = corridor.profile;
      pathBuildings = corridor.pathBuildings;
      nearRadarExcluded = corridor.nearRadarExcluded;
      selfExcluded = corridor.selfExcluded;
      corridorOk = true;
    } catch (e) {
      errors.push(`단면 분석 실패: ${errText(e)}`);
    }
  }

  // ── ③ LoS 방위각별 초과량 (단면 투영 근사) ──
  // 부위 상단 − max(음영고도, 지반고). 앞쪽 장애물이 없으면 음영고도 = 지반고(지면 클램프,
  // 의견서 LoSProfilePanel 과 동일) → 초과량 = 부위 높이 그 자체(완전 가시).
  const shadowClampedAt = (dNearKm: number): number =>
    Math.max(shadowMslAt(profile, pathBuildings, hAntM, dNearKm) ?? -Infinity, crane.ground_elev);

  let shadowAtMastM: number | null = null;
  let mastLosExceedM: number | null = null;
  let losExceedByDeg: number[] | null = null;
  let losFullExceedM: number | null = null;
  if (corridorOk) {
    shadowAtMastM = shadowMslAt(profile, pathBuildings, hAntM, distKm);
    mastLosExceedM = mastTopMslM - shadowClampedAt(distKm);
    const arr = new Array<number>(360);
    let full = -Infinity;
    for (let deg = 0; deg < 360; deg++) {
      const { jibTipKm, counterTipKm } = jibRadialOffsetsKm(crane, azimuthDeg, deg);
      // 부위의 **최근접 반경** = 마스트 중심 + min(0, 오프셋) — 레이더 쪽으로 뻗을 때만 가까워지고,
      // 반대쪽으로 뻗으면 팔의 뿌리(마스트 중심)가 최근접이다.
      let e = mastLosExceedM;
      const jibE = jibTopMslM - shadowClampedAt(distKm + Math.min(0, jibTipKm));
      if (jibE > e) e = jibE;
      // 카운터지브 길이 0 은 부위 없음 (Rust sweep_crane 과 동일 취급)
      if (crane.counter_jib_length > 0) {
        const counterE = jibTopMslM - shadowClampedAt(distKm + Math.min(0, counterTipKm));
        if (counterE > e) e = counterE;
      }
      arr[deg] = e;
      if (e > full) full = e;
    }
    losExceedByDeg = arr;
    losFullExceedM = full;
  }

  // ── ④ 방위각별 시계열 ──
  let series: CraneAngleSeries | null = null;
  if (sweep) {
    let losWorstDeg: number | null = null;
    let losBestDeg: number | null = null;
    if (losExceedByDeg) {
      let w = 0;
      let b = 0;
      for (let i = 1; i < losExceedByDeg.length; i++) {
        if (losExceedByDeg[i] > losExceedByDeg[w]) w = i; // 첫 등장 유지(> 비교)
        if (losExceedByDeg[i] < losExceedByDeg[b]) b = i;
      }
      losWorstDeg = w;
      losBestDeg = b;
    }
    series = {
      braExceedByDeg: sweep.exceed_by_deg,
      losExceedByDeg,
      braWorstDeg: sweep.worst_deg,
      braBestDeg: sweep.best_deg,
      losWorstDeg,
      losBestDeg,
      braPenetratingRanges: penetratingRanges(sweep.exceed_by_deg),
    };
  }

  // ── ⑤ 케이스 판정 (마스트 / 등록 / 최악 / 최선 / 전방위 / 지정) ──
  const cases: CraneCaseVerdict[] = [];
  if (sweep) {
    const sw = sweep;
    const losAt = (deg: number): number | null => (losExceedByDeg ? losExceedByDeg[deg] : null);
    const push = (
      kind: CraneCaseKind,
      label: string,
      jibDeg: number | null,
      braExceedM: number,
      losExceedM: number | null,
    ) => {
      cases.push({
        kind,
        label,
        jibDeg,
        braExceedM,
        braExceeded: braExceedM > 0,
        losExceedM,
        losShielded: losExceedM != null ? losExceedM <= 0 : null,
      });
    };

    push("mast", "마스트 단독", null, sw.mast_exceed_m, mastLosExceedM);

    // 등록 상태 — 전방위 선회면 방위가 없으므로 전방위 최악조건 값으로 판정한다
    if (crane.rotation_mode === "full") {
      push("registered", "등록 상태 (전방위)", null, sw.full_exceed_m, losFullExceedM);
    } else {
      // 스윕 곡선은 1° 격자라 등록 방위각을 정수로 반올림해 읽는다(폴라 차트 표시와 동일 지점)
      const regDeg = Math.round(crane.jib_azimuth_deg) % 360;
      push("registered", `등록 방위각 ${regDeg}°`, regDeg, sw.exceed_by_deg[regDeg], losAt(regDeg));
    }

    push("worst", `BRA 최악각 ${sw.worst_deg}°`, sw.worst_deg, sw.worst_exceed_m, losAt(sw.worst_deg));
    push("best", `BRA 최선각 ${sw.best_deg}°`, sw.best_deg, sw.best_exceed_m, losAt(sw.best_deg));
    push("full", "전방위 최악조건", null, sw.full_exceed_m, losFullExceedM);

    for (const deg of payload.customAngles) {
      push("custom", `지정 방위각 ${deg}°`, deg, sw.exceed_by_deg[deg], losAt(deg));
    }
  }

  const facility: CraneFacilityAnalysis = {
    site,
    hAntM,
    distKm,
    azimuthDeg,
    coneMslAtMastM,
    sweep,
    series,
    cases,
    profile,
    pathBuildings,
    chartMaxKm,
    sampleStepM,
    nearRadarExcluded,
    selfExcluded,
    shadowAtMastM,
  };
  if (errors.length > 0) facility.error = errors.join(" / ");
  return facility;
}

/** 페이로드 → 크레인 × 시설 전수 분석. 시설별 실패는 error 로 남기고 제외하지 않는다. */
export async function analyzeCraneReview(payload: CraneReviewPayload): Promise<CraneReviewResult> {
  const cranes = await Promise.all(
    payload.cranes.map(async (crane) => {
      const mastTopMslM = crane.ground_elev + crane.top_height;
      const jibTopMslM = crane.ground_elev + crane.jib_height + CRANE_JIB_TRUSS_H;
      const facilities = await Promise.all(
        payload.radarSites.map((site) =>
          analyzeCraneFacility(crane, site, payload, mastTopMslM, jibTopMslM),
        ),
      );
      return { crane, mastTopMslM, jibTopMslM, facilities };
    }),
  );
  return { payload, cranes };
}
