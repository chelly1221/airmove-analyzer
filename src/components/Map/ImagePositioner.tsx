import { useState, useEffect, useCallback, useRef } from "react";
import { Marker } from "react-map-gl/maplibre";
import type maplibregl from "maplibre-gl";
import { Check, X, Move } from "lucide-react";
import type { PlanImageBounds } from "../../types";

interface Props {
  map: maplibregl.Map;
  groupId: number;
  imageDataUrl: string;
  /** 기존 bounds (없으면 현재 뷰포트 중앙에 배치) */
  initialBounds?: PlanImageBounds | null;
  /** 토지이용계획도 불투명도 (0~1, 기본 0.6) */
  opacity?: number;
  onConfirm: (bounds: PlanImageBounds) => void;
  onCancel: () => void;
}

/** 파라미터 기반 이미지 위치/크기/회전 */
interface ImageParams {
  centerLat: number;
  centerLon: number;
  halfW: number;   // 반폭 (degrees, lon 방향)
  halfH: number;   // 반높이 (degrees, lat 방향)
  rotDeg: number;  // 회전 각도 (degrees, 반시계 방향)
}

/** [lat, lon] → [lon, lat] for MapLibre */
function toCoord(ll: [number, number]): [number, number] {
  return [ll[1], ll[0]];
}

/** 파라미터 → PlanImageBounds (4 코너) 변환 */
function paramsToBounds(p: ImageParams): PlanImageBounds {
  const θ = p.rotDeg * Math.PI / 180;
  const cos = Math.cos(θ), sin = Math.sin(θ);

  const offsets: [number, number][] = [
    [-p.halfW, +p.halfH],  // topLeft
    [+p.halfW, +p.halfH],  // topRight
    [+p.halfW, -p.halfH],  // bottomRight
    [-p.halfW, -p.halfH],  // bottomLeft
  ];

  const corners = offsets.map(([dLon, dLat]) => [
    p.centerLat + dLon * sin + dLat * cos,
    p.centerLon + dLon * cos - dLat * sin,
  ] as [number, number]);

  return {
    topLeft: corners[0],
    topRight: corners[1],
    bottomRight: corners[2],
    bottomLeft: corners[3],
  };
}

/** PlanImageBounds → 파라미터 역추출 */
function boundsToParams(b: PlanImageBounds): ImageParams {
  const centerLat = (b.topLeft[0] + b.bottomRight[0]) / 2;
  const centerLon = (b.topLeft[1] + b.bottomRight[1]) / 2;

  const wDLon = b.topRight[1] - b.topLeft[1];
  const wDLat = b.topRight[0] - b.topLeft[0];
  const fullWidth = Math.sqrt(wDLon * wDLon + wDLat * wDLat);

  const hDLon = b.bottomLeft[1] - b.topLeft[1];
  const hDLat = b.bottomLeft[0] - b.topLeft[0];
  const fullHeight = Math.sqrt(hDLon * hDLon + hDLat * hDLat);

  const rotRad = Math.atan2(wDLat, wDLon);

  return { centerLat, centerLon, halfW: fullWidth / 2, halfH: fullHeight / 2, rotDeg: rotRad * 180 / Math.PI };
}

/** 뷰포트 기반 초기 파라미터 */
function defaultParamsFromView(map: maplibregl.Map, aspectRatio: number): ImageParams {
  const bounds = map.getBounds();
  const center = map.getCenter();
  const lonSpan = (bounds.getEast() - bounds.getWest()) * 0.4;
  const latSpan = lonSpan / aspectRatio;
  return { centerLat: center.lat, centerLon: center.lng, halfW: lonSpan / 2, halfH: latSpan / 2, rotDeg: 0 };
}

/** 맵 source 좌표 업데이트 */
function updateSourceCoords(map: maplibregl.Map, sourceId: string, b: PlanImageBounds) {
  try {
    const source = map.getSource(sourceId) as maplibregl.ImageSource | undefined;
    if (source) {
      source.setCoordinates([toCoord(b.topLeft), toCoord(b.topRight), toCoord(b.bottomRight), toCoord(b.bottomLeft)]);
    }
  } catch { /* 맵 파괴 시 무시 */ }
}

