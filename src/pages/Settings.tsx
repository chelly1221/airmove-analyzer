import { useState, useRef, useEffect } from "react";
import {
  Plus,
  Pencil,
  Plane,
  Radio,
  X,
  MapPin,
  Key,
  Check,
  Eye,
  EyeOff,
} from "lucide-react";
import maplibregl from "maplibre-gl";
import { invoke } from "@tauri-apps/api/core";
import Modal from "../components/common/Modal";
import DataTable from "../components/common/DataTable";
import { useAppStore } from "../store";
import type { Aircraft, RadarSite } from "../types";

/** 기본 레이더 사이트 */
const DEFAULT_RADAR_SITE: RadarSite = {
  name: "김포 #1", latitude: 37.5490, longitude: 126.7937, altitude: 9.11, antenna_height: 19.8, range_nm: 200,
};

// ─── 비행검사기 관리 ───────────────────────────────────────────────────

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

function AircraftSection() {
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
    if (!form.name.trim()) errs.name = "이름을 입력하세요";
    if (!form.mode_s_code.trim()) {
      errs.mode_s_code = "Mode-S 코드를 입력하세요";
    } else if (!/^[0-9a-fA-F]{6}$/.test(form.mode_s_code.trim())) {
      errs.mode_s_code = "Mode-S 코드는 6자리 HEX 값이어야 합니다";
    }
    if (!form.organization.trim())
      errs.organization = "운용 기관을 입력하세요";

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
    { key: "name", header: "이름" },
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
      key: "memo",
      header: "메모",
      render: (a: Aircraft) => (
        <span className="text-gray-500">{a.memo || "-"}</span>
      ),
    },
    {
      key: "actions",
      header: "",
      width: "50px",
      render: (a: Aircraft) => (
        <button
          onClick={(e) => {
            e.stopPropagation();
            openEdit(a);
          }}
          className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900 transition-colors"
          title="수정"
        >
          <Pencil size={14} />
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Plane size={16} className="text-[#a60739]" />
          <h2 className="text-lg font-semibold text-gray-800">비행검사기 관리</h2>
          <span className="text-xs text-gray-500">({aircraft.length}/10)</span>
        </div>
        <button
          onClick={openAdd}
          disabled={aircraft.length >= 10}
          className="flex items-center gap-2 rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#85062e] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plus size={16} />
          <span>비행검사기 추가</span>
        </button>
      </div>

      {aircraft.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 bg-gray-50 py-16">
          <Plane size={40} className="mb-3 text-gray-600" />
          <p className="text-sm font-medium text-gray-500">
            등록된 비행검사기가 없습니다
          </p>
          <p className="mt-1 text-xs text-gray-600">
            &quot;비행검사기 추가&quot; 버튼을 눌러 등록하세요
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
          <div>
            <label className="mb-1 block text-sm text-gray-600">
              이름 <span className="text-[#a60739]">*</span>
            </label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 placeholder-gray-500 outline-none focus:border-[#a60739] transition-colors"
              placeholder="예: 1호기"
            />
            {errors.name && (
              <p className="mt-1 text-xs text-[#a60739]">{errors.name}</p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-sm text-gray-600">
              기체 모델
            </label>
            <input
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 placeholder-gray-500 outline-none focus:border-[#a60739] transition-colors"
              placeholder="예: King Air 350"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-gray-600">
              등록번호
            </label>
            <input
              value={form.registration}
              onChange={(e) => setForm({ ...form, registration: e.target.value })}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-sm text-gray-800 placeholder-gray-500 outline-none focus:border-[#a60739] transition-colors"
              placeholder="예: FL7779"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-gray-600">
              Mode-S 코드 <span className="text-[#a60739]">*</span>
            </label>
            <input
              value={form.mode_s_code}
              onChange={(e) =>
                setForm({ ...form, mode_s_code: e.target.value })
              }
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-sm text-gray-800 placeholder-gray-500 outline-none focus:border-[#a60739] transition-colors"
              placeholder="예: A1B2C3"
              maxLength={6}
            />
            {errors.mode_s_code && (
              <p className="mt-1 text-xs text-[#a60739]">
                {errors.mode_s_code}
              </p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-sm text-gray-600">
              운용 기관 <span className="text-[#a60739]">*</span>
            </label>
            <input
              value={form.organization}
              onChange={(e) =>
                setForm({ ...form, organization: e.target.value })
              }
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 placeholder-gray-500 outline-none focus:border-[#a60739] transition-colors"
              placeholder="예: 항공우주연구원"
            />
            {errors.organization && (
              <p className="mt-1 text-xs text-[#a60739]">
                {errors.organization}
              </p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-sm text-gray-600">메모</label>
            <textarea
              value={form.memo}
              onChange={(e) => setForm({ ...form, memo: e.target.value })}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 placeholder-gray-500 outline-none focus:border-[#a60739] transition-colors"
              placeholder="비고 사항"
              rows={2}
            />
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setForm({ ...form, active: !form.active })}
              className={`relative h-6 w-11 rounded-full transition-colors ${form.active ? "bg-[#a60739]" : "bg-gray-600"}`}
            >
              <div
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${form.active ? "left-[22px]" : "left-0.5"}`}
              />
            </button>
            <span className="text-sm text-gray-600">
              {form.active ? "활성" : "비활성"}
            </span>
          </div>
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

// ─── 레이더 사이트 편집 폼 ─────────────────────────────────────────────

function RadarSiteEditor({
  initial,
  onSave,
  onCancel,
  onDelete,
}: {
  initial?: RadarSite;
  onSave: (site: RadarSite) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [lat, setLat] = useState(initial?.latitude.toString() ?? "");
  const [lon, setLon] = useState(initial?.longitude.toString() ?? "");
  const [alt, setAlt] = useState(initial?.altitude.toString() ?? "0");
  const [antH, setAntH] = useState(initial?.antenna_height.toString() ?? "25");
  const [rangeNm, setRangeNm] = useState(initial?.range_nm?.toString() ?? "60");
  const [pickMode, setPickMode] = useState(false);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);

  const latRef = useRef(lat);
  const lonRef = useRef(lon);
  latRef.current = lat;
  lonRef.current = lon;

  useEffect(() => {
    if (!pickMode || !mapContainerRef.current) return;

    // ref에서 최신 좌표값 읽기 (stale closure 방지)
    const parsedLat = parseFloat(latRef.current);
    const parsedLon = parseFloat(lonRef.current);

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
      center: [
        !isNaN(parsedLon) ? parsedLon : 127.0,
        !isNaN(parsedLat) ? parsedLat : 36.5,
      ],
      zoom: 6,
    });

    if (!isNaN(parsedLat) && !isNaN(parsedLon)) {
      markerRef.current = new maplibregl.Marker({ color: "#a60739" })
        .setLngLat([parsedLon, parsedLat])
        .addTo(map);
    }

    map.on("click", (e) => {
      const { lng, lat: clickLat } = e.lngLat;
      setLat(clickLat.toFixed(4));
      setLon(lng.toFixed(4));

      if (markerRef.current) {
        markerRef.current.setLngLat([lng, clickLat]);
      } else {
        markerRef.current = new maplibregl.Marker({ color: "#a60739" })
          .setLngLat([lng, clickLat])
          .addTo(map);
      }
    });

    mapRef.current = map;
    return () => {
      markerRef.current = null;
      map.remove();
    };
  }, [pickMode]);

  const handleSave = () => {
    const latitude = parseFloat(lat);
    const longitude = parseFloat(lon);
    const altitude = parseFloat(alt) || 0;
    const antenna_height = parseFloat(antH) || 25;
    const range_nm = parseFloat(rangeNm) || 60;
    if (!name.trim() || isNaN(latitude) || isNaN(longitude)) return;
    onSave({ name: name.trim(), latitude, longitude, altitude, antenna_height, range_nm });
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-100 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-800">
          {initial ? "레이더 사이트 수정" : "새 레이더 사이트 등록"}
        </h3>
        <button onClick={onCancel} className="text-gray-500 hover:text-gray-900">
          <X size={16} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="block text-xs text-gray-500 mb-1">사이트 이름</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="예: 서울레이더"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 placeholder-gray-500 focus:border-[#a60739] focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">위도 (°N)</label>
          <input
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            placeholder="37.5585"
            type="number"
            step="0.0001"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 placeholder-gray-500 focus:border-[#a60739] focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">경도 (°E)</label>
          <input
            value={lon}
            onChange={(e) => setLon(e.target.value)}
            placeholder="126.7906"
            type="number"
            step="0.0001"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 placeholder-gray-500 focus:border-[#a60739] focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">해발 고도 (m)</label>
          <input
            value={alt}
            onChange={(e) => setAlt(e.target.value)}
            placeholder="0"
            type="number"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 placeholder-gray-500 focus:border-[#a60739] focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">안테나 높이 (m)</label>
          <input
            value={antH}
            onChange={(e) => setAntH(e.target.value)}
            placeholder="25"
            type="number"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 placeholder-gray-500 focus:border-[#a60739] focus:outline-none"
          />
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-gray-500 mb-1">제원상 지원범위 (NM)</label>
          <input
            value={rangeNm}
            onChange={(e) => setRangeNm(e.target.value)}
            placeholder="60"
            type="number"
            step="1"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 placeholder-gray-500 focus:border-[#a60739] focus:outline-none"
          />
        </div>
      </div>

      <button
        onClick={() => setPickMode(!pickMode)}
        className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
          pickMode
            ? "bg-[#a60739] text-white"
            : "border border-gray-200 text-gray-500 hover:border-gray-400 hover:text-gray-900"
        }`}
      >
        <MapPin size={14} />
        {pickMode ? "지도 닫기" : "지도에서 클릭하여 좌표 선택"}
      </button>

      {pickMode && (
        <div
          ref={mapContainerRef}
          className="h-64 w-full rounded-lg overflow-hidden border border-gray-200"
        />
      )}

      <div className="flex items-center justify-between">
        {initial && onDelete ? (
          <button
            onClick={onDelete}
            className="rounded-lg px-3 py-2 text-sm text-red-500 hover:bg-red-50 transition-colors"
          >
            삭제
          </button>
        ) : <div />}
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-100"
          >
            취소
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || !lat || !lon}
            className="rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white hover:bg-[#85062e] disabled:opacity-40"
          >
            {initial ? "수정" : "등록"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 레이더사이트 관리 섹션 ────────────────────────────────────────────

function RadarSiteSection() {
  const radarSite = useAppStore((s) => s.radarSite);
  const setRadarSite = useAppStore((s) => s.setRadarSite);
  const customRadarSites = useAppStore((s) => s.customRadarSites);
  const addCustomRadarSite = useAppStore((s) => s.addCustomRadarSite);
  const updateCustomRadarSite = useAppStore((s) => s.updateCustomRadarSite);
  const removeCustomRadarSite = useAppStore((s) => s.removeCustomRadarSite);

  const [showEditor, setShowEditor] = useState(false);
  const [editingSite, setEditingSite] = useState<RadarSite | undefined>();

  const handleSaveCustomSite = (site: RadarSite) => {
    if (editingSite) {
      updateCustomRadarSite(editingSite.name, site);
      if (radarSite.name === editingSite.name) {
        setRadarSite(site);
      }
    } else {
      addCustomRadarSite(site);
    }
    setRadarSite(site);
    setShowEditor(false);
    setEditingSite(undefined);
  };

  const handleEditSite = (site: RadarSite) => {
    if (!customRadarSites.some((s) => s.name === site.name)) {
      addCustomRadarSite(site);
    }
    setEditingSite(site);
    setShowEditor(true);
  };

  const handleDeleteSite = (site: RadarSite) => {
    removeCustomRadarSite(site.name);
    if (radarSite.name === site.name) {
      setRadarSite(DEFAULT_RADAR_SITE);
    }
  };

  const allSites = customRadarSites;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Radio size={16} className="text-[#a60739]" />
          <h2 className="text-lg font-semibold text-gray-800">레이더사이트 관리</h2>
          <span className="text-xs text-gray-500">
            현재: {radarSite.name} ({radarSite.latitude.toFixed(4)}°N, {radarSite.longitude.toFixed(4)}°E)
          </span>
        </div>
        <button
          onClick={() => {
            setEditingSite(undefined);
            setShowEditor(!showEditor);
          }}
          className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-500 hover:border-gray-400 hover:text-gray-900 transition-colors"
        >
          <Plus size={14} />
          직접 등록
        </button>
      </div>

      {/* 사이트 목록 */}
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
        <div className="flex flex-wrap gap-2">
          {allSites.map((site) => (
            <button
              key={site.name}
              onClick={() => setRadarSite(site)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                radarSite.name === site.name
                  ? "bg-[#a60739] text-white"
                  : "border border-gray-200 text-gray-500 hover:border-gray-400 hover:text-gray-900"
              }`}
            >
              {site.name}
            </button>
          ))}
        </div>

        {/* 선택된 사이트 상세 정보 */}
        <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
          <div className="rounded-lg bg-gray-100 p-2.5">
            <span className="text-gray-500">좌표</span>
            <p className="text-gray-800 font-mono mt-0.5">
              {radarSite.latitude.toFixed(4)}°N, {radarSite.longitude.toFixed(4)}°E
            </p>
          </div>
          <div className="rounded-lg bg-gray-100 p-2.5">
            <span className="text-gray-500">해발 고도 / 안테나</span>
            <p className="text-gray-800 font-mono mt-0.5">
              {radarSite.altitude}m / {radarSite.antenna_height}m
            </p>
          </div>
          <div className="rounded-lg bg-gray-100 p-2.5">
            <span className="text-gray-500">지원범위</span>
            <p className="text-gray-800 font-mono mt-0.5">{radarSite.range_nm} NM</p>
          </div>
        </div>
        <div className="mt-2 flex justify-end">
          <button
            onClick={() => handleEditSite(radarSite)}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-200 hover:text-gray-900 transition-colors"
          >
            <Pencil size={12} />
            수정
          </button>
        </div>
      </div>

      {/* 사이트 편집 폼 */}
      {showEditor && (
        <RadarSiteEditor
          initial={editingSite}
          onSave={handleSaveCustomSite}
          onCancel={() => {
            setShowEditor(false);
            setEditingSite(undefined);
          }}
          onDelete={editingSite && allSites.length > 1 ? () => {
            handleDeleteSite(editingSite);
            setShowEditor(false);
            setEditingSite(undefined);
          } : undefined}
        />
      )}
    </div>
  );
}

// ─── OpenSky 인증정보 섹션 ────────────────────────────────────────────

function OpenSkyCredentialsSection() {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const triggerOpenskySync = useAppStore((s) => s.triggerOpenskySync);

  useEffect(() => {
    invoke<[string, string]>("load_opensky_credentials")
      .then(([id, secret]) => {
        setClientId(id);
        setClientSecret(secret);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    try {
      await invoke("save_opensky_credentials", {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      // 저장 즉시 동기화 시작
      if (clientId.trim() && clientSecret.trim()) {
        triggerOpenskySync();
      }
    } catch (e) {
      console.error("Failed to save credentials:", e);
    }
  };

  const hasCredentials = clientId.trim() && clientSecret.trim();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Key size={16} className="text-[#a60739]" />
        <h2 className="text-lg font-semibold text-gray-800">OpenSky API 인증</h2>
        {!loading && (
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
            hasCredentials
              ? "bg-emerald-100 text-emerald-700"
              : "bg-amber-100 text-amber-700"
          }`}>
            {hasCredentials ? "인증됨" : "미설정"}
          </span>
        )}
      </div>
      <p className="text-xs text-gray-500">
        OpenSky Network 계정 인증정보를 등록하면 과거 항적/운항이력 조회가 가능하고, API 호출 제한이 완화됩니다.
      </p>

      {loading ? (
        <div className="py-4 text-center text-sm text-gray-500">로딩 중...</div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-gray-500">Client ID (Username)</label>
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-sm text-gray-800 placeholder-gray-500 outline-none focus:border-[#a60739] transition-colors"
              placeholder="OpenSky username"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-500">Client Secret (Password)</label>
            <div className="relative">
              <input
                type={showSecret ? "text" : "password"}
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 pr-10 font-mono text-sm text-gray-800 placeholder-gray-500 outline-none focus:border-[#a60739] transition-colors"
                placeholder="OpenSky password"
              />
              <button
                type="button"
                onClick={() => setShowSecret(!showSecret)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700"
              >
                {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleSave}
              className="flex items-center gap-2 rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white hover:bg-[#85062e] transition-colors"
            >
              {saved ? <Check size={14} /> : <Key size={14} />}
              {saved ? "저장 완료" : "저장"}
            </button>
            <span className="text-[11px] text-gray-500">
              인증정보는 로컬 DB에 저장됩니다
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 설정 메인 페이지 ──────────────────────────────────────────────────

export default function Settings() {
  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-800">설정</h1>
        <p className="mt-1 text-sm text-gray-500">
          비행검사기 및 레이더사이트를 관리합니다
        </p>
      </div>

      {/* 비행검사기 관리 */}
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-5">
        <AircraftSection />
      </div>

      {/* 레이더사이트 관리 */}
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-5">
        <RadarSiteSection />
      </div>

      {/* OpenSky API 인증 */}
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-5">
        <OpenSkyCredentialsSection />
      </div>
    </div>
  );
}
