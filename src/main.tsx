import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./index.css";
import { useAppStore } from "./store";

// 윈도우 라벨 기반 루트 컴포넌트 선택
const windowLabel = getCurrentWindow().label;
const App = lazy(() => import("./App"));
const TrackMapApp = lazy(() => import("./apps/TrackMapApp"));
const DrawingApp = lazy(() => import("./apps/DrawingApp"));

// 프론트엔드 크래시 시 오류 다이얼로그 (개발자 모드 전용)
function showErrorDialog(title: string, detail: string) {
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;font-family:sans-serif";

  const box = document.createElement("div");
  box.style.cssText =
    "background:#1e1e2e;color:#e0e0e0;border:1px solid #e94560;border-radius:8px;padding:24px;max-width:600px;width:90%;max-height:80vh;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,0.5)";

  // innerHTML 대신 DOM API로 안전하게 생성 (XSS 방지)
  const header = document.createElement("div");
  header.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:16px";
  const icon = document.createElement("span");
  icon.style.cssText = "color:#e94560;font-size:24px";
  icon.textContent = "\u26A0";
  const h2 = document.createElement("h2");
  h2.style.cssText = "margin:0;font-size:16px;color:#e94560";
  h2.textContent = title;
  header.appendChild(icon);
  header.appendChild(h2);

  const pre = document.createElement("pre");
  pre.style.cssText = "background:#141422;padding:12px;border-radius:4px;font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:300px;overflow:auto;color:#ccc;margin:0 0 16px";
  pre.textContent = detail;

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:8px;justify-content:flex-end";
  const copyBtn = document.createElement("button");
  copyBtn.style.cssText = "padding:6px 16px;border:1px solid #555;border-radius:4px;background:#2a2a3e;color:#ccc;cursor:pointer";
  copyBtn.textContent = "복사";
  const closeBtn = document.createElement("button");
  closeBtn.style.cssText = "padding:6px 16px;border:none;border-radius:4px;background:#e94560;color:#fff;cursor:pointer";
  closeBtn.textContent = "닫기";
  btnRow.appendChild(copyBtn);
  btnRow.appendChild(closeBtn);

  box.appendChild(header);
  box.appendChild(pre);
  box.appendChild(btnRow);

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  closeBtn.addEventListener("click", () => overlay.remove());
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(detail);
    copyBtn.textContent = "복사됨!";
  });
}

const onError = (e: ErrorEvent) => {
  const detail = `${e.message}\n\n파일: ${e.filename || "알 수 없음"}:${e.lineno}:${e.colno}\n\n${e.error?.stack || ""}`;
  showErrorDialog("예기치 않은 오류가 발생했습니다", detail);
};

const onUnhandledRejection = (e: PromiseRejectionEvent) => {
  const reason = e.reason;
  const detail =
    reason instanceof Error
      ? `${reason.message}\n\n${reason.stack || ""}`
      : String(reason);
  showErrorDialog("처리되지 않은 비동기 오류", detail);
};

// devMode 변경 시 핸들러 등록/해제
let prevDevMode = useAppStore.getState().devMode;
if (prevDevMode) {
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
}
useAppStore.subscribe((state) => {
  if (state.devMode !== prevDevMode) {
    prevDevMode = state.devMode;
    if (state.devMode) {
      window.addEventListener("error", onError);
      window.addEventListener("unhandledrejection", onUnhandledRejection);
    } else {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    }
  }
});

function RootApp() {
  // main 창: 기존 앱 (업로드+분석+보고서+설정+항공기관리, 지도는 offscreen 유지)
  // trackmap 창: 지도 전용 (자체 업로드+지도)
  // drawing 창: 도면 전용 (자체 업로드+도면)
  if (windowLabel === "trackmap") return <TrackMapApp />;
  if (windowLabel === "drawing") return <DrawingApp />;
  return <App />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <Suspense fallback={<div className="flex h-screen items-center justify-center text-gray-400">로딩 중...</div>}>
        <RootApp />
      </Suspense>
    </BrowserRouter>
  </React.StrictMode>
);
