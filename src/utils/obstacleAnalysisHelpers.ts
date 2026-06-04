/**
 * 장애물 분석 공유 헬퍼 — LoS 배치, 방위 구간 계산
 * ObstacleMonthlyConfigModal / ObstaclePreScreeningModal에서 사용.
 */
import { invoke } from "@tauri-apps/api/core";
import type { RadarSite, ManualBuilding, LoSProfileData, AzSector, BuildingOnPath, PanoramaMergeResult } from "../types";
import type { LossPointGeo } from "../types/obstacle";
import { haversineKm, bearingDeg } from "./geo";

/** OM 보고서 LoS 단면도 차트 최소 X축 (km) — 빌딩이 가까워도 이만큼은 terrain 을 샘플링.
 *  100NM = 100 * 1.852 km. ReportOMLosCrossSection 의 X 풀 스케일과 일치. */
const EXTEND_PROFILE_MIN_KM = 100 * 1.852;

/** LoS 분석 — 4개씩 병렬 배치 실행 */
export async function computeLosBatch(
  jobs: { radar: RadarSite; bldg: ManualBuilding }[],
  prefix: string,
  _total: number,
  onProgress?: (done: number) => void,
): Promise<Map<string, LoSProfileData>> {
  const losMap = new Map<string, LoSProfileData>();
  const BATCH_SIZE = 4;
  let done = 0;

  for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
    const batch = jobs.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(async ({ radar, bldg }) => {
      try {
        const radarHeight = radar.altitude + radar.antenna_height;
        const totalDist = Math.sqrt(
          ((bldg.latitude - radar.latitude) * 111320) ** 2 +
          ((bldg.longitude - radar.longitude) * 111320 * Math.cos(radar.latitude * Math.PI / 180)) ** 2,
        ) / 1000;
        // Terrain sampling 종료 거리: 빌딩 거리와 EXTEND_PROFILE_MIN_KM 중 큰 값.
        //   빌딩이 가까워도 보고서 차트가 100NM 까지 길게 보이도록 — TrackMap 의 동작과 일관.
        const profileEndKm = Math.max(totalDist, EXTEND_PROFILE_MIN_KM);
        // 샘플 밀도: 빌딩까지 최소 150샘플 유지하되, 가까운 빌딩에서 폭주하지 않게 500 으로 상한.
        //   100NM/500 = 370m 간격 → 차트 가시성 충분, fetch_elevation 1회 호출 부담 합리.
        const samples = Math.min(500, Math.max(150, Math.round(150 * (profileEndKm / Math.max(totalDist, 1e-6)))));
        // 빌딩 거리에 해당하는 샘플 인덱스 (블록 판정 루프 종료점)
        const samplesToBuilding = Math.round((totalDist / profileEndKm) * samples);
        // 방향 단위 벡터 (위/경도 변화량 per km) — 빌딩 너머도 같은 베어링 직선상으로 외삽
        const dLatPerKm = totalDist > 1e-6 ? (bldg.latitude - radar.latitude) / totalDist : 0;
        const dLonPerKm = totalDist > 1e-6 ? (bldg.longitude - radar.longitude) / totalDist : 0;
        const lats: number[] = [];
        const lons: number[] = [];
        for (let j = 0; j <= samples; j++) {
          const d = (j / samples) * profileEndKm;
          lats.push(radar.latitude + dLatPerKm * d);
          lons.push(radar.longitude + dLonPerKm * d);
        }
        const [elevations, pathBuildings] = await Promise.all([
          invoke<number[]>("fetch_elevation", { latitudes: lats, longitudes: lons }),
          invoke<BuildingOnPath[]>(
            "query_buildings_along_path",
            { radarLat: radar.latitude, radarLon: radar.longitude, targetLat: bldg.latitude, targetLon: bldg.longitude, corridorWidthM: 200 },
          ),
        ]);

        const combinedElev = [...elevations];
        for (const pb of pathBuildings) {
          // 빌딩 거리(0~totalDist)를 확장 profile 인덱스(0~samples)로 변환
          const sampleIdx = Math.round((pb.distance_km / profileEndKm) * samples);
          if (sampleIdx >= 0 && sampleIdx < combinedElev.length) {
            const bldgTop = pb.ground_elev_m + pb.height_m;
            if (bldgTop > combinedElev[sampleIdx]) combinedElev[sampleIdx] = bldgTop;
          }
        }

        // 차단 판정: 빌딩 거리까지의 terrain 만 봄 (빌딩 너머 지형은 빌딩 가시성에 무관).
        let blocked = false;
        let maxBlockDist = 0, maxBlockElev = -Infinity, maxBlockName = "";
        const R = 6371000;
        const Reff = R * 4 / 3;
        const targetElev = bldg.ground_elev + bldg.height;
        for (let k = 1; k <= samplesToBuilding && k < combinedElev.length; k++) {
          const d = (k / samples) * profileEndKm * 1000;
          const t = samplesToBuilding > 0 ? k / samplesToBuilding : 0; // radar↔building 보간 (0~1)
          const losHeight = radarHeight * (1 - t) + targetElev * t;
          const curvDrop = (d * d) / (2 * Reff);
          const terrainAdjusted = combinedElev[k] + curvDrop;
          if (terrainAdjusted > losHeight) {
            blocked = true;
            if (terrainAdjusted > maxBlockElev) {
              maxBlockElev = terrainAdjusted;
              maxBlockDist = (k / samples) * profileEndKm;
              const nearBldg = pathBuildings.find((pb) => Math.abs(pb.distance_km - maxBlockDist) < 0.5);
              maxBlockName = nearBldg?.name ?? nearBldg?.address ?? "";
            }
          }
        }
        if (maxBlockElev === -Infinity) blocked = false;

        const bearing = ((Math.atan2(
          (bldg.longitude - radar.longitude) * Math.cos(radar.latitude * Math.PI / 180),
          bldg.latitude - radar.latitude,
        ) * 180) / Math.PI + 360) % 360;

        const elevProfile = combinedElev.map((elev, idx) => ({
          distance: (idx / samples) * profileEndKm,
          elevation: elev,
          latitude: lats[idx],
          longitude: lons[idx],
        }));
        // 순수 지형 프로파일 (건물 병합 전 raw SRTM) — 단면도 '분석 대상 제외' 선 계산용
        const terrainProf = elevations.map((elev, idx) => ({
          distance: (idx / samples) * profileEndKm,
          elevation: elev,
          latitude: lats[idx],
          longitude: lons[idx],
        }));
        const key = `${radar.name}_${bldg.id}`;
        const data: LoSProfileData = {
          id: `${prefix}_${radar.name}_${bldg.id}`,
          radarSiteName: radar.name,
          radarLat: radar.latitude,
          radarLon: radar.longitude,
          radarHeight,
          targetLat: bldg.latitude,
          targetLon: bldg.longitude,
          bearing,
          totalDistance: totalDist,
          elevationProfile: elevProfile,
          terrainProfile: terrainProf,
          pathBuildings,
          losBlocked: blocked,
          maxBlockingPoint: blocked ? { distance: maxBlockDist, elevation: maxBlockElev, name: maxBlockName } : undefined,
          timestamp: Date.now(),
        };
        return { key, data };
      } catch (err) {
        console.warn(`LoS 계산 실패: ${radar.name}→${bldg.name}:`, err);
        return null;
      }
    }));
    for (const r of results) {
      if (r) losMap.set(r.key, r.data);
    }
    done += batch.length;
    onProgress?.(done);
  }
  return losMap;
}

