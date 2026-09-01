//! 타워크레인 등록 (`tower_cranes` 테이블) — 데이터 모델 + CRUD + 자동 지반고 재동기화
//!
//! 건물(`manual_buildings`)과 **별도 자료**다. 크레인은 대장 건물을 억제하지 않으므로
//! `suppression` 체계와 무관하고, 지반고 계약만 수동 건물과 동일하다(저장값이 곧 판정 지반).
//!
//! **1단계 분석 반영 범위 = BRA 침범 검사뿐**(`analysis/bra.rs`).
//! LoS 단면도·파노라마·커버리지·OM 보고서·bra-review 의견서는 지상 기립 프리즘
//! (밑면 z = 지반)을 전제로 하는데, 지브는 밑면이 공중에 떠 있어 그대로 넣으면
//! 지상까지 가로막는 벽으로 오판된다 — 2단계 `base_m`(밑면 고도) 지원 후 반영한다.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// 타워크레인 1기 (DB 저장값 그대로)
#[derive(Serialize, Clone, Debug)]
pub struct TowerCrane {
    pub id: i64,
    pub name: String,
    pub latitude: f64,
    pub longitude: f64,
    /// 지반 표고 (m AMSL) — 저장값이 곧 판정 지반
    pub ground_elev: f64,
    /// 지면 표고 입력 모드 'auto'(SRTM 스냅샷) | 'manual'
    pub elev_mode: String,
    /// 지브 설치고 (지브 하단, m AGL)
    pub jib_height: f64,
    /// 최상단(타워탑/캣헤드 정점, m AGL) — jib_height 이상
    pub top_height: f64,
    /// 지브 길이 (m, 마스트 중심 기준)
    pub jib_length: f64,
    /// 카운터지브 길이 (m)
    pub counter_jib_length: f64,
    /// 지브 방위각 (°, 정북 0, 시계방향)
    pub jib_azimuth_deg: f64,
    /// 선회 모드 'fixed'(고정 방위각) | 'full'(전방위 회전 최악조건)
    pub rotation_mode: String,
    /// 마스트 단면 폭 (m, 정사각)
    pub mast_width: f64,
    pub memo: String,
}

/// 등록/수정 입력 — 프론트는 camelCase 키로 보낸다(`{ input: {...} }`)
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TowerCraneInput {
    pub name: String,
    pub latitude: f64,
    pub longitude: f64,
    pub ground_elev: f64,
    pub elev_mode: String,
    pub jib_height: f64,
    pub top_height: f64,
    pub jib_length: f64,
    pub counter_jib_length: f64,
    pub jib_azimuth_deg: f64,
    pub rotation_mode: String,
    pub mast_width: f64,
    pub memo: String,
}

/// SELECT 컬럼 순서 (list / bbox 조회 공용)
const SELECT_COLS: &str = "id, name, latitude, longitude, ground_elev, elev_mode, jib_height, \
     top_height, jib_length, counter_jib_length, jib_azimuth_deg, rotation_mode, mast_width, memo";

/// 한 행 → TowerCrane (SELECT_COLS 순서 고정)
fn row_to_crane(row: &rusqlite::Row) -> rusqlite::Result<TowerCrane> {
    Ok(TowerCrane {
        id: row.get(0)?,
        name: row.get(1)?,
        latitude: row.get(2)?,
        longitude: row.get(3)?,
        ground_elev: row.get(4)?,
        elev_mode: row.get(5)?,
        jib_height: row.get(6)?,
        top_height: row.get(7)?,
        jib_length: row.get(8)?,
        counter_jib_length: row.get(9)?,
        jib_azimuth_deg: row.get(10)?,
        rotation_mode: row.get(11)?,
        mast_width: row.get(12)?,
        memo: row.get(13)?,
    })
}

/// 선회 모드 문자열 검증 — 허용값 외에는 에러(조용한 보정 금지)
fn validate_rotation_mode(mode: &str) -> Result<(), String> {
    match mode {
        "fixed" | "full" => Ok(()),
        other => Err(format!("선회 모드가 잘못되었습니다: '{}' (fixed|full)", other)),
    }
}

