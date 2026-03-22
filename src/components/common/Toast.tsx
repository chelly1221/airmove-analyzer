import { create } from "zustand";
import { X } from "lucide-react";

interface ToastItem {
  id: string;
  message: string;
  type: "error" | "warning" | "success" | "info";
}

interface ToastState {
  toasts: ToastItem[];
  addToast: (message: string, type?: ToastItem["type"]) => void;
  removeToast: (id: string) => void;
}

const DEDUP_MS = 3000;
const AUTO_DISMISS_MS = 5000;
const lastMessages: Map<string, number> = new Map();

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  addToast: (message, type = "error") => {
    const now = Date.now();
    const lastTime = lastMessages.get(message);
    if (lastTime && now - lastTime < DEDUP_MS) return;
    lastMessages.set(message, now);

    const id = crypto.randomUUID();
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }));
    setTimeout(
      () => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
      AUTO_DISMISS_MS,
    );
  },
  removeToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

const TYPE_STYLES: Record<ToastItem["type"], string> = {
  error: "border-red-400 bg-red-50 text-red-800",
  warning: "border-amber-400 bg-amber-50 text-amber-800",
  success: "border-green-400 bg-green-50 text-green-800",
  info: "border-blue-400 bg-blue-50 text-blue-800",
};

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[10000] flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-start gap-2 rounded-lg border px-4 py-3 shadow-lg transition-all ${TYPE_STYLES[t.type]}`}
        >
          <span className="flex-1 text-sm">{t.message}</span>
          <button
            onClick={() => removeToast(t.id)}
            className="shrink-0 opacity-60 hover:opacity-100"
            aria-label="닫기"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
