/**
 * 전파영향성 검토 의견서 — 타입·산식 단일 원천 (순수 계산 + Tauri invoke 래퍼).
 *
 * ── 프레임 규약 (혼용 금지) ───────────────────────────────────────────────
 *  · BRA 제한고도(원추면) : **실제지구 기하**(R = 6,371 km, 4/3 미적용).
 *      src-tauri/src/bra.rs `cone_msl` · src/pages/TrackMap.tsx:6498-6500 드로어 BRA 산식과
 *      동일 정의(변경 금지) — coneMSL = h_ant + d·tanθ + d²/(2R).
 *  · LoS 음영(차폐)고도   : **4/3 유효지구**(R_eff = 4/3·R) 프레임의 running-max 앙각.
 *      src/components/Map/LoSProfilePanel.tsx:943-986 의 sim 산식을 그대로 이식
 *      (장애물 = 지형 전수 + 경로 건물 near/far 엣지, 자기 건물 15 m 이내 제외).
 *  · 단면도 표시 프레임   : **실제지구 디스플레이 프레임** — y(d, elevMSL) = elevMSL − curvDrop(d).
 *      LoSProfilePanel 차트와 동일. 4/3 레이는 h43 + curvDrop43(d) − curvDrop(d) 로 굽혀 표시한다.
 *
 * 폴백 금지(CLAUDE.md): 시설별 분석이 실패하면 조용히 제외하지 않고 `error` 를 남겨 문서에 명시한다.
 */
import { invoke } from "@tauri-apps/api/core";
import { haversineKm, bearingDeg } from "./geo";
import type { BuildingOnPath, NearbyPeak, RadarSite } from "../types";

// ── 상수 ────────────────────────────────────────────────────────────────
const DEG2RAD = Math.PI / 180;
/** 실제 지구 반경 (m) — BRA 원추면·디스플레이 프레임 곡률 */
export const R_EARTH_M = 6_371_000;
/** 4/3 유효지구 반경 (m) — ITU-R 표준대기 굴절 k=4/3, LoS 차폐 판정 프레임 */
export const R_EFF_M = (R_EARTH_M * 4) / 3;
/** 경로 건물 조회 코리도 폭 (m) — LoSProfilePanel 과 동일 */
const CORRIDOR_WIDTH_M = 100;
/** 대상 건물 자기참조 제외 반경 (m) — LoSProfilePanel.tsx:958 과 동일 */
const SELF_EXCLUDE_M = 15;
/** 레이더 주변 제외 반경 (m) — 안테나 근접 건물(레이더 자체 건물·부속동, 좌표 오차로 own-building 제외에 안 잡히는 경우 포함)은
 *  차폐 검토·단면도에서 제외한다(2026-08-27 사용자 지시). 제외 동수는 nearRadarExcluded 로 문서에 명시 */
export const RADAR_NEAR_EXCLUDE_M = 100;

/** 디스플레이(실제지구) 프레임 곡률 처짐량 (m) */
export function curvDrop(dKm: number): number {
  const dM = dKm * 1000;
  return (dM * dM) / (2 * R_EARTH_M);
}

/** 4/3 유효지구 프레임 곡률 처짐량 (m) */
export function curvDrop43(dKm: number): number {
  const dM = dKm * 1000;
  return (dM * dM) / (2 * R_EFF_M);
}

// ── 타입 ────────────────────────────────────────────────────────────────

export type BraReviewHeightSource = "measured" | "fac" | "manual" | "sim" | "vworld";
export type BraReviewGroundSource = "fac" | "manual" | "sim" | "srtm";

