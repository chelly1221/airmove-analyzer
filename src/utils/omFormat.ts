/**
 * 장애물 월간(OM) 보고서 공용 수치 포맷 — 동일 지표가 페이지마다 자릿수가 달라 보이지 않도록
 * '평균 표적소실율'·'평균 PSR율'(±σ 포함)의 표준 소수 자릿수를 단일 소스로 관리한다.
 * 종합 소견 판정 카드(ReportOMFindings)·자동 소견 문구가 공유.
 */

/** 표적소실율(%) 표준 소수 자릿수 */
export const LOSS_PCT_DECIMALS = 2;
/** PSR율(%) 표준 소수 자릿수 */
export const PSR_PCT_DECIMALS = 2;

/** 표적소실율(%) 포맷 — 값·±σ 공통 (단위 기호는 호출부에서 부착) */
export function fmtLossPct(v: number): string {
  return v.toFixed(LOSS_PCT_DECIMALS);
}

/** PSR율(%) 포맷 — 값·±σ 공통 (단위 기호는 호출부에서 부착) */
export function fmtPsrPct(v: number): string {
  return v.toFixed(PSR_PCT_DECIMALS);
}
