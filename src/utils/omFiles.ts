/**
 * OM(장애물 월간) 보고서 — ASS 파일명 날짜 처리 유틸.
 *
 * 보고서 설정 모달(ObstacleMonthlyConfigModal)과 기준데이터 관리 모달(OMReferenceModal)이
 * 동일한 파일명→날짜 추출·월 필터 규칙을 공유하도록 컴포넌트 로컬 훅에서 추출한 순수 함수.
 * Rust `extract_date_from_filename` 미러 — 파일명 언더스코어 토큰 중 6자리 YYMMDD.
 */
import { format, lastDayOfMonth, subMonths } from "date-fns";

/** 파일명에서 날짜(YYYY-MM-DD) 추출 (Rust extract_date_from_filename 미러). 실패 시 null. */
export function extractDateFromFilename(path: string): string | null {
  const filename = path.split(/[/\\]/).pop() ?? path;
  const stem = filename.replace(/\.[^.]+$/, "");
  for (const part of stem.split("_")) {
    if (part.length === 6) {
      const yy = parseInt(part.slice(0, 2), 10);
      const mm = parseInt(part.slice(2, 4), 10);
      const dd = parseInt(part.slice(4, 6), 10);
      if (!isNaN(yy) && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
        return `${2000 + yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
      }
    }
  }
  return null;
}

/** 선택 월("YYYY-MM")에 해당하는 파일만 필터 (전월 마지막날 포함 — 자정 이후 데이터 포함 가능). */
export function filterFilesByMonth(files: string[], month: string): string[] {
  const [y, m] = month.split("-").map(Number);
  const prevMonth = subMonths(new Date(y, m - 1, 1), 1);
  const prevLastDay = format(lastDayOfMonth(prevMonth), "yyyy-MM-dd");
  return files.filter((f) => {
    const date = extractDateFromFilename(f);
    if (!date) return true; // 날짜 추출 실패 시 포함 (안전)
    return date.startsWith(month) || date === prevLastDay;
  });
}
