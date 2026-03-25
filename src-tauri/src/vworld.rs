//! vworld GIS건물통합정보 자동 다운로드
//!
//! 1. vworld.kr 로그인 (세션 쿠키 획득)
//! 2. dsId=18 데이터셋 파일 목록 수집 (페이지네이션)
//! 3. 지역코드 필터링
//! 4. 파일 다운로드 (ZIP)

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use log::info;
use reqwest::{cookie::Jar, Client};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const VWORLD: &str = "https://www.vworld.kr";
const DS_ID: &str = "18";
pub const LANDUSE_DS_ID: &str = "14";

#[derive(Serialize, Clone, Debug)]
pub struct VworldFile {
    pub ds_id: String,
    pub file_no: String,
    pub file_name: String,
    pub region_code: String,
    pub file_size: u64,
}

/// 쿠키 자동 관리 HTTP 클라이언트 생성
fn build_client() -> Result<Client, String> {
    let jar = Arc::new(Jar::default());
    Client::builder()
        .cookie_provider(jar)
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

/// AJAX 로그인 응답 JSON
#[derive(Deserialize, Debug)]
struct LoginResponse {
    #[serde(rename = "resultMap")]
    result_map: LoginResultMap,
}

#[derive(Deserialize, Debug)]
struct LoginResultMap {
    result: String,
    #[serde(default)]
    msg: Option<String>,
    #[serde(default, rename = "nextUrl")]
    next_url: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

/// vworld 로그인 — 세션 쿠키가 설정된 Client 반환
///
/// vworld는 `loginFnc.login()` JS에서 AJAX POST로 로그인 처리:
///   POST /v4po_usrlogin_a004.do
///   usrIdeE = btoa(id), usrPwdE = btoa(pw)
///   응답: JSON { resultMap: { result: "success"|"error", msg, nextUrl } }
pub async fn login(id: &str, pw: &str) -> Result<Client, String> {
    let client = build_client()?;

    // 1) 로그인 페이지 방문 → 세션 쿠키(PJSESSIONID) 획득
    info!("vworld: GET 로그인 페이지 (세션 쿠키 획득)");
    client
        .get(format!("{VWORLD}/v4po_usrlogin_a001.do"))
        .send()
        .await
        .map_err(|e| format!("로그인 페이지 로드 실패: {e}"))?;

    // 2) AJAX 로그인 POST (JS loginFnc.login 재현)
    let id_b64 = B64.encode(id.as_bytes());
    let pw_b64 = B64.encode(pw.as_bytes());
    info!("vworld: POST /v4po_usrlogin_a004.do (AJAX 로그인)");

    let form = [
        ("usrIdeE", id_b64.as_str()),
        ("usrPwdE", pw_b64.as_str()),
        ("nextUrl", ""),
    ];

    let resp = client
        .post(format!("{VWORLD}/v4po_usrlogin_a004.do"))
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Referer", format!("{VWORLD}/v4po_usrlogin_a001.do"))
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("로그인 요청 실패: {e}"))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("응답 읽기 실패: {e}"))?;
    info!("vworld: 로그인 응답 status={status}, body_len={}", body.len());

    // 3) JSON 응답 파싱
    let login_resp: LoginResponse = serde_json::from_str(&body).map_err(|e| {
        format!(
            "로그인 응답 JSON 파싱 실패: {e}\n응답 본문(앞 500자): {}",
            &body[..body.len().min(500)]
        )
    })?;

    match login_resp.result_map.result.as_str() {
        "success" => {
            info!("vworld: 로그인 성공");
            Ok(client)
        }
        "error" => {
            let msg = login_resp
                .result_map
                .msg
                .unwrap_or_else(|| "알 수 없는 오류".to_string());
            Err(format!("로그인 실패: {msg}"))
        }
        other => {
            // 비밀번호 변경 등 추가 처리 필요 시
            let msg = login_resp
                .result_map
                .msg
                .unwrap_or_else(|| format!("result={other}"));
            let redirect = login_resp
                .result_map
                .url
                .or(login_resp.result_map.next_url)
                .unwrap_or_default();
            info!("vworld: 로그인 추가 처리 필요 — result={other}, url={redirect}");
            // 리다이렉트 URL이 있으면 따라가기 (비밀번호 변경 안내 등 건너뛰기)
            if !redirect.is_empty() {
                let redirect_url = if redirect.starts_with("http") {
                    redirect
                } else {
                    format!("{VWORLD}{redirect}")
                };
                client
                    .get(&redirect_url)
                    .send()
                    .await
                    .map_err(|e| format!("리다이렉트 실패: {e}"))?;
                info!("vworld: 리다이렉트 완료 → 로그인 세션 유지");
                Ok(client)
            } else {
                Err(format!("로그인 처리 필요: {msg}"))
            }
        }
    }
}

