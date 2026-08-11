//! BRA(Building Restricted Area) 침범 검사
//!
//! 레이더 안테나 정점에서 전방위로 기준각 θ(기본 0.25°) 기울기로 올라가는 **BRA 원추면**을
//! 관통(침범)하는 건물을 DB 전수 스캔으로 찾는다.
//!
//! 판정 프레임은 LoS 단면도의 BRA 기준선(`LoSProfilePanel` braAMSL)과 **동일한 실제지구 기하 직선**:
//!   `coneMsl(d) = h_ant + d·tan(θ) + d²/(2R)`,  R = 실제지구반경(6,371km)
//! 4/3 유효지구 굴절은 적용하지 않는다 — 기존 BRA 정의(장애물 제한표면)와 일치시키기 위함.
//! (CLAUDE.md 의 "앙각·차단 곡률은 4/3" 규칙은 LoS 차단 판정 계열에 대한 것이고,
//!  BRA 는 굴절과 무관한 기하 제한면이라 실제지구 프레임을 유지한다.)
//!
//! 건물 지붕 해발고는 `centroid 라이브 SRTM + COALESCE(height_measured, height)`.
//! `fac_buildings.ground_elev` 캐시 컬럼은 백필 안 된 행이 많아 사용 금지(building.rs:593 주석 참조).
//!
//! **우선순위 중복 제거**: 상위 자료(수동등록 > 실측3D)에 덮인 후순위 fac 행은 저장 시점
//! `suppressed_by` 플래그(등록/임포트 시 확정, suppression.rs)로 이미 걸러져 있으므로
//! 후보 쿼리에서 `suppressed_by IS NULL` 로 단순 필터한다 — 조회 시점 겹침 계산 없음.
//! 같은 자리의 중복 행이 프리즘으로 이중 렌더되는 것을 막는다. 수동 등록 건물은 억제 대상 아님.

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::geo::EARTH_RADIUS_M;
use crate::srtm::SrtmReader;

/// 건물 높이 상한 (m) — building.rs / panorama.rs 와 동일 (롯데월드타워 ~555m + 여유)
const MAX_BUILDING_HEIGHT_M: f64 = 650.0;
/// 국내 지붕고 해발 상한 (m) — 최대 지반(~1,950m) + 건물 상한 650m. 스캔 반경 해석적 상한 산출용.
const MAX_ROOF_MSL_M: f64 = 2_600.0;
/// centroid 기준 사전 컷 슬랙 (m) — 대형 풋프린트(정점이 centroid 보다 최대 ~1km 앞) 대비
const FOOTPRINT_SLACK_M: f64 = 1000.0;
/// Pass 2 폴리곤 조회 배치 크기 (id IN (...))
const POLY_BATCH: usize = 500;

/// BRA 침범 검사 결과
#[derive(Serialize)]
pub struct BraResult {
    /// 기준각 (°)
    pub angle_deg: f64,
    /// 안테나 정점 해발고 (m AMSL)
    pub radar_height_m: f64,
    /// 스캔 반경 (km) — 요청 반경과 해석적 상한 중 작은 쪽
    pub max_range_km: f64,
    /// 검사한 건물 수 (fac + manual)
    pub scanned: u64,
    /// 침범 총수 (= buildings.len())
    pub total_penetrating: u64,
    /// 폴리곤 파싱 실패/3점 미만으로 판정 불가 처리된 fac 후보 동수
    pub skipped_invalid_polygon: u64,
    /// 침범 건물 (exceed_m 내림차순, 전수)
    pub buildings: Vec<BraBuilding>,
}

