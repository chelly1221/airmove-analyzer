// 타워크레인 절차 생성(procedural) 3D 지오메트리 — 외부 glTF 없이 격자 트러스를 부재 단위로 만든다.
//   순수 함수: 입력(TowerCrane, zScale) → quad 목록. React·deck.gl 의존 없음(테스트 가능).
//   1단계 반영 범위는 표출 + BRA 침범 검사뿐 — LoS 단면도·파노라마·커버리지는 지상기립 프리즘을
//   전제하므로 밑면이 떠 있는 지브를 넣으면 오판이 된다(2단계 base_m 지원 후).
import type { TowerCrane } from "../types";

/** 부재 1면(볼록 다각형). polygon = [lon, lat, z] — z 는 (지반고 + 로컬고) × zScale, m AMSL 기준 */
export interface CraneQuad {
  polygon: [number, number, number][];
}

/** 크레인 1기의 면 묶음 — 색상 그룹별로 분리(레이어 4장에 그대로 대응) */
export interface CraneMesh {
  /** 마스트·지브·카운터지브·타워탑·트롤리/훅 등 주 구조 (주황) */
  structure: CraneQuad[];
  /** 카운터웨이트 블록 (진회색) */
  counterweight: CraneQuad[];
  /** 캐빈 (흰색) */
  cab: CraneQuad[];
  /** 전방위 선회 범위 원판 (rotation_mode='full' 만, 반투명 채움) */
  sweepDisc: CraneQuad[];
}

// ── 수치 상수 (부재 치수·격자 간격) ────────────────────────────
/** 실제지구 반지름 — 로컬 ENU(m) → 위경도 역변환용 평면 스케일 (bra.rs enu_dist_m 과 동일 상수) */
const EARTH_RADIUS_M = 6_371_000;
/** 지브·카운터지브 폭 (하현 2본 간격) — bra.rs 크레인 부위 폴리곤과 동일 값 */
const JIB_WIDTH_M = 2.0;
/** 지브 트러스 높이 (하현 → 상현) — bra.rs 지브 상단 = jib_height + JIB_TRUSS_H */
const JIB_TRUSS_H = 1.5;
/** 격자 패널 간격 (마지막 패널은 나머지 길이) */
const PANEL_M = 2.5;
/** 마스트 모서리 기둥 두께 */
const MAST_CHORD_T = 0.25;
/** 마스트 수평재 두께 */
const MAST_HORIZ_T = 0.15;
/** 마스트 대각재 두께 */
const MAST_DIAG_T = 0.12;
/** 지브·카운터지브 하현/상현 두께 */
const JIB_CHORD_T = 0.2;
/** 지브·카운터지브 가로재·대각재 두께 */
const JIB_LACING_T = 0.15;
/** 선회링(마스트 상단 상자) 높이 */
const SLEW_RING_H = 1.2;
/** 캐빈 상자 (지브 방향 u × 좌우 v × 높이 w) */
const CAB_SIZE: [number, number, number] = [2.0, 2.2, 2.5];
/** 트롤리 상자 (u × v × w) + 지브 상 위치 비율 */
const TROLLEY_SIZE: [number, number, number] = [1.2, 2.0, 0.6];
const TROLLEY_AT = 0.4;
/** 훅 로프 두께 · 길이 비율(지브 설치고 대비) · 훅 블록 한 변 */
const HOOK_ROPE_T = 0.08;
const HOOK_ROPE_RATIO = 0.35;
const HOOK_BLOCK = 0.6;
/** 카운터지브 난간재 높이·두께 */
const CJ_RAIL_H = 0.8;
const CJ_RAIL_T = 0.12;
/** 카운터웨이트 상자 (u × v × w) · 끝단에서 안쪽으로 들인 거리 */
const CW_SIZE: [number, number, number] = [3.0, 2.0, 2.0];
const CW_INSET_M = 1.0;
/** 타워탑(캣헤드) A-프레임 두께 · 펜던트 로프 두께 · 지브측 로프 고정 비율 */
const TOWER_TOP_T = 0.2;
const PENDANT_T = 0.1;
const PENDANT_JIB_AT = 0.55;
/** 선회 범위 원판 분할 수 (bra.rs 'full' 부위 폴리곤과 동일 64각형) */
const SWEEP_SEGMENTS = 64;