/// 지역코드 목록으로 파일 목록 수집 (sidoCd별 쿼리)
pub async fn list_files_by_regions(
    client: &Client,
    region_codes: &[String],
) -> Result<Vec<VworldFile>, String> {
    let mut all = Vec::new();

    // 날짜 범위: 1년 전 ~ 오늘
    let now = time::OffsetDateTime::now_utc();
    let ago = now - time::Duration::days(365);
    let today = format!(
        "{}-{:02}-{:02}",
        now.year(),
        now.month() as u8,
        now.day()
    );
    let one_year_ago = format!(
        "{}-{:02}-{:02}",
        ago.year(),
        ago.month() as u8,
        ago.day()
    );

    for sido in region_codes {
        info!("vworld: sidoCd={sido} 최신 파일 조회");
        let url = format!(
            "{VWORLD}/dtmk/dtmk_ntads_s002.do\
             ?dsId={DS_ID}&dataSetSeq={DS_ID}&svcCde=NA\
             &pageSize=100&pageUnit=100\
             &pageIndex=1&datPageIndex=1&datPageSize=100\
             &listPageIndex=1\
             &startDate={start}&endDate={end}\
             &sidoCd={sido}&fileGbnCd=AL\
             &sortType=00",
            start = one_year_ago,
            end = today,
        );
        let html = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("파일 목록 로드 실패 (sidoCd={sido}): {e}"))?
            .text()
            .await
            .map_err(|e| format!("파일 목록 읽기 실패: {e}"))?;

        // 로그인 세션 만료 체크
        if (html.contains("usrlogin") || html.contains("로그인"))
            && html.contains("form")
            && !html.contains("chkDs")
            && !html.contains("download(")
        {
            return Err("세션 만료: 로그인이 필요합니다".into());
        }

        let mut files = parse_file_list(&html);
        for f in &mut files {
            if f.region_code.is_empty() {
                f.region_code = sido.clone();
            }
        }
        info!("vworld: sidoCd={sido} → {}개 파일 중 최신 1개 선택", files.len());

        // 최신 1개만 (첫 번째 = 최신순 정렬)
        if let Some(first) = files.into_iter().next() {
            all.push(first);
        } else {
            info!("vworld: sidoCd={sido} 파일 없음. HTML 크기={}B", html.len());
        }
    }

    info!("vworld: 총 {}개 파일 수집", all.len());
    Ok(all)
}

