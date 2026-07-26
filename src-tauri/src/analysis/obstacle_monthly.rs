//! 특정 장애물 월간 분석 모듈
//!
//! 선택된 수동 건물의 방위 구간 내 항적만 필터링하여
//! 일별 PSR 탐지율 및 Loss율을 집계한다.

use std::collections::HashMap;

use log::info;
use serde::{Deserialize, Serialize};

use crate::analysis::loss::calculate_haversine_distance;
use crate::models::{RadarDetectionType, TrackPoint};
use crate::parser;

/// 일별 track_points_geo 최대 수집 건수 — LoS 단면도 시각화에 충분한 양
const MAX_TRACK_POINTS_GEO_PER_DAY: usize = 5_000;

// ─── 입력 타입 ───

/// 방위 구간 (레이더 기준, 건물 노출면의 시작~끝 방위)
#[derive(Deserialize, Clone, Debug)]
pub struct AzSector {
    pub start_deg: f64,
    pub end_deg: f64,
}

impl AzSector {
    /// 주어진 방위(0~360)가 이 구간에 포함되는지 확인.
    /// start > end인 경우 (예: 350°~10°) 북쪽 wrap-around 처리.
    pub fn contains(&self, az: f64) -> bool {
        let az = ((az % 360.0) + 360.0) % 360.0; // normalize to [0, 360)
        if self.start_deg <= self.end_deg {
            az >= self.start_deg && az <= self.end_deg
        } else {
            // wrap-around: 350° ~ 10° → 350~360 || 0~10
            az >= self.start_deg || az <= self.end_deg
        }
    }
}

/// 레이더별 파일 묶음 + 해당 레이더 기준 방위 구간
#[derive(Deserialize, Debug)]
pub struct RadarFileSet {
    pub radar_name: String,
    pub radar_lat: f64,
    pub radar_lon: f64,
    pub radar_altitude: f64,
    pub antenna_height: f64,
    pub file_paths: Vec<String>,
    pub azimuth_sectors: Vec<AzSector>,
    /// 장애물 최소 거리(km) — 이보다 먼 항적만 분석 대상
    #[serde(default)]
    pub min_obstacle_distance_km: f64,
    /// LoS 단면도 표시용 건물 방위각(중심) 목록 — track_points_geo 사전필터 기준.
    /// 허용 반폭은 건물별 max(5°, 반각폭+1.5°) — building_az_half_extents_deg 참조.
    #[serde(default)]
    pub building_bearings_deg: Vec<f64>,
    /// 건물별 방위 반각폭(°) — building_bearings_deg 와 인덱스 정렬(병렬 배열).
    /// 프론트 calcBuildingAzExtent 노출면 양끝이 중심 방위에서 벗어난 최대 각도.
    /// track_points_geo 사전필터 허용 반폭 = max(5°, 반각폭 + 1.5°) 산출에 사용 —
    /// 각폭 넓은 건물(반각폭>4°)에서 프론트 차트 창(노출면±1°)의 가장자리 항적 누락 방지.
    /// 비어 있으면(구버전 페이로드) 반각폭 0 으로 간주 → 기존 ±5° 동작.
    #[serde(default)]
    pub building_az_half_extents_deg: Vec<f64>,
}

// ─── 출력 타입 ───

// ── 직렬화 정밀도 절사 ──
// 대용량 배열(loss_points_summary·track_points_geo·az_elev_histogram)의 f64 를
// 표시 정밀도로 절사해 결과 JSON 크기를 2~3배 축소 (17자리 → 6~9자리).
// lat/lon 1e-6°≈0.11m, 시간 1ms, 고도 0.1ft — 모든 소비처(차트·지도·합산)에 무영향 수준.
fn ser_deg6<S: serde::Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_f64((v * 1e6).round() / 1e6)
}
fn ser_s3<S: serde::Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_f64((v * 1e3).round() / 1e3)
}
fn ser_ft1<S: serde::Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_f64((v * 10.0).round() / 10.0)
}

/// Loss 발생 좌표 요약 (커버리지맵 오버레이용)
#[derive(Serialize, Clone, Debug)]
pub struct LossPointGeo {
    #[serde(serialize_with = "ser_deg6")]
    pub lat: f64,
    #[serde(serialize_with = "ser_deg6")]
    pub lon: f64,
    #[serde(serialize_with = "ser_ft1")]
    pub alt_ft: f64,
    /// 부모 gap(소실 이벤트) 전체 지속시간(초) — 이벤트 지속시간 표시용.
    /// 같은 gap 의 보간점 모두 동일 값이므로 점마다 합산하면 N×gap 과대 — 시간 합산엔 share_s 사용.
    #[serde(serialize_with = "ser_s3")]
    pub duration_s: f64,
    /// 소실 gap(이벤트) 고유 번호 — analyze_radar_monthly 1회 실행(레이더 결과) 내에서
    /// gap 마다 1씩 증가. 같은 gap 의 보간점들은 같은 event_id.
    /// '…건'(이벤트 건수) 표시는 distinct event_id 개수로 집계.
    pub event_id: u32,
    /// gap / total_missed — 보간점 균등 분배 시간(초). 같은 gap 의 share_s 합 = gap.
    /// 히스토그램 loss_per_pt 와 동일 값. 소실시간 합산은 Σ share_s.
    #[serde(serialize_with = "ser_s3")]
    pub share_s: f64,
}

/// 항적 포인트 좌표 (LoS 단면도 오버레이용)
#[derive(Serialize, Clone, Debug)]
pub struct TrackPointGeo {
    #[serde(serialize_with = "ser_deg6")]
    pub lat: f64,
    #[serde(serialize_with = "ser_deg6")]
    pub lon: f64,
    #[serde(serialize_with = "ser_ft1")]
    pub alt_ft: f64,
    pub radar_type: String,
}

/// 추가 차단영역 소실율 산출용 (방위×양각) 시간 히스토그램 셀.
/// 건물-무관 원자료 — 프론트가 건물별 angleWith/angleWithout 컷오프로
/// 추가 차단영역 밴드 셀을 합산해 소실율을 산출한다.
/// 양각은 ITU 4/3 유효지구 곡률(k=4/3) 기준 — 프론트 pointElevAngleDeg·panorama 실루엣과 동일 프레임.
/// Deserialize — 기준월 재집계 캐시(OmRefWedge)에 담겨 디스크 캐시로 round-trip 되므로 필요.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AzElevCell {
    /// floor(normalize(az)/0.1), 0..3600
    pub az_bin: u16,
    /// floor((elev + 1.0)/0.05), 0..140
    pub elev_bin: u16,
    /// 정상 추적 노출시간 합 (초)
    #[serde(serialize_with = "ser_s3")]
    pub track_time_s: f64,
    /// 소실시간 합 (초)
    #[serde(serialize_with = "ser_s3")]
    pub loss_time_s: f64,
    /// 정상 추적 스캔 포인트 수 (gap ≤ threshold 인 연속 스캔 1건 = 1포인트)
    pub track_count: u32,
    /// 보간 소실 포인트 수 (소실 gap의 total_missed 보간점을 셀별로 집계)
    pub loss_count: u32,
}

/// 일별 통계
#[derive(Serialize, Clone, Debug)]
pub struct DailyStats {
    pub date: String,        // "2024-01-15"
    pub day_of_month: u8,
    pub ssr_combined_points: u32,  // SSR + combined (분모)
    pub psr_rate: f64,
    pub total_track_time_secs: f64,
    pub total_loss_time_secs: f64,
    pub loss_rate: f64,
    pub loss_points_summary: Vec<LossPointGeo>,
    /// 전체 방위(분석 구간 포함) 기준 Loss율 (%)
    #[serde(default)]
    pub baseline_loss_rate: f64,
    /// 전체 방위(분석 구간 포함) 기준 PSR율 (0~1)
    #[serde(default)]
    pub baseline_psr_rate: f64,
    /// 전방위 기준선 표본량 — 베이스라인 비율의 가중치(섹터 표본량과의 모집단 불일치 방지)
    #[serde(default)]
    pub baseline_track_time_secs: f64,
    #[serde(default)]
    pub baseline_ssr_points: u32,
    /// 필터링된 전체 항적 좌표 (LoS 단면도 오버레이용)
    #[serde(default)]
    pub track_points_geo: Vec<TrackPointGeo>,
    /// 추가 차단영역 분석용 방위×양각 시간 히스토그램 (건물-무관 원자료).
    /// 프론트가 건물별 컷오프로 추가 차단영역 셀을 합산해 노출 조건부 소실율을 산출.
    #[serde(default)]
    pub az_elev_histogram: Vec<AzElevCell>,
}

/// 전체표적 히트맵 그리드 (남한 전역 고정 bbox(HM_MIN/MAX_LAT/LON), 전방위, 전수 카운트, 월간 누적).
/// 표시 전용 — 보고서 통계 스코프(60NM)와 무관. 분석 방위/장애물 후방/거리 컷(60NM) 필터 이전에
/// 그리드 bbox 이내 모든 표적(radar_type 무관, 검사기 제외)을 250~300m 셀에 전수 누적한다
/// (60NM 밖 표적도 표시 창 안이면 포함). 희소(점유 셀만) 직렬화 — dense Vec 로 집계 후 count>0 셀만 전송.
/// 보고서 §1 전체 표적 히트맵(ReportOMTargetHeatmapMap)이 전 레이더를 한 장에 합쳐 붉은 램프로 표현.
#[derive(Serialize, Clone, Debug)]
pub struct TrackHeatmap {
    pub min_lat: f64,        // 그리드 남서 원점 (정밀 유지 — ser_deg6 절사 금지)
    pub min_lon: f64,
    pub cell_deg_lat: f64,   // 위도 방향 셀 크기 (deg)
    pub cell_deg_lon: f64,   // 경도 방향 셀 크기 (deg)
    pub nx: u32,             // 경도 방향 셀 수
    pub ny: u32,             // 위도 방향 셀 수
    pub cells: Vec<u32>,     // 점유 셀 인덱스 (idx = iy * nx + ix), 희소
    pub counts: Vec<u32>,    // cells 와 병렬
    pub max_count: u32,
}

/// 레이더별 월간 분석 결과
#[derive(Serialize, Clone, Debug)]
pub struct RadarMonthlyResult {
    pub radar_name: String,
    pub daily_stats: Vec<DailyStats>,
    pub avg_loss_altitude_ft: f64,
    pub total_files_parsed: usize,
    pub total_points_filtered: u32,
    pub failed_files: Vec<String>,
    /// 전체표적 히트맵 (남한 전역 bbox 전수 밀도, 표시 전용 — 통계 스코프 60NM 와 무관).
    /// Option — 구버전 캐시 역직렬화 호환.
    pub track_heatmap: Option<TrackHeatmap>,
    /// 기준월(참조 달) 재집계 결과 — analyze_obstacle_monthly 가 보관 ASS 를 분석월과 동일
    /// 쐐기 파이프라인으로 재집계해 채운다(같은 월 → Δ=0 불변식). 미등록/실패 시 None(noref).
    /// 별도 invoke 없이 레이더별 bulk 직렬화에 자연 포함(대용량 invoke 응답 금지 규칙 준수).
    #[serde(default)]
    pub reference: Option<OmRefWedge>,
}

