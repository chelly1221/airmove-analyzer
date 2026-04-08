/**
 * OM 보고서 차트 섹션 자동 이미지화 래퍼
 *
 * 1. children(실제 차트 컴포넌트)을 마운트하여 정상 렌더링
 * 2. 자식이 captureReady 이벤트를 dispatch하면 html2canvas로 캡처
 *    (이벤트 없으면 fallback delay 후 캡처)
 * 3. 캡처 성공 시 <img>로 교체 → 이후 리렌더 비용 0
 *
 * 텍스트 편집이 필요한 섹션(소견 등)에는 사용하지 않음.
 */
import { useState, useRef, useEffect } from "react";

interface Props {
  children: React.ReactNode;
  /** 캡처 트리거 — false면 캡처 안 하고 children 그대로 표시 */
  enabled?: boolean;
  /** 폴백 최대 대기 (ms) — captureReady 이벤트 없을 때 이 시간 후 캡처 */
  delay?: number;
  /** 외부에서 사전 캡처된 이미지가 있으면 바로 사용 */
  preCaptured?: string;
  /** 캡처 완료 콜백 (sectionKey → dataUrl) */
  onCaptured?: (dataUrl: string) => void;
  /** 대기 중인 캡처 수 추적 — PDF 내보내기 동기화용 */
  pendingCapturesRef?: React.MutableRefObject<number>;
}

export default function OMSectionImage({
  children,
  enabled = true,
  delay = 3000,
  preCaptured,
  onCaptured,
  pendingCapturesRef,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(preCaptured ?? null);
  const capturedRef = useRef(false);
  // onCaptured를 ref로 안정화 — 인라인 화살표 함수 변경으로 effect 재시작 방지
  const onCapturedRef = useRef(onCaptured);
  onCapturedRef.current = onCaptured;

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
    let started = false;
    if (pendingCapturesRef) pendingCapturesRef.current++;

    const doCapture = async () => {
      started = true;
      if (cancelled) {
        if (pendingCapturesRef) pendingCapturesRef.current--;
        return;
      }
      try {
        const { default: html2canvas } = await import("html2canvas-pro");
        const canvas = await html2canvas(el, {
          scale: 2,
          useCORS: true,
          backgroundColor: "#ffffff",
          logging: false,
        });
        if (cancelled) {
          canvas.width = 0;
          canvas.height = 0;
          if (pendingCapturesRef) pendingCapturesRef.current--;
          return;
        }
        const dataUrl = canvas.toDataURL("image/png");
        canvas.width = 0;
        canvas.height = 0;
        capturedRef.current = true;
        setImageUrl(dataUrl);
        onCapturedRef.current?.(dataUrl);
        if (pendingCapturesRef) pendingCapturesRef.current--;
      } catch (err) {
        console.warn("[OMSectionImage] 캡처 실패, 원본 유지:", err);
        if (pendingCapturesRef) pendingCapturesRef.current--;
      }
    };

    // captureReady 이벤트 수신 — 자식이 렌더링 완료를 알릴 때
    let eventFired = false;
    const handleReady = () => {
      if (eventFired || cancelled) return;
      eventFired = true;
      // 이벤트 후 짧은 지연 — 브라우저 paint 완료 보장
      setTimeout(() => { if (!cancelled) doCapture(); }, 200);
    };
    el.addEventListener("captureReady", handleReady);

    // 폴백 타이머 — captureReady 이벤트가 오지 않을 경우 delay 후 캡처
    const fallbackTimer = setTimeout(() => {
      if (!eventFired && !cancelled) doCapture();
    }, delay);

    return () => {
      cancelled = true;
      el.removeEventListener("captureReady", handleReady);
      clearTimeout(fallbackTimer);
      if (!started && pendingCapturesRef) pendingCapturesRef.current--;
    };
  }, [enabled, delay, preCaptured, pendingCapturesRef]);

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
