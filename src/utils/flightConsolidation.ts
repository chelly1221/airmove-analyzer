import type { Aircraft, Flight, RadarSite, TrackPoint } from "../types";

/** 운항이력 레코드 (내부용, 레거시 호환) */
interface FlightRecord {
  icao24: string;
  first_seen: number;
  last_seen: number;
  est_departure_airport: string | null;
  est_arrival_airport: string | null;
  callsign: string | null;
}
import { correctAnomalousAltitudes } from "./altitudeCorrection";
import { detectLoss } from "./lossDetection";

/** 4시간 gap으로 비행 분리 */
const GAP_THRESHOLD_SECS = 14400;

/** 운항이력 매칭 시간 허용 오차 (초) */
const MATCH_TOLERANCE_SECS = 300; // ±5분

/** 공항 ICAO → 한글 이름 */
export const AIRPORT_NAMES: Record<string, string> = {
  // 한국 민간/국제공항 (AIP)
  RKSI: "인천", RKSS: "김포", RKPK: "김해", RKPC: "제주",
  RKTN: "대구", RKJJ: "광주", RKNY: "양양", RKTU: "청주",
  RKJK: "군산", RKNW: "원주", RKJY: "여수", RKPU: "울산",
  RKPS: "사천", RKTH: "포항경주", RKJB: "무안",
  RKTL: "울진", RKPD: "정석",
  // 1. 전술항공작전기지
  RKSO: "K-55", RKSG: "A-511", RKSM: "K-16",
  RKSW: "K-13", RKTI: "K-75", RKTY: "K-58",
  RKTP: "K-76", RKNN: "K-18",
  // 2. 지원항공작전기지
  RKPE: "K-10",
  RKRS: "G-113", RKRO: "G-217", RKRA: "G-222",
  RK13: "G-404", RKRN: "G-510", RKUL: "G-536",
  // 3. 헬기전용작전기지
  RKJM: "K-15", RKRB: "G-103", RKRP: "G-110",
  RKRK: "G-213", RKRI: "G-231",
  RK15: "G-237", RKRC: "G-280", RK27: "G-218",
  RKRD: "G-290", RKRG: "G-301",
  RK31: "G-307", RK16: "G-312", RK22: "G-313",
  RK48: "G-419", RK32: "G-420",
  RKRY: "G-501", RK51: "G-532",
  RKUY: "G-801", RK25: "G-107", RKJU: "G-703",
  RK38: "G-228", RKUC: "G-505",
  // 4. 헬기예비작전기지
  RK7H: "G-162", RK18: "G-233",
  RK17: "G-406", RK44: "G-412", RK21: "G-413",
  RK33: "G-418",
  // 기타 군 비행장 (OurAirports)
  RKST: "H-220", RKTE: "성무", RKNC: "춘천",
  RKTA: "태안", RKTS: "상주", RKCH: "남지",
  RK6O: "G-605", RK6X: "G-130",
  RK40: "G-240", RK36: "G-238", RK28: "G-219",
  RK42: "G-311", RK43: "G-414", RK49: "G-530",
  RK50: "G-526", RK19: "G-314", RK41: "G-317",
  RK82: "G-405", RK34: "G-417", RK14: "G-231",
  RK52: "G-501", RK60: "G-712", RK6D: "G-710",
  // 한국 헬리포트/헬리패드
  RKDD: "독도", RKDU: "울릉도", RKPM: "모슬포", RKSY: "H-264",
  RKSD: "N-200", RKSC: "수리산", RKSH: "중앙119",
  RKSJ: "태성산", RKSN: "쿠니사격장", RKSQ: "연평도", RKSV: "표리산",
  RKSU: "여주사격장", RKSX: "H-207",
  RKNF: "황령", RKNR: "코타사격장",
  RKTB: "백아도", RKTW: "웅천", RKJO: "용정리",
  RKBN: "N-201", RKTG: "H-805", RKTM: "만길산",
  RKSP: "백령도",
  // 일본 주요
  RJTT: "하네다", RJAA: "나리타", RJBB: "간사이", RJOO: "이타미",
  RJFF: "후쿠오카", RJCC: "신치토세", RJGG: "주부", RJSN: "니가타",
  RJFK: "가고시마", RJNK: "고마츠", ROAH: "나하",
  // 중국 주요
  ZBAA: "베이징", ZSPD: "상하이푸동", ZSSS: "상하이홍차오",
  ZGGG: "광저우", ZGSZ: "선전", ZUUU: "청두", VHHH: "홍콩",
  RCTP: "타오위안", RCSS: "쑹산",
  // 동남아/기타
  WSSS: "싱가포르", VTBS: "수완나품", RPLL: "마닐라",
  WIII: "자카르타",
};