/// 전체 결과
#[derive(Serialize, Clone, Debug)]
pub struct ObstacleMonthlyResult {
    pub radar_results: Vec<RadarMonthlyResult>,
}

/// 진행상황 이벤트
#[derive(Clone, Serialize)]
pub struct ObstacleMonthlyProgress {
    pub radar_name: String,
    pub stage: String,    // "parsing" | "analyzing"
    pub current: usize,
    pub total: usize,
    pub message: String,
}

// ─── 경량 포인트 (메모리 최적화) ───

struct LightPoint {
    timestamp: f64,
    mode_s: String,
    latitude: f64,
    longitude: f64,
    altitude: f64,
    speed: f64,
    radar_type: RadarDetectionType,
}

impl LightPoint {
    fn from_track_point(tp: &TrackPoint) -> Self {
        Self {
            timestamp: tp.timestamp,
            mode_s: tp.mode_s.clone(),
            latitude: tp.latitude,
            longitude: tp.longitude,
            altitude: tp.altitude,
            speed: tp.speed,
            radar_type: tp.radar_type.clone(),
        }
    }
}

// ─── 베이스라인 일 단위 플러시 (메모리 최적화) ───
// 기존 알고리즘을 그대로 유지하면서, 파싱 중 완료된 날짜의 베이스라인을
// 즉시 처리+해제하여 메모리를 최대 2~3일치로 제한한다.
// (기존: 전체 누적 → 51M × 80B ≈ 4GB OOM → 개선: ~300MB)

/// 일별 베이스라인 처리 결과 (경량)
struct BaselineDayResult {
    psr_rate: f64,
    loss_rate: f64,
    /// 전방위 기준선 표본량 (프론트 베이스라인 가중 평균의 가중치)
    track_time_secs: f64,
    ssr_points: u32,
}

/// 기존 알고리즘 그대로: 하루치 베이스라인 포인트를 mode_s별 그룹핑하여
/// PSR율/Loss율/Loss좌표를 계산한다.
fn process_baseline_day(
    bl_points: &[LightPoint],
    radar_lat: f64,
    radar_lon: f64,
) -> BaselineDayResult {
    if bl_points.is_empty() {
        return BaselineDayResult { psr_rate: 0.0, loss_rate: 0.0, track_time_secs: 0.0, ssr_points: 0 };
    }

    // PSR 베이스라인
    let bl_ssr = bl_points.iter().filter(|p| {
        let dist = calculate_haversine_distance(radar_lat, radar_lon, p.latitude, p.longitude);
        dist <= PSR_RANGE_KM && is_ssr_combined(&p.radar_type)
    }).count() as u32;
    let bl_psr = bl_points.iter().filter(|p| {
        let dist = calculate_haversine_distance(radar_lat, radar_lon, p.latitude, p.longitude);
        dist <= PSR_RANGE_KM && is_psr_combined(&p.radar_type)
    }).count() as u32;
    let psr_rate = if bl_ssr > 0 { bl_psr as f64 / bl_ssr as f64 } else { 0.0 };

    // Loss 베이스라인: mode_s별 그룹핑 → 기존 알고리즘
    let mut bl_ms_groups: HashMap<&str, Vec<&LightPoint>> = HashMap::new();
    for p in bl_points {
        bl_ms_groups.entry(&p.mode_s).or_default().push(p);
    }
    let mut bl_track_time = 0.0f64;
    let mut bl_loss_time = 0.0f64;

    for (_ms, mut all_pts) in bl_ms_groups {
        if all_pts.len() < 2 { continue; }
        all_pts.sort_by(|a, b| a.timestamp.partial_cmp(&b.timestamp).unwrap_or(std::cmp::Ordering::Equal));
        let pts = &all_pts;
        if pts.len() < 2 { continue; }
        bl_track_time += pts.last().unwrap().timestamp - pts.first().unwrap().timestamp;
        let mut bl_gaps: Vec<f64> = pts.windows(2)
            .map(|w| w[1].timestamp - w[0].timestamp)
            .filter(|&g| g > 0.5 && g < 30.0)
            .collect();
        if bl_gaps.len() < 3 { continue; }
        bl_gaps.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let bl_scan = bl_gaps[bl_gaps.len() / 2];
        let mut bl_dists: Vec<f64> = pts.iter()
            .map(|p| calculate_haversine_distance(radar_lat, radar_lon, p.latitude, p.longitude))
            .collect();
        bl_dists.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let bl_range_idx = ((bl_dists.len() as f64 * 0.95) as usize).min(bl_dists.len() - 1);
        let bl_max_range = bl_dists[bl_range_idx].max(50.0);
        let bl_threshold = OM_LOSS_THRESHOLD_SECS; // 7초 고정 — TrackMap·main 경로와 동일
        let bl_boundary = bl_max_range * 1.0;
        for window in pts.windows(2) {
            let prev = window[0];
            let next = window[1];
            let gap = next.timestamp - prev.timestamp;
            if gap > bl_threshold && gap <= MAX_OM_LOSS_DURATION_SECS {
                let sd = calculate_haversine_distance(radar_lat, radar_lon, prev.latitude, prev.longitude);
                let ed = calculate_haversine_distance(radar_lat, radar_lon, next.latitude, next.longitude);
                let missed = gap / bl_scan;
                let dist = calculate_haversine_distance(prev.latitude, prev.longitude, next.latitude, next.longitude);
                let implied_speed = (dist / gap) * 3600.0 / 1.852;
                let speed_dev = if prev.speed > 10.0 { (implied_speed - prev.speed).abs() / prev.speed } else { 0.0 };
                let speed_change = if prev.speed > 10.0 && next.speed > 10.0 {
                    let avg_spd = (prev.speed + next.speed) / 2.0;
                    (next.speed - prev.speed).abs() / avg_spd
                } else { 0.0 };
                let is_oor = gap_straddles_analysis_cut(sd, ed, prev.speed, bl_scan)
                    || (sd >= bl_boundary && ed >= bl_boundary)
                    || (missed >= 15.0 && (sd >= bl_boundary || ed >= bl_boundary))
                    || speed_dev > 0.5
                    || speed_change > OM_SPEED_CHANGE_RATIO;
                if !is_oor {
                    bl_loss_time += gap;
                }
            }
        }
    }
    let loss_rate = if bl_track_time > 0.0 { (bl_loss_time / bl_track_time) * 100.0 } else { 0.0 };
    BaselineDayResult { psr_rate, loss_rate, track_time_secs: bl_track_time, ssr_points: bl_ssr }
}

/// track_points_geo 포함 여부: 건물 방위 중심 ± 허용 반폭 이내인지 확인.
/// 허용 반폭 = max(5°, 건물 방위 반각폭 + 1.5°) — 각폭 넓은 건물(반각폭>4°)에서
/// 프론트 차트 창(노출면±1°)이 사전필터를 넘어 가장자리 항적이 원천 누락되지 않도록 확장.
/// half_extents 는 bearings 와 병렬 배열 — 항목이 없으면 반각폭 0(기존 ±5° 동작).
fn in_any_building_bearing(az: f64, bearings: &[f64], half_extents: &[f64]) -> bool {
    bearings.iter().enumerate().any(|(i, &b)| {
        let half = half_extents.get(i).copied().unwrap_or(0.0);
        let allow = (half + 1.5).max(5.0);
        let mut diff = (az - b).abs();
        if diff > 180.0 { diff = 360.0 - diff; }
        diff <= allow
    })
}

fn radar_type_str(rt: &RadarDetectionType) -> &'static str {
    match rt {
        RadarDetectionType::ModeAC => "mode_ac",
        RadarDetectionType::ModeACPsr => "mode_ac_psr",
        RadarDetectionType::ModeSAllCall => "mode_s_allcall",
        RadarDetectionType::ModeSRollCall => "mode_s_rollcall",
        RadarDetectionType::ModeSAllCallPsr => "mode_s_allcall_psr",
        RadarDetectionType::ModeSRollCallPsr => "mode_s_rollcall_psr",
    }
}

// ─── OM 전용 상수 ───

/// OM 분석용 최대 Loss 지속시간 (초): 5분 초과 gap은 오탐 가능성 높아 제외
const MAX_OM_LOSS_DURATION_SECS: f64 = 300.0;

/// 1차 소실표적 판정 임계초 — TrackMap(loss.rs `DEFAULT_THRESHOLD_SECS`)·Worker(detectLossForTrack)와
/// 동일하게 7.0초 고정. (종전 scan_interval×1.4 동적값 → 고정값 통일. 동일 항적에서 OM·TrackMap 이
/// 채택하는 소실 gap 집합을 일치시켜 두 경로의 1차 판정을 동기화한다.)
const OM_LOSS_THRESHOLD_SECS: f64 = crate::analysis::loss::DEFAULT_THRESHOLD_SECS;

/// gap 전후 실제 보고 속도 변화율 임계값: 이 비율 초과 시 오탐(트랙 스왑 등)으로 제외
const OM_SPEED_CHANGE_RATIO: f64 = 0.5;

/// OM 분석 최대 거리(km): 60NM — 이보다 먼 항적/소실은 분석 대상에서 제외한다.
/// 손실율·PSR·추가차단 히스토그램·소실표적(loss_points_summary)·track_points_geo·베이스라인이
/// 전부 이 상한으로 컷된다(파일 파싱 직후 거리필터에서 sector/baseline 분기 이전에 공통 적용 →
/// 단일 지점에서 모든 통계가 60NM 스코프로 통일). LoS 단면도 차트(FULL_X_NM/MAX_X_NM=60)·
/// 파노라마(ReportApp MAX_RANGE_KM=60NM=111km)와 동일 스코프.
const OM_MAX_RANGE_KM: f64 = 60.0 * 1.852;

/// §1 결합 히트맵(전체 표적 히트맵) 그리드 = 남한 전역 고정 bbox (표시 전용, 통계 스코프 60NM 와 무관).
/// 프론트 §1 뷰(ReportOMTargetHeatmapMap.tsx: 북단 38.65°N 앵커·남단 33.05°N, 종횡비 맞춤 가로
/// ≈124.9~130.3°E)를 여유 포함 커버 — "보이는 창 안 표적은 전부 표시"(2026-07-22 사용자 결정).
/// 구 방식(레이더 중심 ±150NM)은 남한 전역 뷰 남부(호남·제주권)를 못 덮어 폐기. 국내 레이더 전제의
/// 절대 bbox — 레이더 위치와 무관.
const HM_MIN_LAT: f64 = 32.9;
const HM_MAX_LAT: f64 = 38.8;
const HM_MIN_LON: f64 = 124.3;
const HM_MAX_LON: f64 = 130.8;

/// PSR 통계 계산 범위 = OM 분석 범위(60NM). 단일 소스(OM_MAX_RANGE_KM)로 통일 —
/// 어차피 daily_points·baseline 이 60NM 로 이미 컷되므로 이 게이트는 명시적 재확인(중복이나 무해).
const PSR_RANGE_KM: f64 = OM_MAX_RANGE_KM;

