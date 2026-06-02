/**
 * OM 보고서 인라인 편집 기반 — 컨텍스트 + 편집 가능 텍스트 컴포넌트.
 *
 * 보고서 내 모든 "문구"(제목·설명·주석·조건·표 라벨·소견 등)를 편집키로 식별해
 * 사용자 수정 문구를 OMReportData.textOverrides 에 저장한다. 기본 문구는 자동
 * 생성된 값이고, override 가 있으면 그 값을 우선 표시한다.
 *
 * - Provider 가 없으면 editable=false 로 동작 → 일반 텍스트로 안전하게 렌더.
 * - contentEditable 패턴은 EditableText 와 동일 (blur 시 textContent 반영).
 * - 차트 내부(캔버스/SVG <text>) 글자는 contentEditable 불가라 본 컴포넌트 대상 외.
 */
import { createContext, useContext, useRef, useCallback } from "react";

interface OMEditContextValue {
  editable: boolean;
  overrides: Record<string, string>;
  /** value=null 이면 해당 키 override 제거(기본값 복원) */
  onOverride: (key: string, value: string | null) => void;
}

const NOOP_CTX: OMEditContextValue = { editable: false, overrides: {}, onOverride: () => {} };

const OMEditContext = createContext<OMEditContextValue>(NOOP_CTX);

export function OMEditProvider({
  value,
  children,
}: {
  value: OMEditContextValue;
  children: React.ReactNode;
}) {
  return <OMEditContext.Provider value={value}>{children}</OMEditContext.Provider>;
}

type Tag = "h1" | "h2" | "h3" | "p" | "span" | "div" | "td" | "th" | "li";

interface OMEditableProps {
  /** 안정적인 편집키 (렌더마다 동일해야 override 가 유지됨) */
  id: string;
  /** 자동 생성 기본 문구 */
  value: string;
  tag?: Tag;
  className?: string;
  style?: React.CSSProperties;
}

/** 편집키로 식별되는 인라인 편집 텍스트. override 가 있으면 우선 표시. */
export default function OMEditable({ id, value, tag: Tag = "span", className = "", style }: OMEditableProps) {
  const { editable, overrides, onOverride } = useContext(OMEditContext);
  const ref = useRef<HTMLElement>(null);
  const display = overrides[id] ?? value;

  const handleBlur = useCallback(() => {
    if (!ref.current) return;
    const text = ref.current.textContent ?? "";
    if (text === value) {
      // 기본값으로 되돌림 → override 제거
      if (overrides[id] != null) onOverride(id, null);
    } else if (text !== overrides[id]) {
      onOverride(id, text);
    }
  }, [id, value, overrides, onOverride]);

  const editClass = editable
    ? "outline-none hover:ring-1 hover:ring-blue-400/40 hover:ring-offset-1 focus:ring-1 focus:ring-blue-500 focus:ring-offset-1 rounded-sm cursor-text"
    : "";

  return (
    <Tag
      ref={ref as React.RefObject<any>}
      contentEditable={editable}
      suppressContentEditableWarning
      onBlur={editable ? handleBlur : undefined}
      data-om-edit-id={id}
      className={`${className} ${editClass}`.trim()}
      style={style}
    >
      {display}
    </Tag>
  );
}
