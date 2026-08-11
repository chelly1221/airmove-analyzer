//! 융합 SRTM 지형 DEM 타일 (terrarium 인코딩 PNG) — `fused-dem` 커스텀 프로토콜 본체
//!
//! MapLibre 3D 지형면·힐셰이드가 쓰던 외부 terrarium DEM(s3 elevation-tiles-prod)은 Rust 를
//! 거치지 않아 실측 3D 임포트의 지반고 융합 보정이 영원히 반영되지 않는다. 그 결과 융합
//! SRTM 절대 AMSL 로 그려지는 deck 기하(BRA 프리즘·LoS 커튼)와 시각 지면이 보정량만큼 어긋난다.
//!
//! 여기서 같은 terrarium 규격의 타일을 `SrtmReader`(융합 경유 유일 경로)로 직접 합성해
//! 지형면·힐셰이드가 분석 수치와 같은 지형을 쓰게 한다. 보정 갱신은 리더 캐시 클리어로
//! 자동 반영되고, 프론트는 캐시버스터(`?v=`)로 웹뷰 타일 캐시를 비운다.
//!
//! - 타일 규격: 256×256 RGB8 PNG, `elev = (R*256 + G + B/256) − 32768`
//! - 줌 제한: `MIN_ZOOM`~`MAX_ZOOM`. 저줌 타일 1장은 위경도 수십 도를 덮어 HGT 타일(1장 25MB)을
//!   수십 개 로드하게 되므로 저줌은 아예 평탄(0m) 타일로 응답한다(소스 minzoom 과 이중 방어).
//! - 최대 줌 13 은 HGT 1초각(≈30m) 한계 — 그 이상은 MapLibre 오버줌이 확대해 쓴다.

use crate::srtm::SrtmReader;

/// 타일 한 변 픽셀 수 (terrarium 규격)
pub const TILE_PX: usize = 256;
/// 서빙 최소 줌 — 미만은 평탄 타일 (저줌 1타일이 HGT 타일 수십 개를 물어오는 것을 차단)
pub const MIN_ZOOM: u32 = 8;
/// 서빙 최대 줌 — HGT 1초각 해상도 한계. 초과 줌은 MapLibre 오버줌 처리
pub const MAX_ZOOM: u32 = 13;

/// 서빙 도메인 (한반도 인근) `[min_lat, max_lat, min_lon, max_lon]` — 밖은 해수면(0m)
const DOMAIN: [f64; 4] = [32.0, 44.0, 122.0, 134.0];

/// `/{z}/{x}/{y}.png` 경로 파싱 (쿼리스트링은 호출자가 제거). 형식이 다르면 None.
pub fn parse_tile_path(path: &str) -> Option<(u32, u32, u32)> {
    let rel = path.trim_start_matches('/');
    let rel = rel.strip_suffix(".png").unwrap_or(rel);
    let mut it = rel.split('/');
    let z: u32 = it.next()?.parse().ok()?;
    let x: u32 = it.next()?.parse().ok()?;
    let y: u32 = it.next()?.parse().ok()?;
    if it.next().is_some() || z > 24 {
        return None;
    }
    let n = 1u64 << z;
    if x as u64 >= n || y as u64 >= n {
        return None;
    }
    Some((z, x, y))
}

/// 웹메르카토르 타일 X 픽셀 좌표 → 경도(deg)
#[inline]
fn tile_px_to_lon(z: u32, x: u32, px: f64) -> f64 {
    let n = (1u64 << z) as f64;
    ((x as f64 + px) / n) * 360.0 - 180.0
}

/// 웹메르카토르 타일 Y 픽셀 좌표 → 위도(deg)
#[inline]
fn tile_py_to_lat(z: u32, y: u32, py: f64) -> f64 {
    let n = (1u64 << z) as f64;
    let t = std::f64::consts::PI * (1.0 - 2.0 * (y as f64 + py) / n);
    t.sinh().atan().to_degrees()
}

