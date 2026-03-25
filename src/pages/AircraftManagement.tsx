import { useState } from "react";
import { Plus, Pencil, Trash2, Plane } from "lucide-react";
import Modal from "../components/common/Modal";
import DataTable from "../components/common/DataTable";
import { useAppStore } from "../store";
import type { Aircraft } from "../types";

function generateId(): string {
  return crypto.randomUUID();
}

const emptyForm: Omit<Aircraft, "id"> = {
  name: "",
  registration: "",
  model: "",
  mode_s_code: "",
  organization: "",
  memo: "",
  active: true,
};

export default function AircraftManagement() {
  const aircraft = useAppStore((s) => s.aircraft);
  const addAircraft = useAppStore((s) => s.addAircraft);
  const updateAircraft = useAppStore((s) => s.updateAircraft);
  const removeAircraft = useAppStore((s) => s.removeAircraft);

  const [modalOpen, setModalOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const openAdd = () => {
    setEditId(null);
    setForm(emptyForm);
    setErrors({});
    setModalOpen(true);
  };

  const openEdit = (a: Aircraft) => {
    setEditId(a.id);
    setForm({
      name: a.name,
      registration: a.registration ?? "",
      model: a.model,
      mode_s_code: a.mode_s_code,
      organization: a.organization,
      memo: a.memo,
      active: a.active,
    });
    setErrors({});
    setModalOpen(true);
  };

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = "기체 이름을 입력하세요";
    if (!form.mode_s_code.trim()) {
      errs.mode_s_code = "Mode-S 코드를 입력하세요";
    } else if (!/^[0-9a-fA-F]{6}$/.test(form.mode_s_code.trim())) {
      errs.mode_s_code = "Mode-S 코드는 6자리 HEX 값이어야 합니다";
    }
    if (!form.organization.trim())
      errs.organization = "운용 기관을 입력하세요";

    // 중복 Mode-S 체크 (편집 시 자기 자신 제외)
    const duplicate = aircraft.find(
      (a) =>
        a.mode_s_code.toLowerCase() === form.mode_s_code.trim().toLowerCase() &&
        a.id !== editId
    );
    if (duplicate) {
      errs.mode_s_code = "이미 등록된 Mode-S 코드입니다";
    }

    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSave = () => {
    if (!validate()) return;

    if (editId) {
      updateAircraft(editId, {
        name: form.name.trim(),
        registration: form.registration.trim(),
        model: form.model.trim(),
        mode_s_code: form.mode_s_code.trim().toUpperCase(),
        organization: form.organization.trim(),
        memo: form.memo.trim(),
        active: form.active,
      });
    } else {
      addAircraft({
        id: generateId(),
        name: form.name.trim(),
        registration: form.registration.trim(),
        model: form.model.trim(),
        mode_s_code: form.mode_s_code.trim().toUpperCase(),
        organization: form.organization.trim(),
        memo: form.memo.trim(),
        active: form.active,
      });
    }
    setModalOpen(false);
  };

  const handleDelete = (id: string) => {
    removeAircraft(id);
    setDeleteConfirm(null);
  };

  const columns = [
    {
      key: "active",
      header: "활성",
      width: "60px",
      render: (a: Aircraft) => (
        <div className="flex justify-center">
          <div
            className={`h-2.5 w-2.5 rounded-full ${a.active ? "bg-green-500" : "bg-gray-400"}`}
            title={a.active ? "활성" : "비활성"}
          />
        </div>
      ),
      align: "center" as const,
    },
    { key: "name", header: "기체 이름" },
    {
      key: "registration",
      header: "등록번호",
      render: (a: Aircraft) => (
        <span className="font-mono text-xs">{a.registration || "-"}</span>
      ),
    },
    {
      key: "model",
      header: "기체 모델",
      render: (a: Aircraft) => (
        <span className="text-gray-500">{a.model || "-"}</span>
      ),
    },
    {
      key: "mode_s_code",
      header: "Mode-S",
      render: (a: Aircraft) => (
        <span className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs">
          {a.mode_s_code}
        </span>
      ),
    },
    { key: "organization", header: "운용 기관" },
    {
      key: "actions",
      header: "관리",
      width: "100px",
      render: (a: Aircraft) => (
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              openEdit(a);
            }}
            className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900 transition-colors"
            title="수정"
            aria-label="수정"
          >
            <Pencil size={14} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setDeleteConfirm(a.id);
            }}
            className="rounded p-1.5 text-gray-500 hover:bg-red-500/20 hover:text-red-600 transition-colors"
            title="삭제"
            aria-label="삭제"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">비행검사기 관리</h1>
          <p className="mt-1 text-sm text-gray-500">
            최대 10대의 비행검사기를 등록/관리합니다 ({aircraft.length}/10)
          </p>
        </div>
        <button
          onClick={openAdd}
          disabled={aircraft.length >= 10}
          className="flex items-center gap-2 rounded-lg bg-[#a60739] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#85062e] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plus size={16} />
          <span>비행검사기 추가</span>
        </button>
      </div>

      {/* Table */}
      {aircraft.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 bg-gray-50 py-20">
          <Plane size={48} className="mb-4 text-gray-400" />
          <p className="text-lg font-medium text-gray-500">
            등록된 비행검사기가 없습니다
          </p>
          <p className="mt-1 text-sm text-gray-500">
            위의 &quot;비행검사기 추가&quot; 버튼을 눌러 등록하세요
          </p>
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={aircraft}
          rowKey={(a) => a.id}
          emptyMessage="등록된 비행검사기가 없습니다"
        />
      )}

      {/* Add/Edit Modal */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editId ? "비행검사기 수정" : "비행검사기 추가"}
      >
        <div className="space-y-4">
          {/* Name */}
          <div>
            <label className="mb-1 block text-sm text-gray-600">
              기체 이름 <span className="text-[#a60739]">*</span>
            </label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 outline-none focus:border-[#a60739]/50 transition-colors"
              placeholder="예: King Air 350"
            />
            {errors.name && (
              <p className="mt-1 text-xs text-[#a60739]">{errors.name}</p>
            )}
          </div>

          {/* Model */}
          <div>
            <label className="mb-1 block text-sm text-gray-600">
              기체 모델
            </label>
            <input
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 outline-none focus:border-[#a60739]/50 transition-colors"
              placeholder="예: King Air 350"
            />
          </div>

          {/* Registration */}
          <div>
            <label className="mb-1 block text-sm text-gray-600">
              등록번호
            </label>
            <input
              value={form.registration}
              onChange={(e) => setForm({ ...form, registration: e.target.value })}
              className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-sm text-gray-800 placeholder-gray-400 outline-none focus:border-[#a60739]/50 transition-colors"
              placeholder="예: FL7779"
            />
          </div>

          {/* Mode-S */}
          <div>
            <label className="mb-1 block text-sm text-gray-600">
              Mode-S 코드 <span className="text-[#a60739]">*</span>
            </label>
            <input
              value={form.mode_s_code}
              onChange={(e) =>
                setForm({ ...form, mode_s_code: e.target.value })
              }
              className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-sm text-gray-800 placeholder-gray-400 outline-none focus:border-[#a60739]/50 transition-colors"
              placeholder="예: A1B2C3"
              maxLength={6}
            />
            {errors.mode_s_code && (
              <p className="mt-1 text-xs text-[#a60739]">
                {errors.mode_s_code}
              </p>
            )}
          </div>

          {/* Organization */}
          <div>
            <label className="mb-1 block text-sm text-gray-600">
              운용 기관 <span className="text-[#a60739]">*</span>
            </label>
            <input
              value={form.organization}
              onChange={(e) =>
                setForm({ ...form, organization: e.target.value })
              }
              className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 outline-none focus:border-[#a60739]/50 transition-colors"
              placeholder="예: 항공우주연구원"
            />
            {errors.organization && (
              <p className="mt-1 text-xs text-[#a60739]">
                {errors.organization}
              </p>
            )}
          </div>

          {/* Active */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setForm({ ...form, active: !form.active })}
              className={`relative h-6 w-11 rounded-full transition-colors ${form.active ? "bg-[#a60739]" : "bg-gray-300"}`}
            >
              <div
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${form.active ? "left-[22px]" : "left-0.5"}`}
              />
            </button>
            <span className="text-sm text-gray-600">
              {form.active ? "활성" : "비활성"}
            </span>
          </div>

          {/* Buttons */}
          <div className="flex items-center justify-between pt-2">
            {editId ? (
              <button
                onClick={() => { setModalOpen(false); setDeleteConfirm(editId); }}
                className="rounded-lg px-3 py-2 text-sm text-red-500 hover:bg-red-50 transition-colors"
              >
                삭제
              </button>
            ) : <div />}
            <div className="flex gap-3">
              <button
                onClick={() => setModalOpen(false)}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 transition-colors"
              >
                취소
              </button>
              <button
                onClick={handleSave}
                className="rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white hover:bg-[#85062e] transition-colors"
              >
                {editId ? "수정" : "추가"}
              </button>
            </div>
          </div>
        </div>
      </Modal>

      {/* Delete Confirmation */}
      <Modal
        open={deleteConfirm !== null}
        onClose={() => setDeleteConfirm(null)}
        title="비행검사기 삭제"
        width="max-w-sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            이 비행검사기를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.
          </p>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setDeleteConfirm(null)}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 transition-colors"
            >
              취소
            </button>
            <button
              onClick={() => deleteConfirm && handleDelete(deleteConfirm)}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors"
            >
              삭제
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
