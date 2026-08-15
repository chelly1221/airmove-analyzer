/**
 * 내보내기(Excel) 전용 다국어 문자열·라벨.
 *
 * 앱 UI 전체를 i18n하지 않고, "내보내기 시 매번 선택"하는 산출물 언어만 다룬다.
 * - 헤더/시트명/요약 항목명 등 정적 문자열: ko/en/ja 직접 정의.
 * - 디코더/Rust 원천 라벨(FRN명·레이더유형·메시지유형·카테고리): 안정적 코드/키로 매핑.
 *   (raDescription·Corrective/Preventive·Climb/Descend 등은 디코더가 이미 영어로 생성)
 */

export type ExportLang = "ko" | "en" | "ja";

export const EXPORT_LANGS: { id: ExportLang; label: string }[] = [
  { id: "ko", label: "한국어" },
  { id: "en", label: "English" },
  { id: "ja", label: "日本語" },
];

// ── 코드/키 기반 라벨 매핑 (Rust 원문은 한글, 없으면 한글 폴백) ──────

// CAT048 FRN id → 표준 ASTERIX 항목명
const FRN_EN: Record<string, string> = {
  "I048/010": "Data Source Identifier",
  "I048/140": "Time of Day",
  "I048/020": "Target Report Descriptor",
  "I048/040": "Measured Position (Polar)",
  "I048/070": "Mode-3/A Code",
  "I048/090": "Flight Level",
  "I048/130": "Radar Plot Characteristics",
  "I048/220": "Aircraft Address",
  "I048/240": "Aircraft Identification",
  "I048/250": "Mode-S MB Data",
  "I048/161": "Track Number",
  "I048/042": "Calculated Position (Cartesian)",
  "I048/200": "Calculated Velocity (Polar)",
  "I048/170": "Track Status",
  "I048/210": "Track Quality",
  "I048/030": "Warning/Error Conditions",
  "I048/080": "Mode-3/A Confidence",
  "I048/100": "Mode-C Confidence",
  "I048/110": "Height (3D)",
  "I048/120": "Radial Doppler Speed",
  "I048/230": "Comms/ACAS Capability",
  "I048/260": "ACAS RA Report",
  "I048/055": "Mode-1 Code",
  "I048/050": "Mode-2 Code",
  "I048/065": "Mode-1 Confidence",
  "I048/060": "Mode-2 Confidence",
  SP: "Special Purpose Field",
  RE: "Reserved Expansion Field",
};
const FRN_JA: Record<string, string> = {
  "I048/010": "データ源識別",
  "I048/140": "時刻 (TOD)",
  "I048/020": "目標報告記述子",
  "I048/040": "測定位置（極座標）",
  "I048/070": "Mode-3/A コード",
  "I048/090": "高度（FL）",
  "I048/130": "レーダープロット特性",
  "I048/220": "航空機アドレス",
  "I048/240": "航空機識別（コールサイン）",
  "I048/250": "Mode-S MB データ",
  "I048/161": "トラック番号",
  "I048/042": "算出位置（直交座標）",
  "I048/200": "算出速度（極座標）",
  "I048/170": "トラック状態",
  "I048/210": "トラック品質",
  "I048/030": "警告/エラー状態",
  "I048/080": "Mode-3/A 信頼度",
  "I048/100": "Mode-C 信頼度",
  "I048/110": "高度（3D）",
  "I048/120": "ラジアルドップラー速度",
  "I048/230": "通信/ACAS 能力",
  "I048/260": "ACAS RA 報告",
  "I048/055": "Mode-1 コード",
  "I048/050": "Mode-2 コード",
  "I048/065": "Mode-1 信頼度",
  "I048/060": "Mode-2 信頼度",
  SP: "特殊目的フィールド",
  RE: "予約拡張フィールド",
};

// I048/020 TYP (key = 0..7) — 기술용어는 원문 유지, "탐지없음"만 번역
const RADAR_TYP_EN: Record<string, string> = {
  "0": "No detection",
  "1": "Single PSR",
  "2": "Single SSR",
  "3": "SSR+PSR",
  "4": "Mode S All-Call",
  "5": "Mode S Roll-Call",
  "6": "Mode S All-Call+PSR",
  "7": "Mode S Roll-Call+PSR",
};
const RADAR_TYP_JA: Record<string, string> = {
  "0": "探知なし",
  "1": "Single PSR",
  "2": "Single SSR",
  "3": "SSR+PSR",
  "4": "Mode S All-Call",
  "5": "Mode S Roll-Call",
  "6": "Mode S All-Call+PSR",
  "7": "Mode S Roll-Call+PSR",
};

// CAT034 메시지 유형 (key = type)
const MSG034_EN: Record<string, string> = {
  "1": "North marker",
  "2": "Sector crossing",
  "3": "Geographical filtering",
  "4": "Jamming strobe",
  "5": "Solar storm",
};
const MSG034_JA: Record<string, string> = {
  "1": "ノースマーカー",
  "2": "セクター通過",
  "3": "地理的フィルタリング",
  "4": "ジャミングストローブ",
  "5": "太陽嵐",
};

