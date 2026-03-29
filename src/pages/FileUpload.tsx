import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import {
  Upload,
  FileUp,
  Trash2,
  Play,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertCircle,
  Radar,
  Plane,
  Globe,
  Plus,
  Pencil,
  Building2,
  ChevronRight,
  ChevronDown,
  Folder,
  Minus,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import MapGL, { Marker, Source, Layer, type MapRef } from "react-map-gl/maplibre";
import { useAppStore } from "../store";
import { sendPointsToWorker, startConsolidate, clearWorkerPoints, getPointSummary, createThrottledChunkHandler, setConsolidationProgressCallback } from "../utils/flightConsolidationWorker";
import maplibregl from "maplibre-gl";
import Modal from "../components/common/Modal";
import { Dropdown } from "../components/common/Dropdown";
import { SrtmDownloadSection, FacBuildingDataSection, LandUseDataSection, PeakDataSection } from "./Settings";
import type { AnalysisResult, BuildingGroup, Flight, GeometryType, ManualBuilding, UploadedFile } from "../types";

// ─── landuse 타일 프로토콜 ──────────────────────────────────────
let landuseProtocolRegistered = false;
function ensureLanduseProtocol() {
  if (landuseProtocolRegistered) return;
  landuseProtocolRegistered = true;
  maplibregl.addProtocol('landuse', async (params) => {
    const parts = params.url.replace('landuse://', '').split('/');
    const [z, x, y] = parts.map(Number);
    try {
      const base64 = await invoke<string | null>('get_landuse_tile', { z, x, y });
      if (!base64) return { data: new ArrayBuffer(0) };
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return { data: bytes.buffer };
    } catch {
      return { data: new ArrayBuffer(0) };
    }
  });
}

// ─── 건물 입력 모달 ──────────────────────────────────────────────

const MAP_STYLE = "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json";

interface BuildingFormData {
  name: string;
  latitude: string;
  longitude: string;
  height: string;
  ground_elev: string;
  memo: string;
  geometry_type: GeometryType;
  geometry_json: string | null;
  group_id: number | null;
}

const emptyForm: BuildingFormData = {
  name: "",
  latitude: "",
  longitude: "",
  height: "",
  ground_elev: "0",
  memo: "",
  geometry_type: "polygon",
  geometry_json: null,
  group_id: null,
};

/** 두 좌표 간 거리 (m) */
function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


/** 도형의 중심점 계산 */
function shapeCentroid(shape: { type: GeometryType; json: string | null }): [number, number] | null {
  if (!shape.json) return null;
  try {
    const val = JSON.parse(shape.json);
    if (Array.isArray(val) && val.length > 0) {
      return [
        val.reduce((s: number, c: number[]) => s + c[0], 0) / val.length,
        val.reduce((s: number, c: number[]) => s + c[1], 0) / val.length,
      ];
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** 도형 유형 한글 라벨 */
function shapeTypeLabel(type: string): string {
  switch (type) {
    case "polygon": return "다각형";
    case "multi": return "복합";
    default: return type;
  }
}

/** 단일 도형을 GeoJSON Feature로 변환 */
function shapeToGeoJsonFeature(shape: { type: GeometryType; json: string | null }, index?: number): GeoJSON.Feature | null {
  if (!shape.json) return null;
  try {
    if (shape.type === "polygon") {
      const pts: [number, number][] = JSON.parse(shape.json);
      if (pts.length >= 2) {
        const first = pts[0], last = pts[pts.length - 1];
        const isClosed = pts.length >= 4 && first[0] === last[0] && first[1] === last[1];
        return {
          type: "Feature",
          geometry: isClosed
            ? { type: "Polygon", coordinates: [pts.map(([lat, lon]) => [lon, lat])] }
            : { type: "LineString", coordinates: pts.map(([lat, lon]) => [lon, lat]) },
          properties: { index: index ?? -1 },
        };
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function BuildingModal({
  open: isOpen,
  onClose,
  onSave,
  initial,
  groups,
  allBuildings,
  defaultGroupId,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (data: BuildingFormData) => void;
  initial?: ManualBuilding | null;
  groups: BuildingGroup[];
  allBuildings: ManualBuilding[];
  defaultGroupId?: number | null;
}) {
  const [form, setForm] = useState<BuildingFormData>(emptyForm);
  const miniMapRef = useRef<MapRef>(null);
  const [miniMapReady, setMiniMapReady] = useState(false);

  // 같은 그룹의 기존 건물 GeoJSON (편집 중인 건물 제외)
  const groupBuildingsGeoJson = useMemo(() => {
    if (form.group_id == null) return null;
    const siblings = allBuildings.filter(
      (b) => b.group_id === form.group_id && (!initial || b.id !== initial.id),
    );
    if (siblings.length === 0) return null;
    const features: GeoJSON.Feature[] = [];
    for (const b of siblings) {
      if (b.geometry_type === "multi" && b.geometry_json) {
        try {
          const subs: { type: GeometryType; json: string }[] = JSON.parse(b.geometry_json);
          for (const s of subs) {
            const f = shapeToGeoJsonFeature(s);
            if (f) features.push(f);
          }
        } catch { /* ignore */ }
      } else {
        const f = shapeToGeoJsonFeature({ type: b.geometry_type, json: b.geometry_json });
        if (f) features.push(f);
      }
    }
    return features.length > 0
      ? { type: "FeatureCollection" as const, features }
      : null;
  }, [form.group_id, allBuildings, initial]);

  // 토지이용계획도 타일 레이어 추가
  useEffect(() => {
    const map = miniMapRef.current?.getMap();
    if (!map || !miniMapReady) return;

    // Add landuse tile layer if not already present
    if (!map.getSource('landuse-tiles')) {
      ensureLanduseProtocol();
      map.addSource('landuse-tiles', {
        type: 'raster',
        tiles: ['landuse://{z}/{x}/{y}'],
        tileSize: 256,
        minzoom: 10,
        maxzoom: 15,
      });
      map.addLayer({
        id: 'landuse-layer',
        type: 'raster',
        source: 'landuse-tiles',
        paint: { 'raster-opacity': 0.6 },
      });
    }
  }, [miniMapReady]);

  // 그리기 임시 상태: 클릭 포인트 축적 + 마우스 현재 위치
  const [clickPts, setClickPts] = useState<[number, number][]>([]); // [lat, lon][]
  const [mousePt, setMousePt] = useState<[number, number] | null>(null);
  // 확정된 도형 목록 (멀티 도형 건물용)
  const [confirmedShapes, setConfirmedShapes] = useState<{ type: GeometryType; json: string }[]>([]);

  // hover 중인 도형 인덱스 (확정된 도형 위에 삭제 버튼 표시)
  const [hoveredShapeIdx, setHoveredShapeIdx] = useState<number | null>(null);
  const [noGeomWarning, setNoGeomWarning] = useState(false);

  useEffect(() => {
    if (initial) {
      const isMulti = initial.geometry_type === "multi";
      setForm({
        name: initial.name,
        latitude: String(initial.latitude),
        longitude: String(initial.longitude),
        height: String(initial.height),
        ground_elev: String(initial.ground_elev),
        memo: initial.memo,
        geometry_type: isMulti ? "polygon" : (initial.geometry_type || "polygon"),
        geometry_json: isMulti ? null : (initial.geometry_json || null),
        group_id: initial.group_id ?? null,
      });
      if (isMulti && initial.geometry_json) {
        try {
          setConfirmedShapes(JSON.parse(initial.geometry_json));
        } catch {
          setConfirmedShapes([]);
        }
      } else {
        setConfirmedShapes([]);
      }
    } else {
      setForm(defaultGroupId != null ? { ...emptyForm, group_id: defaultGroupId } : emptyForm);
      setConfirmedShapes([]);
    }
    setClickPts([]);
    setMousePt(null);
    setHoveredShapeIdx(null);
    setNoGeomWarning(false);
    setMiniMapReady(false);
  }, [initial, isOpen, defaultGroupId]);

  const handleSubmit = () => {
    if (!form.name.trim() || !form.latitude || !form.longitude || !form.height) return;

    // 모든 도형 수집 (확정 목록 + 현재 도형)
    const allShapes = [...confirmedShapes];
    if (form.geometry_json && form.geometry_type !== "multi") {
      allShapes.push({ type: form.geometry_type, json: form.geometry_json });
    }

    // 도형 유효성 검증: 최소 하나의 유효한 도형 필요
    const hasValidGeometry = allShapes.some((s) => {
      if (!s.json) return false;
      try {
        const parsed = JSON.parse(s.json);
        if (s.type === "polygon" && Array.isArray(parsed)) return parsed.length >= 3;
        if (s.type === "multi" && Array.isArray(parsed)) return parsed.length >= 1;
        return false;
      } catch { return false; }
    });

    if (!hasValidGeometry) {
      setNoGeomWarning(true);
      return;
    }

    const finalForm = { ...form };
    if (allShapes.length > 1) {
      finalForm.geometry_type = "multi";
      finalForm.geometry_json = JSON.stringify(allShapes);
      // 전체 도형의 중심점 재계산
      const centers: [number, number][] = [];
      for (const s of allShapes) {
        const c = shapeCentroid(s);
        if (c) centers.push(c);
      }
      if (centers.length > 0) {
        finalForm.latitude = (centers.reduce((s, c) => s + c[0], 0) / centers.length).toFixed(6);
        finalForm.longitude = (centers.reduce((s, c) => s + c[1], 0) / centers.length).toFixed(6);
      }
    } else if (allShapes.length === 1 && confirmedShapes.length > 0) {
      finalForm.geometry_type = allShapes[0].type;
      finalForm.geometry_json = allShapes[0].json;
    }
    onSave(finalForm);
  };

  // Ctrl+Z 실행취소
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!((e.ctrlKey || e.metaKey) && e.key === "z")) return;
      e.preventDefault();

      // 1) 그리기 중: 마지막 클릭 취소
      if (clickPts.length > 0) {
        const next = clickPts.slice(0, -1);
        setClickPts(next);

        if (next.length >= 2) {
          const center = next.reduce(
            (acc, p) => [acc[0] + p[0] / next.length, acc[1] + p[1] / next.length] as [number, number],
            [0, 0] as [number, number],
          );
          setForm((f) => ({
            ...f,
            latitude: center[0].toFixed(6),
            longitude: center[1].toFixed(6),
            geometry_json: JSON.stringify(next),
          }));
        } else if (next.length === 1) {
          setForm((f) => ({
            ...f,
            latitude: next[0][0].toFixed(6),
            longitude: next[0][1].toFixed(6),
            geometry_json: JSON.stringify(next),
          }));
        } else {
          setForm((f) => ({ ...f, geometry_json: null }));
        }
        return;
      }

      // 2) 확정된 현재 도형 취소
      if (form.geometry_json) {
        setForm((f) => ({ ...f, geometry_type: "polygon" as GeometryType, geometry_json: null }));
        return;
      }

      // 3) 멀티 도형: 마지막 확정 도형 제거
      if (confirmedShapes.length > 0) {
        setConfirmedShapes((prev) => prev.slice(0, -1));
      }
    };

    if (isOpen) {
      window.addEventListener("keydown", handler);
      return () => window.removeEventListener("keydown", handler);
    }
  }, [isOpen, clickPts, form.geometry_json, form.geometry_type, confirmedShapes.length]);

  // 현재 도형을 확정 목록에 추가
  const addShapeToList = useCallback(() => {
    if (!form.geometry_json) return;
    // 최소 2포인트 필요
    try {
      const pts = JSON.parse(form.geometry_json) as any[];
      if (pts.length < 2) return;
    } catch { return; }
    setConfirmedShapes((prev) => [...prev, { type: form.geometry_type, json: form.geometry_json! }]);
    setForm((f) => ({ ...f, geometry_type: "polygon" as GeometryType, geometry_json: null }));
    setClickPts([]);
  }, [form.geometry_json, form.geometry_type]);

  // 도형 확정 후 맵 자동 fit bounds
  useEffect(() => {
    if (!miniMapRef.current || !form.geometry_json || clickPts.length > 0) return;
    try {
      const pts: [number, number][] = JSON.parse(form.geometry_json);
      if (pts.length >= 2) {
        let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
        for (const [lat, lon] of pts) {
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
        }
        miniMapRef.current.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 50, maxZoom: 18, duration: 500 });
      }
    } catch { /* ignore parse errors */ }
  }, [form.geometry_json, form.geometry_type, clickPts.length]);

  // 그룹 변경 시 해당 그룹의 영역으로 자동 줌
  const prevGroupIdRef = useRef<number | null>(undefined as any);
  const prevAreaBoundsRef = useRef<string | null>(null);
  useEffect(() => {
    if (!miniMapRef.current || !isOpen) return;
    if (form.group_id == null) {
      prevGroupIdRef.current = form.group_id;
      prevAreaBoundsRef.current = null;
      return;
    }
    const group = groups.find((g) => g.id === form.group_id);
    const areaBounds = group?.area_bounds_json ?? null;
    const groupChanged = form.group_id !== prevGroupIdRef.current;
    const areaChanged = areaBounds !== prevAreaBoundsRef.current;
    prevGroupIdRef.current = form.group_id;
    prevAreaBoundsRef.current = areaBounds;
    if (!groupChanged && !areaChanged) return;
    if (!areaBounds) return;
    try {
      const [[minLat, minLon], [maxLat, maxLon]] = JSON.parse(areaBounds);
      miniMapRef.current.fitBounds(
        [[minLon, minLat], [maxLon, maxLat]],
        { padding: 40, maxZoom: 18, duration: 600 },
      );
    } catch { /* ignore */ }
  }, [form.group_id, groups, isOpen]);

  // 모달 열릴 때 prevGroupIdRef 리셋
  useEffect(() => {
    if (!isOpen) {
      prevGroupIdRef.current = undefined as any;
      prevAreaBoundsRef.current = null;
    }
  }, [isOpen]);

  // 새 건물 추가 시 그룹에 영역이 설정되어 있으면 맵 로드 후 줌
  const handleMiniMapLoad = useCallback(() => {
    setMiniMapReady(true);
    // 그룹에 영역이 있으면 자동 줌 (신규/수정 모두)
    if (form.group_id != null) {
      const group = groups.find((g) => g.id === form.group_id);
      if (group?.area_bounds_json) {
        try {
          const [[minLat, minLon], [maxLat, maxLon]] = JSON.parse(group.area_bounds_json);
          setTimeout(() => {
            miniMapRef.current?.fitBounds(
              [[minLon, minLat], [maxLon, maxLat]],
              { padding: 40, maxZoom: 18, duration: 600 },
            );
          }, 100);
        } catch { /* ignore */ }
      }
    }
  }, [form.group_id, groups]);

  // 미니맵 클릭
  const handleMapClick = useCallback((evt: any) => {
    const { lngLat } = evt;
    const lat: number = lngLat.lat;
    const lon: number = lngLat.lng;
    const pt: [number, number] = [lat, lon];

    // 다각형이 완성된 상태에서 클릭 → 기존 도형 자동 확정 + 새 다각형 시작
    if (form.geometry_json && clickPts.length === 0) {
      // 기존 확정 도형이나 현재 완성 도형 내부 클릭인지 queryRenderedFeatures로 확인
      const map = miniMapRef.current?.getMap();
      if (map) {
        const point = map.project([lon, lat]);
        const hits = map.queryRenderedFeatures([point.x, point.y], {
          layers: ["confirmed-fill", "preview-fill"],
        });
        if (hits.length > 0) return; // 내부 클릭 → 무시
      }
      // 외부 클릭 → 현재 도형을 확정 목록에 추가 + 새 다각형 시작
      addShapeToList();
      // 새 다각형의 첫 꼭짓점으로 등록
      setClickPts([pt]);
      setForm((f) => ({
        ...f,
        latitude: lat.toFixed(6),
        longitude: lon.toFixed(6),
        geometry_type: "polygon",
        geometry_json: JSON.stringify([pt]),
      }));
      return;
    }

    setClickPts((prev) => {
      // 3개 이상 포인트 상태에서 첫 점 근처 클릭 → 닫힌 다각형으로 확정
      if (prev.length >= 3) {
        const first = prev[0];
        const snapDistM = 50;
        const map = miniMapRef.current?.getMap();
        let isSnap = haversineM(first[0], first[1], lat, lon) < snapDistM;
        if (!isSnap && map) {
          const firstPx = map.project([first[1], first[0]]);
          const clickPx = map.project([lon, lat]);
          const pxDist = Math.hypot(firstPx.x - clickPx.x, firstPx.y - clickPx.y);
          isSnap = pxDist < 12;
        }
        if (isSnap) {
          const closed = [...prev, prev[0]];
          const center = prev.reduce(
            (acc, p) => [acc[0] + p[0] / prev.length, acc[1] + p[1] / prev.length],
            [0, 0],
          );
          setForm((f) => ({
            ...f,
            latitude: center[0].toFixed(6),
            longitude: center[1].toFixed(6),
            geometry_type: "polygon",
            geometry_json: JSON.stringify(closed),
          }));
          return [];
        }
      }

      const updated = [...prev, pt];
      const center = updated.reduce(
        (acc, p) => [acc[0] + p[0] / updated.length, acc[1] + p[1] / updated.length],
        [0, 0],
      );
      setForm((f) => ({
        ...f,
        latitude: center[0].toFixed(6),
        longitude: center[1].toFixed(6),
        geometry_type: "polygon",
        geometry_json: JSON.stringify(updated),
      }));
      return updated;
    });
  }, [form.geometry_json, clickPts.length, addShapeToList]);

  // 더블클릭으로 열린 다각형(선) 완료
  const handleMapDblClick = useCallback((evt: any) => {
    evt.preventDefault();
    setClickPts((prev) => {
      if (prev.length < 2) return prev;
      const last = prev[prev.length - 1];
      const secondLast = prev[prev.length - 2];
      const cleaned = (last[0] === secondLast[0] && last[1] === secondLast[1])
        ? prev.slice(0, -1)
        : prev;
      if (cleaned.length < 2) return prev;
      const center = cleaned.reduce(
        (acc, p) => [acc[0] + p[0] / cleaned.length, acc[1] + p[1] / cleaned.length],
        [0, 0],
      );
      setForm((f) => ({
        ...f,
        latitude: center[0].toFixed(6),
        longitude: center[1].toFixed(6),
        geometry_type: "polygon" as GeometryType,
        geometry_json: JSON.stringify(cleaned),
      }));
      return [];
    });
  }, []);

  // 마우스 추적 (실시간 미리보기용 + 도형 hover 감지)
  const handleMapMouseMove = useCallback((evt: any) => {
    const { lngLat, point } = evt;
    setMousePt([lngLat.lat, lngLat.lng]);

    // 확정된 도형 hover 감지
    const map = miniMapRef.current?.getMap();
    if (map && clickPts.length === 0) {
      const hits = map.queryRenderedFeatures([point.x, point.y], {
        layers: ["confirmed-fill", "confirmed-line"],
      });
      if (hits.length > 0 && hits[0].properties?.index != null) {
        setHoveredShapeIdx(hits[0].properties.index);
      } else {
        // 현재 완성 도형 hover
        const previewHits = map.queryRenderedFeatures([point.x, point.y], {
          layers: ["preview-fill"],
        });
        if (previewHits.length > 0 && form.geometry_json) {
          setHoveredShapeIdx(-1); // -1 = 현재 도형
        } else {
          setHoveredShapeIdx(null);
        }
      }
    } else {
      setHoveredShapeIdx(null);
    }
  }, [clickPts.length, form.geometry_json]);

  // ── GeoJSON 미리보기 생성 ──

  const previewGeoJson = useMemo(() => {
    if (form.geometry_json && clickPts.length === 0) {
      // 확정된 도형 표시
      try {
        const pts: [number, number][] = JSON.parse(form.geometry_json);
        if (pts.length >= 2) {
          const first = pts[0], last = pts[pts.length - 1];
          const isClosed = pts.length >= 4 && first[0] === last[0] && first[1] === last[1];
          return {
            type: "Feature" as const,
            geometry: isClosed
              ? { type: "Polygon" as const, coordinates: [pts.map(([lat, lon]) => [lon, lat])] }
              : { type: "LineString" as const, coordinates: pts.map(([lat, lon]) => [lon, lat]) },
            properties: {},
          };
        }
      } catch { /* ignore */ }
    }
    return null;
  }, [clickPts.length, form.geometry_json]);

  // 그리기 중 진행 미리보기 (확정 전 점선, 첫 점 근처면 닫힌 다각형)
  const linePreviewGeoJson = useMemo(() => {
    if (clickPts.length === 0) return null;
    const pts = mousePt ? [...clickPts, mousePt] : clickPts;
    if (pts.length < 2) return null;

    // 3개 이상 꼭짓점 + 마우스가 첫 점 근처면 닫힌 다각형 미리보기
    if (clickPts.length >= 3 && mousePt) {
      const first = clickPts[0];
      let isNearFirst = haversineM(first[0], first[1], mousePt[0], mousePt[1]) < 50;
      if (!isNearFirst) {
        const map = miniMapRef.current?.getMap();
        if (map) {
          const firstPx = map.project([first[1], first[0]]);
          const mousePx = map.project([mousePt[1], mousePt[0]]);
          isNearFirst = Math.hypot(firstPx.x - mousePx.x, firstPx.y - mousePx.y) < 12;
        }
      }
      if (isNearFirst) {
        const closed = [...clickPts, clickPts[0]];
        return {
          type: "Feature" as const,
          geometry: { type: "Polygon" as const, coordinates: [closed.map(([lat, lon]) => [lon, lat])] },
          properties: {},
        };
      }
    }

    return {
      type: "Feature" as const,
      geometry: { type: "LineString" as const, coordinates: pts.map(([lat, lon]) => [lon, lat]) },
      properties: {},
    };
  }, [clickPts, mousePt]);

  // 확정된 멀티 도형 GeoJSON (index property로 hover 식별)
  const confirmedShapesGeoJson = useMemo(() => {
    if (confirmedShapes.length === 0) return null;
    const features: GeoJSON.Feature[] = [];
    for (let i = 0; i < confirmedShapes.length; i++) {
      const feat = shapeToGeoJsonFeature(confirmedShapes[i], i);
      if (feat) features.push(feat);
    }
    if (features.length === 0) return null;
    return { type: "FeatureCollection" as const, features };
  }, [confirmedShapes]);

  // hover 중인 도형의 중심 좌표 (삭제 버튼 위치)
  const hoveredShapeCentroid = useMemo<[number, number] | null>(() => {
    if (hoveredShapeIdx === null) return null;
    if (hoveredShapeIdx === -1) {
      // 현재 완성 도형
      return shapeCentroid({ type: form.geometry_type, json: form.geometry_json });
    }
    if (hoveredShapeIdx >= 0 && hoveredShapeIdx < confirmedShapes.length) {
      return shapeCentroid(confirmedShapes[hoveredShapeIdx]);
    }
    return null;
  }, [hoveredShapeIdx, confirmedShapes, form.geometry_type, form.geometry_json]);

  const markerLat = parseFloat(form.latitude);
  const markerLon = parseFloat(form.longitude);
  const hasMarker = !isNaN(markerLat) && !isNaN(markerLon);

  const mapCenter = hasMarker
    ? { latitude: markerLat, longitude: markerLon }
    : { latitude: 37.55, longitude: 126.99 };

  // 지면 표고 자동/수동 모드
  const [elevMode, setElevMode] = useState<"auto" | "manual">("auto");
  const [elevLoading, setElevLoading] = useState(false);

  // 초기값에 수동 표고가 있으면 수동 모드로 시작
  useEffect(() => {
    if (initial && initial.ground_elev > 0) {
      setElevMode("manual");
    } else {
      setElevMode("auto");
    }
  }, [initial, isOpen]);

  // 자동 모드: 위경도 변경 시 SRTM에서 표고 조회
  useEffect(() => {
    if (elevMode !== "auto") return;
    const lat = parseFloat(form.latitude);
    const lon = parseFloat(form.longitude);
    if (isNaN(lat) || isNaN(lon)) return;
    let cancelled = false;
    setElevLoading(true);
    invoke<number[]>("fetch_elevation", {
      latitudes: [lat],
      longitudes: [lon],
    }).then((elevs) => {
      if (cancelled) return;
      const elev = elevs[0] ?? 0;
      setForm((f) => ({ ...f, ground_elev: String(Math.round(elev)) }));
    }).catch(() => {
      if (cancelled) return;
      setForm((f) => ({ ...f, ground_elev: "0" }));
    }).finally(() => {
      if (!cancelled) setElevLoading(false);
    });
    return () => { cancelled = true; };
  }, [elevMode, form.latitude, form.longitude]);

  const fields: { key: keyof BuildingFormData; label: string; placeholder: string; type?: string; required?: boolean }[] = [
    { key: "name", label: "건물명", placeholder: "예: 남산타워", required: true },
    { key: "latitude", label: "위도", placeholder: "예: 37.5512", type: "number", required: true },
    { key: "longitude", label: "경도", placeholder: "예: 126.9882", type: "number", required: true },
    { key: "height", label: "건물 높이 (m)", placeholder: "예: 236.7", type: "number", required: true },
  ];

  return (
    <Modal open={isOpen} onClose={onClose} title={initial ? "건물 정보 수정" : "건물 수동 등록"} width="max-w-3xl">
      <div className="flex gap-4">
        {/* 왼쪽: 입력 폼 */}
        <div className="w-64 shrink-0 space-y-2.5">
          {/* 그룹 선택 (최상단) */}
          {groups.length > 0 && (
            <div>
              <label className="mb-0.5 block text-xs font-medium text-gray-600">그룹</label>
              <Dropdown
                trigger={
                  <div className="flex w-60 items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm">
                    <span className={form.group_id != null ? "text-gray-800" : "text-gray-400"}>
                      {form.group_id != null ? (groups.find((g) => g.id === form.group_id)?.name ?? "미분류") : "미분류"}
                    </span>
                    <ChevronDown size={14} className="text-gray-400" />
                  </div>
                }
                options={[
                  { key: "", label: "미분류" },
                  ...groups.map((g) => ({ key: String(g.id), label: g.name })),
                ]}
                selected={form.group_id != null ? String(form.group_id) : ""}
                onSelect={(key) => setForm((f) => ({ ...f, group_id: key ? Number(key) : null }))}
                width="w-full"
              />
            </div>
          )}

          {fields.map(({ key, label, placeholder, type, required }) => (
            <div key={key}>
              <label className="mb-0.5 block text-xs font-medium text-gray-600">
                {label}{required && <span className="text-red-500 ml-0.5">*</span>}
              </label>
              <input
                type={type ?? "text"}
                value={form[key] ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                placeholder={placeholder}
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-[#a60739] focus:outline-none focus:ring-1 focus:ring-[#a60739]/30"
              />
            </div>
          ))}

          {/* 지면 표고: 자동/수동 선택 */}
          <div>
            <div className="mb-0.5 flex items-center justify-between">
              <label className="text-xs font-medium text-gray-600">지면 표고 (m)</label>
              <div className="flex rounded-md border border-gray-200 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setElevMode("auto")}
                  className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                    elevMode === "auto"
                      ? "bg-[#a60739] text-white"
                      : "bg-gray-50 text-gray-400 hover:bg-gray-100"
                  }`}
                >
                  자동
                </button>
                <button
                  type="button"
                  onClick={() => setElevMode("manual")}
                  className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                    elevMode === "manual"
                      ? "bg-[#a60739] text-white"
                      : "bg-gray-50 text-gray-400 hover:bg-gray-100"
                  }`}
                >
                  수동
                </button>
              </div>
            </div>
            <div className="relative">
              <input
                type="number"
                value={form.ground_elev}
                onChange={(e) => setForm((f) => ({ ...f, ground_elev: e.target.value }))}
                placeholder="예: 243"
                disabled={elevMode === "auto"}
                className={`w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-[#a60739] focus:outline-none focus:ring-1 focus:ring-[#a60739]/30 ${
                  elevMode === "auto" ? "pr-8 text-gray-500" : ""
                }`}
              />
              {elevMode === "auto" && elevLoading && (
                <Loader2 size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-gray-400" />
              )}
              {elevMode === "auto" && !elevLoading && form.ground_elev && (
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-gray-400">SRTM</span>
              )}
            </div>
          </div>

          {/* 도형 유형 표시 */}
          {(form.geometry_json || confirmedShapes.length > 0) && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs text-gray-500">
              {confirmedShapes.length > 0
                ? `복합 도형 (${confirmedShapes.length + (form.geometry_json ? 1 : 0)}개)`
                : "도형: 다각형"
              }
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            {noGeomWarning && (
              <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-700">
                <span>건물 도형을 그려주세요. 도형이 없으면 장애물 분석에서 방위 구간을 산출할 수 없습니다.</span>
                <button onClick={() => setNoGeomWarning(false)} className="shrink-0 text-amber-400 hover:text-amber-600">✕</button>
              </div>
            )}
            <button
              onClick={onClose}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 transition-colors"
            >
              취소
            </button>
            <button
              onClick={handleSubmit}
              disabled={
                !form.name.trim() || !form.latitude || !form.longitude || !form.height
                || clickPts.length > 0 // 그리기 중에는 제출 불가
                || (form.geometry_type === "polygon" && !!form.geometry_json && (() => { try { return (JSON.parse(form.geometry_json!) as any[]).length < 2; } catch { return true; } })())
              }
              className="rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white hover:bg-[#85062e] disabled:opacity-40 transition-colors"
            >
              {initial ? "수정" : "등록"}
            </button>
          </div>
        </div>

        {/* 오른쪽: 미니맵 */}
        <div className="flex-1 flex flex-col gap-2">
          {/* 도구 모음 */}
          <div className="flex items-center gap-1">
            {/* 선 확정 버튼: 2개 이상 꼭짓점일 때 (열린 다각형 확정) */}
            {clickPts.length >= 2 && (
              <button
                onClick={() => setClickPts([])}
                className="rounded-lg bg-[#a60739] px-2.5 py-1.5 text-xs font-medium text-white hover:bg-[#85062e] transition-colors"
              >
                선 확정
              </button>
            )}
            {clickPts.length > 0 && (
              <button
                onClick={() => {
                  setClickPts([]);
                  setForm((f) => ({ ...f, geometry_type: "polygon" as GeometryType, geometry_json: null }));
                }}
                className="rounded-lg bg-gray-100 px-2 py-1.5 text-xs text-gray-500 hover:bg-gray-200 transition-colors"
              >
                초기화
              </button>
            )}
            {clickPts.length === 0 && !form.geometry_json && confirmedShapes.length === 0 && (
              <span className="text-[10px] text-gray-400">클릭하여 다각형 그리기 시작 · 더블클릭으로 완료 · Ctrl+Z 실행취소</span>
            )}
          </div>

          {/* 확정된 도형 목록 (멀티 도형) */}
          {confirmedShapes.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-gray-400">확정 도형:</span>
              {confirmedShapes.map((s, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 rounded-md bg-blue-50 border border-blue-200 px-2 py-0.5 text-[10px] text-blue-700"
                >
                  {shapeTypeLabel(s.type)}
                  <button
                    onClick={() => setConfirmedShapes((prev) => prev.filter((_, j) => j !== i))}
                    className="text-blue-400 hover:text-red-500 font-bold"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* 지도 */}
          <div className="relative h-80 w-full overflow-hidden rounded-xl border border-gray-200">
            <MapGL
              ref={miniMapRef}
              initialViewState={{
                ...mapCenter,
                zoom: hasMarker ? 14 : 7,
                pitch: 0,
              }}
              maxPitch={0}
              mapStyle={MAP_STYLE}
              style={{ width: "100%", height: "100%" }}
              cursor="crosshair"
              onClick={handleMapClick}
              onDblClick={handleMapDblClick}
              onMouseMove={handleMapMouseMove}
              attributionControl={false}
              doubleClickZoom={false}
              onLoad={handleMiniMapLoad}
            >
              {/* 그룹 영역 바운드 표시 */}
              {form.group_id != null && (() => {
                const group = groups.find((g) => g.id === form.group_id);
                if (!group?.area_bounds_json) return null;
                try {
                  const [[minLat, minLon], [maxLat, maxLon]] = JSON.parse(group.area_bounds_json);
                  const coords = [[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]];
                  return (
                    <Source id="group-area" type="geojson" data={{
                      type: "Feature", geometry: { type: "Polygon", coordinates: [coords] }, properties: {},
                    } as any}>
                      <Layer id="group-area-outline" type="line" paint={{ "line-color": group.color, "line-width": 1.5, "line-dasharray": [5, 3] }} />
                    </Source>
                  );
                } catch { return null; }
              })()}
              {/* 같은 그룹의 기존 건물 (회색, 반투명) */}
              <Source
                id="group-buildings"
                type="geojson"
                data={(groupBuildingsGeoJson ?? { type: "FeatureCollection", features: [] }) as any}
              >
                <Layer
                  id="group-buildings-fill"
                  type="fill"
                  paint={{ "fill-color": "#6b7280", "fill-opacity": 0.2 }}
                  filter={["==", ["geometry-type"], "Polygon"]}
                />
                <Layer
                  id="group-buildings-outline"
                  type="line"
                  paint={{ "line-color": "#6b7280", "line-width": 1.5, "line-dasharray": [3, 2] }}
                  filter={["==", ["geometry-type"], "Polygon"]}
                />
                <Layer
                  id="group-buildings-line"
                  type="line"
                  paint={{ "line-color": "#6b7280", "line-width": 1.5, "line-dasharray": [3, 2] }}
                  filter={["==", ["geometry-type"], "LineString"]}
                />
              </Source>
              {/* 확정된 멀티 도형 (파란색) */}
              <Source
                id="confirmed-shapes"
                type="geojson"
                data={(confirmedShapesGeoJson ?? { type: "FeatureCollection", features: [] }) as any}
              >
                <Layer
                  id="confirmed-fill"
                  type="fill"
                  paint={{ "fill-color": "#3b82f6", "fill-opacity": 0.15 }}
                  filter={["==", ["geometry-type"], "Polygon"]}
                />
                <Layer
                  id="confirmed-outline"
                  type="line"
                  paint={{ "line-color": "#3b82f6", "line-width": 2 }}
                  filter={["==", ["geometry-type"], "Polygon"]}
                />
                <Layer
                  id="confirmed-line"
                  type="line"
                  paint={{ "line-color": "#3b82f6", "line-width": 2.5 }}
                  filter={["==", ["geometry-type"], "LineString"]}
                />
              </Source>


              {/* 도형 (미리보기 + 확정) — Source 항상 마운트하여 MapLibre 깜빡임 방지 */}
              <Source
                id="preview-shape"
                type="geojson"
                data={(previewGeoJson ?? linePreviewGeoJson ?? { type: "FeatureCollection", features: [] }) as any}
              >
                <Layer
                  id="preview-fill"
                  type="fill"
                  paint={{ "fill-color": "#a60739", "fill-opacity": 0.2 }}
                  filter={["==", ["geometry-type"], "Polygon"]}
                />
                <Layer
                  id="preview-outline"
                  type="line"
                  paint={{
                    "line-color": "#a60739",
                    "line-width": 2,
                    "line-dasharray": (previewGeoJson || linePreviewGeoJson?.geometry?.type === "Polygon") ? [1, 0] : [4, 3],
                  }}
                  filter={["==", ["geometry-type"], "Polygon"]}
                />
                <Layer
                  id="preview-line"
                  type="line"
                  paint={{
                    "line-color": "#a60739",
                    "line-width": 2.5,
                    "line-dasharray": linePreviewGeoJson && !previewGeoJson ? [4, 3] : [1, 0],
                  }}
                  filter={["==", ["geometry-type"], "LineString"]}
                />
              </Source>

              {/* 클릭 포인트 마커 (꼭짓점) */}
              {clickPts.map(([lat, lon], i) => (
                <Marker key={`cp-${i}`} latitude={lat} longitude={lon}>
                  <div className={
                    i === 0 && clickPts.length >= 3
                      ? "h-3.5 w-3.5 rounded-full border-2 border-[#a60739] bg-[#a60739]/30 ring-2 ring-[#a60739]/20"
                      : "h-2.5 w-2.5 rounded-full border-2 border-[#a60739] bg-white"
                  } />
                </Marker>
              ))}

              {/* hover 시 삭제 버튼 (확정된 도형 또는 현재 완성 도형) */}
              {hoveredShapeCentroid && clickPts.length === 0 && (
                <Marker latitude={hoveredShapeCentroid[0]} longitude={hoveredShapeCentroid[1]} anchor="center">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (hoveredShapeIdx === -1) {
                        // 현재 완성 도형 삭제
                        setForm((f) => ({ ...f, geometry_type: "polygon" as GeometryType, geometry_json: null }));
                      } else if (hoveredShapeIdx !== null && hoveredShapeIdx >= 0) {
                        setConfirmedShapes((prev) => prev.filter((_, j) => j !== hoveredShapeIdx));
                      }
                      setHoveredShapeIdx(null);
                    }}
                    className="flex items-center justify-center rounded-full bg-white/90 p-1.5 shadow-lg border border-red-300 hover:bg-red-50 transition-colors"
                    title="도형 삭제"
                  >
                    <Trash2 size={14} className="text-red-500" />
                  </button>
                </Marker>
              )}
            </MapGL>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ─── 건물 목록 패널 ──────────────────────────────────────────────

function ManualBuildingPanel() {
  const [buildings, setBuildings] = useState<ManualBuilding[]>([]);
  const [groups, setGroups] = useState<BuildingGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ManualBuilding | null>(null);
  const [addGroupId, setAddGroupId] = useState<number | null>(null);
  // 그룹 관리
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [editGroup, setEditGroup] = useState<BuildingGroup | null>(null);
  const [groupForm, setGroupForm] = useState({ name: "", color: "#6b7280", memo: "", area_bounds_json: null as string | null });
  const groupMapRef = useRef<MapRef>(null);
  const [areaDrawing, setAreaDrawing] = useState(false);
  const [areaFirstClick, setAreaFirstClick] = useState<[number, number] | null>(null); // [lat, lon]
  const [areaMousePt, setAreaMousePt] = useState<[number, number] | null>(null); // [lat, lon]
  // 카드 접기/펼치기
  const [cardOpen, setCardOpen] = useState(false);
  // 그룹 접기/펼치기
  const [collapsedGroups, setCollapsedGroups] = useState<Set<number>>(new Set());

  const loadData = useCallback(async () => {
    try {
      const [bList, gList] = await Promise.all([
        invoke<ManualBuilding[]>("list_manual_buildings"),
        invoke<BuildingGroup[]>("list_building_groups"),
      ]);
      setBuildings(bList);
      setGroups(gList);
      // 기본 접힘: 모든 그룹 + 미분류(0)
      setCollapsedGroups(new Set([0, ...gList.map((g) => g.id)]));
    } catch (e) {
      console.warn("데이터 로드 실패:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleSave = async (data: BuildingFormData) => {
    try {
      if (editTarget) {
        await invoke("update_manual_building", {
          id: editTarget.id,
          name: data.name.trim(),
          latitude: parseFloat(data.latitude),
          longitude: parseFloat(data.longitude),
          height: parseFloat(data.height),
          groundElev: parseFloat(data.ground_elev) || 0,
          memo: data.memo,
          geometryType: data.geometry_type || "polygon",
          geometryJson: data.geometry_json || null,
          groupId: data.group_id,
        });
      } else {
        await invoke("add_manual_building", {
          name: data.name.trim(),
          latitude: parseFloat(data.latitude),
          longitude: parseFloat(data.longitude),
          height: parseFloat(data.height),
          groundElev: parseFloat(data.ground_elev) || 0,
          memo: data.memo,
          geometryType: data.geometry_type || "polygon",
          geometryJson: data.geometry_json || null,
          groupId: data.group_id,
        });
      }
      setModalOpen(false);
      setEditTarget(null);
      loadData();
    } catch (e) {
      console.error("건물 저장 실패:", e);
    }
  };

  const handleDelete = async (b: ManualBuilding) => {
    try {
      await invoke("delete_manual_building", { id: b.id });
      loadData();
    } catch (e) {
      console.error("건물 삭제 실패:", e);
    }
  };

  const openAdd = () => {
    setEditTarget(null);
    setAddGroupId(null);
    setModalOpen(true);
  };

  const openAddInGroup = (groupId: number) => {
    setEditTarget(null);
    setAddGroupId(groupId);
    setModalOpen(true);
  };

  const openEdit = (b: ManualBuilding) => {
    setEditTarget(b);
    setAddGroupId(null);
    setModalOpen(true);
  };

  // 그룹 CRUD
  const openGroupAdd = () => {
    setEditGroup(null);
    setGroupForm({ name: "", color: "#6b7280", memo: "", area_bounds_json: null });
    setAreaDrawing(false);
    setAreaFirstClick(null);
    setAreaMousePt(null);
    setGroupModalOpen(true);
  };
  const openGroupEdit = async (g: BuildingGroup) => {
    setEditGroup(g);
    setGroupForm({ name: g.name, color: g.color, memo: g.memo, area_bounds_json: g.area_bounds_json ?? null });
    setAreaDrawing(false);
    setAreaFirstClick(null);
    setAreaMousePt(null);
    setGroupModalOpen(true);
  };
  const handleGroupSave = async () => {
    if (!groupForm.name.trim()) return;
    try {
      if (editGroup) {
        await invoke("update_building_group", {
          id: editGroup.id,
          name: groupForm.name.trim(),
          color: groupForm.color,
          memo: groupForm.memo,
          areaBoundsJson: groupForm.area_bounds_json || null,
        });
        // 수정된 그룹 펼치기
        setCollapsedGroups((prev) => { const next = new Set(prev); next.delete(editGroup.id); return next; });
      } else {
        const newId = await invoke<number>("add_building_group", {
          name: groupForm.name.trim(),
          color: groupForm.color,
          memo: groupForm.memo,
          areaBoundsJson: groupForm.area_bounds_json || null,
        });
        // 새 그룹 펼치기
        setCollapsedGroups((prev) => { const next = new Set(prev); next.delete(newId); return next; });
      }
      setGroupModalOpen(false);
      loadData();
    } catch (e) { console.error("그룹 저장 실패:", e); }
  };
  const handleGroupDelete = async (g: BuildingGroup) => {
    try {
      await invoke("delete_building_group", { id: g.id });
      loadData();
    } catch (e) { console.error("그룹 삭제 실패:", e); }
  };
  const toggleCollapse = (groupId: number) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  // 그룹별로 건물 분류
  const groupedBuildings = useMemo(() => {
    const map = new Map<number | null, ManualBuilding[]>();
    for (const b of buildings) {
      const key = b.group_id;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(b);
    }
    return map;
  }, [buildings]);

  const getGroupName = (id: number | null) => {
    if (!id) return "미분류";
    return groups.find((g) => g.id === id)?.name ?? "미분류";
  };
  const getGroupColor = (id: number | null) => {
    if (!id) return "#9ca3af";
    return groups.find((g) => g.id === id)?.color ?? "#9ca3af";
  };

  // 그룹 순서: 그룹 목록 순서 + 미분류 마지막
  const sortedGroupKeys = useMemo(() => {
    const keys = [...groupedBuildings.keys()];
    return keys.sort((a, b) => {
      if (a === null) return 1;
      if (b === null) return -1;
      const ia = groups.findIndex((g) => g.id === a);
      const ib = groups.findIndex((g) => g.id === b);
      return ia - ib;
    });
  }, [groupedBuildings, groups]);


  const renderBuildingRow = (b: ManualBuilding) => (
    <div key={b.id} className="flex items-center gap-3 px-3 py-2 hover:bg-gray-100 transition-colors group">
      {b.geometry_type === "multi" ? <Plus size={14} className="shrink-0 text-blue-400" />
        : b.geometry_type === "polygon" ? <Minus size={14} className="shrink-0 text-gray-400" />
        : <Building2 size={14} className="shrink-0 text-gray-400" />}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-gray-800 truncate">{b.name}</span>
          <span className="text-[10px] text-gray-400">{b.height}m</span>
          {b.geometry_type && b.geometry_json && (
            <span className="text-[9px] text-gray-400 bg-gray-200 px-1 rounded">
              {shapeTypeLabel(b.geometry_type)}
              {b.geometry_type === "multi" && b.geometry_json && (() => {
                try { return ` (${JSON.parse(b.geometry_json).length})`; } catch { return ""; }
              })()}
            </span>
          )}
        </div>
        <div className="text-[10px] text-gray-400">
          {b.latitude.toFixed(4)}°N, {b.longitude.toFixed(4)}°E
          {b.ground_elev > 0 && ` · 표고 ${b.ground_elev}m`}
          {b.memo && ` · ${b.memo}`}
        </div>
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={() => openEdit(b)}
          className="rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700 transition-colors"
          title="수정"
        >
          <Pencil size={12} />
        </button>
        <button
          onClick={() => handleDelete(b)}
          className="rounded p-1 text-gray-400 hover:bg-red-100 hover:text-red-600 transition-colors"
          title="삭제"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );

  return (
    <>
      <div className="rounded-xl border border-gray-200 bg-gray-50 overflow-hidden px-5 py-[13px] cursor-pointer select-none" onClick={(e) => { if (!(e.target as HTMLElement).closest("button, a")) setCardOpen((c) => !c); }}>
        {/* Header — 참조 데이터 카드와 동일한 grid 레이아웃 */}
          <div className="grid items-center gap-3" style={{ gridTemplateColumns: "160px 1fr auto" }}>
            <div
              className="flex items-center gap-2"
            >
              <ChevronDown
                size={14}
                className={`text-gray-400 shrink-0 transition-transform duration-200 ${!cardOpen ? "-rotate-90" : ""}`}
              />
              <Building2 size={16} className="text-[#a60739] shrink-0" />
              <h2 className="text-sm font-semibold text-gray-800 whitespace-nowrap">수동 등록 건물</h2>
            </div>
            <div className="flex items-center gap-2 min-w-0">
              {!loading && buildings.length > 0 ? (
                <span className="text-xs text-gray-600">{buildings.length}건 등록{groups.length > 0 && <> · {groups.length}개 그룹</>}</span>
              ) : (
                <span className="text-xs text-gray-400">LoS 분석에 사용할 건물을 수동 등록합니다</span>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={openGroupAdd}
                className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100"
              >
                <Folder size={13} />
                그룹
              </button>
              <button
                onClick={openAdd}
                className="flex items-center gap-1.5 rounded-lg bg-[#a60739] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#8a0630]"
              >
                <Plus size={13} />
                건물 추가
              </button>
            </div>
          </div>

        {/* Expanded body */}
        {cardOpen && (
        <div className="mt-3 space-y-3" onClick={(e) => e.stopPropagation()}>
        {loading ? (
          <div className="flex items-center justify-center py-12 text-gray-400">
            <Loader2 size={20} className="animate-spin" />
          </div>
        ) : buildings.length === 0 && groups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 py-12 text-center">
            <Building2 size={32} className="mx-auto mb-2 text-gray-300" />
            <p className="text-sm text-gray-400">등록된 건물이 없습니다</p>
            <button
              onClick={openAdd}
              className="mt-3 text-sm font-medium text-[#a60739] hover:underline"
            >
              건물 추가하기
            </button>
          </div>
        ) : groups.length === 0 ? (
          /* 그룹 없으면 플랫 리스트 */
          <div className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white">
            {buildings.map(renderBuildingRow)}
          </div>
        ) : (
          /* 그룹별 접기/펼치기 리스트 */
          <div className="space-y-2">
            {sortedGroupKeys.map((gId) => {
              const items = groupedBuildings.get(gId) ?? [];
              const collapsed = collapsedGroups.has(gId ?? 0);
              const group = gId ? groups.find((g) => g.id === gId) : null;
              return (
                <div key={gId ?? "ungrouped"} className="overflow-hidden rounded-xl border border-gray-200 bg-white">
                  {/* 그룹 헤더 */}
                  <div
                    className="group/hdr flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-gray-100 transition-colors"
                    onClick={() => toggleCollapse(gId ?? 0)}
                  >
                    <ChevronRight
                      size={14}
                      className={`shrink-0 text-gray-400 transition-transform ${collapsed ? "" : "rotate-90"}`}
                    />
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: getGroupColor(gId) }}
                    />
                    <span className="text-sm font-medium text-gray-700">{getGroupName(gId)}</span>
                    <span className="text-[10px] text-gray-400">({items.length})</span>
                    {group && (
                      <div className="ml-auto flex items-center gap-1 opacity-0 group-hover/hdr:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={(e) => { e.stopPropagation(); openAddInGroup(group.id); }}
                          className="rounded p-1 text-gray-400 hover:bg-[#a60739]/10 hover:text-[#a60739] transition-colors"
                          title="이 그룹에 건물 추가"
                        >
                          <Plus size={10} />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); openGroupEdit(group); }}
                          className="rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700 transition-colors"
                          title="그룹 수정"
                        >
                          <Pencil size={10} />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleGroupDelete(group); }}
                          className="rounded p-1 text-gray-400 hover:bg-red-100 hover:text-red-600 transition-colors"
                          title="그룹 삭제"
                        >
                          <Trash2 size={10} />
                        </button>
                      </div>
                    )}
                  </div>
                  {/* 건물 목록 */}
                  {!collapsed && (
                    <div className="divide-y divide-gray-100 border-t border-gray-100">
                      {items.map(renderBuildingRow)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
        )}
      </div>

      <BuildingModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditTarget(null); setAddGroupId(null); }}
        onSave={handleSave}
        initial={editTarget}
        groups={groups}
        allBuildings={buildings}
        defaultGroupId={addGroupId}
      />

      {/* 그룹 관리 모달 */}
      <Modal open={groupModalOpen} onClose={() => setGroupModalOpen(false)} title={editGroup ? "그룹 수정" : "그룹 추가"} width="max-w-2xl">
        <div className="flex gap-4">
          {/* 왼쪽: 폼 */}
          <div className="w-56 shrink-0 space-y-3">
            <div>
              <label className="mb-0.5 block text-xs font-medium text-gray-600">그룹명 <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={groupForm.name}
                onChange={(e) => setGroupForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="예: 인천공항 주변"
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-[#a60739] focus:outline-none focus:ring-1 focus:ring-[#a60739]/30"
              />
            </div>
            <div>
              <label className="mb-0.5 block text-xs font-medium text-gray-600">색상</label>
              {(() => {
                const SPEC_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899"];
                const cssGrad = `linear-gradient(to right, ${SPEC_COLORS.join(", ")})`;
                // 클릭 위치 → hex 색상 변환 (canvas 1회 생성)
                const pickColor = (e: React.MouseEvent<HTMLDivElement>) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                  const cv = document.createElement("canvas");
                  cv.width = 256; cv.height = 1;
                  const ctx = cv.getContext("2d")!;
                  const g = ctx.createLinearGradient(0, 0, 256, 0);
                  SPEC_COLORS.forEach((c, i) => g.addColorStop(i / (SPEC_COLORS.length - 1), c));
                  ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 1);
                  const [r, gg, b] = ctx.getImageData(Math.round(x * 255), 0, 1, 1).data;
                  setGroupForm((f) => ({ ...f, color: `#${[r, gg, b].map((v) => v.toString(16).padStart(2, "0")).join("")}` }));
                };
                // 현재 색상의 스펙트럼 위치 (%)
                const hex = groupForm.color.replace("#", "");
                const pct = (() => {
                  const cr = parseInt(hex.slice(0, 2), 16), cg = parseInt(hex.slice(2, 4), 16), cb = parseInt(hex.slice(4, 6), 16);
                  // 각 정지점 색상과 비교하여 가장 가까운 구간 보간
                  const parsed = SPEC_COLORS.map((c) => {
                    const h = c.replace("#", "");
                    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)] as [number, number, number];
                  });
                  let bestIdx = 0, bestDist = Infinity;
                  for (let i = 0; i < parsed.length; i++) {
                    const d = (parsed[i][0] - cr) ** 2 + (parsed[i][1] - cg) ** 2 + (parsed[i][2] - cb) ** 2;
                    if (d < bestDist) { bestDist = d; bestIdx = i; }
                  }
                  return (bestIdx / (parsed.length - 1)) * 100;
                })();
                return (
                  <div className="flex items-center gap-2">
                    <div
                      className="relative h-5 flex-1 cursor-pointer rounded-full overflow-hidden"
                      style={{ background: cssGrad }}
                      onClick={pickColor}
                    >
                      <div
                        className="absolute top-0 h-full w-1.5 -translate-x-1/2 rounded-full border-2 border-white"
                        style={{ left: `${pct}%`, backgroundColor: groupForm.color, boxShadow: "0 0 3px rgba(0,0,0,0.4)" }}
                      />
                    </div>
                    <div className="h-5 w-5 shrink-0 rounded-full border border-gray-300" style={{ backgroundColor: groupForm.color }} />
                  </div>
                );
              })()}
            </div>
            {/* 영역 표시 */}
            {groupForm.area_bounds_json && (() => {
              try {
                const [[minLat, minLon], [maxLat, maxLon]] = JSON.parse(groupForm.area_bounds_json!);
                return (
                  <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-[10px] text-gray-500 space-y-0.5">
                    <div className="font-medium text-gray-600">설정된 영역</div>
                    <div>{minLat.toFixed(4)}°~ {maxLat.toFixed(4)}°N</div>
                    <div>{minLon.toFixed(4)}°~ {maxLon.toFixed(4)}°E</div>
                    <button
                      onClick={() => setGroupForm((f) => ({ ...f, area_bounds_json: null }))}
                      className="text-red-400 hover:text-red-600 mt-1"
                    >
                      영역 초기화
                    </button>
                  </div>
                );
              } catch { return null; }
            })()}
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setGroupModalOpen(false)}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 transition-colors"
              >
                취소
              </button>
              <button
                onClick={handleGroupSave}
                disabled={!groupForm.name.trim()}
                className="rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white hover:bg-[#85062e] disabled:opacity-40 transition-colors"
              >
                {editGroup ? "수정" : "추가"}
              </button>
            </div>
          </div>
          {/* 오른쪽: 영역 설정 미니맵 */}
          <div className="flex-1 flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-gray-600">영역 설정</label>
              {areaDrawing && (
                <span className="text-[10px] text-gray-400">
                  클릭하여 반대쪽 꼭짓점 지정
                </span>
              )}
            </div>
            <div className="relative h-64 w-full overflow-hidden rounded-xl border border-gray-200">
              <MapGL
                ref={groupMapRef}
                initialViewState={(() => {
                  if (groupForm.area_bounds_json) {
                    try {
                      const [[minLat, minLon], [maxLat, maxLon]] = JSON.parse(groupForm.area_bounds_json);
                      return { latitude: (minLat + maxLat) / 2, longitude: (minLon + maxLon) / 2, zoom: 12, pitch: 0 };
                    } catch { /* fallback */ }
                  }
                  return { latitude: 37.55, longitude: 126.99, zoom: 7, pitch: 0 };
                })()}
                maxPitch={0}
                mapStyle={MAP_STYLE}
                style={{ width: "100%", height: "100%" }}
                cursor={areaDrawing ? "crosshair" : "crosshair"}
                onClick={(evt) => {
                  const lat = evt.lngLat.lat;
                  const lon = evt.lngLat.lng;
                  if (!areaFirstClick) {
                    // 첫 번째 클릭: 시작점 지정
                    setAreaFirstClick([lat, lon]);
                    setAreaDrawing(true);
                  } else {
                    // 두 번째 클릭: 영역 확정
                    const minLat = Math.min(areaFirstClick[0], lat);
                    const maxLat = Math.max(areaFirstClick[0], lat);
                    const minLon = Math.min(areaFirstClick[1], lon);
                    const maxLon = Math.max(areaFirstClick[1], lon);
                    setGroupForm((f) => ({
                      ...f,
                      area_bounds_json: JSON.stringify([[minLat, minLon], [maxLat, maxLon]]),
                    }));
                    setAreaFirstClick(null);
                    setAreaDrawing(false);
                    setAreaMousePt(null);
                    // 확정된 영역으로 줌
                    setTimeout(() => {
                      groupMapRef.current?.fitBounds(
                        [[minLon, minLat], [maxLon, maxLat]],
                        { padding: 30, maxZoom: 18, duration: 500 },
                      );
                    }, 50);
                  }
                }}
                onMouseMove={(evt) => {
                  if (areaFirstClick) {
                    setAreaMousePt([evt.lngLat.lat, evt.lngLat.lng]);
                  }
                }}
                attributionControl={false}
                onLoad={() => {
                  // 토지이용계획도 타일 레이어 추가
                  const map = groupMapRef.current?.getMap();
                  if (map && !map.getSource('landuse-tiles')) {
                    ensureLanduseProtocol();
                    map.addSource('landuse-tiles', {
                      type: 'raster',
                      tiles: ['landuse://{z}/{x}/{y}'],
                      tileSize: 256,
                      minzoom: 10,
                      maxzoom: 15,
                    });
                    map.addLayer({
                      id: 'landuse-layer',
                      type: 'raster',
                      source: 'landuse-tiles',
                      paint: { 'raster-opacity': 0.6 },
                    });
                  }
                  // 기존 영역이 있으면 fitBounds로 정확하게 맞춤
                  if (groupForm.area_bounds_json) {
                    try {
                      const [[minLat, minLon], [maxLat, maxLon]] = JSON.parse(groupForm.area_bounds_json!);
                      setTimeout(() => {
                        groupMapRef.current?.fitBounds(
                          [[minLon, minLat], [maxLon, maxLat]],
                          { padding: 30, maxZoom: 18, duration: 500 },
                        );
                      }, 50);
                    } catch { /* ignore */ }
                  }
                }}
              >
                {/* 확정된 영역 사각형 표시 */}
                {groupForm.area_bounds_json && !areaDrawing && (() => {
                  try {
                    const [[minLat, minLon], [maxLat, maxLon]] = JSON.parse(groupForm.area_bounds_json!);
                    const coords = [[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]];
                    return (
                      <Source id="area-bounds" type="geojson" data={{
                        type: "Feature", geometry: { type: "Polygon", coordinates: [coords] }, properties: {},
                      } as any}>
                        <Layer id="area-fill" type="fill" paint={{ "fill-color": groupForm.color, "fill-opacity": 0.15 }} />
                        <Layer id="area-outline" type="line" paint={{ "line-color": groupForm.color, "line-width": 2 }} />
                      </Source>
                    );
                  } catch { return null; }
                })()}
                {/* 그리기 중 미리보기 사각형 */}
                {areaFirstClick && areaMousePt && (() => {
                  const minLat = Math.min(areaFirstClick[0], areaMousePt[0]);
                  const maxLat = Math.max(areaFirstClick[0], areaMousePt[0]);
                  const minLon = Math.min(areaFirstClick[1], areaMousePt[1]);
                  const maxLon = Math.max(areaFirstClick[1], areaMousePt[1]);
                  const coords = [[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]];
                  return (
                    <Source id="area-preview" type="geojson" data={{
                      type: "Feature", geometry: { type: "Polygon", coordinates: [coords] }, properties: {},
                    } as any}>
                      <Layer id="area-preview-fill" type="fill" paint={{ "fill-color": groupForm.color, "fill-opacity": 0.1 }} />
                      <Layer id="area-preview-outline" type="line" paint={{ "line-color": groupForm.color, "line-width": 2, "line-dasharray": [4, 3] }} />
                    </Source>
                  );
                })()}
                {/* 첫 번째 클릭 마커 */}
                {areaFirstClick && (
                  <Marker latitude={areaFirstClick[0]} longitude={areaFirstClick[1]}>
                    <div className="h-2.5 w-2.5 rounded-full border-2 bg-white" style={{ borderColor: groupForm.color }} />
                  </Marker>
                )}
              </MapGL>
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
}

// ─── 메인 페이지 ─────────────────────────────────────────────────

export default function FileUpload() {
  const uploadedFiles = useAppStore((s) => s.uploadedFiles);
  const addUploadedFile = useAppStore((s) => s.addUploadedFile);
  const updateUploadedFile = useAppStore((s) => s.updateUploadedFile);
  const clearUploadedFiles = useAppStore((s) => s.clearUploadedFiles);
  const removeUploadedFile = useAppStore((s) => s.removeUploadedFile);
  const removeUploadedFiles = useAppStore((s) => s.removeUploadedFiles);
  const addParseStats = useAppStore((s) => s.addParseStats);
  const workerPointCount = useAppStore((s) => s.workerPointCount);
  const workerPointSummary = useAppStore((s) => s.workerPointSummary);
  const setFlights = useAppStore((s) => s.setFlights);
  const aircraft = useAppStore((s) => s.aircraft);
  const radarSite = useAppStore((s) => s.radarSite);
  const setRadarSite = useAppStore((s) => s.setRadarSite);
  const customRadarSites = useAppStore((s) => s.customRadarSites);
  const [errorLog, setErrorLog] = useState<string[]>([]);
  // 파싱 모드: "aircraft" = 등록 비행검사기만, "all" = 전체 데이터
  const [parseMode, setParseMode] = useState<"aircraft" | "all">("aircraft");
  // 섹션 접기/펼치기 (자료 있을 때만 collapsible, 기본 접힘)
  const [uploadCollapsed, setUploadCollapsed] = useState(true);

  // 레이더 선택 모달 상태
  const [showRadarModal, setShowRadarModal] = useState(false);
  const [radarModalAction, setRadarModalAction] = useState<"single" | "all">("all");
  const [modalSelectedSite, setModalSelectedSite] = useState(radarSite);
  const pendingParseFileRef = useRef<UploadedFile | null>(null);

  // 모달에 표시할 전체 레이더 사이트 목록
  const allRadarSites = customRadarSites;

  // 등록 항공기별 비행 시간 범위 (Worker 요약 기반, 메인 스레드에 포인트 축적 안 함)
  const registeredTrackRanges = useMemo(() => {
    const activeMap = new Map<string, string>();
    for (const a of aircraft) {
      if (!a.active || !a.mode_s_code) continue;
      activeMap.set(a.mode_s_code.toUpperCase(), a.name);
    }
    const ranges = new Map<string, { name: string; minTs: number; maxTs: number; points: number }>();
    if (activeMap.size === 0 || !workerPointSummary) return ranges;
    for (const entry of workerPointSummary) {
      const ms = entry.modeS.toUpperCase();
      const name = activeMap.get(ms);
      if (name === undefined) continue;
      ranges.set(ms, { name, minTs: entry.minTs, maxTs: entry.maxTs, points: entry.count });
    }
    return ranges;
  }, [aircraft, workerPointSummary]);

  // 비행 통합 실행 (수동 병합 비행 보존, 비동기 — UI 논블로킹)
  const consolidatingRef = useRef(false);

  /** onFlightChunk 콜백 생성 (수동 병합 비행 필터링 + throttle 배치) */
  const makeChunkHandler = useCallback((manualFlights: Flight[]) => {
    const manualRanges = manualFlights.map((mf) => ({
      mode_s: mf.mode_s.toUpperCase(),
      start: mf.start_time,
      end: mf.end_time,
    }));
    const filterFn = (newFlights: Flight[]) => {
      const filtered = manualFlights.length > 0
        ? newFlights.filter((cf) => {
            const ms = cf.mode_s.toUpperCase();
            return !manualRanges.some((mr) =>
              mr.mode_s === ms && cf.start_time >= mr.start - 300 && cf.end_time <= mr.end + 300
            );
          })
        : newFlights;
      if (filtered.length > 0) {
        useAppStore.getState().appendFlights(filtered);
      }
    };
    return createThrottledChunkHandler(filterFn, 250);
  }, []);

  /**
   * 신규 파싱 후 통합 — Worker에 이미 ADD_POINTS 된 상태에서 호출.
   * Worker 버퍼를 소비(reuseBuffer=false)하여 통합.
   */
  const runConsolidation = useCallback(async () => {
    if (consolidatingRef.current) return;
    const state = useAppStore.getState();
    if (state.workerPointCount === 0) return;
    consolidatingRef.current = true;
    useAppStore.getState().setConsolidating(true);
    useAppStore.getState().setConsolidationProgress({ stage: "grouping", current: 0, total: 0, flightsBuilt: 0 });
    setConsolidationProgressCallback((p) => useAppStore.getState().setConsolidationProgress(p as any));
    try {
      const manualFlights = state.flights.filter((f) => f.match_type === "manual");
      if (manualFlights.length > 0) {
        setFlights(manualFlights);
      } else {
        setFlights([]);
      }

      const { handler, flush } = makeChunkHandler(manualFlights);
      await startConsolidate(
        [],
        state.aircraft,
        state.radarSite,
        handler,
      );
      flush();
    } finally {
      consolidatingRef.current = false;
      setConsolidationProgressCallback(null);
      useAppStore.getState().setConsolidating(false);
      useAppStore.getState().setConsolidationProgress(null);
      useAppStore.getState().finalizeFlights();
    }
  }, [setFlights, makeChunkHandler]);

  // workerPointSummary 변경 시 비행 통합
  useEffect(() => {
    if (workerPointCount > 0) runConsolidation();
  }, [registeredTrackRanges]); // eslint-disable-line react-hooks/exhaustive-deps

  // 파일 삭제 후 전체 클리어 + 재통합 (세션 기반 — DB 미사용)
  const clearAndResetData = useCallback(async () => {
    try {
      await clearWorkerPoints();
      useAppStore.setState({ workerPointCount: 0, workerPointSummary: null, flights: [] });
    } catch (e) {
      console.error("[FileUpload] clearAndResetData 실패:", e);
    }
  }, []);

  // 개별 파일 삭제
  const handleDeleteFile = useCallback(async (filePath: string) => {
    removeUploadedFile(filePath);
    await clearAndResetData();
  }, [removeUploadedFile, clearAndResetData]);

  // 레이더별 그룹 삭제
  const handleDeleteGroup = useCallback(async (groupFiles: UploadedFile[]) => {
    const paths = groupFiles.map((f) => f.path);
    removeUploadedFiles(paths);
    await clearAndResetData();
  }, [removeUploadedFiles, clearAndResetData]);

  const handleFilePick = async () => {
    try {
      const result = await open({
        multiple: true,
        filters: [
          { name: "ASS Files", extensions: ["ass", "ASS"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });
      if (result) {
        const paths = Array.isArray(result) ? result : [result];
        for (const filePath of paths) {
          if (typeof filePath === "string") {
            const name = filePath.split(/[/\\]/).pop() ?? filePath;
            if (!uploadedFiles.find((f) => f.path === filePath)) {
              addUploadedFile({
                path: filePath,
                name,
                status: "pending",
              });
            }
          }
        }
      }
    } catch (err) {
      setErrorLog((prev) => [
        ...prev,
        `파일 선택 오류: ${err instanceof Error ? err.message : String(err)}`,
      ]);
    }
  };

  // 파싱 전 레이더 선택 모달 표시
  const requestParseSingle = (file: UploadedFile) => {
    pendingParseFileRef.current = file;
    setRadarModalAction("single");
    setModalSelectedSite(radarSite);
    setShowRadarModal(true);
  };

  const requestParseAll = () => {
    pendingParseFileRef.current = null;
    setRadarModalAction("all");
    setModalSelectedSite(radarSite);
    setShowRadarModal(true);
  };

  const handleRadarConfirm = async () => {
    setShowRadarModal(false);
    setRadarSite(modalSelectedSite);
    const radarName = modalSelectedSite.name;
    if (radarModalAction === "single" && pendingParseFileRef.current) {
      updateUploadedFile(pendingParseFileRef.current.path, { radarName });
      await parseFile(pendingParseFileRef.current);
      // 단일 파일 파싱 후에도 비행 통합 (DB 로드는 registeredTrackRanges useEffect에서 처리)
      runConsolidation();
    } else {
      // 전체 파싱: 대기 중인 파일에 레이더 이름 할당
      const pending = useAppStore.getState().uploadedFiles.filter((f) => f.status === "pending");
      for (const f of pending) {
        updateUploadedFile(f.path, { radarName });
      }
      parseAllInternal();
    }
  };

  // Mode-S 필터 생성
  const getModeSFilter = (): string[] => {
    if (parseMode === "all") return [];
    const activeAircraft = useAppStore.getState().aircraft.filter((a) => a.active);
    if (activeAircraft.length === 0) return [];
    return activeAircraft.map((a) => a.mode_s_code.toUpperCase());
  };

  const parseFile = async (file: UploadedFile) => {
    updateUploadedFile(file.path, { status: "parsing" });

    try {
      const currentSite = useAppStore.getState().radarSite;
      const modeSFilter = getModeSFilter();
      const result: AnalysisResult = await invoke("parse_and_analyze", {
        filePath: file.path,
        radarLat: currentSite.latitude,
        radarLon: currentSite.longitude,
        modeSInclude: modeSFilter,
        modeSExclude: [],
        mode3aInclude: [],
        mode3aExclude: [],
      });

      // 원시 포인트에 radar_name 태깅 후 Worker에 직접 전송 (메인 축적 안 함)
      const radarName = useAppStore.getState().radarSite.name;
      for (const p of result.file_info.track_points) {
        p.radar_name = radarName;
      }
      await sendPointsToWorker(result.file_info.track_points);
      // Worker 요약 갱신
      const summary = await getPointSummary();
      useAppStore.setState({ workerPointCount: summary.totalPoints, workerPointSummary: summary.entries });

      // 파싱 통계 저장
      if (result.file_info.parse_stats) {
        addParseStats(
          result.file_info.filename,
          result.file_info.parse_stats,
          result.file_info.total_records,
        );
      }

      updateUploadedFile(file.path, {
        status: "done",
        parsedFile: result.file_info,
      });

      if (result.file_info.parse_errors.length > 0) {
        setErrorLog((prev) => [
          ...prev,
          ...result.file_info.parse_errors.map(
            (e) => `[${file.name}] ${e}`
          ),
        ]);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      updateUploadedFile(file.path, { status: "error", error: errMsg });
      setErrorLog((prev) => [...prev, `[${file.name}] 파싱 오류: ${errMsg}`]);
    }
  };

  const parseAllInternal = async () => {
    const pending = useAppStore.getState().uploadedFiles.filter((f) => f.status === "pending");
    if (pending.length === 0) return;

    for (const file of pending) {
      await parseFile(file);
    }

    // 모든 파일 파싱 완료 후 비행 통합
    runConsolidation();
  };

  const pendingCount = uploadedFiles.filter(
    (f) => f.status === "pending"
  ).length;
  const parsingCount = uploadedFiles.filter(
    (f) => f.status === "parsing"
  ).length;

  // 레이더별 파일 그룹핑
  const fileGroups = useMemo(() => {
    const groups = new Map<string, UploadedFile[]>();
    for (const file of uploadedFiles) {
      const key = file.radarName ?? "__pending__";
      const list = groups.get(key);
      if (list) list.push(file);
      else groups.set(key, [file]);
    }
    // 대기 중 그룹을 맨 앞, 나머지 레이더 이름 순 정렬
    const sorted: [string, UploadedFile[]][] = [];
    const pendingGroup = groups.get("__pending__");
    if (pendingGroup) sorted.push(["__pending__", pendingGroup]);
    for (const [key, files] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (key !== "__pending__") sorted.push([key, files]);
    }
    return sorted;
  }, [uploadedFiles]);

  // 그룹 접힘 상태 (기본: 접힘)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const statusIcon = (status: UploadedFile["status"]) => {
    switch (status) {
      case "pending":
        return <FileUp size={16} className="text-gray-500" />;
      case "parsing":
        return <Loader2 size={16} className="animate-spin text-blue-600" />;
      case "done":
        return <CheckCircle2 size={16} className="text-green-600" />;
      case "error":
        return <XCircle size={16} className="text-red-600" />;
    }
  };

  const statusText = (file: UploadedFile) => {
    switch (file.status) {
      case "pending":
        return "대기 중";
      case "parsing":
        return "파싱 중...";
      case "done":
        return `완료 (${file.parsedFile?.total_records ?? 0} 레코드)`;
      case "error":
        return file.error ?? "오류";
    }
  };

  return (
    <>
    <div className="space-y-4">
      {/* ── 자료 업로드 + 수동 건물 ── */}
      <div className="space-y-4">
      {/* ── 자료 업로드 ── */}
      {(() => {
        const hasFiles = uploadedFiles.length > 0;
        const isCollapsible = hasFiles;
        const isExpanded = !isCollapsible || !uploadCollapsed;
        const doneTotal = uploadedFiles.filter((f) => f.status === "done").length;
        return (
      <div className={`rounded-xl border border-gray-200 bg-gray-50 overflow-hidden px-5 py-[13px] ${isCollapsible ? "cursor-pointer select-none" : ""}`} onClick={(e) => { if (isCollapsible && !(e.target as HTMLElement).closest("button, a")) setUploadCollapsed((c) => !c); }}>
        {/* Header — 참조 데이터 카드와 동일한 grid 레이아웃 */}
          <div className="grid items-center gap-3" style={{ gridTemplateColumns: "160px 1fr auto" }}>
            <div
              className="flex items-center gap-2"
            >
              {isCollapsible && (
                <ChevronDown
                  size={14}
                  className={`text-gray-400 shrink-0 transition-transform duration-200 ${uploadCollapsed ? "-rotate-90" : ""}`}
                />
              )}
              <Upload size={16} className="text-[#a60739] shrink-0" />
              <h2 className="text-sm font-semibold text-gray-800 whitespace-nowrap">자료 업로드</h2>
            </div>
            <div className="flex items-center gap-2 min-w-0">
              {hasFiles ? (
                <>
                  <span className="text-xs text-gray-600">{uploadedFiles.length}개 파일{doneTotal > 0 && <> · <span className="text-emerald-600">{doneTotal}건 완료</span></>}</span>
                  {pendingCount > 0 && (
                    <button
                      onClick={requestParseAll}
                      disabled={parsingCount > 0}
                      className="flex items-center gap-1.5 rounded-lg bg-[#a60739] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#8a0630] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      <Play size={12} />
                      전체 파싱 ({pendingCount}건)
                    </button>
                  )}
                  <button
                    onClick={clearUploadedFiles}
                    className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-2 py-1 text-[11px] text-gray-400 hover:bg-gray-100 hover:text-red-500 transition-colors"
                    title="전체 삭제"
                  >
                    <Trash2 size={11} />
                    전체 삭제
                  </button>
                </>
              ) : (
                <span className="text-xs text-gray-400">NEC ASS 파일을 업로드하여 파싱합니다</span>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={handleFilePick}
                className="flex items-center gap-1.5 rounded-lg bg-[#a60739] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#8a0630]"
              >
                <Upload size={13} />
                파일 선택
              </button>
            </div>
          </div>

        {/* Expanded body */}
        {isExpanded && hasFiles && (
        <div className="mt-3 space-y-5" onClick={(e) => e.stopPropagation()}>
        {/* File List — 레이더별 그룹 */}
          <div className="space-y-2">
            {fileGroups.map(([groupKey, files]) => {
              const isPending = groupKey === "__pending__";
              const groupLabel = isPending ? "대기 중" : groupKey;
              const expanded = expandedGroups.has(groupKey);
              const doneCount = files.filter((f) => f.status === "done").length;
              return (
                <div key={groupKey} className="overflow-hidden rounded-xl border border-gray-200 bg-white">
                  {/* 그룹 헤더 */}
                  <button
                    onClick={() => toggleGroup(groupKey)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-100 transition-colors"
                  >
                    <ChevronRight
                      size={14}
                      className={`shrink-0 text-gray-400 transition-transform ${expanded ? "rotate-90" : ""}`}
                    />
                    {isPending ? (
                      <FileUp size={14} className="shrink-0 text-gray-400" />
                    ) : (
                      <Radar size={14} className="shrink-0 text-[#a60739]" />
                    )}
                    <span className="text-xs font-semibold text-gray-700">{groupLabel}</span>
                    <span className="text-[10px] text-gray-400">
                      {files.length}개{!isPending && doneCount > 0 && ` · ${doneCount}건 완료`}
                    </span>
                    <span className="flex-1" />
                    <span
                      role="button"
                      onClick={(e) => { e.stopPropagation(); handleDeleteGroup(files); }}
                      className="shrink-0 rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-500 transition-colors"
                      title={isPending ? "대기 파일 삭제" : `${groupLabel} 전체 삭제`}
                    >
                      <Trash2 size={12} />
                    </span>
                  </button>
                  {/* 파일 목록 */}
                  {expanded && (
                    <div className="divide-y divide-gray-100 border-t border-gray-200">
                      {files.map((file) => (
                        <div key={file.path} className="flex items-center gap-2 px-3 py-1.5 pl-9">
                          {statusIcon(file.status)}
                          <span className="truncate text-xs font-medium text-gray-800 min-w-0">{file.name}</span>
                          <span className="text-[10px] text-gray-400 truncate min-w-0 shrink">{file.path.replace(/[/\\][^/\\]+$/, '')}</span>
                          <span
                            className={`ml-auto shrink-0 text-[11px] ${
                              file.status === "done"
                                ? "text-green-600"
                                : file.status === "error"
                                  ? "text-red-600"
                                  : file.status === "parsing"
                                    ? "text-blue-600"
                                    : "text-gray-400"
                            }`}
                          >
                            {statusText(file)}
                          </span>
                          {file.status === "pending" && (
                            <button
                              onClick={() => requestParseSingle(file)}
                              className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-900 transition-colors"
                              title="파싱"
                            >
                              <Play size={12} />
                            </button>
                          )}
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDeleteFile(file.path); }}
                            className="shrink-0 rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-500 transition-colors"
                            title="삭제"
                          >
                            <Minus size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

        {/* Error Log */}
        {errorLog.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-base font-semibold text-gray-800">
                <AlertCircle size={16} className="text-yellow-600" />
                오류 로그
              </h2>
              <button
                onClick={() => setErrorLog([])}
                className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
              >
                로그 삭제
              </button>
            </div>
            <div className="max-h-48 overflow-auto rounded-xl border border-gray-200 bg-gray-100 p-4">
              {errorLog.map((msg, idx) => (
                <p
                  key={`err-${idx}`}
                  className="font-mono text-xs text-yellow-600/80 leading-relaxed"
                >
                  {msg}
                </p>
              ))}
            </div>
          </div>
        )}
      </div>
        )}
      </div>
        );
      })()}

      {/* ── 수동 등록 건물 ── */}
      <ManualBuildingPanel />

      {/* ── 참조 데이터 (건물 + 산 이름 + SRTM 지형) ── */}
      <div className="rounded-xl border border-gray-200 bg-gray-50 overflow-hidden">
        <FacBuildingDataSection />
      </div>
      <div className="rounded-xl border border-gray-200 bg-gray-50 overflow-hidden">
        <LandUseDataSection />
      </div>
      <div className="rounded-xl border border-gray-200 bg-gray-50 overflow-hidden">
        <PeakDataSection />
      </div>
      <div className="rounded-xl border border-gray-200 bg-gray-50 overflow-hidden">
        <SrtmDownloadSection />
      </div>
    </div>
    </div>

    {/* 레이더 사이트 선택 모달 */}
    {showRadarModal && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-2xl">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#a60739]/10">
              <Radar size={20} className="text-[#a60739]" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-800">
                레이더 사이트 선택
              </h3>
              <p className="text-xs text-gray-500">
                파싱에 사용할 레이더 사이트를 확인하세요
              </p>
            </div>
          </div>

          {/* 파싱 대상 선택 */}
          <div className="mb-4">
            <p className="text-xs text-gray-500 mb-2">파싱 대상</p>
            <div className="flex gap-2">
              <button
                onClick={() => setParseMode("aircraft")}
                className={`flex-1 flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-all ${
                  parseMode === "aircraft"
                    ? "border-[#a60739] bg-[#a60739] text-white"
                    : "border-gray-200 bg-gray-50 text-gray-500 hover:border-gray-300"
                }`}
              >
                <Plane size={14} />
                <span>비행검사기만</span>
                {parseMode === "aircraft" && (
                  <span className="text-[10px] text-white/80">
                    ({aircraft.filter((a) => a.active).length}대)
                  </span>
                )}
              </button>
              <button
                onClick={() => setParseMode("all")}
                className={`flex-1 flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-all ${
                  parseMode === "all"
                    ? "border-[#a60739] bg-[#a60739] text-white"
                    : "border-gray-200 bg-gray-50 text-gray-500 hover:border-gray-300"
                }`}
              >
                <Globe size={14} />
                <span>전체 데이터</span>
              </button>
            </div>
            {parseMode === "aircraft" && aircraft.filter((a) => a.active).length === 0 && (
              <p className="mt-1.5 text-xs text-yellow-600">
                등록된 활성 비행검사기가 없어 전체 데이터를 파싱합니다
              </p>
            )}
          </div>

          {/* 레이더 사이트 목록 */}
          <div className="space-y-2 mb-5 max-h-60 overflow-auto">
            {allRadarSites.map((site) => (
              <button
                key={site.name}
                onClick={() => setModalSelectedSite(site)}
                className={`w-full rounded-lg border px-4 py-3 text-left transition-all ${
                  site.name === modalSelectedSite.name
                    ? "border-[#a60739] bg-[#a60739] text-white"
                    : "border-gray-200 bg-gray-50 hover:border-gray-300 hover:bg-gray-100"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className={`text-sm font-medium ${site.name === modalSelectedSite.name ? "text-white" : "text-gray-800"}`}>
                    {site.name}
                  </span>
                  {site.name === modalSelectedSite.name && (
                    <span className="text-xs text-white/80">선택됨</span>
                  )}
                </div>
                <p className={`mt-0.5 text-xs ${site.name === modalSelectedSite.name ? "text-white/70" : "text-gray-500"}`}>
                  {site.latitude.toFixed(4)}°N, {site.longitude.toFixed(4)}°E
                  {site.range_nm ? ` · ${site.range_nm}NM` : ""}
                </p>
              </button>
            ))}
          </div>

          {/* 버튼 */}
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => setShowRadarModal(false)}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 transition-colors"
            >
              취소
            </button>
            <button
              onClick={handleRadarConfirm}
              className="rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white hover:bg-[#85062e] transition-colors"
            >
              파싱 시작
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
