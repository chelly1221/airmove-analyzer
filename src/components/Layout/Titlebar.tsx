import { useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X, Copy } from "lucide-react";

const appWindow = getCurrentWindow();

export default function Titlebar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const unlisten = appWindow.onResized(async () => {
      setMaximized(await appWindow.isMaximized());
    });
    appWindow.isMaximized().then(setMaximized);
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div className="flex h-8 shrink-0 select-none items-center bg-white">
      {/* Drag region + title */}
      <div
        data-tauri-drag-region
        className="flex-1 h-full flex items-center pl-4"
      >
        <span className="text-xs font-bold tracking-wide text-[#a60739] pointer-events-none">
          김포공항 레이더송신소 비행검사기 항적 분석 시스템
        </span>
      </div>

      {/* Window controls */}
      <div className="flex h-full">
        <button
          onClick={() => appWindow.minimize()}
          className="flex h-full w-11 items-center justify-center text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          aria-label="Minimize"
        >
          <Minus size={14} />
        </button>
        <button
          onClick={() => appWindow.toggleMaximize()}
          className="flex h-full w-11 items-center justify-center text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          aria-label="Maximize"
        >
          {maximized ? <Copy size={12} /> : <Square size={12} />}
        </button>
        <button
          onClick={() => appWindow.close()}
          className="flex h-full w-11 items-center justify-center text-gray-400 hover:bg-[#e81123] hover:text-white transition-colors"
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