/** 검토 대상 구조물 입력 (TrackMap 건축물정보 드로어에서 해석) */
export interface BraReviewBuildingInput {
  name: string;
  roadAddr: string | null;
  jibunAddr: string | null;
  lat: number;
  lon: number;
  /** 구조물 높이 (AGL, m) — 0 이하/미상이면 의견서 생성 불가 */
  heightM: number;
  heightSource: BraReviewHeightSource;
  /** 지반고 (MSL, m). null 이면 분석 시 SRTM(fetch_elevation) 으로 채운다 */
  groundElevM: number | null;
  groundSource: BraReviewGroundSource;
  usage: string | null;
  structure: string | null;
  floorsAbove: string | null;
  floorsBelow: string | null;
  /** 대장 건축면적 (문자열, 단위 ㎡) */
  areaM2Registry: string | null;
  /** footprint 폴리곤 ENU 평면 shoelace 면적 (㎡). 폴리곤이 없으면 null */
  footprintAreaM2: number | null;
  pnu: string | null;
  bdMgtSn: string | null;
  /** "건물통합정보" | "수동 등록" | "VWorld" | "-" */
  sourceLabel: string;
}

/** 창 간 전달 페이로드 (IndexedDB 키 "brareview") */
export interface BraReviewPayload {
  version: 1;
  generatedAt: string;
  building: BraReviewBuildingInput;
  radarSites: RadarSite[];
  /** BRA 기준각 (°) — 스토어 braAngleDeg 공유 */
  braAngleDeg: number;
  /** 동일 대상 판별 키 — 재로드 시 이 값이 같으면 인라인 편집 override 를 유지 */
  buildingKey: string;
}

/** LoS 를 차단한 최상위 장애물 */
export interface BraReviewBlocker {
  kind: "building" | "terrain";
  name: string | null;
  distKm: number;
  topAmslM: number;
  lat: number;
  lon: number;
}

/** 시설별 LoS 음영 산출 결과 */
export interface BraReviewLos {
  /** 4/3 프레임 running-max 앙각 (rad, 장애물 없으면 -Infinity) */
  maxAngle: number;
  /** 대상 거리에서의 음영(차폐)고도 (MSL, m) */
  shadowAmslM: number;
  /** 음영고도까지의 허용높이 (AGL, m) */
  allowableAglM: number;
  /** 옥상고 − 음영고도. 양수 = 직접 가시(전파 영향 우려) */
  losExcessM: number;
  shielded: boolean;
  blocker: BraReviewBlocker | null;
}

/** 단면 프로파일 샘플 (SRTM 전수) */
export interface BraReviewProfilePoint {
  distKm: number;
  elevM: number;
  lat: number;
  lon: number;
}

export interface BraReviewFacility {
  site: RadarSite;
  /** 안테나 정점 표고 (MSL, m) = altitude + antenna_height */
  hAntM: number;
  distKm: number;
  azimuthDeg: number;
  /** BRA 제한고도 (MSL, m) — 실제지구 기하 */
  coneMslM: number;
  /** 옥상고 − 제한고도. 양수 = 초과 */
  braExcessM: number;
  braExceeded: boolean;
  /** 분석 실패 시 null (error 동반) */
  los: BraReviewLos | null;
  profile: BraReviewProfilePoint[];
  /** 대상 건물 제외, 거리 재라벨 완료 */
  pathBuildings: BuildingOnPath[];
  /** 대상 건물과 매칭된 경로 건물 (단면도 near/far 폭 표시용) */
  targetOnPath: BuildingOnPath | null;
  chartMaxKm: number;
  /** 프로파일 샘플 간격 (m) — 각주 표기용 */
  sampleStepM: number;
  /** 레이더 주변 RADAR_NEAR_EXCLUDE_M 이내라 검토에서 제외한 경로 건물 동수 */
  nearRadarExcluded: number;
  /** 분석 실패 메시지 (조용한 제외 금지) */
  error?: string;
}

export interface BraReviewResult {
  payload: BraReviewPayload;
  /** 확정 지반고 (MSL, m) — 입력값이 없으면 SRTM 조회분 */
  groundElevM: number;
  groundSource: BraReviewGroundSource;
  rooftopAmslM: number;
  facilities: BraReviewFacility[];
}

// ── 표기 라벨 ───────────────────────────────────────────────────────────

export const HEIGHT_SOURCE_LABEL: Record<BraReviewHeightSource, string> = {
  measured: "실측 3D (1m DSM)",
  fac: "건물통합정보(대장)",
  manual: "수동 등록",
  sim: "입력값",
  vworld: "VWorld",
};

