/**
 * OM 기준데이터(참조 달) — 정합성 판정·폴백 사유 표기 공유 유틸.
 *
 * 기준데이터는 빌드 시점의 레이더 좌표·안테나고로 집계되므로, 이후 레이더 설정이 바뀌면
 * 편차(Δ%p) 비교의 전제가 깨진다. 이 정합성 판정은 3곳에서 동일 임계로 수행되어야 한다:
 * - 보고서 생성(ReportApp) — 통과 시에만 delta 판정, 실패 시 절대 임계 폴백
 * - 기준데이터 관리 모달(OMReferenceModal) — 목록에 적용 가능/미적용 배지
 * - 보고서 설정 모달(ObstacleMonthlyConfigModal) — 레이더 선택 단계 판정 모드 예고
 * 임계·사유 문구를 여기 단일 원천으로 두어 세 곳의 표기가 어긋나지 않게 한다.
 */
import type { OmReferenceMeta, RefFallbackReason } from "../types/obstacle";
import type { RadarSite } from "../types";

/** 위도·경도 정합 허용 오차 (도) — ReportApp 기준 게이트와 동일 */
export const REF_COHERENCE_LATLON_DEG = 0.0005;
/** 안테나고 정합 허용 오차 (m) */
export const REF_COHERENCE_ANT_M = 0.1;

/** 정합성 판정 결과 */
export interface RefCoherence {
  ok: boolean;
  /** 위도 또는 경도 불일치 */
  coordMismatch: boolean;
  /** 안테나고 불일치 */
  antMismatch: boolean;
  /** 불일치 사유 표기 ("좌표 불일치" | "안테나고 불일치" | "좌표·안테나고 불일치"). 일치면 "" */
  reasonText: string;
}

/** 기준데이터 메타 ↔ 현재 레이더 사이트 정합성 판정 (단일 원천) */
export function checkRefCoherence(meta: OmReferenceMeta, site: RadarSite): RefCoherence {
  const coordMismatch =
    Math.abs(meta.radar_lat - site.latitude) >= REF_COHERENCE_LATLON_DEG ||
    Math.abs(meta.radar_lon - site.longitude) >= REF_COHERENCE_LATLON_DEG;
  const antMismatch = Math.abs(meta.antenna_height - site.antenna_height) >= REF_COHERENCE_ANT_M;
  const reasonText = coordMismatch && antMismatch
    ? "좌표·안테나고 불일치"
    : coordMismatch
      ? "좌표 불일치"
      : antMismatch
        ? "안테나고 불일치"
        : "";
  return { ok: !coordMismatch && !antMismatch, coordMismatch, antMismatch, reasonText };
}

/** 기준데이터 미적용 사유 → 보고서 표기 라벨 (요약표 소자·소견표 각주 공용) */
export const REF_FALLBACK_LABELS: Record<RefFallbackReason, string> = {
  none: "기준 없음",
  mismatch: "레이더 정보 불일치",
  load_failed: "기준 로드 실패",
  ref_insufficient: "기준 표본 부족",
};