/// gap 양끝 중 하나라도 인위적 분석 컷(OM_MAX_RANGE_KM=60NM)에서 1스캔 이동거리 이내면 true.
/// true → 그 gap 은 표적이 60NM 분석권 밖으로 이탈했다 재진입한 것으로 보아 out_of_range 로 처리(신호소실 오탐 방지).
/// 왜 필요한가: is_oor 의 boundary 는 '컷된' 항적 거리의 p95 라, 표적이 60NM 경계를 밀착 비행하면
///   (예: 비행검사기 60NM DME arc/orbit) boundary 가 재진입점보다 높아져 경계 straddling gap 을
///   signal_loss 로 오탐할 수 있다. 컷은 정확히 OM_MAX_RANGE_KM 에서 일어나므로, 끝점이 한 스캔 이동거리
///   이내로 컷에 붙은 gap 은 경계 이탈로 확정한다. 1스캔 이동거리 = 속도(kt)×스캔주기(s) (최소 0.5km 폴백).
/// 컷(60NM)보다 실제 도달거리가 짧은 레이더에서는 끝점이 60NM 근처에 오지 않아 항상 false → 무영향.
fn gap_straddles_analysis_cut(start_dist: f64, end_dist: f64, speed_kt: f64, scan_interval_s: f64) -> bool {
    let one_scan_km = (speed_kt.max(0.0) * scan_interval_s / 3600.0) * 1.852;
    let margin = one_scan_km.max(0.5); // 저속/무속도 폴백 하한 0.5km
    start_dist >= OM_MAX_RANGE_KM - margin || end_dist >= OM_MAX_RANGE_KM - margin
}

// ─── 추가 차단영역 히스토그램 상수 ───
// 방위×양각 시간 히스토그램의 빈 크기·범위. 프론트(omAddedBlockage.ts)와 반드시 일치.
const HIST_AZ_BIN_DEG: f64 = 0.1;
const HIST_ELEV_BIN_DEG: f64 = 0.05;
const HIST_ELEV_MIN_DEG: f64 = -1.0;
const HIST_ELEV_MAX_DEG: f64 = 6.0;

/// 4/3 유효지구반경 (m) — ITU-R 표준대기 굴절계수 k=4/3.
const R_EFF_M: f64 = crate::geo::EARTH_RADIUS_M * 4.0 / 3.0;

/// 레이더→표적 양각(°). ITU 4/3 유효지구 곡률(k=4/3) 보정.
/// 반드시 프론트 pointElevAngleDeg(obstacleAnalysisHelpers.ts)·panorama.rs 실루엣과 동일 프레임이어야
/// 추가 차단영역 슬라이스가 AzElev 차트 빨강영역과 정렬된다. (panorama.rs·프론트와 함께 4/3로 통일됨.)
fn elev_angle_deg(dist_km: f64, alt_m: f64, radar_h_m: f64) -> f64 {
    let d_m = dist_km * 1000.0;
    if d_m <= 0.0 {
        return 0.0;
    }
    let curv = (d_m * d_m) / (2.0 * R_EFF_M);
    ((alt_m - curv - radar_h_m) / d_m).atan().to_degrees()
}

/// (방위, 양각) → 히스토그램 셀 (az_bin, elev_bin). 양각 밴드 밖이면 None.
fn hist_cell(az: f64, elev: f64) -> Option<(u16, u16)> {
    if elev < HIST_ELEV_MIN_DEG || elev >= HIST_ELEV_MAX_DEG {
        return None;
    }
    let az_n = ((az % 360.0) + 360.0) % 360.0;
    let az_bin = (az_n / HIST_AZ_BIN_DEG).floor() as u16;
    let elev_bin = ((elev - HIST_ELEV_MIN_DEG) / HIST_ELEV_BIN_DEG).floor() as u16;
    Some((az_bin, elev_bin))
}

// ─── 핵심 로직 ───

/// 포인트가 방위 구간 내에 있는지 확인
fn in_any_sector(az: f64, sectors: &[AzSector]) -> bool {
    sectors.iter().any(|s| s.contains(az))
}

/// 타임스탬프 → 날짜 문자열 (KST = UTC+9)
/// ASS 파일의 타임스탬프는 Unix epoch 초(UTC). 분석월/파일명이 KST 기준이므로
/// 일별 집계도 KST 기준으로 수행한다.
fn timestamp_to_date(ts: f64) -> String {
    const KST_OFFSET: i64 = 9 * 3600; // UTC+9
    let secs = ts as i64 + KST_OFFSET;
    let days = if secs >= 0 { secs / 86400 } else { (secs - 86399) / 86400 };
    let (y, m, d) = days_to_ymd(days);
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// Unix epoch days → (year, month, day)
/// Howard Hinnant's civil_from_days algorithm (proven correct)
fn days_to_ymd(z: i64) -> (i32, u8, u8) {
    let z = z + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = (z - era * 146097) as u32; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u8, d as u8)
}


/// PSR 분류: SSR+combined 포인트인지
fn is_ssr_combined(rt: &RadarDetectionType) -> bool {
    // SSR 계열: SSR 단독 또는 SSR+PSR(combined)
    // Mode A/C = SSR, Mode S = SSR 계열
    // 모든 탐지 유형이 SSR 기반 → 분모에 포함
    // PSR 단독은 없음 (파서가 제거), 따라서 전체 포인트가 분모
    matches!(
        rt,
        RadarDetectionType::ModeAC
        | RadarDetectionType::ModeACPsr
        | RadarDetectionType::ModeSAllCall
        | RadarDetectionType::ModeSRollCall
        | RadarDetectionType::ModeSAllCallPsr
        | RadarDetectionType::ModeSRollCallPsr
    )
}

/// PSR 분류: PSR 포함 (combined) 포인트인지
fn is_psr_combined(rt: &RadarDetectionType) -> bool {
    rt.has_psr()
}

/// 일별 쐐기(방위 구간) 집계 공용 헬퍼 — 분석월(analyze_radar_monthly 일별 루프)과
/// 기준월(compute_reference_wedge)이 **문자 그대로 동일한 코드**로 mode_s 그룹핑 →
/// 스캔주기/최대범위(p95) 추정 → gap 탐지 → 히스토그램/시간 누적을 수행한다.
/// (복붙 이중화 금지 — 두 경로의 1차 판정을 구조적으로 일치시킨다.)
///
/// day_hist 는 호출부가 준비한 일별 누적기(packed key=(az_bin<<16)|elev_bin)에 in-place 누적.
/// 반환: (day_track_time, day_loss_time).
///
/// 분석월 전용 수집물은 Option 컬렉터로 분리 — 기준월 경로는 전부 None 을 넘긴다.
/// **컬렉터 유무는 track_time/loss_time/day_hist 수치에 영향을 주지 않는다**(부가 side-effect 만):
///   · loss_points     : 소실 gap 의 스캔별 보간점(LossPointGeo) push
///   · next_event_id   : 소실 이벤트 고유번호 카운터(1씩 증가, 같은 gap 보간점 공유)
///   · loss_alt_sum    : 소실 gap 평균고도(ft) 합 (avg_loss_altitude_ft 용)
///   · loss_alt_count  : 소실 gap 건수
fn accumulate_wedge_day(
    points: &[LightPoint],
    radar_lat: f64,
    radar_lon: f64,
    radar_h: f64,
    day_hist: &mut HashMap<u32, (f64, f64, u32, u32)>,
    mut loss_points: Option<&mut Vec<LossPointGeo>>,
    mut next_event_id: Option<&mut u32>,
    mut loss_alt_sum: Option<&mut f64>,
    mut loss_alt_count: Option<&mut u32>,
) -> (f64, f64) {
    // Loss 분석: mode_s별 그룹 → 기존 loss 알고리즘 재활용
    let mut mode_s_groups: HashMap<&str, Vec<&LightPoint>> = HashMap::new();
    for p in points {
        mode_s_groups.entry(&p.mode_s).or_default().push(p);
    }

    let mut day_track_time = 0.0f64;
    let mut day_loss_time = 0.0f64;

    for (_ms, mut all_pts) in mode_s_groups {
        if all_pts.len() < 2 {
            continue;
        }
        all_pts.sort_by(|a, b| a.timestamp.partial_cmp(&b.timestamp).unwrap_or(std::cmp::Ordering::Equal));

        let pts = &all_pts;
        if pts.len() < 2 {
            continue;
        }

        // 스캔 간격 추정 (median)
        let mut gaps: Vec<f64> = pts.windows(2)
            .map(|w| w[1].timestamp - w[0].timestamp)
            .filter(|&g| g > 0.5 && g < 30.0)
            .collect();
        if gaps.len() < 3 {
            // 유효 gap이 부족하면 Loss 계산 불가 — track_time도 누적하지 않음
            continue;
        }

        // 비행 시간 (gap 유효성 확인 후 누적) — 부재 구간 포함 전체 경과시간(첫~마지막 포인트)
        let track_time = pts.last().expect("pts has at least 2 elements").timestamp - pts.first().expect("pts has at least 2 elements").timestamp;
        day_track_time += track_time;
        gaps.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let scan_interval = gaps[gaps.len() / 2];

        // 최대 레이더 범위 추정 (95th percentile)
        let mut distances: Vec<f64> = pts.iter()
            .map(|p| calculate_haversine_distance(radar_lat, radar_lon, p.latitude, p.longitude))
            .collect();
        distances.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let range_idx = ((distances.len() as f64 * 0.95) as usize).min(distances.len() - 1);
        let max_range = distances[range_idx].max(50.0);

        let threshold = OM_LOSS_THRESHOLD_SECS; // 7초 고정 — TrackMap loss.rs/Worker 와 동일 (종전 scan_interval×1.4)
        let boundary = max_range * 1.0; // OUT_OF_RANGE_THRESHOLD

        // Gap 탐지
        for window in pts.windows(2) {
            let prev = window[0];
            let next = window[1];
            let gap = next.timestamp - prev.timestamp;

            // ── 추가 차단영역 히스토그램: 정상 추적 노출시간 (prev 셀) ──
            // threshold 이하의 연속 스캔만 '추적시간'으로 집계 (손실 gap과 disjoint).
            if gap > 0.5 && gap <= threshold {
                let pa = crate::geo::bearing_deg(radar_lat, radar_lon, prev.latitude, prev.longitude);
                let pd = calculate_haversine_distance(radar_lat, radar_lon, prev.latitude, prev.longitude);
                if let Some((ab, eb)) = hist_cell(pa, elev_angle_deg(pd, prev.altitude, radar_h)) {
                    let cell = day_hist.entry(((ab as u32) << 16) | eb as u32).or_insert((0.0, 0.0, 0, 0));
                    cell.0 += gap;      // 노출시간
                    cell.2 += 1;        // 정상 추적 스캔 포인트 1건
                }
            }

            if gap > threshold && gap <= MAX_OM_LOSS_DURATION_SECS {
                let start_dist = calculate_haversine_distance(
                    radar_lat, radar_lon, prev.latitude, prev.longitude,
                );
                let end_dist = calculate_haversine_distance(
                    radar_lat, radar_lon, next.latitude, next.longitude,
                );

                let missed = gap / scan_interval;
                let dist = calculate_haversine_distance(prev.latitude, prev.longitude, next.latitude, next.longitude);
                let implied_speed = (dist / gap) * 3600.0 / 1.852;
                let speed_dev = if prev.speed > 10.0 {
                    (implied_speed - prev.speed).abs() / prev.speed
                } else {
                    0.0
                };

                // gap 전후 실제 보고 속도 변화율 (트랙 스왑/그룹핑 오류 탐지)
                let speed_change = if prev.speed > 10.0 && next.speed > 10.0 {
                    let avg_spd = (prev.speed + next.speed) / 2.0;
                    (next.speed - prev.speed).abs() / avg_spd
                } else {
                    0.0
                };

                let is_oor = gap_straddles_analysis_cut(start_dist, end_dist, prev.speed, scan_interval)
                    || (start_dist >= boundary && end_dist >= boundary)
                    || (missed >= 15.0 && (start_dist >= boundary || end_dist >= boundary))
                    || speed_dev > 0.5
                    || speed_change > OM_SPEED_CHANGE_RATIO;

                if !is_oor {
                    // signal_loss
                    day_loss_time += gap;
                    // ── 분석월 전용: 소실 gap 평균고도(ft) 합·건수 ──
                    if let Some(sum) = loss_alt_sum.as_deref_mut() {
                        *sum += ((prev.altitude + next.altitude) / 2.0) * 3.28084;
                    }
                    if let Some(cnt) = loss_alt_count.as_deref_mut() {
                        *cnt += 1;
                    }
                    // 스캔별 보간 포인트 생성 (TrackMap Worker와 동일)
                    // 같은 gap 의 보간점들은 event_id 를 공유 — 이벤트 건수는 distinct event_id
                    // ── 분석월 전용: 이벤트 id (기준월은 None → 0, 소실 보간점 미수집이라 무의미) ──
                    let event_id = if let Some(nid) = next_event_id.as_deref_mut() {
                        *nid += 1;
                        *nid
                    } else {
                        0
                    };
                    let total_missed = ((gap / scan_interval).round() as u32).saturating_sub(1).max(1);
                    // 소실시간 분배 (보간점들에 균등 분배 → 합 = gap) — share_s·히스토그램 공용
                    let loss_per_pt = gap / total_missed as f64;
                    for si in 1..=total_missed {
                        let t = si as f64 / (total_missed as f64 + 1.0);
                        let ilat = prev.latitude + (next.latitude - prev.latitude) * t;
                        let ilon = prev.longitude + (next.longitude - prev.longitude) * t;
                        let ialt = prev.altitude + (next.altitude - prev.altitude) * t; // meters
                        // ── 분석월 전용: 소실 보간점 수집 ──
                        if let Some(lp) = loss_points.as_deref_mut() {
                            lp.push(LossPointGeo {
                                lat: ilat,
                                lon: ilon,
                                alt_ft: ialt * 3.28084,
                                duration_s: gap,        // 이벤트 전체 시간 (표시용 — 합산 금지)
                                event_id,
                                share_s: loss_per_pt,   // 균등 분배 시간 — Σ share_s = gap
                            });
                        }
                        // ── 추가 차단영역 히스토그램: 소실시간 (보간점 셀) ──
                        let la = crate::geo::bearing_deg(radar_lat, radar_lon, ilat, ilon);
                        let ld = calculate_haversine_distance(radar_lat, radar_lon, ilat, ilon);
                        if let Some((ab, eb)) = hist_cell(la, elev_angle_deg(ld, ialt, radar_h)) {
                            let cell = day_hist.entry(((ab as u32) << 16) | eb as u32).or_insert((0.0, 0.0, 0, 0));
                            cell.1 += loss_per_pt;  // 소실시간 (균등 분배)
                            cell.3 += 1;            // 보간 소실 포인트 1건
                        }
                    }
                }
            }
        }
    }

    (day_track_time, day_loss_time)
}

