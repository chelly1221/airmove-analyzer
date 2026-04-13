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

export interface CaptureTracker {
  /** 섹션 mount 시 등록 — 진행 오버레이에 "대기 중"으로 표출 */
  register: (key: string, label: string) => void;
  /** 캡처 완료 또는 언마운트 시 호출 */
  complete: (key: string) => void;
}

interface Props {
  children: React.ReactNode;
  /** 섹션 고유 키 (e.g. "cov-POSAN") */
  sectionKey: string;
  /** 진행 오버레이에 표시할 사람이 읽는 라벨 (e.g. "커버리지 비교맵 (POSAN)") */
  sectionLabel: string;
  /** 캡처 트리거 — false면 캡처 안 하고 children 그대로 표시 */
  enabled?: boolean;
  /** 폴백 최대 대기 (ms) — captureReady 이벤트 없을 때 이 시간 후 캡처 */
  delay?: number;
  /** 외부에서 사전 캡처된 이미지가 있으면 바로 사용 */
  preCaptured?: string;
  /** 캡처 완료 콜백 (sectionKey → dataUrl) */
  onCaptured?: (dataUrl: string) => void;
  /** 부모(ReportApp)에 준비 상태 보고 — staging 단계 동기화용 */
  captureTracker?: CaptureTracker;
}

export default function OMSectionImage({
  children,
  sectionKey,
  sectionLabel,
  enabled = true,
  delay = 6000,
  preCaptured,
  onCaptured,
  captureTracker,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(preCaptured ?? null);
  const capturedRef = useRef(false);
  // onCaptured / captureTracker 를 ref로 안정화 — 인라인 객체 변경으로 effect 재시작 방지
  const onCapturedRef = useRef(onCaptured);
  onCapturedRef.current = onCaptured;
  const trackerRef = useRef(captureTracker);
  trackerRef.current = captureTracker;

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
    let reported = false;
    trackerRef.current?.register(sectionKey, sectionLabel);

    const reportDone = () => {
      if (reported) return;
      reported = true;
      trackerRef.current?.complete(sectionKey);
    };

    const doCapture = async () => {
      if (cancelled) { reportDone(); return; }
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
          reportDone();
          return;
        }
        const dataUrl = canvas.toDataURL("image/png");
        canvas.width = 0;
        canvas.height = 0;
        capturedRef.current = true;
        setImageUrl(dataUrl);
        onCapturedRef.current?.(dataUrl);
        reportDone();
      } catch (err) {
        console.warn("[OMSectionImage] 캡처 실패, 원본 유지:", err);
        reportDone();
      }
    };

    // captureReady 이벤트 수신 — 자식이 렌더링 완료를 알릴 때
    let eventFired = false;
    const handleReady = () => {
      if (eventFired || cancelled) return;
      eventFired = true;
      // 2× RAF로 브라우저 paint 완료 보장
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!cancelled) doCapture();
        });
      });
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
      // 언마운트 시 미완료 캡처는 반드시 tracker에서 빼야 pending drain 됨
      reportDone();
    };
  }, [enabled, delay, preCaptured, sectionKey, sectionLabel]);

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
