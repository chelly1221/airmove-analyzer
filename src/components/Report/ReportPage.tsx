import { forwardRef, type ReactNode } from "react";

interface ReportPageProps {
  children: ReactNode;
  className?: string;
}

/** A4 비율 페이지 래퍼 (210×297mm) */
const ReportPage = forwardRef<HTMLDivElement, ReportPageProps>(
  ({ children, className = "" }, ref) => (
    <div
      ref={ref}
      data-page
      className={`relative mx-auto mb-6 bg-white shadow-xl ${className}`}
      style={{
        width: "210mm",
        minHeight: "297mm",
        padding: "12mm 14mm",
        boxSizing: "border-box",
      }}
    >
      {children}
    </div>
  )
);

ReportPage.displayName = "ReportPage";
export default ReportPage;
