/** MapLibre image source + raster layer for plan overlay images */
import type maplibregl from "maplibre-gl";
import type { PlanImageBounds } from "../types";

/** Convert internal [lat, lon] to MapLibre [lon, lat] */
function toCoord(latLon: [number, number]): [number, number] {
  return [latLon[1], latLon[0]];
}

/** Add a plan image overlay to the map */
export function addPlanOverlay(
  map: maplibregl.Map,
  groupId: number,
  imageDataUrl: string,
  bounds: PlanImageBounds,
  opacity: number,
) {
  const sourceId = `plan-image-${groupId}`;
  const layerId = `plan-raster-${groupId}`;

  // Remove existing if any
  if (map.getLayer(layerId)) map.removeLayer(layerId);
  if (map.getSource(sourceId)) map.removeSource(sourceId);

  // MapLibre image source expects coordinates in order: topLeft, topRight, bottomRight, bottomLeft
  // Each as [longitude, latitude]
  map.addSource(sourceId, {
    type: "image",
    url: imageDataUrl,
    coordinates: [
      toCoord(bounds.topLeft),
      toCoord(bounds.topRight),
      toCoord(bounds.bottomRight),
      toCoord(bounds.bottomLeft),
    ],
  });

  // Insert below first symbol layer (or at end)
  let beforeId: string | undefined;
  for (const layer of map.getStyle().layers) {
    if (layer.type === "symbol") {
      beforeId = layer.id;
      break;
    }
  }

  map.addLayer(
    {
      id: layerId,
      type: "raster",
      source: sourceId,
      paint: {
        "raster-opacity": opacity,
        "raster-fade-duration": 0,
      },
    },
    beforeId,
  );
}

/** Remove a plan image overlay from the map */
export function removePlanOverlay(map: maplibregl.Map, groupId: number) {
  const sourceId = `plan-image-${groupId}`;
  const layerId = `plan-raster-${groupId}`;
  if (map.getLayer(layerId)) map.removeLayer(layerId);
  if (map.getSource(sourceId)) map.removeSource(sourceId);
}

/** Update opacity of an existing plan overlay */
export function updatePlanOpacity(map: maplibregl.Map, groupId: number, opacity: number) {
  const layerId = `plan-raster-${groupId}`;
  if (map.getLayer(layerId)) {
    map.setPaintProperty(layerId, "raster-opacity", opacity);
  }
}

/** Update the coordinates (bounds) of an existing plan image overlay */
export function updatePlanBounds(map: maplibregl.Map, groupId: number, bounds: PlanImageBounds) {
  const sourceId = `plan-image-${groupId}`;
  const source = map.getSource(sourceId) as maplibregl.ImageSource | undefined;
  if (source) {
    source.setCoordinates([
      toCoord(bounds.topLeft),
      toCoord(bounds.topRight),
      toCoord(bounds.bottomRight),
      toCoord(bounds.bottomLeft),
    ]);
  }
}
