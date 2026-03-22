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

/** [lat, lon] → [lon, lat] for MapLibre */
function toCoord(ll: [number, number]): [number, number] {
  return [ll[1], ll[0]];
}

/** Compute initial bounds from map viewport */
function defaultBoundsFromView(map: maplibregl.Map, aspectRatio: number): PlanImageBounds {
  const bounds = map.getBounds();
  const center = map.getCenter();
  const lonSpan = (bounds.getEast() - bounds.getWest()) * 0.4;
  const latSpan = lonSpan / aspectRatio;
  const halfLon = lonSpan / 2;
  const halfLat = latSpan / 2;
  return {
    topLeft: [center.lat + halfLat, center.lng - halfLon],
    topRight: [center.lat + halfLat, center.lng + halfLon],
    bottomRight: [center.lat - halfLat, center.lng + halfLon],
    bottomLeft: [center.lat - halfLat, center.lng - halfLon],
  };
}

/** 원본 비율 유지하면서 코너 드래그 시 새 bounds 계산 */
function resizeKeepingAspect(
  corner: keyof PlanImageBounds,
  lat: number,
  lon: number,
  prev: PlanImageBounds,
  aspectRatio: number,
): PlanImageBounds {
  // 드래그 코너의 대각 고정점
  const oppositeMap: Record<keyof PlanImageBounds, keyof PlanImageBounds> = {
    topLeft: "bottomRight",
    topRight: "bottomLeft",
    bottomRight: "topLeft",
    bottomLeft: "topRight",
  };
  const anchor = prev[oppositeMap[corner]];
  const anchorLat = anchor[0];
  const anchorLon = anchor[1];

  // 드래그 지점과 고정점 간의 거리
  let dLat = Math.abs(lat - anchorLat);
  let dLon = Math.abs(lon - anchorLon);

  // 비율 유지: 더 작은 축을 비율에 맞게 확장
  const currentRatio = dLon / (dLat || 0.0001);
  if (currentRatio > aspectRatio) {
    // 가로가 넓으면 → 세로를 확장
    dLat = dLon / aspectRatio;
  } else {
    // 세로가 넓으면 → 가로를 확장
    dLon = dLat * aspectRatio;
  }

  // 최소 크기 제한
  dLat = Math.max(dLat, 0.0005);
  dLon = Math.max(dLon, 0.0005);

  // 드래그 방향에 따라 부호 결정
  const signLat = lat >= anchorLat ? 1 : -1;
  const signLon = lon >= anchorLon ? 1 : -1;

  const dragLat = anchorLat + signLat * dLat;
  const dragLon = anchorLon + signLon * dLon;

  // top/bottom, left/right 결정
  const minLat = Math.min(anchorLat, dragLat);
  const maxLat = Math.max(anchorLat, dragLat);
  const minLon = Math.min(anchorLon, dragLon);
  const maxLon = Math.max(anchorLon, dragLon);

  return {
    topLeft: [maxLat, minLon],
    topRight: [maxLat, maxLon],
    bottomRight: [minLat, maxLon],
    bottomLeft: [minLat, minLon],
  };
}

/** 맵 source 좌표 업데이트 헬퍼 */
function updateSourceCoords(map: maplibregl.Map, sourceId: string, b: PlanImageBounds) {
  try {
    const source = map.getSource(sourceId) as maplibregl.ImageSource | undefined;
    if (source) {
      source.setCoordinates([
        toCoord(b.topLeft),
        toCoord(b.topRight),
        toCoord(b.bottomRight),
        toCoord(b.bottomLeft),
      ]);
    }
  } catch {
    // 맵이 이미 파괴된 경우 무시
  }
}

