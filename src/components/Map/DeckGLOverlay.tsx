import { useControl } from "react-map-gl/maplibre";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { MapboxOverlayProps } from "@deck.gl/mapbox";

/** deck.gl overlay for react-map-gl (MapLibre) - GPU 가속 레이어 */
export function DeckGLOverlay({ onOverlay, ...props }: MapboxOverlayProps & {
  /** MapboxOverlay 인스턴스 콜백 — 클릭 시점 pickObject(메시 GPU 픽) 용 */
  onOverlay?: (overlay: MapboxOverlay) => void;
}) {
  const overlay = useControl(() => new MapboxOverlay(props));
  overlay.setProps(props);
  onOverlay?.(overlay);
  return null;
}
