import { useState, useRef, useEffect } from "react";
import {
  Plus,
  Pencil,
  Trash2,
  Radio,
  MapPin,
} from "lucide-react";
import maplibregl from "maplibre-gl";
import Modal from "../components/common/Modal";
import DataTable from "../components/common/DataTable";
import { useAppStore } from "../store";
import type { RadarSite } from "../types";

export default function RadarManagement() {
  const customRadarSites = useAppStore((s) => s.customRadarSites);
  const addCustomRadarSite = useAppStore((s) => s.addCustomRadarSite);
  const updateCustomRadarSite = useAppStore((s) => s.updateCustomRadarSite);
  const removeCustomRadarSite = useAppStore((s) => s.removeCustomRadarSite);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingSite, setEditingSite] = useState<RadarSite | undefined>();
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // 폼 상태
  const [name, setName] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [alt, setAlt] = useState("0");
  const [antH, setAntH] = useState("25");
  const [rangeNm, setRangeNm] = useState("60");
  const [active, setActive] = useState(true);
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

  const openAdd = () => {
    setEditingSite(undefined);
    setName("");
    setLat("");
    setLon("");
    setAlt("0");
    setAntH("25");
    setRangeNm("60");
    setActive(true);
    setPickMode(false);
    setModalOpen(true);
  };

  const openEdit = (site: RadarSite) => {
    if (!customRadarSites.some((s) => s.name === site.name)) {
      addCustomRadarSite(site);
    }
    setEditingSite(site);
    setName(site.name);
    setLat(site.latitude.toString());
    setLon(site.longitude.toString());
    setAlt(site.altitude.toString());
    setAntH(site.antenna_height.toString());
    setRangeNm(site.range_nm?.toString() ?? "60");
    setActive(site.active !== false);
    setPickMode(false);
    setModalOpen(true);
  };

  const handleSave = () => {
    const latitude = parseFloat(lat);
    const longitude = parseFloat(lon);
    const altitude = parseFloat(alt) || 0;
    const antenna_height = parseFloat(antH) || 25;
    const range_nm = parseFloat(rangeNm) || 60;
    if (!name.trim() || isNaN(latitude) || isNaN(longitude)) return;

    const site: RadarSite = { name: name.trim(), latitude, longitude, altitude, antenna_height, range_nm, active };

    if (editingSite) {
      updateCustomRadarSite(editingSite.name, site);
    } else {
      addCustomRadarSite(site);
    }
    setModalOpen(false);
  };

  const handleDelete = (siteName: string) => {
    removeCustomRadarSite(siteName);
    setDeleteConfirm(null);
  };

  const allSites = customRadarSites;

  const columns = [
    {
      key: "active",
      header: "활성",
      width: "60px",
      render: (s: RadarSite) => (
        <div className="flex justify-center">
          <div
            className={`h-2.5 w-2.5 rounded-full ${s.active !== false ? "bg-green-500" : "bg-gray-400"}`}
            title={s.active !== false ? "활성" : "비활성"}
          />
        </div>
      ),
      align: "center" as const,
    },
    { key: "name", header: "사이트 이름" },
    {
      key: "coordinates",
      header: "좌표",
      render: (s: RadarSite) => (
        <span className="font-mono text-xs">
          {s.latitude.toFixed(4)}°N, {s.longitude.toFixed(4)}°E
        </span>
      ),
    },
    {
      key: "altitude",
      header: "해발 고도",
      render: (s: RadarSite) => (
        <span className="font-mono text-xs">{s.altitude}m</span>
      ),
    },
    {
      key: "antenna_height",
      header: "안테나 높이",
      render: (s: RadarSite) => (
        <span className="font-mono text-xs">{s.antenna_height}m</span>
      ),
    },
    {
      key: "range_nm",
      header: "지원범위",
      render: (s: RadarSite) => (
        <span className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs">
          {s.range_nm} NM
        </span>
      ),
    },
    {
      key: "actions",
      header: "관리",
      width: "100px",
      render: (s: RadarSite) => (
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              openEdit(s);
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
              setDeleteConfirm(s.name);
            }}
            disabled={allSites.length <= 1}
            className="rounded p-1.5 text-gray-500 hover:bg-red-500/20 hover:text-red-600 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            title="삭제"
            aria-label="삭제"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ),
    },
  ];

  const inputClass = "w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 outline-none focus:border-[#a60739]/50 transition-colors";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">레이더</h1>
          <p className="mt-1 text-sm text-gray-500">
            레이더사이트를 등록/관리합니다 ({allSites.length}개)
          </p>
        </div>
        <button
          onClick={openAdd}
          className="flex items-center gap-2 rounded-lg bg-[#a60739] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#85062e]"
        >
          <Plus size={16} />
          <span>레이더 추가</span>
        </button>
      </div>

      {/* Table */}
      {allSites.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 bg-gray-50 py-20">
          <Radio size={48} className="mb-4 text-gray-400" />
          <p className="text-lg font-medium text-gray-500">
            등록된 레이더사이트가 없습니다
          </p>
          <p className="mt-1 text-sm text-gray-500">
            위의 &quot;레이더 추가&quot; 버튼을 눌러 등록하세요
          </p>
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={allSites}
          rowKey={(s) => s.name}
          emptyMessage="등록된 레이더사이트가 없습니다"
        />
      )}

      {/* Add/Edit Modal */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingSite ? "레이더 사이트 수정" : "레이더 사이트 추가"}
      >
        <div className="space-y-4">
          {/* 사이트 이름 */}
          <div>
            <label className="mb-1 block text-sm text-gray-600">
              사이트 이름 <span className="text-[#a60739]">*</span>
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
              placeholder="예: 서울레이더"
            />
          </div>

          {/* 좌표 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm text-gray-600">
                위도 (°N) <span className="text-[#a60739]">*</span>
              </label>
              <input
                value={lat}
                onChange={(e) => setLat(e.target.value)}
                className={inputClass + " font-mono"}
                placeholder="37.5585"
                type="number"
                step="0.0001"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-gray-600">
                경도 (°E) <span className="text-[#a60739]">*</span>
              </label>
              <input
                value={lon}
                onChange={(e) => setLon(e.target.value)}
                className={inputClass + " font-mono"}
                placeholder="126.7906"
                type="number"
                step="0.0001"
              />
            </div>
          </div>

          {/* 지도 좌표 선택 */}
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

          {/* 고도 / 안테나 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm text-gray-600">해발 고도 (m)</label>
              <input
                value={alt}
                onChange={(e) => setAlt(e.target.value)}
                className={inputClass + " font-mono"}
                placeholder="0"
                type="number"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-gray-600">안테나 높이 (m)</label>
              <input
                value={antH}
                onChange={(e) => setAntH(e.target.value)}
                className={inputClass + " font-mono"}
                placeholder="25"
                type="number"
              />
            </div>
          </div>

          {/* 지원범위 */}
          <div>
            <label className="mb-1 block text-sm text-gray-600">제원상 지원범위 (NM)</label>
            <input
              value={rangeNm}
              onChange={(e) => setRangeNm(e.target.value)}
              className={inputClass + " font-mono"}
              placeholder="60"
              type="number"
              step="1"
            />
          </div>

          {/* 활성/비활성 */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setActive(!active)}
              className={`relative h-6 w-11 rounded-full transition-colors ${active ? "bg-[#a60739]" : "bg-gray-300"}`}
            >
              <div
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${active ? "left-[22px]" : "left-0.5"}`}
              />
            </button>
            <span className="text-sm text-gray-600">
              {active ? "활성" : "비활성"}
            </span>
          </div>

          {/* Buttons */}
          <div className="flex items-center justify-between pt-2">
            {editingSite && allSites.length > 1 ? (
              <button
                onClick={() => { setModalOpen(false); setDeleteConfirm(editingSite.name); }}
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
                disabled={!name.trim() || !lat || !lon}
                className="rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white hover:bg-[#85062e] disabled:opacity-40 transition-colors"
              >
                {editingSite ? "수정" : "등록"}
              </button>
            </div>
          </div>
        </div>
      </Modal>

      {/* Delete Confirmation */}
      <Modal
        open={deleteConfirm !== null}
        onClose={() => setDeleteConfirm(null)}
        title="레이더 사이트 삭제"
        width="max-w-sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            &quot;{deleteConfirm}&quot; 레이더 사이트를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.
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
