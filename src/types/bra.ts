/** BRA(Building Restricted Area) 침범 검사 — Rust analysis/bra.rs 미러 (snake_case 그대로) */

/** BRA 원추면을 침범한 건물 1동 */
export interface BraBuilding {
  /** fac_buildings.id · manual_buildings.id · tower_cranes.id */
  id: number;
  /** "fac" | "manual" | "crane" */
  source: string;
  /** 실측(1m DSM) 지붕고 반영 여부 */
  measured: boolean;
  name: string | null;
  /** fac = dong_name, manual·crane = memo */
  address: string | null;
  /** crane = 최대 초과 부위(마스트/지브/카운터지브/선회 범위) */
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

/** 타워크레인 1기의 지브 방위각 스윕 판정 — 방위를 1° 씩 돌려 본 초과량 곡선과 최악/최선 방위.
 *  초과량은 부호를 유지한다(양수 = 원추면 침범, 음수 = 여유). */
export interface BraCraneSweep {
  /** tower_cranes.id */
  id: number;
  name: string;
  lat: number;
  lon: number;
  /** 마스트 중심까지 지표 거리 (km) */
  distance_km: number;
  /** 레이더 → 크레인 방위 (°, 정북=0, 시계방향) */
  azimuth_deg: number;
  /** 등록 상태 스냅샷 — 선회 모드 'fixed' | 'full' */
  rotation_mode: string;
  /** 등록 상태 스냅샷 — 지브 방위각 (°) */
  jib_azimuth_deg: number;
  /** 마스트 단독(방위 무관) 초과량 (m) */
  mast_exceed_m: number;
  /** 현재 등록 상태(선회 모드·방위각)의 초과량 (m) — 침범 행 exceed_m 과 같은 정의(음수 유지) */
  current_exceed_m: number;
  /** 초과량이 최대인 방위각 (°, 첫 등장) */
  worst_deg: number;
  /** 그 방위의 초과량 (m) */
  worst_exceed_m: number;
  /** 초과량이 최소인 방위각 (°, 첫 등장) */
  best_deg: number;
  /** 그 방위의 초과량 (m) */
  best_exceed_m: number;
  /** 전방위 최악조건 초과량 (m) — 선회 범위 원판(반경 max(지브, 카운터지브)) 기준.
   *  등록 선회 모드와 무관하게 항상 산출된다. */
  full_exceed_m: number;
  /** θ = 0..359° 각각을 고정 지브로 봤을 때의 초과량 (m, 길이 360) */
  exceed_by_deg: number[];
}

/** BRA 침범 검사 결과 */
export interface BraResult {
  /** 기준각 (°) */
  angle_deg: number;
  /** 안테나 정점 해발고 (m AMSL) */
  radar_height_m: number;
  /** 스캔 반경 (km) — 요청 반경과 해석적 상한 중 작은 쪽 */
  max_range_km: number;
  /** 검사한 건물 수 (fac + manual + crane) */
  scanned: number;
  /** 침범 총수 (= buildings.length) */
  total_penetrating: number;
  /** 폴리곤 파싱 실패/3점 미만으로 판정 불가 처리된 fac 후보 동수 */
  skipped_invalid_polygon: number;
  /** 대장 이중 임포트(광역본↔세분본 비트 동일 행)로 결과에서 접힌 행 수 — 구빌드 호환 옵셔널 */
  folded_duplicates?: number;
  /** 침범 건물 (exceed_m 내림차순, 전수) */
  buildings: BraBuilding[];
  /** 반경 내 타워크레인 방위각 스윕 (등록 순, 침범 여부 무관) */
  cranes: BraCraneSweep[];
}
