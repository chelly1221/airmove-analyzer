/** ADS-B 트랙 포인트 (OpenSky Network) */
export interface AdsbPoint {
  time: number;
  latitude: number;
  longitude: number;
  altitude: number;
  heading: number;
  on_ground: boolean;
}

/** ADS-B 트랙 (한 비행 구간) */
export interface AdsbTrack {
  icao24: string;
  callsign: string | null;
  start_time: number;
  end_time: number;
  path: AdsbPoint[];
}
