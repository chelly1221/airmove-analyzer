import { forwardRef, useMemo } from "react";
import { format } from "date-fns";
import OMEditable from "./OMEditable";
import ReportPage from "./ReportPage";
import type { ReportMetadata } from "../../types";

interface CoverPageProps {
  radarName: string;
  metadata: ReportMetadata;
  /** 분석 월 라벨 ("2026년 4월"). 있으면 정보 테이블/부제에 사용. */
  omMonthLabel?: string;
  /** 대상 레이더 다중 표기 (없으면 radarName 사용). */
  omRadarNames?: string[];
  /** 대상 장애물 건수 (있을 때만 행 표시). */
  omBuildingsCount?: number;
}

/** 보고서 표지 — KAC CoverD 디자인 (상단 컬러 블록 + 하단 정보 테이블).
 *
 *  OM(장애물 월간) 전용 — 보고서 템플릿 단일화(2026-06-08)로 다른 템플릿
 *  분기(EditableText 제목/부제)는 제거됨. 제목은 고정 2줄, 부제/분석 기간은
 *  OMEditable 인라인 편집. 스타일은 reportOmStyles.css `.kac-report .cover-d-*`.
 */
const ReportCoverPage = forwardRef<HTMLDivElement, CoverPageProps>(function ReportCoverPage(
  { radarName, metadata, omMonthLabel, omRadarNames, omBuildingsCount },
  ref,
) {
  // 최초 마운트 시 고정 — 렌더마다 작성일자 변경 방지
  const now = useMemo(() => new Date(), []);
  const issueDate = format(now, "yyyy년 MM월 dd일");

  // 정보 테이블 값 — OM(장애물 월간) 단일 템플릿
  const radarLabel = omRadarNames && omRadarNames.length > 0 ? omRadarNames.join(" · ") : (radarName || "—");
  // 분석 기간 — 월 라벨만 표시(예: "2026년 2월"). 일자 범위는 생략.
  const periodLabel = omMonthLabel || "—";
  const orgEnSuffix = metadata.organization === "한국공항공사" ? "  ·  KOREA AIRPORTS CORPORATION" : "";

  return (
    <ReportPage ref={ref} isCover>
      <div className="cover-d">
        <div className="cover-d-block">
          <div className="cover-d-block-deco" />
          <div className="cover-d-mark">
            <span className="cover-d-mark-square">KAC</span>
            <span className="cover-d-mark-text">
              <span className="cover-d-mark-org">{metadata.organization}{orgEnSuffix}</span>
              {metadata.department && <span className="cover-d-mark-dept">{metadata.department}</span>}
            </span>
          </div>
          {/* OM 표지는 머리말(eyebrow) 미표시 — 제목이 컬러 블록 하단에 정렬되도록 title 에 margin-top:auto */}
          {/* OM 시안은 두 줄 표시("레이더 장애물 / 월간 분석 보고서"). */}
          <h1 className="cover-d-title" style={{ marginTop: "auto" }}>레이더 장애물<br />월간 분석 보고서</h1>

          <OMEditable id="cover.subtitle" value={omMonthLabel ?? ""} tag="p" className="cover-d-subtitle" />
        </div>

        <div className="cover-d-info">
          <table className="cover-d-info-table">
            <tbody>
              <tr><th>작성일자</th><td>{issueDate}</td></tr>
              <tr><th>발행기관</th><td>{metadata.organization}{metadata.department ? ` · ${metadata.department}` : ""}{metadata.siteName ? ` · ${metadata.siteName}` : ""}</td></tr>
              <tr><th>대상 레이더</th><td>{radarLabel}</td></tr>
              <tr><th>분석 기간</th><td><OMEditable id="cover.period" value={periodLabel} tag="span" /></td></tr>
              {omBuildingsCount != null && (
                <tr><th>대상 장애물</th><td>{omBuildingsCount}건</td></tr>
              )}
            </tbody>
          </table>

          <div className="cover-d-issuer">
            <div className="cover-d-issuer-sub">{metadata.footer || "본 보고서는 NEC ASTERIX 비행검사기 항적분석체계로 자동 생성됨"}</div>
          </div>
        </div>
      </div>
    </ReportPage>
  );
});

export default ReportCoverPage;
