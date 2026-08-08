import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import type { TourScenarioMeta, TourStep, TourWindow } from "./types";

/** 창 릴레이 상태를 담는 설정 키 — 기존 save_setting/load_setting 커맨드 재사용 (Rust 무변경) */
export const TOUR_STATE_KEY = "tour_state";
/** 저장된 릴레이 상태 신선도 — 초과 시 앱 재시작 잔재로 보고 무시 */
export const TOUR_STATE_TTL_MS = 10 * 60 * 1000;

export interface TourRelayState {
  scenario: string;
  phase: string;
  ts: number;
}

/** 다음 창이 이어받을 phase 를 DB에 기록 (창이 새로 생성되는 경로를 커버) */
export async function saveTourState(scenario: string, phase: string) {
  try {
    await invoke("save_setting", {
      key: TOUR_STATE_KEY,
      value: JSON.stringify({ scenario, phase, ts: Date.now() } satisfies TourRelayState),
    });
  } catch (e) {
    console.warn("[Tour] tour_state 저장 실패:", e);
  }
}

/** 릴레이 상태 클리어 (투어 종료·소비 직후) */
export async function clearTourState() {
  try {
    await invoke("save_setting", { key: TOUR_STATE_KEY, value: JSON.stringify(null) });
  } catch (e) {
    console.warn("[Tour] tour_state 클리어 실패:", e);
  }
}

/** 릴레이 상태 읽기 — 형식 불량/만료는 null */
export async function readTourState(): Promise<TourRelayState | null> {
  try {
    const raw = await invoke<string | null>("load_setting", { key: TOUR_STATE_KEY });
    if (!raw) return null;
    const st = JSON.parse(raw);
    if (!st || typeof st.scenario !== "string" || typeof st.phase !== "string") return null;
    if (typeof st.ts !== "number" || Date.now() - st.ts > TOUR_STATE_TTL_MS) return null;
    return st as TourRelayState;
  } catch {
    return null;
  }
}

/** phase 를 담당하는 창 — 자기 창 phase 만 반응하도록 게이트에 사용 */
export function phaseWindow(phase: string): TourWindow | null {
  switch (phase) {
    case "main":
    case "main-open-map":
      return "main";
    case "drawing":
      return "drawing";
    case "trackmap":
      return "trackmap";
    default:
      return null;
  }
}

/** 릴레이 대상 창에 포커스 (Sidebar.handleNav 의 getAllWebviewWindows 패턴) */
async function focusWindow(label: string) {
  try {
    const w = (await getAllWebviewWindows()).find((x) => x.label === label);
    await w?.setFocus();
  } catch (e) {
    console.warn("[Tour] 창 포커스 실패:", e);
  }
}

const SCENARIO_REPORT_TRACK = "report-track";

// ─── 시나리오 1: 비행검사결과보고서 첨부용 항적자료 ───────────────────
// main(단일항적분석 창 열기) → drawing(항적도 캡처) → main(지도 창 열기) → trackmap(항적 점 캡처)

