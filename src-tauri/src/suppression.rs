//! 건물 중복 억제 — **저장 시점 우선순위 확정**
//!
//! 같은 실체를 가리키는 건물 행이 원천별로 중복 존재한다:
//!   ① 수동등록(`manual_buildings`) — 사용자가 실측/현장조사로 직접 넣은 최우선 자료
//!   ② 실측3D(`fac_buildings` 중 `height_measured IS NOT NULL OR region='실측3D'`) — 1m DSM 임포트
//!   ③ 건물통합정보 대장(그 외 `fac_buildings` 행) — 후순위
//!
//! 중복을 그대로 두면 3D fill-extrusion 박스가 이중 렌더되고(불투명 입체끼리 서로 가림)
//! BRA 침범 목록·동수도 같은 건물을 여러 번 세게 된다.
//!
//! 예전에는 조회 시점(BRA·뷰포트 쿼리)에 겹침을 계산해 제외했으나, 적용 쿼리에만 효과가 있고
//! 수동등록 겹침은 아예 처리되지 않았다. 지금은 **자료 등록/임포트 시점에 겹침을 비교해
//! `fac_buildings.suppressed_by` 로 저장 상태를 확정**한다. 물리 삭제가 아닌 가역 플래그라
//! 상위 원인(수동 건물·실측 자료)이 사라지면 재계산으로 그대로 복원된다.

use std::collections::HashMap;

use rusqlite::{params, Connection};

/// 하위 풋프린트가 상위 풋프린트에 덮이는 면적비 임계 — 이 비율 이상이면 같은 건물의 중복으로 본다.
/// 3% = 매우 공격적(사용자 지시 "무조건 실측/수동 우선") — 상위 풋프린트와 가장자리만 겹치는 인접
/// 건물도 억제될 수 있음을 감수하고, 상위 자료가 덮은 구역의 후순위 중복을 사실상 전부 걷어낸다.
/// (구 `building::MEASURED_COVER_RATIO` 를 이관한 값 — 판정 기준 동일)
pub const COVER_RATIO: f64 = 0.03;

/// 보조 판정 임계 — 상위 풋프린트의 이 비율 이상이 하위 풋프린트 안에 들어 있으면 중복으로 본다.
/// 작은 수동 마커/블롭 조각이 큰 건물 안에 통째로 들어있는 경우(면적비로는 COVER_RATIO 미달)를 잡는다.
const CONTAIN_RATIO: f64 = 0.5;

/// 억제 높이 슬랙 (m) — 상위(실측)가 하위(대장)보다 이만큼까지 낮아도 동일 건물로 인정
/// (db.rs 기동 마이그레이션 `run_suppress_tag_sanity` 가 동일 식을 SQL 로 재사용 — 값 이중정의 금지)
pub(crate) const SUPPRESS_HEIGHT_SLACK_M: f64 = 10.0;

/// 면적비(주 판정) 격자 샘플 축당 점 수 (24×24 = 576점)
const SAMPLE_N: i32 = 24;

/// 포함비(보조 판정) 격자 샘플 축당 점 수 (12×12 = 144점)
const CONTAIN_SAMPLE_N: i32 = 12;

/// 겹침 인덱스 셀 크기 (deg) — measured_building.rs 의 후보 버킷(CELL_DEG)과 동일 규약. 약 111m × 88m
const CELL_DEG: f64 = 0.001;

/// bbox 가 걸치는 셀 축당 최대 개수 (비정상 bbox 방어) — measured_building.rs MAX_CELL_SPAN 과 동일
const MAX_CELL_SPAN: i32 = 256;

/// 수동 건물 조회/재계산 영역 여유 (deg) — 약 1.2km. 대형 도형(폴리곤이 중심점에서 크게 벗어남) 대비.
/// building.rs/panorama.rs 의 geo_buffer(0.01) 보다 한 단계 넉넉하게 잡는다.
pub const AREA_MARGIN_DEG: f64 = 0.011;

/// 폴리곤 미형성(3점 미만) 수동 건물의 폴백 사각 반변 (deg ≈ 5m)
/// — bra.rs / building.rs 의 폴리곤 폴백(±0.000045°)과 동일 규약
const FALLBACK_HALF_DEG: f64 = 0.000045;

/// 진행 로그 간격 (스캔 행 수)
const LOG_EVERY: u64 = 50_000;

/// 백필 완료 표식 settings 키
/// v2 = 높이 조건 억제(height_allows_suppress) 도입 — 구 규칙으로 확정된 억제 태그를 전 영역
/// 재계산해 바로잡기 위해 키를 올렸다. 구 키 'suppression_backfill_v1' 행은 조회되지 않으므로
/// settings 에 남아 있어도 무해하다(삭제 불필요).
const BACKFILL_KEY: &str = "suppression_backfill_v2";

/// 좌표 → 겹침 인덱스 셀 (measured_building.rs::cell_of 와 동일 식)
#[inline]
fn cell_of(lat: f64, lon: f64) -> (i32, i32) {
    ((lat / CELL_DEG).floor() as i32, (lon / CELL_DEG).floor() as i32)
}

