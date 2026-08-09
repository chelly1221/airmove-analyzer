import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { X } from "lucide-react";
import ParseFilterModal from "../components/common/ParseFilterModal";
import { useAppStore } from "../store";
import { useTourStore } from "./tourStore";
import TourFakeFileDialog from "./TourFakeFileDialog";
import type { FakeFile } from "./TourFakeFileDialog";
import TourFakeImportConfirm from "./TourFakeImportConfirm";
import { clearTourState, getPhaseSteps, phaseWindow, readTourState } from "./scenarios";
import type { TourPlacement, TourWindow } from "./types";
import type { Aircraft } from "../types";

const CARD_W = 340;
/** 배치 계산용 카드 높이 추정치 — 실측 없이 뷰포트 클램프에만 사용 */
const CARD_H_EST = 180;
const MARGIN = 8;
/** 대상 위치 재측정 주기 — 포탈 1프레임 지연·레이아웃 변화 양쪽을 커버 */
const MEASURE_MS = 200;
/** 셀렉터 등장 감지 폴링 주기 (드롭다운 패널) */
const APPEAR_MS = 150;
/** 대상 소실 후 복귀까지 디바운스 — 재렌더 순간 공백 오탐 방지 */
const RETREAT_MS = 400;

/** 등록 기체가 없을 때 파싱 필터 데모에 쓰는 예시 기체 */
const DEMO_AIRCRAFT: Aircraft[] = [
  {
    id: "tour-demo",
    name: "비행검사기(예시)",
    registration: "HL0000",
    model: "Embraer Praetor 600",
    mode_s_code: "71BF79",
    organization: "비행점검센터",
    memo: "투어 시뮬레이션용 예시 자료",
    active: true,
  },
];

/** 가상 백업 파일 목록 (실제 자료 아님) */
const FAKE_BACKUP_FILES: FakeFile[] = [
  { name: "airmove-backup-2026-07-15.zip", modified: "2026-07-15 오후 6:12", size: "1.8 GB" },
  { name: "airmove-backup-2026-06-30.zip", modified: "2026-06-30 오후 5:41", size: "1.6 GB" },
];
const BACKUP_PATH = ["내 PC", "문서", "백업"];

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function sameRect(a: Rect | null, b: Rect | null) {
  if (!a || !b) return a === b;
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

/** `**강조**` 마크업만 <b> 로 렌더 */
function renderBody(text: string) {
  return text.split("**").map((part, i) =>
    i % 2 === 1
      ? <b key={i} className="font-semibold text-gray-800">{part}</b>
      : <span key={i}>{part}</span>
  );
}

/** 툴팁 카드 배치 — 대상 오른쪽(드롭다운 팝업 회피) 우선, 공간 부족 시 아래/위 */
function anchoredStyle(rect: Rect, placement?: TourPlacement): CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (placement === "right" && rect.left + rect.width + 12 + CARD_W <= vw - MARGIN) {
    const top = Math.min(Math.max(rect.top, MARGIN), Math.max(MARGIN, vh - CARD_H_EST - MARGIN));
    return { left: rect.left + rect.width + 12, top };
  }
  const left = Math.min(Math.max(rect.left, MARGIN), Math.max(MARGIN, vw - CARD_W - MARGIN));
  const below = rect.top + rect.height + 12;
  if (below + CARD_H_EST <= vh - MARGIN) return { left, top: below };
  // 아래 공간 부족 → 대상 위로
  return { left, bottom: Math.max(MARGIN, vh - rect.top + 12) };
}

/**
 * 시나리오 투어 오버레이 — 각 창 루트에 1개만 마운트한다.
 * 창 릴레이는 tour_state(DB 플래그, 새 창 생성 경로) + emit(이미 열린 창 경로) 이중 경로.
 */
