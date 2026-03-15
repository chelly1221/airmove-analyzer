import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

interface CardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: LucideIcon;
  accent?: string;
}

export default function Card({
  title,
  value,
  subtitle,
  icon: Icon,
  accent = "#a60739",
}: CardProps) {
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-5 transition-all hover:border-gray-300">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-sm text-gray-500">{title}</p>
          <p className="mt-1 text-2xl font-bold text-gray-800">{value}</p>
          {subtitle && (
            <p className="mt-1 text-xs text-gray-500">{subtitle}</p>
          )}
        </div>
        {Icon && (
          <div
            className="flex h-10 w-10 items-center justify-center rounded-lg"
            style={{ backgroundColor: `${accent}20` }}
          >
            <Icon size={20} style={{ color: accent }} />
          </div>
        )}
      </div>
    </div>
  );
}

interface SimpleCardProps {
  children: ReactNode;
  className?: string;
}

export function SimpleCard({ children, className = "" }: SimpleCardProps) {
  return (
    <div
      className={`rounded-xl border border-gray-200 bg-gray-50 p-5 ${className}`}
    >
      {children}
    </div>
  );
}
