/**
 * 타일 기반 3D 건물 캐시 모듈
 *
 * 뷰포트를 고정 타일 그리드로 분할하여 건물 데이터를 캐싱.
 * - Binary Float64Array 전송으로 JSON 직렬화 오버헤드 제거
 * - 점진적 로딩 (높은 건물 우선, 3단계 우선순위)
 * - 이미 로드된 타일은 재쿼리하지 않음
 * - 카메라 앵커 기반 거리 링 필터(줌 14 이상, 3D 영역 전용): 앵커(카메라 지상점)에서 먼 타일일수록
 *   높은 건물만 로드(d≤3km 전체·d≤7km 20m+·d≤15km 40m+·그 외 60m+). 줌 14 미만(2D 점 모드)은
 *   원래대로 줌별 minHeight 만 사용해 점 표시 완전성 유지.
 * - 앵커 거리 오름차순으로 근경부터 채운 뒤 타일 상한(MAX_TILES_PER_FETCH)으로 하드캡 (줌 무관).
 *   (뷰포트 클램프 자체도 줌 14+ 에서만 호출부 TrackMap 이 수행 — 피치 시 bounds 가 지평선까지
 *    확장되어 수백 km² 타일이 fetch 되는 것을 앵커±반경 박스로 제한)
 */

import { invoke } from "@tauri-apps/api/core";
import type { Building3D } from "../types";

// ── 타일 설정 ──────────────────────────────────────────────────

/** 줌별 타일 크기 (도) */
function tileSize(zoom: number): number {
  if (zoom >= 16) return 0.005;  // ~550m
  if (zoom >= 14) return 0.01;   // ~1.1km
  if (zoom >= 12) return 0.05;   // ~5.5km
  return 0.1;                    // ~11km
}

/** 줌별 최소 건물 높이 필터 */
function minHeight(zoom: number): number {
  if (zoom >= 16) return 3;
  if (zoom >= 14) return 10;
  if (zoom >= 12) return 30;
  return 60;
}

// ── Binary 디코딩 ──────────────────────────────────────────────

interface Buildings3DBinaryResult {
  coords: string;      // base64-encoded Float64Array (LE)
  meta: { name: string | null; usage: string | null; source: string; group_color?: string; measured?: boolean }[];
  count: number;
}

/**
 * base64 decode + 건물 unpack을 별도 Worker에서 수행 (메인 스레드 블로킹 방지)
 * atob()가 대량 데이터(~1-3MB)에서 100-400ms 블로킹 유발하므로 인라인 Worker 사용
 */