/// 입력 검증 — 실패는 전부 에러 반환(조용한 보정·폴백 없음).
/// 방위각만 `rem_euclid(360)` 로 정규화해 돌려준다(정규화는 값 해석이지 보정이 아니다).
fn validate_input(input: &TowerCraneInput) -> Result<f64, String> {
    if input.name.trim().is_empty() {
        return Err("크레인 이름이 비어 있습니다".to_string());
    }
    // 유효 범위: 동아시아 (CLAUDE.md 파서 규약과 동일)
    if !(25.0..=50.0).contains(&input.latitude) || !(115.0..=145.0).contains(&input.longitude) {
        return Err(format!(
            "위경도가 유효 범위를 벗어났습니다: ({:.5}, {:.5})",
            input.latitude, input.longitude
        ));
    }
    // NaN 은 is_finite 로 먼저 걸러진다 (비교 연산만으로는 통과해 버린다)
    if !input.jib_height.is_finite() || input.jib_height <= 0.0 {
        return Err("지브 설치고는 0보다 커야 합니다".to_string());
    }
    if !input.top_height.is_finite() || input.top_height < input.jib_height {
        return Err("최상단 높이는 지브 설치고 이상이어야 합니다".to_string());
    }
    if !input.jib_length.is_finite() || input.jib_length <= 0.0 {
        return Err("지브 길이는 0보다 커야 합니다".to_string());
    }
    if !input.counter_jib_length.is_finite() || input.counter_jib_length < 0.0 {
        return Err("카운터지브 길이는 0 이상이어야 합니다".to_string());
    }
    if !input.mast_width.is_finite() || input.mast_width <= 0.0 {
        return Err("마스트 폭은 0보다 커야 합니다".to_string());
    }
    if !input.ground_elev.is_finite() {
        return Err("지반 표고가 유효하지 않습니다".to_string());
    }
    if !input.jib_azimuth_deg.is_finite() {
        return Err("지브 방위각이 유효하지 않습니다".to_string());
    }
    // 지반고 재동기화(`resync_auto_crane_ground`)가 'auto' 행만 갱신하므로 모드 오타는 조용한 오작동이 된다
    if input.elev_mode != "auto" && input.elev_mode != "manual" {
        return Err(format!(
            "지반고 모드가 잘못되었습니다: '{}' (auto|manual)",
            input.elev_mode
        ));
    }
    validate_rotation_mode(&input.rotation_mode)?;
    Ok(input.jib_azimuth_deg.rem_euclid(360.0))
}

/// 타워크레인 전체 조회 (id 순)
pub fn list_tower_cranes(conn: &Connection) -> Result<Vec<TowerCrane>, String> {
    let sql = format!("SELECT {} FROM tower_cranes ORDER BY id", SELECT_COLS);
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("타워크레인 쿼리 준비 실패: {}", e))?;
    let rows = stmt
        .query_map([], row_to_crane)
        .map_err(|e| format!("타워크레인 쿼리 실행 실패: {}", e))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("타워크레인 결과 수집 실패: {}", e))
}

/// 타워크레인 1기 조회 (id) — 없으면 에러(조용한 빈 값 금지).
/// 보고서용 단일 크레인 BRA 방위각 스윕(`analyze_crane_sweep`)이 쓴다.
pub fn get_tower_crane(conn: &Connection, id: i64) -> Result<TowerCrane, String> {
    let sql = format!("SELECT {} FROM tower_cranes WHERE id = ?1", SELECT_COLS);
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("타워크레인 단건 쿼리 준비 실패: {}", e))?;
    stmt.query_row(params![id], row_to_crane).map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => format!("타워크레인 id={} 을(를) 찾을 수 없습니다", id),
        other => format!("타워크레인 단건 쿼리 실행 실패: {}", other),
    })
}

/// bbox 안의 타워크레인 조회 — BRA 침범 검사(analysis/bra.rs)용.
/// 등록 규모가 수십 기 수준이라 전량 반환해도 무해하지만 컬럼 매핑은 단일 원천으로 둔다.
pub fn list_in_bbox(
    conn: &Connection,
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
) -> Result<Vec<TowerCrane>, String> {
    let sql = format!(
        "SELECT {} FROM tower_cranes
         WHERE latitude BETWEEN ?1 AND ?2 AND longitude BETWEEN ?3 AND ?4
         ORDER BY id",
        SELECT_COLS
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("타워크레인 bbox 쿼리 준비 실패: {}", e))?;
    let rows = stmt
        .query_map(params![min_lat, max_lat, min_lon, max_lon], row_to_crane)
        .map_err(|e| format!("타워크레인 bbox 쿼리 실행 실패: {}", e))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("타워크레인 bbox 결과 수집 실패: {}", e))
}

/// 타워크레인 추가 (생성된 id 반환)
pub fn add_tower_crane(conn: &Connection, input: &TowerCraneInput) -> Result<i64, String> {
    let az = validate_input(input)?;
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("시각 조회 실패: {}", e))?
        .as_secs() as i64;
    conn.execute(
        "INSERT INTO tower_cranes (name, latitude, longitude, ground_elev, elev_mode, jib_height, top_height,
             jib_length, counter_jib_length, jib_azimuth_deg, rotation_mode, mast_width, memo, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            input.name, input.latitude, input.longitude, input.ground_elev, input.elev_mode,
            input.jib_height, input.top_height, input.jib_length, input.counter_jib_length,
            az, input.rotation_mode, input.mast_width, input.memo, created_at
        ],
    )
    .map_err(|e| format!("타워크레인 INSERT 실패: {}", e))?;
    Ok(conn.last_insert_rowid())
}

