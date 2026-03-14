import { useState, useRef, useEffect } from "react";
import {
  Plus,
  Pencil,
  Trash2,
  Plane,
  Radio,
  X,
  MapPin,
} from "lucide-react";
import maplibregl from "maplibre-gl";
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
      header: "상태",
      width: "60px",
      render: (a: Aircraft) => (
        <div className="flex justify-center">
          <div
            className={`h-2.5 w-2.5 rounded-full ${a.active ? "bg-green-400" : "bg-gray-500"}`}
            title={a.active ? "활성" : "비활성"}
          />
        </div>
      ),
      align: "center" as const,
    },
    { key: "name", header: "이름" },
    {
      key: "model",
      header: "기체 모델",
      render: (a: Aircraft) => (
        <span className="text-gray-400">{a.model || "-"}</span>
      ),
    },
    {
      key: "mode_s_code",
      header: "Mode-S",
      render: (a: Aircraft) => (
        <span className="rounded bg-[#0f3460] px-2 py-0.5 font-mono text-xs">
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
      header: "관리",
      width: "100px",
      render: (a: Aircraft) => (
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              openEdit(a);
            }}
            className="rounded p-1.5 text-gray-400 hover:bg-white/10 hover:text-white transition-colors"
            title="수정"
          >
            <Pencil size={14} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setDeleteConfirm(a.id);
            }}
            className="rounded p-1.5 text-gray-400 hover:bg-red-500/20 hover:text-red-400 transition-colors"
            title="삭제"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Plane size={16} className="text-[#e94560]" />
          <h2 className="text-lg font-semibold text-white">비행검사기 관리</h2>
          <span className="text-xs text-gray-500">({aircraft.length}/10)</span>
        </div>
        <button
          onClick={openAdd}
          disabled={aircraft.length >= 10}
          className="flex items-center gap-2 rounded-lg bg-[#e94560] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#d63851] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plus size={16} />
          <span>비행검사기 추가</span>
        </button>
      </div>

      {aircraft.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-white/10 bg-[#16213e] py-16">
          <Plane size={40} className="mb-3 text-gray-600" />
          <p className="text-sm font-medium text-gray-400">
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
            <label className="mb-1 block text-sm text-gray-300">
              이름 <span className="text-[#e94560]">*</span>
            </label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full rounded-lg border border-white/10 bg-[#0f3460]/50 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#e94560]/50 transition-colors"
              placeholder="예: 1호기"
            />
            {errors.name && (
              <p className="mt-1 text-xs text-[#e94560]">{errors.name}</p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-sm text-gray-300">
              기체 모델
            </label>
            <input
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              className="w-full rounded-lg border border-white/10 bg-[#0f3460]/50 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#e94560]/50 transition-colors"
              placeholder="예: King Air 350"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-gray-300">
              Mode-S 코드 <span className="text-[#e94560]">*</span>
            </label>
            <input
              value={form.mode_s_code}
              onChange={(e) =>
                setForm({ ...form, mode_s_code: e.target.value })
              }
              className="w-full rounded-lg border border-white/10 bg-[#0f3460]/50 px-3 py-2 font-mono text-sm text-white placeholder-gray-500 outline-none focus:border-[#e94560]/50 transition-colors"
              placeholder="예: A1B2C3"
              maxLength={6}
            />
            {errors.mode_s_code && (
              <p className="mt-1 text-xs text-[#e94560]">
                {errors.mode_s_code}
              </p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-sm text-gray-300">
              운용 기관 <span className="text-[#e94560]">*</span>
            </label>
            <input
              value={form.organization}
              onChange={(e) =>
                setForm({ ...form, organization: e.target.value })
              }
              className="w-full rounded-lg border border-white/10 bg-[#0f3460]/50 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#e94560]/50 transition-colors"
              placeholder="예: 항공우주연구원"
            />
            {errors.organization && (
              <p className="mt-1 text-xs text-[#e94560]">
                {errors.organization}
              </p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-sm text-gray-300">메모</label>
            <textarea
              value={form.memo}
              onChange={(e) => setForm({ ...form, memo: e.target.value })}
              className="w-full rounded-lg border border-white/10 bg-[#0f3460]/50 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#e94560]/50 transition-colors"
              placeholder="비고 사항"
              rows={2}
            />
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setForm({ ...form, active: !form.active })}
              className={`relative h-6 w-11 rounded-full transition-colors ${form.active ? "bg-[#e94560]" : "bg-gray-600"}`}
            >
              <div
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${form.active ? "left-[22px]" : "left-0.5"}`}
              />
            </button>
            <span className="text-sm text-gray-300">
              {form.active ? "활성" : "비활성"}
            </span>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button
              onClick={() => setModalOpen(false)}
              className="rounded-lg border border-white/10 px-4 py-2 text-sm text-gray-400 hover:bg-white/5 transition-colors"
            >
              취소
            </button>
            <button
              onClick={handleSave}
              className="rounded-lg bg-[#e94560] px-4 py-2 text-sm font-medium text-white hover:bg-[#d63851] transition-colors"
            >
              {editId ? "수정" : "추가"}
            </button>
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
          <p className="text-sm text-gray-300">
            이 비행검사기를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.
          </p>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setDeleteConfirm(null)}
              className="rounded-lg border border-white/10 px-4 py-2 text-sm text-gray-400 hover:bg-white/5 transition-colors"
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
}: {
  initial?: RadarSite;
  onSave: (site: RadarSite) => void;
  onCancel: () => void;
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

  useEffect(() => {
    if (!pickMode || !mapContainerRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
      center: [
        parseFloat(lon) || 127.0,
        parseFloat(lat) || 36.5,
      ],
      zoom: 6,
    });

    const initLat = parseFloat(lat);
    const initLon = parseFloat(lon);
    if (!isNaN(initLat) && !isNaN(initLon)) {
      markerRef.current = new maplibregl.Marker({ color: "#e94560" })
        .setLngLat([initLon, initLat])
        .addTo(map);
    }

    map.on("click", (e) => {
      const { lng, lat: clickLat } = e.lngLat;
      setLat(clickLat.toFixed(4));
      setLon(lng.toFixed(4));

      if (markerRef.current) {
        markerRef.current.setLngLat([lng, clickLat]);
      } else {
        markerRef.current = new maplibregl.Marker({ color: "#e94560" })
          .setLngLat([lng, clickLat])
          .addTo(map);
      }
    });

    mapRef.current = map;
    return () => {
      markerRef.current = null;
      map.remove();
    };
  }, [pickMode]); // eslint-disable-line react-hooks/exhaustive-deps

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
    <div className="rounded-xl border border-white/10 bg-[#0d1b2a] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">
          {initial ? "레이더 사이트 수정" : "새 레이더 사이트 등록"}
        </h3>
        <button onClick={onCancel} className="text-gray-400 hover:text-white">
          <X size={16} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="block text-xs text-gray-400 mb-1">사이트 이름</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="예: 서울레이더"
            className="w-full rounded-lg border border-white/10 bg-[#16213e] px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-[#e94560] focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">위도 (°N)</label>
          <input
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            placeholder="37.5585"
            type="number"
            step="0.0001"
            className="w-full rounded-lg border border-white/10 bg-[#16213e] px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-[#e94560] focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">경도 (°E)</label>
          <input
            value={lon}
            onChange={(e) => setLon(e.target.value)}
            placeholder="126.7906"
            type="number"
            step="0.0001"
            className="w-full rounded-lg border border-white/10 bg-[#16213e] px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-[#e94560] focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">해발 고도 (m)</label>
          <input
            value={alt}
            onChange={(e) => setAlt(e.target.value)}
            placeholder="0"
            type="number"
            className="w-full rounded-lg border border-white/10 bg-[#16213e] px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-[#e94560] focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">안테나 높이 (m)</label>
          <input
            value={antH}
            onChange={(e) => setAntH(e.target.value)}
            placeholder="25"
            type="number"
            className="w-full rounded-lg border border-white/10 bg-[#16213e] px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-[#e94560] focus:outline-none"
          />
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-gray-400 mb-1">제원상 지원범위 (NM)</label>
          <input
            value={rangeNm}
            onChange={(e) => setRangeNm(e.target.value)}
            placeholder="60"
            type="number"
            step="1"
            className="w-full rounded-lg border border-white/10 bg-[#16213e] px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-[#e94560] focus:outline-none"
          />
        </div>
      </div>

      <button
        onClick={() => setPickMode(!pickMode)}
        className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
          pickMode
            ? "bg-[#e94560] text-white"
            : "border border-white/10 text-gray-400 hover:border-white/30 hover:text-white"
        }`}
      >
        <MapPin size={14} />
        {pickMode ? "지도 닫기" : "지도에서 클릭하여 좌표 선택"}
      </button>

      {pickMode && (
        <div
          ref={mapContainerRef}
          className="h-64 w-full rounded-lg overflow-hidden border border-white/10"
        />
      )}

      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-lg border border-white/10 px-4 py-2 text-sm text-gray-400 hover:bg-white/5"
        >
          취소
        </button>
        <button
          onClick={handleSave}
          disabled={!name.trim() || !lat || !lon}
          className="rounded-lg bg-[#e94560] px-4 py-2 text-sm font-medium text-white hover:bg-[#d63851] disabled:opacity-40"
        >
          {initial ? "수정" : "등록"}
        </button>
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
          <Radio size={16} className="text-[#e94560]" />
          <h2 className="text-lg font-semibold text-white">레이더사이트 관리</h2>
          <span className="text-xs text-gray-500">
            현재: {radarSite.name} ({radarSite.latitude.toFixed(4)}°N, {radarSite.longitude.toFixed(4)}°E)
          </span>
        </div>
        <button
          onClick={() => {
            setEditingSite(undefined);
            setShowEditor(!showEditor);
          }}
          className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-400 hover:border-white/30 hover:text-white transition-colors"
        >
          <Plus size={14} />
          직접 등록
        </button>
      </div>

      {/* 사이트 목록 */}
      <div className="rounded-xl border border-white/10 bg-[#16213e] p-4">
        <div className="flex flex-wrap gap-2">
          {allSites.map((site) => (
            <div key={site.name} className="relative group">
              <button
                onClick={() => setRadarSite(site)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  radarSite.name === site.name
                    ? "bg-[#e94560] text-white"
                    : "border border-white/10 text-gray-400 hover:border-white/30 hover:text-white"
                }`}
              >
                {site.name}
              </button>
              <div className="absolute -top-1 -right-1 hidden group-hover:flex gap-0.5">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleEditSite(site);
                  }}
                  className="rounded-full bg-blue-500 p-0.5 text-white hover:bg-blue-400"
                  title="수정"
                >
                  <Pencil size={10} />
                </button>
                {allSites.length > 1 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteSite(site);
                    }}
                    className="rounded-full bg-red-500 p-0.5 text-white hover:bg-red-400"
                    title="삭제"
                  >
                    <X size={10} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* 선택된 사이트 상세 정보 */}
        <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
          <div className="rounded-lg bg-[#0d1b2a] p-2.5">
            <span className="text-gray-500">좌표</span>
            <p className="text-white font-mono mt-0.5">
              {radarSite.latitude.toFixed(4)}°N, {radarSite.longitude.toFixed(4)}°E
            </p>
          </div>
          <div className="rounded-lg bg-[#0d1b2a] p-2.5">
            <span className="text-gray-500">해발 고도 / 안테나</span>
            <p className="text-white font-mono mt-0.5">
              {radarSite.altitude}m / {radarSite.antenna_height}m
            </p>
          </div>
          <div className="rounded-lg bg-[#0d1b2a] p-2.5">
            <span className="text-gray-500">지원범위</span>
            <p className="text-white font-mono mt-0.5">{radarSite.range_nm} NM</p>
          </div>
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
        />
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
        <h1 className="text-2xl font-bold text-white">설정</h1>
        <p className="mt-1 text-sm text-gray-400">
          비행검사기 및 레이더사이트를 관리합니다
        </p>
      </div>

      {/* 비행검사기 관리 */}
      <div className="rounded-xl border border-white/10 bg-[#16213e]/50 p-5">
        <AircraftSection />
      </div>

      {/* 레이더사이트 관리 */}
      <div className="rounded-xl border border-white/10 bg-[#16213e]/50 p-5">
        <RadarSiteSection />
      </div>
    </div>
  );
}
