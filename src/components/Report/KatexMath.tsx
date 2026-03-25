import React, { useMemo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

interface KatexMathProps {
  /** LaTeX 수식 문자열 */
  math: string;
  /** 블록(display) 또는 인라인 모드 */
  display?: boolean;
  /** 추가 className */
  className?: string;
}

/** KaTeX 오프라인 수식 렌더러 (인라인/블록) */
const KatexMath: React.FC<KatexMathProps> = ({ math, display = false, className }) => {
  const html = useMemo(
    () => katex.renderToString(math, { displayMode: display, throwOnError: false }),
    [math, display],
  );
  return (
    <span
      className={className}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};

export default React.memo(KatexMath);
