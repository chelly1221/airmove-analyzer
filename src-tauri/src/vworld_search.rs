//! vworld 통합검색 스크래핑 기반 주소/장소 검색
//!
//! map.vworld.kr 지도의 통합검색 엔드포인트(unifiedSearch2.do)를 사용하여
//! 도로명주소 + 장소/건물명 검색 + 좌표(WGS84) 반환. API 키 불필요.

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
