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
    /// fac_buildings 행 id — 타겟 자체 건물 제외 판정용 (수동 건물은 None)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fac_id: Option<i64>,
}

/// 건물통합정보(FAC) 단건 상세 — 클릭 좌표 인근 건물의 대장성 필드 (오프라인 로컬 DB)
#[derive(Serialize, Clone, Debug)]
pub struct FacBuildingDetail {
    pub name: Option<String>,
    pub dong_name: Option<String>,
    pub usage: Option<String>,
    pub pnu: Option<String>,
    pub bd_mgt_sn: Option<String>,
    pub height_m: f64,
    /// 실측(1m DSM) 지붕고 (m) — NULL 이면 실측 데이터 없음, height_m 이 대장 높이
    pub height_measured_m: Option<f64>,
    pub ground_elev_m: f64,
    pub region: String,
    pub lat: f64,
    pub lon: f64,
}

/// 주어진 좌표를 포함(또는 최근접)하는 FAC 건물 1건 조회.
/// 1) bbox 후보 중 폴리곤 내부 포함 건물 우선,
/// 2) 없으면 centroid 최근접(반경 radius_m 이내).
pub fn query_fac_building_detail(
    conn: &Connection,
    lat: f64,
    lon: f64,
    radius_m: f64,
) -> Result<Option<FacBuildingDetail>, String> {
    let eff_radius = radius_m.max(40.0);
    let buf = eff_radius / 111_000.0;
    // 상세 카드는 대장 높이(height)와 실측(1m DSM) 지붕고(height_measured)를 모두 보여주므로 둘 다 조회
    let mut stmt = conn.prepare(
        "SELECT building_name, dong_name, usability, pnu, bd_mgt_sn, height, COALESCE(ground_elev, 0), region, centroid_lat, centroid_lon, polygon_json, height_measured
         FROM fac_buildings
         WHERE centroid_lat BETWEEN ?1 AND ?2
           AND centroid_lon BETWEEN ?3 AND ?4"
    ).map_err(|e| format!("FAC 상세 쿼리 준비 실패: {}", e))?;

    let rows = stmt.query_map(
        params![lat - buf, lat + buf, lon - buf, lon + buf],
        |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, f64>(5)?,
                row.get::<_, f64>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, f64>(8)?,
                row.get::<_, f64>(9)?,
                row.get::<_, Option<String>>(10)?,
                row.get::<_, Option<f64>>(11)?,
            ))
        },
    ).map_err(|e| format!("FAC 상세 쿼리 실행 실패: {}", e))?;

    let mut contained: Option<FacBuildingDetail> = None;
    let mut best: Option<(f64, FacBuildingDetail)> = None; // (거리 km, 상세)

    for row in rows {
        let (name, dong_name, usage, pnu, bd_mgt_sn, height, ground_elev, region, clat, clon, polygon_json, height_measured) =
            row.map_err(|e| format!("FAC 상세 행 읽기 실패: {}", e))?;
        let detail = FacBuildingDetail {
            name, dong_name, usage, pnu, bd_mgt_sn,
            height_m: height, height_measured_m: height_measured, ground_elev_m: ground_elev,
            region, lat: clat, lon: clon,
        };
        // 1) 폴리곤 내부 포함 건물 우선 (정확)
        if contained.is_none() {
            if let Some(s) = polygon_json.as_deref() {
                if let Ok(poly) = serde_json::from_str::<Vec<[f64; 2]>>(s) {
                    let ring: Vec<(f64, f64)> = poly.iter().map(|p| (p[1], p[0])).collect();
                    if point_in_polygon_2d(lon, lat, &ring) {
                        contained = Some(detail);
                        continue;
                    }
                }
            }
        }
        // 2) centroid 최근접 후보 누적
        let d = crate::geo::haversine_km(lat, lon, clat, clon);
        if best.as_ref().map_or(true, |(bd, _)| d < *bd) {
            best = Some((d, detail));
        }
    }

    if let Some(c) = contained {
        return Ok(Some(c));
    }
    if let Some((d, detail)) = best {
        if d * 1000.0 <= eff_radius {
            return Ok(Some(detail));
        }
    }
    Ok(None)
}

/// 주소검색 좌표 인근 건물 1건 (footprint 포함) — 주소검색→3D 표출용
#[derive(Serialize, Clone, Debug)]
pub struct BuildingNearPoint {
    pub name: Option<String>,
    pub usage: Option<String>,        // fac 전용, manual 은 None
    pub source: String,               // "fac" | "manual"
    /// 유효 높이 (m) — fac 은 실측(1m DSM) 지붕고 우선, 없으면 대장 높이
    pub height_m: f64,
    /// 실측(1m DSM) 지붕고 (m) — 값이 있으면 height_m 이 실측값임을 뜻함(배지 표기용). manual 은 항상 None
    pub height_measured: Option<f64>,
    pub ground_elev_m: f64,
    pub lat: f64,                     // centroid
    pub lon: f64,
    /// footprint 링 목록 [[lat,lon],...] — 도형 없는 수동건물은 빈 벡터
    pub polygons: Vec<Vec<[f64; 2]>>,
    pub contained: bool,              // 검색점이 폴리곤 내부
    pub distance_m: f64,              // 검색점→centroid (contained 면 0)
}

