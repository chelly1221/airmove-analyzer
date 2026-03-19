/**
 * 개발자 모드 오버레이 — GPU 사용 상태 + 메모리 사용량 표시
 * 각 주요 컴포넌트 영역에 GPU/CPU 뱃지와 메모리 사용량을 실시간 표시
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { useAppStore } from "../store";
import { isGPUAvailable, getGPUDevice } from "../utils/gpuCompute";

interface GPUDiag {
  webgl2: { available: boolean; renderer: string; vendor: string; unmasked: string };
  webgpu: { available: boolean; adapter: string };
  memory: { jsHeapMB: number; jsHeapLimitMB: number; jsHeapPct: number } | null;
}

/** WebGL2 진단 (1회 수행 후 캐시) */
function probeWebGL2(): GPUDiag["webgl2"] {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2", { powerPreference: "high-performance" });
    if (!gl) return { available: false, renderer: "N/A", vendor: "N/A", unmasked: "N/A" };
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    // 소프트웨어 렌더러 감지
    const isSW = /swiftshader|llvmpipe|software|mesa/i.test(renderer);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { available: true, renderer, vendor, unmasked: isSW ? "SW" : "HW" };
  } catch {
    return { available: false, renderer: "Error", vendor: "Error", unmasked: "N/A" };
  }
}

/** 메모리 사용량 (Chrome/Edge performance.memory) */
function getMemory(): GPUDiag["memory"] {
  const perf = performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number; totalJSHeapSize: number } };
  if (!perf.memory) return null;
  const used = perf.memory.usedJSHeapSize / (1024 * 1024);
  const limit = perf.memory.jsHeapSizeLimit / (1024 * 1024);
  return { jsHeapMB: Math.round(used), jsHeapLimitMB: Math.round(limit), jsHeapPct: Math.round((used / limit) * 100) };
}

/** 각 컴포넌트 영역 GPU 상태 정보 */
interface ComponentStatus {
  name: string;
  gpu: boolean;
  api: string; // WebGL2 / WebGPU / CPU
  detail: string;
  memoryMB?: number;
}

function getComponentStatuses(diag: GPUDiag, storeState: {
  rawTrackPoints: number;
  flights: number;
  losResults: number;
  coverageData: boolean;
  cloudGrid: boolean;
  weatherData: boolean;
}): ComponentStatus[] {
  const statuses: ComponentStatus[] = [];
  const isHW = diag.webgl2.unmasked === "HW";

  // 1. 항적 지도 (deck.gl + MapLibre)
  const trackPointsMB = (storeState.rawTrackPoints * 80) / (1024 * 1024); // ~80 bytes/point 추정
  statuses.push({
    name: "항적 지도 (deck.gl)",
    gpu: diag.webgl2.available && isHW,
    api: diag.webgl2.available ? `WebGL2 ${isHW ? "HW" : "SW"}` : "N/A",
    detail: `${diag.webgl2.renderer.slice(0, 40)}`,
    memoryMB: Math.round(trackPointsMB),
  });

  // 2. MapLibre GL
  statuses.push({
    name: "MapLibre GL",
    gpu: diag.webgl2.available && isHW,
    api: diag.webgl2.available ? `WebGL2 ${isHW ? "HW" : "SW"}` : "N/A",
    detail: "동심원, 지형, 커버리지, 구름",
  });

  // 3. LOS 단면도 (GPU2D — WebGL2 인스턴스 렌더링)
  statuses.push({
    name: "LOS 단면도 (GPU2D)",
    gpu: diag.webgl2.available && isHW,
    api: diag.webgl2.available ? `WebGL2 ${isHW ? "HW" : "SW"}` : "Canvas2D 폴백",
    detail: `LOS 결과 ${storeState.losResults}건`,
  });

  // 4. 도면 타임라인 (GPU2D)
  statuses.push({
    name: "도면 타임라인 (GPU2D)",
    gpu: diag.webgl2.available && isHW,
    api: diag.webgl2.available ? `WebGL2 ${isHW ? "HW" : "SW"}` : "Canvas2D 폴백",
    detail: "항적 포인트 렌더링",
  });

  // 5. 파노라마 계산 (WebGPU Compute)
  statuses.push({
    name: "파노라마 계산",
    gpu: diag.webgpu.available,
    api: diag.webgpu.available ? "WebGPU Compute" : "CPU 폴백 (Rust)",
    detail: diag.webgpu.available ? diag.webgpu.adapter : "GPU 미지원 → Rust IPC",
  });

  // 6. 커버리지 맵
  const coverageMB = storeState.coverageData ? 50 : 0; // 대략적 추정
  statuses.push({
    name: "커버리지 맵",
    gpu: diag.webgl2.available && isHW,
    api: "deck.gl PolygonLayer",
    detail: storeState.coverageData ? "계산 완료" : "미계산",
    memoryMB: coverageMB,
  });

  // 7. 기상/구름 그리드
  statuses.push({
    name: "기상/구름 오버레이",
    gpu: false,
    api: "MapLibre fill",
    detail: storeState.cloudGrid ? "로드됨" : "미로드",
  });

  // 8. PDF 보고서
  statuses.push({
    name: "PDF 렌더링",
    gpu: false,
    api: "html2canvas → CPU",
    detail: "html2canvas + jsPDF",
  });

  return statuses;
}