/** GeoJSON line source 데이터 업데이트 */
function updateGeoJSONLine(map: maplibregl.Map, sourceId: string, coords: [number, number][]) {
  try {
    const src = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData({ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: {} });
    }
  } catch { /* 맵 파괴 시 무시 */ }
}

/** degrees → 근사 미터 */
function degToMeters(deg: number, lat: number, isLon: boolean): number {
  if (isLon) return deg * 111320 * Math.cos(lat * Math.PI / 180);
  return deg * 111320;
}

/** 두 점의 중점 */
function midpoint(a: [number, number], b: [number, number]): [number, number] {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** 회전 핸들 위치 (상단 중앙 위) */
function rotationHandlePos(p: ImageParams, offset: number): [number, number] {
  const θ = p.rotDeg * Math.PI / 180;
  return [
    p.centerLat + (p.halfH + offset) * Math.cos(θ),
    p.centerLon - (p.halfH + offset) * Math.sin(θ),
  ];
}

type EdgeKey = "top" | "right" | "bottom" | "left";

export default function ImagePositioner({ map, groupId, imageDataUrl, initialBounds, opacity = 0.6, onConfirm, onCancel }: Props) {
  const sourceId = `positioning-image-${groupId}`;
  const layerId = `positioning-raster-${groupId}`;
  const outlineSrcId = `positioning-outline-${groupId}`;
  const outlineLayId = `positioning-outline-l-${groupId}`;
  const rotLineSrcId = `positioning-rotline-${groupId}`;
  const rotLineLayId = `positioning-rotline-l-${groupId}`;

  const [params, setParams] = useState<ImageParams | null>(null);
  const paramsRef = useRef<ImageParams | null>(null);
  const rafRef = useRef<number>(0);
  const aspectRef = useRef(1); // halfW / halfH 비율
  const shiftRef = useRef(false);
  const rotatingRef = useRef(false); // 회전 드래그 중 여부

  // Shift 키 추적 (비율 유지 리사이즈)
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === "Shift") shiftRef.current = true; };
    const up = (e: KeyboardEvent) => { if (e.key === "Shift") shiftRef.current = false; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  // 이미지 로드 → 종횡비 계산 → 초기 params
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const aspect = img.width / img.height;
      let p: ImageParams;
      if (initialBounds && initialBounds.topLeft) {
        p = boundsToParams(initialBounds);
      } else {
        p = defaultParamsFromView(map, aspect);
      }
      aspectRef.current = p.halfW / p.halfH;
      setParams(p);
      paramsRef.current = p;
    };
    img.src = imageDataUrl;
  }, [imageDataUrl, initialBounds, map]);

  const bounds = params ? paramsToBounds(params) : null;

  // MapLibre image source 추가/업데이트
  useEffect(() => {
    if (!bounds) return;
    const coords: [[number, number], [number, number], [number, number], [number, number]] = [
      toCoord(bounds.topLeft), toCoord(bounds.topRight), toCoord(bounds.bottomRight), toCoord(bounds.bottomLeft),
    ];
    try {
      if (map.getSource(sourceId)) {
        (map.getSource(sourceId) as maplibregl.ImageSource).setCoordinates(coords);
        if (map.getLayer(layerId)) map.setPaintProperty(layerId, "raster-opacity", opacity);
      } else {
        map.addSource(sourceId, { type: "image", url: imageDataUrl, coordinates: coords });
        let beforeId: string | undefined;
        const style = map.getStyle();
        if (style?.layers) {
          for (const layer of style.layers) {
            if (layer.type === "symbol") { beforeId = layer.id; break; }
          }
        }
        map.addLayer({ id: layerId, type: "raster", source: sourceId, paint: { "raster-opacity": opacity, "raster-fade-duration": 0 } }, beforeId);
      }
    } catch { /* 맵 파괴 */ }
  }, [bounds, map, imageDataUrl, sourceId, layerId, opacity]);

  // 테두리선 + 회전라인 GeoJSON 생성
  useEffect(() => {
    if (!params || !bounds) return;
    const rotOff = Math.max(params.halfH, params.halfW) * 0.2;
    const topMid = midpoint(bounds.topLeft, bounds.topRight);
    const rotPos = rotationHandlePos(params, rotOff);

    const outlineCoords = [
      toCoord(bounds.topLeft), toCoord(bounds.topRight),
      toCoord(bounds.bottomRight), toCoord(bounds.bottomLeft), toCoord(bounds.topLeft),
    ];
    const rotLineCoords = [toCoord(topMid), toCoord(rotPos)];

    const createOrUpdate = (sid: string, lid: string, coords: [number, number][], paint: Record<string, unknown>) => {
      try {
        if (map.getSource(sid)) {
          updateGeoJSONLine(map, sid, coords);
        } else {
          const data = { type: "Feature" as const, geometry: { type: "LineString" as const, coordinates: coords }, properties: {} };
          map.addSource(sid, { type: "geojson", data: data as never });
          map.addLayer({ id: lid, type: "line", source: sid, paint } as never);
        }
      } catch { /* 맵 파괴 */ }
    };

    createOrUpdate(outlineSrcId, outlineLayId, outlineCoords, {
      "line-color": "#3b82f6", "line-width": 1.5, "line-dasharray": [4, 3],
    });
    createOrUpdate(rotLineSrcId, rotLineLayId, rotLineCoords, {
      "line-color": "#22c55e", "line-width": 1.5,
    });
  }, [params, bounds, map, outlineSrcId, outlineLayId, rotLineSrcId, rotLineLayId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      rotatingRef.current = false;
      map.dragPan.enable();
      try {
        for (const lid of [layerId, outlineLayId, rotLineLayId]) {
          if (map.getLayer(lid)) map.removeLayer(lid);
        }
        for (const sid of [sourceId, outlineSrcId, rotLineSrcId]) {
          if (map.getSource(sid)) map.removeSource(sid);
        }
      } catch { /* 맵 파괴 */ }
    };
  }, [map, sourceId, layerId, outlineSrcId, outlineLayId, rotLineSrcId, rotLineLayId]);

  /** 파라미터 적용 + 모든 source 업데이트 (RAF) */
  const applyParams = useCallback((p: ImageParams) => {
    paramsRef.current = p;
    setParams(p);
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const cur = paramsRef.current;
      if (!cur) return;
      const b = paramsToBounds(cur);
      updateSourceCoords(map, sourceId, b);

      const rotOff = Math.max(cur.halfH, cur.halfW) * 0.2;
      const topMid = midpoint(b.topLeft, b.topRight);
      const rotHandle = rotationHandlePos(cur, rotOff);
      updateGeoJSONLine(map, outlineSrcId, [
        toCoord(b.topLeft), toCoord(b.topRight), toCoord(b.bottomRight), toCoord(b.bottomLeft), toCoord(b.topLeft),
      ]);
      updateGeoJSONLine(map, rotLineSrcId, [toCoord(topMid), toCoord(rotHandle)]);
    });
  }, [map, sourceId, outlineSrcId, rotLineSrcId]);

  /** 코너 드래그 — 비율 유지 리사이즈 */
  const handleCornerDrag = useCallback((_corner: string, lat: number, lon: number) => {
    const p = paramsRef.current;
    if (!p) return;
    const θ = p.rotDeg * Math.PI / 180;
    const cos = Math.cos(θ), sin = Math.sin(θ);
    const dLon = lon - p.centerLon, dLat = lat - p.centerLat;
    const projW = Math.abs(dLon * cos + dLat * sin);
    const projH = Math.abs(-dLon * sin + dLat * cos);

    // 항상 비율 유지: 더 큰 변화량 기준
    const ar = aspectRef.current;
    const scale = Math.max(projW / ar, projH, 0.0005);
    applyParams({ ...p, halfW: scale * ar, halfH: scale });
  }, [applyParams]);

  /** 변 중점 드래그 — 반대편 고정, 해당 변만 이동 */
  const handleEdgeDrag = useCallback((edge: EdgeKey, lat: number, lon: number) => {
    const p = paramsRef.current;
    if (!p) return;
    const θ = p.rotDeg * Math.PI / 180;
    const cosθ = Math.cos(θ), sinθ = Math.sin(θ);
    // 축 방향 (lat, lon): height=상단 방향, width=우측 방향
    const hLat = cosθ, hLon = -sinθ;
    const wLat = sinθ, wLon = cosθ;
    const minDim = 0.0005;

    if (edge === "top" || edge === "bottom") {
      const sign = edge === "top" ? 1 : -1;
      // 앵커 = 반대편 변 중점
      const ancLat = p.centerLat - sign * p.halfH * hLat;
      const ancLon = p.centerLon - sign * p.halfH * hLon;
      // 드래그 위치를 높이축에 투영
      const proj = sign * ((lat - ancLat) * hLat + (lon - ancLon) * hLon);
      const fullH = Math.max(proj, minDim);
      const newHalfH = fullH / 2;
      applyParams({
        ...p, halfH: newHalfH,
        centerLat: ancLat + sign * newHalfH * hLat,
        centerLon: ancLon + sign * newHalfH * hLon,
      });
    } else {
      const sign = edge === "right" ? 1 : -1;
      const ancLat = p.centerLat - sign * p.halfW * wLat;
      const ancLon = p.centerLon - sign * p.halfW * wLon;
      const proj = sign * ((lat - ancLat) * wLat + (lon - ancLon) * wLon);
      const fullW = Math.max(proj, minDim);
      const newHalfW = fullW / 2;
      applyParams({
        ...p, halfW: newHalfW,
        centerLat: ancLat + sign * newHalfW * wLat,
        centerLon: ancLon + sign * newHalfW * wLon,
      });
    }
  }, [applyParams]);

  /** 회전: 맵 mousemove로 각도 계산 (핸들은 고정 위치 유지) */
  const onRotationMove = useCallback((e: maplibregl.MapMouseEvent) => {
    if (!rotatingRef.current) return;
    const p = paramsRef.current;
    if (!p) return;
    const { lat, lng } = e.lngLat;
    const dLat = lat - p.centerLat;
    const dLon = lng - p.centerLon;
    let newRot = Math.atan2(-dLon, dLat) * 180 / Math.PI;
    if (shiftRef.current) newRot = Math.round(newRot / 15) * 15;
    applyParams({ ...p, rotDeg: newRot });
  }, [applyParams]);

  const onRotationUp = useCallback(() => {
    rotatingRef.current = false;
    map.getCanvas().style.cursor = "";
    map.off("mousemove", onRotationMove);
    map.off("mouseup", onRotationUp);
    map.dragPan.enable();
  }, [map, onRotationMove]);

  const startRotation = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    rotatingRef.current = true;
    map.getCanvas().style.cursor = "grabbing";
    map.dragPan.disable();
    map.on("mousemove", onRotationMove);
    map.on("mouseup", onRotationUp);
  }, [map, onRotationMove, onRotationUp]);

  /** 중앙 마커 드래그 — 전체 이동 */
  const handleCenterDrag = useCallback((e: { lngLat: { lat: number; lng: number } }) => {
    const p = paramsRef.current;
    if (!p) return;
    applyParams({ ...p, centerLat: e.lngLat.lat, centerLon: e.lngLat.lng });
  }, [applyParams]);

  if (!params || !bounds) return null;

  // 핸들 위치 계산
  const cornerHandles: { key: string; pos: [number, number] }[] = [
    { key: "topLeft", pos: bounds.topLeft },
    { key: "topRight", pos: bounds.topRight },
    { key: "bottomRight", pos: bounds.bottomRight },
    { key: "bottomLeft", pos: bounds.bottomLeft },
  ];

  const edgeHandles: { key: EdgeKey; pos: [number, number] }[] = [
    { key: "top", pos: midpoint(bounds.topLeft, bounds.topRight) },
    { key: "right", pos: midpoint(bounds.topRight, bounds.bottomRight) },
    { key: "bottom", pos: midpoint(bounds.bottomRight, bounds.bottomLeft) },
    { key: "left", pos: midpoint(bounds.bottomLeft, bounds.topLeft) },
  ];

  const rotOff = Math.max(params.halfH, params.halfW) * 0.2;
  const rotPos = rotationHandlePos(params, rotOff);

  // 크기 표시용
  const widthM = Math.round(degToMeters(params.halfW * 2, params.centerLat, true));
  const heightM = Math.round(degToMeters(params.halfH * 2, params.centerLat, false));
  const rotDisplay = Math.round(params.rotDeg * 10) / 10;

  return (
    <>
      {/* 코너 핸들 (4개) — 자유 리사이즈 */}
      {cornerHandles.map(({ key, pos }) => (
        <Marker
          key={key}
          latitude={pos[0]}
          longitude={pos[1]}
          draggable
          onDrag={(e) => handleCornerDrag(key, e.lngLat.lat, e.lngLat.lng)}
          anchor="center"
        >
          <div className="h-[10px] w-[10px] border-[2px] border-blue-500 bg-white shadow-sm cursor-nwse-resize" />
        </Marker>
      ))}

      {/* 변 중점 핸들 (4개) — 단축 리사이즈 */}
      {edgeHandles.map(({ key, pos }) => (
        <Marker
          key={key}
          latitude={pos[0]}
          longitude={pos[1]}
          draggable
          onDrag={(e) => handleEdgeDrag(key, e.lngLat.lat, e.lngLat.lng)}
          anchor="center"
        >
          <div className={`h-[8px] w-[8px] border-[2px] border-blue-500 bg-white shadow-sm ${
            key === "top" || key === "bottom" ? "cursor-ns-resize" : "cursor-ew-resize"
          }`} />
        </Marker>
      ))}

      {/* 회전 핸들 — 상단 녹색 원 (고정 위치, mousedown으로 회전) */}
      <Marker
        latitude={rotPos[0]}
        longitude={rotPos[1]}
        anchor="center"
      >
        <div
          onMouseDown={startRotation}
          className="h-[12px] w-[12px] rounded-full border-[2px] border-green-500 bg-white shadow-sm cursor-grab active:cursor-grabbing"
        />
      </Marker>

      {/* 중앙 이동 핸들 */}
      <Marker
        latitude={params.centerLat}
        longitude={params.centerLon}
        draggable
        onDrag={handleCenterDrag}
        anchor="center"
      >
        <div className="flex h-6 w-6 items-center justify-center rounded-full border-[2px] border-blue-500/50 bg-white/80 shadow-sm cursor-move">
          <Move size={12} className="text-blue-500" />
        </div>
      </Marker>

      {/* 최소 툴바 — 크기/각도 + 확인/취소 */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-lg bg-white px-3 py-2 shadow-lg border border-gray-200">
        <span className="text-[11px] text-gray-500 tabular-nums">
          {widthM} × {heightM} m
          {rotDisplay !== 0 && <span className="ml-1.5 text-green-600">{rotDisplay}°</span>}
        </span>
        <span className="text-gray-200">|</span>
        <span className="text-[10px] text-gray-400">Shift: 15° 스냅</span>
        <button
          onClick={() => bounds && onConfirm(bounds)}
          className="flex items-center gap-1 rounded bg-[#a60739] px-3 py-1 text-xs text-white hover:bg-[#8a062f]"
        >
          <Check size={12} />
          확정
        </button>
        <button
          onClick={onCancel}
          className="flex items-center gap-1 rounded bg-gray-100 px-3 py-1 text-xs text-gray-600 hover:bg-gray-200"
        >
          <X size={12} />
          취소
        </button>
      </div>
    </>
  );
}
