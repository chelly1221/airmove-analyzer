import { useState, useRef, useEffect } from "react";
import {
  Plus,
  Pencil,
  Trash2,
  Radio,
  MapPin,
  Building2,
  Check,
} from "lucide-react";
import maplibregl from "maplibre-gl";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { Tile3DLayer } from "@deck.gl/geo-layers";
import { Tiles3DLoader } from "@loaders.gl/3d-tiles";
import Modal from "../components/common/Modal";
import DataTable from "../components/common/DataTable";
import { useAppStore } from "../store";
import type { RadarSite, AddressBuildingHit } from "../types";

/**
 * 실측 3D 메시 표출 줌 임계 — TrackMap 의 `BUILDINGS_3D_MIN_ZOOM`(=14) 과 같은 값을 이 화면에서
 * 독립 정의(창·페이지 간 결합 회피). 광역 줌에서 타일셋 전역이 순회·로드 대상이 되는 것을 막는다.
 */
const MESH_MIN_ZOOM = 14;
/** 실측 3D 타일 레이어 id — 클릭 시 GPU 픽(pickObject) 대상 */
const MESH_LAYER_IDS = ["radar-pick-3dtiles", "radar-pick-3dtiles-cdm"];
/** 선택 건물 footprint 윤곽선 소스/레이어 id */
const OUTLINE_SRC = "picked-building-outline";
const OUTLINE_LAYER = "picked-building-outline-line";
/** 좌표 선택 지도의 고정 SSE — TrackMap 과 달리 피치 적응 램프 없이 기본값 사용 */
const MESH_SSE = 8;

/** footprint 링 [[lat,lon],...] → GeoJSON 폴리곤 좌표(경도 우선, 닫힌 링) */
function ringToCoords(ring: [number, number][]): [number, number][] {
  const coords: [number, number][] = ring.map(([la, lo]) => [lo, la]);
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) coords.push([first[0], first[1]]);
  return coords;
}

