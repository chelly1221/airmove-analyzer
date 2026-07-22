/**
 * OM 보고서 — (레이더 × 분석 대상 장애물) 소실표적 분류 요약표 (안 1 리디자인).
 *
 * 판정 헤드라인 바(추가 기인 판정 + 추가 차단 구간 소실율/추세) + 순수 4열 분류표(분류|이벤트|소실시간|산정 기준)
 * + 하단 각주 3단 구성. 핵심 판정을 분류 퍼널에서 떼어 표 상단 헤드라인 바로 노출한다.
 * (§3 상세 재배치: 영향범위 도면 → 요약표 → LoS 단면도 → Az×Elev 차트 순.)
 * 차트(ReportOMObstacleAzElevChart)와 동일한 classifyObstacleLosses 결과를 사용 → 집계·편집키(azelev.*.tbl.*) 완전 동일.
 *   분류 계산은 ReportOMObstacleDetail 로 리프트되어(② 요약표·상단 메타 스트립 '대상 차단각' 공용) computed props 로 수신.
 *
 * 집계 단위 — 스키마 계약:
 *   '…건' = 이벤트 건수(distinct event_id), 분류 행은 '분자/분모건'(분모 = 후방 소실표적 총 이벤트)으로
 *   표기해 이벤트/이벤트 비율임을 표기 자체로 드러냄(% 병기 없음 — '건/초' 오독 방지, % 는 헤드라인 소실율에만 허용),
 *   소실시간 = Σ share_s(같은 gap 보간점 합 = gap — 점×gap 과대 없음), 점 개수(표시점)는 표 하단 각주에 병기(차트 점과 일치).
 *   ※ 구 '↳ 대상 차단각' 행(편집키 r5.*)은 메타 스트립으로 이관·삭제 — 기존 저장 오버라이드는 무해하게 고아화된다.
 */
import type { ManualBuilding, RadarSite } from "../../types";
import type { AddedBlockageResult } from "../../types/obstacle";
import { classifyObstacleLosses } from "../../utils/obstacleAnalysisHelpers";
import { BLOCKAGE_NONE_LABEL } from "../../utils/omStats";
import OMEditable from "./OMEditable";

interface Props {
  radarSite: RadarSite;
  building: ManualBuilding;
  /** 분류 결과 — ReportOMObstacleDetail 에서 리프트한 classifyObstacleLosses 산출물(차트와 동일 인자·동일 집계) */
  computed: ReturnType<typeof classifyObstacleLosses>;
  /** 추가 차단영역 소실율 — 헤드라인 심각도 지표 (omAddedBlockage, ReportApp 에서 산출) */
  blockage?: AddedBlockageResult;
}