/// 일별 히스토그램 누적기(packed key=(az_bin<<16)|elev_bin) → **packed key 오름차순 정렬** 셀 Vec.
/// 분석월 일별 직렬화(analyze_radar_monthly)와 기준월 일별 변환(compute_reference_wedge) 양쪽이
/// 공유한다 — 직렬화 셀 순서를 결정화해, TS f64 합산 순서까지 두 경로를 완전 일치(비트 동일)시킨다.
/// 셀 소비처는 전부 순서 무관(TS accumulateBand·차트·지도) — 정렬은 순서만 바꿀 뿐 값·집합 불변.
fn hist_to_sorted_cells(hist: HashMap<u32, (f64, f64, u32, u32)>) -> Vec<AzElevCell> {
    let mut entries: Vec<(u32, (f64, f64, u32, u32))> = hist.into_iter().collect();
    entries.sort_by_key(|(k, _)| *k);
    entries
        .into_iter()
        .map(|(k, (tt, lt, tc, lc))| AzElevCell {
            az_bin: (k >> 16) as u16,
            elev_bin: (k & 0xFFFF) as u16,
            track_time_s: tt,
            loss_time_s: lt,
            track_count: tc,
            loss_count: lc,
        })
        .collect()
}

/// 단일 레이더의 월간 분석 실행
pub fn analyze_radar_monthly(
    radar: &RadarFileSet,
    exclude_mode_s: &[String],
    mag_dec_deg: f64,
    cancel: &std::sync::atomic::AtomicBool,
    progress_fn: &dyn Fn(ObstacleMonthlyProgress),
) -> Result<RadarMonthlyResult, String> {
    let total_files = radar.file_paths.len();
    info!(
        "[ObstacleMonthly] 레이더 '{}' 분석 시작: {} files, {} sectors",
        radar.radar_name,
        total_files,
        radar.azimuth_sectors.len()
    );

    // 1단계: 파일별 순차 파싱 → 필터링 → 일별 버킷 누적
    let mut daily_points: HashMap<String, Vec<LightPoint>> = HashMap::with_capacity(31);
    // 베이스라인: 일 단위 플러시 — 기존 알고리즘 유지, 완료 날짜 즉시 처리+해제
    // (기존: 전체 포인트 누적 → 51M × 80B ≈ 4GB OOM → 개선: 2~3일치 ≈ 300MB)
    let mut daily_baseline_points: HashMap<String, Vec<LightPoint>> = HashMap::with_capacity(31);
    let mut baseline_results: HashMap<String, BaselineDayResult> = HashMap::with_capacity(31);
    let mut latest_date_seen = String::new(); // 파싱 중 가장 최근 날짜 추적
    let mut total_filtered = 0u32;
    let mut failed_files: Vec<String> = Vec::new();
    let has_sectors = !radar.azimuth_sectors.is_empty();
    let has_building_bearings = !radar.building_bearings_deg.is_empty();

    // ── 전체표적 히트맵 그리드 준비 (남한 전역 고정 bbox, 250~300m 셀) ──
    // §1 결합 히트맵은 여러 레이더를 한 장에 합쳐 남한 전역 뷰로 표시하므로, 그리드도 레이더 위치와
    // 무관한 남한 전역 절대 bbox(HM_MIN/MAX_LAT/LON)로 고정한다(표시 전용). 방위/장애물 후방 필터·
    // 거리 컷(60NM) 이전에 그리드 bbox 이내 전 표적을 dense Vec 에 전수 누적한다.
    // cell_deg_lat≈0.0025(≈278m), cell_deg_lon = cell_deg_lat/cos(lat) 로 지상거리 정방형.
    let hm_cell_lat = 0.0025_f64;
    let hm_cos_lat = radar.radar_lat.to_radians().cos().abs().max(0.1);
    let hm_cell_lon = hm_cell_lat / hm_cos_lat;
    let hm_min_lat = HM_MIN_LAT;
    let hm_min_lon = HM_MIN_LON;
    let hm_ny = ((HM_MAX_LAT - HM_MIN_LAT) / hm_cell_lat).ceil() as u32;   // 위도 방향 셀 수 (=2360)
    let hm_nx = ((HM_MAX_LON - HM_MIN_LON) / hm_cell_lon).ceil() as u32;   // 경도 방향 셀 수 (김포권 ≈2061)
    // dense 누적 버퍼 (~2360×2100 u32 ≈ 5M 셀 ≈ 19~20MB) — 파일 순회 동안 일시 유지,
    // 종료 시 count>0 점유 셀만 희소 직렬화(cells/counts 병렬 배열, 기존과 동일 전송 형상).
    let mut heatmap_grid = vec![0u32; (hm_nx as usize) * (hm_ny as usize)];

    // 파일 정렬 (파일명 기준 시간순 보장 — 일 단위 플러시 정확도)
    let mut sorted_paths = radar.file_paths.clone();
    sorted_paths.sort();

    for (i, path) in sorted_paths.iter().enumerate() {
        // 취소 체크
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("분석이 취소되었습니다".to_string());
        }

        progress_fn(ObstacleMonthlyProgress {
            radar_name: radar.radar_name.clone(),
            stage: "parsing".to_string(),
            current: i + 1,
            total: total_files,
            message: format!(
                "{} 파싱 중... ({}/{})",
                path.split(['/', '\\']).last().unwrap_or(path),
                i + 1,
                total_files
            ),
        });

        // 파싱 (모든 항공기 포함 — 필터 없음)
        let parsed = match parser::ass::parse_ass_file(
            path,
            radar.radar_lat,
            radar.radar_lon,
            &[],   // 포함 Mode-S 없음
            &[],   // 제외 Mode-S 없음
            &[],   // 포함 Squawk 없음
            &[],   // 제외 Squawk 없음
            mag_dec_deg,
            |_| {},
        ) {
            Ok(p) => p,
            Err(e) => {
                info!("[ObstacleMonthly] 파일 파싱 실패: {} — {}", path, e);
                failed_files.push(path.clone());
                continue;
            }
        };

        let point_count = parsed.track_points.len();

        // 필터링: mode_s 제외 + 방위 구간 + 장애물 후방
        let mut inner_count = 0u32;
        for tp in &parsed.track_points {
            inner_count += 1;
            if inner_count % 10_000 == 0 && cancel.load(std::sync::atomic::Ordering::Relaxed) {
                return Err("분석이 취소되었습니다".to_string());
            }
            // 비행검사기 제외
            if exclude_mode_s.iter().any(|ex| ex.eq_ignore_ascii_case(&tp.mode_s)) {
                continue;
            }

            // ── 전체표적 히트맵 누적: 그리드 bbox(남한 전역) 이내 전수 카운트 ──
            // exclude_mode_s(검사기) 직후·거리 컷(60NM) 이전에 누적 → 60NM 밖 표적도 표시 창 안이면 포함
            // (§1 결합 히트맵 표시 전용, 통계 스코프와 무관). haversine 불필요 — 그리드 인덱스 bbox 검사만으로 충분.
            // 다운샘플링 없음(전수, CLAUDE.md 규칙 7).
            {
                let ix = ((tp.longitude - hm_min_lon) / hm_cell_lon).floor() as i64;
                let iy = ((tp.latitude - hm_min_lat) / hm_cell_lat).floor() as i64;
                if ix >= 0 && ix < hm_nx as i64 && iy >= 0 && iy < hm_ny as i64 {
                    let gidx = iy as usize * hm_nx as usize + ix as usize;
                    heatmap_grid[gidx] = heatmap_grid[gidx].saturating_add(1);
                }
            }

            // 거리 필터: 장애물 후방(min) ~ 분석 최대 범위(OM_MAX_RANGE_KM=60NM).
            // 분석 대상(sector)·전체 방위 베이스라인 양쪽에 공통 적용 — 아래 분기 이전에 두어
            // 손실율·PSR·히스토그램·소실표적·track_geo·베이스라인이 모두 동일 60NM 스코프로 컷된다.
            //   상한(60NM): 60NM 밖 항적/소실은 보고서 집계에서 전부 제외(분자·분모 동시 컷 → 율 정합 유지).
            //   경계(60NM) 재진입 gap(레이더권 이탈 후 복귀)은 gap_straddles_analysis_cut 로 out_of_range 확정 →
            //   signal_loss 오탐 없음(경계 밀착 arc 등 p95 boundary 가 헐거운 케이스까지 차단).
            {
                let dist = calculate_haversine_distance(
                    radar.radar_lat, radar.radar_lon, tp.latitude, tp.longitude,
                );
                if dist > OM_MAX_RANGE_KM {
                    continue;
                }
                if radar.min_obstacle_distance_km > 0.0 && dist < radar.min_obstacle_distance_km {
                    continue;
                }
            }

            // 방위 필터링
            let az = crate::geo::bearing_deg(radar.radar_lat, radar.radar_lon, tp.latitude, tp.longitude);
            let in_sector = in_any_sector(az, &radar.azimuth_sectors);
            let date = timestamp_to_date(tp.timestamp);

            // 분석 대상: 방위 구간 내 항적 (고도 상한 없음 — 전 고도 포함).
            if in_sector {
                daily_points
                    .entry(date.clone())
                    .or_default()
                    .push(LightPoint::from_track_point(tp));
                total_filtered += 1;
            }

            // 비교기준(베이스라인) = 전체 방위 (분석 구간 포함).
            // 나머지 방위만이 아니라 전 방위 항적을 기준선으로 삼는다.
            if has_sectors {
                if date > latest_date_seen {
                    latest_date_seen = date.clone();
                }
                daily_baseline_points
                    .entry(date)
                    .or_default()
                    .push(LightPoint::from_track_point(tp));
            }
        }

        info!(
            "[ObstacleMonthly] {} 파싱 완료: {} points → {} filtered (누적 {})",
            path.split(['/', '\\']).last().unwrap_or(path),
            point_count,
            total_filtered,
            daily_points.values().map(|v| v.len()).sum::<usize>()
        );

        // ── 베이스라인 일 단위 플러시: 최신 날짜보다 2일 이상 이전 데이터 즉시 처리+해제 ──
        // 자정 전후 포인트가 2개 파일에 걸칠 수 있으므로 2일 버퍼 유지
        if has_sectors && !latest_date_seen.is_empty() {
            let flush_dates: Vec<String> = daily_baseline_points.keys()
                .filter(|d| {
                    // latest_date_seen과 2일 이상 차이나는 날짜 플러시
                    if d.len() != 10 || latest_date_seen.len() != 10 { return false; }
                    // 간단한 문자열 비교: "YYYY-MM-DD" 형식이므로 사전순 비교 유효
                    // 2일 차이 판정: 날짜 차이 직접 계산 대신 보수적으로 월이 다르면 플러시
                    let d_prefix = &d[..7]; // "YYYY-MM"
                    let latest_prefix = &latest_date_seen[..7];
                    if d_prefix < latest_prefix {
                        return true; // 이전 달 → 플러시
                    }
                    if d_prefix == latest_prefix {
                        // 같은 달: day 비교
                        let d_day: i32 = d[8..10].parse().unwrap_or(0);
                        let latest_day: i32 = latest_date_seen[8..10].parse().unwrap_or(0);
                        return latest_day - d_day >= 2;
                    }
                    false
                })
                .cloned()
                .collect();

            for flush_date in flush_dates {
                if let Some(bl_points) = daily_baseline_points.remove(&flush_date) {
                    let result = process_baseline_day(&bl_points, radar.radar_lat, radar.radar_lon);
                    baseline_results.insert(flush_date, result);
                    // bl_points는 여기서 drop → 메모리 해제
                }
            }
        }

        // ParsedFile 메모리 즉시 해제 (drop)
    }

    // 잔여 베이스라인 일괄 처리 (마지막 2일치)
    for (date, bl_points) in daily_baseline_points.drain() {
        let result = process_baseline_day(&bl_points, radar.radar_lat, radar.radar_lon);
        baseline_results.insert(date, result);
    }

    // 2단계: 일별 집계
    let total_days = daily_points.len();
    let mut daily_stats: Vec<DailyStats> = Vec::with_capacity(total_days);
    let mut all_loss_alt_sum = 0.0f64;
    let mut all_loss_alt_count = 0u32;
    // 소실 gap(이벤트) 카운터 — 이 레이더 결과 내에서 gap 마다 1씩 증가, 보간점 event_id 로 공유
    let mut next_event_id = 0u32;

    // 안테나 해발고 (양각 계산용) — 추가 차단영역 히스토그램 전반에서 사용
    let radar_h = radar.radar_altitude + radar.antenna_height;

    let mut sorted_dates: Vec<String> = daily_points.keys().cloned().collect();
    sorted_dates.sort();

    // 날짜 범위 진단 로그
    if sorted_dates.is_empty() {
        info!("[ObstacleMonthly] 레이더 '{}': 필터링 후 데이터 없음 (총 파일 {}개)", radar.radar_name, total_files);
    } else {
        info!(
            "[ObstacleMonthly] 레이더 '{}': 날짜 범위 {} ~ {} ({} 일, {} 포인트)",
            radar.radar_name,
            sorted_dates.first().unwrap(),
            sorted_dates.last().unwrap(),
            total_days,
            daily_points.values().map(|v| v.len()).sum::<usize>()
        );
    }

    for (di, date) in sorted_dates.iter().enumerate() {
        // 취소 체크
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("분석이 취소되었습니다".to_string());
        }

        progress_fn(ObstacleMonthlyProgress {
            radar_name: radar.radar_name.clone(),
            stage: "analyzing".to_string(),
            current: di + 1,
            total: total_days,
            message: format!("{} 분석 중... ({}/{})", date, di + 1, total_days),
        });

        let points = daily_points.get(date).expect("date exists in daily_points keys");

        // 항적 포인트 좌표 수집 (LoS 단면도 오버레이용)
        // 건물 방위 중심 ± max(5°, 반각폭+1.5°) 이내만 필터링하여 IPC 전송량 대폭 감소
        // (기존: 전체 포인트 ~270만개 → 수만 개로 99% 감소)
        let day_track_geo: Vec<TrackPointGeo> = if has_building_bearings {
            points.iter().filter(|p| {
                let az = crate::geo::bearing_deg(radar.radar_lat, radar.radar_lon, p.latitude, p.longitude);
                in_any_building_bearing(az, &radar.building_bearings_deg, &radar.building_az_half_extents_deg)
            }).map(|p| TrackPointGeo {
                lat: p.latitude,
                lon: p.longitude,
                alt_ft: p.altitude * 3.28084,
                radar_type: radar_type_str(&p.radar_type).to_string(),
            }).collect()
        } else {
            Vec::new()
        };

        // track_points_geo 크기 제한 — 균등 샘플링으로 분포 보존
        let day_track_geo = if day_track_geo.len() > MAX_TRACK_POINTS_GEO_PER_DAY {
            let step = day_track_geo.len() as f64 / MAX_TRACK_POINTS_GEO_PER_DAY as f64;
            (0..MAX_TRACK_POINTS_GEO_PER_DAY)
                .map(|i| day_track_geo[(i as f64 * step) as usize].clone())
                .collect()
        } else {
            day_track_geo
        };

        // PSR 통계 (60NM 이내)
        let ssr_combined = points.iter().filter(|p| {
            let dist = calculate_haversine_distance(radar.radar_lat, radar.radar_lon, p.latitude, p.longitude);
            dist <= PSR_RANGE_KM && is_ssr_combined(&p.radar_type)
        }).count() as u32;
        let psr_combined = points.iter().filter(|p| {
            let dist = calculate_haversine_distance(radar.radar_lat, radar.radar_lon, p.latitude, p.longitude);
            dist <= PSR_RANGE_KM && is_psr_combined(&p.radar_type)
        }).count() as u32;
        let psr_rate = if ssr_combined > 0 {
            psr_combined as f64 / ssr_combined as f64
        } else {
            0.0
        };

        // Loss 분석 + 추가 차단영역 히스토그램: 공용 헬퍼(accumulate_wedge_day)로 위임 —
        // 기준월(compute_reference_wedge)과 동일 코드 경로. 분석월 전용 수집물(소실 보간점·
        // 이벤트 id·소실고도 합/건수)은 Some(&mut …) 컬렉터로 넘긴다(컬렉터 유무는 수치 무영향).
        let mut day_loss_points: Vec<LossPointGeo> = Vec::new();
        // 추가 차단영역 히스토그램 누적기: key=(az_bin<<16)|elev_bin, val=(track_time, loss_time, track_count, loss_count)
        let mut day_hist: HashMap<u32, (f64, f64, u32, u32)> = HashMap::new();
        let (day_track_time, day_loss_time) = accumulate_wedge_day(
            points,
            radar.radar_lat,
            radar.radar_lon,
            radar_h,
            &mut day_hist,
            Some(&mut day_loss_points),
            Some(&mut next_event_id),
            Some(&mut all_loss_alt_sum),
            Some(&mut all_loss_alt_count),
        );

        let loss_rate = if day_track_time > 0.0 {
            (day_loss_time / day_track_time) * 100.0
        } else {
            0.0
        };

        // ── 베이스라인 (전체 방위) 일별 통계 — 플러시 결과 사용 ──
        let (baseline_loss_rate, baseline_psr_rate, baseline_track_time_secs, baseline_ssr_points) = if has_sectors {
            if let Some(bl) = baseline_results.remove(date) {
                (bl.loss_rate, bl.psr_rate, bl.track_time_secs, bl.ssr_points)
            } else {
                (0.0, 0.0, 0.0, 0)
            }
        } else {
            (0.0, 0.0, 0.0, 0)
        };

        // 날짜에서 day_of_month 추출
        let dom: u8 = date[8..10].parse().unwrap_or(1);

        // 히스토그램 맵 → 직렬화용 Vec (packed key 오름차순 정렬 — 기준월 일별 변환과 동일 순서).
        let az_elev_histogram = hist_to_sorted_cells(day_hist);

        daily_stats.push(DailyStats {
            date: date.clone(),
            day_of_month: dom,
            ssr_combined_points: ssr_combined,
            psr_rate,
            total_track_time_secs: day_track_time,
            total_loss_time_secs: day_loss_time,
            loss_rate,
            loss_points_summary: day_loss_points,
            baseline_loss_rate,
            baseline_psr_rate,
            baseline_track_time_secs,
            baseline_ssr_points,
            track_points_geo: day_track_geo,
            az_elev_histogram,
        });
    }

    // 날짜순 정렬
    daily_stats.sort_by(|a, b| a.date.cmp(&b.date));

    let avg_loss_alt = if all_loss_alt_count > 0 {
        all_loss_alt_sum / all_loss_alt_count as f64
    } else {
        0.0 // 소실 0건 = '값 없음' — TS 소비부(omFindingsGenerator)가 >0 가드로 표시 생략
    };

    // ── 전체표적 히트맵 희소 직렬화 (점유 셀만) ──
    let mut hm_cells: Vec<u32> = Vec::new();
    let mut hm_counts: Vec<u32> = Vec::new();
    let mut hm_max = 0u32;
    for (i, &c) in heatmap_grid.iter().enumerate() {
        if c > 0 {
            hm_cells.push(i as u32);
            hm_counts.push(c);
            if c > hm_max { hm_max = c; }
        }
    }
    let track_heatmap = if hm_cells.is_empty() {
        None
    } else {
        Some(TrackHeatmap {
            min_lat: hm_min_lat,
            min_lon: hm_min_lon,
            cell_deg_lat: hm_cell_lat,
            cell_deg_lon: hm_cell_lon,
            nx: hm_nx,
            ny: hm_ny,
            cells: hm_cells,
            counts: hm_counts,
            max_count: hm_max,
        })
    };

    info!(
        "[ObstacleMonthly] 레이더 '{}' 분석 완료: {} days, {} filtered points, avg_loss_alt={:.0}ft, 히트맵 셀 {}개",
        radar.radar_name, daily_stats.len(), total_filtered, avg_loss_alt,
        track_heatmap.as_ref().map(|h| h.cells.len()).unwrap_or(0)
    );

    Ok(RadarMonthlyResult {
        radar_name: radar.radar_name.clone(),
        daily_stats,
        avg_loss_altitude_ft: avg_loss_alt,
        total_files_parsed: total_files,
        total_points_filtered: total_filtered,
        failed_files,
        track_heatmap,
        // 기준월 재집계는 호출부(analyze_obstacle_monthly)가 채운다 — 여기선 None 초기화.
        reference: None,
    })
}

