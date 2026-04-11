//! 도로명주소 데이터 임포트 및 오프라인 검색
//!
//! business.juso.go.kr에서 제공하는 주소DB(도로명주소) 전체분을
//! SQLite에 임포트하고 FTS5 전문검색을 통해 오프라인 주소 검색을 지원.
//!
//! 파일 형식: `|` 구분 TXT (UTF-8), 시도별 ZIP
//! 좌표: 별도 좌표DB (UTMK → WGS84 변환)

use log::info;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::Path;

use crate::coord::epsg5179_to_wgs84;

/// 임포트 진행률 이벤트
#[derive(Clone, Serialize)]
pub struct JusoImportProgress {
    pub total: usize,
    pub processed: usize,
    pub status: String,
}

/// 임포트 현황
#[derive(Serialize, Clone, Debug)]
pub struct JusoImportStatus {
    pub region: String,
    pub file_date: String,
    pub imported_at: i64,
    pub record_count: i64,
}

/// 주소 검색 결과
#[derive(Serialize, Clone, Debug)]
pub struct JusoSearchResult {
    pub full_addr: String,
    pub jibun_addr: String,
    pub sido: String,
    pub sigungu: String,
    pub road_name: String,
    pub building_name: String,
    pub zip_code: String,
    pub latitude: f64,
    pub longitude: f64,
}

// ── 주소DB TXT 파싱 ──────────────────────────────────────────

/// 주소DB 전체분 TXT 컬럼 인덱스 (|구분, 0-based)
/// business.juso.go.kr API 다운로드 rnaddrkor_*.txt (24 필드):
///   0: 관리번호, 1: 도로명코드, 2: 시도명, 3: 시군구명,
///   4: 법정읍면동명, 5: 법정리명, 6: 산여부, 7: 지번본번,
///   8: 지번부번, 9: 건물관리번호, 10: 도로명, 11: 지하여부,
///   12: 건물본번, 13: 건물부번, 14: 행정동코드, 15: 행정동명,
///   16: 우편번호, 17: 건물명, 18: 데이터기준일, ...
const COL_SIDO: usize = 2;
const COL_SIGUNGU: usize = 3;
const COL_EMD: usize = 4;
const COL_RI: usize = 5;
const COL_MOUNTAIN: usize = 6;
const COL_JIBUN_MAIN: usize = 7;
const COL_JIBUN_SUB: usize = 8;
const COL_BD_MGT_SN: usize = 9;
const COL_ROAD_NAME: usize = 10;
const COL_UNDERGROUND: usize = 11;
const COL_BLDG_MAIN: usize = 12;
const COL_BLDG_SUB: usize = 13;
const COL_ZIPCODE: usize = 16;
const COL_BLDG_NAME: usize = 17;

/// 좌표DB(entrc) TXT 컬럼 인덱스 (|구분, 0-based)
/// 0: 건물관리번호, ..., X좌표(UTMK), Y좌표(UTMK)
/// 실제 좌표DB 구조:
///   0: 시도명, 1: 시군구명, 2: 읍면동명, 3: 도로명,
///   4: 지하여부, 5: 건물본번, 6: 건물부번, 7: 건물관리번호,
///   8: 우편번호, 9: 건물명, 10: 이동사유코드, 11: 건물형태구분코드,
///   12: X좌표(UTMK/EPSG:5179 동향), 13: Y좌표(UTMK/EPSG:5179 북향)
const COORD_COL_BD_MGT_SN: usize = 7;
const COORD_COL_X: usize = 12;
const COORD_COL_Y: usize = 13;