/// 상위(우선) 건물 풋프린트 1건
struct Footprint {
    /// `suppressed_by` 에 기록할 태그 — "manual:<id>" 또는 "measured:<fac_id>"
    tag: String,
    /// 상위 자료의 높이 (m) — 수동은 `manual_buildings.height`,
    /// 실측은 `COALESCE(height_measured, height)`. 높이 조건 억제(height_allows_suppress) 기준.
    height_m: f64,
    /// 풋프린트 링 (lon, lat) — point_in_polygon_2d 의 (x, y) 규약
    ring: Vec<(f64, f64)>,
    /// [min_lat, max_lat, min_lon, max_lon]
    bbox: [f64; 4],
}

/// 상위 풋프린트가 하위 행을 **높이 기준으로** 억제할 자격이 있는가.
///
/// 피복(면적) 판정만으로는 5~16m 저층 실측 블롭이 66m 아파트 대장 행을 통째로 억제해
/// 건물이 BRA/LoS 에서 사라진다(은행마을 아주아파트 사례). 상위가 하위를 대체하려면
/// 최소한 비슷한 높이를 갖고 있어야 한다.
///
/// · 실측(measured:) — `상위고 + SUPPRESS_HEIGHT_SLACK_M ≥ 하위고` 여야 억제 가능.
/// · 수동(manual:) — 사용자가 직접 넣은 최우선 자료라 높이 비교 없이 우선한다. 단 h ≤ 0 마커는
///   자신이 BRA 렌더/판정에서 스킵되므로 억제까지 허용하면 건물이 통째로 사라지는 블랙홀이 된다.
fn height_allows_suppress(upper: &Footprint, lower_height_m: f64) -> bool {
    if upper.tag.starts_with("manual:") {
        return upper.height_m > 0.0;
    }
    upper.height_m + SUPPRESS_HEIGHT_SLACK_M >= lower_height_m
}

/// 상위 풋프린트들을 0.001° 셀 버킷에 적재한 겹침 프리필터 인덱스.
/// bbox 는 **1차 프리필터 전용**이고, 확정 판정은 실제 폴리곤 풋프린트로 한다.
struct FootprintIndex {
    items: Vec<Footprint>,
    /// 셀 → 그 셀을 걸치는 items 인덱스 목록
    buckets: HashMap<(i32, i32), Vec<usize>>,
}

impl FootprintIndex {
    fn new() -> Self {
        Self { items: Vec::new(), buckets: HashMap::new() }
    }

    fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// 링 + bbox 를 인덱스에 등록. 3점 미만/비정상 bbox 는 무시(등록 안 함).
    fn push(&mut self, tag: String, height_m: f64, ring: Vec<(f64, f64)>, bbox: [f64; 4]) {
        if ring.len() < 3 {
            return;
        }
        if !bbox.iter().all(|v| v.is_finite()) || bbox[1] < bbox[0] || bbox[3] < bbox[2] {
            return;
        }
        let (r0, c0) = cell_of(bbox[0], bbox[2]);
        let (r1, c1) = cell_of(bbox[1], bbox[3]);
        // 축당 셀 수가 과대한 비정상 bbox 는 스킵 (임포트 모듈과 동일 방어)
        if r1 - r0 > MAX_CELL_SPAN || c1 - c0 > MAX_CELL_SPAN {
            return;
        }
        let idx = self.items.len();
        // 높이 미상(NULL/비정상)은 0.0 으로 들어와 실측 상위는 낮은 하위만 억제하게 된다(보수적)
        let height_m = if height_m.is_finite() { height_m } else { 0.0 };
        self.items.push(Footprint { tag, height_m, ring, bbox });
        for r in r0..=r1 {
            for cc in c0..=c1 {
                self.buckets.entry((r, cc)).or_default().push(idx);
            }
        }
    }

    /// 하위 bbox 와 교차하는 상위 풋프린트 인덱스 목록 (id 중복 제거, 저비용 프리필터).
    /// 비정상 bbox 는 빈 목록(fail-open — 억제하지 않음).
    fn candidates(&self, bbox: &[f64; 4]) -> Vec<usize> {
        let mut out: Vec<usize> = Vec::new();
        if self.buckets.is_empty() {
            return out;
        }
        if !bbox.iter().all(|v| v.is_finite()) || bbox[1] < bbox[0] || bbox[3] < bbox[2] {
            return out;
        }
        let (r0, c0) = cell_of(bbox[0], bbox[2]);
        let (r1, c1) = cell_of(bbox[1], bbox[3]);
        if r1 - r0 > MAX_CELL_SPAN || c1 - c0 > MAX_CELL_SPAN {
            return out;
        }
        for r in r0..=r1 {
            for cc in c0..=c1 {
                let Some(list) = self.buckets.get(&(r, cc)) else { continue };
                for &i in list {
                    // 같은 풋프린트가 여러 셀에 등록돼 있으므로 중복 제거
                    if out.contains(&i) {
                        continue;
                    }
                    let b = &self.items[i].bbox;
                    // bbox 교차 여부 (경계 접촉 포함)
                    if bbox[1] < b[0] || bbox[0] > b[1] || bbox[3] < b[2] || bbox[2] > b[3] {
                        continue;
                    }
                    out.push(i);
                }
            }
        }
        out
    }
}

