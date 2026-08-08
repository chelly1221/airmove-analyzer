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
const SCENARIO_OBSTACLE_LOS = "obstacle-los-review";

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

// ─── 시나리오 2: 장애물 전파영향성 사전검토 ─────────────────────────────
// main(지도 창 열기) → trackmap(LoS 분석 도구 → 주소검색 → 건물 카드 → 단면도 → 방위별 확인)
//
// 이 시나리오의 관련 상태(activeTool·addressMarker·losTarget·xZoom 등)는 전부 TrackMap 로컬
// useState 라 스토어 구독(advanceWhen)으로는 감지할 수 없다 — 진행 신호는 전부 DOM 앵커
// (advanceWhenSelectorAppears / advanceOnTargetClick)로만 잡는다.
// 주소검색은 VWorld 온라인 API 라 오프라인에서는 결과가 없을 수 있어 대기성 스텝은 전부 showNext 폴백.

const OBSTACLE_LOS_PHASES: Record<string, TourStep[]> = {
  main: [
    {
      id: "ob-intro",
      title: "장애물 전파영향성 사전검토",
      body:
        "신축(계획) 건물이나 기존 장애물이 레이더 전파에 미치는 영향(LoS 차단 여부·허용높이)을 " +
        "지도 창에서 사전검토하는 과정을 안내합니다. " +
        "주소검색으로 대상 건물을 찾아 LoS 단면도로 방위별 차단 여부를 확인합니다.",
      mode: "dim",
      showNext: true,
      nextLabel: "시작",
    },
    {
      id: "ob-nav-map",
      target: '[data-tour="nav-map"]',
      title: "지도 창 열기",
      body: "'지도' 메뉴를 클릭하세요. 지도 창이 열립니다.",
      mode: "interactive",
      placement: "right",
      advanceOnTargetClick: true,
      endsPhase: true,
      // DB 플래그(새 창 생성 경로) + emit(이미 열려 있는 창 경로) 양쪽 모두 시동
      onAdvance: async () => {
        await saveTourState(SCENARIO_OBSTACLE_LOS, "trackmap");
        await emit("tour:start", { scenario: SCENARIO_OBSTACLE_LOS, phase: "trackmap" });
      },
    },
  ],

  trackmap: [
    {
      id: "ob-tool-los",
      target: '[data-tour="tm-tool-los"]',
      title: "LoS 분석 도구 열기",
      body: "사이드바 도구에서 'LoS 분석'을 클릭하세요. 좌측에 LoS 단면도 도구 드로어가 열립니다.",
      mode: "interactive",
      placement: "right",
      advanceWhenSelectorAppears: '[data-tour="tm-los-drawer"]',
      showNext: true,
    },
    {
      id: "ob-los-drawer",
      target: '[data-tour="tm-los-drawer"]',
      title: "LoS 단면도 도구",
      body:
        "LoS 단면도 도구입니다. '지점 선택'으로 지도의 임의 지점을, '등록 장애물'로 등록된 장애물을 " +
        "조준할 수 있습니다. 이번에는 주소검색으로 건물을 찾아보겠습니다.",
      mode: "interactive",
      placement: "right",
      showNext: true,
    },
    {
      id: "ob-address-input",
      target: '[data-tour="tm-address-search"]',
      title: "대상 건물 검색",
      body: "지도 좌상단 검색창에 도로명주소나 건물명을 입력하세요. 예: **개화동로 561**",
      mode: "interactive",
      placement: "bottom",
      advanceWhenSelectorAppears: '[data-tour="tm-address-results"]',
      showNext: true,
    },
    {
      id: "ob-address-pick",
      target: '[data-tour="tm-address-results"]',
      title: "검색 결과 선택",
      body: "검색 결과에서 대상 주소를 클릭하세요. 지도가 건물 위치로 이동하고 건물 정보 카드가 나타납니다.",
      mode: "interactive",
      placement: "bottom",
      advanceWhenSelectorAppears: '[data-tour="tm-bldg-card"]',
      retreatToOnTargetLost: "ob-address-input",
      showNext: true,
    },
    {
      id: "ob-bldg-card",
      target: '[data-tour="tm-bldg-card"]',
      title: "건물 정보 확인",
      body:
        "건물 정보 카드입니다. GIS 건물이면 지반고·건물높이가 자동으로 채워집니다. " +
        "**신축 계획 검토라면 계획 높이로 수정 후 '적용'**을 눌러 가상 높이로 검토할 수 있습니다.",
      mode: "interactive",
      placement: "right",
      showNext: true,
    },
    {
      id: "ob-bldg-los-btn",
      target: '[data-tour="tm-bldg-los-btn"]',
      title: "LoS 단면도 열기",
      body: "'LoS 단면도'를 클릭하세요. 레이더에서 이 건물까지의 전파 단면이 하단에 표시됩니다.",
      mode: "interactive",
      placement: "right",
      // 클릭 감지 불요 — 단면도 패널 등장이 완료 신호
      advanceWhenSelectorAppears: '[data-tour="tm-los-panel"]',
    },
    {
      id: "ob-bldg-results",
      target: '[data-tour="tm-bldg-card-results"]',
      title: "허용높이 확인",
      body:
        "카드에 LoS·BRA **허용높이**와 초과/여유가 계산됩니다. 계획 높이와 비교해 전파영향성을 사전검토하세요.",
      mode: "interactive",
      placement: "right",
      showNext: true,
    },
    {
      id: "ob-tab-center",
      target: '[data-tour="tm-los-tab-center"]',
      title: "중앙 방위 단면",
      body: "기본으로 건물 **중앙** 방위 단면이 표시됩니다. 헤더의 차단/양호 배지와 단면도를 확인하세요.",
      mode: "interactive",
      placement: "bottom",
      showNext: true,
    },
    {
      id: "ob-tab-left",
      target: '[data-tour="tm-los-tab-left"]',
      title: "좌끝 방위 단면",
      body:
        "'좌끝' 탭을 클릭하세요 — 건물 좌측 끝 방위의 단면입니다. " +
        "넓은 건물은 방위별로 차단 여부가 다를 수 있습니다.",
      mode: "interactive",
      placement: "bottom",
      advanceOnTargetClick: true,
      // 폴리곤 미검출 건물은 단일 뷰라 탭바 자체가 없다 — [다음] 폴백 필수
      showNext: true,
    },
    {
      id: "ob-tab-right",
      target: '[data-tour="tm-los-tab-right"]',
      title: "우끝 방위 단면",
      body: "'우끝' 탭도 확인하세요.",
      mode: "interactive",
      placement: "bottom",
      advanceOnTargetClick: true,
      showNext: true,
    },
    {
      id: "ob-chart-zoom",
      target: '[data-tour="tm-los-chart"]',
      title: "단면도 확대",
      body:
        "차트 위에서 **마우스 휠**을 굴려 건물 주변을 확대해 보세요. " +
        "드래그로 좌우 이동, 헤더의 배율 배지(✕)로 원래 배율로 돌아옵니다.",
      mode: "interactive",
      placement: "bottom",
      // 줌 리셋 배지는 기본 배율에서 벗어날 때만 렌더 = "줌 했음" 신호
      advanceWhenSelectorAppears: '[data-tour="tm-los-zoom-badge"]',
      showNext: true,
    },
    {
      id: "ob-finish",
      title: "사전검토 완료",
      body:
        "건물 높이를 바꿔가며 차단 여부를 재확인하거나, 등록 장애물로 저장해 계속 추적할 수 있습니다.",
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

/** 시나리오 id → phase 별 스텝 레지스트리 */
const SCENARIO_PHASE_MAP: Record<string, Record<string, TourStep[]>> = {
  [SCENARIO_REPORT_TRACK]: REPORT_TRACK_PHASES,
  [SCENARIO_OBSTACLE_LOS]: OBSTACLE_LOS_PHASES,
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
  {
    id: SCENARIO_OBSTACLE_LOS,
    title: "장애물 전파영향성 사전검토",
    description:
      "신축 계획 건물이나 기존 장애물이 레이더 전파에 미치는 영향(LoS 차단 여부·허용높이)을 지도에서 " +
      "사전검토합니다. 주소검색으로 대상 건물을 찾아 LoS 단면도로 중앙·좌끝·우끝 방위의 차단 여부를 확인합니다.",
    stepsSummary: [
      "지도 창에서 LoS 분석 도구 열기",
      "주소검색으로 대상 건물 선택 (예: 개화동로 561)",
      "건물 카드에서 지반고·건물높이 확인 후 LoS 단면도 열기",
      "허용높이·차단 여부와 중앙/좌끝/우끝 방위 확인, 차트 휠 줌",
    ],
  },
];

/** 시나리오·phase 별 스텝 목록 */
export function getPhaseSteps(scenario: string, phase: string): TourStep[] {
  return SCENARIO_PHASE_MAP[scenario]?.[phase] ?? [];
}
