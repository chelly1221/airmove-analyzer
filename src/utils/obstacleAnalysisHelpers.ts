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

/** LoS 차단 판정 결과 — 차트(ReportOMLosCrossSection)와 배지(computeLosBatch)가 공유하는 단일 소스. */
export interface LosBlockageResult {
  blocked: boolean;
  /** 최대 초과(차단 기여 최대) 지점. blocked=false 면 null. distance=km, realElevation=실제 표고(m ASL). */
  maxBlockPoint: { distance: number; adjHeight: number; realElevation: number } | null;
}

/**
 * LoS 차단 판정 — ITU 4/3 유효지구 직선 현(chord) 대비 통합 장애물(지형 profile + 건물 near/far 엣지) 비교.
 * 차트(ReportOMLosCrossSection)·배지(computeLosBatch)가 동일 식·동일 obstacle 집합으로 판정하도록 추출한 단일 소스.
 *   클리어런스 = 평면현 − d1·d2/(2·R_eff). excess(=adjH − 현높이) 가 최대(>0)인 지점을 차단점으로.
 *   ※ self-block 방지 — 분석 대상이 폴리곤형 건물이면 대상 자신의 near/far 엣지·top 스파이크가 표적(=대상 top)
 *     바로 앞에서 무조건 '차단'을 만들므로, 호출부는 대상 자신을 제외한 입력을 넘긴다:
 *     profile = 스파이크 없는 순수 SRTM(terrainProfile), pathBuildings = excludeTargetBuildings(대상 제외).
 *     비대상 건물 높이는 near/far 엣지로 들어가므로 스파이크 부재에 따른 판정 차이는 없다
 *     (footprint 내부 중간점 1개 차이 — 곡률 2차항 ≈ mm 오더).
 * @param profile           판정용 지형 프로파일 {distance(km), elevation(m ASL)} — 순수 SRTM(대상 스파이크 없음)
 * @param pathBuildings     경로상 건물(분석 대상 자신 제외) — near/far 엣지를 obstacle 로 추가
 * @param radarHeight       레이더 안테나 해발고 (m)
 * @param totalDistanceKm   레이더↔표적 지표거리 (km)
 * @param targetElev        표적 해발고 (m)
 */
