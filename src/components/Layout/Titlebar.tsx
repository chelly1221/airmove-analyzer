import { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X, Copy, Settings } from "lucide-react";
import { useAppStore } from "../../store";

const appWindow = getCurrentWindow();

export default function Titlebar({ title, controlsOnly, children }: { title?: string; controlsOnly?: boolean; children?: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const setActivePage = useAppStore((s) => s.setActivePage);
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

  if (controlsOnly) {
    return (
      <div data-tauri-drag-region className="flex h-8 shrink-0 select-none items-center border-b border-gray-200 bg-white">
        {children ? (
          <div className="flex flex-1 items-center gap-3 px-4">{children}</div>
        ) : (
          <div data-tauri-drag-region className="flex-1" />
        )}
        <button onClick={() => appWindow.minimize()} className="flex h-full w-11 items-center justify-center text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors" aria-label="Minimize"><Minus size={14} /></button>
        <button onClick={() => appWindow.toggleMaximize()} className="flex h-full w-11 items-center justify-center text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors" aria-label="Maximize">{maximized ? <Copy size={12} /> : <Square size={12} />}</button>
        <button onClick={() => appWindow.close()} className="flex h-full w-11 items-center justify-center text-gray-400 hover:bg-[#e81123] hover:text-white transition-colors" aria-label="Close"><X size={14} /></button>
      </div>
    );
  }

  return (
    <div className="flex h-8 shrink-0 select-none items-center bg-white">
      {/* Drag region */}
      <div
        data-tauri-drag-region
        className="flex-1 h-full flex items-center pl-4"
      >
        {title && (
          <span className="text-sm font-bold tracking-wide text-[#a60739] pointer-events-none">
            {title}
          </span>
        )}
      </div>

      {/* Settings button */}
      <button
        onClick={() => { setActivePage("settings"); navigate("/settings"); }}
        className={`flex h-full w-10 items-center justify-center transition-colors ${
          location.pathname === "/settings"
            ? "text-[#a60739]"
            : "text-gray-300 hover:text-gray-500"
        }`}
        title="설정"
      >
        <Settings size={14} />
      </button>

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
