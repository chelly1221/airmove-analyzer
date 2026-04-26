/**
 * OM 보고서 섹션 캡처 — 명령형 ref API
 *
 * 기존(html2canvas + DOM 커스텀 이벤트) 구조의 timing race / 라이브러리 hang 문제를
 * 제거하기 위한 재설계. 각 캡처 대상 컴포넌트는 forwardRef + useImperativeHandle 로
 * 이 핸들을 노출하고, ReportApp 의 오케스트레이터가 await 시퀀스로 처리.
 *
 * - SVG 섹션: XMLSerializer → Image() → canvas → toDataURL  (자체 구현, 외부 라이브러리 X)
 * - Canvas 섹션: canvas.toDataURL() 직접 호출
 * - capture() 내부에서 readiness Promise 를 await — 데이터/타일 로드 완료까지 자동 대기
 *
 * capture 가 null 을 반환하면 "이미지 대체 불필요" 의미 (예: 데이터 없음 → 라이브 DOM 유지).
 */

export interface OMSectionCaptureHandle {
  /**
   * 섹션 내부의 readiness 가 충족된 뒤 dataUrl 반환.
   * - 캡처할 콘텐츠가 없으면 null.
   * - 실패 시 throw.
   */
  capture(): Promise<string | null>;
}

/**
 * SVG 요소를 PNG dataUrl 로 직렬화.
 * SVG 내부의 <image href="data:..."> 는 그대로 인라인 보존되어 추가 fetch 없이 그려진다.
 */
export async function svgToPngDataUrl(
  svg: SVGSVGElement,
  scale = 2,
  backgroundColor = "#ffffff",
): Promise<string> {
  const rect = svg.getBoundingClientRect();
  const w = rect.width || svg.clientWidth || 800;
  const h = rect.height || svg.clientHeight || 600;

  // SVG 직렬화. xmlns 속성이 없으면 추가 (브라우저 Image() 가 SVG 로 인식하도록).
  const clone = svg.cloneNode(true) as SVGSVGElement;
  if (!clone.getAttribute("xmlns")) {
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  }
  if (!clone.getAttribute("xmlns:xlink")) {
    clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  }
  // 화면 크기를 명시적으로 width/height 로 부여 (viewBox 만으로는 Image() 렌더 시 0 처리될 수 있음)
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));

  const xml = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = (e) => reject(new Error(`SVG image load 실패: ${String(e)}`));
      img.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context 생성 실패");
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/png");
    canvas.width = 0;
    canvas.height = 0;
    return dataUrl;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 외부 readiness 신호용 deferred Promise.
 * 컴포넌트 mount 시 한번 생성, 데이터/타일 로드 완료 시 resolve, unmount 시 reject.
 */
export function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
