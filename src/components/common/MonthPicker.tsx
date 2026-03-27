import { useCallback, useRef, useState, useEffect } from "react";

interface MonthPickerProps {
  value: string; // "YYYY-MM"
  onChange: (value: string) => void;
  className?: string;
}

const MONTHS = [
  "1월", "2월", "3월", "4월",
  "5월", "6월", "7월", "8월",
  "9월", "10월", "11월", "12월",
];

/** 연도 카드 1장 높이(px) */
const CARD_H = 192;

/**
 * 인라인 월 선택 컴포넌트.
 * 연도별 4×3 월 그리드 카드가 세로 드럼 휠로 회전.
 * 스크롤/드래그로 연도 전환, 모멘텀 + 스냅 애니메이션.
 */
export default function MonthPicker({ value, onChange, className = "" }: MonthPickerProps) {
  const selectedYear = parseInt(value.slice(0, 4), 10);
  const selectedMonth = parseInt(value.slice(5, 7), 10);

  const now = new Date();
  const todayYear = now.getFullYear();
  const todayMonth = now.getMonth() + 1;

  // --- refs for 60fps animation (no React state in hot path) ---
  const scrollY = useRef(0);        // 연속 스크롤 위치 (px). 양수 = 미래 방향(연도 증가)
  const velocity = useRef(0);
  const dragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartScroll = useRef(0);
  const lastPtrY = useRef(0);
  const lastPtrTime = useRef(0);
  const animId = useRef(0);
  const stripEl = useRef<HTMLDivElement>(null);

  // 최신 props를 rAF 콜백에서 참조하기 위한 ref
  const yearRef = useRef(selectedYear);
  const monthRef = useRef(selectedMonth);
  const onChangeRef = useRef(onChange);
  yearRef.current = selectedYear;
  monthRef.current = selectedMonth;
  onChangeRef.current = onChange;

  // 연도 변경 시 scrollY 리셋 (외부에서 value가 바뀐 경우)
  const prevYear = useRef(selectedYear);
  if (prevYear.current !== selectedYear) {
    scrollY.current = 0;
    prevYear.current = selectedYear;
  }

  // 강제 리렌더 (opacity/scale/active 표시 갱신용)
  const [, setTick] = useState(0);
  const rerender = useCallback(() => setTick((t) => t + 1), []);

  /** DOM에 transform 직접 적용 (state 거치지 않음) */
  const applyTransform = useCallback(() => {
    if (stripEl.current) {
      stripEl.current.style.transform = `translateY(${-scrollY.current}px)`;
    }
  }, []);

  /** 모멘텀 + 스냅 애니메이션 */
  const runSnap = useCallback(() => {
    cancelAnimationFrame(animId.current);

    const tick = () => {
      let pos = scrollY.current;
      let vel = velocity.current;

      // 모멘텀 (부드러운 마찰)
      if (Math.abs(vel) > 0.3) {
        pos += vel;
        vel *= 0.94;
      } else {
        vel = 0;
      }

      // 연도 범위 제한 없이 자유 스크롤

      // 가장 가까운 CARD_H 배수로 부드러운 스프링
      const snapTarget = Math.round(pos / CARD_H) * CARD_H;
      const diff = snapTarget - pos;
      if (Math.abs(vel) < 2) {
        pos += diff * 0.08;
        vel *= 0.6;
      }

      scrollY.current = pos;
      velocity.current = vel;
      applyTransform();
      rerender(); // opacity/scale/isActive 매 프레임 갱신

      // 수렴 판정
      if (Math.abs(snapTarget - pos) < 0.5 && Math.abs(vel) < 0.3) {
        scrollY.current = snapTarget;
        applyTransform();

        // 연도 커밋
        const steps = Math.round(snapTarget / CARD_H);
        if (steps !== 0) {
          const newYear = yearRef.current + steps;
          scrollY.current = 0;
          prevYear.current = newYear;
          onChangeRef.current(`${newYear}-${String(monthRef.current).padStart(2, "0")}`);
        }
        rerender();
        return;
      }

      animId.current = requestAnimationFrame(tick);
    };

    animId.current = requestAnimationFrame(tick);
  }, [applyTransform, rerender]);

  // 휠 — 아래로 스크롤 = 미래(연도 증가)
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    cancelAnimationFrame(animId.current);
    scrollY.current += e.deltaY * 0.35;
    velocity.current = Math.max(-25, Math.min(25, velocity.current + e.deltaY * 0.1));
    applyTransform();
    runSnap();
  }, [applyTransform, runSnap]);

  // 포인터 드래그
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    cancelAnimationFrame(animId.current);
    dragging.current = true;
    dragStartY.current = e.clientY;
    dragStartScroll.current = scrollY.current;
    velocity.current = 0;
    lastPtrY.current = e.clientY;
    lastPtrTime.current = performance.now();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dy = e.clientY - dragStartY.current;
    scrollY.current = dragStartScroll.current - dy;

    // 속도 추적
    const t = performance.now();
    const dt = t - lastPtrTime.current;
    if (dt > 4) {
      velocity.current = -(e.clientY - lastPtrY.current) / dt * 16;
      lastPtrY.current = e.clientY;
      lastPtrTime.current = t;
    }

    applyTransform();
    rerender(); // opacity/scale 갱신
  }, [applyTransform, rerender]);

  const handlePointerUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    runSnap();
  }, [runSnap]);

  // 월 클릭: 해당 연도로 즉시 이동
  const handleMonthClick = useCallback((year: number, month: number) => {
    cancelAnimationFrame(animId.current);
    scrollY.current = 0;
    velocity.current = 0;
    prevYear.current = year;
    applyTransform();
    onChangeRef.current(`${year}-${String(month).padStart(2, "0")}`);
    rerender();
  }, [applyTransform, rerender]);

  // cleanup
  useEffect(() => () => cancelAnimationFrame(animId.current), []);

  // --- 렌더링 ---
  const curScroll = scrollY.current;
  const years: number[] = [];
  const extraCards = Math.ceil(Math.abs(curScroll) / CARD_H) + 3;
  for (let i = -extraCards; i <= extraCards; i++) years.push(selectedYear + i);

  return (
    <div
      className={`w-[260px] select-none cursor-grab active:cursor-grabbing ${className}`}
      style={{ height: CARD_H, overflow: "hidden", position: "relative" }}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {/* 상하 페이드 마스크 */}
      <div
        className="pointer-events-none absolute inset-0 z-10"
        style={{ background: "linear-gradient(to bottom, white 0%, transparent 20%, transparent 80%, white 100%)" }}
      />

      {/* 카드 스트립 — transform은 ref로 직접 제어 */}
      <div ref={stripEl} className="absolute left-0 right-0 will-change-transform" style={{ transform: `translateY(${-curScroll}px)` }}>
        {years.map((y) => {
          // 카드 중심의 뷰포트 내 거리 계산
          const cardTop = (y - selectedYear) * CARD_H;
          const cardCenter = cardTop + CARD_H / 2;
          const viewCenter = curScroll + CARD_H / 2;
          const dist = Math.abs(cardCenter - viewCenter);
          const norm = Math.min(dist / CARD_H, 1.5);
          const opacity = Math.max(1 - norm * 0.55, 0);
          const scale = Math.max(1 - norm * 0.05, 0.88);
          const isActive = dist < CARD_H * 0.4;

          return (
            <div
              key={y}
              className="absolute left-0 right-0 px-3"
              style={{
                top: cardTop,
                height: CARD_H,
                opacity,
                transform: `scale(${scale})`,
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                willChange: "opacity, transform",
              }}
            >
              {/* 연도 라벨 */}
              <div className="mb-2 text-center">
                <span className={`tabular-nums text-[13px] font-bold transition-colors duration-200 ${isActive ? "text-[#a60739]" : "text-gray-300"}`}>
                  {y}년
                </span>
              </div>
              {/* 월 그리드 4×3 */}
              <div className="grid grid-cols-4 gap-1.5">
                {MONTHS.map((label, mi) => {
                  const m = mi + 1;
                  const isSelected = isActive && y === selectedYear && m === selectedMonth;
                  const isToday = y === todayYear && m === todayMonth;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => handleMonthClick(y, m)}
                      className={`rounded-xl py-2 text-[12px] font-medium transition-all duration-150 ${
                        isSelected
                          ? "bg-[#a60739] text-white shadow-sm shadow-[#a60739]/25"
                          : isToday
                            ? "text-[#a60739] ring-1 ring-inset ring-[#a60739]/30 hover:bg-[#a60739]/5"
                            : "text-gray-600 hover:bg-gray-100 hover:text-gray-800"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
