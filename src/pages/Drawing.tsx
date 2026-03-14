import { useMemo, useRef, useEffect, useState, useCallback } from "react";
import { Filter, ChevronDown, Scissors } from "lucide-react";
import { format } from "date-fns";
import { useAppStore } from "../store";
import type { TrackPoint } from "../types";

/** Mode-S+PSR / Mode-S 색상 (차가운 계열) */
const MODES_COLORS: [number, number, number][] = [
  [59, 130, 246], [16, 185, 129], [139, 92, 246], [6, 182, 212],
  [99, 102, 241], [20, 184, 166], [132, 204, 22], [236, 72, 153],
];
/** ATCRBS+PSR / ATCRBS 색상 (따뜻한 계열) */
const ATCRBS_COLORS: [number, number, number][] = [
  [245, 158, 11], [249, 115, 22], [234, 179, 8], [251, 146, 60],
  [217, 119, 6], [245, 101, 101],
];

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

export default function Drawing() {
  const analysisResults = useAppStore((s) => s.analysisResults);
  const aircraft = useAppStore((s) => s.aircraft);
  const radarSite = useAppStore((s) => s.radarSite);
  const selectedModeS = useAppStore((s) => s.selectedModeS);
  const setSelectedModeS = useAppStore((s) => s.setSelectedModeS);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const sideCanvasRef = useRef<HTMLCanvasElement>(null);
  const planCanvasRef = useRef<HTMLCanvasElement>(null);

  // 구간모드
  const [rangeEnabled, setRangeEnabled] = useState(false);
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

  // 포인트 필터링
  const { filteredPoints, colorMap, legendEntries } = useMemo(() => {
    const registeredModeS = new Set(aircraft.filter((a) => a.active).map((a) => a.mode_s_code.toUpperCase()));
    const modeSCounts = new Map<string, number>();
    for (const r of analysisResults) {
      for (const p of r.file_info.track_points) {
        modeSCounts.set(p.mode_s, (modeSCounts.get(p.mode_s) ?? 0) + 1);
      }
    }
    const validModeS = new Set<string>();
    for (const [ms, cnt] of modeSCounts) {
      if (cnt >= 10) validModeS.add(ms);
    }

    const showAll = selectedModeS === "__ALL__";
    const pts: TrackPoint[] = [];
    for (const r of analysisResults) {
      for (const p of r.file_info.track_points) {
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
    let modesIdx = 0;
    let atcrbsIdx = 0;
    const modeSList = [...new Set(pts.map((p) => p.mode_s))];
    for (const ms of modeSList) {
      const sample = pts.find((p) => p.mode_s === ms);
      if (sample && (sample.radar_type === "atcrbs" || sample.radar_type === "atcrbs_psr")) {
        colorMap.set(ms, ATCRBS_COLORS[atcrbsIdx % ATCRBS_COLORS.length]);
        atcrbsIdx++;
      } else {
        colorMap.set(ms, MODES_COLORS[modesIdx % MODES_COLORS.length]);
        modesIdx++;
      }
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
  }, [analysisResults, aircraft, selectedModeS]);

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

  const pctToTs = useCallback(
    (pct: number) => {
      const range = timeRange.max - timeRange.min;
      return timeRange.min + (range * pct) / 100;
    },
    [timeRange]
  );

  const fmtTs = useCallback(
    (ts: number) => (ts > 0 ? format(new Date(ts * 1000), "MM-dd HH:mm:ss") : "--/-- --:--:--"),
    []
  );

  // 구간모드 적용된 포인트
  const displayPoints = useMemo(() => {
    if (!rangeEnabled) return filteredPoints;
    const minTs = pctToTs(rangeStart);
    const maxTs = pctToTs(rangeEnd);
    return filteredPoints.filter((p) => p.timestamp >= minTs && p.timestamp <= maxTs);
  }, [filteredPoints, rangeEnabled, rangeStart, rangeEnd, pctToTs]);

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

  // Mode-S 드롭다운 옵션
  const modeSOptions = useMemo(() => {
    const modeSCounts = new Map<string, number>();
    for (const r of analysisResults) {
      for (const p of r.file_info.track_points) {
        modeSCounts.set(p.mode_s, (modeSCounts.get(p.mode_s) ?? 0) + 1);
      }
    }
    const valid: string[] = [];
    for (const [ms, cnt] of modeSCounts) {
      if (cnt >= 10) valid.push(ms);
    }
    return valid.sort();
  }, [analysisResults]);

  // ── 캔버스 렌더링 ──
  useEffect(() => {
    if (displayPoints.length === 0) return;

    const PAD = 50;
    const DOT_R = 2;
    const radarLat = radarSite.latitude;
    const radarLon = radarSite.longitude;
    const avgLat = radarLat;
    const cosLat = Math.cos((avgLat * Math.PI) / 180);

    // ── 측면도: X=레이더 기준 거리(km), Y=고도(m) ──
    const sideCanvas = sideCanvasRef.current;
    if (sideCanvas) {
      const dpr = window.devicePixelRatio || 1;
      const rect = sideCanvas.getBoundingClientRect();
      sideCanvas.width = rect.width * dpr;
      sideCanvas.height = rect.height * dpr;
      const ctx = sideCanvas.getContext("2d");
      if (ctx) {
        ctx.scale(dpr, dpr);
        const w = rect.width;
        const h = rect.height;
        ctx.clearRect(0, 0, w, h);

        // 거리/고도 범위
        let maxDist = 0;
        let minAlt = Infinity, maxAlt = -Infinity;
        const dists: number[] = [];
        for (const p of displayPoints) {
          const d = haversine(radarLat, radarLon, p.latitude, p.longitude);
          dists.push(d);
          if (d > maxDist) maxDist = d;
          if (p.altitude < minAlt) minAlt = p.altitude;
          if (p.altitude > maxAlt) maxAlt = p.altitude;
        }
        maxDist = Math.max(maxDist, 1);
        const altRange = Math.max(maxAlt - minAlt, 100);
        // 0부터 시작
        minAlt = Math.min(minAlt, 0);

        const cw = w - PAD * 2;
        const ch = h - PAD * 2;
        const xScale = (d: number) => PAD + (d / maxDist) * cw;
        const yScale = (alt: number) => PAD + ch - ((alt - minAlt) / (maxAlt - minAlt + 100)) * ch;

        // 그리드
        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.lineWidth = 0.5;
        const yStep = altRange > 5000 ? 1000 : altRange > 2000 ? 500 : altRange > 500 ? 100 : 50;
        for (let a = Math.ceil(minAlt / yStep) * yStep; a <= maxAlt; a += yStep) {
          const y = yScale(a);
          ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(w - PAD, y); ctx.stroke();
          ctx.fillStyle = "rgba(255,255,255,0.3)";
          ctx.font = "10px sans-serif";
          ctx.textAlign = "right";
          ctx.fillText(`${a.toFixed(0)}m`, PAD - 5, y + 3);
        }
        const xStep = maxDist > 200 ? 50 : maxDist > 100 ? 20 : maxDist > 50 ? 10 : maxDist > 20 ? 5 : 2;
        for (let km = 0; km <= maxDist; km += xStep) {
          const x = xScale(km);
          ctx.beginPath(); ctx.moveTo(x, PAD); ctx.lineTo(x, h - PAD); ctx.stroke();
          ctx.fillStyle = "rgba(255,255,255,0.3)";
          ctx.textAlign = "center";
          ctx.fillText(`${km.toFixed(0)}km`, x, h - PAD + 14);
        }

        // 레이더 위치 수직선
        ctx.strokeStyle = "rgba(59,130,246,0.3)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(xScale(0), PAD); ctx.lineTo(xScale(0), h - PAD); ctx.stroke();
        ctx.setLineDash([]);

        // 축 라벨
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.font = "11px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("레이더 기준 거리 (km)", w / 2, h - 5);
        ctx.save();
        ctx.translate(12, h / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText("고도 (m)", 0, 0);
        ctx.restore();

        // 포인트
        for (let i = 0; i < displayPoints.length; i++) {
          const p = displayPoints[i];
          const c = colorMap.get(p.mode_s) ?? [128, 128, 128];
          ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.7)`;
          ctx.beginPath();
          ctx.arc(xScale(dists[i]), yScale(p.altitude), DOT_R, 0, Math.PI * 2);
          ctx.fill();
        }

        // 레이더 마커
        ctx.fillStyle = "#3b82f6";
        ctx.beginPath();
        ctx.arc(xScale(0), yScale(radarSite.altitude + radarSite.antenna_height), 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.font = "9px sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(radarSite.name, xScale(0) + 6, yScale(radarSite.altitude + radarSite.antenna_height) - 4);

        // 제목
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        ctx.font = "bold 12px sans-serif";
        ctx.textAlign = "left";
        ctx.fillText("측면도", PAD, 16);
      }
    }

    // ── 평면도 (지도 스타일): 위=북, 아래=남, 좌=서, 우=동 ──
    const planCanvas = planCanvasRef.current;
    if (planCanvas) {
      const dpr = window.devicePixelRatio || 1;
      const rect = planCanvas.getBoundingClientRect();
      planCanvas.width = rect.width * dpr;
      planCanvas.height = rect.height * dpr;
      const ctx = planCanvas.getContext("2d");
      if (ctx) {
        ctx.scale(dpr, dpr);
        const w = rect.width;
        const h = rect.height;
        ctx.clearRect(0, 0, w, h);

        // lat/lon 범위 (레이더 포함)
        let minLat = radarLat, maxLat = radarLat;
        let minLon = radarLon, maxLon = radarLon;
        for (const p of displayPoints) {
          if (p.latitude < minLat) minLat = p.latitude;
          if (p.latitude > maxLat) maxLat = p.latitude;
          if (p.longitude < minLon) minLon = p.longitude;
          if (p.longitude > maxLon) maxLon = p.longitude;
        }

        // km 변환 (균일 스케일 유지)
        const latKm = (maxLat - minLat) * 111.32;
        const lonKm = (maxLon - minLon) * 111.32 * cosLat;
        const cw = w - PAD * 2;
        const ch = h - PAD * 2;

        // 균일 스케일: km per pixel (동일 비율 유지 → 지도처럼 보임)
        const dataW = Math.max(lonKm, 1);
        const dataH = Math.max(latKm, 1);
        const scale = Math.min(cw / dataW, ch / dataH);
        const usedW = dataW * scale;
        const usedH = dataH * scale;
        const offsetX = PAD + (cw - usedW) / 2;
        const offsetY = PAD + (ch - usedH) / 2;

        const xScale = (lon: number) => offsetX + ((lon - minLon) * 111.32 * cosLat) * scale;
        const yScale = (lat: number) => offsetY + usedH - ((lat - minLat) * 111.32) * scale;

        // 배경 (지도 느낌)
        ctx.fillStyle = "rgba(10,20,35,0.5)";
        ctx.fillRect(offsetX, offsetY, usedW, usedH);

        // 그리드
        ctx.strokeStyle = "rgba(255,255,255,0.06)";
        ctx.lineWidth = 0.5;
        const gridStep = dataH > 200 ? 50 : dataH > 100 ? 20 : dataH > 50 ? 10 : dataH > 20 ? 5 : 2;
        // 가로 그리드 (위도)
        for (let km = 0; km <= dataH; km += gridStep) {
          const lat = minLat + km / 111.32;
          const y = yScale(lat);
          if (y >= offsetY && y <= offsetY + usedH) {
            ctx.beginPath(); ctx.moveTo(offsetX, y); ctx.lineTo(offsetX + usedW, y); ctx.stroke();
            ctx.fillStyle = "rgba(255,255,255,0.25)";
            ctx.font = "9px sans-serif";
            ctx.textAlign = "right";
            ctx.fillText(`${lat.toFixed(2)}°`, offsetX - 4, y + 3);
          }
        }
        // 세로 그리드 (경도)
        const lonStep = dataW > 200 ? 50 : dataW > 100 ? 20 : dataW > 50 ? 10 : dataW > 20 ? 5 : 2;
        for (let km = 0; km <= dataW; km += lonStep) {
          const lon = minLon + km / (111.32 * cosLat);
          const x = xScale(lon);
          if (x >= offsetX && x <= offsetX + usedW) {
            ctx.beginPath(); ctx.moveTo(x, offsetY); ctx.lineTo(x, offsetY + usedH); ctx.stroke();
            ctx.fillStyle = "rgba(255,255,255,0.25)";
            ctx.textAlign = "center";
            ctx.fillText(`${lon.toFixed(2)}°`, x, offsetY + usedH + 13);
          }
        }

        // 포인트
        for (const p of displayPoints) {
          const c = colorMap.get(p.mode_s) ?? [128, 128, 128];
          ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.7)`;
          ctx.beginPath();
          ctx.arc(xScale(p.longitude), yScale(p.latitude), DOT_R, 0, Math.PI * 2);
          ctx.fill();
        }

        // 레이더 마커
        const rx = xScale(radarLon);
        const ry = yScale(radarLat);
        ctx.fillStyle = "#3b82f6";
        ctx.beginPath();
        ctx.arc(rx, ry, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(59,130,246,0.4)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(rx, ry, 12, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        ctx.font = "9px sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(radarSite.name, rx + 8, ry - 4);

        // 방위 표시 (N)
        ctx.fillStyle = "rgba(255,255,255,0.4)";
        ctx.font = "bold 14px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("N", offsetX + usedW / 2, offsetY - 6);
        // N 화살표
        const nx = offsetX + usedW / 2;
        const ny = offsetY - 14;
        ctx.strokeStyle = "rgba(255,255,255,0.3)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(nx, ny + 6);
        ctx.lineTo(nx, ny - 2);
        ctx.moveTo(nx - 3, ny + 1);
        ctx.lineTo(nx, ny - 2);
        ctx.lineTo(nx + 3, ny + 1);
        ctx.stroke();

        // 제목
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        ctx.font = "bold 12px sans-serif";
        ctx.textAlign = "left";
        ctx.fillText("평면도", PAD, 16);
      }
    }
  }, [displayPoints, colorMap, radarSite]);

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
          <h1 className="text-2xl font-bold text-white">도면</h1>
          <p className="mt-1 text-sm text-gray-400">
            측면도와 평면도를 나란히 표시합니다
          </p>
        </div>

        {/* Mode-S 필터 */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex items-center gap-2 rounded-lg border border-white/10 bg-[#16213e] px-3 py-2 text-sm text-white hover:border-white/20"
          >
            <Filter size={14} />
            <span>{getFilterLabel()}</span>
            <ChevronDown size={14} />
          </button>
          {dropdownOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-64 overflow-auto rounded-lg border border-white/10 bg-[#16213e] py-1 shadow-xl max-h-72">
              <button
                onClick={() => { setSelectedModeS(null); setDropdownOpen(false); }}
                className={`w-full px-3 py-2 text-left text-sm ${!selectedModeS ? "bg-[#e94560]/15 text-[#e94560]" : "text-gray-300 hover:bg-white/5"}`}
              >
                비행검사기 (등록)
              </button>
              {aircraft.filter((a) => a.active).map((a) => (
                <button
                  key={a.id}
                  onClick={() => { setSelectedModeS(a.mode_s_code); setDropdownOpen(false); }}
                  className={`w-full px-3 py-2 text-left text-sm ${selectedModeS === a.mode_s_code ? "bg-[#e94560]/15 text-[#e94560]" : "text-gray-300 hover:bg-white/5"}`}
                >
                  {a.name} ({a.mode_s_code})
                </button>
              ))}
              <div className="my-1 h-px bg-white/10" />
              <button
                onClick={() => { setSelectedModeS("__ALL__"); setDropdownOpen(false); }}
                className={`w-full px-3 py-2 text-left text-sm ${selectedModeS === "__ALL__" ? "bg-[#e94560]/15 text-[#e94560]" : "text-gray-300 hover:bg-white/5"}`}
              >
                전체 항적
              </button>
              {modeSOptions.length > 0 && <div className="my-1 h-px bg-white/10" />}
              {modeSOptions.map((ms) => {
                const ac = aircraft.find((a) => a.mode_s_code.toUpperCase() === ms.toUpperCase());
                return (
                  <button
                    key={ms}
                    onClick={() => { setSelectedModeS(ms); setDropdownOpen(false); }}
                    className={`w-full px-3 py-2 text-left text-sm font-mono ${selectedModeS === ms ? "bg-[#e94560]/15 text-[#e94560]" : "text-gray-300 hover:bg-white/5"}`}
                  >
                    {ac ? `${ac.name} — ${ms}` : ms}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {filteredPoints.length === 0 ? (
        <div className="flex flex-1 items-center justify-center rounded-xl border border-white/10 bg-[#16213e]">
          <p className="text-sm text-gray-400">표시할 항적 데이터가 없습니다</p>
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
                  <span className="text-gray-300">{e.label}</span>
                </div>
              ))}
              <span className="text-gray-500">({displayPoints.length.toLocaleString()} 포인트)</span>
            </div>
          )}

          {/* 캔버스 영역 */}
          <div className="flex flex-1 gap-4 min-h-0">
            <div className="flex-1 rounded-xl border border-white/10 bg-[#0d1b2a] p-2">
              <canvas ref={sideCanvasRef} className="h-full w-full" />
            </div>
            <div className="flex-1 rounded-xl border border-white/10 bg-[#0d1b2a] p-2">
              <canvas ref={planCanvasRef} className="h-full w-full" />
            </div>
          </div>

          {/* 구간모드 슬라이더 */}
          <div className="rounded-xl border border-white/10 bg-[#0d1b2a]">
            <div className="flex items-center gap-3 px-4 py-3">
              <button
                onClick={() => setRangeEnabled(!rangeEnabled)}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  rangeEnabled
                    ? "bg-[#e94560]/20 text-[#e94560]"
                    : "text-gray-500 hover:text-gray-300 border border-white/10"
                }`}
              >
                <Scissors size={12} />
                구간모드
              </button>

              {rangeEnabled && (
                <>
                  <span className="min-w-[110px] text-center font-mono text-xs text-[#e94560]">
                    {fmtTs(pctToTs(rangeStart))}
                  </span>

                  <div
                    ref={rangeBarRef}
                    className="relative flex-1 h-6 select-none"
                    onPointerMove={handleRangeMove}
                    onPointerUp={handleRangeUp}
                  >
                    <div className="absolute left-0 right-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-white/10" />
                    <div
                      className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-[#e94560]/40"
                      style={{ left: `${rangeStart}%`, width: `${rangeEnd - rangeStart}%` }}
                    />
                    <div
                      className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize"
                      style={{ left: `${rangeStart}%` }}
                      onPointerDown={(e) => handleRangePointer(e, "start")}
                    >
                      <div className={`h-4 w-4 rounded-full border-2 transition-colors ${
                        draggingHandle === "start"
                          ? "border-white bg-[#e94560] scale-125"
                          : "border-[#e94560] bg-[#16213e] hover:bg-[#e94560]/50"
                      }`} />
                    </div>
                    <div
                      className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize"
                      style={{ left: `${rangeEnd}%` }}
                      onPointerDown={(e) => handleRangePointer(e, "end")}
                    >
                      <div className={`h-4 w-4 rounded-full border-2 transition-colors ${
                        draggingHandle === "end"
                          ? "border-white bg-[#e94560] scale-125"
                          : "border-[#e94560] bg-[#16213e] hover:bg-[#e94560]/50"
                      }`} />
                    </div>
                  </div>

                  <span className="min-w-[110px] text-center font-mono text-xs text-[#e94560]">
                    {fmtTs(pctToTs(rangeEnd))}
                  </span>

                  <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-[#16213e] px-3 py-1.5">
                    <span className="text-[10px] text-gray-500">구간</span>
                    <span className="font-mono text-xs text-white">
                      {(() => {
                        const durSec = pctToTs(rangeEnd) - pctToTs(rangeStart);
                        const m = Math.floor(durSec / 60);
                        const s = Math.floor(durSec % 60);
                        return `${m}분 ${s}초`;
                      })()}
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
