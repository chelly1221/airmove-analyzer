// ─── landuse 커스텀 프로토콜 (공용) ─────────────────────────────
// 목적: 토지이용계획도 raster 타일(landuse://{z}/{x}/{y})을 SQLite 캐시
//       (get_landuse_tile 커맨드)에서 서빙하는 MapLibre 프로토콜을 1회 등록한다.
//       BuildingModal·FileUpload 두 지도에서 동일 등록이 중복되던 것을 단일화.
// 캐시 z12–15 제약: landuse_tiles 테이블은 z12–15 만 저장(그중 z15 는 일부만).
// 부모 폴백 이유: 요청 타일이 캐시에 없으면 빈 ArrayBuffer 를 반환하는데,
//       MapLibre 는 이를 "로드 완료(빈 타일)"로 처리해 부모 타일로의 자체 폴백을
//       하지 않는다 → 캐시 미보유 줌(≈14+)에서 오버레이가 사라진다.
//       따라서 여기서 직접 부모 타일을 크롭·업스케일해 자식 타일을 합성한다.
import maplibregl from "maplibre-gl";
import { invoke } from "@tauri-apps/api/core";

const LANDUSE_MIN_Z = 12; // 캐시 최소 줌 — 이보다 위 부모는 조회하지 않음

let landuseProtocolRegistered = false;

/** base64 PNG → Uint8Array 디코드 (기존 인라인 코드와 동일한 atob 루프) */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// 부모 타일 ImageBitmap 디코드 캐시: 하나의 부모가 4~64개 자식에 재사용되므로
//   자식마다 재디코드하지 않도록 "pz/px/py" 키로 Promise 를 캐싱.
//   FIFO 로 ~32개 초과분을 evict(가장 오래된 키 삭제) — 삭제 시 best-effort close.
const PARENT_CACHE_MAX = 32;
const parentBitmapCache = new Map<string, Promise<ImageBitmap | null>>();

function getParentBitmap(pz: number, px: number, py: number): Promise<ImageBitmap | null> {
  const key = `${pz}/${px}/${py}`;
  const cached = parentBitmapCache.get(key);
  if (cached) return cached;
  const p = (async (): Promise<ImageBitmap | null> => {
    const base64 = await invoke<string | null>("get_landuse_tile", { z: pz, x: px, y: py });
    if (!base64) return null;
    const bytes = base64ToBytes(base64);
    return await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  })();
  parentBitmapCache.set(key, p);
  // FIFO evict — 가장 오래된 키 제거
  if (parentBitmapCache.size > PARENT_CACHE_MAX) {
    const oldest = parentBitmapCache.keys().next().value as string | undefined;
    if (oldest !== undefined) {
      const evicted = parentBitmapCache.get(oldest);
      parentBitmapCache.delete(oldest);
      evicted?.then((bm) => bm?.close()).catch(() => {});
    }
  }
  return p;
}

export function ensureLanduseProtocol() {
  if (landuseProtocolRegistered) return;
  landuseProtocolRegistered = true;
  maplibregl.addProtocol("landuse", async (params) => {
    const parts = params.url.replace("landuse://", "").split("/");
    const [z, x, y] = parts.map(Number);
    try {
      // Step 1: 정확한 타일 조회
      const base64 = await invoke<string | null>("get_landuse_tile", { z, x, y });
      if (base64) return { data: base64ToBytes(base64).buffer };

      // Step 2: 부모 타일 폴백 — z-1 부터 LANDUSE_MIN_Z 까지 상위 줌을 탐색해
      //   해당 자식 사분면을 크롭·256×256 업스케일 합성 (dz ≤ 3 → 사분면 ≥ 32px)
      for (let pz = z - 1; pz >= LANDUSE_MIN_Z; pz--) {
        const dz = z - pz;
        const px = x >> dz;
        const py = y >> dz;
        const bitmap = await getParentBitmap(pz, px, py);
        if (!bitmap) continue;
        const size = 256 >> dz;
        const sx = (x - (px << dz)) * size;
        const sy = (y - (py << dz)) * size;
        const canvas = new OffscreenCanvas(256, 256);
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        // 토지이용은 범주형 색상 — 경계 색 번짐 방지 위해 nearest-neighbor 유지
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(bitmap, sx, sy, size, size, 0, 0, 256, 256);
        const blob = await canvas.convertToBlob({ type: "image/png" });
        const buf = await blob.arrayBuffer();
        return { data: buf };
      }

      // Step 3: 아무것도 없음 → 빈 버퍼(기존 동작)
      return { data: new ArrayBuffer(0) };
    } catch {
      return { data: new ArrayBuffer(0) };
    }
  });
}
