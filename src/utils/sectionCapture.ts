/**
 * OM 보고서 섹션 사전 캡처 유틸리티
 *
 * 무거운 SVG 차트 컴포넌트를 숨겨진 컨테이너에서 렌더링 후
 * Canvas → WebP 이미지로 변환하여 미리보기에서 <img>로만 표시.
 * React 리렌더 비용 제거.
 */

/** 숨겨진 off-screen 컨테이너에서 DOM 요소를 캡처하여 WebP data URL 반환 */
export async function captureDomToImage(
  element: HTMLElement,
  opts?: { width?: number; quality?: number },
): Promise<string> {
  const width = opts?.width ?? element.scrollWidth;
  const height = element.scrollHeight;
  const quality = opts?.quality ?? 0.85;

  // html2canvas-pro 동적 임포트 (이미 프로젝트 의존성)
  const { default: html2canvas } = await import("html2canvas-pro");
  const canvas = await html2canvas(element, {
    width,
    height,
    scale: 2, // Retina 품질
    useCORS: true,
    backgroundColor: "#ffffff",
    logging: false,
  });

  return canvas.toDataURL("image/webp", quality);
}

/** 여러 섹션을 순차 캡처하여 Map<sectionKey, dataUrl> 반환 */
export async function captureMultipleSections(
  container: HTMLElement,
  sectionSelector: string = "[data-om-section]",
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const sections = container.querySelectorAll<HTMLElement>(sectionSelector);

  for (const el of sections) {
    const key = el.dataset.omSection;
    if (!key) continue;
    try {
      const dataUrl = await captureDomToImage(el);
      result.set(key, dataUrl);
    } catch (err) {
      console.warn(`[sectionCapture] Failed to capture ${key}:`, err);
    }
  }

  return result;
}