// CAT008 메시지 유형 (key = type)
const MSG008_EN: Record<string, string> = {
  "1": "Polar vector",
  "2": "Cartesian vector",
  "3": "Contour record",
  "4": "Absolute Cartesian vector",
  "254": "SOP message",
  "255": "EOP message",
};
const MSG008_JA: Record<string, string> = {
  "1": "極座標ベクトル",
  "2": "直交ベクトル",
  "3": "輪郭記録",
  "4": "絶対直交ベクトル",
  "254": "SOP メッセージ",
  "255": "EOP メッセージ",
};

const TTI_KO: Record<number, string> = { 0: "상대정보없음", 1: "Mode-S", 2: "ATCRBS", 3: "예비" };
const TTI_EN: Record<number, string> = { 0: "No threat data", 1: "Mode-S", 2: "ATCRBS", 3: "Reserved" };
const TTI_JA: Record<number, string> = { 0: "相手情報なし", 1: "Mode-S", 2: "ATCRBS", 3: "予備" };

const CAT_KO: Record<number, string> = { 0x30: "CAT048 표적보고", 0x22: "CAT034 서비스", 0x08: "CAT008 기상" };
const CAT_EN: Record<number, string> = { 0x30: "CAT048 Target Report", 0x22: "CAT034 Service", 0x08: "CAT008 Weather" };
const CAT_JA: Record<number, string> = { 0x30: "CAT048 目標報告", 0x22: "CAT034 サービス", 0x08: "CAT008 気象" };

const catFallback = (cat: number) => `CAT${cat.toString(16).padStart(2, "0")}`;

