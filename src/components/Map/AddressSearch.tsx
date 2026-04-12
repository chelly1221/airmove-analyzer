import { useState, useCallback, useRef, useEffect } from "react";
import { Marker } from "react-map-gl/maplibre";
import { Search, Loader2, X, MapPin } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

interface AddressResult {
  display_name: string;
  jibun_addr?: string;
  lat: number;
  lon: number;
}

interface Props {
  onSelect: (lat: number, lon: number, label: string) => void;
}

/** 주소 마커 (MapGL 내부에 렌더링) */
export function AddressMarker({ marker, onClose }: { marker: { lat: number; lon: number; label: string }; onClose: () => void }) {
  return (
    <Marker longitude={marker.lon} latitude={marker.lat} anchor="bottom">
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
export default function AddressSearch({ onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AddressResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); return; }
    setSearching(true);
    try {
      const res = await invoke<{ address: string; building_name: string; zip_code: string; latitude: number; longitude: number; result_type: string }[]>(
        "search_vworld_address", { query: q, limit: 8 },
      );
      setResults(res.map((r) => ({
        display_name: r.result_type === "place" && r.building_name ? r.building_name : r.address,
        jibun_addr: r.result_type === "place" ? r.address : (r.building_name || ""),
        lat: r.latitude,
        lon: r.longitude,
      })));
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
    <div ref={ref} className="absolute top-2 left-2 z-[800]" style={{ width: 280 }}>
      <div className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white/95 px-2.5 py-1.5 shadow-lg backdrop-blur-sm">
        <Search size={14} className="shrink-0 text-gray-400" />
        <input
          type="text"
          value={query}
          onChange={(e) => { handleInput(e.target.value); setOpen(true); }}
          onFocus={() => { if (results.length > 0) setOpen(true); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); search(query); setOpen(true); }
            if (e.key === "Escape") setOpen(false);
          }}
          placeholder="주소/건물명 검색..."
          className="flex-1 bg-transparent text-xs text-gray-700 outline-none placeholder:text-gray-400"
        />
        {searching && <Loader2 size={12} className="animate-spin text-gray-400" />}
        {query && !searching && (
          <button onClick={() => { setQuery(""); setResults([]); setOpen(false); onSelect(0, 0, ""); }} className="text-gray-400 hover:text-gray-600">
            <X size={12} />
          </button>
        )}
      </div>
      {open && results.length > 0 && (
        <div className="mt-1 max-h-[200px] overflow-y-auto rounded-lg border border-gray-200 bg-white/95 shadow-lg backdrop-blur-sm">
          {results.map((r, i) => (
            <button
              key={i}
              onClick={() => select(r)}
              className="flex w-full items-start gap-2 px-2.5 py-2 text-left text-xs text-gray-700 hover:bg-gray-50 transition-colors"
            >
              <MapPin size={12} className="mt-0.5 shrink-0 text-[#a60739]" />
              <div className="min-w-0">
                <div className="line-clamp-2">{r.display_name}</div>
                {r.jibun_addr && <div className="text-[10px] text-gray-400 mt-0.5 line-clamp-1">{r.jibun_addr}</div>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
