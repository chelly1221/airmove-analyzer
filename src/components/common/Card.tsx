import type { ReactNode } from "react";
interface SimpleCardProps {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}

export function SimpleCard({ children, className = "", onClick }: SimpleCardProps) {
  return (
    <div
      className={`rounded-xl border border-gray-200 bg-gray-50 p-5 ${className}`}
      onClick={onClick}
    >
      {children}
    </div>
  );
}