/** 선택 언어에 맞는 내보내기 문자열·라벨 묶음 */
export function exportStrings(lang: ExportLang) {
  // ko/en/ja 중 현재 언어 값 선택
  const pick = <T,>(ko: T, en: T, ja: T): T => (lang === "ja" ? ja : lang === "en" ? en : ko);
  // 코드/키 기반 라벨 — 매핑 없으면 한글 원문 폴백
  const mapped = (en: Record<string, string>, ja: Record<string, string>) =>
    (key: string, ko: string): string =>
      lang === "ja" ? ja[key] ?? ko : lang === "en" ? en[key] ?? ko : ko;

  return {
    // ── ACAS ──
    acasSheet: "ACAS RA",
    acasHeaders: (tz: string) =>
      pick(
        [
          `시각(${tz})`, "시각추정", "보고 Mode-S", "보고 기체", "보고 고도(ft)",
          "TID", "TTI", "위협 Mode-S", "위협 기체", "MTE", "RA 의도",
          "동작", "방향", "위협 거리(NM)", "위협 방위(°)", "위협 고도(ft)",
          "지속(s)", "횟수", "ARA(hex)", "RAC(hex)",
        ],
        [
          `Time (${tz})`, "Time Estimated", "Reporting Mode-S", "Reporting Aircraft", "Reporting Alt (ft)",
          "TID", "TTI", "Threat Mode-S", "Threat Aircraft", "MTE", "RA Intent",
          "Action", "Direction", "Threat Range (NM)", "Threat Bearing (°)", "Threat Alt (ft)",
          "Duration (s)", "Count", "ARA (hex)", "RAC (hex)",
        ],
        [
          `時刻 (${tz})`, "時刻推定", "報告 Mode-S", "報告航空機", "報告高度 (ft)",
          "TID", "TTI", "脅威 Mode-S", "脅威航空機", "MTE", "RA 意図",
          "動作", "方向", "脅威距離 (NM)", "脅威方位 (°)", "脅威高度 (ft)",
          "継続 (s)", "回数", "ARA (hex)", "RAC (hex)",
        ],
      ),
    tti: (t: number) => (lang === "ja" ? TTI_JA : lang === "en" ? TTI_EN : TTI_KO)[t] ?? String(t),
    estimated: (b: boolean) => pick(b ? "추정" : "실측", b ? "Estimated" : "Measured", b ? "推定" : "実測"),

    // ── ASTERIX 프레임 탐색 ──
    framesSheet: pick("프레임", "Frames", "フレーム"),
    framesHeaders: (tz: string) =>
      pick(
        [`시각(${tz})`, "파일", "카테고리", "레코드", "Mode-S", "ACAS", "바이트", "오프셋", "TOD(s)"],
        [`Time (${tz})`, "File", "Category", "Records", "Mode-S", "ACAS", "Bytes", "Offset", "TOD (s)"],
        [`時刻 (${tz})`, "ファイル", "カテゴリ", "レコード", "Mode-S", "ACAS", "バイト", "オフセット", "TOD (s)"],
      ),

    // ── ASTERIX 대시보드 ──
    sheet: {
      summary: pick("요약", "Summary", "サマリー"),
      categories: pick("카테고리", "Categories", "カテゴリ"),
      radarTyp: pick("레이더 탐지유형", "Radar Detection Type", "レーダー探知種別"),
      frn: pick("CAT048 항목", "CAT048 Items", "CAT048 項目"),
      modesTop: pick("Mode-S 상위", "Top Mode-S", "Mode-S 上位"),
      sacSic: "SAC SIC",
      msgType: pick("메시지 유형", "Message Types", "メッセージ種別"),
      files: pick("파일별", "Files", "ファイル別"),
      timeDensity: pick("시간대별 밀도", "Time Density", "時間帯別密度"),
      rangeHist: pick("거리 분포", "Range Distribution", "距離分布"),
      azimuthHist: pick("방위 분포", "Azimuth Distribution", "方位分布"),
      flHist: pick("고도 분포", "Altitude Distribution", "高度分布"),
    },
    // 요약 시트: 항목/값 헤더 + 항목명
    sumHeader: pick(["항목", "값"], ["Item", "Value"], ["項目", "値"]),
    sum: {
      files: pick("파일 수", "Files", "ファイル数"),
      totalBytes: pick("총 용량(bytes)", "Total Size (bytes)", "総容量 (bytes)"),
      frames: pick("프레임", "Frames", "フレーム"),
      blocks: pick("블록", "Blocks", "ブロック"),
      records: pick("레코드", "Records", "レコード"),
      distinctModeS: pick("Mode-S 고유", "Distinct Mode-S", "Mode-S ユニーク"),
      acasRa: pick("ACAS RA 레코드", "ACAS RA Records", "ACAS RA レコード"),
      timeRange: pick("시각 범위", "Time Range", "時刻範囲"),
      necDates: pick("NEC 프레임 날짜", "NEC Frame Dates", "NEC フレーム日付"),
      skippedBytes: pick("스킵 바이트", "Skipped Bytes", "スキップバイト"),
      parseErrors: pick("파싱 오류", "Parse Errors", "解析エラー"),
      truncated: pick("절단 레코드", "Truncated Records", "切断レコード"),
      mode3aGarbled: pick("Mode-3/A 무효", "Mode-3/A Garbled", "Mode-3/A 無効"),
      flVInvalid: pick("고도 미검증(V)", "Altitude Not Validated (V)", "高度未検証 (V)"),
      flGGarbled: pick("고도 Garbled(G)", "Altitude Garbled (G)", "高度 Garbled (G)"),
      todShiftFiles: pick("TOD 보정 파일 수", "TOD-Corrected Files", "TOD 補正ファイル数"),
    },
    // 각 시트 헤더 행
    catsHeader: pick(["카테고리", "블록", "레코드"], ["Category", "Blocks", "Records"], ["カテゴリ", "ブロック", "レコード"]),
    radarTypHeader: pick(["탐지 유형", "건수"], ["Detection Type", "Count"], ["探知種別", "件数"]),
    frnHeader: pick(["FRN", "항목", "건수"], ["FRN", "Item", "Count"], ["FRN", "項目", "件数"]),
    modesHeader: pick(["Mode-S", "건수"], ["Mode-S", "Count"], ["Mode-S", "件数"]),
    sacSicHeader: pick(["SAC", "SIC", "건수"], ["SAC", "SIC", "Count"], ["SAC", "SIC", "件数"]),
    msgHeader: pick(["분류", "유형", "건수"], ["Class", "Type", "Count"], ["分類", "種別", "件数"]),
    filesHeader: (tz: string) =>
      pick(
        ["파일", "용량(bytes)", "프레임", "레코드", `시각 시작(${tz})`, `시각 종료(${tz})`, "TOD 보정(h)"],
        ["File", "Size (bytes)", "Frames", "Records", `Start (${tz})`, `End (${tz})`, "TOD Shift (h)"],
        ["ファイル", "容量 (bytes)", "フレーム", "レコード", `開始 (${tz})`, `終了 (${tz})`, "TOD 補正 (h)"],
      ),
    timeDensityHeader: (tz: string) =>
      pick(
        [`시각(${tz})`, "레코드"],
        [`Time (${tz})`, "Records"],
        [`時刻 (${tz})`, "レコード"],
      ),
    rangeHeader: pick(["거리(NM)", "건수"], ["Range (NM)", "Count"], ["距離 (NM)", "件数"]),
    azimuthHeader: pick(["방위(°)", "건수"], ["Azimuth (°)", "Count"], ["方位 (°)", "件数"]),
    flHeader: pick(["고도", "건수"], ["Altitude", "Count"], ["高度", "件数"]),

    // 값 번역기 (매핑 없으면 한글 원문 유지)
    catLabel: (cat: number) => (lang === "ja" ? CAT_JA : lang === "en" ? CAT_EN : CAT_KO)[cat] ?? catFallback(cat),
    frnName: mapped(FRN_EN, FRN_JA),
    radarTyp: mapped(RADAR_TYP_EN, RADAR_TYP_JA),
    msg034: mapped(MSG034_EN, MSG034_JA),
    msg008: mapped(MSG008_EN, MSG008_JA),
  };
}
