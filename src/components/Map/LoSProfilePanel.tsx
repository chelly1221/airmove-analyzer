import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { X, Loader2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";
import type { ElevationPoint, RadarSite, BuildingOnPath, NearbyPeak, LosCurtainSample } from "../../types";
import { GPU2D, type CircleData } from "../../utils/gpu2d";
import { haversineKm, bearingDeg, LOS_PROFILE_MAX_KM } from "../../utils/geo";
import { detectionTypeColor, PSR_TYPES } from "../../utils/radarConstants";

const R_EARTH_M = 6_371_000;
const R_EFF_M = (R_EARTH_M * 4) / 3; // 4/3 유효지구반경 (표준 대기 굴절 k=4/3)
const LAMBDA_M = 0.1071; // S-band 2.8GHz 파장 (m)

interface LoSTrackPoint {
  distRatio: number;
  altitude: number;
  mode_s: string;
  timestamp: number;
  radar_type: string;
  isLoss: boolean;
}

interface Props {
  radarSite: RadarSite;
  targetLat: number;
  targetLon: number;
  onClose: () => void;
  /** 차트 호버 시 거리 비율(0~1) 콜백, null이면 호버 해제 */
  onHoverDistance?: (ratio: number | null) => void;
  /** LoS 선상 항적/Loss 포인트 전체 */
  losTrackPoints?: LoSTrackPoint[];
  /** 고도 프로파일 로딩 완료 시 콜백 */
  onLoaded?: () => void;
  /** 차트에서 항적 포인트 하이라이트 시 인덱스 콜백 (null이면 해제) */
  onTrackPointHighlight?: (idx: number | null) => void;
  /** 맵에서 클릭한 항적 포인트 인덱스 (외부→차트 하이라이트) */
  externalHighlightIdx?: number | null;
  /** 차트에서 항적 포인트 호버 시 인덱스 콜백 (null이면 해제) */
  onTrackPointHover?: (idx: number | null) => void;
  /** 맵에서 호버한 항적 포인트 인덱스 (외부→차트 호버) */
  externalHoverIdx?: number | null;
  /** 차트에서 건물 호버/클릭 시 건물 정보 콜백 (null이면 해제) */
  onBuildingHover?: (building: { lat: number; lon: number; height_m: number; name: string | null; address: string | null; usage: string | null } | null) => void;
  /** 건물 상세보기 요청 콜백 */
  onBuildingDetail?: (building: BuildingOnPath & { isBlocking?: boolean }) => void;
  /** 주소 검색으로 LoS 분석 시작한 경우의 대상 좌표 — 해당 건물을 목록에 강제 포함하고 파란색으로 구분(자동 선택은 안 함) */
  searchedAddress?: { lat: number; lon: number } | null;
  /** 단면도 레이어 표시 (드로어에서 제어). 미지정 시 모두 표시 */
  layers?: { terrain: boolean; los43: boolean; fresnel: boolean; bra: boolean; cos: boolean };
  /** 프레넬 클리어런스 비율 0~1 (기본 0.8 = 80%) */
  fresnelClearance?: number;
  /** 건물 표시 (제어형). 미지정 시 내부 상태 사용 */
  showBuildings?: boolean;
  onToggleBuildings?: () => void;
  /** 사용자 각도선 표시 (제어형) */
  showCustomAngle?: boolean;
  onToggleCustomAngle?: () => void;
  /** 사용자 각도(°) (제어형) */
  customAngleDeg?: number;
  onCustomAngleChange?: (deg: number) => void;
  /** 차트 내 범례 표시 (드로어가 범례 역할을 하면 false) */
  showLegend?: boolean;
  /** 차단 여부 + 건물 차단/비차단 수 보고 (드로어 헤더/건물 행 갱신용) */
  onStats?: (s: { blocked: boolean; blocking: number; nonBlocking: number }) => void;
  /** 주소검색 건물 LoS 시뮬레이션 — 지반고/높이 사용자 지정값을 단면도 계산에 반영(매칭 건물 덮어쓰기·미매칭 시 가상 건물 주입). 허용높이 산출은 자기 제외 */
  simBuilding?: { lat: number; lon: number; groundElevM: number; heightM: number; name?: string | null } | null;
  /** 시뮬레이션 결과 보고 (허용높이·초과량). simBuilding 없으면 null */
  onSimStats?: (s: { allowableAglM: number; allowableTopAmslM: number; excessM: number; distKm: number } | null) => void;
  /** LoS 수직 단면 커튼 샘플 방출 (지도 3D 표출용, 차트 가시 구간). 프로파일 없으면 null(로딩 중엔 직전 값 유지).
   *  차트 렌더에는 전혀 영향 없음 — chartData 확정 후 별도 useEffect 에서 프레임 역변환만 수행. */
  onCurtainData?: (data: LosCurtainSample[] | null) => void;
  /** 경로상 대상/차단 건물 방출 (지도 하이라이트용 — 대상=파랑, 차단=빨강). 로딩 중엔 직전 값 유지. */
  onPathBuildings?: (d: { target: BuildingOnPath | null; blocking: BuildingOnPath[] } | null) => void;
}


function interpolate(
  lat1: number, lon1: number, lat2: number, lon2: number, t: number
): [number, number] {
  return [lat1 + (lat2 - lat1) * t, lon1 + (lon2 - lon1) * t];
}

/** 디스플레이 프레임 곡률 보정량 (m): 실제 지구반경 기준
 *  → 직선 LoS 가 직선으로, 지형은 거리에 따라 아래로 처져 보임 */
function curvDrop(dKm: number): number {
  const dM = dKm * 1000;
  return (dM * dM) / (2 * R_EARTH_M);
}

/** 4/3 유효지구 곡률 보정량 (m): 표준 대기 굴절 적용 시 레이더 빔이 직선이 되는 프레임.
 *  최저 탐지가능 높이(레이더 빔)는 이 프레임에서 직선으로 전파한 뒤
 *  디스플레이(실제지구) 프레임으로 변환: h_display = h43 + curvDrop43(d) - curvDrop(d) */
function curvDrop43(dKm: number): number {
  const dM = dKm * 1000;
  return (dM * dM) / (2 * R_EFF_M);
}


export default function LoSProfilePanel({ radarSite, targetLat, targetLon, onClose, onHoverDistance, losTrackPoints, onLoaded, onTrackPointHighlight, externalHighlightIdx, onTrackPointHover, externalHoverIdx, onBuildingHover, onBuildingDetail, searchedAddress,
  layers = { terrain: true, los43: true, fresnel: true, bra: true, cos: true },
  fresnelClearance = 0.8,
  showBuildings: showBuildingsProp, onToggleBuildings,
  showCustomAngle: showCustomAngleProp, onToggleCustomAngle,
  customAngleDeg: customAngleDegProp, onCustomAngleChange,
  showLegend = true, onStats, simBuilding, onSimStats, onCurtainData, onPathBuildings }: Props) {
  const manualBuildings = useAppStore((s) => s.manualBuildings);
  const buildingGroups = useAppStore((s) => s.buildingGroups);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<ElevationPoint[]>([]);
  const [peakNames, setPeakNames] = useState<Map<number, string>>(new Map());
  const [buildings, setBuildings] = useState<BuildingOnPath[]>([]);
  const [showBuildingsInternal, setShowBuildingsInternal] = useState(true);
  const showBuildings = showBuildingsProp ?? showBuildingsInternal;
  const setShowBuildings = useCallback((v: boolean) => {
    if (onToggleBuildings) onToggleBuildings();
    else setShowBuildingsInternal(v);
  }, [onToggleBuildings]);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  // X축 줌: [시작%, 끝%] (0~100)
  const [xZoom, setXZoom] = useState<[number, number]>([0, 100]);
  const xZoomRef = useRef<[number, number]>([0, 100]);
  // ── SVG 차트 상수 ──
  const W = 900;
  const H = 280;
  const PAD = { top: 20, right: 30, bottom: 30, left: 65 };
  const cw = W - PAD.left - PAD.right;
  const ch = H - PAD.top - PAD.bottom;
  const [hoveredTrackIdx, setHoveredTrackIdx] = useState<number | null>(null);
  const [pinnedTrackIdx, setPinnedTrackIdx] = useState<number | null>(null);
  const [hoveredBldgIdx, setHoveredBldgIdx] = useState<number | null>(null);
  const [clickedBldgIdx, setClickedBldgIdx] = useState<number | null>(null);
  // 사용자 조절 각도선
  const [customAngleDegInternal, setCustomAngleDegInternal] = useState(0.5);
  const [showCustomAngleInternal, setShowCustomAngleInternal] = useState(false);
  const customAngleDeg = customAngleDegProp ?? customAngleDegInternal;
  const showCustomAngle = showCustomAngleProp ?? showCustomAngleInternal;
  const setCustomAngleDeg = useCallback((v: number) => {
    if (onCustomAngleChange) onCustomAngleChange(v);
    else setCustomAngleDegInternal(v);
  }, [onCustomAngleChange]);
  const setShowCustomAngle = useCallback((v: boolean) => {
    if (onToggleCustomAngle) onToggleCustomAngle();
    else setShowCustomAngleInternal(v);
  }, [onToggleCustomAngle]);
  const customAngleDegRef = useRef(0.5);
  const showCustomAngleRef = useRef(false);
  const isAngleDragging = useRef(false);
  const angleHandlePosRef = useRef<{ x: number; y: number } | null>(null);
  const chartScaleRef = useRef<{ zoomStart: number; zoomEnd: number; zoomRange: number; minY: number; maxY: number } | null>(null);
  // GPU 렌더링 (항적 포인트)
  const trackCanvasRef = useRef<HTMLCanvasElement>(null);
  const gpu2dRef = useRef<GPU2D | null>(null);
  // WebGL 컨텍스트 복구 세대 — contextrestored 시 증가시켜 GPU 재초기화·재그리기 트리거
  const [gpuEpoch, setGpuEpoch] = useState(0);
  // 안정적인 콜백 ref (useCallback 의존성 최소화)
  const hoveredTrackIdxRef = useRef<number | null>(null);
  const pinnedTrackIdxRef = useRef<number | null>(null);
  const trackPointPosRef = useRef<{ x: number; y: number; idx: number }[]>([]);
  const onTrackPointHoverRef = useRef(onTrackPointHover);
  const onTrackPointHighlightRef = useRef(onTrackPointHighlight);
  // 맵에서 클릭한 포인트 → 차트 핀 동기화
  const prevExternalIdx = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (externalHighlightIdx === prevExternalIdx.current) return;
    prevExternalIdx.current = externalHighlightIdx;
    if (externalHighlightIdx != null && externalHighlightIdx !== pinnedTrackIdx) {
      setPinnedTrackIdx(externalHighlightIdx);
    } else if (externalHighlightIdx == null && pinnedTrackIdx !== null) {
      setPinnedTrackIdx(null);
    }
  }, [externalHighlightIdx]);
  // Ref 동기화 (안정적 콜백용)
  hoveredTrackIdxRef.current = hoveredTrackIdx;
  pinnedTrackIdxRef.current = pinnedTrackIdx;
  onTrackPointHoverRef.current = onTrackPointHover;
  onTrackPointHighlightRef.current = onTrackPointHighlight;
  customAngleDegRef.current = customAngleDeg;
  showCustomAngleRef.current = showCustomAngle;
  // 드래그 패닝
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartZoom = useRef<[number, number]>([0, 100]);

  const totalDist = haversineKm(radarSite.latitude, radarSite.longitude, targetLat, targetLon);
  const bearing = bearingDeg(radarSite.latitude, radarSite.longitude, targetLat, targetLon);
  const radarHeight = radarSite.altitude + radarSite.antenna_height;
  // 단면도 x축 도메인: 기본 200NM, 타겟이 더 멀면 타겟까지. 차트는 이 범위 안에서 스크롤 줌.
  const profileMaxKm = useMemo(() => Math.max(LOS_PROFILE_MAX_KM, totalDist), [totalDist]);
  // 단면도 진입 시 타겟 부근을 보여주는 기본 줌(스크롤로 profileMaxKm까지 줌아웃)
  const fitZoom = useMemo<[number, number]>(() => {
    const fitKm = Math.max(totalDist * 1.15, 5 * 1.852); // 최소 ~5NM 가시
    return [0, Math.min(100, (fitKm / profileMaxKm) * 100)];
  }, [totalDist, profileMaxKm]);

  // 고도 프로파일 API 호출
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;
  useEffect(() => {
    let cancelled = false;
    const fetchElevation = async () => {
      // 재조회 중에도 직전 데이터(profile/peakNames/buildings)를 유지 — 탭 전환 시 차트·커튼이
      //   빈 상태로 한 번 접혔다 펴지는 깜박임 방지. 새 데이터 도착 시 통째로 교체된다.
      //   (선택 상태만 초기화: 인덱스가 새 데이터와 어긋나므로)
      setLoading(true);
      setPinnedTrackIdx(null);
      setHoveredTrackIdx(null);
      setHoveredBldgIdx(null);
      setClickedBldgIdx(null);
      onBuildingHover?.(null);
      // 방위(레이더→타겟)를 따라 profileMaxKm(기본 200NM)까지 샘플링 → 차트에서 스크롤로 자유 줌.
      // 평면(등거리) 투영으로 원거리 종점 계산: 항적 코리도(TrackMap)와 동일 축 → distRatio 정합.
      const DEG2RAD = Math.PI / 180;
      const mPerDegLat = DEG2RAD * R_EARTH_M;
      const mPerDegLon = mPerDegLat * Math.cos(radarSite.latitude * DEG2RAD);
      const dLatM = (targetLat - radarSite.latitude) * mPerDegLat;
      const dLonM = (targetLon - radarSite.longitude) * mPerDegLon;
      const dirLen = Math.hypot(dLatM, dLonM) || 1;
      const farM = profileMaxKm * 1000;
      const farLat = radarSite.latitude + ((dLatM / dirLen) * farM) / mPerDegLat;
      const farLon = radarSite.longitude + ((dLonM / dirLen) * farM) / mPerDegLon;
      // ~0.5km 간격 유지(근거리 해상도 보존) — 전수 샘플 원칙, 다운샘플 금지
      const numSamples = Math.min(760, Math.max(150, Math.round(profileMaxKm / 0.5)));
      const lats: number[] = [];
      const lons: number[] = [];
      for (let i = 0; i <= numSamples; i++) {
        const t = i / numSamples;
        const [lat, lon] = interpolate(
          radarSite.latitude, radarSite.longitude, farLat, farLon, t
        );
        lats.push(lat);
        lons.push(lon);
      }

      try {
        // Rust 백엔드 경유 (DB 캐시 우선, 미스분만 API 호출)
        const allElevations: number[] = await invoke("fetch_elevation", {
          latitudes: lats,
          longitudes: lons,
        });

        if (cancelled) return;

        const points: ElevationPoint[] = lats.map((lat, i) => ({
          distance: haversineKm(radarSite.latitude, radarSite.longitude, lat, lons[i]),
          elevation: Math.max(0, allElevations[i] ?? 0),
          latitude: lat,
          longitude: lons[i],
        }));
        setProfile(points);

        // 건물 데이터 조회 — 코리도를 단면도 전체 길이(farLat/farLon = profileMaxKm, 기본 200NM)까지 연장.
        //   지형/최저탐지선·항적점이 200NM 까지 그려지므로(줌아웃) 건물도 같은 범위로 조회해야 줌 어느 단계에서나
        //   선과 건물이 함께 보인다. farLat/farLon 은 레이더→타겟 방위선상의 200NM 점(위 프로파일 종점과 동일).
        //   백엔드가 코리도를 세그먼트 bbox 로 조회하므로 장거리 연장도 빠름.
        // 이번 effect 런에서 조회한 건물 (조회 실패 시 빈 배열) — 아래 산 이름 결정에 상태 buildings 대신
        //   이 로컬 값을 사용해 타겟 변경 시 이전 타겟 건물을 참조하는 stale closure 방지
        let bldgs: BuildingOnPath[] = [];
        try {
          bldgs = await invoke<BuildingOnPath[]>("query_buildings_along_path", {
            radarLat: radarSite.latitude,
            radarLon: radarSite.longitude,
            targetLat: farLat,
            targetLon: farLon,
            corridorWidthM: 100.0,
          });
          // building.rs 는 건물 거리를 (평면 직선 파라메트릭 t)×(haversine 총거리)로 반환 — 지형 축은
          //   평면 보간점의 haversine 라벨이라 대각·장거리 중간 구간에서 수백 m 벌어짐.
          //   동일 보간 구성으로 t→haversine 재라벨링해 지형·항적점과 x축 프레임 통일.
          //   (단일 choke-point: setBuildings·아래 산 이름 루프 모두 변환값 사용)
          const totalHavKm = haversineKm(radarSite.latitude, radarSite.longitude, farLat, farLon);
          if (totalHavKm > 1e-6) {
            const toHav = (d: number): number => {
              const t = Math.min(1, Math.max(0, d / totalHavKm));
              const [hLat, hLon] = interpolate(radarSite.latitude, radarSite.longitude, farLat, farLon, t);
              return haversineKm(radarSite.latitude, radarSite.longitude, hLat, hLon);
            };
            bldgs = bldgs.map((b) => ({
              ...b,
              distance_km: toHav(b.distance_km),
              near_dist_km: b.near_dist_km != null ? toHav(b.near_dist_km) : b.near_dist_km,
              far_dist_km: b.far_dist_km != null ? toHav(b.far_dist_km) : b.far_dist_km,
            }));
          }
        } catch {
          // 건물 데이터 조회 실패 → 빈 목록으로 교체 (아래 공통 반영)
        }
        // 조회 결과로 통째 교체 — 0건이어도 반드시 반영. effect 시작부에서 상태를 비우지 않으므로
        //   (탭 전환 깜박임 방지) 여기가 유일한 교체 지점이고, 건너뛰면 이전 타겟 건물이 잔류한다.
        //   백엔드(query_buildings_along_path)가 GIS 건물 지반을 centroid SRTM(live)로, 수동 건물은 사용자 입력값으로 제공함
        if (!cancelled) setBuildings(bldgs);

        // 최저 탐지가능 높이 선을 실질적으로 가장 크게 올린 산 1개 찾기
        // = 조정 프레임에서 가장 큰 그림자를 만드는 지형점
        let dominantPeakIdx = -1;
        let dominantShadowArea = 0;
        for (let i = 1; i < points.length - 1; i++) {
          const di = points[i].distance;
          if (di <= 0) continue;
          if (di > totalDist) break; // 산 이름은 타겟까지의 차단 지형만 대상 (원거리 확장 구간 제외)
          // 건물을 포함한 effective elevation 사용 — 산 이름은 "지형+건물 통합 장애물" 모델 기준의
          //   결정적 값이어야 하므로 showBuildings 토글과 무관하게, 이번 런에서 조회한 bldgs 사용
          //   (상태 buildings 는 이 effect 의존성 밖이라 타겟 변경 시 이전 타겟 값으로 stale)
          let elev = points[i].elevation;
          for (const b of bldgs) {
            const nearD = b.near_dist_km ?? b.distance_km;
            const farD = b.far_dist_km ?? b.distance_km;
            if (di >= nearD - 0.05 && di <= farD + 0.05) {
              const bTop = b.ground_elev_m + b.height_m;
              if (bTop > elev) elev = bTop;
            }
          }
          const adjH = elev - curvDrop(di);
          if (adjH <= radarHeight) continue;
          // 이 지형점이 만드는 그림자: 뒤쪽 포인트들에서 얼마나 최저선을 올리는지 합산
          let shadowSum = 0;
          for (let j = i + 1; j < points.length && points[j].distance <= totalDist; j++) {
            const dj = points[j].distance;
            const shadow = radarHeight + (adjH - radarHeight) * (dj / di);
            const adjTj = points[j].elevation - curvDrop(dj);
            const baseline = Math.max(radarHeight, adjTj);
            if (shadow > baseline) shadowSum += shadow - baseline;
          }
          if (shadowSum > dominantShadowArea) {
            dominantShadowArea = shadowSum;
            dominantPeakIdx = i;
          }
        }

        // 가장 영향력 있는 산 1개만 이름 조회 (로컬 DB)
        //   건물과 마찬가지로 결과가 없어도 반드시 교체 — 이전 타겟의 산 이름/인덱스 잔류 방지
        const newPeaks = new Map<number, string>();
        if (dominantPeakIdx >= 0 && !cancelled) {
          const peakLat = points[dominantPeakIdx].latitude;
          const peakLon = points[dominantPeakIdx].longitude;
          try {
            const peaks = await invoke<NearbyPeak[]>("query_nearby_peaks", {
              lat: peakLat, lon: peakLon, radiusKm: 3.0,
            });
            if (peaks.length > 0) newPeaks.set(dominantPeakIdx, peaks[0].name);
          } catch {
            // 산 이름 조회 실패 - 비치명적
          }
        }
        if (!cancelled) setPeakNames(newPeaks);
      } catch (err) {
        console.error("Elevation fetch failed:", err);
        if (!cancelled) {
          const points: ElevationPoint[] = lats.map((lat, i) => ({
            distance: haversineKm(radarSite.latitude, radarSite.longitude, lat, lons[i]),
            elevation: 0,
            latitude: lat,
            longitude: lons[i],
          }));
          setProfile(points);
          // 고도 조회 실패 시에도 건물/산 이름은 이전 타겟 값이 남지 않도록 비움
          setBuildings([]);
          setPeakNames(new Map());
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          onLoadedRef.current?.();
        }
      }
    };

    fetchElevation();
    return () => { cancelled = true; };
  }, [radarSite, targetLat, targetLon]);

  // ── 차트 데이터: 실제 지구(R) 조정 프레임 — 직선 LOS가 직선으로 표시 ──
  const chartData = useMemo(() => {
    if (profile.length === 0) return null;

    const D = totalDist; // 타겟(클릭 지점)까지의 거리 — 차단 판정·LoS 직선 기준
    // targetElev는 interpTerrainElev 정의 후 보간으로 계산 (프로파일이 타겟 너머 200NM까지 확장됨)

    // ── 주소검색 시뮬레이션 값의 차트 반영 (2026-08-03) ──
    //   카드에서 수정한 지반고/건물높이를 단면도 계산 전체(장애물·최저탐지선·차단판정·건물 막대·커튼)에 반영.
    //   ① simBuilding 좌표 15m 이내 최근접 건물이 있으면 그 건물의 지반고/높이만 덮어쓰기(도형·거리 유지)
    //   ② 매칭 건물이 없으면(미등록 지점) 해당 지점에 폭 20m 가상 점 건물을 주입
    //   simD 는 아래 허용높이(sim) 블록과 공유 — 차트 x축(t→haversine 재라벨) 프레임 투영, 기존 sim 식과 동일.
    //   허용 상한(sim) 산출은 여전히 '자기 자신 15m 제외' 경로라 자기참조 오염 없음(가상 건물도 좌표 일치로 제외).
    let simD: number | null = null;
    let effBuildings = buildings;
    if (simBuilding && profile.length > 1) {
      const simB = simBuilding;
      const far = profile[profile.length - 1];
      const DEG2RAD = Math.PI / 180;
      const mPerDegLat = DEG2RAD * R_EARTH_M;
      const mPerDegLon = mPerDegLat * Math.cos(radarSite.latitude * DEG2RAD);
      const dLatM = (far.latitude - radarSite.latitude) * mPerDegLat;
      const dLonM = (far.longitude - radarSite.longitude) * mPerDegLon;
      const farM = Math.hypot(dLatM, dLonM) || 1;
      const ux = dLatM / farM, uy = dLonM / farM;
      const sLatM = (simB.lat - radarSite.latitude) * mPerDegLat;
      const sLonM = (simB.lon - radarSite.longitude) * mPerDegLon;
      const along = sLatM * ux + sLonM * uy; // radar→far 축상 along 거리(m)
      const t = Math.max(0, Math.min(1, along / farM));
      const [iLat, iLon] = interpolate(radarSite.latitude, radarSite.longitude, far.latitude, far.longitude, t);
      simD = haversineKm(radarSite.latitude, radarSite.longitude, iLat, iLon);

      const heightM = isNaN(simB.heightM) ? 0 : simB.heightM;
      const groundElevM = isNaN(simB.groundElevM) ? 0 : simB.groundElevM;
      let bestIdx = -1, bestM = 15; // 15m — 아래 sim 자기제외와 동일 기준(양쪽이 같은 건물을 가리켜야 함)
      for (let i = 0; i < buildings.length; i++) {
        const m = haversineKm(buildings[i].lat, buildings[i].lon, simB.lat, simB.lon) * 1000;
        if (m < bestM) { bestM = m; bestIdx = i; }
      }
      if (bestIdx >= 0) {
        effBuildings = buildings.slice();
        const b = effBuildings[bestIdx];
        effBuildings[bestIdx] = { ...b, ground_elev_m: groundElevM, height_m: heightM, total_height_m: groundElevM + heightM };
      } else if (simD > 0.001) {
        const HALF_W = 0.01; // 가상 건물 반폭 10m
        effBuildings = buildings.concat([{
          distance_km: simD,
          near_dist_km: Math.max(0, simD - HALF_W),
          far_dist_km: simD + HALF_W,
          height_m: heightM,
          ground_elev_m: groundElevM,
          total_height_m: groundElevM + heightM,
          name: simB.name ?? null,
          address: null,
          usage: null,
          lat: simB.lat,
          lon: simB.lon,
          is_manual: false,
        }]);
      }
    }

    // 1) 조정 지형 (실제 지구곡률 반영 → 지형이 거리에 따라 아래로 처짐)
    const adjTerrain = profile.map((p) => ({
      distance: p.distance,
      height: p.elevation - curvDrop(p.distance),
    }));

    // 1.5) 통합 장애물 배열: 지형 프로파일 + 건물을 거리순 병합
    //    shadow-casting에서 건물을 정확한 위치의 독립 장애물로 처리
    interface Obstacle { distance: number; elevation: number; }
    const obstacles: Obstacle[] = [];
    for (const p of profile) {
      obstacles.push({ distance: p.distance, elevation: p.elevation });
    }
    if (showBuildings && effBuildings.length > 0) {
      for (const b of effBuildings) {
        const bTop = b.ground_elev_m + b.height_m;
        const nearD = b.near_dist_km ?? b.distance_km;
        const farD = b.far_dist_km ?? b.distance_km;
        // 건물 양쪽 끝에 장애물 추가 (도형 건물의 경우 양쪽 경계)
        obstacles.push({ distance: nearD, elevation: bTop });
        if (farD - nearD > 0.001) {
          obstacles.push({ distance: farD, elevation: bTop });
        }
      }
    }
    obstacles.sort((a, b) => a.distance - b.distance);

    // 건물 경계 거리 목록 (쉐도잉 라인에 건물 경계점 삽입용)
    interface BuildingEdge { nearD: number; farD: number; topElev: number; groundElev: number; }
    const buildingEdges: BuildingEdge[] = [];
    if (showBuildings && effBuildings.length > 0) {
      for (const b of effBuildings) {
        const nearD = b.near_dist_km ?? b.distance_km;
        const farD = b.far_dist_km ?? b.distance_km;
        buildingEdges.push({
          nearD,
          farD,
          topElev: b.ground_elev_m + b.height_m,
          groundElev: b.ground_elev_m,
        });
      }
    }

    // 프로파일에서 특정 거리의 지형 고도 보간
    const interpTerrainElev = (d: number): number => {
      if (d <= profile[0].distance) return profile[0].elevation;
      if (d >= profile[profile.length - 1].distance) return profile[profile.length - 1].elevation;
      for (let i = 1; i < profile.length; i++) {
        if (profile[i].distance >= d) {
          const denom = profile[i].distance - profile[i - 1].distance;
          const t = denom > 1e-9 ? (d - profile[i - 1].distance) / denom : 0;
          return profile[i - 1].elevation + t * (profile[i].elevation - profile[i - 1].elevation);
        }
      }
      return 0;
    };

    // 타겟 거리에서의 지형 고도 — 프로파일이 200NM까지 확장되므로 보간으로 추출 (마지막 포인트≠타겟)
    const targetElev = interpTerrainElev(D);
    const adjTarget = targetElev - curvDrop(D);

    // 통합 샘플 거리: 프로파일 포인트 + 건물 경계 (쉐도잉 라인이 건물에서 수직으로 오르도록)
    const sampleDists: number[] = profile.map(p => p.distance);
    for (const be of buildingEdges) {
      // 건물 바로 앞에도 포인트 삽입 (수직 전환 보장)
      const eps = 0.0005; // ~0.5m
      if (be.nearD > eps) sampleDists.push(be.nearD - eps);
      sampleDists.push(be.nearD);
      if (be.farD - be.nearD > 0.001) {
        sampleDists.push(be.farD);
        sampleDists.push(be.farD + eps);
      } else {
        sampleDists.push(be.nearD + eps);
      }
    }
    // 중복 제거 & 정렬
    const uniqueDists = [...new Set(sampleDists)].sort((a, b) => a - b);

    // 특정 거리에서 건물 높이를 포함한 유효 고도 (곡률 미보정 AMSL)
    const effectiveElevAt = (d: number): number => {
      let elev = interpTerrainElev(d);
      for (const be of buildingEdges) {
        if (d >= be.nearD && d <= be.farD + 0.0001) {
          if (be.topElev > elev) elev = be.topElev;
        }
      }
      return elev;
    };

    // 2) 최저 탐지가능 높이 - LoS (4/3 유효지구 굴절 적용, Running Max Angle: 계곡에서 꺾이지 않음)
    //    레이더 빔은 4/3 프레임에서 직선 → 앙각을 4/3 프레임에서 계산 후
    //    디스플레이(실제지구) 프레임으로 변환: h_display = h43 + curvDrop43(d) - curvDrop(d)
    let maxAngle43 = -Infinity;
    let obIdxStraight = 0;
    const minDetStraight = uniqueDists.map((d) => {
      if (d <= 0) return { distance: d, height: radarHeight };
      const dM = d * 1000;

      // 현재 거리까지의 장애물(지형+건물)에서 4/3 프레임 최대 앙각 갱신
      while (obIdxStraight < obstacles.length && obstacles[obIdxStraight].distance <= d + 1e-9) {
        const ob = obstacles[obIdxStraight];
        if (ob.distance > 0) {
          const adjH43 = ob.elevation - curvDrop43(ob.distance);
          const angle = (adjH43 - radarHeight) / (ob.distance * 1000);
          if (angle > maxAngle43) maxAngle43 = angle;
        }
        obIdxStraight++;
      }

      // 현재 지점의 유효 고도(건물 포함)도 4/3 앙각에 반영
      const terrElev = effectiveElevAt(d);
      const terrAngle = (terrElev - curvDrop43(d) - radarHeight) / dM;
      if (terrAngle > maxAngle43) maxAngle43 = terrAngle;

      // 4/3 프레임 빔 높이 → 디스플레이(실제지구) 프레임 변환, 디스플레이 지형을 floor 로
      const losDisplay = radarHeight + maxAngle43 * dM + curvDrop43(d) - curvDrop(d);
      const adjTerrainDisplay = terrElev - curvDrop(d);
      return { distance: d, height: Math.max(adjTerrainDisplay, losDisplay) };
    });

    // 2.5) 최저 탐지가능 높이 - LoS (4/3 굴절) + 프레넬존 80% 클리어런스
    //   프레넬 반경이 평가 거리에 의존하므로 O(n²) 유지. 그림자 외삽을 4/3 프레임에서 수행 후
    //   디스플레이 프레임으로 변환. 4/3 직선 LoS를 floor로 적용
    const minDetFresnel = uniqueDists.map((d, idx) => {
      if (d <= 0) return { distance: d, height: radarHeight };
      const dM = d * 1000;

      let maxShadow43 = radarHeight; // 4/3 프레임 그림자 높이
      for (const ob of obstacles) {
        if (ob.distance <= 0 || ob.distance >= d) continue;
        const diM = ob.distance * 1000;
        const adjH43 = ob.elevation - curvDrop43(ob.distance);
        const f1 = Math.sqrt(LAMBDA_M * diM * (dM - diM) / dM);
        const adjHFresnel = adjH43 + fresnelClearance * f1;
        const shadow = radarHeight + (adjHFresnel - radarHeight) * (d / ob.distance);
        if (shadow > maxShadow43) maxShadow43 = shadow;
      }

      const terrElev = effectiveElevAt(d);
      const adjTerrainDisplay = terrElev - curvDrop(d);
      // 4/3 프레임 그림자 → 디스플레이 프레임 변환
      const maxShadowDisplay = maxShadow43 + curvDrop43(d) - curvDrop(d);
      // 4/3 직선 LoS(running max angle 적용됨)를 floor로 사용하여 계곡 꺾임 방지
      return {
        distance: d,
        height: Math.max(adjTerrainDisplay, maxShadowDisplay, minDetStraight[idx].height),
      };
    });

    // 3) CoS (Cone of Silence) 70° 기준선
    const COS_DEG = 70;
    const cosLine = profile.map((p) => ({
      distance: p.distance,
      height: radarHeight + p.distance * 1000 * Math.tan((COS_DEG * Math.PI) / 180),
    }));

    // 4) 0.25° BRA 기준선 (실제 앙각 기준 직선)
    const BRA_DEG = 0.25;
    const braLine = profile.map((p) => ({
      distance: p.distance,
      height: radarHeight + p.distance * 1000 * Math.tan((BRA_DEG * Math.PI) / 180),
    }));

    // 차단 판정 — 4/3 유효지구 현(chord): 레이더↔타겟 직선을 4/3 프레임에서 평가
    //   (지도측 los.rs·OM 보고서 computeLosBlockage 와 동일 식 — 실제지구 판정은 4/3 대비
    //   d(D−d)/(8R)만큼 비관적이라 경계 케이스에서 배지·건물 분류가 지도와 뒤집힘)
    const adjTarget43 = targetElev - curvDrop43(D);
    const chord43H = (d: number) =>
      radarHeight + (adjTarget43 - radarHeight) * (d / D);
    let blocked = false;
    let maxBlockPoint: {
      distance: number;
      adjHeight: number;
      realElevation: number;
      name?: string;
    } | null = null;
    let maxExcess = 0;
    // 통합 장애물로 차단 판정 (지형 + 건물) — 판정(excess·blocked)만 4/3,
    //   마커 좌표(adjHeight)는 차트 yScale·isBlocking 비교와 같은 디스플레이(실제지구) 프레임 유지
    for (const ob of obstacles) {
      if (ob.distance <= 0 || ob.distance >= D) continue;
      const excess = (ob.elevation - curvDrop43(ob.distance)) - chord43H(ob.distance);
      if (excess > maxExcess) {
        maxExcess = excess;
        blocked = true;
        maxBlockPoint = {
          distance: ob.distance,
          adjHeight: ob.elevation - curvDrop(ob.distance),
          realElevation: ob.elevation,
        };
      }
    }
    // 최대 차단점에 산 이름 매칭 (프로파일 인덱스 기반)
    if (maxBlockPoint) {
      for (const [idx, name] of peakNames.entries()) {
        if (idx >= 0 && idx < profile.length &&
            Math.abs(profile[idx].distance - maxBlockPoint.distance) < 0.1) {
          maxBlockPoint.name = name;
          break;
        }
      }
    }

    // 이름이 있는 모든 산 (차트에 표시용)
    const namedPeaks: { idx: number; distance: number; adjHeight: number; realElevation: number; name: string }[] = [];
    for (const [idx, name] of peakNames.entries()) {
      if (idx >= 0 && idx < profile.length) {
        namedPeaks.push({
          idx,
          distance: profile[idx].distance,
          adjHeight: adjTerrain[idx].height,
          realElevation: profile[idx].elevation,
          name,
        });
      }
    }

    // Y축 범위 (CoS는 매우 가파르므로 maxY에 포함하지 않음 - 차트 가독성)
    const allHeights = [
      radarHeight,
      ...adjTerrain.map((p) => p.height),
      ...minDetStraight.map((p) => p.height),
      ...minDetFresnel.map((p) => p.height),
      ...braLine.map((p) => p.height),
    ];
    let maxY = -Infinity;
    for (const h of allHeights) if (h > maxY) maxY = h;
    maxY += 100;
    let minY = 0;
    for (const p of adjTerrain) if (p.height < minY) minY = p.height;
    minY -= 50;
    // 0ft가 차트 40% 지점보다 위로 오지 않도록 maxY를 능동 조절
    // 0ft 위치 = (0 - minY) / (maxY - minY) → 아래에서 위로의 비율
    // 차트에서 40% 높이 이하에 0ft가 오려면: (0 - minY) / (maxY - minY) <= 0.4
    // → maxY >= -minY / 0.4 + minY = minY * (1 - 1/0.4) + 0 = -1.5 * minY
    // 즉 0이 40% 이하에 오려면 maxY >= -minY * 1.5
    if (minY < 0) {
      const minMaxYFor40Pct = -minY * 1.5;
      if (maxY < minMaxYFor40Pct) maxY = minMaxYFor40Pct;
    }

    // 차폐에 영향을 주는 건물만 필터링:
    // 건물 꼭대기가 지형만으로 생성된 shadow보다 높으면 = 실질 차폐 기여
    const significantBuildings: (BuildingOnPath & { isBlocking: boolean })[] = [];
    // 주소 검색으로 지정된 건물 찾기 (검색 좌표에 가장 가까운 건물, 150m 이내)
    let searchedBldg: BuildingOnPath | null = null;
    if (searchedAddress && effBuildings.length > 0) {
      let bestD2 = Infinity;
      const cosLat = Math.cos(searchedAddress.lat * Math.PI / 180);
      for (const b of effBuildings) {
        const dLat = (b.lat - searchedAddress.lat) * 111.32;
        const dLon = (b.lon - searchedAddress.lon) * 111.32 * cosLat;
        const d2 = dLat * dLat + dLon * dLon;
        if (d2 < bestD2) { bestD2 = d2; searchedBldg = b; }
      }
      // 150m 이내에 건물이 없으면 무시
      if (Math.sqrt(bestD2) > 0.15) searchedBldg = null;
    }
    let searchedBldgIdx: number | null = null;
    if (showBuildings && effBuildings.length > 0) {
      for (const b of effBuildings) {
        const bDist = b.distance_km;
        // 단면도 전체 길이(profileMaxKm, 기본 200NM)까지 건물 표시 — 줌아웃 시 타겟 너머 건물도 함께.
        //   차단(isBlocking)은 레이더→타겟(0..D) 구간에서만 성립하므로 near≥D 인 타겟 너머 건물은
        //   아래 교집합(s0>s1)에서 자동으로 비차단 처리된다.
        if (bDist <= 0 || bDist >= profileMaxKm) continue;
        const bTop = b.ground_elev_m + b.height_m;
        const bAdj = bTop - curvDrop(bDist);

        // 건물별 차단 판정 — 4/3 현(chord43H) 관통 여부. maxBlockPoint 근접 귀속은
        //   ① 최대 차단점 옆의 무관 건물을 빨강으로 오탐, ② 현을 관통하지만 최대점이 아닌 건물을 누락시킨다.
        //   건물 상단이 레이더→타겟 구간 교집합의 어느 한 끝에서라도 현 위로 올라오면 차단 기여(선형이라 양끝 검사로 충분).
        const bNearD = b.near_dist_km ?? b.distance_km;
        const bFarD = b.far_dist_km ?? b.distance_km;
        const s0 = Math.max(bNearD, 0.001), s1 = Math.min(bFarD, D - 0.001);
        let isBlk = false;
        if (s0 <= s1) {
          const excessAt = (d: number) => (bTop - curvDrop43(d)) - chord43H(d);
          isBlk = Math.max(excessAt(s0), excessAt(s1)) > 0;
        }

        // 지형만으로 생성된 shadow (실제지구 프레임)
        let terrainShadow = radarHeight;
        for (const p of profile) {
          if (p.distance <= 0 || p.distance >= bDist) continue;
          const adjH = p.elevation - curvDrop(p.distance);
          const shadow = radarHeight + (adjH - radarHeight) * (bDist / p.distance);
          if (shadow > terrainShadow) terrainShadow = shadow;
        }
        const isSearched = searchedBldg !== null && b === searchedBldg;
        // 실제 차단 건물(isBlk)은 지형 그림자에 묻혀도 목록에 포함 — 누락 시 지도 빨강 표시가 사라진다
        if (bAdj > terrainShadow || isSearched || isBlk) {
          if (isSearched) searchedBldgIdx = significantBuildings.length;
          significantBuildings.push({ ...b, isBlocking: isBlk });
        }
      }
    }

    // ── 주소검색 건물 LoS 허용높이 시뮬레이션 ──
    //   차트 장애물은 위 effBuildings(사용자 지정값 반영)를 사용. 허용 상한 산출만 '자기 자신(15m 이내) 제외'한
    //   별도 장애물 경로(simObstacles)로 계산해 "그 건물이 없을 때의 최저탐지선(4/3)"을 구한다(자기참조 오염 방지).
    let sim: {
      simD: number;
      allowableTopAmslM: number;
      allowableAglM: number;
      excessM: number;
    } | null = null;
    if (simBuilding && simD != null) {
      const simB = simBuilding;
      const sd = simD; // non-null 좁히기 (아래 클로저·비교에서 number 로 사용)
      // sim 전용 장애물: 지형(전부) + 건물(showBuildings 시, 단 sim 건물 15m 제외)
      //   덮어쓴 건물/가상 건물 모두 simB 좌표와 일치하므로 자동 제외된다.
      const simObstacles: Obstacle[] = [];
      for (const p of profile) simObstacles.push({ distance: p.distance, elevation: p.elevation });
      if (showBuildings && effBuildings.length > 0) {
        for (const b of effBuildings) {
          if (haversineKm(b.lat, b.lon, simB.lat, simB.lon) * 1000 < 15) continue; // 자기 자신 제외
          const bTop = b.ground_elev_m + b.height_m;
          const nearD = b.near_dist_km ?? b.distance_km;
          const farD = b.far_dist_km ?? b.distance_km;
          simObstacles.push({ distance: nearD, elevation: bTop });
          if (farD - nearD > 0.001) simObstacles.push({ distance: farD, elevation: bTop });
        }
      }

      const groundElevM = simB.groundElevM;
      const heightM = isNaN(simB.heightM) ? 0 : simB.heightM;
      // 허용 상한: sim 제외 장애물에서 (simD 직전 30m 까지) 4/3 프레임 최대 앙각
      let maxAngle = -Infinity;
      for (const ob of simObstacles) {
        if (ob.distance > 0 && ob.distance < sd - 0.03) {
          const angle = (ob.elevation - curvDrop43(ob.distance) - radarHeight) / (ob.distance * 1000);
          if (angle > maxAngle) maxAngle = angle;
        }
      }
      const rayTopAmsl = radarHeight + maxAngle * sd * 1000 + curvDrop43(sd);
      // 지면 클램프: 지면이 이미 보이면 허용높이 0 (maxAngle=-Infinity 케이스도 이 클램프로 처리)
      const allowableTopAmslM = Math.max(rayTopAmsl, groundElevM);
      const allowableAglM = allowableTopAmslM - groundElevM; // ≥0
      const excessM = (groundElevM + heightM) - allowableTopAmslM; // 양수=초과, 음수=여유
      sim = { simD: sd, allowableTopAmslM, allowableAglM, excessM };
    }

    return {
      adjTerrain,
      minDetStraight,
      minDetFresnel,
      braLine,
      cosLine,
      blocked,
      maxBlockPoint,
      namedPeaks,
      significantBuildings,
      searchedBldgIdx,
      minY,
      maxY,
      maxDistance: profileMaxKm, // 차트 x축 도메인은 200NM(또는 타겟거리) — 스크롤 줌아웃 한계
      adjTarget,
      targetElev,
      adjTarget43, // 4/3 프레임 타겟 현 종점 — 커튼 4/3 레이 재구성용(렌더 미사용, 비트 불변)
      sim, // 주소검색 건물 시뮬레이션 결과 (계산 전용, 렌더 미사용)
    };
  }, [profile, radarHeight, totalDist, profileMaxKm, peakNames, buildings, showBuildings, searchedAddress, fresnelClearance, simBuilding]);

  // 차단 여부 + 건물 차단/비차단 수를 상위(드로어)로 보고
  useEffect(() => {
    if (!onStats) return;
    if (!chartData) { onStats({ blocked: false, blocking: 0, nonBlocking: 0 }); return; }
    const blocking = chartData.significantBuildings.filter((b) => b.isBlocking).length;
    const nonBlocking = chartData.significantBuildings.length - blocking;
    onStats({ blocked: chartData.blocked, blocking, nonBlocking });
  }, [chartData, onStats]);

  // 주소검색 건물 LoS 시뮬레이션 결과를 상위(카드)로 보고
  useEffect(() => {
    if (!onSimStats) return;
    const s = chartData?.sim ?? null;
    if (!simBuilding || !s) { onSimStats(null); return; }
    onSimStats({ allowableAglM: s.allowableAglM, allowableTopAmslM: s.allowableTopAmslM, excessM: s.excessM, distKm: s.simD });
  }, [chartData, onSimStats, simBuilding]);

  // ── LoS 수직 단면 커튼 데이터 방출 (지도 3D 표출용 — 차트 렌더 불변) ──
  //   차트 디스플레이 프레임(곡률 처짐)을 지도 평면(raw AMSL)으로 역변환해 차트 가시 구간
  //   [xZoom0, xZoom1]×maxDistance 의 차트 선(지형·최저탐지 LoS·프레넬·BRA·CoS·4/3 레이)을 방출
  //   → TrackMap 이 3D 폴리라인/리본면으로 렌더 (단면도 줌 ↔ 지도 커튼 거리 동기화).
  //   chartData 가 이미 반환한 배열(minDetStraight·minDetFresnel·braLine·cosLine)에서 읽음 — 수식 중복 금지.
  //   deps 최소화(chartData·profile·loading·radarHeight·totalDist·xZoom) + 콜백 ref 로 무한루프 차단.
  //   재조회(loading) 중엔 방출하지 않고 직전 커튼 유지 — 탭 전환 시 지도 커튼 깜박임 방지.
  const onCurtainDataRef = useRef(onCurtainData);
  onCurtainDataRef.current = onCurtainData;
  // 언마운트 시에만 커튼 해제 (deps 마다 도는 cleanup 은 깜박임을 유발하므로 별도 [] effect)
  useEffect(() => () => { onCurtainDataRef.current?.(null); }, []);
  useEffect(() => {
    const emit = onCurtainDataRef.current;
    if (!emit) return;
    if (loading) return; // 재조회 중 — 직전 커튼 유지
    if (!chartData || profile.length < 2) { emit(null); return; }
    const D = totalDist;
    if (D <= 0) { emit(null); return; }
    const { minDetStraight, minDetFresnel, braLine, cosLine, adjTarget43, maxDistance } = chartData;

    // uniqueDists 기준 선(minDetStraight·minDetFresnel)을 임의 거리에서 선형보간 — 각기 별도 포인터
    //   (호출이 거리 오름차순 단조라 O(n) 전진; 두 배열 모두 거리 오름차순).
    const makeInterp = (arr: { distance: number; height: number }[]) => {
      let si = 0;
      return (d: number): number => {
        if (d <= arr[0].distance) return arr[0].height;
        const last = arr[arr.length - 1];
        if (d >= last.distance) return last.height;
        while (si < arr.length - 1 && arr[si + 1].distance < d) si++;
        const denom = arr[si + 1].distance - arr[si].distance;
        const t = denom > 1e-9 ? (d - arr[si].distance) / denom : 0;
        return arr[si].height + t * (arr[si + 1].height - arr[si].height);
      };
    };
    const interpLos = makeInterp(minDetStraight);
    const interpFresnel = makeInterp(minDetFresnel);
    // 4/3 현(디스플레이 직선) → 지도 평면 raw AMSL: d=0 → radarHeight, d=D → 타겟 지면고
    const chord43H = (d: number) => radarHeight + (adjTarget43 - radarHeight) * (d / D);
    const rayAt = (d: number) => chord43H(d) + curvDrop43(d);

    // ── 차트 가시 구간 [startKm, endKm] 산출 (xZoom 은 maxDistance 도메인의 %) ──
    //   프로파일 종점을 넘어서면 lat/lon 외삽이 되므로 종점으로 클램프.
    const lastP = profile[profile.length - 1];
    const startKm = Math.max(0, Math.min((xZoom[0] / 100) * maxDistance, lastP.distance));
    const endKm = Math.max(startKm, Math.min((xZoom[1] / 100) * maxDistance, lastP.distance));

    // 샘플 거리 목록 — 구간 경계 + 구간 내 profile 샘플 + 타겟(d=D). 오름차순 정렬 후 중복 제거.
    const dists: number[] = [startKm];
    for (const p of profile) if (p.distance > startKm && p.distance < endKm) dists.push(p.distance);
    if (D > startKm && D < endKm) dists.push(D);
    dists.push(endKm);
    dists.sort((a, b) => a - b);

    // braLine·cosLine 은 profile.map — profile 인덱스와 정렬. 각 차트 선(디스플레이)에 curvDrop(d) 를
    //   더해 지도 평면 raw AMSL 로 환원. 레이더 지점(d≤0)은 모든 선이 안테나 AMSL(radarHeight)에서 출발.
    //   경계·타겟 샘플은 이웃 profile 선형보간(lat/lon/지형/BRA/CoS), los43·fresnel 은 interp 함수,
    //   rayM 은 rayAt(d)(현 연장이라 D 너머도 연속·선형).
    let pi = 1; // profile 브래킷 단조 포인터 (dists 오름차순 호출 전제)
    const sampleAt = (d: number): LosCurtainSample => {
      while (pi < profile.length - 1 && profile[pi].distance < d) pi++;
      const p0 = profile[pi - 1], p1 = profile[pi];
      const denom = p1.distance - p0.distance;
      const t = denom > 1e-9 ? Math.min(1, Math.max(0, (d - p0.distance) / denom)) : 0;
      const lerp = (a: number, b: number) => a + t * (b - a);
      const lat = lerp(p0.latitude, p1.latitude);
      const lon = lerp(p0.longitude, p1.longitude);
      const terrainM = lerp(p0.elevation, p1.elevation);
      if (d <= 0) {
        return {
          lat, lon, distKm: 0, terrainM,
          los43M: radarHeight, fresnelM: radarHeight,
          braM: radarHeight, cosM: radarHeight, rayM: radarHeight,
        };
      }
      const cd = curvDrop(d);
      return {
        lat, lon, distKm: d,
        terrainM,
        los43M: interpLos(d) + cd,
        fresnelM: interpFresnel(d) + cd,
        braM: lerp(braLine[pi - 1].height, braLine[pi].height) + cd,
        cosM: lerp(cosLine[pi - 1].height, cosLine[pi].height) + cd,
        rayM: rayAt(d),
      };
    };
    const samples: LosCurtainSample[] = [];
    let prevD = -Infinity;
    for (const d of dists) {
      if (d - prevD < 1e-9) continue; // 경계가 profile 샘플과 겹치면 중복 제거
      prevD = d;
      samples.push(sampleAt(d));
    }
    emit(samples.length > 1 ? samples : null);
  }, [chartData, profile, loading, radarHeight, totalDist, xZoom]);

  // ── 경로상 대상/차단 건물 방출 (지도 하이라이트용 — 대상=파랑, 차단=빨강) ──
  //   커튼과 동일 원칙: 재조회(loading) 중엔 방출하지 않고 직전 값 유지, 언마운트 시에만 해제.
  const onPathBuildingsRef = useRef(onPathBuildings);
  onPathBuildingsRef.current = onPathBuildings;
  useEffect(() => () => { onPathBuildingsRef.current?.(null); }, []);
  useEffect(() => {
    const emit = onPathBuildingsRef.current;
    if (!emit) return;
    if (loading) return; // 재조회 중 — 직전 하이라이트 유지
    if (!chartData) { emit(null); return; }
    const list = chartData.significantBuildings;
    const idx = chartData.searchedBldgIdx;
    const target = idx != null ? (list[idx] ?? null) : null;
    const blocking = list.filter((b) => b.isBlocking && b !== target);
    emit({ target, blocking });
  }, [chartData, loading]);

  // ── Y축 가시 범위 자동조정 (줌인 시 보이는 구간의 데이터만 기준) ──
  const visibleYRange = useMemo(() => {
    if (!chartData) return null;
    const { adjTerrain, minDetStraight, minDetFresnel, braLine,
            significantBuildings, maxDistance, minY: fullMinY, maxY: fullMaxY } = chartData;
    // Y 자동범위는 표시 중인 레이어만 반영 — 숨겨진 BRA(200NM에서 1,600m+) 등이 maxY를 부풀리면
    //   m/px가 커져 건물이 서브픽셀로 떨어져 사라지므로, 실제 그려지는 시리즈만 높이 수집에 포함.
    //   full-zoom(전체 거리)·줌인(윈도우) 모두 동일한 레이어-인지 로직을 태워 범위 출렁임 제거.
    const fullZoom = xZoom[0] === 0 && xZoom[1] === 100;
    const zoomStart = fullZoom ? 0 : (xZoom[0] / 100) * maxDistance;
    const zoomEnd = fullZoom ? maxDistance : (xZoom[1] / 100) * maxDistance;
    const inRange = (d: number) => d >= zoomStart && d <= zoomEnd;

    // 보이는 구간 내 높이값 수집 (표시 레이어만; cos는 원래 미포함 — 매우 가파름)
    const heights: number[] = [];
    if (layers.terrain) for (const p of adjTerrain) if (inRange(p.distance)) heights.push(p.height);
    if (layers.los43) for (const p of minDetStraight) if (inRange(p.distance)) heights.push(p.height);
    if (layers.fresnel) for (const p of minDetFresnel) if (inRange(p.distance)) heights.push(p.height);
    if (layers.bra) for (const p of braLine) if (inRange(p.distance)) heights.push(p.height);
    // 건물 꼭대기 (significantBuildings는 이미 showBuildings에 종속)
    for (const b of significantBuildings) {
      const nearD = b.near_dist_km ?? b.distance_km;
      const farD = b.far_dist_km ?? b.distance_km;
      if (inRange(nearD) || inRange(farD) || (nearD <= zoomStart && farD >= zoomEnd)) {
        heights.push((b.ground_elev_m + b.height_m) - curvDrop(b.distance_km));
        heights.push(b.ground_elev_m - curvDrop(b.distance_km));
      }
    }
    // 레이더 높이 (시작점이 보이면)
    if (zoomStart <= 0.1) heights.push(radarHeight);

    // 표시 레이어가 모두 꺼져 수집값이 없으면 기존 전체 범위로 폴백
    if (heights.length === 0) return { minY: fullMinY, maxY: fullMaxY };

    let rawMin = Infinity, rawMax = -Infinity;
    for (const h of heights) { if (h < rawMin) rawMin = h; if (h > rawMax) rawMax = h; }
    const range = rawMax - rawMin;
    const padding = Math.max(range * 0.12, 50); // 최소 50m 여유
    const visMinY = rawMin - padding;
    let visMaxY = rawMax + padding;
    // 0ft가 차트 40% 이하에 오도록 보장 (full-zoom·줌인 두 경로 공통)
    if (visMinY < 0) {
      const minMaxYFor40Pct = -visMinY * 1.5;
      if (visMaxY < minMaxYFor40Pct) visMaxY = minMaxYFor40Pct;
    }
    return { minY: visMinY, maxY: visMaxY };
  }, [chartData, xZoom, radarHeight, layers.terrain, layers.los43, layers.fresnel, layers.bra]);

  // ── GPU: 항적 포인트 좌표 사전계산 (히트테스트 + 렌더링 공용) ──
  const trackPointPositions = useMemo(() => {
    if (!losTrackPoints || !chartData || !visibleYRange) return [];
    const { maxDistance } = chartData;
    const { minY, maxY } = visibleYRange;
    const zoomStart = (xZoom[0] / 100) * maxDistance;
    const zoomEnd = (xZoom[1] / 100) * maxDistance;
    const zoomRange = zoomEnd - zoomStart;
    if (zoomRange <= 0) return [];
    const result: { x: number; y: number; idx: number }[] = [];
    for (let i = 0; i < losTrackPoints.length; i++) {
      const tp = losTrackPoints[i];
      const dist = tp.distRatio * maxDistance;
      const adjAlt = tp.altitude - curvDrop(dist);
      const x = PAD.left + ((dist - zoomStart) / zoomRange) * cw;
      const y = PAD.top + ch - ((adjAlt - minY) / (maxY - minY)) * ch;
      if (x < PAD.left - 10 || x > W - PAD.right + 10) continue;
      result.push({ x, y, idx: i });
    }
    return result;
  }, [losTrackPoints, chartData, visibleYRange, xZoom, cw, ch]);
  trackPointPosRef.current = trackPointPositions;

  // GPU 정리 (컴포넌트 언마운트 시)
  useEffect(() => {
    return () => { gpu2dRef.current?.dispose(); gpu2dRef.current = null; };
  }, []);

  // ── GPU: 항적 포인트 렌더링 (lazy-init: 캔버스가 조건부 렌더링이므로 여기서 초기화) ──
  const gpuCanvasElRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = trackCanvasRef.current;
    const svg = svgRef.current;
    if (!canvas || !svg || !losTrackPoints) return;
    // WebGL 컨텍스트 소실 복구: lost 는 preventDefault 로 복구 허용,
    //   restored 시 GPU2D 재생성 + gpuEpoch 증가로 재그리기 (미처리 시 타겟 재지정 전까지 포인트 소실)
    const onCtxLost = (e: Event) => e.preventDefault();
    const onCtxRestored = () => {
      gpu2dRef.current?.dispose();
      gpu2dRef.current = null;
      setGpuEpoch((v) => v + 1);
    };
    canvas.addEventListener("webglcontextlost", onCtxLost);
    canvas.addEventListener("webglcontextrestored", onCtxRestored);
    // 캔버스 엘리먼트 교체 시 리스너 정리/재부착 — 모든 조기 return 경로에서도 반환할 것
    const cleanup = () => {
      canvas.removeEventListener("webglcontextlost", onCtxLost);
      canvas.removeEventListener("webglcontextrestored", onCtxRestored);
    };
    // 캔버스 엘리먼트가 변경되면 GPU2D 재생성 (로딩 후 새 캔버스)
    if (gpu2dRef.current && gpuCanvasElRef.current !== canvas) {
      gpu2dRef.current.dispose();
      gpu2dRef.current = null;
    }
    if (!gpu2dRef.current) {
      try {
        gpu2dRef.current = new GPU2D(canvas);
        gpu2dRef.current.setResolution(W, H);
        gpuCanvasElRef.current = canvas;
      } catch (e) {
        console.warn('[LoS] WebGL2 초기화 실패:', e);
        return cleanup;
      }
    }
    const gpu = gpu2dRef.current;
    // 캔버스 크기를 SVG 렌더 크기에 동기화
    const rect = svg.getBoundingClientRect();
    gpu.syncSize(rect.width, rect.height);
    gpu.clear();
    if (trackPointPositions.length === 0) { gpu.flush(); return cleanup; }
    // 차트 영역 클리핑
    gpu.scissor(PAD.left, PAD.top, cw, ch);
    const circles: CircleData[] = [];
    for (const pos of trackPointPositions) {
      const tp = losTrackPoints[pos.idx];
      const isPinned = pinnedTrackIdx === pos.idx;
      const isExtHover = externalHoverIdx === pos.idx && hoveredTrackIdx !== pos.idx;
      const isHovered = hoveredTrackIdx === pos.idx;
      const isActive = isHovered || isPinned || isExtHover;
      const col = tp.isLoss
        ? [1, 0.09, 0.27] as [number, number, number]
        : (() => { const c = detectionTypeColor(tp.radar_type); return [c[0]/255, c[1]/255, c[2]/255] as [number, number, number]; })();
      const fillA = isActive ? 1 : tp.isLoss ? 0.9 : 0.7;
      let strokeCol: [number, number, number, number] = [0, 0, 0, 0];
      let sw = 0;
      if (isPinned)        { strokeCol = [0.98, 0.8, 0.08, 1]; sw = 2; }
      else if (isExtHover) { strokeCol = [0.22, 0.74, 0.97, 1]; sw = 2; }
      else if (isHovered)  { strokeCol = [1, 1, 1, 1]; sw = 1.5; }
      else if (tp.isLoss)  { strokeCol = [1, 0.09, 0.27, 0.5]; sw = 0.5; }
      else if (PSR_TYPES.has(tp.radar_type)) { strokeCol = [1, 1, 1, 0.6]; sw = 1; }
      circles.push({
        x: pos.x, y: pos.y,
        r: isActive ? 4 : tp.isLoss ? 2.5 : 1.5,
        fill: [col[0], col[1], col[2], fillA],
        stroke: strokeCol,
        strokeWidth: sw,
      });
    }
    gpu.drawCircles(circles);
    gpu.noScissor();
    gpu.flush();
    return cleanup;
  }, [trackPointPositions, losTrackPoints, hoveredTrackIdx, pinnedTrackIdx, externalHoverIdx, chartData, gpuEpoch]);

  // X축 줌 네이티브 휠 핸들러 (passive: false 필수)
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const svgX = ((e.clientX - rect.left) / rect.width) * W;
      // 차트 영역 밖이면 무시
      if (svgX < PAD.left || svgX > W - PAD.right) return;
      const cursorRatio = (svgX - PAD.left) / cw; // 0~1 in chart area
      const [s, en] = xZoomRef.current;
      const range = en - s;
      // 커서가 가리키는 절대 위치 (%)
      const pivot = s + cursorRatio * range;
      const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
      const newRange = Math.min(100, Math.max(1, range * factor));
      let newStart = pivot - cursorRatio * newRange;
      let newEnd = pivot + (1 - cursorRatio) * newRange;
      if (newStart < 0) { newEnd -= newStart; newStart = 0; }
      if (newEnd > 100) { newStart -= (newEnd - 100); newEnd = 100; }
      newStart = Math.max(0, newStart);
      newEnd = Math.min(100, newEnd);
      const next: [number, number] = [newStart, newEnd];
      xZoomRef.current = next;
      setXZoom(next);
    };
    const onMouseDown = (e: MouseEvent) => {
      // 각도선 핸들 드래그 체크
      if (showCustomAngleRef.current && angleHandlePosRef.current) {
        const rr = svg.getBoundingClientRect();
        const sx = ((e.clientX - rr.left) / rr.width) * W;
        const sy = ((e.clientY - rr.top) / rr.height) * H;
        const hp = angleHandlePosRef.current;
        const ddx = sx - hp.x, ddy = sy - hp.y;
        if (ddx * ddx + ddy * ddy < 225) {
          isAngleDragging.current = true;
          svg.style.cursor = "ns-resize";
          e.preventDefault();
          return;
        }
      }
      // 줌 상태가 아니면 드래그 패닝 불필요
      const [s, en] = xZoomRef.current;
      if (s === 0 && en === 100) return;
      const rect = svg.getBoundingClientRect();
      const svgX = ((e.clientX - rect.left) / rect.width) * W;
      if (svgX < PAD.left || svgX > W - PAD.right) return;
      isDragging.current = true;
      dragStartX.current = e.clientX;
      dragStartZoom.current = [...xZoomRef.current];
      svg.style.cursor = "grabbing";
      e.preventDefault();
    };
    const onMouseMoveGlobal = (e: MouseEvent) => {
      if (isAngleDragging.current) {
        const rr = svg.getBoundingClientRect();
        const svgY = ((e.clientY - rr.top) / rr.height) * H;
        const scl = chartScaleRef.current;
        if (scl) {
          const h = scl.minY + (1 - (svgY - PAD.top) / ch) * (scl.maxY - scl.minY);
          const dist = scl.zoomEnd;
          if (dist > 0) {
            const angle = Math.atan((h - radarHeight) / (dist * 1000)) * 180 / Math.PI;
            setCustomAngleDeg(Math.round(Math.max(-1, Math.min(45, angle)) * 100) / 100);
          }
        }
        return;
      }
      if (!isDragging.current) return;
      const rect = svg.getBoundingClientRect();
      const dx = e.clientX - dragStartX.current;
      const [origS, origE] = dragStartZoom.current;
      const range = origE - origS;
      // dx 픽셀을 줌 %로 변환 (차트 영역 폭 기준)
      const chartPxWidth = rect.width * (cw / W);
      const shift = -(dx / chartPxWidth) * range;
      let newStart = origS + shift;
      let newEnd = origE + shift;
      if (newStart < 0) { newEnd -= newStart; newStart = 0; }
      if (newEnd > 100) { newStart -= (newEnd - 100); newEnd = 100; }
      newStart = Math.max(0, newStart);
      newEnd = Math.min(100, newEnd);
      const next: [number, number] = [newStart, newEnd];
      xZoomRef.current = next;
      setXZoom(next);
    };
    const onMouseUpGlobal = () => {
      if (isAngleDragging.current) {
        isAngleDragging.current = false;
        svg.style.cursor = "";
        return;
      }
      if (isDragging.current) {
        isDragging.current = false;
        svg.style.cursor = "";
      }
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    svg.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMoveGlobal);
    document.addEventListener("mouseup", onMouseUpGlobal);
    return () => {
      svg.removeEventListener("wheel", onWheel);
      svg.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mousemove", onMouseMoveGlobal);
      document.removeEventListener("mouseup", onMouseUpGlobal);
    };
  }, [cw, loading]);

  // 줌 리셋 (프로파일/타겟 변경 시) → 타겟 부근 기본 줌으로 (스크롤로 200NM까지 줌아웃)
  useEffect(() => {
    xZoomRef.current = fitZoom;
    setXZoom(fitZoom);
  }, [profile, fitZoom]);

  // 마우스 이동 핸들러 (SVG 좌표 → 거리 + 항적 포인트 히트테스트)
  const handleSvgMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (isDragging.current || isAngleDragging.current) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * W;
    const svgY = ((e.clientY - rect.top) / rect.height) * H;
    setHoverX(svgX);
    // 항적 포인트 히트테스트 (GPU 캔버스 대응)
    const positions = trackPointPosRef.current;
    let nearIdx: number | null = null;
    let nearDist = 100; // 10px threshold²
    for (const p of positions) {
      const dx = p.x - svgX, dy = p.y - svgY;
      const d2 = dx * dx + dy * dy;
      if (d2 < nearDist) { nearDist = d2; nearIdx = p.idx; }
    }
    if (nearIdx !== hoveredTrackIdxRef.current) {
      hoveredTrackIdxRef.current = nearIdx;
      setHoveredTrackIdx(nearIdx);
      onTrackPointHoverRef.current?.(nearIdx);
    }
  }, []); // refs만 사용하므로 의존성 없음
  const handleSvgMouseLeave = useCallback(() => {
    setHoverX(null);
    onHoverDistance?.(null);
    // 항적 포인트 호버 해제
    if (hoveredTrackIdxRef.current !== null) {
      hoveredTrackIdxRef.current = null;
      setHoveredTrackIdx(null);
      onTrackPointHoverRef.current?.(null);
    }
  }, [onHoverDistance]);
  // 항적 포인트 클릭 → 핀 토글
  const handleSvgClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * W;
    const svgY = ((e.clientY - rect.top) / rect.height) * H;
    const positions = trackPointPosRef.current;
    let nearIdx: number | null = null;
    let nearDist = 100;
    for (const p of positions) {
      const dx = p.x - svgX, dy = p.y - svgY;
      const d2 = dx * dx + dy * dy;
      if (d2 < nearDist) { nearDist = d2; nearIdx = p.idx; }
    }
    if (nearIdx !== null) {
      const prev = pinnedTrackIdxRef.current;
      if (prev === nearIdx) {
        setPinnedTrackIdx(null);
        onTrackPointHighlightRef.current?.(null);
      } else {
        setPinnedTrackIdx(nearIdx);
        onTrackPointHighlightRef.current?.(nearIdx);
      }
    }
  }, []);

  // 호버 위치의 상세 데이터 계산
  const hoverData = useMemo(() => {
    if (hoverX === null || !chartData || profile.length === 0) return null;
    const { adjTerrain, minDetStraight, minDetFresnel, maxDistance } = chartData;

    // 줌 뷰포트 반영 (PAD/cw 는 컴포넌트 차트 상수 공용 — 로컬 재정의 금지)
    const zoomStart = xZoom[0] / 100 * maxDistance;
    const zoomEnd = xZoom[1] / 100 * maxDistance;
    const zoomRange = zoomEnd - zoomStart;
    const dist = zoomStart + ((hoverX - PAD.left) / cw) * zoomRange;
    if (dist < zoomStart || dist > zoomEnd) return null;

    // 거리 기반 선형 보간 헬퍼 (각 배열이 자체 distance를 가지므로 독립 보간)
    const lerpAt = (arr: { distance: number; height: number }[], d: number): number => {
      if (arr.length === 0) return 0;
      if (d <= arr[0].distance) return arr[0].height;
      for (let j = 1; j < arr.length; j++) {
        if (arr[j].distance >= d) {
          const denom = arr[j].distance - arr[j - 1].distance;
          const t = denom > 1e-9 ? (d - arr[j - 1].distance) / denom : 0;
          return arr[j - 1].height + t * (arr[j].height - arr[j - 1].height);
        }
      }
      return arr[arr.length - 1].height;
    };

    // 프로파일에서 보간하여 값 계산
    const terrainH = lerpAt(adjTerrain, dist);
    // 호버 거리가 마지막 프로파일 점(haversine 거리)을 넘으면 보간 미발견 → 끝점 고도로 폴백 (0ft 오표기 방지)
    let realElev = profile[profile.length - 1].elevation;
    for (let i = 1; i < profile.length; i++) {
      if (profile[i].distance >= dist) {
        const denom = profile[i].distance - profile[i - 1].distance;
        const t = denom > 1e-9 ? (dist - profile[i - 1].distance) / denom : 0;
        realElev = profile[i - 1].elevation + t * (profile[i].elevation - profile[i - 1].elevation);
        break;
      }
    }
    const straightH = lerpAt(minDetStraight, dist);
    const fresnelH = lerpAt(minDetFresnel, dist);

    // AGL (Above Ground Level): 실제 지표면 기준 최저탐지 높이
    const straightAGL = straightH - terrainH;
    const fresnelAGL = fresnelH - terrainH;
    // 실제 AMSL (조정 프레임 → 실제 고도 복원)
    const straightAMSL = straightH + curvDrop(dist);
    const fresnelAMSL = fresnelH + curvDrop(dist);

    // BRA 0.25° 기준선 높이 (AMSL)
    const BRA_DEG = 0.25;
    const braH = radarHeight + dist * 1000 * Math.tan((BRA_DEG * Math.PI) / 180);
    const braAMSL = braH + curvDrop(dist);

    // CoS 최고 탐지 고도 (AMSL)
    const cosH = radarHeight + dist * 1000 * Math.tan((70 * Math.PI) / 180);
    const cosAMSL = cosH + curvDrop(dist);

    return { dist, terrainH, realElev, straightH, fresnelH, straightAGL, fresnelAGL, straightAMSL, fresnelAMSL, braAMSL, cosAMSL };
  }, [hoverX, chartData, profile, xZoom]);

  // 호버 거리 비율을 부모에 전달
  useEffect(() => {
    if (hoverData && totalDist > 0) {
      onHoverDistance?.(hoverData.dist / totalDist);
    } else {
      onHoverDistance?.(null);
    }
  }, [hoverData, totalDist, onHoverDistance]);

  const renderChart = () => {
    if (!chartData || !visibleYRange) return null;
    const {
      adjTerrain, minDetStraight, minDetFresnel, braLine, cosLine,
      maxBlockPoint, maxDistance,
    } = chartData;
    const { minY, maxY } = visibleYRange;

    const zoomStart = (xZoom[0] / 100) * maxDistance;
    const zoomEnd = (xZoom[1] / 100) * maxDistance;
    const zoomRange = zoomEnd - zoomStart;
    const xScale = (d: number) => PAD.left + ((d - zoomStart) / zoomRange) * cw;
    const yScale = (h: number) => PAD.top + ch - ((h - minY) / (maxY - minY)) * ch;
    chartScaleRef.current = { zoomStart, zoomEnd, zoomRange, minY, maxY };
    if (!showCustomAngle) angleHandlePosRef.current = null;

    // 지형 채우기
    const terrainFill =
      `M ${xScale(0)} ${yScale(minY)} ` +
      adjTerrain.map((p) => `L ${xScale(p.distance)} ${yScale(p.height)}`).join(" ") +
      ` L ${xScale(maxDistance)} ${yScale(minY)} Z`;

    // 지형 윤곽선
    const terrainLine = adjTerrain
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.distance)} ${yScale(p.height)}`)
      .join(" ");

    // 최저 탐지가능 높이 (직선 LoS)
    const minDetStrPath = minDetStraight
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.distance)} ${yScale(p.height)}`)
      .join(" ");

    // 최저 탐지가능 높이 (직선 LoS + 프레넬존 80% 클리어런스)
    const minDetFresnelPath = minDetFresnel
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.distance)} ${yScale(p.height)}`)
      .join(" ");

    // BRA 0.25° 기준선
    const braPath = braLine
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.distance)} ${yScale(p.height)}`)
      .join(" ");

    // CoS 70° 기준선
    const cosPath = cosLine
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.distance)} ${yScale(p.height)}`)
      .join(" ");

    // 단위 변환 상수
    const M_TO_FT = 3.28084;
    const KM_TO_NM = 1 / 1.852;

    // Y축 눈금 (ft 기준) — 격자·라벨은 진고도 y 를 디스플레이 프레임(y − curvDrop(dist))에 그리므로, tick 은
    //   minY..maxY(디스플레이 높이 범위)가 아닌 표시가능 '진고도' 범위 [minY+drop(zoomStart), maxY+drop(zoomEnd)]
    //   에서 생성해야 원거리 줌 윈도우에서도 격자·라벨이 플롯 안에 들어온다(스텝은 화면 밀도 기준 유지).
    const yRangeFt = (maxY - minY) * M_TO_FT;
    const yStepFt = yRangeFt > 30000 ? 5000 : yRangeFt > 15000 ? 2000 : yRangeFt > 5000 ? 1000 : yRangeFt > 2000 ? 500 : 200;
    const yTicks: number[] = [];
    const minYft = (minY + curvDrop(zoomStart)) * M_TO_FT;
    const maxYft = (maxY + curvDrop(zoomEnd)) * M_TO_FT;
    for (let yf = Math.ceil(minYft / yStepFt) * yStepFt; yf <= maxYft; yf += yStepFt) yTicks.push(yf / M_TO_FT); // m으로 저장 (yScale은 m 기준)

    // X축 눈금 (NM 기준, 줌 뷰포트 적용)
    const visibleDistNm = zoomRange * KM_TO_NM;
    const xStepNm = visibleDistNm > 80 ? 20 : visibleDistNm > 40 ? 10 : visibleDistNm > 15 ? 5 : visibleDistNm > 5 ? 2 : 1;
    const xTicks: number[] = []; // km 값으로 저장
    const zoomStartNm = zoomStart * KM_TO_NM;
    const zoomEndNm = zoomEnd * KM_TO_NM;
    const xTickStartNm = Math.ceil(zoomStartNm / xStepNm) * xStepNm;
    for (let xn = xTickStartNm; xn <= zoomEndNm; xn += xStepNm) xTicks.push(xn / KM_TO_NM); // km으로 변환

    return (
      <div className="relative">
      {/* GPU 캔버스: 항적 포인트 (SVG 아래에 배치, 범례/툴팁이 위에 표시) */}
      <canvas ref={trackCanvasRef} className="absolute inset-0 pointer-events-none" style={{ width: '100%', height: '100%' }} />
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full relative"
        style={{ minHeight: 220, cursor: xZoom[0] !== 0 || xZoom[1] !== 100 ? "grab" : undefined }}
        onMouseMove={handleSvgMouseMove} onMouseLeave={handleSvgMouseLeave} onClick={handleSvgClick}>
        <defs>
          <linearGradient id="terrainGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22c55e" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#22c55e" stopOpacity="0.05" />
          </linearGradient>
          <clipPath id="chart-clip">
            <rect x={PAD.left} y={PAD.top} width={cw} height={ch} />
          </clipPath>
        </defs>

        {/* Y축 라벨 (클립 밖) — tick 이 진고도 범위로 확장됐으므로, 윈도우 좌단(zoomStart) 기준
            디스플레이 값이 플롯 세로범위 밖인 tick 은 라벨 생략(격자 곡선은 clipPath 가 처리) */}
        {yTicks.map((y) => {
          const yDisp = y - curvDrop(zoomStart);
          if (yDisp < minY - 1e-9 || yDisp > maxY + 1e-9) return null;
          const labelY = yScale(yDisp);
          return (
            <text key={`yl-${y}`} x={PAD.left - 5} y={labelY + 3} textAnchor="end"
              fill="#6b7280" fontSize={9}>
              {Math.round(y * M_TO_FT).toLocaleString()}ft
            </text>
          );
        })}
        {/* X축 라벨 (클립 밖) */}
        {xTicks.map((x) => (
          <text key={`xl-${x}`} x={xScale(x)} y={H - PAD.bottom + 14} textAnchor="middle"
            fill="#6b7280" fontSize={9}>
            {(x * KM_TO_NM).toFixed(x * KM_TO_NM >= 10 ? 0 : 1)}NM
          </text>
        ))}

        {/* 클리핑 영역 내 차트 요소 */}
        <g clipPath="url(#chart-clip)">
        {/* 수평 격자: 일정 AMSL 고도를 지구곡률 반영 곡선으로 표현 */}
        {yTicks.map((y) => {
          const numSeg = 50;
          const parts: string[] = [];
          for (let s = 0; s <= numSeg; s++) {
            const dist = zoomStart + (s / numSeg) * zoomRange;
            parts.push(`${s === 0 ? 'M' : 'L'} ${xScale(dist)} ${yScale(y - curvDrop(dist))}`);
          }
          return (
            <path key={`yg-${y}`} d={parts.join(' ')} fill="none"
              stroke={y === 0 ? "rgba(0,0,0,0.15)" : "rgba(0,0,0,0.06)"}
              strokeWidth={y === 0 ? 1 : 0.5} />
          );
        })}
        {/* 수직 격자 */}
        {xTicks.map((x) => (
          <line key={`xg-${x}`} x1={xScale(x)} y1={PAD.top} x2={xScale(x)} y2={H - PAD.bottom}
            stroke="rgba(0,0,0,0.06)" strokeWidth={0.5} />
        ))}
        {/* 지형 채우기 + 윤곽선 */}
        {layers.terrain && (
          <>
            <path d={terrainFill} fill="url(#terrainGrad)" />
            <path d={terrainLine} fill="none" stroke="#22c55e" strokeWidth={1.5} />
          </>
        )}

        {/* 건물 실루엣 (차폐 기여 건물만) — 점 건물: 세로선, 도형 건물: 채워진 사각형 */}
        {showBuildings && chartData.significantBuildings.map((b, bi) => {
          const nearD = b.near_dist_km ?? b.distance_km;
          const farD = b.far_dist_km ?? b.distance_km;
          // 보이는 줌 구간 밖 건물은 렌더 생략 (200NM 연장 시 화면 밖 수백 동이 DOM에 쌓이는 것 방지).
          //   return null 이므로 bi(=significantBuildings 인덱스)는 그대로 → 호버/클릭/툴팁 인덱스 정합 유지.
          if (farD < zoomStart || nearD > zoomEnd) return null;
          const hasExtent = (farD - nearD) > 0.001;
          // 도형 건물: 양 끝의 곡률 보정 적용
          const nearGroundAdj = b.ground_elev_m - curvDrop(nearD);
          const nearTopAdj = (b.ground_elev_m + b.height_m) - curvDrop(nearD);
          const farGroundAdj = hasExtent ? (b.ground_elev_m - curvDrop(farD)) : nearGroundAdj;
          const farTopAdj = hasExtent ? ((b.ground_elev_m + b.height_m) - curvDrop(farD)) : nearTopAdj;
          const bxNear = xScale(nearD);
          const bxFar = hasExtent ? xScale(farD) : bxNear;
          const byBottomNear = yScale(nearGroundAdj);
          let byTopNear = yScale(nearTopAdj);
          const byBottomFar = hasExtent ? yScale(farGroundAdj) : byBottomNear;
          let byTopFar = hasExtent ? yScale(farTopAdj) : byTopNear;
          // 줌아웃으로 픽셀 높이가 1px 미만이 되면 건물이 통째로 사라지므로, top 을 bottom−2px 로 올려 최소 2px 실루엣 보장
          if (byBottomNear - byTopNear < 2) byTopNear = byBottomNear - 2;
          if (byBottomFar - byTopFar < 2) byTopFar = byBottomFar - 2;
          const isHovered = hoveredBldgIdx === bi;
          const isClicked = clickedBldgIdx === bi;
          // 수동 건물 그룹 색상 조회
          let manualGroupColor: string | null = null;
          if (b.is_manual) {
            const mb = manualBuildings.find((m) => Math.abs(m.latitude - b.lat) < 1e-6 && Math.abs(m.longitude - b.lon) < 1e-6);
            if (mb?.group_id) {
              const grp = buildingGroups.find((g) => g.id === mb.group_id);
              if (grp) manualGroupColor = grp.color;
            }
          }
          const manualColor = manualGroupColor || "#f97316"; // 그룹색 or 주황색
          // 색 우선순위: 클릭 > 호버 > 대상건물(파랑) > 차단(빨강) > 수동 그룹색 > 비차단 회색.
          //   대상 건물은 자동선택 대신 파란색으로만 구분(지도 하이라이트와 동일 색), 차단은 수동/GIS 무관 빨강.
          const isTargetBldg = chartData.searchedBldgIdx === bi;
          const baseColor = isClicked ? "#f59e0b" : isHovered ? "#facc15" : isTargetBldg ? "#3b82f6" : b.isBlocking ? "rgba(239, 68, 68, 0.8)" : b.is_manual ? manualColor : "rgba(148, 163, 184, 0.5)";
          const fillColor = isClicked ? "rgba(245,158,11,0.3)" : isHovered ? "rgba(250,204,21,0.25)" : isTargetBldg ? "rgba(59,130,246,0.2)" : b.isBlocking ? "rgba(239,68,68,0.15)" : b.is_manual ? `${manualColor}20` : "rgba(148,163,184,0.08)";

          if (hasExtent) {
            // 도형 건물: 채워진 사각형 (사다리꼴 — 곡률 보정으로 양쪽 높이 다름)
            const pathD = `M ${bxNear} ${byBottomNear} L ${bxNear} ${byTopNear} L ${bxFar} ${byTopFar} L ${bxFar} ${byBottomFar} Z`;
            return (
              <g key={`bld-${bi}`}>
                {/* 투명 히트영역 */}
                <path d={pathD} fill="transparent" stroke="transparent" strokeWidth={4}
                  style={{ cursor: "pointer" }}
                  onMouseEnter={() => { setHoveredBldgIdx(bi); onBuildingHover?.({ lat: b.lat, lon: b.lon, height_m: b.height_m, name: b.name, address: b.address, usage: b.usage }); }}
                  onMouseLeave={() => { setHoveredBldgIdx(null); if (clickedBldgIdx === null) onBuildingHover?.(null); }}
                  onClick={(e) => {
                    e.stopPropagation();
                    const toggling = clickedBldgIdx === bi;
                    setClickedBldgIdx(toggling ? null : bi);
                    onBuildingHover?.(toggling ? null : { lat: b.lat, lon: b.lon, height_m: b.height_m, name: b.name, address: b.address, usage: b.usage });
                  }}
                />
                {/* 채워진 사각형 + 윤곽선 */}
                <path d={pathD} fill={fillColor} stroke={baseColor}
                  strokeWidth={isClicked ? 2 : isHovered ? 1.5 : 1}
                  pointerEvents="none"
                />
              </g>
            );
          }

          // 점 건물: 기존 세로선 방식
          return (
            <g key={`bld-${bi}`}>
              <line
                x1={bxNear} y1={byBottomNear} x2={bxNear} y2={byTopNear}
                stroke="transparent"
                strokeWidth={14}
                style={{ cursor: "pointer" }}
                onMouseEnter={() => { setHoveredBldgIdx(bi); onBuildingHover?.({ lat: b.lat, lon: b.lon, height_m: b.height_m, name: b.name, address: b.address, usage: b.usage }); }}
                onMouseLeave={() => { setHoveredBldgIdx(null); if (clickedBldgIdx === null) onBuildingHover?.(null); }}
                onClick={(e) => {
                  e.stopPropagation();
                  const toggling = clickedBldgIdx === bi;
                  setClickedBldgIdx(toggling ? null : bi);
                  onBuildingHover?.(toggling ? null : { lat: b.lat, lon: b.lon, height_m: b.height_m, name: b.name, address: b.address, usage: b.usage });
                }}
              />
              <line
                x1={bxNear} y1={byBottomNear} x2={bxNear} y2={byTopNear}
                stroke={baseColor}
                strokeWidth={isClicked ? 2.5 : isHovered ? 2 : 1}
                pointerEvents="none"
              />
            </g>
          );
        })}

        {/* 최저 탐지가능 높이 - 직선 LoS + 프레넬존 클리어런스 */}
        {layers.fresnel && (
          <path d={minDetFresnelPath} fill="none"
            stroke="#ec4899" strokeWidth={1.2} strokeDasharray="6 3" />
        )}

        {/* 최저 탐지가능 높이 - LoS (4/3 유효지구 굴절) */}
        {layers.los43 && (
          <path d={minDetStrPath} fill="none"
            stroke="#f59e0b" strokeWidth={1.8} />
        )}

        {/* 0.25° BRA 기준선 */}
        {layers.bra && (
          <>
            <path d={braPath} fill="none"
              stroke="#22d3ee" strokeWidth={1} strokeDasharray="8 4" />
            <text
              x={xScale(zoomEnd) - 4}
              y={yScale(radarHeight + zoomEnd * 1000 * Math.tan((0.25 * Math.PI) / 180)) - 5}
              textAnchor="end" fill="#22d3ee" fontSize={9} fontWeight="bold">
              BRA
            </text>
          </>
        )}

        {/* CoS 70° 기준선 */}
        {layers.cos && (
          <path d={cosPath} fill="none"
            stroke="#a855f7" strokeWidth={1} strokeDasharray="4 3" />
        )}

        {/* 레이더 위치 라벨 (Y축 상단) */}
        <text x={xScale(0) + 4} y={PAD.top + 12}
          fill="#6b7280" fontSize={8}>
          {radarSite.name} ({Math.round(radarHeight * M_TO_FT).toLocaleString()}ft)
        </text>

        {/* 이름 있는 산들 */}
        {chartData.namedPeaks.map((peak, i) => {
          const isMaxBlock = maxBlockPoint && Math.abs(peak.distance - maxBlockPoint.distance) < 0.5;
          return (
            <g key={`peak-${i}`}>
              <circle
                cx={xScale(peak.distance)}
                cy={yScale(peak.adjHeight)}
                r={isMaxBlock ? 4 : 3}
                fill={isMaxBlock ? "#a60739" : "#f59e0b"}
                stroke="white" strokeWidth={1} />
              <text
                x={xScale(peak.distance)}
                y={PAD.top + ch - 5}
                textAnchor="middle" fill="#374151" fontSize={9} fontWeight="bold">
                {/* 산 이름은 표시영역 최하단 고정(Y줌 무관) — 지형·선과 겹침 방지 */}
                {`${peak.name} (${Math.round(peak.realElevation * M_TO_FT).toLocaleString()}ft)`}
              </text>
            </g>
          );
        })}

        {/* 사용자 조절 각도선 */}
        {showCustomAngle && (() => {
          const angRad = customAngleDeg * Math.PI / 180;
          const endH = radarHeight + maxDistance * 1000 * Math.tan(angRad);
          const linePath = `M ${xScale(0)} ${yScale(radarHeight)} L ${xScale(maxDistance)} ${yScale(endH)}`;
          const hDist = zoomEnd;
          const hH = radarHeight + hDist * 1000 * Math.tan(angRad);
          const hX = xScale(hDist);
          const hY = yScale(hH);
          const hAMSL = hH + curvDrop(hDist);
          angleHandlePosRef.current = { x: hX, y: hY };
          return (
            <>
              <path d={linePath} fill="none" stroke="#f43f5e" strokeWidth={1.5} strokeDasharray="6 4" />
              <text x={hX - 4} y={Math.max(PAD.top + 10, hY - 8)} textAnchor="end" fill="#f43f5e" fontSize={9} fontWeight="bold">
                {customAngleDeg.toFixed(2)}°
              </text>
              <text x={hX - 4} y={Math.min(H - PAD.bottom - 2, hY + 14)} textAnchor="end" fill="#f43f5e" fontSize={8}>
                {Math.round(hAMSL * M_TO_FT).toLocaleString()}ft
              </text>
            </>
          );
        })()}

        {/* LoS 선상 항적/Loss 포인트: GPU 캔버스에서 렌더링 (아래 trackCanvasRef) */}

        </g>{/* /chart-clip */}

        {/* 범례 (왼쪽 위) — 드로어가 범례 역할을 하면 숨김 */}
        {showLegend && (
        <g transform={`translate(${PAD.left + 8}, ${PAD.top + 5})`}>
          <rect x={-4} y={-6} width={270} height={(() => {
            let h = 66;
            if (chartData.significantBuildings.length > 0) {
              const hasBlocking = chartData.significantBuildings.some(b => b.isBlocking);
              const hasNonBlocking = chartData.significantBuildings.some(b => !b.isBlocking);
              const hasManual = chartData.significantBuildings.some(b => b.is_manual);
              if (hasBlocking) h += 14;
              if (hasNonBlocking) h += 14;
              if (hasManual) h += 14;
            }
            if (showCustomAngle) h += 14;
            return h;
          })()} rx={4} fill="rgba(255,255,255,0.9)" stroke="rgba(0,0,0,0.1)" strokeWidth={0.5} />
          <line x1={0} y1={0} x2={20} y2={0}
            stroke="#f59e0b" strokeWidth={1.8} />
          <text x={24} y={3} fill="#374151" fontSize={8}>
            최저 탐지가능 높이 (LoS, 4/3 굴절)
          </text>
          <line x1={0} y1={14} x2={20} y2={14}
            stroke="#ec4899" strokeWidth={1.2} strokeDasharray="6 3" />
          <text x={24} y={17} fill="#374151" fontSize={8}>
            최저 탐지가능 높이 (LoS 4/3, 프레넬존 80% 클리어런스)
          </text>
          <line x1={0} y1={28} x2={20} y2={28}
            stroke="#22d3ee" strokeWidth={1} strokeDasharray="8 4" />
          <text x={24} y={31} fill="#374151" fontSize={8}>
            BRA (0.25° 기준선)
          </text>
          <line x1={0} y1={42} x2={20} y2={42}
            stroke="#a855f7" strokeWidth={1} strokeDasharray="4 3" />
          <text x={24} y={45} fill="#374151" fontSize={8}>
            CoS (70° 최고 탐지고도)
          </text>
          <line x1={0} y1={56} x2={20} y2={56} stroke="#22c55e" strokeWidth={1.5} />
          <text x={24} y={59} fill="#374151" fontSize={8}>
            지형 (지구곡률 보정)
          </text>
          {chartData.significantBuildings.length > 0 && (() => {
            const blockingCount = chartData.significantBuildings.filter(b => b.isBlocking).length;
            const manualCount = chartData.significantBuildings.filter(b => b.is_manual).length;
            const nonBlockingCount = chartData.significantBuildings.length - blockingCount;
            let legendY = 66;
            return (
              <>
                {blockingCount > 0 && (
                  <>
                    <rect x={2} y={legendY} width={16} height={8} fill="rgba(239,68,68,0.15)" stroke="rgba(239,68,68,0.8)" strokeWidth={0.5} />
                    <text x={24} y={legendY + 7} fill="#374151" fontSize={8}>
                      LoS 차단 건물 ({blockingCount}동)
                    </text>
                    {(() => { legendY += 14; return null; })()}
                  </>
                )}
                {nonBlockingCount > 0 && (
                  <>
                    <rect x={2} y={legendY} width={16} height={8} fill="rgba(148,163,184,0.08)" stroke="rgba(148,163,184,0.5)" strokeWidth={0.5} />
                    <text x={24} y={legendY + 7} fill="#374151" fontSize={8}>
                      비차단 건물 ({nonBlockingCount}동)
                    </text>
                    {(() => { legendY += 14; return null; })()}
                  </>
                )}
                {manualCount > 0 && (
                  <>
                    <rect x={2} y={legendY} width={16} height={8} fill="rgba(249,115,22,0.15)" stroke="#f97316" strokeWidth={0.5} />
                    <text x={24} y={legendY + 7} fill="#374151" fontSize={8}>
                      수동 등록 건물 ({manualCount}동)
                    </text>
                  </>
                )}
              </>
            );
          })()}
          {showCustomAngle && (() => {
            let caY = 66;
            if (chartData.significantBuildings.length > 0) {
              if (chartData.significantBuildings.some(b => b.isBlocking)) caY += 14;
              if (chartData.significantBuildings.some(b => !b.isBlocking)) caY += 14;
              if (chartData.significantBuildings.some(b => b.is_manual)) caY += 14;
            }
            return (
              <>
                <line x1={0} y1={caY} x2={20} y2={caY}
                  stroke="#f43f5e" strokeWidth={1.5} strokeDasharray="6 4" />
                <text x={24} y={caY + 3} fill="#374151" fontSize={8}>
                  사용자 각도선 ({customAngleDeg.toFixed(2)}°)
                </text>
              </>
            );
          })()}
        </g>
        )}

        {/* 인터랙티브 크로스헤어 + 호버 툴팁 */}
        {hoverData && hoveredTrackIdx === null && externalHoverIdx == null && pinnedTrackIdx === null && hoveredBldgIdx === null && (() => {
          const hXPos = xScale(hoverData.dist);
          const tooltipW = 195;
          const tooltipH = showCustomAngle ? 118 : 104;
          const tooltipX = hXPos + tooltipW + 12 > W ? hXPos - tooltipW - 8 : hXPos + 8;
          const tooltipY = PAD.top + 4;
          const customAngleHoverAMSL = showCustomAngle ? radarHeight + hoverData.dist * 1000 * Math.tan(customAngleDeg * Math.PI / 180) + curvDrop(hoverData.dist) : 0;
          return (
            <g>
              {/* 차트 Y축 크로스헤어 (보조) */}
              <line x1={hXPos} y1={PAD.top} x2={hXPos} y2={H - PAD.bottom}
                stroke="rgba(156,163,175,0.2)" strokeWidth={0.5} strokeDasharray="2 3" />
              {/* 지형 위 인디케이터 */}
              <circle cx={hXPos} cy={yScale(hoverData.terrainH)} r={3}
                fill="#22c55e" stroke="white" strokeWidth={0.8} />
              {/* 직선 LoS: 지면→포인트 수직 가이드 */}
              <line x1={hXPos} y1={yScale(hoverData.terrainH)} x2={hXPos} y2={yScale(hoverData.straightH)}
                stroke="#f59e0b" strokeWidth={0.8} strokeDasharray="2 2" strokeOpacity={0.5} />
              <circle cx={hXPos} cy={yScale(hoverData.straightH)} r={3}
                fill="#f59e0b" stroke="white" strokeWidth={0.8} />
              {/* 프레넬존 클리어런스 인디케이터 */}
              <circle cx={hXPos} cy={yScale(hoverData.fresnelH)} r={2.5}
                fill="#ec4899" stroke="white" strokeWidth={0.8} />
              {/* 각도선 인디케이터 */}
              {showCustomAngle && (
                <circle cx={hXPos} cy={yScale(radarHeight + hoverData.dist * 1000 * Math.tan(customAngleDeg * Math.PI / 180))} r={3}
                  fill="#f43f5e" stroke="white" strokeWidth={0.8} />
              )}
              {/* 툴팁 배경 */}
              <rect x={tooltipX} y={tooltipY} width={tooltipW} height={tooltipH}
                rx={4} fill="rgba(255,255,255,0.95)" stroke="rgba(0,0,0,0.1)" strokeWidth={0.5} />
              {/* 툴팁 내용 */}
              <text x={tooltipX + 8} y={tooltipY + 14} fill="#6b7280" fontSize={8}>
                거리: <tspan fill="#374151" fontWeight="bold">{(hoverData.dist / 1.852).toFixed(1)}NM</tspan>
              </text>
              <text x={tooltipX + 8} y={tooltipY + 28} fill="#22c55e" fontSize={8}>
                지형고도: <tspan fill="#374151">{Math.round(hoverData.realElev * 3.28084).toLocaleString()}ft AMSL</tspan>
              </text>
              <text x={tooltipX + 8} y={tooltipY + 42} fill="#f59e0b" fontSize={8}>
                최저탐지(LoS 4/3): <tspan fill="#374151" fontWeight="bold">{Math.round(hoverData.straightAMSL * 3.28084).toLocaleString()}ft</tspan>
                <tspan fill="#6b7280" fontSize={7}> (AGL {Math.round(hoverData.straightAGL * 3.28084).toLocaleString()}ft)</tspan>
              </text>
              <text x={tooltipX + 8} y={tooltipY + 56} fill="#ec4899" fontSize={8}>
                프레넬80%: <tspan fill="#374151" fontWeight="bold">{Math.round(hoverData.fresnelAMSL * 3.28084).toLocaleString()}ft</tspan>
                <tspan fill="#6b7280" fontSize={7}> (AGL {Math.round(hoverData.fresnelAGL * 3.28084).toLocaleString()}ft)</tspan>
              </text>
              <text x={tooltipX + 8} y={tooltipY + 70} fill="#22d3ee" fontSize={8}>
                BRA 0.25°: <tspan fill="#374151" fontWeight="bold">{Math.round(hoverData.braAMSL * 3.28084).toLocaleString()}ft</tspan>
              </text>
              <text x={tooltipX + 8} y={tooltipY + 84} fill="#a855f7" fontSize={8}>
                최고탐지(CoS): <tspan fill="#374151" fontWeight="bold">{Math.round(hoverData.cosAMSL * 3.28084).toLocaleString()}ft</tspan>
              </text>
              {showCustomAngle && (
                <text x={tooltipX + 8} y={tooltipY + 98} fill="#f43f5e" fontSize={8}>
                  각도선 {customAngleDeg.toFixed(2)}°: <tspan fill="#374151" fontWeight="bold">{Math.round(customAngleHoverAMSL * 3.28084).toLocaleString()}ft</tspan>
                </text>
              )}
            </g>
          );
        })()}

        {/* 건물 호버/클릭 툴팁 */}
        {(() => {
          const activeBldgIdx = clickedBldgIdx ?? hoveredBldgIdx;
          if (activeBldgIdx === null || !chartData.significantBuildings[activeBldgIdx]) return null;
          const b = chartData.significantBuildings[activeBldgIdx];
          const bTopAdj = (b.ground_elev_m + b.height_m) - curvDrop(b.distance_km);
          const bx = xScale(b.distance_km);
          const by = yScale(bTopAdj);
          const tooltipW = 190;
          const hasName = !!b.name;
          const hasAddr = !!b.address;
          const hasUsage = !!b.usage;
          const headerLines = (hasName ? 1 : 0) + (hasAddr ? 1 : 0) + (hasUsage ? 1 : 0);
          const isClicked = clickedBldgIdx === activeBldgIdx;
          const tooltipH = 62 + headerLines * 13;
          const tooltipX = bx + tooltipW + 12 > W ? bx - tooltipW - 8 : bx + 8;
          const tooltipY = Math.max(PAD.top + 4, by - tooltipH / 2);
          let lineY = tooltipY;
          return (
            <g>
              <rect x={tooltipX} y={tooltipY} width={tooltipW} height={tooltipH}
                rx={4} fill="rgba(255,255,255,0.95)" stroke={isClicked ? "rgba(245,158,11,0.6)" : "rgba(0,0,0,0.15)"} strokeWidth={isClicked ? 1 : 0.5} />
              {hasName && (
                <text x={tooltipX + 8} y={(lineY += 13, lineY)} fill="#374151" fontSize={9} fontWeight="bold">
                  {b.name}
                </text>
              )}
              {hasUsage && (
                <text x={tooltipX + 8} y={(lineY += 13, lineY)} fill="#6366f1" fontSize={8}>
                  {b.usage}
                </text>
              )}
              {hasAddr && (
                <text x={tooltipX + 8} y={(lineY += 13, lineY)} fill="#9ca3af" fontSize={7.5}>
                  {b.address}
                </text>
              )}
              <text x={tooltipX + 8} y={(lineY += 14, lineY)} fill="#6b7280" fontSize={8}>
                거리: <tspan fill="#374151" fontWeight="bold">{(b.distance_km / 1.852).toFixed(1)}NM</tspan>
                <tspan fill="#6b7280"> ({b.distance_km.toFixed(1)}km)</tspan>
              </text>
              <text x={tooltipX + 8} y={(lineY += 14, lineY)} fill="#6b7280" fontSize={8}>
                건물높이: <tspan fill="#374151" fontWeight="bold">{b.height_m.toFixed(1)}m</tspan>
                <tspan fill="#6b7280"> ({Math.round(b.height_m * 3.28084)}ft)</tspan>
              </text>
              <text x={tooltipX + 8} y={(lineY += 14, lineY)} fill="#6b7280" fontSize={8}>
                지반고: <tspan fill="#374151">{Math.round(b.ground_elev_m)}m</tspan>
                <tspan fill="#6b7280">  꼭대기: </tspan>
                <tspan fill="#374151" fontWeight="bold">{Math.round(b.ground_elev_m + b.height_m)}m AMSL</tspan>
              </text>
              <text x={tooltipX + 8} y={(lineY += 14, lineY)} fill={b.isBlocking ? "#ef4444" : "#6b7280"} fontSize={8} fontWeight={b.isBlocking ? "bold" : "normal"}>
                {b.isBlocking ? "⚠ LoS 차단 기여" : "차폐 영향"}
              </text>
              {isClicked && (
                <text x={tooltipX + tooltipW - 8} y={lineY} textAnchor="end"
                  fill="#3b82f6" fontSize={7.5} style={{ cursor: "pointer" }}
                  onMouseEnter={(e) => { (e.target as SVGTextElement).style.textDecoration = "underline"; }}
                  onMouseLeave={(e) => { (e.target as SVGTextElement).style.textDecoration = "none"; }}
                  onClick={(e) => { e.stopPropagation(); onBuildingDetail?.(b); }}
                >
                  상세보기
                </text>
              )}
            </g>
          );
        })()}

        {/* 항적/Loss 포인트 호버/핀 툴팁 */}
        {(() => {
          const activeIdx = hoveredTrackIdx ?? externalHoverIdx ?? pinnedTrackIdx;
          if (activeIdx === null || !losTrackPoints || !losTrackPoints[activeIdx]) return null;
          const tp = losTrackPoints[activeIdx];
          const tpDist = tp.distRatio * maxDistance;
          const tpAdjAlt = tp.altitude - curvDrop(tpDist);
          const tpX = xScale(tpDist);
          const tpY = yScale(tpAdjAlt);
          const tooltipW = 160;
          const tooltipH = 62;
          const tooltipX = tpX + tooltipW + 12 > W ? tpX - tooltipW - 8 : tpX + 8;
          const tooltipY = Math.max(PAD.top, Math.min(tpY - tooltipH / 2, H - PAD.bottom - tooltipH));
          const date = new Date(tp.timestamp * 1000);
          const timeStr = `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}:${String(date.getUTCSeconds()).padStart(2, "0")}`;
          return (
            <g>
              <rect x={tooltipX} y={tooltipY} width={tooltipW} height={tooltipH}
                rx={4} fill="rgba(255,255,255,0.95)" stroke={tp.isLoss ? "#ff1744" : (() => { const c = detectionTypeColor(tp.radar_type); return `rgb(${c[0]},${c[1]},${c[2]})`; })()} strokeWidth={0.8} />
              <text x={tooltipX + 8} y={tooltipY + 14} fill="#374151" fontSize={8} fontWeight="bold">
                {tp.mode_s} {tp.isLoss ? "(Loss)" : ""}
              </text>
              <text x={tooltipX + 8} y={tooltipY + 28} fill="#6b7280" fontSize={8}>
                시각: <tspan fill="#374151">{timeStr} UTC</tspan>
              </text>
              <text x={tooltipX + 8} y={tooltipY + 42} fill="#6b7280" fontSize={8}>
                고도: <tspan fill="#374151" fontWeight="bold">{Math.round(tp.altitude * 3.28084).toLocaleString()}ft</tspan>
                <tspan fill="#6b7280" fontSize={7}> ({tp.altitude.toFixed(0)}m)</tspan>
              </text>
              <text x={tooltipX + 8} y={tooltipY + 56} fill="#6b7280" fontSize={8}>
                거리: <tspan fill="#374151">{(tpDist / 1.852).toFixed(1)}NM</tspan>
              </text>
            </g>
          );
        })()}
        {/* 각도선 드래그 핸들 */}
        {showCustomAngle && angleHandlePosRef.current && (
          <circle
            cx={angleHandlePosRef.current.x}
            cy={Math.max(PAD.top, Math.min(H - PAD.bottom, angleHandlePosRef.current.y))}
            r={6}
            fill="#f43f5e" fillOpacity={0.8} stroke="white" strokeWidth={2}
            style={{ cursor: "ns-resize" }}
          />
        )}
      </svg>
      </div>
    );
  };

  return (
    <div className="border-t border-gray-200 bg-white/95 backdrop-blur-sm shadow-lg">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-2">
        <span className="text-xs font-semibold text-gray-800">LoS 단면도</span>
        <span className="text-[10px] text-gray-500">
          {radarSite.name} → {targetLat.toFixed(4)}°N {targetLon.toFixed(4)}°E
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-2 text-[10px] text-gray-500">
          <span>거리: {(totalDist / 1.852).toFixed(1)}NM</span>
          <span>방위: {bearing.toFixed(0)}°</span>
          {chartData && (
            <span className={chartData.blocked ? "text-[#a60739]" : "text-emerald-600"}>
              {chartData.blocked ? "LoS 차단" : "LoS 양호"}
            </span>
          )}
          {(Math.abs(xZoom[0] - fitZoom[0]) > 0.5 || Math.abs(xZoom[1] - fitZoom[1]) > 0.5) ? (
            <button
              onClick={() => { xZoomRef.current = fitZoom; setXZoom(fitZoom); }}
              className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-gray-200 transition-colors"
              title="타겟 거리로 줌 리셋"
            >
              {Math.round(100 / ((xZoom[1] - xZoom[0]) / 100))}% ✕
            </button>
          ) : null}
          {buildings.length > 0 && (
            <button
              onClick={() => setShowBuildings(!showBuildings)}
              className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                showBuildings
                  ? "bg-slate-200 text-slate-700"
                  : "bg-gray-100 text-gray-400"
              }`}
            >
              건물 {showBuildings ? "ON" : "OFF"}
            </button>
          )}
          <button
            onClick={() => setShowCustomAngle(!showCustomAngle)}
            className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
              showCustomAngle
                ? "bg-rose-100 text-rose-700"
                : "bg-gray-100 text-gray-400"
            }`}
          >
            각도선
          </button>
          {showCustomAngle && (
            <div className="flex items-center gap-1">
              <input
                type="number"
                value={customAngleDeg}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (!isNaN(v)) setCustomAngleDeg(Math.max(-1, Math.min(45, Math.round(v * 100) / 100)));
                }}
                step={0.01}
                min={-1}
                max={45}
                className="w-16 rounded border border-gray-300 bg-white px-1 py-0.5 text-[10px] text-center text-gray-700"
                title="각도 (°)"
              />
              <span className="text-[10px] text-gray-400">°</span>
            </div>
          )}
          {chartData && chartData.namedPeaks.length > 0 && (
            <span className="text-yellow-600">
              산: {chartData.namedPeaks.map((p) => p.name).join(", ")}
            </span>
          )}
        </div>
        <button onClick={onClose}
          className="rounded p-1 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800">
          <X size={14} />
        </button>
      </div>

      {/* Chart — 재조회 중에도 직전 차트를 유지(깜박임 방지), 우상단 소형 스피너로만 진행 표시.
           최초 로드(차트 없음)일 때만 전체 스피너. */}
      <div className="relative px-4 py-2">
        {chartData ? (
          <>
            <div style={{ opacity: loading ? 0.6 : 1, transition: "opacity .2s" }}>
              {renderChart()}
            </div>
            {loading && (
              <div className="absolute right-5 top-3 flex items-center gap-1 rounded bg-white/85 px-1.5 py-0.5 shadow-sm">
                <Loader2 size={12} className="animate-spin text-gray-500" />
                <span className="text-[10px] text-gray-500">갱신 중</span>
              </div>
            )}
          </>
        ) : (
          <div className="flex h-[220px] items-center justify-center">
            <Loader2 size={20} className="animate-spin text-gray-500" />
            <span className="ml-2 text-xs text-gray-500">고도 데이터 로딩 중...</span>
          </div>
        )}
      </div>

    </div>
  );
}