const REPORT_TRACK_PHASES: Record<string, TourStep[]> = {
  main: [
    {
      id: "intro",
      title: "비행검사결과보고서 첨부용 항적자료",
      body:
        "단일항적분석 창에서 항적도를, 지도 창에서 항적 점 표시 화면을 캡처해 " +
        "비행검사결과보고서에 첨부하는 과정을 안내합니다. " +
        "안내에 따라 두 창을 차례로 열고 화면을 캡처하세요.",
      mode: "dim",
      showNext: true,
      nextLabel: "시작",
    },
    {
      id: "nav-drawing",
      target: '[data-tour="nav-drawing"]',
      title: "단일항적분석 창 열기",
      body: "'단일항적분석' 메뉴를 클릭하세요. 별도 창이 열립니다.",
      mode: "interactive",
      placement: "right",
      advanceOnTargetClick: true,
      endsPhase: true,
      // DB 플래그(새 창 생성 경로) + emit(이미 열려 있는 창 경로) 양쪽 모두 시동
      onAdvance: async () => {
        await saveTourState(SCENARIO_REPORT_TRACK, "drawing");
        await emit("tour:start", { scenario: SCENARIO_REPORT_TRACK, phase: "drawing" });
      },
    },
  ],

  drawing: [
    {
      id: "drawing-aircraft-btn",
      target: '[data-tour="drawing-aircraft"]',
      title: "비행검사기 목록 열기",
      body: "비행검사기 드롭다운을 클릭해 목록을 여세요.",
      mode: "interactive",
      placement: "right",
      advanceWhenSelectorAppears: '[data-tour="drawing-aircraft-list"]',
      showNext: true,
    },
    {
      id: "drawing-aircraft-pick",
      target: '[data-tour="drawing-aircraft-list"]',
      title: "비행검사기 선택",
      body:
        "등록된 비행검사기 목록입니다. 검사에 사용한 기체를 선택하세요. " +
        "'전체 항적'을 선택하면 모든 표적이 표시됩니다.",
      mode: "interactive",
      placement: "right",
      advanceWhen: (s, b) => s.selectedModeS !== b.selectedModeS,
      retreatToOnTargetLost: "drawing-aircraft-btn",
      showNext: true,
    },
    {
      id: "drawing-radar-btn",
      target: '[data-tour="drawing-radar"]',
      title: "레이더 목록 열기",
      body: "레이더 드롭다운을 클릭해 목록을 여세요.",
      mode: "interactive",
      placement: "right",
      advanceWhenSelectorAppears: '[data-tour="drawing-radar-list"]',
      showNext: true,
    },
    {
      id: "drawing-radar-pick",
      target: '[data-tour="drawing-radar-list"]',
      title: "레이더 선택",
      body:
        "자료를 저장한 레이더를 선택하세요. 레이더별로 좌표 원점과 제원이 달라 정확한 선택이 중요합니다.",
      mode: "interactive",
      placement: "right",
      advanceWhen: (s, b) => s.radarSite.name !== b.radarSite.name,
      retreatToOnTargetLost: "drawing-radar-btn",
      showNext: true,
    },
    {
      id: "drawing-open-ass",
      target: '[data-tour="drawing-open-ass"]',
      title: "ASS 파일 열기",
      body: "'ASS 파일 열기'를 클릭하세요. 투어에서는 가상 파일 선택 화면이 열립니다.",
      mode: "interactive",
      placement: "bottom",
      advanceOnTargetClick: true,
      interceptClick: true,
    },
    {
      id: "sim-file-pick",
      target: '[data-tour="fake-file-list"]',
      title: "저장자료 선택",
      body:
        "검사 당일 레이더 저장자료(.ass)를 선택하세요. " +
        "실제 화면에서는 Ctrl/Shift 클릭으로 여러 파일을 한 번에 선택할 수 있습니다.",
      mode: "interactive",
      placement: "right",
      overlay: "fileDialog",
      overlayCancelGoTo: "drawing-open-ass",
    },
    {
      id: "sim-file-open",
      target: '[data-tour="fake-file-open"]',
      title: "파일 열기",
      body: "'열기'를 클릭하세요.",
      mode: "interactive",
      placement: "right",
      overlay: "fileDialog",
      overlayCancelGoTo: "drawing-open-ass",
    },
    {
      id: "pf-aircraft",
      target: '[data-tour="pf-aircraft"]',
      title: "파싱 필터 — 비행검사기",
      body:
        "파싱 필터 설정 창입니다. 검사에 사용한 비행검사기를 체크하세요 — " +
        "체크한 기체의 Mode-S 표적만 파싱되어 처리 시간과 용량이 크게 줄어듭니다.",
      mode: "interactive",
      placement: "right",
      overlay: "parseFilter",
      overlayCancelGoTo: "drawing-open-ass",
      advanceOnTargetClick: true,
    },
    {
      id: "pf-include",
      target: '[data-tour="pf-include"]',
      title: "파싱 필터 — 포함 조건",
      body:
        "포함 조건 — 미등록 기체는 여기서 Mode-S 코드나 Squawk(4자리 8진수) 코드를 직접 추가해 포함시킬 수 있습니다.",
      mode: "interactive",
      placement: "right",
      overlay: "parseFilter",
      overlayCancelGoTo: "drawing-open-ass",
      showNext: true,
    },
    {
      id: "pf-exclude",
      target: '[data-tour="pf-exclude"]',
      title: "파싱 필터 — 제외 조건",
      body: "제외 조건 — 특정 Mode-S·Squawk 표적을 파싱에서 제외합니다.",
      mode: "interactive",
      placement: "right",
      overlay: "parseFilter",
      overlayCancelGoTo: "drawing-open-ass",
      showNext: true,
    },
    {
      id: "pf-nofilter",
      target: '[data-tour="pf-nofilter"]',
      title: "파싱 필터 — 전체 데이터",
      body:
        "전체 데이터 — 필터 없이 모든 표적을 파싱합니다. 파일 전체를 분석하므로 시간이 오래 걸리고 용량이 커집니다.",
      mode: "interactive",
      placement: "right",
      overlay: "parseFilter",
      overlayCancelGoTo: "drawing-open-ass",
      showNext: true,
    },
    {
      id: "pf-confirm",
      target: '[data-tour="pf-confirm"]',
      title: "파싱 시작",
      body:
        "'파싱 시작'을 클릭하세요. 이 버튼은 비행검사기를 체크했거나 '전체 데이터'를 선택했을 때 활성화됩니다.",
      mode: "interactive",
      placement: "right",
      overlay: "parseFilter",
      overlayCancelGoTo: "drawing-open-ass",
    },
    {
      id: "drawing-capture",
      title: "항적도 캡처",
      body:
        "실제 사용 시에는 파싱이 진행되고 항적이 화면에 표시됩니다. " +
        "항적을 확인한 뒤 **Win + Shift + S** 로 스크린샷을 캡처하세요 — 보고서 첨부용 항적도입니다.",
      mode: "floating",
      showNext: true,
    },
    {
      id: "drawing-relay",
      title: "지도 창으로 이동",
      body: "이제 지도 창에서 항적 점 화면을 캡처합니다. 메인 창으로 이동합니다.",
      mode: "floating",
      showNext: true,
      nextLabel: "메인 창으로",
      endsPhase: true,
      onAdvance: async () => {
        await emit("tour:relay", { scenario: SCENARIO_REPORT_TRACK, phase: "main-open-map" });
        await focusWindow("main");
      },
    },
  ],

  "main-open-map": [
    {
      id: "nav-map",
      target: '[data-tour="nav-map"]',
      title: "지도 창 열기",
      body: "'지도' 메뉴를 클릭하세요. 지도 창이 열립니다.",
      mode: "interactive",
      placement: "right",
      advanceOnTargetClick: true,
      endsPhase: true,
      onAdvance: async () => {
        await saveTourState(SCENARIO_REPORT_TRACK, "trackmap");
        await emit("tour:start", { scenario: SCENARIO_REPORT_TRACK, phase: "trackmap" });
      },
    },
  ],

  trackmap: [
    {
      id: "tm-aircraft-btn",
      target: '[data-tour="tm-aircraft"]',
      title: "비행검사기 목록 열기",
      body: "비행검사기 드롭다운을 클릭해 목록을 여세요.",
      mode: "interactive",
      placement: "right",
      advanceWhenSelectorAppears: '[data-tour="tm-aircraft-list"]',
      showNext: true,
    },
    {
      id: "tm-aircraft-pick",
      target: '[data-tour="tm-aircraft-list"]',
      title: "비행검사기 선택",
      body: "단일항적분석과 동일하게 검사에 사용한 기체를 선택하세요. 검색창으로 Mode-S 코드를 찾을 수도 있습니다.",
      mode: "interactive",
      placement: "right",
      advanceWhen: (s, b) => s.selectedModeS !== b.selectedModeS,
      retreatToOnTargetLost: "tm-aircraft-btn",
      showNext: true,
    },
    {
      id: "tm-radar-btn",
      target: '[data-tour="tm-radar"]',
      title: "레이더 목록 열기",
      body: "레이더 드롭다운을 클릭해 목록을 여세요.",
      mode: "interactive",
      placement: "right",
      advanceWhenSelectorAppears: '[data-tour="tm-radar-list"]',
      showNext: true,
    },
    {
      id: "tm-radar-pick",
      target: '[data-tour="tm-radar-list"]',
      title: "레이더 선택",
      body: "자료를 저장한 레이더를 선택하세요. 지도의 레이더 원점·커버리지 기준이 함께 바뀝니다.",
      mode: "interactive",
      placement: "right",
      advanceWhen: (s, b) => s.radarSite.name !== b.radarSite.name,
      retreatToOnTargetLost: "tm-radar-btn",
      showNext: true,
    },
    {
      id: "tm-open-ass",
      target: '[data-tour="tm-open-ass"]',
      title: "ASS 파일 열기",
      body: "'ASS 파일 열기'를 클릭하세요. 투어에서는 가상 파일 선택 화면이 열립니다.",
      mode: "interactive",
      placement: "bottom",
      advanceOnTargetClick: true,
      interceptClick: true,
    },
    {
      id: "tm-sim-file-pick",
      target: '[data-tour="fake-file-list"]',
      title: "저장자료 선택",
      body: "단일항적분석과 동일하게 동일 검사일의 저장자료(.ass)를 선택하세요.",
      mode: "interactive",
      placement: "right",
      overlay: "fileDialog",
      overlayCancelGoTo: "tm-open-ass",
    },
    {
      id: "tm-sim-file-open",
      target: '[data-tour="fake-file-open"]',
      title: "파일 열기",
      body: "'열기'를 클릭하세요.",
      mode: "interactive",
      placement: "right",
      overlay: "fileDialog",
      overlayCancelGoTo: "tm-open-ass",
    },
    {
      id: "tm-pf-aircraft",
      target: '[data-tour="pf-aircraft"]',
      title: "파싱 필터 — 비행검사기",
      body: "이전과 동일하게 비행검사기를 체크하세요. 포함·제외 조건과 전체 데이터 옵션도 동일합니다.",
      mode: "interactive",
      placement: "right",
      overlay: "parseFilter",
      overlayCancelGoTo: "tm-open-ass",
      advanceOnTargetClick: true,
    },
    {
      id: "tm-pf-confirm",
      target: '[data-tour="pf-confirm"]',
      title: "파싱 시작",
      body: "'파싱 시작'을 클릭하세요.",
      mode: "interactive",
      placement: "right",
      overlay: "parseFilter",
      overlayCancelGoTo: "tm-open-ass",
    },
    {
      id: "tm-track-points",
      target: '[data-tour="tm-track-points"]',
      title: "항적 점 표시",
      body: "항적 표시를 '점'으로 전환하세요. 개별 탐지점 단위로 항적이 표시됩니다.",
      mode: "interactive",
      placement: "right",
      advanceOnTargetClick: true,
    },
    {
      id: "tm-capture",
      title: "지도 화면 캡처",
      body: "실제 사용 시 항적 점이 지도에 표시됩니다. **Win + Shift + S** 로 캡처하세요.",
      mode: "floating",
      showNext: true,
    },
    {
      id: "tm-finish",
      title: "투어 완료",
      body: "캡처한 두 이미지를 비행검사결과보고서에 첨부하세요.",
      mode: "dim",
      showNext: true,
      nextLabel: "완료",
      endsPhase: true,
      onAdvance: async () => {
        await clearTourState();
      },
    },
  ],
};

