//! LoS 경로 건물 쿼리 및 수동 건물 관리
//!
//! LoS 경로 상의 건물을 조회하여 높이 정보를 반환하고,
//! 수동 등록 건물 및 건물 그룹 CRUD를 제공.

use std::io::{Read as IoRead, Seek};
use std::path::Path;

use encoding_rs::EUC_KR;
use rusqlite::{params, Connection};
use serde::Serialize;
use shapefile::dbase::FieldValue;

use crate::coord::epsg5186_to_wgs84;

/// 건물 높이 상한 (m) — 한국 최고층 롯데월드타워 ~555m, 여유 포함 650m
const MAX_BUILDING_HEIGHT_M: f64 = 650.0;

// ─── 2D 기하학 헬퍼 (LoS 직선-건물 교차) ──────────────

/// 2D 선분 교차: (ax,ay)→(bx,by)와 (cx,cy)→(dx,dy)
/// 반환: Some(t) — AB 상 교차점 위치 (0=A, 1=B)
fn line_seg_intersect_t(
    ax: f64, ay: f64, bx: f64, by: f64,
    cx: f64, cy: f64, dx: f64, dy: f64,
) -> Option<f64> {
    let rx = bx - ax;
    let ry = by - ay;
    let sx = dx - cx;
    let sy = dy - cy;
    let denom = rx * sy - ry * sx;
    if denom.abs() < 1e-15 {
        return None; // 평행
    }
    let t = ((cx - ax) * sy - (cy - ay) * sx) / denom;
    let u = ((cx - ax) * ry - (cy - ay) * rx) / denom;
    if t >= 0.0 && t <= 1.0 && u >= 0.0 && u <= 1.0 {
        Some(t)
    } else {
        None
    }
}