/// BRA 원추면을 침범한 건물 1동
#[derive(Serialize)]
pub struct BraBuilding {
    /// fac_buildings.id 또는 manual_buildings.id
    pub id: i64,
    /// "fac" | "manual" (building.rs BuildingNearPoint 관례)
    pub source: String,
    /// 실측(1m DSM) 지붕고 반영 여부
    pub measured: bool,
    pub name: Option<String>,
    /// fac = dong_name, manual = memo
    pub address: Option<String>,
    pub usage: Option<String>,
    /// centroid 위도
    pub lat: f64,
    /// centroid 경도
    pub lon: f64,
    /// 판정 지점(레이더 최근접 경계점)까지 지표 거리 (km)
    pub distance_km: f64,
    /// centroid 방위 (°, 정북=0, 시계방향)
    pub azimuth_deg: f64,
    /// 지반 표고 (m AMSL)
    pub ground_elev_m: f64,
    /// 건물 높이 (m, AGL)
    pub height_m: f64,
    /// 지붕 해발고 (m AMSL) = ground_elev_m + height_m
    pub total_height_m: f64,
    /// 판정 지점의 원추면 해발고 (m AMSL)
    pub cone_msl_m: f64,
    /// 초과량 (m) = total_height_m − cone_msl_m (> 0 이면 침범)
    pub exceed_m: f64,
    /// 폴리곤 꼭짓점 [[lat, lon], ...] — 프론트 3D 오버레이 프리즘용
    pub polygon: Vec<[f64; 2]>,
}

/// BRA 원추면 해발고 (m AMSL) — LoSProfilePanel 의 braAMSL 과 동일 식
#[inline]
fn cone_msl(radar_height_m: f64, tan_theta: f64, d_m: f64) -> f64 {
    radar_height_m + d_m * tan_theta + (d_m * d_m) / (2.0 * EARTH_RADIUS_M)
}

/// 레이더 중심 ENU 평면 거리 (m) — panorama.rs wgs84_to_enu 와 동일 스케일(평면투영에만 실제지구 반경 사용)
#[inline]
fn enu_dist_m(cos_lat: f64, radar_lat: f64, radar_lon: f64, lat: f64, lon: f64) -> f64 {
    let east = (lon - radar_lon).to_radians() * EARTH_RADIUS_M * cos_lat;
    let north = (lat - radar_lat).to_radians() * EARTH_RADIUS_M;
    (east * east + north * north).sqrt()
}

/// 원추면이 MAX_ROOF_MSL_M 에 도달하는 지표거리 (m) — 그 밖은 어떤 건물도 침범 불가
/// `h + d·t + d²/(2R) = MAX` 를 d 에 대해 푼 양근 (a=1/(2R), b=t, c=h−MAX)
fn analytic_range_limit_m(radar_height_m: f64, tan_theta: f64) -> f64 {
    let c = radar_height_m - MAX_ROOF_MSL_M;
    if c >= 0.0 {
        return 0.0; // 안테나가 이미 상한 위 — 침범 가능한 건물 없음
    }
    let a = 1.0 / (2.0 * EARTH_RADIUS_M);
    let b = tan_theta;
    let disc = (b * b - 4.0 * a * c).max(0.0);
    (-b + disc.sqrt()) / (2.0 * a)
}

/// Pass 1 통과 후보 (폴리곤 미포함 — 폴리곤 JSON 파싱은 Pass 2 에서만)
struct FacCandidate {
    id: i64,
    clat: f64,
    clon: f64,
    height_m: f64,
    ground_elev_m: f64,
    measured: bool,
}

