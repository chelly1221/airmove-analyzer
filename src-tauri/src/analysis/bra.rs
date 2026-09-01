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
//! 같은 자리의 중복 행이 침범 목록에 이중 계상되는 것을 막는다. 수동 등록 건물은 억제 대상 아님.
//!
//! **타워크레인**(`tower_cranes`, crane.rs)도 같은 원추면으로 함께 판정한다. 크레인 1기는
//! 마스트/지브/카운터지브(또는 전방위 선회 범위) 부위로 나눠 각각 판정하고 **초과량이 가장 큰
//! 부위 1건만** 결과에 올린다(크레인당 최대 1행, `source = "crane"`, `usage` = 그 부위명).
//! 크레인 반영은 **BRA 침범 검사에 한정**한다 — LoS 단면도·파노라마·커버리지·OM 보고서는
//! 지상 기립 프리즘(밑면 = 지반)을 전제하는데 지브는 밑면이 공중이라 지상까지 막는 벽으로
//! 오판된다(1단계. 2단계 `base_m` 지원 후 반영).
//!
//! **대장↔대장 이중 임포트**는 위 억제 체계(수동/실측 우선순위 전용)로 걸러지지 않는다 —
//! 광역본(F_FAC_BUILDING_경기)과 세분본(F_FAC_BUILDING_경기_부천시_소사구) SHP 가 같은 건물을
//! 비트 동일한 centroid·높이·폴리곤으로 각각 싣기 때문. 결과 수준에서 `fold_fac_duplicates` 로 접는다.

use std::collections::{HashMap, HashSet};

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
/// 타워크레인 지브/카운터지브 폭 (m) — 트러스 하현 간격 (프론트 craneGeometry.ts 와 동일 값)
const JIB_WIDTH_M: f64 = 2.0;
/// 타워크레인 지브 트러스 높이 (m) — 지브 상단 AGL = jib_height + 이 값
const JIB_TRUSS_H: f64 = 1.5;
/// 전방위(full) 선회 범위 원판 근사 분할 수
const SWEEP_SEGMENTS: usize = 64;

/// BRA 침범 검사 결과
#[derive(Serialize)]
pub struct BraResult {
    /// 기준각 (°)
    pub angle_deg: f64,
    /// 안테나 정점 해발고 (m AMSL)
    pub radar_height_m: f64,
    /// 스캔 반경 (km) — 요청 반경과 해석적 상한 중 작은 쪽
    pub max_range_km: f64,
    /// 검사한 건물 수 (fac + manual + crane)
    pub scanned: u64,
    /// 침범 총수 (= buildings.len(), 대장 중복 접기 후)
    pub total_penetrating: u64,
    /// 폴리곤 파싱 실패/3점 미만으로 판정 불가 처리된 fac 후보 동수
    pub skipped_invalid_polygon: u64,
    /// 대장 이중 임포트(광역본↔세분본)로 접어낸 중복 행 수
    pub folded_duplicates: u64,
    /// 침범 건물 (exceed_m 내림차순, 전수)
    pub buildings: Vec<BraBuilding>,
    /// 반경 내 타워크레인 방위각 스윕 (등록 순, 침범 여부 무관)
    pub cranes: Vec<BraCraneSweep>,
}

/// 타워크레인 1기의 지브 방위각 스윕 판정 — 방위를 1° 씩 돌려 본 BRA 초과량 곡선과 최악/최선 방위.
/// 초과량은 **부호를 유지**한다(양수 = 원추면 침범, 음수 = 여유).
#[derive(Serialize)]
pub struct BraCraneSweep {
    /// tower_cranes.id
    pub id: i64,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    /// 마스트 중심까지 지표 거리 (km)
    pub distance_km: f64,
    /// 레이더 → 크레인 방위 (°, 정북=0, 시계방향)
    pub azimuth_deg: f64,
    /// 등록 상태 스냅샷 — 선회 모드 'fixed' | 'full'
    pub rotation_mode: String,
    /// 등록 상태 스냅샷 — 지브 방위각 (°)
    pub jib_azimuth_deg: f64,
    /// 마스트 단독(방위 무관) 초과량 (m) = ground + top_height − cone(마스트 최근접)
    pub mast_exceed_m: f64,
    /// 현재 등록 상태(선회 모드·방위각)의 초과량 (m) — 침범 행 exceed_m 과 같은 정의(음수 유지)
    pub current_exceed_m: f64,
    /// 초과량이 최대인 방위각 (°, 첫 등장)
    pub worst_deg: u16,
    /// 그 방위의 초과량 (m)
    pub worst_exceed_m: f64,
    /// 초과량이 최소인 방위각 (°, 첫 등장)
    pub best_deg: u16,
    /// 그 방위의 초과량 (m)
    pub best_exceed_m: f64,
    /// 전방위 최악조건 초과량 (m) — 선회 범위 원판(반경 max(지브, 카운터지브))으로 본 값.
    /// 등록 선회 모드와 무관하게 항상 산출한다(보고서 "전방위 최악조건" 케이스).
    pub full_exceed_m: f64,
    /// θ = 0..359° 각각을 고정 지브로 봤을 때의 초과량 (m, 길이 360)
    pub exceed_by_deg: Vec<f32>,
}

