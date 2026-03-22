/**
 * 개발자모드 우클릭 소스 위치 오버레이
 * UI 요소 우클릭 시 해당 요소의 소스 파일:줄번호를 툴팁으로 표시 + 클립보드 복사
 */
import { useEffect, useState, useCallback } from "react";
import { useAppStore } from "../store";

export default function SourceOverlay() {
  const devMode = useAppStore((s) => s.devMode);
  const [info, setInfo] = useState<{
    text: string;
    x: number;
    y: number;
  } | null>(null);

  const handleContextMenu = useCallback(
    (e: MouseEvent) => {
      if (!devMode) return;

      const target = e.target as HTMLElement;
      // 맵 캔버스(deck.gl/MapLibre) 영역은 스킵
      if (target.tagName === "CANVAS") return;

      // 클릭된 요소에서 상위로 탐색하여 data-source 찾기
      let el: HTMLElement | null = target;
      while (el) {
        const src = el.getAttribute("data-source");
        if (src) {
          e.preventDefault();
          e.stopPropagation();
          navigator.clipboard.writeText(src).catch(() => {});
          setInfo({ text: src, x: e.clientX, y: e.clientY });
          return;
        }
        el = el.parentElement;
      }
    },
    [devMode],
  );

  useEffect(() => {
    document.addEventListener("contextmenu", handleContextMenu, true);
    return () =>
      document.removeEventListener("contextmenu", handleContextMenu, true);
  }, [handleContextMenu]);

  // 2초 후 자동 소멸
  useEffect(() => {
    if (!info) return;
    const timer = setTimeout(() => setInfo(null), 2000);
    return () => clearTimeout(timer);
  }, [info]);

  // 클릭 시 즉시 소멸
  useEffect(() => {
    if (!info) return;
    const dismiss = () => setInfo(null);
    document.addEventListener("click", dismiss, { once: true });
    return () => document.removeEventListener("click", dismiss);
  }, [info]);

  if (!info) return null;

  return (
    <div
      style={{
        position: "fixed",
        left: info.x + 8,
        top: info.y - 30,
        zIndex: 99999,
        background: "#1e1e2e",
        color: "#cdd6f4",
        border: "1px solid #585b70",
        borderRadius: 6,
        padding: "4px 10px",
        fontSize: 12,
        fontFamily: "monospace",
        pointerEvents: "none",
        whiteSpace: "nowrap",
        boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
      }}
    >
      {info.text}
      <span style={{ color: "#6c7086", marginLeft: 8 }}>copied</span>
    </div>
  );
}