/// [[lat,lon],...] JSON 배열 → 링 [[lat,lon],...] (3점 미만이면 None)
fn json_array_to_ring(val: &serde_json::Value) -> Option<Vec<[f64; 2]>> {
    let arr = val.as_array()?;
    let pts: Vec<[f64; 2]> = arr
        .iter()
        .filter_map(|p| {
            let lat = p.get(0)?.as_f64()?;
            let lon = p.get(1)?.as_f64()?;
            Some([lat, lon])
        })
        .collect();
    if pts.len() >= 3 { Some(pts) } else { None }
}

/// 수동 건물 geometry_json → footprint 링 목록 [[lat,lon],...] (주소검색 3D 표출용)
/// "polygon" = 단일 링, "multi" = [{type,json},...] 복수 링. 도형 없으면 빈 벡터.
fn manual_building_rings(geo_type: Option<&str>, geo_json: Option<&str>) -> Vec<Vec<[f64; 2]>> {
    let mut rings: Vec<Vec<[f64; 2]>> = Vec::new();
    let gt = match geo_type {
        Some(t) => t,
        None => return rings,
    };
    let json_str = match geo_json {
        Some(s) if !s.is_empty() => s,
        _ => return rings,
    };
    let val: serde_json::Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => return rings,
    };
    match gt {
        "polygon" => {
            if let Some(ring) = json_array_to_ring(&val) {
                rings.push(ring);
            }
        }
        "multi" => {
            // [{type, json}, ...] — 각 서브 도형의 json 은 [[lat,lon],...] 문자열
            if let Some(arr) = val.as_array() {
                for item in arr {
                    if item.get("type").and_then(|v| v.as_str()) != Some("polygon") {
                        continue;
                    }
                    if let Some(sj) = item.get("json").and_then(|v| v.as_str()) {
                        if let Ok(sv) = serde_json::from_str::<serde_json::Value>(sj) {
                            if let Some(ring) = json_array_to_ring(&sv) {
                                rings.push(ring);
                            }
                        }
                    }
                }
            }
        }
        _ => {}
    }
    rings
}

