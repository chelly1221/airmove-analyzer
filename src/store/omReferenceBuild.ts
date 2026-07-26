/**
 * OM 기준데이터 등록 오케스트레이션 스토어.
 *
 * 재설계: 등록(register_om_reference)은 원본 ASS 사본 복사만 수행한다(집계·재계산 없음 —
 * 히스토그램은 보고서 생성 시 현재 설정으로 재집계). 원본이 수 GB 일 수 있어 복사가 오래 걸리므로,
 * 관리 모달 로컬 상태에 두면 모달을 닫는 순간 복사가 끊긴다. 오케스트레이션을 모달 밖 zustand
 * 스토어로 승격해 모달을 닫아도 백그라운드로 계속 복사한다.
 *
 * 계약(수정 금지, src/types·utils·src-tauri 소유 아님):
 * - register_om_reference: OmReferenceMeta[] 반환(레이더별 순차 단일 호출). 복사 실패/취소는 reject
 *   또는 빈 반환 → 실패. 진행 이벤트 om-reference-progress(payload: ObstacleMonthlyProgress),
 *   stage="copy"(원본 ASS 보관 중), "error"(레이더 단위 실패).
 * - cancel_analysis: 공유 cancel 토큰 취소(fire-and-forget).
 */
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { RadarSite, OmReferenceMeta, ObstacleMonthlyProgress } from "../types";

export type OmRefJobStatus = "pending" | "running" | "done" | "error" | "cancelled";

/** 레이더 단위 등록 작업 항목 */
export interface OmRefBuildJob {
  radarName: string;
  monthLabel: string;
  status: OmRefJobStatus;
  error?: string;
}

interface OmRefBuildState {
  /** 빌드 진행 중 (in-flight invoke 가 settle 될 때까지 유지 — 취소 레이스 방지) */
  building: boolean;
  /** 사용자가 취소를 요청했는지 (settle 시 남은 job 을 cancelled 로 마킹) */
  cancelRequested: boolean;
  /** 레이더별 작업 상태 목록 (진행/결과 표시·재오픈 시 잔존) */
  jobs: OmRefBuildJob[];
  /** 현재 진행 상황 (레이더명·메시지·진척) */
  progress: { radarName: string; message: string; current: number; total: number } | null;

  startBuild: (items: { radar: RadarSite; files: string[]; month: string }[]) => Promise<void>;
  requestCancel: () => void;
  clearJobs: () => void;
}

/** jobs 배열에서 idx 위치 job 의 상태(+에러)를 갱신한 새 배열 반환 (타입 고정용 헬퍼) */
function withJobStatus(jobs: OmRefBuildJob[], idx: number, status: OmRefJobStatus, error?: string): OmRefBuildJob[] {
  return jobs.map((j, i) => (i === idx ? { ...j, status, error: error ?? j.error } : j));
}

/** idx 이상의 pending job 을 전부 cancelled 로 마킹한 새 배열 반환 (취소 시 남은 작업 정리) */
function cancelPendingFrom(jobs: OmRefBuildJob[], from: number): OmRefBuildJob[] {
  return jobs.map((j, i) => (i >= from && j.status === "pending" ? { ...j, status: "cancelled" as OmRefJobStatus } : j));
}

/**
 * RadarSite → register 커맨드용 RadarFileSet.
 * 등록은 원본 ASS 복사만 하므로 azimuth_sectors/building_* 는 빈 배열(백엔드가 무시).
 * radar_lat/lon/altitude/antenna_height 는 메타에 기록(참고용) — 재집계는 생성 시 현재 설정을 쓴다.
 */
function buildRadarFileSet(radar: RadarSite, filePaths: string[]) {
  return {
    radar_name: radar.name,
    radar_lat: radar.latitude,
    radar_lon: radar.longitude,
    radar_altitude: radar.altitude,
    antenna_height: radar.antenna_height,
    file_paths: filePaths,
    azimuth_sectors: [],
    min_obstacle_distance_km: 0,
    building_bearings_deg: [],
    building_az_half_extents_deg: [],
  };
}