/// 단일 파일 다운로드 → 바이트 반환
pub async fn download_file(client: &Client, ds_id: &str, file_no: &str) -> Result<Vec<u8>, String> {
    // 다운로드 전 데이터셋 페이지 방문 (세션 워밍업 + Referer 체인)
    let dataset_url = format!(
        "{VWORLD}/dtmk/dtmk_ntads_s002.do?dsId={ds_id}&svcCde=NA&listPageIndex=1"
    );
    let _ = client.get(&dataset_url).send().await;

    let url = format!(
        "{VWORLD}/dtmk/downloadResourceFile.do?ds_id={ds_id}&fileNo={file_no}"
    );
    info!("vworld: 다운로드 ds_id={ds_id}, fileNo={file_no}");

    let resp = client
        .get(&url)
        .header("Referer", &dataset_url)
        .header("Origin", VWORLD)
        .send()
        .await
        .map_err(|e| format!("다운로드 요청 실패 (fileNo={file_no}): {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("다운로드 HTTP 오류: {status}"));
    }

    // Content-Type 확인 (HTML이면 세션 만료 또는 권한 문제)
    let is_html = resp
        .headers()
        .get("content-type")
        .and_then(|ct| ct.to_str().ok())
        .map(|ct| ct.contains("text/html"))
        .unwrap_or(false);

    if is_html {
        let body = resp.text().await.unwrap_or_default();
        // 실제 세션 만료 vs 다른 원인 구분
        if body.contains("usrlogin") || body.contains("로그인") {
            info!("vworld: 다운로드 응답이 HTML (로그인 페이지). body_len={}", body.len());
            return Err("다운로드 실패: 로그인 세션이 만료되었습니다".into());
        }
        // 동의/약관 페이지 등 다른 HTML
        let snippet: String = body.chars().filter(|c| !c.is_whitespace()).take(300).collect();
        info!("vworld: 다운로드 응답이 HTML (비로그인). body_len={}, snippet={}", body.len(), snippet);
        return Err(format!(
            "다운로드 실패: 파일 대신 HTML 응답 수신 (fileNo={file_no}, {}B). 사이트 구조 변경 가능성 있음.",
            body.len()
        ));
    }

    let bytes = resp.bytes()
        .await
        .map_err(|e| format!("다운로드 읽기 실패: {e}"))?;

    // ZIP 매직 바이트 검증 (PK\x03\x04)
    if bytes.len() < 4 || &bytes[..4] != b"PK\x03\x04" {
        info!(
            "vworld: 다운로드 데이터가 ZIP이 아님. len={}, head={:?}",
            bytes.len(),
            &bytes[..bytes.len().min(16)]
        );
        return Err(format!(
            "다운로드 실패: 유효하지 않은 파일 (fileNo={file_no}, {}B). ZIP 형식이 아닙니다.",
            bytes.len()
        ));
    }

    Ok(bytes.to_vec())
}

/// 지역코드로 파일 필터링
pub fn filter_by_region(files: &[VworldFile], codes: &[String]) -> Vec<VworldFile> {
    files
        .iter()
        .filter(|f| codes.iter().any(|c| f.region_code == *c))
        .cloned()
        .collect()
}

/// 지역코드 → 앱 내부 region key
pub fn region_code_to_key(code: &str) -> &str {
    match code {
        "11" => "seoul",
        "26" => "busan",
        "27" => "daegu",
        "28" => "incheon",
        "29" => "gwangju",
        "30" => "daejeon",
        "31" => "ulsan",
        "36" => "sejong",
        "41" => "gyeonggi",
        "42" => "gangwon",
        "43" => "chungbuk",
        "44" => "chungnam",
        "45" => "jeonbuk",
        "46" => "jeonnam",
        "47" => "gyeongbuk",
        "48" => "gyeongnam",
        "50" => "jeju",
        other => other,
    }
}

// ── HTML 파싱 유틸 ──────────────────────────────────────

fn attr_val(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_lowercase();
    for delim in ['"', '\''] {
        let pat = format!("{name}={delim}");
        if let Some(start) = lower.find(&pat) {
            let val_start = start + pat.len();
            let val_end = tag[val_start..].find(delim)? + val_start;
            return Some(html_decode(&tag[val_start..val_end]));
        }
    }
    None
}

fn html_decode(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

/// download(dsId, fileNo, fileSize) + chkDs 체크박스에서 파일 목록 추출
fn parse_file_list(html: &str) -> Vec<VworldFile> {
    let mut files = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut from = 0;

    // 전략 1: download() onclick 패턴
    while let Some(pos) = html[from..].find("download(") {
        let abs = from + pos;
        let Some(paren) = html[abs..].find(')') else {
            break;
        };
        let args = &html[abs + 9..abs + paren];
        let parts: Vec<&str> = args
            .split(',')
            .map(|s| {
                s.trim()
                    .trim_matches(|c: char| c == '\'' || c == '"' || c.is_whitespace())
            })
            .collect();

        if parts.len() >= 3 {
            let ds_id = parts[0].to_string();
            let file_no = parts[1].to_string();
            let file_size: u64 = parts[2].parse().unwrap_or(0);

            if seen.insert(file_no.clone()) {
                let ctx_start = abs.saturating_sub(800);
                let ctx_end = (abs + 800).min(html.len());
                let ctx = &html[ctx_start..ctx_end];

                files.push(VworldFile {
                    ds_id,
                    file_no,
                    file_name: detect_filename(ctx),
                    region_code: detect_region(ctx),
                    file_size,
                });
            }
        }
        from = abs + paren;
    }

    // 전략 2: chkDs 체크박스 fallback
    if files.is_empty() {
        from = 0;
        while let Some(pos) = html[from..].to_lowercase().find("name=\"chkds\"") {
            let abs = from + pos;
            let tag_start = html[..abs].rfind('<').unwrap_or(abs);
            let tag_end = html[abs..].find('>').map(|e| abs + e).unwrap_or(abs);
            let tag = &html[tag_start..=tag_end];

            if let Some(file_no) = attr_val(tag, "value") {
                if seen.insert(file_no.clone()) {
                    let ctx_start = abs.saturating_sub(800);
                    let ctx_end = (abs + 1200).min(html.len());
                    let ctx = &html[ctx_start..ctx_end];

                    files.push(VworldFile {
                        ds_id: DS_ID.to_string(),
                        file_no,
                        file_name: detect_filename(ctx),
                        region_code: detect_region(ctx),
                        file_size: 0,
                    });
                }
            }
            from = abs + 1;
        }
    }

    files
}

const REGION_CODES: &[(&str, &str)] = &[
    ("11", "서울"),
    ("26", "부산"),
    ("27", "대구"),
    ("28", "인천"),
    ("29", "광주"),
    ("30", "대전"),
    ("31", "울산"),
    ("36", "세종"),
    ("41", "경기"),
    ("42", "강원"),
    ("43", "충북"),
    ("44", "충남"),
    ("45", "전북"),
    ("46", "전남"),
    ("47", "경북"),
    ("48", "경남"),
    ("50", "제주"),
];

fn detect_region(ctx: &str) -> String {
    // _XX_ 패턴 우선 (파일명에서)
    for &(code, _) in REGION_CODES {
        if ctx.contains(&format!("_{code}_")) {
            return code.to_string();
        }
    }
    // 지역명 fallback
    for &(code, name) in REGION_CODES {
        if ctx.contains(name) {
            return code.to_string();
        }
    }
    String::new()
}

fn detect_filename(ctx: &str) -> String {
    let text = strip_tags(ctx);
    for word in text.split_whitespace() {
        if word.to_lowercase().ends_with(".zip") {
            return word.to_string();
        }
    }
    "건물통합정보.zip".to_string()
}

/// 주변 텍스트에서 파일명 감지 (다중 확장자, 기본값 없음)
fn detect_filename_any(ctx: &str) -> String {
    let text = strip_tags(ctx);
    for word in text.split_whitespace() {
        let lower = word.to_lowercase();
        if lower.ends_with(".zip") || lower.ends_with(".pdf") || lower.ends_with(".shp") {
            return word.to_string();
        }
    }
    String::new()
}

fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut inside = false;
    for ch in html.chars() {
        match ch {
            '<' => inside = true,
            '>' => inside = false,
            _ if !inside => out.push(ch),
            _ => {}
        }
    }
    out
}

// ── 건물통합정보 F_FAC_BUILDING (dsId=30524) ────────────────────

pub const FAC_BUILDING_DS_ID: &str = "30524";

/// 건물통합정보(F_FAC_BUILDING) 파일 목록 수집
/// - 이 데이터셋(dsId=30524, svcCde=MK)은 sidoCd 파라미터가 동작하지 않음
/// - 전체 목록을 수집한 후 파일명의 한글 지역명으로 필터링
/// - region_codes: 한글 지역명 (예: ["서울", "인천", "경기"])
pub async fn list_fac_building_files(
    client: &Client,
    region_codes: &[String],
) -> Result<Vec<VworldFile>, String> {
    let mut all = Vec::new();

    info!("vworld: 건물통합정보 전체 파일 목록 수집 (필터: {:?})", region_codes);

    // 전체 목록 페이지별 수집 (sidoCd 필터 미사용, svcCde=MK)
    let mut page = 1;
    loop {
        let url = format!(
            "{VWORLD}/dtmk/dtmk_ntads_s002.do\
             ?dsId={FAC_BUILDING_DS_ID}&dataSetSeq={FAC_BUILDING_DS_ID}&svcCde=MK\
             &pageSize=500&pageUnit=500\
             &pageIndex={page}&datPageIndex={page}&datPageSize=500\
             &listPageIndex=1\
             &fileGbnCd=AL\
             &sortType=00",
        );
        let html = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("건물통합정보 파일 목록 로드 실패 (page={page}): {e}"))?
            .text()
            .await
            .map_err(|e| format!("파일 목록 읽기 실패: {e}"))?;

        // 로그인 세션 만료 체크
        if (html.contains("usrlogin") || html.contains("로그인"))
            && html.contains("form")
            && !html.contains("chkDs")
            && !html.contains("download(")
        {
            return Err("세션 만료: 로그인이 필요합니다".into());
        }

        let files = parse_file_list_with_ds_id(&html, FAC_BUILDING_DS_ID);
        let count = files.len();

        // ZIP 파일만 필터
        let zips: Vec<_> = files.into_iter().filter(|f| {
            f.file_name.to_lowercase().ends_with(".zip") || f.file_name.is_empty()
        }).collect();

        info!("vworld: 건물통합정보 page={page} → {count}개 파일, {}개 ZIP", zips.len());
        all.extend(zips);

        // 500개 미만이면 마지막 페이지
        if count < 500 {
            break;
        }
        page += 1;
    }

    info!("vworld: 건물통합정보 총 {}개 파일 수집 (필터 전)", all.len());

    // 파일명에서 한글 지역명으로 필터링
    // 파일명 패턴: F_FAC_BUILDING_서울_강남구.zip, F_FAC_BUILDING_경기_고양시_덕양구.zip
    if !region_codes.is_empty() {
        all.retain(|f| {
            region_codes.iter().any(|region| f.file_name.contains(region.as_str()))
        });
        // region_code 필드 채우기
        for f in &mut all {
            for region in region_codes {
                if f.file_name.contains(region.as_str()) {
                    // REGION_CODES에서 숫자 코드 찾기
                    let code = REGION_CODES.iter()
                        .find(|(_, name)| *name == region.as_str())
                        .map(|(code, _)| code.to_string())
                        .unwrap_or_else(|| region.clone());
                    f.region_code = code;
                    break;
                }
            }
        }
    }

    info!("vworld: 건물통합정보 필터 후 {}개 파일", all.len());
    Ok(all)
}