// ════════════════════════════════════════════════════════════════════════════
// 기준데이터(참조 달) — 등록 = 원본 ASS 사본 보관 + 메타만 / 재집계 = 보고서 생성 시
// ════════════════════════════════════════════════════════════════════════════
//
// 재설계(구 전방위 사전집계 폐지): 기준데이터 등록(register_om_reference)은 원본 ASS 를
// 복사 보관하고 메타만 남긴다. 심각성 판정용 az×elev 히스토그램은 **보고서 생성 시**
// (analyze_obstacle_monthly) 분석월과 **완전히 동일한 쐐기 파이프라인**(동일 sector·최소거리·
// 검사기 제외·현재 좌표/안테나고)으로 기준월 ASS 를 재집계해 산출한다(compute_reference_wedge).
// 같은 월 입력 → accumulate_wedge_day 공용 코드로 비트 동일 히스토그램 → Δ=0 이 구조적으로 보장된다.
// 재집계 결과는 설정 해시 키로 디스크 캐시한다. 좌표·안테나고 정합성 게이트는 항상 현재 설정으로
// 재계산하므로 폐지됨(구 checkRefCoherence).
//
// 이 파일이 소유하는 것: 직렬화 구조체(메타·레지스트리·재집계 결과) + 재집계 로직 + 캐시 키.
// 등록/캐시 IO·registry 저장은 호출부(lib.rs)가 담당한다.

