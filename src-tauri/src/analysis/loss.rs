use std::collections::HashMap;

use log::info;

use crate::models::{AnalysisResult, LossSegment, ParsedFile, TrackPoint};

/// Default loss detection threshold in seconds.
/// Typical radar rotation period is ~4-6 seconds for terminal radars,
/// so a gap significantly larger than that indicates a loss.
pub const DEFAULT_THRESHOLD_SECS: f64 = 12.0;

/// Minimum points per Mode-S to be considered for loss analysis.
const MIN_POINTS_FOR_ANALYSIS: usize = 5;

/// Detect loss segments within a single aircraft's track (sorted points).
fn detect_loss_for_track(
    mode_s: &str,
    points: &[&TrackPoint],
    threshold_secs: f64,
) -> Vec<LossSegment> {
    if points.len() < 2 {
        return Vec::new();
    }

    let mut segments = Vec::new();

    for window in points.windows(2) {
        let prev = window[0];
        let next = window[1];

        let gap = next.timestamp - prev.timestamp;

        if gap > threshold_secs {
            let distance_km = calculate_haversine_distance(
                prev.latitude,
                prev.longitude,
                next.latitude,
                next.longitude,
            );

            segments.push(LossSegment {
                mode_s: mode_s.to_string(),
                start_time: prev.timestamp,
                end_time: next.timestamp,
                start_lat: prev.latitude,
                start_lon: prev.longitude,
                end_lat: next.latitude,
                end_lon: next.longitude,
                duration_secs: gap,
                distance_km,
                last_altitude: prev.altitude,
            });
        }
    }

    segments
}

/// Calculate the great-circle distance between two points using the Haversine formula.
pub fn calculate_haversine_distance(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const EARTH_RADIUS_KM: f64 = 6371.0;

    let lat1_rad = lat1.to_radians();
    let lat2_rad = lat2.to_radians();
    let dlat = (lat2 - lat1).to_radians();
    let dlon = (lon2 - lon1).to_radians();

    let a = (dlat / 2.0).sin().powi(2)
        + lat1_rad.cos() * lat2_rad.cos() * (dlon / 2.0).sin().powi(2);
    let c = 2.0 * a.sqrt().asin();

    EARTH_RADIUS_KM * c
}

