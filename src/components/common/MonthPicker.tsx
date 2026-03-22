import { useEffect, useRef, useState } from "react";
import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";

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

export default function MonthPicker({ value, onChange, className = "" }: MonthPickerProps) {
  const [open, setOpen] = useState(false);
  const selectedYear = parseInt(value.slice(0, 4), 10);
  const selectedMonth = parseInt(value.slice(5, 7), 10); // 1-based
  const [viewYear, setViewYear] = useState(selectedYear);
  const containerRef = useRef<HTMLDivElement>(null);

  const now = new Date();
  const todayYear = now.getFullYear();
  const todayMonth = now.getMonth() + 1;

  // 드롭다운 열릴 때 선택된 연도로 리셋
  useEffect(() => {
    if (open) setViewYear(selectedYear);
  }, [open, selectedYear]);

  // 외부 클릭 닫기
  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  // Escape 닫기
  useEffect(() => {
    if (!open) return;
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [open]);

  const handleSelect = (month: number) => {
    const mm = String(month).padStart(2, "0");
    onChange(`${viewYear}-${mm}`);
    setOpen(false);
  };

  const displayLabel = `${selectedYear}년 ${String(selectedMonth).padStart(2, "0")}월`;

  return (
    <div ref={containerRef} className={`relative inline-block ${className}`}>
      {/* 트리거 버튼 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-[12px] text-gray-700 transition-colors hover:border-gray-400 focus:border-[#a60739] focus:outline-none focus:ring-1 focus:ring-[#a60739]"
      >
        <Calendar size={13} className="text-gray-400" />
        <span className="font-medium">{displayLabel}</span>
        <ChevronDown
          size={13}
          className={`text-gray-400 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {/* 드롭다운 */}
      <div
        className={`absolute left-0 top-full z-[60] mt-1.5 w-[232px] origin-top rounded-xl border border-gray-200 bg-white p-3 shadow-lg transition-all duration-200 ${
          open
            ? "pointer-events-auto scale-100 opacity-100"
            : "pointer-events-none scale-95 opacity-0"
        }`}
      >
        {/* 연도 네비게이션 */}
        <div className="mb-2.5 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setViewYear((y) => y - 1)}
            className="rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
          >
            <ChevronLeft size={15} />
          </button>
          <span className="text-[13px] font-semibold text-gray-700 tabular-nums">
            {viewYear}년
          </span>
          <button
            type="button"
            onClick={() => setViewYear((y) => y + 1)}
            className="rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
          >
            <ChevronRight size={15} />
          </button>
        </div>

        {/* 월 그리드 4×3 */}
        <div className="grid grid-cols-4 gap-1">
          {MONTHS.map((label, idx) => {
            const m = idx + 1;
            const isSelected = viewYear === selectedYear && m === selectedMonth;
            const isToday = viewYear === todayYear && m === todayMonth;

            return (
              <button
                key={m}
                type="button"
                onClick={() => handleSelect(m)}
                className={`rounded-lg py-1.5 text-[11.5px] transition-all duration-150 ${
                  isSelected
                    ? "bg-[#a60739] font-semibold text-white shadow-sm shadow-[#a60739]/25"
                    : isToday
                      ? "font-medium text-[#a60739] ring-1 ring-[#a60739]/25 hover:bg-[#a60739]/5"
                      : "text-gray-600 hover:bg-gray-100 hover:text-gray-800"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