/// 주소검색 좌표 인근 건물 1건 조회 (fac + manual, footprint 포함).
/// 1) 폴리곤 내부 포함 건물 우선(다수면 fac 우선·동일소스면 최근접),
/// 2) 없으면 fac+manual 통틀어 centroid 최근접(반경 radius_m 이내). 그 외 None.
pub fn query_building_near_point(
    conn: &Connection,
    // GIS(건물통합정보) 건물을 centroid SRTM 으로 '지형 위'에 앉히기 위함(along_path 와 동일 소스).
    srtm: &mut crate::srtm::SrtmReader,
    lat: f64,
    lon: f64,
    radius_m: f64,
) -> Result<Option<BuildingNearPoint>, String> {
    let eff_radius = radius_m.max(80.0);
    let buf = eff_radius / 111_000.0;
    // 수동 건물은 centroid 가 폴리곤 중심이라, 큰 도형이면 검색점이 내부여도 centroid 가 bbox 밖일 수 있다.
    // 포함 판정(우선순위 1)을 놓치지 않도록 수동 후보 bbox 는 최소 ~330m 로 넉넉히.
    let manual_buf = buf.max(330.0 / 111_000.0);

    // 후보(fac + manual) 를 하나의 벡터에 모아 포함/최근접 판정.
    struct Cand {
        source: &'static str,
        name: Option<String>,
        usage: Option<String>,
        height_m: f64,
        height_measured: Option<f64>,
        ground_elev_m: f64,
        clat: f64,
        clon: f64,
        polygons: Vec<Vec<[f64; 2]>>,
    }
    let mut cands: Vec<Cand> = Vec::new();

    // ── FAC 건물 후보 ──
    // fac 지반 = centroid SRTM(live). ground_elev 캐시 컬럼은 미백필 행이 많아 사용 금지(프로젝트 불변식).
    // 높이는 실측(1m DSM) 지붕고 우선(COALESCE) — 3D 표출·상세 카드가 실측 형상과 일치하게.
    //   height_measured 는 별도로도 읽어 '실측' 배지 표기에 사용.
    let mut stmt = conn.prepare(
        "SELECT building_name, usability, COALESCE(height_measured, height), centroid_lat, centroid_lon, polygon_json, height_measured
         FROM fac_buildings
         WHERE centroid_lat BETWEEN ?1 AND ?2
           AND centroid_lon BETWEEN ?3 AND ?4"
    ).map_err(|e| format!("건물 근접 FAC 쿼리 준비 실패: {}", e))?;
    let rows = stmt.query_map(
        params![lat - buf, lat + buf, lon - buf, lon + buf],
        |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, f64>(3)?,
                row.get::<_, f64>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<f64>>(6)?,
            ))
        },
    ).map_err(|e| format!("건물 근접 FAC 쿼리 실행 실패: {}", e))?;
    for row in rows {
        let (name, usage, height, clat, clon, polygon_json, height_measured) =
            row.map_err(|e| format!("건물 근접 FAC 행 읽기 실패: {}", e))?;
        let mut polygons: Vec<Vec<[f64; 2]>> = Vec::new();
        if let Some(s) = polygon_json.as_deref() {
            if let Ok(poly) = serde_json::from_str::<Vec<[f64; 2]>>(s) {
                if poly.len() >= 3 {
                    polygons.push(poly);
                }
            }
        }
        let ground_elev = srtm.get_elevation(clat, clon).unwrap_or(0.0);
        cands.push(Cand {
            source: "fac",
            name,
            usage,
            height_m: height,
            height_measured,
            ground_elev_m: ground_elev,
            clat,
            clon,
            polygons,
        });
    }

    // ── 수동 건물 후보 ──
    // 그룹 enabled 게이트는 적용하지 않는다(명시적 주소검색이므로 활성/비활성 무관하게 항상 대상).
    // manual 지반 = 저장된 ground_elev(사용자 입력값) 그대로 사용.
    let mut stmt2 = conn.prepare(
        "SELECT name, latitude, longitude, height, ground_elev, geometry_type, geometry_json
         FROM manual_buildings
         WHERE latitude BETWEEN ?1 AND ?2
           AND longitude BETWEEN ?3 AND ?4"
    ).map_err(|e| format!("건물 근접 수동 쿼리 준비 실패: {}", e))?;
    let manual_rows = stmt2.query_map(
        params![lat - manual_buf, lat + manual_buf, lon - manual_buf, lon + manual_buf],
        |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, f64>(3)?,
                row.get::<_, f64>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        },
    ).map_err(|e| format!("건물 근접 수동 쿼리 실행 실패: {}", e))?;
    for row in manual_rows {
        let (name, mlat, mlon, height, ground_elev, geo_type, geo_json) =
            row.map_err(|e| format!("건물 근접 수동 행 읽기 실패: {}", e))?;
        let polygons = manual_building_rings(geo_type.as_deref(), geo_json.as_deref());
        cands.push(Cand {
            source: "manual",
            name,
            usage: None,
            height_m: height,
            height_measured: None,
            ground_elev_m: ground_elev,
            clat: mlat,
            clon: mlon,
            polygons,
        });
    }

    // 판정: ① 폴리곤 내부 포함(다수면 fac 우선·동일소스면 최근접) ② 없으면 centroid 최근접(반경 이내)
    let mut best_contained: Option<(bool, f64, usize)> = None; // (is_fac, dist_km, idx)
    let mut best_near: Option<(f64, usize)> = None;            // (dist_km, idx)

    for (i, c) in cands.iter().enumerate() {
        let d_km = crate::geo::haversine_km(lat, lon, c.clat, c.clon);
        // 포함 판정 — ring 은 (lon,lat) 좌표계로 변환 후 ray casting
        let mut contained = false;
        for ring in &c.polygons {
            let ring_ll: Vec<(f64, f64)> = ring.iter().map(|p| (p[1], p[0])).collect();
            if point_in_polygon_2d(lon, lat, &ring_ll) {
                contained = true;
                break;
            }
        }
        if contained {
            let is_fac = c.source == "fac";
            let better = match &best_contained {
                None => true,
                // fac 우선(승격만 허용), 동일 소스면 최근접
                Some((bf, bd, _)) => (is_fac && !*bf) || (is_fac == *bf && d_km < *bd),
            };
            if better {
                best_contained = Some((is_fac, d_km, i));
            }
        }
        if best_near.as_ref().map_or(true, |(bd, _)| d_km < *bd) {
            best_near = Some((d_km, i));
        }
    }

    let chosen: Option<(usize, bool, f64)> = if let Some((_, _, i)) = best_contained {
        Some((i, true, 0.0)) // contained → distance 0
    } else if let Some((d, i)) = best_near {
        if d * 1000.0 <= eff_radius {
            Some((i, false, d * 1000.0))
        } else {
            None
        }
    } else {
        None
    };

    if let Some((idx, contained, dist_m)) = chosen {
        let c = &cands[idx];
        return Ok(Some(BuildingNearPoint {
            name: c.name.clone(),
            usage: c.usage.clone(),
            source: c.source.to_string(),
            height_m: c.height_m,
            height_measured: c.height_measured,
            ground_elev_m: c.ground_elev_m,
            lat: c.clat,
            lon: c.clon,
            polygons: c.polygons.clone(),
            contained,
            distance_m: dist_m,
        }));
    }
    Ok(None)
}

