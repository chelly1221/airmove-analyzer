import { useState } from "react";
import { Layers } from "lucide-react";

export type MapStyle = "osm" | "carto-dark";

interface MapStyleToggleProps {
  style: MapStyle;
  onChange: (style: MapStyle) => void;
}

export const MAP_TILE_URLS: Record<MapStyle, { url: string; attribution: string }> = {
  osm: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  },
  "carto-dark": {
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
  },
};

export default function MapStyleToggle({ style, onChange }: MapStyleToggleProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="leaflet-top leaflet-right" style={{ position: "absolute", top: 10, right: 10, zIndex: 1000 }}>
      <div className="relative">
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white/95 px-3 py-2 text-sm text-gray-800 shadow-lg backdrop-blur hover:bg-white transition-colors"
          title="지도 스타일 변경"
        >
          <Layers size={16} />
          <span>{style === "osm" ? "표준" : "다크"}</span>
        </button>
        {open && (
          <div className="absolute right-0 top-full mt-1 w-36 overflow-hidden rounded-lg border border-gray-300 bg-white/95 shadow-xl backdrop-blur">
            <button
              onClick={() => { onChange("osm"); setOpen(false); }}
              className={`flex w-full items-center px-3 py-2 text-sm transition-colors ${style === "osm" ? "bg-[#a60739]/20 text-[#a60739]" : "text-gray-600 hover:bg-gray-100"}`}
            >
              OSM 표준
            </button>
            <button
              onClick={() => { onChange("carto-dark"); setOpen(false); }}
              className={`flex w-full items-center px-3 py-2 text-sm transition-colors ${style === "carto-dark" ? "bg-[#a60739]/20 text-[#a60739]" : "text-gray-600 hover:bg-gray-100"}`}
            >
              Carto 다크
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
