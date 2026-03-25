import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Plus,
  Pencil,
  Trash2,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Upload,
  X,
  RotateCw,
} from "lucide-react";
import { useAppStore } from "../store";
import type { BuildingGroup, PlanImageBounds } from "../types";
import Modal from "./common/Modal";
import { EmptyState } from "./common/EmptyState";

/** base64 매직 바이트로 이미지 mime 타입 판별 (투명도 유지) */
function detectImageMime(base64: string): string {
  if (base64.startsWith("iVBOR")) return "image/png";
  if (base64.startsWith("UklGR")) return "image/webp";
  return "image/jpeg";
}

/** 기본 색상 팔레트 */
const COLOR_PRESETS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4",
  "#3b82f6", "#8b5cf6", "#ec4899", "#6b7280", "#a60739",
];

interface Props {
  /** 지오레퍼런싱 모드 진입 콜백 */
  onStartPositioning?: (groupId: number, imageDataUrl: string) => void;
  /** 오버레이 활성 시 자동 줌 콜백 */
  onFitBounds?: (bounds: PlanImageBounds) => void;
}

export default function BuildingGroupPanel({ onStartPositioning, onFitBounds }: Props) {
  const buildingGroups = useAppStore((s) => s.buildingGroups);
  const manualBuildings = useAppStore((s) => s.manualBuildings);
  const loadBuildingGroups = useAppStore((s) => s.loadBuildingGroups);
  const loadManualBuildings = useAppStore((s) => s.loadManualBuildings);
  const activePlanOverlays = useAppStore((s) => s.activePlanOverlays);
  const setActivePlanOverlay = useAppStore((s) => s.setActivePlanOverlay);
  const updatePlanOverlayProps = useAppStore((s) => s.updatePlanOverlayProps);

  const [expanded, setExpanded] = useState(false);
  const [editModal, setEditModal] = useState<{ mode: "add" | "edit"; group?: BuildingGroup } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);

  // 모달 폼 상태
  const [formName, setFormName] = useState("");
  const [formColor, setFormColor] = useState("#3b82f6");
  const [formMemo, setFormMemo] = useState("");
  const [formOpacity, setFormOpacity] = useState(0.5);
  const [formRotation, setFormRotation] = useState(0);
  const [planImagePreview, setPlanImagePreview] = useState<string | null>(null);
  const [planImageBase64, setPlanImageBase64] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 초기 로드
  useEffect(() => {
    loadBuildingGroups();
    loadManualBuildings();
  }, []);

  /** 그룹별 건물 수 */
  const countByGroup = (groupId: number) =>
    manualBuildings.filter((b) => b.group_id === groupId).length;

  /** 모달 열기 */
  const openAddModal = () => {
    setFormName("");
    setFormColor("#3b82f6");
    setFormMemo("");
    setFormOpacity(0.5);
    setFormRotation(0);
    setPlanImagePreview(null);
    setPlanImageBase64(null);
    setEditModal({ mode: "add" });
  };

  const openEditModal = async (group: BuildingGroup) => {
    setFormName(group.name);
    setFormColor(group.color);
    setFormMemo(group.memo);
    setFormOpacity(group.plan_opacity);
    setFormRotation(group.plan_rotation);
    setPlanImagePreview(null);
    setPlanImageBase64(null);
    // 기존 이미지 로드
    if (group.has_plan_image) {
      try {
        const result = await invoke<{ image_base64: string; bounds_json: string; opacity: number; rotation: number } | null>(
          "load_group_plan_image",
          { groupId: group.id },
        );
        if (result) {
          setPlanImagePreview(`data:${detectImageMime(result.image_base64)};base64,${result.image_base64}`);
          setPlanImageBase64(result.image_base64);
          setFormOpacity(result.opacity);
          setFormRotation(result.rotation);
        }
      } catch (e) {
        console.warn("[PlanImage] 로드 실패:", e);
      }
    }
    setEditModal({ mode: "edit", group });
  };

  /** 이미지 파일 선택 + 압축 */
  const handlePickImage = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "이미지", extensions: ["png", "jpg", "jpeg", "bmp", "webp"] }],
      });
      if (!selected) return;
      const filePath = typeof selected === "string" ? selected : String(selected);
      // Tauri IPC로 파일 읽기
      const base64Raw = await invoke<string>("read_file_base64", { path: filePath });
      // Canvas 압축 (4096px 제한, JPEG Q80)
      const compressed = await compressImage(base64Raw, filePath);
      setPlanImageBase64(compressed.base64);
      setPlanImagePreview(compressed.dataUrl);
    } catch (e) {
      console.warn("[PlanImage] 파일 선택 실패:", e);
    }
  };

  /** 이미지 압축 (Canvas, PNG/WebP 투명도 유지) */
  const compressImage = (base64: string, path: string): Promise<{ base64: string; dataUrl: string }> => {
    return new Promise((resolve, reject) => {
      const ext = path.split(".").pop()?.toLowerCase() ?? "jpeg";
      const hasAlpha = ext === "png" || ext === "webp";
      const srcMime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      const img = new Image();
      img.onload = () => {
        const MAX = 4096;
        let w = img.width, h = img.height;
        if (w > MAX || h > MAX) {
          const scale = MAX / Math.max(w, h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = hasAlpha ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.8);
        const b64 = dataUrl.split(",")[1];
        resolve({ base64: b64, dataUrl });
      };
      img.onerror = reject;
      img.src = `data:${srcMime};base64,${base64}`;
    });
  };

  /** 저장 */
  const handleSave = async () => {
    setSaving(true);
    try {
      if (editModal?.mode === "add") {
        const id = await invoke<number>("add_building_group", {
          name: formName || "새 그룹",
          color: formColor,
          memo: formMemo,
        });
        // 이미지가 있으면 저장
        if (planImageBase64) {
          await invoke("save_group_plan_image", {
            groupId: id,
            imageBase64: planImageBase64,
            boundsJson: "",
            opacity: formOpacity,
            rotation: formRotation,
          });
        }
      } else if (editModal?.mode === "edit" && editModal.group) {
        await invoke("update_building_group", {
          id: editModal.group.id,
          name: formName || editModal.group.name,
          color: formColor,
          memo: formMemo,
          planOpacity: formOpacity,
          planRotation: formRotation,
          areaBoundsJson: editModal.group.area_bounds_json ?? null,
        });
        // 새 이미지가 있으면 저장
        if (planImageBase64 && planImagePreview?.startsWith("data:")) {
          const existingBounds = editModal.group.plan_bounds_json || "";
          await invoke("save_group_plan_image", {
            groupId: editModal.group.id,
            imageBase64: planImageBase64,
            boundsJson: existingBounds,
            opacity: formOpacity,
            rotation: formRotation,
          });
        }
      }
      await loadBuildingGroups();
      setEditModal(null);
    } catch (e) {
      console.warn("[BuildingGroup] 저장 실패:", e);
    } finally {
      setSaving(false);
    }
  };

  /** 삭제 */
  const handleDelete = async (id: number) => {
    try {
      // 오버레이 제거
      setActivePlanOverlay(id, null);
      await invoke("delete_building_group", { id });
      await loadBuildingGroups();
      await loadManualBuildings();
      setDeleteConfirm(null);
    } catch (e) {
      console.warn("[BuildingGroup] 삭제 실패:", e);
    }
  };

  /** 이미지 삭제 */
  const handleDeleteImage = async () => {
    if (editModal?.mode === "edit" && editModal.group) {
      try {
        await invoke("delete_group_plan_image", { groupId: editModal.group.id });
        setPlanImagePreview(null);
        setPlanImageBase64(null);
        setActivePlanOverlay(editModal.group.id, null);
      } catch (e) {
        console.warn("[PlanImage] 삭제 실패:", e);
      }
    } else {
      setPlanImagePreview(null);
      setPlanImageBase64(null);
    }
  };

  /** 오버레이 토글 */
  const toggleOverlay = async (group: BuildingGroup) => {
    if (activePlanOverlays.has(group.id)) {
      setActivePlanOverlay(group.id, null);
      return;
    }
    if (!group.has_plan_image || !group.plan_bounds_json) return;
    try {
      const result = await invoke<{ image_base64: string; bounds_json: string; opacity: number; rotation: number } | null>(
        "load_group_plan_image",
        { groupId: group.id },
      );
      if (!result || !result.bounds_json) return;
      const bounds: PlanImageBounds = JSON.parse(result.bounds_json);
      setActivePlanOverlay(group.id, {
        imageDataUrl: `data:${detectImageMime(result.image_base64)};base64,${result.image_base64}`,
        bounds,
        opacity: result.opacity,
        rotation: result.rotation,
      });
      onFitBounds?.(bounds);
    } catch (e) {
      console.warn("[PlanOverlay] 토글 실패:", e);
    }
  };

  /** 지오레퍼런싱 모드 진입 */
  const startPositioning = async (group: BuildingGroup) => {
    if (!onStartPositioning) return;
    let imageDataUrl = planImagePreview;
    if (!imageDataUrl && group.has_plan_image) {
      try {
        const result = await invoke<{ image_base64: string } | null>(
          "load_group_plan_image",
          { groupId: group.id },
        );
        if (result) imageDataUrl = `data:${detectImageMime(result.image_base64)};base64,${result.image_base64}`;
      } catch { /* ignore */ }
    }
    if (!imageDataUrl) return;
    onStartPositioning(group.id, imageDataUrl);
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      {/* 헤더 (접기/펼치기) */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
      >
        <span className="flex items-center gap-2">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          건물 그룹 ({buildingGroups.length})
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); openAddModal(); }}
          className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          title="그룹 추가"
          aria-label="그룹 추가"
        >
          <Plus size={14} />
        </button>
      </button>

      {expanded && (
        <div className="border-t border-gray-100 px-2 py-1 space-y-1 max-h-64 overflow-y-auto">
          {buildingGroups.length === 0 ? (
            <EmptyState
              icon={FolderPlus}
              title="등록된 그룹이 없습니다"
              description="그룹을 추가하여 건물을 분류하세요"
              compact
            />
          ) : (
            buildingGroups.map((g) => {
              const overlayData = activePlanOverlays.get(g.id);
              return (
              <div key={g.id}>
                <div
                  className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-gray-50 group"
                >
                  {/* 색상 스와치 */}
                  <span
                    className="h-3 w-3 rounded-sm flex-shrink-0"
                    style={{ backgroundColor: g.color }}
                  />
                  {/* 이름 + 건물 수 */}
                  <span className="flex-1 truncate text-gray-700">
                    {g.name}
                    <span className="ml-1 text-gray-400">({countByGroup(g.id)})</span>
                  </span>
                  {/* 계획도 표시 */}
                  {g.has_plan_image && (
                    <ImageIcon size={12} className="text-gray-300 flex-shrink-0" />
                  )}
                  {/* 액션 버튼들 */}
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    {g.has_plan_image && g.plan_bounds_json && (
                      <button
                        onClick={() => toggleOverlay(g)}
                        className="rounded p-1 hover:bg-gray-200"
                        title={overlayData ? "오버레이 숨기기" : "오버레이 표시"}
                        aria-label={overlayData ? "오버레이 숨기기" : "오버레이 표시"}
                      >
                        {overlayData ? (
                          <Eye size={12} className="text-blue-500" />
                        ) : (
                          <EyeOff size={12} className="text-gray-400" />
                        )}
                      </button>
                    )}
                    <button
                      onClick={() => openEditModal(g)}
                      className="rounded p-1 hover:bg-gray-200"
                      title="수정"
                      aria-label="수정"
                    >
                      <Pencil size={12} className="text-gray-400" />
                    </button>
                    <button
                      onClick={() => setDeleteConfirm(g.id)}
                      className="rounded p-1 hover:bg-gray-200"
                      title="삭제"
                      aria-label="삭제"
                    >
                      <Trash2 size={12} className="text-gray-400" />
                    </button>
                  </div>
                </div>
                {/* 오버레이 활성 시 투명도/회전 인라인 컨트롤 */}
                {overlayData && (
                  <div className="mx-2 mb-1 rounded bg-blue-50/50 px-2 py-1.5 space-y-1">
                    <div className="flex items-center gap-1.5">
                      <Eye size={10} className="text-gray-400 flex-shrink-0" />
                      <input
                        type="range" min={0.05} max={1} step={0.05}
                        value={overlayData.opacity}
                        onChange={(e) => updatePlanOverlayProps(g.id, { opacity: Number(e.target.value) })}
                        className="flex-1 accent-blue-500 h-1"
                      />
                      <span className="text-[10px] text-gray-500 w-7 text-right">{Math.round(overlayData.opacity * 100)}%</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <RotateCw size={10} className="text-gray-400 flex-shrink-0" />
                      <input
                        type="range" min={-180} max={180} step={1}
                        value={overlayData.rotation}
                        onChange={(e) => updatePlanOverlayProps(g.id, { rotation: Number(e.target.value) })}
                        className="flex-1 accent-blue-500 h-1"
                      />
                      <span className="text-[10px] text-gray-500 w-7 text-right">{overlayData.rotation}°</span>
                    </div>
                  </div>
                )}
              </div>
              );
            })
          )}
        </div>
      )}

      {/* 추가/수정 모달 */}
      {editModal && (
        <Modal
          open={true}
          title={editModal.mode === "add" ? "건물 그룹 추가" : "건물 그룹 수정"}
          onClose={() => setEditModal(null)}
        >
          <div className="space-y-4 p-4">
            {/* 이름 */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">이름</label>
              <input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
                placeholder="그룹 이름"
              />
            </div>
            {/* 색상 */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">색상</label>
              <div className="flex flex-wrap gap-1.5">
                {COLOR_PRESETS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setFormColor(c)}
                    className={`h-6 w-6 rounded-md border-2 transition-all ${
                      formColor === c ? "border-gray-800 scale-110" : "border-transparent hover:border-gray-300"
                    }`}
                    style={{ backgroundColor: c }}
                  />
                ))}
                <input
                  type="color"
                  value={formColor}
                  onChange={(e) => setFormColor(e.target.value)}
                  className="h-6 w-6 cursor-pointer rounded border-0 p-0"
                />
              </div>
            </div>
            {/* 메모 */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">메모</label>
              <textarea
                value={formMemo}
                onChange={(e) => setFormMemo(e.target.value)}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none resize-none"
                rows={2}
                placeholder="메모 (선택)"
              />
            </div>
            {/* 토지이용계획도 */}
            <div className="border-t pt-3">
              <label className="block text-xs font-medium text-gray-600 mb-2">토지이용계획도</label>
              {planImagePreview ? (
                <div className="space-y-2">
                  <div className="relative rounded border border-gray-200 overflow-hidden">
                    <img src={planImagePreview} alt="계획도" className="w-full max-h-32 object-contain bg-gray-50" />
                    <button
                      onClick={handleDeleteImage}
                      className="absolute top-1 right-1 rounded-full bg-white/80 p-0.5 hover:bg-white"
                    >
                      <X size={14} className="text-gray-500" />
                    </button>
                  </div>
                  {/* 불투명도 */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 w-14">불투명도</span>
                    <input
                      type="range"
                      min={0.1}
                      max={1}
                      step={0.05}
                      value={formOpacity}
                      onChange={(e) => setFormOpacity(Number(e.target.value))}
                      className="flex-1 accent-[#a60739]"
                    />
                    <span className="text-xs text-gray-500 w-8 text-right">{Math.round(formOpacity * 100)}%</span>
                  </div>
                  {/* 위치 조정 버튼 */}
                  {editModal.mode === "edit" && editModal.group && (
                    <button
                      onClick={() => startPositioning(editModal.group!)}
                      className="w-full rounded bg-blue-50 px-3 py-1.5 text-xs text-blue-600 hover:bg-blue-100"
                    >
                      지도에서 위치 조정
                    </button>
                  )}
                </div>
              ) : (
                <button
                  onClick={handlePickImage}
                  className="flex w-full items-center justify-center gap-2 rounded border-2 border-dashed border-gray-300 px-3 py-4 text-sm text-gray-400 hover:border-gray-400 hover:text-gray-500"
                >
                  <Upload size={16} />
                  이미지 업로드
                </button>
              )}
            </div>
            {/* 저장/취소 */}
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setEditModal(null)}
                className="rounded px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100"
              >
                취소
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="rounded bg-[#a60739] px-4 py-1.5 text-sm text-white hover:bg-[#8a062f] disabled:opacity-50"
              >
                {saving ? "저장 중..." : "저장"}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* 삭제 확인 */}
      {deleteConfirm !== null && (
        <Modal open={true} title="그룹 삭제" onClose={() => setDeleteConfirm(null)}>
          <div className="p-4 space-y-3">
            <p className="text-sm text-gray-600">
              이 그룹을 삭제하시겠습니까? 소속 건물은 미분류로 변경됩니다.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="rounded px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100"
              >
                취소
              </button>
              <button
                onClick={() => handleDelete(deleteConfirm)}
                className="rounded bg-red-500 px-4 py-1.5 text-sm text-white hover:bg-red-600"
              >
                삭제
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
