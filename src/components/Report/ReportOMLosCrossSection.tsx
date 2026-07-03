import React, { useMemo, useRef, useState, useEffect, useCallback } from "react";
import type { ManualBuilding, LoSProfileData, BuildingOnPath, ElevationPoint, PanoramaMergeResult } from "../../types";
import type { LossPointGeo, TrackPointGeo } from "../../types/obstacle";
import { useOMChartZoom, type ChartZoom } from "./OMEditable";
import { detectionTypeColor, PSR_TYPES } from "../../utils/radarConstants";
import { bearingDeg, haversineKm } from "../../utils/geo";
import {
  calcBuildingAzExtent, isTargetBuildingOnPath, excludeTargetBuildings, computeLosBlockage,
  makePanoramaSampler, panoWithForBuilding, BLDG_EFFECT_EPS_DEG,
} from "../../utils/obstacleAnalysisHelpers";

// ── 물리 상수 ──
const R_EARTH_M = 6_371_000;
/** ITU-R 표준대기 굴절계수 k=4/3 → 유효지구반경. 단면도(지형/지물 표시·LoS·차단 판정)를 이 단일
 *  4/3 프레임에서 수행: 지형은 유효지구 곡률만큼 처지고 LoS(레이)는 이 프레임에서 직선(ITU 경로단면법). */
const R_EFF_M = (R_EARTH_M * 4) / 3;

/** 디스플레이 프레임 곡률 보정량 (m): ITU 4/3 유효지구반경 기준
 *  → 직선 LoS 가 (이 4/3 프레임에서) 직선으로, 지형이 거리에 따라 4/3 곡률만큼 아래로 처져 보임 */
function curvDrop43(dKm: number): number {
  const dM = dKm * 1000;
  return (dM * dM) / (2 * R_EFF_M);
}

// ── SVG 차트 상수 (TrackMap LoSProfilePanel 과 동일) ──
const W = 900;
const H = 280;
const PAD = { top: 20, right: 30, bottom: 30, left: 65 };
const cw = W - PAD.left - PAD.right;
const ch = H - PAD.top - PAD.bottom;
const M_TO_FT = 3.28084;
const KM_TO_NM = 1 / 1.852;

/** 차트 X축 기본(리셋) 풀 스케일 (NM) — 보고서 LoS 단면도 기본 뷰는 빌딩 거리와 무관하게 100NM.
 *  chartData.maxDistance(=줌 % 기준)이자 줌 리셋 타겟. */
const FULL_X_NM = 100;
const FULL_X_KM = FULL_X_NM * 1.852;
/** 편집모드 최대 줌아웃 한계 (NM) — 휠 줌아웃 시 여기까지 확장(200NM). terrain/항적/소실표적 데이터도
 *  이만큼 샘플링·수집되어야 한다: obstacleAnalysisHelpers.EXTEND_PROFILE_MIN_KM(profile) + projectPointsToLos(점 cap).
 *  줌 도메인은 % 단위(FULL_X 기준)라 200NM = MAX_ZOOM_PCT(200%). */
const MAX_X_NM = 200;
const MAX_X_KM = MAX_X_NM * 1.852;
const MAX_ZOOM_PCT = (MAX_X_NM / FULL_X_NM) * 100; // 200

const LOSS_COLOR: [number, number, number] = [255, 23, 69]; // #ff1745

export interface ChartTrackPoint {
  distKm: number;
  altM: number; // 곡률 보정 전 AMSL
  radarType: string;
  isLoss: boolean;
}

/**
 * LoS 단면도 — TrackMap LoSProfilePanel 의 chartData/렌더링을 보고서용으로 그대로 이식.
 *
 *  TrackMap 과 동일한 요소:
 *   - LoS (ITU 4/3 유효지구 프레임, running max angle, 통합 obstacle 배열) — 주황 실선
 *   - 지형 (4/3 유효지구 곡률 보정) — 녹색 솔리드
 *   - 경로상 빌딩: polygon 은 사다리꼴, point 는 세로선; 차폐 기여(빨강) / 비차단(회색) / 수동(주황)
 *   - 범례 좌상단 + 빌딩 카운트
 *
 *  보고서 한정 — 정적 렌더링이라 제거:
 *   - GPU 캔버스 트랙 → SVG circles
 *   - 호버/툴팁/줌/사용자 각도선
 *   - peak DB 쿼리 (배치 부담)
 *   - BRA / CoS / 프레넬 기준선 (단순화)
 *
 *  X축 기본 100NM(FULL_X_KM), 편집모드 줌아웃 시 최대 200NM(MAX_X_KM). los.elevationProfile 은
 *  obstacleAnalysisHelpers 에서 200NM 까지 샘플링됨.
 */
