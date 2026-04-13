import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import MapGL, { Marker, Source, Layer, type MapRef } from "react-map-gl/maplibre";
import { ChevronDown, Trash2, Loader2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import Modal from "./common/Modal";
import { Dropdown } from "./common/Dropdown";
import AddressSearch, { AddressMarker } from "./Map/AddressSearch";
import type { BuildingGroup, GeometryType, ManualBuilding } from "../types";
import { MAP_STYLE_URL } from "../utils/radarConstants";

// ─── landuse 프로토콜 (BuildingModal 전용) ──────────────────────
import maplibregl from "maplibre-gl";

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

// ─── 타입 & 유틸 ──────────────────────────────────────────────

export interface BuildingFormData {
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
  } catch { /* ignore */ }
  return null;
}

/** 도형 유형 한글 라벨 */
export function shapeTypeLabel(type: string): string {
  switch (type) {
    case "polygon": return "다각형";
    case "multi": return "복합";
    default: return type;
  }
}

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
  } catch { /* ignore */ }
  return null;
}

// ─── 컴포넌트 ──────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  onSave: (data: BuildingFormData) => void;
  initial?: ManualBuilding | null;
  groups: BuildingGroup[];
  allBuildings: ManualBuilding[];
  defaultGroupId?: number | null;
}

