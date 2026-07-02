/**
 * A4 페이지 레이아웃 상수 (mm) — 멀티페이지 분할용.
 *
 * KAC 보고서 디자인(2026-05)에 맞춰 페이지 inner padding 이 `16mm 14mm 18mm` 로
 * 변경됨 (머리띠 8mm + 본문 사이 여백 8mm + 하단 여백 18mm). 본문 영역은
 * `297 - 16 - 18 = 263mm`.
 */
export const PAGE_CONTENT_MM = 263; // 297 - (16mm top + 18mm bottom)