/// 레이더점 ↔ 폴리곤 변(선분) 최단거리 (m)
/// 등거리원통 근사 — 레이더를 원점으로 Δlon 은 cos(lat) 로 축소해 m 로 환산.
/// 수백 m 스케일(자체 건물 판정)에서 투영 오차는 무시 가능.
fn point_seg_dist_m(
    plat: f64,
    plon: f64,
    cos_lat: f64,
    a: (f64, f64), // (lon, lat)
    b: (f64, f64), // (lon, lat)
) -> f64 {
    let ax = (a.0 - plon) * cos_lat * 111_000.0;
    let ay = (a.1 - plat) * 111_000.0;
    let bx = (b.0 - plon) * cos_lat * 111_000.0;
    let by = (b.1 - plat) * 111_000.0;
    let dx = bx - ax;
    let dy = by - ay;
    let len2 = dx * dx + dy * dy;
    if len2 < 1e-12 {
        // 퇴화 변(중복 꼭짓점) → 점거리
        return (ax * ax + ay * ay).sqrt();
    }
    // 원점(레이더)을 선분에 투영한 파라미터 t = −(A·d)/|d|² 를 [0,1] 로 클램프
    let t = (-(ax * dx + ay * dy) / len2).clamp(0.0, 1.0);
    let cx = ax + t * dx;
    let cy = ay + t * dy;
    (cx * cx + cy * cy).sqrt()
}

/// 레이더 좌표를 footprint 가 포함하거나 footprint 변까지 5m 이내인 fac 건물 id 목록 — "레이더 자체 건물".
/// 레이더가 설치된 구조물 자신이 해당 방위 LoS/커버리지/파노라마/BRA 를 가리는 오탐 방지용.
/// 실측3D blob 행(region='실측3D')과 대장 행이 같은 자리에 겹치면 모두 반환(보통 0~2건).
/// 조회 실패 시 빈 벡터(제외 없음, fail-open).
///
/// id 영속화 없이 매 호출 레이더 좌표로 재판정한다 — fac id 는 재임포트마다 바뀌므로 저장하면 곧 무효.
pub fn radar_own_building_ids(conn: &Connection, radar_lat: f64, radar_lon: f64) -> Vec<i64> {
    // 자체 건물 인정 여유 (m) — 4자리 반올림 레거시 좌표(≈11m 격자)가 좁은 타워 footprint 밖으로
    // 살짝 벗어나는 경우까지 흡수. 인접 동을 잘못 삼키지 않도록 최소값 유지.
    const SELF_BUF_M: f64 = 5.0;
    // 사전 필터 250m — footprint 가 centroid 에서 벗어나는 폭(대형 격납고·활주로변 구조물)을 감안.
    // centroid 인덱스를 그대로 타는 bbox 조회 (코드베이스 공통 관례). 높이 필터는 두지 않는다
    // (자체 건물은 대장 높이 0/NULL 이거나 실측3D blob 뿐일 수 있음).
    let buf = 250.0 / 111_000.0;

    let mut ids: Vec<i64> = Vec::new();

    let Ok(mut stmt) = conn.prepare(
        "SELECT id, polygon_json FROM fac_buildings
         WHERE centroid_lat BETWEEN ?1 AND ?2
           AND centroid_lon BETWEEN ?3 AND ?4",
    ) else {
        return ids; // 준비 실패 → 제외 없음(fail-open)
    };

    let Ok(rows) = stmt.query_map(
        params![radar_lat - buf, radar_lat + buf, radar_lon - buf, radar_lon + buf],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
    ) else {
        return ids; // 실행 실패 → 제외 없음(fail-open)
    };

    let cos_lat = radar_lat.to_radians().cos();

    for row in rows.flatten() {
        let (id, polygon_json) = row;
        // polygon_json 은 [[lat,lon],...] 단일 링 (전 코드 공통 관례) → (lon,lat) 로 변환
        let Some(pts) = polygon_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<Vec<[f64; 2]>>(s).ok())
        else {
            continue;
        };
        if pts.len() < 3 {
            continue;
        }
        let ring: Vec<(f64, f64)> = pts.iter().map(|p| (p[1], p[0])).collect();

        if point_in_polygon_2d(radar_lon, radar_lat, &ring) {
            ids.push(id);
            continue;
        }

        // 포함은 아니지만 변까지 5m 이내면 같은 구조물로 본다
        let n = ring.len();
        let mut min_d = f64::INFINITY;
        for i in 0..n {
            let j = (i + 1) % n;
            let d = point_seg_dist_m(radar_lat, radar_lon, cos_lat, ring[i], ring[j]);
            if d < min_d {
                min_d = d;
            }
        }
        if min_d <= SELF_BUF_M {
            ids.push(id);
        }
    }

    ids
}