/** 로컬 크레인 좌표 [u(지브 방향), v(지브 기준 우측), w(상방)] — m 단위, 원점 = 마스트 중심 지반 */
type P = [number, number, number];

const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: P, k: number): P => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: P, b: P): P => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: P) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: P): P => {
  const l = len(a);
  return l < 1e-9 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
};

/** 3D 선분 → 단면 정사각(두께 thick) 사각기둥의 옆면 4장. 끝면(캡)은 생략 — 격자 트러스에선 보이지 않는다.
 *  방향 벡터에 수직인 두 축은 방향 × up(0,0,1) 로 얻고, 수직 부재(외적 퇴화)는 u축(정면, east 축 상당)으로 대체한다. */
function beam(p0: P, p1: P, thick: number): P[][] {
  const d = sub(p1, p0);
  if (len(d) < 1e-6) return [];
  const dir = norm(d);
  let a = cross(dir, [0, 0, 1]);
  if (len(a) < 1e-6) a = [1, 0, 0]; // 수직 부재 — 임의의 수직축 대체
  a = norm(a);
  const b = norm(cross(dir, a));
  const h = thick / 2;
  const offs: P[] = [
    add(scale(a, h), scale(b, h)),
    add(scale(a, h), scale(b, -h)),
    add(scale(a, -h), scale(b, -h)),
    add(scale(a, -h), scale(b, h)),
  ];
  const quads: P[][] = [];
  for (let i = 0; i < 4; i++) {
    const o0 = offs[i];
    const o1 = offs[(i + 1) % 4];
    quads.push([add(p0, o0), add(p0, o1), add(p1, o1), add(p1, o0)]);
  }
  return quads;
}

/** 로컬 축 정렬 상자(solid 6면) — 선회링·캐빈·트롤리·훅 블록·카운터웨이트 공용 */
function box(center: P, su: number, sv: number, sw: number): P[][] {
  const [cu, cv, cw] = center;
  const u0 = cu - su / 2, u1 = cu + su / 2;
  const v0 = cv - sv / 2, v1 = cv + sv / 2;
  const w0 = cw - sw / 2, w1 = cw + sw / 2;
  return [
    [[u0, v0, w0], [u1, v0, w0], [u1, v1, w0], [u0, v1, w0]], // 밑면
    [[u0, v0, w1], [u1, v0, w1], [u1, v1, w1], [u0, v1, w1]], // 윗면
    [[u0, v0, w0], [u1, v0, w0], [u1, v0, w1], [u0, v0, w1]], // -v 면
    [[u0, v1, w0], [u1, v1, w0], [u1, v1, w1], [u0, v1, w1]], // +v 면
    [[u0, v0, w0], [u0, v1, w0], [u0, v1, w1], [u0, v0, w1]], // -u 면
    [[u1, v0, w0], [u1, v1, w0], [u1, v1, w1], [u1, v0, w1]], // +u 면
  ];
}

/** quads 를 대상 배열에 이어붙임 — spread(push(...arr)) 금지 규약에 따라 for 루프 */
function pushAll(dst: P[][], quads: P[][]) {
  for (const q of quads) dst.push(q);
}

/**
 * 타워크레인 1기의 절차 생성 메시.
 * @param c 등록 크레인(높이는 m AGL, 지반고는 저장값 그대로 사용 — 수동 지반 계약과 동일)
 * @param zScale 지형 과장 배율(TrackMap TERRAIN_EXAGGERATION, 현재 1) — 분석 레이어와 동일 z 프레임
 */
