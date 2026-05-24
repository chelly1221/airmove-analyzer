import { useEffect, useRef, useState } from "react";
import { FileSpreadsheet, Loader2, ChevronDown } from "lucide-react";
import { EXPORT_LANGS, type ExportLang } from "../../utils/exportI18n";

/**
 * EXCEL 내보내기 버튼 — 클릭 시 언어(한국어/English)를 매번 선택하는 드롭다운.
 * 선택한 언어로 onExport(lang)를 호출한다.
 */
export function ExcelExportButton({
  onExport,
  disabled,
  busy,
  title,
  size = "md",
}: {
  onExport: (lang: ExportLang) => void;
  disabled?: boolean;
  busy?: boolean;
  title?: string;
  size?: "md" | "sm";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const sz = size === "sm" ? "h-7 px-3 text-[11px] rounded-md" : "px-3 py-1.5 text-[12px] rounded-lg";
  const icon = size === "sm" ? 12 : 14;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || busy}
        title={title ?? "Excel(.xlsx)로 내보내기 — 언어 선택"}
        className={`inline-flex items-center gap-1.5 border border-emerald-600/30 bg-white font-medium text-emerald-700 transition-colors hover:bg-emerald-50 disabled:opacity-50 ${sz}`}
      >
        {busy ? <Loader2 size={icon} className="animate-spin" /> : <FileSpreadsheet size={icon} />}
        EXCEL
        <ChevronDown size={size === "sm" ? 11 : 12} className="text-emerald-700/60" />
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+4px)] z-50 min-w-[140px] overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
          {EXPORT_LANGS.map((l) => (
            <button
              key={l.id}
              onClick={() => {
                setOpen(false);
                onExport(l.id);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-gray-700 transition-colors hover:bg-emerald-50 hover:text-emerald-700"
            >
              <FileSpreadsheet size={12} className="text-emerald-600/70" />
              {l.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
