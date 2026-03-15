import { useRef, useCallback } from "react";

interface EditableTextProps {
  value: string;
  onChange: (value: string) => void;
  editable: boolean;
  tag?: "h1" | "h2" | "h3" | "p" | "span" | "div";
  className?: string;
  style?: React.CSSProperties;
}

/** 편집 모드에서 contentEditable이 되는 텍스트 컴포넌트 */
export default function EditableText({
  value,
  onChange,
  editable,
  tag: Tag = "span",
  className = "",
  style,
}: EditableTextProps) {
  const ref = useRef<HTMLElement>(null);

  const handleBlur = useCallback(() => {
    if (ref.current) {
      const text = ref.current.textContent ?? "";
      if (text !== value) onChange(text);
    }
  }, [onChange, value]);

  const editClass = editable
    ? "outline-none hover:ring-1 hover:ring-blue-400/50 hover:ring-offset-1 focus:ring-1 focus:ring-blue-500 focus:ring-offset-1 rounded-sm cursor-text"
    : "";

  return (
    <Tag
      ref={ref as any}
      contentEditable={editable}
      suppressContentEditableWarning
      onBlur={handleBlur}
      className={`${className} ${editClass}`}
      style={style}
    >
      {value}
    </Tag>
  );
}
