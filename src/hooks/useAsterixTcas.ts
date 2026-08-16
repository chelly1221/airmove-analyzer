/**
 * ASTERIX 통계 상세 "BDS·ACAS" 토픽용 TCAS 보고 추출 훅 — scan_asterix_tcas 호출 + bulk:// 수신.
 *
 * ASTERIX 탭이 이미 스캔한 파일셋(store.asterixFilePaths)을 그대로 재사용한다 — 별도 업로드 없음.
 * 전수 재파싱이라 토픽 전환·재방문마다 다시 돌리지 않도록 모듈 레벨 단일 캐시를 둔다.
 * 캐시 키는 (파일셋 배열 참조 identity · 레이더 위/경도)이며, 새 ASS 스캔(=배열 참조 교체)이나
 * 레이더 사이트 변경이면 즉시 무효화된다(useAsterixDetail 의 캐시 규약과 동일 사고방식).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../store";
import { readBulkJson, type BulkRef } from "../utils/bulkIpc";
import type { TcasReport } from "../types/track";

/** Rust emit 페이로드 — "asterix-tcas-progress" (AsterixScanProgress 공유 형태) */
export interface AsterixTcasProgress {
  done: number;
  total: number;
  filename: string;
}

/** 캐시가 유효한 파일셋 (배열 참조 identity) + 그때의 레이더 좌표 */
let cachedPaths: string[] | null = null;
let cachedLat = Number.NaN;
let cachedLon = Number.NaN;
let cachedReports: TcasReport[] | null = null;

function cacheGet(paths: string[], lat: number, lon: number): TcasReport[] | null {
  if (cachedPaths !== paths || cachedLat !== lat || cachedLon !== lon) return null;
  return cachedReports;
}

function cachePut(paths: string[], lat: number, lon: number, value: TcasReport[]): void {
  cachedPaths = paths;
  cachedLat = lat;
  cachedLon = lon;
  cachedReports = value;
}

export interface UseAsterixTcas {
  reports: TcasReport[] | null;
  loading: boolean;
  progress: AsterixTcasProgress | null;
  error: string | null;
  run: () => void;
}

export function useAsterixTcas(): UseAsterixTcas {
  const filePaths = useAppStore((s) => s.asterixFilePaths);
  const radarLat = useAppStore((s) => s.radarSite.latitude);
  const radarLon = useAppStore((s) => s.radarSite.longitude);

  const [reports, setReports] = useState<TcasReport[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<AsterixTcasProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 단일비행 세대 카운터 — in-flight 중 재호출 시 이전 응답은 폐기
  const genRef = useRef(0);
  const mountedRef = useRef(true);

  // 진행 이벤트 구독 (마운트 동안만)
  useEffect(() => {
    mountedRef.current = true;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    listen<AsterixTcasProgress>("asterix-tcas-progress", (e) => {
      if (!disposed) setProgress(e.payload);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((e) => console.error("[ASTERIX] TCAS 진행 이벤트 구독 실패:", e));
    return () => {
      disposed = true;
      mountedRef.current = false;
      unlisten?.();
    };
  }, []);

  const run = useCallback(() => {
    const gen = ++genRef.current;

    const hit = cacheGet(filePaths, radarLat, radarLon);
    if (hit) {
      setReports(hit);
      setError(null);
      setLoading(false);
      setProgress(null);
      return;
    }

    if (filePaths.length === 0) {
      setReports([]);
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
        const ref = await invoke<BulkRef>("scan_asterix_tcas", {
          filePaths,
          radarLat,
          radarLon,
        });
        const res = await readBulkJson<TcasReport[]>(ref);
        // 세대가 지났어도 결과 자체는 유효 — 캐시에는 남긴다
        cachePut(filePaths, radarLat, radarLon, res);
        if (gen !== genRef.current || !mountedRef.current) return;
        setReports(res);
        setLoading(false);
        setProgress(null);
      } catch (e) {
        console.error("[ASTERIX] TCAS 보고 추출 실패:", e);
        if (gen !== genRef.current || !mountedRef.current) return;
        setError(String(e));
        setLoading(false);
        setProgress(null);
      }
    })();
  }, [filePaths, radarLat, radarLon]);

  return { reports, loading, progress, error, run };
}

export default useAsterixTcas;