/// BRA 원추면을 침범한 건물 1동
#[derive(Serialize)]
pub struct BraBuilding {
    /// fac_buildings.id · manual_buildings.id · tower_cranes.id
    pub id: i64,
    /// "fac" | "manual" | "crane" (building.rs BuildingNearPoint 관례)
    pub source: String,
    /// 실측(1m DSM) 지붕고 반영 여부
    pub measured: bool,
    pub name: Option<String>,
    /// fac = dong_name, manual/crane = memo
    pub address: Option<String>,
    /// fac = usability, crane = 초과량 최대 부위("마스트"|"지브"|"카운터지브"|"선회 범위")
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
    /// 건물 높이 (m, AGL) — crane 은 판정에 쓰인 부위의 상단 AGL
    pub height_m: f64,
    /// 지붕 해발고 (m AMSL) = ground_elev_m + height_m
    pub total_height_m: f64,
    /// 판정 지점의 원추면 해발고 (m AMSL)
    pub cone_msl_m: f64,
    /// 초과량 (m) = total_height_m − cone_msl_m (> 0 이면 침범)
    pub exceed_m: f64,
    /// 폴리곤 꼭짓점 [[lat, lon], ...] — 내부 판정 전용(경계 최근접 judge·중복 접기 키).
    /// 프리즘 오버레이 제거(2026-08-12)로 프론트 소비처가 사라져 응답에서 제외한다
    /// (침범 건물 수천~수만 동 × 폴리곤 정점 = 응답 대부분을 차지하던 페이로드).
    #[serde(skip_serializing)]
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
pub(crate) fn analytic_range_limit_m(radar_height_m: f64, tan_theta: f64) -> f64 {
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
    let mut crane_sweeps: Vec<BraCraneSweep> = Vec::new();

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
            folded_duplicates: 0,
            buildings: Vec::new(),
            cranes: Vec::new(),
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

    // ── 실측3D 무명 블롭 속성 역참조 보강 ──
    // region='실측3D' 임포트 행은 1m DSM 블롭이라 이름/동명/용도가 없어 결과에 무명으로 오른다.
    // 그런데 이 블롭이 억제한 대장 행('measured:{블롭id}')에는 이름이 그대로 남아 있으므로
    // 역참조해 **비어 있는 필드만** 채운다(기존 값 덮어쓰기 금지).
    // 판정 결과 자체와 무관한 표시용 보강이라 실패는 비치명 — 경고만 남기고 생략한다.
    {
        // 결과에 오른 무명 fac 행(= 실측3D 블롭 후보)이 있을 때만 전체 스캔 수행
        let wanted: HashSet<i64> = hits
            .iter()
            .filter(|b| b.source == "fac" && b.name.is_none())
            .map(|b| b.id)
            .collect();
        if !wanted.is_empty() {
            match load_measured_blob_attrs(conn, &wanted) {
                Ok(attrs) => {
                    let mut enriched: u64 = 0;
                    for b in hits.iter_mut() {
                        if b.source != "fac" || b.name.is_some() {
                            continue;
                        }
                        let Some(a) = attrs.get(&b.id) else { continue };
                        b.name = a.name.clone(); // 대상은 name.is_none() 인 행뿐
                        if b.address.is_none() {
                            b.address = a.dong.clone();
                        }
                        if b.usage.is_none() {
                            b.usage = a.usage.clone();
                        }
                        enriched += 1;
                    }
                    if enriched > 0 {
                        log::info!(
                            "[BRA] 실측3D 무명 블롭 속성 역참조 보강 {}/{}동",
                            enriched,
                            wanted.len()
                        );
                    }
                }
                Err(e) => log::warn!("[BRA] 실측3D 무명 블롭 속성 역참조 생략: {}", e),
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
            //   building.rs 의 binary 패킹 폴백(±0.000045° ≈ 5m)·suppression.rs FALLBACK_HALF_DEG 와 동일 규약.
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

    // ── 타워크레인 (tower_cranes) — 부위별 판정 후 초과량 최대 부위 1건만(크레인당 최대 1행).
    //    지반은 저장된 ground_elev(수동 건물과 동일 계약), 기하는 등록 제원으로 절차 생성한다. ──
    {
        let geo_buffer = 0.01; // ~1.1km — 지브 길이(수십~수백 m) 커버 (수동 건물 블록과 동일 관례)
        let cranes = crate::crane::list_in_bbox(
            conn,
            min_lat - geo_buffer,
            max_lat + geo_buffer,
            min_lon - geo_buffer,
            max_lon + geo_buffer,
        )?;
        for c in &cranes {
            scanned += 1;
            if let Some(b) = judge_crane(
                cos_lat, radar_lat, radar_lon, radar_height_m, tan_theta, d_max, c,
            ) {
                hits.push(b);
            }
            // 방위각 스윕은 침범 여부와 무관하게 반경 안이면 항상 낸다 — 드로어가 여유(음수)도 표시한다
            if let Some(sw) = sweep_crane(
                cos_lat, radar_lat, radar_lon, radar_height_m, tan_theta, d_max, c,
            ) {
                crane_sweeps.push(sw);
            }
        }
    }

    // 대장 이중 임포트(광역본↔세분본) 접기 — 정렬 전에 수행해야 total_penetrating 이 실체 수와 맞는다
    let folded_duplicates = fold_fac_duplicates(&mut hits);

    // 초과량 내림차순 — 상한 없이 전수 반환 (드로어 침범 리스트의 이름·주소 검색이 전수를 훑는다.
    // 표시 행 수만 프론트가 캡하므로 여기서 자르면 캡 밖 건물을 영영 못 찾는다 — 상한 도입 금지)
    hits.sort_by(|a, b| b.exceed_m.partial_cmp(&a.exceed_m).unwrap_or(std::cmp::Ordering::Equal));
    let total_penetrating = hits.len() as u64;

    log::info!(
        "[BRA] 기준각 {:.2}° · 안테나 {:.1}m AMSL · 반경 {:.1}km — 검사 {}동, 침범 {}동{}{}",
        angle_deg, radar_height_m, d_max / 1000.0, scanned, total_penetrating,
        if skipped_invalid_polygon > 0 {
            format!(" (폴리곤 불량 {}동 제외)", skipped_invalid_polygon)
        } else {
            String::new()
        },
        if folded_duplicates > 0 {
            format!(" (대장 중복 {}행 접음)", folded_duplicates)
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
        folded_duplicates,
        buildings: hits,
        cranes: crane_sweeps,
    })
}

/// 폴리곤 경계(변 위 최근접점 포함) 중 레이더 원점에 가장 가까운 지점까지 지표거리 (m).
///
/// 변(i, i+1) 마다 원점→선분 최근접점 거리를 구해 최소값을 취한다 — 정점 전용 최소는 긴 변의
/// 중간이 레이더 쪽으로 더 가까운 대형 풋프린트에서 거리를 과대평가(= 침범 누락)한다.
/// 정점이 없거나 좌표가 NaN 이면 None(판정 불가를 그대로 드러낸다).
fn nearest_boundary_dist_m(
    cos_lat: f64,
    radar_lat: f64,
    radar_lon: f64,
    polygon: &[[f64; 2]],
) -> Option<f64> {
    // 정점을 레이더 원점 ENU (east, north) 로 1회 변환 — enu_dist_m 과 동일 스케일
    let n = polygon.len();
    let mut pts: Vec<(f64, f64)> = Vec::with_capacity(n);
    for p in polygon {
        let east = (p[1] - radar_lon).to_radians() * EARTH_RADIUS_M * cos_lat;
        let north = (p[0] - radar_lat).to_radians() * EARTH_RADIUS_M;
        pts.push((east, north));
    }
    let mut d_min = f64::INFINITY;
    for i in 0..n {
        let (ax, ay) = pts[i];
        let (bx, by) = pts[(i + 1) % n];
        let (ex, ey) = (bx - ax, by - ay);
        let len2 = ex * ex + ey * ey;
        // 퇴화(선분 길이 0)면 t=0 → 그 정점까지의 거리
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
    if d_min.is_finite() {
        Some(d_min)
    } else {
        None
    }
}

/// 부위 1개의 원추면 여유/초과량 (m) = `ground + top_agl − cone(최근접 경계 거리)`.
///
/// `judge` 와 달리 **음수(여유)도 그대로 반환**한다 — 방위각 스윕은 침범하지 않는 방위의
/// 여유고까지 비교해야 최선각을 고를 수 있다. 최근접 경계점이 스캔 반경(d_max) 밖이면 None.
#[allow(clippy::too_many_arguments)]
fn part_margin_m(
    cos_lat: f64,
    radar_lat: f64,
    radar_lon: f64,
    radar_height_m: f64,
    tan_theta: f64,
    d_max: f64,
    ground_elev_m: f64,
    top_agl_m: f64,
    polygon: &[[f64; 2]],
) -> Option<f64> {
    let d_min = nearest_boundary_dist_m(cos_lat, radar_lat, radar_lon, polygon)?;
    if d_min > d_max {
        return None;
    }
    Some(ground_elev_m + top_agl_m - cone_msl(radar_height_m, tan_theta, d_min))
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
    let d_min = nearest_boundary_dist_m(cos_lat, radar_lat, radar_lon, &polygon)?;
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

/// 타워크레인 부위 1개 — BRA 판정 입력(수평 폴리곤 + 상단 높이).
/// BRA 원추면은 지표거리와 해발고만 보므로 부위별 수평 단면 + 상단 AGL 이면 충분하다.
struct CranePart {
    /// 부위명 (결과 usage 표기)
    usage: &'static str,
    /// 상단 높이 (m AGL)
    top_agl_m: f64,
    /// 폴리곤 [[lat, lon], ...]
    polygon: Vec<[f64; 2]>,
}

/// 크레인 중심 기준 ENU(m) → [lat, lon] — `enu_dist_m` 의 역변환(동일 평면 스케일, 실제지구 반경)
#[inline]
fn crane_enu_to_latlon(clat: f64, clon: f64, cos_clat: f64, east: f64, north: f64) -> [f64; 2] {
    [
        clat + (north / EARTH_RADIUS_M).to_degrees(),
        clon + (east / (EARTH_RADIUS_M * cos_clat)).to_degrees(),
    ]
}

/// 마스트 수평 단면 폴리곤 — 중심 정사각(변 mast_width). `crane_parts` 와 방위각 스윕 공용.
fn crane_mast_polygon(c: &crate::crane::TowerCrane) -> Vec<[f64; 2]> {
    let cos_clat = c.latitude.to_radians().cos().max(0.5);
    let h = c.mast_width / 2.0;
    let to_ll = |east: f64, north: f64| {
        crane_enu_to_latlon(c.latitude, c.longitude, cos_clat, east, north)
    };
    vec![to_ll(-h, -h), to_ll(h, -h), to_ll(h, h), to_ll(-h, h)]
}

/// 지브 계열 팔 1개의 수평 폴리곤 — 마스트 중심에서 방위 `theta_deg` 의 `sign` 방향(+1 지브 /
/// −1 카운터지브)으로 길이 `len`, 폭 JIB_WIDTH_M 인 직사각형.
/// 방위각은 정북 0·시계방향이므로 단위벡터는 (east, north) = (sin θ, cos θ).
/// `crane_parts`(고정 모드)와 `sweep_crane` 이 **같은 기하**를 쓰도록 자유 함수로 분리한다.
fn crane_arm_polygon(
    c: &crate::crane::TowerCrane,
    theta_deg: f64,
    len: f64,
    sign: f64,
) -> Vec<[f64; 2]> {
    let cos_clat = c.latitude.to_radians().cos().max(0.5);
    let to_ll = |east: f64, north: f64| {
        crane_enu_to_latlon(c.latitude, c.longitude, cos_clat, east, north)
    };
    let th = theta_deg.to_radians();
    let (ue, un) = (th.sin(), th.cos()); // 지브 방향 단위벡터
    let (pe, pn) = (un, -ue); // 폭 방향(지브에 수직)
    let w = JIB_WIDTH_M / 2.0;
    let (de, dn) = (ue * sign, un * sign);
    vec![
        to_ll(-pe * w, -pn * w),
        to_ll(pe * w, pn * w),
        to_ll(de * len + pe * w, dn * len + pn * w),
        to_ll(de * len - pe * w, dn * len - pn * w),
    ]
}

/// 전방위(full) 선회 범위 원판의 수평 폴리곤 — 마스트 중심, 반경 max(지브, 카운터지브)를
/// 정 SWEEP_SEGMENTS 각형으로 근사. `crane_parts`(full 모드)와 `sweep_crane` 의
/// 전방위 최악조건 산출이 **같은 기하**를 쓰도록 자유 함수로 분리한다.
fn crane_full_disk_polygon(c: &crate::crane::TowerCrane) -> Vec<[f64; 2]> {
    let cos_clat = c.latitude.to_radians().cos().max(0.5);
    let r = c.jib_length.max(c.counter_jib_length);
    let mut ring: Vec<[f64; 2]> = Vec::with_capacity(SWEEP_SEGMENTS);
    for i in 0..SWEEP_SEGMENTS {
        let a = std::f64::consts::TAU * (i as f64) / (SWEEP_SEGMENTS as f64);
        ring.push(crane_enu_to_latlon(
            c.latitude, c.longitude, cos_clat, r * a.sin(), r * a.cos(),
        ));
    }
    ring
}

/// 타워크레인 제원 → 판정 부위 목록 (마스트 + 지브/카운터지브 또는 선회 범위 원판).
fn crane_parts(c: &crate::crane::TowerCrane) -> Vec<CranePart> {
    let mut parts: Vec<CranePart> = Vec::new();

    // 마스트 — 중심 정사각(변 mast_width), 상단은 최상단(타워탑/캣헤드 정점)
    parts.push(CranePart {
        usage: "마스트",
        top_agl_m: c.top_height,
        polygon: crane_mast_polygon(c),
    });

    // 지브 계열 상단 = 지브 설치고(하현 밑면) + 트러스 높이
    let jib_top = c.jib_height + JIB_TRUSS_H;
    match c.rotation_mode.as_str() {
        "full" => {
            // 전방위 회전 최악조건 — 선회 반경 원판을 정다각형으로 근사
            parts.push(CranePart {
                usage: "선회 범위",
                top_agl_m: jib_top,
                polygon: crane_full_disk_polygon(c),
            });
        }
        "fixed" => {
            parts.push(CranePart {
                usage: "지브",
                top_agl_m: jib_top,
                polygon: crane_arm_polygon(c, c.jib_azimuth_deg, c.jib_length, 1.0),
            });
            if c.counter_jib_length > 0.0 {
                parts.push(CranePart {
                    usage: "카운터지브",
                    top_agl_m: jib_top,
                    polygon: crane_arm_polygon(c, c.jib_azimuth_deg, c.counter_jib_length, -1.0),
                });
            }
        }
        other => {
            // 저장 시 검증(crane.rs)을 통과한 값만 들어오므로 정상 경로에선 도달 불가.
            // DB 직접 수정 등 이상값은 조용히 어느 한쪽으로 가정하지 않고 지브 부위를 만들지 않는다.
            log::warn!(
                "[BRA] 타워크레인 id={} 선회 모드 이상값 '{}' — 지브 부위 판정 생략(마스트만)",
                c.id, other
            );
        }
    }
    parts
}

/// 타워크레인 1기 판정 — 부위별로 `judge` 를 돌려 **초과량 최대 부위 1건**만 반환.
/// 크레인당 최대 1행이 결과에 오르며, 그 부위명이 `usage` 로 표기된다.
#[allow(clippy::too_many_arguments)]
fn judge_crane(
    cos_lat: f64,
    radar_lat: f64,
    radar_lon: f64,
    radar_height_m: f64,
    tan_theta: f64,
    d_max: f64,
    c: &crate::crane::TowerCrane,
) -> Option<BraBuilding> {
    let address = if c.memo.trim().is_empty() { None } else { Some(c.memo.clone()) };
    let mut best: Option<BraBuilding> = None;
    for part in crane_parts(c) {
        let hit = judge(
            cos_lat, radar_lat, radar_lon, radar_height_m, tan_theta, d_max,
            c.id, "crane", false,
            Some(c.name.clone()), address.clone(), Some(part.usage.to_string()),
            c.latitude, c.longitude, c.ground_elev, part.top_agl_m, part.polygon,
        );
        let Some(h) = hit else { continue };
        if best.as_ref().map_or(true, |b| h.exceed_m > b.exceed_m) {
            best = Some(h);
        }
    }
    best
}

/// 타워크레인 1기 방위각 스윕 — 지브를 0..359° 로 1° 씩 돌려 각 방위의 초과량(음수 = 여유)을
/// 구하고 최악(최대)/최선(최소) 방위를 뽑는다.
///
/// 마스트 중심이 스캔 반경 밖이면 None — 결과 `cranes` 에 올리지 않는다.
/// 스윕 기하는 등록 선회 모드와 무관하게 **고정 지브**(`crane_arm_polygon`) 기준이다:
/// "그 방위로 고정했을 때" 어떻게 판정되는지가 최악/최선각의 정의이기 때문.
/// 부위 margin 이 None(반경 밖)이면 그 부위는 비교에서 제외한다.
#[allow(clippy::too_many_arguments)]
pub(crate) fn sweep_crane(
    cos_lat: f64,
    radar_lat: f64,
    radar_lon: f64,
    radar_height_m: f64,
    tan_theta: f64,
    d_max: f64,
    c: &crate::crane::TowerCrane,
) -> Option<BraCraneSweep> {
    let d_center = enu_dist_m(cos_lat, radar_lat, radar_lon, c.latitude, c.longitude);
    if d_center > d_max {
        return None;
    }
    let margin = |top_agl_m: f64, polygon: &[[f64; 2]]| {
        part_margin_m(
            cos_lat, radar_lat, radar_lon, radar_height_m, tan_theta, d_max,
            c.ground_elev, top_agl_m, polygon,
        )
    };

    // 마스트 단독(방위 무관) — 스윕 곡선의 하한선. 마스트 최근접 경계는 중심보다 가까우므로
    // 중심이 반경 안이면 항상 값이 나온다(None = 좌표 이상값 → 스윕 자체를 포기).
    let mast_exceed_m = margin(c.top_height, &crane_mast_polygon(c))?;

    // 등록 상태(선회 모드·방위각) 그대로의 초과량 — 침범 행 exceed_m 과 같은 정의(음수 유지)
    let mut current = f64::NEG_INFINITY;
    for part in crane_parts(c) {
        if let Some(m) = margin(part.top_agl_m, &part.polygon) {
            if m > current {
                current = m;
            }
        }
    }
    // 선회 반경이 커서 부위가 전부 반경 밖으로 밀린 경우 마스트 값이 현재 판정값
    let current_exceed_m = if current.is_finite() { current } else { mast_exceed_m };

    // 지브 계열 상단 = 지브 설치고(하현 밑면) + 트러스 높이 (crane_parts 와 동일)
    let jib_top = c.jib_height + JIB_TRUSS_H;

    // 전방위 최악조건 — 등록 선회 모드와 무관하게 선회 범위 원판으로 본 초과량.
    // 원판 최근접 경계(d_center − 반경)는 마스트 최근접 경계보다 항상 가까우므로 반경 밖으로
    // 밀릴 수 없다(= None 은 좌표 이상값뿐). 그 경우에만 마스트 값을 쓴다(current_exceed_m 과 동일 관례).
    let full_exceed_m = margin(jib_top, &crane_full_disk_polygon(c)).unwrap_or(mast_exceed_m);

    let mut exceed: Vec<f64> = Vec::with_capacity(360);
    for deg in 0..360u16 {
        let theta = deg as f64;
        let mut e = mast_exceed_m;
        if let Some(m) = margin(jib_top, &crane_arm_polygon(c, theta, c.jib_length, 1.0)) {
            if m > e {
                e = m;
            }
        }
        if c.counter_jib_length > 0.0 {
            if let Some(m) =
                margin(jib_top, &crane_arm_polygon(c, theta, c.counter_jib_length, -1.0))
            {
                if m > e {
                    e = m;
                }
            }
        }
        exceed.push(e);
    }

    // 첫 등장 argmax/argmin (동률이면 작은 방위각)
    let mut worst_deg = 0usize;
    let mut best_deg = 0usize;
    for (i, &v) in exceed.iter().enumerate() {
        if v > exceed[worst_deg] {
            worst_deg = i;
        }
        if v < exceed[best_deg] {
            best_deg = i;
        }
    }

    Some(BraCraneSweep {
        id: c.id,
        name: c.name.clone(),
        lat: c.latitude,
        lon: c.longitude,
        distance_km: d_center / 1000.0,
        azimuth_deg: crate::geo::bearing_deg(radar_lat, radar_lon, c.latitude, c.longitude),
        rotation_mode: c.rotation_mode.clone(),
        jib_azimuth_deg: c.jib_azimuth_deg,
        mast_exceed_m,
        current_exceed_m,
        worst_deg: worst_deg as u16,
        worst_exceed_m: exceed[worst_deg],
        best_deg: best_deg as u16,
        best_exceed_m: exceed[best_deg],
        full_exceed_m,
        // 표시(폴라 링)용 곡선은 f32 로 충분 — 360 × 크레인 수 페이로드를 절반으로
        exceed_by_deg: exceed.iter().map(|&v| v as f32).collect(),
    })
}

/// 대장 중복 접기 키 — (centroid 위도, 경도, 높이) 비트 + 폴리곤 정점 수.
///
/// 허용오차 없는 **비트 정확 일치**만 접는다. 광역본/세분본 SHP 는 같은 원천에서 뽑혀
/// 동일 건물을 비트 동일 값으로 싣기 때문이고, 반대로 근사 키(수 m 허용)를 쓰면
/// 실제로 인접한 별개 동(연립·상가 등)을 오접합해 침범 건물을 누락시킨다.
type FoldKey = (u64, u64, u64, usize);

#[inline]
fn fold_key(b: &BraBuilding) -> FoldKey {
    (b.lat.to_bits(), b.lon.to_bits(), b.height_m.to_bits(), b.polygon.len())
}

/// 이름 보유 여부 — 공백뿐인 이름은 없는 것으로 본다 (접기 유지 1순위)
#[inline]
fn has_name(b: &BraBuilding) -> bool {
    b.name.as_deref().is_some_and(|s| !s.trim().is_empty())
}

/// 같은 실체 두 행 중 `cand` 를 남길지 — 이름 보유 우선, 동률이면 id 작은 쪽(결정론)
#[inline]
fn fold_prefers(cand: &BraBuilding, kept: &BraBuilding) -> bool {
    match (has_name(cand), has_name(kept)) {
        (true, false) => true,
        (false, true) => false,
        _ => cand.id < kept.id,
    }
}

/// 결과 수준 대장 중복 접기 — fac 소스끼리 완전 동일 실체를 1행으로 접는다. 반환: 접어낸 행 수.
///
/// 저장 시점 `suppressed_by` 억제는 수동/실측3D 우선순위 전용이라 대장↔대장 이중 임포트는
/// 통과한다(예: '소사 에스케이뷰' 14동 → 침범 28행). 목록 부풀림·침범 동수 이중 계상을 막는다.
/// 수동 등록(manual) 건물은 사용자가 같은 자리에 의도적으로 세울 수 있으므로 접지 않는다.
fn fold_fac_duplicates(hits: &mut Vec<BraBuilding>) -> u64 {
    let mut kept: HashMap<FoldKey, usize> = HashMap::new();
    let mut dropped = vec![false; hits.len()];
    let mut folded: u64 = 0;

    for i in 0..hits.len() {
        if hits[i].source != "fac" {
            continue; // 수동 등록 제외
        }
        let key = fold_key(&hits[i]);
        match kept.get(&key).copied() {
            None => {
                kept.insert(key, i);
            }
            Some(j) => {
                if fold_prefers(&hits[i], &hits[j]) {
                    dropped[j] = true;
                    kept.insert(key, i);
                } else {
                    dropped[i] = true;
                }
                folded += 1;
            }
        }
    }

    if folded > 0 {
        // retain 은 원래 순서대로 1회씩 방문 — dropped 인덱스와 보조를 맞출 수 있다
        let mut i = 0usize;
        hits.retain(|_| {
            let keep = !dropped[i];
            i += 1;
            keep
        });
    }
    folded
}

/// 실측3D 블롭이 억제한 대장 행에서 역참조한 속성 1건
struct SuppressedAttr {
    name: Option<String>,
    dong: Option<String>,
    usage: Option<String>,
    /// 대표성 판정용 높이 (m) — 한 블롭에 여러 대장 행이 걸리면 가장 높은 행을 채택
    height_m: f64,
}

/// 무명 실측3D 블롭 id → 그 블롭이 억제한 대장 행의 속성 표 (fac_buildings 1회 스캔).
///
/// 1m DSM 블롭은 이름/용도가 없지만, 자신이 덮어 억제한 대장 행('measured:{블롭id}')에는
/// 이름이 남아 있다. 한 블롭이 여러 대장 동을 덮은 경우 **가장 높은 행**을 블롭 대표로 본다.
/// `wanted` 로 결과에 실제로 오른 무명 블롭만 담아 표 크기를 묶는다.
fn load_measured_blob_attrs(
    conn: &Connection,
    wanted: &HashSet<i64>,
) -> Result<HashMap<i64, SuppressedAttr>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT suppressed_by, building_name, dong_name, usability,
                    COALESCE(height_measured, height)
             FROM fac_buildings
             WHERE suppressed_by LIKE 'measured:%' AND building_name IS NOT NULL",
        )
        .map_err(|e| format!("BRA 블롭 속성 쿼리 준비 실패: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, f64>(4)?,
            ))
        })
        .map_err(|e| format!("BRA 블롭 속성 쿼리 실행 실패: {}", e))?;

    let mut map: HashMap<i64, SuppressedAttr> = HashMap::new();
    for row in rows {
        let (tag, name, dong, usage, height_m) =
            row.map_err(|e| format!("BRA 블롭 속성 행 읽기 실패: {}", e))?;
        let Some(blob_id) = tag.strip_prefix("measured:").and_then(|s| s.parse::<i64>().ok())
        else {
            continue; // 태그 형식 이상 — 무시
        };
        if !wanted.contains(&blob_id) {
            continue;
        }
        match map.get(&blob_id) {
            Some(prev) if prev.height_m >= height_m => {}
            _ => {
                map.insert(blob_id, SuppressedAttr { name, dong, usage, height_m });
            }
        }
    }
    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 접기 규칙 검증용 최소 hit — 판정값(거리/초과량)은 접기와 무관해 상수로 채운다
    fn hit(
        id: i64,
        source: &str,
        name: Option<&str>,
        lat: f64,
        lon: f64,
        height_m: f64,
        verts: usize,
    ) -> BraBuilding {
        BraBuilding {
            id,
            source: source.to_string(),
            measured: false,
            name: name.map(|s| s.to_string()),
            address: None,
            usage: None,
            lat,
            lon,
            distance_km: 1.0,
            azimuth_deg: 0.0,
            ground_elev_m: 0.0,
            height_m,
            total_height_m: height_m,
            cone_msl_m: 0.0,
            exceed_m: 1.0,
            polygon: vec![[lat, lon]; verts],
        }
    }

    /// 광역본/세분본 이중 임포트(비트 동일)는 1행으로 접히고, 이름 보유 행이 남는다
    #[test]
    fn test_fold_identical_bits_keeps_named() {
        let mut hits = vec![
            hit(10, "fac", None, 37.4842, 126.7935, 66.0, 5),
            hit(20, "fac", Some("소사 에스케이뷰"), 37.4842, 126.7935, 66.0, 5),
        ];
        assert_eq!(fold_fac_duplicates(&mut hits), 1);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, 20);
        assert_eq!(hits[0].name.as_deref(), Some("소사 에스케이뷰"));
    }

    /// 근소 차이(1 ULP 수준)는 별개 동 — 접지 않는다 (근사 키 오접합 방지)
    #[test]
    fn test_fold_skips_near_but_unequal() {
        let lat = 37.4842_f64;
        let mut hits = vec![
            hit(10, "fac", None, lat, 126.7935, 66.0, 5),
            hit(20, "fac", None, f64::from_bits(lat.to_bits() + 1), 126.7935, 66.0, 5),
            // 높이만 0.01m 다른 행도 별개
            hit(30, "fac", None, lat, 126.7935, 66.01, 5),
            // 정점 수가 다르면 다른 형상
            hit(40, "fac", None, lat, 126.7935, 66.0, 6),
        ];
        assert_eq!(fold_fac_duplicates(&mut hits), 0);
        assert_eq!(hits.len(), 4);
    }

    /// 이름 동률이면 id 작은 쪽이 남는다 (결정론)
    #[test]
    fn test_fold_ties_keep_lower_id() {
        let mut hits = vec![
            hit(70, "fac", None, 37.5, 127.0, 30.0, 4),
            hit(30, "fac", None, 37.5, 127.0, 30.0, 4),
            hit(50, "fac", None, 37.5, 127.0, 30.0, 4),
        ];
        assert_eq!(fold_fac_duplicates(&mut hits), 2);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, 30);
    }

