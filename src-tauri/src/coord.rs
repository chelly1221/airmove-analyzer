//! EPSG:5186 / EPSG:5179 → WGS84 좌표 변환
//!
//! GRS80 타원체 기반 Transverse Mercator 역변환을 직접 구현.
//! GRS80과 WGS84는 사실상 동일 타원체 (서브밀리미터 차이)이므로 데이텀 변환 불필요.

use std::f64::consts::PI;

// GRS80 타원체 파라미터
const A: f64 = 6_378_137.0; // 장반경 (m)
const F: f64 = 1.0 / 298.257222101; // 편평률

/// 범용 TM 역변환 (GRS80 타원체)
/// lam0: 중앙자오선 (rad), phi0: 위도 원점 (rad), k0: 축척계수, fe: 가산 동향, fn_: 가산 북향
fn tm_inverse_grs80(
    easting: f64,
    northing: f64,
    lam0: f64,
    phi0: f64,
    k0: f64,
    fe: f64,
    fn_: f64,
) -> (f64, f64) {
    let b = A * (1.0 - F);
    let e2 = 2.0 * F - F * F;
    let e_prime2 = e2 / (1.0 - e2);

    let n = (A - b) / (A + b);
    let n2 = n * n;
    let n3 = n2 * n;
    let n4 = n3 * n;

    let a_hat = A / (1.0 + n) * (1.0 + n2 / 4.0 + n4 / 64.0);

    let b1 = 3.0 / 2.0 * n - 27.0 / 32.0 * n3;
    let b2 = 15.0 / 16.0 * n2 - 55.0 / 32.0 * n4;
    let b3 = 35.0 / 48.0 * n3;
    let b4 = 315.0 / 512.0 * n4;
    let m0 = a_hat
        * (phi0 - b1 * (2.0 * phi0).sin() + b2 * (4.0 * phi0).sin()
            - b3 * (6.0 * phi0).sin() + b4 * (8.0 * phi0).sin());

    let x = easting - fe;
    let m = (northing - fn_) / k0 + m0;

    let mu = m / a_hat;

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
    let d = x / (n1 * k0);

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

    let lon = lam0
        + (d - (1.0 + 2.0 * t1 + c1) * d3 / 6.0
            + (5.0 - 2.0 * c1 + 28.0 * t1 - 3.0 * c1 * c1 + 8.0 * e_prime2 + 24.0 * t1 * t1)
                * d5
                / 120.0)
            / cos_fp;

    (lat * 180.0 / PI, lon * 180.0 / PI)
}

/// EPSG:5186 (Korea 2000 / Central Belt 2010) → WGS84 (latitude°, longitude°)
pub fn epsg5186_to_wgs84(easting: f64, northing: f64) -> (f64, f64) {
    const LAM0: f64 = 127.0 * PI / 180.0;
    const PHI0: f64 = 38.0 * PI / 180.0;
    const K0: f64 = 1.0;
    const FE: f64 = 200_000.0;
    const FN: f64 = 600_000.0;
    tm_inverse_grs80(easting, northing, LAM0, PHI0, K0, FE, FN)
}

/// EPSG:5179 (Korea 2000 / Unified Coordinate System) → WGS84 (latitude°, longitude°)
pub fn epsg5179_to_wgs84(easting: f64, northing: f64) -> (f64, f64) {
    const LAM0: f64 = 127.5 * PI / 180.0;
    const PHI0: f64 = 38.0 * PI / 180.0;
    const K0: f64 = 0.9996;
    const FE: f64 = 1_000_000.0;
    const FN: f64 = 2_000_000.0;
    tm_inverse_grs80(easting, northing, LAM0, PHI0, K0, FE, FN)
}

// ── ECEF → WGS84 변환 ──────────────────────────────────────

/// WGS84 타원체 파라미터
const WGS84_A: f64 = 6_378_137.0;
const WGS84_F: f64 = 1.0 / 298.257223563;

/// ECEF (Earth-Centered Earth-Fixed) 좌표를 WGS84 (lat°, lon°, height_m)로 변환
///
/// Bowring 반복법 사용 (3~4회 수렴, 서브밀리미터 정밀도)
pub fn ecef_to_wgs84(x: f64, y: f64, z: f64) -> (f64, f64, f64) {
    let e2 = 2.0 * WGS84_F - WGS84_F * WGS84_F;
    let lon = y.atan2(x);
    let p = (x * x + y * y).sqrt();

    // 초기 추정
    let mut lat = z.atan2(p * (1.0 - e2));
    for _ in 0..5 {
        let sin_lat = lat.sin();
        let n = WGS84_A / (1.0 - e2 * sin_lat * sin_lat).sqrt();
        lat = (z + e2 * n * sin_lat).atan2(p);
    }

    let sin_lat = lat.sin();
    let n = WGS84_A / (1.0 - e2 * sin_lat * sin_lat).sqrt();
    let cos_lat = lat.cos();
    let h = if cos_lat.abs() > 1e-10 {
        p / cos_lat - n
    } else {
        z.abs() / sin_lat.abs() - n * (1.0 - e2)
    };

    (lat * 180.0 / PI, lon * 180.0 / PI, h)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_5186_origin() {
        let (lat, lon) = epsg5186_to_wgs84(200_000.0, 600_000.0);
        assert!((lat - 38.0).abs() < 0.001, "lat={lat}");
        assert!((lon - 127.0).abs() < 0.001, "lon={lon}");
    }

    #[test]
    fn test_5186_seoul_city_hall() {
        let (lat, lon) = epsg5186_to_wgs84(198_000.0, 553_000.0);
        assert!((lat - 37.57).abs() < 0.02, "lat={lat}");
        assert!((lon - 126.98).abs() < 0.02, "lon={lon}");
    }

    #[test]
    fn test_5186_building_shp_coord() {
        let (lat, lon) = epsg5186_to_wgs84(201_909.0, 553_082.0);
        assert!((lat - 37.577).abs() < 0.01, "lat={lat}");
        assert!((lon - 127.02).abs() < 0.01, "lon={lon}");
    }

    #[test]
    fn test_5179_origin() {
        // EPSG:5179 원점 (FE=1000000, FN=2000000) → (38°N, 127.5°E)
        let (lat, lon) = epsg5179_to_wgs84(1_000_000.0, 2_000_000.0);
        assert!((lat - 38.0).abs() < 0.001, "lat={lat}");
        assert!((lon - 127.5).abs() < 0.001, "lon={lon}");
    }

    #[test]
    fn test_5179_seoul() {
        // 서울시청 EPSG:5179 근사좌표: (~953000, ~1952000) → 약 (37.57°N, 126.98°E)
        let (lat, lon) = epsg5179_to_wgs84(953_000.0, 1_952_000.0);
        assert!((lat - 37.57).abs() < 0.05, "lat={lat}");
        assert!((lon - 126.98).abs() < 0.05, "lon={lon}");
    }

    #[test]
    fn test_5179_peak_sample() {
        // 샘플 데이터: 송악산 (제주) x=887176.45, y=1468208.02
        // 제주도 남쪽이므로 약 lat 33.2~33.3, lon 126.2~126.4
        let (lat, lon) = epsg5179_to_wgs84(887_176.45, 1_468_208.02);
        assert!(lat > 33.0 && lat < 34.0, "lat={lat} (expect ~33.x for Jeju)");
        assert!(lon > 126.0 && lon < 127.0, "lon={lon} (expect ~126.x for Jeju)");
    }
}
