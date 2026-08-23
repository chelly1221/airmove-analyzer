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
    /// 파싱 단계에서 항적에서 제거·보존된 유령표적 포인트 수
    /// (detect_and_remove_ghosts + remove_spatial_outliers 합계)
    #[serde(default)]
    pub ghost_points_removed: usize,
    /// TrackMap PSR 단독 플롯용으로 수집된 표적보고 수 — **TYP=1 한정**
    /// (collect_psr_reports=true 일 때만 누적)
    #[serde(default)]
    pub psr_reports_collected: usize,
    /// I161 트랙번호가 없어 PSR 단독 플롯 수집에서 제외된 TYP=1 표적보고 수.
    /// 폴백 금지 — 다른 키로 묶지 않고 폐기 카운트로만 드러낸다.
    #[serde(default)]
    pub psr_reports_no_track_number: usize,
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

/// TCAS/ACAS 보고 — 트랙 포인트와 독립적으로 전수 추출.
/// 좌표/시간이 없는 Comm-B 응답 레코드에도 실려오므로 별도 수집한다.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TcasReport {
    /// Unix timestamp (I140 우선, 없으면 직전 유효 시각으로 추정)
    pub timestamp: f64,
    /// 시각이 직전 레코드에서 추정된 값인지 (I140 부재)
    pub time_estimated: bool,
    /// 보고 항공기 Mode-S (I220, hex 6자리). 없으면 "NO_MODES"
    pub mode_s: String,
    /// 0 = I048/260 ACAS RA, 1 = I048/250 BDS 3,0 RA, 2 = I048/250 BDS 1,6 Coordination
    pub source: u8,
    /// BDS 페이로드 7바이트
    pub payload: Vec<u8>,
    /// 레코드에 좌표가 있으면 WGS84 (없으면 None)
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    /// 고도 (m, flight level 변환). 없으면 None
    pub altitude: Option<f64>,
    /// 프레임 전문 — NEC 프레임 헤더([월][일][시][분]+카운터) + 해당 프레임의 모든
    /// ASTERIX 블록(CAT048/034/008 등) 원본 바이트. NEC 프레이밍이 없으면 해당 CAT048 블록.
    pub raw_frame: Vec<u8>,
}

/// CAT008 기상 극좌표 벡터 (I008/034) — 트랙 독립 전수 추출.
/// 레이더 1차(PSR) 채널의 강수 에코. 방위별 거리구간 + 강도(6단계).
/// 거리는 bin 단위로 보관 (실거리 = bin × NM/bin, SOP의 f 미전송이라 프론트에서 스케일 적용).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WeatherVector {
    /// Unix timestamp (NEC 프레임 헤더의 분 단위 UTC — CAT008엔 시각필드 없음)
    pub time: f64,
    /// 진북 기준 방위 (도). 자북 → 진북(mag_dec) 보정 적용됨.
    pub azimuth: f32,
    /// 시작 거리 (bin)
    pub start_bin: u8,
    /// 끝 거리 (bin)
    pub end_bin: u8,
    /// 강도 레벨 1~6 (I008/020 bits 7-5)
    pub intensity: u8,
}

/// TrackMap "PSR 단독" 플롯 표출용 경량 표적보고 — I161 트랙번호가 있는 **TYP=1 레코드만**
/// (전수; 유령 제거·동일위치 중복 제거·Mode-S 필터 미적용).
/// 기존 track_points 파이프라인과 완전히 분리된 별도 채널이다.
/// PSR 채널 **통계**(탐지율·소실)는 이 채널이 아니라 ASTERIX 통계 상세의 PSR 토픽
/// (`analysis::psr_channel`)이 계산한다 — 여기서 TYP 2~7 을 나르지 않는 이유.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PsrReport {
    /// Unix 초 (UTC) — track_points 와 동일한 base_date + day_offset + TOD 산정
    pub timestamp: f64,
    /// I161 트랙번호 (12bit)
    pub track_number: u16,
    /// I020 TYP — 이 채널은 TYP=1(PSR 단독) 만 수집하므로 **항상 1** (필드는 계약 유지용)
    pub typ: u8,
    pub latitude: f64,
    pub longitude: f64,
    /// 레이더 거리 NM (I040 그대로; I042 직교좌표 레코드는 sqrt(x²+y²))
    pub rho_nm: f32,
    /// 진북 방위 deg [0,360) — 자북 theta + mag_dec 보정
    pub theta_deg: f32,
    /// I220 Mode-S 주소 (>0 일 때만), 없으면 None
    pub mode_s: Option<u32>,
    /// I070 Mode 3/A (garbled 가 아닐 때만), 없으면 None
    pub mode3a: Option<u16>,
    /// I090 FL×100ft→m, 없으면 None (PSR 단독 보고엔 고도가 없다)
    pub altitude_m: Option<f32>,
    /// I200 대지속도 (kt) — 없으면 0
    pub speed_kts: f32,
    /// I200 진행방위 (deg) — 없으면 0
    pub heading_deg: f32,
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
    /// 파싱 단계에서 항적에서 제거된 유령표적 포인트 보존분 (이중표적 분석용).
    /// track_points 에는 포함되지 않으며, Loss 탐지/항적 파이프라인과 완전 분리된 별도 채널.
    #[serde(default)]
    pub ghost_points: Vec<TrackPoint>,
    pub parse_errors: Vec<String>,
    pub start_time: Option<f64>,
    pub end_time: Option<f64>,
    /// 파싱 시 사용된 레이더 좌표
    pub radar_lat: f64,
    pub radar_lon: f64,
    /// 파싱 통계 (진단용)
    #[serde(default)]
    pub parse_stats: Option<ParseStatistics>,
    /// TCAS/ACAS 보고 (트랙 독립 전수 추출)
    #[serde(default)]
    pub tcas_reports: Vec<TcasReport>,
    /// CAT008 기상 극좌표 벡터 (트랙 독립 전수 추출)
    #[serde(default)]
    pub weather_vectors: Vec<WeatherVector>,
    /// PSR 채널 분석용 표적보고 (collect_psr_reports=true 로 파싱했을 때만 채워짐).
    /// track_points 와 별개 채널 — Loss 탐지/항적 파이프라인에 영향 없음.
    #[serde(default)]
    pub psr_reports: Vec<PsrReport>,
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
