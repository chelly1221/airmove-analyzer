import { useState, useRef, useEffect, useCallback } from "react";

export interface DropdownOption {
  key: string;
  label: React.ReactNode;
  disabled?: boolean;
}

interface DropdownProps {
  trigger: React.ReactNode;
  options: (DropdownOption | "separator")[];
  selected?: string;
  onSelect: (key: string) => void;
  align?: "left" | "right";
  width?: string;
  maxHeight?: string;
  disabled?: boolean;
  className?: string;
}

export function Dropdown({
  trigger,
  options,
  selected,
  onSelect,
  align = "left",
  width = "w-56",
  maxHeight = "max-h-72",
  disabled = false,
  className = "",
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [focusIdx, setFocusIdx] = useState(-1);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const selectableOptions = options.filter(
    (o): o is DropdownOption => o !== "separator" && !o.disabled,
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!open) {
        if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
          e.preventDefault();
          setOpen(true);
          setFocusIdx(0);
        }
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusIdx((prev) => Math.min(prev + 1, selectableOptions.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusIdx((prev) => Math.max(prev - 1, 0));
      } else if (e.key === "Enter" && focusIdx >= 0) {
        e.preventDefault();
        onSelect(selectableOptions[focusIdx].key);
        setOpen(false);
      }
    },
    [open, focusIdx, selectableOptions, onSelect],
  );

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-1"
      >
        {trigger}
      </button>
      {open && (
        <div
          role="listbox"
          className={`absolute top-full z-50 mt-1 ${align === "right" ? "right-0" : "left-0"} ${width} ${maxHeight} overflow-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg`}
        >
          {options.map((opt, i) => {
            if (opt === "separator") {
              return <div key={`sep-${i}`} className="my-1 h-px bg-gray-200" />;
            }
            const isSelected = opt.key === selected;
            const isFocused =
              selectableOptions[focusIdx]?.key === opt.key;
            return (
              <button
                key={opt.key}
                type="button"
                role="option"
                aria-selected={isSelected}
                disabled={opt.disabled}
                onClick={() => {
                  onSelect(opt.key);
                  setOpen(false);
                }}
                className={`w-full px-3 py-1.5 text-left text-sm transition-colors ${
                  isSelected
                    ? "bg-[#a60739] font-medium text-white"
                    : isFocused
                      ? "bg-gray-100 text-gray-800"
                      : "text-gray-600 hover:bg-gray-100"
                } ${opt.disabled ? "cursor-not-allowed opacity-40" : ""}`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