export function LosCrossSection({
  los, radarName, building, buildingGroup, trackPoints, lossPoints, blockedOverride, panoWith, panoWithout,
}: {
  los: LoSProfileData;
  radarName: string;
  building: ManualBuilding;
  /** 이 빌딩의 소속 그룹 — 제목 옆 인라인 배지 표시용. 없으면 미표시 */
  buildingGroup?: import("../../types").BuildingGroup | null;
  trackPoints: ChartTrackPoint[];
  lossPoints: ChartTrackPoint[];
  /** 보조 '가시선 차단 O/X' 배지 판정 — panorama 실루엣 기반(소실표적 분류와 동일 소스, losBlockedFromPanorama:
   *  대상 top 양각 < 기존 지형·지물 차단각 = 레이더→대상 가시선 차단). 미지정(panorama 미준비) 시 차트 내부
   *  chord 판정(blocked)으로 폴백 — chord 도 분석 대상 자신을 제외한 입력(excludeTargetBuildings)으로 판정하므로
   *  self-block 없음. 헤드라인 'LoS 영향' 배지와는 별개 지표 — 아래 panoWith/panoWithout 기반 hasBldgEffect 사용. */
  blockedOverride?: boolean | null;
  /** 이 레이더의 분석 대상 포함 파노라마 — 헤드라인 'LoS 영향 O/X' 배지(hasBldgEffect) 판정용.
   *  내부에서 panoWithForBuilding 으로 '해당' 건물만 얹어 §1 요약표(classifyObstacleLosses angleTotalDeg)와
   *  동일 샘플러·동일 임계(+0.005°)로 계산 — §1 'LoS 영향' 열과 배지가 항상 동일 판정. */
  panoWith?: PanoramaMergeResult;
  /** 이 레이더의 분석 대상 제외 파노라마 — 위 배지의 without 차단각(angleTerrainDeg) 소스 */
  panoWithout?: PanoramaMergeResult;
}) {
  const chartData = useMemo(() => {
    const profile = los.elevationProfile;
    if (profile.length === 0) return null;

    const radarHeight = los.radarHeight;
    const D = los.totalDistance;
    const targetElev = building.ground_elev + building.height;
    const buildings: BuildingOnPath[] = los.pathBuildings ?? [];

    // 표시용 base 지형 = 순수 SRTM(terrainProfile). combinedElev(=profile)는 건물 꼭대기를 footprint 중심
    //   1개 그리드점에 spike 로 박는데, interpElev 가 그 spike 까지 ~1셀(≈60m) 미리 올라가는 램프를 만들어
    //   최저탐지선·녹색지형이 건물 법면 '앞'에서 조기상승했다(특히 그리드 스텝보다 좁은 point 형 건물:
    //   최근접 그리드점이 nearD 보다 앞쪽으로 스냅). 표시용 지형·최저탐지선은 순수 SRTM 을 base 로 쓰고
    //   건물은 edges + effElevAt override 로만 주입 → 법면에서 수직상승(TrackMap LoSProfilePanel 과 동일).
    //   ※ 차단판정(computeLosBlockage)도 이 순수 SRTM base + 대상 제외 건물 엣지(excludeTargetBuildings)로
    //     수행 — 보조 '가시선 차단' 배지 폴백(computeLosBatch los.losBlocked)과 동일 입력·동일 식(아래 blockage 블록 참조).
    const baseTerrain = los.terrainProfile ?? profile;

    // 1) 조정 지형 (4/3 유효지구 곡률 반영) — 순수 SRTM. 건물은 실루엣(significantBuildings)으로 별도 표시.
    const adjTerrain = baseTerrain.map((p) => ({
      distance: p.distance,
      height: p.elevation - curvDrop43(p.distance),
    }));

    // 통합 장애물 인터페이스 — computeMinDet 가 자체 obstacle 구성에 사용. 차단 판정은 computeLosBlockage(공유 헬퍼)로 일원화.
    interface Obstacle { distance: number; elevation: number; }

    // 2) 최저 탐지가능선 (직선 LoS, ITU 4/3 유효지구, Running Max Angle).
    //    지형 base(terrainPts) + 건물(blds) 통합 obstacle 에 대해 running-max 앙각 계산.
    //    레이더 빔을 4/3 유효지구(디스플레이) 프레임에서 직선으로 전파 (ITU-R 경로단면법).
    //    앙각·빔 높이 모두 4/3 곡률 보정(curvDrop43)만 사용하므로 추가 프레임 변환 불필요.
    //    동일 알고리즘을 (지형+모든건물) / (순수지형+대상제외건물) 두 입력으로 호출.
    const computeMinDet = (terrainPts: ElevationPoint[], blds: BuildingOnPath[]) => {
      if (terrainPts.length === 0) return [] as { distance: number; height: number }[];
      const edges = blds.map((b) => ({
        nearD: b.near_dist_km ?? b.distance_km,
        farD: b.far_dist_km ?? b.distance_km,
        topElev: b.ground_elev_m + b.height_m,
      }));
      const obs: Obstacle[] = [];
      for (const p of terrainPts) obs.push({ distance: p.distance, elevation: p.elevation });
      for (const e of edges) {
        obs.push({ distance: e.nearD, elevation: e.topElev });
        if (e.farD - e.nearD > 0.001) obs.push({ distance: e.farD, elevation: e.topElev });
      }
      obs.sort((a, b) => a.distance - b.distance);

      const interpElev = (d: number): number => {
        if (d <= terrainPts[0].distance) return terrainPts[0].elevation;
        const last = terrainPts[terrainPts.length - 1];
        if (d >= last.distance) return last.elevation;
        for (let i = 1; i < terrainPts.length; i++) {
          if (terrainPts[i].distance >= d) {
            const denom = terrainPts[i].distance - terrainPts[i - 1].distance;
            const t = denom > 1e-9 ? (d - terrainPts[i - 1].distance) / denom : 0;
            return terrainPts[i - 1].elevation + t * (terrainPts[i].elevation - terrainPts[i - 1].elevation);
          }
        }
        return 0;
      };

      // 통합 샘플 거리 (지형 샘플 + 건물 경계 ± eps)
      const sd: number[] = terrainPts.map((p) => p.distance);
      for (const e of edges) {
        const eps = 0.0005;
        if (e.nearD > eps) sd.push(e.nearD - eps);
        sd.push(e.nearD);
        if (e.farD - e.nearD > 0.001) { sd.push(e.farD); sd.push(e.farD + eps); }
        else sd.push(e.nearD + eps);
      }
      const dists = [...new Set(sd)].sort((a, b) => a - b);

      const effElevAt = (d: number): number => {
        let elev = interpElev(d);
        for (const e of edges) {
          if (d >= e.nearD && d <= e.farD + 0.0001) { if (e.topElev > elev) elev = e.topElev; }
        }
        return elev;
      };

      let maxAngle = -Infinity;
      let obIdx = 0;
      // 샘플별 지형 floor(terr)·음영 ray(los)·당시 누적 최대앙각(angle)을 보존 — 아래 교차점 삽입에 사용.
      const raw = dists.map((d) => {
        if (d <= 0) return { distance: d, terr: radarHeight, los: radarHeight, angle: -Infinity };
        const dM = d * 1000;
        while (obIdx < obs.length && obs[obIdx].distance <= d + 1e-9) {
          const ob = obs[obIdx];
          if (ob.distance > 0) {
            const adjH = ob.elevation - curvDrop43(ob.distance);
            const angle = (adjH - radarHeight) / (ob.distance * 1000);
            if (angle > maxAngle) maxAngle = angle;
          }
          obIdx++;
        }
        const terrElev = effElevAt(d);
        const terrAngle = (terrElev - curvDrop43(d) - radarHeight) / dM;
        if (terrAngle > maxAngle) maxAngle = terrAngle;
        // 직선 빔 높이 — ITU 4/3 유효지구(디스플레이) 프레임에서 직선. 디스플레이 지형을 floor 로
        const losDisplay = radarHeight + maxAngle * dM;
        const adjTerrainDisplay = terrElev - curvDrop43(d);
        return { distance: d, terr: adjTerrainDisplay, los: losDisplay, angle: maxAngle };
      });

      // 폴리라인 코너컷 제거 — 인접 샘플 사이에서 음영 ray 와 지형 floor 의 상하가 바뀌는 곳(= ray 가 지형
      //   법면에 닿는 지점)에 정확한 교차점을 정점으로 삽입한다. 종전엔 마지막 'ray 우세' 샘플과 첫 '지형 우세'
      //   샘플을 직선으로 이어, 한 칸(코리도 ≈60m·확장부 ≈370m) 미리 꺾여 올라간 것처럼 보였다(법면 도달 전 조기상승).
      //   ray 는 각도 일정한 직선, 지형 floor 는 구간선형 → 교차점은 선형보간으로 정확히 구해진다.
      const EPS = 1e-6;
      const out: { distance: number; height: number }[] = [];
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        const p = i > 0 ? raw[i - 1] : null;
        if (p && p.distance > 0) {
          const pRay = p.los > p.terr + EPS;
          const cRay = c.los > c.terr + EPS;
          if (pRay && !cRay) {
            // ray → 지형: 들어오던 ray(각도 p.angle)가 상승 지형면에 닿는 지점
            const f0 = (radarHeight + p.angle * p.distance * 1000) - p.terr;
            const f1 = (radarHeight + p.angle * c.distance * 1000) - c.terr;
            if (f0 > 0 && f1 < 0) {
              const t = f0 / (f0 - f1);
              const xd = p.distance + t * (c.distance - p.distance);
              out.push({ distance: xd, height: radarHeight + p.angle * xd * 1000 });
            }
          } else if (!pRay && cRay) {
            // 지형 → ray(능선 너머 음영 시작): 새 ray(각도 c.angle)가 지형면에서 떨어지는 지점
            const f0 = p.terr - (radarHeight + c.angle * p.distance * 1000);
            const f1 = c.terr - (radarHeight + c.angle * c.distance * 1000);
            if (f0 > 0 && f1 < 0) {
              const t = f0 / (f0 - f1);
              const xd = p.distance + t * (c.distance - p.distance);
              out.push({ distance: xd, height: radarHeight + c.angle * xd * 1000 });
            }
          }
        }
        out.push({ distance: c.distance, height: Math.max(c.terr, c.los) });
      }
      return out;
    };

    // 2a) 현재 선 — 순수 SRTM base(baseTerrain) + 모든 건물 edges. spike 배제로 법면 앞 조기상승 제거.
    const minDetStraight = computeMinDet(baseTerrain, buildings);

    // 2b) 분석 대상 건물 제외 선 — 실선과 동일한 순수 SRTM base(baseTerrain)에서 출발하고, 대상 건물만
    //     edges 에서 제외(buildingsWithoutTarget)한다. 비대상 건물은 실선과 동일하게 edges+effElevAt 로
    //     들어가 실루엣 유지 → 두 선은 대상 전까지 완전히 동일하고 대상 후방서만 벌어진다.
    //     (실선·점선이 spike 없는 동일 base 라 비대상 건물 처리도 일치 — 종전 '점선만 봉우리 무시' 불일치 해소.
    //      대상 건물 top spike 도 base 에 없어 점선이 대상 footprint 에서 실제 지반으로 자연 하강 — 복원 hack 불필요.)
    //     대상 식별: 수동건물 + 치수 일치 + far_dist 가 타겟 거리(D)까지 도달 (코리도 끝 = 대상).
    //     point 형 대상은 Rust 가 pathBuildings 에서 제외 → 매칭 0 건이면 미표시(두 선 동일).
    const targetBuildings = buildings.filter((b) => isTargetBuildingOnPath(b, building, D));
    // 점선('분석 대상 제외')·차단판정 공용 — 대상 건물뿐 아니라, 대상 footprint 안에 겹쳐 들어온 비대상 건물
    //   (예: 동일 위치 건물통합정보 폴리곤 — is_manual=false 라 대상매칭 불가)도 제외해야 '대상 제거 시 실제 지반'을
    //   드러낸다. 제외 안 하면 그 건물이 computeMinDet 의 near/far 엣지로 재투입돼 점선이 footprint 위에서
    //   안 내려간다. (footprint 밖 비대상 건물은 그대로 유지 — 기존 비대상 실루엣 보존 규칙 불변.)
    //   공유 헬퍼(excludeTargetBuildings)로 computeLosBatch 차단 배지와 동일 집합 보장.
    const buildingsWithoutTarget = excludeTargetBuildings(buildings, building, D);
    // 점선 base 도 실선과 동일한 순수 SRTM(baseTerrain). spike 없는 base 라 대상 footprint 지반 복원·
    //   spike 강제복원 hack 이 모두 불필요 — 대상은 edges 에서 빠지고(buildingsWithoutTarget) footprint 는
    //   raw SRTM 지반으로 자연 하강한다.
    const dashedTerrain: ElevationPoint[] | undefined =
      targetBuildings.length > 0 ? baseTerrain : undefined;
    const minDetWithout = dashedTerrain
      ? computeMinDet(dashedTerrain, buildingsWithoutTarget)
      : null;

    // 차단 판정 — 배지(computeLosBatch)와 동일한 computeLosBlockage 단일 소스·동일 입력(4/3 chord 식).
    //   지형 base = 순수 SRTM(baseTerrain), 건물 = 분석 대상 제외(buildingsWithoutTarget) — 대상 자신의
    //   near/far 엣지·top 스파이크가 self-block 을 만들지 않는다(폴리곤형 대상이 중간 차폐 없어도 무조건
    //   '차단'이 되던 문제 해소). 표시(지형선·건물 실루엣·최저탐지선·significantBuildings)는 기존대로 대상 포함.
    const { blocked, maxBlockPoint } = computeLosBlockage(baseTerrain, buildingsWithoutTarget, radarHeight, D, targetElev);

    // 5) 차폐 기여 빌딩 — 지형만 shadow 보다 빌딩 꼭대기가 높으면 실질 차폐 기여.
    //    단, 분석 대상 건물은 음영 여부와 무관하게 항상 포함(앞쪽 지형에 가려도 표시) — isTarget 표시.
    //    shadow 는 순수 SRTM(baseTerrain)으로만 계산 — spike 병합본(profile)을 돌면 건물 자신의 top 스파이크가
    //    최근접 그리드 스냅으로 bDist '앞'에 놓일 때(≈50%) 자기그림자를 만들어, 실제 차단 건물이 실루엣·범례
    //    카운트에서 무작위 누락됐다(최저탐지선·차단판정의 baseTerrain 이전 시 이 블록만 리팩토링 누락).
    const significantBuildings: (BuildingOnPath & { isBlocking: boolean; isTarget: boolean })[] = [];
    for (const b of buildings) {
      const bDist = b.distance_km;
      if (bDist <= 0 || bDist >= D) continue;
      const isTarget = isTargetBuildingOnPath(b, building, D);
      const bTop = b.ground_elev_m + b.height_m;
      const bAdj = bTop - curvDrop43(bDist);
      let terrainShadow = radarHeight;
      for (const p of baseTerrain) {
        if (p.distance <= 0 || p.distance >= bDist) continue;
        const adjH = p.elevation - curvDrop43(p.distance);
        const shadow = radarHeight + (adjH - radarHeight) * (bDist / p.distance);
        if (shadow > terrainShadow) terrainShadow = shadow;
      }
      if (bAdj > terrainShadow || isTarget) {
        // 차단 건물(적색) 판정 — maxBlockPoint.distance 는 건물 near/far '엣지' 또는 지형 샘플 거리이므로,
        //   건물 '중심'(bDist)±0.1km 고정 허용치가 아닌 footprint 구간(near−ε ~ far+ε) 포함 여부로 판정.
        //   (경로방향 span>0.2km 건물이 near 엣지에서 최대 차단을 만들면 종전 식은 자기 차단점을 놓쳤음.)
        const nearD = b.near_dist_km ?? b.distance_km;
        const farD = b.far_dist_km ?? b.distance_km;
        const isBlk = !!(maxBlockPoint &&
          maxBlockPoint.distance >= nearD - 0.05 &&
          maxBlockPoint.distance <= farD + 0.05 &&
          bAdj > maxBlockPoint.adjHeight - 5);
        significantBuildings.push({ ...b, isBlocking: isBlk, isTarget });
      }
    }
    // 분석 대상 건물을 마지막에 그려 다른 건물·지형 위로(높은 z-index) 올린다. (Array.sort 는 안정 정렬)
    significantBuildings.sort((a, b) => Number(a.isTarget) - Number(b.isTarget));

    // Y축 범위 — 기본(리셋) 뷰는 0~FULL_X_KM(100NM)만 보이므로 그 구간 데이터로만 산출.
    //   (profile 은 줌아웃용으로 200NM 까지 확장되지만, 200NM 의 큰 곡률 처짐/상승 LoS 가 기본 뷰
    //    Y축을 망가뜨리지 않도록 FULL_X_KM 이내로 제한. 줌아웃 시엔 visibleYRange 가 윈도우로 재계산.)
    const allHeights = [radarHeight];
    for (const p of adjTerrain) if (p.distance <= FULL_X_KM) allHeights.push(p.height);
    for (const p of minDetStraight) if (p.distance <= FULL_X_KM) allHeights.push(p.height);
    let maxY = -Infinity;
    for (const h of allHeights) if (h > maxY) maxY = h;
    maxY += 100;
    let minY = 0;
    for (const p of adjTerrain) if (p.distance <= FULL_X_KM && p.height < minY) minY = p.height;
    minY -= 50;
    if (minY < 0) {
      const minMaxYFor40Pct = -minY * 1.5;
      if (maxY < minMaxYFor40Pct) maxY = minMaxYFor40Pct;
    }

    return {
      adjTerrain, minDetStraight, minDetWithout,
      blocked, maxBlockPoint, significantBuildings,
      minY, maxY, maxDistance: FULL_X_KM,
      targetElev, radarHeight,
    };
  }, [los, building]);

  // 헤드라인 'LoS 영향' 배지 — §1 요약표 hasBldgEffect 와 동일 의미·동일 산식으로 통일:
  //   대상 건물이 기존 지형·지물 위로 '추가 차단각'을 만드는가 = angleWith(bAz) > angleWithout(bAz) + EPS.
  //   hasBldgEffectFromPanorama(단일 소스)와 동일 계산 — 이 컴포넌트는 RadarSite 대신 los.radarLat/Lon
  //   (동일 레이더 좌표)만 보유해 인라인으로 재현(샘플러·임계 BLDG_EFFECT_EPS_DEG 는 헬퍼와 공유).
  //   panoWith 미가용 시 null(판정 불가) — §1 표의 3-상태('—') 표기 규칙과 동일(무영향 X 단정 금지).
  //   (종전: losBlockedFromPanorama '가시선 차단' 기준을 같은 문구로 표기 — §1과 사실상 반대 판정이라
  //   같은 쌍이 O/X 상반 인쇄. 가시선 차단은 아래 보조 배지로 분리.)
  const hasBldgEffect = useMemo<boolean | null>(() => {
    const panoWithB = panoWithForBuilding(panoWith, panoWithout, building.id);
    if (!panoWithB) return null;
    const sW = makePanoramaSampler(panoWithB);
    const sWo = panoWithout ? makePanoramaSampler(panoWithout) : sW;
    const bAzDeg = bearingDeg(los.radarLat, los.radarLon, building.latitude, building.longitude);
    return sW(bAzDeg) > sWo(bAzDeg) + BLDG_EFFECT_EPS_DEG;
  }, [panoWith, panoWithout, building, los.radarLat, los.radarLon]);

  // ── 줌 편집 (클릭 → 줌모드, 휠 확대/축소 + 드래그 패닝). obstacle_monthly 편집 컨텍스트에서만 활성 ──
  const svgRef = useRef<SVGSVGElement>(null);
  // 항적/소실 포인트 전용 canvas 오버레이 — 수천~수만 점을 <circle> DOM 노드 없이 래스터로 그려
  //   PDF 캡처(WebView2 PrintToPdf) 병목을 제거한다. SVG(축/그리드/선/건물/범례)는 그대로 유지.
  //   z-순서: 소실표적(zIndex:0, SVG 아래 최하층) < SVG(zIndex:1) < 항적(zIndex:1, DOM 후순) < 범례(zIndex:2)
  const pointCanvasRef = useRef<HTMLCanvasElement>(null);
  // 소실표적 전용 canvas — SVG(지형/건물/LoS선) '아래'(z 맨 뒤)에 깔린다. 빨간 점 군집이
  //   LoS선·건물 실루엣을 가리지 않도록 분리 (지형 fill 0.35 투명도라 아래서도 비쳐 보임).
  const lossCanvasRef = useRef<HTMLCanvasElement>(null);
  // canvas 의 실제 렌더 픽셀 크기 — SVG(viewBox 0 0 W H, w-full)가 컨테이너 폭에 맞춰 스케일되므로
  //   ResizeObserver 로 렌더 박스를 추적해 viewBox→픽셀 스케일을 정확히 재현(1px 정합).
  const [canvasPx, setCanvasPx] = useState<{ w: number; h: number }>({ w: W, h: H });
  const zoomKey = `loscs.${radarName}_${building.id}`;
  const { editable, zoom, setZoom } = useOMChartZoom(zoomKey);
  const [zoomMode, setZoomMode] = useState(false);
  // 라이브 줌(로컬) — 드래그/휠 중 전역 omData 갱신에 따른 전체 트리 리렌더 방지.
  //   상호작용이 끝나면(또는 휠 정지 200ms 후) persist(setZoom) 로 1회 커밋한다.
  const [liveZoom, setLiveZoom] = useState<ChartZoom>(zoom);
  const liveZoomRef = useRef<ChartZoom>(liveZoom);
  liveZoomRef.current = liveZoom;
  const interactingRef = useRef(false);
  const setZoomRef = useRef(setZoom);
  setZoomRef.current = setZoom;

  // 외부(초기화·재로딩)로 persist 값이 바뀌면 로컬 동기화 (상호작용 중에는 무시)
  useEffect(() => {
    if (interactingRef.current) return;
    setLiveZoom(zoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom[0], zoom[1]]);

  const resetZoom = useCallback(() => {
    interactingRef.current = false;
    liveZoomRef.current = [0, 100];
    setLiveZoom([0, 100]);
    setZoomRef.current(null);
  }, []);
  const exitZoomMode = useCallback(() => {
    const [s, e] = liveZoomRef.current;
    setZoomRef.current(s === 0 && e === 100 ? null : [s, e]);
    interactingRef.current = false;
    setZoomMode(false);
  }, []);

  // 휠 줌 + 드래그 패닝 — 줌모드에서만 네이티브 리스너 부착 (wheel preventDefault 위해 passive:false)
  useEffect(() => {
    if (!editable || !zoomMode) return;
    const svg = svgRef.current;
    if (!svg) return;
    let commitTimer: ReturnType<typeof setTimeout> | null = null;
    const commit = () => {
      const [s, e] = liveZoomRef.current;
      setZoomRef.current(s === 0 && e === 100 ? null : [s, e]);
      interactingRef.current = false;
    };
    const scheduleCommit = () => {
      if (commitTimer) clearTimeout(commitTimer);
      commitTimer = setTimeout(commit, 200);
    };
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const rect = svg.getBoundingClientRect();
      const svgX = ((ev.clientX - rect.left) / rect.width) * W;
      if (svgX < PAD.left || svgX > W - PAD.right) return;
      const cursorRatio = (svgX - PAD.left) / cw;
      const [s, e] = liveZoomRef.current;
      const range = e - s;
      const pivot = s + cursorRatio * range;
      const factor = ev.deltaY > 0 ? 1.2 : 1 / 1.2;
      // 줌아웃 한계 = MAX_ZOOM_PCT(200% = 200NM). 기본/리셋은 여전히 [0,100](100NM).
      const newRange = Math.min(MAX_ZOOM_PCT, Math.max(1, range * factor));
      let ns = pivot - cursorRatio * newRange;
      let ne = pivot + (1 - cursorRatio) * newRange;
      if (ns < 0) { ne -= ns; ns = 0; }
      if (ne > MAX_ZOOM_PCT) { ns -= ne - MAX_ZOOM_PCT; ne = MAX_ZOOM_PCT; }
      ns = Math.max(0, ns); ne = Math.min(MAX_ZOOM_PCT, ne);
      interactingRef.current = true;
      const next: ChartZoom = [ns, ne];
      liveZoomRef.current = next;
      setLiveZoom(next);
      scheduleCommit();
    };
    let dragging = false;
    let dragStartClientX = 0;
    let dragStartZoom: ChartZoom = [0, 100];
    const onMouseDown = (ev: MouseEvent) => {
      const [s, e] = liveZoomRef.current;
      if (s === 0 && e === 100) return; // 줌 안 됨 → 패닝 불필요
      const rect = svg.getBoundingClientRect();
      const svgX = ((ev.clientX - rect.left) / rect.width) * W;
      if (svgX < PAD.left || svgX > W - PAD.right) return;
      dragging = true;
      interactingRef.current = true;
      dragStartClientX = ev.clientX;
      dragStartZoom = [...liveZoomRef.current];
      svg.style.cursor = "grabbing";
      ev.preventDefault();
    };
    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging) return;
      const rect = svg.getBoundingClientRect();
      const dx = ev.clientX - dragStartClientX;
      const [origS, origE] = dragStartZoom;
      const range = origE - origS;
      const chartPxWidth = rect.width * (cw / W);
      const shift = -(dx / chartPxWidth) * range;
      let ns = origS + shift, ne = origE + shift;
      if (ns < 0) { ne -= ns; ns = 0; }
      if (ne > MAX_ZOOM_PCT) { ns -= ne - MAX_ZOOM_PCT; ne = MAX_ZOOM_PCT; }
      ns = Math.max(0, ns); ne = Math.min(MAX_ZOOM_PCT, ne);
      const next: ChartZoom = [ns, ne];
      liveZoomRef.current = next;
      setLiveZoom(next);
    };
    const onMouseUp = () => {
      if (!dragging) return;
      dragging = false;
      svg.style.cursor = "";
      if (commitTimer) { clearTimeout(commitTimer); commitTimer = null; }
      commit();
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    svg.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      if (commitTimer) clearTimeout(commitTimer);
      svg.removeEventListener("wheel", onWheel);
      svg.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      svg.style.cursor = "";
    };
  }, [editable, zoomMode]);

  // ── Y축 가시 범위 — X 줌 윈도우에 맞춰 세로도 자동 맞춤 (TrackMap LoSProfilePanel 과 동일) ──
  //    줌인 시 보이는 구간(지형·LoS·대상제외선·건물)의 데이터만으로 minY/maxY 재계산.
  //    전체 줌([0,100])이면 chartData 의 전체 범위를 그대로 사용 → 줌 진입/이탈 시 점프 없음.
  const visibleYRange = useMemo(() => {
    if (!chartData) return null;
    const { adjTerrain, minDetStraight, minDetWithout, significantBuildings,
            maxDistance, minY: fullMinY, maxY: fullMaxY, radarHeight } = chartData;
    if (liveZoom[0] === 0 && liveZoom[1] === 100) return { minY: fullMinY, maxY: fullMaxY };

    const zoomStart = (liveZoom[0] / 100) * maxDistance;
    const zoomEnd = (liveZoom[1] / 100) * maxDistance;
    const inRange = (d: number) => d >= zoomStart && d <= zoomEnd;

    // 보이는 구간 내 높이값 수집 (곡률 보정 후 디스플레이 높이)
    const heights: number[] = [];
    for (const p of adjTerrain) if (inRange(p.distance)) heights.push(p.height);
    for (const p of minDetStraight) if (inRange(p.distance)) heights.push(p.height);
    if (minDetWithout) for (const p of minDetWithout) if (inRange(p.distance)) heights.push(p.height);
    // 건물 꼭대기·바닥 (윈도우에 걸치는 건물 포함)
    for (const b of significantBuildings) {
      const nearD = b.near_dist_km ?? b.distance_km;
      const farD = b.far_dist_km ?? b.distance_km;
      if (inRange(nearD) || inRange(farD) || (nearD <= zoomStart && farD >= zoomEnd)) {
        heights.push((b.ground_elev_m + b.height_m) - curvDrop43(b.distance_km));
        heights.push(b.ground_elev_m - curvDrop43(b.distance_km));
      }
    }
    // 레이더 높이 (시작점이 보일 때만)
    if (zoomStart <= 0.1) heights.push(radarHeight);

    if (heights.length === 0) return { minY: fullMinY, maxY: fullMaxY };

    let rawMin = Infinity, rawMax = -Infinity;
    for (const h of heights) { if (h < rawMin) rawMin = h; if (h > rawMax) rawMax = h; }
    const range = rawMax - rawMin;
    const padding = Math.max(range * 0.12, 50); // 최소 50m 여유
    const visMinY = rawMin - padding;
    let visMaxY = rawMax + padding;
    // 0ft 가 차트 40% 이하에 오도록 보장 (chartData 전체범위 로직과 동일)
    if (visMinY < 0) {
      const minMaxYFor40Pct = -visMinY * 1.5;
      if (visMaxY < minMaxYFor40Pct) visMaxY = minMaxYFor40Pct;
    }
    return { minY: visMinY, maxY: visMaxY };
  }, [chartData, liveZoom]);

  // ── canvas 렌더 픽셀 크기 추적 — SVG 는 viewBox(0 0 W H) + w-full 이라 렌더 폭이 동적.
  //    SVG 실제 렌더 박스를 ResizeObserver 로 관측해 canvas CSS/픽셀 크기를 일치시킨다(viewBox→px 스케일 보존).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const update = () => {
      const r = svg.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setCanvasPx((prev) =>
          prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height },
        );
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(svg);
    return () => ro.disconnect();
  }, []);

  // ── 항적/소실 포인트 canvas 렌더 ──
  //    SVG <circle> 전수 렌더를 대체. SVG 와 동일한 좌표계(viewBox 0 0 W H)에서 cx/cy 를 계산한 뒤
  //    canvas 의 viewBox→픽셀 스케일(sx, sy)·DPR 을 곱해 그린다 → SVG path/축과 1px 정합.
  //    의존성에 liveZoom·visibleYRange·canvasPx 가 포함되어 줌/패닝/리사이즈 시 자동 재그리기.
  useEffect(() => {
    const pointCanvas = pointCanvasRef.current;
    const lossCanvas = lossCanvasRef.current;
    if (!pointCanvas || !lossCanvas || !chartData) return;

    const { minY, maxY } = visibleYRange ?? chartData;
    const { maxDistance } = chartData;

    // SVG 와 동일한 X/Y 스케일 재현 (viewBox 좌표계, 0~W / 0~H)
    const zoomStartKm = (liveZoom[0] / 100) * maxDistance;
    const zoomEndKm = (liveZoom[1] / 100) * maxDistance;
    const zoomRangeKm = Math.max(1e-6, zoomEndKm - zoomStartKm);
    const xScaleV = (d: number) => PAD.left + ((d - zoomStartKm) / zoomRangeKm) * cw;
    const yScaleV = (h: number) => PAD.top + ch - ((h - minY) / (maxY - minY)) * ch;

    // viewBox(W×H) → 렌더 픽셀(canvasPx) → 물리 픽셀(DPR) 변환.
    //   SVG 기본 preserveAspectRatio="xMidYMid meet" 와 동일하게 맞춘다:
    //   maxHeight(230) 로 높이가 클램프되면 SVG 는 균일 스케일(min) + 중앙 정렬(레터박스)로 그려지므로
    //   canvas 도 동일 스케일 s = min(boxW/W, boxH/H) 와 중앙 오프셋(ox, oy)을 적용해야 1px 정합.
    // DPR 상한 1.5 — 페이지마다 2개(항적/소실) 반복되는 오버레이 캔버스의 백킹 메모리 절감.
    //   점(r=1.5) 래스터 오버레이라 1.5x 로도 화면·PDF 인쇄 충분(축/선/텍스트는 SVG 벡터 그대로).
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const s = Math.min(canvasPx.w / W, canvasPx.h / H);
    const ox = (canvasPx.w - W * s) / 2; // 가로 레터박스 오프셋(px)
    const oy = (canvasPx.h - H * s) / 2; // 세로 레터박스 오프셋(px)
    // backing store 픽셀 크기 (DPR 적용) — 멈춤 없이 매 그리기마다 동기화
    const bw = Math.round(canvasPx.w * dpr);
    const bh = Math.round(canvasPx.h * dpr);

    // 두 canvas(소실표적/항적) 공통 셋업 — 크기 동기화 + viewBox 변환 + plot rect 클립(SVG clipPath 와 동일)
    // willReadFrequently: 소프트웨어(CPU) 백킹 강제 — 페이지마다 2개씩 반복되는 오버레이 캔버스가
    //   GPU 가속 백킹이면 공유 GPU 프로세스에 페이지 수만큼 상주(§3 도면과 동일 근거).
    const setup = (canvas: HTMLCanvasElement): CanvasRenderingContext2D | null => {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      if (canvas.width !== bw) canvas.width = bw;
      if (canvas.height !== bh) canvas.height = bh;
      // 이후 좌표는 viewBox(0..W, 0..H) 그대로 사용 — DPR·균일스케일·레터박스 오프셋 합성
      ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
      ctx.clearRect(-ox / s, -oy / s, canvasPx.w / s, canvasPx.h / s);
      ctx.save();
      ctx.beginPath();
      ctx.rect(PAD.left, PAD.top, cw, ch);
      ctx.clip();
      return ctx;
    };

    // 소실표적 포인트 — 최하층 canvas(SVG 아래, z 맨 뒤). 항적점과 동일 크기(r=1.5) + 반투명 테두리.
    const lossCtx = setup(lossCanvas);
    if (lossCtx) {
      const lr = LOSS_COLOR[0], lg = LOSS_COLOR[1], lb = LOSS_COLOR[2];
      for (const lp of lossPoints) {
        const adjAlt = lp.altM - curvDrop43(lp.distKm);
        const px = xScaleV(lp.distKm);
        const py = yScaleV(adjAlt);
        lossCtx.beginPath();
        lossCtx.arc(px, py, 1.5, 0, Math.PI * 2);
        lossCtx.fillStyle = `rgba(${lr},${lg},${lb},0.9)`;
        lossCtx.fill();
        lossCtx.lineWidth = 0.5;
        lossCtx.strokeStyle = `rgba(${lr},${lg},${lb},0.5)`;
        lossCtx.stroke();
      }
      lossCtx.restore();
    }

    // 항적 포인트 — SVG 위 canvas. <circle r=1.5 fillOpacity=0.7> + PSR 흰 테두리. SVG 와 동일 cx/cy.
    const trackCtx = setup(pointCanvas);
    if (trackCtx) {
      for (const tp of trackPoints) {
        const adjAlt = tp.altM - curvDrop43(tp.distKm);
        const px = xScaleV(tp.distKm);
        const py = yScaleV(adjAlt);
        const col = detectionTypeColor(tp.radarType);
        trackCtx.beginPath();
        trackCtx.arc(px, py, 1.5, 0, Math.PI * 2);
        trackCtx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},0.7)`;
        trackCtx.fill();
        if (PSR_TYPES.has(tp.radarType)) {
          trackCtx.lineWidth = 1;
          trackCtx.strokeStyle = "rgba(255,255,255,0.6)";
          trackCtx.stroke();
        }
      }
      trackCtx.restore();
    }
  }, [chartData, visibleYRange, liveZoom, canvasPx, trackPoints, lossPoints]);

  if (!chartData) return null;

  const {
    adjTerrain, minDetStraight, minDetWithout,
    blocked, significantBuildings, maxDistance, radarHeight,
  } = chartData;
  // 보조 '가시선 차단' 배지 = panorama 판정(losBlockedFromPanorama, 소실표적 분류와 동일 소스) 우선, 없으면 chord 폴백.
  //   헤드라인 'LoS 영향' 배지는 위 hasBldgEffect(§1 요약표와 동일 판정) — 두 지표는 별개(사실상 상반 경향).
  const displayBlocked = blockedOverride ?? blocked;
  // X 줌 윈도우에 맞춰 자동조정된 세로 범위 (전체 줌이면 chartData 전체범위와 동일)
  const { minY, maxY } = visibleYRange ?? chartData;

  // X축 줌 윈도우 (liveZoom: [시작%, 끝%]). [0,100] 이면 전체.
  const zoomStartKm = (liveZoom[0] / 100) * maxDistance;
  const zoomEndKm = (liveZoom[1] / 100) * maxDistance;
  const zoomRangeKm = Math.max(1e-6, zoomEndKm - zoomStartKm);
  const xScale = (d: number) => PAD.left + ((d - zoomStartKm) / zoomRangeKm) * cw;
  const yScale = (h: number) => PAD.top + ch - ((h - minY) / (maxY - minY)) * ch;

  // 지형 채우기 (마지막 profile 포인트까지)
  const lastTerrainD = adjTerrain[adjTerrain.length - 1]?.distance ?? maxDistance;
  const terrainFill =
    `M ${xScale(0)} ${yScale(minY)} ` +
    adjTerrain.map((p) => `L ${xScale(p.distance)} ${yScale(p.height)}`).join(" ") +
    ` L ${xScale(lastTerrainD)} ${yScale(minY)} Z`;
  const terrainLine = adjTerrain
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.distance)} ${yScale(p.height)}`)
    .join(" ");

  const minDetStrPath = minDetStraight
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.distance)} ${yScale(p.height)}`)
    .join(" ");

  // 분석 대상 건물 제외 최저탐지선 (청록 점선) — 대상 후방에서 주황선과 벌어짐
  const minDetWithoutPath = minDetWithout
    ? minDetWithout
        .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.distance)} ${yScale(p.height)}`)
        .join(" ")
    : null;

  // Y축 눈금 (ft) — 격자·라벨은 진고도 y 를 디스플레이 프레임(y − curvDrop43(dist))에 그리므로, tick 은
  //   minY..maxY(디스플레이 높이 범위)가 아닌 표시가능 '진고도' 범위 [minY+drop(zoomStart), maxY+drop(zoomEnd)]
  //   에서 생성해야 윈도우 내 어느 거리에서든 격자가 플롯 안에 들어온다. (종전: 디스플레이 범위에서 생성 →
  //   원거리 줌 윈도우에서 격자·라벨이 곡률강하량만큼 아래로 이탈해 상단 대역이 비었음.)
  //   스텝은 화면 밀도(임의 거리 단면의 가시폭 = maxY−minY) 기준 유지.
  const yRangeFt = (maxY - minY) * M_TO_FT;
  const yStepFt = yRangeFt > 30000 ? 5000 : yRangeFt > 15000 ? 2000 : yRangeFt > 5000 ? 1000 : yRangeFt > 2000 ? 500 : 200;
  const yTicks: number[] = [];
  const minYft = (minY + curvDrop43(zoomStartKm)) * M_TO_FT;
  const maxYft = (maxY + curvDrop43(zoomEndKm)) * M_TO_FT;
  for (let yf = Math.ceil(minYft / yStepFt) * yStepFt; yf <= maxYft; yf += yStepFt) yTicks.push(yf / M_TO_FT);

  // X축 눈금 (NM) — 줌 윈도우 기준
  const zoomStartNm = zoomStartKm * KM_TO_NM;
  const zoomEndNm = zoomEndKm * KM_TO_NM;
  const visNm = zoomEndNm - zoomStartNm;
  const xStepNm = visNm > 80 ? 20 : visNm > 40 ? 10 : visNm > 15 ? 5 : visNm > 5 ? 2 : visNm > 2 ? 1 : 0.5;
  const xTicks: number[] = [];
  for (let xn = Math.ceil(zoomStartNm / xStepNm) * xStepNm; xn <= zoomEndNm + 1e-9; xn += xStepNm) {
    if (xn >= zoomStartNm - 1e-9) xTicks.push(xn / KM_TO_NM);
  }

  // 제목용 빌딩 메타
  const D = los.totalDistance;
  const targetElev = building.ground_elev + building.height;
  const buildingName = building.name || `건물 ${building.id}`;
  const bDistNm = D * KM_TO_NM;

  // 빌딩 카운트 — 분석 대상은 별도 집계(다른 범주서 제외해 중복 라벨 방지)
  const targetCount = significantBuildings.filter((b) => b.isTarget).length;
  const nonTargetBuildings = significantBuildings.filter((b) => !b.isTarget);
  const blockingCount = nonTargetBuildings.filter((b) => b.isBlocking).length;
  const manualCount = nonTargetBuildings.filter((b) => b.is_manual).length;
  const nonBlockingCount = nonTargetBuildings.length - blockingCount;

  // 범례 박스 높이 — LoS + 지형 (2줄, 28px) [+ 대상제외선] + 대상/차폐/비차폐/수동 + 항적/소실표적
  let legendH = 24;
  if (minDetWithout) legendH += 14;
  if (targetCount > 0) legendH += 14;
  if (blockingCount > 0) legendH += 14;
  if (nonBlockingCount > 0) legendH += 14;
  if (manualCount > 0) legendH += 14;
  legendH += 14 + 14; // 항적 + 소실표적

  // clipPath id 안전화 — los.id(레이더명 포함)에 공백·괄호·한글 등이 있으면 url(#id) 참조가 깨져
  //   클리핑이 무력화되고, 줌 시 윈도우 밖 지형·LoS·항적이 차트 축 영역(plot rect)을 넘어 그려진다.
  //   영숫자/_/- 외 문자는 _ 로 치환(클립 rect 는 모든 차트가 동일하므로 충돌해도 무해).
  const idSuffix = `${los.id}-${building.id}`.replace(/[^A-Za-z0-9_-]/g, "_");

  return (
    <div className="mb-3">
      {/* 제목 */}
      <div className="mb-1 flex items-center gap-2">
        {buildingGroup && (
          <span
            className="inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-semibold"
            style={{
              background: `${buildingGroup.color}1a`,
              border: `1px solid ${buildingGroup.color}55`,
              color: buildingGroup.color,
            }}
          >
            <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 1, background: buildingGroup.color }} />
            {buildingGroup.name}
          </span>
        )}
        <span className="text-[13px] font-bold text-gray-800">{buildingName}</span>
        <span className="text-[11px] text-gray-500">
          {radarName} → 방위 {los.bearing.toFixed(1)}° / 거리 {bDistNm.toFixed(1)}NM ({D.toFixed(1)}km)
          / 정상표고(해발) {Math.round(targetElev * M_TO_FT).toLocaleString()}ft ({targetElev.toFixed(0)}m)
        </span>
        {/* 헤드라인 배지 — 추가 차단각 형성 여부(hasBldgEffect, §1 'LoS 영향' 열과 동일 판정).
            파노라마 미가용 시 '판정 불가'(회색) — §1의 '—' 3-상태와 정합. */}
        <span className={`ml-auto rounded px-1.5 py-0.5 text-[11px] font-medium ${
          hasBldgEffect === null ? "bg-gray-100 text-gray-500"
            : hasBldgEffect ? "bg-red-50 text-red-600" : "bg-green-50 text-green-600"
        }`}>
          {hasBldgEffect === null ? "LoS 영향 판정 불가" : hasBldgEffect ? "LoS 영향 O" : "LoS 영향 X"}
        </span>
        {/* 보조 배지 — 가시선 차단(레이더→대상 top 가시성, losBlockedFromPanorama/chord 폴백).
            지형 위로 솟은 대상은 보통 '가시선 차단 X + LoS 영향 O', 지형에 묻힌 대상은 그 반대. */}
        <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
          displayBlocked ? "bg-amber-50 text-amber-600" : "bg-gray-100 text-gray-500"
        }`}>
          {displayBlocked ? "가시선 차단 O" : "가시선 차단 X"}
        </span>
      </div>

      <div className="relative group">
        {editable && (
          <div className="absolute right-1 top-1 z-10 flex items-center gap-1 print:hidden">
            {zoomMode ? (
              <>
                <span className="rounded bg-blue-500/90 px-1.5 py-0.5 text-[9px] font-medium text-white">
                  휠 확대/축소 · 드래그 이동
                </span>
                <button type="button" onClick={resetZoom}
                  className="rounded border border-gray-300 bg-white px-1.5 py-0.5 text-[9px] text-gray-600 hover:bg-gray-100">
                  초기화
                </button>
                <button type="button" onClick={exitZoomMode}
                  className="rounded border border-blue-400 bg-blue-50 px-1.5 py-0.5 text-[9px] font-medium text-blue-600 hover:bg-blue-100">
                  완료
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setZoomMode(true)}
                className="rounded bg-black/40 px-1.5 py-0.5 text-[9px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                클릭하여 줌 편집
              </button>
            )}
          </div>
        )}
      {/* 소실표적 canvas — SVG(지형/건물/LoS선)보다 아래(zIndex:0, z 맨 뒤). 지형 fill 이 반투명이라 비쳐 보인다.
          SVG 에 position:relative+zIndex:1 을 줘야 static 흐름 위로 올라가 이 canvas 를 덮는다. */}
      <canvas
        ref={lossCanvasRef}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: canvasPx.w,
          height: canvasPx.h,
          pointerEvents: "none",
          zIndex: 0,
        }}
      />
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className={`w-full ${zoomMode ? "rounded ring-2 ring-blue-400" : ""}`}
        style={{
          maxHeight: 230,
          position: "relative",
          zIndex: 1,
          cursor: editable
            ? (zoomMode
                ? (liveZoom[0] !== 0 || liveZoom[1] !== 100 ? "grab" : "crosshair")
                : "zoom-in")
            : undefined,
          touchAction: zoomMode ? "none" : undefined,
        }}
        onClick={editable && !zoomMode ? () => setZoomMode(true) : undefined}
      >
        <defs>
          <clipPath id={`cc-${idSuffix}`}>
            <rect x={PAD.left} y={PAD.top} width={cw} height={ch} />
          </clipPath>
        </defs>

        {/* Y축 라벨 (클립 밖) — tick 이 진고도 범위로 확장됐으므로, 윈도우 좌단(zoomStartKm) 기준
            디스플레이 값이 플롯 세로범위 밖인 tick 은 라벨 생략(격자 곡선은 clipPath 가 처리) */}
        {yTicks.map((y) => {
          const yDisp = y - curvDrop43(zoomStartKm);
          if (yDisp < minY - 1e-9 || yDisp > maxY + 1e-9) return null;
          const labelY = yScale(yDisp);
          return (
            <text key={`yl-${y}`} x={PAD.left - 5} y={labelY + 3} textAnchor="end"
              fill="#6b7280" fontSize={9}>
              {Math.round(y * M_TO_FT).toLocaleString()}ft
            </text>
          );
        })}
        {/* X축 라벨 */}
        {xTicks.map((x) => (
          <text key={`xl-${x.toFixed(3)}`} x={xScale(x)} y={H - PAD.bottom + 14} textAnchor="middle"
            fill="#6b7280" fontSize={9}>
            {(x * KM_TO_NM).toFixed(x * KM_TO_NM >= 10 ? 0 : 1)}NM
          </text>
        ))}

        <g clipPath={`url(#cc-${idSuffix})`}>
          {/* 수평 격자 (곡률 반영 곡선) */}
          {yTicks.map((y) => {
            const parts: string[] = [];
            for (let s = 0; s <= 50; s++) {
              const dist = zoomStartKm + (s / 50) * zoomRangeKm;
              parts.push(`${s === 0 ? "M" : "L"} ${xScale(dist)} ${yScale(y - curvDrop43(dist))}`);
            }
            return (
              <path key={`yg-${y}`} d={parts.join(" ")} fill="none"
                stroke={y === 0 ? "rgba(0,0,0,0.15)" : "rgba(0,0,0,0.06)"}
                strokeWidth={y === 0 ? 1 : 0.5} />
            );
          })}
          {/* 수직 격자 */}
          {xTicks.map((x) => (
            <line key={`xg-${x.toFixed(3)}`} x1={xScale(x)} y1={PAD.top} x2={xScale(x)} y2={H - PAD.bottom}
              stroke="rgba(0,0,0,0.06)" strokeWidth={0.5} />
          ))}

          {/* 지형 — 솔리드 녹색 (그라데이션 제거: 바닥이 검게 보이는 문제 회피) */}
          <path d={terrainFill} fill="#22c55e" fillOpacity={0.35} />
          <path d={terrainLine} fill="none" stroke="#22c55e" strokeWidth={1.5} />

          {/* 항적/소실표적 포인트는 SVG 가 아닌 canvas 로 렌더 — 항적은 SVG 위 오버레이(pointCanvasRef),
              소실표적은 SVG 아래 최하층(lossCanvasRef, z 맨 뒤).
              수천~수만 <circle> DOM 노드를 제거해 PDF 캡처(WebView2 PrintToPdf) 병목을 없앤다. */}

          {/* 건물 실루엣 — TrackMap 방식 (사다리꼴 / 세로선) */}
          {significantBuildings.map((b, bi) => {
            const nearD = b.near_dist_km ?? b.distance_km;
            const farD = b.far_dist_km ?? b.distance_km;
            const hasExtent = (farD - nearD) > 0.001;
            const nearGroundAdj = b.ground_elev_m - curvDrop43(nearD);
            const nearTopAdj = (b.ground_elev_m + b.height_m) - curvDrop43(nearD);
            const farGroundAdj = hasExtent ? (b.ground_elev_m - curvDrop43(farD)) : nearGroundAdj;
            const farTopAdj = hasExtent ? ((b.ground_elev_m + b.height_m) - curvDrop43(farD)) : nearTopAdj;
            const bxNear = xScale(nearD);
            const bxFar = hasExtent ? xScale(farD) : bxNear;
            const byBottomNear = yScale(nearGroundAdj);
            const byTopNear = yScale(nearTopAdj);
            const byBottomFar = hasExtent ? yScale(farGroundAdj) : byBottomNear;
            const byTopFar = hasExtent ? yScale(farTopAdj) : byTopNear;
            const bHeight = byBottomNear - byTopNear;
            // 분석 대상은 1px 미만이라도 항상 표시 (분석 주체이므로 누락 금지)
            if (bHeight < 1 && !b.isTarget) return null;

            const baseColor = b.isTarget
              ? "#ea580c"
              : b.is_manual
                ? "#f97316"
                : b.isBlocking
                  ? "rgba(239, 68, 68, 0.8)"
                  : "rgba(148, 163, 184, 0.5)";
            const fillColor = b.isTarget
              ? "rgba(249,115,22,0.35)"
              : b.is_manual
                ? "rgba(249,115,22,0.15)"
                : b.isBlocking
                  ? "rgba(239,68,68,0.15)"
                  : "rgba(148,163,184,0.08)";
            const bStrokeW = b.isTarget ? 1.6 : 1;

            if (hasExtent) {
              const pathD = `M ${bxNear} ${byBottomNear} L ${bxNear} ${byTopNear} L ${bxFar} ${byTopFar} L ${bxFar} ${byBottomFar} Z`;
              return (
                <path key={`bld-${bi}`} d={pathD} fill={fillColor} stroke={baseColor} strokeWidth={bStrokeW} />
              );
            }
            return (
              <line key={`bld-${bi}`}
                x1={bxNear} y1={byBottomNear}
                x2={bxNear} y2={byTopNear}
                stroke={baseColor} strokeWidth={bStrokeW} />
            );
          })}

          {/* 분석 대상 건물 제외 최저탐지선 (청록 점선) — 대상 후방에서 주황선 아래로 벌어짐 */}
          {minDetWithoutPath && (
            <path d={minDetWithoutPath} fill="none"
              stroke="#14b8a6" strokeWidth={1.5} strokeDasharray="5 3" />
          )}

          {/* LoS (직선, 메인) */}
          <path d={minDetStrPath} fill="none"
            stroke="#f59e0b" strokeWidth={1.8} />

          {/* 레이더 위치 라벨 */}
          <text x={xScale(0) + 4} y={PAD.top + 12}
            fill="#6b7280" fontSize={8}>
            {radarName} ({Math.round(radarHeight * M_TO_FT).toLocaleString()}ft)
          </text>

          {/* 소실표적 포인트는 SVG 아래 canvas(lossCanvasRef)에서 그린다 — 위 항적 포인트와 동일 사유. */}
        </g>
        {/* 범례는 canvas(항적/소실표적) 위로 올리려 아래 별도 오버레이 <svg> 로 분리해 그린다. */}
      </svg>
      {/* 항적 포인트 canvas 오버레이 — SVG 플롯 위에 정확히 겹친다(같은 left/top/size·동일 viewBox 스케일).
          pointer-events:none 으로 SVG 의 줌/패닝 상호작용을 가리지 않는다. */}
      <canvas
        ref={pointCanvasRef}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: canvasPx.w,
          height: canvasPx.h,
          pointerEvents: "none",
          zIndex: 1,
        }}
      />
      {/* 범례 오버레이 — 항적 canvas(zIndex:1) 위(zIndex:2)에 그려 표적 포인트에 가려지지 않게.
          메인 SVG 와 동일 viewBox·w-full·maxHeight 로 렌더 박스가 정확히 겹치고(레터박스 스케일 동일),
          pointer-events:none 으로 SVG 의 줌/패닝 상호작용을 가리지 않는다. */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          maxHeight: 230,
          pointerEvents: "none",
          zIndex: 2,
        }}
      >
        {/* 범례 (좌상단 — TrackMap 방식) */}
        <g transform={`translate(${PAD.left + 8}, ${PAD.top + 5})`}>
          <rect x={-4} y={-6} width={200} height={legendH} rx={4}
            fill="rgba(255,255,255,0.9)" stroke="rgba(0,0,0,0.1)" strokeWidth={0.5} />
          <line x1={0} y1={0} x2={20} y2={0} stroke="#f59e0b" strokeWidth={1.8} />
          <text x={24} y={3} fill="#374151" fontSize={8}>
            최저 탐지가능 높이 (LoS, 직선)
          </text>
          <line x1={0} y1={14} x2={20} y2={14} stroke="#22c55e" strokeWidth={1.5} />
          <text x={24} y={17} fill="#374151" fontSize={8}>
            지형 (지구곡률 보정)
          </text>
          {minDetWithout && (
            <>
              <line x1={0} y1={28} x2={20} y2={28} stroke="#14b8a6" strokeWidth={1.5} strokeDasharray="5 3" />
              <text x={24} y={31} fill="#374151" fontSize={8}>
                최저 탐지가능 (분석 대상 제외)
              </text>
            </>
          )}
          {(() => {
            let legendY = minDetWithout ? 38 : 24;
            const items: React.ReactNode[] = [];
            if (targetCount > 0) {
              items.push(
                <g key="leg-tgt">
                  <rect x={2} y={legendY - 4} width={16} height={8}
                    fill="rgba(249,115,22,0.35)" stroke="#ea580c" strokeWidth={0.6} />
                  <text x={24} y={legendY + 3} fill="#374151" fontSize={8}>
                    분석 대상 건물 ({targetCount}동)
                  </text>
                </g>,
              );
              legendY += 14;
            }
            if (blockingCount > 0) {
              items.push(
                <g key="leg-blk">
                  <rect x={2} y={legendY - 4} width={16} height={8}
                    fill="rgba(239,68,68,0.15)" stroke="rgba(239,68,68,0.8)" strokeWidth={0.5} />
                  <text x={24} y={legendY + 3} fill="#374151" fontSize={8}>
                    LoS 차단 건물 ({blockingCount}동)
                  </text>
                </g>,
              );
              legendY += 14;
            }
            if (nonBlockingCount > 0) {
              items.push(
                <g key="leg-nb">
                  <rect x={2} y={legendY - 4} width={16} height={8}
                    fill="rgba(148,163,184,0.08)" stroke="rgba(148,163,184,0.5)" strokeWidth={0.5} />
                  <text x={24} y={legendY + 3} fill="#374151" fontSize={8}>
                    비차단 건물 ({nonBlockingCount}동)
                  </text>
                </g>,
              );
              legendY += 14;
            }
            if (manualCount > 0) {
              items.push(
                <g key="leg-mn">
                  <rect x={2} y={legendY - 4} width={16} height={8}
                    fill="rgba(249,115,22,0.15)" stroke="#f97316" strokeWidth={0.5} />
                  <text x={24} y={legendY + 3} fill="#374151" fontSize={8}>
                    수동 등록 건물 ({manualCount}동)
                  </text>
                </g>,
              );
              legendY += 14;
            }
            items.push(
              <g key="leg-tp">
                <circle cx={9} cy={legendY} r={1.5} fill="rgb(34,197,94)" fillOpacity={0.7} />
                <text x={24} y={legendY + 3} fill="#374151" fontSize={8}>
                  {/* 차트 점 수 — '건'은 이벤트(distinct event_id) 전용 단위라 '점'으로 표기.
                      항적은 백엔드 일별 최대 5,000점 균등표본(track_points_geo) — 소실표적은 전수 */}
                  항적 ({trackPoints.length.toLocaleString()}점 · 일별 최대 5,000점 표본)
                </text>
              </g>,
            );
            legendY += 14;
            items.push(
              <g key="leg-loss">
                <circle cx={9} cy={legendY} r={2.5}
                  fill={`rgb(${LOSS_COLOR[0]},${LOSS_COLOR[1]},${LOSS_COLOR[2]})`} fillOpacity={0.9} />
                <text x={24} y={legendY + 3} fill="#374151" fontSize={8}>
                  {/* 보간점 수(차트 점과 일치) — 이벤트 건수 아님. §3 요약표 'N건 · M점'의 M과 동단위 */}
                  소실표적 ({lossPoints.length.toLocaleString()}점)
                </text>
              </g>,
            );
            return <>{items}</>;
          })()}
        </g>
      </svg>
      </div>
    </div>
  );
}

