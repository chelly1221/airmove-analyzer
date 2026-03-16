import type { WeatherHourly, WeatherSnapshot, CloudGridData, CloudGridFrame, CloudGridCell } from "../types";
import { invoke } from "@tauri-apps/api/core";

const ARCHIVE_API = "https://archive-api.open-meteo.com/v1/archive";

/** 날짜 범위를 일 단위 배열로 분해 */
function getDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const d = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");
  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

/** 단일 날짜 기상 데이터 API 조회 */
async function fetchWeatherForDay(lat: number, lon: number, date: string): Promise<WeatherHourly[]> {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    start_date: date,
    end_date: date,
    hourly: [
      "temperature_2m",
      "precipitation",
      "cloud_cover",
      "cloud_cover_low",
      "cloud_cover_mid",
      "cloud_cover_high",
      "visibility",
      "wind_speed_10m",
      "wind_direction_10m",
      "pressure_msl",
      "dewpoint_2m",
    ].join(","),
    timezone: "UTC",
  });

  const resp = await fetch(`${ARCHIVE_API}?${params}`);
  if (!resp.ok) throw new Error(`Weather API error: ${resp.status}`);
  const data = await resp.json();

  const h = data.hourly;
  const hourly: WeatherHourly[] = [];
  if (h && h.time) {
    for (let i = 0; i < h.time.length; i++) {
      hourly.push({
        timestamp: new Date(h.time[i] + "Z").getTime() / 1000,
        temperature: h.temperature_2m?.[i] ?? 0,
        precipitation: h.precipitation?.[i] ?? 0,
        cloud_cover: h.cloud_cover?.[i] ?? 0,
        cloud_cover_low: h.cloud_cover_low?.[i] ?? 0,
        cloud_cover_mid: h.cloud_cover_mid?.[i] ?? 0,
        cloud_cover_high: h.cloud_cover_high?.[i] ?? 0,
        visibility: h.visibility?.[i] ?? 0,
        wind_speed: h.wind_speed_10m?.[i] ?? 0,
        wind_direction: h.wind_direction_10m?.[i] ?? 0,
        pressure: h.pressure_msl?.[i] ?? 0,
        dewpoint: h.dewpoint_2m?.[i] ?? 0,
      });
    }
  }
  return hourly;
}

/** Open-Meteo Archive API에서 과거 시간별 기상 데이터 조회 (일 단위 캐싱) */
export async function fetchHistoricalWeather(
  lat: number,
  lon: number,
  startDate: string,
  endDate: string,
  onProgress?: (msg: string) => void,
): Promise<WeatherSnapshot> {
  const allDates = getDateRange(startDate, endDate);
  let allHourly: WeatherHourly[] = [];

  // 1) DB에서 캐시된 날짜 확인
  let cachedDates: Set<string> = new Set();
  try {
    const cached = await invoke<string[]>("get_weather_cached_dates", {
      radarLat: lat, radarLon: lon,
    });
    cachedDates = new Set(cached);
  } catch (e) {
    console.warn("[Weather] 캐시 날짜 조회 실패:", e);
  }

  // 2) 캐시된 날짜는 DB에서 로드
  const cachedForRange = allDates.filter((d) => cachedDates.has(d));
  const uncachedDates = allDates.filter((d) => !cachedDates.has(d));

  if (cachedForRange.length > 0) {
    try {
      const rows = await invoke<[string, string][]>("load_weather_cache", {
        radarLat: lat, radarLon: lon, dates: cachedForRange,
      });
      for (const [, json] of rows) {
        const hourly: WeatherHourly[] = JSON.parse(json);
        allHourly.push(...hourly);
      }
      console.log(`[Weather] DB 캐시에서 ${cachedForRange.length}일 로드`);
    } catch (e) {
      console.warn("[Weather] 캐시 로드 실패, 전체 재조회:", e);
      uncachedDates.push(...cachedForRange);
    }
  }

  // 3) 미캐시 날짜만 API 조회 + DB 저장
  for (let i = 0; i < uncachedDates.length; i++) {
    const date = uncachedDates[i];
    onProgress?.(`기상 데이터 조회 중... (${i + 1}/${uncachedDates.length}) ${date}`);
    try {
      const hourly = await fetchWeatherForDay(lat, lon, date);
      allHourly.push(...hourly);
      // DB에 캐시 저장
      invoke("save_weather_day", {
        date, radarLat: lat, radarLon: lon,
        hourlyJson: JSON.stringify(hourly),
      }).catch((e) => console.warn(`[Weather] ${date} 캐시 저장 실패:`, e));
    } catch (e) {
      console.warn(`[Weather] ${date} 조회 실패:`, e);
    }
  }

  // timestamp 정렬
  allHourly.sort((a, b) => a.timestamp - b.timestamp);

  return {
    radarLat: lat,
    radarLon: lon,
    startDate,
    endDate,
    hourly: allHourly,
    fetchedAt: Date.now() / 1000,
  };
}

