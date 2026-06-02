/**
 * 장애물 분석 공유 헬퍼 — LoS 배치, 방위 구간 계산
 * ObstacleMonthlyConfigModal / ObstaclePreScreeningModal에서 사용.
 */
import { invoke } from "@tauri-apps/api/core";
import type { RadarSite, ManualBuilding, LoSProfileData, AzSector, BuildingOnPath } from "../types";
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
//   inShadow:       소실표적 양각 < 전체 차단각(지형+장애물)  → 음영구역 내
//   buildingCaused: inShadow && 양각 ≥ 지형 차단각            → 분석 대상 장애물 추가 기인
// 차트(빨강 점)와 요약 표(음영 소실 건수)가 항상 일치하도록 동일 로직 사용.

const R_EARTH_M_LOSS = 6_371_000;
const FT_PER_M_LOSS = 3.28084;
const AZ_TOLERANCE_DEG = 10;

export interface ClassifiedLoss {
  azDeg: number;
  elevAngleDeg: number;
  durationS: number;
  inShadow: boolean;
  buildingCaused: boolean;
}

/** elevationProfile 의 running max 차단각(tan, rad 근사), cutoff 거리(km)까지 */
function runningMaxAngleRad(
  profile: { distance: number; elevation: number }[],
  radarHeight: number,
  cutoffDistKm?: number,
): number {
  let maxAngle = -Infinity;
  for (const pt of profile) {
    if (pt.distance <= 0) continue;
    if (cutoffDistKm !== undefined && pt.distance > cutoffDistKm) break;
    const dM = pt.distance * 1000;
    const adjH = pt.elevation - (dM * dM) / (2 * R_EARTH_M_LOSS);
    const angle = (adjH - radarHeight) / dM;
    if (angle > maxAngle) maxAngle = angle;
  }
  return maxAngle === -Infinity ? 0 : maxAngle;
}

/** 소실표적 양각(°) — 곡률 보정 후 */
function lossElevAngleDeg(radarH: number, targetAltM: number, distM: number): number {
  if (distM <= 0) return 0;
  const curvDrop = (distM * distM) / (2 * R_EARTH_M_LOSS);
  return (Math.atan((targetAltM - curvDrop - radarH) / distM) * 180) / Math.PI;
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

  let angleTotal = 0;
  let angleTerrain = 0;
  if (los.elevationProfile.length > 0) {
    angleTotal = runningMaxAngleRad(los.elevationProfile, radarH);
    angleTerrain = runningMaxAngleRad(los.elevationProfile, radarH, bDistKm);
  } else {
    const bTopM = (building.ground_elev || 0) + building.height;
    const dM = bDistKm * 1000;
    const curvDrop = (dM * dM) / (2 * R_EARTH_M_LOSS);
    angleTotal = (bTopM - curvDrop - radarH) / dM;
  }
  const angleTotalDeg = (Math.atan(angleTotal) * 180) / Math.PI;
  const angleTerrainDeg = (Math.atan(angleTerrain) * 180) / Math.PI;

  const losses: ClassifiedLoss[] = [];
  for (const lp of lossPoints) {
    const lpDistKm = haversineKm(radar.latitude, radar.longitude, lp.lat, lp.lon);
    const lpAz = bearingDeg(radar.latitude, radar.longitude, lp.lat, lp.lon);
    let azDiff = Math.abs(lpAz - bAzDeg);
    if (azDiff > 180) azDiff = 360 - azDiff;
    if (azDiff > AZ_TOLERANCE_DEG) continue;
    if (lpDistKm <= bDistKm + 0.01) continue;

    const lpAltM = lp.alt_ft / FT_PER_M_LOSS;
    const lpElevDeg = lossElevAngleDeg(radarH, lpAltM, lpDistKm * 1000);
    const inShadow = lpElevDeg < angleTotalDeg;
    const buildingCaused = inShadow && lpElevDeg >= angleTerrainDeg;
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
