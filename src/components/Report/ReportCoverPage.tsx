import { format } from "date-fns";
import EditableText from "./EditableText";
import ReportPage from "./ReportPage";
import { forwardRef } from "react";
import type { ReportMetadata } from "../../types";

interface CoverPageProps {
  template: "weekly" | "monthly" | "flights" | "single" | "obstacle";
  radarName: string;
  metadata: ReportMetadata;
  editable: boolean;
  title: string;
  onTitleChange: (v: string) => void;
  subtitle: string;
  onSubtitleChange: (v: string) => void;
}

const ReportCoverPage = forwardRef<HTMLDivElement, CoverPageProps>(
  ({ template: _template, radarName, metadata, editable, title, onTitleChange, subtitle, onSubtitleChange }, ref) => {
    const now = new Date();
    const docNum = `${metadata.docPrefix}-${format(now, "yyyy")}-${String(now.getMonth() + 1).padStart(3, "0")}`;

    return (
      <ReportPage ref={ref}>
        {/* 상단 구분선 */}
        <div className="border-t-[3px] border-black" />

        {/* 문서 헤더 */}
        <div className="mt-3 flex justify-between text-[11px] text-gray-500">
          <span>{metadata.department}</span>
          <span>문서번호: {docNum}</span>
        </div>
        <div className="mt-1 flex justify-between text-[11px] text-gray-500">
          <span>시행일자: {format(now, "yyyy년 MM월 dd일")}</span>
          <span>레이더: {radarName}</span>
        </div>

        <div className="mt-2 border-t border-gray-400" />

        {/* 중앙 제목 영역 */}
        <div className="flex flex-col items-center justify-center" style={{ marginTop: "80mm" }}>
          <div className="mb-6 text-[13px] tracking-[0.3em] text-gray-400">
            {metadata.organization}
          </div>

          <EditableText
            value={title}
            onChange={onTitleChange}
            editable={editable}
            tag="h1"
            className="text-center text-[28px] font-bold text-gray-900"
          />

          <div className="mt-6 h-[2px] w-24 bg-[#a60739]" />

          <EditableText
            value={subtitle}
            onChange={onSubtitleChange}
            editable={editable}
            tag="p"
            className="mt-6 text-center text-[14px] text-gray-500"
          />

          <div className="mt-12 text-[13px] text-gray-400">
            {format(now, "yyyy년 MM월 dd일")}
          </div>
          {metadata.author && (
            <div className="mt-2 text-[12px] text-gray-400">
              작성: {metadata.author}
            </div>
          )}
        </div>

        {/* 하단 */}
        <div className="absolute bottom-[20mm] left-[20mm] right-[20mm]">
          <div className="border-t-[2px] border-gray-300" />
          <p className="mt-2 text-center text-[9px] text-gray-400">
            {metadata.footer}
          </p>
        </div>
      </ReportPage>
    );
  }
);

ReportCoverPage.displayName = "ReportCoverPage";
export default ReportCoverPage;
