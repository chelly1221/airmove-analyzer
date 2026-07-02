import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
  /** false이면 배경 클릭/ESC/헤더 X 로 닫히지 않음 (호출부가 제공하는 버튼으로만 닫기) */
  closable?: boolean;
}

export default function Modal({
  open,
  onClose,
  title,
  children,
  width = "max-w-lg",
  closable = true,
}: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const mouseDownTargetRef = useRef<EventTarget | null>(null);
  const titleId = useId();

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && closable) onCloseRef.current();
    };
    document.addEventListener("keydown", handleEsc);
    dialogRef.current?.focus();
    return () => document.removeEventListener("keydown", handleEsc);
  }, [open, closable]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onMouseDown={(e) => {
        mouseDownTargetRef.current = e.target;
      }}
      onClick={(e) => {
        if (closable && e.target === overlayRef.current && mouseDownTargetRef.current === overlayRef.current) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`${width} w-full mx-4 rounded-xl border border-gray-200 bg-white shadow-xl outline-none`}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <h2 id={titleId} className="text-lg font-semibold text-gray-800">{title}</h2>
          {/* closable=false 면 X 미표시 — 정리 로직 없는 즉시 onClose(창 destroy 등) 우회 경로 차단 */}
          {closable && (
            <button
              onClick={onClose}
              className="rounded-lg p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900 transition-colors"
              aria-label="닫기"
            >
              <X size={20} />
            </button>
          )}
        </div>
        <div className="px-6 py-4">{children}</div>
      </div>
    </div>
  );
}
