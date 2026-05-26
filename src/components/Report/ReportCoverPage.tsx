import { forwardRef, useMemo } from "react";
import { format } from "date-fns";
import EditableText from "./EditableText";
import ReportPage from "./ReportPage";
import type { ReportMetadata } from "../../types";

interface CoverPageProps {
  template: "weekly" | "monthly" | "flights" | "single" | "obstacle" | "obstacle_monthly";
  radarName: string;
  metadata: ReportMetadata;
  editable: boolean;
  title: string;
  onTitleChange: (v: string) => void;
  subtitle: string;
  onSubtitleChange: (v: string) => void;
  /** OM(장애물 월간) 전용 — 분석 월 라벨 ("2026년 4월"). 있으면 정보 테이블/eyebrow 에 사용. */
  omMonthLabel?: string;
  /** OM 전용 — 대상 레이더 다중 표기 (없으면 radarName 사용). */
  omRadarNames?: string[];
  /** OM 전용 — 대상 장애물 건수 (있을 때만 행 표시). */
  omBuildingsCount?: number;
}

/** 보고서 표지 — KAC CoverD 디자인 (상단 컬러 블록 + 하단 정보 테이블).
 *
 *  사용자 결정으로 모든 템플릿이 동일 디자인을 공유. 템플릿별로 eyebrow
 *  텍스트만 다르며, OM(장애물 월간) 만 분석 월/대상 장애물 행을 추가로
 *  표시한다. 스타일은 reportOmStyles.css `.kac-report .cover-d-*`.
 */
const templateCodeMap: Record<CoverPageProps["template"], string> = {
  weekly: "WK",
  monthly: "MO",
  flights: "FL",
  single: "SG",
  obstacle: "OB",
  obstacle_monthly: "OM",
};

const ReportCoverPage = forwardRef<HTMLDivElement, CoverPageProps>(function ReportCoverPage(
  {
    template, radarName, metadata, editable,
    title, onTitleChange, subtitle, onSubtitleChange,
    omMonthLabel, omRadarNames, omBuildingsCount,
  },
  ref,
) {
  // 최초 마운트 시 고정 — 렌더마다 문서번호 변경 방지
  const now = useMemo(() => new Date(), []);
  const tplCode = templateCodeMap[template] ?? "RPT";
  const docNum = `${metadata.docPrefix}-${tplCode}-${format(now, "yyMMdd")}-${format(now, "HHmm")}`;
  const issueDate = format(now, "yyyy년 MM월 dd일");

  // Eyebrow — 템플릿별 라벨
  const yearOnly = omMonthLabel?.slice(0, 4) ?? format(now, "yyyy");
  const eyebrowByTemplate: Record<CoverPageProps["template"], string> = {
    obstacle_monthly: `${yearOnly} 월간 보고서`,
    monthly: `${yearOnly} 월간 보고서`,
    weekly: `${yearOnly} 주간 보고서`,
    flights: "비행 분석 보고서",
    single: "단일 비행 분석 보고서",
    obstacle: "장애물 사전검토 보고서",
  };
  const eyebrow = eyebrowByTemplate[template];

  // 정보 테이블 값
  const isOM = template === "obstacle_monthly";
  const radarLabel = omRadarNames && omRadarNames.length > 0 ? omRadarNames.join(" · ") : (radarName || "—");
  const periodLabel = omMonthLabel ? `${omMonthLabel} (1일 ~ 말일)` : (subtitle || "—");
  // 발행처: "한국공항공사" → "한 국 공 항 공 사" 패턴 (시안의 letter-spacing 강조)
  const issuerName = useMemo(() => metadata.organization.split("").join(" "), [metadata.organization]);
  const orgEnSuffix = metadata.organization === "한국공항공사" ? "  ·  KOREA AIRPORTS CORPORATION" : "";

  return (
    <ReportPage ref={ref} isCover>
      <div className="cover-d">
        <div className="cover-d-block">
          <div className="cover-d-block-deco" />
          <div className="cover-d-mark">
            <span className="cover-d-mark-square">KAC</span>
            <span className="cover-d-mark-text">{metadata.organization}{orgEnSuffix}</span>
          </div>
          {eyebrow && <div className="cover-d-eyebrow">{eyebrow}</div>}

          {isOM ? (
            // OM 시안은 두 줄 표시("레이더 장애물 / 월간 분석 보고서") — 편집 비활성화.
            <h1 className="cover-d-title">레이더 장애물<br />월간 분석 보고서</h1>
          ) : (
            <EditableText
              value={title}
              onChange={onTitleChange}
              editable={editable}
              tag="h1"
              className="cover-d-title"
            />
          )}

          {isOM ? (
            <p className="cover-d-subtitle">{omMonthLabel}</p>
          ) : (
            <EditableText
              value={subtitle}
              onChange={onSubtitleChange}
              editable={editable}
              tag="p"
              className="cover-d-subtitle"
            />
          )}
        </div>

        <div className="cover-d-info">
          <table className="cover-d-info-table">
            <tbody>
              <tr><th>문서번호</th><td>{docNum}</td></tr>
              <tr><th>작성일자</th><td>{issueDate}</td></tr>
              <tr><th>발행기관</th><td>{metadata.organization}{metadata.department ? ` · ${metadata.department}` : ""}{metadata.siteName ? ` · ${metadata.siteName}` : ""}</td></tr>
              <tr><th>대상 레이더</th><td>{radarLabel}</td></tr>
              <tr><th>분석 기간</th><td>{periodLabel}</td></tr>
              {isOM && omBuildingsCount != null && (
                <tr><th>대상 장애물</th><td>{omBuildingsCount}건</td></tr>
              )}
            </tbody>
          </table>

          <div className="cover-d-issuer">
            <div className="cover-d-issuer-name">{issuerName}</div>
            <div className="cover-d-issuer-sub">{metadata.footer || "본 보고서는 NEC ASTERIX 비행검사기 항적분석체계로 자동 생성됨"}</div>
          </div>
        </div>
      </div>
    </ReportPage>
  );
});

export default ReportCoverPage;
