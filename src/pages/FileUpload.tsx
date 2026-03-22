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
  MapPin,
  Square,
  Circle,
  Minus,
  ChevronRight,
  RotateCw,
  FolderPlus,
  Image as ImageIcon,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import MapGL, { Marker, Source, Layer, type MapRef } from "react-map-gl/maplibre";
import { useAppStore } from "../store";
import { consolidateFlights } from "../utils/flightConsolidation";
import Modal from "../components/common/Modal";
import ImagePositioner from "../components/Map/ImagePositioner";
import { addPlanOverlay, removePlanOverlay } from "../utils/planOverlay";
import type { AnalysisResult, BuildingGroup, FlightRecord, GeometryType, ManualBuilding, PlanImageBounds, UploadedFile } from "../types";

// ─── 건물 입력 모달 ──────────────────────────────────────────────

const MAP_STYLE = "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json";

type DrawTool = "point" | "rectangle" | "circle" | "line";

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
  geometry_type: "point",
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

/** 두 좌표 간 방위각 (degrees, 북=0 시계방향) */
function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const la1 = (lat1 * Math.PI) / 180;
  const la2 = (lat2 * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** 점에서 직선(p1→p2)까지 수직 거리 (m) */
function perpDistM(pt: [number, number], p1: [number, number], p2: [number, number]): number {
  // p1→pt 벡터를 p1→p2 방향에 사영한 후 수직 성분 계산
  const d1x = (pt[1] - p1[1]) * Math.cos((p1[0] * Math.PI) / 180) * 111320;
  const d1y = (pt[0] - p1[0]) * 111320;
  const d2x = (p2[1] - p1[1]) * Math.cos((p1[0] * Math.PI) / 180) * 111320;
  const d2y = (p2[0] - p1[0]) * 111320;
  const len = Math.sqrt(d2x * d2x + d2y * d2y);
  if (len < 1) return Math.sqrt(d1x * d1x + d1y * d1y);
  const cross = Math.abs(d1x * d2y - d1y * d2x);
  return cross / len;
}

/** 두 점(한 변) + 마우스 위치에서 사각형 4꼭짓점 계산 (수직 오프셋) */
function rectCornersFromEdge(
  p1: [number, number], p2: [number, number], mouse: [number, number],
): [[number, number], [number, number], [number, number], [number, number]] {
  const cosLat = Math.cos((p1[0] * Math.PI) / 180);
  // 변 방향 벡터 (미터 단위)
  const edgeX = (p2[1] - p1[1]) * 111320 * cosLat;
  const edgeY = (p2[0] - p1[0]) * 111320;
  const edgeLen = Math.sqrt(edgeX * edgeX + edgeY * edgeY);
  if (edgeLen < 0.01) return [p1, p2, p2, p1];
  // 수직 단위 벡터 (좌측)
  const nx = -edgeY / edgeLen;
  const ny = edgeX / edgeLen;
  // 마우스→p1 벡터
  const mx = (mouse[1] - p1[1]) * 111320 * cosLat;
  const my = (mouse[0] - p1[0]) * 111320;
  // 수직 성분 (부호 유지)
  const proj = mx * nx + my * ny;
  // 오프셋을 위경도로 변환
  const dLon = (proj * nx) / (111320 * cosLat);
  const dLat = (proj * ny) / 111320;
  return [
    p1,
    p2,
    [p2[0] + dLat, p2[1] + dLon],
    [p1[0] + dLat, p1[1] + dLon],
  ];
}

/** 4꼭짓점을 GeoJSON polygon 좌표로 변환 */
function cornersToPolygonCoords(
  corners: [[number, number], [number, number], [number, number], [number, number]],
): [number, number][] {
  return [
    [corners[0][1], corners[0][0]],
    [corners[1][1], corners[1][0]],
    [corners[2][1], corners[2][0]],
    [corners[3][1], corners[3][0]],
    [corners[0][1], corners[0][0]], // close ring
  ];
}

/** 타원을 GeoJSON polygon 좌표로 변환 */
function ellipseToPolygon(
  center: [number, number],
  semiMajorM: number,
  semiMinorM: number,
  rotationDeg: number,
  segments = 64,
): [number, number][] {
  const [lat, lon] = center;
  const rotRad = (rotationDeg * Math.PI) / 180;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const coords: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * 2 * Math.PI;
    // 타원 로컬 좌표 (미터)
    const lx = semiMajorM * Math.cos(t);
    const ly = semiMinorM * Math.sin(t);
    // 회전 적용 (rotationDeg는 북(위도+) 기준 시계방향)
    const rx = lx * Math.sin(rotRad) + ly * Math.cos(rotRad);  // east
    const ry = lx * Math.cos(rotRad) - ly * Math.sin(rotRad);  // north
    const dLon = rx / (111320 * cosLat);
    const dLat = ry / 111320;
    coords.push([lon + dLon, lat + dLat]);
  }
  return coords;
}