/// 표고(m) → terrarium RGB
#[inline]
fn encode_terrarium(elev: f64) -> [u8; 3] {
    // v = elev + 32768 (0..65536 범위로 클램프 — 8bit 3채널 표현 한계)
    let v = (elev + 32768.0).clamp(0.0, 65535.999);
    let iv = v as u32;
    let frac = v - iv as f64;
    [(iv >> 8) as u8, (iv & 0xff) as u8, (frac * 256.0) as u8]
}

/// 타일 1장 렌더 → terrarium PNG 바이트.
/// 줌/도메인 밖은 평탄(0m) 타일. SRTM 조회는 `SrtmReader` 경유이므로 융합 보정이 자동 반영된다.
pub fn render_tile(srtm: &mut SrtmReader, z: u32, x: u32, y: u32) -> Vec<u8> {
    let mut rgb = vec![0u8; TILE_PX * TILE_PX * 3];

    // 타일 경계 (픽셀 0 ~ TILE_PX)
    let lon_w = tile_px_to_lon(z, x, 0.0);
    let lon_e = tile_px_to_lon(z, x, 1.0);
    let lat_n = tile_py_to_lat(z, y, 0.0);
    let lat_s = tile_py_to_lat(z, y, 1.0);

    let out_of_domain = lat_n < DOMAIN[0] || lat_s > DOMAIN[1] || lon_e < DOMAIN[2] || lon_w > DOMAIN[3];
    if z < MIN_ZOOM || out_of_domain {
        // 평탄 타일 (0m) — 저줌/도메인 밖은 SRTM 을 건드리지 않는다
        let flat = encode_terrarium(0.0);
        for px in rgb.chunks_exact_mut(3) {
            px.copy_from_slice(&flat);
        }
        return png_rgb(TILE_PX as u32, TILE_PX as u32, &rgb);
    }

    // 행별 조회 전에 이 타일이 걸치는 HGT 타일을 1회 프리로드 (이후는 캐시 히트 O(1))
    srtm.preload_tiles(
        lat_s.max(DOMAIN[0]).floor() as i32,
        lat_n.min(DOMAIN[1]).floor() as i32,
        lon_w.max(DOMAIN[2]).floor() as i32,
        lon_e.min(DOMAIN[3]).floor() as i32,
    );

    for j in 0..TILE_PX {
        // 픽셀 중심 샘플 (terrarium 관례)
        let lat = tile_py_to_lat(z, y, (j as f64 + 0.5) / TILE_PX as f64);
        let in_lat = lat >= DOMAIN[0] && lat <= DOMAIN[1];
        for i in 0..TILE_PX {
            let lon = tile_px_to_lon(z, x, (i as f64 + 0.5) / TILE_PX as f64);
            let elev = if in_lat && lon >= DOMAIN[2] && lon <= DOMAIN[3] {
                srtm.get_elevation(lat, lon).unwrap_or(0.0)
            } else {
                0.0
            };
            let o = (j * TILE_PX + i) * 3;
            rgb[o..o + 3].copy_from_slice(&encode_terrarium(elev));
        }
    }

    png_rgb(TILE_PX as u32, TILE_PX as u32, &rgb)
}

// ─── 최소 PNG 인코더 (RGB8, 필터 0) ─────────────────────────────
// 외부 이미지 크레이트 추가 없이 flate2(기존 의존성)만으로 규격 PNG 를 만든다.

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

/// PNG 청크 1개 기록 (길이 + 타입 + 데이터 + CRC32)
fn write_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut crc = flate2::Crc::new();
    crc.update(kind);
    crc.update(data);
    out.extend_from_slice(&crc.sum().to_be_bytes());
}

