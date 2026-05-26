import React, { useMemo, useState, useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import type { RadarSite, LossPointGeo, ManualBuilding } from "../../types";
import type { CoverageLayer } from "../../utils/radarCoverage";
import { azimuthAndDist } from "../../utils/geo";
import ReportOMSectionHeader from "./ReportOMSectionHeader";
import { type OMSectionCaptureHandle, createDeferred, svgToPngDataUrl } from "./omCapture";

/** 고도(ft) → 스펙트럼 HSL 색상 (빨강→파랑) */
function altToColor(altFt: number, minAlt: number, maxAlt: number): string {
  const t = maxAlt > minAlt ? (altFt - minAlt) / (maxAlt - minAlt) : 0.5;
  const hue = t * 240; // 0°(red) → 240°(blue)
  return `hsl(${hue}, 85%, 50%)`;
}

interface Props {
  sectionNum: number;
  radarSite: RadarSite;
  /** 분석 대상 건물 포함 커버리지 레이어 (다중 고도) */
  layersWithTargets: CoverageLayer[];
  /** 분석 대상 건물 제외 커버리지 레이어 (다중 고도) */
  layersWithoutTargets: CoverageLayer[];
  /** Loss 발생 좌표 */
  lossPoints: LossPointGeo[];
  /** 기본 고도 (ft) — 미사용, 호환성 유지 */
  defaultAltFt: number;
  selectedBuildings: ManualBuilding[];
  /** true면 헤더 생략 (외부에서 헤더 렌더) */
  hideHeader?: boolean;
  /** 사전 캡처된 SVG dataUrl. 있으면 라이브 SVG 대신 <img> 표시 */
  preCapturedImage?: string;
}

/** 방위별 커버리지 범위(km) lookup — O(1) 인덱스 기반 */
function coverageRangeAt(layer: CoverageLayer, azDeg: number): number {
  const n = layer.bearings.length;
  if (n === 0) return 0;
  const step = 360 / n;
  const idx = Math.round(((azDeg % 360) + 360) % 360 / step) % n;
  return layer.bearings[idx].maxRangeKm;
}

/** 고도별 보간 커버리지 범위(km) */
function coverageRangeAtAlt(
  layers: CoverageLayer[], altFt: number, azDeg: number,
): number {
  if (layers.length === 0) return 0;
  // 고도 정렬된 레이어에서 lo/hi 탐색 (이미 적은 수)
  let lo: CoverageLayer | null = null;
  let hi: CoverageLayer | null = null;
  for (const l of layers) {
    if (l.altitudeFt <= altFt && (!lo || l.altitudeFt > lo.altitudeFt)) lo = l;
    if (l.altitudeFt >= altFt && (!hi || l.altitudeFt < hi.altitudeFt)) hi = l;
  }
  if (!lo && !hi) return 0;
  if (!lo) return coverageRangeAt(hi!, azDeg);
  if (!hi) return coverageRangeAt(lo, azDeg);
  if (lo.altitudeFt === hi.altitudeFt) return coverageRangeAt(lo, azDeg);
  const t = (altFt - lo.altitudeFt) / (hi.altitudeFt - lo.altitudeFt);
  return coverageRangeAt(lo, azDeg) + t * (coverageRangeAt(hi, azDeg) - coverageRangeAt(lo, azDeg));
}

/** 레이어 쌍에서 diff path 생성 (분석 대상 건물 영향 차이) */
function buildDiffPath(
  layerWith: CoverageLayer, layerWithout: CoverageLayer,
  scale: number, cx: number, cy: number,
): string | null {
  const withBearings = layerWith.bearings;
  const withoutBearings = layerWithout.bearings;
  if (withBearings.length === 0 || withoutBearings.length === 0) return null;

  const segments: string[] = [];
  const every = Math.max(1, Math.floor(withoutBearings.length / 360));

  let outerPts: string[] = [];
  let innerPts: string[] = [];
  let inDiff = false;

  // withBearings를 방위각 기준 Map으로 변환 (인덱스가 아닌 deg 기준 매칭)
  const withByDeg = new Map<number, (typeof withBearings)[0]>();
  for (const wb of withBearings) {
    withByDeg.set(Math.round(wb.deg * 100), wb);
  }

  for (let i = 0; i < withoutBearings.length; i += every) {
    const b = withoutBearings[i];
    const matchWith = withByDeg.get(Math.round(b.deg * 100)) ?? null;
    const rWithout = b.maxRangeKm * scale;
    const rWith = (matchWith?.maxRangeKm ?? b.maxRangeKm) * scale;
    const rad = (b.deg * Math.PI) / 180;
    const diff = rWithout - rWith;

    if (diff > 0) {
      outerPts.push(`${(cx + rWithout * Math.sin(rad)).toFixed(1)} ${(cy - rWithout * Math.cos(rad)).toFixed(1)}`);
      innerPts.unshift(`${(cx + rWith * Math.sin(rad)).toFixed(1)} ${(cy - rWith * Math.cos(rad)).toFixed(1)}`);
      inDiff = true;
    } else if (inDiff) {
      if (outerPts.length >= 2) {
        segments.push(`M ${outerPts[0]} L ${outerPts.slice(1).join(" L ")} L ${innerPts.join(" L ")} Z`);
      }
      outerPts = []; innerPts = []; inDiff = false;
    }
  }
  if (outerPts.length >= 2) {
    segments.push(`M ${outerPts[0]} L ${outerPts.slice(1).join(" L ")} L ${innerPts.join(" L ")} Z`);
  }
  return segments.length > 0 ? segments.join(" ") : null;
}

/* ── 타일 좌표 유틸 (Slippy Map) ── */
function lon2tile(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * (1 << z));
}
function lat2tile(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * (1 << z));
}
function tile2lon(x: number, z: number): number {
  return (x / (1 << z)) * 360 - 180;
}
function tile2lat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / (1 << z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

interface MapImageResult {
  dataUrl: string;
  lonMin: number; lonMax: number;
  latMin: number; latMax: number;
}

/** 지정한 지리 경계(lon/lat)를 덮는 정적 지도 배경 이미지 생성 */
function useStaticMapImage(
  lonMin: number, lonMax: number, latMin: number, latMax: number,
): MapImageResult | null {
  const [result, setResult] = useState<MapImageResult | null>(null);

  useEffect(() => {
    if (!(lonMax > lonMin) || !(latMax > latMin)) return;
    let cancelled = false;

    // 줌 레벨 선택: 가로 4–8 타일 (확대된 영역일수록 높은 줌 → 선명)
    let zoom = 6;
    for (let z = 1; z <= 16; z++) {
      const xTiles = lon2tile(lonMax, z) - lon2tile(lonMin, z) + 1;
      if (xTiles > 8) { zoom = z - 1; break; }
      zoom = z;
    }
    zoom = Math.max(3, Math.min(zoom, 14));

    const xMin = lon2tile(lonMin, zoom);
    const xMax = lon2tile(lonMax, zoom);
    const yMin = lat2tile(latMax, zoom);
    const yMax = lat2tile(latMin, zoom);
    const tilesX = xMax - xMin + 1;
    const tilesY = yMax - yMin + 1;
    if (tilesX * tilesY > 100) return; // 안전 제한

    const TS = 256;
    const canvas = document.createElement("canvas");
    canvas.width = tilesX * TS;
    canvas.height = tilesY * TS;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#f0f0f0";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const promises: Promise<void>[] = [];
    for (let ty = yMin; ty <= yMax; ty++) {
      for (let tx = xMin; tx <= xMax; tx++) {
        const url = `https://basemaps.cartocdn.com/light_nolabels/${zoom}/${tx}/${ty}.png`;
        const px = (tx - xMin) * TS;
        const py = (ty - yMin) * TS;
        promises.push(new Promise<void>((resolve) => {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.onload = () => { ctx.drawImage(img, px, py); resolve(); };
          img.onerror = () => resolve();
          img.src = url;
        }));
      }
    }

    Promise.all(promises).then(() => {
      if (cancelled) return;
      setResult({
        dataUrl: canvas.toDataURL("image/png"),
        lonMin: tile2lon(xMin, zoom),
        lonMax: tile2lon(xMax + 1, zoom),
        latMax: tile2lat(yMin, zoom),
        latMin: tile2lat(yMax + 1, zoom),
      });
    });

    return () => { cancelled = true; };
  }, [lonMin, lonMax, latMin, latMax]);

  return result;
}

const SECTOR_PAD_DEG = 25;
const FIXED_ALTS = [1000, 2000, 3000, 5000, 10000, 15000, 20000];
/** diff 영역 확대(줌) 파라미터 */
const MIN_FOCUS_HALF_KM = 4;   // 단일 지점 등 작은 diff 의 최소 반경(km)
const FOCUS_PAD_FRAC = 0.18;   // diff 영역 주변 여백 비율
const FOCUS_MARGIN_PX = 64;    // 캔버스 가장자리 여백(px, 라벨/축척 공간)

const ReportOMCoverageDiff = forwardRef<OMSectionCaptureHandle, Props>(function ReportOMCoverageDiff({
  sectionNum,
  radarSite,
  layersWithTargets,
  layersWithoutTargets,
  lossPoints,
  selectedBuildings,
  hideHeader,
  preCapturedImage,
}: Props, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const readyDeferredRef = useRef(createDeferred<void>());
  const MIN_ALT = 1000;
  const MAX_ALT = 20000;

  // 고정 20개 레이어 선택 (가장 가까운 고도 매칭)
  const { fixedWith, fixedWithout } = useMemo(() => {
    const pick = (layers: CoverageLayer[], targetAlt: number) => {
      if (layers.length === 0) return null;
      return layers.reduce((prev, curr) =>
        Math.abs(curr.altitudeFt - targetAlt) < Math.abs(prev.altitudeFt - targetAlt) ? curr : prev,
      );
    };
    return {
      fixedWith: FIXED_ALTS.map((alt) => pick(layersWithTargets, alt)).filter(Boolean) as CoverageLayer[],
      fixedWithout: FIXED_ALTS.map((alt) => pick(layersWithoutTargets, alt)).filter(Boolean) as CoverageLayer[],
    };
  }, [layersWithTargets, layersWithoutTargets]);

  // 건물 방위 범위 → 섹터 크롭
  const { sectorStart, sectorEnd, hasSector } = useMemo(() => {
    if (selectedBuildings.length === 0)
      return { sectorStart: 0, sectorEnd: 360, sectorSpan: 360, hasSector: false };

    const azimuths = selectedBuildings.map((b) =>
      azimuthAndDist(radarSite.latitude, radarSite.longitude, b.latitude, b.longitude).azDeg,
    );
    const sorted = [...azimuths].sort((a, b) => a - b);
    let bestGap = 0, gapEnd = 0;
    for (let i = 0; i < sorted.length; i++) {
      const next = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + 360;
      const gap = next - sorted[i];
      if (gap > bestGap) { bestGap = gap; gapEnd = next % 360; }
    }
    const span = 360 - bestGap;
    const start = (gapEnd - SECTOR_PAD_DEG + 360) % 360;
    const end = (gapEnd + span + SECTOR_PAD_DEG) % 360;
    const totalSpan = Math.min(span + SECTOR_PAD_DEG * 2, 360);
    return { sectorStart: start, sectorEnd: end, sectorSpan: totalSpan, hasSector: totalSpan < 350 };
  }, [selectedBuildings, radarSite]);

  const inSector = (azDeg: number) => {
    if (!hasSector) return true;
    if (sectorStart <= sectorEnd) return azDeg >= sectorStart && azDeg <= sectorEnd;
    return azDeg >= sectorStart || azDeg <= sectorEnd;
  };

  // 최저 레이어 (Cone of Silence 판정)
  const lowestWith = fixedWith.length > 0 ? fixedWith[0] : null;

  // Loss 3D 차이 필터: 분석 대상 건물 때문에 커버리지가 줄어든 영역의 Loss만
  const filteredLoss = useMemo(() => {
    if (layersWithTargets.length === 0 || layersWithoutTargets.length === 0) return [];
    return lossPoints.filter((pt) => {
      if (pt.alt_ft < MIN_ALT || pt.alt_ft > MAX_ALT) return false;
      const { azDeg, distKm } = azimuthAndDist(radarSite.latitude, radarSite.longitude, pt.lat, pt.lon);
      if (lowestWith && lowestWith.coneRadiusKm > 0.5 && distKm < lowestWith.coneRadiusKm) return false;
      const rangeWith = coverageRangeAtAlt(layersWithTargets, pt.alt_ft, azDeg);
      const rangeWithout = coverageRangeAtAlt(layersWithoutTargets, pt.alt_ft, azDeg);
      return distKm <= rangeWithout && distKm > rangeWith;
    });
  }, [lossPoints, radarSite, lowestWith, layersWithTargets, layersWithoutTargets]);

  // SVG 레이아웃 (상수)
  const svgSize = 700;
  const fullCx = svgSize / 2;
  const fullCy = svgSize / 2;
  const fullMaxR = svgSize / 2 - 30;

  // globalMaxRange: 루프 기반 최대값 (Math.max spread 콜스택 폭발 방지)
  const globalMaxRange = useMemo(() => {
    let maxR = Math.max(radarSite.range_nm * 1.852, 1);
    for (const l of fixedWith) for (const b of l.bearings) { if (b.maxRangeKm > maxR) maxR = b.maxRangeKm; }
    for (const l of fixedWithout) for (const b of l.bearings) { if (b.maxRangeKm > maxR) maxR = b.maxRangeKm; }
    return maxR;
  }, [fixedWith, fixedWithout, radarSite.range_nm]);

  // 장애물 영향 차이(diff) 영역의 km 바운딩박스 — 확대(줌) 기준.
  // diff 세그먼트(제외>포함) + 건물 + 장애물 기인 소실표적을 모두 포함.
  const focusBboxKm = useMemo(() => {
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    let any = false;
    const add = (distKm: number, azDeg: number) => {
      const rad = (azDeg * Math.PI) / 180;
      const x = distKm * Math.sin(rad);
      const y = -distKm * Math.cos(rad);
      if (x < xMin) xMin = x; if (x > xMax) xMax = x;
      if (y < yMin) yMin = y; if (y > yMax) yMax = y;
      any = true;
    };
    for (let i = 0; i < fixedWith.length; i++) {
      const lw = fixedWith[i];
      const lwo = fixedWithout.find((l) => Math.abs(l.altitudeFt - lw.altitudeFt) < 200);
      if (!lwo) continue;
      const withByDeg = new Map<number, number>();
      for (const wb of lw.bearings) withByDeg.set(Math.round(wb.deg * 100), wb.maxRangeKm);
      for (const b of lwo.bearings) {
        const rWith = withByDeg.get(Math.round(b.deg * 100)) ?? b.maxRangeKm;
        if (b.maxRangeKm - rWith > 0) { add(b.maxRangeKm, b.deg); add(rWith, b.deg); }
      }
    }
    for (const bld of selectedBuildings) {
      const { azDeg, distKm } = azimuthAndDist(radarSite.latitude, radarSite.longitude, bld.latitude, bld.longitude);
      add(distKm, azDeg);
    }
    for (const pt of filteredLoss) {
      const { azDeg, distKm } = azimuthAndDist(radarSite.latitude, radarSite.longitude, pt.lat, pt.lon);
      add(distKm, azDeg);
    }
    return any ? { xMin, xMax, yMin, yMax } : null;
  }, [fixedWith, fixedWithout, selectedBuildings, filteredLoss, radarSite]);

  // 확대 변환: diff 영역이 캔버스를 채우도록 scale/center 계산.
  // viewBox 는 700×700 고정 → 라벨/마커/범례 크기는 일정 유지, 지오메트리만 확대.
  const { scale, cx, cy, focused } = useMemo(() => {
    if (!focusBboxKm) {
      return { scale: fullMaxR / globalMaxRange, cx: fullCx, cy: fullCy, focused: false };
    }
    const cxKm = (focusBboxKm.xMin + focusBboxKm.xMax) / 2;
    const cyKm = (focusBboxKm.yMin + focusBboxKm.yMax) / 2;
    let half = Math.max(
      (focusBboxKm.xMax - focusBboxKm.xMin) / 2,
      (focusBboxKm.yMax - focusBboxKm.yMin) / 2,
      MIN_FOCUS_HALF_KM,
    );
    half *= 1 + FOCUS_PAD_FRAC;
    const inner = svgSize - FOCUS_MARGIN_PX * 2;
    const s = inner / (half * 2);
    return { scale: s, cx: svgSize / 2 - cxKm * s, cy: svgSize / 2 - cyKm * s, focused: true };
  }, [focusBboxKm, globalMaxRange, fullMaxR, fullCx, fullCy]);

  // 가시 캔버스에 대응하는 지리 경계 → 줌 수준에 맞는 지도 타일 요청
  const geoBounds = useMemo(() => {
    const kmPerDegLat = 111.32;
    const kmPerDegLon = 111.32 * Math.cos((radarSite.latitude * Math.PI) / 180);
    const kmLeft = (0 - cx) / scale, kmRight = (svgSize - cx) / scale;
    const kmTop = (0 - cy) / scale, kmBottom = (svgSize - cy) / scale;
    return {
      lonMin: radarSite.longitude + kmLeft / kmPerDegLon,
      lonMax: radarSite.longitude + kmRight / kmPerDegLon,
      latMax: radarSite.latitude - kmTop / kmPerDegLat,
      latMin: radarSite.latitude - kmBottom / kmPerDegLat,
    };
  }, [cx, cy, scale, radarSite.latitude, radarSite.longitude]);

  // 지도 배경 타일 이미지 (확대 영역 기준)
  const mapImage = useStaticMapImage(geoBounds.lonMin, geoBounds.lonMax, geoBounds.latMin, geoBounds.latMax);

  // 캡처 readiness — 맵 타일 준비(또는 빈 상태 확정) + 2× RAF(paint) 이후 resolve.
  // capture() 가 await 중인 deferred 를 신호.
  const readyFiredRef = useRef(false);
  useEffect(() => {
    if (readyFiredRef.current) return;
    const hasData = fixedWith.length > 0 || fixedWithout.length > 0;
    // 데이터가 있는 경우 맵 타일 로드까지 대기 (빈 데이터는 즉시 준비 인정)
    if (hasData && mapImage === null) return;

    let cancelled = false;
    let raf2Id = 0;
    const raf1Id = requestAnimationFrame(() => {
      raf2Id = requestAnimationFrame(() => {
        if (cancelled || readyFiredRef.current) return;
        readyFiredRef.current = true;
        readyDeferredRef.current.resolve();
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1Id);
      if (raf2Id) cancelAnimationFrame(raf2Id);
    };
  }, [mapImage, fixedWith.length, fixedWithout.length]);

  // 명령형 capture 핸들 — SVG 직렬화 → PNG dataUrl
  useImperativeHandle(ref, () => ({
    async capture(): Promise<string | null> {
      // 데이터 없으면 캡처 불필요 (라이브 빈 상태 메시지를 PDF 에 그대로 인쇄)
      if (fixedWith.length === 0 && fixedWithout.length === 0) return null;
      // 맵 타일 + paint 완료 대기
      await readyDeferredRef.current.promise;
      const svg = svgRef.current;
      if (!svg) throw new Error("ReportOMCoverageDiff: svg not mounted");
      return await svgToPngDataUrl(svg, 2, "#ffffff");
    },
  }), [fixedWith.length, fixedWithout.length]);

  // unmount 시 readiness 미해결이면 reject
  useEffect(() => {
    const deferred = readyDeferredRef.current;
    return () => {
      deferred.reject(new Error("ReportOMCoverageDiff unmounted before ready"));
    };
  }, []);

  // 각 고도별 diff path (분석 대상 건물 영향 차이) — diff 영역만 그림
  const diffPaths = useMemo(() => {
    const result: { altFt: number; color: string; path: string }[] = [];
    for (let i = 0; i < fixedWith.length; i++) {
      const lw = fixedWith[i];
      const lwo = fixedWithout.find((l) => Math.abs(l.altitudeFt - lw.altitudeFt) < 200);
      if (!lwo) continue;
      const dp = buildDiffPath(lw, lwo, scale, cx, cy);
      if (dp) {
        result.push({
          altFt: lw.altitudeFt,
          color: altToColor(lw.altitudeFt, MIN_ALT, MAX_ALT),
          path: dp,
        });
      }
    }
    // 낮은 고도(큰 영역) → 높은 고도(작은 영역) 순. 작은 영역이 위에 그려짐.
    return result.sort((a, b) => a.altFt - b.altFt);
  }, [fixedWith, fixedWithout, scale, cx, cy]);

  if (fixedWith.length === 0 && fixedWithout.length === 0) return (
    <div ref={containerRef} className="flex flex-col items-center py-16 text-gray-400">
      <p className="text-sm">커버리지 비교 데이터 없음</p>
    </div>
  );

  // viewBox 700×700 고정 (diff 영역 확대는 scale/cx/cy 로 처리)
  const vbX = 0, vbY = 0, vbW = svgSize, vbH = svgSize;
  const coverageR = globalMaxRange * scale; // 커버리지 최대 반경(SVG 단위)

  // 거리 링 라벨 방위 — 확대 시 focus 중심 방향, 아니면 NE(45°)
  const focusBearingDeg = focused && focusBboxKm
    ? ((Math.atan2((focusBboxKm.xMin + focusBboxKm.xMax) / 2, -((focusBboxKm.yMin + focusBboxKm.yMax) / 2)) * 180) / Math.PI + 360) % 360
    : 45;

  // 축척 바 — 캔버스 폭 ~1/5 에 해당하는 nice km
  const scaleBar = (() => {
    const targetKm = (svgSize * 0.2) / scale;
    const pow = Math.pow(10, Math.floor(Math.log10(targetKm)));
    let niceKm = pow;
    for (const m of [1, 2, 5, 10]) {
      if (Math.abs(m * pow - targetKm) < Math.abs(niceKm - targetKm)) niceKm = m * pow;
    }
    return { km: niceKm, px: niceKm * scale };
  })();

  // 거리 링
  const ringIntervalKm = 20 * 1.852;
  const rings: { km: number; nm: number }[] = [];
  for (let km = ringIntervalKm; km <= globalMaxRange; km += ringIntervalKm) {
    rings.push({ km, nm: km / 1.852 });
  }

  // 섹터 경계선 (전체 보기에서만 사용)
  const sectorLines = hasSector ? [sectorStart, sectorEnd].map((deg) => {
    const rad = (deg * Math.PI) / 180;
    return { x2: cx + (coverageR + 15) * Math.sin(rad), y2: cy - (coverageR + 15) * Math.cos(rad) };
  }) : [];

  // 방위 라벨
  const compassPoints = [
    { deg: 0, label: "N" }, { deg: 45, label: "NE" }, { deg: 90, label: "E" },
    { deg: 135, label: "SE" }, { deg: 180, label: "S" }, { deg: 225, label: "SW" },
    { deg: 270, label: "W" }, { deg: 315, label: "NW" },
  ].filter(({ deg }) => !hasSector || inSector(deg));

  return (
    <div ref={containerRef} className="mb-8">
      {!hideHeader && <ReportOMSectionHeader sectionNum={sectionNum} title="커버리지 비교맵" />}

      {/* 정보 요약 바 */}
      <div className="mb-2 flex items-center justify-between rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-[10px] text-gray-500">
        <span>분석 고도: {MIN_ALT.toLocaleString()} — {MAX_ALT.toLocaleString()} ft ({fixedWith.length}레이어)</span>
        <span>
          장애물 기인 소실표적 {filteredLoss.length}건
          {hasSector && <> · 섹터 {sectorStart.toFixed(0)}°–{sectorEnd.toFixed(0)}°</>}
        </span>
      </div>

      {/* 커버리지 비교맵 — preCapturedImage 가 있으면 정적 이미지로 표시 */}
      <div className="rounded-md border border-gray-200 p-2">
        {preCapturedImage ? (
          <img src={preCapturedImage} alt="" className="w-full" />
        ) : (
        <svg ref={svgRef} viewBox={`${vbX.toFixed(1)} ${vbY.toFixed(1)} ${vbW.toFixed(1)} ${vbH.toFixed(1)}`} className="w-full">
          <defs>
            <clipPath id="om-map-clip">
              <circle cx={cx} cy={cy} r={coverageR + 2} />
            </clipPath>
          </defs>

          {/* 배경 */}
          <rect x={vbX} y={vbY} width={vbW} height={vbH} fill="#fafafa" rx={4} />

          {/* 지도 배경 */}
          {mapImage && (() => {
            const kmPerDegLon = 111.32 * Math.cos((radarSite.latitude * Math.PI) / 180);
            const kmPerDegLat = 111.32;
            const imgX = cx + (mapImage.lonMin - radarSite.longitude) * kmPerDegLon * scale;
            const imgY = cy - (mapImage.latMax - radarSite.latitude) * kmPerDegLat * scale;
            const imgW = (mapImage.lonMax - mapImage.lonMin) * kmPerDegLon * scale;
            const imgH = (mapImage.latMax - mapImage.latMin) * kmPerDegLat * scale;
            return (
              <image
                href={mapImage.dataUrl}
                x={imgX} y={imgY} width={imgW} height={imgH}
                preserveAspectRatio="none"
                opacity={0.5}
                clipPath="url(#om-map-clip)"
              />
            );
          })()}

          {/* Cone of Silence */}
          {lowestWith && lowestWith.coneRadiusKm > 0.5 && (
            <circle cx={cx} cy={cy} r={lowestWith.coneRadiusKm * scale}
              fill="#fafafa" stroke="#9ca3af" strokeWidth={0.5} strokeDasharray="2,2" />
          )}

          {/* 장애물 영향 차이(diff) 영역만 표시 — 고도별 스펙트럼 색상 (낮은 고도 아래, 높은 고도 위) */}
          {diffPaths.map((dp, i) => (
            <path key={`diff-${i}`} d={dp.path}
              fill={dp.color} fillOpacity={1}
              stroke="#ffffff" strokeWidth={0.5} strokeOpacity={0.6} />
          ))}

          {/* 거리 링 (레이더 중심 기준) — focus 방향 라벨, 화면 밖이면 라벨 생략 */}
          {rings.map((ring, i) => {
            const r = ring.km * scale;
            const labelRad = (focusBearingDeg * Math.PI) / 180;
            const lxp = cx + (r + 3) * Math.sin(labelRad);
            const lyp = cy - (r + 3) * Math.cos(labelRad);
            const showLabel = lxp >= 6 && lxp <= svgSize - 6 && lyp >= 10 && lyp <= svgSize - 10;
            return (
              <g key={`ring-${i}`}>
                <circle cx={cx} cy={cy} r={r} fill="none" stroke="#d1d5db" strokeWidth={0.4} strokeDasharray="3,3" />
                {showLabel && (
                  <text x={lxp} y={lyp} fill="#9ca3af" fontSize={8} textAnchor="start"
                    stroke="#ffffff" strokeWidth={2} paintOrder="stroke"
                  >{ring.nm.toFixed(0)}NM</text>
                )}
              </g>
            );
          })}

          {/* 방위선 + 라벨 (전체 보기에서만 — 확대 시엔 북향 표시로 대체) */}
          {!focused && compassPoints.map(({ deg, label }) => {
            const rad = (deg * Math.PI) / 180;
            return (
              <g key={deg}>
                <line x1={cx} y1={cy} x2={cx + (coverageR + 10) * Math.sin(rad)} y2={cy - (coverageR + 10) * Math.cos(rad)}
                  stroke="#c0c0c8" strokeWidth={0.4} />
                <text x={cx + (coverageR + 20) * Math.sin(rad)} y={cy - (coverageR + 20) * Math.cos(rad) + 3}
                  textAnchor="middle" fill="#6b7280" fontSize={9} fontWeight={600}>{label}</text>
              </g>
            );
          })}

          {/* 섹터 경계선 (전체 보기에서만) */}
          {!focused && sectorLines.map((sl, i) => (
            <line key={`sec-${i}`} x1={cx} y1={cy} x2={sl.x2} y2={sl.y2}
              stroke="#a60739" strokeWidth={0.6} strokeDasharray="4,3" strokeOpacity={0.5} />
          ))}

          {/* 소실표적 (장애물 기인만) */}
          {filteredLoss.map((pt, i) => {
            const { azDeg, distKm } = azimuthAndDist(radarSite.latitude, radarSite.longitude, pt.lat, pt.lon);
            if (distKm > globalMaxRange) return null;
            const rad = (azDeg * Math.PI) / 180;
            const r = distKm * scale;
            const px = cx + r * Math.sin(rad);
            const py = cy - r * Math.cos(rad);
            return (
              <g key={`loss-${i}`}>
                <circle cx={px} cy={py} r={4} fill="none" stroke="#ffffff" strokeWidth={1} />
                <circle cx={px} cy={py} r={2.5} fill="#ef4444" stroke="#b91c1c" strokeWidth={0.5} />
              </g>
            );
          })}

          {/* 건물 위치 */}
          {selectedBuildings.map((b, i) => {
            const { azDeg, distKm } = azimuthAndDist(radarSite.latitude, radarSite.longitude, b.latitude, b.longitude);
            if (distKm > globalMaxRange) return null;
            const rad = (azDeg * Math.PI) / 180;
            const r = distKm * scale;
            const bx = cx + r * Math.sin(rad);
            const by = cy - r * Math.cos(rad);
            return (
              <g key={`bld-${i}`}>
                <rect x={bx - 4} y={by - 4} width={8} height={8} fill="#f59e0b" stroke="#ffffff" strokeWidth={0.8} rx={1.5} />
                <text x={bx + 7} y={by + 3} fill="#92400e" fontSize={7} fontWeight={600}
                  stroke="#ffffff" strokeWidth={2} paintOrder="stroke">{b.name || `B${i + 1}`}</text>
              </g>
            );
          })}

          {/* 레이더 중심 */}
          <circle cx={cx} cy={cy} r={4} fill="#a60739" stroke="white" strokeWidth={1.2} />
          <text x={cx} y={cy + 14} textAnchor="middle" fill="#a60739" fontSize={8} fontWeight={600}
            stroke="#ffffff" strokeWidth={2} paintOrder="stroke">{radarSite.name}</text>

          {/* 스펙트럼 범례 (7개 고도별 개별 표시) */}
          {(() => {
            const legendW = FIXED_ALTS.length * 36;
            const lx = vbX + vbW / 2 - legendW / 2;
            const ly = vbY + vbH - 26;
            return (
              <g>
                {FIXED_ALTS.map((alt, i) => {
                  const x = lx + i * 36;
                  const color = altToColor(alt, MIN_ALT, MAX_ALT);
                  return (
                    <g key={alt}>
                      <rect x={x} y={ly} width={12} height={8} fill={color} rx={1.5} />
                      <text x={x + 6} y={ly + 17} textAnchor="middle" fill="#6b7280" fontSize={7}>
                        {alt >= 1000 ? `${(alt / 1000).toFixed(0)}k` : alt}
                      </text>
                    </g>
                  );
                })}
                <text x={lx + legendW / 2} y={ly - 4} textAnchor="middle" fill="#6b7280" fontSize={7}>
                  고도 (ft)
                </text>
              </g>
            );
          })()}

          {/* 북향 표시 (확대 시) — 지도는 항상 북쪽이 위 */}
          {focused && (
            <g>
              <rect x={svgSize - 44} y={12} width={32} height={50} rx={4} fill="#ffffff" fillOpacity={0.75} />
              <line x1={svgSize - 28} y1={44} x2={svgSize - 28} y2={24} stroke="#374151" strokeWidth={1.4} />
              <path d={`M ${svgSize - 28} 19 L ${svgSize - 31} 26 L ${svgSize - 25} 26 Z`} fill="#374151" />
              <text x={svgSize - 28} y={58} textAnchor="middle" fill="#374151" fontSize={9} fontWeight={700}>N</text>
            </g>
          )}

          {/* 축척 바 (확대 시) */}
          {focused && (
            <g>
              <line x1={24} y1={svgSize - 24} x2={24 + scaleBar.px} y2={svgSize - 24} stroke="#374151" strokeWidth={1.6} />
              <line x1={24} y1={svgSize - 28} x2={24} y2={svgSize - 20} stroke="#374151" strokeWidth={1.6} />
              <line x1={24 + scaleBar.px} y1={svgSize - 28} x2={24 + scaleBar.px} y2={svgSize - 20} stroke="#374151" strokeWidth={1.6} />
              <text x={24 + scaleBar.px / 2} y={svgSize - 30} textAnchor="middle" fill="#374151" fontSize={8}
                stroke="#ffffff" strokeWidth={2} paintOrder="stroke">
                {scaleBar.km}km · {(scaleBar.km / 1.852).toFixed(scaleBar.km / 1.852 < 10 ? 1 : 0)}NM
              </text>
            </g>
          )}
        </svg>
        )}
      </div>

      {/* 장애물 영향 차이 없음 안내 */}
      {diffPaths.length === 0 && fixedWith.length > 0 && fixedWithout.length > 0 && (
        <div className="mt-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-center text-[11px] text-blue-700">
          분석 대상 장애물에 의한 실질적인 커버리지 차이가 발생하지 않았습니다.
          {filteredLoss.length === 0
            ? " 장애물 기인 소실표적 또한 없습니다."
            : ` (단, 장애물 기인 소실표적 ${filteredLoss.length}건 존재)`}
        </div>
      )}

      {/* 범례 */}
      <div className="mt-2 flex flex-wrap justify-center gap-4 text-[10px] text-gray-600">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-6 rounded-sm" style={{
            background: "linear-gradient(to right, hsl(0,85%,50%), hsl(120,85%,50%), hsl(240,85%,50%))",
          }} />
          장애물 영향 차이 (고도별 색상)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-red-500 border border-white" />
          장애물 기인 소실표적 ({filteredLoss.length}건)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded bg-amber-400 border border-white" />
          분석 대상 장애물
        </span>
        {lowestWith && lowestWith.coneRadiusKm > 0.5 && (
          <span className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-full border border-gray-400 border-dashed" />
            Cone of Silence
          </span>
        )}
      </div>
    </div>
  );
});

export default React.memo(ReportOMCoverageDiff);