/// TXT 한 행에서 도로명주소 문자열 조합
fn build_road_addr(fields: &[&str]) -> String {
    let sido = fields.get(COL_SIDO).unwrap_or(&"").trim();
    let sigungu = fields.get(COL_SIGUNGU).unwrap_or(&"").trim();
    let emd = fields.get(COL_EMD).unwrap_or(&"").trim();
    let road = fields.get(COL_ROAD_NAME).unwrap_or(&"").trim();
    let underground = fields.get(COL_UNDERGROUND).unwrap_or(&"0").trim();
    let main = fields.get(COL_BLDG_MAIN).unwrap_or(&"").trim();
    let sub = fields.get(COL_BLDG_SUB).unwrap_or(&"0").trim();

    let underground_prefix = if underground == "1" { "지하 " } else { "" };
    let bldg_num = if sub != "0" && !sub.is_empty() {
        format!("{}-{}", main, sub)
    } else {
        main.to_string()
    };

    let mut addr = format!("{} {} {} {}{}", sido, sigungu, road, underground_prefix, bldg_num);

    // 법정읍면동/리 참고정보 추가
    let ri = fields.get(COL_RI).unwrap_or(&"").trim();
    if !emd.is_empty() || !ri.is_empty() {
        let ref_info = if !ri.is_empty() {
            format!("{} {}", emd, ri)
        } else {
            emd.to_string()
        };
        addr.push_str(&format!(" ({})", ref_info));
    }

    addr
}

/// TXT 한 행에서 지번주소 문자열 조합
/// 예: "서울특별시 강남구 역삼동 123-4" 또는 "서울특별시 강남구 역삼동 산 5"
fn build_jibun_addr(fields: &[&str]) -> String {
    let sido = fields.get(COL_SIDO).unwrap_or(&"").trim();
    let sigungu = fields.get(COL_SIGUNGU).unwrap_or(&"").trim();
    let emd = fields.get(COL_EMD).unwrap_or(&"").trim();
    let ri = fields.get(COL_RI).unwrap_or(&"").trim();
    let mountain = fields.get(COL_MOUNTAIN).unwrap_or(&"0").trim();
    let jibun_main = fields.get(COL_JIBUN_MAIN).unwrap_or(&"").trim();

    if jibun_main.is_empty() || jibun_main == "0" {
        return String::new();
    }

    // 지번부번: 주소DB에서 14번 컬럼이 읍면동구분인 경우도 있으므로
    // 숫자인지 확인 후 사용
    let jibun_sub_raw = fields.get(COL_JIBUN_SUB).unwrap_or(&"0").trim();
    let jibun_sub = if jibun_sub_raw.parse::<u32>().is_ok() {
        jibun_sub_raw
    } else {
        "0"
    };

    let mountain_prefix = if mountain == "1" { "산 " } else { "" };
    let jibun_num = if jibun_sub != "0" && !jibun_sub.is_empty() {
        format!("{}-{}", jibun_main, jibun_sub)
    } else {
        jibun_main.to_string()
    };

    let dong = if !ri.is_empty() { ri } else { emd };
    format!("{} {} {} {}{}", sido, sigungu, dong, mountain_prefix, jibun_num)
}

/// BOM 제거 + EUC-KR 디텍트/변환 (첫 N바이트 체크)
fn read_zip_entry_to_string(entry: &mut zip::read::ZipFile) -> Result<String, String> {
    let mut raw = Vec::new();
    entry
        .read_to_end(&mut raw)
        .map_err(|e| format!("ZIP 항목 읽기 실패: {e}"))?;

    // UTF-8 BOM 제거
    let data = if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &raw[3..]
    } else {
        &raw
    };

    // UTF-8 우선 시도
    match std::str::from_utf8(data) {
        Ok(s) => Ok(s.to_string()),
        Err(_) => {
            // EUC-KR fallback
            let (decoded, _, _) = encoding_rs::EUC_KR.decode(data);
            Ok(decoded.into_owned())
        }
    }
}

/// ZIP 내 TXT 파일 이름 목록 수집 (주소DB 또는 좌표DB)
fn find_txt_entries(archive: &mut zip::ZipArchive<std::fs::File>) -> Vec<String> {
    let mut names = Vec::new();
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            let name = entry.name().to_string();
            let lower = name.to_lowercase();
            if (lower.ends_with(".txt") || lower.ends_with(".csv"))
                && !lower.contains("__macosx")
                && !lower.contains("readme")
                && !lower.contains("설명")
                && !lower.contains("jibun_") // 지번매핑 파일 제외 (14필드, 별도 포맷)
            {
                names.push(name);
            }
        }
    }
    names
}

