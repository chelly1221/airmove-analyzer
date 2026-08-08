//! vworld 통합검색 스크래핑 기반 주소/장소 검색 + 건물 상세정보
//!
//! map.vworld.kr 지도의 통합검색 엔드포인트(unifiedSearch2.do)를 사용하여
//! 도로명주소 + 지번주소 + 장소/건물명 검색 + 좌표(WGS84) 반환. API 키 불필요.
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
    /// "juso" | "jibun" | "place"
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

    // Juso, Jibun, Place 카테고리 병렬 요청
    let juso_url = format!(
        "{}?q={}&output=json&qType=map&category=Juso&count={}",
        SEARCH_URL, encoded_q, limit,
    );
    let jibun_url = format!(
        "{}?q={}&output=json&qType=map&category=Jibun&count={}",
        SEARCH_URL, encoded_q, limit,
    );
    let place_url = format!(
        "{}?q={}&output=json&qType=map&category=Place&count={}",
        SEARCH_URL, encoded_q, limit,
    );

    let (juso_res, jibun_res, place_res) = tokio::join!(
        fetch_json(&client, &juso_url),
        fetch_json(&client, &jibun_url),
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

    // Jibun 결과 (Juso 와 동일 구조, BLD_NM/ZIP_CL 없음 → serde default)
    if let Ok(text) = jibun_res {
        if let Ok(api) = serde_json::from_str::<ApiResponse>(&text) {
            for it in api.list.unwrap_or_default() {
                let lat: f64 = match it.ypos.parse() { Ok(v) => v, Err(_) => continue };
                let lon: f64 = match it.xpos.parse() { Ok(v) => v, Err(_) => continue };
                if lat == 0.0 || lon == 0.0 { continue; }
                // 중복 제거: 동일 좌표 결과가 이미 있으면 스킵
                let dup = results.iter().any(|r| {
                    (r.latitude - lat).abs() < 1e-6 && (r.longitude - lon).abs() < 1e-6
                });
                if dup { continue; }
                results.push(VWorldSearchResult {
                    address: it.juso,
                    building_name: it.bld_nm,
                    zip_code: it.zip_cl,
                    latitude: lat,
                    longitude: lon,
                    result_type: "jibun".to_string(),
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

// 응답 HTML 의 탭 구획 마커
// - 건축물정보 탭: <div id="infoTab_2d_bd" ...>  (건물 적중/미적중 모두 존재)
// - POI 탭:        <div id="infoTab_2d_poi" ...> (모든 응답에 가짜 플레이스홀더 테이블 포함)
const BD_TAB_MARKER: &str = "<div id=\"infoTab_2d_bd\"";
const POI_TAB_MARKER: &str = "<div id=\"infoTab_2d_poi\"";
// 여러 건물이 조회된 경우 두 번째 건물 블록 (listCount > 1)
const SECOND_CONTENT_MARKER: &str = "id=\"content_2\"";

/// 응답 HTML 에서 건축물정보 탭 구간만 잘라낸다.
///
/// POI 탭에는 모든 응답에 동일한 더미 테이블(명칭=별말성당 / 지번=(우)12345 …)이 들어 있어
/// 전체 HTML 을 그대로 파싱하면 가짜 값이 유입된다. 또한 건물이 여러 건 조회되면
/// content_1, content_2 … 가 이어지므로 주소와 대장 정보의 건물 일치를 위해 첫 건물까지만 남긴다.
/// bd 마커가 없는 레거시 레이아웃은 전체 HTML 을 그대로 사용(기존 동작 유지).
fn extract_building_tab_slice(html: &str) -> &str {
    let mut slice = match html.find(BD_TAB_MARKER) {
        Some(start) => {
            let rest = &html[start..];
            match rest.find(POI_TAB_MARKER) {
                Some(end) => &rest[..end],
                None => rest,
            }
        }
        None => html,
    };
    if let Some(second) = slice.find(SECOND_CONTENT_MARKER) {
        slice = &slice[..second];
    }
    slice
}

/// 여는 태그 내부 문자열(예: ` class="adr old"`)에서 지정 속성의 값 추출
fn extract_attr<'a>(tag_open: &'a str, attr: &str) -> Option<&'a str> {
    let mut pos = 0;
    while let Some(idx) = tag_open[pos..].find(attr) {
        let start = pos + idx;
        // 속성명 앞은 공백이어야 함 (예: myclass= 오탐 방지)
        let prev_ok = start == 0 || tag_open[..start].ends_with(|c: char| c.is_whitespace());
        let rest = tag_open[start + attr.len()..].trim_start();
        if prev_ok && rest.starts_with('=') {
            let after_eq = rest[1..].trim_start();
            let quote = after_eq.chars().next()?;
            if quote == '"' || quote == '\'' {
                let val = &after_eq[1..];
                let end = val.find(quote)?;
                return Some(&val[..end]);
            }
            // 따옴표 없는 속성값
            let end = after_eq
                .find(|c: char| c.is_whitespace())
                .unwrap_or(after_eq.len());
            return Some(&after_eq[..end]);
        }
        pos = start + attr.len();
    }
    None
}

/// 건축물정보 탭 슬라이스에서 주소 블록 추출 → (도로명주소, 지번주소)
///
/// 실제 응답은 `<p class="adr">한글 도로명</p>`, `<p class="adr old">한글 지번</p>` 에 이어
/// 같은 class 로 영문 주소 2줄이 오는 4줄 블록이다. 한글이 항상 먼저 나오므로
/// class 별 첫 항목만 채택한다. (th 라벨 "도로명" 은 응답에 존재하지 않음)
fn extract_adr_addresses(slice: &str) -> (String, String) {
    let mut road = String::new();
    let mut jibun = String::new();
    let mut pos = 0;

    while let Some(idx) = slice[pos..].find("<p") {
        let tag_start = pos + idx;
        let after_name = tag_start + 2;
        // `<p` 다음 문자가 공백/`>`/`/` 가 아니면 <pre> 등 다른 태그
        let is_p_tag = slice[after_name..]
            .chars()
            .next()
            .map(|c| c.is_whitespace() || c == '>' || c == '/')
            .unwrap_or(false);
        let Some(gt) = slice[after_name..].find('>') else { break };
        let tag_end = after_name + gt;
        pos = tag_end + 1;
        if !is_p_tag {
            continue;
        }

        // class 속성값을 토큰 단위로 정확히 비교 (adr → 도로명, adr old → 지번)
        let Some(class_val) = extract_attr(&slice[after_name..tag_end], "class") else { continue };
        let tokens: Vec<&str> = class_val.split_whitespace().collect();
        let is_road = tokens.len() == 1 && tokens[0] == "adr";
        let is_jibun = tokens.len() == 2 && tokens.contains(&"adr") && tokens.contains(&"old");
        if !is_road && !is_jibun {
            continue;
        }
        // 각 class 의 첫 항목(한글)만 채택 — 뒤따르는 영문 주소는 무시
        if (is_road && !road.is_empty()) || (is_jibun && !jibun.is_empty()) {
            continue;
        }

        let Some(close) = slice[pos..].find("</p>") else { break };
        let text = strip_html_tags(&slice[pos..pos + close]);
        let text = text.trim();
        if text.is_empty() || text == "-" {
            continue;
        }
        if is_road {
            road = text.to_string();
        } else {
            jibun = text.to_string();
        }
        if !road.is_empty() && !jibun.is_empty() {
            break;
        }
    }

    (road, jibun)
}

/// po_buildMetaInfoGIS.do 응답 HTML → 건물 상세정보 (순수 함수, 네트워크 없음)
fn parse_building_info(html: &str) -> Option<VWorldBuildingInfo> {
    // 응답 자체가 비정상적으로 짧으면 파싱 불가
    if html.len() < 100 {
        return None;
    }

    // 건축물정보 탭만 사용 — POI 더미 테이블 차단
    let slice = extract_building_tab_slice(html);

    // 건물 데이터가 없는 경우.
    // 주의: POI 더미 블록에 "POI 정보가 없습니다." 문구가 모든 응답에 항상 들어 있으므로
    // 이 검사는 반드시 슬라이스(건축물정보 탭)에 대해서만 수행한다.
    if slice.contains("데이터가 없습니다") || slice.contains("정보가 없습니다") {
        return None;
    }

    let pairs = extract_th_td_pairs(slice);
    let (adr_road, adr_jibun) = extract_adr_addresses(slice);

    // 대장 테이블도 주소 블록도 없으면 미적중 (더미만 있는 응답에서 가짜 정보 생성 방지)
    if pairs.is_empty() && adr_road.is_empty() && adr_jibun.is_empty() {
        return None;
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
            // 레거시 폴백 (현재 응답에는 없는 라벨)
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

    // adr 블록 주소가 우선 — th/td 레거시 값이 있어도 덮어쓴다
    if !adr_road.is_empty() {
        info.road_addr = adr_road;
    }
    if !adr_jibun.is_empty() {
        info.jibun_addr = adr_jibun;
    }

    Some(info)
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

    Ok(parse_building_info(&html))
}

#[cfg(test)]
mod tests {
    use super::*;

    // 실제 po_buildMetaInfoGIS.do 응답(강서구청 적중)의 구조를 축약한 fixture.
    // 탭 div 마커 · adr 4줄(한글 2 + 영문 2) · 대장 th/td · POI 더미 테이블을 보존.
    const FIXTURE_HIT: &str = r##"<script type="text/javascript">
var listCount = 1;
function infoTabChange(gubun){
	if(gubun=="bd"){
		$("#infoTab_2d_bd").removeClass("hide");
		$("#infoTab_2d_poi").addClass("hide");
	}else{
		$("#infoTab_2d_bd").addClass("hide");
		$("#infoTab_2d_poi").removeClass("hide");
	}
}
</script>
<nav class="tap">
	<ul id="2dInfoTab">
		<li class="on"><a href="javascript:infoTabChange('bd')" class="tapTit" title="선택된 탭">건축물정보</a></li>
		<li><a href="javascript:infoTabChange('poi')" class="tapTit" title="">POI정보</a></li>
	</ul>
</nav>
<!-- 빌딩 tab -->
<div id="infoTab_2d_bd" class="content tapCon view1">
	<div id="content_1">
		<div class="item" style='border: 0;box-shadow: none;'>
			<p class="adr">서울특별시 강서구 화곡로 302</p>
			<p class="adr old">서울특별시 강서구 화곡동 980-16</p>
			<p class="adr">302, Hwagok-ro, Gangseo-gu, Seoul, Republic of Korea</p>
			<p class="adr old">980-16, Hwagok-dong, Gangseo-gu, Seoul, Republic of Korea</p>
		</div>
		<div class="grid">
			<table>
				<caption>건축물정보</caption>
				<tbody>
					<tr><th>건물명칭</th><td colspan="3">강서구청</td></tr>
					<tr><th>건물동명칭</th><td> - </td><th>건물용도</th><td>업무시설</td></tr>
					<tr><th>구조</th><td colspan="3">철근콘크리트구조</td></tr>
					<tr><th>지상층수</th><td>10 층</td><th>지하층수</th><td>2 층</td></tr>
					<tr><th>건물면적</th><td>1234.00 ㎡</td><th>건물높이</th><td>45.60 m</td></tr>
					<tr><th>사용승인일자</th><td colspan="3">1986-09-02</td></tr>
					<input type="hidden" name="pnu" id="pnu" value="1150010300109800016" />
				</tbody>
			</table>
		</div>
	</div>
	<p class="infoTxt">건축물 대장 조회 시 일부 건축물은 <mark>여러건이 조회</mark>될 수 있습니다.</p>
</div>
<!-- poi tab -->
<div id="infoTab_2d_poi" class="content tapCon view2 hide">
	<div class="grid">
		<table class="nopoi2d">
			<tbody>
				<tr><th>명칭</th><td>별말성당</td></tr>
				<tr><th>주소</th><td>경기도 구리시 아천동 산 49-1임</td></tr>
				<tr><th>지번</th><td>(우)12345 경기도 구리시 아천동 산 49-1임</td></tr>
				<tr><th>전화번호</th><td>02-1234-5678</td></tr>
				<tr><th>홈페이지</th><td>www.abcdefg.co.kr</td></tr>
			</tbody>
		</table>
		<p class="infoTxt hide nopoi2dInfo">POI 정보가 없습니다.</p>
	</div>
</div>"##;

    // 미적중 응답: 건축물정보 탭이 안내 문구만 담고 있고 POI 더미 테이블만 존재
    const FIXTURE_MISS: &str = r##"<script type="text/javascript">
var listCount = 1;
function infoTabChange(gubun){
	if(gubun=="bd"){
		$("#infoTab_2d_bd").removeClass("hide");
		$("#infoTab_2d_poi").addClass("hide");
	}
}
</script>
<nav class="tap">
	<ul id="2dInfoTab">
		<li class="on"><a href="javascript:infoTabChange('bd')" class="tapTit" title="선택된 탭">건축물정보</a></li>
		<li><a href="javascript:infoTabChange('poi')" class="tapTit" title="">POI정보</a></li>
	</ul>
</nav>
<!-- 빌딩 tab -->
<div id="infoTab_2d_bd" class="content tapCon view1">
	<p id="nobdInfo" class="infoTxt">본 지역은 건축물 정보를 <mark>제공하지</mark> 않습니다.</p>
</div>
<!-- poi tab -->
<div id="infoTab_2d_poi" class="content tapCon view2 hide">
	<div class="grid">
		<table class="nopoi2d">
			<tbody>
				<tr><th>명칭</th><td>별말성당</td></tr>
				<tr><th>주소</th><td>경기도 구리시 아천동 산 49-1임</td></tr>
				<tr><th>지번</th><td>(우)12345 경기도 구리시 아천동 산 49-1임</td></tr>
				<tr><th>전화번호</th><td>02-1234-5678</td></tr>
			</tbody>
		</table>
		<p class="infoTxt hide nopoi2dInfo">POI 정보가 없습니다.</p>
	</div>
</div>"##;

    // 건물이 여러 건 조회된 응답: content_2 이후는 잘라내고 첫 건물만 사용해야 한다
    const FIXTURE_MULTI: &str = r##"<div id="infoTab_2d_bd" class="content tapCon view1">
	<div id="content_1">
		<div class="item">
			<p class="adr">서울특별시 강서구 화곡로 302</p>
			<p class="adr old">서울특별시 강서구 화곡동 980-16</p>
		</div>
		<div class="grid"><table><tbody>
			<tr><th>건물명칭</th><td colspan="3">제1동</td></tr>
		</tbody></table></div>
	</div>
	<div id="content_2">
		<div class="item">
			<p class="adr">서울특별시 강서구 화곡로 304</p>
			<p class="adr old">서울특별시 강서구 화곡동 980-99</p>
		</div>
		<div class="grid"><table><tbody>
			<tr><th>건물명칭</th><td colspan="3">제2동</td></tr>
		</tbody></table></div>
	</div>
</div>
<div id="infoTab_2d_poi" class="content tapCon view2 hide">
	<table class="nopoi2d"><tbody>
		<tr><th>지번</th><td>(우)12345 경기도 구리시 아천동 산 49-1임</td></tr>
	</tbody></table>
</div>"##;

    // 적중 응답: adr 블록 주소 + 대장 th/td 정상 추출, POI 더미 미유입
    #[test]
    fn parses_hit_response_addresses_and_table() {
        let info = parse_building_info(FIXTURE_HIT).expect("적중 응답은 Some 이어야 함");

        // adr 블록에서 한글 도로명/지번 주소 추출 (영문 주소는 무시)
        assert_eq!(info.road_addr, "서울특별시 강서구 화곡로 302");
        assert_eq!(info.jibun_addr, "서울특별시 강서구 화곡동 980-16");

        // POI 더미 테이블 값이 유입되지 않아야 함
        assert!(!info.jibun_addr.contains("(우)12345"));
        assert!(!info.jibun_addr.contains("구리시"));
        assert!(!info.name.contains("별말성당"));

        // 건축물대장 th/td 값 정상 추출
        assert_eq!(info.name, "강서구청");
        assert_eq!(info.usage, "업무시설");
        assert_eq!(info.structure, "철근콘크리트구조");
        assert_eq!(info.floors_above, "10 층");
        assert_eq!(info.floors_below, "2 층");
        assert_eq!(info.area, "1234.00 ㎡");
        assert_eq!(info.height, "45.60 m");
        assert_eq!(info.approval_date, "1986-09-02");
        // "-" 값은 무시
        assert_eq!(info.dong_name, "");
    }

    // 미적중 응답(POI 더미만 존재)은 None
    #[test]
    fn returns_none_for_miss_response() {
        assert!(parse_building_info(FIXTURE_MISS).is_none());
    }

    // 다건 조회 시 content_2 이후 절단 — 첫 번째 건물만 사용
    #[test]
    fn uses_only_first_building_when_multiple() {
        let info = parse_building_info(FIXTURE_MULTI).expect("적중 응답은 Some 이어야 함");
        assert_eq!(info.road_addr, "서울특별시 강서구 화곡로 302");
        assert_eq!(info.jibun_addr, "서울특별시 강서구 화곡동 980-16");
        assert_eq!(info.name, "제1동");
    }
}
