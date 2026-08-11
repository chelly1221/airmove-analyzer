// BRA 침범 건물 프리즘 전용 SolidPolygonLayer 서브클래스.
//
// 목적: "원추면 위 = 빨강 / 아래 = 회색" 을 **픽셀(프래그먼트) 단위**로 판정한다.
//   구 설계는 폴리곤 정점마다 원추면 높이를 구해 벽을 상·하 두 쿼드로 잘랐는데,
//   레이더에 접선 방향인 긴 벽은 벽 중간이 양끝 정점보다 레이더에 가까워 원추면이 중간에서
//   더 낮게 지나간다. 정점 보간으로는 이 처짐을 재현할 수 없어 실제로는 벽 중앙부가 원추를
//   뚫는데도 벽 전체가 회색으로 칠해졌다(실측 3D 행은 폴리곤이 bbox 사각형 4정점뿐이라 증상 극대).
//   지붕 캡도 최근접 정점 기준으로 통째 빨강이라 과대 마킹이었다.
//   → 벽/지붕을 통짜 면으로 넘기고, 프래그먼트에서 그 픽셀의 실제 (lng, lat, z) 로 원추면 높이를
//     다시 계산해 색을 정하면 두 오류가 동시에 사라진다.
//
// 구현: deck.gl 9.2 셰이더 모듈 + 훅 주입 (ClipExtension 과 동일한 계약).
//   · VS  — solid-polygon-layer-vertex-main.glsl 이 `geometry.worldPosition = props.positions`(원시
//           lng/lat/z, _full3d 여도 테셀레이터는 preproject 를 삼각분할 인덱스 계산에만 쓰고
//           positions 속성엔 원본 좌표를 그대로 넣는다) 를 설정한 **직후** DECKGL_FILTER_GL_POSITION
//           훅을 부르므로, 이 훅에서 varying 으로 실어 보낸다.
//   · FS  — DECKGL_FILTER_COLOR 훅에서 원추면 높이와 비교해 색을 곱한다. picking 모듈의 동일 훅
//           주입은 order:99 라 항상 뒤에 실행 → 피킹 패스는 그대로 동작한다.
import { SolidPolygonLayer } from "@deck.gl/layers";
import type { SolidPolygonLayerProps } from "@deck.gl/layers";

/** 실제지구 반경 (m) — bra.rs cone_msl · TrackMap 원추면 메시와 동일 (4/3 굴절 미적용) */
const R_EARTH_M = 6_371_000;

/** 원추면 판정 uniform 블록 — FS 전용 (VS 는 worldPosition varying 캡처만 담당) */
const braConeUniformBlock = /* glsl */ `\
uniform braConeUniforms {
  vec2 radarLngLat;
  vec2 mPerDeg;
  float apexM;
  float tanTheta;
  float invTwoR;
  float ex;
} braCone;
`;

/**
 * 셰이더 모듈 — 모듈 name 이 곧 GLSL 인스턴스명이자 shaderInputs.setProps 의 키.
 * uniformTypes 의 나열 순서는 위 블록 선언 순서와 반드시 일치해야 한다(std140 패킹).
 *   radarLngLat = [경도, 위도] (deg)
 *   mPerDeg     = [경도 1°당 m(x), 위도 1°당 m(y)] — worldPosition.xy 가 (lng, lat) 순서라 x=경도 스케일
 *   apexM       = 안테나 정점 해발고 (AMSL m, 과장 미적용)
 *   tanTheta    = 기준각 tan
 *   invTwoR     = 1/(2R) 지구곡률 항 계수
 *   ex          = 지형 과장 배율 (AMSL m → 렌더 z)
 */
