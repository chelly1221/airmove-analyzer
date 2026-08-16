/**
 * ASTERIX 통계 상세 재집계 훅 — scan_asterix_detail 호출 + bulk:// 수신.
 *
 * 10M+ 레코드 전수 재스캔이므로 토픽 전환·재방문마다 다시 돌리지 않도록
 * 모듈 레벨 LRU 캐시(상한 8)를 둔다. 캐시 키는 (현재 파일셋 · 필터 JSON)이며,
 * 파일셋 배열 참조가 바뀌면(= 새 ASS 스캔) 캐시 전체를 버린다.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../store";
import { readBulkJson, type BulkRef } from "../utils/bulkIpc";
import type { AsterixDetailFilter, AsterixDetailStats } from "../types/asterixDetail";

/** Rust emit 페이로드 — "asterix-detail-progress" */
export interface AsterixDetailProgress {
  done: number;
  total: number;
  filename: string;
}

const CACHE_MAX = 8;
/** 캐시가 유효한 파일셋 (배열 참조 identity) */
let cachedPaths: string[] | null = null;
/** filter JSON → 결과 (Map 삽입 순서 = LRU 순서, 앞쪽이 오래된 것) */
const cache = new Map<string, AsterixDetailStats>();

function cacheGet(paths: string[], key: string): AsterixDetailStats | null {
  if (cachedPaths !== paths) return null;
  const hit = cache.get(key);
  if (!hit) return null;
  // 최근 사용으로 승격
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cachePut(paths: string[], key: string, value: AsterixDetailStats): void {
  if (cachedPaths !== paths) {
    cache.clear();
    cachedPaths = paths;
  }
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

export interface UseAsterixDetail {
  data: AsterixDetailStats | null;
  loading: boolean;
  progress: AsterixDetailProgress | null;
  error: string | null;
  run: (filter: AsterixDetailFilter) => void;
}

export function useAsterixDetail(): UseAsterixDetail {
  const filePaths = useAppStore((s) => s.asterixFilePaths);
  const [data, setData] = useState<AsterixDetailStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<AsterixDetailProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 단일비행 세대 카운터 — in-flight 중 재호출 시 이전 응답은 폐기
  const genRef = useRef(0);
  const mountedRef = useRef(true);

  // 진행 이벤트 구독 (마운트 동안만)
  useEffect(() => {
    mountedRef.current = true;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    listen<AsterixDetailProgress>("asterix-detail-progress", (e) => {
      if (!disposed) setProgress(e.payload);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((e) => console.error("[ASTERIX] 상세 진행 이벤트 구독 실패:", e));
    return () => {
      disposed = true;
      mountedRef.current = false;
      unlisten?.();
    };
  }, []);

  const run = useCallback(
    (filter: AsterixDetailFilter) => {
      const gen = ++genRef.current;
      const key = JSON.stringify(filter);

      const hit = cacheGet(filePaths, key);
      if (hit) {
        setData(hit);
        setError(null);
        setLoading(false);
        setProgress(null);
        return;
      }

      setLoading(true);
      setError(null);
      setProgress(null);

      (async () => {
        try {
          const ref = await invoke<BulkRef>("scan_asterix_detail", { filePaths, filter });
          const res = await readBulkJson<AsterixDetailStats>(ref);
          // 세대가 지났어도 결과 자체는 유효 — 캐시에는 남긴다
          cachePut(filePaths, key, res);
          if (gen !== genRef.current || !mountedRef.current) return;
          setData(res);
          setLoading(false);
          setProgress(null);
        } catch (e) {
          console.error("[ASTERIX] 상세 재집계 실패:", e);
          if (gen !== genRef.current || !mountedRef.current) return;
          setError(String(e));
          setLoading(false);
          setProgress(null);
        }
      })();
    },
    [filePaths],
  );

  return { data, loading, progress, error, run };
}

export default useAsterixDetail;
