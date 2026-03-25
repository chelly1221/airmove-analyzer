import type { ParsedFile } from "./parse";

/** UI 페이지 */
export type PageId =
  | "upload"
  | "map"
  | "drawing"
  | "tracks"
  | "analysis"
  | "report"
  | "radar"
  | "settings"
  | "aircraft"
  | "obstacle";

/** 파일 업로드 상태 */
export interface UploadedFile {
  path: string;
  name: string;
  status: "pending" | "parsing" | "done" | "error";
  error?: string;
  parsedFile?: ParsedFile;
  /** 파싱에 사용된 레이더 사이트 이름 */
  radarName?: string;
}