export function buildCraneMesh(c: TowerCrane, zScale: number): CraneMesh {
  const structure: P[][] = [];
  const counterweight: P[][] = [];
  const cab: P[][] = [];
  const sweep: P[][] = [];

  const jibH = c.jib_height;               // 지브 하단 (m AGL)
  const topH = c.top_height;               // 최상단 (m AGL)
  const L = c.jib_length;                  // 지브 길이
  const Lc = c.counter_jib_length;         // 카운터지브 길이
  const mw = c.mast_width;                 // 마스트 단면 폭
  const hm = mw / 2;
  const hw = JIB_WIDTH_M / 2;              // 지브 하현 반폭
  const jibTopZ = jibH + JIB_TRUSS_H;      // 지브 상현 높이

  // ── 마스트: 4모서리 기둥 + 패널마다 4면 수평재·대각재(지그재그) ──
  const mastCorner = (k: number, w: number): P => {
    const su = k === 0 || k === 1 ? 1 : -1;
    const sv = k === 0 || k === 3 ? 1 : -1;
    return [su * hm, sv * hm, w];
  };
  for (let k = 0; k < 4; k++) {
    pushAll(structure, beam(mastCorner(k, 0), mastCorner(k, jibH), MAST_CHORD_T));
  }
  const mastPanels = Math.max(1, Math.ceil(jibH / PANEL_M));
  for (let i = 0; i < mastPanels; i++) {
    const w0 = i * PANEL_M;
    const w1 = Math.min((i + 1) * PANEL_M, jibH);
    if (w1 - w0 < 0.05) continue;
    for (let k = 0; k < 4; k++) {
      // 패널 상단 4면 수평재
      pushAll(structure, beam(mastCorner(k, w1), mastCorner((k + 1) % 4, w1), MAST_HORIZ_T));
      // 4면 대각재 — 패널마다 오름/내림 교대(지그재그)
      const ascending = i % 2 === 0;
      pushAll(structure, beam(
        mastCorner(k, ascending ? w0 : w1),
        mastCorner((k + 1) % 4, ascending ? w1 : w0),
        MAST_DIAG_T,
      ));
    }
  }

  // ── 선회부(선회링) + 캐빈 ──
  pushAll(structure, box([0, 0, jibH + SLEW_RING_H / 2], mw, mw, SLEW_RING_H));
  pushAll(cab, box(
    [0, hm + CAB_SIZE[1] / 2, jibH + SLEW_RING_H + CAB_SIZE[2] / 2], // 지브 방향 오른쪽 옆, 선회링 위
    CAB_SIZE[0], CAB_SIZE[1], CAB_SIZE[2],
  ));

  // ── 지브(+u 방향): 삼각 트러스(하현 2본 + 상현 1본) + 패널 가로재·대각재 ──
  pushAll(structure, beam([0, -hw, jibH], [L, -hw, jibH], JIB_CHORD_T));
  pushAll(structure, beam([0, hw, jibH], [L, hw, jibH], JIB_CHORD_T));
  pushAll(structure, beam([0, 0, jibTopZ], [L, 0, jibTopZ], JIB_CHORD_T));
  const jibPanels = Math.max(1, Math.ceil(L / PANEL_M));
  for (let i = 0; i < jibPanels; i++) {
    const u0 = i * PANEL_M;
    const u1 = Math.min((i + 1) * PANEL_M, L);
    if (u1 - u0 < 0.05) continue;
    // 하현 가로재 (패널 끝단)
    pushAll(structure, beam([u1, -hw, jibH], [u1, hw, jibH], JIB_LACING_T));
    // 상현으로 오르는 대각재 2본 — 패널마다 방향 교대(지그재그)
    const ascending = i % 2 === 0;
    const uLow = ascending ? u0 : u1;
    const uTop = ascending ? u1 : u0;
    pushAll(structure, beam([uLow, -hw, jibH], [uTop, 0, jibTopZ], JIB_LACING_T));
    pushAll(structure, beam([uLow, hw, jibH], [uTop, 0, jibTopZ], JIB_LACING_T));
  }
  // 트롤리(지브 40% 지점 하현 아래) + 훅 로프 + 훅 블록
  const trolleyU = L * TROLLEY_AT;
  const trolleyBottom = jibH - TROLLEY_SIZE[2];
  pushAll(structure, box([trolleyU, 0, jibH - TROLLEY_SIZE[2] / 2], TROLLEY_SIZE[0], TROLLEY_SIZE[1], TROLLEY_SIZE[2]));
  const hookBottom = trolleyBottom - jibH * HOOK_ROPE_RATIO;
  pushAll(structure, beam([trolleyU, 0, trolleyBottom], [trolleyU, 0, hookBottom], HOOK_ROPE_T));
  pushAll(structure, box([trolleyU, 0, hookBottom - HOOK_BLOCK / 2], HOOK_BLOCK, HOOK_BLOCK, HOOK_BLOCK));

  // ── 카운터지브(−u 방향): 평판 트러스(하현 2본 + 가로재) + 난간재, 끝단 카운터웨이트 2블록 ──
  if (Lc > 0) {
    pushAll(structure, beam([0, -hw, jibH], [-Lc, -hw, jibH], JIB_CHORD_T));
    pushAll(structure, beam([0, hw, jibH], [-Lc, hw, jibH], JIB_CHORD_T));
    pushAll(structure, beam([0, -hw, jibH + CJ_RAIL_H], [-Lc, -hw, jibH + CJ_RAIL_H], CJ_RAIL_T));
    pushAll(structure, beam([0, hw, jibH + CJ_RAIL_H], [-Lc, hw, jibH + CJ_RAIL_H], CJ_RAIL_T));
    const cjPanels = Math.max(1, Math.ceil(Lc / PANEL_M));
    for (let i = 0; i < cjPanels; i++) {
      const u = -Math.min((i + 1) * PANEL_M, Lc);
      pushAll(structure, beam([u, -hw, jibH], [u, hw, jibH], JIB_LACING_T));
      // 난간 기둥 2본
      pushAll(structure, beam([u, -hw, jibH], [u, -hw, jibH + CJ_RAIL_H], CJ_RAIL_T));
      pushAll(structure, beam([u, hw, jibH], [u, hw, jibH + CJ_RAIL_H], CJ_RAIL_T));
    }
    // 카운터웨이트 — 끝단에서 안쪽 1m 지점에 좌우 2블록
    const cwU = -(Lc - CW_INSET_M);
    const cwV = CW_SIZE[1] / 2 + 0.05;
    for (const sv of [-1, 1]) {
      pushAll(counterweight, box(
        [cwU, sv * cwV, jibH + CW_SIZE[2] / 2],
        CW_SIZE[0], CW_SIZE[1], CW_SIZE[2],
      ));
    }
  }

  // ── 타워탑(캣헤드): A-프레임 4본 + 펜던트 로프. top_height == jib_height 면 생략 ──
  if (topH > jibH + 0.05) {
    const apex: P = [0, 0, topH];
    for (let k = 0; k < 4; k++) {
      pushAll(structure, beam(mastCorner(k, jibH), apex, TOWER_TOP_T));
    }
    pushAll(structure, beam(apex, [L * PENDANT_JIB_AT, 0, jibTopZ], PENDANT_T));
    if (Lc > 0) pushAll(structure, beam(apex, [-Lc, 0, jibH + CJ_RAIL_H], PENDANT_T));
  }

  // ── 선회 범위 원판 (전방위 최악조건 모드) — bra.rs 'full' 부위와 같은 반경·같은 높이 ──
  if (c.rotation_mode === "full") {
    const R = Math.max(L, Lc);
    const ring: P[] = [];
    for (let i = 0; i < SWEEP_SEGMENTS; i++) {
      const a = (2 * Math.PI * i) / SWEEP_SEGMENTS;
      ring.push([R * Math.cos(a), R * Math.sin(a), jibTopZ]);
    }
    sweep.push(ring);
  }

  // ── 로컬(u,v,w) → ENU → 위경도 투영. 방위각 정의: 정북 0·시계방향 (e = sinθ, n = cosθ) ──
  const th = (c.jib_azimuth_deg * Math.PI) / 180;
  const sinT = Math.sin(th);
  const cosT = Math.cos(th);
  const latRad = (c.latitude * Math.PI) / 180;
  const degPerM = 180 / Math.PI / EARTH_RADIUS_M;
  const lonPerM = degPerM / Math.cos(latRad);
  const project = (quads: P[][]): CraneQuad[] => {
    const out: CraneQuad[] = [];
    for (const q of quads) {
      const poly: [number, number, number][] = [];
      for (const [u, v, w] of q) {
        const e = u * sinT + v * cosT;
        const n = u * cosT - v * sinT;
        poly.push([
          c.longitude + e * lonPerM,
          c.latitude + n * degPerM,
          (c.ground_elev + w) * zScale,
        ]);
      }
      out.push({ polygon: poly });
    }
    return out;
  };

  return {
    structure: project(structure),
    counterweight: project(counterweight),
    cab: project(cab),
    sweepDisc: project(sweep),
  };
}