/// 링에서 bbox [min_lat, max_lat, min_lon, max_lon] 산출. 비정상 좌표가 섞이면 None.
fn ring_bbox(ring: &[(f64, f64)]) -> Option<[f64; 4]> {
    if ring.len() < 3 {
        return None;
    }
    let (mut min_lat, mut max_lat) = (f64::INFINITY, f64::NEG_INFINITY);
    let (mut min_lon, mut max_lon) = (f64::INFINITY, f64::NEG_INFINITY);
    for &(lon, lat) in ring {
        if !lon.is_finite() || !lat.is_finite() {
            return None;
        }
        min_lat = min_lat.min(lat);
        max_lat = max_lat.max(lat);
        min_lon = min_lon.min(lon);
        max_lon = max_lon.max(lon);
    }
    Some([min_lat, max_lat, min_lon, max_lon])
}

/// polygon_json([[lat, lon], ...] — DB 저장 관례) → (lon, lat) 링. 파싱 실패/3점 미만은 None.
fn parse_polygon_ring(poly_json: Option<&str>) -> Option<Vec<(f64, f64)>> {
    poly_json
        .and_then(|s| serde_json::from_str::<Vec<[f64; 2]>>(s).ok())
        .filter(|p| p.len() >= 3)
        .map(|p| p.iter().map(|v| (v[1], v[0])).collect())
}

/// 수동 건물 geometry → 풋프린트 링 (lon, lat).
/// 기하 해석은 파노라마/BRA 와 동일 규약(`analysis::panorama::expand_manual_geometry`)을 재사용하고,
/// 3점 미만(점/선 등 폴리곤 미형성)은 중심 주변 소형 정사각으로 폴백한다.
fn manual_ring(
    lat: f64,
    lon: f64,
    geo_type: Option<&str>,
    geo_json: Option<&str>,
) -> Vec<(f64, f64)> {
    let pts = crate::analysis::panorama::expand_manual_geometry(lat, lon, geo_type, geo_json);
    if pts.len() >= 3 {
        // expand_manual_geometry 는 (lat, lon) 을 돌려주므로 (lon, lat) 로 뒤집는다
        pts.iter().map(|&(la, lo)| (lo, la)).collect()
    } else {
        let d = FALLBACK_HALF_DEG;
        vec![
            (lon - d, lat - d),
            (lon + d, lat - d),
            (lon + d, lat + d),
            (lon - d, lat + d),
        ]
    }
}

/// 수동 건물 1동의 풋프린트 bbox [min_lat, max_lat, min_lon, max_lon] (폴백 사각 포함).
/// 재계산 영역 산출용 — 호출부는 여기에 AREA_MARGIN_DEG 여유를 더해 쓴다.
pub fn manual_bbox(
    lat: f64,
    lon: f64,
    geo_type: Option<&str>,
    geo_json: Option<&str>,
) -> [f64; 4] {
    let ring = manual_ring(lat, lon, geo_type, geo_json);
    ring_bbox(&ring).unwrap_or([
        lat - FALLBACK_HALF_DEG,
        lat + FALLBACK_HALF_DEG,
        lon - FALLBACK_HALF_DEG,
        lon + FALLBACK_HALF_DEG,
    ])
}

