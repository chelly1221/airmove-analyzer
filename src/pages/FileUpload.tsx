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
import { SrtmDownloadSection, FacBuildingDataSection, LandUseDataSection, PeakDataSection } from "./Settings";
import type { AnalysisResult, BuildingGroup, Flight, ManualBuilding, UploadedFile } from "../types";
import { MAP_STYLE_URL } from "../utils/radarConstants";
import BuildingModal, { shapeTypeLabel, type BuildingFormData } from "../components/BuildingModal";

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
    // 모든 그룹을 빈 배열로 먼저 등록 (건물이 없는 그룹도 표시)
    for (const g of groups) map.set(g.id, []);
    for (const b of buildings) {
      const key = b.group_id;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(b);
    }
    return map;
  }, [buildings, groups]);

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
                mapStyle={MAP_STYLE_URL}
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