// ── 토지이용계획정보 (dsId=14) ────────────────────────────────

/// 토지이용계획정보 파일 목록 수집 (sidoCd별 쿼리)
pub async fn list_landuse_files(
    client: &Client,
    region_codes: &[String],
) -> Result<Vec<VworldFile>, String> {
    let mut all = Vec::new();

    let now = time::OffsetDateTime::now_utc();
    let ago = now - time::Duration::days(365 * 3); // 토지이용계획은 업데이트 주기 길어 3년 범위
    let today = format!("{}-{:02}-{:02}", now.year(), now.month() as u8, now.day());
    let one_year_ago = format!("{}-{:02}-{:02}", ago.year(), ago.month() as u8, ago.day());

    for sido in region_codes {
        info!("vworld: 토지이용계획 sidoCd={sido} 파일 조회");
        let url = format!(
            "{VWORLD}/dtmk/dtmk_ntads_s002.do\
             ?dsId={LANDUSE_DS_ID}&dataSetSeq={LANDUSE_DS_ID}&svcCde=NA\
             &pageSize=100&pageUnit=100\
             &pageIndex=1&datPageIndex=1&datPageSize=100\
             &listPageIndex=1\
             &startDate={start}&endDate={end}\
             &sidoCd={sido}&fileGbnCd=AL\
             &sortType=00",
            start = one_year_ago,
            end = today,
        );
        let html = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("토지이용계획 파일 목록 로드 실패 (sidoCd={sido}): {e}"))?
            .text()
            .await
            .map_err(|e| format!("파일 목록 읽기 실패: {e}"))?;

        // 로그인 세션 만료 체크
        if (html.contains("usrlogin") || html.contains("로그인"))
            && html.contains("form")
            && !html.contains("chkDs")
            && !html.contains("download(")
        {
            return Err("세션 만료: 로그인이 필요합니다".into());
        }

        let mut files = parse_file_list_with_ds_id(&html, LANDUSE_DS_ID);
        for f in &mut files {
            if f.region_code.is_empty() {
                f.region_code = sido.clone();
            }
        }

        // ZIP 파일만 필터
        let zips: Vec<_> = files.into_iter().filter(|f| {
            f.file_name.to_lowercase().ends_with(".zip") || f.file_name.is_empty()
        }).collect();

        info!("vworld: 토지이용계획 sidoCd={sido} → {}개 파일 중 최신 1개 선택", zips.len());

        if let Some(first) = zips.into_iter().next() {
            all.push(first);
        } else {
            info!("vworld: 토지이용계획 sidoCd={sido} 파일 없음");
        }
    }

    info!("vworld: 토지이용계획 총 {}개 파일 수집", all.len());
    Ok(all)
}