export const GROUND_SOURCE_LABEL: Record<BraReviewGroundSource, string> = {
  fac: "건물통합정보(대장)",
  manual: "수동 등록",
  sim: "입력값",
  srtm: "SRTM",
};

// ── 포맷 유틸 ───────────────────────────────────────────────────────────

/** 천단위 콤마 + 고정 소수 자릿수. 비유한 값은 "-" */
export function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 도분초 표기 — 37° 29' 18.13" N (초는 소수 2자리) */
export function toDms(value: number, axis: "lat" | "lon"): string {
  const hemi = axis === "lat" ? (value >= 0 ? "N" : "S") : value >= 0 ? "E" : "W";
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = (minFloat - min) * 60;
  return `${deg}° ${min}' ${sec.toFixed(2)}" ${hemi}`;
}

/** ENU 평면 shoelace 면적 (㎡) — 링 [[lat,lon],...] */
export function ringAreaM2(ring: [number, number][]): number | null {
  if (!ring || ring.length < 3) return null;
  const lat0 = ring[0][0];
  const mPerDegLat = DEG2RAD * R_EARTH_M;
  const mPerDegLon = mPerDegLat * Math.cos(lat0 * DEG2RAD);
  let acc = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const ax = (a[1] - ring[0][1]) * mPerDegLon;
    const ay = (a[0] - lat0) * mPerDegLat;
    const bx = (b[1] - ring[0][1]) * mPerDegLon;
    const by = (b[0] - lat0) * mPerDegLat;
    acc += ax * by - bx * ay;
  }
  const area = Math.abs(acc) / 2;
  return Number.isFinite(area) && area > 0 ? area : null;
}

/** 점-in-폴리곤 (ray casting) — 링 [[lat,lon],...] */
function pointInRing(lat: number, lon: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0], xi = ring[i][1];
    const yj = ring[j][0], xj = ring[j][1];
    const hit = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-18) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

/** 선형 보간 좌표 (평면 등거리 — LoSProfilePanel.tsx:83-87 과 동일) */
function interpolate(lat1: number, lon1: number, lat2: number, lon2: number, t: number): [number, number] {
  return [lat1 + (lat2 - lat1) * t, lon1 + (lon2 - lon1) * t];
}

// ── 시설별 분석 ─────────────────────────────────────────────────────────

/** LoS 앙각 후보 장애물 (지형 샘플 / 경로 건물 엣지) */
interface ObstacleEntry {
  kind: "building" | "terrain";
  distKm: number;
  topAmslM: number;
  name: string | null;
  lat: number;
  lon: number;
}

/** 단면 코리도 수집 결과 — 의견서·타워크레인 검토 공용 */
export interface FacilityCorridor {
  /** 레이더 → 대상 수평거리 (km, haversine) */
  distKm: number;
  /** 레이더 → 대상 방위 (°) */
  azimuthDeg: number;
  /** 안테나 정점 표고 (MSL, m) */
  hAntM: number;
  /** 단면도 X 축 상한 (km) */
  chartMaxKm: number;
  /** 프로파일 샘플 간격 (m) */
  sampleStepM: number;
  /** SRTM 전수 프로파일 (레이더 → chartMaxKm) */
  profile: BraReviewProfilePoint[];
  /** 경로 건물 (대상 건물·레이더 근접 건물 제외, 거리 재라벨 완료) */
  pathBuildings: BuildingOnPath[];
  /** 대상 좌표와 매칭된 경로 건물 (여러 건이면 첫 건) */
  targetOnPath: BuildingOnPath | null;
  /** RADAR_NEAR_EXCLUDE_M 이내라 제외한 동수 */
  nearRadarExcluded: number;
  /** 대상 자기참조(selfExcludeM 이내 또는 footprint 포함)로 제외한 총 동수 */
  selfExcluded: number;
}

/** 단면 코리도의 기하 파라미터 — 거리·방위·차트 범위·샘플 수의 단일 원천.
 *  실패 경로(단면 분석 전 반환)와 정상 경로가 **같은 값**을 쓰도록 분리한다.
 *  타워크레인 검토(craneReviewAnalysis.ts)도 같은 값을 써야 해 export 한다. */
