/**
 * OM 보고서 — (레이더 × 분석 대상 장애물) 소실표적 분류 요약표.
 *
 * 기존 ReportOMObstacleAzElevChart 캔버스 하단에 인라인이던 요약표를 단독 컴포넌트로 분리.
 * (§3 상세 재배치: 영향범위 도면 → 요약표 → LoS 단면도 → Az×Elev 차트 순. 표를 차트에서 떼어 2번째 배치)
 * 차트와 동일한 classifyObstacleLosses(동일 인자) 결과를 사용 → 집계·편집키(azelev.*.tbl.*) 완전 동일.
 *
 * 집계 단위 — 스키마 계약:
 *   '…건' = 이벤트 건수(distinct event_id), 비율 = 이벤트/이벤트(분자·분모 동일 단위),
 *   소실시간 = Σ share_s(같은 gap 보간점 합 = gap — 점×gap 과대 없음), 점 개수는 1행에 병기(차트 점과 일치).
 */
import { useMemo } from "react";
import type { ManualBuilding, RadarSite, PanoramaMergeResult } from "../../types";
import type { LossPointGeo, AddedBlockageResult } from "../../types/obstacle";
import { classifyObstacleLosses, type SiblingBuilding } from "../../utils/obstacleAnalysisHelpers";
import { BLOCKAGE_NONE_LABEL } from "../../utils/omStats";
import OMEditable from "./OMEditable";

const KM_PER_NM = 1.852;

interface Props {
  radarSite: RadarSite;
  building: ManualBuilding;
  /** 이 레이더의 모든 소실표적 (방위 윈도우 + 대상 후방 필터링은 분류 내부에서) */
  lossPoints: LossPointGeo[];
  /** 분석 대상 포함 파노라마 (분류 차단각 산출 — 차트 빨강영역과 동일 소스) */
  panoWith?: PanoramaMergeResult;
  /** 분석 대상 제외 파노라마 */
  panoWithout?: PanoramaMergeResult;
  /** 같은 레이더의 '다른' 분석 대상 건물 — buildSiblings 산출(소실표적 오귀속 방지, 분류 내부에서 사용) */
  siblings?: SiblingBuilding[];
  /** 추가 차단영역 소실율 — 헤드라인 심각도 지표 (omAddedBlockage, ReportApp 에서 산출) */
  blockage?: AddedBlockageResult;
}

