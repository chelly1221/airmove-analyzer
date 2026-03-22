import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  compact?: boolean;
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center text-center ${compact ? "py-4" : "py-12"}`}
    >
      <Icon
        size={compact ? 24 : 36}
        className="mb-2 text-gray-300"
        strokeWidth={1.5}
      />
      <p
        className={`font-medium text-gray-400 ${compact ? "text-xs" : "text-sm"}`}
      >
        {title}
      </p>
      {description && (
        <p
          className={`mt-1 text-gray-400 ${compact ? "text-[10px]" : "text-xs"}`}
        >
          {description}
        </p>
      )}
      {action && (
        <button
          onClick={action.onClick}
          className="mt-3 rounded-lg bg-gray-100 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-200"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