export default function BuildingModal({
  open: isOpen, onClose, onSave, initial, groups, allBuildings, defaultGroupId,
}: Props) {
  const [form, setForm] = useState<BuildingFormData>(emptyForm);
  const miniMapRef = useRef<MapRef>(null);
  const [miniMapReady, setMiniMapReady] = useState(false);

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

  // 토지이용계획도 타일 레이어
  useEffect(() => {
    const map = miniMapRef.current?.getMap();
    if (!map || !miniMapReady) return;
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

  const [clickPts, setClickPts] = useState<[number, number][]>([]);
  const [mousePt, setMousePt] = useState<[number, number] | null>(null);
  const [confirmedShapes, setConfirmedShapes] = useState<{ type: GeometryType; json: string }[]>([]);
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
        try { setConfirmedShapes(JSON.parse(initial.geometry_json)); } catch { setConfirmedShapes([]); }
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
    const allShapes = [...confirmedShapes];
    if (form.geometry_json && form.geometry_type !== "multi") {
      allShapes.push({ type: form.geometry_type, json: form.geometry_json });
    }
    const hasValidGeometry = allShapes.some((s) => {
      if (!s.json) return false;
      try {
        const parsed = JSON.parse(s.json);
        if (s.type === "polygon" && Array.isArray(parsed)) return parsed.length >= 3;
        if (s.type === "multi" && Array.isArray(parsed)) return parsed.length >= 1;
        return false;
      } catch { return false; }
    });
    if (!hasValidGeometry) { setNoGeomWarning(true); return; }
    const finalForm = { ...form };
    if (allShapes.length > 1) {
      finalForm.geometry_type = "multi";
      finalForm.geometry_json = JSON.stringify(allShapes);
      const centers: [number, number][] = [];
      for (const s of allShapes) { const c = shapeCentroid(s); if (c) centers.push(c); }
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
      if (clickPts.length > 0) {
        const next = clickPts.slice(0, -1);
        setClickPts(next);
        if (next.length >= 2) {
          const center = next.reduce(
            (acc, p) => [acc[0] + p[0] / next.length, acc[1] + p[1] / next.length] as [number, number],
            [0, 0] as [number, number],
          );
          setForm((f) => ({ ...f, latitude: center[0].toFixed(6), longitude: center[1].toFixed(6), geometry_json: JSON.stringify(next) }));
        } else if (next.length === 1) {
          setForm((f) => ({ ...f, latitude: next[0][0].toFixed(6), longitude: next[0][1].toFixed(6), geometry_json: JSON.stringify(next) }));
        } else {
          setForm((f) => ({ ...f, geometry_json: null }));
        }
        return;
      }
      if (form.geometry_json) {
        setForm((f) => ({ ...f, geometry_type: "polygon" as GeometryType, geometry_json: null }));
        return;
      }
      if (confirmedShapes.length > 0) {
        setConfirmedShapes((prev) => prev.slice(0, -1));
      }
    };
    if (isOpen) {
      window.addEventListener("keydown", handler);
      return () => window.removeEventListener("keydown", handler);
    }
  }, [isOpen, clickPts, form.geometry_json, form.geometry_type, confirmedShapes.length]);

  const addShapeToList = useCallback(() => {
    if (!form.geometry_json) return;
    try { const pts = JSON.parse(form.geometry_json) as any[]; if (pts.length < 2) return; } catch { return; }
    setConfirmedShapes((prev) => [...prev, { type: form.geometry_type, json: form.geometry_json! }]);
    setForm((f) => ({ ...f, geometry_type: "polygon" as GeometryType, geometry_json: null }));
    setClickPts([]);
  }, [form.geometry_json, form.geometry_type]);

  useEffect(() => {
    if (!miniMapRef.current || !form.geometry_json || clickPts.length > 0) return;
    try {
      const pts: [number, number][] = JSON.parse(form.geometry_json);
      if (pts.length >= 2) {
        let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
        for (const [lat, lon] of pts) {
          if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
          if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
        }
        miniMapRef.current.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 50, maxZoom: 18, duration: 500 });
      }
    } catch { /* ignore */ }
  }, [form.geometry_json, form.geometry_type, clickPts.length]);

  const prevGroupIdRef = useRef<number | null>(undefined as any);
  const prevAreaBoundsRef = useRef<string | null>(null);
  useEffect(() => {
    if (!miniMapRef.current || !isOpen) return;
    if (form.group_id == null) { prevGroupIdRef.current = form.group_id; prevAreaBoundsRef.current = null; return; }
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
      miniMapRef.current.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 40, maxZoom: 18, duration: 600 });
    } catch { /* ignore */ }
  }, [form.group_id, groups, isOpen]);

  useEffect(() => {
    if (!isOpen) { prevGroupIdRef.current = undefined as any; prevAreaBoundsRef.current = null; }
  }, [isOpen]);

  const handleMiniMapLoad = useCallback(() => {
    setMiniMapReady(true);
    if (form.group_id != null) {
      const group = groups.find((g) => g.id === form.group_id);
      if (group?.area_bounds_json) {
        try {
          const [[minLat, minLon], [maxLat, maxLon]] = JSON.parse(group.area_bounds_json);
          setTimeout(() => {
            miniMapRef.current?.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 40, maxZoom: 18, duration: 600 });
          }, 100);
        } catch { /* ignore */ }
      }
    }
  }, [form.group_id, groups]);

  const handleMapClick = useCallback((evt: any) => {
    const { lngLat } = evt;
    const lat: number = lngLat.lat;
    const lon: number = lngLat.lng;
    const pt: [number, number] = [lat, lon];

    if (form.geometry_json && clickPts.length === 0) {
      const map = miniMapRef.current?.getMap();
      if (map) {
        const point = map.project([lon, lat]);
        const hits = map.queryRenderedFeatures([point.x, point.y], { layers: ["confirmed-fill", "preview-fill"] });
        if (hits.length > 0) return;
      }
      addShapeToList();
      setClickPts([pt]);
      setForm((f) => ({ ...f, latitude: lat.toFixed(6), longitude: lon.toFixed(6), geometry_type: "polygon", geometry_json: JSON.stringify([pt]) }));
      return;
    }

    setClickPts((prev) => {
      if (prev.length >= 3) {
        const first = prev[0];
        const map = miniMapRef.current?.getMap();
        let isSnap = false;
        if (map) {
          const firstPx = map.project([first[1], first[0]]);
          const clickPx = map.project([lon, lat]);
          isSnap = Math.hypot(firstPx.x - clickPx.x, firstPx.y - clickPx.y) <= 9;
        }
        if (isSnap) {
          const closed = [...prev, prev[0]];
          const center = prev.reduce((acc, p) => [acc[0] + p[0] / prev.length, acc[1] + p[1] / prev.length], [0, 0]);
          setForm((f) => ({ ...f, latitude: center[0].toFixed(6), longitude: center[1].toFixed(6), geometry_type: "polygon", geometry_json: JSON.stringify(closed) }));
          return [];
        }
      }
      const updated = [...prev, pt];
      const center = updated.reduce((acc, p) => [acc[0] + p[0] / updated.length, acc[1] + p[1] / updated.length], [0, 0]);
      setForm((f) => ({ ...f, latitude: center[0].toFixed(6), longitude: center[1].toFixed(6), geometry_type: "polygon", geometry_json: JSON.stringify(updated) }));
      return updated;
    });
  }, [form.geometry_json, clickPts.length, addShapeToList]);

  const handleMapDblClick = useCallback((evt: any) => {
    evt.preventDefault();
    setClickPts((prev) => {
      if (prev.length < 2) return prev;
      const last = prev[prev.length - 1];
      const secondLast = prev[prev.length - 2];
      const cleaned = (last[0] === secondLast[0] && last[1] === secondLast[1]) ? prev.slice(0, -1) : prev;
      if (cleaned.length < 2) return prev;
      const center = cleaned.reduce((acc, p) => [acc[0] + p[0] / cleaned.length, acc[1] + p[1] / cleaned.length], [0, 0]);
      setForm((f) => ({ ...f, latitude: center[0].toFixed(6), longitude: center[1].toFixed(6), geometry_type: "polygon" as GeometryType, geometry_json: JSON.stringify(cleaned) }));
      return [];
    });
  }, []);

  const handleMapMouseMove = useCallback((evt: any) => {
    const { lngLat, point } = evt;
    setMousePt([lngLat.lat, lngLat.lng]);
    const map = miniMapRef.current?.getMap();
    if (map && clickPts.length === 0) {
      const hits = map.queryRenderedFeatures([point.x, point.y], { layers: ["confirmed-fill", "confirmed-line"] });
      if (hits.length > 0 && hits[0].properties?.index != null) {
        setHoveredShapeIdx(hits[0].properties.index);
      } else {
        const previewHits = map.queryRenderedFeatures([point.x, point.y], { layers: ["preview-fill"] });
        if (previewHits.length > 0 && form.geometry_json) {
          setHoveredShapeIdx(-1);
        } else {
          setHoveredShapeIdx(null);
        }
      }
    } else {
      setHoveredShapeIdx(null);
    }
  }, [clickPts.length, form.geometry_json]);

  const previewGeoJson = useMemo(() => {
    if (form.geometry_json && clickPts.length === 0) {
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

  const linePreviewGeoJson = useMemo(() => {
    if (clickPts.length === 0) return null;
    const pts = mousePt ? [...clickPts, mousePt] : clickPts;
    if (pts.length < 2) return null;
    if (clickPts.length >= 3 && mousePt) {
      const first = clickPts[0];
      let isNearFirst = false;
      const map = miniMapRef.current?.getMap();
      if (map) {
        const firstPx = map.project([first[1], first[0]]);
        const mousePx = map.project([mousePt[1], mousePt[0]]);
        isNearFirst = Math.hypot(firstPx.x - mousePx.x, firstPx.y - mousePx.y) <= 9;
      }
      if (isNearFirst) {
        const closed = [...clickPts, clickPts[0]];
        return { type: "Feature" as const, geometry: { type: "Polygon" as const, coordinates: [closed.map(([lat, lon]) => [lon, lat])] }, properties: {} };
      }
    }
    return { type: "Feature" as const, geometry: { type: "LineString" as const, coordinates: pts.map(([lat, lon]) => [lon, lat]) }, properties: {} };
  }, [clickPts, mousePt]);

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

  const hoveredShapeCentroid = useMemo<[number, number] | null>(() => {
    if (hoveredShapeIdx === null) return null;
    if (hoveredShapeIdx === -1) return shapeCentroid({ type: form.geometry_type, json: form.geometry_json });
    if (hoveredShapeIdx >= 0 && hoveredShapeIdx < confirmedShapes.length) return shapeCentroid(confirmedShapes[hoveredShapeIdx]);
    return null;
  }, [hoveredShapeIdx, confirmedShapes, form.geometry_type, form.geometry_json]);

  const markerLat = parseFloat(form.latitude);
  const markerLon = parseFloat(form.longitude);
  const hasMarker = !isNaN(markerLat) && !isNaN(markerLon);
  const mapCenter = hasMarker ? { latitude: markerLat, longitude: markerLon } : { latitude: 37.55, longitude: 126.99 };

  const [addressMarker, setAddressMarker] = useState<{ lat: number; lon: number; label: string } | null>(null);
  const handleAddressSelect = useCallback((lat: number, lon: number, label: string) => {
    if (lat !== 0 && lon !== 0) {
      miniMapRef.current?.flyTo({ center: [lon, lat], zoom: 17, duration: 600 });
      setAddressMarker({ lat, lon, label });
    } else {
      setAddressMarker(null);
    }
  }, []);

  useEffect(() => { if (!isOpen) setAddressMarker(null); }, [isOpen]);

  const [elevMode, setElevMode] = useState<"auto" | "manual">("auto");
  const [elevLoading, setElevLoading] = useState(false);

  useEffect(() => {
    if (initial && initial.ground_elev > 0) setElevMode("manual");
    else setElevMode("auto");
  }, [initial, isOpen]);

  useEffect(() => {
    if (elevMode !== "auto") return;
    const lat = parseFloat(form.latitude);
    const lon = parseFloat(form.longitude);
    if (isNaN(lat) || isNaN(lon)) return;
    let cancelled = false;
    setElevLoading(true);
    invoke<number[]>("fetch_elevation", { latitudes: [lat], longitudes: [lon] })
      .then((elevs) => { if (!cancelled) setForm((f) => ({ ...f, ground_elev: String(Math.round(elevs[0] ?? 0)) })); })
      .catch(() => { if (!cancelled) setForm((f) => ({ ...f, ground_elev: "0" })); })
      .finally(() => { if (!cancelled) setElevLoading(false); });
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

          {/* 지면 표고 */}
          <div>
            <div className="mb-0.5 flex items-center justify-between">
              <label className="text-xs font-medium text-gray-600">지면 표고 (m)</label>
              <div className="flex rounded-md border border-gray-200 overflow-hidden">
                <button type="button" onClick={() => setElevMode("auto")}
                  className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${elevMode === "auto" ? "bg-[#a60739] text-white" : "bg-gray-50 text-gray-400 hover:bg-gray-100"}`}>자동</button>
                <button type="button" onClick={() => setElevMode("manual")}
                  className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${elevMode === "manual" ? "bg-[#a60739] text-white" : "bg-gray-50 text-gray-400 hover:bg-gray-100"}`}>수동</button>
              </div>
            </div>
            <div className="relative">
              <input type="number" value={form.ground_elev}
                onChange={(e) => setForm((f) => ({ ...f, ground_elev: e.target.value }))}
                placeholder="예: 243" disabled={elevMode === "auto"}
                className={`w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-[#a60739] focus:outline-none focus:ring-1 focus:ring-[#a60739]/30 ${elevMode === "auto" ? "pr-8 text-gray-500" : ""}`} />
              {elevMode === "auto" && elevLoading && <Loader2 size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-gray-400" />}
              {elevMode === "auto" && !elevLoading && form.ground_elev && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-gray-400">SRTM</span>}
            </div>
          </div>

          {(form.geometry_json || confirmedShapes.length > 0) && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs text-gray-500">
              {confirmedShapes.length > 0 ? `복합 도형 (${confirmedShapes.length + (form.geometry_json ? 1 : 0)}개)` : "도형: 다각형"}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            {noGeomWarning && (
              <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-700">
                <span>건물 도형을 그려주세요. 도형이 없으면 장애물 분석에서 방위 구간을 산출할 수 없습니다.</span>
                <button onClick={() => setNoGeomWarning(false)} className="shrink-0 text-amber-400 hover:text-amber-600">✕</button>
              </div>
            )}
            <button onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 transition-colors">취소</button>
            <button onClick={handleSubmit}
              disabled={!form.name.trim() || !form.latitude || !form.longitude || !form.height || clickPts.length > 0 || (form.geometry_type === "polygon" && !!form.geometry_json && (() => { try { return (JSON.parse(form.geometry_json!) as any[]).length < 2; } catch { return true; } })())}
              className="rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white hover:bg-[#85062e] disabled:opacity-40 transition-colors">{initial ? "수정" : "등록"}</button>
          </div>
        </div>

        {/* 오른쪽: 미니맵 */}
        <div className="flex-1 flex flex-col gap-2">
          <div className="flex items-center gap-1">
            {clickPts.length >= 2 && (
              <button onClick={() => setClickPts([])} className="rounded-lg bg-[#a60739] px-2.5 py-1.5 text-xs font-medium text-white hover:bg-[#85062e] transition-colors">선 확정</button>
            )}
            {clickPts.length > 0 && (
              <button onClick={() => { setClickPts([]); setForm((f) => ({ ...f, geometry_type: "polygon" as GeometryType, geometry_json: null })); }}
                className="rounded-lg bg-gray-100 px-2 py-1.5 text-xs text-gray-500 hover:bg-gray-200 transition-colors">초기화</button>
            )}
            {clickPts.length === 0 && !form.geometry_json && confirmedShapes.length === 0 && (
              <span className="text-[10px] text-gray-400">클릭하여 다각형 그리기 시작 · 더블클릭으로 완료 · Ctrl+Z 실행취소</span>
            )}
          </div>

          {confirmedShapes.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-gray-400">확정 도형:</span>
              {confirmedShapes.map((s, i) => (
                <span key={i} className="inline-flex items-center gap-1 rounded-md bg-blue-50 border border-blue-200 px-2 py-0.5 text-[10px] text-blue-700">
                  {shapeTypeLabel(s.type)}
                  <button onClick={() => setConfirmedShapes((prev) => prev.filter((_, j) => j !== i))} className="text-blue-400 hover:text-red-500 font-bold">×</button>
                </span>
              ))}
            </div>
          )}

          <div className="relative h-80 w-full overflow-hidden rounded-xl border border-gray-200">
            <MapGL ref={miniMapRef} initialViewState={{ ...mapCenter, zoom: hasMarker ? 14 : 7, pitch: 0 }}
              maxPitch={0} mapStyle={MAP_STYLE_URL} style={{ width: "100%", height: "100%" }} cursor="crosshair"
              onClick={handleMapClick} onDblClick={handleMapDblClick} onMouseMove={handleMapMouseMove}
              attributionControl={false} doubleClickZoom={false} onLoad={handleMiniMapLoad}>
              {form.group_id != null && (() => {
                const group = groups.find((g) => g.id === form.group_id);
                if (!group?.area_bounds_json) return null;
                try {
                  const [[minLat, minLon], [maxLat, maxLon]] = JSON.parse(group.area_bounds_json);
                  const coords = [[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]];
                  return (<Source id="group-area" type="geojson" data={{ type: "Feature", geometry: { type: "Polygon", coordinates: [coords] }, properties: {} } as any}>
                    <Layer id="group-area-outline" type="line" paint={{ "line-color": group.color, "line-width": 1.5, "line-dasharray": [5, 3] }} />
                  </Source>);
                } catch { return null; }
              })()}
              <Source id="group-buildings" type="geojson" data={(groupBuildingsGeoJson ?? { type: "FeatureCollection", features: [] }) as any}>
                <Layer id="group-buildings-fill" type="fill" paint={{ "fill-color": "#6b7280", "fill-opacity": 0.2 }} filter={["==", ["geometry-type"], "Polygon"]} />
                <Layer id="group-buildings-outline" type="line" paint={{ "line-color": "#6b7280", "line-width": 1.5, "line-dasharray": [3, 2] }} filter={["==", ["geometry-type"], "Polygon"]} />
                <Layer id="group-buildings-line" type="line" paint={{ "line-color": "#6b7280", "line-width": 1.5, "line-dasharray": [3, 2] }} filter={["==", ["geometry-type"], "LineString"]} />
              </Source>
              <Source id="confirmed-shapes" type="geojson" data={(confirmedShapesGeoJson ?? { type: "FeatureCollection", features: [] }) as any}>
                <Layer id="confirmed-fill" type="fill" paint={{ "fill-color": "#3b82f6", "fill-opacity": 0.15 }} filter={["==", ["geometry-type"], "Polygon"]} />
                <Layer id="confirmed-outline" type="line" paint={{ "line-color": "#3b82f6", "line-width": 2 }} filter={["==", ["geometry-type"], "Polygon"]} />
                <Layer id="confirmed-line" type="line" paint={{ "line-color": "#3b82f6", "line-width": 2.5 }} filter={["==", ["geometry-type"], "LineString"]} />
              </Source>
              <Source id="preview-shape" type="geojson" data={(previewGeoJson ?? linePreviewGeoJson ?? { type: "FeatureCollection", features: [] }) as any}>
                <Layer id="preview-fill" type="fill" paint={{ "fill-color": "#a60739", "fill-opacity": 0.2 }} filter={["==", ["geometry-type"], "Polygon"]} />
                <Layer id="preview-outline" type="line" paint={{ "line-color": "#a60739", "line-width": 2, "line-dasharray": (previewGeoJson || linePreviewGeoJson?.geometry?.type === "Polygon") ? [1, 0] : [4, 3] }} filter={["==", ["geometry-type"], "Polygon"]} />
                <Layer id="preview-line" type="line" paint={{ "line-color": "#a60739", "line-width": 2.5, "line-dasharray": linePreviewGeoJson && !previewGeoJson ? [4, 3] : [1, 0] }} filter={["==", ["geometry-type"], "LineString"]} />
              </Source>
              {clickPts.map(([lat, lon], i) => (
                <Marker key={`cp-${i}`} latitude={lat} longitude={lon}>
                  <div className={i === 0 && clickPts.length >= 3 ? "h-3.5 w-3.5 rounded-full border-2 border-[#a60739] bg-[#a60739]/30 ring-2 ring-[#a60739]/20" : "h-2.5 w-2.5 rounded-full border-2 border-[#a60739] bg-white"} />
                </Marker>
              ))}
              {hoveredShapeCentroid && clickPts.length === 0 && (
                <Marker latitude={hoveredShapeCentroid[0]} longitude={hoveredShapeCentroid[1]} anchor="center">
                  <button onClick={(e) => {
                    e.stopPropagation();
                    if (hoveredShapeIdx === -1) setForm((f) => ({ ...f, geometry_type: "polygon" as GeometryType, geometry_json: null }));
                    else if (hoveredShapeIdx !== null && hoveredShapeIdx >= 0) setConfirmedShapes((prev) => prev.filter((_, j) => j !== hoveredShapeIdx));
                    setHoveredShapeIdx(null);
                  }} className="flex items-center justify-center rounded-full bg-white/90 p-1.5 shadow-lg border border-red-300 hover:bg-red-50 transition-colors" title="도형 삭제">
                    <Trash2 size={14} className="text-red-500" />
                  </button>
                </Marker>
              )}
              {addressMarker && (
                <AddressMarker marker={addressMarker} onClose={() => setAddressMarker(null)} />
              )}
            </MapGL>
            <AddressSearch onSelect={handleAddressSelect} />
          </div>
        </div>
      </div>
    </Modal>
  );
}