/** 분류 요약표 — Az×Elev 차트와 동일 분류 결과를 표로 제공. */
export default function ReportOMObstacleSummaryTable({
  radarSite, building, lossPoints, panoWith, panoWithout, siblings, blockage,
}: Props) {
  // 차트(ReportOMObstacleAzElevChart)와 동일 인자 → 동일 집계. (보고서 1건 분량, 메모이즈로 재계산 저렴)
  const computed = useMemo(
    () => classifyObstacleLosses(radarSite, building, lossPoints, { panoWith, panoWithout, siblings }),
    [radarSite, building, lossPoints, panoWith, panoWithout, siblings],
  );

  // 요약 수치 — '…건'은 이벤트(distinct event_id), 비율도 이벤트/이벤트. 점 개수(totalPts)는 1행 병기용.
  const totalPts = computed.losses.length;
  const totalEv = computed.totalEventCount;
  const shadowEv = computed.shadowEventCount;
  const bldgEv = computed.buildingEventCount;
  const bldgDuration = computed.buildingDurationS; // Σ share_s — 같은 gap 보간점 합 = gap
  const freeEv = totalEv - shadowEv;               // inShadow 점이 하나도 없는 이벤트 (합 = totalEv 보존)
  const shadowRatio = totalEv > 0 ? (shadowEv / totalEv) * 100 : 0;
  const bldgRatio = totalEv > 0 ? (bldgEv / totalEv) * 100 : 0;
  const hasBldgEffect = computed.angleTotalDeg > computed.angleTerrainDeg + 0.005;

  // 인라인 편집키 접두사 — 차트와 동일 스킴(azelev.*) 유지 → 기존 편집 보존
  const eid = `azelev.${radarSite.name}_${building.id}`;

  return (
    /* 요약 테이블 — 분석요약 표(.om-table)와 동일 색·스타일로 통일 */
    <table className="om-table sm-table mt-2">
      <thead>
        <tr>
          <th><OMEditable id={`${eid}.tbl.colItem`} value="항목" tag="span" /></th>
          <th><OMEditable id={`${eid}.tbl.colVal`} value="값" tag="span" /></th>
          <th><OMEditable id={`${eid}.tbl.colNote`} value="비고" tag="span" /></th>
        </tr>
      </thead>
      <tbody>
        <tr>
          {/* 허용각은 건물별 max(±10°, 노출면 반각폭+1°) — classifyAzToleranceDeg(분류와 단일 소스) */}
          <td>방위 ±{computed.azTolDeg.toFixed(1)}° · <OMEditable id={`${eid}.tbl.r1.label`} value="후방 소실표적" tag="span" /></td>
          <td className="ta-r mono">{totalEv}건 · {totalPts}점</td>
          <td className="muted"><OMEditable id={`${eid}.tbl.r1.note`} value="분석 대상 후방 영역" tag="span" /></td>
        </tr>
        <tr className="alt">
          <td><OMEditable id={`${eid}.tbl.r2.label`} value="LoS 차단 영역 내" tag="span" /></td>
          <td className="ta-r mono">
            {shadowEv}건 ({shadowRatio.toFixed(1)}%)
          </td>
          <td className="muted"><OMEditable id={`${eid}.tbl.r2.note`} value="지형+장애물 통합 차단" tag="span" /></td>
        </tr>
        <tr>
          <td className="strong" style={{ color: "#a60739" }}><OMEditable id={`${eid}.tbl.r3.label`} value="장애물 추가 기인" tag="span" /></td>
          <td className="ta-r mono strong" style={{ color: bldgRatio > 10 ? "#dc2626" : "#374151" }}>
            {bldgEv}건 ({bldgRatio.toFixed(1)}%) / {bldgDuration.toFixed(1)}초
          </td>
          <td className="muted">
            <OMEditable id={`${eid}.tbl.r3.note`} value="지형·기존지물 차단각 초과 ~ 대상 차단각 사이" tag="span" />
          </td>
        </tr>
        {blockage && (
          <tr>
            <td className="strong" style={{ color: "#a60739" }}>
              ↳ <OMEditable id={`${eid}.tbl.blockage.label`} value="추가 차단 구간 소실율" tag="span" />
            </td>
            <td className="ta-r mono strong" style={{ color: blockage.grade.color }}>
              {/* 추가 차단 구간 미형성(BLOCKAGE_NONE_LABEL)은 라벨 대신 0.00%로 표시 — 비율 정의상 추가 소실 없음. */}
              {blockage.grade.label === "항적 없음" || blockage.grade.label === "판정 불가"
                ? blockage.grade.label
                : blockage.grade.label === BLOCKAGE_NONE_LABEL
                ? `${blockage.lossRatePct.toFixed(2)}%`
                : `${blockage.lossRatePct.toFixed(2)}% · ${blockage.grade.label}`}
            </td>
            <td className="muted">
              {blockage.grade.label === BLOCKAGE_NONE_LABEL
                ? <OMEditable id={`${eid}.tbl.blockage.noteNone`} value="지형·기존지물 이하 → 추가 차단영역 미형성" tag="span" />
                : blockage.grade.label === "항적 없음"
                ? <OMEditable id={`${eid}.tbl.blockage.note0`} value="통과 항적 거의 없음 → 영향 없음" tag="span" />
                : <>통과 {Math.round(blockage.exposurePointCount).toLocaleString()}pt 중 소실 {Math.round(blockage.lossPointCount).toLocaleString()}pt·{blockage.daysWithExposure}일 · 추세 {blockage.trendDir}
                  {blockage.trendDir !== "안정" ? ` (일당 ${blockage.trendSlopePctPerDay > 0 ? "+" : ""}${blockage.trendSlopePctPerDay.toFixed(3)}%p)` : ""}</>}
            </td>
          </tr>
        )}
        <tr className="alt">
          <td style={{ color: "#2563eb" }}><OMEditable id={`${eid}.tbl.r4.label`} value="장애물 무관" tag="span" /></td>
          <td className="ta-r mono">
            {freeEv}건 ({totalEv > 0 ? ((freeEv / totalEv) * 100).toFixed(1) : "0.0"}%)
          </td>
          <td className="muted"><OMEditable id={`${eid}.tbl.r4.note`} value="차단 영역 외 소실표적" tag="span" /></td>
        </tr>
        <tr>
          <td>↳ <OMEditable id={`${eid}.tbl.r5.label`} value="대상 차단각" tag="span" /></td>
          <td className="ta-r mono">
            {computed.angleTotalDeg.toFixed(2)}°
            {hasBldgEffect ? ` (지형 ${computed.angleTerrainDeg.toFixed(2)}°)` : " (지형 이하)"}
          </td>
          <td className="muted">
            {(computed.bDistKm / KM_PER_NM).toFixed(1)}NM · 추가 기인 판정:
            {" "}
            {/* 헤드라인은 추가 차단영역 등급으로 정렬 — 이벤트 비율(bldgRatio) 폴백은 추가 차단영역 미제공 시 */}
            {blockage
              ? <span className="strong" style={{ color: blockage.grade.color }}>{blockage.grade.label}</span>
              : bldgRatio > 20
              ? <span className="strong" style={{ color: "#dc2626" }}>유의미</span>
              : bldgRatio > 5
                ? <span className="strong" style={{ color: "#d97706" }}>부분 영향</span>
                : <span className="strong" style={{ color: "#16a34a" }}>영향 미미</span>}
          </td>
        </tr>
      </tbody>
    </table>
  );
}