/** 건물 도형의 레이더 방향 노출면 방위 구간 계산 */
export function calcBuildingAzExtent(
  radarLat: number, radarLon: number,
  building: ManualBuilding,
): AzSector {
  const toRad = Math.PI / 180;
  const bearingTo = (lat2: number, lon2: number) => {
    const y = Math.sin((lon2 - radarLon) * toRad) * Math.cos(lat2 * toRad);
    const x = Math.cos(radarLat * toRad) * Math.sin(lat2 * toRad) -
      Math.sin(radarLat * toRad) * Math.cos(lat2 * toRad) * Math.cos((lon2 - radarLon) * toRad);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  };

  const geo = building.geometry_json ? JSON.parse(building.geometry_json) : null;
  const bearings: number[] = [bearingTo(building.latitude, building.longitude)];

  if (building.geometry_type === "polygon" && geo && Array.isArray(geo)) {
    for (const pt of geo) {
      if (Array.isArray(pt) && pt.length === 2) {
        bearings.push(bearingTo(pt[0], pt[1]));
      }
    }
  } else if (building.geometry_type === "multi" && geo && Array.isArray(geo)) {
    for (const sub of geo) {
      const subType = sub.type;
      const subJson = sub.json;
      if (!subType || !subJson) continue;
      const subBuilding = { ...building, geometry_type: subType, geometry_json: subJson };
      const subResult = calcBuildingAzExtent(radarLat, radarLon, subBuilding);
      bearings.push(subResult.start_deg, subResult.end_deg);
    }
  }

  if (bearings.length <= 1) {
    const az = bearings[0];
    return { start_deg: (az - 2 + 360) % 360, end_deg: (az + 2) % 360 };
  }

  bearings.sort((a, b) => a - b);
  let maxGap = 0, gapStart = 0;
  for (let i = 0; i < bearings.length; i++) {
    const next = (i + 1) % bearings.length;
    const gap = next === 0 ? (360 - bearings[i] + bearings[0]) : (bearings[next] - bearings[i]);
    if (gap > maxGap) { maxGap = gap; gapStart = i; }
  }
  const start = bearings[(gapStart + 1) % bearings.length];
  const end = bearings[gapStart];
  return { start_deg: start, end_deg: end };
}