/** 특정 시각에 가장 가까운 시간별 기상 데이터 반환 */
export function getWeatherAtTime(
  snapshot: WeatherSnapshot,
  timestamp: number,
): WeatherHourly | null {
  if (snapshot.hourly.length === 0) return null;
  let best = snapshot.hourly[0];
  let bestDiff = Math.abs(best.timestamp - timestamp);
  for (const h of snapshot.hourly) {
    const diff = Math.abs(h.timestamp - timestamp);
    if (diff < bestDiff) {
      best = h;
      bestDiff = diff;
    }
  }
  return best;
}

/** 덕팅 가능성 평가 (온도-이슬점 차, 해면기압 기반) */
export function assessDuctingRisk(weather: WeatherHourly): "low" | "moderate" | "high" {
  const tdDiff = weather.temperature - weather.dewpoint;
  // 온도-이슬점 차가 작고 기압이 높으면 덕팅 가능성 증가
  if (tdDiff < 2 && weather.pressure > 1020) return "high";
  if (tdDiff < 5 && weather.pressure > 1015) return "moderate";
  return "low";
}

/** 단일 날짜 구름 그리드 API 조회 */
async function fetchCloudGridForDay(
  points: { lat: number; lon: number }[],
  date: string,
  onProgress?: (msg: string) => void,
): Promise<CloudGridFrame[]> {
  const BATCH_SIZE = 10;
  const allResults: { lat: number; lon: number; times: string[]; covers: number[]; lows: number[]; mids: number[]; highs: number[] }[] = [];

  for (let i = 0; i < points.length; i += BATCH_SIZE) {
    const batch = points.slice(i, i + BATCH_SIZE);
    onProgress?.(`구름 ${date} (${Math.min(i + BATCH_SIZE, points.length)}/${points.length})`);

    const promises = batch.map(async (pt) => {
      const params = new URLSearchParams({
        latitude: pt.lat.toFixed(4),
        longitude: pt.lon.toFixed(4),
        start_date: date,
        end_date: date,
        hourly: "cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high",
        timezone: "UTC",
      });
      const resp = await fetch(`${ARCHIVE_API}?${params}`);
      if (!resp.ok) return null;
      const data = await resp.json();
      return {
        lat: pt.lat,
        lon: pt.lon,
        times: data.hourly?.time ?? [],
        covers: data.hourly?.cloud_cover ?? [],
        lows: data.hourly?.cloud_cover_low ?? [],
        mids: data.hourly?.cloud_cover_mid ?? [],
        highs: data.hourly?.cloud_cover_high ?? [],
      };
    });

    const results = await Promise.all(promises);
    for (const r of results) {
      if (r) allResults.push(r);
    }
  }

  const timeSet = new Set<string>();
  for (const r of allResults) {
    for (const t of r.times) timeSet.add(t);
  }
  const sortedTimes = Array.from(timeSet).sort();

  return sortedTimes.map((timeStr, ti) => {
    const cells: CloudGridCell[] = allResults.map((r) => ({
      lat: r.lat,
      lon: r.lon,
      cloud_cover: r.covers[ti] ?? 0,
      cloud_cover_low: r.lows[ti] ?? 0,
      cloud_cover_mid: r.mids[ti] ?? 0,
      cloud_cover_high: r.highs[ti] ?? 0,
    }));
    return {
      timestamp: new Date(timeStr + "Z").getTime() / 1000,
      cells,
    };
  });
}

