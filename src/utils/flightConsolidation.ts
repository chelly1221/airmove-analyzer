import type { Aircraft, Flight } from "../types";

/** 공항 ICAO → 한글 이름 */
const AIRPORT_NAMES: Record<string, string> = {
  // 한국 민간/국제공항 (AIP)
  RKSI: "인천", RKSS: "김포", RKPK: "김해", RKPC: "제주",
  RKTN: "대구", RKJJ: "광주", RKNY: "양양", RKTU: "청주",
  RKJK: "군산", RKNW: "원주", RKJY: "여수", RKPU: "울산",
  RKPS: "사천", RKTH: "포항경주", RKJB: "무안",
  RKTL: "울진", RKPD: "정석",
  // 1. 전술항공작전기지
  RKSO: "K-55", RKSG: "A-511", RKSM: "K-16",
  RKSW: "K-13", RKTI: "K-75", RKTY: "K-58",
  RKTP: "K-76", RKNN: "K-18",
  // 2. 지원항공작전기지
  RKPE: "K-10",
  RKRS: "G-113", RKRO: "G-217", RKRA: "G-222",
  RK13: "G-404", RKRN: "G-510", RKUL: "G-536",
  // 3. 헬기전용작전기지
  RKJM: "K-15", RKRB: "G-103", RKRP: "G-110",
  RKRK: "G-213", RKRI: "G-231",
  RK15: "G-237", RKRC: "G-280", RK27: "G-218",
  RKRD: "G-290", RKRG: "G-301",
  RK31: "G-307", RK16: "G-312", RK22: "G-313",
  RK48: "G-419", RK32: "G-420",
  RKRY: "G-501", RK51: "G-532",
  RKUY: "G-801", RK25: "G-107", RKJU: "G-703",
  RK38: "G-228", RKUC: "G-505",
  // 4. 헬기예비작전기지
  RK7H: "G-162", RK18: "G-233",
  RK17: "G-406", RK44: "G-412", RK21: "G-413",
  RK33: "G-418",
  // 기타 군 비행장 (OurAirports)
  RKST: "H-220", RKTE: "성무", RKNC: "춘천",
  RKTA: "태안", RKTS: "상주", RKCH: "남지",
  RK6O: "G-605", RK6X: "G-130",
  RK40: "G-240", RK36: "G-238", RK28: "G-219",
  RK42: "G-311", RK43: "G-414", RK49: "G-530",
  RK50: "G-526", RK19: "G-314", RK41: "G-317",
  RK82: "G-405", RK34: "G-417", RK14: "G-231",
  RK52: "G-501", RK60: "G-712", RK6D: "G-710",
  // 한국 헬리포트/헬리패드
  RKDD: "독도", RKDU: "울릉도", RKPM: "모슬포", RKSY: "H-264",
  RKSD: "N-200", RKSC: "수리산", RKSH: "중앙119",
  RKSJ: "태성산", RKSN: "쿠니사격장", RKSQ: "연평도", RKSV: "표리산",
  RKSU: "여주사격장", RKSX: "H-207",
  RKNF: "황령", RKNR: "코타사격장",
  RKTB: "백아도", RKTW: "웅천", RKJO: "용정리",
  RKBN: "N-201", RKTG: "H-805", RKTM: "만길산",
  RKSP: "백령도",
  // 일본 주요
  RJTT: "하네다", RJAA: "나리타", RJBB: "간사이", RJOO: "이타미",
  RJFF: "후쿠오카", RJCC: "신치토세", RJGG: "주부", RJSN: "니가타",
  RJFK: "가고시마", RJNK: "고마츠", ROAH: "나하",
  // 중국 주요
  ZBAA: "베이징", ZSPD: "상하이푸동", ZSSS: "상하이홍차오",
  ZGGG: "광저우", ZGSZ: "선전", ZUUU: "청두", VHHH: "홍콩",
  RCTP: "타오위안", RCSS: "쑹산",
  // 동남아/기타
  WSSS: "싱가포르", VTBS: "수완나품", RPLL: "마닐라",
  WIII: "자카르타",
};

/** 공항 ICAO → 한글명 포함 라벨 (예: "RKSI(인천)") */
function airportLabel(code: string | null | undefined): string {
  if (!code) return "?";
  const name = AIRPORT_NAMES[code.toUpperCase()];
  return name ? `${code}(${name})` : code;
}

/** 비행 라벨 생성 */
export function flightLabel(f: Flight, aircraft: Aircraft[]): string {
  const name = f.aircraft_name ?? aircraft.find(
    (a) => a.mode_s_code.toUpperCase() === f.mode_s.toUpperCase()
  )?.name ?? f.mode_s;
  const parts = [name];
  if (f.callsign) parts.push(f.callsign);
  if (f.departure_airport || f.arrival_airport) {
    parts.push(`${airportLabel(f.departure_airport)} → ${airportLabel(f.arrival_airport)}`);
  }
  return parts.join(" · ");
}