// ─── 기준데이터 직렬화 구조체 (프론트 계약 고정 — snake_case JSON) ───

/// 기준데이터 메타 (레지스트리·목록에 공통). Serialize+Deserialize —
/// 레지스트리(settings JSON)에서 역직렬화되고 list 커맨드로 직렬화 반환된다.
/// 재설계 개편: 집계 산출물(track/loss time·total_points·archive_bytes) 필드 삭제 —
/// 등록은 원본 ASS 보관 + 메타만이고, 히스토그램은 보고서 생성 시 재집계하기 때문.
/// Default — OmReferenceRegistryEntry 의 derive(Default) (구버전 마이그레이션 기본값)용.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct OmReferenceMeta {
    pub radar_name: String,
    pub month_label: String,
    pub file_count: u32,
    pub first_date: String,
    pub last_date: String,
    pub created_at: String,
    pub radar_lat: f64,
    pub radar_lon: f64,
    pub radar_altitude: f64,
    pub antenna_height: f64,
    /// 보관된 원본 ASS 합계 바이트 — 0=미보관(구버전 빌드/보관 실패), 재집계 불가 → 프론트 "재등록 필요".
    #[serde(default)]
    pub ass_bytes: u64,
}

/// 기준월 재집계 결과 (RadarMonthlyResult.reference 로 직렬화 — 프론트 BlockageReference 원천).
/// 분석월과 완전히 동일한 쐐기 파이프라인으로 기준월 ASS 를 재집계한 산출물.
/// **일별 히스토그램을 그대로 담는다**(월간 합산하지 않음) — 분석월 daily_stats 와 동일 직렬화
/// (일별 ser_s3·hist_to_sorted_cells 정렬 셀). **daily 는 month_label 월의 날짜만 담는다**
/// (월경계 파일 내부의 타월 데이터 제외 — 분석월 filteredResult date-필터와 대칭, 같은 월 →
/// 동일 날짜 집합 → Δ=0). 프론트가 분석월과 동일 코드·동일 순서로 일별
/// accumulateBand 합산 → 표시 정밀도까지 비트 동일(같은 월 → Δ=0 이 구조적으로 보장).
/// totals(track/loss time·day_count·source_file_count)는 로그·유지 목적으로 존치.
/// Deserialize 는 디스크 캐시(<hash>.json) 역직렬화용.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OmRefWedge {
    pub month_label: String,
    /// 일별 방위×양각 시간 히스토그램 (date 오름차순 — 분석월 daily_stats 와 동일 순서·동일 직렬화).
    pub daily: Vec<OmRefDayHist>,
    pub total_track_time_secs: f64,
    pub total_loss_time_secs: f64,
    pub day_count: u32,
    pub source_file_count: u32,
}

/// 기준월 일별 히스토그램 (OmRefWedge.daily 요소). 셀은 분석월과 동일한 ser_s3 직렬화·
/// hist_to_sorted_cells 정렬 순서 — TS 일별 합산 순서가 분석월과 완전히 일치하도록.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OmRefDayHist {
    pub date: String,
    pub az_elev_histogram: Vec<AzElevCell>,
}

/// 레지스트리 항목 (settings `om_reference_registry` JSON: radar_name → 이 값).
/// 메타 + 원본 ASS 보관 디렉토리. flatten 으로 메타 필드가 최상위에 펼쳐진다.
/// 재설계 개편: file_path/points_dir 제거(집계 JSON·포인트 아카이브 폐지) — 단 구버전 registry
/// 역직렬화 호환을 위해 serde(default) 로 남겨두고, 로드 시 1회 lazy cleanup 으로 비운다.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct OmReferenceRegistryEntry {
    #[serde(flatten)]
    pub meta: OmReferenceMeta,
    /// 원본 ASS 보관 디렉토리 절대경로 (om_reference/ass/<dir>/) — 빈 문자열=미보관(재등록 필요).
    #[serde(default)]
    pub ass_dir: String,
    /// (구버전 마이그레이션) 집계 JSON 파일 경로 — 새 시스템 미사용. 로드 시 발견하면 파일 삭제 후 비움.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub file_path: String,
    /// (구버전 마이그레이션) 원시 포인트 아카이브 디렉토리 — 새 시스템 미사용. 로드 시 발견하면 삭제 후 비움.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub points_dir: String,
}

// ─── 기준데이터 헬퍼 ───

/// 현재 UTC 시각을 ISO-8601 문자열로 (chrono 미의존 — std 로 생성).
/// 예: "2026-07-22T03:14:07Z". days_to_ymd(Howard Hinnant) 재사용.
/// 등록 커맨드(register_om_reference)의 created_at 생성에 lib.rs 에서 재사용 → pub.
pub fn now_iso8601() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (y, m, d) = days_to_ymd(days);
    let hh = rem / 3600;
    let mm = (rem % 3600) / 60;
    let ss = rem % 60;
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m, d, hh, mm, ss)
}

/// d 가 latest 보다 2일 이상 이전인지 (일 단위 플러시 판정, "YYYY-MM-DD" 문자열).
/// analyze_radar_monthly 의 baseline 플러시 규칙과 동일 — 자정 전후 포인트가 2개
/// 파일에 걸칠 수 있어 2일 버퍼를 유지한다.
fn date_is_2days_older(d: &str, latest: &str) -> bool {
    if d.len() != 10 || latest.len() != 10 {
        return false;
    }
    let d_prefix = &d[..7]; // "YYYY-MM"
    let latest_prefix = &latest[..7];
    if d_prefix < latest_prefix {
        return true; // 이전 달 → 플러시
    }
    if d_prefix == latest_prefix {
        let d_day: i32 = d[8..10].parse().unwrap_or(0);
        let latest_day: i32 = latest[8..10].parse().unwrap_or(0);
        return latest_day - d_day >= 2;
    }
    false
}

