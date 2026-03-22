//! 공통 지리 유틸리티 (Haversine, Bearing, Destination Point)

/// 지구 평균 반경 (m)
pub const EARTH_RADIUS_M: f64 = 6_371_000.0;
/// 지구 평균 반경 (km)
pub const EARTH_RADIUS_KM: f64 = 6_371.0;

/// Haversine 거리 (km) — clamp 가드 포함
pub fn haversine_km(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let dlat = (lat2 - lat1).to_radians();
    let dlon = (lon2 - lon1).to_radians();
    let a = (dlat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (dlon / 2.0).sin().powi(2);
    EARTH_RADIUS_KM * 2.0 * a.clamp(0.0, 1.0).sqrt().asin()
}

/// Haversine 거리 (m)
pub fn haversine_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    haversine_km(lat1, lon1, lat2, lon2) * 1000.0
}

/// 두 지점 간 방위각 (0~360°, true north, clockwise)
pub fn bearing_deg(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let lat1 = lat1.to_radians();
    let lat2 = lat2.to_radians();
    let dlon = (lon2 - lon1).to_radians();
    let y = dlon.sin() * lat2.cos();
    let x = lat1.cos() * lat2.sin() - lat1.sin() * lat2.cos() * dlon.cos();
    (y.atan2(x).to_degrees() + 360.0) % 360.0
}

/// 시작점에서 방위/거리 이동한 좌표 (거리: m)
pub fn destination_point_m(lat: f64, lon: f64, bearing: f64, distance_m: f64) -> (f64, f64) {
    let lat1 = lat.to_radians();
    let lon1 = lon.to_radians();
    let brg = bearing.to_radians();
    let d_r = distance_m / EARTH_RADIUS_M;
    let lat2 = (lat1.sin() * d_r.cos() + lat1.cos() * d_r.sin() * brg.cos()).asin();
    let lon2 = lon1
        + (brg.sin() * d_r.sin() * lat1.cos()).atan2(d_r.cos() - lat1.sin() * lat2.sin());
    (lat2.to_degrees(), lon2.to_degrees())
}

/// 시작점에서 방위/거리 이동한 좌표 (거리: km)
pub fn destination_point_km(lat: f64, lon: f64, bearing: f64, distance_km: f64) -> (f64, f64) {
    destination_point_m(lat, lon, bearing, distance_km * 1000.0)
}