/// ZIP 내 중첩 ZIP 파일 이름 목록 수집
fn find_zip_entries(archive: &mut zip::ZipArchive<std::fs::File>) -> Vec<String> {
    let mut names = Vec::new();
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            let name = entry.name().to_string();
            if name.to_lowercase().ends_with(".zip") && !name.contains("__MACOSX") {
                names.push(name);
            }
        }
    }
    names
}

/// 중첩 ZIP에서 지역명 추출 (파일명 기준)
fn extract_region_from_zip_name(name: &str) -> String {
    let fname = name.rsplit('/').next().unwrap_or(name);
    let regions = [
        "서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종",
        "경기", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주",
    ];
    for r in &regions {
        if fname.contains(r) {
            return r.to_string();
        }
    }
    // 지역명 못 찾으면 파일명 사용
    fname.trim_end_matches(".zip").trim_end_matches(".ZIP").to_string()
}

/// 중첩 ZIP을 임시 파일로 추출하고 (경로, 지역명) 목록 반환
pub fn extract_inner_zips(zip_path: &str) -> Result<Vec<(std::path::PathBuf, String)>, String> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("ZIP 열기 실패: {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("ZIP 아카이브 읽기 실패: {e}"))?;

    let inner_zips = find_zip_entries(&mut archive);
    if inner_zips.is_empty() {
        return Ok(Vec::new());
    }

    let mut results = Vec::new();
    let temp_dir = std::env::temp_dir().join("juso_inner");
    let _ = std::fs::create_dir_all(&temp_dir);

    for (idx, zip_name) in inner_zips.iter().enumerate() {
        let region = extract_region_from_zip_name(zip_name);
        let mut entry = archive
            .by_name(zip_name)
            .map_err(|e| format!("내부 ZIP 항목 열기 실패: {e}"))?;

        let mut buf = Vec::new();
        entry.read_to_end(&mut buf)
            .map_err(|e| format!("내부 ZIP 읽기 실패: {e}"))?;

        let inner_path = temp_dir.join(format!("inner_{}.zip", idx));
        std::fs::write(&inner_path, &buf)
            .map_err(|e| format!("내부 ZIP 저장 실패: {e}"))?;

        results.push((inner_path, region));
    }

    Ok(results)
}

/// ZIP이 중첩 ZIP 구조인지 확인 (내부에 .zip은 있지만 주소 TXT는 없는 경우)
pub fn is_nested_zip(zip_path: &str) -> bool {
    let Ok(file) = std::fs::File::open(zip_path) else { return false };
    let Ok(mut archive) = zip::ZipArchive::new(file) else { return false };
    let txts = find_txt_entries(&mut archive);
    // TXT가 없거나 주소 데이터가 아닌 메타 TXT만 있는 경우 중첩 구조로 판단
    let has_inner_zips = !find_zip_entries(&mut archive).is_empty();
    has_inner_zips && txts.is_empty()
}