/** 분류 요약표 — Az×Elev 차트와 동일 분류 결과(computed)를 판정 헤드라인 바 + 4열 표로 제공. */
export default function ReportOMObstacleSummaryTable({
  radarSite, building, computed, blockage,
}: Props) {
  // 요약 수치 — '…건'은 이벤트(distinct event_id). totalPts(표시점)는 각주 병기용.
  const totalPts = computed.losses.length;
  const totalEv = computed.totalEventCount;
  const shadowEv = computed.shadowEventCount;
  const bldgEv = computed.buildingEventCount;
  const bldgDuration = computed.buildingDurationS; // Σ share_s — 같은 gap 보간점 합 = gap
  const freeEv = totalEv - shadowEv;               // inShadow 점이 하나도 없는 이벤트 (합 = totalEv 보존)
  // 표시용은 분자/분모건 — bldgRatio 는 강조색·폴백 판정에만 사용
  const bldgRatio = totalEv > 0 ? (bldgEv / totalEv) * 100 : 0;

  // 인라인 편집키 접두사 — 차트와 동일 스킴(azelev.*) 유지 → 기존 편집 보존
  const eid = `azelev.${radarSite.name}_${building.id}`;

  // 판정 헤드라인 — 추가 차단영역 등급으로 정렬(추가 차단영역 미제공 시 이벤트 비율 폴백, 구 마지막 행 로직 이관)
  const verdict = blockage
    ? blockage.grade
    : bldgRatio > 20 ? { label: "유의미", color: "#dc2626" }
    : bldgRatio > 5 ? { label: "부분 영향", color: "#d97706" }
    : { label: "영향 미미", color: "#16a34a" };

  // 정상 등급 = 추가 차단영역이 형성된 실제 소실율 등급('항적 없음'·'판정 불가'·미형성 제외).
  //   헤드라인 우측 추세 표기·각주 표본 상세는 정상 등급에서만 노출.
  const isNormalGrade = !!blockage
    && blockage.grade.label !== "항적 없음"
    && blockage.grade.label !== "판정 불가"
    && blockage.grade.label !== BLOCKAGE_NONE_LABEL;

  return (
    <div className="mt-2">
      {/* (A) 판정 헤드라인 바 — 좌: 추가 기인 판정 배지, 우: 추가 차단 구간 소실율·추세(구 4행 값 이관) */}
      <div className="om-verdict-bar" style={{ borderLeftColor: verdict.color }}>
        <span>
          <OMEditable id={`${eid}.tbl.verdict.label`} value="추가 기인 판정" tag="span" />{" "}
          <span className="strong" style={{ color: verdict.color }}>● {verdict.label}</span>
        </span>
        {blockage && (
          <span className="vb-detail">
            {/* 추가 차단 구간 소실율(비율 지표)만 % 허용 — 분류 행 이벤트 열엔 % 금지 */}
            {blockage.grade.label === "항적 없음" ? (
              <OMEditable id={`${eid}.tbl.blockage.note0`} value="통과 항적 거의 없음 → 영향 없음" tag="span" />
            ) : blockage.grade.label === "판정 불가" ? (
              <>통과 {Math.round(blockage.exposurePointCount).toLocaleString()}pt · 표본 부족</>
            ) : blockage.grade.label === BLOCKAGE_NONE_LABEL ? (
              <>
                <span className="mono">{blockage.lossRatePct.toFixed(2)}%</span> ·{" "}
                <OMEditable id={`${eid}.tbl.blockage.noteNone`} value="지형·기존지물 이하 → 추가 차단영역 미형성" tag="span" />
              </>
            ) : (
              <>
                <OMEditable id={`${eid}.tbl.blockage.label`} value="추가 차단 구간 소실율" tag="span" />{" "}
                <span className="mono">{blockage.lossRatePct.toFixed(2)}%</span> · 추세 {blockage.trendDir}
                {blockage.trendDir !== "안정" ? (
                  <span className="mono">{` (일당 ${blockage.trendSlopePctPerDay > 0 ? "+" : ""}${blockage.trendSlopePctPerDay.toFixed(3)}%p)`}</span>
                ) : ""}
              </>
            )}
          </span>
        )}
      </div>

      {/* (B) 순수 분류표 — 분류|이벤트|소실시간|산정 기준. '분자/분모건' 표기 유지(분류 행 % 금지) */}
      <table className="om-table sm-table mt-1.5">
        <thead>
          <tr>
            <th><OMEditable id={`${eid}.tbl.colItem`} value="분류" tag="span" /></th>
            <th><OMEditable id={`${eid}.tbl.colVal`} value="이벤트" tag="span" /></th>
            <th><OMEditable id={`${eid}.tbl.colDur`} value="소실시간" tag="span" /></th>
            <th><OMEditable id={`${eid}.tbl.colNote`} value="산정 기준" tag="span" /></th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><OMEditable id={`${eid}.tbl.r1.label`} value="후방 소실표적" tag="span" /></td>
            <td className="ta-r mono">{totalEv}건</td>
            <td className="ta-c muted">—</td>
            {/* 허용각은 건물별 max(±10°, 노출면 반각폭+1°) — classifyAzToleranceDeg(분류와 단일 소스) */}
            <td className="muted">방위 ±{computed.azTolDeg.toFixed(1)}° · <OMEditable id={`${eid}.tbl.r1.note`} value="분석 대상 후방 영역" tag="span" /></td>
          </tr>
          <tr className="alt">
            <td style={{ paddingLeft: 14 }}>↳ <OMEditable id={`${eid}.tbl.r2.label`} value="LoS 차단 영역 내" tag="span" /></td>
            <td className="ta-r mono">{shadowEv}/{totalEv}건</td>
            <td className="ta-c muted">—</td>
            <td className="muted"><OMEditable id={`${eid}.tbl.r2.note`} value="지형+장애물 통합 차단" tag="span" /></td>
          </tr>
          <tr>
            <td className="strong" style={{ color: "#a60739", paddingLeft: 26 }}>↳ <OMEditable id={`${eid}.tbl.r3.label`} value="장애물 추가 기인" tag="span" /></td>
            <td className="ta-r mono strong" style={{ color: bldgRatio > 10 ? "#dc2626" : "#374151" }}>{bldgEv}/{totalEv}건</td>
            <td className="ta-r mono">{bldgDuration.toFixed(1)}초</td>
            <td className="muted"><OMEditable id={`${eid}.tbl.r3.note`} value="지형·기존지물 차단각 초과 ~ 대상 차단각 사이" tag="span" /></td>
          </tr>
          <tr className="alt">
            <td style={{ color: "#2563eb", paddingLeft: 14 }}>↳ <OMEditable id={`${eid}.tbl.r4.label`} value="장애물 무관" tag="span" /></td>
            <td className="ta-r mono">{freeEv}/{totalEv}건</td>
            <td className="ta-c muted">—</td>
            <td className="muted"><OMEditable id={`${eid}.tbl.r4.note`} value="차단 영역 외 소실표적" tag="span" /></td>
          </tr>
        </tbody>
      </table>

      {/* (C) 각주 — 표시점 수(차트 점과 일치)·소실시간 정의 + (정상 등급 한정) 통과/소실 표본 상세(구 4행 비고 이관) */}
      <div className="om-tbl-note">
        ※ 표시점 {totalPts.toLocaleString()}점(Az×Elev 차트 표시점과 일치) · 소실시간 = Σ 이벤트 분담시간(share_s)
        {isNormalGrade && blockage
          ? ` · 통과 ${Math.round(blockage.exposurePointCount).toLocaleString()}pt 중 소실 ${Math.round(blockage.lossPointCount).toLocaleString()}pt · ${blockage.daysWithExposure}일`
          : ""}
      </div>
    </div>
  );
}
