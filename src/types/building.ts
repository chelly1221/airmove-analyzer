/** LOS 경로 상의 건물 */
export interface BuildingOnPath {
  distance_km: number;
  /** LOS 경로 상 건물 시작 거리 (km) — 도형 건물은 near < far */
  near_dist_km: number;
  /** LOS 경로 상 건물 끝 거리 (km) */
  far_dist_km: number;
  height_m: number;
  ground_elev_m: number;
  total_height_m: number;
  name: string | null;
  address: string | null;
  usage: string | null;
  lat: number;
  lon: number;
}

/** 건물 데이터 임포트 상태 */
export interface BuildingImportStatus {
  region: string;
  file_date: string;
  imported_at: number;
  record_count: number;
}

/** 도형 유형 */
export type GeometryType = "point" | "rectangle" | "circle" | "line" | "multi";

/** 건물 그룹 */
export interface BuildingGroup {
  id: number;
  name: string;
  /** 색상 (hex) */
  color: string;
  memo: string;
  has_plan_image: boolean;
  plan_bounds_json: string | null;
  plan_opacity: number;
}

/** 토지이용계획도 오버레이 경계 (4코너 좌표) */
export interface PlanImageBounds {
  topLeft: [number, number];      // [lat, lon]
  topRight: [number, number];
  bottomRight: [number, number];
  bottomLeft: [number, number];
}

/** 수동 등록 건물 */
export interface ManualBuilding {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  /** 건물 높이 (m) */
  height: number;
  /** 지면 표고 (m) */
  ground_elev: number;
  memo: string;
  /** 도형 유형 */
  geometry_type: GeometryType;
  /** 도형 좌표 JSON */
  geometry_json: string | null;
  /** 소속 그룹 ID (null이면 미분류) */
  group_id: number | null;
}
