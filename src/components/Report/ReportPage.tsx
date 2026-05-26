import { createContext, forwardRef, useContext, type ReactNode } from "react";

interface ReportPageProps {
  children: ReactNode;
  className?: string;
  /** 표지 페이지 — 머리띠/페이지 번호/페이지 padding 제거 */
  isCover?: boolean;
  /** 머리띠 텍스트 직접 지정 (선택). 없으면 Context 값을 사용. */
  pageHeader?: string;
  /**
   * 사이드바 목차에서 이 페이지로 점프하기 위한 anchor 키.
   * `data-toc-key` 속성으로 노출되며, OM 사이드바가 IntersectionObserver
   * 로 active 페이지 탐지 + scrollIntoView 점프에 사용.
   * 한 섹션이 여러 페이지를 차지하면 첫 페이지에만 지정한다.
   */
  tocKey?: string;
}

/**
 * 상위에서 보고서 페이지 머리띠 텍스트를 주입하는 컨텍스트.
 * ReportPreviewContent 가 템플릿별 머리띠 문구를 한 번 설정한다.
 */
const PageHeaderContext = createContext<string | undefined>(undefined);
export const ReportPageHeaderProvider = PageHeaderContext.Provider;

/**
 * A4 보고서 페이지 래퍼 (210×297mm).
 *
 * 외곽 스타일·머리띠·페이지 번호 CSS counter 는 reportOmStyles.css 의
 * `.kac-report .report-page` 스코프에서 처리. 머리띠 텍스트는
 * `data-page-header` 속성 → CSS `attr()` 로 표시.
 *
 * 표지에는 isCover=true 를 주어 머리띠/페이지번호/inner padding 제거.
 */
const ReportPage = forwardRef<HTMLDivElement, ReportPageProps>(
  ({ children, className = "", isCover, pageHeader, tocKey }, ref) => {
    const ctxHeader = useContext(PageHeaderContext);
    const headerText = !isCover ? (pageHeader ?? ctxHeader) : undefined;
    return (
      <div
        ref={ref}
        data-page
        data-page-header={headerText || undefined}
        data-toc-key={tocKey || undefined}
        className={`report-page${isCover ? " is-cover" : ""}${className ? ` ${className}` : ""}`}
      >
        <div className="report-page-inner">{children}</div>
        <div className="page-num" />
      </div>
    );
  },
);

ReportPage.displayName = "ReportPage";
export default ReportPage;