/// LoS 경로(레이더→타겟) 상의 건물 조회
pub fn query_buildings_along_path(
    conn: &Connection,
    // GIS(건물통합정보) 건물을 centroid SRTM 으로 '지형 위'에 앉히기 위함 — 파노라마(panorama.rs)와 동일 소스.
    srtm: &mut crate::srtm::SrtmReader,
    radar_lat: f64,
    radar_lon: f64,
    target_lat: f64,
    target_lon: f64,
    corridor_width_m: f64,
    // OM 보고서 전용: 자료관리 그룹 활성화(enabled) 상태와 무관하게 모든 수동 건물 포함.
    //   라이브 LoS 뷰(TrackMap/LoSProfilePanel)는 false 로 호출해 그룹 토글을 그대로 존중한다.
    ignore_group_enabled: bool,
) -> Result<Vec<BuildingOnPath>, String> {
    // bbox 버퍼: 건물 폴리곤이 centroid에서 벗어날 수 있으므로 넉넉하게 (최소 200m)
    let bbox_buffer_m = corridor_width_m.max(200.0);
    let buffer_deg = bbox_buffer_m / 111_000.0;

    let min_lat = radar_lat.min(target_lat) - buffer_deg;
    let max_lat = radar_lat.max(target_lat) + buffer_deg;
    let min_lon = radar_lon.min(target_lon) - buffer_deg;
    let max_lon = radar_lon.max(target_lon) + buffer_deg;

    let total_dist = crate::geo::haversine_km(radar_lat, radar_lon, target_lat, target_lon);
    if total_dist < 0.001 {
        return Ok(Vec::new());
    }

    let dx = target_lon - radar_lon;
    let dy = target_lat - radar_lat;

    let mut buildings = Vec::new();

    // GIS(건물통합정보) 건물: 코리도(레이더→타겟)를 세그먼트로 쪼개 각 세그먼트 소형 bbox 로 후보 조회.
    //   종전엔 레이더~타겟 양끝 단일 bbox 라, 대각·장거리 코리도(단면도가 200NM 까지 연장될 때)에서는
    //   직선과 무관한 사각형 내부 수십만 동을 전부 폴리곤 파싱/교차해 느렸다(실측: 30NM 대각 47만 후보).
    //   세그먼트 bbox 는 직선에 밀착해 후보를 수십분의 1 로 줄인다(실측: 200NM 대각 595k→23k). centroid 인덱스 활용,
    //   인접 세그먼트 buffer 중첩분은 id 로 1회만 처리.
    // 높이는 실측(1m DSM) 지붕고 우선(COALESCE) — LoS 단면도/차단 판정이 실측 지붕고를 쓰도록.
    let mut stmt = conn.prepare(
        "SELECT id, centroid_lat, centroid_lon, COALESCE(height_measured, height), building_name, dong_name, usability, polygon_json
         FROM fac_buildings
         WHERE centroid_lat BETWEEN ?1 AND ?2
           AND centroid_lon BETWEEN ?3 AND ?4
           AND COALESCE(height_measured, height) > 0
           AND COALESCE(height_measured, height) <= ?5"
    ).map_err(|e| format!("쿼리 준비 실패: {}", e))?;

    // 세그먼트 길이 ~3km — 각 bbox 는 (3km + buffer) 정사각 근방. 짧은 코리도는 1세그먼트(종전과 동일).
    const SEG_KM: f64 = 3.0;
    let n_seg = ((total_dist / SEG_KM).ceil() as usize).max(1);
    let mut seen_ids: std::collections::HashSet<i64> = std::collections::HashSet::new();

    // 레이더 자체 건물(레이더가 올라앉은 구조물) 제외 목록 — 1회 산출.
    // 레이더점이 그 footprint 안이라 모든 방위에서 거리 0 차폐로 잡혀 자기 자신을 가린다.
    let own_ids = radar_own_building_ids(conn, radar_lat, radar_lon);

    for s in 0..n_seg {
        let t0 = s as f64 / n_seg as f64;
        let t1 = (s + 1) as f64 / n_seg as f64;
        let (lat0, lat1) = (radar_lat + t0 * dy, radar_lat + t1 * dy);
        let (lon0, lon1) = (radar_lon + t0 * dx, radar_lon + t1 * dx);
        let seg_min_lat = lat0.min(lat1) - buffer_deg;
        let seg_max_lat = lat0.max(lat1) + buffer_deg;
        let seg_min_lon = lon0.min(lon1) - buffer_deg;
        let seg_max_lon = lon0.max(lon1) + buffer_deg;

        let rows = stmt.query_map(
            params![seg_min_lat, seg_max_lat, seg_min_lon, seg_max_lon, MAX_BUILDING_HEIGHT_M],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, f64>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            },
        ).map_err(|e| format!("쿼리 실행 실패: {}", e))?;

        for row in rows {
            let (id, blat, blon, height, name, address, usage, polygon_json_str) =
                row.map_err(|e| format!("행 읽기 실패: {}", e))?;
            // 인접 세그먼트 bbox 가 buffer 만큼 겹치므로 id 로 중복 제거 (한 건물 1회만 처리)
            if !seen_ids.insert(id) {
                continue;
            }
            // 레이더 자체 건물은 장애물이 아니다 — 아래 "시작점이 폴리곤 내부" 분기에서
            // hit 0.0 이 들어가 전 방위가 거리 0 에서 차단되는 것을 원천 차단.
            // (타겟측 포함 판정 total_dist 는 그대로 — 타겟 건물 분석이 그 경로를 쓴다)
            if own_ids.contains(&id) {
                continue;
            }

            // 건물통합정보(GIS) 지반 = centroid SRTM(live). fac_buildings.ground_elev 캐시 컬럼은 백필 안 된 행이
            //   많아(NULL→COALESCE 0) 건물이 해수면에 가라앉아 LoS 차폐를 못 만들었다. 파노라마(panorama.rs:509)와
            //   동일하게 centroid SRTM 한 점으로 지반을 다시 잡아 단면도·TrackMap LoS·파노라마/소실통계 프레임 통일.
            let ground_elev = srtm.get_elevation(blat, blon).unwrap_or(0.0);

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
                    ground_elev_m: ground_elev,
                    total_height_m: height + ground_elev,
                    name,
                    address,
                    usage,
                    lat: rep_lat,
                    lon: rep_lon,
                    polygon: Some(poly_pts.clone()),
                    is_manual: false,
                    fac_id: Some(id),
                });
            } else {
                // 폴리곤 없는 GIS 건물은 제외
                continue;
            }
        }
    }

    // 수동 등록 건물도 경로 분석에 포함
    let geo_buffer = 0.01; // ~1.1km 버퍼 — 대형 도형 커버
    // ignore_group_enabled(OM 보고서)면 그룹 활성화 필터를 빼고 모든 수동 건물 포함.
    let group_filter = if ignore_group_enabled {
        ""
    } else {
        " AND (group_id IS NULL OR group_id IN (SELECT id FROM building_groups WHERE enabled = 1))"
    };
    let manual_sql = format!(
        "SELECT latitude, longitude, height, ground_elev, name, memo, geometry_type, geometry_json
         FROM manual_buildings
         WHERE latitude BETWEEN ?1 AND ?2
           AND longitude BETWEEN ?3 AND ?4{}",
        group_filter,
    );
    let mut stmt2 = conn.prepare(&manual_sql)
        .map_err(|e| format!("수동 건물 쿼리 준비 실패: {}", e))?;

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
                // ring 은 (lon, lat) 튜플 — BuildingOnPath.polygon 계약은 [lat, lon] 이라 뒤집어 담는다
                //   (프론트 지도 하이라이트가 수동 건물도 커버하도록)
                polygon: Some(ring.iter().map(|&(lon, lat)| [lat, lon]).collect()),
                is_manual: true,
                fac_id: None,
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
                fac_id: None,
            });
        } else {
            // point 타입 등 geometry 없는 수동 건물은 제외
            continue;
        }
    }

    buildings.sort_by(|a, b| a.distance_km.partial_cmp(&b.distance_km).unwrap_or(std::cmp::Ordering::Equal));

    Ok(buildings)
}

