import { useMemo, useRef, useEffect, useState, useCallback } from "react";
import { Filter, ChevronDown } from "lucide-react";
import { format } from "date-fns";
import MapGL, { Source, Layer, Marker } from "react-map-gl/maplibre";
import { ScatterplotLayer } from "@deck.gl/layers";
import { DeckGLOverlay } from "../components/Map/DeckGLOverlay";
import { useAppStore } from "../store";
import type { TrackPoint } from "../types";
import { GPU2D, type CircleData, type LineData } from "../utils/gpu2d";
import {
  computeMaxDistanceGPU, computeMaxDistanceCPU,
  computeEwDistsGPU, computeEwDistsCPU,
  computeDensityHistogramGPU, computeDensityHistogramCPU,
  type EwDistResult,
} from "../utils/gpuDrawingCompute";

/** 탐지 유형별 색상 (항적지도와 동일) */
const DETECTION_TYPE_COLORS: Record<string, [number, number, number]> = {
  mode_ac:              [234, 179, 8],
  mode_ac_psr:          [234, 179, 8],
  mode_s_allcall:       [56, 189, 248],
  mode_s_allcall_psr:   [132, 204, 22],
  mode_s_rollcall:      [59, 130, 246],
  mode_s_rollcall_psr:  [34, 197, 94],
};

/** 탐지 유형 라벨 */
function radarTypeLabel(rt: string): string {
  switch (rt) {
    case "mode_ac":              return "Mode A/C";
    case "mode_ac_psr":          return "Mode A/C + PSR";
    case "mode_s_allcall":       return "Mode S All-Call";
    case "mode_s_allcall_psr":   return "Mode S All-Call + PSR";
    case "mode_s_rollcall":      return "Mode S Roll-Call";
    case "mode_s_rollcall_psr":  return "Mode S Roll-Call + PSR";
    default:                     return rt.toUpperCase();
  }
}

