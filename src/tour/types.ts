import type { useAppStore } from "../store";

/**
 * 스토어 상태 타입 — store/index.ts 의 AppState 인터페이스가 export 되지 않아
 * getState() 반환형에서 유도한다 (기존 파일 침습 최소화).
 */
export type AppState = ReturnType<typeof useAppStore.getState>;

/** 투어가 진행되는 창 (Tauri 윈도우 라벨과 동일) */
export type TourWindow = "main" | "drawing" | "trackmap";

/**
 * 스텝 표출 방식
 * - dim: 화면 전체 딤 + 중앙 카드 (인트로/완료)
 * - interactive: 딤 없음. 대상 하이라이트 링 + 툴팁 카드 (실제 조작 유도)
 * - floating: 우하단 소형 카드만 (안내 문구)
 */
export type TourMode = "dim" | "interactive" | "floating";

/** 툴팁 카드 배치 우선순위 — 드롭다운 대상은 "right"(팝업을 가리지 않도록) */
export type TourPlacement = "right" | "bottom";

export interface TourStep {
  id: string;
  /** 대상 CSS 셀렉터. 없으면 중앙(dim)/우하단(floating) 카드 */
  target?: string;
  title: string;
  /** 본문. `**...**` 는 굵게 표시된다 */
  body: string;
  /** waitAfterClick 대기 중 표시할 본문 (없으면 body 유지) */
  waitBody?: string;
  mode: TourMode;
  placement?: TourPlacement;
  /** 대상 클릭 감지 시 자동 진행 */
  advanceOnTargetClick?: boolean;
  /** 클릭 후 우하단 대기 카드로 전환 (advanceWhen 충족까지 대기) */
  waitAfterClick?: boolean;
  /**
   * 스토어 조건 자동 진행. baseline 은 스텝 진입 시점 스냅샷.
   * 10M+ 규약: 대량 배열 순회 금지 — length·스칼라 필드만 읽을 것.
   */
  advanceWhen?: (state: AppState, baseline: AppState) => boolean;
  /** [다음] 버튼 표시 여부 (대기 상태에서는 항상 폴백으로 표시) */
  showNext?: boolean;
  /** 기본 "다음" */
  nextLabel?: string;
  /** 진행 직후 부수효과 (tour_state 저장·emit 등) */
  onAdvance?: () => void | Promise<void>;
  /** 이 스텝 진행 시 이 창의 투어 종료 (마지막 스텝 또는 릴레이 스텝) */
  endsPhase?: boolean;
}

/** 사용방법 페이지에 노출되는 시나리오 메타 */
export interface TourScenarioMeta {
  id: string;
  title: string;
  description: string;
  stepsSummary: string[];
}