export function computeLosBlockage(
  profile: { distance: number; elevation: number }[],
  pathBuildings: BuildingOnPath[],
  radarHeight: number,
  totalDistanceKm: number,
  targetElev: number,
): LosBlockageResult {
  const R_EFF = (6_371_000 * 4) / 3; // 4/3 유효지구반경 (ITU-R 표준대기 k=4/3)
  const curvDrop43 = (dKm: number): number => {
    const dM = dKm * 1000;
    return (dM * dM) / (2 * R_EFF);
  };
  const D = totalDistanceKm;
  const adjTarget = targetElev - curvDrop43(D); // 표적단 4/3 곡률 강하

  // 통합 장애물: 지형(profile) + 건물 near/far 엣지 (min-det 는 호출부가 자체 구성)
  const obstacles: { distance: number; elevation: number }[] = [];
  for (const p of profile) obstacles.push({ distance: p.distance, elevation: p.elevation });
  for (const b of pathBuildings) {
    const bTop = b.ground_elev_m + b.height_m;
    const nearD = b.near_dist_km ?? b.distance_km;
    const farD = b.far_dist_km ?? b.distance_km;
    obstacles.push({ distance: nearD, elevation: bTop });
    if (farD - nearD > 0.001) obstacles.push({ distance: farD, elevation: bTop });
  }
  obstacles.sort((a, b) => a.distance - b.distance);

  // 레이더↔표적 직선 현(chord) — 표적단도 4/3 곡률 강하 반영
  const losStraightH = (d: number) => radarHeight + (adjTarget - radarHeight) * (d / D);
  let blocked = false;
  let maxBlockPoint: LosBlockageResult["maxBlockPoint"] = null;
  let maxExcess = 0;
  for (const ob of obstacles) {
    if (ob.distance <= 0 || ob.distance >= D) continue;
    const adjH = ob.elevation - curvDrop43(ob.distance);
    const excess = adjH - losStraightH(ob.distance);
    if (excess > maxExcess) {
      maxExcess = excess;
      blocked = true;
      maxBlockPoint = { distance: ob.distance, adjHeight: adjH, realElevation: ob.elevation };
    }
  }
  return { blocked, maxBlockPoint };
}

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
        // 코리도: 0..totalDist 등간격, 마지막 점이 정확히 totalDist (코리도 마지막 점 = 빌딩 거리)
        const corridorSamples = Math.min(MAX_CORRIDOR_SAMPLES, Math.max(1, Math.round(totalDist / CORRIDOR_STEP_KM)));
        const dists: number[] = [];
        for (let j = 0; j <= corridorSamples; j++) dists.push((j / corridorSamples) * totalDist);
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

        const targetElev = bldg.ground_elev + bldg.height;

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

        // 순수 지형 프로파일 (건물 병합 전 raw SRTM) — 단면도 '분석 대상 제외' 선 + 차단판정 지형 base
        const terrainProf = elevations.map((elev, idx) => ({
          distance: dists[idx],
          elevation: elev,
          latitude: lats[idx],
          longitude: lons[idx],
        }));
        // 차단 판정 — 차트(ReportOMLosCrossSection)와 동일한 computeLosBlockage 단일 소스·동일 4/3 chord 식.
        //   입력에서 분석 대상 자신을 제외(self-block 방지): 지형 base = 스파이크 없는 순수 SRTM(terrainProf),
        //   건물 = excludeTargetBuildings(대상 매칭 + 대상 footprint 겹침 제외). 종전엔 elevProfile(대상 top
        //   스파이크 포함) + pathBuildings(대상 near/far 엣지 포함)를 그대로 넣어 폴리곤형 대상이 중간 차폐
        //   없어도 무조건 '차단'이었다 — losBlockedFromPanorama 문서의 'chord 폴백은 self-block 회피'와 구현 일치.
        //   차트(ReportOMLosCrossSection)도 동일 입력(terrainProfile + 대상 제외 건물)로 판정 → 배지↔차트 식 일치 유지.
        //   비대상 건물은 near/far 엣지로 동일 높이가 들어가므로 스파이크 부재에 따른 판정 차이 없음.
        const judgeBuildings = excludeTargetBuildings(pathBuildings, bldg, totalDist);
        const { blocked, maxBlockPoint } = computeLosBlockage(
          terrainProf, judgeBuildings, radarHeight, totalDist, targetElev,
        );
        let maxBlockName = "";
        if (maxBlockPoint) {
          const nearBldg = judgeBuildings.find((pb) => Math.abs(pb.distance_km - maxBlockPoint.distance) < 0.5);
          maxBlockName = nearBldg?.name ?? nearBldg?.address ?? "";
        }
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
          maxBlockingPoint: maxBlockPoint
            ? { distance: maxBlockPoint.distance, elevation: maxBlockPoint.realElevation, name: maxBlockName }
            : undefined,
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

