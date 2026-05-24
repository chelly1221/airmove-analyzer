/**
 * 의존성 없는 최소 XLSX(.xlsx) 생성기.
 *
 * - 압축 없는(stored) ZIP 컨테이너 + OOXML 파트(inline string)만으로 진짜 .xlsx 파일을 만든다.
 * - 외부 라이브러리/네이티브 바인딩이 필요 없어 Windows 빌드(node_modules 재설치)에 영향이 없다.
 * - 저장은 기존 Rust 커맨드 `write_file_base64`(base64 → 파일)를 재사용 → fs 쓰기 권한 불필요.
 *
 * 한계: 스타일/수식/공유문자열 없음. 텍스트는 inlineStr, 숫자는 number 셀로만 기록한다.
 */

/** 셀 값 — 숫자는 number 셀, 그 외 텍스트는 inlineStr, null/undefined/빈문자는 빈 셀 */
export type Cell = string | number | null | undefined;

export interface SheetData {
  name: string;
  /** 행 배열 (첫 행은 보통 헤더). 각 행은 셀 배열 */
  rows: Cell[][];
}

const enc = new TextEncoder();

// ── XML 이스케이프 ──────────────────────────────────────────
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // XML 1.0 비허용 제어문자 제거 (탭/개행 제외)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

// ── 열 인덱스(0-base) → A1 표기 열 문자 ─────────────────────
function colName(idx: number): string {
  let s = "";
  let n = idx + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ── 시트 이름 정규화 (Excel 제약: 31자, []:*?/\ 금지, 비어있지 않음) ──
function sanitizeSheetName(name: string, fallback: string): string {
  const n = name.replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31);
  return n.length ? n : fallback;
}

function cellXml(cell: Cell, ref: string): string {
  if (cell == null || cell === "") return "";
  if (typeof cell === "number" && Number.isFinite(cell)) {
    return `<c r="${ref}"><v>${cell}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(cell))}</t></is></c>`;
}

function sheetXml(rows: Cell[][]): string {
  let body = "";
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r];
    let rowXml = "";
    for (let c = 0; c < cells.length; c++) {
      rowXml += cellXml(cells[c], `${colName(c)}${r + 1}`);
    }
    body += `<row r="${r + 1}">${rowXml}</row>`;
  }
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${body}</sheetData></worksheet>`
  );
}

// ── OOXML 패키지 파트 구성 ──────────────────────────────────
function buildParts(sheets: SheetData[]): { path: string; data: Uint8Array }[] {
  const names = sheets.map((s, i) => sanitizeSheetName(s.name, `Sheet${i + 1}`));

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    sheets
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join("") +
    `</Types>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>` +
    names.map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
    `</sheets></workbook>`;

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join("") +
    `</Relationships>`;

  const parts: { path: string; data: Uint8Array }[] = [
    { path: "[Content_Types].xml", data: enc.encode(contentTypes) },
    { path: "_rels/.rels", data: enc.encode(rootRels) },
    { path: "xl/workbook.xml", data: enc.encode(workbook) },
    { path: "xl/_rels/workbook.xml.rels", data: enc.encode(workbookRels) },
  ];
  sheets.forEach((s, i) =>
    parts.push({ path: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(sheetXml(s.rows)) }),
  );
  return parts;
}

// ── ZIP (stored, 무압축) ────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const u16 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
const u32 = (n: number) =>
  new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

function zipStore(files: { path: string; data: Uint8Array }[]): Uint8Array {
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.path);
    const crc = crc32(f.data);
    const size = f.data.length;

    // 로컬 파일 헤더 + 데이터
    const local = concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0),
      nameBytes, f.data,
    ]);
    localChunks.push(local);

    // 중앙 디렉터리 헤더
    centralChunks.push(
      concat([
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0),
        u32(offset), nameBytes,
      ]),
    );
    offset += local.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of centralChunks) centralSize += c.length;

  const end = concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralSize), u32(centralStart), u16(0),
  ]);

  return concat([...localChunks, ...centralChunks, end]);
}

/** 시트 배열 → .xlsx 바이트 */
export function buildXlsx(sheets: SheetData[]): Uint8Array {
  return zipStore(buildParts(sheets));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * 저장 대화상자를 띄워 시트들을 .xlsx로 저장한다.
 * @returns 저장됨 true / 취소 false
 */
export async function saveXlsx(sheets: SheetData[], defaultFilename: string): Promise<boolean> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    defaultPath: defaultFilename,
    filters: [{ name: "Excel 통합 문서", extensions: ["xlsx"] }],
  });
  if (!path) return false;

  const { invoke } = await import("@tauri-apps/api/core");
  const bytes = buildXlsx(sheets);
  await invoke("write_file_base64", { path, data: bytesToBase64(bytes) });
  return true;
}
