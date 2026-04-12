//! vworld 통합검색 스크래핑 기반 주소/장소 검색 + 건물 상세정보
//!
//! map.vworld.kr 지도의 통합검색 엔드포인트(unifiedSearch2.do)를 사용하여
//! 도로명주소 + 장소/건물명 검색 + 좌표(WGS84) 반환. API 키 불필요.
//! 건물 상세정보는 po_buildMetaInfoGIS.do 엔드포인트에서 HTML 파싱.

use serde::{Deserialize, Serialize};

const SEARCH_URL: &str = "https://apis.vworld.kr/unifiedSearch2.do";
const REFERER: &str = "https://map.vworld.kr/map/dtkmap.do";

#[derive(Debug, Clone, Serialize)]
pub struct VWorldSearchResult {
    pub address: String,
    pub building_name: String,
    pub zip_code: String,
    pub latitude: f64,
    pub longitude: f64,
    /// "juso" | "place"
    pub result_type: String,
}

// unifiedSearch2.do 응답 구조 (Juso)
#[derive(Debug, Deserialize)]
struct ApiResponse {
    #[serde(rename = "LIST")]
    list: Option<Vec<JusoItem>>,
}

#[derive(Debug, Deserialize)]
struct JusoItem {
    #[serde(rename = "JUSO", default)]
    juso: String,
    #[serde(rename = "BLD_NM", default)]
    bld_nm: String,
    #[serde(rename = "ZIP_CL", default)]
    zip_cl: String,
    #[serde(default)]
    xpos: String,
    #[serde(default)]
    ypos: String,
}

// Place 카테고리 응답 구조
#[derive(Debug, Deserialize)]
struct PlaceResponse {
    #[serde(rename = "LIST")]
    list: Option<Vec<PlaceItem>>,
}

#[derive(Debug, Deserialize)]
struct PlaceItem {
    /// 장소/시설명
    #[serde(rename = "TITLE", default)]
    title: String,
    /// 주소
    #[serde(rename = "ADDRESS", default)]
    address: String,
    #[serde(default)]
    xpos: String,
    #[serde(default)]
    ypos: String,
}

fn percent_encode(q: &str) -> String {
    q.bytes()
        .flat_map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![b as char]
            }
            b' ' => vec!['+'],
            _ => format!("%{:02X}", b).chars().collect(),
        })
        .collect()
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP 클라이언트 생성 실패: {e}"))
}

async fn fetch_json(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let resp = client
        .get(url)
        .header("Referer", REFERER)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        )
        .send()
        .await
        .map_err(|e| format!("vworld 검색 요청 실패: {e}"))?;
    resp.text()
        .await
        .map_err(|e| format!("응답 읽기 실패: {e}"))
}

/// vworld 통합검색으로 주소 + 장소 검색
pub async fn search(query: &str, limit: usize) -> Result<Vec<VWorldSearchResult>, String> {
    let q = query.trim();
    if q.len() < 2 {
        return Ok(Vec::new());
    }

    let client = build_client()?;
    let encoded_q = percent_encode(q);

    // Juso, Place 카테고리 병렬 요청
    let juso_url = format!(
        "{}?q={}&output=json&qType=map&category=Juso&count={}",
        SEARCH_URL, encoded_q, limit,
    );
    let place_url = format!(
        "{}?q={}&output=json&qType=map&category=Place&count={}",
        SEARCH_URL, encoded_q, limit,
    );

    let (juso_res, place_res) = tokio::join!(
        fetch_json(&client, &juso_url),
        fetch_json(&client, &place_url),
    );

    let mut results = Vec::new();

    // Juso 결과
    if let Ok(text) = juso_res {
        if let Ok(api) = serde_json::from_str::<ApiResponse>(&text) {
            for it in api.list.unwrap_or_default() {
                let lat: f64 = match it.ypos.parse() { Ok(v) => v, Err(_) => continue };
                let lon: f64 = match it.xpos.parse() { Ok(v) => v, Err(_) => continue };
                if lat == 0.0 || lon == 0.0 { continue; }
                results.push(VWorldSearchResult {
                    address: it.juso,
                    building_name: it.bld_nm,
                    zip_code: it.zip_cl,
                    latitude: lat,
                    longitude: lon,
                    result_type: "juso".to_string(),
                });
            }
        }
    }

    // Place 결과
    if let Ok(text) = place_res {
        if let Ok(api) = serde_json::from_str::<PlaceResponse>(&text) {
            for it in api.list.unwrap_or_default() {
                let lat: f64 = match it.ypos.parse() { Ok(v) => v, Err(_) => continue };
                let lon: f64 = match it.xpos.parse() { Ok(v) => v, Err(_) => continue };
                if lat == 0.0 || lon == 0.0 { continue; }
                // 중복 제거: 동일 좌표 Juso 결과가 이미 있으면 스킵
                let dup = results.iter().any(|r| {
                    (r.latitude - lat).abs() < 1e-6 && (r.longitude - lon).abs() < 1e-6
                });
                if dup { continue; }
                results.push(VWorldSearchResult {
                    address: it.address,
                    building_name: it.title,
                    zip_code: String::new(),
                    latitude: lat,
                    longitude: lon,
                    result_type: "place".to_string(),
                });
            }
        }
    }

    // limit 적용
    results.truncate(limit);
    Ok(results)
}