/// 기준월(참조 달) 재집계 — 보관된 ASS 를 분석월과 **완전히 동일한 쐐기 파이프라인**으로
/// 재집계한다. 파싱·필터 시퀀스(검사기 제외 → 60NM 컷 → min_obstacle_distance 컷 → sector 필터
/// → month_label date-필터 → 일별 버킷)와 일별 집계(accumulate_wedge_day, 컬렉터 None)를 분석월과
/// 공유하므로, 같은 월 입력이면 분석월 히스토그램과 비트 동일(Δ=0 불변식). geo 수집 없음
/// (loss/track_points_geo/heatmap/baseline 전부 생략) — 쐐기 통과 포인트만 일별 버킷 → 히스토그램·시간 집계.
/// **일별 히스토그램을 월간 합산하지 않고 그대로 daily 에 담는다**(분석월 daily_stats 와 동일 직렬화) —
/// 프론트가 분석월과 같은 코드·같은 순서로 일별 합산해 표시 정밀도까지 비트 동일하게 만들기 위함.
/// **daily 는 month_label 월의 날짜만 담는다**(월경계 파일 내부의 전월 말일·익월 초일 등 타월 데이터
/// 제외 — 분석월 filteredResult date-필터와 대칭, 같은 월 → 동일 날짜 집합 → Δ=0). 이 필터가 없으면
/// 월경계 파일의 타월 날짜가 기준월에만 추가로 들어가 같은 월 테스트에서도 Δ 가 어긋난다.
/// 메모리는 baseline 패턴과 같은 일 단위 플러시(2일 버퍼)로 제한. 취소는 공유 AtomicBool.
///
/// `radar` 는 분석월 RadarFileSet(현재 좌표·안테나고·sector·min_obstacle_distance) — file_paths 는
/// 무시하고 `ass_files`(보관 ASS 절대경로, 정렬)를 파싱한다. 진행은 stage "ref" 로 emit(기준월 명시).
pub fn compute_reference_wedge(
    radar: &RadarFileSet,
    exclude_mode_s: &[String],
    ass_files: &[String],
    month_label: &str,
    mag_dec_deg: f64,
    cancel: &std::sync::atomic::AtomicBool,
    progress_fn: &dyn Fn(ObstacleMonthlyProgress),
) -> Result<OmRefWedge, String> {
    use std::sync::atomic::Ordering;

    let total_files = ass_files.len();
    info!(
        "[OmReference] 레이더 '{}' 기준월 재집계 시작: {} files (동일 쐐기 파이프라인, month={})",
        radar.radar_name, total_files, month_label
    );

    // 안테나 해발고 (양각 계산용) — 분석월과 동일
    let radar_h = radar.radar_altitude + radar.antenna_height;

    // 일별 버킷 (쐐기 통과 포인트) — 일 단위 플러시로 메모리 2~3일치로 제한
    let mut daily_points: HashMap<String, Vec<LightPoint>> = HashMap::with_capacity(4);
    // 일별 히스토그램 수집 (월간 합산 안 함 — 분석월 daily_stats 와 동일 직렬화로 그대로 전달)
    let mut daily: Vec<OmRefDayHist> = Vec::new();
    let mut total_track_time = 0.0f64;
    let mut total_loss_time = 0.0f64;
    let mut day_count = 0u32;
    let mut latest_date_seen = String::new();

    // 파일 정렬 (시간순 보장 — 일 단위 플러시 정확도)
    let mut sorted_paths = ass_files.to_vec();
    sorted_paths.sort();

    for (i, path) in sorted_paths.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err("분석이 취소되었습니다".to_string());
        }
        progress_fn(ObstacleMonthlyProgress {
            radar_name: radar.radar_name.clone(),
            stage: "ref".to_string(),
            current: i + 1,
            total: total_files,
            message: format!(
                "기준월 재집계 중... ({}/{})",
                i + 1,
                total_files
            ),
        });

        // 파싱 (분석월과 동일 시퀀스 — 포함/제외 없이 전량 파싱 후 아래에서 필터)
        let parsed = match parser::ass::parse_ass_file(
            path,
            radar.radar_lat,
            radar.radar_lon,
            &[],
            &[],
            &[],
            &[],
            mag_dec_deg,
            |_| {},
        ) {
            Ok(p) => p,
            Err(e) => {
                // 파싱 실패 파일은 건너뛴다(분석월과 동일 관용 — 보고서 생성 차단 금지).
                info!("[OmReference] 기준월 파일 파싱 실패(건너뜀): {} — {}", path, e);
                continue;
            }
        };

        let mut inner_count = 0u32;
        for tp in &parsed.track_points {
            inner_count += 1;
            if inner_count % 10_000 == 0 && cancel.load(Ordering::Relaxed) {
                return Err("분석이 취소되었습니다".to_string());
            }
            // 비행검사기 제외 — 분석월과 동일
            if exclude_mode_s.iter().any(|ex| ex.eq_ignore_ascii_case(&tp.mode_s)) {
                continue;
            }
            // 거리 필터 (장애물 후방 min ~ 60NM) — 분석월과 동일 (heatmap 누적만 생략)
            let dist = calculate_haversine_distance(
                radar.radar_lat, radar.radar_lon, tp.latitude, tp.longitude,
            );
            if dist > OM_MAX_RANGE_KM {
                continue;
            }
            if radar.min_obstacle_distance_km > 0.0 && dist < radar.min_obstacle_distance_km {
                continue;
            }
            // 방위 필터 — 분석월과 동일 (sector 통과분만; baseline 누적은 생략)
            let az = crate::geo::bearing_deg(radar.radar_lat, radar.radar_lon, tp.latitude, tp.longitude);
            if !in_any_sector(az, &radar.azimuth_sectors) {
                continue;
            }
            let date = timestamp_to_date(tp.timestamp);
            if !date.starts_with(month_label) { continue; } // 월경계 파일의 전월 말일·익월 초일 제외 — 분석월 date-필터(ObstacleMonthlyConfigModal filteredResult)와 대칭
            if date > latest_date_seen {
                latest_date_seen = date.clone();
            }
            daily_points
                .entry(date)
                .or_default()
                .push(LightPoint::from_track_point(tp));
        }

        // ── 일 단위 플러시: latest_date_seen 대비 2일 이상 이전 날짜 즉시 처리+해제 ──
        if !latest_date_seen.is_empty() {
            let flush_dates: Vec<String> = daily_points
                .keys()
                .filter(|d| date_is_2days_older(d, &latest_date_seen))
                .cloned()
                .collect();
            for fd in flush_dates {
                if let Some(pts) = daily_points.remove(&fd) {
                    let mut day_hist: HashMap<u32, (f64, f64, u32, u32)> = HashMap::new();
                    // 공용 헬퍼 — 분석월과 동일 코드, 컬렉터는 전부 None(geo 미수집)
                    let (tt, lt) = accumulate_wedge_day(
                        &pts, radar.radar_lat, radar.radar_lon, radar_h, &mut day_hist,
                        None, None, None, None,
                    );
                    total_track_time += tt;
                    total_loss_time += lt;
                    // 일별 히스토그램을 정렬 셀로 변환해 그대로 수집(분석월과 동일 직렬화)
                    daily.push(OmRefDayHist { date: fd, az_elev_histogram: hist_to_sorted_cells(day_hist) });
                    day_count += 1;
                    // pts drop → 메모리 해제
                }
            }
        }
    }

    // 잔여 일 일괄 처리 (마지막 2일치)
    let remaining: Vec<String> = daily_points.keys().cloned().collect();
    for fd in remaining {
        if cancel.load(Ordering::Relaxed) {
            return Err("분석이 취소되었습니다".to_string());
        }
        if let Some(pts) = daily_points.remove(&fd) {
            let mut day_hist: HashMap<u32, (f64, f64, u32, u32)> = HashMap::new();
            let (tt, lt) = accumulate_wedge_day(
                &pts, radar.radar_lat, radar.radar_lon, radar_h, &mut day_hist,
                None, None, None, None,
            );
            total_track_time += tt;
            total_loss_time += lt;
            daily.push(OmRefDayHist { date: fd, az_elev_histogram: hist_to_sorted_cells(day_hist) });
            day_count += 1;
        }
    }

    // daily 를 date 오름차순 정렬 — 분석월 daily_stats 도 date 정렬이므로 두 경로의 일별 순서 일치
    // (TS 일별 합산 순서까지 동일 → 같은 월이면 총계 비트 동일).
    daily.sort_by(|a, b| a.date.cmp(&b.date));

    info!(
        "[OmReference] 레이더 '{}' 기준월 재집계 완료: {} days, track {:.0}s loss {:.0}s, {} daily hist (files {})",
        radar.radar_name, day_count, total_track_time, total_loss_time, daily.len(), total_files
    );

    Ok(OmRefWedge {
        month_label: month_label.to_string(),
        daily,
        total_track_time_secs: total_track_time,
        total_loss_time_secs: total_loss_time,
        day_count,
        source_file_count: total_files as u32,
    })
}

/// 기준월 재집계 캐시 버전 — 파이프라인/캐시 포맷이 바뀌면 +1 하여 기존 캐시를 무효화한다.
/// v2: OmRefWedge 캐시 포맷을 월간 합산(az_elev_histogram) → 일별(daily: OmRefDayHist)로 변경.
/// v3: daily 에 month_label date-필터 추가(월경계 파일의 타월 날짜 제외 — 분석월 filteredResult 와 대칭).
///     정의 변경 → 구 v2 캐시(타월 날짜 포함분)를 자동 무효화한다.
pub const OM_REF_PIPELINE_VERSION: u32 = 3;

/// 기준월 재집계 캐시 키 (16진 문자열) — 같은 입력·같은 설정이면 같은 키(같은 월 재집계는 캐시 히트).
/// 구성: 수동 버전 상수 + 파이프라인 상수 실측값 + month_label + 보관 ASS(이름,바이트) 정렬 +
///       현재 좌표(6자리)/안테나고·해발고(2자리)/최소거리(3자리)/sector(6자리) 정렬/제외Mode-S(소문자 정렬).
/// 파이프라인 상수를 넣는 이유: 임계·빈 상수가 바뀌면 히스토그램이 달라지므로 캐시를 자동 무효화.
/// `files_meta`: (파일명, 바이트) 목록 — 호출부(lib.rs)가 ass_dir 을 읽어 전달.
/// 해시: 새 crate 없이 FNV-1a 64bit 2개(오프셋 상수 상이) 조합 = 128bit(충돌 확률 무시 가능).
pub fn reference_cache_key(
    month_label: &str,
    files_meta: &[(String, u64)],
    radar: &RadarFileSet,
    exclude_mode_s: &[String],
) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(1024);
    let _ = write!(s, "v{}", OM_REF_PIPELINE_VERSION);
    let _ = write!(
        s, "|lt{}|md{}|sc{}",
        OM_LOSS_THRESHOLD_SECS, MAX_OM_LOSS_DURATION_SECS, OM_SPEED_CHANGE_RATIO
    );
    let _ = write!(
        s, "|az{}|eb{}|emin{}|emax{}",
        HIST_AZ_BIN_DEG, HIST_ELEV_BIN_DEG, HIST_ELEV_MIN_DEG, HIST_ELEV_MAX_DEG
    );
    let _ = write!(s, "|mr{}", OM_MAX_RANGE_KM);
    let _ = write!(s, "|mon{}", month_label);
    let _ = write!(s, "|lat{:.6}|lon{:.6}", radar.radar_lat, radar.radar_lon);
    let _ = write!(s, "|alt{:.2}|ah{:.2}", radar.radar_altitude, radar.antenna_height);
    let _ = write!(s, "|mind{:.3}", radar.min_obstacle_distance_km);
    // sectors 정렬 (start,end 6자리)
    let mut secs: Vec<(String, String)> = radar
        .azimuth_sectors
        .iter()
        .map(|a| (format!("{:.6}", a.start_deg), format!("{:.6}", a.end_deg)))
        .collect();
    secs.sort();
    s.push_str("|sec");
    for (a, b) in &secs {
        let _ = write!(s, "{}:{};", a, b);
    }
    // exclude_mode_s 소문자 정렬
    let mut exc: Vec<String> = exclude_mode_s.iter().map(|e| e.to_ascii_lowercase()).collect();
    exc.sort();
    s.push_str("|exc");
    for e in &exc {
        let _ = write!(s, "{},", e);
    }
    // files (이름, 바이트) 정렬
    let mut fm: Vec<&(String, u64)> = files_meta.iter().collect();
    fm.sort_by(|a, b| a.0.cmp(&b.0));
    s.push_str("|files");
    for (n, b) in fm {
        let _ = write!(s, "{}:{};", n, b);
    }

    // FNV-1a 64bit × 2 (오프셋 상수 상이) → 128bit hex
    fn fnv1a(bytes: &[u8], basis: u64) -> u64 {
        let mut h = basis;
        for &b in bytes {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
        h
    }
    let bytes = s.as_bytes();
    let h1 = fnv1a(bytes, 0xcbf2_9ce4_8422_2325);
    let h2 = fnv1a(bytes, 0x8422_2325_cbf2_9ce4);
    format!("{:016x}{:016x}", h1, h2)
}