/// 점이 폴리곤 내부인지 판정 (ray casting, (x,y) 좌표계)
fn point_in_polygon_2d(px: f64, py: f64, polygon: &[(f64, f64)]) -> bool {
    let n = polygon.len();
    if n < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = polygon[i];
        let (xj, yj) = polygon[j];
        if ((yi > py) != (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// LoS 직선과 폴리곤 교차 — 교차 거리(km) 목록 반환
/// 좌표계: (lon, lat) = (x, y)
fn line_polygon_intersections(
    r_lon: f64,
    r_lat: f64,
    t_lon: f64,
    t_lat: f64,
    poly: &[(f64, f64)], // (lon, lat) 쌍
    total_dist_km: f64,
) -> Vec<f64> {
    let n = poly.len();
    if n < 3 {
        return Vec::new();
    }
    let mut dists = Vec::new();
    for i in 0..n {
        let j = (i + 1) % n;
        if let Some(t) = line_seg_intersect_t(
            r_lon,
            r_lat,
            t_lon,
            t_lat,
            poly[i].0,
            poly[i].1,
            poly[j].0,
            poly[j].1,
        ) {
            dists.push(t.clamp(0.0, 1.0) * total_dist_km);
        }
    }
    dists
}

/// 수동 건물 geometry → 폴리곤 링 (lon, lat) 변환
/// polygon 좌표 배열 [[lat,lon],...] → Some(ring), 그 외 → None
fn manual_building_to_polygon_ring(
    _center_lat: f64,
    _center_lon: f64,
    geo_type: Option<&str>,
    geo_json: Option<&str>,
) -> Option<Vec<(f64, f64)>> {
    let gt = geo_type?;
    if gt != "polygon" {
        return None;
    }
    let json_str = geo_json.filter(|s| !s.is_empty())?;
    let val: serde_json::Value = serde_json::from_str(json_str).ok()?;

    if let Some(arr) = val.as_array() {
        let pts: Vec<(f64, f64)> = arr
            .iter()
            .filter_map(|p| {
                let lat = p.get(0)?.as_f64()?;
                let lon = p.get(1)?.as_f64()?;
                Some((lon, lat)) // (lon, lat) 순서
            })
            .collect();
        if pts.len() >= 3 {
            return Some(pts);
        }
    }
    None
}

/// LoS 경로 상의 건물 정보 (프론트엔드 반환)
#[derive(Serialize, Clone, Debug)]
pub struct BuildingOnPath {
    pub distance_km: f64,
    /// LoS 경로 상 건물 시작 거리 (km) — 도형 건물은 near < far
    pub near_dist_km: f64,
    /// LoS 경로 상 건물 끝 거리 (km)
    pub far_dist_km: f64,
    pub height_m: f64,
    pub ground_elev_m: f64,
    pub total_height_m: f64,
    pub name: Option<String>,
    pub address: Option<String>,
    pub usage: Option<String>,
    pub lat: f64,
    pub lon: f64,
    /// 건물 폴리곤 좌표 [[lat,lon],...] (WGS84) — 3D 렌더링용
    #[serde(skip_serializing_if = "Option::is_none")]
    pub polygon: Option<Vec<[f64; 2]>>,
    /// 수동 등록 건물 여부 (true이면 ground_elev_m은 사용자 입력값)
    pub is_manual: bool,
}

/// LoS 경로(레이더→타겟) 상의 건물 조회
pub fn query_buildings_along_path(
    conn: &Connection,
    radar_lat: f64,
    radar_lon: f64,
    target_lat: f64,
    target_lon: f64,
    corridor_width_m: f64,
) -> Result<Vec<BuildingOnPath>, String> {
    // bbox 버퍼: 건물 폴리곤이 centroid에서 벗어날 수 있으므로 넉넉하게 (최소 200m)
    let bbox_buffer_m = corridor_width_m.max(200.0);
    let buffer_deg = bbox_buffer_m / 111_000.0;

    let min_lat = radar_lat.min(target_lat) - buffer_deg;
    let max_lat = radar_lat.max(target_lat) + buffer_deg;
    let min_lon = radar_lon.min(target_lon) - buffer_deg;
    let max_lon = radar_lon.max(target_lon) + buffer_deg;

    let mut stmt = conn.prepare(
        "SELECT centroid_lat, centroid_lon, height, building_name, dong_name, usability, polygon_json
         FROM fac_buildings
         WHERE centroid_lat BETWEEN ?1 AND ?2
           AND centroid_lon BETWEEN ?3 AND ?4
           AND height > 0
           AND height <= ?5"
    ).map_err(|e| format!("쿼리 준비 실패: {}", e))?;

    let rows = stmt.query_map(
        params![min_lat, max_lat, min_lon, max_lon, MAX_BUILDING_HEIGHT_M],
        |row| {
            Ok((
                row.get::<_, f64>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        },
    ).map_err(|e| format!("쿼리 실행 실패: {}", e))?;

    let total_dist = crate::geo::haversine_km(radar_lat, radar_lon, target_lat, target_lon);
    if total_dist < 0.001 {
        return Ok(Vec::new());
    }

    let dx = target_lon - radar_lon;
    let dy = target_lat - radar_lat;
    let _path_len_sq = dx * dx + dy * dy;

    let mut buildings = Vec::new();

    for row in rows {
        let (_blat, _blon, height, name, address, usage, polygon_json_str) = row.map_err(|e| format!("행 읽기 실패: {}", e))?;

        // 폴리곤 좌표 파싱 시도
        let polygon_coords: Option<Vec<[f64; 2]>> = polygon_json_str.as_deref()
            .and_then(|s| serde_json::from_str(s).ok());

        if let Some(ref poly_pts) = polygon_coords {
            // 정확한 직선-폴리곤 교차 테스트 (복도 근사 대신 기하학적 교차)
            let poly_lonlat: Vec<(f64, f64)> =
                poly_pts.iter().map(|p| (p[1], p[0])).collect();

            let mut hit_distances = line_polygon_intersections(
                radar_lon, radar_lat, target_lon, target_lat,
                &poly_lonlat, total_dist,
            );

            // LoS 시작/끝점이 폴리곤 내부인 경우 (건물 안에서 시작/종료)
            if point_in_polygon_2d(radar_lon, radar_lat, &poly_lonlat) {
                hit_distances.push(0.0);
            }
            if point_in_polygon_2d(target_lon, target_lat, &poly_lonlat) {
                hit_distances.push(total_dist);
            }

            if hit_distances.is_empty() {
                continue;
            }

            let near_dist = hit_distances.iter().cloned().fold(f64::INFINITY, f64::min);
            let far_dist = hit_distances.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            let center_dist = (near_dist + far_dist) / 2.0;

            // 대표 좌표: 교차 구간 중심점
            let t_mid = (center_dist / total_dist).clamp(0.0, 1.0);
            let rep_lon = radar_lon + t_mid * dx;
            let rep_lat = radar_lat + t_mid * dy;

            buildings.push(BuildingOnPath {
                distance_km: center_dist,
                near_dist_km: near_dist,
                far_dist_km: far_dist,
                height_m: height,
                ground_elev_m: 0.0,
                total_height_m: height,
                name,
                address,
                usage,
                lat: rep_lat,
                lon: rep_lon,
                polygon: Some(poly_pts.clone()),
                is_manual: false,
            });
        } else {
            // 폴리곤 없는 GIS 건물은 제외
            continue;
        }
    }

    // 수동 등록 건물도 경로 분석에 포함
    let geo_buffer = 0.01; // ~1.1km 버퍼 — 대형 도형 커버
    let mut stmt2 = conn.prepare(
        "SELECT latitude, longitude, height, ground_elev, name, memo, geometry_type, geometry_json
         FROM manual_buildings
         WHERE latitude BETWEEN ?1 AND ?2
           AND longitude BETWEEN ?3 AND ?4"
    ).map_err(|e| format!("수동 건물 쿼리 준비 실패: {}", e))?;

    let manual_rows = stmt2.query_map(
        params![min_lat - geo_buffer, max_lat + geo_buffer, min_lon - geo_buffer, max_lon + geo_buffer],
        |row| {
            Ok((
                row.get::<_, f64>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, f64>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        },
    ).map_err(|e| format!("수동 건물 쿼리 실행 실패: {}", e))?;

    for row in manual_rows {
        let (mlat, mlon, height, ground_elev, name, memo, geo_type, geo_json) = row.map_err(|e| format!("수동 건물 행 읽기 실패: {}", e))?;

        let geo_type_str = geo_type.as_deref().unwrap_or("polygon");

        // 폴리곤 형태 → 정확한 직선-폴리곤 교차
        if let Some(ring) = manual_building_to_polygon_ring(mlat, mlon, geo_type.as_deref(), geo_json.as_deref()) {
            let mut hit_distances = line_polygon_intersections(
                radar_lon, radar_lat, target_lon, target_lat,
                &ring, total_dist,
            );
            if point_in_polygon_2d(radar_lon, radar_lat, &ring) {
                hit_distances.push(0.0);
            }
            if point_in_polygon_2d(target_lon, target_lat, &ring) {
                hit_distances.push(total_dist);
            }

            if hit_distances.is_empty() {
                continue;
            }

            let near_dist = hit_distances.iter().cloned().fold(f64::INFINITY, f64::min);
            let far_dist = hit_distances.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            let center_dist = (near_dist + far_dist) / 2.0;

            let t_mid = (center_dist / total_dist).clamp(0.0, 1.0);
            let rep_lon = radar_lon + t_mid * dx;
            let rep_lat = radar_lat + t_mid * dy;

            buildings.push(BuildingOnPath {
                distance_km: center_dist,
                near_dist_km: near_dist,
                far_dist_km: far_dist,
                height_m: height,
                ground_elev_m: ground_elev,
                total_height_m: height + ground_elev,
                name: name.clone(),
                address: memo.clone(),
                usage: None,
                lat: rep_lat,
                lon: rep_lon,
                polygon: None,
                is_manual: true,
            });
        } else if geo_type_str == "line" {
            // 선형 건물 (벽/담) — LoS 직선과 각 세그먼트 교차 테스트
            let line_pts = expand_manual_building_geometry(mlat, mlon, geo_type.as_deref(), geo_json.as_deref());
            let mut hit_distances: Vec<f64> = Vec::new();
            for k in 0..line_pts.len().saturating_sub(1) {
                let (lat1, lon1) = line_pts[k];
                let (lat2, lon2) = line_pts[k + 1];
                if let Some(t) = line_seg_intersect_t(
                    radar_lon, radar_lat, target_lon, target_lat,
                    lon1, lat1, lon2, lat2,
                ) {
                    hit_distances.push(t.clamp(0.0, 1.0) * total_dist);
                }
            }

            if hit_distances.is_empty() {
                continue;
            }

            let near_dist = hit_distances.iter().cloned().fold(f64::INFINITY, f64::min);
            let far_dist = hit_distances.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            let center_dist = (near_dist + far_dist) / 2.0;

            let t_mid = (center_dist / total_dist).clamp(0.0, 1.0);
            let rep_lon = radar_lon + t_mid * dx;
            let rep_lat = radar_lat + t_mid * dy;

            buildings.push(BuildingOnPath {
                distance_km: center_dist,
                near_dist_km: near_dist,
                far_dist_km: far_dist,
                height_m: height,
                ground_elev_m: ground_elev,
                total_height_m: height + ground_elev,
                name: name.clone(),
                address: memo.clone(),
                usage: None,
                lat: rep_lat,
                lon: rep_lon,
                polygon: None,
                is_manual: true,
            });
        } else {
            // point 타입 등 geometry 없는 수동 건물은 제외
            continue;
        }
    }

    buildings.sort_by(|a, b| a.distance_km.partial_cmp(&b.distance_km).unwrap_or(std::cmp::Ordering::Equal));

    Ok(buildings)
}

// ─── 영역 내 건물 조회 (커버리지 맵용) ──────────────────────────

/// 영역 내 건물 정보 (좌표 + 높이만 반환, 경량)
#[derive(Serialize, Clone, Debug)]
pub struct BuildingInArea {
    pub lat: f64,
    pub lon: f64,
    pub height_m: f64,
}

/// 바운딩 박스 내 건물 조회 (건물통합정보 + 수동 등록 건물 통합)
pub fn query_buildings_in_bbox(
    conn: &Connection,
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
    min_height_m: f64,
) -> Result<Vec<BuildingInArea>, String> {
    let mut result = Vec::new();

    // 1) 건물통합정보
    let mut stmt = conn.prepare(
        "SELECT centroid_lat, centroid_lon, height
         FROM fac_buildings
         WHERE centroid_lat BETWEEN ?1 AND ?2
           AND centroid_lon BETWEEN ?3 AND ?4
           AND height >= ?5
           AND height <= ?6"
    ).map_err(|e| format!("쿼리 준비 실패: {}", e))?;

    let rows = stmt.query_map(
        params![min_lat, max_lat, min_lon, max_lon, min_height_m, MAX_BUILDING_HEIGHT_M],
        |row| {
            Ok(BuildingInArea {
                lat: row.get(0)?,
                lon: row.get(1)?,
                height_m: row.get(2)?,
            })
        },
    ).map_err(|e| format!("쿼리 실행 실패: {}", e))?;

    for row in rows {
        result.push(row.map_err(|e| format!("행 읽기 실패: {}", e))?);
    }

    // 2) 수동 등록 건물 (geometry 확장 지원)
    let geo_buffer = 0.01; // ~1.1km 버퍼
    let mut stmt2 = conn.prepare(
        "SELECT latitude, longitude, height, ground_elev, geometry_type, geometry_json
         FROM manual_buildings
         WHERE latitude BETWEEN ?1 AND ?2
           AND longitude BETWEEN ?3 AND ?4
           AND (height + ground_elev) >= ?5"
    ).map_err(|e| format!("수동 건물 쿼리 준비 실패: {}", e))?;

    let rows2 = stmt2.query_map(
        params![min_lat - geo_buffer, max_lat + geo_buffer, min_lon - geo_buffer, max_lon + geo_buffer, min_height_m],
        |row| {
            Ok((
                row.get::<_, f64>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, f64>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        },
    ).map_err(|e| format!("수동 건물 쿼리 실행 실패: {}", e))?;

    for row in rows2 {
        let (clat, clon, height, ground_elev, geo_type, geo_json) = row.map_err(|e| format!("수동 건물 행 읽기 실패: {}", e))?;
        let total_h = height + ground_elev;

        let sample_pts = expand_manual_building_geometry(clat, clon, geo_type.as_deref(), geo_json.as_deref());
        for (slat, slon) in &sample_pts {
            // 원래 bbox 범위에 들어오는 포인트만 추가
            if *slat >= min_lat && *slat <= max_lat && *slon >= min_lon && *slon <= max_lon {
                result.push(BuildingInArea {
                    lat: *slat,
                    lon: *slon,
                    height_m: total_h,
                });
            }
        }
    }

    Ok(result)
}

// ─── 3D 건물 조회 ───────────────────────────────────────────────

/// 3D 건물 데이터 (폴리곤 포함)
#[derive(Serialize, Clone, Debug)]
pub struct Building3D {
    pub lat: f64,
    pub lon: f64,
    pub height_m: f64,
    /// 건물 폴리곤 [[lat,lon],...] (WGS84)
    pub polygon: Vec<[f64; 2]>,
    pub name: Option<String>,
    pub usage: Option<String>,
    /// 데이터 출처: "fac", "manual"
    pub source: String,
    /// 건물 그룹 색상 (수동 건물만, 예: "#ef4444")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_color: Option<String>,
}

/// 뷰포트 내 3D 건물 조회 (폴리곤 포함, 높은 건물 우선)
/// `exclude_sources`: 제외할 출처 목록 (예: ["fac"], ["manual"])
pub fn query_buildings_3d(
    conn: &Connection,
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
    min_height_m: f64,
    _max_count: usize,
    exclude_sources: &[String],
) -> Result<Vec<Building3D>, String> {
    let mut result = Vec::new();

    let skip_manual = exclude_sources.iter().any(|s| s == "manual");
    let _skip_fac = exclude_sources.iter().any(|s| s == "fac");

    // 2) 수동 건물 (도형 확장 → 폴리곤 생성)
    if !skip_manual {
        let geo_buffer = 0.01;
        let mut stmt2 = conn.prepare(
            "SELECT mb.latitude, mb.longitude, mb.height, mb.ground_elev, mb.name, mb.geometry_type, mb.geometry_json, bg.color
             FROM manual_buildings mb
             LEFT JOIN building_groups bg ON mb.group_id = bg.id
             WHERE mb.latitude BETWEEN ?1 AND ?2
               AND mb.longitude BETWEEN ?3 AND ?4
               AND (mb.height + mb.ground_elev) >= ?5"
        ).map_err(|e| format!("수동 건물 3D 쿼리 준비 실패: {}", e))?;

        let rows2 = stmt2.query_map(
            params![min_lat - geo_buffer, max_lat + geo_buffer, min_lon - geo_buffer, max_lon + geo_buffer, min_height_m],
            |row| {
                Ok((
                    row.get::<_, f64>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, f64>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            },
        ).map_err(|e| format!("수동 건물 3D 쿼리 실행 실패: {}", e))?;

        for row in rows2 {
            let (lat, lon, height, ground_elev, name, geo_type, geo_json, group_color) =
                row.map_err(|e| format!("수동 건물 3D 행 읽기 실패: {}", e))?;
            let total_h = height + ground_elev;

            // 수동 건물 geometry → 폴리곤 좌표 변환
            let sample_pts = expand_manual_building_geometry(lat, lon, geo_type.as_deref(), geo_json.as_deref());
            if sample_pts.len() < 3 {
                // 점/선 → 작은 사각형 생성 (±5m)
                let d = 0.000045; // ~5m
                let polygon = vec![
                    [lat - d, lon - d],
                    [lat - d, lon + d],
                    [lat + d, lon + d],
                    [lat + d, lon - d],
                ];
                result.push(Building3D {
                    lat, lon, height_m: total_h, polygon, name, usage: None, source: "manual".to_string(), group_color,
                });
            } else {
                let polygon: Vec<[f64; 2]> = sample_pts.iter().map(|(la, lo)| [*la, *lo]).collect();
                result.push(Building3D {
                    lat, lon, height_m: total_h, polygon, name, usage: None, source: "manual".to_string(), group_color,
                });
            }
        }
    }

    Ok(result)
}

// ─── 타일 기반 Binary 건물 조회 ──────────────────────────────────

/// 건물 메타데이터 (binary 전송 시 별도)
#[derive(Serialize, Clone, Debug)]
pub struct Building3DMeta {
    pub name: Option<String>,
    pub usage: Option<String>,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_color: Option<String>,
}

/// Binary 패킹된 3D 건물 데이터
/// coords: base64 Float64Array [lon0, lat0, height0, vertexCount0, v0_lon, v0_lat, v1_lon, v1_lat, ..., lon1, lat1, height1, ...]
/// meta: 건물별 메타데이터 배열
#[derive(Serialize, Clone, Debug)]
pub struct Buildings3DBinary {
    pub coords: String,
    pub meta: Vec<Building3DMeta>,
    pub count: usize,
}

/// 타일 영역 내 수동+FAC 건물을 binary Float64Array로 반환
/// 폴리곤 좌표를 Float64로 패킹: [lon, lat, height, vertexCount, v0_lon, v0_lat, ...]
pub fn query_buildings_3d_binary(
    conn: &Connection,
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
    min_height_m: f64,
    max_count: usize,
    exclude_sources: &[String],
) -> Result<Buildings3DBinary, String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    let skip_manual = exclude_sources.iter().any(|s| s == "manual");
    let skip_fac = exclude_sources.iter().any(|s| s == "fac");

    // 좌표 데이터를 f64 벡터로 패킹
    let mut floats: Vec<f64> = Vec::new();
    let mut metas: Vec<Building3DMeta> = Vec::new();

    // 수동 건물
    if !skip_manual {
        let geo_buffer = 0.01;
        let mut stmt = conn.prepare(
            "SELECT mb.latitude, mb.longitude, mb.height, mb.ground_elev, mb.name, mb.geometry_type, mb.geometry_json, bg.color
             FROM manual_buildings mb
             LEFT JOIN building_groups bg ON mb.group_id = bg.id
             WHERE mb.latitude BETWEEN ?1 AND ?2
               AND mb.longitude BETWEEN ?3 AND ?4
               AND (mb.height + mb.ground_elev) >= ?5"
        ).map_err(|e| format!("수동 건물 binary 쿼리 준비 실패: {}", e))?;

        let rows = stmt.query_map(
            params![min_lat - geo_buffer, max_lat + geo_buffer, min_lon - geo_buffer, max_lon + geo_buffer, min_height_m],
            |row| {
                Ok((
                    row.get::<_, f64>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, f64>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            },
        ).map_err(|e| format!("수동 건물 binary 쿼리 실행 실패: {}", e))?;

        for row in rows {
            if metas.len() >= max_count { break; }
            let (lat, lon, height, ground_elev, name, geo_type, geo_json, group_color) =
                row.map_err(|e| format!("수동 건물 binary 행 읽기 실패: {}", e))?;
            let total_h = height + ground_elev;

            let sample_pts = expand_manual_building_geometry(lat, lon, geo_type.as_deref(), geo_json.as_deref());
            let polygon: Vec<[f64; 2]> = if sample_pts.len() < 3 {
                let d = 0.000045;
                vec![[lat - d, lon - d], [lat - d, lon + d], [lat + d, lon + d], [lat + d, lon - d]]
            } else {
                sample_pts.iter().map(|(la, lo)| [*la, *lo]).collect()
            };

            // 패킹: [lon, lat, height, vertexCount, v0_lon, v0_lat, ...]
            floats.push(lon);
            floats.push(lat);
            floats.push(total_h);
            floats.push(polygon.len() as f64);
            for [vlat, vlon] in &polygon {
                floats.push(*vlon);
                floats.push(*vlat);
            }

            metas.push(Building3DMeta {
                name, usage: None, source: "manual".to_string(), group_color,
            });
        }
    }

    // FAC 건물 (fac_buildings 테이블 없을 수 있음 — 실패 시 무시)
    if !skip_fac {
        if let Ok(mut stmt) = conn.prepare(
            "SELECT centroid_lat, centroid_lon, height, building_name, usability, polygon_json
             FROM fac_buildings
             WHERE centroid_lat BETWEEN ?1 AND ?2
               AND centroid_lon BETWEEN ?3 AND ?4
               AND height >= ?5
               AND height <= ?6
             ORDER BY height DESC
             LIMIT ?7"
        ) {
            let remaining = max_count.saturating_sub(metas.len());
            if let Ok(rows) = stmt.query_map(
                params![min_lat, max_lat, min_lon, max_lon, min_height_m, MAX_BUILDING_HEIGHT_M, remaining as i64],
                |row| {
                    Ok((
                        row.get::<_, f64>(0)?,
                        row.get::<_, f64>(1)?,
                        row.get::<_, f64>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            ) {
                for row in rows {
                    let (lat, lon, height, name, usage, poly_json) = match row {
                        Ok(r) => r,
                        Err(_) => continue,
                    };

                    let polygon: Vec<[f64; 2]> = match serde_json::from_str(&poly_json) {
                        Ok(p) => p,
                        Err(_) => continue,
                    };
                    if polygon.len() < 3 { continue; }

                    floats.push(lon);
                    floats.push(lat);
                    floats.push(height);
                    floats.push(polygon.len() as f64);
                    for [vlat, vlon] in &polygon {
                        floats.push(*vlon);
                        floats.push(*vlat);
                    }

                    metas.push(Building3DMeta {
                        name, usage, source: "fac".to_string(), group_color: None,
                    });
                }
            }
        }
    }

    let count = metas.len();
    // f64 → little-endian bytes → base64
    let byte_len = floats.len() * 8;
    let mut bytes = Vec::with_capacity(byte_len);
    for f in &floats {
        bytes.extend_from_slice(&f.to_le_bytes());
    }
    let coords = STANDARD.encode(&bytes);

    Ok(Buildings3DBinary { coords, meta: metas, count })
}

// ─── 건물 그룹 CRUD ─────────────────────────────────────────────

/// 건물 그룹
#[derive(Serialize, Clone, Debug)]
pub struct BuildingGroup {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub memo: String,
    pub has_plan_image: bool,
    pub plan_bounds_json: Option<String>,
    pub plan_opacity: f64,
    pub plan_rotation: f64,
    /// 그룹 영역 바운드 JSON: [[minLat, minLon], [maxLat, maxLon]]
    pub area_bounds_json: Option<String>,
}

/// 건물 그룹 전체 조회
pub fn list_building_groups(conn: &Connection) -> Result<Vec<BuildingGroup>, String> {
    let mut stmt = conn.prepare(
        "SELECT id, name, color, memo, (plan_image IS NOT NULL) AS has_plan_image, plan_bounds_json, plan_opacity, plan_rotation, area_bounds_json FROM building_groups ORDER BY id"
    ).map_err(|e| format!("쿼리 준비 실패: {}", e))?;

    let rows = stmt.query_map([], |row| {
        Ok(BuildingGroup {
            id: row.get(0)?,
            name: row.get(1)?,
            color: row.get(2)?,
            memo: row.get(3)?,
            has_plan_image: row.get::<_, i32>(4).unwrap_or(0) != 0,
            plan_bounds_json: row.get(5)?,
            plan_opacity: row.get::<_, f64>(6).unwrap_or(0.5),
            plan_rotation: row.get::<_, f64>(7).unwrap_or(0.0),
            area_bounds_json: row.get(8)?,
        })
    }).map_err(|e| format!("쿼리 실행 실패: {}", e))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("결과 수집 실패: {}", e))
}

/// 건물 그룹 추가 (생성된 id 반환)
pub fn add_building_group(
    conn: &Connection,
    name: &str,
    color: &str,
    memo: &str,
    area_bounds_json: Option<&str>,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO building_groups (name, color, memo, area_bounds_json) VALUES (?1, ?2, ?3, ?4)",
        params![name, color, memo, area_bounds_json],
    ).map_err(|e| format!("INSERT 실패: {}", e))?;
    Ok(conn.last_insert_rowid())
}

/// 건물 그룹 수정
pub fn update_building_group(
    conn: &Connection,
    id: i64,
    name: &str,
    color: &str,
    memo: &str,
    plan_opacity: Option<f64>,
    plan_rotation: Option<f64>,
    area_bounds_json: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE building_groups SET name=?1, color=?2, memo=?3, area_bounds_json=?4 WHERE id=?5",
        params![name, color, memo, area_bounds_json, id],
    ).map_err(|e| format!("UPDATE 실패: {}", e))?;
    if let Some(opacity) = plan_opacity {
        conn.execute(
            "UPDATE building_groups SET plan_opacity = ?1 WHERE id = ?2",
            params![opacity, id],
        ).map_err(|e| format!("UPDATE opacity 실패: {}", e))?;
    }
    if let Some(rotation) = plan_rotation {
        conn.execute(
            "UPDATE building_groups SET plan_rotation = ?1 WHERE id = ?2",
            params![rotation, id],
        ).map_err(|e| format!("UPDATE rotation 실패: {}", e))?;
    }
    Ok(())
}

/// 건물 그룹 삭제 (소속 건물의 group_id는 ON DELETE SET NULL로 자동 해제)
pub fn delete_building_group(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM building_groups WHERE id = ?1", params![id])
        .map_err(|e| format!("DELETE 실패: {}", e))?;
    Ok(())
}

/// 건물 그룹 토지이용계획도 이미지 저장
pub fn save_group_plan_image(
    conn: &Connection,
    group_id: i64,
    image_bytes: &[u8],
    bounds_json: &str,
    opacity: f64,
    rotation: f64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE building_groups SET plan_image = ?1, plan_bounds_json = ?2, plan_opacity = ?3, plan_rotation = ?4 WHERE id = ?5",
        params![image_bytes, bounds_json, opacity, rotation, group_id],
    ).map_err(|e| format!("UPDATE 실패: {}", e))?;
    Ok(())
}

/// 건물 그룹 토지이용계획도 이미지 로드
pub fn load_group_plan_image(
    conn: &Connection,
    group_id: i64,
) -> Result<Option<(Vec<u8>, String, f64, f64)>, String> {
    let mut stmt = conn.prepare(
        "SELECT plan_image, plan_bounds_json, plan_opacity, plan_rotation FROM building_groups WHERE id = ?1"
    ).map_err(|e| format!("쿼리 준비 실패: {}", e))?;

    let result = stmt.query_row(params![group_id], |row| {
        let image: Option<Vec<u8>> = row.get(0)?;
        let bounds: Option<String> = row.get(1)?;
        let opacity: f64 = row.get::<_, f64>(2).unwrap_or(0.5);
        let rotation: f64 = row.get::<_, f64>(3).unwrap_or(0.0);
        Ok(image.map(|img| (img, bounds.unwrap_or_default(), opacity, rotation)))
    }).map_err(|e| format!("쿼리 실행 실패: {}", e))?;

    Ok(result)
}

/// 건물 그룹 도면 오버레이 속성(투명도/회전) 업데이트
pub fn update_plan_overlay_props(
    conn: &Connection,
    group_id: i64,
    opacity: Option<f64>,
    rotation: Option<f64>,
) -> Result<(), String> {
    if let Some(o) = opacity {
        conn.execute(
            "UPDATE building_groups SET plan_opacity = ?1 WHERE id = ?2",
            params![o, group_id],
        ).map_err(|e| format!("UPDATE opacity 실패: {}", e))?;
    }
    if let Some(r) = rotation {
        conn.execute(
            "UPDATE building_groups SET plan_rotation = ?1 WHERE id = ?2",
            params![r, group_id],
        ).map_err(|e| format!("UPDATE rotation 실패: {}", e))?;
    }
    Ok(())
}

/// 건물 그룹 토지이용계획도 이미지 삭제
pub fn delete_group_plan_image(conn: &Connection, group_id: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE building_groups SET plan_image = NULL, plan_bounds_json = NULL WHERE id = ?1",
        params![group_id],
    ).map_err(|e| format!("UPDATE 실패: {}", e))?;
    Ok(())
}

// ─── 수동 등록 건물 CRUD ─────────────────────────────────────────

/// 수동 등록 건물
#[derive(Serialize, Clone, Debug)]
pub struct ManualBuilding {
    pub id: i64,
    pub name: String,
    pub latitude: f64,
    pub longitude: f64,
    pub height: f64,
    pub ground_elev: f64,
    pub memo: String,
    /// 도형 유형: "polygon" | "multi"
    pub geometry_type: String,
    /// 도형 좌표 JSON (polygon: [[lat,lon],...])
    pub geometry_json: Option<String>,
    /// 소속 그룹 ID (null이면 미분류)
    pub group_id: Option<i64>,
}

/// 수동 건물 전체 조회
pub fn list_manual_buildings(conn: &Connection) -> Result<Vec<ManualBuilding>, String> {
    let mut stmt = conn.prepare(
        "SELECT id, name, latitude, longitude, height, ground_elev, memo, geometry_type, geometry_json, group_id FROM manual_buildings ORDER BY id"
    ).map_err(|e| format!("쿼리 준비 실패: {}", e))?;

    let rows = stmt.query_map([], |row| {
        Ok(ManualBuilding {
            id: row.get(0)?,
            name: row.get(1)?,
            latitude: row.get(2)?,
            longitude: row.get(3)?,
            height: row.get(4)?,
            ground_elev: row.get(5)?,
            memo: row.get(6)?,
            geometry_type: row.get::<_, Option<String>>(7)?.unwrap_or_else(|| "polygon".to_string()),
            geometry_json: row.get(8)?,
            group_id: row.get(9)?,
        })
    }).map_err(|e| format!("쿼리 실행 실패: {}", e))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("결과 수집 실패: {}", e))
}

/// 수동 건물 추가 (생성된 id 반환)
pub fn add_manual_building(
    conn: &Connection,
    name: &str,
    latitude: f64,
    longitude: f64,
    height: f64,
    ground_elev: f64,
    memo: &str,
    geometry_type: &str,
    geometry_json: Option<&str>,
    group_id: Option<i64>,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO manual_buildings (name, latitude, longitude, height, ground_elev, memo, geometry_type, geometry_json, group_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![name, latitude, longitude, height, ground_elev, memo, geometry_type, geometry_json, group_id],
    ).map_err(|e| format!("INSERT 실패: {}", e))?;
    Ok(conn.last_insert_rowid())
}

/// 수동 건물 수정
pub fn update_manual_building(
    conn: &Connection,
    id: i64,
    name: &str,
    latitude: f64,
    longitude: f64,
    height: f64,
    ground_elev: f64,
    memo: &str,
    geometry_type: &str,
    geometry_json: Option<&str>,
    group_id: Option<i64>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE manual_buildings SET name=?1, latitude=?2, longitude=?3, height=?4, ground_elev=?5, memo=?6, geometry_type=?7, geometry_json=?8, group_id=?9 WHERE id=?10",
        params![name, latitude, longitude, height, ground_elev, memo, geometry_type, geometry_json, group_id, id],
    ).map_err(|e| format!("UPDATE 실패: {}", e))?;
    Ok(())
}

/// 수동 건물 삭제
pub fn delete_manual_building(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM manual_buildings WHERE id = ?1", params![id])
        .map_err(|e| format!("DELETE 실패: {}", e))?;
    Ok(())
}

// ─── 헬퍼 함수 ─────────────────────────────────────────────────

/// 인코딩 깨짐으로 인한 비정상 건물명 판별
/// - 전각 물음표(？, U+FF1F): UTF-8 바이트를 EUC-KR로 잘못 디코딩한 흔적
/// - ASCII 물음표(?): 원본 SHP에서 EUC-KR 미지원 문자가 0x3F로 치환된 것
fn is_garbled_name(s: &str) -> bool {
    // 전각 물음표 포함 → 항상 인코딩 깨짐
    if s.contains('\u{FF1F}') {
        return true;
    }
    // ASCII '?' + 주변에 한글이 있으면 대체문자로 판단
    if s.contains('?') && s.chars().any(|c| ('\u{AC00}'..='\u{D7A3}').contains(&c)) {
        return true;
    }
    false
}

/// DBF 파일에서 특정 문자열 필드의 원본 바이트를 EUC-KR로 디코딩하여 레코드별 Vec 반환
pub(crate) fn parse_dbf_euckr_field(dbf_path: &Path, field_names: &[&str]) -> Option<Vec<Option<String>>> {
    let data = std::fs::read(dbf_path).ok()?;
    if data.len() < 32 { return None; }

    let num_records = u32::from_le_bytes(data[4..8].try_into().ok()?) as usize;
    let header_size = u16::from_le_bytes(data[8..10].try_into().ok()?) as usize;
    let record_size = u16::from_le_bytes(data[10..12].try_into().ok()?) as usize;
    if record_size == 0 || header_size == 0 || header_size > data.len() {
        return None;
    }

    // 필드 디스크립터 파싱: 오프셋 32부터 32바이트씩, 0x0D 터미네이터
    // field_names 리스트 순서를 우선순위로 사용 (앞쪽이 높은 우선순위)
    let mut field_map: Vec<(String, usize, usize)> = Vec::new(); // (name, offset, len)
    let mut field_offset: usize = 1; // 1바이트 삭제 플래그
    let mut pos = 32;
    while pos + 32 <= header_size && data[pos] != 0x0D {
        let fname_bytes = &data[pos..pos + 11];
        let fname_end = fname_bytes.iter().position(|&b| b == 0).unwrap_or(11);
        let fname = std::str::from_utf8(&fname_bytes[..fname_end]).unwrap_or("");
        let flen = data[pos + 16] as usize;

        if field_names.iter().any(|&n| n.eq_ignore_ascii_case(fname)) {
            field_map.push((fname.to_string(), field_offset, flen));
        }
        field_offset += flen;
        pos += 32;
    }

    // field_names 우선순위 순서로 정렬 (리스트 앞쪽 = 높은 우선순위)
    let (t_off, t_len) = field_names.iter()
        .find_map(|&wanted| {
            field_map.iter()
                .find(|(name, _, _)| name.eq_ignore_ascii_case(wanted))
                .map(|(_, off, len)| (*off, *len))
        })?;

    let mut results = Vec::with_capacity(num_records);
    for i in 0..num_records {
        let rec_start = header_size + i * record_size;
        if rec_start + t_off + t_len > data.len() {
            results.push(None);
            continue;
        }
        let raw = &data[rec_start + t_off..rec_start + t_off + t_len];
        // null 바이트 및 공백 제거 후 실제 데이터 길이 확인
        let raw_trimmed = raw.iter()
            .rposition(|&b| b != 0x00 && b != 0x20)
            .map(|end| &raw[..=end])
            .unwrap_or(&[]);
        if raw_trimmed.is_empty() {
            results.push(None);
            continue;
        }
        // UTF-8 유효성 먼저 확인 (일부 레코드가 UTF-8로 인코딩된 경우)
        let decoded_str = if let Ok(utf8) = std::str::from_utf8(raw_trimmed) {
            utf8.to_string()
        } else {
            let (decoded, _, _) = EUC_KR.decode(raw_trimmed);
            decoded.into_owned()
        };
        let trimmed = decoded_str.trim().to_string();
        if trimmed.is_empty() || is_garbled_name(&trimmed) {
            results.push(None);
        } else {
            results.push(Some(trimmed));
        }
    }

    Some(results)
}

pub(crate) fn extract_zip_entry<R: IoRead + Seek>(
    archive: &mut zip::ZipArchive<R>,
    entry_name: &str,
    dest_path: &Path,
) -> Result<(), String> {
    let mut entry = archive.by_name(entry_name)
        .map_err(|e| format!("ZIP 항목 '{}' 열기 실패: {}", entry_name, e))?;
    let mut out = std::fs::File::create(dest_path)
        .map_err(|e| format!("파일 생성 실패: {}", e))?;
    std::io::copy(&mut entry, &mut out)
        .map_err(|e| format!("파일 추출 실패: {}", e))?;
    Ok(())
}

/// SHP 폴리곤 꼭짓점을 WGS84로 변환하여 JSON 직렬화
/// 입력: EPSG:5186 좌표의 outer ring points (Point 또는 PointZ)
/// 출력: [[lat,lon],[lat,lon],...] 형식 JSON 문자열
pub(crate) fn extract_polygon_wgs84<P: shapefile::record::traits::HasXY>(points: Option<&[P]>) -> Option<String> {
    let pts = points?;
    if pts.len() < 3 {
        return None;
    }

    let mut coords: Vec<[f64; 2]> = Vec::with_capacity(pts.len());
    for pt in pts {
        let (lat, lon) = epsg5186_to_wgs84(pt.x(), pt.y());
        coords.push([lat, lon]);
    }

    // RDP 간소화: 꼭짓점 50개 초과 시 축소
    if coords.len() > 50 {
        coords = rdp_simplify(&coords, 0.000005); // ~0.5m
        if coords.len() < 3 {
            return None;
        }
    }

    serde_json::to_string(&coords).ok()
}

/// Ramer-Douglas-Peucker 폴리곤 간소화
fn rdp_simplify(points: &[[f64; 2]], epsilon: f64) -> Vec<[f64; 2]> {
    if points.len() < 3 {
        return points.to_vec();
    }

    // 가장 먼 점 찾기
    let first = points[0];
    let last = points[points.len() - 1];
    let mut max_dist = 0.0;
    let mut max_idx = 0;

    for (i, pt) in points.iter().enumerate().skip(1).take(points.len() - 2) {
        let d = perpendicular_distance(pt, &first, &last);
        if d > max_dist {
            max_dist = d;
            max_idx = i;
        }
    }

    if max_dist > epsilon {
        let mut left = rdp_simplify(&points[..=max_idx], epsilon);
        let right = rdp_simplify(&points[max_idx..], epsilon);
        left.pop(); // 중복 제거
        left.extend_from_slice(&right);
        left
    } else {
        vec![first, last]
    }
}

/// 점에서 직선까지 수직 거리 (2D)
fn perpendicular_distance(pt: &[f64; 2], line_start: &[f64; 2], line_end: &[f64; 2]) -> f64 {
    let dx = line_end[0] - line_start[0];
    let dy = line_end[1] - line_start[1];
    let len_sq = dx * dx + dy * dy;
    if len_sq < 1e-20 {
        let ex = pt[0] - line_start[0];
        let ey = pt[1] - line_start[1];
        return (ex * ex + ey * ey).sqrt();
    }
    ((pt[0] - line_start[0]) * dy - (pt[1] - line_start[1]) * dx).abs() / len_sq.sqrt()
}

/// Polygon bbox + centroid (EPSG:5186 좌표)
pub(crate) fn compute_polygon_bbox_centroid(
    poly: &shapefile::Polygon,
) -> Option<(f64, f64, f64, f64, f64, f64)> {
    let rings = poly.rings();
    if rings.is_empty() {
        return None;
    }
    let points = rings[0].points();
    if points.is_empty() {
        return None;
    }

    let mut min_x = f64::MAX;
    let mut min_y = f64::MAX;
    let mut max_x = f64::MIN;
    let mut max_y = f64::MIN;
    let mut sum_x = 0.0;
    let mut sum_y = 0.0;

    for pt in points {
        min_x = min_x.min(pt.x);
        min_y = min_y.min(pt.y);
        max_x = max_x.max(pt.x);
        max_y = max_y.max(pt.y);
        sum_x += pt.x;
        sum_y += pt.y;
    }

    let n = points.len() as f64;
    Some((sum_x / n, sum_y / n, min_x, min_y, max_x, max_y))
}

/// PolygonZ bbox + centroid
pub(crate) fn compute_polygon_z_bbox_centroid(
    poly: &shapefile::PolygonZ,
) -> Option<(f64, f64, f64, f64, f64, f64)> {
    let rings = poly.rings();
    if rings.is_empty() {
        return None;
    }
    let points = rings[0].points();
    if points.is_empty() {
        return None;
    }

    let mut min_x = f64::MAX;
    let mut min_y = f64::MAX;
    let mut max_x = f64::MIN;
    let mut max_y = f64::MIN;
    let mut sum_x = 0.0;
    let mut sum_y = 0.0;

    for pt in points {
        min_x = min_x.min(pt.x);
        min_y = min_y.min(pt.y);
        max_x = max_x.max(pt.x);
        max_y = max_y.max(pt.y);
        sum_x += pt.x;
        sum_y += pt.y;
    }

    let n = points.len() as f64;
    Some((sum_x / n, sum_y / n, min_x, min_y, max_x, max_y))
}

/// DBF 레코드에서 숫자 필드 추출 (여러 필드명 시도, 첫 번째 매칭 반환)
pub(crate) fn get_field_as_f64(
    record: &shapefile::dbase::Record,
    field_names: &[&str],
) -> Option<f64> {
    for name in field_names {
        if let Some(value) = record.get(name) {
            match value {
                FieldValue::Numeric(Some(v)) => return Some(*v),
                FieldValue::Float(Some(v)) => return Some(*v as f64),
                FieldValue::Double(v) => return Some(*v),
                FieldValue::Integer(v) => return Some(*v as f64),
                FieldValue::Character(Some(s)) => {
                    if let Ok(v) = s.trim().parse::<f64>() {
                        return Some(v);
                    }
                }
                _ => {}
            }
        }
    }
    None
}

/// DBF 레코드에서 문자열 필드 추출
pub(crate) fn get_field_as_string(
    record: &shapefile::dbase::Record,
    field_names: &[&str],
) -> Option<String> {
    for name in field_names {
        if let Some(value) = record.get(name) {
            if let FieldValue::Character(Some(s)) = value {
                let trimmed = s.trim().to_string();
                if !trimmed.is_empty() {
                    return Some(trimmed);
                }
            }
        }
    }
    None
}

/// 수동 건물 geometry_json을 파싱하여 (lat, lon) 샘플 포인트 목록으로 확장.
/// geometry가 없으면 중심점만 반환.
pub(crate) fn expand_manual_building_geometry(
    center_lat: f64,
    center_lon: f64,
    geo_type: Option<&str>,
    geo_json: Option<&str>,
) -> Vec<(f64, f64)> {
    let geo_type = match geo_type {
        Some(t) if t == "polygon" || t == "multi" => t,
        _ => return vec![(center_lat, center_lon)],
    };
    let json_str = match geo_json {
        Some(s) if !s.is_empty() => s,
        _ => return vec![(center_lat, center_lon)],
    };
    let val: serde_json::Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => return vec![(center_lat, center_lon)],
    };

    match geo_type {
        "polygon" => {
            if let Some(arr) = val.as_array() {
                let pts: Vec<(f64, f64)> = arr.iter().filter_map(|p| {
                    let lat = p.get(0).and_then(|v| v.as_f64())?;
                    let lon = p.get(1).and_then(|v| v.as_f64())?;
                    Some((lat, lon))
                }).collect();
                if !pts.is_empty() {
                    return pts;
                }
            }
        }
        "multi" => {
            // 복합 도형: [{type, json}, ...] 배열을 재귀 확장
            if let Some(arr) = val.as_array() {
                let mut all_pts = Vec::new();
                for item in arr {
                    let sub_type = item.get("type").and_then(|v| v.as_str());
                    let sub_json = item.get("json").and_then(|v| v.as_str());
                    let pts = expand_manual_building_geometry(center_lat, center_lon, sub_type, sub_json);
                    all_pts.extend(pts);
                }
                if !all_pts.is_empty() {
                    return all_pts;
                }
            }
        }
        _ => {}
    }

    vec![(center_lat, center_lon)]
}

/// 오늘 날짜 문자열 (YYYY-MM)
pub(crate) fn today_yyyymm() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // 정확한 날짜 계산
    let days = (secs / 86400) as i64;
    let (y, m, _d) = days_to_ymd(days);
    format!("{}-{:02}", y, m)
}

fn days_to_ymd(days_since_epoch: i64) -> (i64, u32, u32) {
    // Civil calendar algorithm (Howard Hinnant)
    let z = days_since_epoch + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
