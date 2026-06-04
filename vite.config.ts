import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import babelPluginSourceAttrs from "./src/dev/babelPluginSourceAttrs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [babelPluginSourceAttrs],
      },
    }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // 무거운 vendor 라이브러리를 별도 청크로 분리 — 500 kB 청크 경고 해소 +
    // 보고서 창/지도 창 등 페이지 진입 시 필요 없는 vendor 로딩 회피.
    chunkSizeWarningLimit: 1200, // maplibre-gl 단일 청크가 ~1.05MB — 더 쪼갤 수 없음
    rollupOptions: {
      // deck.gl 의 @loaders.gl/worker-utils 는 Node.js 의 child_process(spawn)
      // 를 import 하지만 브라우저 코드 경로에서는 사용되지 않음 — 안전하게 무시.
      onwarn(warning, defaultHandler) {
        if (
          warning.code === "MISSING_EXPORT" &&
          typeof warning.message === "string" &&
          warning.message.includes("@loaders.gl/worker-utils") &&
          warning.message.includes("spawn")
        ) return;
        defaultHandler(warning);
      },
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          // 단일 거대 청크 (1MB+) — 더 분리할 수 없음
          if (id.includes("maplibre-gl")) return "vendor-maplibre";
          if (id.includes("@deck.gl")) return "vendor-deck";
          // 보조 지도 라이브러리
          if (id.includes("react-map-gl")) return "vendor-mapgl";
          // Tauri API
          if (id.includes("@tauri-apps")) return "vendor-tauri";
          // React 런타임 (react, react-dom, react-router, scheduler)
          if (
            id.includes("/react-dom/") ||
            id.includes("/react-router/") ||
            id.includes("/react-router-dom/") ||
            id.includes("/scheduler/") ||
            /[\\/]react[\\/]/.test(id)
          ) return "vendor-react";
          // 그 외 모든 노드모듈 — 단일 vendor 청크 (작은 의존성 모음)
          return "vendor";
        },
      },
    },
  },
});
