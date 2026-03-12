use serde::{Deserialize, Serialize};

/// 비행검사기 (Flight Inspector Aircraft)
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Aircraft {
    /// UUID
    pub id: String,
    /// 기체 이름
    pub name: String,
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
}

/// 분석 결과 (Analysis Result)
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AnalysisResult {
    pub file_info: ParsedFile,
    pub loss_segments: Vec<LossSegment>,
    pub total_loss_time: f64,
    pub total_track_time: f64,
    pub loss_percentage: f64,
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