// ─── calcBuildingAzExtent 메모이즈 ──────────────────────────────────────────
// 왜 필요한가(크래시 근본 원인): OM 보고서 렌더는 (건물 N × 레이더) 에 대해 §2 요약·§3 상세·§4 소실상세가
//   각각 건물마다 buildSiblings(전체 건물) + classifyObstacleLosses 를 돌아 calcBuildingAzExtent 를
//   O(N²) 로 호출한다. 이 함수는 내부에서 JSON.parse(geometry_json) + 폴리곤 꼭짓점 순회(멀티는 재귀)를
//   수행하므로, 건물 100개·레이더 3개면 렌더 1회에 수만~수십만 번 JSON.parse → 건물통합정보 폴리곤
//   (꼭짓점 수십~수백)에서 순간 수백MB~GB 힙 할당 → WebView2 렌더러 OOM → 창 소멸(커밋 7239573 회귀).
//   calcBuildingAzExtent 는 순수 함수(같은 radar 좌표·같은 building → 항상 같은 AzSector)이므로,
//   레이더×건물당 실제 계산(JSON.parse)을 1회로 줄이면 O(N²) 호출은 상수시간 캐시 히트가 되어 폭발이 사라진다.
//
// 캐시 무효화 규약:
//   · 키 = building 객체 참조(WeakMap). building.id 같은 원시값이 아니라 객체 참조를 키로 써서 서로 다른
//     building 인스턴스 간 오염을 원천 차단하고, building 이 GC 되면 캐시 엔트리도 자동 해제(누수 없음).
//     ⇒ 건물의 좌표·geometry 가 바뀌면 반드시 '새 객체'로 교체해야 캐시가 무효화된다(같은 객체 in-place
//        mutate 는 stale 캐시를 유발하므로 금지 — 실제 편집 파이프라인은 새 ManualBuilding 을 만들어 교체).
//   · 하위 키 = `${radarLat},${radarLon}` 문자열. 레이더 객체가 참조 유지된 채 좌표만 바뀌어도 재계산된다.
//   · 반환 AzSector 는 캐시에 저장된 객체를 '공유' 반환한다 — 전체 호출부(§2/§3/§4·ObstacleMonthlyConfigModal·
//     ReportOMLosCrossSection·ReportOMRadarBuildingMap·ReportApp·computeAddedBlockage·mergeAzSectors·
//     buildingAzHalfExtentDeg)를 grep 확인한 결과 start_deg/end_deg 를 mutate 하는 곳이 없어(모두 read-only,
//     2026-07-02 조사) 공유 반환이 안전하다. 이후 mutate 하는 호출부가 생기면 그 호출부에서 값을 복제할 것.
const azExtentCache = new WeakMap<ManualBuilding, Map<string, AzSector>>();

/** 건물 도형의 레이더 방향 노출면 방위 구간 계산 — 메모이즈 래퍼(위 캐시 규약 참조). */
export function calcBuildingAzExtent(
  radarLat: number, radarLon: number,
  building: ManualBuilding,
): AzSector {
  let byRadar = azExtentCache.get(building);
  if (!byRadar) {
    byRadar = new Map<string, AzSector>();
    azExtentCache.set(building, byRadar);
  }
  const key = `${radarLat},${radarLon}`;
  const cached = byRadar.get(key);
  if (cached) return cached;
  const result = calcBuildingAzExtentRaw(radarLat, radarLon, building);
  byRadar.set(key, result);
  return result;
}

/** calcBuildingAzExtent 원본 계산부(JSON.parse 포함) — 메모이즈 캐시 미스일 때만 호출.
 *  멀티 타입 하위 도형 재귀(:아래)는 메모이즈된 export calcBuildingAzExtent 를 계속 호출한다(재귀도 캐시 이득). */
