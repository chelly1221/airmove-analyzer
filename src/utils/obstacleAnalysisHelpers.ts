/**
 * 장애물 분석 공유 헬퍼 — LoS 배치, 방위 구간 계산
 * ObstacleMonthlyConfigModal / ObstaclePreScreeningModal에서 사용.
 */
import { invoke } from "@tauri-apps/api/core";
import type { RadarSite, ManualBuilding, LoSProfileData, AzSector } from "../types";

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
        const samples = 150;
        const lats: number[] = [];
        const lons: number[] = [];
        for (let j = 0; j <= samples; j++) {
          const t = j / samples;
          lats.push(radar.latitude + (bldg.latitude - radar.latitude) * t);
          lons.push(radar.longitude + (bldg.longitude - radar.longitude) * t);
        }
        const [elevations, pathBuildings] = await Promise.all([
          invoke<number[]>("fetch_elevation", { latitudes: lats, longitudes: lons }),
          invoke<{ distance_km: number; height_m: number; ground_elev_m: number; total_height_m: number; name: string | null; address: string | null }[]>(
            "query_buildings_along_path",
            { radarLat: radar.latitude, radarLon: radar.longitude, targetLat: bldg.latitude, targetLon: bldg.longitude, corridorWidthM: 200 },
          ),
        ]);
        const totalDist = Math.sqrt(
          ((bldg.latitude - radar.latitude) * 111320) ** 2 +
          ((bldg.longitude - radar.longitude) * 111320 * Math.cos(radar.latitude * Math.PI / 180)) ** 2,
        ) / 1000;

        const combinedElev = [...elevations];
        for (const pb of pathBuildings) {
          const sampleIdx = Math.round((pb.distance_km / totalDist) * samples);
          if (sampleIdx >= 0 && sampleIdx < combinedElev.length) {
            const bldgTop = pb.ground_elev_m + pb.height_m;
            if (bldgTop > combinedElev[sampleIdx]) combinedElev[sampleIdx] = bldgTop;
          }
        }

        let blocked = false;
        let maxBlockDist = 0, maxBlockElev = -Infinity, maxBlockName = "";
        const R = 6371000;
        const Reff = R * 4 / 3;
        const targetElev = bldg.ground_elev + bldg.height;
        for (let k = 1; k < combinedElev.length; k++) {
          const d = (k / samples) * totalDist * 1000;
          const t = k / samples;
          const losHeight = radarHeight * (1 - t) + targetElev * t;
          const curvDrop = (d * d) / (2 * Reff);
          const terrainAdjusted = combinedElev[k] + curvDrop;
          if (terrainAdjusted > losHeight) {
            blocked = true;
            if (terrainAdjusted > maxBlockElev) {
              maxBlockElev = terrainAdjusted;
              maxBlockDist = t * totalDist;
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
          distance: (idx / samples) * totalDist,
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
