/**
 * 타워크레인 전파영향 검토 보고서 — 창 간 페이로드·분석 결과 타입과 순수 산식 헬퍼 (단일 원천).
 *
 * 프레임 규약(전파영향성 검토 의견서 braReviewAnalysis.ts 와 동일):
 *   · BRA 제한고도 = 실제지구 기하 `h_ant + d·tanθ + d²/2R` (Rust bra.rs cone_msl 동일, 4/3 미적용)
 *   · LoS 음영고도 = 4/3 유효지구 프레임 running-max 앙각 (지형 전수 샘플 + 경로 건물 near/far 엣지)
 *   · 단면도 표시 = 실제지구 디스플레이 프레임 (elev − curvDrop)
 *
 * 크레인 기하(Rust bra.rs 와 동일 상수): 마스트 = 변 mast_width 정사각·상단 top_height,
 * 지브/카운터지브 = 폭 CRANE_JIB_WIDTH_M 직사각, 상단 = jib_height + CRANE_JIB_TRUSS_H.
 * BRA 방위각별 초과량은 Rust `analyze_crane_sweep`(2D 직사각 최근접 경계, 정확) 값을 쓰고,
 * LoS 방위각별 초과량은 지브·카운터지브를 **레이더–마스트 방위 단면에 투영**(경로단면법)해 근사한다 —
 * 지브 끝의 횡방향 오프셋(≤ 지브 길이)은 수 km 거리에서 방위 변화가 미소하므로 단면 1개로 검토(보고서 각주에 명기).
 */
import type { BuildingOnPath, RadarSite, TowerCrane } from "../types";
import type { BraCraneSweep } from "../types/bra";
import { curvDrop43 } from "./braReviewAnalysis";

/** 지브 트러스 높이 (m) — Rust bra.rs JIB_TRUSS_H / craneGeometry.ts 동일 */
export const CRANE_JIB_TRUSS_H = 1.5;
/** 지브·카운터지브 폭 (m) — Rust bra.rs JIB_WIDTH_M 동일 */
export const CRANE_JIB_WIDTH_M = 2.0;
/** 크레인 위치 건물(자기 참조) 제외 반경 (m) — braReviewAnalysis SELF_EXCLUDE_M 과 동일 규약 */
export const CRANE_SELF_EXCLUDE_M = 15;

/** 분석 케이스 종류 */
export type CraneCaseKind = "mast" | "registered" | "worst" | "best" | "full" | "custom";

/** 창 간 전달 페이로드 (IndexedDB report-transfer/data 키 "cranereview") */
export interface CraneReviewPayload {
  version: 1;
  generatedAt: string;
  /** 검토 대상 크레인 (1기 이상, 등록 순) */
  cranes: TowerCrane[];
  /** 검토 시설 (사용자가 모달에서 선택) */
  radarSites: RadarSite[];
  /** BRA 기준각 (°) — 스토어 braAngleDeg 기본 */
  braAngleDeg: number;
  /** 사용자 지정 지브 방위각 (정수 0–359, 중복 제거·오름차순) */
  customAngles: number[];
  /** 사용자 지정 각도에 대해서도 수직 단면도를 포함할지 */
  customCrossSections: boolean;
  /** 동일 설정 판별 키 — 재로드 시 같으면 인라인 편집 override 유지 */
  reviewKey: string;
}

/** 케이스 1개(마스트 단독/등록 방위각/최악/최선/전방위/사용자 지정) 판정값 */
export interface CraneCaseVerdict {
  kind: CraneCaseKind;
  /** 표기 라벨 — "마스트 단독" | "등록 방위각 120°" | "BRA 최악각 179°" | "BRA 최선각 90°" | "전방위 최악조건" | "지정 방위각 45°" */
  label: string;
  /** 지브 방위각 (° 정북 0·시계방향). mast/full 은 null */
  jibDeg: number | null;
  /** BRA 초과량 (m, + 침범 / − 여유) — 실제지구 기하, Rust 스윕 값 */
  braExceedM: number;
  braExceeded: boolean;
  /** LoS 초과량 (m) — 4/3 음영고도 대비 (full 은 방위 전수 최악값). 단면 분석 실패 시 null */
  losExceedM: number | null;
  /** losExceedM ≤ 0 (음영 아래 = 차폐). null 이면 판정 불가 */
  losShielded: boolean | null;
}