/** 방위 구간 병합 — 360°/0° 래핑 처리 */
export function mergeAzSectors(sectors: AzSector[]): AzSector[] {
  if (sectors.length <= 1) return sectors;

  // 래핑 구간(start > end)을 두 개로 분리: [start, 360), [0, end]
  const linear: { s: number; e: number }[] = [];
  for (const sec of sectors) {
    if (sec.start_deg > sec.end_deg) {
      linear.push({ s: sec.start_deg, e: 360 });
      linear.push({ s: 0, e: sec.end_deg });
    } else {
      linear.push({ s: sec.start_deg, e: sec.end_deg });
    }
  }
  linear.sort((a, b) => a.s - b.s);

  // 선형 병합
  const merged: { s: number; e: number }[] = [{ ...linear[0] }];
  for (let i = 1; i < linear.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = linear[i];
    if (curr.s <= prev.e + 2) {
      prev.e = Math.max(prev.e, curr.e);
    } else {
      merged.push({ ...curr });
    }
  }

  // 첫/끝 구간이 0°에서 이어지면 재합치기 → 래핑 구간 복원
  if (merged.length >= 2) {
    const first = merged[0];
    const last = merged[merged.length - 1];
    if (first.s <= 0 + 2 && last.e >= 360 - 2) {
      last.e = first.e;       // last.s ~ first.e (래핑)
      merged.shift();
    }
  }

  return merged.map((m) => ({
    start_deg: m.s >= 360 ? m.s - 360 : m.s,
    end_deg: m.e >= 360 ? m.e - 360 : m.e,
  }));
}