function unpackBuildingsOffThread(
  coordsB64: string,
  meta: Buildings3DBinaryResult["meta"],
  count: number,
): Promise<Building3D[]> {
  if (count === 0) return Promise.resolve([]);

  return new Promise((resolve, reject) => {
    // 포맷: [lon, lat, ground_elev, height, vertexCount, v0_lon, v0_lat, ...]
    const code = `self.onmessage=function(e){
try{
  var b64=e.data.coords,meta=e.data.meta,count=e.data.count;
  var raw=atob(b64),buf=new Uint8Array(raw.length);
  for(var i=0;i<raw.length;i++)buf[i]=raw.charCodeAt(i);
  var floats=new Float64Array(buf.buffer);
  var buildings=[],offset=0;
  for(var i=0;i<count;i++){
    var lon=floats[offset++],lat=floats[offset++],g=floats[offset++],h=floats[offset++],vc=floats[offset++];
    var poly=[];
    for(var v=0;v<vc;v++){var vlon=floats[offset++];var vlat=floats[offset++];poly.push([vlat,vlon]);}
    var m=meta[i];
    buildings.push({lat:lat,lon:lon,height_m:h,ground_elev_m:g,polygon:poly,name:m.name,usage:m.usage,source:m.source,group_color:m.group_color,measured:!!m.measured});
  }
  postMessage(buildings);
}catch(err){postMessage({error:String(err)})}
}`;
    const blob = new Blob([code], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    const w = new Worker(url);
    w.onmessage = (e) => {
      if (Array.isArray(e.data)) resolve(e.data as Building3D[]);
      else reject(new Error(e.data?.error ?? "Building unpack failed"));
      w.terminate();
      URL.revokeObjectURL(url);
    };
    w.onerror = (err) => { reject(err); w.terminate(); URL.revokeObjectURL(url); };
    w.postMessage({ coords: coordsB64, meta, count });
  });
}

// ── 타일 캐시 ──────────────────────────────────────────────────

interface TileCacheEntry {
  buildings: Building3D[];
  minHeight: number;
  timestamp: number;
}

/** 타일 키 (출처 시그니처 + 그리드 인덱스).
 * srcSig를 포함해야 출처 토글 직후, 이전 출처로 진행 중이던 fetch가
 * 캐시 무효화 후 늦게 _cache.set 하더라도 새 출처 로드가 그 타일을 히트로
 * 오인하지 않는다 (출처 교차 오염 방지). */
function tileKey(latIdx: number, lonIdx: number, size: number, srcSig: string): string {
  return `${srcSig}_${size}_${latIdx}_${lonIdx}`;
}

// 글로벌 캐시
const _cache = new Map<string, TileCacheEntry>();
let _cacheZoomLevel = -1; // 캐시가 생성된 줌 레벨 (타일 크기 변경 시 무효화)

/** 캐시 초기화 (레이더 변경, 소스 토글 시) */
export function invalidateBuildingCache(): void {
  _cache.clear();
  _cacheZoomLevel = -1;
}

// ── 뷰포트 타일 쿼리 ──────────────────────────────────────────

interface ViewportBounds {
  south: number;
  north: number;
  west: number;
  east: number;
  zoom: number;
}

interface FetchResult {
  /** 뷰포트 내 모든 건물 (캐시 + 신규) */
  buildings: Building3D[];
  /** 캐시 히트 타일 수 */
  cacheHits: number;
  /** 새로 로드한 타일 수 */
  fetched: number;
}

/** 한 fetch 에서 처리할 최대 타일 수 (근접 정렬 후 하드캡) */
const MAX_TILES_PER_FETCH = 256;

/** 위경도 근사 거리 환산 (km/도) — equirectangular 근사에 충분 */
const KM_PER_DEG = 111.32;

/**
 * 앵커 거리(km)별 요구 최소 건물 높이 (거리 링 필터).
 * 먼 타일일수록 큰 건물만 로드해 fill-extrusion 부하를 줄인다.
 */
function ringMinHeight(distKm: number): number {
  if (distKm <= 3) return 0;   // 근경: 추가 필터 없음
  if (distKm <= 7) return 20;
  if (distKm <= 15) return 40;
  return 60;
}

/**
 * 뷰포트 영역의 건물을 타일 기반으로 조회.
 * 이미 캐시된 타일은 재쿼리하지 않고, 새 타일만 binary IPC로 로드.
 *
 * @param bounds 뷰포트 범위 (호출부에서 앵커±반경으로 클램프된 범위)
 * @param excludeSources 제외할 출처
 * @param onProgress 점진적 로딩 콜백 (새 타일 로드될 때마다 전체 건물 배열 전달)
 * @param anchor 카메라 지상점 {lat, lon} — 거리 링 필터/근접 정렬 기준 (미전달 시 bounds 중심)
 */
export async function fetchBuildingsForViewport(
  bounds: ViewportBounds,
  excludeSources: string[],
  onProgress?: (buildings: Building3D[]) => void,
  anchor?: { lat: number; lon: number },
): Promise<FetchResult> {
  const { south, north, west, east, zoom } = bounds;
  const size = tileSize(zoom);
  const minH = minHeight(zoom);
  // 출처 시그니처 — 캐시 키에 포함하여 출처별 타일을 분리 (정렬로 순서 무관)
  const srcSig = excludeSources.length ? [...excludeSources].sort().join(",") : "all";

  // 거리 링 필터/근접 정렬 기준 앵커 — 미전달 시 bounds 중심
  const anchorLat = anchor ? anchor.lat : (south + north) / 2;
  const anchorLon = anchor ? anchor.lon : (west + east) / 2;
  const cosLat = Math.cos(anchorLat * Math.PI / 180);
  // 타일 중심 ↔ 앵커 거리 (km, equirectangular 근사)
  const tileDistKm = (li: number, lj: number): number => {
    const cLat = (li + 0.5) * size;
    const cLon = (lj + 0.5) * size;
    const dy = (cLat - anchorLat) * KM_PER_DEG;
    const dx = (cLon - anchorLon) * KM_PER_DEG * cosLat;
    return Math.sqrt(dx * dx + dy * dy);
  };

  // 줌 레벨에 따른 타일 크기가 변경되면 캐시 무효화
  if (_cacheZoomLevel !== -1 && tileSize(_cacheZoomLevel) !== size) {
    _cache.clear();
  }
  _cacheZoomLevel = zoom;

  // 뷰포트에 겹치는 타일 인덱스 계산
  const latStart = Math.floor(south / size);
  const latEnd = Math.floor(north / size);
  const lonStart = Math.floor(west / size);
  const lonEnd = Math.floor(east / size);

  const cachedTiles: string[] = [];
  // tileReq: 타일별 요구 최소높이 = max(줌 최소높이, 거리 링값). dist: 앵커 거리(km)
  const missingTiles: { key: string; latIdx: number; lonIdx: number; tileReq: number; dist: number }[] = [];

  for (let li = latStart; li <= latEnd; li++) {
    for (let lj = lonStart; lj <= lonEnd; lj++) {
      const dist = tileDistKm(li, lj);
      // 거리 링 필터는 3D fill-extrusion 렉 방지 전용이라 줌 14 이상에서만 적용.
      // 줌 14 미만(2D 점 모드)은 원래대로 줌별 minHeight 만 사용해 점 표시 완전성을 복원한다.
      // 카메라 이동으로 먼 타일이 가까워지면 tileReq 가 낮아져 아래 히트 판정이 어긋나
      // 기존 업그레이드(재쿼리) 경로로 자동 재로드된다. (dist 는 줌 무관하게 근접 정렬에 사용)
      const tileReq = zoom >= 14 ? Math.max(minH, ringMinHeight(dist)) : minH;
      const key = tileKey(li, lj, size, srcSig);
      const entry = _cache.get(key);
      if (entry && entry.minHeight <= tileReq) {
        cachedTiles.push(key);
      } else {
        missingTiles.push({ key, latIdx: li, lonIdx: lj, tileReq, dist });
      }
    }
  }

  // 근접 우선: 앵커 거리 오름차순 정렬 → 진행 콜백에서 근경부터 채워짐
  missingTiles.sort((a, b) => a.dist - b.dist);

  // 타일 하드캡: 상한 초과 시 근경 우선으로 앞부분만 처리하고 드롭 수 로그 (침묵 절단 금지)
  if (missingTiles.length > MAX_TILES_PER_FETCH) {
    const dropped = missingTiles.length - MAX_TILES_PER_FETCH;
    console.warn(`건물 타일 상한 초과 — 근경 ${MAX_TILES_PER_FETCH}개만 로드, ${dropped}개 드롭 (요청 ${missingTiles.length})`);
    missingTiles.length = MAX_TILES_PER_FETCH;
  }

  // 캐시에서 즉시 수집 가능한 건물
  const collectAll = (): Building3D[] => {
    const result: Building3D[] = [];
    // 뷰포트 범위 내 캐시된 타일
    for (let li = latStart; li <= latEnd; li++) {
      for (let lj = lonStart; lj <= lonEnd; lj++) {
        const key = tileKey(li, lj, size, srcSig);
        const entry = _cache.get(key);
        if (entry) {
          for (const b of entry.buildings) {
            result.push(b);
          }
        }
      }
    }
    return result;
  };

  // 캐시만으로 충분하면 즉시 반환
  if (missingTiles.length === 0) {
    return { buildings: collectAll(), cacheHits: cachedTiles.length, fetched: 0 };
  }

  // 누락 타일이 있으면 먼저 캐시 데이터로 진행률 콜백
  if (onProgress && cachedTiles.length > 0) {
    onProgress(collectAll());
  }

  // 점진적 로딩: 높은 건물 → 중간 → 전체 (3단계)
  // 1단계: 높이 50m+ (빠르게 스카이라인 형성)
  // 2단계: 높이 20m+ (대부분의 건물)
  // 3단계: minH 이상 (전체)
  // stage.minH 는 "스테이지 하한(floor)"일 뿐이고, 실제 타일 목표는 max(stage.minH, tileReq).
  // dedupe filter 는 동일 floor 를 갖는 중복 스테이지만 제거하므로 거리 링(tileReq) 변경과 무관하게 안전.
  const stages = zoom >= 14
    ? [
        { minH: Math.max(50, minH), label: "tall" },
        { minH: Math.max(20, minH), label: "mid" },
        { minH, label: "all" },
      ].filter((s, i, arr) => i === arr.length - 1 || s.minH > arr[arr.length - 1].minH)
    : [{ minH, label: "all" }]; // 줌이 낮으면 단일 단계

  let fetched = 0;

  for (const stage of stages) {
    // 이 단계에서 로드할 타일 (타일 목표 = max(stage.minH, tileReq); 이미 충족된 타일은 스킵)
    const tilesToFetch = missingTiles.filter(t => {
      const target = Math.max(stage.minH, t.tileReq);
      const entry = _cache.get(t.key);
      return !entry || entry.minHeight > target;
    });

    if (tilesToFetch.length === 0) continue;

    // 병렬 타일 쿼리 (최대 4개 동시)
    const batchSize = 4;
    for (let bi = 0; bi < tilesToFetch.length; bi += batchSize) {
      const batch = tilesToFetch.slice(bi, bi + batchSize);
      const promises = batch.map(async ({ key, latIdx, lonIdx, tileReq }) => {
        // 타일 목표 = max(스테이지 하한, 거리 링 요구치) — 마지막 스테이지 후 각 타일은 tileReq 수준 도달
        const target = Math.max(stage.minH, tileReq);
        const tileSouth = latIdx * size;
        const tileNorth = (latIdx + 1) * size;
        const tileWest = lonIdx * size;
        const tileEast = (lonIdx + 1) * size;

        try {
          const result = await invoke<Buildings3DBinaryResult>("query_buildings_3d_binary", {
            minLat: tileSouth,
            maxLat: tileNorth,
            minLon: tileWest,
            maxLon: tileEast,
            minHeightM: target,
            maxCount: 15000,
            excludeSources,
          });

          const buildings = await unpackBuildingsOffThread(result.coords, result.meta, result.count);
          _cache.set(key, {
            buildings,
            minHeight: target,
            timestamp: Date.now(),
          });
          fetched++;
        } catch (err) {
          // 쿼리 실패 시 빈 타일로 캐시 (재시도 방지)
          console.warn(`타일 ${key} 로드 실패:`, err);
          _cache.set(key, { buildings: [], minHeight: target, timestamp: Date.now() });
        }
      });

      await Promise.all(promises);

      // 배치 완료 후 진행률 콜백
      if (onProgress) {
        onProgress(collectAll());
      }
    }
  }

  return {
    buildings: collectAll(),
    cacheHits: cachedTiles.length,
    fetched,
  };
}

// ── MapLibre GeoJSON 변환 ──────────────────────────────────────

/**
 * Building3D[] → MapLibre fill-extrusion용 GeoJSON FeatureCollection
 * 3D 렌더링은 MapLibre 네이티브 fill-extrusion으로 처리
 */
export function buildingsToGeoJSON(buildings: Building3D[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const b of buildings) {
    if (b.polygon.length < 3) continue;
    // 폴리곤 좌표: [lat, lon] → [lon, lat] 변환 + 폐합
    const coords = b.polygon.map(([lat, lon]) => [lon, lat]);
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      coords.push([...first]);
    }

    features.push({
      type: "Feature",
      properties: {
        height: b.height_m,
        base: b.ground_elev_m, // AMSL 지반고 — 팝업 표시용 (fill-extrusion base 는 지도면 위 상대 오프셋이라 사용 금지)
        name: b.name || "",
        usage: b.usage || "",
        source: b.source,
        group_color: b.group_color || null,
        // 실측(1m DSM) 보유 여부 — 메시 타일 표출 중 박스를 근투명 처리하는 표현식 조건
        measured: !!b.measured,
        lat: b.lat,
        lon: b.lon,
      },
      geometry: {
        type: "Polygon",
        coordinates: [coords],
      },
    });
  }
  return { type: "FeatureCollection", features };
}