const KM_TO_NM = 0.539957;
const NM_TO_KM = 1.852;
const M_TO_FT = 3.28084;
const MAP_STYLE = "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json";

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
  const gpuRef = useRef<GPU2D | null>(null);
  const gpuCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // 구간 선택
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(100);
  const [draggingHandle, setDraggingHandle] = useState<"start" | "end" | null>(null);
  const rangeBarRef = useRef<HTMLDivElement>(null);

  // 타임라인 줌 (스크롤로 확대/축소)
  const [zoomView, setZoomView] = useState<[number, number]>([0, 100]);
  const zoomViewRef = useRef<[number, number]>([0, 100]);
  const zoomVStart = zoomView[0];
  const zoomVEnd = zoomView[1];
  const zoomRange = zoomVEnd - zoomVStart;
  const absToScreen = (abs: number) => zoomRange > 0 ? ((abs - zoomVStart) / zoomRange) * 100 : 0;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // GPU2D 정리 (언마운트 시)
  useEffect(() => {
    return () => { gpuRef.current?.dispose(); gpuRef.current = null; };
  }, []);

  // 비행 선택 변경 시 구간 핸들 + 줌 초기화
  useEffect(() => {
    setRangeStart(0);
    setRangeEnd(100);
    zoomViewRef.current = [0, 100];
    setZoomView([0, 100]);
  }, [selectedFlightId]);

  // 타임라인 스크롤 줌
  useEffect(() => {
    const el = rangeBarRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mouseRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const [vs, ve] = zoomViewRef.current;
      const cursorAbs = vs + mouseRatio * (ve - vs);
      const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
      let newRange = Math.max(0.005, Math.min(100, (ve - vs) * factor));
      let ns = cursorAbs - mouseRatio * newRange;
      let ne = ns + newRange;
      if (ns < 0) { ns = 0; ne = Math.min(100, newRange); }
      if (ne > 100) { ne = 100; ns = Math.max(0, 100 - newRange); }
      zoomViewRef.current = [ns, ne];
      setZoomView([ns, ne]);
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  // Mode-S 카운팅 (1회만 수행, filteredPoints + modeSOptions 공유)
  const modeSCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of flights) {
      for (const p of f.track_points) {
        counts.set(p.mode_s, (counts.get(p.mode_s) ?? 0) + 1);
      }
    }
    return counts;
  }, [flights]);

  const validModeS = useMemo(() => {
    const valid = new Set<string>();
    for (const [ms, cnt] of modeSCounts) {
      if (cnt >= 10) valid.add(ms);
    }
    return valid;
  }, [modeSCounts]);

  // 포인트 필터링
  const { filteredPoints, legendEntries } = useMemo(() => {
    const registeredModeS = new Set(aircraft.filter((a) => a.active).map((a) => a.mode_s_code.toUpperCase()));
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

    // 탐지 유형별 색상 매핑 (항적지도와 동일)
    const usedTypes = new Set<string>();
    for (const p of pts) usedTypes.add(p.radar_type);

    const legendEntries = Array.from(usedTypes)
      .sort()
      .map((rt) => ({
        radarType: rt,
        label: radarTypeLabel(rt),
        color: DETECTION_TYPE_COLORS[rt] ?? [128, 128, 128] as [number, number, number],
      }));

    return { filteredPoints: pts, legendEntries };
  }, [flights, aircraft, selectedModeS, validModeS]);

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
      const scrPct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
      // 화면 좌표 → 절대 좌표 변환
      const [vs, ve] = zoomViewRef.current;
      const absPct = Math.max(0, Math.min(100, vs + (scrPct / 100) * (ve - vs)));
      if (draggingHandle === "start") {
        setRangeStart(Math.min(absPct, rangeEnd - 0.5));
      } else {
        setRangeEnd(Math.max(absPct, rangeStart + 0.5));
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

  // Mode-S 드롭다운 옵션 (등록 항공기 제외, 공유된 modeSCounts 재사용)
  const modeSOptions = useMemo(() => {
    const valid: string[] = [];
    for (const ms of validModeS) {
      if (!registeredModeSSet.has(ms.toUpperCase())) valid.push(ms);
    }
    return valid.sort();
  }, [validModeS, registeredModeSSet]);

  // 비행 선택 시 해당 비행 전체 포인트 (구간 미적용, 맵 뷰/줌 고정용)
  const flightBasePoints = useMemo(() => {
    if (!selectedFlightId) return filteredPoints;
    const flight = filteredFlights.find((f) => f.id === selectedFlightId);
    return flight ? flight.track_points : filteredPoints;
  }, [selectedFlightId, filteredFlights, filteredPoints]);

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

  // ── WebGPU 계산용 사전 추출 배열 (포인트 변경 시 1회 생성) ──
  const { lonsArray, timestampsArray } = useMemo(() => {
    const n = flightFilteredPoints.length;
    const latLon = new Float32Array(n * 2);
    const lons = new Float32Array(n);
    const ts = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = flightFilteredPoints[i];
      latLon[i * 2] = p.latitude;
      latLon[i * 2 + 1] = p.longitude;
      lons[i] = p.longitude;
      ts[i] = p.timestamp;
    }
    return { latLonArray: latLon, lonsArray: lons, timestampsArray: ts };
  }, [flightFilteredPoints]);

  // flightBasePoints용 latLon (planViewState + rangeRings에서 사용)
  const baseLatLonArray = useMemo(() => {
    const n = flightBasePoints.length;
    const arr = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      arr[i * 2] = flightBasePoints[i].latitude;
      arr[i * 2 + 1] = flightBasePoints[i].longitude;
    }
    return arr;
  }, [flightBasePoints]);

  // ── 측면도: ewDists GPU/CPU 비동기 계산 ──
  const [ewDistResult, setEwDistResult] = useState<EwDistResult | null>(null);

  useEffect(() => {
    if (flightFilteredPoints.length === 0) { setEwDistResult(null); return; }
    const cosLat = Math.cos((radarSite.latitude * Math.PI) / 180);
    let cancelled = false;

    computeEwDistsGPU(radarSite.longitude, cosLat, lonsArray).then((gpuResult) => {
      if (cancelled) return;
      if (gpuResult) {
        setEwDistResult(gpuResult);
      } else {
        // CPU 폴백
        setEwDistResult(computeEwDistsCPU(radarSite.longitude, cosLat, flightFilteredPoints));
      }
    });

    return () => { cancelled = true; };
  }, [flightFilteredPoints, lonsArray, radarSite.latitude, radarSite.longitude]);

  // ── 측면도 캔버스 렌더링 (ewDistResult 준비 후 실행) ──
  useEffect(() => {
    if (!ewDistResult || flightFilteredPoints.length === 0) return;

    const PAD = 50;
    const DOT_R = 2;
    const { ewDists, minEW, maxEW } = ewDistResult;

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

    // 고도 범위
    let minAlt = Infinity, maxAlt = -Infinity;
    for (const p of flightFilteredPoints) {
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

    // GPU 초기화 (lazy-init)
    const gpuCanvas = gpuCanvasRef.current;
    if (gpuCanvas && !gpuRef.current) {
      try { gpuRef.current = new GPU2D(gpuCanvas); } catch { /* WebGL2 불가 시 무시 */ }
    }
    const gpu = gpuRef.current;

    if (gpu) {
      gpu.setResolution(w, h);
      gpu.syncSize(w, h);
      gpu.clear();

      // ── 그리드 라인 (GPU) ──
      const gridLines: LineData[] = [];
      const gridColor: [number, number, number, number] = [0, 0, 0, 0.08];

      const altRangeFt = (maxAlt - minAlt) * M_TO_FT;
      const yStepFt = altRangeFt > 30000 ? 5000 : altRangeFt > 15000 ? 2000 : altRangeFt > 5000 ? 1000 : altRangeFt > 1500 ? 500 : 100;
      for (let ft = Math.ceil(minAltFt / yStepFt) * yStepFt; ft <= maxAltFt; ft += yStepFt) {
        const y = yScale(ft / M_TO_FT);
        gridLines.push({ x1: PAD, y1: y, x2: w - PAD, y2: y, width: 0.5, color: gridColor });
      }

      const maxAbsEW_NM = maxAbsEW * KM_TO_NM;
      const ewStepNM = maxAbsEW_NM > 100 ? 20 : maxAbsEW_NM > 50 ? 10 : maxAbsEW_NM > 20 ? 5 : maxAbsEW_NM > 10 ? 2 : 1;
      for (let nm = -Math.ceil(maxAbsEW_NM / ewStepNM) * ewStepNM; nm <= maxAbsEW_NM; nm += ewStepNM) {
        const x = xScale(nm * NM_TO_KM);
        if (x < PAD || x > w - PAD) continue;
        gridLines.push({ x1: x, y1: PAD, x2: x, y2: h - PAD, width: 0.5, color: gridColor });
      }

      const dashLen = 4, gapLen = 4;
      const radarLineColor: [number, number, number, number] = [59 / 255, 130 / 255, 246 / 255, 0.3];
      for (let y = PAD; y < h - PAD; y += dashLen + gapLen) {
        const yEnd = Math.min(y + dashLen, h - PAD);
        gridLines.push({ x1: centerX, y1: y, x2: centerX, y2: yEnd, width: 1, color: radarLineColor });
      }

      gpu.drawLines(gridLines);

      // ── 포인트 (GPU) ──
      const circles: CircleData[] = [];
      for (let i = 0; i < flightFilteredPoints.length; i++) {
        const p = flightFilteredPoints[i];
        const c = DETECTION_TYPE_COLORS[p.radar_type] ?? [128, 128, 128];
        circles.push({
          x: xScale(ewDists[i]),
          y: yScale(p.altitude),
          r: DOT_R,
          fill: [c[0] / 255, c[1] / 255, c[2] / 255, 0.7],
          stroke: [0, 0, 0, 0],
          strokeWidth: 0,
        });
      }
      circles.push({
        x: centerX,
        y: yScale(radarSite.altitude + radarSite.antenna_height),
        r: 4,
        fill: [59 / 255, 130 / 255, 246 / 255, 1],
        stroke: [0, 0, 0, 0],
        strokeWidth: 0,
      });
      gpu.drawCircles(circles);
      gpu.flush();
    } else {
      // GPU 불가 시 Canvas 2D 폴백
      ctx.strokeStyle = "rgba(0,0,0,0.08)";
      ctx.lineWidth = 0.5;
      const altRangeFt = (maxAlt - minAlt) * M_TO_FT;
      const yStepFt = altRangeFt > 30000 ? 5000 : altRangeFt > 15000 ? 2000 : altRangeFt > 5000 ? 1000 : altRangeFt > 1500 ? 500 : 100;
      for (let ft = Math.ceil(minAltFt / yStepFt) * yStepFt; ft <= maxAltFt; ft += yStepFt) {
        const y = yScale(ft / M_TO_FT);
        ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(w - PAD, y); ctx.stroke();
      }
      const maxAbsEW_NM = maxAbsEW * KM_TO_NM;
      const ewStepNM = maxAbsEW_NM > 100 ? 20 : maxAbsEW_NM > 50 ? 10 : maxAbsEW_NM > 20 ? 5 : maxAbsEW_NM > 10 ? 2 : 1;
      for (let nm = -Math.ceil(maxAbsEW_NM / ewStepNM) * ewStepNM; nm <= maxAbsEW_NM; nm += ewStepNM) {
        const x = xScale(nm * NM_TO_KM);
        if (x < PAD || x > w - PAD) continue;
        ctx.beginPath(); ctx.moveTo(x, PAD); ctx.lineTo(x, h - PAD); ctx.stroke();
      }
      ctx.strokeStyle = "rgba(59,130,246,0.3)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(centerX, PAD); ctx.lineTo(centerX, h - PAD); ctx.stroke();
      ctx.setLineDash([]);
      for (let i = 0; i < flightFilteredPoints.length; i++) {
        const p = flightFilteredPoints[i];
        const c = DETECTION_TYPE_COLORS[p.radar_type] ?? [128, 128, 128];
        ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.7)`;
        ctx.beginPath();
        ctx.arc(xScale(ewDists[i]), yScale(p.altitude), DOT_R, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = "rgba(59,130,246,1)";
      ctx.beginPath();
      ctx.arc(centerX, yScale(radarSite.altitude + radarSite.antenna_height), 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // ── 텍스트 라벨 (Canvas 2D) ──
    const altRangeFtLabel = (maxAlt - minAlt) * M_TO_FT;
    const yStepFtLabel = altRangeFtLabel > 30000 ? 5000 : altRangeFtLabel > 15000 ? 2000 : altRangeFtLabel > 5000 ? 1000 : altRangeFtLabel > 1500 ? 500 : 100;
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    for (let ft = Math.ceil(minAltFt / yStepFtLabel) * yStepFtLabel; ft <= maxAltFt; ft += yStepFtLabel) {
      const y = yScale(ft / M_TO_FT);
      ctx.fillText(`${ft.toLocaleString()}`, PAD - 5, y + 3);
    }
    const maxAbsEW_NM_label = maxAbsEW * KM_TO_NM;
    const ewStepNMLabel = maxAbsEW_NM_label > 100 ? 20 : maxAbsEW_NM_label > 50 ? 10 : maxAbsEW_NM_label > 20 ? 5 : maxAbsEW_NM_label > 10 ? 2 : 1;
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.textAlign = "center";
    for (let nm = -Math.ceil(maxAbsEW_NM_label / ewStepNMLabel) * ewStepNMLabel; nm <= maxAbsEW_NM_label; nm += ewStepNMLabel) {
      const x = xScale(nm * NM_TO_KM);
      if (x < PAD || x > w - PAD) continue;
      ctx.fillText(nm === 0 ? "0" : `${Math.abs(nm)}`, x, h - PAD + 14);
    }

    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("거리 (NM)", w / 2, h - 5);
    ctx.save();
    ctx.translate(12, h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("고도 (ft)", 0, 0);
    ctx.restore();

    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(radarSite.name, centerX + 6, yScale(radarSite.altitude + radarSite.antenna_height) - 4);
  }, [ewDistResult, flightFilteredPoints, radarSite]);

  // ── 평면도: 최대 거리 GPU/CPU 비동기 계산 (planViewState + rangeRings 공유) ──
  const [maxDistKm, setMaxDistKm] = useState(0);

  useEffect(() => {
    if (flightBasePoints.length === 0) { setMaxDistKm(0); return; }
    let cancelled = false;

    computeMaxDistanceGPU(radarSite.latitude, radarSite.longitude, baseLatLonArray).then((gpuResult) => {
      if (cancelled) return;
      if (gpuResult !== null) {
        setMaxDistKm(gpuResult);
      } else {
        // CPU 폴백
        setMaxDistKm(computeMaxDistanceCPU(radarSite.latitude, radarSite.longitude, flightBasePoints));
      }
    });

    return () => { cancelled = true; };
  }, [flightBasePoints, baseLatLonArray, radarSite.latitude, radarSite.longitude]);

  const planViewState = useMemo(() => {
    if (flightBasePoints.length === 0) {
      return { longitude: radarSite.longitude, latitude: radarSite.latitude, zoom: 8 };
    }
    // 항적 포인트 + 레이더 사이트의 바운딩 박스 계산
    let minLat = radarSite.latitude, maxLat = radarSite.latitude;
    let minLon = radarSite.longitude, maxLon = radarSite.longitude;
    for (const p of flightBasePoints) {
      if (p.latitude < minLat) minLat = p.latitude;
      if (p.latitude > maxLat) maxLat = p.latitude;
      if (p.longitude < minLon) minLon = p.longitude;
      if (p.longitude > maxLon) maxLon = p.longitude;
    }
    const centerLat = (minLat + maxLat) / 2;
    const centerLon = (minLon + maxLon) / 2;
    const latSpan = Math.max(maxLat - minLat, 0.01);
    const lonSpan = Math.max(maxLon - minLon, 0.01);
    // 위도/경도 범위 중 큰 쪽 기준으로 줌 계산 (여유 1.3배)
    const maxSpan = Math.max(latSpan, lonSpan * Math.cos((centerLat * Math.PI) / 180)) * 1.3;
    const zoom = Math.max(4, Math.min(13, Math.log2(180 / maxSpan)));
    return { longitude: centerLon, latitude: centerLat, zoom };
  }, [flightBasePoints, radarSite]);

  // ── 평면도: deck.gl ScatterplotLayer (GeoJSON Feature 객체 생성 제거) ──
  const deckLayers = useMemo(() => {
    if (flightFilteredPoints.length === 0) return [];
    return [
      new ScatterplotLayer<TrackPoint>({
        id: "drawing-track-dots",
        data: flightFilteredPoints,
        getPosition: (d) => [d.longitude, d.latitude],
        getFillColor: (d) => {
          const c = DETECTION_TYPE_COLORS[d.radar_type] ?? [128, 128, 128];
          return [...c, 180] as [number, number, number, number];
        },
        getRadius: 2,
        radiusMinPixels: 1.5,
        radiusMaxPixels: 4,
        radiusUnits: "pixels" as const,
      }),
    ];
  }, [flightFilteredPoints]);

  const { rangeRingsGeoJSON, ringLabelsGeoJSON } = useMemo(() => {
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
  }, [maxDistKm, radarSite]);

  const mapKey = useMemo(
    () => `${radarSite.latitude}-${radarSite.longitude}-${selectedFlightId ?? "all"}`,
    [radarSite, selectedFlightId]
  );

  // ── 타임라인 밀도 바 — WebGPU/CPU 비동기 계산 ──
  const [densityBuckets, setDensityBuckets] = useState<number[]>([]);

  useEffect(() => {
    const range = selectedFlightId ? displayTimeRange : timeRange;
    const pts = selectedFlightId
      ? (filteredFlights.find((f) => f.id === selectedFlightId)?.track_points ?? filteredPoints)
      : filteredPoints;
    if (pts.length === 0 || range.max <= range.min) { setDensityBuckets([]); return; }
    const fullSpan = range.max - range.min;
    const viewMinTs = range.min + (zoomVStart / 100) * fullSpan;
    const viewMaxTs = range.min + (zoomVEnd / 100) * fullSpan;
    if (viewMaxTs <= viewMinTs) { setDensityBuckets([]); return; }

    let cancelled = false;
    const NUM_BUCKETS = 200;

    // timestamps 배열 생성 (선택 비행이면 해당 비행용, 아니면 공유 배열)
    const tsArr = selectedFlightId
      ? (() => { const a = new Float32Array(pts.length); for (let i = 0; i < pts.length; i++) a[i] = pts[i].timestamp; return a; })()
      : timestampsArray;

    computeDensityHistogramGPU(tsArr, viewMinTs, viewMaxTs, NUM_BUCKETS).then((gpuResult) => {
      if (cancelled) return;
      if (gpuResult) {
        setDensityBuckets(gpuResult);
      } else {
        setDensityBuckets(computeDensityHistogramCPU(pts, viewMinTs, viewMaxTs, NUM_BUCKETS));
      }
    });

    return () => { cancelled = true; };
  }, [filteredPoints, filteredFlights, selectedFlightId, timeRange, displayTimeRange, zoomVStart, zoomVEnd, timestampsArray]);

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
          {/* 범례 (탐지 유형별, 항적지도와 동일) */}
          {legendEntries.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 text-xs">
              {legendEntries.map((e) => (
                <div key={e.radarType} className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-[3px] w-4 rounded-sm"
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
              <div className="relative h-full w-full">
                <canvas ref={sideCanvasRef} className="absolute inset-0 h-full w-full" />
                <canvas ref={gpuCanvasRef} className="absolute inset-0 h-full w-full pointer-events-none" />
              </div>
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
                <DeckGLOverlay layers={deckLayers} />
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
                <div className="text-[9px] text-gray-300">{fmtDate(displayPctToTs(zoomVStart))}</div>
                <div className="text-[10px] text-gray-500">{fmtTime(displayPctToTs(zoomVStart))}</div>
              </div>

              <div
                ref={rangeBarRef}
                className="relative flex-1 h-8 select-none cursor-crosshair"
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
                  {absToScreen(rangeStart) > 0 && (
                    <div className="absolute top-0 bottom-0 left-0 bg-gray-200/60"
                      style={{ width: `${Math.max(0, absToScreen(rangeStart))}%` }} />
                  )}
                  {absToScreen(rangeEnd) < 100 && (
                    <div className="absolute top-0 bottom-0 right-0 bg-gray-200/60"
                      style={{ width: `${Math.max(0, 100 - absToScreen(rangeEnd))}%` }} />
                  )}
                </div>
                {/* 구간 핸들 - 시작 */}
                <div
                  className="absolute top-0 bottom-0 -translate-x-1/2 cursor-ew-resize z-10 w-3"
                  style={{ left: `${absToScreen(rangeStart)}%` }}
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
                  style={{ left: `${absToScreen(rangeEnd)}%` }}
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
                <div className="text-[9px] text-gray-300">{fmtDate(displayPctToTs(zoomVEnd))}</div>
                <div className="text-[10px] text-gray-500">{fmtTime(displayPctToTs(zoomVEnd))}</div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