// ─── 장애물 음영 표적소실 분류 ─────────────────────────────────────────────
// ReportOMObstacleAzElevChart 와 ReportOMSummarySection 이 공유하는 단일 소스.
//   inShadow:       소실표적 양각 < with 차단각(지형+기존지물+분석대상)  → 통합 음영구역 내
//   buildingCaused: inShadow && 양각 ≥ without 차단각(분석대상 제외)      → 분석 대상 건물 추가분에 의해서만 차단
// with/without 두 프로파일의 유일한 차이 = 분석 대상 건물 → [without, with] 밴드 = '대상 추가 차단'.
//   이는 panorama 빨강영역(panoWith−panoWithout)과 동일 정의 → 차트의 빨강 영역과 검은× 점이 by-construction 일치.
// 차단각 조회 방식은 두 경로가 다름:
//   • option B(panorama 제공): 방위별 silhouette max(전 거리, 실제지구) → 차트와 동일 소스라 픽셀 일치.
//     파노라마는 거리축이 없어 max-over-distance 가 본질 — 표적 너머 지형도 silhouette 에 포함되나,
//     buildingCount(=with−without 차분)는 공통 원거리 장애물이 상쇄돼 거리 오염 없음.
//   • option A(panorama 없음, 복원/요약 폴백): 각 표적 '자기 거리까지'의 prefix-max(4/3) → 표적 너머 지형 차폐 오판 제거.

const R_EARTH_M_LOSS = 6_371_000;
/** 4/3 유효지구반경 — 표준 대기 굴절(k=4/3). LoS 단면도(curvDrop43)·computeLosBatch·도메인 표준과 통일.
 *  (실제지구 곡률 사용 시 단면도 '정답' 차단 판정과 경계 케이스 불일치 → 4/3 으로 일원화) */
const R_EFF_M_LOSS = (R_EARTH_M_LOSS * 4) / 3;
const FT_PER_M_LOSS = 3.28084;
const AZ_TOLERANCE_DEG = 10;

/** classifyObstacleLosses 의 sibling(같은 레이더의 다른 분석 대상) — 방위·거리·id 로 오귀속 타이브레이크(전순서). */
export interface SiblingBuilding {
  id: number;
  azDeg: number;
  distKm: number;
}

export interface ClassifiedLoss {
  azDeg: number;
  elevAngleDeg: number;
  durationS: number;
  inShadow: boolean;
  buildingCaused: boolean;
}

/**
 * LoS 경로 건물 중 분석 대상 manual 건물 식별 — 단면도(ReportOMLosCrossSection)와 분류가 공유하는 단일 규칙.
 * is_manual + 치수(지반표고·높이) 일치 + 코리도 끝(타겟 거리)까지 도달.
 * point 형 대상은 Rust 가 pathBuildings 에서 이미 제외 → 매칭 0 건이면 without=with(효과 0, 단면도와 동일 한계).
 */
export function isTargetBuildingOnPath(
  b: BuildingOnPath, building: ManualBuilding, totalDistKm: number,
): boolean {
  return b.is_manual
    && Math.abs(b.ground_elev_m - (building.ground_elev ?? 0)) < 1
    && Math.abs(b.height_m - building.height) < 1
    && (b.far_dist_km ?? b.distance_km) >= totalDistKm - 0.5;
}

/** terrain 프로파일에 건물 윗변(지반+높이)을 거리별 max 로 병합한 새 프로파일.
 *  computeLosBatch 의 combinedElev 구성과 동일 — 건물의 near~far 구간 샘플에 max. */
function mergeBuildingsIntoProfile(
  terrain: { distance: number; elevation: number }[],
  buildings: BuildingOnPath[],
): { distance: number; elevation: number }[] {
  const prof = terrain.map((p) => ({ distance: p.distance, elevation: p.elevation }));
  if (prof.length < 2) return prof;
  const d0 = prof[0].distance;
  const step = prof[1].distance - prof[0].distance;
  if (step <= 0) return prof;
  for (const b of buildings) {
    const top = b.ground_elev_m + b.height_m;
    const near = b.near_dist_km ?? b.distance_km;
    const far = b.far_dist_km ?? b.distance_km;
    const loIdx = Math.max(0, Math.round((near - d0) / step));
    const hiIdx = Math.min(prof.length - 1, Math.round((far - d0) / step));
    for (let i = loIdx; i <= hiIdx; i++) {
      if (top > prof[i].elevation) prof[i].elevation = top;
    }
  }
  return prof;
}

