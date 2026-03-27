import { format } from "date-fns";
import type { Flight, RadarSite } from "../../types";
import { flightLabel } from "../../utils/flightConsolidation";
import { useAppStore } from "../../store";
import ReportPage from "./ReportPage";
import { PAGE_CONTENT_MM, SECTION_HEADER_MM, TABLE_HEADER_MM, ROW_HEIGHT_SM } from "./reportPageConstants";

interface Props {
  sectionNum: number;
  flights: Flight[];
  radarSite: RadarSite;
}

function getGrade(lossPercent: number): { label: string; color: string; bg: string } {
  if (lossPercent < 1) return { label: "양호", color: "text-green-700", bg: "bg-green-100 border-green-300" };
  if (lossPercent < 5) return { label: "주의", color: "text-yellow-700", bg: "bg-yellow-100 border-yellow-300" };
  return { label: "경고", color: "text-red-700", bg: "bg-red-100 border-red-300" };
}

// 첫 페이지 고정 콘텐츠 높이: 판정(10mm) + KPI(20mm) + 소제목(8mm) + 테이블헤더(8mm) = 46mm
const FIRST_PAGE_FIXED_MM = 46;
// 차트 + 레이더 정보 높이
const CHART_ROW_HEIGHT_MM = 8.5; // flights.length * 28 / 600 * 182mm ≈ 8.5mm/flight
const RADAR_INFO_MM = 12;

function renderTableHeader() {
  return (
    <thead>
      <tr className="bg-[#28283c] text-white">
        <th className="border border-gray-300 px-1.5 py-1.5 text-center font-medium w-6">#</th>
        <th className="border border-gray-300 px-1.5 py-1.5 text-left font-medium">비행</th>
        <th className="border border-gray-300 px-1.5 py-1.5 text-center font-medium">시간범위</th>
        <th className="border border-gray-300 px-1.5 py-1.5 text-right font-medium">포인트</th>
        <th className="border border-gray-300 px-1.5 py-1.5 text-right font-medium">추적(분)</th>
        <th className="border border-gray-300 px-1.5 py-1.5 text-right font-medium">소실 건수</th>
        <th className="border border-gray-300 px-1.5 py-1.5 text-right font-medium">소실(초)</th>
        <th className="border border-gray-300 px-1.5 py-1.5 text-right font-medium">소실율(%)</th>
        <th className="border border-gray-300 px-1.5 py-1.5 text-center font-medium">판정</th>
      </tr>
    </thead>
  );
}

