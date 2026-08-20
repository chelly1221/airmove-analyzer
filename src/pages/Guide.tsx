import { useState } from "react";
import { BookOpen, ChevronDown, Play } from "lucide-react";
import { TOUR_SCENARIOS } from "../tour/scenarios";
import { useTourStore } from "../tour/tourStore";

/**
 * 사용방법 — 시나리오별 투어 목록.
 * 투어는 실제 UI 요소를 하이라이트하며 창(메인 → 2D 항적현시 → 지도)을 릴레이한다.
 * 각 시나리오 카드는 아코디언이며 최초에는 전부 접힌 상태다.
 */
export default function Guide() {
  const start = useTourStore((s) => s.start);
  const active = useTourStore((s) => s.active);

  // 펼쳐진 시나리오 id 집합 — 초기값 전부 닫힘(여러 개 동시 열기 허용)
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());

  const toggle = (id: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-800">사용방법</h1>
        <p className="mt-1 text-sm text-gray-500">
          업무 시나리오별 안내 투어를 제공합니다. 화면의 실제 버튼을 순서대로 짚어 줍니다.
        </p>
      </div>

      {/* 시나리오 목록 */}
      <div className="space-y-4">
        {TOUR_SCENARIOS.map((sc) => {
          const open = openIds.has(sc.id);
          return (
            <div key={sc.id} className="rounded-xl border border-gray-200 bg-[#f8f9fa] p-5">
              {/* 헤더 — 클릭 시 아코디언 토글 */}
              <div
                role="button"
                tabIndex={0}
                aria-expanded={open}
                onClick={() => toggle(sc.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggle(sc.id);
                  }
                }}
                className="flex cursor-pointer items-center justify-between gap-4"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <BookOpen size={16} className="shrink-0 text-[#a60739]" />
                  <h2 className="text-base font-semibold text-gray-800">{sc.title}</h2>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <ChevronDown
                    size={18}
                    className={`text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
                  />
                  <button
                    onClick={(e) => {
                      e.stopPropagation(); // 투어 시작은 아코디언 토글과 분리
                      start(sc.id, "main");
                    }}
                    disabled={active}
                    className="flex shrink-0 items-center gap-2 rounded-lg bg-[#a60739] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#85062e] disabled:opacity-50"
                  >
                    <Play size={14} />
                    <span>{active ? "투어 진행 중" : "투어 시작"}</span>
                  </button>
                </div>
              </div>

              {open && (
                <>
                  <p className="mt-3 text-sm leading-relaxed text-gray-600">{sc.description}</p>

                  {/* 진행 순서 요약 */}
                  <ol className="mt-4 space-y-1.5 border-t border-gray-200 pt-4">
                    {sc.stepsSummary.map((s, i) => (
                      <li key={i} className="flex items-start gap-2.5 text-sm text-gray-600">
                        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white text-[11px] font-semibold text-[#a60739] ring-1 ring-gray-200">
                          {i + 1}
                        </span>
                        <span>{s}</span>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* 안내 */}
      <div className="space-y-1 text-xs text-gray-400">
        <p>투어 중 ESC 키 또는 ✕ 버튼으로 언제든 종료할 수 있습니다.</p>
        <p>시나리오는 계속 추가될 예정입니다.</p>
      </div>
    </div>
  );
}
