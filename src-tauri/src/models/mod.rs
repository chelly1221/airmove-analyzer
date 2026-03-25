use std::fmt;
use serde::{Deserialize, Serialize};

/// 레이더 탐지 유형 (I020 TYP 기반 6종 분류)
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Hash)]
pub enum RadarDetectionType {
    #[serde(rename = "mode_ac")]
    ModeAC,              // TYP=2 (010): SSR (Mode A/C) only
    #[serde(rename = "mode_ac_psr")]
    ModeACPsr,           // TYP=3 (011): SSR (Mode A/C) + PSR
    #[serde(rename = "mode_s_allcall")]
    ModeSAllCall,        // TYP=4 (100): Mode S All-Call
    #[serde(rename = "mode_s_rollcall")]
    ModeSRollCall,       // TYP=5 (101): Mode S Roll-Call
    #[serde(rename = "mode_s_allcall_psr")]
    ModeSAllCallPsr,     // TYP=6 (110): Mode S All-Call + PSR
    #[serde(rename = "mode_s_rollcall_psr")]
    ModeSRollCallPsr,    // TYP=7 (111): Mode S Roll-Call + PSR
}

impl RadarDetectionType {
    /// 탐지 우선순위 (동일 스캔 중복 처리용)
    pub fn priority(&self) -> u8 {
        match self {
            RadarDetectionType::ModeAC => 0,
            RadarDetectionType::ModeACPsr => 1,
            RadarDetectionType::ModeSAllCall => 2,
            RadarDetectionType::ModeSRollCall => 3,
            RadarDetectionType::ModeSAllCallPsr => 4,
            RadarDetectionType::ModeSRollCallPsr => 5,
        }
    }

    pub fn has_psr(&self) -> bool {
        matches!(self, RadarDetectionType::ModeACPsr | RadarDetectionType::ModeSAllCallPsr | RadarDetectionType::ModeSRollCallPsr)
    }

    pub fn has_modes(&self) -> bool {
        matches!(self, RadarDetectionType::ModeSAllCall | RadarDetectionType::ModeSRollCall | RadarDetectionType::ModeSAllCallPsr | RadarDetectionType::ModeSRollCallPsr)
    }

    pub fn is_atcrbs(&self) -> bool {
        matches!(self, RadarDetectionType::ModeAC | RadarDetectionType::ModeACPsr)
    }
}

impl fmt::Display for RadarDetectionType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RadarDetectionType::ModeAC => write!(f, "Mode A/C"),
            RadarDetectionType::ModeACPsr => write!(f, "Mode A/C+PSR"),
            RadarDetectionType::ModeSAllCall => write!(f, "Mode S All-Call"),
            RadarDetectionType::ModeSRollCall => write!(f, "Mode S Roll-Call"),
            RadarDetectionType::ModeSAllCallPsr => write!(f, "Mode S All-Call+PSR"),
            RadarDetectionType::ModeSRollCallPsr => write!(f, "Mode S Roll-Call+PSR"),
        }
    }
}

/// 파싱 통계 (진단/디버깅용)
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ParseStatistics {
    pub total_asterix_records: usize,
    pub discarded_psr_none: usize,

    pub atcrbs_merged: usize,
    pub atcrbs_unmatched: usize,
    /// [mode_ac, mode_ac_psr, mode_s_allcall, mode_s_rollcall, mode_s_allcall_psr, mode_s_rollcall_psr]
    pub points_by_type: [usize; 6],
    /// I070 Mode 3/A: V=1(무효) 또는 G=1(garbled) 레코드 수
    pub mode3a_invalid: usize,
    /// 파싱 에러 후 바이트 스캔으로 복구된 레코드 수
    #[serde(default)]
    pub recovered_records: usize,
    /// NEC↔TOD 교차검증 실패로 폐기된 오염 레코드 수
    #[serde(default)]
    pub nec_tod_mismatch: usize,
}

