/**
 * 장애물 분석 공유 헬퍼 — LoS 배치, 방위 구간 계산
 * ObstacleMonthlyConfigModal에서 사용.
 */
import { invoke } from "@tauri-apps/api/core";
import type { RadarSite, ManualBuilding, LoSProfileData, AzSector, BuildingOnPath, PanoramaMergeResult } from "../types";
import type { LossPointGeo } from "../types/obstacle";
import { haversineKm, bearingDeg } from "./geo";

/** OM 보고서 LoS 단면도 차트 최소 X축 (km) — 빌딩이 가까워도 이만큼은 terrain 을 샘플링.
 *  200NM = 200 * 1.852 km. ReportOMLosCrossSection 의 편집모드 최대 줌아웃(MAX_X_KM)과 일치 —
 *  기본 뷰는 100NM 이지만 줌아웃 시 200NM 까지 보이므로 그만큼 미리 샘플링. */
const EXTEND_PROFILE_MIN_KM = 200 * 1.852;

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
        //   빌딩이 가까워도 보고서 차트가 (줌아웃 시) 200NM 까지 길게 보이도록 — TrackMap 의 동작과 일관.
        const profileEndKm = Math.max(totalDist, EXTEND_PROFILE_MIN_KM);
        // 거리 그리드(km) — 코리도(레이더→빌딩 0..totalDist)는 근거리 지형 봉우리를 잡도록 조밀하게(≈60m),
        //   빌딩 너머 확장부(totalDist..profileEndKm)는 줌아웃 표시용으로 거칠게(≈370m) 샘플링.
        //   (종전: 0..profileEndKm 전체를 균일 ≤1000샘플로 깔아 근거리 코리도까지 ~370m 로 과소표집 →
        //    코리도의 날카로운 봉우리가 지형선·최저탐지선 양쪽에서 누락될 수 있었음. 앙각은 1/d 가중이라
        //    근거리 손실이 최저탐지선을 가장 크게 들어올렸어야 할 지점에서 가장 큼.)
        const CORRIDOR_STEP_KM = 0.06;        // ≈60m — SRTM(≈30m) 근접 밀도로 코리도 표집
        const EXT_STEP_KM = 0.37;             // ≈370m — 확장부(빌딩 너머) 밀도(종전 균일치 유지)
        const MAX_CORRIDOR_SAMPLES = 1500;    // 원거리 빌딩에서 fetch_elevation 폭주 방지(코리도 상한)
        // 방향 단위 벡터 (위/경도 변화량 per km) — 빌딩 너머도 같은 베어링 직선상으로 외삽
        const dLatPerKm = totalDist > 1e-6 ? (bldg.latitude - radar.latitude) / totalDist : 0;
        const dLonPerKm = totalDist > 1e-6 ? (bldg.longitude - radar.longitude) / totalDist : 0;
        // 코리도: 0..totalDist 등간격, 마지막 점이 정확히 totalDist (= 빌딩 인덱스 samplesToBuilding)
        const corridorSamples = Math.min(MAX_CORRIDOR_SAMPLES, Math.max(1, Math.round(totalDist / CORRIDOR_STEP_KM)));
        const dists: number[] = [];
        for (let j = 0; j <= corridorSamples; j++) dists.push((j / corridorSamples) * totalDist);
        // 빌딩 거리에 해당하는 샘플 인덱스 (블록 판정 루프 종료점) — 코리도 마지막 점
        const samplesToBuilding = corridorSamples;
        // 확장부: totalDist 초과 ~ profileEndKm 거칠게 (빌딩이 200NM 너머면 profileEndKm==totalDist → 확장 없음)
        if (profileEndKm > totalDist + 1e-9) {
          const extSamples = Math.max(1, Math.round((profileEndKm - totalDist) / EXT_STEP_KM));
          for (let j = 1; j <= extSamples; j++) dists.push(totalDist + (j / extSamples) * (profileEndKm - totalDist));
        }
        const lats: number[] = [];
        const lons: number[] = [];
        for (let j = 0; j < dists.length; j++) {
          const d = dists[j];
          lats.push(radar.latitude + dLatPerKm * d);
          lons.push(radar.longitude + dLonPerKm * d);
        }
        const [elevations, pathBuildings] = await Promise.all([
          invoke<number[]>("fetch_elevation", { latitudes: lats, longitudes: lons }),
          invoke<BuildingOnPath[]>(
            "query_buildings_along_path",
            // ignoreGroupEnabled: 보고서는 자료관리 그룹 활성화 상태와 무관하게 선택된 모든 건물(대상+경로상)을
            //   단면도에 적용한다 — panorama(query_building_polygons)가 이미 enabled 무시라 단면도·음영차트 프레임 통일.
            { radarLat: radar.latitude, radarLon: radar.longitude, targetLat: bldg.latitude, targetLon: bldg.longitude, corridorWidthM: 200, ignoreGroupEnabled: true },
          ),
        ]);

        // 비균일 거리 그리드(dists 오름차순)에서 d 에 가장 가까운 인덱스 — 이진 탐색
        const distToNearestIdx = (d: number): number => {
          if (d <= dists[0]) return 0;
          const lastI = dists.length - 1;
          if (d >= dists[lastI]) return lastI;
          let lo = 0, hi = lastI;
          while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (dists[mid] <= d) lo = mid; else hi = mid;
          }
          return (d - dists[lo]) <= (dists[hi] - d) ? lo : hi;
        };

        // GIS(건물통합정보) 건물 지반은 Rust query_buildings_along_path 가 centroid SRTM(live)로 재설정해
        //   내려준다(파노라마·TrackMap LoS 와 동일 소스) → pathBuildings.ground_elev_m 을 그대로 사용. 수동건물은
        //   사용자 입력 지반고 유지. (종전 단면도는 캐시 컬럼 COALESCE(ground_elev,0) 의존이라 백필 안 된 GIS 건물이
        //   해수면에 가라앉아 차폐를 못 만들던 버그가 있었음 — Rust 소스 통합으로 해소.)
        const combinedElev = [...elevations];
        for (const pb of pathBuildings) {
          // 빌딩 거리를 가장 가까운 그리드 인덱스로 매핑 (단일 점 스파이크)
          const sampleIdx = distToNearestIdx(pb.distance_km);
          if (sampleIdx >= 0 && sampleIdx < combinedElev.length) {
            const bldgTop = pb.ground_elev_m + pb.height_m;
            if (bldgTop > combinedElev[sampleIdx]) combinedElev[sampleIdx] = bldgTop;
          }
        }

        // 차단 판정: 빌딩 거리까지의 terrain 만 봄 (빌딩 너머 지형은 빌딩 가시성에 무관).
        //   직선 LoS — 실제지구(R=6,371,000) 곡률만 보정하고 4/3 유효지구 굴절은 적용하지 않는다.
        //   단면도(ReportOMLosCrossSection) 표시·차단 배지와 동일 프레임이라 los.losBlocked 와 차트 판정이 일치.
        let blocked = false;
        let maxBlockDist = 0, maxBlockElev = -Infinity, maxBlockName = "";
        const R = 6371000;
        const targetElev = bldg.ground_elev + bldg.height;
        for (let k = 1; k <= samplesToBuilding && k < combinedElev.length; k++) {
          const d = dists[k] * 1000;
          const t = totalDist > 1e-6 ? dists[k] / totalDist : 0; // radar↔building 보간 (0~1)
          const losHeight = radarHeight * (1 - t) + targetElev * t;
          const curvDrop = (d * d) / (2 * R);
          const terrainAdjusted = combinedElev[k] + curvDrop;
          if (terrainAdjusted > losHeight) {
            blocked = true;
            if (terrainAdjusted > maxBlockElev) {
              maxBlockElev = terrainAdjusted;
              maxBlockDist = dists[k];
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
          distance: dists[idx],
          elevation: elev,
          latitude: lats[idx],
          longitude: lons[idx],
        }));
        // 순수 지형 프로파일 (건물 병합 전 raw SRTM) — 단면도 '분석 대상 제외' 선 계산용
        const terrainProf = elevations.map((elev, idx) => ({
          distance: dists[idx],
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
// with/without 두 실루엣의 유일한 차이 = 분석 대상 건물 → [without, with] 밴드 = '대상 추가 차단'.
//   이는 panorama 빨강영역(panoWith−panoWithout)과 동일 정의 → 차트의 빨강 영역과 검은× 점이 by-construction 일치.
// 차단각 = panorama 실루엣 방위별 max(전 거리, 실제지구) → 차트와 동일 소스라 픽셀 일치.
//   파노라마는 거리축이 없어 max-over-distance 가 본질 — 표적 너머 지형도 silhouette 에 포함되나,
//   buildingCount(=with−without 차분)는 공통 원거리 장애물이 상쇄돼 거리 오염 없음.

/** 소실표적 양각·차단각 곡률 보정 지구반경 — 실제지구. panorama 실루엣(빨강영역)이 실제지구 프레임이라
 *  점·영역을 같은 프레임에 두어 검은×↔빨강영역 픽셀 일치(단면도 표시 곡률 curvDrop 과도 동일 반경). */
const R_EARTH_M_LOSS = 6_371_000;
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
  /** 레이더↔소실표적 거리(km) — 표/상세 표시용 (내부 lpDistKm) */
  distKm: number;
  /** 원본 소실표적 객체 — 좌표·고도·일자(호출부 역참조) 표시용. 입력 배열 요소 참조 그대로. */
  source: LossPointGeo;
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

/** 표적 양각(°) — 실제지구 곡률 보정 후(보고된 고도에서 d²/2R 강하량 차감). panorama 실루엣과 동일 프레임.
 *  소실표적·항적 모두 동일 프레임으로 투영하기 위해 export (ReportOMObstacleAzElevChart 항적 점 공유). */
export function pointElevAngleDeg(radarH: number, targetAltM: number, distM: number): number {
  if (distM <= 0) return 0;
  const curvDrop = (distM * distM) / (2 * R_EARTH_M_LOSS);
  return (Math.atan((targetAltM - curvDrop - radarH) / distM) * 180) / Math.PI;
}

/** 고도 단위 변환(ft→m) 상수 — 소실표적·항적 양각 투영 공유 */
export const FT_PER_M = FT_PER_M_LOSS;

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
export function makePanoramaSampler(pano: PanoramaMergeResult): (azDeg: number) => number {
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
    /** 차단각 산출용 panorama(실제지구) — 차트 빨강영역과 동일 소스라 검은×↔빨강영역 픽셀 일치.
     *  panoWith = 지형+기존지물+분석대상, panoWithout = 분석대상 제외(Rust 가 제외대상 0 이면 null → without==with).
     *  panoWith 자체가 없으면(해당 레이더 파노라마 계산 실패) 차단각 0 → 음영 분류 생략(보수적). */
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

  // 차단각 = panorama 실루엣 방위별 max(실제지구). with(지형+기존지물+분석대상) − without(분석대상 제외) = '대상 추가 차단'.
  //   빨강영역(panoWith−panoWithout)과 동일 소스·동일 프레임 → 차트 빨강영역·검은× 점 픽셀 일치.
  //   panoWithout 가 null(Rust 가 제외대상 0 일 때) → without==with. panoWith 자체가 없으면 차단각 0(음영 분류 생략).
  const sW = opts?.panoWith ? makePanoramaSampler(opts.panoWith) : null;
  const sWo = opts?.panoWithout ? makePanoramaSampler(opts.panoWithout) : sW;
  const angleWithAt = (azDeg: number) => (sW ? sW(azDeg) : 0);
  const angleWithoutAt = (azDeg: number) => (sWo ? sWo(azDeg) : 0);

  // 표 표시용 대표 차단각 — angleTotalDeg=with(대상 차단각), angleTerrainDeg=without(지형+기존). 대상 방위 기준.
  const angleTotalDeg = angleWithAt(bAzDeg);
  const angleTerrainDeg = angleWithoutAt(bAzDeg);

  const siblings = opts?.siblings ?? [];
  // sibling 오귀속 비교용 자기 방위·거리 — 호출부가 sibling 을 bearingDeg·haversineKm 로 계산하므로 동일 기준 사용(비대칭 제거).
  //   ※ 거리 동률/근접 판정에 bDistKm(=los.totalDistance, 등거리근사)을 쓰면 sibling.distKm(haversine)과 메트릭이
  //     불일치해(등거리>haversine 체계적 편향) 동방위·동일위치 건물쌍에서 전순서가 깨진다 — 양쪽 모두 양보→소실표적 누락,
  //     id fail-safe 사문화. 자기 거리도 haversine 으로 통일해 antisymmetric 전순서(정확히 한 건물만 소유) 복원.
  const selfAzForSibling = bearingDeg(radar.latitude, radar.longitude, building.latitude, building.longitude);
  const selfDistForSibling = haversineKm(radar.latitude, radar.longitude, building.latitude, building.longitude);
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
      const tieDist = Math.abs(s.distKm - selfDistForSibling) <= 1e-9;
      const tieAzDeg = Math.abs(s.azDeg - selfAzForSibling) <= 1e-9;
      if (sd < azDiffSelf - 1e-9                                      // 방위 근접
        || (tieAz && s.distKm < selfDistForSibling - 1e-9)            // 동률 → 거리 근접
        || (tieAz && tieDist && s.azDeg < selfAzForSibling - 1e-9)    // +동률 → 작은 방위값
        || (tieAz && tieDist && tieAzDeg && s.id < building.id)) {    // +완전동률(동일 위치) → 작은 id (fail-safe)
        ownedByOther = true;
        break;
      }
    }
    if (ownedByOther) continue;

    const lpAltM = lp.alt_ft / FT_PER_M_LOSS;
    const lpElevDeg = pointElevAngleDeg(radarH, lpAltM, lpDistKm * 1000);
    const angleWith = angleWithAt(lpAz);                         // 표적 방위 with 차단각
    const angleWithout = angleWithoutAt(lpAz);                   // 표적 방위 without 차단각
    const inShadow = lpElevDeg < angleWith;                      // 지형+장애물 통합 차단 음영
    const buildingCaused = inShadow && lpElevDeg >= angleWithout; // 대상 건물 추가분에 의해서만 차단
    losses.push({ azDeg: lpAz, elevAngleDeg: lpElevDeg, durationS: lp.duration_s, distKm: lpDistKm, source: lp, inShadow, buildingCaused });
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