/** 공항 ICAO → 한글명 포함 라벨 (예: "RKSI(인천)") */
export function airportLabel(code: string | null | undefined): string {
  if (!code) return "?";
  const name = AIRPORT_NAMES[code.toUpperCase()];
  return name ? `${code}(${name})` : code;
}

/** 비행 라벨 생성 */
export function flightLabel(f: Flight, aircraft: Aircraft[]): string {
  const name = f.aircraft_name ?? aircraft.find(
    (a) => a.mode_s_code.toUpperCase() === f.mode_s.toUpperCase()
  )?.name ?? f.mode_s;
  const parts = [name];
  if (f.callsign) parts.push(f.callsign);
  if (f.departure_airport || f.arrival_airport) {
    parts.push(`${airportLabel(f.departure_airport)} → ${airportLabel(f.arrival_airport)}`);
  }
  return parts.join(" · ");
}

/**
 * 같은 날 4시간 이내의 OpenSky FlightRecord를 하나로 병합.
 * 출발만 있는 레코드 + 도착만 있는 레코드 → 하나의 비행으로 합침.
 */
export function mergeFlightRecords(records: FlightRecord[]): FlightRecord[] {
  if (records.length <= 1) return records;

  // icao24별로 그룹핑
  const byIcao = new Map<string, FlightRecord[]>();
  for (const r of records) {
    const key = r.icao24.toUpperCase();
    let arr = byIcao.get(key);
    if (!arr) {
      arr = [];
      byIcao.set(key, arr);
    }
    arr.push(r);
  }

  const merged: FlightRecord[] = [];

  for (const [, group] of byIcao) {
    // 시간순 정렬
    group.sort((a, b) => a.first_seen - b.first_seen);

    const used = new Set<number>();

    for (let i = 0; i < group.length; i++) {
      if (used.has(i)) continue;

      let current = { ...group[i] };

      // 같은 날, 4시간 이내인 다음 레코드와 병합 시도
      for (let j = i + 1; j < group.length; j++) {
        if (used.has(j)) continue;
        const next = group[j];

        // 4시간 이내 확인
        const timeDiff = next.first_seen - current.last_seen;
        if (timeDiff > GAP_THRESHOLD_SECS || timeDiff < -GAP_THRESHOLD_SECS) continue;

        // 같은 날 확인
        const d1 = new Date(current.first_seen * 1000);
        const d2 = new Date(next.first_seen * 1000);
        if (d1.getFullYear() !== d2.getFullYear() ||
            d1.getMonth() !== d2.getMonth() ||
            d1.getDate() !== d2.getDate()) continue;

        // 병합: 시간범위 확장, 공항정보 보완
        current = {
          ...current,
          first_seen: Math.min(current.first_seen, next.first_seen),
          last_seen: Math.max(current.last_seen, next.last_seen),
          est_departure_airport: current.est_departure_airport || next.est_departure_airport,
          est_arrival_airport: current.est_arrival_airport || next.est_arrival_airport,
          callsign: current.callsign || next.callsign,
        };
        used.add(j);
      }

      merged.push(current);
      used.add(i);
    }
  }

  return merged;
}

/**
 * 모든 TrackPoint를 비행 단위로 통합.
 *
 * 1. mode_s별 그룹핑 → 시간순 정렬
 * 2. FlightRecord 병합 (같은 날 4시간 이내 출발/도착 합치기)
 * 3. FlightRecord 매칭 (icao24 일치 + 시간 겹침 ±5분)
 * 4. 미매칭 points → 4시간 gap으로 분리
 * 5. 각 Flight에 loss 탐지 + 통계 계산
 */
const yieldUI = () => new Promise<void>(r => setTimeout(r, 0));

