import { Fragment } from "react";
import { Polyline, CircleMarker, Popup } from "react-leaflet";
import { format } from "date-fns";
import type { LossSegment } from "../../types";

interface LossMarkersProps {
  segments: LossSegment[];
  maxTimestamp?: number;
}

export default function LossMarkers({ segments, maxTimestamp }: LossMarkersProps) {
  const filtered = maxTimestamp
    ? segments.filter((s) => s.start_time <= maxTimestamp)
    : segments;

  return (
    <>
      {filtered.map((seg, idx) => {
        const positions: [number, number][] = [
          [seg.start_lat, seg.start_lon],
          [seg.end_lat, seg.end_lon],
        ];

        return (
          <Fragment key={`loss-${idx}`}>
            <Polyline
              positions={positions}
              pathOptions={{
                color: "#e94560",
                weight: 3,
                opacity: 0.9,
                dashArray: "8, 6",
              }}
            />
            <CircleMarker
              center={[seg.start_lat, seg.start_lon]}
              radius={6}
              pathOptions={{
                color: "#e94560",
                fillColor: "#e94560",
                fillOpacity: 0.9,
                weight: 2,
              }}
            >
              <Popup>
                <div className="text-xs leading-relaxed">
                  <div className="font-bold text-red-600">
                    Loss 시작 #{idx + 1}
                  </div>
                  <div>
                    시각: {format(new Date(seg.start_time * 1000), "HH:mm:ss")}
                  </div>
                  <div>지속시간: {seg.duration_secs.toFixed(1)}초</div>
                  <div>거리: {seg.distance_km.toFixed(2)}km</div>
                  <div>고도: {seg.last_altitude.toFixed(0)}m</div>
                </div>
              </Popup>
            </CircleMarker>
            <CircleMarker
              center={[seg.end_lat, seg.end_lon]}
              radius={5}
              pathOptions={{
                color: "#ff8a80",
                fillColor: "#ff8a80",
                fillOpacity: 0.8,
                weight: 2,
              }}
            >
              <Popup>
                <div className="text-xs leading-relaxed">
                  <div className="font-bold text-red-500">
                    Loss 종료 #{idx + 1}
                  </div>
                  <div>
                    시각: {format(new Date(seg.end_time * 1000), "HH:mm:ss")}
                  </div>
                </div>
              </Popup>
            </CircleMarker>
          </Fragment>
        );
      })}
    </>
  );
}