/// 타워크레인 수정 — 대상 행이 없으면 에러(조용한 무시 금지)
pub fn update_tower_crane(
    conn: &Connection,
    id: i64,
    input: &TowerCraneInput,
) -> Result<(), String> {
    let az = validate_input(input)?;
    let n = conn
        .execute(
            "UPDATE tower_cranes SET name=?1, latitude=?2, longitude=?3, ground_elev=?4, elev_mode=?5,
                 jib_height=?6, top_height=?7, jib_length=?8, counter_jib_length=?9, jib_azimuth_deg=?10,
                 rotation_mode=?11, mast_width=?12, memo=?13 WHERE id=?14",
            params![
                input.name, input.latitude, input.longitude, input.ground_elev, input.elev_mode,
                input.jib_height, input.top_height, input.jib_length, input.counter_jib_length,
                az, input.rotation_mode, input.mast_width, input.memo, id
            ],
        )
        .map_err(|e| format!("타워크레인 UPDATE 실패: {}", e))?;
    if n == 0 {
        return Err(format!("타워크레인 id={} 을(를) 찾을 수 없습니다", id));
    }
    Ok(())
}

/// 지브 방위각·선회 모드만 갱신 (지도에서 그때그때 조정하는 경량 경로).
/// 대상 행이 없으면 에러 — 낙관 갱신이 DB 에 안 남는 상태를 숨기지 않는다.
pub fn update_tower_crane_jib(
    conn: &Connection,
    id: i64,
    jib_azimuth_deg: f64,
    rotation_mode: &str,
) -> Result<(), String> {
    if !jib_azimuth_deg.is_finite() {
        return Err("지브 방위각이 유효하지 않습니다".to_string());
    }
    validate_rotation_mode(rotation_mode)?;
    let az = jib_azimuth_deg.rem_euclid(360.0);
    let n = conn
        .execute(
            "UPDATE tower_cranes SET jib_azimuth_deg=?1, rotation_mode=?2 WHERE id=?3",
            params![az, rotation_mode, id],
        )
        .map_err(|e| format!("타워크레인 지브 UPDATE 실패: {}", e))?;
    if n == 0 {
        return Err(format!("타워크레인 id={} 을(를) 찾을 수 없습니다", id));
    }
    Ok(())
}

/// 타워크레인 삭제 — 대상 행이 없으면 에러
pub fn delete_tower_crane(conn: &Connection, id: i64) -> Result<(), String> {
    let n = conn
        .execute("DELETE FROM tower_cranes WHERE id = ?1", params![id])
        .map_err(|e| format!("타워크레인 DELETE 실패: {}", e))?;
    if n == 0 {
        return Err(format!("타워크레인 id={} 을(를) 찾을 수 없습니다", id));
    }
    Ok(())
}

/// 자동(SRTM) 모드 타워크레인의 지반고 재동기화 — 갱신 행 수 반환.
///
/// 규약은 `building::resync_auto_manual_ground` 와 동일:
/// - `elev_mode='auto'` 행만 갱신, `'manual'` 은 사용자 확정값이라 손대지 않는다.
/// - 반올림 정수 저장(프론트 등록 규약 `Math.round` 와 정합).
/// - 호출자는 융합 세대 확정 후(보정 저장/삭제 + `srtm.clear_cache()` 이후)에 호출해야 한다.
pub fn resync_auto_crane_ground(
    conn: &Connection,
    srtm: &mut crate::srtm::SrtmReader,
) -> Result<usize, String> {
    let rows: Vec<(i64, f64, f64)> = {
        let mut stmt = conn
            .prepare("SELECT id, latitude, longitude FROM tower_cranes WHERE elev_mode = 'auto'")
            .map_err(|e| format!("타워크레인 지반고 재동기화 SELECT 준비 실패: {}", e))?;
        let mapped = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|e| format!("타워크레인 지반고 재동기화 쿼리 실패: {}", e))?;
        mapped.filter_map(|r| r.ok()).collect()
    };
    if rows.is_empty() {
        return Ok(0);
    }

    let mut upd = conn
        .prepare("UPDATE tower_cranes SET ground_elev = ?1 WHERE id = ?2")
        .map_err(|e| format!("타워크레인 지반고 재동기화 UPDATE 준비 실패: {}", e))?;
    let mut updated = 0usize;
    for (id, lat, lon) in &rows {
        let g = srtm.get_elevation(*lat, *lon).unwrap_or(0.0).round();
        if upd.execute(params![g, id]).is_ok() {
            updated += 1;
        }
    }
    log::info!("[타워크레인] 자동(SRTM) 지반고 재동기화 {}행", updated);
    Ok(updated)
}
