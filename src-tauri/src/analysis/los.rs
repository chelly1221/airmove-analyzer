use crate::models::{LineOfSightResult, RadarSite};

/// Earth's mean radius in meters.
const EARTH_RADIUS_M: f64 = 6_371_000.0;

/// Effective Earth radius factor for radio wave propagation.
/// The 4/3 model accounts for standard atmospheric refraction,
/// which bends radio waves slightly toward the Earth's surface,
/// effectively increasing the geometric horizon.
const EFFECTIVE_EARTH_FACTOR: f64 = 4.0 / 3.0;

/// Effective Earth radius in meters (4/3 model).
const EFFECTIVE_EARTH_RADIUS_M: f64 = EARTH_RADIUS_M * EFFECTIVE_EARTH_FACTOR;

/// Calculate line-of-sight parameters between a radar site and a target.
///
/// Uses the 4/3 effective Earth radius model for radio wave propagation,
/// which is the standard model for radar coverage calculations.
///
/// # Arguments
/// * `radar` - Radar site configuration
/// * `target_lat` - Target latitude in degrees (WGS84)
/// * `target_lon` - Target longitude in degrees (WGS84)
/// * `target_alt` - Target altitude in meters above sea level
///
/// # Returns
/// A `LineOfSightResult` containing visibility assessment and geometry.
pub fn calculate_line_of_sight(
    radar: &RadarSite,
    target_lat: f64,
    target_lon: f64,
    target_alt: f64,
) -> LineOfSightResult {
    // Total radar height = site altitude + antenna height
    let radar_height = radar.altitude + radar.antenna_height;

    // Ground distance from radar to target using Haversine
    let ground_distance_km = crate::analysis::loss::calculate_haversine_distance(
        radar.latitude,
        radar.longitude,
        target_lat,
        target_lon,
    );
    let ground_distance_m = ground_distance_km * 1000.0;

    // Maximum radar horizon distance using 4/3 Earth model:
    // d = sqrt(2 * R_eff * h)
    // where R_eff is the effective Earth radius and h is the height.
    let radar_horizon_m = (2.0 * EFFECTIVE_EARTH_RADIUS_M * radar_height).sqrt();
    let target_horizon_m = (2.0 * EFFECTIVE_EARTH_RADIUS_M * target_alt).sqrt();

    // Total maximum detection range is the sum of both horizons
    let max_detection_range_m = radar_horizon_m + target_horizon_m;
    let max_range_km = max_detection_range_m / 1000.0;

    // Slant range accounting for Earth curvature (law of cosines on spherical triangle)
    let central_angle = ground_distance_m / EARTH_RADIUS_M;
    let r_radar = EARTH_RADIUS_M + radar_height;
    let r_target = EARTH_RADIUS_M + target_alt;
    let slant_range_m = (r_radar.powi(2) + r_target.powi(2)
        - 2.0 * r_radar * r_target * central_angle.cos())
    .sqrt();
    let slant_range_km = slant_range_m / 1000.0;

    // Elevation angle from radar to target
    // Accounting for Earth curvature using the 4/3 model:
    // The target appears to be lowered by d^2 / (2 * R_eff)
    let earth_curvature_drop = ground_distance_m.powi(2) / (2.0 * EFFECTIVE_EARTH_RADIUS_M);
    let apparent_height_diff = (target_alt - radar_height) - earth_curvature_drop;
    let elevation_rad = if ground_distance_m > 0.0 {
        (apparent_height_diff / ground_distance_m).atan()
    } else {
        std::f64::consts::FRAC_PI_2 // directly overhead
    };
    let elevation_deg = elevation_rad.to_degrees();

    // Target is in sight if the ground distance is less than the maximum detection range
    let in_sight = ground_distance_m <= max_detection_range_m;

    LineOfSightResult {
        in_sight,
        slant_range_km,
        elevation_deg,
        max_range_km,
        target_altitude: target_alt,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::RadarSite;

    fn gimpo_radar() -> RadarSite {
        RadarSite {
            name: "Gimpo ASR".to_string(),
            latitude: 37.5585,
            longitude: 126.7906,
            altitude: 18.0,       // meters ASL
            antenna_height: 15.0, // meters
        }
    }

    #[test]
    fn test_nearby_high_altitude_in_sight() {
        let radar = gimpo_radar();
        // Aircraft at 10km altitude, 50km away - definitely in sight
        let result = calculate_line_of_sight(&radar, 37.9, 126.8, 10_000.0);
        assert!(result.in_sight);
        assert!(result.slant_range_km > 30.0);
        assert!(result.elevation_deg > 0.0);
    }

    #[test]
    fn test_far_low_altitude_out_of_sight() {
        let radar = gimpo_radar();
        // Aircraft at 100m altitude, 200km away - likely below horizon
        let result = calculate_line_of_sight(&radar, 39.4, 126.8, 100.0);
        // At 100m altitude and 200km away, the aircraft is beyond radio horizon
        assert!(!result.in_sight);
    }

    #[test]
    fn test_directly_overhead() {
        let radar = gimpo_radar();
        let result = calculate_line_of_sight(&radar, 37.5585, 126.7906, 5_000.0);
        assert!(result.in_sight);
        assert!(result.elevation_deg > 80.0); // Nearly vertical
    }

    #[test]
    fn test_max_range_increases_with_altitude() {
        let radar = gimpo_radar();
        let result_low = calculate_line_of_sight(&radar, 37.9, 126.8, 1_000.0);
        let result_high = calculate_line_of_sight(&radar, 37.9, 126.8, 10_000.0);
        assert!(result_high.max_range_km > result_low.max_range_km);
    }

    #[test]
    fn test_zero_altitude_limited_range() {
        let radar = gimpo_radar();
        // At ground level, detection range should be very limited
        let result = calculate_line_of_sight(&radar, 37.6, 126.85, 0.0);
        // Max range with target at 0m should be just the radar horizon
        assert!(result.max_range_km < 50.0);
    }
}