/// 하위 풋프린트가 상위 후보들에 '같은 건물'로 볼 만큼 덮이는지 판정 — 덮으면 기여 상위 1건의 태그.
///
/// ① 주 판정(면적비): 하위 풋프린트 내부 SAMPLE_N×SAMPLE_N 격자 샘플 중 상위 풋프린트(합집합)에
///    덮이는 비율 ≥ COVER_RATIO. 태그는 **피복 기여가 가장 큰 상위 1건**에 귀속한다.
/// ② 보조 판정(포함비): ①이 불충족일 때, 상위 풋프린트 내부 CONTAIN_SAMPLE_N×CONTAIN_SAMPLE_N
///    샘플 중 하위 풋프린트 안에 드는 비율 ≥ CONTAIN_RATIO 인 상위가 있으면 그 **최초 매치**.
///    (작은 수동 마커/블롭 조각이 큰 건물 안에 들어있는 경우)
///
/// 두 판정 모두 **높이 조건**(height_allows_suppress)을 통과한 상위만 대상으로 한다 — 자격 없는
/// 상위는 후보 목록에서 먼저 걸러내므로 피복 기여(주판정 union)에도 포함되지 않는다.
///
/// bbox 는 축 정렬 최소 직사각형이라 대각선/L자형 건물에서는 실제 풋프린트보다 훨씬 크다.
/// bbox 만으로 판정하면 실제로는 닿지도 않는 인접 건물이 '유령 겹침'으로 오억제되므로,
/// bbox 는 저비용 프리필터로만 쓰고 확정은 폴리곤 내부점으로 한다.
fn covering_tag(
    lower_ring: &[(f64, f64)],
    lower_bbox: &[f64; 4],
    lower_height_m: f64,
    index: &FootprintIndex,
    cands: &[usize],
) -> Option<String> {
    if lower_ring.len() < 3 || cands.is_empty() {
        return None;
    }
    // 높이 조건 미달 상위는 애초에 후보에서 제외 (주판정·보조판정 공통 게이트)
    let cands: Vec<usize> = cands
        .iter()
        .copied()
        .filter(|&ci| height_allows_suppress(&index.items[ci], lower_height_m))
        .collect();
    if cands.is_empty() {
        return None;
    }
    let cands = &cands[..];
    let (min_lat, max_lat, min_lon, max_lon) =
        (lower_bbox[0], lower_bbox[1], lower_bbox[2], lower_bbox[3]);
    let own_area = (max_lat - min_lat) * (max_lon - min_lon);
    if own_area <= 0.0 || !own_area.is_finite() {
        return None; // 퇴화(선/점) 풋프린트 — 판정 불가
    }

    // ── ① 면적비 ──
    let step_lat = (max_lat - min_lat) / SAMPLE_N as f64;
    let step_lon = (max_lon - min_lon) / SAMPLE_N as f64;
    let mut inside = 0u32;
    let mut covered = 0u32;
    // 후보별 피복 기여 수 (cands 와 같은 순서)
    let mut contrib = vec![0u32; cands.len()];
    for i in 0..SAMPLE_N {
        let lat = min_lat + (i as f64 + 0.5) * step_lat;
        for j in 0..SAMPLE_N {
            let lon = min_lon + (j as f64 + 0.5) * step_lon;
            if !crate::building::point_in_polygon_2d(lon, lat, lower_ring) {
                continue;
            }
            inside += 1;
            for (k, &ci) in cands.iter().enumerate() {
                let up = &index.items[ci];
                // bbox 퀵리젝트 후 실제 폴리곤 판정
                if lat < up.bbox[0] || lat > up.bbox[1] || lon < up.bbox[2] || lon > up.bbox[3] {
                    continue;
                }
                if crate::building::point_in_polygon_2d(lon, lat, &up.ring) {
                    covered += 1;
                    contrib[k] += 1;
                    break;
                }
            }
        }
    }
    // inside == 0 = 격자에 안 잡히는 초미세/슬리버 풋프린트 — 면적비 판정 생략(보조 판정으로 넘김)
    if inside > 0 && covered as f64 / inside as f64 >= COVER_RATIO {
        let best = contrib
            .iter()
            .enumerate()
            .max_by_key(|(_, n)| **n)
            .map(|(k, _)| cands[k]);
        if let Some(bi) = best {
            return Some(index.items[bi].tag.clone());
        }
    }

    // ── ② 포함비 (상위가 하위 안에 들어있는 경우) ──
    for &ci in cands {
        let up = &index.items[ci];
        let (u_min_lat, u_max_lat, u_min_lon, u_max_lon) =
            (up.bbox[0], up.bbox[1], up.bbox[2], up.bbox[3]);
        let u_area = (u_max_lat - u_min_lat) * (u_max_lon - u_min_lon);
        if u_area <= 0.0 || !u_area.is_finite() {
            continue;
        }
        let u_step_lat = (u_max_lat - u_min_lat) / CONTAIN_SAMPLE_N as f64;
        let u_step_lon = (u_max_lon - u_min_lon) / CONTAIN_SAMPLE_N as f64;
        let mut u_inside = 0u32;
        let mut u_contained = 0u32;
        for i in 0..CONTAIN_SAMPLE_N {
            let lat = u_min_lat + (i as f64 + 0.5) * u_step_lat;
            for j in 0..CONTAIN_SAMPLE_N {
                let lon = u_min_lon + (j as f64 + 0.5) * u_step_lon;
                if !crate::building::point_in_polygon_2d(lon, lat, &up.ring) {
                    continue;
                }
                u_inside += 1;
                if lat < min_lat || lat > max_lat || lon < min_lon || lon > max_lon {
                    continue;
                }
                if crate::building::point_in_polygon_2d(lon, lat, lower_ring) {
                    u_contained += 1;
                }
            }
        }
        if u_inside > 0 && u_contained as f64 / u_inside as f64 >= CONTAIN_RATIO {
            return Some(up.tag.clone());
        }
    }

    None
}

/// 영역 내 수동 건물(manual_buildings) 풋프린트 인덱스 적재.
/// 대형 도형이 영역 밖 중심점을 가질 수 있어 조회 범위에 AREA_MARGIN_DEG 여유를 준다.
fn load_manual_index(
    conn: &Connection,
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
) -> FootprintIndex {
    let mut idx = FootprintIndex::new();
    // 그룹 비활성(enabled=0) 여부와 무관하게 전부 적재 — 억제는 자료 우선순위의 문제이고,
    // 그룹 토글은 표시/판정 범위의 문제라 서로 독립이다(토글로 대장 중복이 되살아나면 안 됨).
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, latitude, longitude, geometry_type, geometry_json, height
         FROM manual_buildings
         WHERE latitude BETWEEN ?1 AND ?2 AND longitude BETWEEN ?3 AND ?4",
    ) else {
        log::warn!("[중복억제] 수동 건물 쿼리 준비 실패 — 수동 우선순위 생략");
        return idx;
    };
    let Ok(rows) = stmt.query_map(
        params![
            min_lat - AREA_MARGIN_DEG,
            max_lat + AREA_MARGIN_DEG,
            min_lon - AREA_MARGIN_DEG,
            max_lon + AREA_MARGIN_DEG
        ],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, f64>(5)?,
            ))
        },
    ) else {
        log::warn!("[중복억제] 수동 건물 쿼리 실행 실패 — 수동 우선순위 생략");
        return idx;
    };

    for (id, lat, lon, geo_type, geo_json, height) in rows.flatten() {
        if !lat.is_finite() || !lon.is_finite() {
            continue;
        }
        let ring = manual_ring(lat, lon, geo_type.as_deref(), geo_json.as_deref());
        let Some(bbox) = ring_bbox(&ring) else { continue };
        idx.push(format!("manual:{}", id), height, ring, bbox);
    }
    idx
}

