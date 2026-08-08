import { create } from "zustand";
import { clearTourState, getPhaseSteps } from "./scenarios";

/**
 * 창-로컬 투어 상태 (Toast.tsx 와 동일한 경량 zustand 패턴).
 * 창 간 상태 공유는 하지 않는다 — 릴레이는 tour_state(DB) + emit 로만 이뤄진다.
 */
interface TourState {
  active: boolean;
  scenario: string | null;
  phase: string | null;
  stepIndex: number;
  /** waitAfterClick 대기 상태 (우하단 대기 카드) */
  waiting: boolean;
  start: (scenario: string, phase: string) => void;
  advance: () => void;
  setWaiting: (v: boolean) => void;
  end: () => void;
}

const IDLE = { active: false, scenario: null, phase: null, stepIndex: 0, waiting: false } as const;

export const useTourStore = create<TourState>((set, get) => ({
  ...IDLE,

  start: (scenario, phase) => {
    // 중복 시동 방지 — DB 플래그로 이미 시작한 뒤 emit 이 도착해도 무해해야 한다
    if (get().active) return;
    if (getPhaseSteps(scenario, phase).length === 0) return;
    set({ active: true, scenario, phase, stepIndex: 0, waiting: false });
  },

  advance: () => {
    const { active, scenario, phase, stepIndex } = get();
    if (!active || !scenario || !phase) return;
    const steps = getPhaseSteps(scenario, phase);
    const step = steps[stepIndex];
    if (!step) {
      set({ ...IDLE });
      return;
    }
    // 부수효과(tour_state 저장·emit)는 fire-and-forget — 실패해도 UI 진행은 막지 않는다
    Promise.resolve(step.onAdvance?.()).catch((e) => console.warn("[Tour] onAdvance 실패:", e));
    // 릴레이 스텝·마지막 스텝은 이 창의 투어를 종료.
    // tour_state 클리어는 하지 않는다 — onAdvance 가 방금 다음 phase 를 기록했을 수 있음
    if (step.endsPhase || stepIndex >= steps.length - 1) {
      set({ ...IDLE });
      return;
    }
    set({ stepIndex: stepIndex + 1, waiting: false });
  },

  setWaiting: (v) => set({ waiting: v }),

  end: () => {
    if (!get().active) return;
    set({ ...IDLE });
    void clearTourState();
  },
}));