/// Perform full analysis: group by Mode-S, detect per-aircraft losses, downsample for display.
pub fn analyze_tracks(parsed: ParsedFile, threshold_secs: f64) -> AnalysisResult {
    // Group track points by Mode-S
    let mut groups: HashMap<&str, Vec<&TrackPoint>> = HashMap::new();
    for point in &parsed.track_points {
        groups
            .entry(&point.mode_s)
            .or_default()
            .push(point);
    }

    // Sort each group by timestamp and detect losses
    let mut all_loss_segments = Vec::new();
    let mut analyzed_count = 0usize;

    for (mode_s, mut points) in groups {
        if points.len() < MIN_POINTS_FOR_ANALYSIS {
            continue;
        }
        analyzed_count += 1;

        points.sort_by(|a, b| {
            a.timestamp
                .partial_cmp(&b.timestamp)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let segments = detect_loss_for_track(mode_s, &points, threshold_secs);
        all_loss_segments.extend(segments);
    }

    info!(
        "Analyzed {} Mode-S tracks, found {} loss segments",
        analyzed_count,
        all_loss_segments.len()
    );

    // Sort loss segments by time
    all_loss_segments.sort_by(|a, b| {
        a.start_time
            .partial_cmp(&b.start_time)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let total_loss_time: f64 = all_loss_segments.iter().map(|s| s.duration_secs).sum();

    let total_track_time = match (parsed.start_time, parsed.end_time) {
        (Some(start), Some(end)) => end - start,
        _ => 0.0,
    };

    let loss_percentage = if total_track_time > 0.0 {
        (total_loss_time / total_track_time) * 100.0
    } else {
        0.0
    };

    AnalysisResult {
        file_info: parsed,
        loss_segments: all_loss_segments,
        total_loss_time,
        total_track_time,
        loss_percentage,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_point(ts: f64, lat: f64, lon: f64, alt: f64) -> TrackPoint {
        TrackPoint {
            timestamp: ts,
            mode_s: "ABCDEF".to_string(),
            latitude: lat,
            longitude: lon,
            altitude: alt,
            speed: 200.0,
            heading: 90.0,
            raw_data: vec![],
        }
    }

    fn make_point_ms(ts: f64, lat: f64, lon: f64, alt: f64, mode_s: &str) -> TrackPoint {
        TrackPoint {
            timestamp: ts,
            mode_s: mode_s.to_string(),
            latitude: lat,
            longitude: lon,
            altitude: alt,
            speed: 200.0,
            heading: 90.0,
            raw_data: vec![],
        }
    }

    #[test]
    fn test_no_loss_with_continuous_track() {
        let points = vec![
            make_point(1000.0, 37.5, 126.8, 3000.0),
            make_point(1005.0, 37.51, 126.81, 3000.0),
            make_point(1010.0, 37.52, 126.82, 3000.0),
        ];
        let refs: Vec<&TrackPoint> = points.iter().collect();
        let segments = detect_loss_for_track("ABCDEF", &refs, 12.0);
        assert!(segments.is_empty());
    }

    #[test]
    fn test_detects_single_loss() {
        let points = vec![
            make_point(1000.0, 37.5, 126.8, 3000.0),
            make_point(1005.0, 37.51, 126.81, 3000.0),
            make_point(1020.0, 37.52, 126.82, 3000.0), // 15-second gap
        ];
        let refs: Vec<&TrackPoint> = points.iter().collect();
        let segments = detect_loss_for_track("ABCDEF", &refs, 12.0);
        assert_eq!(segments.len(), 1);
        assert!((segments[0].duration_secs - 15.0).abs() < 0.001);
        assert_eq!(segments[0].mode_s, "ABCDEF");
    }

    #[test]
    fn test_detects_multiple_losses() {
        let points = vec![
            make_point(1000.0, 37.5, 126.8, 3000.0),
            make_point(1020.0, 37.51, 126.81, 3000.0), // 20-second gap
            make_point(1025.0, 37.52, 126.82, 3000.0),
            make_point(1050.0, 37.53, 126.83, 3000.0), // 25-second gap
        ];
        let refs: Vec<&TrackPoint> = points.iter().collect();
        let segments = detect_loss_for_track("ABCDEF", &refs, 12.0);
        assert_eq!(segments.len(), 2);
    }

    #[test]
    fn test_empty_points() {
        let segments = detect_loss_for_track("ABCDEF", &[], 12.0);
        assert!(segments.is_empty());
    }

    #[test]
    fn test_single_point() {
        let points = vec![make_point(1000.0, 37.5, 126.8, 3000.0)];
        let refs: Vec<&TrackPoint> = points.iter().collect();
        let segments = detect_loss_for_track("ABCDEF", &refs, 12.0);
        assert!(segments.is_empty());
    }

    #[test]
    fn test_haversine_known_distance() {
        let dist = calculate_haversine_distance(37.5665, 126.9780, 35.1796, 129.0756);
        assert!(dist > 300.0 && dist < 350.0, "Distance was {}", dist);
    }

    #[test]
    fn test_haversine_zero_distance() {
        let dist = calculate_haversine_distance(37.5, 126.8, 37.5, 126.8);
        assert!(dist.abs() < 0.001);
    }

    #[test]
    fn test_analyze_tracks_per_modes() {
        // Two aircraft: ABCDEF has a loss, 123456 does not
        let parsed = ParsedFile {
            filename: "test.ass".to_string(),
            total_records: 10,
            track_points: vec![
                make_point_ms(1000.0, 37.5, 126.8, 3000.0, "ABCDEF"),
                make_point_ms(1005.0, 37.51, 126.81, 3000.0, "ABCDEF"),
                make_point_ms(1008.0, 37.52, 126.82, 3000.0, "ABCDEF"),
                make_point_ms(1011.0, 37.53, 126.83, 3000.0, "ABCDEF"),
                make_point_ms(1030.0, 37.54, 126.84, 3000.0, "ABCDEF"), // 19s gap
                // Different aircraft - no gap between ABCDEF and 123456 should be detected
                make_point_ms(1002.0, 36.0, 127.0, 5000.0, "123456"),
                make_point_ms(1007.0, 36.01, 127.01, 5000.0, "123456"),
                make_point_ms(1012.0, 36.02, 127.02, 5000.0, "123456"),
                make_point_ms(1017.0, 36.03, 127.03, 5000.0, "123456"),
                make_point_ms(1022.0, 36.04, 127.04, 5000.0, "123456"),
            ],
            parse_errors: vec![],
            start_time: Some(1000.0),
            end_time: Some(1030.0),
        };

        let result = analyze_tracks(parsed, 12.0);
        // Only ABCDEF should have 1 loss (19s gap); 123456 has 5s gaps = no loss
        assert_eq!(result.loss_segments.len(), 1);
        assert_eq!(result.loss_segments[0].mode_s, "ABCDEF");
    }

}
