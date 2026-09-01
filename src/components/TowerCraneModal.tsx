// 타워크레인 등록·수정 모달 — 위치(미니맵 클릭 1점) + 제원 입력 + 지브 미리보기.
//   건물 모달(BuildingModal)과 달리 폴리곤 작도가 없고, 전역 draft 보존도 없다(로컬 state).
import { useState, useEffect, useMemo, useRef } from "react";
import MapGL, { Marker, Source, Layer, type MapRef } from "react-map-gl/maplibre";
import { Loader2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import Modal from "./common/Modal";
import { DsSlider } from "./Map/drawerPrimitives";
import type { CraneRotationMode, TowerCrane, TowerCraneInput } from "../types";
import { MAP_STYLE_URL } from "../utils/radarConstants";

/** 폼 상태 — 숫자 필드는 입력 중 빈 문자열/부분 입력을 허용해야 하므로 문자열로 보관 */
interface CraneForm {
  name: string;
  latitude: string;
  longitude: string;
  ground_elev: string;
  elev_mode: "auto" | "manual";
  jib_height: string;
  top_height: string;
  jib_length: string;
  counter_jib_length: string;
  jib_azimuth_deg: number;
  rotation_mode: CraneRotationMode;
  mast_width: string;
  memo: string;
}

const emptyForm: CraneForm = {
  name: "",
  latitude: "",
  longitude: "",
  ground_elev: "0",
  elev_mode: "auto", // 신규 등록 기본 자동(SRTM)
  jib_height: "",
  top_height: "",
  jib_length: "",
  counter_jib_length: "",
  jib_azimuth_deg: 0,
  rotation_mode: "fixed",
  mast_width: "2.0",
  memo: "",
};

const EARTH_RADIUS_M = 6_371_000;

/** 로컬 ENU(m) → 위경도 (미리보기 전용, craneGeometry 와 동일 평면 스케일) */
function offsetLatLon(lat: number, lon: number, east: number, north: number): [number, number] {
  const degPerM = 180 / Math.PI / EARTH_RADIUS_M;
  return [lon + east * degPerM / Math.cos((lat * Math.PI) / 180), lat + north * degPerM];
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** 저장 실패 시 reject — 모달은 열린 채 에러 문구를 표시한다(조용한 무시 금지) */
  onSave: (input: TowerCraneInput) => Promise<void>;
  initial: TowerCrane | null;
}

export default function TowerCraneModal({ open, onClose, onSave, initial }: Props) {
  const [form, setForm] = useState<CraneForm>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [elevLoading, setElevLoading] = useState(false);
  const mapRef = useRef<MapRef>(null);
  /** 자동 지반고 재조회 억제용 마지막 좌표 키 — 오픈 직후엔 저장값을 그대로 표시 */
  const lastAutoCoordsRef = useRef<string | null>(null);
  /** 파생 기본값(최상단·카운터지브) 자동 채움 여부 — 사용자가 직접 만지면 중단 */
  const topTouched = useRef(false);
  const cjTouched = useRef(false);

  // 오픈 시 1회 시드 (닫으면 Modal 이 언마운트되므로 잔여 상태 없음)
  useEffect(() => {
    if (!open) return;
    if (initial) {
      setForm({
        name: initial.name,
        latitude: String(initial.latitude),
        longitude: String(initial.longitude),
        ground_elev: String(initial.ground_elev),
        elev_mode: initial.elev_mode,
        jib_height: String(initial.jib_height),
        top_height: String(initial.top_height),
        jib_length: String(initial.jib_length),
        counter_jib_length: String(initial.counter_jib_length),
        jib_azimuth_deg: initial.jib_azimuth_deg,
        rotation_mode: initial.rotation_mode,
        mast_width: String(initial.mast_width),
        memo: initial.memo,
      });
      lastAutoCoordsRef.current = `${initial.latitude},${initial.longitude}`;
      topTouched.current = true;
      cjTouched.current = true;
    } else {
      setForm(emptyForm);
      lastAutoCoordsRef.current = null;
      topTouched.current = false;
      cjTouched.current = false;
    }
    setError(null);
  }, [open, initial]);

  // 자동(SRTM) 모드에서 좌표가 바뀔 때만 지반고 재조회 — BuildingModal 과 동일 계약(정수 반올림 저장)
  useEffect(() => {
    if (!open || form.elev_mode !== "auto") return;
    const lat = parseFloat(form.latitude);
    const lon = parseFloat(form.longitude);
    if (isNaN(lat) || isNaN(lon)) return;
    const key = `${form.latitude},${form.longitude}`;
    if (key === lastAutoCoordsRef.current) return;
    lastAutoCoordsRef.current = key;
    let cancelled = false;
    setElevLoading(true);
    invoke<number[]>("fetch_elevation", { latitudes: [lat], longitudes: [lon] })
      .then((elevs) => { if (!cancelled) setForm((f) => ({ ...f, ground_elev: String(Math.round(elevs[0] ?? 0)) })); })
      .catch((e) => { if (!cancelled) setError(`지반 표고(SRTM) 조회 실패: ${e}`); })
      .finally(() => { if (!cancelled) setElevLoading(false); });
    return () => { cancelled = true; };
  }, [open, form.elev_mode, form.latitude, form.longitude]);

  const lat = parseFloat(form.latitude);
  const lon = parseFloat(form.longitude);
  const hasPos = !isNaN(lat) && !isNaN(lon);
  const jibH = parseFloat(form.jib_height);
  const topH = parseFloat(form.top_height);
  const jibL = parseFloat(form.jib_length);
  const cjL = parseFloat(form.counter_jib_length);
  const mastW = parseFloat(form.mast_width);

  /** 미니맵 미리보기 — 지브 선 · 카운터지브 선 · (전방위 모드) 선회 반경 원 */
  const previewGeoJson = useMemo<GeoJSON.FeatureCollection | null>(() => {
    if (!hasPos) return null;
    const th = (form.jib_azimuth_deg * Math.PI) / 180;
    const features: GeoJSON.Feature[] = [];
    const L = isNaN(jibL) ? 0 : jibL;
    const Lc = isNaN(cjL) ? 0 : cjL;
    if (L > 0) {
      const [eLon, eLat] = offsetLatLon(lat, lon, Math.sin(th) * L, Math.cos(th) * L);
      features.push({
        type: "Feature", properties: { kind: "jib" },
        geometry: { type: "LineString", coordinates: [[lon, lat], [eLon, eLat]] },
      });
    }
    if (Lc > 0) {
      const [eLon, eLat] = offsetLatLon(lat, lon, -Math.sin(th) * Lc, -Math.cos(th) * Lc);
      features.push({
        type: "Feature", properties: { kind: "counter" },
        geometry: { type: "LineString", coordinates: [[lon, lat], [eLon, eLat]] },
      });
    }
    if (form.rotation_mode === "full") {
      const R = Math.max(L, Lc);
      if (R > 0) {
        const ring: [number, number][] = [];
        for (let i = 0; i <= 64; i++) {
          const a = (2 * Math.PI * i) / 64;
          ring.push(offsetLatLon(lat, lon, Math.sin(a) * R, Math.cos(a) * R));
        }
        features.push({
          type: "Feature", properties: { kind: "sweep" },
          geometry: { type: "LineString", coordinates: ring },
        });
      }
    }
    return features.length > 0 ? { type: "FeatureCollection", features } : null;
  }, [hasPos, lat, lon, jibL, cjL, form.jib_azimuth_deg, form.rotation_mode]);

  const setNum = (key: keyof CraneForm, v: string) => setForm((f) => ({ ...f, [key]: v }));

  /** 미니맵 onLoad 시 최신 좌표 참조용 — initialViewState 는 마운트 1회라 시드 직후 좌표가 반영되지 않는다 */
  const posRef = useRef<[number, number] | null>(null);
  posRef.current = hasPos ? [lat, lon] : null;

  const handleSubmit = async () => {
    // 검증 실패는 에러 문구로 명시 — 조용한 보정 없음
    if (!form.name.trim()) { setError("이름을 입력하세요."); return; }
    if (!hasPos) { setError("위치(위도·경도)를 지정하세요."); return; }
    if (!(jibH > 0)) { setError("지브 설치고는 0보다 커야 합니다."); return; }
    if (!(topH >= jibH)) { setError("최상단 높이는 지브 설치고 이상이어야 합니다."); return; }
    if (!(jibL > 0)) { setError("지브 길이는 0보다 커야 합니다."); return; }
    if (!(cjL >= 0)) { setError("카운터지브 길이는 0 이상이어야 합니다."); return; }
    if (!(mastW > 0)) { setError("마스트 폭은 0보다 커야 합니다."); return; }
    const ground = parseFloat(form.ground_elev);
    if (isNaN(ground)) { setError("지반 표고를 입력하세요."); return; }
    setError(null);
    setSaving(true);
    try {
      await onSave({
        name: form.name.trim(),
        latitude: lat,
        longitude: lon,
        groundElev: ground,
        elevMode: form.elev_mode,
        jibHeight: jibH,
        topHeight: topH,
        jibLength: jibL,
        counterJibLength: cjL,
        jibAzimuthDeg: ((form.jib_azimuth_deg % 360) + 360) % 360,
        rotationMode: form.rotation_mode,
        mastWidth: mastW,
        memo: form.memo,
      });
    } catch (e) {
      setError(`저장 실패: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  const inputCls = "w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-[#a60739] focus:outline-none focus:ring-1 focus:ring-[#a60739]/30";

  return (
    <Modal open={open} onClose={onClose} title={initial ? "타워크레인 수정" : "타워크레인 등록"} width="max-w-[min(1200px,94vw)]">
      <div className="flex gap-4">
        {/* 왼쪽: 입력 폼 */}
        <div className="w-80 shrink-0 space-y-2.5">
          <div>
            <label className="mb-0.5 block text-xs font-medium text-gray-600">이름<span className="ml-0.5 text-red-500">*</span></label>
            <input type="text" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="예: ○○현장 T/C 1호기" className={inputCls} />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-0.5 block text-xs font-medium text-gray-600">위도<span className="ml-0.5 text-red-500">*</span></label>
              <input type="number" value={form.latitude} onChange={(e) => setNum("latitude", e.target.value)}
                placeholder="예: 37.5512" className={inputCls} />
            </div>
            <div>
              <label className="mb-0.5 block text-xs font-medium text-gray-600">경도<span className="ml-0.5 text-red-500">*</span></label>
              <input type="number" value={form.longitude} onChange={(e) => setNum("longitude", e.target.value)}
                placeholder="예: 126.9882" className={inputCls} />
            </div>
          </div>

          {/* 지면 표고 (auto=SRTM 스냅샷 / manual=직접 입력) */}
          <div>
            <div className="mb-0.5 flex items-center justify-between">
              <label className="text-xs font-medium text-gray-600">지면 표고 (m)</label>
              <div className="flex overflow-hidden rounded-md border border-gray-200">
                <button type="button" onClick={() => { lastAutoCoordsRef.current = null; setForm((f) => ({ ...f, elev_mode: "auto" })); }}
                  className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${form.elev_mode === "auto" ? "bg-[#a60739] text-white" : "bg-gray-50 text-gray-400 hover:bg-gray-100"}`}>자동</button>
                <button type="button" onClick={() => setForm((f) => ({ ...f, elev_mode: "manual" }))}
                  className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${form.elev_mode === "manual" ? "bg-[#a60739] text-white" : "bg-gray-50 text-gray-400 hover:bg-gray-100"}`}>수동</button>
              </div>
            </div>
            <div className="relative">
              <input type="number" value={form.ground_elev} onChange={(e) => setNum("ground_elev", e.target.value)}
                disabled={form.elev_mode === "auto"} placeholder="예: 12"
                className={`${inputCls} ${form.elev_mode === "auto" ? "pr-8 text-gray-500" : ""}`} />
              {form.elev_mode === "auto" && elevLoading && <Loader2 size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-gray-400" />}
              {form.elev_mode === "auto" && !elevLoading && form.ground_elev !== "" && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-gray-400">SRTM</span>}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-0.5 block text-xs font-medium text-gray-600">지브 설치고 (m AGL)<span className="ml-0.5 text-red-500">*</span></label>
              <input type="number" value={form.jib_height}
                onChange={(e) => {
                  const v = e.target.value;
                  setForm((f) => {
                    const h = parseFloat(v);
                    // 최상단은 지브 설치고 + 6 이 기본 — 사용자가 직접 입력하기 전까지만 따라간다
                    const top = !topTouched.current && !isNaN(h) ? String(h + 6) : f.top_height;
                    return { ...f, jib_height: v, top_height: top };
                  });
                }}
                placeholder="예: 60" className={inputCls} />
            </div>
            <div>
              <label className="mb-0.5 block text-xs font-medium text-gray-600">최상단 높이 (m AGL)<span className="ml-0.5 text-red-500">*</span></label>
              <input type="number" value={form.top_height}
                onChange={(e) => { topTouched.current = true; setNum("top_height", e.target.value); }}
                placeholder="예: 66" className={inputCls} />
            </div>
          </div>
          {!isNaN(jibH) && !isNaN(topH) && topH < jibH && (
            <div className="text-[11px] text-[#e94560]">최상단 높이는 지브 설치고({jibH}m) 이상이어야 합니다.</div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-0.5 block text-xs font-medium text-gray-600">지브 길이 (m)<span className="ml-0.5 text-red-500">*</span></label>
              <input type="number" value={form.jib_length}
                onChange={(e) => {
                  const v = e.target.value;
                  setForm((f) => {
                    const l = parseFloat(v);
                    // 카운터지브 기본값 = 지브 길이 × 0.3 (반올림)
                    const cj = !cjTouched.current && !isNaN(l) ? String(Math.round(l * 0.3)) : f.counter_jib_length;
                    return { ...f, jib_length: v, counter_jib_length: cj };
                  });
                }}
                placeholder="예: 60" className={inputCls} />
            </div>
            <div>
              <label className="mb-0.5 block text-xs font-medium text-gray-600">카운터지브 길이 (m)</label>
              <input type="number" value={form.counter_jib_length}
                onChange={(e) => { cjTouched.current = true; setNum("counter_jib_length", e.target.value); }}
                placeholder="예: 18" className={inputCls} />
            </div>
          </div>

          {/* 지브 방위각 (정북 0 · 시계방향) */}
          <div>
            <div className="mb-0.5 flex items-center justify-between">
              <label className="text-xs font-medium text-gray-600">지브 방위각 (°)</label>
              <input type="number" min={0} max={359} value={form.jib_azimuth_deg}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) setForm((f) => ({ ...f, jib_azimuth_deg: ((Math.round(v) % 360) + 360) % 360 }));
                }}
                disabled={form.rotation_mode === "full"}
                className="w-20 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-right text-sm text-gray-800 focus:border-[#a60739] focus:outline-none disabled:text-gray-400" />
            </div>
            <DsSlider value={form.jib_azimuth_deg} min={0} max={359} step={1}
              disabled={form.rotation_mode === "full"}
              onChange={(v) => setForm((f) => ({ ...f, jib_azimuth_deg: v }))} />
          </div>

          {/* 선회 모드 */}
          <div>
            <label className="mb-0.5 block text-xs font-medium text-gray-600">선회 모드</label>
            <div className="flex overflow-hidden rounded-lg border border-gray-200">
              {([["fixed", "고정 방위각"], ["full", "전방위 최악조건"]] as const).map(([k, label]) => (
                <button key={k} type="button" onClick={() => setForm((f) => ({ ...f, rotation_mode: k }))}
                  className={`flex-1 px-2 py-1.5 text-xs font-medium transition-colors ${form.rotation_mode === k ? "bg-[#a60739] text-white" : "bg-gray-50 text-gray-500 hover:bg-gray-100"}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-0.5 block text-xs font-medium text-gray-600">마스트 폭 (m)</label>
              <input type="number" value={form.mast_width} onChange={(e) => setNum("mast_width", e.target.value)}
                placeholder="예: 2.0" className={inputCls} />
            </div>
            <div>
              <label className="mb-0.5 block text-xs font-medium text-gray-600">메모</label>
              <input type="text" value={form.memo} onChange={(e) => setForm((f) => ({ ...f, memo: e.target.value }))}
                placeholder="현장·주소 등" className={inputCls} />
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-[#e94560]/30 bg-[#e94560]/5 px-3 py-1.5 text-[11px] text-[#e94560]">{error}</div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 transition-colors hover:bg-gray-100">취소</button>
            <button onClick={handleSubmit} disabled={saving}
              className="flex items-center gap-1.5 rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#85062e] disabled:opacity-40">
              {saving && <Loader2 size={13} className="animate-spin" />}
              {initial ? "수정" : "등록"}
            </button>
          </div>
        </div>

        {/* 오른쪽: 미니맵 (클릭 1점으로 위치 지정 + 지브 미리보기) */}
        <div className="flex flex-1 flex-col gap-1.5">
          <span className="text-[10px] text-gray-400">지도를 클릭해 크레인 위치를 지정합니다 (주황 = 지브, 회색 = 카운터지브, 점선 = 전방위 선회 범위)</span>
          <div className="relative h-[60vh] min-h-72 w-full overflow-hidden rounded-xl border border-gray-200">
            <MapGL
              ref={mapRef}
              initialViewState={{ latitude: hasPos ? lat : 37.55, longitude: hasPos ? lon : 126.99, zoom: hasPos ? 16 : 7, pitch: 0 }}
              maxPitch={0}
              mapStyle={MAP_STYLE_URL}
              style={{ width: "100%", height: "100%" }}
              cursor="crosshair"
              attributionControl={false}
              onClick={(evt) => setForm((f) => ({ ...f, latitude: evt.lngLat.lat.toFixed(6), longitude: evt.lngLat.lng.toFixed(6) }))}
              onLoad={() => {
                const p = posRef.current;
                if (p) mapRef.current?.jumpTo({ center: [p[1], p[0]], zoom: 16 });
              }}
            >
              {previewGeoJson && (
                <Source id="crane-preview" type="geojson" data={previewGeoJson}>
                  <Layer id="crane-preview-jib" type="line" filter={["==", ["get", "kind"], "jib"]}
                    paint={{ "line-color": "#f97316", "line-width": 3 }} />
                  <Layer id="crane-preview-counter" type="line" filter={["==", ["get", "kind"], "counter"]}
                    paint={{ "line-color": "#6b7280", "line-width": 3 }} />
                  <Layer id="crane-preview-sweep" type="line" filter={["==", ["get", "kind"], "sweep"]}
                    paint={{ "line-color": "#f97316", "line-width": 1.5, "line-dasharray": [4, 3] }} />
                </Source>
              )}
              {hasPos && (
                <Marker latitude={lat} longitude={lon}>
                  <div className="h-3 w-3 rounded-full border-2 border-white bg-[#f97316] shadow" />
                </Marker>
              )}
            </MapGL>
          </div>
        </div>
      </div>
    </Modal>
  );
}