export async function consolidateFlights(
  allTrackPoints: TrackPoint[],
  flightHistory: FlightRecord[],
  aircraft: Aircraft[],
  radarSite: RadarSite,
): Promise<Flight[]> {
  if (allTrackPoints.length === 0) return [];

  // OpenSky 비행 기록 병합 (같은 날 4시간 이내)
  const mergedHistory = mergeFlightRecords(flightHistory);

  // mode_s + radar_name 별 그룹핑 (대소문자 정규화)
  const byModeSRadar = new Map<string, TrackPoint[]>();
  for (const p of allTrackPoints) {
    const key = `${p.mode_s.toUpperCase()}|${p.radar_name ?? ""}`;
    let arr = byModeSRadar.get(key);
    if (!arr) {
      arr = [];
      byModeSRadar.set(key, arr);
    }
    arr.push(p);
  }

  // Aircraft name 매핑
  const aircraftByModeS = new Map<string, Aircraft>();
  for (const a of aircraft) {
    if (a.active && a.mode_s_code) {
      aircraftByModeS.set(a.mode_s_code.toUpperCase(), a);
    }
  }

  const flights: Flight[] = [];

  for (const [groupKey, points] of byModeSRadar) {
    const [modeS, radarName] = groupKey.split("|");
    points.sort((a, b) => a.timestamp - b.timestamp);

    const ac = aircraftByModeS.get(modeS.toUpperCase());

    // 이 mode_s에 매칭 가능한 FlightRecord 찾기 (병합된 기록 사용)
    const matchingRecords = mergedHistory.filter(
      (fr) => fr.icao24.toUpperCase() === modeS.toUpperCase()
    );

    // 각 포인트를 FlightRecord에 할당하거나 미매칭으로 남김
    const assigned = new Array<number>(points.length).fill(-1); // -1 = 미매칭
    const recordPoints = new Map<number, TrackPoint[]>();

    for (let ri = 0; ri < matchingRecords.length; ri++) {
      const fr = matchingRecords[ri];
      const frStart = fr.first_seen - MATCH_TOLERANCE_SECS;
      const frEnd = fr.last_seen + MATCH_TOLERANCE_SECS;

      for (let pi = 0; pi < points.length; pi++) {
        if (assigned[pi] >= 0) continue;
        const ts = points[pi].timestamp;
        if (ts >= frStart && ts <= frEnd) {
          assigned[pi] = ri;
          let arr = recordPoints.get(ri);
          if (!arr) {
            arr = [];
            recordPoints.set(ri, arr);
          }
          arr.push(points[pi]);
        }
      }
    }

    // FlightRecord 매칭된 비행 생성
    for (const [ri, pts] of recordPoints) {
      const fr = matchingRecords[ri];
      const flight = await buildFlight(
        modeS, pts, radarSite, "gap", ac?.name,
        fr.callsign?.trim() || undefined,
        fr.est_departure_airport ?? undefined,
        fr.est_arrival_airport ?? undefined,
        radarName || undefined,
      );
      flights.push(flight);
      await yieldUI();
    }

    // 미매칭 포인트를 4시간 gap으로 분리
    const unmatched = points.filter((_, i) => assigned[i] < 0);
    if (unmatched.length > 0) {
      const groups = splitByGap(unmatched, GAP_THRESHOLD_SECS);
      for (const group of groups) {
        const flight = await buildFlight(modeS, group, radarSite, "gap", ac?.name,
          undefined, undefined, undefined, radarName || undefined);
        flights.push(flight);
        await yieldUI();
      }
    }
  }

  // 시간순 정렬
  flights.sort((a, b) => a.start_time - b.start_time);

  return flights;
}