export default function ImagePositioner({ map, groupId, imageDataUrl, initialBounds, opacity = 0.6, onConfirm, onCancel }: Props) {
  const sourceId = `positioning-image-${groupId}`;
  const layerId = `positioning-raster-${groupId}`;
  const [bounds, setBounds] = useState<PlanImageBounds | null>(null);
  const boundsRef = useRef<PlanImageBounds | null>(null);
  const rafRef = useRef<number>(0);
  // 이미지 종횡비 (width / height, lon방향 / lat방향)
  const aspectRef = useRef<number>(1);

  // 이미지 로드 → 종횡비 계산 → 초기 bounds 설정
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const aspect = img.width / img.height;
      aspectRef.current = aspect;
      const b = initialBounds && initialBounds.topLeft ? initialBounds : defaultBoundsFromView(map, aspect);
      setBounds(b);
      boundsRef.current = b;
    };
    img.src = imageDataUrl;
  }, [imageDataUrl, initialBounds, map]);

  // MapLibre image source 추가/업데이트
  useEffect(() => {
    if (!bounds) return;

    const coords: [[number, number], [number, number], [number, number], [number, number]] = [
      toCoord(bounds.topLeft),
      toCoord(bounds.topRight),
      toCoord(bounds.bottomRight),
      toCoord(bounds.bottomLeft),
    ];

    try {
      if (map.getSource(sourceId)) {
        (map.getSource(sourceId) as maplibregl.ImageSource).setCoordinates(coords);
        // opacity 변경 반영
        if (map.getLayer(layerId)) {
          map.setPaintProperty(layerId, "raster-opacity", opacity);
        }
      } else {
        map.addSource(sourceId, {
          type: "image",
          url: imageDataUrl,
          coordinates: coords,
        });
        // Insert below first symbol layer
        let beforeId: string | undefined;
        const style = map.getStyle();
        if (style?.layers) {
          for (const layer of style.layers) {
            if (layer.type === "symbol") { beforeId = layer.id; break; }
          }
        }
        map.addLayer({ id: layerId, type: "raster", source: sourceId, paint: { "raster-opacity": opacity, "raster-fade-duration": 0 } }, beforeId);
      }
    } catch {
      // 맵이 파괴된 경우 무시
    }
  }, [bounds, map, imageDataUrl, sourceId, layerId, opacity]);

  // Cleanup on unmount — 맵 파괴 여부 안전 체크
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      try {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
      } catch {
        // 맵이 이미 파괴된 경우 무시 (모달 닫기 시 MapGL 먼저 언마운트)
      }
    };
  }, [map, sourceId, layerId]);

  /** 코너 드래그 — 원본 비율 유지 리사이즈 */
  const handleCornerDrag = useCallback((corner: keyof PlanImageBounds, lat: number, lon: number) => {
    setBounds((prev) => {
      if (!prev) return prev;
      const next = resizeKeepingAspect(corner, lat, lon, prev, aspectRef.current);
      boundsRef.current = next;
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        if (boundsRef.current) updateSourceCoords(map, sourceId, boundsRef.current);
      });
      return next;
    });
  }, [map, sourceId]);

  /** Center marker drag — moves all 4 corners */
  const handleCenterDragStart = useCallback(() => {
    // 드래그 시작 시 현재 중심 기록 (boundsRef 직접 참조)
  }, []);

  const handleCenterDrag = useCallback((e: { lngLat: { lat: number; lng: number } }) => {
    if (!boundsRef.current) return;
    const b = boundsRef.current;
    const prevCLat = (b.topLeft[0] + b.bottomRight[0]) / 2;
    const prevCLon = (b.topLeft[1] + b.bottomRight[1]) / 2;
    const dLat = e.lngLat.lat - prevCLat;
    const dLon = e.lngLat.lng - prevCLon;
    const next: PlanImageBounds = {
      topLeft: [b.topLeft[0] + dLat, b.topLeft[1] + dLon],
      topRight: [b.topRight[0] + dLat, b.topRight[1] + dLon],
      bottomRight: [b.bottomRight[0] + dLat, b.bottomRight[1] + dLon],
      bottomLeft: [b.bottomLeft[0] + dLat, b.bottomLeft[1] + dLon],
    };
    boundsRef.current = next;
    setBounds(next);
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      if (boundsRef.current) updateSourceCoords(map, sourceId, boundsRef.current);
    });
  }, [map, sourceId]);

  if (!bounds) return null;

  const center: [number, number] = [
    (bounds.topLeft[0] + bounds.bottomRight[0]) / 2,
    (bounds.topLeft[1] + bounds.bottomRight[1]) / 2,
  ];

  const corners: { key: keyof PlanImageBounds; pos: [number, number] }[] = [
    { key: "topLeft", pos: bounds.topLeft },
    { key: "topRight", pos: bounds.topRight },
    { key: "bottomRight", pos: bounds.bottomRight },
    { key: "bottomLeft", pos: bounds.bottomLeft },
  ];

  return (
    <>
      {/* 코너 마커 (비율 유지 리사이즈) */}
      {corners.map(({ key, pos }) => (
        <Marker
          key={key}
          latitude={pos[0]}
          longitude={pos[1]}
          draggable
          onDrag={(e) => handleCornerDrag(key, e.lngLat.lat, e.lngLat.lng)}
          anchor="center"
        >
          <div className="h-4 w-4 rounded-full border-2 border-white bg-red-500 shadow cursor-nwse-resize" />
        </Marker>
      ))}

      {/* 중앙 마커 (전체 이동) */}
      <Marker
        latitude={center[0]}
        longitude={center[1]}
        draggable
        onDragStart={handleCenterDragStart}
        onDrag={handleCenterDrag}
        anchor="center"
      >
        <div className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-blue-500 shadow cursor-move">
          <Move size={14} className="text-white" />
        </div>
      </Marker>

      {/* 확인/취소 툴바 */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-lg bg-white px-3 py-2 shadow-lg border border-gray-200">
        <span className="text-xs text-gray-600 mr-2">코너를 드래그하여 크기 조정, 중앙을 드래그하여 이동</span>
        <button
          onClick={() => bounds && onConfirm(bounds)}
          className="flex items-center gap-1 rounded bg-[#a60739] px-3 py-1 text-xs text-white hover:bg-[#8a062f]"
        >
          <Check size={12} />
          위치 확정
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