/// 타겟 지점의 LoS 기준선(최저탐지선) 산출 결과 — 타겟 자체 건물 제외.
#[derive(Serialize, Clone, Debug)]
pub struct LosBaselineResult {
    pub distance_km: f64,
    /// 타겟 거리에서의 기준선 높이 (AMSL m)
    pub baseline_amsl_m: f64,
    /// 기준선 앙각 (deg, 4/3 프레임)
    pub angle_deg: f64,
    /// 타겟 자체 건물로 제외된 fac 행 수 (검증용 — 프론트 미사용)
    pub excluded_count: usize,
}

/// 4/3 유효지구 곡률 강하 (m) — 단면도 curvDrop43 와 동일 식.
fn curv_drop43(d_km: f64) -> f64 {
    let d_m = d_km * 1000.0;
    d_m * d_m / (2.0 * (crate::geo::EARTH_RADIUS_M * 4.0 / 3.0))
}

/// 타겟 지점의 LoS 기준선(최저탐지선) — 타겟 자체 건물 제외.
/// BRA 호버 툴팁용: "이 건물이 없을 때의 LoS 선"이 타겟 거리에서 갖는 높이(AMSL).
/// 단면도(LoSProfilePanel minDetStraight)와 동일한 4/3 유효지구 running max 앙각 방식.
pub fn query_los_baseline(
    conn: &Connection,
    srtm: &mut crate::srtm::SrtmReader,
    radar_lat: f64,
    radar_lon: f64,
    radar_h_amsl: f64, // 안테나 AMSL = altitude + antenna_height (프론트에서 계산해 전달)
    target_lat: f64,
    target_lon: f64,
) -> Result<LosBaselineResult, String> {
    let total_d = crate::geo::haversine_km(radar_lat, radar_lon, target_lat, target_lon);
    if total_d < 0.001 {
        return Err("타겟이 레이더와 동일 지점".to_string());
    }

    // 타겟 자체 건물(호버한 건물 자신) id — 함수명은 radar 용이지만 좌표 순수 함수라 타겟 좌표에 그대로 유효.
    //   footprint 포함 or 변 5m 이내(실측3D blob 겹침 포함) 판정이 그대로 "이 건물 자신"을 잡는다.
    let own = radar_own_building_ids(conn, target_lat, target_lon);

    // 경로 건물 — 단면도와 동일 코리도 폭 100m·그룹 활성화(enabled) 존중
    let path_buildings = query_buildings_along_path(
        conn, srtm, radar_lat, radar_lon, target_lat, target_lon, 100.0, false,
    )?;
    let mut excluded_count = 0usize;
    let buildings: Vec<&BuildingOnPath> = path_buildings
        .iter()
        .filter(|b| {
            let is_own = b.fac_id.map(|id| own.contains(&id)).unwrap_or(false);
            if is_own {
                excluded_count += 1;
            }
            !is_own
        })
        .collect();

    // running max slope (slope = 높이차/수평거리 비율 — 단면도와 동일하게 tan 아닌 비율)
    let mut max_slope = f64::NEG_INFINITY;

    // 지형 샘플: 단면도와 동일한 0.5km 간격 + 타겟 지점(정확히 total_d).
    //   lat/lon 은 레이더→타겟 선형 보간 — query_buildings_along_path 의 파라메트릭 t 와 동일 프레임
    //   (건물 near/far 거리와 축 정합)
    let d_lat = target_lat - radar_lat;
    let d_lon = target_lon - radar_lon;
    let mut sample_ds: Vec<f64> = Vec::new();
    let mut k = 1usize;
    while (k as f64) * 0.5 < total_d - 1e-9 {
        sample_ds.push((k as f64) * 0.5);
        k += 1;
    }
    sample_ds.push(total_d); // 마지막은 정확히 타겟 지점 (위 루프가 total_d 직전까지만 담아 중복 없음)

    for d_k in sample_ds {
        let t = d_k / total_d;
        let s_lat = radar_lat + t * d_lat;
        let s_lon = radar_lon + t * d_lon;
        // 조회 실패/타일 없음은 0.0 — 단면도의 Math.max(0, elev) 클램프 미러
        let elev = srtm.get_elevation(s_lat, s_lon).unwrap_or(0.0).max(0.0);
        let ang = (elev - curv_drop43(d_k) - radar_h_amsl) / (d_k * 1000.0);
        if ang > max_slope {
            max_slope = ang;
        }
    }

    // 건물(자체 제외 후): 단면도 obstacles 배열이 건물 양끝 엣지를 넣는 것의 미러
    for b in &buildings {
        let b_top = b.ground_elev_m + b.height_m;
        for d_e in [b.near_dist_km, b.far_dist_km] {
            if d_e <= 0.0 || d_e > total_d + 1e-9 {
                continue;
            }
            let ang = (b_top - curv_drop43(d_e) - radar_h_amsl) / (d_e * 1000.0);
            if ang > max_slope {
                max_slope = ang;
            }
        }
    }

    // 지형 샘플이 최소 1개(타겟 지점) 있으므로 max_slope 는 항상 유한
    let baseline_amsl_m = radar_h_amsl + max_slope * (total_d * 1000.0) + curv_drop43(total_d);

    Ok(LosBaselineResult {
        distance_km: total_d,
        baseline_amsl_m,
        angle_deg: max_slope.atan().to_degrees(),
        excluded_count,
    })
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
    /// 실측(1m DSM) 데이터 보유 건물 — 실측 3D 메시 타일 표출 시 박스 숨김 대상
    pub measured: bool,
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
               AND (mb.height + mb.ground_elev) >= ?5
               AND (mb.group_id IS NULL OR bg.enabled = 1)"
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

            let sample_pts = expand_manual_building_geometry(lat, lon, geo_type.as_deref(), geo_json.as_deref());
            let polygon: Vec<[f64; 2]> = if sample_pts.len() < 3 {
                let d = 0.000045;
                vec![[lat - d, lon - d], [lat - d, lon + d], [lat + d, lon + d], [lat + d, lon - d]]
            } else {
                sample_pts.iter().map(|(la, lo)| [*la, *lo]).collect()
            };

            // 패킹: [lon, lat, ground_elev, height, vertexCount, v0_lon, v0_lat, ...]
            floats.push(lon);
            floats.push(lat);
            floats.push(ground_elev);
            floats.push(height);
            floats.push(polygon.len() as f64);
            for [vlat, vlon] in &polygon {
                floats.push(*vlon);
                floats.push(*vlat);
            }

            metas.push(Building3DMeta {
                name, usage: None, source: "manual".to_string(), group_color, measured: false,
            });
        }
    }

    // FAC 건물 (fac_buildings 테이블 없을 수 있음 — 실패 시 무시)
    if !skip_fac {
        // 높이는 실측(1m DSM) 지붕고 우선(COALESCE) — 3D 건물 렌더 높이/필터/정렬 모두 동일 기준.
        if let Ok(mut stmt) = conn.prepare(
            "SELECT centroid_lat, centroid_lon, COALESCE(height_measured, height), building_name, usability, polygon_json, COALESCE(ground_elev, 0),
                    (height_measured IS NOT NULL OR region = '실측3D')
             FROM fac_buildings
             WHERE centroid_lat BETWEEN ?1 AND ?2
               AND centroid_lon BETWEEN ?3 AND ?4
               AND COALESCE(height_measured, height) >= ?5
               AND COALESCE(height_measured, height) <= ?6
             ORDER BY COALESCE(height_measured, height) DESC
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
                        row.get::<_, f64>(6)?,
                        row.get::<_, bool>(7)?,
                    ))
                },
            ) {
                for row in rows {
                    let (lat, lon, height, name, usage, poly_json, ground_elev, measured) = match row {
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
                    floats.push(ground_elev);
                    floats.push(height);
                    floats.push(polygon.len() as f64);
                    for [vlat, vlon] in &polygon {
                        floats.push(*vlon);
                        floats.push(*vlat);
                    }

                    metas.push(Building3DMeta {
                        name, usage, source: "fac".to_string(), group_color: None, measured,
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
    /// 활성화 여부 (false이면 LoS/커버리지/3D 렌더링에서 제외)
    pub enabled: bool,
}

/// 건물 그룹 전체 조회
pub fn list_building_groups(conn: &Connection) -> Result<Vec<BuildingGroup>, String> {
    let mut stmt = conn.prepare(
        "SELECT id, name, color, memo, (plan_image IS NOT NULL) AS has_plan_image, plan_bounds_json, plan_opacity, plan_rotation, area_bounds_json, enabled FROM building_groups ORDER BY id"
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
            enabled: row.get::<_, i32>(9).unwrap_or(1) != 0,
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

/// 건물 그룹 활성화 플래그 변경
pub fn set_building_group_enabled(
    conn: &Connection,
    id: i64,
    enabled: bool,
) -> Result<(), String> {
    conn.execute(
        "UPDATE building_groups SET enabled = ?1 WHERE id = ?2",
        params![enabled as i32, id],
    ).map_err(|e| format!("UPDATE enabled 실패: {}", e))?;
    Ok(())
}

/// 건물 그룹 삭제 (소속 건물의 group_id는 ON DELETE SET NULL로 자동 해제)
pub fn delete_building_group(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM building_groups WHERE id = ?1", params![id])
        .map_err(|e| format!("DELETE 실패: {}", e))?;
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
    /// 지면 표고 입력 모드 'auto'|'manual'|''(레거시)
    pub elev_mode: String,
}

/// 수동 건물 전체 조회
pub fn list_manual_buildings(conn: &Connection) -> Result<Vec<ManualBuilding>, String> {
    let mut stmt = conn.prepare(
        "SELECT id, name, latitude, longitude, height, ground_elev, memo, geometry_type, geometry_json, group_id, elev_mode FROM manual_buildings ORDER BY id"
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
            elev_mode: row.get::<_, Option<String>>(10)?.unwrap_or_default(),
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
    elev_mode: &str,
    memo: &str,
    geometry_type: &str,
    geometry_json: Option<&str>,
    group_id: Option<i64>,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO manual_buildings (name, latitude, longitude, height, ground_elev, elev_mode, memo, geometry_type, geometry_json, group_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![name, latitude, longitude, height, ground_elev, elev_mode, memo, geometry_type, geometry_json, group_id],
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
    elev_mode: &str,
    memo: &str,
    geometry_type: &str,
    geometry_json: Option<&str>,
    group_id: Option<i64>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE manual_buildings SET name=?1, latitude=?2, longitude=?3, height=?4, ground_elev=?5, elev_mode=?6, memo=?7, geometry_type=?8, geometry_json=?9, group_id=?10 WHERE id=?11",
        params![name, latitude, longitude, height, ground_elev, elev_mode, memo, geometry_type, geometry_json, group_id, id],
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
