interface Props {
  sectionNum: number;
  title: string;
  /** 레이더명 서브타이틀 (h2 아래 h3으로 표시) */
  radarName?: string;
}

/** OM 보고서 섹션 공통 헤더 (h2 + 선택적 h3 서브타이틀) */
function ReportOMSectionHeader({ sectionNum, title, radarName }: Props) {
  return (
    <>
      <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[19px] font-bold text-gray-900">
        {sectionNum}. {title}
      </h2>
      {radarName && (
        <h3 className="mb-2 text-[15px] font-semibold text-gray-700">{radarName}</h3>
      )}
    </>
  );
}

export default ReportOMSectionHeader;