    /// 수동 등록은 같은 자리에 겹쳐도 접지 않는다 (사용자 의도)
    #[test]
    fn test_fold_never_folds_manual() {
        let mut hits = vec![
            hit(1, "manual", Some("가설 크레인"), 37.5, 127.0, 40.0, 4),
            hit(2, "manual", None, 37.5, 127.0, 40.0, 4),
        ];
        assert_eq!(fold_fac_duplicates(&mut hits), 0);
        assert_eq!(hits.len(), 2);
    }

    /// 테스트용 타워크레인 — 플랫탑(캣헤드 없음) 구성이라 최상단 = 지브 설치고
    fn crane(rotation_mode: &str, az: f64) -> crate::crane::TowerCrane {
        crate::crane::TowerCrane {
            id: 1,
            name: "시험 크레인".to_string(),
            // 레이더(37.5, 127.0) 정북 3km — enu_dist_m 과 같은 스케일로 환산
            latitude: 37.5 + (3000.0_f64 / EARTH_RADIUS_M).to_degrees(),
            longitude: 127.0,
            ground_elev: 0.0,
            elev_mode: "manual".to_string(),
            jib_height: 60.0,
            top_height: 60.0,
            jib_length: 50.0,
            counter_jib_length: 15.0,
            jib_azimuth_deg: az,
            rotation_mode: rotation_mode.to_string(),
            mast_width: 2.0,
            memo: String::new(),
        }
    }