/** 거리별 누적 최대 차단각(°) — 4/3 유효지구 곡률 보정 후 running max.
 *  distance 오름차순 프로파일 → prefix max 라 표적별 거리 cutoff 를 angleAtDist 로 O(log n) 조회. */
function prefixMaxAngleDeg(
  profile: { distance: number; elevation: number }[],
  radarHeight: number,
): { dist: number; maxDeg: number }[] {
  const out: { dist: number; maxDeg: number }[] = [];
  let run = -Infinity;
  for (const pt of profile) {
    if (pt.distance > 0) {
      const dM = pt.distance * 1000;
      const adjH = pt.elevation - (dM * dM) / (2 * R_EFF_M_LOSS);
      const angle = (adjH - radarHeight) / dM;
      if (angle > run) run = angle;
    }
    out.push({ dist: pt.distance, maxDeg: run === -Infinity ? 0 : (Math.atan(run) * 180) / Math.PI });
  }
  return out;
}

/** prefix-max 차단각 배열에서 distKm 까지의 누적 최대각(°) — 마지막 dist ≤ distKm 항목. */
function angleAtDist(prefix: { dist: number; maxDeg: number }[], distKm: number): number {
  if (prefix.length === 0 || prefix[0].dist > distKm) return 0;
  let lo = 0, hi = prefix.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (prefix[mid].dist <= distKm) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return prefix[ans].maxDeg;
}

/** 소실표적 양각(°) — 곡률 보정 후. earthRadiusM 으로 프레임 선택(4/3 유효지구 기본, panorama 경로는 실제지구). */
function lossElevAngleDeg(radarH: number, targetAltM: number, distM: number, earthRadiusM = R_EFF_M_LOSS): number {
  if (distM <= 0) return 0;
  const curvDrop = (distM * distM) / (2 * earthRadiusM);
  return (Math.atan((targetAltM - curvDrop - radarH) / distM) * 180) / Math.PI;
}

/** 절대 방위차 (−180, 180] — x 를 기준 c 에 대한 상대각으로 */
function relAngleDeg(x: number, c: number): number {
  return ((x - c + 540) % 360) - 180;
}

/**
 * panorama terrain(방위→차단 양각°, 실제지구) 전역 360° 원형 보간 샘플러.
 * makePanoramaSampler(분류)와 buildSilhouetteLines(차트)가 공유 → terrain 차단각이 두 곳에서 동일.
 *   (윈도우 필터/경계 클램프로 인한 검은×↔빨강영역 불일치 제거 — 양끝은 래핑 보간)
 */
export function makeTerrainSampler(terrain: PanoramaMergeResult["terrain"]): (azDeg: number) => number {
  const terr = (terrain ?? [])
    .map((p) => ({ az: ((p.azimuth_deg % 360) + 360) % 360, el: Math.max(0, p.elevation_angle_deg) }))
    .sort((a, b) => a.az - b.az);
  const T = terr.length;
  return (azDeg: number): number => {
    if (T === 0) return 0;
    if (T === 1) return terr[0].el;
    const a = ((azDeg % 360) + 360) % 360;
    if (a <= terr[0].az || a >= terr[T - 1].az) {
      const a0 = terr[T - 1].az, a1 = terr[0].az + 360;
      const aa = a <= terr[0].az ? a + 360 : a;
      const t = a1 > a0 ? Math.min(1, Math.max(0, (aa - a0) / (a1 - a0))) : 0;
      return terr[T - 1].el + (terr[0].el - terr[T - 1].el) * t;
    }
    let lo = 0, hi = T - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (terr[mid].az <= a) lo = mid; else hi = mid;
    }
    const s = terr[hi].az - terr[lo].az;
    const t = s > 1e-9 ? (a - terr[lo].az) / s : 0;
    return terr[lo].el + (terr[hi].el - terr[lo].el) * t;
  };
}

