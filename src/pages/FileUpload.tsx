import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import {
  Trash2,
  Loader2,
  Plus,
  Pencil,
  Building2,
  ChevronRight,
  ChevronDown,
  Folder,
  Minus,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import MapGL, { Marker, Source, Layer, type MapRef } from "react-map-gl/maplibre";
import Modal from "../components/common/Modal";
import { SrtmDownloadSection, FacBuildingDataSection, MeasuredBuildingDataSection, Vworld3dBuildingSection, LandUseDataSection, PeakDataSection } from "./Settings";
import type { BuildingGroup, ManualBuilding } from "../types";
import { MAP_STYLE_URL } from "../utils/radarConstants";
import { ensureLanduseProtocol } from "../utils/landuseProtocol";
import BuildingModal, { shapeTypeLabel, makeInitialDraft, type BuildingFormData } from "../components/BuildingModal";
import { useAppStore } from "../store";

// ─── 건물 목록 패널 ──────────────────────────────────────────────

/** 수동 건물·그룹 변경을 다른 창(지도)에 알림 (fire-and-forget).
 *  지도 창 store 의 manualBuildings/buildingGroups 는 LoS 도구를 켤 때만 재조회하므로
 *  도구가 열려 있는 동안의 편집은 이 신호가 없으면 stale 로 남는다.
 *  payload 없이 "변경됨"만 알리고 수신 창이 DB 재조회 — 목록 형상 중복 정의 회피.
 *  (loadData 는 마운트 시에도 도는 공통 재조회라 발신 지점으로 부적합 — mutation 성공 지점에만 둔다) */
const emitManualBuildingsChanged = () => {
  emit("manual-buildings-changed", {}).catch(() => {});
};

function ManualBuildingPanel() {
  const [buildings, setBuildings] = useState<ManualBuilding[]>([]);
  const [groups, setGroups] = useState<BuildingGroup[]>([]);
  const [loading, setLoading] = useState(true);
  // 건물 모달 상태는 전역 스토어 — 페이지 이동 후 복귀해도 열림/작성 내용 유지
  const modalOpen = useAppStore((s) => s.buildingModalOpen);
  const editTarget = useAppStore((s) => s.buildingModalEditTarget);
  const addGroupId = useAppStore((s) => s.buildingModalAddGroupId);
  const openBuildingModal = useAppStore((s) => s.openBuildingModal);
  const closeBuildingModal = useAppStore((s) => s.closeBuildingModal);
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

  // 수동 건물 변경 이벤트 수신 → 목록 재조회.
  //   실측 3D 임포트/삭제는 자동(SRTM) 모드 행의 지반고를 융합 세대에 맞춰 재동기화하고
  //   이 이벤트를 발신한다(Rust). 수신측은 DB 재조회만 한다 — 재영속 금지(발신측이 이미 영속).
  useEffect(() => {
    const un = listen("manual-buildings-changed", () => { loadData(); });
    return () => { un.then((fn) => fn()); };
  }, [loadData]);

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
          elevMode: data.elev_mode || "manual", // 추론 전 '' → 'manual'(화면 표시와 일치)
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
          elevMode: data.elev_mode || "manual", // 추론 전 '' → 'manual'(화면 표시와 일치)
          memo: data.memo,
          geometryType: data.geometry_type || "polygon",
          geometryJson: data.geometry_json || null,
          groupId: data.group_id,
        });
      }
      closeBuildingModal();
      loadData();
      emitManualBuildingsChanged();
    } catch (e) {
      console.error("건물 저장 실패:", e);
    }
  };

  const handleDelete = async (b: ManualBuilding) => {
    try {
      await invoke("delete_manual_building", { id: b.id });
      loadData();
      emitManualBuildingsChanged();
    } catch (e) {
      console.error("건물 삭제 실패:", e);
    }
  };

  const openAdd = () => {
    openBuildingModal(null, null, makeInitialDraft(null, null));
  };

  const openAddInGroup = (groupId: number) => {
    openBuildingModal(null, groupId, makeInitialDraft(null, groupId));
  };

  const openEdit = (b: ManualBuilding) => {
    openBuildingModal(b, null, makeInitialDraft(b, null));
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
      emitManualBuildingsChanged();
    } catch (e) { console.error("그룹 저장 실패:", e); }
  };
  const handleGroupDelete = async (g: BuildingGroup) => {
    try {
      await invoke("delete_building_group", { id: g.id });
      loadData();
      emitManualBuildingsChanged();
    } catch (e) { console.error("그룹 삭제 실패:", e); }
  };
  const toggleGroupEnabled = async (g: BuildingGroup) => {
    const next = !g.enabled;
    setGroups((prev) => prev.map((x) => (x.id === g.id ? { ...x, enabled: next } : x)));
    try {
      await invoke("set_building_group_enabled", { id: g.id, enabled: next });
      emitManualBuildingsChanged();
    } catch (e) {
      console.error("그룹 활성화 변경 실패:", e);
      setGroups((prev) => prev.map((x) => (x.id === g.id ? { ...x, enabled: g.enabled } : x)));
    }
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
                    <span className={`text-sm font-medium ${group && !group.enabled ? "text-gray-400 line-through" : "text-gray-700"}`}>{getGroupName(gId)}</span>
                    <span className="text-[10px] text-gray-400">({items.length})</span>
                    {group && (
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleGroupEnabled(group); }}
                        className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${group.enabled ? "bg-[#a60739]" : "bg-gray-300"}`}
                        role="switch"
                        aria-checked={group.enabled}
                        title={group.enabled ? "그룹 비활성화 (LoS/커버리지/3D에서 제외)" : "그룹 활성화"}
                      >
                        <span className={`inline-block h-3 w-3 rounded-full bg-white shadow transition-transform ${group.enabled ? "translate-x-3.5" : "translate-x-0.5"}`} />
                      </button>
                    )}
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
        onClose={closeBuildingModal}
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
  // 자료관리는 건물/참조 데이터만 관리. ASS 업로드는 ACAS·지도·2D 항적현시에서 수행.
  return (
    <div className="space-y-4">
      {/* ── 수동 등록 건물 ── */}
      <ManualBuildingPanel />

      {/* ── 참조 데이터 (건물 + 산 이름 + SRTM 지형) ── */}
      <div className="rounded-xl border border-gray-200 bg-gray-50 overflow-hidden">
        <FacBuildingDataSection />
      </div>
      <div className="rounded-xl border border-gray-200 bg-gray-50 overflow-hidden">
        <MeasuredBuildingDataSection />
      </div>
      <div className="rounded-xl border border-gray-200 bg-gray-50 overflow-hidden">
        <Vworld3dBuildingSection />
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
  );
}
