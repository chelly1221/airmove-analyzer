import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
  /** false이면 배경 클릭/ESC/헤더 X 로 닫히지 않음 (호출부가 제공하는 버튼으로만 닫기) */
  closable?: boolean;
}

/**
 * 열려 있는 모달 스택 (모듈 레벨, 렌더 간 공유).
 * 중첩 모달에서 Esc·배경 클릭은 최상단(마지막 push) 모달만 닫는다 —
 * 각 모달이 독립 keydown 을 걸면 Esc 한 번에 전부 닫히기 때문.
 * cleanup 은 splice(자신만 제거) — 언마운트 순서가 push 역순이 아닐 수 있어 pop 금지.
 */
const modalStack: symbol[] = [];

export default function Modal({
  open,
  onClose,
  title,
  children,
  width = "max-w-lg",
  closable = true,
}: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const mouseDownTargetRef = useRef<EventTarget | null>(null);
  const titleId = useId();

  // 인스턴스 고유 스택 식별자 (지연 초기화 — 매 렌더 Symbol 생성 방지)
  const idRef = useRef<symbol | null>(null);
  if (!idRef.current) idRef.current = Symbol("modal");

  // 최신 props를 리스너/클릭 핸들러에서 참조 (deps 변경으로 스택 재정렬되지 않게)
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closableRef = useRef(closable);
  closableRef.current = closable;

  useEffect(() => {
    if (!open) return;
    const id = idRef.current!;
    // closable=false 모달도 스택에 올려 최상단 판정(아래 모달 Esc 차단)에 참여
    modalStack.push(id);
    const handleEsc = (e: KeyboardEvent) => {
      // 자신이 최상단일 때만 반응 — 중첩 모달에서 Esc 전파 차단
      if (e.key === "Escape" && closableRef.current && modalStack[modalStack.length - 1] === id) {
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", handleEsc);
    dialogRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", handleEsc);
      const i = modalStack.indexOf(id);
      if (i !== -1) modalStack.splice(i, 1);
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onMouseDown={(e) => {
        mouseDownTargetRef.current = e.target;
      }}
      onClick={(e) => {
        // 최상단 모달의 배경 클릭만 닫기 (중첩 시 아래 모달 오버레이는 무시)
        if (
          closable &&
          e.target === overlayRef.current &&
          mouseDownTargetRef.current === overlayRef.current &&
          modalStack[modalStack.length - 1] === idRef.current
        ) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`${width} flex max-h-[85vh] w-full flex-col mx-4 rounded-xl border border-gray-200 bg-white shadow-xl outline-none`}
      >
        {/* 헤더 고정 */}
        <div className="flex shrink-0 items-center justify-between border-b border-gray-200 px-6 py-4">
          <h2 id={titleId} className="text-lg font-semibold text-gray-800">{title}</h2>
          {/* closable=false 면 X 미표시 — 정리 로직 없는 즉시 onClose(창 destroy 등) 우회 경로 차단 */}
          {closable && (
            <button
              onClick={onClose}
              className="rounded-lg p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900 transition-colors"
              aria-label="닫기"
            >
              <X size={20} />
            </button>
          )}
        </div>
        {/* 콘텐츠만 스크롤 (min-h-0 로 flex 자식이 max-h 안에서 줄어들 수 있게) */}
        <div className="min-h-0 overflow-y-auto px-6 py-4">{children}</div>
      </div>
    </div>
  );
}