export default function DevOverlay() {
  const devMode = useAppStore((s) => s.devMode);
  const rawTrackPoints = useAppStore((s) => s.rawTrackPoints.length);
  const flights = useAppStore((s) => s.flights.length);
  const losResults = useAppStore((s) => s.losResults.length);
  const coverageData = useAppStore((s) => !!s.coverageData);
  const cloudGrid = useAppStore((s) => !!s.cloudGrid);
  const weatherData = useAppStore((s) => !!s.weatherData);

  const [diag, setDiag] = useState<GPUDiag | null>(null);
  const [memory, setMemory] = useState<GPUDiag["memory"]>(null);
  const [collapsed, setCollapsed] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);

  // 1회 GPU 진단
  useEffect(() => {
    if (!devMode) return;
    const webgl2 = probeWebGL2();

    // WebGPU 비동기 진단
    (async () => {
      let webgpu: GPUDiag["webgpu"] = { available: false, adapter: "N/A" };
      const avail = isGPUAvailable();
      if (avail === true) {
        webgpu = { available: true, adapter: "초기화 완료" };
      } else if (avail === null) {
        // 아직 초기화 안됨 → 시도
        const device = await getGPUDevice();
        webgpu = { available: !!device, adapter: device ? "초기화 완료" : "미지원" };
      }
      setDiag({ webgl2, webgpu, memory: getMemory() });
    })();
  }, [devMode]);

  // 메모리 주기 갱신
  useEffect(() => {
    if (!devMode) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    setMemory(getMemory());
    intervalRef.current = setInterval(() => setMemory(getMemory()), 2000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [devMode]);

  const toggleCollapse = useCallback(() => setCollapsed((v) => !v), []);

  if (!devMode || !diag) return null;

  const statuses = getComponentStatuses(diag, {
    rawTrackPoints, flights, losResults, coverageData, cloudGrid, weatherData,
  });

  const totalEstMB = statuses.reduce((sum, s) => sum + (s.memoryMB ?? 0), 0);

  return (
    <div
      className="fixed bottom-3 right-3 z-[9998] select-none"
      style={{ fontFamily: "monospace", fontSize: 11 }}
    >
      {/* 헤더 바 */}
      <div
        className="flex items-center gap-2 rounded-t-lg bg-gray-900/95 px-3 py-1.5 text-white cursor-pointer backdrop-blur-sm border border-gray-700 border-b-0"
        onClick={toggleCollapse}
      >
        <span className="text-[10px] font-bold tracking-wider text-amber-400">DEV</span>
        <span className="text-gray-400">|</span>
        <span className={`text-[10px] font-bold ${diag.webgl2.unmasked === "HW" ? "text-green-400" : "text-red-400"}`}>
          GPU {diag.webgl2.unmasked === "HW" ? "HW" : "SW"}
        </span>
        {memory && (
          <>
            <span className="text-gray-400">|</span>
            <span className={`text-[10px] ${memory.jsHeapPct > 80 ? "text-red-400" : memory.jsHeapPct > 50 ? "text-yellow-400" : "text-green-400"}`}>
              Heap {memory.jsHeapMB}MB / {memory.jsHeapLimitMB}MB ({memory.jsHeapPct}%)
            </span>
          </>
        )}
        <span className="ml-auto text-gray-500 text-[10px]">{collapsed ? "▲" : "▼"}</span>
      </div>

      {/* 상세 패널 */}
      {!collapsed && (
        <div className="rounded-b-lg bg-gray-900/95 px-3 pb-3 pt-1 text-white backdrop-blur-sm border border-gray-700 border-t-0 max-h-[60vh] overflow-auto" style={{ minWidth: 380 }}>
          {/* GPU 렌더러 정보 */}
          <div className="mb-2 text-[10px] text-gray-400 border-b border-gray-700 pb-1.5">
            <div>WebGL2: <span className="text-gray-300">{diag.webgl2.renderer}</span></div>
            <div>Vendor: <span className="text-gray-300">{diag.webgl2.vendor}</span></div>
            <div>WebGPU: <span className={diag.webgpu.available ? "text-green-400" : "text-red-400"}>
              {diag.webgpu.available ? "지원" : "미지원"}
            </span></div>
          </div>

          {/* 컴포넌트별 상태 */}
          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-gray-500 border-b border-gray-800">
                <th className="text-left py-0.5 font-normal">컴포넌트</th>
                <th className="text-center py-0.5 font-normal w-10">GPU</th>
                <th className="text-left py-0.5 font-normal">API</th>
                <th className="text-right py-0.5 font-normal w-14">메모리</th>
              </tr>
            </thead>
            <tbody>
              {statuses.map((s) => (
                <tr key={s.name} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                  <td className="py-1 text-gray-300 pr-2" title={s.detail}>{s.name}</td>
                  <td className="py-1 text-center">
                    <span className={`inline-block w-2 h-2 rounded-full ${s.gpu ? "bg-green-400" : "bg-red-400"}`} />
                  </td>
                  <td className="py-1 text-gray-400">{s.api}</td>
                  <td className="py-1 text-right text-gray-400">
                    {s.memoryMB != null && s.memoryMB > 0 ? `~${s.memoryMB}MB` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* 데이터 요약 */}
          <div className="mt-2 border-t border-gray-700 pt-1.5 text-[10px] text-gray-400 flex flex-wrap gap-x-4 gap-y-0.5">
            <span>포인트: <span className="text-gray-300">{rawTrackPoints.toLocaleString()}</span></span>
            <span>비행: <span className="text-gray-300">{flights}</span></span>
            <span>LOS: <span className="text-gray-300">{losResults}</span></span>
            {totalEstMB > 0 && (
              <span>추정 데이터: <span className="text-gray-300">~{totalEstMB}MB</span></span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