/**
 * panorama(지형+건물)의 방위별 차단 양각(°, 실제지구) 샘플러.
 * ReportOMObstacleAzElevChart 의 buildSilhouetteLines 와 동일 의미 — terrain 보간 + 건물 실루엣/밴드 max.
 * 빨강영역(panoWith−panoWithout)과 검은× 점 분류를 같은 소스·같은 프레임으로 산출 → 픽셀 단위 일치.
 */
function makePanoramaSampler(pano: PanoramaMergeResult): (azDeg: number) => number {
  const terrainAt = makeTerrainSampler(pano.terrain);

  type Prep =
    | { kind: "sil"; center: number; rels: number[]; els: number[]; rMin: number; rMax: number }
    | { kind: "band"; center: number; lo: number; hi: number; el: number };
  const preps: Prep[] = [];
  for (const b of pano.buildings ?? []) {
    const span = (((b.azimuth_end_deg - b.azimuth_start_deg) % 360) + 360) % 360;
    const center = (((b.azimuth_start_deg + span / 2) % 360) + 360) % 360;
    if (b.silhouette && b.silhouette.length >= 2) {
      const pts = b.silhouette
        .map(([az, el]) => ({ r: relAngleDeg(az, center), el: Math.max(0, el) }))
        .sort((a, c) => a.r - c.r);
      preps.push({
        kind: "sil", center,
        rels: pts.map((p) => p.r), els: pts.map((p) => p.el),
        rMin: pts[0].r, rMax: pts[pts.length - 1].r,
      });
    } else {
      // 차트 prep() 과 동일: rs≤re 정규화 후 점 건물(폭<1e-6)에만 ±0.05° 밴드 부여.
      // (유한폭 건물에 ±0.05° 마진을 주면 샘플러가 차트보다 넓게 차폐 → 검은×↔빨강영역 픽셀 불일치)
      let rs = relAngleDeg(b.azimuth_start_deg, center);
      let re = relAngleDeg(b.azimuth_end_deg, center);
      if (rs > re) { const t = rs; rs = re; re = t; }
      if (Math.abs(re - rs) < 1e-6) { rs -= 0.05; re += 0.05; } // 점 건물 → 미세 밴드
      preps.push({ kind: "band", center, lo: rs, hi: re, el: Math.max(0, b.elevation_angle_deg) });
    }
  }

  const interpSil = (rels: number[], els: number[], r: number): number => {
    const m = rels.length;
    if (r <= rels[0]) return els[0];
    if (r >= rels[m - 1]) return els[m - 1];
    let lo = 0, hi = m - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (rels[mid] <= r) lo = mid; else hi = mid;
    }
    const s = rels[hi] - rels[lo];
    const t = s > 1e-9 ? (r - rels[lo]) / s : 0;
    return els[lo] + (els[hi] - els[lo]) * t;
  };

  return (azDeg: number): number => {
    const a = ((azDeg % 360) + 360) % 360;
    let m = terrainAt(a);
    for (const pb of preps) {
      const r = relAngleDeg(a, pb.center);
      if (pb.kind === "band") {
        if (r >= pb.lo && r <= pb.hi && pb.el > m) m = pb.el;
      } else if (r >= pb.rMin - 1e-9 && r <= pb.rMax + 1e-9) {
        const v = interpSil(pb.rels, pb.els, r);
        if (v > m) m = v;
      }
    }
    return m;
  };
}

/**
 * (레이더 × 분석 대상 장애물) 의 LoS 차단각 대비 후방 소실표적 분류.
 * 방위 윈도우(±10°) + 대상 후방(거리 > bDistKm) 소실표적만 채택.
 * @returns 차단각(°) + 분류된 소실 배열 + 집계(음영/장애물기인 건수, 장애물기인 소실시간)
 */
