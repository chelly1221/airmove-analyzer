/**
 * OM 보고서 차트 섹션 자동 이미지화 래퍼
 *
 * 1. children(실제 차트 컴포넌트)을 마운트하여 정상 렌더링
 * 2. 렌더링 완료 후 html2canvas로 WebP 캡처
 * 3. 캡처 성공 시 <img>로 교체 → 이후 리렌더 비용 0
 *
 * 텍스트 편집이 필요한 섹션(소견 등)에는 사용하지 않음.
 */
import { useState, useRef, useEffect } from "react";

interface Props {
  children: React.ReactNode;
  /** 캡처 트리거 — false면 캡처 안 하고 children 그대로 표시 */
  enabled?: boolean;
  /** 캡처 지연 (ms) — 차트 렌더 안정화 대기 */
  delay?: number;
  /** 외부에서 사전 캡처된 이미지가 있으면 바로 사용 */
  preCaptured?: string;
  /** 캡처 완료 콜백 (sectionKey → dataUrl) */
  onCaptured?: (dataUrl: string) => void;
}

export default function OMSectionImage({
  children,
  enabled = true,
  delay = 500,
  preCaptured,
  onCaptured,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(preCaptured ?? null);
  const capturedRef = useRef(false);

  useEffect(() => {
    if (preCaptured) {
      setImageUrl(preCaptured);
      capturedRef.current = true;
    } else {
      // preCaptured가 undefined로 변경 시 재캡처 허용
      capturedRef.current = false;
      setImageUrl(null);
    }
  }, [preCaptured]);

  useEffect(() => {
    if (!enabled || capturedRef.current || preCaptured) return;
    const el = ref.current;
    if (!el) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      if (cancelled) return;
      try {
        const { default: html2canvas } = await import("html2canvas-pro");
        const canvas = await html2canvas(el, {
          scale: 2,
          useCORS: true,
          backgroundColor: "#ffffff",
          logging: false,
        });
        if (cancelled) return;
        const dataUrl = canvas.toDataURL("image/png");
        // 캔버스 리소스 명시적 해제
        canvas.width = 0;
        canvas.height = 0;
        capturedRef.current = true;
        setImageUrl(dataUrl);
        onCaptured?.(dataUrl);
      } catch (err) {
        console.warn("[OMSectionImage] 캡처 실패, 원본 유지:", err);
        // 캡처 실패 시 원본 컴포넌트 유지
      }
    }, delay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, delay, preCaptured, onCaptured]);

  // 이미지 캡처 완료 → 정적 이미지로 표시
  if (imageUrl) {
    return (
      <div>
        <img
          src={imageUrl}
          alt=""
          className="w-full"
          style={{ imageRendering: "auto" }}
        />
      </div>
    );
  }

  // 아직 캡처 전 → 실제 차트 렌더링
  return <div ref={ref}>{children}</div>;
}
