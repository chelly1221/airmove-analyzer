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
  /** 판정 지점(레이더 최근접 경계점)까지 지표 거리 (km) */
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
  /** 침범 총수 (= buildings.length) */
  total_penetrating: number;
  /** 폴리곤 파싱 실패/3점 미만으로 판정 불가 처리된 fac 후보 동수 */
  skipped_invalid_polygon: number;
  /** 대장 이중 임포트(광역본↔세분본 비트 동일 행)로 결과에서 접힌 행 수 — 구빌드 호환 옵셔널 */
  folded_duplicates?: number;
  /** 침범 건물 (exceed_m 내림차순, 전수) */
  buildings: BraBuilding[];
}