/// radar_name → 파일시스템 안전 스템: 영숫자 외 문자를 '_' 로 치환 + 결정적 짧은 해시 접미사.
/// 같은 radar_name 은 항상 같은 스템을 생성(재등록 시 동일 디렉토리 교체) —
/// DefaultHasher::new() 는 고정 초기상태라 실행 간 결정적.
fn sanitized_stem(radar_name: &str) -> String {
    use std::hash::{Hash, Hasher};
    let safe: String = radar_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    radar_name.hash(&mut h);
    let hash = h.finish() & 0xFFFF_FFFF;
    format!("omref_{}_{:08x}", safe, hash)
}

/// 원본 ASS 보관·캐시 디렉토리명 (om_reference/ass/<name>/, om_reference/cache/<name>/)
pub fn reference_dirname(radar_name: &str) -> String {
    sanitized_stem(radar_name)
}

// ═══════════════════════════════════════════════════════════════════════════
// 패리티 진단 테스트 (동일 입력 → 분석월 경로 vs 기준월 재집계 경로 히스토그램 일치 검증)
// cargo test --release parity -- --ignored --nocapture, 환경변수 PARITY_DIR=ASS 폴더
// ═══════════════════════════════════════════════════════════════════════════
#[cfg(test)]
mod parity_tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    #[ignore]
    fn verify_reference_parity() {
        let dir = std::env::var("PARITY_DIR").expect("PARITY_DIR 환경변수 필요");
        // 4월 파일 + 전월 마지막날(0331) — filterFilesByMonth 규칙 미러
        let mut files: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter_map(|e| {
                let p = e.path();
                let name = p.file_name()?.to_string_lossy().to_string();
                if !name.to_ascii_lowercase().ends_with(".ass") {
                    return None;
                }
                let d = crate::parser::ass::extract_date_from_filename(&name)?;
                if d.starts_with("2026-04") || d == "2026-03-31" {
                    Some(p.to_string_lossy().to_string())
                } else {
                    None
                }
            })
            .collect();
        files.sort();
        assert!(!files.is_empty(), "PARITY_DIR 에 4월 파일 없음");
        eprintln!("[parity] {} files", files.len());

        let radar = RadarFileSet {
            radar_name: "PARITY".to_string(),
            radar_lat: 37.558,
            radar_lon: 126.794,
            radar_altitude: 20.0,
            antenna_height: 15.0,
            file_paths: files.clone(),
            azimuth_sectors: vec![
                AzSector { start_deg: 195.0, end_deg: 215.0 },
                AzSector { start_deg: 300.0, end_deg: 308.0 },
            ],
            min_obstacle_distance_km: 1.5,
            building_bearings_deg: vec![],
            building_az_half_extents_deg: vec![],
        };
        let exclude: Vec<String> = vec![];
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let noop = |_p: ObstacleMonthlyProgress| {};

        // ── Path A: 분석월 경로 (analyze_radar_monthly → 일별 히스토그램) ──
        let res = analyze_radar_monthly(&radar, &exclude, -8.0, &cancel, &noop).expect("analyze 실패");
        // ── Path B: 기준월 재집계 경로 (compute_reference_wedge → 일별 히스토그램) ──
        let wedge = compute_reference_wedge(&radar, &exclude, &files, "2026-04", -8.0, &cancel, &noop)
            .expect("reference 실패");

        // ── 일별·셀별 exact 비교 ──
        // 재설계 후 기준월도 일별 히스토그램을 그대로 담으므로(hist_to_sorted_cells 정렬 셀),
        // 같은 월 입력이면 분석월 daily_stats 와 기준월 daily 는 날짜 집합·각 날짜의 셀 배열이
        // 정렬 포함 완전 동일해야 한다(full precision 값·카운트 exact). r3 시뮬레이션은 이제
        // 정의상 0이라 폐지 — 직접 exact assert 로 대체.
        //
        // Path A(분석월)는 앱과 동일하게 만들기 위해 filteredResult 를 미러한다:
        // res.daily_stats 에서 "2026-04" 로 시작하는 날짜만 비교 대상으로 남긴다
        // (ObstacleMonthlyConfigModal filteredResult: d.date.startsWith(effectiveMonth) 미러 —
        //  월경계 파일의 3/31·5/1 등 타월 날짜 제외). Path B(compute_reference_wedge)는 R1(v3)
        // month_label date-필터로 이미 4월 날짜만 담으므로 별도 필터 불필요 → 두 경로 날짜 집합 대칭.
        let a_by_date: BTreeMap<&str, &Vec<AzElevCell>> = res
            .daily_stats
            .iter()
            .filter(|d| d.date.starts_with("2026-04"))
            .map(|d| (d.date.as_str(), &d.az_elev_histogram))
            .collect();
        let b_by_date: BTreeMap<&str, &Vec<AzElevCell>> = wedge
            .daily
            .iter()
            .map(|d| (d.date.as_str(), &d.az_elev_histogram))
            .collect();

        eprintln!("[parity] A days={} B days={}", a_by_date.len(), b_by_date.len());

        // 날짜 집합 일치 (BTreeMap 이라 키는 정렬 순)
        let a_dates: Vec<&str> = a_by_date.keys().copied().collect();
        let b_dates: Vec<&str> = b_by_date.keys().copied().collect();
        assert_eq!(a_dates, b_dates, "날짜 집합 불일치");

        // 각 날짜의 셀 배열이 정렬 포함 완전 동일:
        //   · az_bin/elev_bin/track_count/loss_count — exact (정렬 셀 정합 + 정수합은 순서 무관).
        //   · track_time_s/loss_time_s — **직렬화(ser_s3) 표시 정밀도로 exact**(단, 아래 sub-ULP 경계 예외).
        // 왜 full precision(to_bits)이 아니라 표시 정밀도인가: accumulate_wedge_day 의 mode_s 그룹핑
        // HashMap 반복 순서가 인스턴스마다 무작위라, 여러 그룹이 같은 셀에 기여하면 f64 덧셈의
        // 비결합성으로 두 경로의 셀 값이 sub-ULP(1 ULP≈1e-15) 어긋날 수 있다(그룹 순서만 다름 — 알고리즘은
        // 동일). 이 차이는 보통 ser_s3(0.001s 양자화, 프론트가 실제 소비하는 직렬화 값) 밑이라 직렬화 후 동일.
        //
        // **단 하나의 예외 — ser_s3 반올림 경계(x.xxx5)**: 값이 정확히 0.0005 배수 경계에 걸리면
        // (예: 25.6875 vs 25.687499999999996) 1-ULP 섭동이 반올림을 뒤집어 ser_s3 후 0.001s 차이를 낸다.
        // 이는 월경계 데이터 차이(초 단위)가 아니라 순수 부동소수 비결합성 산물이므로 허용한다:
        // ser_s3 값이 같거나(주 경로) **full-precision |Δ| < 1e-6**(경계 뒤집힘 증명 — 실 데이터 차이는
        // ser_s3 퀀텀 1e-3 이상이라 1e-6 문턱을 넘지 못함)이면 일치로 본다. 이로써 월경계 회귀
        // (날짜 집합·포인트 셋 차이 → 초 단위 Δ)는 여전히 잡히고, 결정적 그룹순서(변경 금지 — '분석월
        // 산출 수치 불변' 규칙)에 의존하지 않는다.
        fn r3(v: f64) -> f64 { (v * 1e3).round() / 1e3 }
        // ser_s3 표시 정밀도 일치 OR sub-ULP 경계 뒤집힘(full-precision 1e-6 이내)이면 true.
        fn s3_eq(a: f64, b: f64) -> bool { r3(a) == r3(b) || (a - b).abs() < 1e-6 }
        let mut total_cells = 0usize;
        let mut max_dtt = 0.0f64; // full precision 최대 |Δ| (진단 — sub-ULP 확인용)
        let mut max_dlt = 0.0f64;
        for (date, a_cells) in &a_by_date {
            let b_cells = b_by_date.get(date).expect("date exists in B");
            assert_eq!(
                a_cells.len(), b_cells.len(),
                "[{}] 셀 수 불일치 A={} B={}", date, a_cells.len(), b_cells.len()
            );
            for (i, (ca, cb)) in a_cells.iter().zip(b_cells.iter()).enumerate() {
                assert_eq!(ca.az_bin, cb.az_bin, "[{}] #{} az_bin 불일치", date, i);
                assert_eq!(ca.elev_bin, cb.elev_bin, "[{}] #{} elev_bin 불일치", date, i);
                assert_eq!(ca.track_count, cb.track_count, "[{}] #{} track_count 불일치", date, i);
                assert_eq!(ca.loss_count, cb.loss_count, "[{}] #{} loss_count 불일치", date, i);
                // 표시 정밀도(ser_s3) 일치 — 직렬화 후 JSON·TS 소비값 동일 보증(Δ=0). sub-ULP 경계 예외 허용(위 주석).
                assert!(
                    s3_eq(ca.track_time_s, cb.track_time_s),
                    "[{}] #{} (az={} elev={}) track_time_s 불일치(경계 예외 초과) A={} B={} |Δ|={:.3e}",
                    date, i, ca.az_bin, ca.elev_bin, ca.track_time_s, cb.track_time_s,
                    (ca.track_time_s - cb.track_time_s).abs()
                );
                assert!(
                    s3_eq(ca.loss_time_s, cb.loss_time_s),
                    "[{}] #{} (az={} elev={}) loss_time_s 불일치(경계 예외 초과) A={} B={} |Δ|={:.3e}",
                    date, i, ca.az_bin, ca.elev_bin, ca.loss_time_s, cb.loss_time_s,
                    (ca.loss_time_s - cb.loss_time_s).abs()
                );
                max_dtt = max_dtt.max((ca.track_time_s - cb.track_time_s).abs());
                max_dlt = max_dlt.max((ca.loss_time_s - cb.loss_time_s).abs());
            }
            total_cells += a_cells.len();
        }
        eprintln!(
            "[parity] 일별·셀별 일치 확인: {} days, {} cells | 카운트·bin exact, 시간 ser_s3 일치(sub-ULP 경계 예외 허용) | full-precision max|Δtt|={:.2e} max|Δlt|={:.2e} (1 ULP 수준 — HashMap 그룹순서 산물, 월경계 데이터 차이 아님)",
            a_by_date.len(), total_cells, max_dtt, max_dlt
        );
    }
}
