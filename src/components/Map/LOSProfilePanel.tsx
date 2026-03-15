import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { X, Save, Loader2 } from "lucide-react";
import { useAppStore } from "../../store";
import type { ElevationPoint, LOSProfileData, RadarSite } from "../../types";

const R_EARTH_M = 6_371_000;
const R_EFF_M = R_EARTH_M * (4 / 3); // 4/3 유효 지구 반경

interface LOSTrackPoint {
  distRatio: number;
  altitude: number;
  mode_s: string;
  timestamp: number;
  radar_type: string;
  isLoss: boolean;
}

interface Props {
  radarSite: RadarSite;
  targetLat: number;
  targetLon: number;
  onClose: () => void;
  /** 차트 호버 시 거리 비율(0~1) 콜백, null이면 호버 해제 */
  onHoverDistance?: (ratio: number | null) => void;
  /** LOS 선상 항적/Loss 포인트 전체 */
  losTrackPoints?: LOSTrackPoint[];
  /** 고도 프로파일 로딩 완료 시 콜백 */
  onLoaded?: () => void;
  /** 차트에서 항적 포인트 하이라이트 시 인덱스 콜백 (null이면 해제) */
  onTrackPointHighlight?: (idx: number | null) => void;
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

/** 디스플레이 프레임 곡률 보정량 (m): 실제 지구반경 기준
 *  → 직선 LOS가 직선으로, 4/3 굴절선이 아래로 휘어 보임 */
function curvDrop(dKm: number): number {
  const dM = dKm * 1000;
  return (dM * dM) / (2 * R_EARTH_M);
}

/** 4/3 유효지구 곡률 보정량 (m): 굴절 전파 계산용 */
function curvDrop43(dKm: number): number {
  const dM = dKm * 1000;
  return (dM * dM) / (2 * R_EFF_M);
}



export default function LOSProfilePanel({ radarSite, targetLat, targetLon, onClose, onHoverDistance, losTrackPoints, onLoaded, onTrackPointHighlight }: Props) {
  const addLOSResult = useAppStore((s) => s.addLOSResult);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<ElevationPoint[]>([]);
  const [peakNames, setPeakNames] = useState<Map<number, string>>(new Map());
  const [saved, setSaved] = useState(false);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  // X축 줌: [시작%, 끝%] (0~100)
  const [xZoom, setXZoom] = useState<[number, number]>([0, 100]);
  const xZoomRef = useRef<[number, number]>([0, 100]);
  const [hoveredTrackIdx, setHoveredTrackIdx] = useState<number | null>(null);
  const [pinnedTrackIdx, setPinnedTrackIdx] = useState<number | null>(null);
  // 드래그 패닝
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartZoom = useRef<[number, number]>([0, 100]);

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

        // 최저 탐지가능 높이 선(굴절)을 실질적으로 가장 크게 올린 산 1개 찾기
        // = 조정 프레임에서 가장 큰 그림자를 만드는 지형점
        let dominantPeakIdx = -1;
        let dominantShadowArea = 0;
        for (let i = 1; i < points.length - 1; i++) {
          const di = points[i].distance;
          if (di <= 0) continue;
          const adjH = points[i].elevation - curvDrop(di);
          if (adjH <= radarHeight) continue;
          // 이 지형점이 만드는 그림자: 뒤쪽 포인트들에서 얼마나 최저선을 올리는지 합산
          let shadowSum = 0;
          for (let j = i + 1; j < points.length; j++) {
            const dj = points[j].distance;
            const shadow = radarHeight + (adjH - radarHeight) * (dj / di);
            const adjTj = points[j].elevation - curvDrop(dj);
            const baseline = Math.max(radarHeight, adjTj);
            if (shadow > baseline) shadowSum += shadow - baseline;
          }
          if (shadowSum > dominantShadowArea) {
            dominantShadowArea = shadowSum;
            dominantPeakIdx = i;
          }
        }

        // 가장 영향력 있는 산 1개만 이름 조회
        if (dominantPeakIdx >= 0 && !cancelled) {
          const peakLat = points[dominantPeakIdx].latitude;
          const peakLon = points[dominantPeakIdx].longitude;
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
                  if (d2 < closestDist) { closestDist = d2; closest = el; }
                }
                const name = closest.tags?.["name:ko"] || closest.tags?.name;
                if (name && !cancelled) setPeakNames(new Map([[dominantPeakIdx, name]]));
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
        if (!cancelled) {
          setLoading(false);
          onLoaded?.();
        }
      }
    };

    fetchElevation();
    return () => { cancelled = true; };
  }, [radarSite, targetLat, targetLon]);

  // ── 차트 데이터: 실제 지구(R) 조정 프레임 — 직선 LOS가 직선으로 표시 ──
  const chartData = useMemo(() => {
    if (profile.length === 0) return null;

    const D = totalDist;
    const targetElev = profile[profile.length - 1].elevation;
    const adjTarget = targetElev - curvDrop(D);

    // 1) 조정 지형 (실제 지구곡률 반영 → 지형이 거리에 따라 아래로 처짐)
    const adjTerrain = profile.map((p) => ({
      distance: p.distance,
      height: p.elevation - curvDrop(p.distance),
    }));

    // 2) 최저 탐지가능 높이 - 직선 LOS (디스플레이 프레임에서 직접 shadow-casting → 직선)
    const minDetStraight = profile.map((p, idx) => {
      const d = p.distance;
      if (idx === 0) return { distance: d, height: radarHeight };

      let maxShadow = radarHeight;
      for (let i = 1; i < idx; i++) {
        const di = profile[i].distance;
        if (di <= 0) continue;
        const adjH = profile[i].elevation - curvDrop(di);
        const shadow = radarHeight + (adjH - radarHeight) * (d / di);
        if (shadow > maxShadow) maxShadow = shadow;
      }

      return {
        distance: d,
        height: Math.max(adjTerrain[idx].height, maxShadow),
      };
    });

    // 3) 최저 탐지가능 높이 - 4/3 굴절 적용
    //    4/3 프레임에서 shadow-casting → AMSL 복원 → 실제지구 디스플레이 프레임 변환
    const minDetRefracted = profile.map((p, idx) => {
      const d = p.distance;
      if (idx === 0) return { distance: d, height: radarHeight };

      // 4/3 프레임에서 shadow-casting
      let maxShadow = radarHeight;
      for (let i = 1; i < idx; i++) {
        const di = profile[i].distance;
        if (di <= 0) continue;
        const adjH = profile[i].elevation - curvDrop43(di);
        const shadow = radarHeight + (adjH - radarHeight) * (d / di);
        if (shadow > maxShadow) maxShadow = shadow;
      }

      const adjTerrain43 = profile[idx].elevation - curvDrop43(d);
      const h43 = Math.max(adjTerrain43, maxShadow);
      // 4/3 프레임 → AMSL → 실제지구 디스플레이 프레임
      const amslH = h43 + curvDrop43(d);
      return { distance: d, height: amslH - curvDrop(d) };
    });

    // 4) CoS (Cone of Silence) 70° 기준선
    const COS_DEG = 70;
    const cosLine = profile.map((p) => ({
      distance: p.distance,
      height: radarHeight + p.distance * 1000 * Math.tan((COS_DEG * Math.PI) / 180),
    }));

    // 5) 0.25° BRA 기준선 (실제 앙각 기준 직선)
    const BRA_DEG = 0.25;
    const braLine = profile.map((p) => ({
      distance: p.distance,
      height: radarHeight + p.distance * 1000 * Math.tan((BRA_DEG * Math.PI) / 180),
    }));

    // 차단 판정 (4/3 프레임에서 지형 vs 레이더→타겟 직선)
    const adjTarget43 = targetElev - curvDrop43(D);
    const losRefracted43H = (d: number) =>
      radarHeight + (adjTarget43 - radarHeight) * (d / D);
    let blocked = false;
    let maxBlockPoint: {
      distance: number;
      adjHeight: number;
      realElevation: number;
      name?: string;
    } | null = null;
    let maxExcess = 0;
    for (let i = 1; i < profile.length - 1; i++) {
      const di = profile[i].distance;
      const adjH43 = profile[i].elevation - curvDrop43(di);
      const excess = adjH43 - losRefracted43H(di);
      if (excess > maxExcess) {
        maxExcess = excess;
        blocked = true;
        maxBlockPoint = {
          distance: di,
          adjHeight: adjTerrain[i].height, // 디스플레이 프레임 좌표
          realElevation: profile[i].elevation,
          name: peakNames.get(i),
        };
      }
    }

    // 이름이 있는 모든 산 (차트에 표시용)
    const namedPeaks: { idx: number; distance: number; adjHeight: number; realElevation: number; name: string }[] = [];
    for (const [idx, name] of peakNames.entries()) {
      if (idx >= 0 && idx < profile.length) {
        namedPeaks.push({
          idx,
          distance: profile[idx].distance,
          adjHeight: adjTerrain[idx].height,
          realElevation: profile[idx].elevation,
          name,
        });
      }
    }

    // Y축 범위 (CoS는 매우 가파르므로 maxY에 포함하지 않음 - 차트 가독성)
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
      cosLine,
      blocked,
      maxBlockPoint,
      namedPeaks,
      minY,
      maxY,
      maxDistance: D,
      adjTarget,
      targetElev,
    };
  }, [profile, radarHeight, totalDist, peakNames]);

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

  // ── SVG 차트 상수 (훅보다 먼저 선언) ──
  const W = 900;
  const H = 280;
  const PAD = { top: 20, right: 30, bottom: 30, left: 65 };
  const cw = W - PAD.left - PAD.right;
  const ch = H - PAD.top - PAD.bottom;

  // X축 줌 네이티브 휠 핸들러 (passive: false 필수)
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const svgX = ((e.clientX - rect.left) / rect.width) * W;
      // 차트 영역 밖이면 무시
      if (svgX < PAD.left || svgX > W - PAD.right) return;
      const cursorRatio = (svgX - PAD.left) / cw; // 0~1 in chart area
      const [s, en] = xZoomRef.current;
      const range = en - s;
      // 커서가 가리키는 절대 위치 (%)
      const pivot = s + cursorRatio * range;
      const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
      let newRange = Math.min(100, Math.max(1, range * factor));
      let newStart = pivot - cursorRatio * newRange;
      let newEnd = pivot + (1 - cursorRatio) * newRange;
      if (newStart < 0) { newEnd -= newStart; newStart = 0; }
      if (newEnd > 100) { newStart -= (newEnd - 100); newEnd = 100; }
      newStart = Math.max(0, newStart);
      newEnd = Math.min(100, newEnd);
      const next: [number, number] = [newStart, newEnd];
      xZoomRef.current = next;
      setXZoom(next);
    };
    const onMouseDown = (e: MouseEvent) => {
      // 줌 상태가 아니면 드래그 패닝 불필요
      const [s, en] = xZoomRef.current;
      if (s === 0 && en === 100) return;
      const rect = svg.getBoundingClientRect();
      const svgX = ((e.clientX - rect.left) / rect.width) * W;
      if (svgX < PAD.left || svgX > W - PAD.right) return;
      isDragging.current = true;
      dragStartX.current = e.clientX;
      dragStartZoom.current = [...xZoomRef.current];
      svg.style.cursor = "grabbing";
      e.preventDefault();
    };
    const onMouseMoveGlobal = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const rect = svg.getBoundingClientRect();
      const dx = e.clientX - dragStartX.current;
      const [origS, origE] = dragStartZoom.current;
      const range = origE - origS;
      // dx 픽셀을 줌 %로 변환 (차트 영역 폭 기준)
      const chartPxWidth = rect.width * (cw / W);
      const shift = -(dx / chartPxWidth) * range;
      let newStart = origS + shift;
      let newEnd = origE + shift;
      if (newStart < 0) { newEnd -= newStart; newStart = 0; }
      if (newEnd > 100) { newStart -= (newEnd - 100); newEnd = 100; }
      newStart = Math.max(0, newStart);
      newEnd = Math.min(100, newEnd);
      const next: [number, number] = [newStart, newEnd];
      xZoomRef.current = next;
      setXZoom(next);
    };
    const onMouseUpGlobal = () => {
      if (isDragging.current) {
        isDragging.current = false;
        svg.style.cursor = "";
      }
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    svg.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMoveGlobal);
    document.addEventListener("mouseup", onMouseUpGlobal);
    return () => {
      svg.removeEventListener("wheel", onWheel);
      svg.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mousemove", onMouseMoveGlobal);
      document.removeEventListener("mouseup", onMouseUpGlobal);
    };
  }, [cw, loading]);

  // 줌 리셋 (프로파일 변경 시)
  useEffect(() => {
    xZoomRef.current = [0, 100];
    setXZoom([0, 100]);
  }, [profile]);

  // 마우스 이동 핸들러 (SVG 좌표 → 거리)
  const handleSvgMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (isDragging.current) return; // 드래그 중에는 크로스헤어 비활성
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * 900; // viewBox 기준 X
    setHoverX(svgX);
  }, []);
  const handleSvgMouseLeave = useCallback(() => {
    setHoverX(null);
    onHoverDistance?.(null);
  }, [onHoverDistance]);

  // 호버 위치의 상세 데이터 계산
  const hoverData = useMemo(() => {
    if (hoverX === null || !chartData || profile.length === 0) return null;
    const { adjTerrain, minDetRefracted, minDetStraight, minY, maxY, maxDistance } = chartData;

    const PAD_LEFT = 65;
    const PAD_RIGHT = 30;
    const cw = 900 - PAD_LEFT - PAD_RIGHT;
    // 줌 뷰포트 반영
    const zoomStart = xZoom[0] / 100 * maxDistance;
    const zoomEnd = xZoom[1] / 100 * maxDistance;
    const zoomRange = zoomEnd - zoomStart;
    const dist = zoomStart + ((hoverX - PAD_LEFT) / cw) * zoomRange;
    if (dist < zoomStart || dist > zoomEnd) return null;

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

    // AGL (Above Ground Level): 실제 지표면 기준 최저탐지 높이
    const refractedAGL = refractedH - terrainH;
    const straightAGL = straightH - terrainH;
    // 실제 AMSL (조정 프레임 → 실제 고도 복원)
    const refractedAMSL = refractedH + curvDrop(dist);
    const straightAMSL = straightH + curvDrop(dist);

    // BRA 0.25° 기준선 높이 (AMSL)
    const BRA_DEG = 0.25;
    const braH = radarHeight + dist * 1000 * Math.tan((BRA_DEG * Math.PI) / 180);
    const braAMSL = braH + curvDrop(dist);

    // CoS 최고 탐지 고도 (AMSL)
    const cosH = radarHeight + dist * 1000 * Math.tan((70 * Math.PI) / 180);
    const cosAMSL = cosH + curvDrop(dist);

    return { dist, terrainH, realElev, refractedH, straightH, refractedAGL, straightAGL, refractedAMSL, straightAMSL, braAMSL, cosAMSL, minY, maxY };
  }, [hoverX, chartData, profile, xZoom]);

  // 호버 거리 비율을 부모에 전달
  useEffect(() => {
    if (hoverData && totalDist > 0) {
      onHoverDistance?.(hoverData.dist / totalDist);
    } else {
      onHoverDistance?.(null);
    }
  }, [hoverData, totalDist, onHoverDistance]);

  const renderChart = () => {
    if (!chartData) return null;
    const {
      adjTerrain, minDetRefracted, minDetStraight, braLine, cosLine,
      maxBlockPoint, minY, maxY, maxDistance,
    } = chartData;

    const zoomStart = (xZoom[0] / 100) * maxDistance;
    const zoomEnd = (xZoom[1] / 100) * maxDistance;
    const zoomRange = zoomEnd - zoomStart;
    const xScale = (d: number) => PAD.left + ((d - zoomStart) / zoomRange) * cw;
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

    // CoS 70° 기준선
    const cosPath = cosLine
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.distance)} ${yScale(p.height)}`)
      .join(" ");

    // 단위 변환 상수
    const M_TO_FT = 3.28084;
    const KM_TO_NM = 1 / 1.852;

    // Y축 눈금 (ft 기준)
    const yRangeFt = (maxY - minY) * M_TO_FT;
    const yStepFt = yRangeFt > 30000 ? 5000 : yRangeFt > 15000 ? 2000 : yRangeFt > 5000 ? 1000 : yRangeFt > 2000 ? 500 : 200;
    const yTicks: number[] = [];
    const minYft = minY * M_TO_FT;
    const maxYft = maxY * M_TO_FT;
    for (let yf = Math.ceil(minYft / yStepFt) * yStepFt; yf <= maxYft; yf += yStepFt) yTicks.push(yf / M_TO_FT); // m으로 저장 (yScale은 m 기준)

    // X축 눈금 (NM 기준, 줌 뷰포트 적용)
    const visibleDistNm = zoomRange * KM_TO_NM;
    const xStepNm = visibleDistNm > 80 ? 20 : visibleDistNm > 40 ? 10 : visibleDistNm > 15 ? 5 : visibleDistNm > 5 ? 2 : 1;
    const xTicks: number[] = []; // km 값으로 저장
    const zoomStartNm = zoomStart * KM_TO_NM;
    const zoomEndNm = zoomEnd * KM_TO_NM;
    const xTickStartNm = Math.ceil(zoomStartNm / xStepNm) * xStepNm;
    for (let xn = xTickStartNm; xn <= zoomEndNm; xn += xStepNm) xTicks.push(xn / KM_TO_NM); // km으로 변환

    return (
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full"
        style={{ minHeight: 220, cursor: xZoom[0] !== 0 || xZoom[1] !== 100 ? "grab" : undefined }}
        onMouseMove={handleSvgMouseMove} onMouseLeave={handleSvgMouseLeave}>
        <defs>
          <linearGradient id="terrainGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22c55e" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#22c55e" stopOpacity="0.05" />
          </linearGradient>
          <clipPath id="chart-clip">
            <rect x={PAD.left} y={PAD.top} width={cw} height={ch} />
          </clipPath>
        </defs>

        {/* 그리드 */}
        {yTicks.map((y) => (
          <g key={`y-${y}`}>
            <line x1={PAD.left} y1={yScale(y)} x2={W - PAD.right} y2={yScale(y)}
              stroke={y === 0 ? "rgba(0,0,0,0.15)" : "rgba(0,0,0,0.06)"} strokeWidth={y === 0 ? 1 : 0.5} />
            <text x={PAD.left - 5} y={yScale(y) + 3} textAnchor="end"
              fill="#6b7280" fontSize={9}>
              {Math.round(y * M_TO_FT).toLocaleString()}ft
            </text>
          </g>
        ))}
        {xTicks.map((x) => (
          <g key={`x-${x}`}>
            <line x1={xScale(x)} y1={PAD.top} x2={xScale(x)} y2={H - PAD.bottom}
              stroke="rgba(0,0,0,0.06)" strokeWidth={0.5} />
            <text x={xScale(x)} y={H - PAD.bottom + 14} textAnchor="middle"
              fill="#6b7280" fontSize={9}>
              {(x * KM_TO_NM).toFixed(x * KM_TO_NM >= 10 ? 0 : 1)}NM
            </text>
          </g>
        ))}

        {/* 클리핑 영역 내 차트 요소 */}
        <g clipPath="url(#chart-clip)">
        {/* 지형 채우기 */}
        <path d={terrainFill} fill="url(#terrainGrad)" />

        {/* 지형 윤곽선 */}
        <path d={terrainLine} fill="none" stroke="#22c55e" strokeWidth={1.5} />

        {/* 최저 탐지가능 높이 - 직선 LOS (굴절 미적용, 실제 지구반경) */}
        <path d={minDetStrPath} fill="none"
          stroke="rgba(107,114,128,0.6)" strokeWidth={1.8} />

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

        {/* CoS 70° 기준선 */}
        <path d={cosPath} fill="none"
          stroke="#a855f7" strokeWidth={1} strokeDasharray="4 3" />

        {/* 레이더 위치 라벨 (Y축 상단) */}
        <text x={xScale(0) + 4} y={PAD.top + 12}
          fill="#6b7280" fontSize={8}>
          {radarSite.name} ({Math.round(radarHeight * M_TO_FT).toLocaleString()}ft)
        </text>

        {/* 이름 있는 산들 */}
        {chartData.namedPeaks.map((peak, i) => {
          const isMaxBlock = maxBlockPoint && Math.abs(peak.distance - maxBlockPoint.distance) < 0.5;
          return (
            <g key={`peak-${i}`}>
              <circle
                cx={xScale(peak.distance)}
                cy={yScale(peak.adjHeight)}
                r={isMaxBlock ? 4 : 3}
                fill={isMaxBlock ? "#a60739" : "#f59e0b"}
                stroke="white" strokeWidth={1} />
              <text
                x={xScale(peak.distance)}
                y={yScale(peak.adjHeight) - 10}
                textAnchor="middle" fill="#374151" fontSize={9} fontWeight="bold">
                {`${peak.name} (${Math.round(peak.realElevation * M_TO_FT).toLocaleString()}ft)`}
              </text>
            </g>
          );
        })}

        {/* LOS 선상 항적/Loss 포인트 전체 */}
        {losTrackPoints && losTrackPoints.map((tp, tpIdx) => {
          const tpDist = tp.distRatio * maxDistance;
          // 고도를 4/3 조정 프레임으로 변환
          const tpAdjAlt = tp.altitude - curvDrop(tpDist);
          // Y축 범위 밖이면 표시 안 함
          if (tpAdjAlt < minY || tpAdjAlt > maxY) return null;
          const tpX = xScale(tpDist);
          const tpY = yScale(tpAdjAlt);
          const isPinned = pinnedTrackIdx === tpIdx;
          const isActive = hoveredTrackIdx === tpIdx || isPinned;
          return (
            <circle key={`tp-${tpIdx}`}
              cx={tpX} cy={tpY}
              r={isActive ? 4 : 2}
              fill={tp.isLoss ? "#ef4444" : "#3b82f6"}
              fillOpacity={isActive ? 1 : 0.6}
              stroke={isPinned ? "#facc15" : isActive ? "white" : "none"}
              strokeWidth={isPinned ? 2 : isActive ? 1.5 : 0}
              style={{ cursor: "pointer" }}
              onMouseEnter={() => {
                setHoveredTrackIdx(tpIdx);
                if (pinnedTrackIdx === null) onTrackPointHighlight?.(tpIdx);
              }}
              onMouseLeave={() => {
                setHoveredTrackIdx(null);
                if (pinnedTrackIdx === null) onTrackPointHighlight?.(null);
              }}
              onClick={() => {
                if (pinnedTrackIdx === tpIdx) {
                  setPinnedTrackIdx(null);
                  onTrackPointHighlight?.(null);
                } else {
                  setPinnedTrackIdx(tpIdx);
                  onTrackPointHighlight?.(tpIdx);
                }
              }}
            />
          );
        })}

        </g>{/* /chart-clip */}

        {/* 범례 (왼쪽 위) */}
        <g transform={`translate(${PAD.left + 8}, ${PAD.top + 5})`}>
          <rect x={-4} y={-6} width={234} height={66} rx={4} fill="rgba(255,255,255,0.9)" stroke="rgba(0,0,0,0.1)" strokeWidth={0.5} />
          <line x1={0} y1={0} x2={20} y2={0}
            stroke="#f59e0b" strokeWidth={1.8} />
          <text x={24} y={3} fill="#374151" fontSize={8}>
            최저 탐지가능 높이 (4/3 전파굴절 적용)
          </text>
          <line x1={0} y1={14} x2={20} y2={14}
            stroke="rgba(107,114,128,0.6)" strokeWidth={1.8} />
          <text x={24} y={17} fill="#374151" fontSize={8}>
            최저 탐지가능 높이 (직선 LOS, 굴절 미적용)
          </text>
          <line x1={0} y1={28} x2={20} y2={28}
            stroke="#22d3ee" strokeWidth={1} strokeDasharray="8 4" />
          <text x={24} y={31} fill="#374151" fontSize={8}>
            BRA (0.25° 기준선)
          </text>
          <line x1={0} y1={42} x2={20} y2={42}
            stroke="#a855f7" strokeWidth={1} strokeDasharray="4 3" />
          <text x={24} y={45} fill="#374151" fontSize={8}>
            CoS (70° 최고 탐지고도)
          </text>
          <line x1={0} y1={56} x2={20} y2={56} stroke="#22c55e" strokeWidth={1.5} />
          <text x={24} y={59} fill="#374151" fontSize={8}>
            지형 (지구곡률 보정)
          </text>
        </g>

        {/* 인터랙티브 크로스헤어 + 호버 툴팁 */}
        {hoverData && hoveredTrackIdx === null && pinnedTrackIdx === null && (() => {
          const hXPos = xScale(hoverData.dist);
          const tooltipW = 175;
          const tooltipH = 104;
          const tooltipX = hXPos + tooltipW + 12 > W ? hXPos - tooltipW - 8 : hXPos + 8;
          const tooltipY = PAD.top + 4;
          return (
            <g>
              {/* 차트 Y축 크로스헤어 (보조) */}
              <line x1={hXPos} y1={PAD.top} x2={hXPos} y2={H - PAD.bottom}
                stroke="rgba(156,163,175,0.2)" strokeWidth={0.5} strokeDasharray="2 3" />
              {/* 지형 위 인디케이터 */}
              <circle cx={hXPos} cy={yScale(hoverData.terrainH)} r={3}
                fill="#22c55e" stroke="white" strokeWidth={0.8} />
              {/* 굴절선: 지면→포인트 수직 가이드 */}
              <line x1={hXPos} y1={yScale(hoverData.terrainH)} x2={hXPos} y2={yScale(hoverData.refractedH)}
                stroke="#f59e0b" strokeWidth={0.8} strokeDasharray="2 2" strokeOpacity={0.5} />
              <circle cx={hXPos} cy={yScale(hoverData.refractedH)} r={3}
                fill="#f59e0b" stroke="white" strokeWidth={0.8} />
              {/* 직선 LOS: 지면→포인트 수직 가이드 */}
              <line x1={hXPos} y1={yScale(hoverData.terrainH)} x2={hXPos} y2={yScale(hoverData.straightH)}
                stroke="rgba(107,114,128,0.5)" strokeWidth={0.8} strokeDasharray="2 2" strokeOpacity={0.5} />
              <circle cx={hXPos} cy={yScale(hoverData.straightH)} r={2.5}
                fill="rgba(107,114,128,0.6)" stroke="white" strokeWidth={0.8} />
              {/* 툴팁 배경 */}
              <rect x={tooltipX} y={tooltipY} width={tooltipW} height={tooltipH}
                rx={4} fill="rgba(255,255,255,0.95)" stroke="rgba(0,0,0,0.1)" strokeWidth={0.5} />
              {/* 툴팁 내용 */}
              <text x={tooltipX + 8} y={tooltipY + 14} fill="#6b7280" fontSize={8}>
                거리: <tspan fill="#374151" fontWeight="bold">{(hoverData.dist / 1.852).toFixed(1)}NM</tspan>
              </text>
              <text x={tooltipX + 8} y={tooltipY + 28} fill="#22c55e" fontSize={8}>
                지형고도: <tspan fill="#374151">{Math.round(hoverData.realElev * 3.28084).toLocaleString()}ft AMSL</tspan>
              </text>
              <text x={tooltipX + 8} y={tooltipY + 42} fill="#f59e0b" fontSize={8}>
                최저탐지(굴절): <tspan fill="#374151" fontWeight="bold">{Math.round(hoverData.refractedAMSL * 3.28084).toLocaleString()}ft</tspan>
                <tspan fill="#6b7280" fontSize={7}> (AGL {Math.round(hoverData.refractedAGL * 3.28084).toLocaleString()}ft)</tspan>
              </text>
              <text x={tooltipX + 8} y={tooltipY + 56} fill="rgba(107,114,128,0.6)" fontSize={8}>
                직선LOS: <tspan fill="#374151" fontWeight="bold">{Math.round(hoverData.straightAMSL * 3.28084).toLocaleString()}ft</tspan>
                <tspan fill="#6b7280" fontSize={7}> (AGL {Math.round(hoverData.straightAGL * 3.28084).toLocaleString()}ft)</tspan>
              </text>
              <text x={tooltipX + 8} y={tooltipY + 72} fill="#22d3ee" fontSize={8}>
                BRA 0.25°: <tspan fill="#374151" fontWeight="bold">{Math.round(hoverData.braAMSL * 3.28084).toLocaleString()}ft</tspan>
              </text>
              <text x={tooltipX + 8} y={tooltipY + 86} fill="#a855f7" fontSize={8}>
                최고탐지(CoS): <tspan fill="#374151" fontWeight="bold">{Math.round(hoverData.cosAMSL * 3.28084).toLocaleString()}ft</tspan>
              </text>
            </g>
          );
        })()}

        {/* 항적/Loss 포인트 호버/핀 툴팁 */}
        {(() => {
          const activeIdx = hoveredTrackIdx ?? pinnedTrackIdx;
          if (activeIdx === null || !losTrackPoints || !losTrackPoints[activeIdx]) return null;
          const tp = losTrackPoints[activeIdx];
          const tpDist = tp.distRatio * maxDistance;
          const tpAdjAlt = tp.altitude - curvDrop(tpDist);
          const tpX = xScale(tpDist);
          const tpY = yScale(tpAdjAlt);
          const tooltipW = 160;
          const tooltipH = 62;
          const tooltipX = tpX + tooltipW + 12 > W ? tpX - tooltipW - 8 : tpX + 8;
          const tooltipY = Math.max(PAD.top, Math.min(tpY - tooltipH / 2, H - PAD.bottom - tooltipH));
          const date = new Date(tp.timestamp * 1000);
          const timeStr = `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}:${String(date.getUTCSeconds()).padStart(2, "0")}`;
          return (
            <g>
              <rect x={tooltipX} y={tooltipY} width={tooltipW} height={tooltipH}
                rx={4} fill="rgba(255,255,255,0.95)" stroke={tp.isLoss ? "#ef4444" : "#3b82f6"} strokeWidth={0.8} />
              <text x={tooltipX + 8} y={tooltipY + 14} fill="#374151" fontSize={8} fontWeight="bold">
                {tp.mode_s} {tp.isLoss ? "(Loss)" : ""}
              </text>
              <text x={tooltipX + 8} y={tooltipY + 28} fill="#6b7280" fontSize={8}>
                시각: <tspan fill="#374151">{timeStr} UTC</tspan>
              </text>
              <text x={tooltipX + 8} y={tooltipY + 42} fill="#6b7280" fontSize={8}>
                고도: <tspan fill="#374151" fontWeight="bold">{Math.round(tp.altitude * 3.28084).toLocaleString()}ft</tspan>
                <tspan fill="#6b7280" fontSize={7}> ({tp.altitude.toFixed(0)}m)</tspan>
              </text>
              <text x={tooltipX + 8} y={tooltipY + 56} fill="#6b7280" fontSize={8}>
                거리: <tspan fill="#374151">{(tpDist / 1.852).toFixed(1)}NM</tspan>
              </text>
            </g>
          );
        })()}
      </svg>
    );
  };

  return (
    <div className="border-t border-gray-200 bg-white/95 backdrop-blur-sm shadow-lg">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-2">
        <span className="text-xs font-semibold text-gray-800">LOS 단면도</span>
        <span className="text-[10px] text-gray-500">
          {radarSite.name} → {targetLat.toFixed(4)}°N {targetLon.toFixed(4)}°E
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-2 text-[10px] text-gray-500">
          <span>거리: {(totalDist / 1.852).toFixed(1)}NM</span>
          <span>방위: {bearing.toFixed(0)}°</span>
          {chartData && (
            <span className={chartData.blocked ? "text-[#a60739]" : "text-emerald-600"}>
              {chartData.blocked ? "LOS 차단" : "LOS 양호"}
            </span>
          )}
          {xZoom[0] !== 0 || xZoom[1] !== 100 ? (
            <button
              onClick={() => { xZoomRef.current = [0, 100]; setXZoom([0, 100]); }}
              className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-gray-200 transition-colors"
            >
              {Math.round(100 / ((xZoom[1] - xZoom[0]) / 100))}% ✕
            </button>
          ) : null}
          {chartData && chartData.namedPeaks.length > 0 && (
            <span className="text-yellow-600">
              산: {chartData.namedPeaks.map((p) => p.name).join(", ")}
            </span>
          )}
        </div>
        <button onClick={handleSave} disabled={loading || saved}
          className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 disabled:opacity-50"
          title="보고서에 저장">
          <Save size={12} />
          {saved ? "저장됨" : "저장"}
        </button>
        <button onClick={onClose}
          className="rounded p-1 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800">
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