/// 주소DB ZIP 파일에서 도로명주소 데이터를 임포트
pub fn import_address_zip(
    conn: &Connection,
    zip_path: &str,
    region: &str,
    progress_fn: &dyn Fn(JusoImportProgress),
) -> Result<usize, String> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("ZIP 파일 열기 실패: {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("ZIP 아카이브 읽기 실패: {e}"))?;

    let txt_names = find_txt_entries(&mut archive);
    if txt_names.is_empty() {
        return Err("ZIP에서 TXT 파일을 찾을 수 없습니다".into());
    }

    info!("[juso] {} TXT 파일 발견: {:?}", txt_names.len(), txt_names);

    progress_fn(JusoImportProgress {
        total: 0,
        processed: 0,
        status: "주소 데이터 로딩 중...".to_string(),
    });

    // 기존 지역 데이터 삭제
    conn.execute(
        "DELETE FROM juso_addresses WHERE region = ?1",
        params![region],
    )
    .map_err(|e| format!("기존 데이터 삭제 실패: {e}"))?;

    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "INSERT INTO juso_addresses (region, full_addr, jibun_addr, sido, sigungu, eupmyeondong, road_name, building_num, building_name, zip_code, bd_mgt_sn)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        )
        .map_err(|e| format!("INSERT 준비 실패: {e}"))?;

    let mut total_inserted = 0usize;
    let batch_size = 10_000;

    for txt_name in &txt_names {
        let mut entry = archive
            .by_name(txt_name)
            .map_err(|e| format!("TXT 항목 열기 실패: {e}"))?;

        let content = read_zip_entry_to_string(&mut entry)?;

        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            let fields: Vec<&str> = line.split('|').collect();
            if fields.len() < 11 {
                continue;
            }

            let sido = fields.get(COL_SIDO).unwrap_or(&"").trim();
            let sigungu = fields.get(COL_SIGUNGU).unwrap_or(&"").trim();
            let road_name = fields.get(COL_ROAD_NAME).unwrap_or(&"").trim();

            // 최소 필수 필드 검증
            if sido.is_empty() || road_name.is_empty() {
                continue;
            }

            // 헤더 행 스킵 (숫자가 아닌 첫 번째 필드)
            if fields[0].starts_with("관리") || fields[0].starts_with("번호") {
                continue;
            }

            let full_addr = build_road_addr(&fields);
            let jibun_addr = build_jibun_addr(&fields);
            let jibun_opt = if jibun_addr.is_empty() { None } else { Some(jibun_addr) };
            let emd = fields.get(COL_EMD).unwrap_or(&"").trim();
            let bldg_main = fields.get(COL_BLDG_MAIN).unwrap_or(&"").trim();
            let bldg_sub = fields.get(COL_BLDG_SUB).unwrap_or(&"0").trim();
            let building_num = if bldg_sub != "0" && !bldg_sub.is_empty() {
                format!("{}-{}", bldg_main, bldg_sub)
            } else {
                bldg_main.to_string()
            };
            let bldg_name = fields.get(COL_BLDG_NAME).unwrap_or(&"").trim();
            let zip_code = fields.get(COL_ZIPCODE).unwrap_or(&"").trim();
            let bd_mgt_sn = fields.get(COL_BD_MGT_SN).unwrap_or(&"").trim();

            stmt.execute(params![
                region,
                full_addr,
                jibun_opt,
                sido,
                sigungu,
                emd,
                road_name,
                building_num,
                bldg_name,
                zip_code,
                bd_mgt_sn,
            ])
            .map_err(|e| format!("INSERT 실패: {e}"))?;

            total_inserted += 1;

            if total_inserted % batch_size == 0 {
                conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
                conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
                progress_fn(JusoImportProgress {
                    total: 0,
                    processed: total_inserted,
                    status: format!("주소 {}건 임포트 중...", total_inserted),
                });
            }
        }
    }

    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;

    // 건물통합정보(fac_buildings)에서 좌표 매칭 (bd_mgt_sn 기준)
    progress_fn(JusoImportProgress {
        total: 0,
        processed: total_inserted,
        status: "건물 좌표 매칭 중...".to_string(),
    });
    match_coords_from_fac_buildings(conn);

    // FTS5 인덱스 리빌드
    progress_fn(JusoImportProgress {
        total: 0,
        processed: total_inserted,
        status: "검색 인덱스 생성 중...".to_string(),
    });
    rebuild_fts(conn)?;

    // 임포트 로그 기록 (0건이면 기존 로그 삭제)
    if total_inserted == 0 {
        let _ = conn.execute(
            "DELETE FROM juso_import_log WHERE region = ?1",
            params![region],
        );
    } else {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let zip_filename = Path::new(zip_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown.zip");

        conn.execute(
            "INSERT OR REPLACE INTO juso_import_log (region, file_date, imported_at, record_count) VALUES (?1, ?2, ?3, ?4)",
            params![region, zip_filename, now, total_inserted as i64],
        )
        .map_err(|e| format!("임포트 로그 저장 실패: {e}"))?;
    }

    info!("[juso] {} 지역 {}건 임포트 완료", region, total_inserted);

    progress_fn(JusoImportProgress {
        total: total_inserted,
        processed: total_inserted,
        status: format!("완료: {}건 임포트", total_inserted),
    });

    Ok(total_inserted)
}