// ── 토지이용계획도 타일 다운로드 ────────────────────────────────
//
// vworld dtkmap 지도에서 토지이용계획도 체크박스 ON 시 브라우저가 하는 것과 동일:
//   map.vworld.kr/proxy.do → 2d.vworld.kr WMS 프록시 경유
//   로그인/API키 불필요 (proxy.do가 서버사이드 인증 처리)
//   WMS 1.3.0, CRS=EPSG:4326, BBOX=lat,lon 순서
//   레이어: lt_c_lhblpn (토지이용계획도)

/// 토지이용계획도 WMS 타일 1장 다운로드 (proxy.do 경유, 로그인 불필요).
pub async fn download_landuse_tile(z: u32, x: u32, y: u32) -> Result<Vec<u8>, String> {
    let n = (1u64 << z) as f64;
    let lon_min = x as f64 / n * 360.0 - 180.0;
    let lon_max = (x + 1) as f64 / n * 360.0 - 180.0;
    let lat_max = (std::f64::consts::PI * (1.0 - 2.0 * y as f64 / n))
        .sinh()
        .atan()
        .to_degrees();
    let lat_min = (std::f64::consts::PI * (1.0 - 2.0 * (y + 1) as f64 / n))
        .sinh()
        .atan()
        .to_degrees();

    // WMS 1.3.0 + EPSG:4326 → BBOX = minlat,minlon,maxlat,maxlon
    let bbox = format!("{},{},{},{}", lat_min, lon_min, lat_max, lon_max);

    // 2d.vworld.kr WMS URL (proxy.do 내부 URL)
    let inner_url = format!(
        "https://2d.vworld.kr/2DCache/gis/map/WMS?\
         bbox={bbox}\
         &styles=lt_c_lhblpn\
         &format=image/png\
         &transparent=true\
         &crs=EPSG:4326\
         &version=1.3.0\
         &service=WMS\
         &request=GetMap\
         &layers=lt_c_lhblpn\
         &width=256&height=256"
    );

    // proxy.do 경유 URL (inner_url을 percent-encode)
    let encoded_inner: String = inner_url.bytes().map(|b| {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{:02X}", b),
        }
    }).collect();
    let proxy_url = format!("https://map.vworld.kr/proxy.do?url={encoded_inner}");

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP 클라이언트 생성 실패: {e}"))?;

    let resp = client
        .get(&proxy_url)
        .header("Referer", "https://map.vworld.kr/map/dtkmap.do")
        .send()
        .await
        .map_err(|e| format!("타일 요청 실패: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("타일 HTTP {}", resp.status()));
    }

    let bytes = resp.bytes().await.map_err(|e| format!("타일 읽기 실패: {e}"))?;

    if bytes.len() < 8 || !bytes.starts_with(b"\x89PNG") {
        return Err("PNG 이미지가 아닙니다".into());
    }

    Ok(bytes.to_vec())
}

