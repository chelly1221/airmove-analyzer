import React, { useMemo } from "react";
import type { RadarMonthlyResult, ManualBuilding, BuildingGroup, RadarSite, AzSector, LoSProfileData, LossPointGeo, PanoramaMergeResult } from "../../types";
import type { AddedBlockageResult } from "../../types/obstacle";
import {
  weightedLossAvg, weightedLossStdDev,
  weightedPsrAvg, weightedPsrStdDev,
  gradeWithConfidence,
} from "../../utils/omStats";
import { haversineKm, bearingDeg } from "../../utils/geo";
import { classifyObstacleLosses } from "../../utils/obstacleAnalysisHelpers";
import ReportPage from "./ReportPage";
import ReportOMSectionHeader from "./ReportOMSectionHeader";
import BuildingGroupBadge from "./BuildingGroupBadge";
import OMEditable from "./OMEditable";
import { PAGE_CONTENT_MM } from "./reportPageConstants";

/** 표적소실 산출 로직 + 참고용 안내 기본 문구 (인라인 편집 가능) */
const LOSS_LOGIC_NOTE =
  "표적소실율 = (신호소실 누적 시간 ÷ 전체 추적 시간) × 100. 스캔 주기를 자동 추정(중앙값)한 뒤 "
  + "임계값(주기 × 1.4) 초과 ~ 5분(300초) 이하의 미탐지 구간을 표적소실 후보로 보되, 범위이탈(out-of-range)과 "
  + "속도 이상치·트랙 스왑/그룹핑 오류로 추정되는 구간은 오탐으로 제외하고 신호소실(signal loss)만 집계함. "
  + "본 수치는 저장 자료(ASTERIX) 기반으로 자동 산출된 추정치로, 레이더 원시 로그·정비 기록과 차이가 있을 수 있으므로 참고 자료로만 활용 바람.";

interface Props {
  sectionNum: number;
  radarResults: RadarMonthlyResult[];
  selectedBuildings: ManualBuilding[];
  /** 건물 그룹 메타 (인라인 배지 표시용) */
  buildingGroups: BuildingGroup[];
  radarSites: RadarSite[];
  /** 레이더별 방위 구간 (레이더 이름 → AzSector[]) */
  azimuthSectorsByRadar: Map<string, AzSector[]>;
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
 *   2) 방위·산식 통합 박스 (.meta-merged)
 *   3) 레이더별 KPI 행 리스트 (.kpi-list, data-kpi="list")
 *
 * 건물이 많으면 첫 페이지에 KPI/방위/산식을 두고 잔여 건물 표는 후속 페이지로
 * 분할. 페이지 inner padding 16/18mm + 새 KPI 행 리스트 높이를 반영한 추정치.
 */
const HEADER_HEIGHT_MM = 14;
const BLOCK_H3_MM = 8;        // "분석 대상 장애물" 제목 블록 (.block-h3, 15px + 하단여백 8px)
const TABLE_HEADER_MM = 16;   // 2단 헤더 (레이더 그룹 + 방위/거리·LoS·추가소실율)
const ROW_HEIGHT_MM = 7;
const META_MERGED_MM = 80;   // 방위 + 통계산식 + 표적소실 산출노트 3행 (.meta-merged, 장문 텍스트 다중 줄)
const KPI_BLOCK_MM = 60;     // om-h3(~8mm) + 5행 × ~9.5mm + 블록 하단여백 12px ≈ 60mm