/** 선택 건물 → 윤곽선 GeoJSON (없으면 빈 FeatureCollection) */
function outlineData(hit: AddressBuildingHit | null) {
  return {
    type: "FeatureCollection" as const,
    features: (hit?.polygons ?? [])
      .filter((ring) => ring.length >= 3)
      .map((ring) => ({
        type: "Feature" as const,
        properties: {},
        geometry: { type: "Polygon" as const, coordinates: [ringToCoords(ring)] },
      })),
  };
}

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
  /** 등록된 실측 3D 타일셋 폴더 (미등록이면 null → 2D 평면 지도 그대로) */
  const [tiles3dDir, setTiles3dDir] = useState<string | null>(null);
  /** 지도에서 클릭해 선택한 건물 (레이더 위치 지정 후보) */
  const [pickedBuilding, setPickedBuilding] = useState<AddressBuildingHit | null>(null);
  /** 선택 건물을 폼에 반영했는지 (카드의 "적용됨" 표시용) */
  const [pickedApplied, setPickedApplied] = useState(false);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  /** deck.gl MapboxOverlay 인스턴스 — 클릭 시점 실측 메시 pickObject 용 */
  const deckOverlayRef = useRef<MapboxOverlay | null>(null);
  /** onTilesetLoad 로 수집한 Tileset3D 인스턴스(main + cdm 최대 2개) — 줌 게이트 라이브 반영 대상 */
  const meshTilesetsRef = useRef<any[]>([]);
  /** 윤곽선 소스·레이어 준비 완료(스타일 load 이후) 여부 */
  const outlineReadyRef = useRef(false);
  /** 최신 클릭 시퀀스 — 늦게 도착한 이전 클릭의 건물 조회 응답 무시 */
  const pickSeqRef = useRef(0);

  const latRef = useRef(lat);
  const lonRef = useRef(lon);
  latRef.current = lat;
  lonRef.current = lon;
  const pickedBuildingRef = useRef(pickedBuilding);
  pickedBuildingRef.current = pickedBuilding;

  // 등록된 실측 3D 타일셋 폴더 조회 (미등록이면 null 유지 → 메시 오버레이 미부착)
  useEffect(() => {
    invoke<string | null>("get_tiles3d_dir")
      .then(setTiles3dDir)
      .catch(() => { /* 미등록 */ });
  }, []);

  /** 마커를 해당 좌표로 이동(없으면 생성) */
  const placeMarker = (lng: number, latitude: number) => {
    const map = mapRef.current;
    if (!map) return;
    if (markerRef.current) {
      markerRef.current.setLngLat([lng, latitude]);
    } else {
      const marker = new maplibregl.Marker({ color: "#a60739" })
        .setLngLat([lng, latitude])
        .addTo(map);
      // deck MapboxOverlay(overlaid) 캔버스는 maplibre 컨트롤 코너(z-index:2)에 부착돼 HTML 마커
      // (z-index auto)를 덮는다 — 캔버스 컨테이너가 스태킹 컨텍스트가 아니므로 마커에 3 을 주면
      // 실측 3D 메시 위에도 마커가 항상 보인다 (AddressSearch 와 동일 계약).
      marker.getElement().style.zIndex = "3";
      markerRef.current = marker;
    }
  };

  useEffect(() => {
    if (!pickMode || !mapContainerRef.current) return;

    const parsedLat = parseFloat(latRef.current);
    const parsedLon = parseFloat(lonRef.current);
    const hasCoord = !isNaN(parsedLat) && !isNaN(parsedLon);
    // 실측 메시가 등록돼 있고 시작 좌표가 있으면 메시가 곧바로 보이는 근접·기울임 시점으로 시작
    const meshStart = hasCoord && !!tiles3dDir;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
      center: [hasCoord ? parsedLon : 127.0, hasCoord ? parsedLat : 36.5],
      zoom: meshStart ? 16 : 6,
      pitch: meshStart ? 45 : 0,
    });
    mapRef.current = map;

    if (hasCoord) placeMarker(parsedLon, parsedLat);

    // ── 실측 3D 메시(3D Tiles) 오버레이 ─────────────────────────────────────────
    // overlaid(MapboxOverlay) 모드 — deck 캔버스가 별도라 maplibre 클릭 이벤트와 충돌 없음.
    let overlay: MapboxOverlay | null = null;
    let zoomOk = map.getZoom() >= MESH_MIN_ZOOM;
    // 최신 게이트 목표값. 타일셋 로드는 비동기라 게이트가 먼저 바뀔 수 있고, 늦게 도착한
    // 타일셋도 로드 시점에 현재 목표값을 반영해야 초기 1회 과로드를 피한다.
    const meshTune = { load: zoomOk };

    if (tiles3dDir) {
      // Tile3DLayer 는 Tileset3D 옵션을 생성자로 전달하지 않아 onTilesetLoad 에서 주입
      const tuneTileset = (ts: any) => {
        ts.setProps({
          debounceTime: 150,
          memoryAdjustedScreenSpaceError: true,
          maximumScreenSpaceError: MESH_SSE,
          loadTiles: meshTune.load,
        });
        ts._cacheBytes = 256 * 1024 * 1024;
        ts._cacheOverflowBytes = 64 * 1024 * 1024;
        meshTilesetsRef.current.push(ts);
      };
      const makeLayers = (visible: boolean) =>
        MESH_LAYER_IDS.map((id, i) =>
          new Tile3DLayer({
            id,
            // TrackMap 과 동일한 데이터 URL 구성 (tiles3d 커스텀 프로토콜로 로컬 타일셋 서빙)
            data: convertFileSrc(i === 0 ? "tileset.json" : "tileset_cdm.json", "tiles3d"),
            loader: Tiles3DLoader,
            // 줌 게이트 — visible:false 는 드로우만 막고 순회 라이프사이클은 계속 돌기 때문에
            // 실제 로드 차단은 아래 loadTiles:false 와 페어로만 성립한다(동결 → 캐시 유지).
            visible,
            pickable: true, // 클릭 시점 pickObject(메시 표면 좌표)용
            onTilesetLoad: tuneTileset,
            onTileError: (err: unknown) => console.warn("실측 3D 타일 로드 실패:", err),
          }),
        );

      overlay = new MapboxOverlay({ interleaved: false, layers: makeLayers(zoomOk) });
      map.addControl(overlay as unknown as maplibregl.IControl);
      deckOverlayRef.current = overlay;

      // 줌 변화 시 게이트 라이브 반영 — 레이어 재생성(id·data 동일 → deck 이 tileset state 승계)
      // + 로드된 타일셋 loadTiles 토글. 레이어를 제거하지 않으므로 재진입 시 재요청·재파싱 없음.
      const applyGate = () => {
        const ok = map.getZoom() >= MESH_MIN_ZOOM;
        if (ok === zoomOk) return;
        zoomOk = ok;
        meshTune.load = ok;
        overlay?.setProps({ layers: makeLayers(ok) });
        for (const ts of meshTilesetsRef.current) {
          ts.setProps({ maximumScreenSpaceError: MESH_SSE, loadTiles: ok });
          if (ok) ts.update(); // 게이트 재진입 시 즉시 재순회
        }
      };
      map.on("move", applyGate); // 줌 조작도 move 를 발화시킴
      map.on("zoom", applyGate);
    }

    // ── 선택 건물 footprint 윤곽선 ────────────────────────────────────────────
    map.on("load", () => {
      map.addSource(OUTLINE_SRC, { type: "geojson", data: outlineData(null) });
      map.addLayer({
        id: OUTLINE_LAYER,
        type: "line",
        source: OUTLINE_SRC,
        paint: { "line-color": "#a60739", "line-width": 2 },
      });
      outlineReadyRef.current = true;
      // 스타일 로드 전에 선택된 건물이 있으면 즉시 반영
      const src = map.getSource(OUTLINE_SRC) as maplibregl.GeoJSONSource | undefined;
      src?.setData(outlineData(pickedBuildingRef.current));
    });

    map.on("click", (e) => {
      // ① 실측 메시 표출 중이면 GPU 픽 우선 — 화면에 보이는 실측 지붕면을 그대로 클릭 대상으로
      let lng = e.lngLat.lng;
      let clickLat = e.lngLat.lat;
      let meshHit = false;
      if (overlay) {
        try {
          const coord = overlay.pickObject({
            x: e.point.x,
            y: e.point.y,
            layerIds: MESH_LAYER_IDS,
          })?.coordinate;
          if (coord) {
            lng = coord[0];
            clickLat = coord[1];
            meshHit = true;
          }
        } catch { /* deck 미초기화 등 — 평면 좌표 폴백 */ }
      }

      // ② 기본 동작(변경 없음): 입력란 좌표 갱신 + 마커 이동
      setLat(clickLat.toFixed(4));
      setLon(lng.toFixed(4));
      placeMarker(lng, clickLat);

      // ③ 클릭 지점 인근 건물 조회 — 내부 포함이거나 메시를 직접 맞춘 경우만 선택 후보로 채택
      pickSeqRef.current += 1;
      const seq = pickSeqRef.current;
      invoke<AddressBuildingHit | null>("find_building_near_point", {
        lat: clickLat,
        lon: lng,
        radiusM: 40,
      })
        .then((hit) => {
          if (seq !== pickSeqRef.current) return; // 이후 클릭이 있었으면 폐기
          if (hit && (hit.contained || meshHit)) {
            setPickedBuilding(hit);
            setPickedApplied(false);
          } else {
            setPickedBuilding(null);
          }
        })
        .catch(() => {
          if (seq === pickSeqRef.current) setPickedBuilding(null);
        });
    });

    return () => {
      markerRef.current = null;
      outlineReadyRef.current = false;
      if (overlay) {
        try {
          map.removeControl(overlay as unknown as maplibregl.IControl);
        } catch { /* 이미 제거됨 */ }
      }
      deckOverlayRef.current = null;
      meshTilesetsRef.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, [pickMode, tiles3dDir]);

  // 선택 건물 윤곽선 갱신 (스타일 load 이후에만 — 그 전 선택분은 load 핸들러가 반영)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !outlineReadyRef.current) return;
    const src = map.getSource(OUTLINE_SRC) as maplibregl.GeoJSONSource | undefined;
    src?.setData(outlineData(pickedBuilding));
  }, [pickedBuilding]);

  /** 선택 건물을 레이더 위치로 지정 — 좌표·해발고도·안테나 높이 폼 반영 */
  const applyPickedBuilding = () => {
    const b = pickedBuilding;
    if (!b) return;
    // centroid 는 소수 6자리로 — 좁은 footprint 안쪽에 좌표가 유지돼야 백엔드 포함 판정(자동 제외)이 성립
    setLat(b.lat.toFixed(6));
    setLon(b.lon.toFixed(6));
    setAlt(b.ground_elev_m.toFixed(1));
    setAntH((b.height_measured ?? b.height_m).toFixed(1));
    placeMarker(b.lon, b.lat);
    setPickedApplied(true);
  };

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
    setPickedBuilding(null);
    setPickedApplied(false);
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
    setPickedBuilding(null);
    setPickedApplied(false);
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
            onClick={() => {
              const next = !pickMode;
              setPickMode(next);
              if (!next) {
                setPickedBuilding(null);
                setPickedApplied(false);
              }
            }}
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
            <div className="space-y-2">
              <div
                ref={mapContainerRef}
                className="h-80 w-full rounded-lg overflow-hidden border border-gray-200"
              />
              <p className="text-[11px] text-gray-400">
                {tiles3dDir
                  ? "줌 14 이상에서 실측 3D 표시 · 우클릭 드래그로 기울이기 · 건물을 클릭하면 레이더 위치로 지정할 수 있습니다"
                  : "지도를 클릭하여 좌표를 선택하세요 (실측 3D 자료 미등록)"}
              </p>

              {/* 선택 건물 카드 */}
              {pickedBuilding && (
                <div className="space-y-2 rounded-lg border border-gray-200 bg-[#f8f9fa] p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Building2 size={14} className="shrink-0 text-[#a60739]" />
                        <span className="truncate text-sm font-medium text-gray-800">
                          {pickedBuilding.name || "이름 없음"}
                        </span>
                        {pickedBuilding.height_measured != null && (
                          <span className="shrink-0 rounded bg-[#a60739]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#a60739]">
                            실측
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-gray-500">
                        {pickedBuilding.usage || "용도 미상"}
                      </p>
                      <p className="mt-0.5 font-mono text-xs text-gray-500">
                        지반고 {pickedBuilding.ground_elev_m.toFixed(1)}m · 높이{" "}
                        {(pickedBuilding.height_measured ?? pickedBuilding.height_m).toFixed(1)}m
                      </p>
                    </div>
                    {pickedApplied && (
                      <span className="flex shrink-0 items-center gap-1 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700">
                        <Check size={10} />
                        적용됨
                      </span>
                    )}
                  </div>
                  <button
                    onClick={applyPickedBuilding}
                    className="w-full rounded-lg bg-[#a60739] px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-[#85062e]"
                  >
                    이 건물을 레이더 위치로 지정
                  </button>
                  <p className="text-[11px] leading-relaxed text-gray-500">
                    레이더 좌표가 건물 내부에 있으면 해당 건물은 LoS·커버리지 분석에서 자동
                    제외됩니다. 안테나 높이는 필요시 조정하세요.
                  </p>
                </div>
              )}
            </div>
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