// ── N3P (연속수치지형도 산봉우리) ──────────────────────────────

const N3P_DS_ID: &str = "30193";

/// N3P 데이터셋 파일 목록 수집 (최신 1개)
pub async fn list_n3p_files(client: &Client) -> Result<Vec<VworldFile>, String> {
    let now = time::OffsetDateTime::now_utc();
    let ago = now - time::Duration::days(365 * 3); // N3P는 업데이트 주기가 길어 3년 범위
    let today = format!("{}-{:02}-{:02}", now.year(), now.month() as u8, now.day());
    let start = format!("{}-{:02}-{:02}", ago.year(), ago.month() as u8, ago.day());

    info!("vworld: N3P 파일 목록 조회 (dsId={N3P_DS_ID})");
    let url = format!(
        "{VWORLD}/dtmk/dtmk_ntads_s002.do\
         ?dsId={N3P_DS_ID}&dataSetSeq={N3P_DS_ID}&svcCde=MK\
         &pageSize=100&pageUnit=100\
         &pageIndex=1&datPageIndex=1&datPageSize=100\
         &listPageIndex=1\
         &startDate={start}&endDate={today}\
         &fileGbnCd=AL\
         &sortType=00",
    );

    let html = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("N3P 파일 목록 로드 실패: {e}"))?
        .text()
        .await
        .map_err(|e| format!("N3P 파일 목록 읽기 실패: {e}"))?;

    // 세션 만료 체크
    if (html.contains("usrlogin") || html.contains("로그인"))
        && html.contains("form")
        && !html.contains("chkDs")
        && !html.contains("download(")
    {
        return Err("세션 만료: 로그인이 필요합니다".into());
    }

    let files = parse_file_list_with_ds_id(&html, N3P_DS_ID);
    info!("vworld: N3P → {}개 파일 발견", files.len());

    if files.is_empty() {
        return Ok(files);
    }

    // ZIP 파일만 필터 (PDF 설명서 등 제외) + N3P 키워드 우선
    let zips: Vec<_> = files.iter().filter(|f| {
        f.file_name.to_lowercase().ends_with(".zip")
    }).cloned().collect();

    let n3p_zips: Vec<_> = zips.iter().filter(|f| {
        let name_lower = f.file_name.to_lowercase();
        name_lower.contains("n3p") || name_lower.contains("산봉")
    }).cloned().collect();

    // N3P ZIP → ZIP → 전체 순서로 폴백
    let mut result = if !n3p_zips.is_empty() {
        n3p_zips
    } else if !zips.is_empty() {
        zips
    } else {
        files
    };
    result.truncate(1);
    Ok(result)
}