    /// 크레인 부위 판정 — 지브가 레이더 쪽을 향하면 판정 지점이 마스트보다 가까워지고,
    /// 전방위 모드는 선회 범위 원판으로 판정된다.
    #[test]
    fn test_crane_jib_direction_and_full_sweep() {
        let (rlat, rlon, rh) = (37.5_f64, 127.0_f64, 30.0_f64);
        let cos_lat = rlat.to_radians().cos().max(0.5);
        let tan_theta = 0.25_f64.to_radians().tan();
        let d_max = 60_000.0;
        // 마스트(변 2m 정사각) 최근접 경계 = 3.000 − 0.001 km
        let mast_km = 2.999;

        // 고정 · 지브가 레이더 쪽(방위 180°) — 지브 끝(3000−50m)에서 판정
        let toward = judge_crane(cos_lat, rlat, rlon, rh, tan_theta, d_max, &crane("fixed", 180.0))
            .expect("지브가 원추면을 침범해야 한다");
        assert_eq!(toward.source, "crane");
        assert_eq!(toward.usage.as_deref(), Some("지브"));
        assert!(toward.distance_km < mast_km, "지브 판정 거리 {} 는 마스트보다 가까워야 한다", toward.distance_km);
        assert!((toward.distance_km - 2.950).abs() < 0.01, "distance_km = {}", toward.distance_km);
        assert!((toward.height_m - (60.0 + JIB_TRUSS_H)).abs() < 1e-9);
        assert!(toward.exceed_m > 0.0);

        // 고정 · 지브가 반대쪽(방위 0°) — 이때는 카운터지브(3000−15m)가 최근접
        let away = judge_crane(cos_lat, rlat, rlon, rh, tan_theta, d_max, &crane("fixed", 0.0))
            .expect("카운터지브가 원추면을 침범해야 한다");
        assert_eq!(away.usage.as_deref(), Some("카운터지브"));
        assert!(toward.distance_km < away.distance_km);
        assert!(away.distance_km < mast_km);

        // 전방위 — 방위각과 무관하게 선회 범위 원판(반경 max(L, Lc) = 50m)으로 판정
        let full = judge_crane(cos_lat, rlat, rlon, rh, tan_theta, d_max, &crane("full", 0.0))
            .expect("선회 범위가 원추면을 침범해야 한다");
        assert_eq!(full.usage.as_deref(), Some("선회 범위"));
        assert!((full.distance_km - 2.950).abs() < 0.01, "distance_km = {}", full.distance_km);
    }

