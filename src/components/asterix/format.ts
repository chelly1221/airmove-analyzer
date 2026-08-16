/**
 * ASTERIX 화면 공용 포맷 유틸 — 대시보드(AsterixAnalysis)와 통계 상세 페이지가 공유한다.
 * (AsterixAnalysis.tsx 파일 로컬 유틸을 동작 불변으로 이전)
 */

import type { TzMode } from "../../types/asterixDetail";
import type { Aircraft } from "../../types";

export const KST_OFFSET_SECS = 9 * 3600;

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${u[i]}`;
}

export const pad = (n: number) => String(n).padStart(2, "0");

export function fmtTod(s: number | null): string {
  if (s == null) return "—";
  const x = ((s % 86400) + 86400) % 86400;
  return `${pad(Math.floor(x / 3600))}:${pad(Math.floor((x % 3600) / 60))}:${pad(Math.floor(x % 60))}`;
}

export function formatTime(ts: number, tz: TzMode): string {
  const d = new Date((ts + (tz === "KST" ? KST_OFFSET_SECS : 0)) * 1000);
  const yy = String(d.getUTCFullYear()).slice(2);
  return `${yy}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** 수집 공백 길이 — 1시간 이상이면 `1h 23m`, 그 미만이면 `n분` */
export function fmtGapDur(secs: number): string {
  const m = Math.round(secs / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}분`;
}

/** I140 TOD→UTC 보정량(시간) 표기 — 부호 명시(U+2212), 소수부는 필요할 때만 */
export function fmtShiftH(h: number): string {
  const a = Math.abs(h);
  return `${h < 0 ? "−" : "+"}${Number.isInteger(a) ? String(a) : a.toFixed(1)}h`;
}

export function dtLocalToTs(s: string, tz: TzMode): number | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const utcMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return (utcMs - (tz === "KST" ? KST_OFFSET_SECS * 1000 : 0)) / 1000;
}

export const CAT_SHORT: Record<number, string> = { 0x30: "048", 0x22: "034", 0x08: "008" };
export const catShort = (cat: number) => CAT_SHORT[cat] ?? cat.toString(16).padStart(2, "0");

export function labelFor(modeS: string, aircraft: Aircraft[]): string {
  const a = aircraft.find((ac) => ac.mode_s_code?.toUpperCase() === modeS.toUpperCase());
  const name = a?.name || a?.registration;
  return name ? `${name} (${modeS})` : modeS;
}