export function classifyObstacleLosses(
  radar: RadarSite,
  building: ManualBuilding,
  los: LoSProfileData,
  lossPoints: LossPointGeo[],
  opts?: {
    /** 차트 빨강영역과 픽셀 일치용 — 제공 시 차단각을 panorama(실제지구)에서 방위별 샘플(option B). 없으면 LoS 프로파일 4/3(option A). */
    panoWith?: PanoramaMergeResult;
    panoWithout?: PanoramaMergeResult;
    /** 같은 레이더의 '다른' 분석 대상 건물(방위°+거리km) — 소실표적을 더 강하게 소유하는 건물이 있으면 본 건물 집계서 제외(오귀속 방지).
     *  소유 우선순위: 방위 근접 > 거리 근접 > 작은 방위값 (정확히 한 건물만 카운트 — 같은 방위 중복 방지). */
    siblings?: SiblingBuilding[];
  },
): {
  bDistKm: number;
  bAzDeg: number;
  angleTotalDeg: number;
  angleTerrainDeg: number;
  losses: ClassifiedLoss[];
  shadowCount: number;
  buildingCount: number;
  buildingDurationS: number;
} {
  const radarH = radar.altitude + radar.antenna_height;
  const bDistKm = los.totalDistance > 0
    ? los.totalDistance
    : haversineKm(radar.latitude, radar.longitude, building.latitude, building.longitude);
  const bAzDeg = los.bearing ?? bearingDeg(radar.latitude, radar.longitude, building.latitude, building.longitude);

  // 차단각 산출 — with(지형+기존지물+분석대상) / without(분석대상 제외)의 차이가 곧 '대상 추가 차단'.
  //  (B) panorama 제공 → 빨강영역(panoWith−panoWithout)과 동일 소스·동일 프레임(실제지구)으로 방위별 샘플 → 픽셀 일치.
  //  (A) panorama 없음(복원/요약 폴백) → LoS 프로파일 with/without, 표적별 거리 cutoff, 4/3 유효지구.
  const pW = opts?.panoWith;
  const pWo = opts?.panoWithout;
  const usePano = !!(pW && pWo);
  const earthR = usePano ? R_EARTH_M_LOSS : R_EFF_M_LOSS;

  // angleWithAt/angleWithoutAt(방위°, 거리km) — option B 는 방위 의존, option A 는 거리 의존(표적별 cutoff).
  let angleWithAt: (azDeg: number, distKm: number) => number;
  let angleWithoutAt: (azDeg: number, distKm: number) => number;
  if (usePano) {
    const sW = makePanoramaSampler(pW!);
    const sWo = makePanoramaSampler(pWo!);
    angleWithAt = (az) => sW(az);
    angleWithoutAt = (az) => sWo(az);
  } else {
    const terrain = los.terrainProfile && los.terrainProfile.length > 0 ? los.terrainProfile : null;
    const pathB = los.pathBuildings ?? [];
    let withPrefix: { dist: number; maxDeg: number }[];
    let withoutPrefix: { dist: number; maxDeg: number }[];
    if (terrain) {
      withPrefix = prefixMaxAngleDeg(mergeBuildingsIntoProfile(terrain, pathB), radarH);
      withoutPrefix = prefixMaxAngleDeg(
        mergeBuildingsIntoProfile(terrain, pathB.filter((b) => !isTargetBuildingOnPath(b, building, bDistKm))),
        radarH,
      );
    } else if (los.elevationProfile.length > 0) {
      // terrainProfile 없는 복원 los — with 만 산출, without=with (대상 효과 0, 보수적: buildingCaused 0)
      withPrefix = prefixMaxAngleDeg(los.elevationProfile, radarH);
      withoutPrefix = withPrefix;
    } else {
      // 프로파일 전무 — 건물 단일점 각도로 with, without=with (보수적)
      const bTopM = (building.ground_elev ?? 0) + building.height;
      withPrefix = prefixMaxAngleDeg([{ distance: bDistKm, elevation: bTopM }], radarH);
      withoutPrefix = withPrefix;
    }
    angleWithAt = (_az, dist) => angleAtDist(withPrefix, dist);
    angleWithoutAt = (_az, dist) => angleAtDist(withoutPrefix, dist);
  }

  // 표 표시용 대표 차단각 — angleTotalDeg=with(대상 차단각), angleTerrainDeg=without(지형+기존). 대상 방위·건물 거리 기준.
  const angleTotalDeg = angleWithAt(bAzDeg, bDistKm);
  const angleTerrainDeg = angleWithoutAt(bAzDeg, bDistKm);

  const siblings = opts?.siblings ?? [];
  // sibling 오귀속 비교용 자기 방위 — 호출부가 sibling 을 bearingDeg 로 계산하므로 동일 기준 사용(비대칭 제거).
  const selfAzForSibling = bearingDeg(radar.latitude, radar.longitude, building.latitude, building.longitude);
  const losses: ClassifiedLoss[] = [];
  for (const lp of lossPoints) {
    const lpDistKm = haversineKm(radar.latitude, radar.longitude, lp.lat, lp.lon);
    const lpAz = bearingDeg(radar.latitude, radar.longitude, lp.lat, lp.lon);
    let azDiff = Math.abs(lpAz - bAzDeg);
    if (azDiff > 180) azDiff = 360 - azDiff;
    if (azDiff > AZ_TOLERANCE_DEG) continue;
    if (lpDistKm <= bDistKm + 0.01) continue;
    // 오귀속 방지(#4): '다른' 분석 대상이 이 소실표적을 더 강하게 소유하면 본 건물 집계서 제외.
    //   결정론적 전순서 — 방위 근접 > 거리 근접 > 작은 방위값 > 작은 id → 정확히 한 건물만 카운트.
    //   (같은 위치 중복 건물 등 완전동률도 id 로 단독 소유 결정 → 중복 카운트 원천 차단)
    let azDiffSelf = Math.abs(lpAz - selfAzForSibling);
    if (azDiffSelf > 180) azDiffSelf = 360 - azDiffSelf;
    let ownedByOther = false;
    for (const s of siblings) {
      let sd = Math.abs(lpAz - s.azDeg);
      if (sd > 180) sd = 360 - sd;
      const tieAz = Math.abs(sd - azDiffSelf) <= 1e-9;
      const tieDist = Math.abs(s.distKm - bDistKm) <= 1e-9;
      const tieAzDeg = Math.abs(s.azDeg - selfAzForSibling) <= 1e-9;
      if (sd < azDiffSelf - 1e-9                                      // 방위 근접
        || (tieAz && s.distKm < bDistKm - 1e-9)                       // 동률 → 거리 근접
        || (tieAz && tieDist && s.azDeg < selfAzForSibling - 1e-9)    // +동률 → 작은 방위값
        || (tieAz && tieDist && tieAzDeg && s.id < building.id)) {    // +완전동률(동일 위치) → 작은 id (fail-safe)
        ownedByOther = true;
        break;
      }
    }
    if (ownedByOther) continue;

    const lpAltM = lp.alt_ft / FT_PER_M_LOSS;
    const lpElevDeg = lossElevAngleDeg(radarH, lpAltM, lpDistKm * 1000, earthR);
    const angleWith = angleWithAt(lpAz, lpDistKm);               // 표적 방위/거리 with 차단각
    const angleWithout = angleWithoutAt(lpAz, lpDistKm);         // 표적 방위/거리 without 차단각
    const inShadow = lpElevDeg < angleWith;                      // 지형+장애물 통합 차단 음영
    const buildingCaused = inShadow && lpElevDeg >= angleWithout; // 대상 건물 추가분에 의해서만 차단
    losses.push({ azDeg: lpAz, elevAngleDeg: lpElevDeg, durationS: lp.duration_s, inShadow, buildingCaused });
  }

  let shadowCount = 0;
  let buildingCount = 0;
  let buildingDurationS = 0;
  for (const l of losses) {
    if (l.inShadow) shadowCount++;
    if (l.buildingCaused) {
      buildingCount++;
      buildingDurationS += l.durationS;
    }
  }

  return { bDistKm, bAzDeg, angleTotalDeg, angleTerrainDeg, losses, shadowCount, buildingCount, buildingDurationS };
}