/// 영역과 bbox 가 교차하는 실측3D 행 풋프린트 인덱스 적재.
fn load_measured_index(
    conn: &Connection,
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
) -> FootprintIndex {
    let mut idx = FootprintIndex::new();
    // WHERE 절의 실측 술어 텍스트는 db.rs 의 파셜 인덱스 idx_fac_buildings_measured_bbox
    // predicate 와 동일해야 플래너가 그 인덱스를 선택한다(db.rs 주석의 기존 계약) — 문구 변경 금지.
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, polygon_json, bbox_min_lat, bbox_max_lat, bbox_min_lon, bbox_max_lon,
                COALESCE(height_measured, height)
         FROM fac_buildings
         WHERE (height_measured IS NOT NULL OR region='실측3D')
           AND bbox_max_lat >= ?1 AND bbox_min_lat <= ?2
           AND bbox_max_lon >= ?3 AND bbox_min_lon <= ?4",
    ) else {
        log::warn!("[중복억제] 실측 행 쿼리 준비 실패 — 실측 우선순위 생략");
        return idx;
    };
    let Ok(rows) = stmt.query_map(params![min_lat, max_lat, min_lon, max_lon], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<f64>>(2)?,
            row.get::<_, Option<f64>>(3)?,
            row.get::<_, Option<f64>>(4)?,
            row.get::<_, Option<f64>>(5)?,
            row.get::<_, Option<f64>>(6)?,
        ))
    }) else {
        log::warn!("[중복억제] 실측 행 쿼리 실행 실패 — 실측 우선순위 생략");
        return idx;
    };

    for (id, poly_json, b0, b1, b2, b3, height) in rows.flatten() {
        // 폴리곤 파싱 실패 행은 피복 근거가 없어 스킵(억제 원인이 되지 못함)
        let Some(ring) = parse_polygon_ring(poly_json.as_deref()) else { continue };
        // bbox 는 저장 컬럼 우선, 미기입(NULL)이면 링에서 산출
        let bbox = match (b0, b1, b2, b3) {
            (Some(v0), Some(v1), Some(v2), Some(v3)) => [v0, v1, v2, v3],
            _ => match ring_bbox(&ring) {
                Some(b) => b,
                None => continue,
            },
        };
        idx.push(format!("measured:{}", id), height.unwrap_or(0.0), ring, bbox);
    }
    idx
}