/// 건물통합정보(fac_buildings) 테이블에서 좌표를 가져와 주소에 매칭
fn match_coords_from_fac_buildings(conn: &Connection) {
    let result = conn.execute(
        "UPDATE juso_addresses SET latitude = sub.lat, longitude = sub.lon
         FROM (
             SELECT bd_mgt_sn, centroid_lat AS lat, centroid_lon AS lon
             FROM fac_buildings
             WHERE bd_mgt_sn IS NOT NULL AND bd_mgt_sn != ''
         ) AS sub
         WHERE juso_addresses.bd_mgt_sn = sub.bd_mgt_sn
           AND juso_addresses.latitude IS NULL",
        [],
    );
    match result {
        Ok(n) => info!("[juso] fac_buildings에서 좌표 {}건 매칭", n),
        Err(e) => info!("[juso] fac_buildings 좌표 매칭 실패 (무시): {e}"),
    }
}

/// 좌표DB ZIP 파일에서 좌표를 읽어 기존 주소에 매칭
pub fn import_coord_zip(
    conn: &Connection,
    zip_path: &str,
    progress_fn: &dyn Fn(JusoImportProgress),
) -> Result<usize, String> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("좌표DB ZIP 열기 실패: {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("ZIP 아카이브 읽기 실패: {e}"))?;

    let txt_names = find_txt_entries(&mut archive);
    if txt_names.is_empty() {
        return Err("ZIP에서 좌표 TXT 파일을 찾을 수 없습니다".into());
    }

    info!("[juso] 좌표DB {} TXT 파일 발견", txt_names.len());

    progress_fn(JusoImportProgress {
        total: 0,
        processed: 0,
        status: "좌표 데이터 로딩 중...".to_string(),
    });

    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "UPDATE juso_addresses SET latitude = ?1, longitude = ?2 WHERE bd_mgt_sn = ?3 AND latitude IS NULL",
        )
        .map_err(|e| format!("UPDATE 준비 실패: {e}"))?;

    let mut total_updated = 0usize;
    let batch_size = 10_000;
    let mut processed = 0usize;

    for txt_name in &txt_names {
        let mut entry = archive
            .by_name(txt_name)
            .map_err(|e| format!("좌표 TXT 항목 열기 실패: {e}"))?;

        let content = read_zip_entry_to_string(&mut entry)?;

        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            let fields: Vec<&str> = line.split('|').collect();
            if fields.len() <= COORD_COL_Y {
                continue;
            }

            let bd_mgt_sn = fields.get(COORD_COL_BD_MGT_SN).unwrap_or(&"").trim();
            if bd_mgt_sn.is_empty() {
                continue;
            }

            let x_str = fields.get(COORD_COL_X).unwrap_or(&"").trim();
            let y_str = fields.get(COORD_COL_Y).unwrap_or(&"").trim();

            let x: f64 = match x_str.parse() {
                Ok(v) if v > 0.0 => v,
                _ => continue,
            };
            let y: f64 = match y_str.parse() {
                Ok(v) if v > 0.0 => v,
                _ => continue,
            };

            // UTMK (EPSG:5179) → WGS84
            let (lat, lon) = epsg5179_to_wgs84(x, y);

            // 한국 영역 검증
            if lat < 33.0 || lat > 43.0 || lon < 124.0 || lon > 132.0 {
                continue;
            }

            let changed = stmt
                .execute(params![lat, lon, bd_mgt_sn])
                .map_err(|e| format!("좌표 UPDATE 실패: {e}"))?;

            if changed > 0 {
                total_updated += changed;
            }

            processed += 1;
            if processed % batch_size == 0 {
                conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
                conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
                progress_fn(JusoImportProgress {
                    total: 0,
                    processed,
                    status: format!("좌표 {}건 매칭 중...", total_updated),
                });
            }
        }
    }

    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;

    info!("[juso] 좌표 {}건 매칭 완료", total_updated);

    progress_fn(JusoImportProgress {
        total: processed,
        processed,
        status: format!("좌표 매칭 완료: {}건", total_updated),
    });

    Ok(total_updated)
}

// ── FTS5 전문검색 ──────────────────────────────────────────