const braConeModule = {
  name: "braCone",
  fs: braConeUniformBlock,
  uniformTypes: {
    radarLngLat: "vec2<f32>",
    mPerDeg: "vec2<f32>",
    apexM: "f32",
    tanTheta: "f32",
    invTwoR: "f32",
    ex: "f32",
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

/** 훅 주입 — 색 상수는 TrackMap 의 구 RED/GRAY 와 동일값(#ef4444 / #e5e7eb) */
const braConeInject = {
  "vs:#decl": /* glsl */ `
out vec3 braWorldPos;
`,
  // geometry.worldPosition 은 vec3 (deck core shaderlib/misc/geometry) — 원시 lng/lat/z
  "vs:DECKGL_FILTER_GL_POSITION": /* glsl */ `
  braWorldPos = geometry.worldPosition;
`,
  "fs:#decl": /* glsl */ `
in vec3 braWorldPos;
const vec3 BRA_RED = vec3(239.0, 68.0, 68.0) / 255.0;
const vec3 BRA_GRAY = vec3(229.0, 231.0, 235.0) / 255.0;
`,
  // 픽셀 위치 → 레이더 수평거리 → 원추면 z → 상(빨강)/하(회색).
  // fragColor.rgb 는 getFillColor 백색(255)에 VS 조명 계수가 곱해진 **조명 계수 캐리어**다.
  // (현재 extruded:false 경로는 VS 에서 조명을 타지 않아 정확히 흰색 = 1 곱이지만, 곱셈으로
  //  적용해 두면 조명이 걸리는 경로에서도 벽면 음영이 그대로 보존된다.)
  // 경도/위도가 f32 varying 이라 ~1.5e-5°(≈1.3m) 정밀도지만, 기울기 0.25°(tanθ≈0.0044) 기준
  // 원추고 오차는 수 mm 수준이라 무시 가능.
  "fs:DECKGL_FILTER_COLOR": /* glsl */ `
  float bradx = (braWorldPos.x - braCone.radarLngLat.x) * braCone.mPerDeg.x;
  float brady = (braWorldPos.y - braCone.radarLngLat.y) * braCone.mPerDeg.y;
  float brad = sqrt(bradx * bradx + brady * brady);
  float braConeZ = (braCone.apexM + brad * braCone.tanTheta + brad * brad * braCone.invTwoR) * braCone.ex;
  vec3 braBase = braWorldPos.z > braConeZ ? BRA_RED : BRA_GRAY;
  fragColor = vec4(braBase * fragColor.rgb, fragColor.a);
`,
};

/** 원추면 재구성 파라미터 — 전부 braResult 스냅샷 기준값(라이브 슬라이더 값 금지) */
export type BraConeProps = {
  /** 레이더 경도 (deg) */
  radarLng?: number;
  /** 레이더 위도 (deg) */
  radarLat?: number;
  /** 위도 1°당 m */
  mPerDegLat?: number;
  /** 경도 1°당 m (cos(lat) 반영) */
  mPerDegLon?: number;
  /** 안테나 정점 해발고 (AMSL m) */
  apexM?: number;
  /** 기준각 tan */
  tanTheta?: number;
  /** 지형 과장 배율 */
  ex?: number;
};

export type BraPrismLayerProps<DataT = unknown> = SolidPolygonLayerProps<DataT> & BraConeProps;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default class BraPrismLayer<DataT = any> extends SolidPolygonLayer<DataT, Required<BraConeProps>> {
  static layerName = "BraPrismLayer";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static defaultProps: any = {
    ...SolidPolygonLayer.defaultProps,
    radarLng: { type: "number", value: 0 },
    radarLat: { type: "number", value: 0 },
    mPerDegLat: { type: "number", value: 111320 },
    mPerDegLon: { type: "number", value: 111320 },
    apexM: { type: "number", value: 0 },
    tanTheta: { type: "number", value: 0 },
    ex: { type: "number", value: 1 },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getShaders(type: any): any {
    const shaders = super.getShaders(type);
    // super 결과는 호출마다 새 객체 — 모듈 중복 push 걱정 없음
    shaders.modules = [...(shaders.modules ?? []), braConeModule];
    shaders.inject = { ...(shaders.inject ?? {}), ...braConeInject };
    return shaders;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  draw(opts: { uniforms: any }): void {
    const { radarLng, radarLat, mPerDegLat, mPerDegLon, apexM, tanTheta, ex } = this.props;
    const braCone = {
      radarLngLat: [radarLng, radarLat],
      mPerDeg: [mPerDegLon, mPerDegLat],
      apexM,
      tanTheta,
      invTwoR: 1 / (2 * R_EARTH_M),
      ex,
    };
    // 존재하는 모든 모델에 세팅 (현 설정은 extruded:false 라 top 모델만 생성된다)
    for (const model of this.state.models ?? []) {
      model.shaderInputs.setProps({ braCone });
    }
    super.draw(opts);
  }
}