/// RGB8 픽셀 버퍼 → PNG 바이트
fn png_rgb(width: u32, height: u32, rgb: &[u8]) -> Vec<u8> {
    use std::io::Write;

    // 스캔라인마다 필터 바이트 0(None) 을 앞에 붙인 raw 스트림
    let stride = width as usize * 3;
    let mut raw = Vec::with_capacity((stride + 1) * height as usize);
    for row in rgb.chunks_exact(stride) {
        raw.push(0u8);
        raw.extend_from_slice(row);
    }

    // zlib 압축 (지형 타일은 인접 픽셀 상관이 높아 fast 압축으로도 충분)
    let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
    let idat = match enc.write_all(&raw).and_then(|_| enc.finish()) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[FusedDEM] PNG 압축 실패: {}", e);
            Vec::new()
        }
    };

    let mut out = Vec::with_capacity(idat.len() + 64);
    out.extend_from_slice(&PNG_SIGNATURE);

    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.push(8); // bit depth
    ihdr.push(2); // color type 2 = truecolor RGB
    ihdr.push(0); // compression: deflate
    ihdr.push(0); // filter: adaptive
    ihdr.push(0); // interlace: none
    write_chunk(&mut out, b"IHDR", &ihdr);
    write_chunk(&mut out, b"IDAT", &idat);
    write_chunk(&mut out, b"IEND", &[]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// terrarium 인코딩 ↔ MapLibre 디코딩식 왕복
    #[test]
    fn terrarium_roundtrip() {
        for &e in &[0.0f64, 1.0, 38.5, 123.25, 1947.75, -5.0] {
            let [r, g, b] = encode_terrarium(e);
            let dec = (r as f64) * 256.0 + g as f64 + (b as f64) / 256.0 - 32768.0;
            assert!((dec - e).abs() <= 0.01, "elev {} → {}", e, dec);
        }
    }

    /// PNG 구조: 시그니처·청크 순서·IDAT 압축 해제 길이
    #[test]
    fn png_structure() {
        let w = 4u32;
        let h = 3u32;
        let rgb = vec![7u8; (w * h * 3) as usize];
        let png = png_rgb(w, h, &rgb);
        assert_eq!(&png[..8], &PNG_SIGNATURE);
        // IHDR 청크: 길이 13 + "IHDR"
        assert_eq!(&png[8..12], &13u32.to_be_bytes());
        assert_eq!(&png[12..16], b"IHDR");
        // IDAT 추출 → zlib 해제 후 (필터바이트 1 + stride) × h 여야 한다
        let idat_pos = png
            .windows(4)
            .position(|w4| w4 == b"IDAT")
            .expect("IDAT 청크 없음");
        let len = u32::from_be_bytes([
            png[idat_pos - 4],
            png[idat_pos - 3],
            png[idat_pos - 2],
            png[idat_pos - 1],
        ]) as usize;
        let body = &png[idat_pos + 4..idat_pos + 4 + len];
        let mut dec = flate2::read::ZlibDecoder::new(body);
        let mut raw = Vec::new();
        std::io::Read::read_to_end(&mut dec, &mut raw).expect("zlib 해제 실패");
        assert_eq!(raw.len(), (w as usize * 3 + 1) * h as usize);
        assert!(png.ends_with(&[b'I', b'E', b'N', b'D', 0xae, 0x42, 0x60, 0x82]));
    }

    /// 타일 경로 파싱 (정상/비정상)
    #[test]
    fn tile_path_parse() {
        assert_eq!(parse_tile_path("/12/3494/1602.png"), Some((12, 3494, 1602)));
        assert_eq!(parse_tile_path("12/3494/1602"), Some((12, 3494, 1602)));
        assert_eq!(parse_tile_path("/12/3494"), None);
        assert_eq!(parse_tile_path("/12/9999999/1.png"), None);
        assert_eq!(parse_tile_path("/a/b/c.png"), None);
    }

    /// 타일 픽셀 → 위경도 (z=0 전지구 경계)
    #[test]
    fn tile_bounds() {
        assert!((tile_px_to_lon(0, 0, 0.0) + 180.0).abs() < 1e-9);
        assert!((tile_px_to_lon(0, 0, 1.0) - 180.0).abs() < 1e-9);
        assert!((tile_py_to_lat(0, 0, 0.0) - 85.0511).abs() < 1e-3);
        assert!((tile_py_to_lat(0, 0, 1.0) + 85.0511).abs() < 1e-3);
    }
}