/// 비행검사기 (Flight Inspector Aircraft)
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Aircraft {
    /// UUID
    pub id: String,
    /// 이름 (예: 1호기, 2호기)
    pub name: String,
    /// 등록번호 (예: FL7779)
    #[serde(default)]
    pub registration: String,
    /// 기체 모델 (예: Embraer Praetor 600)
    #[serde(default)]
    pub model: String,
    /// Mode-S 코드 (hex string)
    pub mode_s_code: String,
    /// 운용 기관
    pub organization: String,
    pub memo: String,
    pub active: bool,
}

/// 레이더 트랙 포인트
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TrackPoint {
    /// Unix timestamp
    pub timestamp: f64,
    /// Mode-S code
    pub mode_s: String,
    /// WGS84 latitude (degrees)
    pub latitude: f64,
    /// WGS84 longitude (degrees)
    pub longitude: f64,
    /// Altitude in meters
    pub altitude: f64,
    /// Speed in knots
    pub speed: f64,
    /// Heading in degrees
    pub heading: f64,
    /// 레이더 탐지 유형 (4종 분류)
    pub radar_type: RadarDetectionType,
    /// Original bytes for debugging
    #[serde(with = "serde_bytes_base64")]
    pub raw_data: Vec<u8>,
}

/// Loss 구간 (Loss Segment)
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LossSegment {
    pub mode_s: String,
    pub start_time: f64,
    pub end_time: f64,
    pub start_lat: f64,
    pub start_lon: f64,
    pub end_lat: f64,
    pub end_lon: f64,
    pub duration_secs: f64,
    pub distance_km: f64,
    pub last_altitude: f64,
    pub start_altitude: f64,
    pub end_altitude: f64,
    /// "signal_loss" = 실제 Loss, "out_of_range" = 레이더 범위 이탈
    pub loss_type: String,
    /// Loss 시작점의 레이더로부터 거리 (km)
    pub start_radar_dist_km: f64,
    /// Loss 종료점의 레이더로부터 거리 (km)
    pub end_radar_dist_km: f64,
}

/// 파싱 결과 (Parse Result)
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ParsedFile {
    pub filename: String,
    pub total_records: usize,
    pub track_points: Vec<TrackPoint>,
    pub parse_errors: Vec<String>,
    pub start_time: Option<f64>,
    pub end_time: Option<f64>,
    /// 파싱 시 사용된 레이더 좌표
    pub radar_lat: f64,
    pub radar_lon: f64,
    /// 파싱 통계 (진단용)
    #[serde(default)]
    pub parse_stats: Option<ParseStatistics>,
}

/// 분석 결과 (Analysis Result)
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AnalysisResult {
    pub file_info: ParsedFile,
    pub loss_segments: Vec<LossSegment>,
    pub total_loss_time: f64,
    pub total_track_time: f64,
    pub loss_percentage: f64,
    /// 추정된 레이더 최대 탐지거리 (km)
    pub max_radar_range_km: f64,
}

/// 레이더 사이트 설정 (Radar Site Configuration)
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RadarSite {
    pub name: String,
    /// WGS84 latitude
    pub latitude: f64,
    /// WGS84 longitude
    pub longitude: f64,
    /// Meters above sea level
    pub altitude: f64,
    /// Antenna height in meters
    pub antenna_height: f64,
}

/// Line of Sight calculation result
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LineOfSightResult {
    /// Whether the target is within radar line of sight
    pub in_sight: bool,
    /// Slant range to target in km
    pub slant_range_km: f64,
    /// Elevation angle in degrees
    pub elevation_deg: f64,
    /// Maximum detection range at this altitude using 4/3 Earth model, in km
    pub max_range_km: f64,
    /// Target altitude in meters
    pub target_altitude: f64,
}

/// Custom serialization for Vec<u8> as base64, so JSON transport works cleanly.
mod serde_bytes_base64 {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(bytes: &Vec<u8>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        // Serialize as an array of numbers for JSON compatibility
        serializer.collect_seq(bytes.iter())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let v: Vec<u8> = Vec::deserialize(deserializer)?;
        Ok(v)
    }
}
