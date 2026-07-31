import type { BuildingOnPath } from "./building";

/** 단면도 고도 샘플 포인트 */
export interface ElevationPoint {
  distance: number;
  elevation: number;
  latitude: number;
  longitude: number;
}

/** LoS 수직 단면 커튼 샘플 (지도 평면 프레임: z = AMSL m, 곡률 미적용 raw)
 *  단면도(LoSProfilePanel) 디스플레이 프레임(곡률 처짐)을 지도 평면(raw AMSL)으로 역변환한 값 —
 *  각 필드는 단면도 차트의 동명 선이며, TrackMap 이 레이더→타겟(0..D) 구간 3D 수직 평면상
 *  폴리라인(지형·최저탐지 LoS·프레넬·BRA·CoS·4/3 레이)으로 그대로 표출한다. */
export interface LosCurtainSample {
  lat: number; lon: number; distKm: number;
  terrainM: number;  // 지형선 (raw elevation)
  los43M: number;    // 최저탐지 LoS (지도 프레임 = minDetStraight.height + curvDrop(d))
  fresnelM: number;  // 프레넬존 80% 클리어런스 (지도 프레임 = minDetFresnel.height + curvDrop(d))
  braM: number;      // 0.25° BRA 기준선 (지도 프레임 = braLine.height + curvDrop(d))
  cosM: number;      // 70° CoS 기준선 (지도 프레임 = cosLine.height + curvDrop(d))
  rayM: number;      // 레이더→타겟 4/3 현 (지도 프레임 = chord43H(d) + curvDrop43(d))
}

/** LoS 분석 단면도 결과 */
export interface LoSProfileData {
  id: string;
  radarSiteName: string;
  radarLat: number;
  radarLon: number;
  radarHeight: number;
  targetLat: number;
  targetLon: number;
  bearing: number;
  totalDistance: number;
  /** 지형+경로상 건물 옥상고 병합 프로파일 (combinedElev). 차단 판정/통합 obstacle 기준. */
  elevationProfile: ElevationPoint[];
  /** 순수 지형 프로파일 (SRTM, 건물 병합 전). 단면도에서 '분석 대상 제외' 최저탐지선 계산에 사용.
   *  DB 영속화 대상 아님 — fresh 계산(computeLosBatch) 시에만 존재, 없으면 대상 제외 선 미표시. */
  terrainProfile?: ElevationPoint[];
  /** 레이더→타겟 경로상 200m 코리도 내 건물 — 단면도에 차폐/비차폐로 표시.
   *  OM 보고서 LoS 단면도에서 TrackMap 동작과 일관성 위해 추가. */
  pathBuildings?: BuildingOnPath[];
  losBlocked: boolean;
  maxBlockingPoint?: { distance: number; elevation: number; name?: string };
  mapScreenshot?: string;
  chartScreenshot?: string;
  timestamp: number;
}