/** 도형의 중심점 계산 */
function shapeCentroid(shape: { type: GeometryType; json: string | null }): [number, number] | null {
  if (!shape.json) return null;
  try {
    const val = JSON.parse(shape.json);
    if (shape.type === "rectangle" && Array.isArray(val)) {
      if (val.length === 4)
        return [
          val.reduce((s: number, c: number[]) => s + c[0], 0) / 4,
          val.reduce((s: number, c: number[]) => s + c[1], 0) / 4,
        ];
      if (val.length === 2) return [(val[0][0] + val[1][0]) / 2, (val[0][1] + val[1][1]) / 2];
    }
    if (shape.type === "circle" && val.center) return val.center;
    if (shape.type === "line" && Array.isArray(val) && val.length > 0) {
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
    case "rectangle": return "사각형";
    case "circle": return "원/타원";
    case "line": return "선";
    case "point": return "포인트";
    case "multi": return "복합";
    default: return type;
  }
}

/** 단일 도형을 GeoJSON Feature로 변환 */
function shapeToGeoJsonFeature(shape: { type: GeometryType; json: string | null }): GeoJSON.Feature | null {
  if (!shape.json) return null;
  try {
    if (shape.type === "rectangle") {
      const parsed = JSON.parse(shape.json);
      if (Array.isArray(parsed) && parsed.length === 4) {
        return {
          type: "Feature",
          geometry: {
            type: "Polygon",
            coordinates: [cornersToPolygonCoords(parsed as [[number, number], [number, number], [number, number], [number, number]])],
          },
          properties: {},
        };
      }
    }
    if (shape.type === "circle") {
      const gj = JSON.parse(shape.json);
      const semiMajor: number = gj.semi_major_m ?? gj.radius_m ?? 100;
      const semiMinor: number = gj.semi_minor_m ?? semiMajor;
      return {
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [ellipseToPolygon(gj.center, semiMajor, semiMinor, gj.rotation_deg ?? 0)],
        },
        properties: {},
      };
    }
    if (shape.type === "line") {
      const pts: [number, number][] = JSON.parse(shape.json);
      if (pts.length >= 2) {
        return {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: pts.map(([lat, lon]) => [lon, lat]),
          },
          properties: {},
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
}: {
  open: boolean;
  onClose: () => void;
  onSave: (data: BuildingFormData) => void;
  initial?: ManualBuilding | null;
  groups: BuildingGroup[];
}) {
  const [form, setForm] = useState<BuildingFormData>(emptyForm);
  const [drawTool, setDrawTool] = useState<DrawTool>("point");
  const miniMapRef = useRef<MapRef>(null);
  const [miniMapReady, setMiniMapReady] = useState(false);

  // 선택 그룹의 plan overlay를 미니맵에 표시 (DB에서 직접 로드)
  useEffect(() => {
    const map = miniMapRef.current?.getMap();
    if (!map || !miniMapReady) return;
    // 이전 plan overlay 제거
    for (const layer of map.getStyle().layers) {
      if (layer.id.startsWith("plan-raster-")) {
        const gid = Number(layer.id.replace("plan-raster-", ""));
        removePlanOverlay(map, gid);
      }
    }
    const gid = form.group_id;
    if (gid == null) return;
    const group = groups.find((g) => g.id === gid);
    if (!group?.has_plan_image || !group.plan_bounds_json) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await invoke<{ image_base64: string; bounds_json: string; opacity: number } | null>(
          "load_group_plan_image", { groupId: gid },
        );
        if (cancelled || !result?.bounds_json) return;
        const bounds: PlanImageBounds = JSON.parse(result.bounds_json);
        const m = miniMapRef.current?.getMap();
        if (m) addPlanOverlay(m, gid, `data:image/jpeg;base64,${result.image_base64}`, bounds, result.opacity);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [form.group_id, groups, miniMapReady]);

  // 그리기 임시 상태: 클릭 포인트 축적 + 마우스 현재 위치
  const [clickPts, setClickPts] = useState<[number, number][]>([]); // [lat, lon][]
  const [mousePt, setMousePt] = useState<[number, number] | null>(null);
  // 타원 회전 모드
  const [rotatingEllipse, setRotatingEllipse] = useState(false);
  // 확정된 도형 목록 (멀티 도형 건물용)
  const [confirmedShapes, setConfirmedShapes] = useState<{ type: GeometryType; json: string }[]>([]);

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
        geometry_type: isMulti ? "point" : (initial.geometry_type || "point"),
        geometry_json: isMulti ? null : (initial.geometry_json || null),
        group_id: initial.group_id ?? null,
      });
      setDrawTool(isMulti ? "point" : (initial.geometry_type as DrawTool || "point"));
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
      setForm(emptyForm);
      setDrawTool("point");
      setConfirmedShapes([]);
    }
    setClickPts([]);
    setMousePt(null);
    setRotatingEllipse(false);
    setMiniMapReady(false);
  }, [initial, isOpen]);

  const handleSubmit = () => {
    if (!form.name.trim() || !form.latitude || !form.longitude || !form.height) return;

    // 모든 도형 수집 (확정 목록 + 현재 도형)
    const allShapes = [...confirmedShapes];
    if (form.geometry_json && form.geometry_type !== "point" && form.geometry_type !== "multi") {
      allShapes.push({ type: form.geometry_type, json: form.geometry_json });
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

  // 도구 변경 시 임시 상태 초기화
  useEffect(() => {
    setClickPts([]);
    setMousePt(null);
    setRotatingEllipse(false);
  }, [drawTool]);

  // Ctrl+Z 실행취소
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!((e.ctrlKey || e.metaKey) && e.key === "z")) return;
      e.preventDefault();

      // 1) 그리기 중: 마지막 클릭 취소
      if (clickPts.length > 0) {
        const next = clickPts.slice(0, -1);
        setClickPts(next);

        if (drawTool === "line") {
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
        }

        // 원/타원: step3→step2 (장축만 남기고 원 확정 해제)
        if (drawTool === "circle" && clickPts.length === 2) {
          setForm((f) => ({ ...f, geometry_type: "circle" as GeometryType, geometry_json: null }));
        }
        return;
      }

      // 2) 확정된 현재 도형 취소
      if (form.geometry_json && form.geometry_type !== "point") {
        setForm((f) => ({ ...f, geometry_type: drawTool as GeometryType, geometry_json: null }));
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
  }, [isOpen, clickPts, drawTool, form.geometry_json, form.geometry_type, confirmedShapes.length]);

  // 현재 도형을 확정 목록에 추가
  const addShapeToList = useCallback(() => {
    if (!form.geometry_json || form.geometry_type === "point") return;
    setConfirmedShapes((prev) => [...prev, { type: form.geometry_type, json: form.geometry_json! }]);
    setForm((f) => ({ ...f, geometry_type: drawTool as GeometryType, geometry_json: null }));
    setClickPts([]);
    setRotatingEllipse(false);
  }, [form.geometry_json, form.geometry_type, drawTool]);

  // 도형 확정 후 맵 자동 fit bounds (사각형/원/타원/선)
  useEffect(() => {
    if (!miniMapRef.current || !form.geometry_json || clickPts.length > 0) return;
    try {
      if (form.geometry_type === "rectangle") {
        const parsed = JSON.parse(form.geometry_json);
        let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
        const pts: [number, number][] = parsed.length === 2
          ? [parsed[0], parsed[1]] // legacy [[minLat,minLon],[maxLat,maxLon]]
          : parsed; // 4-corner
        for (const [lat, lon] of pts) {
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
        }
        miniMapRef.current.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 50, maxZoom: 18, duration: 500 });
      } else if (form.geometry_type === "circle") {
        const gj = JSON.parse(form.geometry_json);
        const [clat, clon] = gj.center;
        const rDeg = (gj.semi_major_m ?? gj.radius_m ?? 100) / 111320;
        const cosLat = Math.cos((clat * Math.PI) / 180);
        miniMapRef.current.fitBounds(
          [[clon - rDeg / cosLat, clat - rDeg], [clon + rDeg / cosLat, clat + rDeg]],
          { padding: 50, maxZoom: 18, duration: 500 },
        );
      } else if (form.geometry_type === "line") {
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
      }
    } catch { /* ignore parse errors */ }
  }, [form.geometry_json, form.geometry_type, clickPts.length]);

  /** form에 사각형 반영 — 4꼭짓점 저장 */
  const applyRect4 = useCallback((corners: [[number, number], [number, number], [number, number], [number, number]]) => {
    const cLat = corners.reduce((s, c) => s + c[0], 0) / 4;
    const cLon = corners.reduce((s, c) => s + c[1], 0) / 4;
    setForm((f) => ({
      ...f,
      latitude: cLat.toFixed(6),
      longitude: cLon.toFixed(6),
      geometry_type: "rectangle" as GeometryType,
      geometry_json: JSON.stringify(corners),
    }));
  }, []);

  /** form에 타원 반영 (clickPts는 건드리지 않음) */
  const applyEllipse = useCallback((center: [number, number], semiMajorM: number, semiMinorM: number, rotDeg: number) => {
    setForm((f) => ({
      ...f,
      latitude: center[0].toFixed(6),
      longitude: center[1].toFixed(6),
      geometry_type: "circle" as GeometryType,
      geometry_json: JSON.stringify({
        center,
        semi_major_m: Math.round(semiMajorM),
        semi_minor_m: Math.round(semiMinorM),
        rotation_deg: Math.round(rotDeg * 10) / 10,
      }),
    }));
  }, []);

  // 미니맵 클릭
  const handleMapClick = useCallback((evt: any) => {
    const { lngLat } = evt;
    const lat: number = lngLat.lat;
    const lon: number = lngLat.lng;
    const pt: [number, number] = [lat, lon];

    // 타원 회전 모드: 클릭으로 회전 확정
    if (rotatingEllipse && form.geometry_type === "circle" && form.geometry_json) {
      try {
        const gj = JSON.parse(form.geometry_json);
        const center: [number, number] = gj.center;
        const newRot = bearing(center[0], center[1], lat, lon);
        applyEllipse(center, gj.semi_major_m ?? gj.radius_m, gj.semi_minor_m ?? gj.semi_major_m ?? gj.radius_m, newRot);
      } catch { /* ignore */ }
      setRotatingEllipse(false);
      return;
    }

    if (drawTool === "point") {
      setForm((f) => ({
        ...f,
        latitude: lat.toFixed(6),
        longitude: lon.toFixed(6),
        geometry_type: "point",
        geometry_json: null,
      }));
      return;
    }

    if (drawTool === "rectangle") {
      setClickPts((prev) => {
        if (prev.length === 0) return [pt]; // 1클릭: 첫 번째 꼭짓점
        if (prev.length === 1) return [prev[0], pt]; // 2클릭: 한 변 확정
        // 3클릭: 수직으로 당겨서 사각형 확정
        const corners = rectCornersFromEdge(prev[0], prev[1], pt);
        applyRect4(corners);
        return [];
      });
      return;
    }

    if (drawTool === "circle") {
      setClickPts((prev) => {
        if (prev.length === 0) {
          // 1단계: 중심
          return [pt];
        }
        if (prev.length === 1) {
          // 2단계: 장축 끝점 → 원으로 우선 확정, 3단계 진행 대기
          const center = prev[0];
          const semiMajor = haversineM(center[0], center[1], lat, lon);
          const rot = bearing(center[0], center[1], lat, lon);
          applyEllipse(center, semiMajor, semiMajor, rot);
          return [center, pt];
        }
        if (prev.length === 2) {
          // 3단계: 단축 조절 → 타원 확정
          const center = prev[0];
          const majorEnd = prev[1];
          const semiMajor = haversineM(center[0], center[1], majorEnd[0], majorEnd[1]);
          const rot = bearing(center[0], center[1], majorEnd[0], majorEnd[1]);
          const semiMinor = Math.max(1, perpDistM(pt, center, majorEnd));
          applyEllipse(center, semiMajor, semiMinor, rot);
          return [];
        }
        return [];
      });
      return;
    }

    if (drawTool === "line") {
      setClickPts((prev) => {
        const updated = [...prev, pt];
        const center = updated.reduce(
          (acc, p) => [acc[0] + p[0] / updated.length, acc[1] + p[1] / updated.length],
          [0, 0],
        );
        setForm((f) => ({
          ...f,
          latitude: center[0].toFixed(6),
          longitude: center[1].toFixed(6),
          geometry_type: "line",
          geometry_json: JSON.stringify(updated),
        }));
        return updated;
      });
    }
  }, [drawTool, applyRect4, applyEllipse, rotatingEllipse, form.geometry_type, form.geometry_json]);

  // 라인 더블클릭으로 완료
  const handleMapDblClick = useCallback((evt: any) => {
    if (drawTool === "line") {
      evt.preventDefault();
    }
  }, [drawTool]);

  // 마우스 추적 (실시간 미리보기용)
  const handleMapMouseMove = useCallback((evt: any) => {
    const { lngLat } = evt;
    setMousePt([lngLat.lat, lngLat.lng]);
  }, []);

  // ── GeoJSON 미리보기 생성 ──

  const previewGeoJson = useMemo(() => {
    // 사각형 미리보기: 1포인트 → 선 미리보기, 2포인트 → 사각형 미리보기
    if (drawTool === "rectangle" && clickPts.length === 1 && mousePt) {
      // 한 변 미리보기 (선)
      return {
        type: "Feature" as const,
        geometry: {
          type: "LineString" as const,
          coordinates: [[clickPts[0][1], clickPts[0][0]], [mousePt[1], mousePt[0]]],
        },
        properties: {},
      };
    }
    if (drawTool === "rectangle" && clickPts.length === 2 && mousePt) {
      // 수직으로 당기는 사각형 미리보기
      const corners = rectCornersFromEdge(clickPts[0], clickPts[1], mousePt);
      return {
        type: "Feature" as const,
        geometry: {
          type: "Polygon" as const,
          coordinates: [cornersToPolygonCoords(corners)],
        },
        properties: {},
      };
    }

    // 타원 미리보기
    if (drawTool === "circle" && clickPts.length >= 1 && mousePt) {
      const center = clickPts[0];
      if (clickPts.length === 1) {
        // 2단계 미리보기: 중심→마우스 = 원(장축=단축)
        const r = haversineM(center[0], center[1], mousePt[0], mousePt[1]);
        if (r < 1) return null;
        const rot = bearing(center[0], center[1], mousePt[0], mousePt[1]);
        return {
          type: "Feature" as const,
          geometry: { type: "Polygon" as const, coordinates: [ellipseToPolygon(center, r, r, rot)] },
          properties: {},
        };
      }
      if (clickPts.length === 2) {
        // 3단계 미리보기: 장축 확정, 마우스로 단축 조절
        const majorEnd = clickPts[1];
        const semiMajor = haversineM(center[0], center[1], majorEnd[0], majorEnd[1]);
        const rot = bearing(center[0], center[1], majorEnd[0], majorEnd[1]);
        const semiMinor = Math.max(1, perpDistM(mousePt, center, majorEnd));
        return {
          type: "Feature" as const,
          geometry: { type: "Polygon" as const, coordinates: [ellipseToPolygon(center, semiMajor, semiMinor, rot)] },
          properties: {},
        };
      }
    }

    // 타원 회전 모드 미리보기
    if (rotatingEllipse && drawTool === "circle" && form.geometry_type === "circle" && form.geometry_json && mousePt) {
      try {
        const gj = JSON.parse(form.geometry_json);
        const center: [number, number] = gj.center;
        const semiMajor: number = gj.semi_major_m ?? gj.radius_m ?? 100;
        const semiMinor: number = gj.semi_minor_m ?? semiMajor;
        const newRot = bearing(center[0], center[1], mousePt[0], mousePt[1]);
        return {
          type: "Feature" as const,
          geometry: { type: "Polygon" as const, coordinates: [ellipseToPolygon(center, semiMajor, semiMinor, newRot)] },
          properties: {},
        };
      } catch { /* ignore */ }
    }

    // 확정된 도형 표시
    if (form.geometry_type === "rectangle" && form.geometry_json) {
      try {
        const parsed = JSON.parse(form.geometry_json);
        if (Array.isArray(parsed) && parsed.length === 4) {
          // 4꼭짓점 형식
          const coords = cornersToPolygonCoords(parsed as [[number, number], [number, number], [number, number], [number, number]]);
          return {
            type: "Feature" as const,
            geometry: { type: "Polygon" as const, coordinates: [coords] },
            properties: {},
          };
        }
        if (Array.isArray(parsed) && parsed.length === 2) {
          // 레거시 축 정렬 형식
          const [[minLat, minLon], [maxLat, maxLon]] = parsed;
          return {
            type: "Feature" as const,
            geometry: {
              type: "Polygon" as const,
              coordinates: [[[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]]],
            },
            properties: {},
          };
        }
      } catch { /* ignore */ }
    }
    if (form.geometry_type === "circle" && form.geometry_json) {
      try {
        const gj = JSON.parse(form.geometry_json);
        const center: [number, number] = gj.center;
        const semiMajor: number = gj.semi_major_m ?? gj.radius_m ?? 100;
        const semiMinor: number = gj.semi_minor_m ?? semiMajor;
        const rot: number = gj.rotation_deg ?? 0;
        return {
          type: "Feature" as const,
          geometry: { type: "Polygon" as const, coordinates: [ellipseToPolygon(center, semiMajor, semiMinor, rot)] },
          properties: {},
        };
      } catch { /* ignore */ }
    }
    if (form.geometry_type === "line" && form.geometry_json) {
      try {
        const pts: [number, number][] = JSON.parse(form.geometry_json);
        if (pts.length >= 2) {
          return {
            type: "Feature" as const,
            geometry: { type: "LineString" as const, coordinates: pts.map(([lat, lon]) => [lon, lat]) },
            properties: {},
          };
        }
      } catch { /* ignore */ }
    }
    return null;
  }, [drawTool, clickPts, mousePt, form.geometry_type, form.geometry_json, rotatingEllipse]);

  // 라인 그리기 중 진행 미리보기 (확정 전 점선)
  const linePreviewGeoJson = useMemo(() => {
    if (drawTool !== "line" || clickPts.length === 0) return null;
    const pts = mousePt ? [...clickPts, mousePt] : clickPts;
    if (pts.length < 2) return null;
    return {
      type: "Feature" as const,
      geometry: { type: "LineString" as const, coordinates: pts.map(([lat, lon]) => [lon, lat]) },
      properties: {},
    };
  }, [drawTool, clickPts, mousePt]);

  // 확정된 멀티 도형 GeoJSON
  const confirmedShapesGeoJson = useMemo(() => {
    if (confirmedShapes.length === 0) return null;
    const features: GeoJSON.Feature[] = [];
    for (const shape of confirmedShapes) {
      const feat = shapeToGeoJsonFeature(shape);
      if (feat) features.push(feat);
    }
    if (features.length === 0) return null;
    return { type: "FeatureCollection" as const, features };
  }, [confirmedShapes]);

  // "도형 추가" 가능 여부
  const canAddShape =
    (form.geometry_type !== "point" && form.geometry_json && clickPts.length === 0) ||
    (drawTool === "line" && clickPts.length >= 2 && form.geometry_json);

  // 타원 장축선 미리보기 (3단계 시) + 회전 모드 가이드선
  const majorAxisGeoJson = useMemo(() => {
    // 회전 모드: 중심→마우스 가이드선
    if (rotatingEllipse && form.geometry_type === "circle" && form.geometry_json && mousePt) {
      try {
        const gj = JSON.parse(form.geometry_json);
        const center: [number, number] = gj.center;
        return {
          type: "Feature" as const,
          geometry: {
            type: "LineString" as const,
            coordinates: [[center[1], center[0]], [mousePt[1], mousePt[0]]],
          },
          properties: {},
        };
      } catch { /* ignore */ }
    }
    if (drawTool !== "circle" || clickPts.length !== 2) return null;
    const [center, majorEnd] = clickPts;
    return {
      type: "Feature" as const,
      geometry: {
        type: "LineString" as const,
        coordinates: [[center[1], center[0]], [majorEnd[1], majorEnd[0]]],
      },
      properties: {},
    };
  }, [drawTool, clickPts, rotatingEllipse, form.geometry_type, form.geometry_json, mousePt]);

  // 사각형 한 변 미리보기 (2클릭 후 edge 표시)
  const rectEdgeGeoJson = useMemo(() => {
    if (drawTool !== "rectangle" || clickPts.length !== 2) return null;
    return {
      type: "Feature" as const,
      geometry: {
        type: "LineString" as const,
        coordinates: [[clickPts[0][1], clickPts[0][0]], [clickPts[1][1], clickPts[1][0]]],
      },
      properties: {},
    };
  }, [drawTool, clickPts]);

  // 힌트 텍스트
  const hintText = useMemo(() => {
    const undoSuffix = clickPts.length > 0 || (form.geometry_json && form.geometry_type !== "point") ? " · Ctrl+Z" : "";
    if (rotatingEllipse) return "클릭하여 회전 확정" + undoSuffix;
    if (drawTool === "point") return "클릭하여 위치 지정";
    if (drawTool === "rectangle") {
      if (clickPts.length === 0) return "첫 번째 꼭짓점 클릭" + undoSuffix;
      if (clickPts.length === 1) return "두 번째 꼭짓점 클릭 (한 변) · Ctrl+Z";
      return "당겨서 사각형 확정 · Ctrl+Z";
    }
    if (drawTool === "circle") {
      if (clickPts.length === 0) return "중심점 클릭" + undoSuffix;
      if (clickPts.length === 1) return "장축 끝점 클릭 · Ctrl+Z";
      return "단축 길이 클릭 (타원) 또는 '원으로 확정' · Ctrl+Z";
    }
    if (drawTool === "line") return clickPts.length === 0 ? "첫 번째 꼭짓점 클릭" + undoSuffix : "다음 꼭짓점 클릭 · Ctrl+Z";
    return "";
  }, [drawTool, clickPts.length, rotatingEllipse, form.geometry_json, form.geometry_type]);

  const markerLat = parseFloat(form.latitude);
  const markerLon = parseFloat(form.longitude);
  const hasMarker = !isNaN(markerLat) && !isNaN(markerLon);

  const mapCenter = hasMarker
    ? { latitude: markerLat, longitude: markerLon }
    : { latitude: 37.55, longitude: 126.99 };

  const drawTools: { tool: DrawTool; icon: typeof MapPin; label: string }[] = [
    { tool: "point", icon: MapPin, label: "포인트" },
    { tool: "rectangle", icon: Square, label: "사각형" },
    { tool: "circle", icon: Circle, label: "원/타원" },
    { tool: "line", icon: Minus, label: "선" },
  ];

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
    { key: "memo", label: "메모", placeholder: "비고 사항" },
  ];

  return (
    <Modal open={isOpen} onClose={onClose} title={initial ? "건물 정보 수정" : "건물 수동 등록"} width="max-w-3xl">
      <div className="flex gap-4">
        {/* 왼쪽: 입력 폼 */}
        <div className="w-64 shrink-0 space-y-2.5">
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
          {(form.geometry_type !== "point" || confirmedShapes.length > 0) && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs text-gray-500">
              {confirmedShapes.length > 0
                ? `복합 도형 (${confirmedShapes.length + (form.geometry_json && form.geometry_type !== "point" ? 1 : 0)}개)`
                : <>
                    도형: {form.geometry_type === "rectangle" ? "사각형" : form.geometry_type === "circle" ? "원/타원" : "선"}
                    {form.geometry_type === "circle" && form.geometry_json && (() => {
                      try {
                        const g = JSON.parse(form.geometry_json);
                        const ma = g.semi_major_m ?? g.radius_m;
                        const mi = g.semi_minor_m ?? ma;
                        const rot = g.rotation_deg ?? 0;
                        if (ma === mi) return ` (반경 ${ma}m)`;
                        return ` (${ma}×${mi}m, ${rot}°)`;
                      } catch { return ""; }
                    })()}
                  </>
              }
            </div>
          )}

          {/* 그룹 선택 */}
          {groups.length > 0 && (
            <div>
              <label className="mb-0.5 block text-xs font-medium text-gray-600">그룹</label>
              <select
                value={form.group_id ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, group_id: e.target.value ? Number(e.target.value) : null }))}
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm text-gray-800 focus:border-[#a60739] focus:outline-none focus:ring-1 focus:ring-[#a60739]/30"
              >
                <option value="">미분류</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 transition-colors"
            >
              취소
            </button>
            <button
              onClick={handleSubmit}
              disabled={!form.name.trim() || !form.latitude || !form.longitude || !form.height}
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
            {drawTools.map(({ tool, icon: Icon, label }) => (
              <button
                key={tool}
                onClick={() => setDrawTool(tool)}
                className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all ${
                  drawTool === tool
                    ? "bg-[#a60739] text-white"
                    : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                }`}
                title={label}
              >
                <Icon size={13} />
                {label}
              </button>
            ))}
            {drawTool === "circle" && clickPts.length === 2 && (
              <button
                onClick={() => setClickPts([])}
                className="ml-1 rounded-lg bg-[#a60739] px-2.5 py-1.5 text-xs font-medium text-white hover:bg-[#85062e] transition-colors"
              >
                원으로 확정
              </button>
            )}
            {/* 타원 회전 버튼: 확정된 타원이 있고 그리기 중이 아닐 때 */}
            {drawTool === "circle" && clickPts.length === 0 && form.geometry_type === "circle" && form.geometry_json && !rotatingEllipse && (
              <button
                onClick={() => setRotatingEllipse(true)}
                className="ml-1 flex items-center gap-1 rounded-lg bg-gray-100 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-200 transition-colors"
              >
                <RotateCw size={12} />
                회전
              </button>
            )}
            {rotatingEllipse && (
              <button
                onClick={() => setRotatingEllipse(false)}
                className="ml-1 rounded-lg bg-[#a60739] px-2.5 py-1.5 text-xs font-medium text-white hover:bg-[#85062e] transition-colors"
              >
                회전 취소
              </button>
            )}
            {clickPts.length > 0 && (
              <button
                onClick={() => {
                  setClickPts([]);
                  // 도형도 함께 초기화
                  setForm((f) => ({ ...f, geometry_type: drawTool as GeometryType, geometry_json: null }));
                }}
                className="ml-1 rounded-lg bg-gray-100 px-2 py-1.5 text-xs text-gray-500 hover:bg-gray-200 transition-colors"
              >
                초기화
              </button>
            )}
            {/* 도형 추가 (멀티 도형) */}
            {canAddShape && (
              <button
                onClick={addShapeToList}
                className="ml-1 flex items-center gap-0.5 rounded-lg bg-blue-500 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-blue-600 transition-colors"
              >
                <Plus size={12} />
                도형 추가
              </button>
            )}
            <span className="ml-auto text-[10px] text-gray-400">
              {hintText}
            </span>
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
              doubleClickZoom={drawTool !== "line"}
              onLoad={() => setMiniMapReady(true)}
            >
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

              {/* 확정된 포인트 마커 */}
              {hasMarker && form.geometry_type === "point" && (
                <Marker latitude={markerLat} longitude={markerLon} anchor="bottom">
                  <div className="flex flex-col items-center">
                    <div className="rounded-full bg-[#a60739] p-1 shadow-lg">
                      <MapPin size={16} className="text-white" />
                    </div>
                  </div>
                </Marker>
              )}

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
                    "line-dasharray": previewGeoJson ? [1, 0] : [4, 3],
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

              {/* 타원 장축선 (3단계 / 회전 모드) */}
              <Source
                id="major-axis"
                type="geojson"
                data={(majorAxisGeoJson ?? { type: "FeatureCollection", features: [] }) as any}
              >
                <Layer
                  id="major-axis-line"
                  type="line"
                  paint={{ "line-color": "#a60739", "line-width": 1.5, "line-dasharray": [6, 4] }}
                />
              </Source>

              {/* 사각형 한 변 확정선 */}
              <Source
                id="rect-edge"
                type="geojson"
                data={(rectEdgeGeoJson ?? { type: "FeatureCollection", features: [] }) as any}
              >
                <Layer
                  id="rect-edge-line"
                  type="line"
                  paint={{ "line-color": "#a60739", "line-width": 2, "line-dasharray": [6, 4] }}
                />
              </Source>

              {/* 클릭 포인트 마커 (사각형 꼭짓점, 타원 중심/장축끝, 라인 꼭짓점) */}
              {clickPts.map(([lat, lon], i) => (
                <Marker key={`cp-${i}`} latitude={lat} longitude={lon}>
                  <div className="h-2.5 w-2.5 rounded-full border-2 border-[#a60739] bg-white" />
                </Marker>
              ))}

              {/* 확정된 도형 중심점 마커 */}
              {hasMarker && (form.geometry_type === "rectangle" || form.geometry_type === "circle") && clickPts.length === 0 && (
                <Marker latitude={markerLat} longitude={markerLon}>
                  <div className="h-2 w-2 rounded-full bg-[#a60739] ring-2 ring-white" />
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
  // 그룹 관리
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [editGroup, setEditGroup] = useState<BuildingGroup | null>(null);
  const [groupForm, setGroupForm] = useState({ name: "", color: "#6b7280", memo: "" });
  // 토지이용계획도
  const [planImagePreview, setPlanImagePreview] = useState<string | null>(null);
  const [planImageBase64, setPlanImageBase64] = useState<string | null>(null);
  const [planOpacity, setPlanOpacity] = useState(0.5);
  // 오버레이 토글
  const activePlanOverlays = useAppStore((s) => s.activePlanOverlays);
  const setActivePlanOverlay = useAppStore((s) => s.setActivePlanOverlay);
  const updatePlanOverlayProps = useAppStore((s) => s.updatePlanOverlayProps);
  // 위치 조정 맵 모달
  const [positioningModal, setPositioningModal] = useState<{ groupId: number; imageDataUrl: string; initialBounds: PlanImageBounds | null; opacity?: number } | null>(null);
  // 그룹 필터 (null=전체, 0=미분류, 양수=그룹ID)
  const [filterGroupId, setFilterGroupId] = useState<number | null>(null);
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
          geometryType: data.geometry_type || "point",
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
          geometryType: data.geometry_type || "point",
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
    setModalOpen(true);
  };

  const openEdit = (b: ManualBuilding) => {
    setEditTarget(b);
    setModalOpen(true);
  };

  // 그룹 CRUD
  const openGroupAdd = () => {
    setEditGroup(null);
    setGroupForm({ name: "", color: "#6b7280", memo: "" });
    setPlanImagePreview(null);
    setPlanImageBase64(null);
    setPlanOpacity(0.5);
    setGroupModalOpen(true);
  };
  const openGroupEdit = async (g: BuildingGroup) => {
    setEditGroup(g);
    setGroupForm({ name: g.name, color: g.color, memo: g.memo });
    setPlanOpacity(g.plan_opacity);
    setPlanImagePreview(null);
    setPlanImageBase64(null);
    if (g.has_plan_image) {
      try {
        const result = await invoke<{ image_base64: string; bounds_json: string; opacity: number } | null>(
          "load_group_plan_image", { groupId: g.id },
        );
        if (result) {
          setPlanImagePreview(`data:image/jpeg;base64,${result.image_base64}`);
          setPlanImageBase64(result.image_base64);
          setPlanOpacity(result.opacity);
        }
      } catch { /* ignore */ }
    }
    setGroupModalOpen(true);
  };
  /** 이미지 선택 + Canvas 압축 */
  const handlePickPlanImage = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "이미지", extensions: ["png", "jpg", "jpeg", "bmp", "webp"] }],
      });
      if (!selected) return;
      const filePath = typeof selected === "string" ? selected : String(selected);
      const raw = await invoke<string>("read_file_base64", { path: filePath });
      // Canvas 압축 (4096px, JPEG Q80)
      const ext = filePath.split(".").pop()?.toLowerCase() ?? "jpeg";
      const mime = ext === "png" ? "image/png" : "image/jpeg";
      const img = new Image();
      img.onload = () => {
        const MAX = 4096;
        let w = img.width, h = img.height;
        if (w > MAX || h > MAX) { const s = MAX / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        c.getContext("2d")!.drawImage(img, 0, 0, w, h);
        const dataUrl = c.toDataURL("image/jpeg", 0.8);
        setPlanImageBase64(dataUrl.split(",")[1]);
        setPlanImagePreview(dataUrl);
      };
      img.src = `data:${mime};base64,${raw}`;
    } catch (e) { console.warn("[PlanImage] 선택 실패:", e); }
  };
  /** 이미지 삭제 */
  const handleDeletePlanImage = async () => {
    if (editGroup) {
      try { await invoke("delete_group_plan_image", { groupId: editGroup.id }); } catch { /* ignore */ }
      setActivePlanOverlay(editGroup.id, null);
    }
    setPlanImagePreview(null);
    setPlanImageBase64(null);
  };
  const handleGroupSave = async () => {
    if (!groupForm.name.trim()) return;
    try {
      if (editGroup) {
        await invoke("update_building_group", { id: editGroup.id, name: groupForm.name.trim(), color: groupForm.color, memo: groupForm.memo, planOpacity: planOpacity });
        if (planImageBase64) {
          await invoke("save_group_plan_image", {
            groupId: editGroup.id, imageBase64: planImageBase64,
            boundsJson: editGroup.plan_bounds_json || "", opacity: planOpacity,
          });
        }
      } else {
        const newId = await invoke<number>("add_building_group", { name: groupForm.name.trim(), color: groupForm.color, memo: groupForm.memo });
        if (planImageBase64) {
          await invoke("save_group_plan_image", {
            groupId: newId, imageBase64: planImageBase64, boundsJson: "", opacity: planOpacity,
          });
        }
      }
      setGroupModalOpen(false);
      loadData();
    } catch (e) { console.error("그룹 저장 실패:", e); }
  };
  const handleGroupDelete = async (g: BuildingGroup) => {
    try {
      setActivePlanOverlay(g.id, null);
      await invoke("delete_building_group", { id: g.id });
      if (filterGroupId === g.id) setFilterGroupId(null);
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
    const filtered = filterGroupId === null
      ? buildings
      : filterGroupId === 0
        ? buildings.filter((b) => !b.group_id)
        : buildings.filter((b) => b.group_id === filterGroupId);

    const map = new Map<number | null, ManualBuilding[]>();
    for (const b of filtered) {
      const key = b.group_id;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(b);
    }
    return map;
  }, [buildings, filterGroupId]);

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

  const GROUP_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899", "#6b7280", "#14b8a6"];

  const renderBuildingRow = (b: ManualBuilding) => (
    <div key={b.id} className="flex items-center gap-3 px-3 py-2 hover:bg-gray-100 transition-colors group">
      {b.geometry_type === "multi" ? <Plus size={14} className="shrink-0 text-blue-400" />
        : b.geometry_type === "rectangle" ? <Square size={14} className="shrink-0 text-gray-400" />
        : b.geometry_type === "circle" ? <Circle size={14} className="shrink-0 text-gray-400" />
        : b.geometry_type === "line" ? <Minus size={14} className="shrink-0 text-gray-400" />
        : <Building2 size={14} className="shrink-0 text-gray-400" />}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-gray-800 truncate">{b.name}</span>
          <span className="text-[10px] text-gray-400">{b.height}m</span>
          {b.geometry_type && b.geometry_type !== "point" && (
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
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-800">수동 등록 건물</h1>
            <p className="mt-1 text-sm text-gray-500">
              LOS 분석에 사용할 건물을 수동 등록합니다
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={openGroupAdd}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-600 transition-colors hover:bg-gray-100"
            >
              <FolderPlus size={14} />
              그룹
            </button>
            <button
              onClick={openAdd}
              className="flex items-center gap-2 rounded-lg bg-[#a60739] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#85062e]"
            >
              <Plus size={16} />
              건물 추가
            </button>
          </div>
        </div>

        {/* 그룹 필터 탭 */}
        {groups.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => setFilterGroupId(null)}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                filterGroupId === null ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"
              }`}
            >
              전체 ({buildings.length})
            </button>
            {groups.map((g) => {
              const cnt = buildings.filter((b) => b.group_id === g.id).length;
              return (
                <button
                  key={g.id}
                  onClick={() => setFilterGroupId(filterGroupId === g.id ? null : g.id)}
                  className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                    filterGroupId === g.id ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                  }`}
                >
                  <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: g.color }} />
                  {g.name} ({cnt})
                </button>
              );
            })}
            {(() => {
              const ungrouped = buildings.filter((b) => !b.group_id).length;
              return ungrouped > 0 ? (
                <button
                  onClick={() => setFilterGroupId(filterGroupId === 0 ? null : 0)}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                    filterGroupId === 0 ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                  }`}
                >
                  미분류 ({ungrouped})
                </button>
              ) : null;
            })()}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12 text-gray-400">
            <Loader2 size={20} className="animate-spin" />
          </div>
        ) : buildings.length === 0 ? (
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
          <div className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-gray-50">
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
                <div key={gId ?? "ungrouped"} className="overflow-hidden rounded-xl border border-gray-200 bg-gray-50">
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
                    {group?.has_plan_image && (
                      <ImageIcon size={11} className="shrink-0 text-gray-300" />
                    )}
                    {group && (
                      <div className="ml-auto flex items-center gap-1 opacity-0 group-hover/hdr:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
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

      <BuildingModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditTarget(null); }}
        onSave={handleSave}
        initial={editTarget}
        groups={groups}
      />

      {/* 그룹 관리 모달 */}
      <Modal open={groupModalOpen} onClose={() => setGroupModalOpen(false)} title={editGroup ? "그룹 수정" : "그룹 추가"} width="max-w-sm">
        <div className="space-y-3">
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
            <div className="flex items-center gap-2">
              {GROUP_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setGroupForm((f) => ({ ...f, color: c }))}
                  className={`h-6 w-6 rounded-full transition-all ${groupForm.color === c ? "ring-2 ring-offset-1 ring-gray-800 scale-110" : "hover:scale-110"}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
          <div>
            <label className="mb-0.5 block text-xs font-medium text-gray-600">메모</label>
            <input
              type="text"
              value={groupForm.memo}
              onChange={(e) => setGroupForm((f) => ({ ...f, memo: e.target.value }))}
              placeholder="비고"
              className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-[#a60739] focus:outline-none focus:ring-1 focus:ring-[#a60739]/30"
            />
          </div>
          {/* 토지이용계획도 */}
          <div className="border-t pt-3">
            <label className="mb-1.5 block text-xs font-medium text-gray-600">토지이용계획도</label>
            {planImagePreview ? (
              <div className="space-y-2">
                <div className="relative rounded-lg border border-gray-200 overflow-hidden">
                  <img src={planImagePreview} alt="계획도" className="w-full max-h-28 object-contain bg-gray-50" />
                  <button
                    onClick={handleDeletePlanImage}
                    className="absolute top-1 right-1 rounded-full bg-white/80 p-0.5 hover:bg-white"
                  >
                    <X size={14} className="text-gray-500" />
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-gray-500 w-12">투명도</span>
                  <input type="range" min={0.1} max={1} step={0.05} value={planOpacity}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setPlanOpacity(v);
                      if (editGroup && activePlanOverlays.has(editGroup.id)) {
                        updatePlanOverlayProps(editGroup.id, { opacity: v });
                      }
                    }}
                    className="flex-1 accent-[#a60739]" />
                  <span className="text-[10px] text-gray-500 w-7 text-right">{Math.round(planOpacity * 100)}%</span>
                </div>
                {/* 지도에서 위치 조정 — 맵 모달 열기 */}
                {editGroup && (
                  <button
                    onClick={async () => {
                      // 이미지가 있으면 먼저 저장
                      if (planImageBase64) {
                        await invoke("save_group_plan_image", {
                          groupId: editGroup.id, imageBase64: planImageBase64,
                          boundsJson: editGroup.plan_bounds_json || "", opacity: planOpacity,
                        });
                        await loadData();
                      }
                      const bounds = editGroup.plan_bounds_json ? JSON.parse(editGroup.plan_bounds_json) as PlanImageBounds : null;
                      setPositioningModal({
                        groupId: editGroup.id,
                        imageDataUrl: planImagePreview!,
                        initialBounds: bounds,
                        opacity: planOpacity,
                      });
                    }}
                    className="w-full rounded-lg bg-blue-50 px-3 py-1.5 text-xs text-blue-600 hover:bg-blue-100 transition-colors"
                  >
                    <MapPin size={12} className="inline mr-1" />
                    지도에서 위치 조정
                  </button>
                )}
              </div>
            ) : (
              <button
                onClick={handlePickPlanImage}
                className="flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-gray-300 px-3 py-3 text-xs text-gray-400 hover:border-gray-400 hover:text-gray-500 transition-colors"
              >
                <Upload size={14} />
                이미지 업로드
              </button>
            )}
          </div>
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
      </Modal>

      {/* 위치 조정 맵 모달 */}
      {positioningModal && (
        <PositioningMapModal
          groupId={positioningModal.groupId}
          imageDataUrl={positioningModal.imageDataUrl}
          initialBounds={positioningModal.initialBounds}
          opacity={positioningModal.opacity}
          onConfirm={async (bounds) => {
            try {
              const result = await invoke<{ image_base64: string; opacity: number } | null>(
                "load_group_plan_image", { groupId: positioningModal.groupId },
              );
              if (result) {
                await invoke("save_group_plan_image", {
                  groupId: positioningModal.groupId,
                  imageBase64: result.image_base64,
                  boundsJson: JSON.stringify(bounds),
                  opacity: result.opacity,
                });
                setActivePlanOverlay(positioningModal.groupId, {
                  imageDataUrl: positioningModal.imageDataUrl,
                  bounds, opacity: result.opacity,
                });
              }
              loadData();
            } catch (e) { console.warn("[Positioning] 저장 실패:", e); }
            setPositioningModal(null);
          }}
          onCancel={() => setPositioningModal(null)}
        />
      )}
    </>
  );
}

// ─── 위치 조정 맵 모달 ──────────────────────────────────────────

const POS_MAP_STYLE = "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json";

function PositioningMapModal({
  groupId, imageDataUrl, initialBounds, opacity, onConfirm, onCancel,
}: {
  groupId: number;
  imageDataUrl: string;
  initialBounds: PlanImageBounds | null;
  opacity?: number;
  onConfirm: (bounds: PlanImageBounds) => void;
  onCancel: () => void;
}) {
  const mapRef = useRef<MapRef>(null);
  const radarSite = useAppStore((s) => s.radarSite);
  const [mapReady, setMapReady] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="relative w-[90vw] h-[80vh] max-w-5xl rounded-xl border border-gray-200 bg-white shadow-2xl overflow-hidden flex flex-col">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-800">토지이용계획도 위치 조정</h2>
          <button onClick={onCancel} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 relative">
          <MapGL
            ref={mapRef}
            initialViewState={{ latitude: radarSite.latitude, longitude: radarSite.longitude, zoom: 12 }}
            mapStyle={POS_MAP_STYLE}
            style={{ width: "100%", height: "100%" }}
            attributionControl={false}
            onLoad={() => setMapReady(true)}
          >
            {mapReady && mapRef.current?.getMap() && (
              <ImagePositioner
                map={mapRef.current.getMap()!}
                groupId={groupId}
                imageDataUrl={imageDataUrl}
                initialBounds={initialBounds}
                opacity={opacity}
                onConfirm={onConfirm}
                onCancel={onCancel}
              />
            )}
          </MapGL>
        </div>
      </div>
    </div>
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
  const appendRawTrackPoints = useAppStore((s) => s.appendRawTrackPoints);
  const addParseStats = useAppStore((s) => s.addParseStats);
  const rawTrackPoints = useAppStore((s) => s.rawTrackPoints);
  const setFlights = useAppStore((s) => s.setFlights);
  const aircraft = useAppStore((s) => s.aircraft);
  const radarSite = useAppStore((s) => s.radarSite);
  const setRadarSite = useAppStore((s) => s.setRadarSite);
  const customRadarSites = useAppStore((s) => s.customRadarSites);
  const flightHistory = useAppStore((s) => s.flightHistory);
  const setFlightHistory = useAppStore((s) => s.setFlightHistory);
  const [errorLog, setErrorLog] = useState<string[]>([]);
  // 파싱 모드: "aircraft" = 등록 비행검사기만, "all" = 전체 데이터
  const [parseMode, setParseMode] = useState<"aircraft" | "all">("aircraft");

  // 레이더 선택 모달 상태
  const [showRadarModal, setShowRadarModal] = useState(false);
  const [radarModalAction, setRadarModalAction] = useState<"single" | "all">("all");
  const [modalSelectedSite, setModalSelectedSite] = useState(radarSite);
  const pendingParseFileRef = useRef<UploadedFile | null>(null);

  // 모달에 표시할 전체 레이더 사이트 목록
  const allRadarSites = customRadarSites;

  // 등록 항공기별 비행 시간 범위 (단일 패스 O(n))
  const registeredTrackRanges = useMemo(() => {
    const activeMap = new Map<string, string>();
    for (const a of aircraft) {
      if (!a.active || !a.mode_s_code) continue;
      activeMap.set(a.mode_s_code.toUpperCase(), a.name);
    }
    const ranges = new Map<string, { name: string; minTs: number; maxTs: number; points: number }>();
    if (activeMap.size === 0) return ranges;
    for (const p of rawTrackPoints) {
      const ms = p.mode_s.toUpperCase();
      const name = activeMap.get(ms);
      if (name === undefined) continue;
      const prev = ranges.get(ms);
      if (!prev) {
        ranges.set(ms, { name, minTs: p.timestamp, maxTs: p.timestamp, points: 1 });
      } else {
        if (p.timestamp < prev.minTs) prev.minTs = p.timestamp;
        if (p.timestamp > prev.maxTs) prev.maxTs = p.timestamp;
        prev.points++;
      }
    }
    return ranges;
  }, [aircraft, rawTrackPoints]);

  // 비행 통합 실행 (수동 병합 비행 보존, 비동기 — UI 논블로킹)
  const consolidatingRef = useRef(false);
  const runConsolidation = useCallback(async () => {
    if (consolidatingRef.current) return; // 중복 실행 방지
    const state = useAppStore.getState();
    if (state.rawTrackPoints.length === 0) return;
    consolidatingRef.current = true;
    try {
      const consolidated = await consolidateFlights(
        state.rawTrackPoints,
        state.flightHistory,
        state.aircraft,
        state.radarSite,
      );
      // 수동 병합된 비행은 재통합에서 보존 (사용자 의도 유지)
      const manualFlights = useAppStore.getState().flights.filter((f) => f.match_type === "manual");
      if (manualFlights.length > 0) {
        const manualRanges = manualFlights.map((mf) => ({
          mode_s: mf.mode_s.toUpperCase(),
          start: mf.start_time,
          end: mf.end_time,
        }));
        const filtered = consolidated.filter((cf) => {
          const ms = cf.mode_s.toUpperCase();
          return !manualRanges.some((mr) =>
            mr.mode_s === ms && cf.start_time >= mr.start - 300 && cf.end_time <= mr.end + 300
          );
        });
        setFlights([...filtered, ...manualFlights].sort((a, b) => a.start_time - b.start_time));
      } else {
        setFlights(consolidated);
      }
    } finally {
      consolidatingRef.current = false;
    }
  }, [setFlights]);

  // flightHistory가 변경되면 재통합 (DB 캐시 로드 또는 API 동기화 결과 반영)
  useEffect(() => {
    if (rawTrackPoints.length > 0) {
      runConsolidation();
    }
  }, [flightHistory]); // eslint-disable-line react-hooks/exhaustive-deps

  // rawTrackPoints 변경 시 DB에서 기존 데이터 자동 로드 + 비행 통합
  useEffect(() => {
    if (registeredTrackRanges.size === 0) {
      // 등록 항공기 없어도 rawTrackPoints가 있으면 통합 실행
      if (rawTrackPoints.length > 0) runConsolidation();
      return;
    }
    const icao24List = [...registeredTrackRanges.keys()];
    const ranges = [...registeredTrackRanges.values()];
    let start = Infinity, end = -Infinity;
    for (const r of ranges) { if (r.minTs < start) start = r.minTs; if (r.maxTs > end) end = r.maxTs; }
    // 운항이력 — DB에서 로드 후 setFlightHistory → flightHistory useEffect가 재통합 트리거
    invoke<FlightRecord[]>("load_flight_history", {
      icao24_list: icao24List, start, end,
    }).then((records) => {
      if (records.length > 0) {
        setFlightHistory(records);
      } else {
        // DB에 운항이력 없어도 통합 실행 (gap 분리로라도)
        runConsolidation();
      }
    }).catch(() => {
      // DB 로드 실패 시에도 통합 실행
      runConsolidation();
    });
  }, [registeredTrackRanges]); // eslint-disable-line react-hooks/exhaustive-deps

  // DB에서 rawTrackPoints 재로드 후 비행 재통합
  const reloadAndReconsolidate = useCallback(async () => {
    try {
      const data = await invoke<any>("load_saved_data");
      if (data?.track_points?.length > 0) {
        useAppStore.setState({ rawTrackPoints: data.track_points });
      } else {
        useAppStore.setState({ rawTrackPoints: [], flights: [] });
      }
    } catch {
      useAppStore.setState({ rawTrackPoints: [], flights: [] });
    }
    // 약간의 딜레이 후 재통합 (state 반영 대기)
    setTimeout(() => runConsolidation(), 50);
  }, [runConsolidation]);

  // 개별 파일 삭제
  const handleDeleteFile = useCallback(async (filePath: string) => {
    removeUploadedFile(filePath);
    await reloadAndReconsolidate();
  }, [removeUploadedFile, reloadAndReconsolidate]);

  // 레이더별 그룹 삭제
  const handleDeleteGroup = useCallback(async (groupFiles: UploadedFile[]) => {
    const paths = groupFiles.map((f) => f.path);
    removeUploadedFiles(paths);
    await reloadAndReconsolidate();
  }, [removeUploadedFiles, reloadAndReconsolidate]);

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
        modeSFilter,
      });

      // 원시 포인트에 radar_name 태깅 후 축적
      const radarName = useAppStore.getState().radarSite.name;
      for (const p of result.file_info.track_points) {
        p.radar_name = radarName;
      }
      appendRawTrackPoints(result.file_info.track_points);

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
    <div className="grid grid-cols-2 gap-6">
      {/* ── 왼쪽 열: 자료 업로드 ── */}
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-800">자료 업로드</h1>
            <p className="mt-1 text-sm text-gray-500">
              NEC ASS 파일을 업로드하여 파싱합니다
            </p>
          </div>
          <button
            onClick={handleFilePick}
            className="flex items-center gap-2 rounded-lg bg-[#a60739] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#85062e]"
          >
            <Upload size={16} />
            파일 선택
          </button>
        </div>

        {/* File List — 레이더별 그룹 */}
        {uploadedFiles.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-800">
                업로드 파일 ({uploadedFiles.length}개)
              </h2>
              <div className="flex items-center gap-2">
                {pendingCount > 0 && (
                  <button
                    onClick={requestParseAll}
                    disabled={parsingCount > 0}
                    className="flex items-center gap-2 rounded-lg bg-[#a60739] px-3 py-2 text-sm font-medium text-white hover:bg-[#85062e] disabled:opacity-50 transition-colors"
                  >
                    <Play size={14} />
                    <span>전체 파싱 ({pendingCount}건)</span>
                  </button>
                )}
                <button
                  onClick={clearUploadedFiles}
                  className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-500 hover:bg-gray-100 transition-colors"
                >
                  <Trash2 size={14} />
                  <span>전체 삭제</span>
                </button>
              </div>
            </div>

            <div className="space-y-2">
              {fileGroups.map(([groupKey, files]) => {
                const isPending = groupKey === "__pending__";
                const groupLabel = isPending ? "대기 중" : groupKey;
                const expanded = expandedGroups.has(groupKey);
                const doneCount = files.filter((f) => f.status === "done").length;
                return (
                  <div key={groupKey} className="overflow-hidden rounded-xl border border-gray-200 bg-gray-50">
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
          </div>
        )}

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

      {/* ── 오른쪽 열: 수동 등록 건물 ── */}
      <div>
        <ManualBuildingPanel />
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