/** BRA 초과(>0) 연속 방위 구간 — 랩어라운드(예: 350°→10°)는 endDeg < startDeg 로 표현 */
export interface CranePenetratingRange {
  startDeg: number;
  endDeg: number;
  maxExceedM: number;
  maxAtDeg: number;
}

/** 방위각별(θ=0..359) 시계열 */
export interface CraneAngleSeries {
  /** 길이 360 — Rust exceed_by_deg */
  braExceedByDeg: number[];
  /** 길이 360 — LoS 초과량(단면 투영 근사). 단면 분석 실패 시 null */
  losExceedByDeg: number[] | null;
  braWorstDeg: number;
  braBestDeg: number;
  losWorstDeg: number | null;
  losBestDeg: number | null;
  braPenetratingRanges: CranePenetratingRange[];
}

/** 단면 프로파일 샘플 (SRTM 전수, MSL) */
export interface CraneProfilePoint {
  distKm: number;
  elevM: number;
  lat: number;
  lon: number;
}

/** 크레인 1기 × 시설 1개 분석 결과 */
export interface CraneFacilityAnalysis {
  site: RadarSite;
  /** 안테나 정점 표고 (MSL) = altitude + antenna_height */
  hAntM: number;
  /** 레이더 → 마스트 중심 거리 (km, haversine) */
  distKm: number;
  /** 레이더 → 크레인 방위 (°) */
  azimuthDeg: number;
  /** 마스트 중심 거리의 BRA 제한고도 (MSL) */
  coneMslAtMastM: number;
  /** Rust analyze_crane_sweep 원본 (실패 시 null + error) */
  sweep: BraCraneSweep | null;
  series: CraneAngleSeries | null;
  /** 순서: mast, registered, worst, best, full, custom… (customAngles 오름차순) */
  cases: CraneCaseVerdict[];
  /** 단면 프로파일 (레이더 → 크레인 방위선, chartMaxKm 까지) */
  profile: CraneProfilePoint[];
  /** 경로 건물 (크레인 위치 건물·레이더 근접 건물 제외, 거리 재라벨 완료) */
  pathBuildings: BuildingOnPath[];
  chartMaxKm: number;
  /** 프로파일 샘플 간격 (m) — 각주 표기용 */
  sampleStepM: number;
  /** 레이더 주변 RADAR_NEAR_EXCLUDE_M 이내라 제외한 경로 건물 동수 */
  nearRadarExcluded: number;
  /** 크레인 위치 건물(footprint 포함 또는 CRANE_SELF_EXCLUDE_M 이내)로 제외한 동수 */
  selfExcluded: number;
  /** 마스트 거리에서의 음영고도 (MSL). 장애물 없음/실패 시 null */
  shadowAtMastM: number | null;
  /** 단면 분석 실패 메시지 (조용한 제외 금지 — 문서에 표기) */
  error?: string;
}

/** 크레인 1기 분석 */
export interface CraneAnalysis {
  crane: TowerCrane;
  /** 최상단 MSL = ground_elev + top_height */
  mastTopMslM: number;
  /** 지브 상단 MSL = ground_elev + jib_height + CRANE_JIB_TRUSS_H */
  jibTopMslM: number;
  facilities: CraneFacilityAnalysis[];
}

export interface CraneReviewResult {
  payload: CraneReviewPayload;
  cranes: CraneAnalysis[];
}

// ── 순수 산식 헬퍼 (분석·단면도 공용) ──────────────────────────────────

/** 지브 방위각 θ 를 레이더–마스트 단면(방위 az)에 투영했을 때의 반경 방향 오프셋 (km).
 *  Δ = θ − az; 지브 끝 = +L·cosΔ (양수 = 레이더에서 멀어지는 쪽), 카운터지브 끝 = −Lc·cosΔ. */