export function corridorGeometry(site: RadarSite, targetLat: number, targetLon: number) {
  const hAntM = site.altitude + site.antenna_height;
  const distKm = haversineKm(site.latitude, site.longitude, targetLat, targetLon);
  const azimuthDeg = bearingDeg(site.latitude, site.longitude, targetLat, targetLon);
  const chartMaxKm = Math.max(15, distKm * 1.15);
  // 전수 샘플(≈20 m 간격) — 다운샘플 금지(CLAUDE.md 규칙 7)
  const numSamples = Math.min(2000, Math.max(300, Math.round(chartMaxKm / 0.02)));
  const sampleStepM = (chartMaxKm * 1000) / numSamples;
  return { hAntM, distKm, azimuthDeg, chartMaxKm, numSamples, sampleStepM };
}

/**
 * 레이더 → 대상 방위선의 단면 코리도 수집 — SRTM 전수 프로파일 + 경로 건물(코리도 100 m)
 * 거리 재라벨 + 제외 규칙(레이더 근접 / 대상 자기참조).
 *
 * 의견서(`analyzeFacility`)와 타워크레인 검토(`craneReviewAnalysis.ts`)가 **같은 코리도**를 쓰도록
 * 분리했다 — 산식·제외 규칙을 바꾸면 양쪽이 함께 움직인다.
 * invoke 실패는 그대로 throw 한다(조용한 폴백 금지) — 호출측이 error 문구로 문서에 남긴다.
 */
export async function fetchFacilityCorridor(
  site: RadarSite,
  targetLat: number,
  targetLon: number,
  opts: { selfLat: number; selfLon: number; selfExcludeM: number },
): Promise<FacilityCorridor> {
  const { hAntM, distKm, azimuthDeg, chartMaxKm, numSamples, sampleStepM } =
    corridorGeometry(site, targetLat, targetLon);

  // 방위선을 chartMaxKm 까지 연장 — 평면(등거리) 투영 종점 (LoSProfilePanel.tsx:222-232 방식)
  const mPerDegLat = DEG2RAD * R_EARTH_M;
  const mPerDegLon = mPerDegLat * Math.cos(site.latitude * DEG2RAD);
  const dLatM = (targetLat - site.latitude) * mPerDegLat;
  const dLonM = (targetLon - site.longitude) * mPerDegLon;
  const dirLen = Math.hypot(dLatM, dLonM) || 1;
  const farM = chartMaxKm * 1000;
  const farLat = site.latitude + ((dLatM / dirLen) * farM) / mPerDegLat;
  const farLon = site.longitude + ((dLonM / dirLen) * farM) / mPerDegLon;

  const lats: number[] = [];
  const lons: number[] = [];
  for (let i = 0; i <= numSamples; i++) {
    const [la, lo] = interpolate(site.latitude, site.longitude, farLat, farLon, i / numSamples);
    lats.push(la);
    lons.push(lo);
  }
  const elevs = await invoke<number[]>("fetch_elevation", { latitudes: lats, longitudes: lons });
  const profile: BraReviewProfilePoint[] = [];
  for (let i = 0; i < lats.length; i++) {
    profile.push({
      distKm: haversineKm(site.latitude, site.longitude, lats[i], lons[i]),
      elevM: Math.max(0, elevs[i] ?? 0), // 음수 표고 0 클램프 (LoSProfilePanel 과 동일)
      lat: lats[i],
      lon: lons[i],
    });
  }

  // 경로상 건물 (코리도 100 m) — 백엔드 거리(평면 t×haversine)를 지형 축과 동일 프레임으로 재라벨
  let bldgs = await invoke<BuildingOnPath[]>("query_buildings_along_path", {
    radarLat: site.latitude,
    radarLon: site.longitude,
    targetLat: farLat,
    targetLon: farLon,
    corridorWidthM: CORRIDOR_WIDTH_M,
  });
  const totalHavKm = haversineKm(site.latitude, site.longitude, farLat, farLon);
  if (totalHavKm > 1e-6) {
    const toHav = (d: number): number => {
      const t = Math.min(1, Math.max(0, d / totalHavKm));
      const [hLat, hLon] = interpolate(site.latitude, site.longitude, farLat, farLon, t);
      return haversineKm(site.latitude, site.longitude, hLat, hLon);
    };
    bldgs = bldgs.map((b) => ({
      ...b,
      distance_km: toHav(b.distance_km),
      near_dist_km: b.near_dist_km != null ? toHav(b.near_dist_km) : b.near_dist_km,
      far_dist_km: b.far_dist_km != null ? toHav(b.far_dist_km) : b.far_dist_km,
    }));
  }

  // 대상 건물 분리 (자기참조 오염 방지) — selfExcludeM 이내 또는 footprint 포함.
  //   여러 건이 매칭되면 **첫 건만** targetOnPath 로 삼고 나머지도 경로 건물에서 뺀다(종전 규칙 유지).
  // 레이더 주변 RADAR_NEAR_EXCLUDE_M 이내 건물(centroid 또는 경로 near 엣지 기준)은 검토·단면도에서 제외
  let targetOnPath: BuildingOnPath | null = null;
  let nearRadarExcluded = 0;
  let selfExcluded = 0;
  const pathBuildings: BuildingOnPath[] = [];
  for (const b of bldgs) {
    const nearEdgeM = (b.near_dist_km ?? b.distance_km) * 1000;
    if (nearEdgeM < RADAR_NEAR_EXCLUDE_M || haversineKm(b.lat, b.lon, site.latitude, site.longitude) * 1000 < RADAR_NEAR_EXCLUDE_M) {
      nearRadarExcluded++;
      continue;
    }
    const isTarget =
      haversineKm(b.lat, b.lon, opts.selfLat, opts.selfLon) * 1000 < opts.selfExcludeM ||
      (b.polygon != null && b.polygon.length >= 3 && pointInRing(opts.selfLat, opts.selfLon, b.polygon));
    if (isTarget) {
      if (!targetOnPath) targetOnPath = b;
      selfExcluded++;
      continue;
    }
    pathBuildings.push(b);
  }

  return {
    distKm, azimuthDeg, hAntM, chartMaxKm, sampleStepM,
    profile, pathBuildings, targetOnPath, nearRadarExcluded, selfExcluded,
  };
}