/// 영역 내 fac_buildings 의 `suppressed_by` 를 우선순위 규칙으로 전면 재계산.
///
/// 규칙: ① 실측 행 — 수동 건물 풋프린트에 덮이면 'manual:<id>'
///       ② 대장(비실측) 행 — 수동에 덮이면 'manual:<id>', 아니고 실측 행 풋프린트에 덮이면 'measured:<fac_id>'
///       ③ 그 외 NULL. 수동 건물은 억제 대상 아님(별도 테이블, 최우선 자료).
///
/// 겹침 판정은 `covering_tag` — 면적비(24×24, ≥COVER_RATIO) 주 판정 + 포함비(12×12, ≥CONTAIN_RATIO)
/// 보조 판정. 폴리곤 파싱 실패 행은 판정 불가라 NULL 유지(fail-open).
///
/// 대상 행 범위는 **centroid 기준** — 조회부(BRA Pass 1 · query_buildings_3d_binary)가 쓰는 술어와
/// 동일하고 idx_fac_buildings_centroid 를 탄다. 호출부가 AREA_MARGIN_DEG 여유를 더해 부르므로
/// 풋프린트가 영역 경계를 넘는 행도 포함된다.
///
/// 반환: (억제로 바뀐 행 수, 해제로 바뀐 행 수) — 값이 실제로 바뀌는 행만 UPDATE 한다.
pub fn recompute_area(
    conn: &Connection,
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
) -> Result<(u64, u64), String> {
    if !(min_lat.is_finite() && max_lat.is_finite() && min_lon.is_finite() && max_lon.is_finite())
        || max_lat < min_lat
        || max_lon < min_lon
    {
        return Err(format!(
            "중복억제 재계산 영역이 비정상입니다: lat {}~{}, lon {}~{}",
            min_lat, max_lat, min_lon, max_lon
        ));
    }

    let started = std::time::Instant::now();
    let manual_idx = load_manual_index(conn, min_lat, max_lat, min_lon, max_lon);
    let measured_idx = load_measured_index(conn, min_lat, max_lat, min_lon, max_lon);

    // ── 대상 행 순회 — 변경분만 (id, 새 값) 으로 모아 한 트랜잭션에서 UPDATE ──
    let mut changes: Vec<(i64, Option<String>)> = Vec::new();
    let mut scanned: u64 = 0;
    {
        let mut stmt = conn
            .prepare(
                "SELECT id, polygon_json, bbox_min_lat, bbox_max_lat, bbox_min_lon, bbox_max_lon,
                        (height_measured IS NOT NULL OR region = '실측3D'), suppressed_by,
                        COALESCE(height_measured, height)
                 FROM fac_buildings
                 WHERE centroid_lat BETWEEN ?1 AND ?2
                   AND centroid_lon BETWEEN ?3 AND ?4",
            )
            .map_err(|e| format!("중복억제 대상 쿼리 준비 실패: {}", e))?;
        let rows = stmt
            .query_map(params![min_lat, max_lat, min_lon, max_lon], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<f64>>(2)?,
                    row.get::<_, Option<f64>>(3)?,
                    row.get::<_, Option<f64>>(4)?,
                    row.get::<_, Option<f64>>(5)?,
                    row.get::<_, bool>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<f64>>(8)?,
                ))
            })
            .map_err(|e| format!("중복억제 대상 쿼리 실행 실패: {}", e))?;

        for row in rows {
            let (id, poly_json, b0, b1, b2, b3, measured, current, lower_height) =
                row.map_err(|e| format!("중복억제 대상 행 읽기 실패: {}", e))?;
            // 높이 미상은 0 — 상위(실측)가 어떤 높이든 억제할 수 있다(기존 동작 유지)
            let lower_height_m = lower_height.filter(|v| v.is_finite()).unwrap_or(0.0);
            scanned += 1;
            if scanned % LOG_EVERY == 0 {
                log::info!("[중복억제] 스캔 {}행 · 변경 예정 {}건", scanned, changes.len());
            }

            // bbox 프리필터 — 대부분의 행이 여기서 후보 0건으로 끝난다(폴리곤 JSON 파싱 생략)
            let row_bbox: Option<[f64; 4]> = match (b0, b1, b2, b3) {
                (Some(v0), Some(v1), Some(v2), Some(v3)) => Some([v0, v1, v2, v3]),
                _ => None,
            };
            let (m_cands, s_cands) = match &row_bbox {
                Some(bb) => (
                    manual_idx.candidates(bb),
                    // 실측 행은 실측 우선순위 판정 대상이 아니다(자기 자신 매치 방지 포함)
                    if measured { Vec::new() } else { measured_idx.candidates(bb) },
                ),
                // bbox 미기입 행은 프리필터 근거가 없다 — 폴리곤 파싱 후 링 bbox 로 다시 잡는다
                None => (Vec::new(), Vec::new()),
            };

            let need_poly = row_bbox.is_none() || !m_cands.is_empty() || !s_cands.is_empty();
            let mut new_val: Option<String> = None;

            if need_poly {
                if let Some(ring) = parse_polygon_ring(poly_json.as_deref()) {
                    if let Some(bb) = ring_bbox(&ring) {
                        // bbox 미기입 행은 여기서 후보를 다시 구한다
                        let (m_cands, s_cands) = if row_bbox.is_some() {
                            (m_cands, s_cands)
                        } else {
                            (
                                manual_idx.candidates(&bb),
                                if measured { Vec::new() } else { measured_idx.candidates(&bb) },
                            )
                        };
                        // ① 수동 최우선
                        if !manual_idx.is_empty() {
                            new_val =
                                covering_tag(&ring, &bb, lower_height_m, &manual_idx, &m_cands);
                        }
                        // ② 수동에 안 덮인 대장 행만 실측 우선순위 적용
                        if new_val.is_none() && !measured && !measured_idx.is_empty() {
                            new_val =
                                covering_tag(&ring, &bb, lower_height_m, &measured_idx, &s_cands);
                        }
                    }
                }
                // 폴리곤 파싱 실패/퇴화 → new_val = None (판정 불가는 억제하지 않음)
            }

            if new_val != current {
                changes.push((id, new_val));
            }
        }
    }

    if changes.is_empty() {
        log::info!(
            "[중복억제] 재계산 완료 — 스캔 {}행 · 변경 없음 ({:.1}s)",
            scanned,
            started.elapsed().as_secs_f64()
        );
        return Ok((0, 0));
    }

    // ── 변경분 일괄 반영 (단일 트랜잭션 — 임포트 경로의 execute_batch("BEGIN") 관례와 동일) ──
    let mut suppressed: u64 = 0;
    let mut cleared: u64 = 0;
    conn.execute_batch("BEGIN")
        .map_err(|e| format!("중복억제 트랜잭션 시작 실패: {}", e))?;
    let upd_result: Result<(), String> = (|| {
        let mut upd = conn
            .prepare("UPDATE fac_buildings SET suppressed_by = ?1 WHERE id = ?2")
            .map_err(|e| format!("중복억제 UPDATE 준비 실패: {}", e))?;
        for (id, val) in &changes {
            upd.execute(params![val, id])
                .map_err(|e| format!("중복억제 UPDATE 실패: {}", e))?;
            if val.is_some() {
                suppressed += 1;
            } else {
                cleared += 1;
            }
            let done = suppressed + cleared;
            if done % LOG_EVERY == 0 {
                log::info!("[중복억제] 반영 {}/{}행", done, changes.len());
            }
        }
        Ok(())
    })();
    if let Err(e) = upd_result {
        let _ = conn.execute_batch("ROLLBACK");
        return Err(e);
    }
    conn.execute_batch("COMMIT")
        .map_err(|e| format!("중복억제 커밋 실패: {}", e))?;

    log::info!(
        "[중복억제] 재계산 완료 — 스캔 {}행 · 억제 {}행 · 해제 {}행 (수동 {}동 / 실측 {}동, {:.1}s)",
        scanned,
        suppressed,
        cleared,
        manual_idx.items.len(),
        measured_idx.items.len(),
        started.elapsed().as_secs_f64()
    );
    Ok((suppressed, cleared))
}