/**
 * 레이더 기준 건물 방위각 윈도우 안의 항적/소실표적 투영.
 *
 * calcBuildingAzExtent 로 건물 폴리곤(점 건물이면 ±2° 기본값)의 레이더 기준 노출면
 * 방위 구간을 구하고, 양끝에 여유마진 1° 씩 더한 윈도우 안의 포인트를 채택.
 * 거리는 레이더 기준 지상거리(haversine), 최대 줌아웃(200NM, MAX_X_KM)까지 — 건물 후방(음영구역)
 * 항적도 포함. (track_points_geo 는 백엔드에서 건물 중심 방위 ±max(5°, 노출면 반각폭+1.5°) 로 사전
 * 필터되어 들어온다 — ObstacleMonthlyConfigModal 이 buildingAzHalfExtentDeg 와 동일 정의의 반각폭을
 * 전송. 이 윈도우(노출면 ±1°)의 양끝은 중심에서 반각폭+1° ≤ max(5°, 반각폭+1.5°) 이므로 항상 그
 * 부분집합. 단 track_points_geo 는 일별 최대 5,000점 균등표본(의도 설계, MAX_TRACK_POINTS_GEO_PER_DAY)
 * — 항적만 표본이며 소실표적(loss_points_summary)은 전수.)
 */
