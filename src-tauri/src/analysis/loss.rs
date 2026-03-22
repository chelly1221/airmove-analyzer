use std::collections::HashMap;

use log::info;

use crate::models::{AnalysisResult, LossSegment, ParsedFile, TrackPoint};
#[cfg(test)]
use crate::models::RadarDetectionType;

/// 기본 임계값 (초): 이 시간 이상 gap이면 Loss
pub const DEFAULT_THRESHOLD_SECS: f64 = 7.0;

/// Minimum points per Mode-S to be considered for loss analysis.
const MIN_POINTS_FOR_ANALYSIS: usize = 1;

/// 레이더 최대 탐지거리의 몇 % 이상이면 범위이탈로 판단
const OUT_OF_RANGE_THRESHOLD: f64 = 1.0;

/// 이 횟수 이상 연속 스캔 미탐지면 범위이탈로 간주
/// (레이더 범위 내에서 이렇게 오래 Loss가 지속되기 어려움)
const MAX_CONSECUTIVE_SIGNAL_LOSS_SCANS: f64 = 15.0;

/// 이 시간(초) 이상의 gap은 Loss가 아님 → 비행 분리 기준과 동일 (4시간)
const MAX_LOSS_DURATION_SECS: f64 = 14400.0; // 4시간 — TypeScript detectLoss와 일치

/// 보간 속도 vs 직전 속도 차이 비율이 이 값을 초과하면 범위이탈로 판정 (50% 차이)
const SPEED_DEVIATION_RATIO: f64 = 0.5;

/// Detect loss segments within a single aircraft's track (sorted points).
fn detect_loss_for_track(
    mode_s: &str,
    points: &[&TrackPoint],
    threshold_secs: f64,
    scan_interval_secs: f64,
    radar_lat: f64,
    radar_lon: f64,
    max_radar_range_km: f64,
) -> Vec<LossSegment> {
    if points.len() < 2 {
        return Vec::new();
    }

    let boundary_km = max_radar_range_km * OUT_OF_RANGE_THRESHOLD;
    let mut segments = Vec::new();

    for window in points.windows(2) {
        let prev = window[0];
        let next = window[1];

        let gap = next.timestamp - prev.timestamp;

        if gap > threshold_secs && gap <= MAX_LOSS_DURATION_SECS {
            let distance_km = calculate_haversine_distance(
                prev.latitude,
                prev.longitude,
                next.latitude,
                next.longitude,
            );

            let start_radar_dist = calculate_haversine_distance(
                radar_lat, radar_lon, prev.latitude, prev.longitude,
            );
            let end_radar_dist = calculate_haversine_distance(
                radar_lat, radar_lon, next.latitude, next.longitude,
            );

            // 놓친 스캔 횟수 추정
            let missed_scans = gap / scan_interval_secs;

            // 보간 속도 계산 (knots): gap 구간의 직선거리 / 시간
            let implied_speed_kts = (distance_km / gap) * 3600.0 / 1.852;
            let prev_speed = prev.speed; // knots
            let speed_deviation = if prev_speed > 10.0 {
                (implied_speed_kts - prev_speed).abs() / prev_speed
            } else {
                0.0
            };

            // 범위이탈 판단:
            // 1) 시작/끝점 모두 레이더 경계 근처 → 확실한 범위이탈
            // 2) 연속 미탐지 횟수가 매우 많고 한쪽이라도 경계 근처
            // 3) 보간 속도가 직전 속도와 크게 다르면 범위이탈 (직선 보간 무의미)
            // 4) 그 외 → signal_loss
            let loss_type = if start_radar_dist >= boundary_km && end_radar_dist >= boundary_km {
                "out_of_range"
            } else if missed_scans >= MAX_CONSECUTIVE_SIGNAL_LOSS_SCANS
                && (start_radar_dist >= boundary_km || end_radar_dist >= boundary_km)
            {
                "out_of_range"
            } else if speed_deviation > SPEED_DEVIATION_RATIO {
                "out_of_range"
            } else {
                "signal_loss"
            };

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
                start_altitude: prev.altitude,
                end_altitude: next.altitude,
                loss_type: loss_type.to_string(),
                start_radar_dist_km: start_radar_dist,
                end_radar_dist_km: end_radar_dist,
            });
        }
    }

    segments
}

/// Calculate the great-circle distance between two points using the Haversine formula.
pub fn calculate_haversine_distance(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    crate::geo::haversine_km(lat1, lon1, lat2, lon2)
}

/// 트랙의 중앙값 스캔 간격 추정
fn estimate_scan_interval(points: &[&TrackPoint]) -> Option<f64> {
    if points.len() < 5 {
        return None;
    }
    let mut gaps: Vec<f64> = points.windows(2)
        .map(|w| w[1].timestamp - w[0].timestamp)
        .filter(|&g| g > 0.5 && g < 30.0) // 비정상적 gap 제외
        .collect();
    if gaps.len() < 3 {
        return None;
    }
    gaps.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    Some(gaps[gaps.len() / 2]) // median
}

