import OMEditable from "./OMEditable";

interface Props {
  sectionNum: number;
  title: string;
  /** 레이더명 서브타이틀 (h2 아래 h3 으로 표시) */
  radarName?: string;
  /** 인라인 편집키 — 있으면 제목을 직접 편집 가능 */
  editId?: string;
}

/**
 * OM 보고서 섹션 공통 헤더.
 *
 * `band` 변형 — 좌측 6px 코발트 색띠 + 회색(#f3f4f6) 박스. 스타일은
 * reportOmStyles.css 의 `.kac-report .om-h2` 가 담당.
 */
function ReportOMSectionHeader({ sectionNum, title, radarName, editId }: Props) {
  return (
    <>
      <h2 className="om-h2">
        <span className="sec-num">{sectionNum}.</span>
        {editId
          ? <OMEditable id={editId} value={title} tag="span" className="sec-title" />
          : <span className="sec-title">{title}</span>}
      </h2>
      {radarName && <h3 className="om-h3">{radarName}</h3>}
    </>
  );
}

export default ReportOMSectionHeader;
