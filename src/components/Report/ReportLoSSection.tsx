import type { LoSProfileData } from "../../types";
import ReportPage from "./ReportPage";
import { PAGE_CONTENT_MM, SECTION_HEADER_MM, TABLE_HEADER_MM, ROW_HEIGHT_MD } from "./reportPageConstants";

interface LoSSectionProps {
  sectionNum: number;
  losResults: LoSProfileData[];
}

function renderTableHeader() {
  return (
    <thead>
      <tr className="bg-[#28283c] text-white">
        <th className="border border-gray-300 px-2 py-1.5 text-center font-medium w-6">#</th>
        <th className="border border-gray-300 px-2 py-1.5 text-left font-medium">레이더</th>
        <th className="border border-gray-300 px-2 py-1.5 text-left font-medium">대상 좌표</th>
        <th className="border border-gray-300 px-2 py-1.5 text-right font-medium">거리(km)</th>
        <th className="border border-gray-300 px-2 py-1.5 text-right font-medium">방위(°)</th>
        <th className="border border-gray-300 px-2 py-1.5 text-center font-medium">결과</th>
        <th className="border border-gray-300 px-2 py-1.5 text-left font-medium">차단점</th>
      </tr>
    </thead>
  );
}

function renderRow(r: LoSProfileData, idx: number) {
  return (
    <tr key={idx} className={idx % 2 === 0 ? "bg-white" : "bg-gray-50"}>
      <td className="border border-gray-200 px-2 py-1.5 text-center">{idx + 1}</td>
      <td className="border border-gray-200 px-2 py-1.5">{r.radarSiteName}</td>
      <td className="border border-gray-200 px-2 py-1.5 font-mono text-[13px]">
        {r.targetLat.toFixed(4)}°N {r.targetLon.toFixed(4)}°E
      </td>
      <td className="border border-gray-200 px-2 py-1.5 text-right">{r.totalDistance.toFixed(1)}</td>
      <td className="border border-gray-200 px-2 py-1.5 text-right">{r.bearing.toFixed(0)}</td>
      <td className="border border-gray-200 px-2 py-1.5 text-center">
        <span className={`rounded px-1.5 py-0.5 text-[13px] font-medium ${
          r.losBlocked
            ? "bg-red-100 text-red-700"
            : "bg-green-100 text-green-700"
        }`}>
          {r.losBlocked ? "차단" : "양호"}
        </span>
      </td>
      <td className="border border-gray-200 px-2 py-1.5">
        {r.maxBlockingPoint
          ? `${r.maxBlockingPoint.name ? r.maxBlockingPoint.name + " " : ""}${r.maxBlockingPoint.elevation.toFixed(0)}m`
          : "-"}
      </td>
    </tr>
  );
}

export default function ReportLoSSection({ sectionNum, losResults }: LoSSectionProps) {
  if (losResults.length === 0) return null;

  // 첫 페이지: 헤더(12mm) + 테이블헤더(8mm) → 가용 높이
  const firstPageRows = Math.floor((PAGE_CONTENT_MM - SECTION_HEADER_MM - TABLE_HEADER_MM) / ROW_HEIGHT_MD);
  // 이후 페이지: 테이블헤더(8mm) → 가용 높이
  const nextPageRows = Math.floor((PAGE_CONTENT_MM - TABLE_HEADER_MM) / ROW_HEIGHT_MD);

  // 단일 페이지에 수용 가능
  if (losResults.length <= firstPageRows) {
    return (
      <ReportPage>
        <div className="mb-8">
          <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[19px] font-bold text-gray-900">
            {sectionNum}. LoS 분석 결과
          </h2>
          <table className="w-full border-collapse text-[14px]">
            {renderTableHeader()}
            <tbody>{losResults.map((r, i) => renderRow(r, i))}</tbody>
          </table>
        </div>
      </ReportPage>
    );
  }

  // 멀티페이지 분할
  const pages: React.ReactNode[] = [];
  let offset = 0;

  // 첫 페이지
  const firstChunk = losResults.slice(0, firstPageRows);
  pages.push(
    <ReportPage key="los-0">
      <div className="mb-8">
        <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[19px] font-bold text-gray-900">
          {sectionNum}. LoS 분석 결과
        </h2>
        <table className="w-full border-collapse text-[14px]">
          {renderTableHeader()}
          <tbody>{firstChunk.map((r, i) => renderRow(r, offset + i))}</tbody>
        </table>
      </div>
    </ReportPage>
  );
  offset += firstPageRows;

  // 이후 페이지
  while (offset < losResults.length) {
    const chunk = losResults.slice(offset, offset + nextPageRows);
    const pageIdx = pages.length;
    pages.push(
      <ReportPage key={`los-${pageIdx}`}>
        <div className="mb-2 text-[10px] text-gray-400">
          {sectionNum}. LoS 분석 결과 (계속 — {offset + 1}~{offset + chunk.length}/{losResults.length})
        </div>
        <table className="w-full border-collapse text-[14px]">
          {renderTableHeader()}
          <tbody>{chunk.map((r, i) => renderRow(r, offset + i))}</tbody>
        </table>
      </ReportPage>
    );
    offset += nextPageRows;
  }

  return <>{pages}</>;
}
