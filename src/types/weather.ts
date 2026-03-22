/** 시간별 기상 데이터 (Open-Meteo Archive API) */
export interface WeatherHourly {
  /** Unix timestamp */
  timestamp: number;
  /** 기온 (°C) */
  temperature: number;
  /** 강수량 (mm) */
  precipitation: number;
  /** 전체 운량 (%) */
  cloud_cover: number;
  /** 하층 운량 (%) */
  cloud_cover_low: number;
  /** 중층 운량 (%) */
  cloud_cover_mid: number;
  /** 상층 운량 (%) */
  cloud_cover_high: number;
  /** 시정 (m) */
  visibility: number;
  /** 풍속 (m/s) */
  wind_speed: number;
  /** 풍향 (degrees) */
  wind_direction: number;
  /** 해면기압 (hPa) */
  pressure: number;
  /** 이슬점 (°C) */
  dewpoint: number;
}

/** 기상 스냅샷 (특정 기간/위치) */
export interface WeatherSnapshot {
  radarLat: number;
  radarLon: number;
  startDate: string;
  endDate: string;
  hourly: WeatherHourly[];
  fetchedAt: number;
}

/** 구름 그리드 셀 (공간 분포) */
export interface CloudGridCell {
  lat: number;
  lon: number;
  cloud_cover: number;
  cloud_cover_low: number;
  cloud_cover_mid: number;
  cloud_cover_high: number;
}

/** 구름 그리드 (시간별 공간 분포) */
export interface CloudGridFrame {
  timestamp: number;
  cells: CloudGridCell[];
}

/** 구름 그리드 타임시리즈 */
export interface CloudGridData {
  radarLat: number;
  radarLon: number;
  frames: CloudGridFrame[];
  gridSpacingKm: number;
}
