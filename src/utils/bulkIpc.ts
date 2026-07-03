/**
 * 대용량 IPC 응답의 파일 매개 수신 (bulk:// 커스텀 프로토콜)
 *
 * Tauri invoke 응답이 수 MB+ 급이면 WebView2 IPC 폴백(postMessage+eval) 경로에서
 * 전체 페이로드가 CDP Runtime.evaluate 스크립트로 공유 브라우저 프로세스를 통과하며
 * OOM 크래시(0xE0000008, 모든 창 동시 백지)를 유발한다. 대용량 커맨드는 Rust 가
 * 결과를 임시 파일로 쓰고 BulkRef(id)만 반환 — 본문은 bulk:// 프로토콜 fetch 로
 * 스트리밍 수신한다 (src-tauri/src/bulk.rs 참조).
 */
import { invoke, convertFileSrc } from "@tauri-apps/api/core";

/** Rust bulk::BulkRef 미러 — 대용량 커맨드의 invoke 응답 */
export interface BulkRef {
  bulk_id: string;
  bytes: number;
}

async function fetchBulk(ref: BulkRef): Promise<Response> {
  const res = await fetch(convertFileSrc(ref.bulk_id, "bulk"));
  if (!res.ok) {
    throw new Error(`bulk 수신 실패 (HTTP ${res.status}, id=${ref.bulk_id})`);
  }
  return res;
}

/** 수신 완료(또는 실패) 후 Rust 측 임시 파일 삭제 — 실패해도 시작 시 sweep 이 정리 */
export function cleanupBulk(ref: BulkRef): void {
  invoke("bulk_cleanup", { id: ref.bulk_id }).catch(() => { /* sweep 이 정리 */ });
}

/** JSON 본문 수신 + 파싱 + 임시 파일 정리 */
export async function readBulkJson<T>(ref: BulkRef): Promise<T> {
  try {
    const res = await fetchBulk(ref);
    return (await res.json()) as T;
  } finally {
    cleanupBulk(ref);
  }
}

/** raw 바이트 본문 수신 (f32 heightmap, RGBA 비트맵 등) + 임시 파일 정리 */
export async function readBulkBytes(ref: BulkRef): Promise<ArrayBuffer> {
  try {
    const res = await fetchBulk(ref);
    return await res.arrayBuffer();
  } finally {
    cleanupBulk(ref);
  }
}
