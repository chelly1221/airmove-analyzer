/** 타워크레인 등록 — Rust crane.rs 미러 (조회 응답은 snake_case 그대로).
 *  1단계 분석 반영 범위 = BRA 침범 검사만. LoS 단면도·파노라마·커버리지·OM/의견서는 미반영
 *  (지브는 밑면이 떠 있어 지상기립 프리즘을 전제하는 경로에 넣으면 오판 — 2단계 base_m 지원 후). */

/** 지브 선회 모드 — fixed = 등록 방위각 고정 / full = 전방위 회전 최악조건 */
export type CraneRotationMode = "fixed" | "full";

/** 등록된 타워크레인 1기 (list_tower_cranes 응답 행) */
export interface TowerCrane {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  /** 지반 표고 (m AMSL) — 저장값이 곧 계약 (manual_buildings 와 동일) */
  ground_elev: number;
  /** 'auto' = SRTM 스냅샷 / 'manual' = 직접 입력 */
  elev_mode: "auto" | "manual";
  /** 지브 설치고 (지브 하단, m AGL) */
  jib_height: number;
  /** 최상단(타워탑/캣헤드 정점, m AGL) ≥ jib_height */
  top_height: number;
  /** 지브 길이 (m, 마스트 중심 기준) */
  jib_length: number;
  /** 카운터지브 길이 (m) */
  counter_jib_length: number;
  /** 지브 방위각 (°, 정북 0 · 시계방향) */
  jib_azimuth_deg: number;
  rotation_mode: CraneRotationMode;
  /** 마스트 단면 폭 (m, 정사각) */
  mast_width: number;
  memo: string;
}

/** 등록·수정 커맨드 입력 (Rust 측 #[serde(rename_all = "camelCase")]) */
export interface TowerCraneInput {
  name: string;
  latitude: number;
  longitude: number;
  groundElev: number;
  elevMode: "auto" | "manual";
  jibHeight: number;
  topHeight: number;
  jibLength: number;
  counterJibLength: number;
  jibAzimuthDeg: number;
  rotationMode: CraneRotationMode;
  mastWidth: number;
  memo: string;
}