/// BRA 침범 검사 본체
///
/// 2-pass 구성: Pass 1 은 centroid + 높이만 읽어 원추면 여유로 후보를 좁히고(폴리곤 JSON 미파싱),
/// Pass 2 에서 후보 id 배치로 폴리곤/속성을 읽어 경계 최근접 거리로 확정 판정한다.
/// (단일 pass 로 폴리곤까지 읽으면 수십만 동 JSON 파싱이 지배적 — building.rs:539 주석과 동일한 함정)
pub fn analyze_penetration(
    srtm: &mut SrtmReader,
    conn: &Connection,
    radar_lat: f64,
    radar_lon: f64,
    radar_height_m: f64,
    angle_deg: f64,
    max_range_km: f64,
) -> Result<BraResult, String> {
    let tan_theta = angle_deg.to_radians().tan();
    let mut scanned: u64 = 0;
    let mut skipped_invalid_polygon: u64 = 0;
    let mut hits: Vec<BraBuilding> = Vec::new();

    // 스캔 반경 = 제원 범위와 해석적 상한 중 작은 쪽
    let d_max = (max_range_km * 1000.0).min(analytic_range_limit_m(radar_height_m, tan_theta));
    if d_max < 1.0 {
        return Ok(BraResult {
            angle_deg,
            radar_height_m,
            max_range_km: d_max / 1000.0,
            scanned: 0,
            total_penetrating: 0,
            skipped_invalid_polygon: 0,
            buildings: Vec::new(),
        });
    }

    // bbox (panorama.rs:519 스타일 평면 근사)
    let cos_lat = radar_lat.to_radians().cos().max(0.5);
    let d_lat = d_max / 111_000.0;
    let d_lon = d_max / (111_000.0 * cos_lat);
    let min_lat = radar_lat - d_lat;
    let max_lat = radar_lat + d_lat;
    let min_lon = radar_lon - d_lon;
    let max_lon = radar_lon + d_lon;

    // SRTM 타일 선로드 → 이후 루프는 읽기 전용 elevation_from_tiles 만 사용 (&mut 반복 호출 금지)
    srtm.preload_tiles(
        min_lat.floor() as i32,
        max_lat.floor() as i32,
        min_lon.floor() as i32,
        max_lon.floor() as i32,
    );

    // 레이더 자체 건물(레이더가 올라앉은 구조물) — 안테나 발밑이라 원추면 시작점을 항상 뚫는다.
    // BRA 침범 목록에 자기 자신이 오르는 것을 막는다.
    let own_ids = crate::building::radar_own_building_ids(conn, radar_lat, radar_lon);

    // ── Pass 1: 건물통합정보(fac) 후보 좁히기 — 폴리곤 JSON 미포함 ──
    let mut candidates: Vec<FacCandidate> = Vec::new();
    {
        let tiles = srtm.tiles_ref();
        let mut stmt = conn
            .prepare(
                "SELECT id, centroid_lat, centroid_lon, COALESCE(height_measured, height),
                        (height_measured IS NOT NULL OR region = '실측3D')
                 FROM fac_buildings
                 WHERE centroid_lat BETWEEN ?1 AND ?2
                   AND centroid_lon BETWEEN ?3 AND ?4
                   AND COALESCE(height_measured, height) > 0
                   AND COALESCE(height_measured, height) <= ?5
                   AND suppressed_by IS NULL",
            )
            .map_err(|e| format!("BRA 후보 쿼리 준비 실패: {}", e))?;

        let rows = stmt
            .query_map(
                params![min_lat, max_lat, min_lon, max_lon, MAX_BUILDING_HEIGHT_M],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, f64>(1)?,
                        row.get::<_, f64>(2)?,
                        row.get::<_, f64>(3)?,
                        row.get::<_, bool>(4)?,
                    ))
                },
            )
            .map_err(|e| format!("BRA 후보 쿼리 실행 실패: {}", e))?;

        for row in rows {
            let (id, clat, clon, height_m, measured) =
                row.map_err(|e| format!("BRA 후보 행 읽기 실패: {}", e))?;
            scanned += 1;

            if own_ids.contains(&id) {
                continue; // 레이더 자체 건물
            }

            let d_c = enu_dist_m(cos_lat, radar_lat, radar_lon, clat, clon);
            if d_c > d_max + FOOTPRINT_SLACK_M {
                continue;
            }
            // 건물통합정보(GIS) 지반 = centroid SRTM(live) — ground_elev 캐시 컬럼 사용 금지
            let ground_elev_m = crate::srtm::elevation_from_tiles(tiles, clat, clon);
            // 사전 컷: 풋프린트가 centroid 보다 최대 슬랙만큼 앞설 수 있으므로 그 지점 원추면과 비교
            let d_probe = (d_c - FOOTPRINT_SLACK_M).max(1.0);
            if ground_elev_m + height_m > cone_msl(radar_height_m, tan_theta, d_probe) {
                candidates.push(FacCandidate { id, clat, clon, height_m, ground_elev_m, measured });
            }
        }
    }

    // ── Pass 2: 후보 폴리곤/속성 배치 조회 → 최근접 경계점으로 확정 판정 ──
    for chunk in candidates.chunks(POLY_BATCH) {
        // id 는 DB 에서 읽은 i64 — 문자열 결합 안전 (panorama.rs 의 exclude_manual_ids 관례와 동일)
        let id_list: Vec<String> = chunk.iter().map(|c| c.id.to_string()).collect();
        let sql = format!(
            "SELECT id, polygon_json, building_name, dong_name, usability
             FROM fac_buildings WHERE id IN ({})",
            id_list.join(",")
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("BRA 폴리곤 쿼리 준비 실패: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(|e| format!("BRA 폴리곤 쿼리 실행 실패: {}", e))?;

        for row in rows {
            let (id, poly_json, name, address, usage) =
                row.map_err(|e| format!("BRA 폴리곤 행 읽기 실패: {}", e))?;
            let Some(cand) = chunk.iter().find(|c| c.id == id) else { continue };

            // 폴리곤은 [[lat, lon], ...] (기존 파싱 관례). 3점 미만/파싱 실패는 제외.
            let polygon: Vec<[f64; 2]> = match poly_json
                .as_deref()
                .and_then(|s| serde_json::from_str::<Vec<[f64; 2]>>(s).ok())
            {
                Some(p) if p.len() >= 3 => p,
                _ => {
                    skipped_invalid_polygon += 1;
                    continue;
                }
            };

            if let Some(b) = judge(
                cos_lat, radar_lat, radar_lon, radar_height_m, tan_theta, d_max,
                id, "fac", cand.measured, name, address, usage,
                cand.clat, cand.clon, cand.ground_elev_m, cand.height_m, polygon,
            ) {
                hits.push(b);
            }
        }
    }

    // ── 수동 등록 건물 (manual_buildings) — panorama.rs collect_building_obstacles 와 동일 취급:
    //    지반은 저장된 ground_elev(사용자 입력/자동 SRTM 확정값), 기하는 expand_manual_geometry ──
    {
        let geo_buffer = 0.01; // ~1.1km — 대형 도형 커버 (building.rs/panorama.rs 관례)
        let mut stmt = conn
            .prepare(
                "SELECT id, latitude, longitude, height, ground_elev, name, memo, geometry_type, geometry_json
                 FROM manual_buildings
                 WHERE latitude BETWEEN ?1 AND ?2
                   AND longitude BETWEEN ?3 AND ?4",
            )
            .map_err(|e| format!("BRA 수동 건물 쿼리 준비 실패: {}", e))?;

        let rows = stmt
            .query_map(
                params![
                    min_lat - geo_buffer,
                    max_lat + geo_buffer,
                    min_lon - geo_buffer,
                    max_lon + geo_buffer
                ],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, f64>(1)?,
                        row.get::<_, f64>(2)?,
                        row.get::<_, f64>(3)?,
                        row.get::<_, f64>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, Option<String>>(8)?,
                    ))
                },
            )
            .map_err(|e| format!("BRA 수동 건물 쿼리 실행 실패: {}", e))?;

        for row in rows {
            let (id, mlat, mlon, height_m, ground_elev_m, name, memo, geo_type, geo_json) =
                row.map_err(|e| format!("BRA 수동 건물 행 읽기 실패: {}", e))?;
            scanned += 1;
            if height_m <= 0.0 {
                continue;
            }

            let pts = super::panorama::expand_manual_geometry(
                mlat, mlon, geo_type.as_deref(), geo_json.as_deref(),
            );
            // 폴리곤 미형성(point/line 등)은 중심 주변 소형 정사각으로 대체 —
            //   building.rs 의 binary 패킹 폴백(±0.000045° ≈ 5m)과 동일 규약이라 프론트 프리즘 렌더가 통일된다.
            let polygon: Vec<[f64; 2]> = if pts.len() >= 3 {
                pts.iter().map(|&(la, lo)| [la, lo]).collect()
            } else {
                let d = 0.000045;
                vec![
                    [mlat - d, mlon - d],
                    [mlat - d, mlon + d],
                    [mlat + d, mlon + d],
                    [mlat + d, mlon - d],
                ]
            };

            if let Some(b) = judge(
                cos_lat, radar_lat, radar_lon, radar_height_m, tan_theta, d_max,
                id, "manual", false, name, memo, None,
                mlat, mlon, ground_elev_m, height_m, polygon,
            ) {
                hits.push(b);
            }
        }
    }

    // 초과량 내림차순 — 상한 없이 전수 반환 (지도 프리즘 마킹이 목록 상한에 잘리면 안 된다)
    hits.sort_by(|a, b| b.exceed_m.partial_cmp(&a.exceed_m).unwrap_or(std::cmp::Ordering::Equal));
    let total_penetrating = hits.len() as u64;

    log::info!(
        "[BRA] 기준각 {:.2}° · 안테나 {:.1}m AMSL · 반경 {:.1}km — 검사 {}동, 침범 {}동{}",
        angle_deg, radar_height_m, d_max / 1000.0, scanned, total_penetrating,
        if skipped_invalid_polygon > 0 {
            format!(" (폴리곤 불량 {}동 제외)", skipped_invalid_polygon)
        } else {
            String::new()
        },
    );

    Ok(BraResult {
        angle_deg,
        radar_height_m,
        max_range_km: d_max / 1000.0,
        scanned,
        total_penetrating,
        skipped_invalid_polygon,
        buildings: hits,
    })
}