    /// 방위각 스윕 — 최악각은 지브가 레이더를 향할 때(180° 부근), 최선각은 지브·카운터지브가
    /// 시선에 수직일 때(90°/270°)로 나온다.
    #[test]
    fn test_crane_sweep_worst_best() {
        let (rlat, rlon, rh) = (37.5_f64, 127.0_f64, 30.0_f64);
        let cos_lat = rlat.to_radians().cos().max(0.5);
        let tan_theta = 0.25_f64.to_radians().tan();
        let d_max = 60_000.0;
        let c = crane("fixed", 0.0);
        let sw = sweep_crane(cos_lat, rlat, rlon, rh, tan_theta, d_max, &c)
            .expect("반경 안 크레인은 스윕이 나와야 한다");

        assert_eq!(sw.exceed_by_deg.len(), 360);
        // 최악각 — 지브가 레이더 쪽. 정확히 180° 가 아니라 179°/181° 가 될 수 있다:
        // 폭 2m 직사각형이라 지브 끝단 **모서리**가 정면(180°)의 끝단 변보다 ~1cm 더 가깝다.
        assert!(
            (179..=181).contains(&sw.worst_deg),
            "worst_deg = {} (지브가 레이더를 향하는 방위여야 한다)",
            sw.worst_deg
        );
        assert!(
            sw.worst_exceed_m > sw.mast_exceed_m,
            "worst {} 는 마스트 단독 {} 보다 커야 한다",
            sw.worst_exceed_m, sw.mast_exceed_m
        );
        // 최선각 — 지브·카운터지브가 시선에 수직이라 최근접 경계가 마스트 수준까지 물러난다
        assert!(sw.best_exceed_m < sw.worst_exceed_m);
        assert!(
            (80..=100).contains(&sw.best_deg) || (260..=280).contains(&sw.best_deg),
            "best_deg = {}",
            sw.best_deg
        );
        // 전방위 최악조건 — 선회 범위 원판(반경 50m)의 최근접 경계가 지브 정면과 사실상 같은
        // 지점이라 최악각 값과 일치한다(원판 정64각형 근사 오차 ~0.06m → 원추고 차 ~3e-4m)
        assert!(
            (sw.full_exceed_m - sw.worst_exceed_m).abs() < 0.01,
            "full {} vs worst {}",
            sw.full_exceed_m, sw.worst_exceed_m
        );
        // 곡선과 대표값 정합 — 180° 값은 최악값과 사실상 같다(위 모서리 차이 ~1e-4m)
        assert!(
            (sw.exceed_by_deg[180] as f64 - sw.worst_exceed_m).abs() < 1e-3,
            "exceed_by_deg[180] = {} vs worst = {}",
            sw.exceed_by_deg[180], sw.worst_exceed_m
        );
    }

    /// 공백뿐인 이름은 없는 것으로 보고 실명 행을 남긴다
    #[test]
    fn test_fold_blank_name_loses_to_real_name() {
        let mut hits = vec![
            hit(5, "fac", Some("   "), 37.5, 127.0, 30.0, 4),
            hit(9, "fac", Some("행복아파트"), 37.5, 127.0, 30.0, 4),
        ];
        assert_eq!(fold_fac_duplicates(&mut hits), 1);
        assert_eq!(hits[0].id, 9);
    }
}
