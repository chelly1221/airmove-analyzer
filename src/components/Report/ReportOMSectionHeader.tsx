interface Props {
  sectionNum: number;
  title: string;
  /** 레이더명 서브타이틀 (h2 아래 h3 으로 표시) */
  radarName?: string;
}

/**
 * OM 보고서 섹션 공통 헤더.
 *
 * `band` 변형 — 좌측 6px 코발트 색띠 + 회색(#f3f4f6) 박스. 스타일은
 * reportOmStyles.css 의 `.kac-report .om-h2` 가 담당.
 */
function ReportOMSectionHeader({ sectionNum, title, radarName }: Props) {
  return (
    <>
      <h2 className="om-h2">
        <span className="sec-num">{sectionNum}.</span>
        <span className="sec-title">{title}</span>
      </h2>
      {radarName && <h3 className="om-h3">{radarName}</h3>}
    </>
  );
}

export default ReportOMSectionHeader;