/** 사용방법 페이지 목록용 메타 */
export const TOUR_SCENARIOS: TourScenarioMeta[] = [
  {
    id: SCENARIO_REPORT_TRACK,
    title: "비행검사결과보고서 첨부용 항적자료",
    description:
      "레이더 저장자료(ASS)를 불러와 비행검사기 항적을 표출하고, 보고서에 첨부할 항적도와 " +
      "항적 점 표시 화면을 차례로 캡처합니다. 안내에 따라 단일항적분석 창과 지도 창이 순서대로 열립니다. " +
      "가상 자료로 전 과정을 시뮬레이션하므로 실제 ASS 파일이 없어도 진행할 수 있습니다.",
    stepsSummary: [
      "단일항적분석 창에서 비행검사기·레이더 선택",
      "ASS 파일 선택 후 파싱 필터(비행검사기·포함/제외 조건·전체 데이터) 설정",
      "항적도 화면 캡처 (Win + Shift + S)",
      "지도 창에서 동일 자료를 불러와 항적 표시를 '점'으로 전환",
      "항적 점 표시 화면 캡처 (Win + Shift + S)",
    ],
  },
];

/** 시나리오·phase 별 스텝 목록 */
export function getPhaseSteps(scenario: string, phase: string): TourStep[] {
  if (scenario !== SCENARIO_REPORT_TRACK) return [];
  return REPORT_TRACK_PHASES[phase] ?? [];
}
