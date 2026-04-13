/** LoS 경로 상의 건물 */
export interface BuildingOnPath {
  distance_km: number;
  /** LoS 경로 상 건물 시작 거리 (km) — 도형 건물은 near < far */
  near_dist_km: number;
  /** LoS 경로 상 건물 끝 거리 (km) */
  far_dist_km: number;
  height_m: number;
  ground_elev_m: number;
  total_height_m: number;
  name: string | null;
  address: string | null;
  usage: string | null;
  lat: number;
  lon: number;
  /** 건물 폴리곤 좌표 [[lat,lon],...] (WGS84) — 3D 렌더링용 */
  polygon?: [number, number][];
  /** 수동 등록 건물 여부 (true이면 ground_elev_m은 사용자 입력값) */
  is_manual: boolean;
}

/** 3D 건물 데이터 (맵 뷰포트 내 건물) */
export interface Building3D {
  lat: number;
  lon: number;
  /** 건물 자체 높이 (m) */
  height_m: number;
  /** 지반 표고 (m, AMSL) — fill-extrusion base */
  ground_elev_m: number;
  /** 건물 폴리곤 좌표 [[lat,lon],...] (WGS84) */
  polygon: [number, number][];
  name: string | null;
  usage: string | null;
  /** 데이터 출처: "fac", "manual" */
  source: string;
  /** 건물 그룹 색상 (수동 건물만, 예: "#ef4444") */
  group_color?: string;
}

/** 인근 산봉우리 (query_nearby_peaks 결과) */
export interface NearbyPeak {
  name: string;
  height_m: number | null;
  latitude: number;
  longitude: number;
  distance_km: number;
}

/** 산봉우리 임포트 상태 */
export interface PeakImportStatus {
  file_name: string;
  imported_at: number;
  record_count: number;
}

/** SRTM 타일 상태 [타일 수, 최신 다운로드 일시(epoch)] */
export type SrtmStatus = [number, number] | null;

/** 도형 유형 */
export type GeometryType = "polygon" | "multi";

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
  plan_rotation: number;
  /** 그룹 영역 바운드 JSON: [[minLat, minLon], [maxLat, maxLon]] */
  area_bounds_json: string | null;
  /** 활성화 여부 (false이면 LoS/커버리지/3D 렌더링에서 제외) */
  enabled: boolean;
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