/// dsId를 지정하여 파일 목록 파싱 (N3P용)
fn parse_file_list_with_ds_id(html: &str, default_ds_id: &str) -> Vec<VworldFile> {
    let mut files = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut from = 0;

    // download() onclick 패턴
    while let Some(pos) = html[from..].find("download(") {
        let abs = from + pos;
        let Some(paren) = html[abs..].find(')') else { break };
        let args = &html[abs + 9..abs + paren];
        let parts: Vec<&str> = args
            .split(',')
            .map(|s| s.trim().trim_matches(|c: char| c == '\'' || c == '"' || c.is_whitespace()))
            .collect();

        if parts.len() >= 3 {
            let ds_id = parts[0].to_string();
            let file_no = parts[1].to_string();
            let file_size: u64 = parts[2].parse().unwrap_or(0);

            if seen.insert(file_no.clone()) {
                let ctx_start = abs.saturating_sub(800);
                let ctx_end = (abs + 800).min(html.len());
                let ctx = &html[ctx_start..ctx_end];

                files.push(VworldFile {
                    ds_id,
                    file_no,
                    file_name: detect_filename_any(ctx),
                    region_code: String::new(),
                    file_size,
                });
            }
        }
        from = abs + paren;
    }

    // chkDs fallback
    if files.is_empty() {
        from = 0;
        while let Some(pos) = html[from..].to_lowercase().find("name=\"chkds\"") {
            let abs = from + pos;
            let tag_start = html[..abs].rfind('<').unwrap_or(abs);
            let tag_end = html[abs..].find('>').map(|e| abs + e).unwrap_or(abs);
            let tag = &html[tag_start..=tag_end];

            if let Some(file_no) = attr_val(tag, "value") {
                if seen.insert(file_no.clone()) {
                    let ctx_start = abs.saturating_sub(800);
                    let ctx_end = (abs + 1200).min(html.len());
                    let ctx = &html[ctx_start..ctx_end];

                    files.push(VworldFile {
                        ds_id: default_ds_id.to_string(),
                        file_no,
                        file_name: detect_filename_any(ctx),
                        region_code: String::new(),
                        file_size: 0,
                    });
                }
            }
            from = abs + 1;
        }
    }

    files
}