export function jibRadialOffsetsKm(
  crane: TowerCrane,
  azimuthDeg: number,
  jibDeg: number,
): { jibTipKm: number; counterTipKm: number } {
  const delta = ((jibDeg - azimuthDeg) * Math.PI) / 180;
  const c = Math.cos(delta);
  return {
    jibTipKm: (crane.jib_length * c) / 1000,
    counterTipKm: (-crane.counter_jib_length * c) / 1000,
  };
}

/** 거리 dKm 보다 앞(dKm − 0.03 km 미만)에 있는 지형 샘플·경로 건물 엣지의 4/3 프레임 running-max 앙각(slope 비율).
 *  장애물이 없으면 -Infinity. braReviewAnalysis analyzeFacility 의 maxAngle 산식과 동일. */
export function losMaxAngleUpTo(
  profile: CraneProfilePoint[],
  pathBuildings: BuildingOnPath[],
  hAntM: number,
  dKm: number,
): number {
  const limit = dKm - 0.03;
  let maxAngle = -Infinity;
  for (const p of profile) {
    if (!(p.distKm > 0 && p.distKm < limit)) continue;
    const a = (p.elevM - curvDrop43(p.distKm) - hAntM) / (p.distKm * 1000);
    if (a > maxAngle) maxAngle = a;
  }
  for (const b of pathBuildings) {
    const top = b.ground_elev_m + b.height_m;
    const nearD = b.near_dist_km ?? b.distance_km;
    const farD = b.far_dist_km ?? b.distance_km;
    for (const d of farD - nearD > 0.001 ? [nearD, farD] : [nearD]) {
      if (!(d > 0 && d < limit)) continue;
      const a = (top - curvDrop43(d) - hAntM) / (d * 1000);
      if (a > maxAngle) maxAngle = a;
    }
  }
  return maxAngle;
}

/** 거리 dKm 에서의 4/3 음영고도 (MSL). 앞쪽 장애물이 없으면 null. 지면 클램프는 호출측(지반고) 책임. */
export function shadowMslAt(
  profile: CraneProfilePoint[],
  pathBuildings: BuildingOnPath[],
  hAntM: number,
  dKm: number,
): number | null {
  const a = losMaxAngleUpTo(profile, pathBuildings, hAntM, dKm);
  if (a === -Infinity) return null;
  return hAntM + a * dKm * 1000 + curvDrop43(dKm);
}

/** 초과량 배열(길이 360)에서 >0 연속 구간을 시계방향으로 추출 (랩어라운드는 endDeg < startDeg 한 구간) */
export function penetratingRanges(exceedByDeg: number[]): CranePenetratingRange[] {
  const n = exceedByDeg.length;
  if (n === 0) return [];
  const pos = (i: number) => exceedByDeg[((i % n) + n) % n] > 0;
  if (exceedByDeg.every((v) => v > 0)) {
    let maxAt = 0;
    for (let i = 1; i < n; i++) if (exceedByDeg[i] > exceedByDeg[maxAt]) maxAt = i;
    return [{ startDeg: 0, endDeg: n - 1, maxExceedM: exceedByDeg[maxAt], maxAtDeg: maxAt }];
  }
  // 비침범 각도에서 시작해 한 바퀴 돌며 구간 수집 → 랩어라운드 구간이 자연히 한 덩어리가 된다
  let start0 = 0;
  while (pos(start0)) start0++;
  const out: CranePenetratingRange[] = [];
  let i = start0;
  const end = start0 + n;
  while (i < end) {
    if (!pos(i)) { i++; continue; }
    const s = i;
    let maxAt = i;
    while (i < end && pos(i)) {
      if (exceedByDeg[i % n] > exceedByDeg[maxAt % n]) maxAt = i;
      i++;
    }
    out.push({ startDeg: s % n, endDeg: (i - 1) % n, maxExceedM: exceedByDeg[maxAt % n], maxAtDeg: maxAt % n });
  }
  return out;
}
