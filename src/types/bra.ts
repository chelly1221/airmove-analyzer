/** BRA(Building Restricted Area) 침범 검사 — Rust analysis/bra.rs 미러 (snake_case 그대로) */

/** BRA 원추면을 침범한 건물 1동 */
export interface BraBuilding {
  /** fac_buildings.id 또는 manual_buildings.id */
  id: number;
  /** "fac" | "manual" */
  source: string;
  /** 실측(1m DSM) 지붕고 반영 여부 */
  measured: boolean;
  name: string | null;
  /** fac = dong_name, manual = memo */
  address: string | null;
  usage: string | null;
  /** centroid 위도 */
  lat: number;
  /** centroid 경도 */
  lon: number;
  /** 판정 지점(레이더 최근접 정점)까지 지표 거리 (km) */
  distance_km: number;
  /** centroid 방위 (°, 정북=0, 시계방향) */
  azimuth_deg: number;
  /** 지반 표고 (m AMSL) */
  ground_elev_m: number;
  /** 건물 높이 (m, AGL) */
  height_m: number;
  /** 지붕 해발고 (m AMSL) */
  total_height_m: number;
  /** 판정 지점의 원추면 해발고 (m AMSL) */
  cone_msl_m: number;
  /** 초과량 (m) = total_height_m − cone_msl_m */
  exceed_m: number;
  /** 폴리곤 꼭짓점 [[lat, lon], ...] */
  polygon: [number, number][];
}

/** BRA 침범 검사 결과 */
export interface BraResult {
  /** 기준각 (°) */
  angle_deg: number;
  /** 안테나 정점 해발고 (m AMSL) */
  radar_height_m: number;
  /** 스캔 반경 (km) — 요청 반경과 해석적 상한 중 작은 쪽 */
  max_range_km: number;
  /** 검사한 건물 수 (fac + manual) */
  scanned: number;
  /** 침범 총수 (truncate 전) */
  total_penetrating: number;
  /** 상한 초과로 잘렸는지 */
  truncated: boolean;
  /** 침범 건물 (exceed_m 내림차순, 최대 2,000동) */
  buildings: BraBuilding[];
}
