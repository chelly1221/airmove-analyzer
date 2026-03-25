/**
 * 개발자모드 우클릭 소스 위치 오버레이
 * UI 요소 우클릭 시 해당 요소의 소스 파일:줄번호를 툴팁으로 표시 + 클립보드 복사
 */
import { useEffect, useState, useCallback, useRef } from "react";
import { useAppStore } from "../store";

export default function SourceOverlay() {
  const devMode = useAppStore((s) => s.devMode);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [info, setInfo] = useState<{
    text: string;
    x: number;
    y: number;
  } | null>(null);

  const handleContextMenu = useCallback(
    (e: MouseEvent) => {
      if (!devMode) return;

      const target = e.target as HTMLElement;

      // 클릭된 요소에서 상위로 탐색하여 data-source 찾기
      let el: HTMLElement | null = target;
      let src: string | null = null;
      while (el) {
        const attr = el.getAttribute("data-source");
        if (attr) {
          src = attr;
          break;
        }
        el = el.parentElement;
      }

      // data-source 없으면 요소 정보로 폴백
      if (!src) {
        const tag = target.tagName.toLowerCase();
        const id = target.id ? `#${target.id}` : "";
        const cls = target.className && typeof target.className === "string"
          ? "." + target.className.trim().split(/\s+/).slice(0, 3).join(".")
          : "";
        src = `<${tag}${id}${cls}> (no source)`;
      }

      e.preventDefault();
      e.stopPropagation();
      if (!src.endsWith("(no source)")) {
        navigator.clipboard.writeText(src).catch(() => {});
      }
      setInfo({ text: src, x: e.clientX, y: e.clientY });
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

  // 렌더 후 뷰포트 오버플로우 보정
  useEffect(() => {
    if (!info || !tooltipRef.current) return;
    const el = tooltipRef.current;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 우측 오버플로우 → 클릭 왼쪽에 표시
    if (rect.right > vw - 8) {
      el.style.left = `${info.x - rect.width - 8}px`;
    }
    // 상단 오버플로우
    if (rect.top < 8) {
      el.style.top = `${info.y + 8}px`;
    }
    // 하단 오버플로우
    if (rect.bottom > vh - 8) {
      el.style.top = `${vh - rect.height - 8}px`;
    }
  }, [info]);

  if (!info) return null;

  const noSource = info.text.endsWith("(no source)");

  return (
    <div
      ref={tooltipRef}
      style={{
        position: "fixed",
        left: info.x + 8,
        top: info.y - 30,
        zIndex: 99999,
        background: "#1e1e2e",
        color: noSource ? "#a6adc8" : "#cdd6f4",
        border: `1px solid ${noSource ? "#45475a" : "#585b70"}`,
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
      {!noSource && (
        <span style={{ color: "#6c7086", marginLeft: 8 }}>copied</span>
      )}
    </div>
  );
}