/** TrackPoint 배열에서 Flight 객체 생성 */
async function buildFlight(
  modeS: string,
  points: TrackPoint[],
  radarSite: RadarSite,
  matchType: "gap" | "manual",
  aircraftName?: string,
  callsign?: string,
  departure?: string,
  arrival?: string,
  radarName?: string,
): Promise<Flight> {
  points.sort((a, b) => a.timestamp - b.timestamp);

  // 이상고도 보정 (앞뒤 정상 포인트 기준 선형 보간)
  const { points: correctedPoints, correctedCount } = await correctAnomalousAltitudes(points);
  if (correctedCount > 0) {
    console.log(`[고도보정] ${modeS}: ${correctedCount}개 포인트 보정됨`);
  }

  if (correctedPoints.length === 0) {
    return {
      id: `${modeS}_0`,
      mode_s: modeS,
      aircraft_name: aircraftName,
      callsign, departure_airport: departure, arrival_airport: arrival,
      start_time: 0, end_time: 0,
      track_points: [], loss_points: [], loss_segments: [],
      total_loss_time: 0, total_track_time: 0, loss_percentage: 0,
      max_radar_range_km: 0, match_type: matchType, radar_name: radarName,
      point_count: 0,
      bbox: { minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 },
      radar_type_counts: {},
    };
  }

  const { lossPoints, lossSegments, maxRadarRangeKm } = await detectLoss(
    correctedPoints, radarSite.latitude, radarSite.longitude,
  );

  const startTime = correctedPoints[0].timestamp;
  const endTime = correctedPoints[correctedPoints.length - 1].timestamp;
  const totalTrackTime = endTime - startTime;

  // gap별 고유 지속시간 합산 (signal_loss만)
  const gapDurations = new Map<string, number>();
  for (const lp of lossPoints) {
    if (lp.loss_type === "out_of_range") continue;
    const key = `${lp.mode_s}_${lp.gap_start_time}`;
    if (!gapDurations.has(key)) gapDurations.set(key, lp.gap_duration_secs);
  }
  const totalLossTime = Array.from(gapDurations.values()).reduce((s, d) => s + d, 0);

  const lossPercentage = totalTrackTime > 0 ? (totalLossTime / totalTrackTime) * 100 : 0;

  return {
    id: `${modeS}_${startTime}`,
    mode_s: modeS,
    aircraft_name: aircraftName,
    callsign,
    departure_airport: departure,
    arrival_airport: arrival,
    start_time: startTime,
    end_time: endTime,
    track_points: correctedPoints,
    loss_points: lossPoints,
    loss_segments: lossSegments,
    total_loss_time: totalLossTime,
    total_track_time: totalTrackTime,
    loss_percentage: lossPercentage,
    max_radar_range_km: maxRadarRangeKm,
    match_type: matchType,
    radar_name: radarName,
    point_count: correctedPoints.length,
    bbox: computeBbox(correctedPoints),
    radar_type_counts: computeRadarTypeCounts(correctedPoints),
  };
}

/** 포인트 배열에서 경위도 바운딩 박스 계산 */
function computeBbox(points: TrackPoint[]) {
  const bbox = { minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity };
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.latitude < bbox.minLat) bbox.minLat = p.latitude;
    if (p.latitude > bbox.maxLat) bbox.maxLat = p.latitude;
    if (p.longitude < bbox.minLon) bbox.minLon = p.longitude;
    if (p.longitude > bbox.maxLon) bbox.maxLon = p.longitude;
  }
  return points.length === 0 ? { minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 } : bbox;
}

/** 포인트 배열에서 레이더 탐지 유형별 카운트 */
function computeRadarTypeCounts(points: TrackPoint[]) {
  const counts: Record<string, number> = {};
  for (let i = 0; i < points.length; i++) {
    const rt = points[i].radar_type;
    counts[rt] = (counts[rt] ?? 0) + 1;
  }
  return counts;
}

/**
 * 수동 병합: 선택된 Flight들을 하나로 합침.
 * - track_points 합산 후 시간순 정렬
 * - loss 재탐지
 * - callsign/공항 정보는 가장 먼저 존재하는 값 사용
 */
export async function manualMergeFlights(
  selectedFlights: Flight[],
  radarSite: RadarSite,
): Promise<Flight> {
  // 시간순으로 정렬
  const sorted = [...selectedFlights].sort((a, b) => a.start_time - b.start_time);

  // 모든 track_points 합산
  const allPoints = sorted.flatMap((f) => f.track_points);
  const modeS = sorted[0].mode_s;

  // 메타 정보: 첫 번째로 존재하는 값 사용
  const aircraftName = sorted.find((f) => f.aircraft_name)?.aircraft_name;
  const callsign = sorted.find((f) => f.callsign)?.callsign;
  const departure = sorted.find((f) => f.departure_airport)?.departure_airport;
  const arrival = [...sorted].reverse().find((f) => f.arrival_airport)?.arrival_airport;

  const radarNameVal = sorted.find((f) => f.radar_name)?.radar_name;
  return await buildFlight(
    modeS, allPoints, radarSite, "manual", aircraftName,
    callsign, departure, arrival, radarNameVal,
  );
}

/** 정렬된 포인트를 gap 기준으로 분리 */
function splitByGap(points: TrackPoint[], gapSecs: number): TrackPoint[][] {
  if (points.length === 0) return [];
  const groups: TrackPoint[][] = [[points[0]]];
  for (let i = 1; i < points.length; i++) {
    const gap = points[i].timestamp - points[i - 1].timestamp;
    if (gap >= gapSecs) {
      groups.push([points[i]]);
    } else {
      groups[groups.length - 1].push(points[i]);
    }
  }
  return groups;
}