/// 확정 판정 — 폴리곤 경계(변 위 최근접점 포함) 중 레이더 최근접 지점에서 원추면을 넘는지.
/// 원추면은 d 에 대해 단조증가이므로 최근접 경계점에서 초과량이 최대다.
/// 최근접 경계점이 스캔 반경(d_max) 밖이면 제외 — fac 은 centroid 사전컷 슬랙(FOOTPRINT_SLACK_M),
/// 수동 건물은 bbox 코너까지 반경 밖으로 넘칠 수 있어 여기서 최종 컷한다.
#[allow(clippy::too_many_arguments)]
fn judge(
    cos_lat: f64,
    radar_lat: f64,
    radar_lon: f64,
    radar_height_m: f64,
    tan_theta: f64,
    d_max: f64,
    id: i64,
    source: &str,
    measured: bool,
    name: Option<String>,
    address: Option<String>,
    usage: Option<String>,
    clat: f64,
    clon: f64,
    ground_elev_m: f64,
    height_m: f64,
    polygon: Vec<[f64; 2]>,
) -> Option<BraBuilding> {
    // 정점을 레이더 원점 ENU (east, north) 로 1회 변환 — enu_dist_m 과 동일 스케일
    let n = polygon.len();
    let mut pts: Vec<(f64, f64)> = Vec::with_capacity(n);
    for p in &polygon {
        let east = (p[1] - radar_lon).to_radians() * EARTH_RADIUS_M * cos_lat;
        let north = (p[0] - radar_lat).to_radians() * EARTH_RADIUS_M;
        pts.push((east, north));
    }
    // 변(i, i+1) 마다 원점→선분 최근접점 거리를 구해 최소값 — 정점 전용 최소는 긴 변의 중간이
    // 레이더 쪽으로 더 가까운 대형 풋프린트에서 거리를 과대평가(= 침범 누락)한다.
    let mut d_min = f64::INFINITY;
    for i in 0..n {
        let (ax, ay) = pts[i];
        let (bx, by) = pts[(i + 1) % n];
        let (ex, ey) = (bx - ax, by - ay);
        let len2 = ex * ex + ey * ey;
        // 퇴화(선분 길이 0)면 t=0 → 정점 거리로 폴백
        let t = if len2 > 0.0 {
            (-(ax * ex + ay * ey) / len2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let (qx, qy) = (ax + ex * t, ay + ey * t);
        let d = (qx * qx + qy * qy).sqrt();
        if d < d_min {
            d_min = d;
        }
    }
    if !d_min.is_finite() {
        return None;
    }
    if d_min > d_max {
        return None; // 최근접 경계점이 스캔 반경 밖 — 원추 표시 반경과 결과 정합 유지
    }
    let total_height_m = ground_elev_m + height_m;
    let cone = cone_msl(radar_height_m, tan_theta, d_min);
    let exceed_m = total_height_m - cone;
    if exceed_m <= 0.0 {
        return None;
    }
    Some(BraBuilding {
        id,
        source: source.to_string(),
        measured,
        name,
        address,
        usage,
        lat: clat,
        lon: clon,
        distance_km: d_min / 1000.0,
        azimuth_deg: crate::geo::bearing_deg(radar_lat, radar_lon, clat, clon),
        ground_elev_m,
        height_m,
        total_height_m,
        cone_msl_m: cone,
        exceed_m,
        polygon,
    })
}
