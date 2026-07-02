import React, { useMemo } from "react";
import type { RadarMonthlyResult, ManualBuilding, BuildingGroup, RadarSite, LoSProfileData, LossPointGeo, PanoramaMergeResult } from "../../types";
import type { AddedBlockageResult } from "../../types/obstacle";
import {
  weightedLossAvg, weightedLossStdDev,
  weightedPsrAvg, weightedPsrStdDev,
  gradeWithConfidence,
} from "../../utils/omStats";
import { haversineKm, bearingDeg } from "../../utils/geo";
import { classifyObstacleLosses, buildSiblings } from "../../utils/obstacleAnalysisHelpers";
import ReportPage from "./ReportPage";
import ReportOMSectionHeader from "./ReportOMSectionHeader";
import BuildingGroupBadge from "./BuildingGroupBadge";
import OMEditable from "./OMEditable";
import { PAGE_CONTENT_MM } from "./reportPageConstants";

/** 참고용 안내 기본 문구 (인라인 편집 가능) */
const LOSS_LOGIC_NOTE =
  "본 수치는 저장 자료 기반 자동 산출 추정치로, 레이더 원시 로그·정비 기록과 차이가 있을 수 있어 참고용으로만 활용 바람.";

interface Props {
  sectionNum: number;
  radarResults: RadarMonthlyResult[];
  selectedBuildings: ManualBuilding[];
  /** 건물 그룹 메타 (인라인 배지 표시용) */
  buildingGroups: BuildingGroup[];
  radarSites: RadarSite[];
  /** 건물별 × 레이더별 LoS 결과 (key: `${radarName}_${buildingId}`) — 차단여부·음영소실 열용 */
  losMap: Map<string, LoSProfileData>;
  /** 레이더별 분석대상 포함/제외 파노라마 — 음영소실 분류를 AzElev 차트와 동일 소스(빨강영역)로 산출 */
  panoWithByRadar?: Map<string, PanoramaMergeResult>;
  panoWithoutByRadar?: Map<string, PanoramaMergeResult>;
  /** 건물별 추가 차단영역 소실율 (key: `${radarName}_${buildingId}`) — 헤드라인 심각도 */
  addedBlockageByKey?: Record<string, AddedBlockageResult>;
}

/**
 * 분석 요약 페이지 (페이지 1).
 *
 * 페이지 구성 순서(data-order="table-first"):
 *   1) 분석 대상 장애물 표 (.om-table)
 *   2) 참고 안내 박스 (.meta-merged)
 *   3) 레이더별 KPI 행 리스트 (.kpi-list, data-kpi="list")
 *
 * 건물이 많으면 첫 페이지에 KPI/참고 안내를 두고 잔여 건물 표는 후속 페이지로
 * 분할. 페이지 inner padding 16/18mm + 새 KPI 행 리스트 높이를 반영한 추정치.
 */
const HEADER_HEIGHT_MM = 14;
const BLOCK_H3_MM = 8;        // "분석 대상 장애물" 제목 블록 (.block-h3, 15px + 하단여백 8px)
const TABLE_HEADER_MM = 16;   // 2단 헤더 (레이더 그룹 + 방위/거리·LoS 영향·추가소실율)
const ROW_HEIGHT_MM = 7;
const META_MERGED_MM = 14;   // 참고 안내 1행 (.meta-merged, 단문 1줄)
const KPI_BLOCK_MM = 60;     // om-h3(~8mm) + 5행 × ~9.5mm + 블록 하단여백 12px ≈ 60mm

