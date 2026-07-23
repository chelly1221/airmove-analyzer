/**
 * OM 보고서 — (레이더 × 분석 대상 장애물) 소실표적 분류 요약표 (안 2: 누적 막대).
 *
 * 판정 헤드라인 바(추가 기인 판정 + 추가 차단 구간 소실율/추세) + 3분할 가로 누적 막대
 * (추가 기인 | 지형·기존지물 | 장애물 무관, Σ = 후방 소실표적 총 이벤트) + 브래킷(LoS 차단 영역) + 레전드
 * + 하단 각주 3단 구성. 핵심 판정은 표 상단 헤드라인 바, 분류 퍼널은 막대·레전드로 시각화한다.
 * (§3 상세 재배치: 영향범위 도면 → 요약표 → LoS 단면도 → Az×Elev 차트 순.)
 * 차트(ReportOMObstacleAzElevChart)와 동일한 classifyObstacleLosses 결과를 사용 → 집계·편집키(azelev.*.tbl.*) 완전 동일.
 *   분류 계산은 ReportOMObstacleDetail 로 리프트되어(② 요약표·상단 메타 스트립 '대상 차단각' 공용) computed props 로 수신.
 *
 * 집계 단위 — 스키마 계약:
 *   '…건' = 이벤트 건수(distinct event_id), 분류 세그먼트/레전드는 '분자/분모건'(분모 = 후방 소실표적 총 이벤트)으로
 *   표기해 이벤트/이벤트 비율임을 표기 자체로 드러냄(% 병기 없음 — '건/초' 오독 방지, % 는 헤드라인 소실율·막대 세그먼트 폭에만 허용),
 *   소실시간 = Σ share_s(같은 gap 보간점 합 = gap — 점×gap 과대 없음)로 추가 기인 레전드 행에만 병기, 점 개수(표시점)는 하단 각주에 병기(차트 점과 일치).
 *   세그먼트 폭 = (ev/totalEv)*100%, Σ ev = totalEv 정확 보존. 3분할: 추가 기인(bldgEv) ⊆ LoS 차단(shadowEv),
 *   지형·기존지물 = shadowEv−bldgEv, 장애물 무관 = totalEv−shadowEv.
 *   ※ 구 4열 표(편집키 tbl.colItem/colVal/colDur/colNote)·구 '↳ 대상 차단각' 행(r5.*)은 누적 막대 전환으로 삭제 —
 *     기존 저장 오버라이드는 무해하게 고아화된다(r5.* 선례와 동일).
 */
import type { ManualBuilding, RadarSite } from "../../types";
import type { AddedBlockageResult } from "../../types/obstacle";
import { classifyObstacleLosses } from "../../utils/obstacleAnalysisHelpers";
import { BLOCKAGE_NONE_LABEL } from "../../utils/omStats";
import { REF_FALLBACK_LABELS } from "../../utils/omReference";
import OMEditable from "./OMEditable";

interface Props {
  radarSite: RadarSite;
  building: ManualBuilding;
  /** 분류 결과 — ReportOMObstacleDetail 에서 리프트한 classifyObstacleLosses 산출물(차트와 동일 인자·동일 집계) */
  computed: ReturnType<typeof classifyObstacleLosses>;
  /** 추가 차단영역 소실율 — 헤드라인 심각도 지표 (omAddedBlockage, ReportApp 에서 산출) */
  blockage?: AddedBlockageResult;
}