/// FTS5 인덱스 전체 리빌드
fn rebuild_fts(conn: &Connection) -> Result<(), String> {
    // 깨진 FTS5 테이블 복구: DROP 후 재생성
    let _ = conn.execute_batch("DROP TABLE IF EXISTS juso_fts;");
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS juso_fts USING fts5(
            full_addr, jibun_addr, sido, sigungu, road_name, building_name,
            content=juso_addresses,
            content_rowid=id
        );",
    )
    .map_err(|e| format!("FTS5 테이블 생성 실패: {e}"))?;

    conn.execute_batch(
        "INSERT INTO juso_fts(rowid, full_addr, jibun_addr, sido, sigungu, road_name, building_name)
         SELECT id, full_addr, jibun_addr, sido, sigungu, road_name, building_name FROM juso_addresses;",
    )
    .map_err(|e| format!("FTS5 리빌드 실패: {e}"))?;
    Ok(())
}

/// FTS5 주소 검색 (TrackMap 검색창 용)
pub fn search_address(
    conn: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<JusoSearchResult>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    // FTS5 쿼리: 각 단어를 prefix 매칭으로 변환
    let fts_query: String = query
        .split_whitespace()
        .filter(|w| !w.is_empty())
        .map(|w| format!("\"{}\"*", w.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" ");

    if fts_query.is_empty() {
        return Ok(Vec::new());
    }

    let mut stmt = conn
        .prepare(
            "SELECT a.full_addr, a.jibun_addr, a.sido, a.sigungu, a.road_name, a.building_name,
                    a.zip_code, COALESCE(a.latitude, 0.0), COALESCE(a.longitude, 0.0)
             FROM juso_fts f
             JOIN juso_addresses a ON a.id = f.rowid
             WHERE juso_fts MATCH ?1
             ORDER BY (a.latitude IS NOT NULL) DESC, rank
             LIMIT ?2",
        )
        .map_err(|e| format!("FTS5 검색 준비 실패: {e}"))?;

    let rows = stmt
        .query_map(params![fts_query, limit as i64], |row| {
            Ok(JusoSearchResult {
                full_addr: row.get(0)?,
                jibun_addr: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                sido: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                sigungu: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                road_name: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                building_name: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                zip_code: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                latitude: row.get(7)?,
                longitude: row.get(8)?,
            })
        })
        .map_err(|e| format!("FTS5 검색 실패: {e}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("결과 수집 실패: {e}"))
}

// ── 상태 조회 / 삭제 ──────────────────────────────────────────

/// 임포트 현황 조회
pub fn get_import_status(conn: &Connection) -> Result<Vec<JusoImportStatus>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT region, file_date, imported_at, record_count FROM juso_import_log WHERE record_count > 0 ORDER BY region",
        )
        .map_err(|e| format!("쿼리 실패: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(JusoImportStatus {
                region: row.get(0)?,
                file_date: row.get(1)?,
                imported_at: row.get(2)?,
                record_count: row.get(3)?,
            })
        })
        .map_err(|e| format!("쿼리 실행 실패: {e}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("결과 수집 실패: {e}"))
}

/// 총 주소 건수 (전체)
pub fn get_total_count(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM juso_addresses", [], |row| row.get(0))
        .map_err(|e| format!("카운트 실패: {e}"))
}

/// 좌표 매칭된 주소 건수
pub fn get_geocoded_count(conn: &Connection) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM juso_addresses WHERE latitude IS NOT NULL",
        [],
        |row| row.get(0),
    )
    .map_err(|e| format!("카운트 실패: {e}"))
}

/// 주소 데이터 삭제
pub fn clear_data(conn: &Connection, region: Option<&str>) -> Result<(), String> {
    match region {
        Some(r) => {
            conn.execute("DELETE FROM juso_addresses WHERE region = ?1", params![r])
                .map_err(|e| format!("삭제 실패: {e}"))?;
            conn.execute("DELETE FROM juso_import_log WHERE region = ?1", params![r])
                .map_err(|e| format!("로그 삭제 실패: {e}"))?;
        }
        None => {
            conn.execute("DELETE FROM juso_addresses", [])
                .map_err(|e| format!("전체 삭제 실패: {e}"))?;
            conn.execute("DELETE FROM juso_import_log", [])
                .map_err(|e| format!("전체 로그 삭제 실패: {e}"))?;
        }
    }
    // FTS 리빌드
    rebuild_fts(conn)?;
    Ok(())
}

