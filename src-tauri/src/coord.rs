//! EPSG:5186 (Korea 2000 / Central Belt 2010) → WGS84 좌표 변환
//!
//! GRS80 타원체 기반 Transverse Mercator 역변환을 직접 구현.
//! GRS80과 WGS84는 사실상 동일 타원체 (서브밀리미터 차이)이므로 데이텀 변환 불필요.

use std::f64::consts::PI;

// GRS80 타원체 파라미터
const A: f64 = 6_378_137.0; // 장반경 (m)
const F: f64 = 1.0 / 298.257222101; // 편평률

// EPSG:5186 투영 파라미터
const LAM0: f64 = 127.0 * PI / 180.0; // 중앙자오선 (rad)
const PHI0: f64 = 38.0 * PI / 180.0; // 위도 원점 (rad)
const K0: f64 = 1.0; // 축척계수
const FE: f64 = 200_000.0; // 가산 동향 (m)
const FN: f64 = 600_000.0; // 가산 북향 (m)

/// EPSG:5186 (easting, northing) → WGS84 (latitude, longitude) 변환
/// 반환: (위도°, 경도°)
pub fn epsg5186_to_wgs84(easting: f64, northing: f64) -> (f64, f64) {
    let b = A * (1.0 - F);
    let e2 = 2.0 * F - F * F; // 제1이심률 제곱
    let e_prime2 = e2 / (1.0 - e2); // 제2이심률 제곱

    // 자오선 호장 계수
    let n = (A - b) / (A + b);
    let n2 = n * n;
    let n3 = n2 * n;
    let n4 = n3 * n;

    // 자오선 호장 (meridional arc) 역산: M → footprint latitude
    let a_hat = A / (1.0 + n) * (1.0 + n2 / 4.0 + n4 / 64.0);

    // 위도 원점(38°N)까지의 자오선 호장 M0
    let b1 = 3.0 / 2.0 * n - 27.0 / 32.0 * n3;
    let b2 = 15.0 / 16.0 * n2 - 55.0 / 32.0 * n4;
    let b3 = 35.0 / 48.0 * n3;
    let b4 = 315.0 / 512.0 * n4;
    let m0 = a_hat
        * (PHI0 - b1 * (2.0 * PHI0).sin() + b2 * (4.0 * PHI0).sin()
            - b3 * (6.0 * PHI0).sin() + b4 * (8.0 * PHI0).sin());

    let x = easting - FE;
    let m = (northing - FN) / K0 + m0;

    // 반복법으로 footprint latitude (mu) 계산
    let mu = m / a_hat;

    // Helmert 급수 역변환 계수
    let e1 = (1.0 - (1.0 - e2).sqrt()) / (1.0 + (1.0 - e2).sqrt());
    let e1_2 = e1 * e1;
    let e1_3 = e1_2 * e1;
    let e1_4 = e1_3 * e1;

    let j1 = 3.0 / 2.0 * e1 - 27.0 / 32.0 * e1_3;
    let j2 = 21.0 / 16.0 * e1_2 - 55.0 / 32.0 * e1_4;
    let j3 = 151.0 / 96.0 * e1_3;
    let j4 = 1097.0 / 512.0 * e1_4;

    let fp = mu + j1 * (2.0 * mu).sin()
        + j2 * (4.0 * mu).sin()
        + j3 * (6.0 * mu).sin()
        + j4 * (8.0 * mu).sin();

    let sin_fp = fp.sin();
    let cos_fp = fp.cos();
    let tan_fp = fp.tan();

    let c1 = e_prime2 * cos_fp * cos_fp;
    let t1 = tan_fp * tan_fp;
    let n1 = A / (1.0 - e2 * sin_fp * sin_fp).sqrt();
    let r1 = A * (1.0 - e2) / (1.0 - e2 * sin_fp * sin_fp).powf(1.5);
    let d = x / (n1 * K0);

    let d2 = d * d;
    let d3 = d2 * d;
    let d4 = d3 * d;
    let d5 = d4 * d;
    let d6 = d5 * d;

    let lat = fp
        - (n1 * tan_fp / r1)
            * (d2 / 2.0
                - (5.0 + 3.0 * t1 + 10.0 * c1 - 4.0 * c1 * c1 - 9.0 * e_prime2) * d4 / 24.0
                + (61.0 + 90.0 * t1 + 298.0 * c1 + 45.0 * t1 * t1 - 252.0 * e_prime2 - 3.0 * c1 * c1)
                    * d6
                    / 720.0);

    let lon = LAM0
        + (d - (1.0 + 2.0 * t1 + c1) * d3 / 6.0
            + (5.0 - 2.0 * c1 + 28.0 * t1 - 3.0 * c1 * c1 + 8.0 * e_prime2 + 24.0 * t1 * t1)
                * d5
                / 120.0)
            / cos_fp;

    (lat * 180.0 / PI, lon * 180.0 / PI)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_origin() {
        // EPSG:5186 원점 (FE=200000, FN=600000) → (38°N, 127°E)
        let (lat, lon) = epsg5186_to_wgs84(200_000.0, 600_000.0);
        assert!((lat - 38.0).abs() < 0.001, "lat={lat}");
        assert!((lon - 127.0).abs() < 0.001, "lon={lon}");
    }

    #[test]
    fn test_seoul_city_hall() {
        // 서울시청 근사 좌표 (EPSG:5186): (198000, 553000) → 약 (37.57°N, 126.98°E)
        let (lat, lon) = epsg5186_to_wgs84(198_000.0, 553_000.0);
        assert!((lat - 37.57).abs() < 0.02, "lat={lat}");
        assert!((lon - 126.98).abs() < 0.02, "lon={lon}");
    }

    #[test]
    fn test_building_shp_coord() {
        // GIS건물통합정보 SHP 실제 좌표: (201909, 553082) → 약 (37.577°N, 127.022°E)
        let (lat, lon) = epsg5186_to_wgs84(201_909.0, 553_082.0);
        assert!((lat - 37.577).abs() < 0.01, "lat={lat}");
        assert!((lon - 127.02).abs() < 0.01, "lon={lon}");
    }
}
