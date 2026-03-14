import { useMemo } from "react";
import { Polyline, CircleMarker, Popup } from "react-leaflet";
import { format } from "date-fns";
import type { TrackPoint } from "../../types";

/** 트랙 색상 팔레트 (Mode-S별 구분) */
const TRACK_COLORS = [
  "#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899",
  "#06b6d4", "#84cc16", "#f97316", "#6366f1", "#14b8a6",
];

interface TrackLayerProps {
  points: TrackPoint[];
  maxTimestamp?: number;
}

/** 대용량 포인트를 Mode-S별 트랙으로 그룹화하고 다운샘플링 */
function groupAndSample(
  points: TrackPoint[],
  maxTimestamp?: number
): Map<string, TrackPoint[]> {
  const groups = new Map<string, TrackPoint[]>();

  for (const p of points) {
    if (maxTimestamp !== undefined && p.timestamp > maxTimestamp) continue;
    let arr = groups.get(p.mode_s);
    if (!arr) {
      arr = [];
      groups.set(p.mode_s, arr);
    }
    arr.push(p);
  }

  // Downsample large tracks: keep at most ~2000 points per track for rendering
  const MAX_POINTS_PER_TRACK = 2000;
  const result = new Map<string, TrackPoint[]>();

  for (const [key, pts] of groups) {
    if (pts.length <= MAX_POINTS_PER_TRACK) {
      result.set(key, pts);
    } else {
      const step = Math.ceil(pts.length / MAX_POINTS_PER_TRACK);
      const sampled: TrackPoint[] = [];
      for (let i = 0; i < pts.length; i += step) {
        sampled.push(pts[i]);
      }
      // Always include last point
      if (sampled[sampled.length - 1] !== pts[pts.length - 1]) {
        sampled.push(pts[pts.length - 1]);
      }
      result.set(key, sampled);
    }
  }

  return result;
}

export default function TrackLayer({ points, maxTimestamp }: TrackLayerProps) {
  const grouped = useMemo(
    () => groupAndSample(points, maxTimestamp),
    [points, maxTimestamp]
  );

  if (grouped.size === 0) return null;

  const entries = Array.from(grouped.entries());

  return (
    <>
      {entries.map(([modeS, pts], trackIdx) => {
        if (pts.length < 2) return null;
        const color = TRACK_COLORS[trackIdx % TRACK_COLORS.length];
        const positions = pts.map(
          (p) => [p.latitude, p.longitude] as [number, number]
        );

        // Show markers at wider intervals for large datasets
        const markerStep = Math.max(1, Math.floor(pts.length / 50));

        return (
          <span key={`track-${modeS}-${trackIdx}`} style={{ display: "contents" }}>
            <Polyline
              positions={positions}
              pathOptions={{
                color,
                weight: 2.5,
                opacity: 0.8,
              }}
            />
            {pts
              .filter((_, i) => i % markerStep === 0 || i === pts.length - 1)
              .map((p, idx) => (
                <CircleMarker
                  key={`tp-${trackIdx}-${idx}`}
                  center={[p.latitude, p.longitude]}
                  radius={3}
                  pathOptions={{
                    color,
                    fillColor: color,
                    fillOpacity: 0.8,
                    weight: 1,
                  }}
                >
                  <Popup>
                    <div className="text-xs leading-relaxed">
                      <div className="font-bold text-gray-800">
                        {format(new Date(p.timestamp * 1000), "MM-dd HH:mm:ss")}
                      </div>
                      <div>Mode-S: {p.mode_s}</div>
                      <div>고도: {p.altitude.toFixed(0)}m</div>
                      <div>속도: {p.speed.toFixed(1)}kts</div>
                      <div>방위: {p.heading.toFixed(1)}&deg;</div>
                      <div className="text-gray-500">
                        {p.latitude.toFixed(5)}, {p.longitude.toFixed(5)}
                      </div>
                    </div>
                  </Popup>
                </CircleMarker>
              ))}
          </span>
        );
      })}
    </>
  );
}
