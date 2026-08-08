import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { Marker } from "react-map-gl/maplibre";
import { Search, Loader2, X, MapPin } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import Fuse from "fuse.js";
import type { ManualBuilding } from "../../types/building";

interface AddressResult {
  display_name: string;
  jibun_addr?: string;
  /** "juso" | "jibun" | "place" (VWorld) | "manual" (수동 등록 건물) */
  resultType?: string;
  lat: number;
  lon: number;
}

interface Props {
  onSelect: (lat: number, lon: number, label: string) => void;
  /** 좌측 오프셋(px) — 좌측 도구 드로어 열림 시 드로어 폭만큼 밀어내 가림 방지 (기본 8) */
  offsetLeft?: number;
  /** true 면 수동 등록 건물도 통합 검색 + 빈 쿼리 focus 시 전체 목록 표시 (기본 false) */
  withManualBuildings?: boolean;
}

/** 수동 등록 건물 → 결과 행. 보조줄에 높이/지반고(+메모) 요약 */
function manualToResult(b: ManualBuilding): AddressResult {
  return {
    display_name: b.name,
    jibun_addr: `높이 ${b.height}m · 지반 ${b.ground_elev}m${b.memo ? ` · ${b.memo}` : ""}`,
    resultType: "manual",
    lat: b.latitude,
    lon: b.longitude,
  };
}

/** 주소 마커 (MapGL 내부에 렌더링).
 *  zIndex 3 — deck MapboxOverlay(overlaid) 캔버스는 maplibre 컨트롤 코너(.maplibregl-ctrl-*, z-index:2)에
 *  부착되어 HTML 마커(z-index auto)를 덮는다. 캔버스 컨테이너는 스태킹 컨텍스트가 아니므로 마커에
 *  z-index 3 을 주면 실측 3D 메시·LoS 커튼 등 deck 3D 표출 위에 아이콘/툴팁이 항상 보인다. */
export function AddressMarker({ marker, onClose }: { marker: { lat: number; lon: number; label: string }; onClose: () => void }) {
  return (
    <Marker longitude={marker.lon} latitude={marker.lat} anchor="bottom" style={{ zIndex: 3 }}>
      <div className="flex flex-col items-center">
        <div className="relative mb-1 max-w-[200px] rounded-md bg-white/95 px-2 py-1 text-[10px] leading-tight text-gray-700 shadow-lg backdrop-blur-sm border border-gray-200">
          <div className="line-clamp-2">{marker.label}</div>
          <button
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-gray-500 text-white shadow hover:bg-gray-700 transition-colors"
          >
            <X size={8} />
          </button>
          <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 h-2 w-2 rotate-45 bg-white/95 border-b border-r border-gray-200" />
        </div>
        <MapPin size={24} className="text-[#a60739] drop-shadow-md" fill="#a60739" strokeWidth={1} stroke="#fff" />
      </div>
    </Marker>
  );
}

