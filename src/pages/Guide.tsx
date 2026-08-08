import { BookOpen, Play } from "lucide-react";
import { TOUR_SCENARIOS } from "../tour/scenarios";
import { useTourStore } from "../tour/tourStore";

/**
 * 사용방법 — 시나리오별 투어 목록.
 * 투어는 실제 UI 요소를 하이라이트하며 창(메인 → 단일항적분석 → 지도)을 릴레이한다.
 */
export default function Guide() {
  const start = useTourStore((s) => s.start);
  const active = useTourStore((s) => s.active);

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
        {TOUR_SCENARIOS.map((sc) => (
          <div key={sc.id} className="rounded-xl border border-gray-200 bg-[#f8f9fa] p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <BookOpen size={16} className="shrink-0 text-[#a60739]" />
                  <h2 className="text-base font-semibold text-gray-800">{sc.title}</h2>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-gray-600">{sc.description}</p>
              </div>
              <button
                onClick={() => start(sc.id, "main")}
                disabled={active}
                className="flex shrink-0 items-center gap-2 rounded-lg bg-[#a60739] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#85062e] disabled:opacity-50"
              >
                <Play size={14} />
                <span>{active ? "투어 진행 중" : "투어 시작"}</span>
              </button>
            </div>

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
          </div>
        ))}
      </div>

      {/* 안내 */}
      <div className="space-y-1 text-xs text-gray-400">
        <p>투어 중 ESC 키 또는 ✕ 버튼으로 언제든 종료할 수 있습니다.</p>
        <p>시나리오는 계속 추가될 예정입니다.</p>
      </div>
    </div>
  );
}