export default function TourHost({ window: win }: { window: TourWindow }) {
  const active = useTourStore((s) => s.active);
  const scenario = useTourStore((s) => s.scenario);
  const phase = useTourStore((s) => s.phase);
  const stepIndex = useTourStore((s) => s.stepIndex);
  const waiting = useTourStore((s) => s.waiting);
  const end = useTourStore((s) => s.end);

  const steps = useMemo(
    () => (active && scenario && phase ? getPhaseSteps(scenario, phase) : []),
    [active, scenario, phase],
  );
  const step = steps[stepIndex];

  const [rect, setRect] = useState<Rect | null>(null);

  // ─── 크로스윈도우 시동 ──────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    const startIfMine = (p: { scenario?: string; phase?: string } | null) => {
      if (cancelled || !p?.scenario || !p.phase) return;
      if (phaseWindow(p.phase) !== win) return;
      // emit 경로로 시동된 경우 DB 플래그가 남아 창을 닫았다 다시 열면 phase 가 재시작된다 —
      // 게이트를 통과한 시점에 항상 클리어 (마운트 경로의 이중 클리어는 무해)
      void clearTourState();
      useTourStore.getState().start(p.scenario, p.phase);
    };

    // 새로 생성된 창: emit 시점에 리스너가 없으므로 DB 플래그로 시동 (소비 즉시 클리어)
    if (win !== "main") {
      (async () => {
        const st = await readTourState();
        if (cancelled) return;
        if (!st) return;
        if (phaseWindow(st.phase) !== win) return;
        await clearTourState();
        startIfMine(st);
      })();
    }

    // 이미 열려 있던 창: 이벤트로 시동. main 은 drawing 창의 릴레이만 수신한다.
    const evt = win === "main" ? "tour:relay" : "tour:start";
    const unlisten = listen<{ scenario?: string; phase?: string }>(evt, (e) => startIfMine(e.payload));

    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  }, [win]);

  // ─── 대상 측정 (없으면 나타날 때까지 폴링) + 대상 소실 시 복귀 ───────
  useEffect(() => {
    const target = step?.target;
    if (!active || !target || step?.mode !== "interactive" || waiting) {
      setRect(null);
      return;
    }
    // 복귀 판정은 rect state 가 아니라 측정 루프 지역 변수로 — state 는 한 렌더 지연돼 오탐한다
    const retreatId = step.retreatToOnTargetLost;
    const autoScroll = !!step.scrollIntoView;
    let seen = false;
    let lostAt = 0;
    let retreated = false;
    // 설정 페이지처럼 스크롤 컨테이너 아래에 있는 대상을 자동 노출 (스텝당 1회)
    let scrolled = false;
    const measure = () => {
      const el = document.querySelector(target);
      if (autoScroll && el && !scrolled) {
        scrolled = true;
        el.scrollIntoView({ block: "center" });
      }
      const r = el ? el.getBoundingClientRect() : null;
      const next: Rect | null = r ? { top: r.top, left: r.left, width: r.width, height: r.height } : null;
      setRect((prev) => (sameRect(prev, next) ? prev : next));
      if (!retreatId || retreated) return;
      if (next) {
        seen = true;
        lostAt = 0;
        return;
      }
      if (!seen) return; // 아직 한 번도 못 잡음 — 등장 대기 중
      if (!lostAt) {
        lostAt = Date.now();
        return;
      }
      if (Date.now() - lostAt >= RETREAT_MS) {
        retreated = true;
        useTourStore.getState().goTo(retreatId);
      }
    };
    measure();
    const timer = window.setInterval(measure, MEASURE_MS);
    window.addEventListener("resize", measure);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", measure);
    };
  }, [active, step, waiting]);

  // ─── 셀렉터 등장 자동 진행 (드롭다운 패널 열림 감지) ─────────────────
  useEffect(() => {
    const selector = step?.advanceWhenSelectorAppears;
    if (!active || !selector) return;
    let done = false;
    const check = () => {
      if (done) return;
      if (!document.querySelector(selector)) return;
      done = true;
      useTourStore.getState().advance();
    };
    const timer = window.setInterval(check, APPEAR_MS);
    return () => window.clearInterval(timer);
  }, [active, step]);

  // ─── 대상 클릭 감지 자동 진행 ───────────────────────────────────────
  useEffect(() => {
    if (!active || !step?.target || waiting) return;
    if (!step.advanceOnTargetClick && !step.interceptClick) return;
    const target = step.target;
    const intercept = !!step.interceptClick;
    // 더블클릭(빠른 2연타)이면 setTimeout advance 가 2회 예약돼 다음 스텝이 스킵된다 —
    // 스텝당 1회만 발화 (스텝 변경 시 이펙트 재등록으로 자연 리셋)
    let fired = false;
    const onClick = (e: MouseEvent) => {
      if (fired) return;
      const el = e.target as Element | null;
      if (!el?.closest?.(target)) return;
      fired = true;
      if (intercept) {
        // document 캡처는 React 루트 리스너보다 먼저 실행 — 전파를 끊으면 실제 onClick
        // (네이티브 파일 다이얼로그 open)이 실행되지 않는다. 대신 시뮬레이션으로 진행.
        e.stopPropagation();
        e.preventDefault();
        useTourStore.getState().advance();
        return;
      }
      // 캡처 단계라 원래 핸들러보다 먼저 실행됨 — 다음 틱으로 미뤄 실제 동작을 보장
      window.setTimeout(() => {
        if (step.waitAfterClick) useTourStore.getState().setWaiting(true);
        else useTourStore.getState().advance();
      }, 0);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [active, step, waiting]);

  // ─── 스토어 조건 자동 진행 (baseline = 스텝 진입 시점 스냅샷) ────────
  useEffect(() => {
    if (!active || !step?.advanceWhen) return;
    const advanceWhen = step.advanceWhen;
    const baseline = useAppStore.getState();
    // 구독 콜백은 set 마다 동기 호출되고 이펙트 cleanup 은 커밋 시점에야 돌므로,
    // 한 틱에 set 이 연달아 일어나면(통합 종료 시 consolidating/progress 연속 set 등)
    // 조건이 참인 채로 2회 이상 발화해 스텝을 건너뛴다 — 스텝당 1회만 진행
    let done = false;
    return useAppStore.subscribe((s) => {
      if (done) return;
      if (advanceWhen(s, baseline)) {
        done = true;
        useTourStore.getState().advance();
      }
    });
  }, [active, step]);

  // ─── ESC 종료 (오버레이 스텝은 오버레이 자신의 취소 경로가 처리) ─────
  useEffect(() => {
    if (!active || step?.overlay) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useTourStore.getState().end();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, step]);

  // ─── 시뮬레이션 오버레이 ────────────────────────────────────────────
  const overlay = active ? step?.overlay : undefined;
  const overlayCancelGoTo = step?.overlayCancelGoTo;

  // 등록 기체가 없으면 예시 기체로 데모 (오버레이 표시 시점에 1회 평가 — 대량 데이터 접근 없음)
  const demoAircraft = useMemo<Aircraft[]>(() => {
    if (overlay !== "parseFilter") return DEMO_AIRCRAFT;
    const list = useAppStore.getState().aircraft;
    return list.some((a) => a.active) ? list : DEMO_AIRCRAFT;
  }, [overlay]);

  /** 오버레이 취소 → 지정 스텝으로 복귀 (없으면 투어 종료) */
  const cancelOverlay = () => {
    if (overlayCancelGoTo) useTourStore.getState().goTo(overlayCancelGoTo);
    else useTourStore.getState().end();
  };

  /** 파싱 시작(데모) → 파싱 없이 parseFilter 구간 다음 스텝으로 점프 */
  const confirmParseFilter = () => {
    const st = useTourStore.getState();
    const list = st.scenario && st.phase ? getPhaseSteps(st.scenario, st.phase) : [];
    let last = -1;
    for (let i = 0; i < list.length; i++) {
      if (list[i].overlay === "parseFilter") last = i;
    }
    const next = list[last + 1];
    if (next) st.goTo(next.id);
    else st.advance();
  };

  if (!active || !step) return null;

  const anchored = step.mode === "interactive" && !waiting && !!rect;
  const bodyText = waiting && step.waitBody ? step.waitBody : step.body;
  // 대기 상태에서는 자동 진행이 실패해도 빠져나올 수 있도록 [다음] 폴백을 항상 노출
  const showNext = !!step.showNext || waiting;

  const cardStyle: CSSProperties =
    step.mode === "dim"
      ? { left: "50%", top: "50%", transform: "translate(-50%, -50%)" }
      : anchored
        ? anchoredStyle(rect!, step.placement)
        : { right: 24, bottom: 24 };

  return createPortal(
    <>
      {/* 시뮬레이션 오버레이 — key 를 overlay 값으로 두어 연속 스텝에서는 상태를 보존 */}
      {overlay === "fileDialog" && (
        <TourFakeFileDialog
          key="fileDialog"
          onPick={() => useTourStore.getState().advance()}
          onOpen={() => useTourStore.getState().advance()}
          onCancel={cancelOverlay}
        />
      )}
      {overlay === "parseFilter" && (
        <ParseFilterModal
          key="parseFilter"
          open
          onClose={cancelOverlay}
          onConfirm={confirmParseFilter}
          aircraft={demoAircraft}
        />
      )}
      {overlay === "backupSaveDialog" && (
        <TourFakeFileDialog
          key="backupSaveDialog"
          mode="save"
          files={FAKE_BACKUP_FILES}
          pathSegments={BACKUP_PATH}
          filterLabel="AirMove 백업 (*.zip)"
          defaultName={`airmove-backup-${new Date().toISOString().slice(0, 10)}.zip`}
          onPick={() => {}}
          onOpen={() => useTourStore.getState().advance()}
          onCancel={cancelOverlay}
        />
      )}
      {overlay === "backupOpenDialog" && (
        <TourFakeFileDialog
          key="backupOpenDialog"
          files={FAKE_BACKUP_FILES}
          pathSegments={BACKUP_PATH}
          filterLabel="AirMove 백업 (*.zip, *.db)"
          onPick={() => useTourStore.getState().advance()}
          onOpen={() => useTourStore.getState().advance()}
          onCancel={cancelOverlay}
        />
      )}
      {overlay === "backupConfirm" && (
        <TourFakeImportConfirm
          key="backupConfirm"
          onConfirm={() => useTourStore.getState().advance()}
          onCancel={cancelOverlay}
        />
      )}

      {/* 인트로/완료 카드 — 전체 딤 */}
      {step.mode === "dim" && <div className="fixed inset-0 z-[10010] bg-black/45" />}

      {/* 대상 하이라이트 링 — 9999px spread 그림자가 딤 역할을 하되 클릭은 막지 않는다 */}
      {anchored && (
        <div
          className="tour-ring pointer-events-none fixed z-[10010] rounded-lg border-2 border-[#a60739]"
          style={{ left: rect!.left - 4, top: rect!.top - 4, width: rect!.width + 8, height: rect!.height + 8 }}
        />
      )}

      {/* 안내 카드 */}
      <div
        className="pointer-events-auto fixed z-[10011] w-[340px] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl"
        style={cardStyle}
      >
        <div className="h-1 w-full bg-[#a60739]" />
        <div className="relative p-4">
          <button
            onClick={end}
            className="absolute right-3 top-3 rounded p-0.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            aria-label="투어 종료"
            title="투어 종료 (ESC)"
          >
            <X size={14} />
          </button>
          <div className="pr-6 text-sm font-semibold text-gray-900">{step.title}</div>
          <p className="mt-1.5 text-xs leading-relaxed text-gray-600">{renderBody(bodyText)}</p>
          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="text-[11px] text-gray-400">
              {stepIndex + 1}/{steps.length}
            </span>
            {showNext ? (
              <button
                onClick={() => useTourStore.getState().advance()}
                className="rounded-lg bg-[#a60739] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#85062e]"
              >
                {step.nextLabel ?? "다음"}
              </button>
            ) : (
              <span className="text-[11px] text-[#a60739]">클릭하면 다음 단계로 진행됩니다</span>
            )}
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