/** 비행 건별 보고서: 선택 비행 비교 테이블 + 차트 */
export default function ReportFlightComparisonSection({ sectionNum, flights, radarSite }: Props) {
  const aircraft = useAppStore((s) => s.aircraft);

  if (flights.length === 0) return null;

  const totalLoss = flights.reduce((s, f) => s + f.loss_points.length, 0);
  const avgLossPercent = flights.reduce((s, f) => s + f.loss_percentage, 0) / flights.length;
  const totalTrackMin = flights.reduce((s, f) => s + f.total_track_time, 0) / 60;
  const totalLossTime = flights.reduce((s, f) => s + f.total_loss_time, 0);
  const grade = getGrade(avgLossPercent);
  let maxLossPercent = 1;
  for (const f of flights) if (f.loss_percentage > maxLossPercent) maxLossPercent = f.loss_percentage;

  const chartHeightMM = flights.length > 1 ? flights.length * CHART_ROW_HEIGHT_MM + 10 : 0;

  // 첫 페이지 가용 행 수
  const firstPageAvailMM = PAGE_CONTENT_MM - SECTION_HEADER_MM - FIRST_PAGE_FIXED_MM;
  const firstPageRows = Math.floor(firstPageAvailMM / ROW_HEIGHT_SM);
  const nextPageRows = Math.floor((PAGE_CONTENT_MM - TABLE_HEADER_MM) / ROW_HEIGHT_SM);

  // 단일 페이지 체크: 테이블 + 차트 + 레이더 정보
  const tableHeightMM = flights.length * ROW_HEIGHT_SM;
  const totalContentMM = FIRST_PAGE_FIXED_MM + tableHeightMM + chartHeightMM + RADAR_INFO_MM;
  const singlePage = totalContentMM <= PAGE_CONTENT_MM - SECTION_HEADER_MM;

  // 공통 헤더 + KPI
  const headerAndKPI = (
    <>
      <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[15px] font-bold text-gray-900">
        {sectionNum}. 비행 비교 분석
      </h2>
      <div className="mb-4 flex items-center gap-3">
        <span className="text-[12px] text-gray-600">종합 판정:</span>
        <span className={`rounded-md border px-3 py-1 text-[13px] font-bold ${grade.bg} ${grade.color}`}>
          {grade.label}
        </span>
        <span className="text-[11px] text-gray-400">
          선택 {flights.length}건 · 평균 소실율 {avgLossPercent.toFixed(1)}%
        </span>
      </div>
      <div className="mb-5 grid grid-cols-5 gap-2">
        {[
          { label: "선택 비행", value: `${flights.length}건` },
          { label: "총 소실 건수", value: `${totalLoss}건`, accent: true },
          { label: "평균 소실율", value: `${avgLossPercent.toFixed(1)}%`, accent: true },
          { label: "총 추적시간", value: `${totalTrackMin.toFixed(1)}분` },
          { label: "총 소실시간", value: `${totalLossTime.toFixed(1)}초` },
        ].map((kpi) => (
          <div key={kpi.label} className="rounded border border-gray-200 bg-gray-50 px-2 py-1.5 text-center">
            <div className="text-[9px] text-gray-400">{kpi.label}</div>
            <div className={`text-[14px] font-bold ${kpi.accent ? "text-[#a60739]" : "text-gray-800"}`}>
              {kpi.value}
            </div>
          </div>
        ))}
      </div>
    </>
  );

  const renderRow = (f: Flight, idx: number) => {
    const label = flightLabel(f, aircraft);
    const g = getGrade(f.loss_percentage);
    return (
      <tr key={f.id} className={idx % 2 === 0 ? "bg-white" : "bg-gray-50"}>
        <td className="border border-gray-200 px-1.5 py-1 text-center">{idx + 1}</td>
        <td className="border border-gray-200 px-1.5 py-1">{label}</td>
        <td className="border border-gray-200 px-1.5 py-1 text-center text-[9px]">
          {format(new Date(f.start_time * 1000), "MM-dd HH:mm")}~{format(new Date(f.end_time * 1000), "HH:mm")}
        </td>
        <td className="border border-gray-200 px-1.5 py-1 text-right">{f.point_count.toLocaleString()}</td>
        <td className="border border-gray-200 px-1.5 py-1 text-right">{(f.total_track_time / 60).toFixed(1)}</td>
        <td className="border border-gray-200 px-1.5 py-1 text-right">{f.loss_points.length}</td>
        <td className="border border-gray-200 px-1.5 py-1 text-right">{f.total_loss_time.toFixed(1)}</td>
        <td className="border border-gray-200 px-1.5 py-1 text-right font-medium">{f.loss_percentage.toFixed(1)}</td>
        <td className="border border-gray-200 px-1.5 py-1 text-center">
          <span className={`rounded px-1.5 py-0.5 text-[9px] font-medium border ${g.bg} ${g.color}`}>
            {g.label}
          </span>
        </td>
      </tr>
    );
  };

  // 차트 + 레이더 정보
  const chartAndRadar = (
    <>
      {flights.length > 1 && (
        <div>
          <h3 className="mb-2 text-[12px] font-semibold text-gray-700">소실율 비교</h3>
          <svg width="100%" viewBox={`0 0 600 ${flights.length * 28 + 10}`} className="overflow-visible">
            {flights.map((f, i) => {
              const barW = (f.loss_percentage / maxLossPercent) * 380;
              const y = i * 28 + 5;
              const label = flightLabel(f, aircraft);
              const name = label.length > 25 ? label.slice(0, 23) + "…" : label;
              return (
                <g key={f.id}>
                  <text x={165} y={y + 14} textAnchor="end" fontSize={10} fill="#666">
                    {name}
                  </text>
                  <rect x={175} y={y + 2} width={Math.max(barW, 2)} height={16} rx={2} fill="#a60739" opacity={0.8} />
                  <text x={180 + barW} y={y + 14} fontSize={10} fill="#333" fontWeight="600">
                    {f.loss_percentage.toFixed(1)}%
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}
      <div className="mt-4 rounded border border-gray-200 bg-gray-50 p-2.5 text-[10px] text-gray-500">
        레이더: {radarSite.name} ({radarSite.latitude.toFixed(4)}°N, {radarSite.longitude.toFixed(4)}°E) · 지원범위 {radarSite.range_nm}NM
      </div>
    </>
  );

  // 단일 페이지
  if (singlePage) {
    return (
      <ReportPage>
        <div className="mb-8">
          {headerAndKPI}
          <h3 className="mb-2 text-[12px] font-semibold text-gray-700">비행별 상세</h3>
          <table className="mb-4 w-full border-collapse text-[10px]">
            {renderTableHeader()}
            <tbody>{flights.map((f, i) => renderRow(f, i))}</tbody>
          </table>
          {chartAndRadar}
        </div>
      </ReportPage>
    );
  }

  // 멀티페이지
  const pages: React.ReactNode[] = [];
  let offset = 0;

  // 첫 페이지: 헤더 + KPI + 테이블 시작
  const firstChunk = flights.slice(0, firstPageRows);
  pages.push(
    <ReportPage key="fc-0">
      <div className="mb-8">
        {headerAndKPI}
        <h3 className="mb-2 text-[12px] font-semibold text-gray-700">비행별 상세</h3>
        <table className="mb-4 w-full border-collapse text-[10px]">
          {renderTableHeader()}
          <tbody>{firstChunk.map((f, i) => renderRow(f, i))}</tbody>
        </table>
      </div>
    </ReportPage>
  );
  offset = firstPageRows;

  // 중간 테이블 페이지
  while (offset < flights.length) {
    const remaining = flights.length - offset;
    // 마지막 청크에 차트+레이더가 들어갈 여유 확인
    const reserveForChart = offset + nextPageRows >= flights.length
      ? chartHeightMM + RADAR_INFO_MM : 0;
    const rowsThisPage = Math.floor((PAGE_CONTENT_MM - TABLE_HEADER_MM - reserveForChart) / ROW_HEIGHT_SM);
    const chunk = flights.slice(offset, offset + Math.min(rowsThisPage, remaining));
    const isLast = offset + chunk.length >= flights.length;
    const pageIdx = pages.length;

    pages.push(
      <ReportPage key={`fc-${pageIdx}`}>
        <div className="mb-2 text-[10px] text-gray-400">
          {sectionNum}. 비행 비교 분석 (계속 — {offset + 1}~{offset + chunk.length}/{flights.length})
        </div>
        <table className="mb-4 w-full border-collapse text-[10px]">
          {renderTableHeader()}
          <tbody>{chunk.map((f, i) => renderRow(f, offset + i))}</tbody>
        </table>
        {isLast && chartAndRadar}
      </ReportPage>
    );
    offset += chunk.length;
  }

  // 차트가 마지막 테이블 페이지에 안 들어갔으면 별도 페이지
  if (offset >= flights.length && !pages[pages.length - 1]) {
    // 이미 위에서 isLast로 추가됨
  }

  return <>{pages}</>;
}