/** 구름 그리드 데이터 조회 (레이더 주변 격자점, 일 단위 캐싱) */
export async function fetchCloudGrid(
  radarLat: number,
  radarLon: number,
  radiusKm: number,
  gridSpacingKm: number,
  startDate: string,
  endDate: string,
  onProgress?: (pct: number, msg: string) => void,
): Promise<CloudGridData> {
  // 격자점 생성
  const points: { lat: number; lon: number }[] = [];
  const degPerKm = 1 / 111.32;
  const cosLat = Math.cos((radarLat * Math.PI) / 180);
  const steps = Math.ceil(radiusKm / gridSpacingKm);

  for (let dy = -steps; dy <= steps; dy++) {
    for (let dx = -steps; dx <= steps; dx++) {
      const distKm = Math.sqrt(dx * dx + dy * dy) * gridSpacingKm;
      if (distKm > radiusKm) continue;
      points.push({
        lat: radarLat + dy * gridSpacingKm * degPerKm,
        lon: radarLon + dx * gridSpacingKm * degPerKm / cosLat,
      });
    }
  }

  const allDates = getDateRange(startDate, endDate);
  let allFrames: CloudGridFrame[] = [];

  // 1) DB에서 구름 그리드 캐시 로드
  let cloudCachedDates: Set<string> = new Set();
  try {
    // load_cloud_grid_cache로 전체 날짜 시도
    const rows = await invoke<[string, string, number][]>("load_cloud_grid_cache", {
      radarLat, radarLon, dates: allDates,
    });
    for (const [date, framesJson] of rows) {
      const frames: CloudGridFrame[] = JSON.parse(framesJson);
      allFrames.push(...frames);
      cloudCachedDates.add(date);
    }
    if (cloudCachedDates.size > 0) {
      console.log(`[CloudGrid] DB 캐시에서 ${cloudCachedDates.size}일 로드`);
    }
  } catch (e) {
    console.warn("[CloudGrid] 캐시 로드 실패:", e);
  }

  // 2) 미캐시 날짜만 API 조회
  const uncachedDates = allDates.filter((d) => !cloudCachedDates.has(d));
  const totalWork = uncachedDates.length;

  for (let di = 0; di < uncachedDates.length; di++) {
    const date = uncachedDates[di];
    onProgress?.(
      ((di + 1) / totalWork) * 100,
      `구름 데이터 조회 중... (${di + 1}/${totalWork}) ${date}`,
    );

    try {
      const frames = await fetchCloudGridForDay(points, date, (msg) =>
        onProgress?.(((di + 0.5) / totalWork) * 100, msg),
      );
      allFrames.push(...frames);
      // DB에 캐시 저장
      invoke("save_cloud_grid_day", {
        date, radarLat, radarLon, gridSpacingKm,
        framesJson: JSON.stringify(frames),
      }).catch((e) => console.warn(`[CloudGrid] ${date} 캐시 저장 실패:`, e));
    } catch (e) {
      console.warn(`[CloudGrid] ${date} 조회 실패:`, e);
    }
  }

  // timestamp 정렬
  allFrames.sort((a, b) => a.timestamp - b.timestamp);

  onProgress?.(100, "완료");

  return {
    radarLat,
    radarLon,
    frames: allFrames,
    gridSpacingKm,
  };
}

/** 특정 시각에 가장 가까운 구름 프레임 반환 */
export function getCloudFrameAtTime(
  data: CloudGridData,
  timestamp: number,
): CloudGridFrame | null {
  if (data.frames.length === 0) return null;
  let best = data.frames[0];
  let bestDiff = Math.abs(best.timestamp - timestamp);
  for (const f of data.frames) {
    const diff = Math.abs(f.timestamp - timestamp);
    if (diff < bestDiff) {
      best = f;
      bestDiff = diff;
    }
  }
  return best;
}
