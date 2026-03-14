use std::fmt;
use serde::{Deserialize, Serialize};

/// 레이더 탐지 유형 (I020 TYP 기반 4종 분류)
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RadarDetectionType {
    Atcrbs,     // TYP=2: ATCRBS/SSR only
    AtcrbsPsr,  // TYP=3: ATCRBS + PSR
    Modes,      // TYP=4,5: Mode-S only
    ModesPsr,   // TYP=6,7: Mode-S + PSR (최고 신뢰)
}

impl RadarDetectionType {
    /// 탐지 우선순위 (동일 스캔 중복 처리용)
    pub fn priority(&self) -> u8 {
        match self {
            RadarDetectionType::Atcrbs => 0,
            RadarDetectionType::AtcrbsPsr => 1,
            RadarDetectionType::Modes => 2,
            RadarDetectionType::ModesPsr => 3,
        }
    }

    pub fn has_psr(&self) -> bool {
        matches!(self, RadarDetectionType::AtcrbsPsr | RadarDetectionType::ModesPsr)
    }

    pub fn has_modes(&self) -> bool {
        matches!(self, RadarDetectionType::Modes | RadarDetectionType::ModesPsr)
    }

    pub fn is_atcrbs(&self) -> bool {
        matches!(self, RadarDetectionType::Atcrbs | RadarDetectionType::AtcrbsPsr)
    }
}

impl fmt::Display for RadarDetectionType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RadarDetectionType::Atcrbs => write!(f, "ATCRBS"),
            RadarDetectionType::AtcrbsPsr => write!(f, "ATCRBS+PSR"),
            RadarDetectionType::Modes => write!(f, "Mode-S"),
            RadarDetectionType::ModesPsr => write!(f, "Mode-S+PSR"),
        }
    }
}

/// 파싱 통계 (진단/디버깅용)
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ParseStatistics {
    pub total_asterix_records: usize,
    pub discarded_psr_none: usize,
    pub garbled_removed: usize,
    pub atcrbs_merged: usize,
    pub atcrbs_unmatched: usize,
    /// [atcrbs, atcrbs_psr, modes, modes_psr]
    pub points_by_type: [usize; 4],
}

/// 비행검사기 (Flight Inspector Aircraft)
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Aircraft {
    /// UUID
    pub id: String,
    /// 이름 (예: 1호기, 2호기)
    pub name: String,
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
