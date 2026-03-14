import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { X, Save, Loader2 } from "lucide-react";
import { useAppStore } from "../../store";
import type { ElevationPoint, LOSProfileData, RadarSite } from "../../types";

const R_EARTH_M = 6_371_000;
const R_EFF_M = R_EARTH_M * (4 / 3); // 4/3 유효 지구 반경

interface Props {
  radarSite: RadarSite;
  targetLat: number;
  targetLon: number;
  onClose: () => void;
}

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

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos((lat2 * Math.PI) / 180);
  const x =
    Math.cos((lat1 * Math.PI) / 180) * Math.sin((lat2 * Math.PI) / 180) -
    Math.sin((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function interpolate(
  lat1: number, lon1: number, lat2: number, lon2: number, t: number
): [number, number] {
  return [lat1 + (lat2 - lat1) * t, lon1 + (lon2 - lon1) * t];
}

/** 4/3 유효지구 곡률 보정량 (m). 조정 프레임에서 지형을 낮추는 양 */
function curvDrop(dKm: number): number {
  const dM = dKm * 1000;
  return (dM * dM) / (2 * R_EFF_M);
}

/** 실제 지구 곡률 보정량 (m). 굴절 없는 직선 전파 경로 계산용 */
function curvDropReal(dKm: number): number {
  const dM = dKm * 1000;
  return (dM * dM) / (2 * R_EARTH_M);
}

export default function LOSProfilePanel({ radarSite, targetLat, targetLon, onClose }: Props) {
  const addLOSResult = useAppStore((s) => s.addLOSResult);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<ElevationPoint[]>([]);
  const [peakName, setPeakName] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const totalDist = haversine(radarSite.latitude, radarSite.longitude, targetLat, targetLon);
  const bearing = bearingDeg(radarSite.latitude, radarSite.longitude, targetLat, targetLon);
  const radarHeight = radarSite.altitude + radarSite.antenna_height;

  // 고도 프로파일 API 호출
  useEffect(() => {
    let cancelled = false;
    const fetchElevation = async () => {
      setLoading(true);
      const numSamples = 150;
      const lats: number[] = [];
      const lons: number[] = [];
      for (let i = 0; i <= numSamples; i++) {
        const t = i / numSamples;
        const [lat, lon] = interpolate(
          radarSite.latitude, radarSite.longitude, targetLat, targetLon, t
        );
        lats.push(Math.round(lat * 10000) / 10000);
        lons.push(Math.round(lon * 10000) / 10000);
      }

      try {
        const batchSize = 100;
        const allElevations: number[] = [];
        for (let start = 0; start < lats.length; start += batchSize) {
          const batchLats = lats.slice(start, start + batchSize);
          const batchLons = lons.slice(start, start + batchSize);
          const url = `https://api.open-meteo.com/v1/elevation?latitude=${batchLats.join(",")}&longitude=${batchLons.join(",")}`;
          const resp = await fetch(url);
          if (!resp.ok) throw new Error(`Elevation API: ${resp.status}`);
          const data = await resp.json();
          allElevations.push(...data.elevation);
        }

        if (cancelled) return;

        const points: ElevationPoint[] = lats.map((lat, i) => ({
          distance: haversine(radarSite.latitude, radarSite.longitude, lat, lons[i]),
          elevation: Math.max(0, allElevations[i] ?? 0),
          latitude: lat,
          longitude: lons[i],
        }));
        setProfile(points);

        // 최대 차단점 산 이름 조회
        const D = haversine(radarSite.latitude, radarSite.longitude, targetLat, targetLon);
        const adjTarget = points[points.length - 1].elevation - curvDrop(D);
        let maxBlockIdx = -1;
        let maxBlockExcess = -Infinity;
        for (let i = 1; i < points.length - 1; i++) {
          const d = points[i].distance;
          const adjTerrain = points[i].elevation - curvDrop(d);
          const losH = radarHeight + (adjTarget - radarHeight) * (d / D);
          const excess = adjTerrain - losH;
          if (excess > maxBlockExcess) {
            maxBlockExcess = excess;
            maxBlockIdx = i;
          }
        }

        if (maxBlockExcess > 0 && maxBlockIdx >= 0) {
          const peakLat = points[maxBlockIdx].latitude;
          const peakLon = points[maxBlockIdx].longitude;
          try {
            const overpassUrl = `https://overpass-api.de/api/interpreter?data=[out:json];node["natural"="peak"](around:3000,${peakLat},${peakLon});out body;`;
            const peakResp = await fetch(overpassUrl);
            if (peakResp.ok) {
              const peakData = await peakResp.json();
              if (peakData.elements?.length > 0) {
                let closest = peakData.elements[0];
                let closestDist = Infinity;
                for (const el of peakData.elements) {
                  const d2 = haversine(peakLat, peakLon, el.lat, el.lon);
                  if (d2 < closestDist) {
                    closestDist = d2;
                    closest = el;
                  }
                }
                const name = closest.tags?.["name:ko"] || closest.tags?.name || undefined;
                if (!cancelled) setPeakName(name);
              }
            }
          } catch {
            // 산 이름 조회 실패 - 비치명적
          }
        }
      } catch (err) {
        console.error("Elevation fetch failed:", err);
        if (!cancelled) {
          const points: ElevationPoint[] = lats.map((lat, i) => ({
            distance: haversine(radarSite.latitude, radarSite.longitude, lat, lons[i]),
            elevation: 0,
            latitude: lat,
            longitude: lons[i],
          }));
          setProfile(points);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchElevation();
    return () => { cancelled = true; };
  }, [radarSite, targetLat, targetLon, totalDist]);

  // ── 차트 데이터: 모든 요소를 4/3 조정 프레임에서 계산 ──
  const chartData = useMemo(() => {
    if (profile.length === 0) return null;

    const D = totalDist;
    const targetElev = profile[profile.length - 1].elevation;
    const adjTarget = targetElev - curvDrop(D);

    // 1) 조정 지형 (지구곡률 반영 → 지형이 거리에 따라 아래로 처짐)
    const adjTerrain = profile.map((p) => ({
      distance: p.distance,
      height: p.elevation - curvDrop(p.distance),
    }));

    // 2) 최저 탐지가능 높이 - 4/3 굴절 적용 (조정 프레임에서 직선 그림자 전파)
    const minDetRefracted = profile.map((p, idx) => {
      const d = p.distance;
      if (idx === 0) return { distance: d, height: radarHeight };

      let maxShadow = radarHeight;
      for (let i = 1; i < idx; i++) {
        const di = profile[i].distance;
        if (di <= 0) continue;
        const adjH = profile[i].elevation - curvDrop(di);
        // 굴절 빔: 조정 프레임에서 직선 그림자 연장
        const shadow = radarHeight + (adjH - radarHeight) * (d / di);
        if (shadow > maxShadow) maxShadow = shadow;
      }

      return {
        distance: d,
        height: Math.max(adjTerrain[idx].height, maxShadow),
      };
    });

    // 3) 최저 탐지가능 높이 - 직선 LOS (굴절 미반영)
    //    실제 지구(R) 프레임에서 직선 그림자 → 4/3 조정 프레임으로 변환
    const minDetStraight = profile.map((p, idx) => {
      const d = p.distance;
      if (idx === 0) return { distance: d, height: radarHeight };

      let maxShadow = radarHeight;
      for (let i = 1; i < idx; i++) {
        const di = profile[i].distance;
        if (di <= 0) continue;
        // 실제 지구곡률(R) 기준 장애물 높이 보정
        const realEarthH = profile[i].elevation - curvDropReal(di);
        // 실제 지구 프레임에서 직선 그림자 연장
        const shadowRealFrame = radarHeight + (realEarthH - radarHeight) * (d / di);
        // 실제 지구 프레임 → 4/3 조정 프레임 변환 (프레임 차이 보정)
        const shadowAdj = shadowRealFrame + curvDropReal(d) - curvDrop(d);
        if (shadowAdj > maxShadow) maxShadow = shadowAdj;
      }

      return {
        distance: d,
        height: Math.max(adjTerrain[idx].height, maxShadow),
      };
    });

    // 4) 0.25° BRA 기준선 (조정 프레임에서 직선 = 4/3 굴절 빔 경로)
    const BRA_DEG = 0.25;
    const braLine = profile.map((p) => ({
      distance: p.distance,
      height: radarHeight + p.distance * 1000 * Math.tan((BRA_DEG * Math.PI) / 180),
    }));

    // 차단 판정 (조정 프레임에서 지형 vs 굴절선)
    const losRefractedH = (d: number) =>
      radarHeight + (adjTarget - radarHeight) * (d / D);
    let blocked = false;
    let maxBlockPoint: {
      distance: number;
      adjHeight: number;
      realElevation: number;
      name?: string;
    } | null = null;
    let maxExcess = 0;
    for (let i = 1; i < profile.length - 1; i++) {
      const excess = adjTerrain[i].height - losRefractedH(profile[i].distance);
      if (excess > maxExcess) {
        maxExcess = excess;
        blocked = true;
        maxBlockPoint = {
          distance: profile[i].distance,
          adjHeight: adjTerrain[i].height,
          realElevation: profile[i].elevation,
          name: peakName,
        };
      }
    }

    // Y축 범위
    const allHeights = [
      radarHeight,
      ...adjTerrain.map((p) => p.height),
      ...minDetRefracted.map((p) => p.height),
      ...minDetStraight.map((p) => p.height),
      ...braLine.map((p) => p.height),
    ];
    const maxY = Math.max(...allHeights) + 100;
    const minY = Math.min(0, ...adjTerrain.map((p) => p.height)) - 50;

    return {
      adjTerrain,
      minDetRefracted,
      minDetStraight,
      braLine,
      blocked,
      maxBlockPoint,
      minY,
      maxY,
      maxDistance: D,
      adjTarget,
      targetElev,
    };
  }, [profile, radarHeight, totalDist, peakName]);

  const handleSave = () => {
    if (!chartData) return;
    const result: LOSProfileData = {
      id: `los-${Date.now()}`,
      radarSiteName: radarSite.name,
      radarLat: radarSite.latitude,
      radarLon: radarSite.longitude,
      radarHeight,
      targetLat,
      targetLon,
      bearing,
      totalDistance: totalDist,
      elevationProfile: profile,
      losBlocked: chartData.blocked,
      maxBlockingPoint: chartData.maxBlockPoint
        ? {
            distance: chartData.maxBlockPoint.distance,
            elevation: chartData.maxBlockPoint.realElevation,
            name: chartData.maxBlockPoint.name,
          }
        : undefined,
      timestamp: Date.now(),
    };
    addLOSResult(result);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  // 마우스 이동 핸들러 (SVG 좌표 → 거리)
  const handleSvgMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * 900; // viewBox 기준 X
    setHoverX(svgX);
  }, []);
  const handleSvgMouseLeave = useCallback(() => setHoverX(null), []);

  // 호버 위치의 상세 데이터 계산
  const hoverData = useMemo(() => {
    if (hoverX === null || !chartData || profile.length === 0) return null;
    const { adjTerrain, minDetRefracted, minDetStraight, minY, maxY, maxDistance } = chartData;

    const PAD_LEFT = 65;
    const PAD_RIGHT = 30;
    const cw = 900 - PAD_LEFT - PAD_RIGHT;
    const dist = ((hoverX - PAD_LEFT) / cw) * maxDistance;
    if (dist < 0 || dist > maxDistance) return null;

    // 프로파일에서 보간하여 값 계산
    let terrainH = 0;
    let realElev = 0;
    let refractedH = 0;
    let straightH = 0;
    for (let i = 1; i < adjTerrain.length; i++) {
      if (adjTerrain[i].distance >= dist) {
        const t = (dist - adjTerrain[i - 1].distance) / (adjTerrain[i].distance - adjTerrain[i - 1].distance);
        terrainH = adjTerrain[i - 1].height + t * (adjTerrain[i].height - adjTerrain[i - 1].height);
        realElev = profile[i - 1].elevation + t * (profile[i].elevation - profile[i - 1].elevation);
        refractedH = minDetRefracted[i - 1].height + t * (minDetRefracted[i].height - minDetRefracted[i - 1].height);
        straightH = minDetStraight[i - 1].height + t * (minDetStraight[i].height - minDetStraight[i - 1].height);
        break;
      }
    }

    return { dist, terrainH, realElev, refractedH, straightH, minY, maxY };
  }, [hoverX, chartData, profile]);

  // ── SVG 차트 ──
  const W = 900;
  const H = 280;
  const PAD = { top: 20, right: 30, bottom: 30, left: 65 };
  const cw = W - PAD.left - PAD.right;
  const ch = H - PAD.top - PAD.bottom;

  const renderChart = () => {
    if (!chartData) return null;
    const {
      adjTerrain, minDetRefracted, minDetStraight, braLine,
      maxBlockPoint, minY, maxY, maxDistance,
    } = chartData;

    const xScale = (d: number) => PAD.left + (d / maxDistance) * cw;
    const yScale = (h: number) => PAD.top + ch - ((h - minY) / (maxY - minY)) * ch;

    // 지형 채우기
    const terrainFill =
      `M ${xScale(0)} ${yScale(minY)} ` +
      adjTerrain.map((p) => `L ${xScale(p.distance)} ${yScale(p.height)}`).join(" ") +
      ` L ${xScale(maxDistance)} ${yScale(minY)} Z`;

    // 지형 윤곽선
    const terrainLine = adjTerrain
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.distance)} ${yScale(p.height)}`)
      .join(" ");

    // 최저 탐지가능 높이 (4/3 굴절)
    const minDetRefPath = minDetRefracted
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.distance)} ${yScale(p.height)}`)
      .join(" ");

    // 최저 탐지가능 높이 (직선 LOS)
    const minDetStrPath = minDetStraight
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.distance)} ${yScale(p.height)}`)
      .join(" ");

    // BRA 0.25° 기준선
    const braPath = braLine
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.distance)} ${yScale(p.height)}`)
      .join(" ");

    // Y축 눈금
    const yRange = maxY - minY;
    const yStep = yRange > 3000 ? 500 : yRange > 1500 ? 200 : yRange > 500 ? 100 : 50;
    const yTicks: number[] = [];
    for (let y = Math.ceil(minY / yStep) * yStep; y <= maxY; y += yStep) yTicks.push(y);

    // X축 눈금
    const xStep = maxDistance > 100 ? 20 : maxDistance > 50 ? 10 : maxDistance > 20 ? 5 : 2;
    const xTicks: number[] = [];
    for (let x = 0; x <= maxDistance; x += xStep) xTicks.push(x);

    return (
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minHeight: 220 }}
        onMouseMove={handleSvgMouseMove} onMouseLeave={handleSvgMouseLeave}>
        <defs>
          <linearGradient id="terrainGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22c55e" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#22c55e" stopOpacity="0.05" />
          </linearGradient>
        </defs>

        {/* 그리드 */}
        {yTicks.map((y) => (
          <g key={`y-${y}`}>
            <line x1={PAD.left} y1={yScale(y)} x2={W - PAD.right} y2={yScale(y)}
              stroke={y === 0 ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.06)"} strokeWidth={y === 0 ? 1 : 0.5} />
            <text x={PAD.left - 5} y={yScale(y) + 3} textAnchor="end"
              fill="rgba(255,255,255,0.4)" fontSize={9}>
              {y}m
            </text>
          </g>
        ))}
        {xTicks.map((x) => (
          <g key={`x-${x}`}>
            <line x1={xScale(x)} y1={PAD.top} x2={xScale(x)} y2={H - PAD.bottom}
              stroke="rgba(255,255,255,0.06)" strokeWidth={0.5} />
            <text x={xScale(x)} y={H - PAD.bottom + 14} textAnchor="middle"
              fill="rgba(255,255,255,0.4)" fontSize={9}>
              {x}km
            </text>
          </g>
        ))}

        {/* 지형 채우기 */}
        <path d={terrainFill} fill="url(#terrainGrad)" />

        {/* 지형 윤곽선 */}
        <path d={terrainLine} fill="none" stroke="#22c55e" strokeWidth={1.5} />

        {/* 최저 탐지가능 높이 - 직선 LOS (굴절 미반영) */}
        <path d={minDetStrPath} fill="none"
          stroke="rgba(255,255,255,0.4)" strokeWidth={1.2} strokeDasharray="6 3" />

        {/* 최저 탐지가능 높이 - 4/3 굴절 적용 */}
        <path d={minDetRefPath} fill="none"
          stroke="#f59e0b" strokeWidth={1.8} />

        {/* 0.25° BRA 기준선 */}
        <path d={braPath} fill="none"
          stroke="#22d3ee" strokeWidth={1} strokeDasharray="8 4" />
        <text
          x={xScale(maxDistance) - 4}
          y={yScale(braLine[braLine.length - 1].height) - 5}
          textAnchor="end" fill="#22d3ee" fontSize={9} fontWeight="bold">
          BRA
        </text>

        {/* 레이더 포인트 */}
        <circle cx={xScale(0)} cy={yScale(radarHeight)} r={4}
          fill="#3b82f6" stroke="white" strokeWidth={1} />
        <text x={xScale(0) + 6} y={yScale(radarHeight) - 6}
          fill="white" fontSize={9} fontWeight="bold">
          {radarSite.name} ({radarHeight.toFixed(0)}m)
        </text>

        {/* 차단점 */}
        {maxBlockPoint && (
          <>
            <circle
              cx={xScale(maxBlockPoint.distance)}
              cy={yScale(maxBlockPoint.adjHeight)}
              r={4} fill="#e94560" stroke="white" strokeWidth={1} />
            <text
              x={xScale(maxBlockPoint.distance)}
              y={yScale(maxBlockPoint.adjHeight) - 10}
              textAnchor="middle" fill="white" fontSize={9} fontWeight="bold">
              {maxBlockPoint.name
                ? `${maxBlockPoint.name} (${maxBlockPoint.realElevation.toFixed(0)}m)`
                : `${maxBlockPoint.realElevation.toFixed(0)}m`}
            </text>
          </>
        )}

        {/* 범례 (왼쪽 위) */}
        <g transform={`translate(${PAD.left + 8}, ${PAD.top + 5})`}>
          <rect x={-4} y={-6} width={234} height={52} rx={4} fill="rgba(0,0,0,0.5)" />
          <line x1={0} y1={0} x2={20} y2={0}
            stroke="#f59e0b" strokeWidth={1.8} />
          <text x={24} y={3} fill="rgba(255,255,255,0.7)" fontSize={8}>
            최저 탐지가능 높이 (4/3 전파굴절 적용)
          </text>
          <line x1={0} y1={14} x2={20} y2={14}
            stroke="rgba(255,255,255,0.4)" strokeWidth={1.2} strokeDasharray="6 3" />
          <text x={24} y={17} fill="rgba(255,255,255,0.7)" fontSize={8}>
            최저 탐지가능 높이 (직선 LOS)
          </text>
          <line x1={0} y1={28} x2={20} y2={28}
            stroke="#22d3ee" strokeWidth={1} strokeDasharray="8 4" />
          <text x={24} y={31} fill="rgba(255,255,255,0.7)" fontSize={8}>
            BRA (0.25° 기준선)
          </text>
          <line x1={0} y1={42} x2={20} y2={42} stroke="#22c55e" strokeWidth={1.5} />
          <text x={24} y={45} fill="rgba(255,255,255,0.7)" fontSize={8}>
            지형 (4/3 지구곡률 보정)
          </text>
        </g>

        {/* 인터랙티브 크로스헤어 + 호버 툴팁 */}
        {hoverData && (() => {
          const hXPos = PAD.left + (hoverData.dist / maxDistance) * cw;
          const tooltipW = 165;
          const tooltipH = 90;
          const tooltipX = hXPos + tooltipW + 12 > W ? hXPos - tooltipW - 8 : hXPos + 8;
          const tooltipY = PAD.top + 4;
          return (
            <g>
              {/* 수직 크로스헤어 */}
              <line x1={hXPos} y1={PAD.top} x2={hXPos} y2={H - PAD.bottom}
                stroke="rgba(255,255,255,0.3)" strokeWidth={0.8} strokeDasharray="3 2" />
              {/* 지형 위 인디케이터 */}
              <circle cx={hXPos} cy={yScale(hoverData.terrainH)} r={3}
                fill="#22c55e" stroke="white" strokeWidth={0.8} />
              {/* 굴절선 인디케이터 */}
              <circle cx={hXPos} cy={yScale(hoverData.refractedH)} r={3}
                fill="#f59e0b" stroke="white" strokeWidth={0.8} />
              {/* 직선 LOS 인디케이터 */}
              <circle cx={hXPos} cy={yScale(hoverData.straightH)} r={2.5}
                fill="rgba(255,255,255,0.4)" stroke="white" strokeWidth={0.8} />
              {/* 툴팁 배경 */}
              <rect x={tooltipX} y={tooltipY} width={tooltipW} height={tooltipH}
                rx={4} fill="rgba(13,27,42,0.92)" stroke="rgba(255,255,255,0.15)" strokeWidth={0.5} />
              {/* 툴팁 내용 */}
              <text x={tooltipX + 8} y={tooltipY + 14} fill="rgba(255,255,255,0.5)" fontSize={8}>
                거리: <tspan fill="white" fontWeight="bold">{hoverData.dist.toFixed(1)}km</tspan>
              </text>
              <text x={tooltipX + 8} y={tooltipY + 28} fill="#22c55e" fontSize={8}>
                지형: <tspan fill="rgba(255,255,255,0.8)">{hoverData.realElev.toFixed(0)}m</tspan>
                <tspan fill="rgba(255,255,255,0.4)" fontSize={7}> (보정: {hoverData.terrainH.toFixed(0)}m)</tspan>
              </text>
              <text x={tooltipX + 8} y={tooltipY + 42} fill="#f59e0b" fontSize={8}>
                최저탐지(굴절): <tspan fill="rgba(255,255,255,0.8)">{hoverData.refractedH.toFixed(0)}m</tspan>
              </text>
              <text x={tooltipX + 8} y={tooltipY + 56} fill="rgba(255,255,255,0.4)" fontSize={8}>
                최저탐지(직선): <tspan fill="rgba(255,255,255,0.8)">{hoverData.straightH.toFixed(0)}m</tspan>
              </text>
              <text x={tooltipX + 8} y={tooltipY + 72} fill="rgba(255,255,255,0.5)" fontSize={8}>
                여유고: <tspan fill={hoverData.refractedH - hoverData.terrainH > 0 ? "#10b981" : "#e94560"} fontWeight="bold">
                  {(hoverData.refractedH - hoverData.terrainH).toFixed(0)}m
                </tspan>
              </text>
            </g>
          );
        })()}
      </svg>
    );
  };

  return (
    <div className="border-t border-white/10 bg-[#0d1b2a]">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-white/5 px-4 py-2">
        <span className="text-xs font-semibold text-white">LOS 분석 (4/3 Earth 조정 프레임)</span>
        <span className="text-[10px] text-gray-500">
          {radarSite.name} → {targetLat.toFixed(4)}°N {targetLon.toFixed(4)}°E
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-2 text-[10px] text-gray-400">
          <span>거리: {totalDist.toFixed(1)}km</span>
          <span>방위: {bearing.toFixed(0)}°</span>
          {chartData && (
            <span className={chartData.blocked ? "text-[#e94560]" : "text-emerald-400"}>
              {chartData.blocked ? "LOS 차단" : "LOS 양호"}
            </span>
          )}
          {chartData?.maxBlockPoint?.name && (
            <span className="text-yellow-400">
              차단점: {chartData.maxBlockPoint.name}
            </span>
          )}
        </div>
        <button onClick={handleSave} disabled={loading || saved}
          className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-gray-400 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-50"
          title="보고서에 저장">
          <Save size={12} />
          {saved ? "저장됨" : "저장"}
        </button>
        <button onClick={onClose}
          className="rounded p-1 text-gray-400 transition-colors hover:bg-white/10 hover:text-white">
          <X size={14} />
        </button>
      </div>

      {/* Chart */}
      <div className="px-4 py-2">
        {loading ? (
          <div className="flex h-[220px] items-center justify-center">
            <Loader2 size={20} className="animate-spin text-gray-500" />
            <span className="ml-2 text-xs text-gray-500">고도 데이터 로딩 중...</span>
          </div>
        ) : (
          renderChart()
        )}
      </div>
    </div>
  );
}