function ReportOMSummarySection({
  sectionNum,
  radarResults,
  selectedBuildings,
  buildingGroups,
  radarSites,
  azimuthSectorsByRadar,
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
  //   Detail.siblings 가 [radarSite.latitude, radarSite.longitude] 에 의존 → 동일 민감도로 동기화(sibling 오귀속 일치).
  const radarGeoKey = radarSites.map((r) => `${r.latitude},${r.longitude},${r.name}`).join(";");

  // 건물×레이더 음영소실(장애물 추가 기인) 건수 — AzElevChart 와 동일 분류(classifyObstacleLosses)
  const shadowLossByKey = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of radarSites) {
      // 같은 레이더의 건물별 방위 (sibling 오귀속 방지용 — 가장 가까운 방위 건물에 귀속)
      const azByBldg = selectedBuildings.map((b) => ({
        id: b.id,
        azDeg: bearingDeg(r.latitude, r.longitude, b.latitude, b.longitude),
        distKm: haversineKm(r.latitude, r.longitude, b.latitude, b.longitude),
      }));
      for (const b of selectedBuildings) {
        const los = losMap.get(`${r.name}_${b.id}`);
        if (!los) continue;
        const siblings = azByBldg.filter((x) => x.id !== b.id).map((x) => ({ id: x.id, azDeg: x.azDeg, distKm: x.distKm }));
        const { buildingCount } = classifyObstacleLosses(r, b, los, lossPointsByRadar.get(r.name) ?? [], {
          panoWith: panoWithByRadar?.get(r.name),
          panoWithout: panoWithoutByRadar?.get(r.name),
          siblings,
        });
        m.set(`${r.name}_${b.id}`, buildingCount);
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
              <th className="ta-c sm">LoS</th>
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
                const shadowLoss = shadowLossByKey.get(`${r.name}_${b.id}`) ?? 0;
                const blockage = addedBlockageByKey?.[`${r.name}_${b.id}`];
                return (
                  <React.Fragment key={`cell-${r.name}-${b.id}`}>
                    <td className="ta-c mono sm">{az.toFixed(1)}° / {dist.toFixed(1)}km</td>
                    <td className="ta-c sm">
                      {los ? (
                        <span className={`badge ${los.losBlocked ? "bad" : "ok"}`}>
                          {los.losBlocked ? "차단" : "양호"}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="ta-c mono sm">
                      {!los ? (
                        <span className="muted">—</span>
                      ) : blockage ? (
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

  // ── 방위·산식 통합 박스 (.meta-merged) ────────────────────────────────
  const renderMetaMerged = () => (
    <div className="meta-merged">
      <div className="meta-merged-row az">
        <OMEditable id="summary.azLabel" value="분석 방위 구간" tag="p" className="meta-merged-label" />
        <div className="az-grid">
          {radarSites.map((r) => {
            const sectors = azimuthSectorsByRadar.get(r.name) ?? [];
            const sectorText = sectors.map((s) => `${s.start_deg.toFixed(1)}°~${s.end_deg.toFixed(1)}°`).join(", ") || "—";
            return (
              <div key={r.name}>
                <span className="muted">{r.name}:</span>{" "}
                <span className="mono strong">{sectorText}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="meta-merged-row formula">
        <OMEditable id="summary.formulaLabel" value="통계 산식" tag="p" className="meta-merged-label" />
        <div>
          <span className="strong">통계 산식 · </span>
          평균: 관측량 가중 평균 <i>x̄<sub>w</sub> = Σ(wᵢ·xᵢ) / Σ(wᵢ)</i>
          {" "}(Loss: w=비행시간, PSR: w=SSR포인트수){" · "}
          <i>±σ</i>: 가중 모표준편차 <i>σ<sub>w</sub> = √(Σ(wᵢ·(xᵢ - x̄<sub>w</sub>)²) / Σ(wᵢ))</i>{" · "}
          판정: 양호(&lt;0.5%) / 주의(0.5~2% 미만) / 경고(≥2%) / 보류(&lt;7일)
          {" · "}
          <span className="strong">추가소실율</span>: 분석 대상 장애물이 새로 가리는 추가 차단영역(지형·기존지물 차단각~대상 차단각 사이 양각 밴드)을 <i>지나는 항적이 그 안에서 소실되는 비율</i>. 차단영역 내 항적이 부족하면 "항적 없음", 관측 7일 미만 또는 항적 발생일 3일 미만 시 "판정 보류". (파노라마 미가용 시 음영소실 건수로 폴백)
        </div>
      </div>
      <div className="meta-merged-row formula" style={{ borderTop: "1px solid var(--om-border)" }}>
        <OMEditable id="summary.lossLogicLabel" value="표적소실 산출 · 참고" tag="p" className="meta-merged-label" />
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