/** 주소 검색 오버레이 (맵 위에 absolute 배치) */
export default function AddressSearch({ onSelect, offsetLeft = 8, withManualBuildings = false }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AddressResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [manualList, setManualList] = useState<ManualBuilding[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 등록 건물 목록 — focus 시마다 재조회 (자료관리 추가/수정 즉시 반영, 작은 테이블이라 비용 무시)
  const loadManual = useCallback(async () => {
    try {
      const list = await invoke<ManualBuilding[]>("list_manual_buildings");
      setManualList([...list].sort((a, b) => a.name.localeCompare(b.name, "ko")));
    } catch {
      setManualList([]);
    }
  }, []);

  const search = useCallback(async (q: string) => {
    const query = q.trim();
    if (!query) { setResults([]); return; }
    setSearching(true);
    try {
      // VWorld는 prefix 기반이라 후보를 넉넉히(20) 받아 fuse.js로 재정렬
      const res = await invoke<{ address: string; building_name: string; zip_code: string; latitude: number; longitude: number; result_type: string }[]>(
        "search_vworld_address", { query, limit: 20 },
      );
      const mapped: AddressResult[] = res.map((r) => ({
        display_name: r.result_type === "place" && r.building_name ? r.building_name : r.address,
        jibun_addr: r.result_type === "place" ? r.address : (r.building_name || ""),
        resultType: r.result_type,
        lat: r.latitude,
        lon: r.longitude,
      }));

      // 한글 오타/부분 일치 허용 fuzzy 재정렬. display_name에 가중치, 보조로 jibun_addr.
      // threshold 0.4: 너무 관대하면 noise, 너무 빡빡하면 오타 보정 실패. 한글 2~3글자 기준 경험값.
      const fuse = new Fuse(mapped, {
        keys: [
          { name: "display_name", weight: 0.7 },
          { name: "jibun_addr", weight: 0.3 },
        ],
        threshold: 0.4,
        ignoreLocation: true,
        includeScore: true,
        minMatchCharLength: 1,
      });
      const ranked = fuse.search(query);
      // fuse 매칭이 있으면 그 순서대로, 없으면 VWorld 원순서 유지 (완전 미스보다 prefix 결과가 나음)
      const final = ranked.length > 0 ? ranked.map((x) => x.item) : mapped;
      setResults(final.slice(0, 8));
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  const handleInput = useCallback((value: string) => {
    setQuery(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => search(value), 400);
  }, [search]);

  // 수동건물 매칭 — 로컬 데이터라 디바운스 없이 매 키스트로크 재계산 (fuse 옵션은 VWorld 재정렬과 동일 계열)
  const manualMatches = useMemo(() => {
    const q = query.trim();
    if (!withManualBuildings || !q || manualList.length === 0) return [];
    const fuse = new Fuse(manualList, {
      keys: [
        { name: "name", weight: 0.7 },
        { name: "memo", weight: 0.3 },
      ],
      threshold: 0.4,
      ignoreLocation: true,
      minMatchCharLength: 1,
    });
    return fuse.search(q).map((x) => manualToResult(x.item));
  }, [withManualBuildings, query, manualList]);

  // 드롭다운 표시 목록 — 쿼리 있으면 [수동 매치 전부 + VWorld 8건], 비어 있으면 등록 건물 전체(가나다순)
  const shown = useMemo<AddressResult[]>(() => {
    if (query.trim()) return [...manualMatches, ...results];
    return withManualBuildings ? manualList.map(manualToResult) : [];
  }, [query, manualMatches, results, withManualBuildings, manualList]);

  const select = useCallback((r: AddressResult) => {
    if (r.lat !== 0 && r.lon !== 0) {
      onSelect(r.lat, r.lon, r.display_name);
    }
    setResults([]);
    setOpen(false);
  }, [onSelect]);

  // 외부 클릭 닫기
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} data-tour="tm-address-search" className="absolute top-2 z-[800]" style={{ width: 280, left: offsetLeft, transition: "left .4s cubic-bezier(.4,0,.2,1)" }}>
      <div className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white/95 px-2.5 py-1.5 shadow-lg backdrop-blur-sm">
        <Search size={14} className="shrink-0 text-gray-400" />
        <input
          type="text"
          value={query}
          onChange={(e) => { handleInput(e.target.value); setOpen(true); }}
          // 등록건물 모드는 첫 클릭(쿼리 비어 있어도) 만으로 전체 목록 드롭다운 — focus 때마다 재조회
          onFocus={() => { if (withManualBuildings) { loadManual(); setOpen(true); } else if (results.length > 0) setOpen(true); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); search(query); setOpen(true); }
            if (e.key === "Escape") setOpen(false);
          }}
          placeholder="주소/지번/건물명 검색..."
          className="flex-1 bg-transparent text-xs text-gray-700 outline-none placeholder:text-gray-400"
        />
        {searching && <Loader2 size={12} className="animate-spin text-gray-400" />}
        {query && !searching && (
          <button onClick={() => { setQuery(""); setResults([]); setOpen(false); onSelect(0, 0, ""); }} className="text-gray-400 hover:text-gray-600">
            <X size={12} />
          </button>
        )}
      </div>
      {open && shown.length > 0 && (
        <div data-tour="tm-address-results" className="mt-1 max-h-[min(70vh,720px)] overflow-y-auto rounded-lg border border-gray-200 bg-white/95 shadow-lg backdrop-blur-sm">
          {shown.map((r, i) => (
            <button
              key={i}
              onClick={() => select(r)}
              className="flex w-full items-start gap-2 px-2.5 py-2 text-left text-xs text-gray-700 hover:bg-gray-50 transition-colors"
            >
              <MapPin size={12} className="mt-0.5 shrink-0 text-[#a60739]" />
              <div className="min-w-0">
                <div className="line-clamp-2">
                  {r.display_name}
                  {r.resultType === "jibun" && <span className="ml-1 rounded bg-gray-100 px-1 py-px text-[9px] text-gray-500 align-middle">지번</span>}
                  {r.resultType === "manual" && <span className="ml-1 rounded bg-purple-50 px-1 py-px text-[9px] text-purple-600 align-middle">등록</span>}
                </div>
                {r.jibun_addr && <div className="text-[10px] text-gray-400 mt-0.5 line-clamp-1">{r.jibun_addr}</div>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