/// Perform full analysis: group by Mode-S, detect per-aircraft losses, downsample for display.
pub fn analyze_tracks(parsed: ParsedFile, threshold_secs: f64) -> AnalysisResult {
    let radar_lat = parsed.radar_lat;
    let radar_lon = parsed.radar_lon;

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
    let mut total_aircraft_track_time: f64 = 0.0;
    let mut overall_max_range_km: f64 = 50.0;

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

        // 이 항공기의 실제 비행 시간
        if let (Some(first), Some(last)) = (points.first(), points.last()) {
            total_aircraft_track_time += last.timestamp - first.timestamp;
        }

        // 이 항공기의 레이더 최대 탐지거리 추정
        let aircraft_range_km = estimate_max_radar_range_refs(&points, radar_lat, radar_lon);
        if aircraft_range_km > overall_max_range_km {
            overall_max_range_km = aircraft_range_km;
        }

        // 스캔 간격 추정 (범위이탈 판단용)
        let estimated_interval = estimate_scan_interval(&points);
        let effective_threshold = threshold_secs;
        let scan_interval = estimated_interval.unwrap_or(5.0);

        let segments = detect_loss_for_track(
            mode_s, &points, effective_threshold, scan_interval,
            radar_lat, radar_lon, aircraft_range_km,
        );
        all_loss_segments.extend(segments);
    }

    info!("Estimated overall max radar range: {:.1} km", overall_max_range_km);

    let signal_loss_count = all_loss_segments.iter()
        .filter(|s| s.loss_type == "signal_loss").count();
    let out_of_range_count = all_loss_segments.iter()
        .filter(|s| s.loss_type == "out_of_range").count();

    info!(
        "Analyzed {} Mode-S tracks, found {} loss segments (signal_loss: {}, out_of_range: {})",
        analyzed_count,
        all_loss_segments.len(),
        signal_loss_count,
        out_of_range_count
    );

    // Sort loss segments by time
    all_loss_segments.sort_by(|a, b| {
        a.start_time
            .partial_cmp(&b.start_time)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Loss 시간 합산 (signal_loss만 — 범위이탈은 예상된 동작이므로 소실율에서 제외)
    let total_loss_time: f64 = all_loss_segments.iter()
        .filter(|s| s.loss_type == "signal_loss")
        .map(|s| s.duration_secs)
        .sum();

    let total_track_time = total_aircraft_track_time;

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
        max_radar_range_km: overall_max_range_km,
    }
}

/// 레이더 최대 탐지거리 추정 (전체 포인트의 95th percentile 거리)
#[allow(dead_code)]
fn estimate_max_radar_range(points: &[TrackPoint], radar_lat: f64, radar_lon: f64) -> f64 {
    if points.is_empty() {
        return 150.0; // 기본값 150km
    }

    let mut distances: Vec<f64> = points
        .iter()
        .map(|p| calculate_haversine_distance(radar_lat, radar_lon, p.latitude, p.longitude))
        .collect();
    distances.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    // 95th percentile
    let idx = (distances.len() as f64 * 0.95) as usize;
    let idx = idx.min(distances.len() - 1);
    distances[idx].max(50.0) // 최소 50km
}

/// 레이더 최대 탐지거리 추정 (참조 슬라이스용)
fn estimate_max_radar_range_refs(points: &[&TrackPoint], radar_lat: f64, radar_lon: f64) -> f64 {
    if points.is_empty() {
        return 150.0;
    }

    let mut distances: Vec<f64> = points
        .iter()
        .map(|p| calculate_haversine_distance(radar_lat, radar_lon, p.latitude, p.longitude))
        .collect();
    distances.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let idx = (distances.len() as f64 * 0.95) as usize;
    let idx = idx.min(distances.len() - 1);
    distances[idx].max(50.0)
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
            radar_type: RadarDetectionType::ModeSRollCallPsr,
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
            radar_type: RadarDetectionType::ModeSRollCallPsr,
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
        let segments = detect_loss_for_track("ABCDEF", &refs, 12.0, 5.0, 37.5585, 126.7906, 150.0);
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
        let segments = detect_loss_for_track("ABCDEF", &refs, 12.0, 5.0, 37.5585, 126.7906, 150.0);
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
        let segments = detect_loss_for_track("ABCDEF", &refs, 12.0, 5.0, 37.5585, 126.7906, 150.0);
        assert_eq!(segments.len(), 2);
    }

    #[test]
    fn test_empty_points() {
        let segments = detect_loss_for_track("ABCDEF", &[], 12.0, 5.0, 37.5585, 126.7906, 150.0);
        assert!(segments.is_empty());
    }

    #[test]
    fn test_single_point() {
        let points = vec![make_point(1000.0, 37.5, 126.8, 3000.0)];
        let refs: Vec<&TrackPoint> = points.iter().collect();
        let segments = detect_loss_for_track("ABCDEF", &refs, 12.0, 5.0, 37.5585, 126.7906, 150.0);
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
            radar_lat: 37.5585,
            radar_lon: 126.7906,
            parse_stats: None,
        };

        let result = analyze_tracks(parsed, 12.0);
        // Only ABCDEF should have 1 loss (19s gap); 123456 has 5s gaps = no loss
        assert_eq!(result.loss_segments.len(), 1);
        assert_eq!(result.loss_segments[0].mode_s, "ABCDEF");
    }

}