export function projectPointsToLos(
  los: LoSProfileData,
  trackPoints: TrackPointGeo[],
  lossPoints: LossPointGeo[],
  building: ManualBuilding,
): { track: ChartTrackPoint[]; loss: ChartTrackPoint[] } {
  // 건물 노출면 양끝에 여유마진 1° 씩 추가 (정렬 오차/빔폭 흡수)
  const AZ_MARGIN_DEG = 1;
  const ext = calcBuildingAzExtent(los.radarLat, los.radarLon, building);
  const start = (ext.start_deg - AZ_MARGIN_DEG + 360) % 360;
  const end = (ext.end_deg + AZ_MARGIN_DEG) % 360;
  // 방위 윈도우 판정 — start > end 면 0°/360° 래핑 구간
  const inWindow = (az: number) =>
    start <= end ? az >= start && az <= end : az >= start || az <= end;

  const track: ChartTrackPoint[] = [];
  for (const tp of trackPoints) {
    const distKm = haversineKm(los.radarLat, los.radarLon, tp.lat, tp.lon);
    if (distKm <= 0.001 || distKm > MAX_X_KM) continue;
    if (!inWindow(bearingDeg(los.radarLat, los.radarLon, tp.lat, tp.lon))) continue;
    track.push({
      distKm,
      altM: tp.alt_ft / M_TO_FT,
      radarType: tp.radar_type,
      isLoss: false,
    });
  }
  const loss: ChartTrackPoint[] = [];
  for (const lp of lossPoints) {
    const distKm = haversineKm(los.radarLat, los.radarLon, lp.lat, lp.lon);
    if (distKm <= 0.001 || distKm > MAX_X_KM) continue;
    if (!inWindow(bearingDeg(los.radarLat, los.radarLon, lp.lat, lp.lon))) continue;
    loss.push({
      distKm,
      altM: lp.alt_ft / M_TO_FT,
      radarType: "",
      isLoss: true,
    });
  }
  return { track, loss };
}

