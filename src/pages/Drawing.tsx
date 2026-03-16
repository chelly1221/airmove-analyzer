import { useMemo, useRef, useEffect, useState, useCallback } from "react";
import { Filter, ChevronDown } from "lucide-react";
import { format } from "date-fns";
import MapGL, { Source, Layer, Marker } from "react-map-gl/maplibre";
import { useAppStore } from "../store";
import type { TrackPoint } from "../types";

/** 항공기별 색상 팔레트 */
const AIRCRAFT_COLORS: [number, number, number][] = [
  [59, 130, 246], [16, 185, 129], [139, 92, 246], [6, 182, 212],
  [249, 115, 22], [236, 72, 153], [132, 204, 22], [245, 158, 11],
  [99, 102, 241], [20, 184, 166],
];

const KM_TO_NM = 0.539957;
const NM_TO_KM = 1.852;
const M_TO_FT = 3.28084;
const MAP_STYLE = "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json";

/** Haversine distance (km) */
function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** 동심원 좌표 생성 */
function circleCoords(lat: number, lon: number, radiusKm: number, steps = 64): [number, number][] {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const coords: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * 2 * Math.PI;
    coords.push([
      lon + (radiusKm / (111.32 * cosLat)) * Math.sin(angle),
      lat + (radiusKm / 111.32) * Math.cos(angle),
    ]);
  }
  return coords;
}