function calcBuildingAzExtentRaw(
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
// 차단각 = panorama 실루엣 방위별 max(전 거리, ITU 4/3 유효지구) → 차트와 동일 소스라 픽셀 일치.
//   파노라마는 거리축이 없어 max-over-distance 가 본질 — 표적 너머 지형도 silhouette 에 포함되나,
//   buildingCount(=with−without 차분)는 공통 원거리 장애물이 상쇄돼 거리 오염 없음.

/** 소실표적 양각·차단각 곡률 보정 지구반경 — ITU 4/3 유효지구(k=4/3). panorama 실루엣(빨강영역)도
 *  4/3 프레임(Rust panorama.rs·obstacle_monthly.rs elev_angle_deg 동시 이행)이라, 점·영역을 같은
 *  프레임에 두어 검은×↔빨강영역 픽셀 일치. 단면도·차단 배지(computeLosBatch)와도 동일 4/3 프레임. */
const R_EFF_M_LOSS = (6_371_000 * 4) / 3;
const FT_PER_M_LOSS = 3.28084;
/** 소실표적 분류 방위 허용각 하한(°) — 실제 허용각은 건물별 classifyAzToleranceDeg = max(이 하한, 노출면 반각폭+1°).
 *  (종전 ±10° 고정 캡 — 총 각폭 18° 초과 근접 대상에서 차트 창 안의 소실표적이 분류에서 누락되던 문제 해소.) */
const AZ_TOLERANCE_DEG = 10;
/** 허용각 반각폭 마진(°) — Az×Elev 차트 창(ReportOMObstacleAzElevChart AZ_MARGIN)과 동일 1° (창 ⊆ 허용각 보장) */
const CLASSIFY_AZ_MARGIN_DEG = 1;

/**
 * 건물 노출면 반각폭(°) — calcBuildingAzExtent 노출면 양끝이 중심 방위(centerAzDeg)에서 벗어난 최대 원형 각차
 * (비대칭 노출면 대비 max). 분류 허용각(classifyAzToleranceDeg)·Az×Elev 차트 창(azHalfSpan)이 공유하는
 * 단일 산식 — 백엔드 track_points_geo 사전필터 반폭 산출(ObstacleMonthlyConfigModal)과도 동일 정의.
 */
export function buildingAzHalfExtentDeg(
  radarLat: number, radarLon: number, building: ManualBuilding, centerAzDeg: number,
): number {
  const ext = calcBuildingAzExtent(radarLat, radarLon, building);
  const circDiff = (a: number): number => {
    const d = Math.abs(a - centerAzDeg) % 360;
    return d > 180 ? 360 - d : d;
  };
  return Math.max(circDiff(ext.start_deg), circDiff(ext.end_deg));
}

/**
 * 건물별 소실표적 분류 방위 허용각(°) = max(±10° 하한, 노출면 반각폭 + 1° 마진).
 * classifyObstacleLosses(자기 창)·buildSiblings(sibling claim 가능성 검사)가 공유하는 단일 진실원천.
 * Az×Elev 차트 창(azHalfSpan = max(반각폭+1°, 2°)) ≤ 이 허용각 — 차트 창 안의 소실 점은 항상 분류에 포함.
 */
export function classifyAzToleranceDeg(
  radarLat: number, radarLon: number, building: ManualBuilding, centerAzDeg: number,
): number {
  return Math.max(
    AZ_TOLERANCE_DEG,
    buildingAzHalfExtentDeg(radarLat, radarLon, building, centerAzDeg) + CLASSIFY_AZ_MARGIN_DEG,
  );
}

/** classifyObstacleLosses 의 sibling(같은 레이더의 다른 분석 대상) — buildSiblings 로 생성.
 *  방위·거리·허용각은 classify 의 자기 판정(bAzDeg·bDistKm·azTolDeg)과 동일 산식 → 어느 건물 pass 에서
 *  계산해도 소유자가 동일하게 결정(대칭 전순서). 방위·거리·id 로 오귀속 타이브레이크. */
export interface SiblingBuilding {
  id: number;
  /** 레이더→건물 방위(°, bearingDeg) — classify 의 bAzDeg 와 동일 산식 */
  azDeg: number;
  /** 레이더→건물 거리(km, haversine) — classify 의 bDistKm 와 동일 산식 */
  distKm: number;
  /** 그 건물의 분류 방위 허용각(°, classifyAzToleranceDeg) — claim 가능성(방위창) 검사용 */
  azTolDeg: number;
}

/**
 * classify 호출부 공용 sibling 목록 빌더 — 자기(selfId) 제외 + losMap 제공 시 LoS 결과 없는 건물 제외.
 * LoS 결과가 없으면 그 건물의 classify 자체가 돌지 않으므로, 그런 건물이 소유권만 가져가면 해당 소실표적이
 * 모든 건물 집계에서 누락된다 — sibling 에서 제외해 다음으로 강한(집계 가능한) 건물이 귀속받게 한다.
 * §2 요약(ReportOMSummarySection)·§3 상세(ReportOMObstacleDetail)·§4 소실상세(ReportOMLossEvents)가
 * 전부 이 빌더를 사용해야 표·차트 점 수가 일치한다.
 */
export function buildSiblings(
  radar: RadarSite,
  allBuildings: ManualBuilding[],
  selfId: number,
  losMap?: Map<string, LoSProfileData> | null,
): SiblingBuilding[] {
  const out: SiblingBuilding[] = [];
  for (const b of allBuildings) {
    if (b.id === selfId) continue;
    if (losMap && !losMap.has(`${radar.name}_${b.id}`)) continue; // classify 미실행 건물 — 소유권 대상 아님
    const azDeg = bearingDeg(radar.latitude, radar.longitude, b.latitude, b.longitude);
    out.push({
      id: b.id,
      azDeg,
      distKm: haversineKm(radar.latitude, radar.longitude, b.latitude, b.longitude),
      azTolDeg: classifyAzToleranceDeg(radar.latitude, radar.longitude, b, azDeg),
    });
  }
  return out;
}

export interface ClassifiedLoss {
  azDeg: number;
  elevAngleDeg: number;
  /** 부모 gap(이벤트) 전체 지속시간(초) — 이벤트 지속시간 표시용. 같은 이벤트의 보간점 모두 동일 값이라
   *  점마다 합산하면 보간점 수 × gap 과대 — 시간 합산은 source.share_s(Σ = gap)를 사용. */
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

/**
 * LoS 경로 건물에서 '분석 대상 자신'을 제외 — 차단판정(self-block 방지)·단면도 '대상 제외' 점선의 단일 규칙.
 * 대상 매칭(isTargetBuildingOnPath)뿐 아니라 대상 footprint 거리구간에 겹친 비대상 건물
 * (동일 위치 건물통합정보 폴리곤 등 — is_manual=false 라 대상매칭 불가)도 함께 제외해야 '대상 제거 시'
 * 관점이 성립한다. (footprint 밖 비대상 건물은 유지.)
 * computeLosBatch(차단 배지 los.losBlocked)·ReportOMLosCrossSection(차트 blocked·점선)이 공유
 * → 배지↔차트가 항상 동일 obstacle 집합으로 판정.
 */
export function excludeTargetBuildings(
  pathBuildings: BuildingOnPath[], building: ManualBuilding, totalDistKm: number,
): BuildingOnPath[] {
  const targetSpans: { near: number; far: number }[] = [];
  for (const b of pathBuildings) {
    if (isTargetBuildingOnPath(b, building, totalDistKm)) {
      targetSpans.push({ near: b.near_dist_km ?? b.distance_km, far: b.far_dist_km ?? b.distance_km });
    }
  }
  const inTargetSpan = (d: number) => targetSpans.some((s) => d >= s.near - 1e-9 && d <= s.far + 1e-9);
  return pathBuildings.filter(
    (b) => !isTargetBuildingOnPath(b, building, totalDistKm) && !inTargetSpan(b.distance_km),
  );
}

/** 표적 양각(°) — ITU 4/3 유효지구 곡률 보정 후(보고된 고도에서 d²/2R_eff 강하량 차감). panorama 실루엣과 동일 프레임.
 *  소실표적·항적 모두 동일 프레임으로 투영하기 위해 export (ReportOMObstacleAzElevChart 항적 점 공유). */
export function pointElevAngleDeg(radarH: number, targetAltM: number, distM: number): number {
  if (distM <= 0) return 0;
  const curvDrop = (distM * distM) / (2 * R_EFF_M_LOSS);
  return (Math.atan((targetAltM - curvDrop - radarH) / distM) * 180) / Math.PI;
}

/** 고도 단위 변환(ft→m) 상수 — 소실표적·항적 양각 투영 공유 */
export const FT_PER_M = FT_PER_M_LOSS;

/** 절대 방위차 (−180, 180] — x 를 기준 c 에 대한 상대각으로 */
function relAngleDeg(x: number, c: number): number {
  return ((x - c + 540) % 360) - 180;
}

/**
 * panorama terrain(방위→차단 양각°, ITU 4/3 유효지구) 전역 360° 원형 보간 샘플러.
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
 * panorama(지형+건물)의 방위별 차단 양각(°, ITU 4/3 유효지구) 샘플러.
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
 * 방위 윈도우(건물별 허용각 azTolDeg = max(±10°, 노출면 반각폭+1°)) + 대상 후방(거리 > bDistKm) 소실표적만 채택.
 * @returns 차단각(°) + 분류된 소실 배열(점 단위) + 집계 — '…건'(이벤트)은 distinct event_id, 소실시간은 Σ share_s
 */
export function classifyObstacleLosses(
  radar: RadarSite,
  building: ManualBuilding,
  lossPoints: LossPointGeo[],
  opts?: {
    /** 차단각 산출용 panorama(ITU 4/3 유효지구) — 차트 빨강영역과 동일 소스라 검은×↔빨강영역 픽셀 일치.
     *  panoWith = 지형+기존지물+분석대상, panoWithout = 분석대상 제외(Rust 가 제외대상 0 이면 null → without==with).
     *  panoWith 자체가 없으면(해당 레이더 파노라마 계산 실패) 차단각 0 → 음영 분류 생략(보수적). */
    panoWith?: PanoramaMergeResult;
    panoWithout?: PanoramaMergeResult;
    /** 같은 레이더의 '다른' 분석 대상 건물 — buildSiblings 로 생성(LoS 결과 없는 건물 제외).
     *  '실제로 claim 가능한'(자기 pass 와 동일 조건: 방위차 ≤ 그 sibling 의 허용각 && 대상 후방) sibling 이
     *  더 강하게 소유하면 본 건물 집계서 제외(오귀속 방지). 소유 우선순위: 방위 근접 > 거리 근접 > 작은 방위값 > 작은 id. */
    siblings?: SiblingBuilding[];
  },
): {
  /** 레이더↔대상 거리(km, haversine) — 후방 판정·sibling 대칭 기준 */
  bDistKm: number;
  /** 레이더↔대상 방위(°, bearingDeg) — 창 중심·sibling 대칭 기준 */
  bAzDeg: number;
  /** 건물별 방위 허용각(° = max(10, 노출면 반각폭+1)) — 표 '방위 ±N°' 표시·차트 창 부분집합 검증용 */
  azTolDeg: number;
  angleTotalDeg: number;
  angleTerrainDeg: number;
  /** 채택 소실표적(점 단위) — 차트 점·'소실표적 수' 라벨은 이 길이(점 개수)를 사용 */
  losses: ClassifiedLoss[];
  /** inShadow 점 개수(점 단위) */
  shadowCount: number;
  /** buildingCaused 점 개수(점 단위) */
  buildingCount: number;
  /** 장애물 추가 기인 소실시간(초) = buildingCaused 점 Σ share_s — 같은 gap 보간점 합 = gap (과대 없음) */
  buildingDurationS: number;
  /** 채택 소실표적의 distinct 이벤트(gap) 수 — '…건' 표시·비율 분모용 */
  totalEventCount: number;
  /** inShadow 점을 1개 이상 포함한 이벤트 수 — 'LoS 차단 영역 내 N건' */
  shadowEventCount: number;
  /** buildingCaused 점을 1개 이상 포함한 이벤트 수 — '장애물 추가 기인 N건' */
  buildingEventCount: number;
} {
  const radarH = radar.altitude + radar.antenna_height;
  // 대상 방위·거리·허용각 — sibling(buildSiblings)과 동일 산식(bearingDeg·haversineKm·classifyAzToleranceDeg).
  //   소유권 판정(claim 가능성 + 타이브레이크)이 어느 건물 pass 에서 계산돼도 같은 수치 위에서 이뤄져
  //   소유자가 유일하게 결정된다(대칭 전순서). (종전: 자기만 창 중심 los.bearing·후방 기준 los.totalDistance
  //   (등거리근사)를 써서 sibling 메트릭(bearingDeg/haversine)과 체계가 어긋났음 — 전부 단일화.)
  const bDistKm = haversineKm(radar.latitude, radar.longitude, building.latitude, building.longitude);
  const bAzDeg = bearingDeg(radar.latitude, radar.longitude, building.latitude, building.longitude);
  // 건물별 방위 허용각 — ±10° 고정 캡 제거: 각폭 넓은 근접 대상도 노출면 전체(+1° 마진)를 커버.
  //   Az×Elev 차트 창(azHalfSpan = max(반각폭+1°, 2°)) ⊆ 이 허용각 — 차트 창 안 소실 점 누락 없음.
  const azTolDeg = classifyAzToleranceDeg(radar.latitude, radar.longitude, building, bAzDeg);

  // 차단각 = panorama 실루엣 방위별 max(ITU 4/3 유효지구). with(지형+기존지물+분석대상) − without(분석대상 제외) = '대상 추가 차단'.
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
  const losses: ClassifiedLoss[] = [];
  for (const lp of lossPoints) {
    const lpDistKm = haversineKm(radar.latitude, radar.longitude, lp.lat, lp.lon);
    const lpAz = bearingDeg(radar.latitude, radar.longitude, lp.lat, lp.lon);
    let azDiff = Math.abs(lpAz - bAzDeg);
    if (azDiff > 180) azDiff = 360 - azDiff;
    if (azDiff > azTolDeg) continue;
    if (lpDistKm <= bDistKm + 0.01) continue;
    // 오귀속 방지(#4): '다른' 분석 대상이 이 소실표적을 더 강하게 소유하면 본 건물 집계서 제외.
    //   결정론적 전순서 — 방위 근접 > 거리 근접 > 작은 방위값 > 작은 id → 정확히 한 건물만 카운트.
    //   (같은 위치 중복 건물 등 완전동률도 id 로 단독 소유 결정 → 중복 카운트 원천 차단)
    //   자기 기준값(bAzDeg·bDistKm)이 sibling(buildSiblings)과 동일 산식이라 azDiff/거리 비교가 대칭.
    let ownedByOther = false;
    for (const s of siblings) {
      let sd = Math.abs(lpAz - s.azDeg);
      if (sd > 180) sd = 360 - sd;
      // claim 가능성 검사 — 그 sibling 자기 pass 와 동일 조건(방위차 ≤ 그 건물의 허용각 && 대상 후방)을
      //   통과하는 sibling 만 소유권 대상. (종전: 방위 근접만으로 무조건 양보 → 소유권 가져간 sibling 이
      //   자기 pass 의 창/후방 조건에서 그 점을 못 받으면 소실표적이 모든 건물 집계에서 누락되는 구멍.)
      if (sd > s.azTolDeg || lpDistKm <= s.distKm + 0.01) continue;
      const tieAz = Math.abs(sd - azDiff) <= 1e-9;
      const tieDist = Math.abs(s.distKm - bDistKm) <= 1e-9;
      const tieAzDeg = Math.abs(s.azDeg - bAzDeg) <= 1e-9;
      if (sd < azDiff - 1e-9                                      // 방위 근접
        || (tieAz && s.distKm < bDistKm - 1e-9)                   // 동률 → 거리 근접
        || (tieAz && tieDist && s.azDeg < bAzDeg - 1e-9)          // +동률 → 작은 방위값
        || (tieAz && tieDist && tieAzDeg && s.id < building.id)) { // +완전동률(동일 위치) → 작은 id (fail-safe)
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

  // 집계 — 스키마 계약: '…건'(이벤트 건수)은 distinct event_id, 소실시간 합산은 Σ share_s(같은 gap 보간점 합 = gap),
  //   점 단위 카운트(shadowCount/buildingCount)는 차트 점·'소실표적 수' 라벨용으로 유지.
  //   (종전 buildingDurationS 는 점마다 durationS(=부모 gap 전체)를 합산 → 보간점 수 × gap 과대 — Σ share_s 로 교정.)
  //   이벤트 분류는 any-point 규칙: 그 이벤트의 보간점 중 1개 이상이 해당 분류면 그 이벤트로 집계
  //   (buildingCaused ⇒ inShadow 이므로 buildingEventCount ⊆ shadowEventCount, 총합 보존).
  let shadowCount = 0;
  let buildingCount = 0;
  let buildingDurationS = 0;
  const totalEventIds = new Set<number>();
  const shadowEventIds = new Set<number>();
  const buildingEventIds = new Set<number>();
  for (const l of losses) {
    totalEventIds.add(l.source.event_id);
    if (l.inShadow) {
      shadowCount++;
      shadowEventIds.add(l.source.event_id);
    }
    if (l.buildingCaused) {
      buildingCount++;
      buildingEventIds.add(l.source.event_id);
      buildingDurationS += l.source.share_s;
    }
  }

  return {
    bDistKm, bAzDeg, azTolDeg, angleTotalDeg, angleTerrainDeg, losses,
    shadowCount, buildingCount, buildingDurationS,
    totalEventCount: totalEventIds.size,
    shadowEventCount: shadowEventIds.size,
    buildingEventCount: buildingEventIds.size,
  };
}

/**
 * LoS 단면도 차단(blocked) 판정 — 소실표적 분류(classifyObstacleLosses)와 동일한 panorama 실루엣 소스·동일 양각식으로 통일.
 *   표적(건물 top) 양각 < 차단각(panorama, 건물 방위) → 차단.
 *   소실표적 inShadow(lpElevDeg < angleWith)와 동일 프레임·동일 pointElevAngleDeg(ITU 4/3) 사용. 단,
 *   소실표적은 대상 건물 '뒤'라 angleWith(표적 포함)로 보지만, **표적 건물 자신**은 실루엣에서 빠져야 한다
 *   (panoWith 로 표적 방위를 샘플하면 표적 자신이 self-block → 항상 차단). 따라서 **panoWithout**(분석대상 제외)만 사용 —
 *   이는 요약표 angleTerrainDeg(=angleWithoutAt(bAz))와 동일 값이라 표·배지가 일관된다.
 *   ※ panorama 는 거리축이 없어(max-over-distance) 표적 너머 지형도 실루엣에 포함 → chord 코리도 단면도 차트와
 *     어긋날 수 있음(의도된 통일 — 단면도 차트는 코리도 시각화 유지, blocked 판정만 panorama 로 통일).
 *   panoWithout 미제공(Rust 제외대상 0/리로드) 시 null → 호출부가 chord(los.losBlocked)로 폴백.
 *   chord 판정도 분석 대상 자신을 제외(computeLosBatch·excludeTargetBuildings)하므로 폴백 역시 self-block 없음.
 */
export function losBlockedFromPanorama(
  radar: RadarSite,
  building: ManualBuilding,
  _los: LoSProfileData,
  panoWithout?: PanoramaMergeResult,
): boolean | null {
  if (!panoWithout) return null;
  const sampler = makePanoramaSampler(panoWithout);
  const radarH = radar.altitude + radar.antenna_height;
  // bDistKm·bAzDeg 는 classifyObstacleLosses 와 동일 산식(bearingDeg·haversineKm 단일화)으로 통일 —
  //   요약표 '대상 차단각'(angleTotalDeg, classify bAzDeg 샘플)과 배지가 같은 방위·거리 기준을 쓴다.
  //   (_los 는 호출부(ReportApp·ReportOMObstacleDetail) 시그니처 호환용으로 유지 — 산식 단일화 후 미사용.)
  const bDistKm = haversineKm(radar.latitude, radar.longitude, building.latitude, building.longitude);
  const bAzDeg = bearingDeg(radar.latitude, radar.longitude, building.latitude, building.longitude);
  const targetTopM = (building.ground_elev ?? 0) + building.height;
  const targetElevDeg = pointElevAngleDeg(radarH, targetTopM, bDistKm * 1000);
  return targetElevDeg < sampler(bAzDeg);
}
