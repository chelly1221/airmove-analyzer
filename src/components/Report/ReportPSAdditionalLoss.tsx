import type { PreScreeningResult } from "../../types";

interface Props {
  sectionNum: number;
  result: PreScreeningResult;
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs.toFixed(0)}초`;
  if (secs < 3600) return `${Math.floor(secs / 60)}분 ${Math.floor(secs % 60)}초`;
  return `${Math.floor(secs / 3600)}시간 ${Math.floor((secs % 3600) / 60)}분`;
}

/** 추가 Loss 이벤트 상세 섹션 */
export default function ReportPSAdditionalLoss({ sectionNum, result }: Props) {
  const allEvents = result.radar_results.flatMap((rr) =>
    rr.building_results.flatMap((br) =>
      br.additional_loss_events.map((ev) => ({
        radarName: rr.radar_name,
        buildingName: br.building_name || `건물 ${br.building_id}`,
        ...ev,
      })),
    ),
  );

  // 건물별 요약
  const buildingSummaries = result.radar_results.flatMap((rr) =>
    rr.building_results
      .filter((br) => br.additional_loss_events.length > 0 || br.additional_loss_time_secs > 0)
      .map((br) => ({
        radarName: rr.radar_name,
        buildingName: br.building_name || `건물 ${br.building_id}`,
        eventCount: br.additional_loss_events.length,
        totalTimeSecs: br.additional_loss_time_secs,
        affectedAircraft: br.affected_aircraft_count,
        sectorTrackTime: br.sector_total_track_time_secs,
        existingLossTime: br.sector_existing_loss_time_secs,
        additionalLossRate: br.sector_total_track_time_secs > 0
          ? (br.additional_loss_time_secs / br.sector_total_track_time_secs) * 100
          : 0,
      })),
  );

  const hasEvents = allEvents.length > 0;

  return (
    <div className="mb-8">
      <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[19px] font-bold text-gray-900">
        {sectionNum}. 추가 표적소실 분석
      </h2>

      {!hasEvents ? (
        <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-center">
          <p className="text-[14px] font-semibold text-green-700">추가 표적소실 없음</p>
          <p className="mt-1 text-[11px] text-green-600">
            제안 건물에 의한 추가적인 표적소실 이벤트가 검출되지 않았습니다.
          </p>
        </div>
      ) : (
        <>
          {/* 건물별 요약 */}
          <h3 className="mb-2 text-[14px] font-semibold text-gray-700">건물별 추가 Loss 요약</h3>
          <table className="mb-5 w-full text-[11px]">
            <thead>
              <tr className="border-b-2 border-gray-300 bg-gray-100 text-gray-600">
                <th className="px-2 py-1.5 text-left">레이더</th>
                <th className="px-2 py-1.5 text-left">건물</th>
                <th className="px-2 py-1.5 text-right">이벤트 수</th>
                <th className="px-2 py-1.5 text-right">추가 Loss 시간</th>
                <th className="px-2 py-1.5 text-right">영향 항공기</th>
                <th className="px-2 py-1.5 text-right">추가 소실율</th>
              </tr>
            </thead>
            <tbody>
              {buildingSummaries.map((bs, idx) => (
                <tr key={idx} className="border-b border-gray-100">
                  <td className="px-2 py-1.5 font-medium text-gray-700">{bs.radarName}</td>
                  <td className="px-2 py-1.5 text-gray-700">{bs.buildingName}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-red-600 font-semibold">{bs.eventCount}</td>
                  <td className="px-2 py-1.5 text-right text-gray-600">{formatDuration(bs.totalTimeSecs)}</td>
                  <td className="px-2 py-1.5 text-right text-gray-600">{bs.affectedAircraft}대</td>
                  <td className="px-2 py-1.5 text-right font-mono text-red-600 font-semibold">{bs.additionalLossRate.toFixed(2)}%</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* 이벤트 상세 (최대 30건) */}
          <h3 className="mb-2 text-[14px] font-semibold text-gray-700">
            추가 Loss 이벤트 상세
            {allEvents.length > 30 && <span className="ml-2 text-[11px] font-normal text-gray-400">(상위 30건 표시)</span>}
          </h3>
          <table className="w-full text-[10px]">
            <thead>
              <tr className="border-b-2 border-gray-300 bg-gray-100 text-gray-500">
                <th className="px-1.5 py-1 text-left">레이더</th>
                <th className="px-1.5 py-1 text-left">건물</th>
                <th className="px-1.5 py-1 text-left">Mode-S</th>
                <th className="px-1.5 py-1 text-left">날짜</th>
                <th className="px-1.5 py-1 text-left">시작 (UTC)</th>
                <th className="px-1.5 py-1 text-left">종료 (UTC)</th>
                <th className="px-1.5 py-1 text-right">지속시간</th>
                <th className="px-1.5 py-1 text-right">평균고도 (ft)</th>
                <th className="px-1.5 py-1 text-right">거리 (km)</th>
                <th className="px-1.5 py-1 text-right">방위 (°)</th>
              </tr>
            </thead>
            <tbody>
              {allEvents.slice(0, 30).map((ev, idx) => (
                <tr key={idx} className="border-b border-gray-50">
                  <td className="px-1.5 py-1 text-gray-600">{ev.radarName}</td>
                  <td className="px-1.5 py-1 text-gray-600">{ev.buildingName}</td>
                  <td className="px-1.5 py-1 font-mono text-gray-700">{ev.mode_s}</td>
                  <td className="px-1.5 py-1 text-gray-500">{formatDate(ev.start_time)}</td>
                  <td className="px-1.5 py-1 font-mono text-gray-600">{formatTime(ev.start_time)}</td>
                  <td className="px-1.5 py-1 font-mono text-gray-600">{formatTime(ev.end_time)}</td>
                  <td className="px-1.5 py-1 text-right text-gray-600">{ev.duration_secs.toFixed(0)}초</td>
                  <td className="px-1.5 py-1 text-right font-mono text-gray-600">{ev.avg_alt_ft.toFixed(0)}</td>
                  <td className="px-1.5 py-1 text-right font-mono text-gray-600">{ev.radar_distance_km.toFixed(1)}</td>
                  <td className="px-1.5 py-1 text-right font-mono text-gray-600">{ev.azimuth_deg.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