// ── business.juso.go.kr 자동 다운로드 ──────────────────────────

const JUSO_BASE: &str = "https://business.juso.go.kr";

/// HTTP 클라이언트 생성 (로그인 불필요)
pub fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(20))
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
             AppleWebKit/537.36 (KHTML, like Gecko) \
             Chrome/120.0.0.0 Safari/537.36",
        )
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("HTTP 클라이언트 생성 실패: {e}"))
}

#[derive(Clone, Debug)]
pub struct JusoDownloadFile {
    pub name: String,
    pub url: String,
    pub region: String,
}

/// JSON API 응답의 파일 항목
#[derive(Deserialize, Debug)]
#[allow(dead_code)]
struct JusoFileEntry {
    #[serde(rename = "crtrYm", default)]
    crtr_ym: Option<String>,
    #[serde(rename = "fileTypeNm", default)]
    file_type_nm: Option<String>,
    #[serde(rename = "fileNm", default)]
    file_nm: Option<String>,
    #[serde(rename = "tmprFileNm", default)]
    tmpr_file_nm: Option<String>,
    #[serde(rename = "isExist", default)]
    is_exist: Option<String>,
    #[serde(rename = "ctpvClsfCd", default)]
    ctpv_clsf_cd: Option<String>,
    #[serde(rename = "fileSn", default)]
    file_sn: Option<serde_json::Value>,
    #[serde(rename = "atflNo", default)]
    atfl_no: Option<serde_json::Value>,
}

#[derive(Deserialize, Debug)]
struct JusoApiResults {
    #[serde(rename = "allMonthFileList", default)]
    all_month_file_list: Vec<JusoFileEntry>,
}

#[derive(Deserialize, Debug)]
struct JusoApiResponse {
    status: u16,
    results: Option<JusoApiResults>,
}

/// 주소DB 최신 월전체 파일 목록 조회 (JSON API)
///
/// rtlDtaDtlSn: 1=도로명주소 한글, 3=건물DB, 10=도로명코드 등
/// aplyDtaSeCd: 11=월전체, 21=월변동, 22=일변동
pub async fn list_address_files(
    client: &reqwest::Client,
) -> Result<Vec<JusoDownloadFile>, String> {
    info!("[juso] 주소DB JSON API 파일 목록 수집");

    let now = time::OffsetDateTime::now_utc();
    let year = now.year();
    let month = now.month() as u8;

    // rtlDtaDtlSn=1: 도로명주소 한글 월전체
    let resp = client
        .post(format!("{JUSO_BASE}/api/jst/selectAttrbDBDwldList"))
        .json(&serde_json::json!({
            "rtlDtaDtlSn": "1",
            "year": year,
            "month": month,
            "expand": "Y"
        }))
        .send()
        .await
        .map_err(|e| format!("주소DB API 요청 실패: {e}"))?;

    let api_resp: JusoApiResponse = resp
        .json()
        .await
        .map_err(|e| format!("주소DB API 응답 파싱 실패: {e}"))?;

    if api_resp.status != 200 {
        return Err(format!("주소DB API 오류: status={}", api_resp.status));
    }

    let results = api_resp.results.ok_or("주소DB API 결과 없음")?;

    // 최신 월전체(isExist=Y)만 필터, 가장 최신 1개
    let latest = results
        .all_month_file_list
        .iter()
        .filter(|f| f.is_exist.as_deref() == Some("Y") && f.file_nm.is_some())
        .last(); // 목록이 오래된 순이므로 마지막이 최신

    let mut files = Vec::new();
    if let Some(entry) = latest {
        let file_nm = entry.file_nm.as_deref().unwrap_or("주소DB.zip");
        let url = build_download_url(entry);
        files.push(JusoDownloadFile {
            name: file_nm.to_string(),
            url,
            region: "전국".to_string(),
        });
    }

    info!("[juso] {}개 주소DB 파일 발견", files.len());
    Ok(files)
}

