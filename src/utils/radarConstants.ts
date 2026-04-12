/** 레이더 탐지 유형 관련 공유 상수 */

/** 맵 스타일 URL (Carto Voyager) */
export const MAP_STYLE_URL = "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json";

/**
 * 탐지 유형별 색상:
 *   Roll-Call = 파란색, All-Call + PSR = 연두색, All-Call only = 하늘색
 *   A/C 계열 = 노란색
 */
export const DETECTION_TYPE_COLORS: Record<string, [number, number, number]> = {
  mode_ac:              [234, 179, 8],    // yellow
  mode_ac_psr:          [234, 179, 8],    // yellow
  mode_s_allcall:       [56, 189, 248],   // sky blue (하늘색)
  mode_s_allcall_psr:   [132, 204, 22],   // lime green (연두색)
  mode_s_rollcall:      [59, 130, 246],   // blue (파란색)
  mode_s_rollcall_psr:  [34, 197, 94],    // green (초록색)
};

/** PSR 포함 탐지 유형 집합 */
export const PSR_TYPES = new Set(["mode_ac_psr", "mode_s_allcall_psr", "mode_s_rollcall_psr"]);

/** 탐지 유형 색상 조회 (fallback: 회색) */
export function detectionTypeColor(rt: string): [number, number, number] {
  return DETECTION_TYPE_COLORS[rt] ?? [128, 128, 128];
}

/** 탐지 유형 라벨 */
export function radarTypeLabel(rt: string): string {
  switch (rt) {
    case "mode_ac":              return "Mode A/C";
    case "mode_ac_psr":          return "Mode A/C + PSR";
    case "mode_s_allcall":       return "Mode S All-Call";
    case "mode_s_allcall_psr":   return "Mode S All-Call + PSR";
    case "mode_s_rollcall":      return "Mode S Roll-Call";
    case "mode_s_rollcall_psr":  return "Mode S Roll-Call + PSR";
    default:                     return rt.toUpperCase();
  }
}