/** 분류 요약 — Az×Elev 차트와 동일 분류 결과(computed)를 판정 헤드라인 바 + 3분할 누적 막대·레전드로 제공. */
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
  const terrainEv = shadowEv - bldgEv;             // 지형·기존지물 차단(신규 파생) — buildingCaused ⊆ inShadow 이므로 ≥ 0
  // 표시용은 분자/분모건 — bldgRatio 는 강조색·폴백 판정에만 사용
  const bldgRatio = totalEv > 0 ? (bldgEv / totalEv) * 100 : 0;

  // 인라인 편집키 접두사 — 차트와 동일 스킴(azelev.*) 유지 → 기존 편집 보존
  const eid = `azelev.${radarSite.name}_${building.id}`;

  // Δ%p 부호 표기 — 양수 +, 음수는 − (U+2212) 사용 (요구 사양)
  const signedPp = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`;

  // 3분할 세그먼트 — 색·라벨·편집키(key)·산정 기준 단일 원천(막대·레전드 공유). Σ ev = totalEv 정확 보존.
  //   색은 CVD 검증 통과 팔레트: 추가 기인 #a60739 / 지형·기존지물 #a16207 / 장애물 무관 #2563eb.
  const segments = [
    { key: "r3",       ev: bldgEv,    color: "#a60739", label: "장애물 추가 기인",   note: "지형·기존지물 차단각 초과 ~ 대상 차단각 사이", strong: true  },
    { key: "rTerrain", ev: terrainEv, color: "#a16207", label: "지형·기존지물 차단", note: "기존 차단각 이하 소실(장애물 무관 차단)",     strong: false },
    { key: "r4",       ev: freeEv,    color: "#2563eb", label: "장애물 무관",       note: "차단 영역 외 소실표적",                        strong: false },
  ];

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
            ) : blockage.gradingMode === "delta" && blockage.refLossRatePct !== undefined && blockage.deltaPp !== undefined ? (
              /* delta 모드 — 기준월 대비 편차 병기 (분석월 소실율 = blockage.lossRatePct) */
              <>
                <OMEditable id={`${eid}.tbl.blockage.deltaLabel`} value="추가 차단 구간" tag="span" />{" "}
                기준 {blockage.refMonthLabel} <span className="mono">{blockage.refLossRatePct.toFixed(2)}%</span>
                {" → "}분석월 <span className="mono">{blockage.lossRatePct.toFixed(2)}%</span>{" "}
                <span className="mono strong" style={{ color: verdict.color }}>(Δ {signedPp(blockage.deltaPp)}%p)</span>
                {" · 추세 "}{blockage.trendDir}
                {blockage.trendDir !== "안정" ? (
                  <span className="mono">{` (일당 ${blockage.trendSlopePctPerDay > 0 ? "+" : ""}${blockage.trendSlopePctPerDay.toFixed(3)}%p)`}</span>
                ) : ""}
              </>
            ) : (
              /* absolute 폴백 — 기존 표시 유지 + 기준데이터 미적용 소자 */
              <>
                <OMEditable id={`${eid}.tbl.blockage.label`} value="추가 차단 구간 소실율" tag="span" />{" "}
                <span className="mono">{blockage.lossRatePct.toFixed(2)}%</span> · 추세 {blockage.trendDir}
                {blockage.trendDir !== "안정" ? (
                  <span className="mono">{` (일당 ${blockage.trendSlopePctPerDay > 0 ? "+" : ""}${blockage.trendSlopePctPerDay.toFixed(3)}%p)`}</span>
                ) : ""}
                <span className="muted">{` · 기준데이터 미적용(${REF_FALLBACK_LABELS[blockage.refFallback ?? "none"]})`}</span>
              </>
            )}
          </span>
        )}
      </div>

      {/* (B) 분류 누적 막대 — 3분할(추가 기인|지형·기존지물|장애물 무관), Σ = totalEv. 순수 div/CSS(캔버스·SVG 금지 → PrintToPdf 안전) */}
      <div className="om-cls-chart">
        {totalEv === 0 ? (
          /* 빈 상태 — 소실 이벤트 0건 */
          <div className="om-cls-empty">
            <OMEditable id={`${eid}.tbl.empty`} value="후방 소실표적 없음 — 분석 대상 방위 창 내 소실 이벤트 0건" tag="span" />
          </div>
        ) : (
          <>
            {/* 헤더 — 좌: 후방 소실표적 총 이벤트, 우(muted): 방위 허용각 · 후방 영역 설명 */}
            <div className="om-cls-head">
              <span>
                <OMEditable id={`${eid}.tbl.r1.label`} value="후방 소실표적" tag="span" />{" "}
                <span className="mono strong">{totalEv}건</span>
              </span>
              {/* 허용각은 건물별 max(±10°, 노출면 반각폭+1°) — classifyAzToleranceDeg(분류와 단일 소스) */}
              <span className="muted">방위 ±{computed.azTolDeg.toFixed(1)}° · <OMEditable id={`${eid}.tbl.r1.note`} value="분석 대상 후방 영역" tag="span" /></span>
            </div>

            {/* 누적 막대 — ev>0 세그먼트만, 폭 = (ev/totalEv)*100%. 세그먼트 간 흰 간격(column-gap)만, 테두리 없음 */}
            <div className="om-cls-bar">
              {segments.filter((s) => s.ev > 0).map((s) => {
                const pct = (s.ev / totalEv) * 100;
                return (
                  <div
                    key={s.key}
                    className="om-cls-seg"
                    style={{ width: `${pct}%`, background: s.color }}
                    title={`${s.label} ${s.ev}/${totalEv}건`}
                  >
                    {/* 폭 ≥ 8%일 때만 내부 라벨(넘침·클리핑 방지 — 미달 시 라벨 자체를 렌더 안 함) */}
                    {pct >= 8 ? <span>{s.ev}건</span> : null}
                  </div>
                );
              })}
            </div>

            {/* 브래킷 — LoS 차단 영역(shadowEv) 폭 표시. ⊔형 라인 + 오른쪽 overflow 허용 nowrap 라벨 */}
            {shadowEv > 0 && (
              <div className="om-cls-bracket" style={{ width: `${(shadowEv / totalEv) * 100}%` }}>
                <div className="om-cls-bracket-line" />
                <div className="om-cls-bracket-label">
                  <OMEditable id={`${eid}.tbl.r2.label`} value="LoS 차단 영역 내" tag="span" /> {shadowEv}/{totalEv}건
                  <span className="muted"> · <OMEditable id={`${eid}.tbl.r2.note`} value="지형+장애물 통합 차단" tag="span" /></span>
                </div>
              </div>
            )}

            {/* 레전드 — 3행 고정(0건 세그먼트도 항목 정체성 보존). 색은 칩이 담당, 텍스트는 잉크색 유지 */}
            <div className="om-cls-legend">
              {segments.map((s) => (
                <div key={s.key} className="om-cls-lg-row">
                  <span className="om-cls-chip" style={{ background: s.color }} />
                  <OMEditable id={`${eid}.tbl.${s.key}.label`} value={s.label} tag="span" className={s.strong ? "strong" : ""} />
                  {/* 소실시간(Σ share_s)은 추가 기인 행에만, bldgEv>0일 때만 병기 */}
                  <span className="mono">{s.ev}/{totalEv}건{s.key === "r3" && bldgEv > 0 ? ` · ${bldgDuration.toFixed(1)}초` : ""}</span>
                  <span className="muted" style={{ fontSize: "10.5px" }}><OMEditable id={`${eid}.tbl.${s.key}.note`} value={s.note} tag="span" /></span>
                </div>
              ))}
            </div>

            {/* 추가 기인 0건 명시 (사용자 요구) — 후방 소실 전건이 지형·기존지물 이하 또는 차단 영역 외 */}
            {bldgEv === 0 && (
              <div className="om-cls-zero">
                ※ <OMEditable id={`${eid}.tbl.zeroBldg`} value="장애물 추가 기인 소실표적 없음 — 후방 소실 전건이 지형·기존지물 차단각 이하 또는 차단 영역 외" tag="span" />
              </div>
            )}
          </>
        )}
      </div>

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