function ReportOMSummarySection({
  sectionNum,
  radarResults,
  selectedBuildings,
  buildingGroups,
  radarSites,
  losMap,
  panoWithByRadar,
  panoWithoutByRadar,
  addedBlockageByKey,
}: Props) {
  // 레이더별 소실표적 (음영소실 분류용) — daily_stats 의 loss_points_summary 집계
  const lossPointsByRadar = useMemo(() => {
    const m = new Map<string, LossPointGeo[]>();
    for (const rr of radarResults) {
      const all: LossPointGeo[] = [];
      for (const ds of rr.daily_stats) {
        for (const lp of ds.loss_points_summary) all.push(lp);
      }
      m.set(rr.radar_name, all);
    }
    return m;
  }, [radarResults]);

  // radar 좌표 시그니처 — radarSites 객체가 in-place 변경(참조 유지)돼도 재계산 트리거.
  //   Detail.siblings 가 [radarSite.latitude, radarSite.longitude, radarSite.name] 에 의존 → 동일 민감도로 동기화(sibling 오귀속 일치).
  const radarGeoKey = radarSites.map((r) => `${r.latitude},${r.longitude},${r.name}`).join(";");

  // 건물×레이더: 음영소실(장애물 추가 기인) 이벤트 건수(distinct event_id) + 추가 차단 여부 —
  //   AzElevChart·§3 요약표와 동일 분류(classifyObstacleLosses). '…건' 표시는 스키마 계약대로 이벤트 단위
  //   (같은 gap 의 보간점을 점 개수로 세면 과대 — buildingEventCount 사용).
  //   hasBldgEffect = 대상 차단각(with) > 지형·기존지물 차단각(without)+0.005° → 섹션3(AzElevChart)·LoS 단면도와 동일 조건.
  //   추가 차단 양각이 없으면(지형 이하) 'LoS 영향' 열을 O(영향)가 아닌 X(무영향)로 표기(섹션2,3 통일).
  const obstacleInfoByKey = useMemo(() => {
    const m = new Map<string, { shadowLoss: number; hasBldgEffect: boolean }>();
    for (const r of radarSites) {
      for (const b of selectedBuildings) {
        if (!losMap.has(`${r.name}_${b.id}`)) continue;
        // sibling — buildSiblings 단일 산식(§3 상세·§4 소실상세와 동일). LoS 결과 없는(=classify 미실행)
        //   건물은 제외해, 집계 못 할 건물이 소실표적 소유권만 가져가 누락시키는 것 방지.
        const siblings = buildSiblings(r, selectedBuildings, b.id, losMap);
        const { buildingEventCount, angleTotalDeg, angleTerrainDeg } = classifyObstacleLosses(r, b, lossPointsByRadar.get(r.name) ?? [], {
          panoWith: panoWithByRadar?.get(r.name),
          panoWithout: panoWithoutByRadar?.get(r.name),
          siblings,
        });
        // 추가 차단 양각 존재 여부 (AzElevChart hasBldgEffect 와 동일 임계 0.005°)
        const hasBldgEffect = angleTotalDeg > angleTerrainDeg + 0.005;
        m.set(`${r.name}_${b.id}`, { shadowLoss: buildingEventCount, hasBldgEffect });
      }
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- radarGeoKey 는 radarSites 가 참조 유지된 채 좌표만 in-place 변경돼도 재계산시키기 위함(rule 이 루프 내 r.latitude/longitude 접근을 추적 못해 'unnecessary' 로 오판). Detail.siblings 와 동기화 보장.
  }, [selectedBuildings, radarSites, radarGeoKey, losMap, lossPointsByRadar, panoWithByRadar, panoWithoutByRadar]);

  // 첫 페이지에 들어갈 수 있는 건물 행 수 계산
  const fixedContentMm = HEADER_HEIGHT_MM + BLOCK_H3_MM + TABLE_HEADER_MM + META_MERGED_MM
    + radarResults.length * KPI_BLOCK_MM;
  const availForRows = PAGE_CONTENT_MM - fixedContentMm;
  const maxRowsFirstPage = Math.max(3, Math.floor(availForRows / ROW_HEIGHT_MM));
  // 후속 페이지에 들어갈 수 있는 행 수 (섹션 헤더 + 테이블 헤더만)
  const maxRowsNextPage = Math.floor((PAGE_CONTENT_MM - HEADER_HEIGHT_MM - TABLE_HEADER_MM) / ROW_HEIGHT_MM);

  const totalBuildings = selectedBuildings.length;
  const needsSplit = totalBuildings > maxRowsFirstPage;

  // ── 분석 대상 장애물 표 (2단 헤더: 레이더 그룹 × 방위/거리·LoS·추가소실율) ──────────
  const renderBuildingTable = (buildings: ManualBuilding[], startIdx: number) => (
    <table className="om-table">
      <thead>
        <tr>
          <th className="w-5">#</th>
          <th className="ta-l">건물명</th>
          <th className="ta-r">높이(m)</th>
          {radarSites.map((r) => (
            <th key={r.name} colSpan={3} className="ta-c">{r.name}</th>
          ))}
        </tr>
        <tr className="sub">
          <th />
          <th />
          <th />
          {radarSites.map((r) => (
            <React.Fragment key={`sh-${r.name}`}>
              <th className="ta-c sm">방위/거리</th>
              <th className="ta-c sm">LoS 영향</th>
              <th className="ta-c sm">추가소실율</th>
            </React.Fragment>
          ))}
        </tr>
      </thead>
      <tbody>
        {buildings.map((b, i) => {
          const idx = startIdx + i;
          return (
            <tr key={b.id} className={idx % 2 === 0 ? "" : "alt"}>
              <td className="ta-c">{idx + 1}</td>
              <td>
                <BuildingGroupBadge groupId={b.group_id} groups={buildingGroups} placement="before" />
                {b.name || `건물 ${b.id}`}
              </td>
              <td className="ta-r mono">{b.height.toFixed(0)}</td>
              {radarSites.map((r) => {
                const az = bearingDeg(r.latitude, r.longitude, b.latitude, b.longitude);
                const dist = haversineKm(r.latitude, r.longitude, b.latitude, b.longitude);
                const los = losMap.get(`${r.name}_${b.id}`);
                const info = obstacleInfoByKey.get(`${r.name}_${b.id}`);
                const shadowLoss = info?.shadowLoss ?? 0;
                // LoS 영향 O = 대상 건물이 기존 지형지물 대비 추가 차단 양각을 만드는 경우만(섹션2,3 동일 조건).
                //   추가 차단각이 없으면(지형 이하) 직선 LoS 가 지형에 막혀도 X(무영향)로 표기.
                const blocked = info?.hasBldgEffect ?? false;
                const blockage = addedBlockageByKey?.[`${r.name}_${b.id}`];
                return (
                  <React.Fragment key={`cell-${r.name}-${b.id}`}>
                    <td className="ta-c mono sm">{az.toFixed(1)}° / {dist.toFixed(1)}km</td>
                    <td className="ta-c sm">
                      {los ? (
                        <span className={`badge ${blocked ? "bad" : "ok"}`}>
                          {blocked ? "O" : "X"}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="ta-c mono sm">
                      {!los ? (
                        <span className="muted">—</span>
                      ) : blockage ? (
                        // 추가 차단 구간 미형성(BLOCKAGE_NONE_LABEL)은 라벨 대신 0.00%로 표시 — 비율 정의상 추가 소실 없음.
                        blockage.grade.label === "항적 없음" || blockage.grade.label === "판정 보류"
                          ? <span className="muted">{blockage.grade.label}</span>
                          : <span style={{ color: blockage.grade.color, fontWeight: 600 }} title={`음영소실 ${shadowLoss}건`}>
                              {blockage.lossRatePct.toFixed(2)}%
                            </span>
                      ) : (
                        // 파노라마/히스토그램 미가용(리로드 등) → 음영소실 건수 폴백
                        shadowLoss > 0
                          ? <span style={{ color: "#a60739", fontWeight: 600 }}>{shadowLoss}건</span>
                          : <span className="muted">—</span>
                      )}
                    </td>
                  </React.Fragment>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  // ── 참고 안내 (.meta-merged) ──────────────────────────────────────────
  const renderMetaMerged = () => (
    <div className="meta-merged">
      <div className="meta-merged-row formula">
        <OMEditable id="summary.lossLogicNote" value={LOSS_LOGIC_NOTE} tag="div" />
      </div>
    </div>
  );

  // ── 레이더별 KPI 행 리스트 ─────────────────────────────────────────────
  const renderKPIBlocks = () => radarResults.map((rr) => {
    const days = rr.daily_stats.length;
    const avgPsr = weightedPsrAvg(rr.daily_stats) * 100;
    const psrSigma = weightedPsrStdDev(rr.daily_stats) * 100;
    const avgLoss = weightedLossAvg(rr.daily_stats);
    const lossSigma = weightedLossStdDev(rr.daily_stats);
    const totalPts = rr.total_points_filtered;
    const grade = gradeWithConfidence(avgLoss, days);
    // 종합 판정 행에 등급 색을 인라인 CSS 변수로 주입 → .kpi.grade 에서 사용
    const gradeVars = { "--grade-bg": grade.bg, "--grade-color": grade.color } as React.CSSProperties;

    return (
      <div key={rr.radar_name} className="kpi-block">
        <h3 className="om-h3">{rr.radar_name}</h3>
        <div className="kpi-list">
          <div className="kpi grade" style={gradeVars}>
            <p className="kpi-label">종합 판정</p>
            <p className="kpi-val">{grade.label}</p>
            <p className="kpi-sigma" />
          </div>
          <div className="kpi">
            <p className="kpi-label">분석일수</p>
            <p className="kpi-val">{days}일</p>
            <p className="kpi-sigma" />
          </div>
          <div className="kpi">
            <p className="kpi-label">분석 포인트</p>
            <p className="kpi-val">{totalPts.toLocaleString()}</p>
            <p className="kpi-sigma" />
          </div>
          <div className="kpi">
            <p className="kpi-label">평균 PSR율</p>
            <p className="kpi-val" style={{ color: "var(--om-accent)" }}>{avgPsr.toFixed(2)}%</p>
            <p className="kpi-sigma">±{psrSigma.toFixed(2)}%p</p>
          </div>
          <div className="kpi">
            <p className="kpi-label">평균 표적소실율</p>
            <p className="kpi-val" style={{ color: "#a60739" }}>{avgLoss.toFixed(3)}%</p>
            <p className="kpi-sigma">±{lossSigma.toFixed(3)}%p</p>
          </div>
        </div>
        {rr.failed_files.length > 0 && (
          <p className="mt-1 text-[11px]" style={{ color: "#dc2626" }}>
            파싱 실패: {rr.failed_files.length}건 ({rr.failed_files.map((f) => f.split(/[/\\]/).pop()).join(", ")})
          </p>
        )}
      </div>
    );
  });

  // ── 분할 불필요: 한 페이지 ──
  if (!needsSplit) {
    return (
      <ReportPage>
        <ReportOMSectionHeader
          sectionNum={sectionNum}
          title="분석 요약"
          editId="summary.title"
        />
        <OMEditable id="summary.bldgHeader" value="분석 대상 장애물" tag="div" className="block-h3" style={{ marginTop: 0 }} />
        {renderBuildingTable(selectedBuildings, 0)}
        {renderMetaMerged()}
        {renderKPIBlocks()}
      </ReportPage>
    );
  }

  // ── 분할 필요: 첫 페이지 + 후속 페이지(잔여 건물 표) ──
  const pages: React.ReactNode[] = [];
  const firstSlice = selectedBuildings.slice(0, maxRowsFirstPage);
  pages.push(
    <ReportPage key="summary-0">
      <ReportOMSectionHeader
        sectionNum={sectionNum}
        title="분석 요약"
        editId="summary.title"
      />
      <div className="block-h3" style={{ marginTop: 0 }}>
        <OMEditable id="summary.bldgHeader" value="분석 대상 장애물" tag="span" />
        {" "}({totalBuildings}건 중 1–{maxRowsFirstPage})
      </div>
      {renderBuildingTable(firstSlice, 0)}
      {renderMetaMerged()}
      {renderKPIBlocks()}
    </ReportPage>,
  );

  let offset = maxRowsFirstPage;
  let pageIdx = 1;
  while (offset < totalBuildings) {
    const slice = selectedBuildings.slice(offset, offset + maxRowsNextPage);
    pages.push(
      <ReportPage key={`summary-${pageIdx}`}>
        <ReportOMSectionHeader
          sectionNum={sectionNum}
          title={`분석 요약 (계속) — 장애물 ${offset + 1}–${Math.min(offset + maxRowsNextPage, totalBuildings)}/${totalBuildings}`}
        />
        {renderBuildingTable(slice, offset)}
      </ReportPage>,
    );
    offset += maxRowsNextPage;
    pageIdx++;
  }

  return <>{pages}</>;
}

export default React.memo(ReportOMSummarySection);