// ─── 건물 상세정보 (po_buildMetaInfoGIS.do) ───

const BUILDING_INFO_URL: &str = "https://map.vworld.kr/dtkmap/po_buildMetaInfoGIS.do";

#[derive(Debug, Clone, Serialize, Default)]
pub struct VWorldBuildingInfo {
    /// 건물명칭
    pub name: String,
    /// 건물동명칭
    pub dong_name: String,
    /// 도로명주소
    pub road_addr: String,
    /// 지번주소
    pub jibun_addr: String,
    /// 건물용도
    pub usage: String,
    /// 구조
    pub structure: String,
    /// 지상층수
    pub floors_above: String,
    /// 지하층수
    pub floors_below: String,
    /// 건물높이 (m)
    pub height: String,
    /// 건물면적 (m²)
    pub area: String,
    /// 연면적 (m²)
    pub total_area: String,
    /// 대지면적 (m²)
    pub site_area: String,
    /// 용적률 (%)
    pub floor_area_ratio: String,
    /// 건폐율 (%)
    pub building_coverage: String,
    /// 사용승인일자
    pub approval_date: String,
}

/// WGS84 → EPSG:3857 (Web Mercator) 변환
fn wgs84_to_epsg3857(lat: f64, lon: f64) -> (f64, f64) {
    let x = lon * 20037508.34 / 180.0;
    let y = ((90.0 + lat) * std::f64::consts::PI / 360.0).tan().ln() * 20037508.34
        / std::f64::consts::PI;
    (x, y)
}

/// HTML 테이블에서 <th>text</th><td>value</td> 쌍 추출
fn extract_th_td_pairs(html: &str) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    let mut pos = 0;
    while let Some(th_start) = html[pos..].find("<th") {
        let th_start = pos + th_start;
        // <th ...> 닫는 > 찾기
        let Some(th_open_end) = html[th_start..].find('>') else { break };
        let th_content_start = th_start + th_open_end + 1;
        let Some(th_end) = html[th_content_start..].find("</th>") else { break };
        let th_text = html[th_content_start..th_content_start + th_end].trim().to_string();

        // 바로 뒤 <td> 찾기
        let after_th = th_content_start + th_end + 5;
        if let Some(td_start) = html[after_th..].find("<td") {
            let td_start = after_th + td_start;
            if let Some(td_open_end) = html[td_start..].find('>') {
                let td_content_start = td_start + td_open_end + 1;
                if let Some(td_end) = html[td_content_start..].find("</td>") {
                    let td_text = html[td_content_start..td_content_start + td_end]
                        .trim()
                        .to_string();
                    // HTML 태그 제거
                    let clean = strip_html_tags(&td_text);
                    pairs.push((th_text, clean));
                    pos = td_content_start + td_end + 5;
                    continue;
                }
            }
        }
        pos = after_th;
    }
    pairs
}

fn strip_html_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        if ch == '<' {
            in_tag = true;
        } else if ch == '>' {
            in_tag = false;
        } else if !in_tag {
            out.push(ch);
        }
    }
    out.trim().to_string()
}

/// 좌표(WGS84)로 건물 상세정보 조회
pub async fn fetch_building_info(lat: f64, lon: f64) -> Result<Option<VWorldBuildingInfo>, String> {
    let client = build_client()?;
    let (x, y) = wgs84_to_epsg3857(lat, lon);

    let url = format!(
        "{}?SRSNAME=EPSG:900913&BLDGPOS=POINT({}%20{})&MAPMODE=2D",
        BUILDING_INFO_URL, x, y,
    );

    let resp = client
        .get(&url)
        .header("Referer", REFERER)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        )
        .send()
        .await
        .map_err(|e| format!("건물정보 요청 실패: {e}"))?;

    let html = resp
        .text()
        .await
        .map_err(|e| format!("건물정보 응답 읽기 실패: {e}"))?;

    // 건물 데이터가 없는 경우
    if html.contains("데이터가 없습니다") || html.contains("정보가 없습니다") || html.len() < 100 {
        return Ok(None);
    }

    let pairs = extract_th_td_pairs(&html);
    if pairs.is_empty() {
        return Ok(None);
    }

    let mut info = VWorldBuildingInfo::default();
    for (key, val) in &pairs {
        let v = val.trim().to_string();
        if v.is_empty() || v == "-" {
            continue;
        }
        match key.as_str() {
            "건물명칭" => info.name = v,
            "건물동명칭" => info.dong_name = v,
            "도로명" | "도로명주소" => info.road_addr = v,
            "지번" | "지번주소" => info.jibun_addr = v,
            "건물용도" => info.usage = v,
            "구조" => info.structure = v,
            "지상층수" => info.floors_above = v,
            "지하층수" => info.floors_below = v,
            "건물높이" => info.height = v,
            "건물면적" => info.area = v,
            "연면적" => info.total_area = v,
            "대지면적" => info.site_area = v,
            "용적률" => info.floor_area_ratio = v,
            "건폐율" => info.building_coverage = v,
            "사용승인일자" => info.approval_date = v,
            _ => {}
        }
    }

    Ok(Some(info))
}