/// 실측 원인 억제만 전건 해제 — 실측 자료 초기화(measured_building::clear_measured) 전용.
/// 수동 원인('manual:%')은 그대로 둔다(원인이 남아 있으므로).
pub fn clear_measured_suppression(conn: &Connection) -> Result<u64, String> {
    let n = conn
        .execute(
            "UPDATE fac_buildings SET suppressed_by = NULL WHERE suppressed_by LIKE 'measured:%'",
            [],
        )
        .map_err(|e| format!("실측 중복억제 해제 실패: {}", e))?;
    Ok(n as u64)
}

/// 특정 수동 건물이 원인인 억제만 해제 (수동 건물 수정/삭제 시 영역 밖으로 이동한 잔재 방지).
pub fn clear_manual_suppression(conn: &Connection, manual_id: i64) -> Result<u64, String> {
    let n = conn
        .execute(
            "UPDATE fac_buildings SET suppressed_by = NULL WHERE suppressed_by = ?1",
            params![format!("manual:{}", manual_id)],
        )
        .map_err(|e| format!("수동 중복억제 해제 실패: {}", e))?;
    Ok(n as u64)
}

/// 기존 DB 1회 백필 — settings 에 완료 표식이 있으면 즉시 skip.
///
/// 대상 영역 = 실측 커버리지 bbox(있으면) ∪ 각 수동 건물 bbox(+AREA_MARGIN_DEG).
/// 앱 기동 시 백그라운드 스레드에서 호출한다(lib.rs setup) — 메인 스레드 블로킹 금지.
///
/// 완료 표식은 **전 영역이 성공했을 때만** 기록한다(부분 성공은 다음 기동 재시도).
///
/// 반환: 변경된 행 수(억제 + 해제). 0 이면 DB 상태가 그대로라 호출부의 캐시 무효화도 불필요하다.
pub fn backfill_if_needed(conn: &Connection) -> Result<u64, String> {
    if crate::db::get_setting(conn, BACKFILL_KEY)
        .unwrap_or(None)
        .is_some()
    {
        return Ok(0);
    }

    let started = std::time::Instant::now();
    let mut areas: Vec<[f64; 4]> = Vec::new();

    // ① 실측 커버리지 전역 — [min_lat, max_lat, min_lon, max_lon]
    match crate::measured_building::coverage_bbox(conn) {
        Ok(Some(b)) => areas.push(b),
        Ok(None) => {}
        Err(e) => log::warn!("[중복억제] 백필 실측 커버리지 조회 실패: {}", e),
    }

    // ② 수동 건물별 bbox — 실측 커버리지 밖의 수동 건물도 덮기 위함
    {
        let mut stmt = conn
            .prepare("SELECT latitude, longitude, geometry_type, geometry_json FROM manual_buildings")
            .map_err(|e| format!("백필 수동 건물 쿼리 준비 실패: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, f64>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|e| format!("백필 수동 건물 쿼리 실행 실패: {}", e))?;
        for (lat, lon, geo_type, geo_json) in rows.flatten() {
            if !lat.is_finite() || !lon.is_finite() {
                continue;
            }
            let b = manual_bbox(lat, lon, geo_type.as_deref(), geo_json.as_deref());
            areas.push([
                b[0] - AREA_MARGIN_DEG,
                b[1] + AREA_MARGIN_DEG,
                b[2] - AREA_MARGIN_DEG,
                b[3] + AREA_MARGIN_DEG,
            ]);
        }
    }

    if areas.is_empty() {
        // 억제 원인 자료가 전무 — 재계산할 것이 없다. 표식만 남겨 재시도를 막는다.
        let _ = crate::db::set_setting(conn, BACKFILL_KEY, "done");
        log::info!("[중복억제] 백필 대상 영역 없음 — 표식만 기록");
        return Ok(0);
    }

    let mut total_suppressed: u64 = 0;
    let mut total_cleared: u64 = 0;
    let mut ok_areas = 0usize;
    let area_count = areas.len();
    for a in &areas {
        match recompute_area(conn, a[0], a[1], a[2], a[3]) {
            Ok((s, c)) => {
                total_suppressed += s;
                total_cleared += c;
                ok_areas += 1;
            }
            // 영역 1건 실패는 비치명 — 나머지 영역은 계속 처리
            Err(e) => log::warn!("[중복억제] 백필 영역 재계산 실패: {}", e),
        }
    }
    if ok_areas == 0 {
        // 전 영역 실패 — 표식을 남기지 않아 다음 기동에서 재시도한다
        return Err(format!("백필 전 영역({}개) 재계산 실패", area_count));
    }
    if ok_areas < area_count {
        // 부분 성공 — 표식을 남기지 않아 다음 기동에서 **실패 영역**을 다시 처리한다.
        // 표식을 여기서 박으면 최대 영역(실측 커버리지 전역)이 실패했는데 소형 수동 bbox 성공만으로
        // 'done' 이 되어 실패 영역이 영구 미재계산으로 남는다.
        // 성공 영역의 변경분은 이미 DB 에 커밋됐으므로 Err 가 아니라 Ok(변경 행 수)로 반환한다 —
        // 호출부(lib.rs)가 n > 0 으로 캐시 무효화·emit 을 수행해야 화면이 옛 상태로 남지 않는다.
        log::warn!(
            "[중복억제] 백필 부분 성공 — 영역 {}/{} · 억제 {}행 · 해제 {}행 · 표식 미기록(다음 기동 재시도)",
            ok_areas,
            area_count,
            total_suppressed,
            total_cleared
        );
        return Ok(total_suppressed + total_cleared);
    }

    crate::db::set_setting(conn, BACKFILL_KEY, "done")
        .map_err(|e| format!("백필 표식 기록 실패: {}", e))?;
    log::info!(
        "[중복억제] 백필 완료 — 영역 {}개 · 억제 {}행 · 해제 {}행 ({:.1}s)",
        area_count,
        total_suppressed,
        total_cleared,
        started.elapsed().as_secs_f64()
    );
    Ok(total_suppressed + total_cleared)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 중심 (lat, lon) · 반변 half(deg) 정사각 링 — (lon, lat) 규약
    fn square(lat: f64, lon: f64, half: f64) -> Vec<(f64, f64)> {
        vec![
            (lon - half, lat - half),
            (lon + half, lat - half),
            (lon + half, lat + half),
            (lon - half, lat + half),
        ]
    }

    /// 상위 풋프린트 1건짜리 인덱스 (하위와 완전히 겹치는 위치)
    fn one_upper(tag: &str, height_m: f64, half: f64) -> FootprintIndex {
        let mut idx = FootprintIndex::new();
        let ring = square(37.5, 127.0, half);
        let bbox = ring_bbox(&ring).expect("상위 bbox");
        idx.push(tag.to_string(), height_m, ring, bbox);
        idx
    }

    /// 하위(대장) 행 판정 실행 — 상위와 같은 자리, 반변 0.0002°(≈22m)
    fn judge(idx: &FootprintIndex, lower_height_m: f64) -> Option<String> {
        let ring = square(37.5, 127.0, 0.0002);
        let bbox = ring_bbox(&ring).expect("하위 bbox");
        let cands = idx.candidates(&bbox);
        assert!(!cands.is_empty(), "프리필터 후보가 비었다 — 테스트 배치 오류");
        covering_tag(&ring, &bbox, lower_height_m, idx, &cands)
    }

    /// 저층 실측 블롭(8m)은 고층 대장(66m 아파트)을 억제하지 못한다
    #[test]
    fn test_low_measured_cannot_suppress_tall_register() {
        let idx = one_upper("measured:1", 8.0, 0.0002);
        assert_eq!(judge(&idx, 66.0), None);
    }

    /// 같은 높이대(실측 66m vs 대장 60m)는 정상 억제
    #[test]
    fn test_same_height_measured_suppresses() {
        let idx = one_upper("measured:1", 66.0, 0.0002);
        assert_eq!(judge(&idx, 60.0), Some("measured:1".to_string()));
    }

    /// 슬랙 범위 안(실측 55m vs 대장 60m — 5m 낮음)도 동일 건물로 인정
    #[test]
    fn test_measured_within_slack_suppresses() {
        let idx = one_upper("measured:1", 55.0, 0.0002);
        assert_eq!(judge(&idx, 60.0), Some("measured:1".to_string()));
    }

    /// h=0 수동 마커는 억제 불가 — 자신은 BRA 에서 스킵되므로 블랙홀이 된다
    #[test]
    fn test_zero_height_manual_cannot_suppress() {
        let idx = one_upper("manual:9", 0.0, 0.0002);
        assert_eq!(judge(&idx, 66.0), None);
    }

    /// h=5 수동은 높이와 무관하게 억제 (사용자 의도 최우선)
    #[test]
    fn test_low_manual_suppresses_regardless_of_height() {
        let idx = one_upper("manual:9", 5.0, 0.0002);
        assert_eq!(judge(&idx, 66.0), Some("manual:9".to_string()));
    }

    /// 보조 판정(포함비) 경로도 높이 조건을 탄다 — 큰 대장 안에 든 작은 저층 실측 블롭
    #[test]
    fn test_contain_branch_respects_height() {
        // 상위 반변 0.00002°(≈2m) → 하위(≈22m) 안에 완전히 포함 = 포함비 100%
        let low = one_upper("measured:1", 8.0, 0.00002);
        assert_eq!(judge(&low, 66.0), None);
        let tall = one_upper("measured:1", 66.0, 0.00002);
        assert_eq!(judge(&tall, 66.0), Some("measured:1".to_string()));
    }
}