export const useOmReferenceBuildStore = create<OmRefBuildState>((set, get) => ({
  building: false,
  cancelRequested: false,
  jobs: [],
  progress: null,

  startBuild: async (items) => {
    if (get().building) return; // 이미 등록 중이면 무시

    // jobs 초기화 (전부 pending)
    const jobs: OmRefBuildJob[] = items.map((it) => ({
      radarName: it.radar.name,
      monthLabel: it.month,
      status: "pending",
    }));
    set({ building: true, cancelRequested: false, jobs, progress: null });

    // 진행 이벤트 1회 등록 — progress 갱신 + stage==="error" payload 를 radar_name 별 마지막 에러로 보관.
    // (register 는 레이더별 단일 호출·부분 성공이라 실패 레이더가 빈 반환으로 오므로, 사유는 이벤트에서 회수)
    const errorByRadar = new Map<string, string>();
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listen<ObstacleMonthlyProgress>("om-reference-progress", (e) => {
        const p = e.payload;
        if (p.stage === "error") errorByRadar.set(p.radar_name, p.message);
        set({
          progress: {
            radarName: p.radar_name,
            message: p.message,
            current: p.total > 0 ? p.current : 0,
            total: p.total > 0 ? p.total : 0,
          },
        });
      });
    } catch { /* 리스너 실패 시 진행률 없이 진행 */ }

    try {
      // 레이더별 순차 invoke — 한 call 에 여러 레이더를 싣지 않는 이유:
      // (1) 기준월이 레이더별로 다를 수 있고, (2) 실패 귀속(어느 레이더가 실패했는지)을 명확히 하기 위함.
      for (let i = 0; i < items.length; i++) {
        // 취소 요청 시 남은 pending job 전부 cancelled 로 마킹 후 중단
        if (get().cancelRequested) {
          set((s) => ({ jobs: cancelPendingFrom(s.jobs, i) }));
          break;
        }

        const it = items[i];
        set((s) => ({ jobs: withJobStatus(s.jobs, i, "running") }));

        const radarFileSets = [buildRadarFileSet(it.radar, it.files)];
        try {
          const metas = await invoke<OmReferenceMeta[]>("register_om_reference", {
            radarFileSets,
            monthLabel: it.month,
          });
          if (get().cancelRequested) {
            set((s) => ({ jobs: withJobStatus(s.jobs, i, "cancelled") }));
          } else if (!metas || metas.length === 0) {
            // 빈 반환 = 실패(부분 성공 계약). 성공 경로로 오인하지 않는다.
            const msg = errorByRadar.get(it.radar.name) ?? "등록 실패 — 상세는 로그 확인";
            set((s) => ({ jobs: withJobStatus(s.jobs, i, "error", msg) }));
          } else {
            set((s) => ({ jobs: withJobStatus(s.jobs, i, "done") }));
          }
        } catch (err) {
          if (get().cancelRequested) {
            set((s) => ({ jobs: withJobStatus(s.jobs, i, "cancelled") }));
          } else {
            set((s) => ({ jobs: withJobStatus(s.jobs, i, "error", String(err)) }));
          }
        }
      }
    } finally {
      unlisten?.();
      set({ progress: null, building: false, cancelRequested: false });
    }
  },

  requestCancel: () => {
    if (!get().building) return; // 등록 중이 아니면 무시
    set({ cancelRequested: true });
    // fire-and-forget — 응답을 기다리지 않는다.
    invoke("cancel_analysis").catch(() => { /* ignore */ });
    // building 은 여기서 풀지 않고 in-flight invoke 가 settle 될 때 finally 에서 푼다.
    // 즉시 building=false 로 풀면 사용자가 곧바로 새 등록을 시작할 수 있는데, 그 순간 공유 cancel
    // 토큰이 리셋되어 방금 요청한 취소가 무효화되고, 이전 복사와 새 복사가 동일 ass 디렉토리에
    // 동시 기록하는 레이스가 생긴다.
  },

  clearJobs: () => {
    if (get().building) return; // 등록 중에는 결과를 비우지 않는다.
    set({ jobs: [], progress: null });
  },
}));
