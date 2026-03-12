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
  accent = "#e94560",
}: CardProps) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#16213e] p-5 transition-all hover:border-white/20">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-sm text-gray-400">{title}</p>
          <p className="mt-1 text-2xl font-bold text-white">{value}</p>
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
      className={`rounded-xl border border-white/10 bg-[#16213e] p-5 ${className}`}
    >
      {children}
    </div>
  );
}