/// 좌표DB(건물DB) 최신 월전체 파일 목록 조회
///
/// rtlDtaDtlSn=3: 건물DB (좌표 포함)
pub async fn list_coord_files(
    client: &reqwest::Client,
) -> Result<Vec<JusoDownloadFile>, String> {
    info!("[juso] 건물DB(좌표) JSON API 파일 목록 수집");

    let now = time::OffsetDateTime::now_utc();
    let year = now.year();
    let month = now.month() as u8;

    let resp = client
        .post(format!("{JUSO_BASE}/api/jst/selectAttrbDBDwldList"))
        .json(&serde_json::json!({
            "rtlDtaDtlSn": "3",
            "year": year,
            "month": month,
            "expand": "Y"
        }))
        .send()
        .await
        .map_err(|e| format!("건물DB API 요청 실패: {e}"))?;

    let api_resp: JusoApiResponse = resp
        .json()
        .await
        .map_err(|e| format!("건물DB API 응답 파싱 실패: {e}"))?;

    if api_resp.status != 200 {
        return Err(format!("건물DB API 오류: status={}", api_resp.status));
    }

    let results = api_resp.results.ok_or("건물DB API 결과 없음")?;

    let latest = results
        .all_month_file_list
        .iter()
        .filter(|f| f.is_exist.as_deref() == Some("Y") && f.file_nm.is_some())
        .last();

    let mut files = Vec::new();
    if let Some(entry) = latest {
        let file_nm = entry.file_nm.as_deref().unwrap_or("건물DB.zip");
        let url = build_download_url(entry);
        files.push(JusoDownloadFile {
            name: file_nm.to_string(),
            url,
            region: "전국".to_string(),
        });
    }

    info!("[juso] {}개 건물DB 파일 발견", files.len());
    Ok(files)
}

/// API 응답 항목에서 다운로드 URL 조합
fn build_download_url(entry: &JusoFileEntry) -> String {
    let req_type = entry.file_type_nm.as_deref().unwrap_or("");
    let ctprvn_cd = entry.ctpv_clsf_cd.as_deref().unwrap_or("00");
    let stdde = entry.crtr_ym.as_deref().unwrap_or("");
    let file_name = entry.file_nm.as_deref().unwrap_or("");
    let real_file_name = entry.tmpr_file_nm.as_deref().unwrap_or("");
    let int_file_no = match &entry.file_sn {
        Some(serde_json::Value::Number(n)) => n.to_string(),
        Some(serde_json::Value::String(s)) => s.clone(),
        _ => "0".to_string(),
    };
    let int_num = match &entry.atfl_no {
        Some(serde_json::Value::Number(n)) => n.to_string(),
        Some(serde_json::Value::String(s)) => s.clone(),
        _ => "0".to_string(),
    };
    let reg_ymd = if stdde.len() >= 4 { &stdde[..4] } else { stdde };

    // 수동 percent-encode (한글 파일명)
    fn pct_encode(s: &str) -> String {
        let mut out = String::new();
        for b in s.bytes() {
            match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    out.push(b as char);
                }
                _ => {
                    out.push_str(&format!("%{:02X}", b));
                }
            }
        }
        out
    }

    format!(
        "{JUSO_BASE}/api/jst/download?reqType={}&ctprvnCd={}&stdde={}&fileName={}&realFileName={}&intFileNo={}&intNum={}&regYmd={}",
        pct_encode(req_type),
        pct_encode(ctprvn_cd),
        pct_encode(stdde),
        pct_encode(file_name),
        pct_encode(real_file_name),
        pct_encode(&int_file_no),
        pct_encode(&int_num),
        pct_encode(reg_ymd),
    )
}

/// 파일 다운로드
pub async fn download_file(
    client: &reqwest::Client,
    url: &str,
) -> Result<Vec<u8>, String> {
    info!("[juso] 다운로드: {}", url);
    let resp = client
        .get(url)
        .header("Referer", format!("{JUSO_BASE}/jst/jstAddressDownload"))
        .send()
        .await
        .map_err(|e| format!("다운로드 요청 실패: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("다운로드 HTTP {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("다운로드 데이터 읽기 실패: {e}"))?;

    if bytes.len() < 100 {
        return Err("다운로드된 파일이 너무 작습니다".into());
    }

    Ok(bytes.to_vec())
}