async function analyzeFacility(
  site: RadarSite,
  bld: BraReviewBuildingInput,
  groundElevM: number,
  rooftopAmslM: number,
  braAngleDeg: number,
): Promise<BraReviewFacility> {
  const { hAntM, distKm, azimuthDeg, chartMaxKm, sampleStepM } =
    corridorGeometry(site, bld.lat, bld.lon);
  const dM = distKm * 1000;
  // BRA 제한고도 — 실제지구 기하(4/3 미적용). bra.rs cone_msl / TrackMap 드로어 6498-6500 동일 정의.
  const coneMslM = hAntM + dM * Math.tan(braAngleDeg * DEG2RAD) + (dM * dM) / (2 * R_EARTH_M);
  const braExcessM = rooftopAmslM - coneMslM;

  const base = {
    site, hAntM, distKm, azimuthDeg, coneMslM, braExcessM,
    braExceeded: braExcessM > 0, chartMaxKm, sampleStepM, nearRadarExcluded: 0,
  };
  const failed = (error: string): BraReviewFacility => ({
    ...base, los: null, profile: [], pathBuildings: [], targetOnPath: null, error,
  });

  if (!(distKm > 0.02)) {
    return failed("레이더와 구조물의 수평거리가 너무 가까워 단면 분석을 수행할 수 없습니다");
  }

  try {
    const { profile, pathBuildings, targetOnPath, nearRadarExcluded } = await fetchFacilityCorridor(
      site, bld.lat, bld.lon,
      { selfLat: bld.lat, selfLon: bld.lon, selfExcludeM: SELF_EXCLUDE_M },
    );

    // ── LoS 음영(차폐)고도 — 4/3 프레임 running-max 앙각 ──
    const obstacles: ObstacleEntry[] = [];
    for (const p of profile) {
      obstacles.push({ kind: "terrain", distKm: p.distKm, topAmslM: p.elevM, name: null, lat: p.lat, lon: p.lon });
    }
    for (const b of pathBuildings) {
      const top = b.ground_elev_m + b.height_m;
      const nearD = b.near_dist_km ?? b.distance_km;
      const farD = b.far_dist_km ?? b.distance_km;
      obstacles.push({ kind: "building", distKm: nearD, topAmslM: top, name: b.name, lat: b.lat, lon: b.lon });
      if (farD - nearD > 0.001) {
        obstacles.push({ kind: "building", distKm: farD, topAmslM: top, name: b.name, lat: b.lat, lon: b.lon });
      }
    }
    let maxAngle = -Infinity;
    let blockerRaw: ObstacleEntry | null = null;
    for (const ob of obstacles) {
      if (!(ob.distKm > 0 && ob.distKm < distKm - 0.03)) continue;
      const angle = (ob.topAmslM - curvDrop43(ob.distKm) - hAntM) / (ob.distKm * 1000);
      if (angle > maxAngle) {
        maxAngle = angle;
        blockerRaw = ob;
      }
    }
    const rayTopAmslM = maxAngle === -Infinity ? -Infinity : hAntM + maxAngle * dM + curvDrop43(distKm);
    // 지면 클램프 — 지면이 이미 보이면 음영고도 = 지반고 (LoSProfilePanel.tsx:981 과 동일)
    const shadowAmslM = Math.max(rayTopAmslM, groundElevM);
    const allowableAglM = shadowAmslM - groundElevM;
    const losExcessM = rooftopAmslM - shadowAmslM;

    let blocker: BraReviewBlocker | null = null;
    if (blockerRaw && maxAngle !== -Infinity) {
      let name = blockerRaw.name;
      if (blockerRaw.kind === "terrain") {
        // 산 이름은 오프라인 peak DB (N3P). 없으면 null → 문서에서 "지형(능선)" 으로 표기
        try {
          const peaks = await invoke<NearbyPeak[]>("query_nearby_peaks", {
            lat: blockerRaw.lat, lon: blockerRaw.lon, radiusKm: 1.5,
          });
          name = peaks[0]?.name ?? null;
        } catch {
          name = null;
        }
      }
      blocker = {
        kind: blockerRaw.kind, name,
        distKm: blockerRaw.distKm, topAmslM: blockerRaw.topAmslM,
        lat: blockerRaw.lat, lon: blockerRaw.lon,
      };
    }

    return {
      ...base,
      los: { maxAngle, shadowAmslM, allowableAglM, losExcessM, shielded: losExcessM <= 0, blocker },
      profile,
      pathBuildings,
      targetOnPath,
      nearRadarExcluded,
    };
  } catch (e) {
    return failed(`단면 분석 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── 진입점 ──────────────────────────────────────────────────────────────

/** 페이로드 → 전 시설 분석 결과. 시설별 실패는 error 로 남기고 제외하지 않는다. */
export async function analyzeBraReview(payload: BraReviewPayload): Promise<BraReviewResult> {
  const bld = payload.building;
  let groundElevM = bld.groundElevM;
  let groundSource: BraReviewGroundSource = bld.groundSource;
  if (groundElevM == null) {
    // GIS 건물 지반 규약(centroid live SRTM) — 폴백이 아니라 규약 경로. 출처는 "SRTM" 으로 표기한다.
    const elevs = await invoke<number[]>("fetch_elevation", { latitudes: [bld.lat], longitudes: [bld.lon] });
    const v = elevs[0];
    if (v == null || !Number.isFinite(v)) throw new Error("지반고(SRTM) 조회에 실패했습니다");
    groundElevM = Math.max(0, v);
    groundSource = "srtm";
  }
  const rooftopAmslM = groundElevM + bld.heightM;
  const ground = groundElevM;
  const facilities = await Promise.all(
    payload.radarSites.map((site) => analyzeFacility(site, bld, ground, rooftopAmslM, payload.braAngleDeg)),
  );
  return { payload, groundElevM: ground, groundSource, rooftopAmslM, facilities };
}