export default function Drawing() {
  const allFlights = useAppStore((s) => s.flights);
  const aircraft = useAppStore((s) => s.aircraft);
  const radarSite = useAppStore((s) => s.radarSite);
  const flights = useMemo(
    () => allFlights.filter((f) => !f.radar_name || f.radar_name === radarSite.name),
    [allFlights, radarSite.name],
  );
  const selectedModeS = useAppStore((s) => s.selectedModeS);
  const setSelectedModeS = useAppStore((s) => s.setSelectedModeS);
  const selectedFlightId = useAppStore((s) => s.selectedFlightId);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const sideCanvasRef = useRef<HTMLCanvasElement>(null);

  // 구간 선택
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(100);
  const [draggingHandle, setDraggingHandle] = useState<"start" | "end" | null>(null);
  const rangeBarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // 비행 선택 변경 시 구간 핸들 초기화
  useEffect(() => {
    setRangeStart(0);
    setRangeEnd(100);
  }, [selectedFlightId]);

  // 포인트 필터링
  const { filteredPoints, colorMap, legendEntries } = useMemo(() => {
    const registeredModeS = new Set(aircraft.filter((a) => a.active).map((a) => a.mode_s_code.toUpperCase()));
    const modeSCounts = new Map<string, number>();
    for (const f of flights) {
      for (const p of f.track_points) {
        modeSCounts.set(p.mode_s, (modeSCounts.get(p.mode_s) ?? 0) + 1);
      }
    }
    const validModeS = new Set<string>();
    for (const [ms, cnt] of modeSCounts) {
      if (cnt >= 10) validModeS.add(ms);
    }

    const showAll = selectedModeS === "__ALL__";
    const pts: TrackPoint[] = [];
    for (const f of flights) {
      for (const p of f.track_points) {
        if (!validModeS.has(p.mode_s)) continue;
        if (showAll) { pts.push(p); }
        else if (!selectedModeS) {
          if (registeredModeS.has(p.mode_s.toUpperCase())) pts.push(p);
        } else {
          if (p.mode_s === selectedModeS) pts.push(p);
        }
      }
    }

    const colorMap = new Map<string, [number, number, number]>();
    let acIdx = 0;
    const modeSList = [...new Set(pts.map((p) => p.mode_s))].sort((a, b) => {
      const acA = aircraft.find((ac) => ac.mode_s_code.toUpperCase() === a.toUpperCase());
      const acB = aircraft.find((ac) => ac.mode_s_code.toUpperCase() === b.toUpperCase());
      if (acA && acB) return acA.name.localeCompare(acB.name, "ko");
      if (acA) return -1;
      if (acB) return 1;
      return a.localeCompare(b);
    });
    for (const ms of modeSList) {
      colorMap.set(ms, AIRCRAFT_COLORS[acIdx % AIRCRAFT_COLORS.length]);
      acIdx++;
    }

    const legendEntries = modeSList.map((ms) => {
      const ac = aircraft.find((a) => a.mode_s_code.toUpperCase() === ms.toUpperCase());
      return {
        modeS: ms,
        label: ac ? `${ac.name} (${ms})` : ms,
        color: colorMap.get(ms) ?? [128, 128, 128],
      };
    });

    return { filteredPoints: pts, colorMap, legendEntries };
  }, [flights, aircraft, selectedModeS]);

  // 시간 범위
  const timeRange = useMemo(() => {
    if (filteredPoints.length === 0) return { min: 0, max: 0 };
    let min = Infinity, max = -Infinity;
    for (const p of filteredPoints) {
      if (p.timestamp < min) min = p.timestamp;
      if (p.timestamp > max) max = p.timestamp;
    }
    return { min, max };
  }, [filteredPoints]);

  // Mode-S 필터 적용된 비행 목록
  const filteredFlights = useMemo(() => {
    const registeredModeS = new Set(aircraft.filter((a) => a.active).map((a) => a.mode_s_code.toUpperCase()));
    const showAll = selectedModeS === "__ALL__";
    return flights.filter((f) => {
      if (showAll) return true;
      if (!selectedModeS) return registeredModeS.has(f.mode_s.toUpperCase());
      return f.mode_s === selectedModeS;
    });
  }, [flights, aircraft, selectedModeS]);

  // 비행 선택 시 해당 비행의 시간 범위로 표시 (앞뒤 1시간 여유)
  const displayTimeRange = useMemo(() => {
    const pts = selectedFlightId
      ? (filteredFlights.find((f) => f.id === selectedFlightId)?.track_points ?? [])
      : filteredPoints;
    if (pts.length === 0) return { min: 0, max: 0 };
    let min = Infinity, max = -Infinity;
    for (const p of pts) {
      if (p.timestamp < min) min = p.timestamp;
      if (p.timestamp > max) max = p.timestamp;
    }
    // 비행 선택 시 앞뒤 1시간 여유
    if (selectedFlightId) {
      min -= 3600;
      max += 3600;
    }
    return { min, max };
  }, [selectedFlightId, filteredFlights, filteredPoints]);

  const pctToTs = useCallback(
    (pct: number) => timeRange.min + ((timeRange.max - timeRange.min) * pct) / 100,
    [timeRange]
  );

  const displayPctToTs = useCallback(
    (pct: number) => displayTimeRange.min + ((displayTimeRange.max - displayTimeRange.min) * pct) / 100,
    [displayTimeRange]
  );

  const fmtDate = useCallback(
    (ts: number) => (ts > 0 ? format(new Date(ts * 1000), "yyyy-MM-dd") : "----/--/--"),
    []
  );
  const fmtTime = useCallback(
    (ts: number) => (ts > 0 ? format(new Date(ts * 1000), "HH:mm:ss") : "--:--:--"),
    []
  );

  // 구간 적용된 포인트
  const displayPoints = useMemo(() => {
    if (rangeStart <= 0 && rangeEnd >= 100) return filteredPoints;
    const minTs = pctToTs(rangeStart);
    const maxTs = pctToTs(rangeEnd);
    return filteredPoints.filter((p) => p.timestamp >= minTs && p.timestamp <= maxTs);
  }, [filteredPoints, rangeStart, rangeEnd, pctToTs]);

  // 구간모드 드래그 핸들러
  const handleRangePointer = useCallback(
    (e: React.PointerEvent, handle: "start" | "end") => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      setDraggingHandle(handle);
    },
    []
  );
  const handleRangeMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingHandle || !rangeBarRef.current) return;
      const rect = rangeBarRef.current.getBoundingClientRect();
      const pct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
      if (draggingHandle === "start") {
        setRangeStart(Math.min(pct, rangeEnd - 0.5));
      } else {
        setRangeEnd(Math.max(pct, rangeStart + 0.5));
      }
    },
    [draggingHandle, rangeStart, rangeEnd]
  );
  const handleRangeUp = useCallback(() => {
    setDraggingHandle(null);
  }, []);

  // 등록 항공기 Mode-S 세트
  const registeredModeSSet = useMemo(
    () => new Set(aircraft.filter((a) => a.active).map((a) => a.mode_s_code.toUpperCase())),
    [aircraft]
  );

  // Mode-S 드롭다운 옵션 (등록 항공기 제외)
  const modeSOptions = useMemo(() => {
    const modeSCounts = new Map<string, number>();
    for (const f of flights) {
      for (const p of f.track_points) {
        modeSCounts.set(p.mode_s, (modeSCounts.get(p.mode_s) ?? 0) + 1);
      }
    }
    const valid: string[] = [];
    for (const [ms, cnt] of modeSCounts) {
      if (cnt >= 10 && !registeredModeSSet.has(ms.toUpperCase())) valid.push(ms);
    }
    return valid.sort();
  }, [flights, registeredModeSSet]);

  // 비행 선택 시 해당 비행만 필터 + 구간 선택 적용, 선택 해제 시 전체
  const flightFilteredPoints = useMemo(() => {
    if (!selectedFlightId) return displayPoints;
    const flight = filteredFlights.find((f) => f.id === selectedFlightId);
    if (!flight) return displayPoints;
    let pts = flight.track_points;
    // 구간 선택 적용 (displayTimeRange 기준)
    if (rangeStart > 0 || rangeEnd < 100) {
      const minTs = displayPctToTs(rangeStart);
      const maxTs = displayPctToTs(rangeEnd);
      pts = pts.filter((p) => p.timestamp >= minTs && p.timestamp <= maxTs);
    }
    return pts;
  }, [selectedFlightId, filteredFlights, displayPoints, rangeStart, rangeEnd, displayPctToTs]);

  // ── 측면도 캔버스 (NM / ft) ──
  useEffect(() => {
    if (flightFilteredPoints.length === 0) return;

    const PAD = 50;
    const DOT_R = 2;
    const radarLat = radarSite.latitude;
    const radarLon = radarSite.longitude;
    const cosLat = Math.cos((radarLat * Math.PI) / 180);

    const sideCanvas = sideCanvasRef.current;
    if (!sideCanvas) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = sideCanvas.getBoundingClientRect();
    sideCanvas.width = rect.width * dpr;
    sideCanvas.height = rect.height * dpr;
    const ctx = sideCanvas.getContext("2d");
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);

    // 동서 거리(km) 및 고도(m) 범위
    let minEW = 0, maxEW = 0;
    let minAlt = Infinity, maxAlt = -Infinity;
    const ewDists: number[] = [];
    for (const p of flightFilteredPoints) {
      const dEW = (p.longitude - radarLon) * 111.32 * cosLat;
      ewDists.push(dEW);
      if (dEW < minEW) minEW = dEW;
      if (dEW > maxEW) maxEW = dEW;
      if (p.altitude < minAlt) minAlt = p.altitude;
      if (p.altitude > maxAlt) maxAlt = p.altitude;
    }
    const maxAbsEW = Math.max(Math.abs(minEW), Math.abs(maxEW), 1);
    minAlt = Math.min(minAlt, 0);
    const minAltFt = minAlt * M_TO_FT;
    const maxAltFt = maxAlt * M_TO_FT;

    const cw = w - PAD * 2;
    const ch = h - PAD * 2;
    const centerX = PAD + cw / 2;
    const xScale = (dEW: number) => centerX - (dEW / maxAbsEW) * (cw / 2);
    const yScale = (alt: number) => PAD + ch - ((alt - minAlt) / (maxAlt - minAlt + 100)) * ch;

    // 그리드 - 고도 (ft)
    ctx.strokeStyle = "rgba(0,0,0,0.08)";
    ctx.lineWidth = 0.5;
    const altRangeFt = (maxAlt - minAlt) * M_TO_FT;
    const yStepFt = altRangeFt > 30000 ? 5000 : altRangeFt > 15000 ? 2000 : altRangeFt > 5000 ? 1000 : altRangeFt > 1500 ? 500 : 100;
    for (let ft = Math.ceil(minAltFt / yStepFt) * yStepFt; ft <= maxAltFt; ft += yStepFt) {
      const altM = ft / M_TO_FT;
      const y = yScale(altM);
      ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(w - PAD, y); ctx.stroke();
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(`${ft.toLocaleString()}`, PAD - 5, y + 3);
    }

    // 그리드 - 동서 거리 (NM)
    const maxAbsEW_NM = maxAbsEW * KM_TO_NM;
    const ewStepNM = maxAbsEW_NM > 100 ? 20 : maxAbsEW_NM > 50 ? 10 : maxAbsEW_NM > 20 ? 5 : maxAbsEW_NM > 10 ? 2 : 1;
    for (let nm = -Math.ceil(maxAbsEW_NM / ewStepNM) * ewStepNM; nm <= maxAbsEW_NM; nm += ewStepNM) {
      const km = nm * NM_TO_KM;
      const x = xScale(km);
      if (x < PAD || x > w - PAD) continue;
      ctx.beginPath(); ctx.moveTo(x, PAD); ctx.lineTo(x, h - PAD); ctx.stroke();
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.textAlign = "center";
      ctx.fillText(nm === 0 ? "0" : `${Math.abs(nm)}`, x, h - PAD + 14);
    }

    // 레이더 위치 수직선 (중앙)
    ctx.strokeStyle = "rgba(59,130,246,0.3)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(centerX, PAD); ctx.lineTo(centerX, h - PAD); ctx.stroke();
    ctx.setLineDash([]);

    // 축 라벨
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("거리 (NM)", w / 2, h - 5);
    ctx.save();
    ctx.translate(12, h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("고도 (ft)", 0, 0);
    ctx.restore();

    // 포인트
    for (let i = 0; i < flightFilteredPoints.length; i++) {
      const p = flightFilteredPoints[i];
      const c = colorMap.get(p.mode_s) ?? [128, 128, 128];
      ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.7)`;
      ctx.beginPath();
      ctx.arc(xScale(ewDists[i]), yScale(p.altitude), DOT_R, 0, Math.PI * 2);
      ctx.fill();
    }

    // 레이더 마커 (중앙)
    ctx.fillStyle = "#3b82f6";
    ctx.beginPath();
    ctx.arc(centerX, yScale(radarSite.altitude + radarSite.antenna_height), 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(radarSite.name, centerX + 6, yScale(radarSite.altitude + radarSite.antenna_height) - 4);

    // (제목 없음 — 탭 타이틀로 충분)
  }, [flightFilteredPoints, colorMap, radarSite]);

  // ── 평면도 지도 데이터 ──
  const planViewState = useMemo(() => {
    if (flightFilteredPoints.length === 0) {
      return { longitude: radarSite.longitude, latitude: radarSite.latitude, zoom: 8 };
    }
    let maxDist = 0;
    for (const p of flightFilteredPoints) {
      const d = haversine(radarSite.latitude, radarSite.longitude, p.latitude, p.longitude);
      if (d > maxDist) maxDist = d;
    }
    maxDist = Math.max(maxDist, 1);
    const zoom = Math.max(4, Math.min(13, Math.log2(40000 / (maxDist * 2.5))));
    return { longitude: radarSite.longitude, latitude: radarSite.latitude, zoom };
  }, [flightFilteredPoints, radarSite]);

  const trackPointsGeoJSON = useMemo((): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: flightFilteredPoints.map((p) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [p.longitude, p.latitude] },
      properties: { mode_s: p.mode_s },
    })),
  }), [flightFilteredPoints]);

  const { rangeRingsGeoJSON, ringLabelsGeoJSON } = useMemo(() => {
    let maxDistKm = 0;
    for (const p of flightFilteredPoints) {
      const d = haversine(radarSite.latitude, radarSite.longitude, p.latitude, p.longitude);
      if (d > maxDistKm) maxDistKm = d;
    }
    const maxDistNM = Math.max(maxDistKm * KM_TO_NM, 1);
    const ringStepNM = maxDistNM > 100 ? 20 : maxDistNM > 50 ? 10 : maxDistNM > 20 ? 5 : maxDistNM > 10 ? 2 : 1;

    const ringFeatures: GeoJSON.Feature[] = [];
    const labelFeatures: GeoJSON.Feature[] = [];
    for (let nm = ringStepNM; nm <= maxDistNM * 1.1; nm += ringStepNM) {
      const coords = circleCoords(radarSite.latitude, radarSite.longitude, nm * NM_TO_KM);
      ringFeatures.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: coords },
        properties: {},
      });
      // 라벨: 동쪽 점 (step 16/64)
      labelFeatures.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: coords[16] },
        properties: { label: `${nm} NM` },
      });
    }

    return {
      rangeRingsGeoJSON: { type: "FeatureCollection" as const, features: ringFeatures },
      ringLabelsGeoJSON: { type: "FeatureCollection" as const, features: labelFeatures },
    };
  }, [flightFilteredPoints, radarSite]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const colorExpression = useMemo((): any => {
    if (colorMap.size === 0) return "rgb(128,128,128)";
    const expr: unknown[] = ["match", ["get", "mode_s"]];
    for (const [ms, c] of colorMap) {
      expr.push(ms, `rgb(${c[0]},${c[1]},${c[2]})`);
    }
    expr.push("rgb(128,128,128)");
    return expr;
  }, [colorMap]);

  const mapKey = useMemo(
    () => `${radarSite.latitude}-${radarSite.longitude}-${flightFilteredPoints.length}-${selectedFlightId ?? "all"}`,
    [radarSite, flightFilteredPoints.length, selectedFlightId]
  );

  // 타임라인 밀도 바 — 비행 선택 시 해당 비행 포인트 기준 (displayTimeRange)
  const densityBuckets = useMemo(() => {
    const range = selectedFlightId ? displayTimeRange : timeRange;
    const pts = selectedFlightId
      ? (filteredFlights.find((f) => f.id === selectedFlightId)?.track_points ?? filteredPoints)
      : filteredPoints;
    if (pts.length === 0 || range.max <= range.min) return [];
    const NUM_BUCKETS = 200;
    const buckets = new Array(NUM_BUCKETS).fill(0);
    const span = range.max - range.min;
    for (const p of pts) {
      const idx = Math.min(NUM_BUCKETS - 1, Math.floor(((p.timestamp - range.min) / span) * NUM_BUCKETS));
      if (idx >= 0) buckets[idx]++;
    }
    const maxCount = Math.max(1, ...buckets);
    return buckets.map((c: number) => c / maxCount);
  }, [filteredPoints, filteredFlights, selectedFlightId, timeRange, displayTimeRange]);

  const getFilterLabel = () => {
    if (!selectedModeS) return "비행검사기 (등록)";
    if (selectedModeS === "__ALL__") return "전체 항적";
    const ac = aircraft.find((a) => a.mode_s_code.toUpperCase() === selectedModeS.toUpperCase());
    return ac ? ac.name : selectedModeS;
  };

  return (
    <div className="flex h-full flex-col space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">도면</h1>
          <p className="mt-1 text-sm text-gray-500">
            측면도와 평면도를 나란히 표시합니다
          </p>
        </div>

        {/* Mode-S 필터 */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800 hover:border-gray-300"
          >
            <Filter size={14} />
            <span>{getFilterLabel()}</span>
            <ChevronDown size={14} />
          </button>
          {dropdownOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-64 overflow-auto rounded-lg border border-gray-200 bg-gray-50 py-1 shadow-xl max-h-72">
              <button
                onClick={() => { setSelectedModeS(null); setDropdownOpen(false); }}
                className={`w-full px-3 py-2 text-left text-sm ${!selectedModeS ? "bg-[#a60739] text-white" : "text-gray-600 hover:bg-gray-100"}`}
              >
                비행검사기 (등록)
              </button>
              {aircraft.filter((a) => a.active).map((a) => (
                <button
                  key={a.id}
                  onClick={() => { setSelectedModeS(a.mode_s_code); setDropdownOpen(false); }}
                  className={`w-full px-3 py-2 text-left text-sm ${selectedModeS === a.mode_s_code ? "bg-[#a60739] text-white" : "text-gray-600 hover:bg-gray-100"}`}
                >
                  {a.name} ({a.mode_s_code})
                </button>
              ))}
              <div className="my-1 h-px bg-gray-200" />
              <button
                onClick={() => { setSelectedModeS("__ALL__"); setDropdownOpen(false); }}
                className={`w-full px-3 py-2 text-left text-sm ${selectedModeS === "__ALL__" ? "bg-[#a60739] text-white" : "text-gray-600 hover:bg-gray-100"}`}
              >
                전체 항적
              </button>
              {modeSOptions.length > 0 && <div className="my-1 h-px bg-gray-200" />}
              {modeSOptions.map((ms) => (
                <button
                  key={ms}
                  onClick={() => { setSelectedModeS(ms); setDropdownOpen(false); }}
                  className={`w-full px-3 py-2 text-left text-sm font-mono ${selectedModeS === ms ? "bg-[#a60739] text-white" : "text-gray-600 hover:bg-gray-100"}`}
                >
                  {ms}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {filteredPoints.length === 0 ? (
        <div className="flex flex-1 items-center justify-center rounded-xl border border-gray-200 bg-gray-50">
          <p className="text-sm text-gray-500">표시할 항적 데이터가 없습니다</p>
        </div>
      ) : (
        <>
          {/* 범례 */}
          {legendEntries.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 text-xs">
              {legendEntries.map((e) => (
                <div key={e.modeS} className="flex items-center gap-1.5">
                  <div
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: `rgb(${e.color[0]},${e.color[1]},${e.color[2]})` }}
                  />
                  <span className="text-gray-600">{e.label}</span>
                </div>
              ))}
              <span className="text-gray-500">({flightFilteredPoints.length.toLocaleString()} 포인트)</span>
            </div>
          )}

          {/* 캔버스 + 지도 영역 */}
          <div className="flex flex-1 gap-4 min-h-0">
            {/* 측면도 */}
            <div className="flex-1 rounded-xl border border-gray-200 bg-gray-100 p-2">
              <canvas ref={sideCanvasRef} className="h-full w-full" />
            </div>
            {/* 평면도 (지도 오버레이) */}
            <div className="flex-1 rounded-xl border border-gray-200 overflow-hidden">
              <MapGL
                key={mapKey}
                initialViewState={planViewState}
                mapStyle={MAP_STYLE}
                style={{ width: "100%", height: "100%" }}
                attributionControl={false}
              >
                <Source id="range-rings" type="geojson" data={rangeRingsGeoJSON}>
                  <Layer
                    id="range-ring-lines"
                    type="line"
                    paint={{ "line-color": "rgba(0,0,0,0.15)", "line-width": 1, "line-dasharray": [4, 4] }}
                  />
                </Source>
                <Source id="ring-labels" type="geojson" data={ringLabelsGeoJSON}>
                  <Layer
                    id="ring-label-text"
                    type="symbol"
                    layout={{
                      "text-field": ["get", "label"],
                      "text-size": 10,
                      "text-anchor": "left",
                      "text-offset": [0.5, 0],
                      "text-allow-overlap": true,
                    }}
                    paint={{
                      "text-color": "rgba(0,0,0,0.4)",
                      "text-halo-color": "white",
                      "text-halo-width": 1,
                    }}
                  />
                </Source>
                <Source id="track-points" type="geojson" data={trackPointsGeoJSON}>
                  <Layer
                    id="track-dots"
                    type="circle"
                    paint={{
                      "circle-radius": 2,
                      "circle-color": colorExpression,
                      "circle-opacity": 0.7,
                    }}
                  />
                </Source>
                <Marker latitude={radarSite.latitude} longitude={radarSite.longitude} anchor="center">
                  <div className="flex h-2.5 w-2.5 items-center justify-center rounded-full bg-blue-500 ring-1 ring-blue-500/30">
                    <div className="h-1 w-1 rounded-full bg-white" />
                  </div>
                </Marker>
              </MapGL>
            </div>
          </div>

          {/* 구간 선택 슬라이더 (밀도 바 포함) */}
          <div className="rounded-xl border border-gray-200 bg-white">
            <div className="flex items-center gap-3 px-4 py-2">
              <div className="min-w-[62px] text-center font-mono leading-tight">
                <div className="text-[9px] text-gray-300">{fmtDate(displayPctToTs(rangeStart))}</div>
                <div className="text-[10px] text-gray-500">{fmtTime(displayPctToTs(rangeStart))}</div>
              </div>

              <div
                ref={rangeBarRef}
                className="relative flex-1 h-8 select-none"
                onPointerMove={handleRangeMove}
                onPointerUp={handleRangeUp}
              >
                {/* 밀도 바 배경 */}
                <div className="absolute inset-0 flex items-end rounded overflow-hidden bg-gray-100">
                  {densityBuckets.map((v, i) => (
                    <div
                      key={i}
                      className="flex-1"
                      style={{
                        height: `${Math.max(v > 0 ? 10 : 0, v * 100)}%`,
                        backgroundColor: `rgba(166,7,57,${0.15 + v * 0.35})`,
                      }}
                    />
                  ))}
                </div>
                {/* 선택 구간 하이라이트 */}
                <div className="absolute inset-0 rounded overflow-hidden pointer-events-none">
                  {rangeStart > 0 && (
                    <div className="absolute top-0 bottom-0 left-0 bg-gray-200/60"
                      style={{ width: `${rangeStart}%` }} />
                  )}
                  {rangeEnd < 100 && (
                    <div className="absolute top-0 bottom-0 right-0 bg-gray-200/60"
                      style={{ width: `${100 - rangeEnd}%` }} />
                  )}
                </div>
                {/* 구간 핸들 - 시작 */}
                <div
                  className="absolute top-0 bottom-0 -translate-x-1/2 cursor-ew-resize z-10 w-3"
                  style={{ left: `${rangeStart}%` }}
                  onPointerDown={(e) => handleRangePointer(e, "start")}
                >
                  <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-5 w-1.5 rounded-full transition-colors ${
                    draggingHandle === "start"
                      ? "bg-[#a60739] scale-y-125"
                      : "bg-[#a60739]/60 hover:bg-[#a60739]"
                  }`} />
                </div>
                {/* 구간 핸들 - 끝 */}
                <div
                  className="absolute top-0 bottom-0 -translate-x-1/2 cursor-ew-resize z-10 w-3"
                  style={{ left: `${rangeEnd}%` }}
                  onPointerDown={(e) => handleRangePointer(e, "end")}
                >
                  <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-5 w-1.5 rounded-full transition-colors ${
                    draggingHandle === "end"
                      ? "bg-[#a60739] scale-y-125"
                      : "bg-[#a60739]/60 hover:bg-[#a60739]"
                  }`} />
                </div>
              </div>

              <div className="min-w-[62px] text-center font-mono leading-tight">
                <div className="text-[9px] text-gray-300">{fmtDate(displayPctToTs(rangeEnd))}</div>
                <div className="text-[10px] text-gray-500">{fmtTime(displayPctToTs(rangeEnd))}</div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
