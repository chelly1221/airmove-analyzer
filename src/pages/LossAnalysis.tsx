import { useState, useMemo } from "react";
import {
  BarChart3,
  Clock,
  Ruler,
  Mountain,
  Trash2,
  MapPin,
  Crosshair,
} from "lucide-react";
import Card from "../components/common/Card";
import { SimpleCard } from "../components/common/Card";

import { useAppStore } from "../store";
import { flightLabel } from "../utils/flightConsolidation";
import type { LossPoint, LoSProfileData } from "../types";

interface FlatLoss {
  index: number;
  flightId: string;
  flightLabel: string;
  point: LossPoint;
}

export default function LossAnalysis() {
  const allFlights = useAppStore((s) => s.flights);
  const aircraft = useAppStore((s) => s.aircraft);
  const radarSite = useAppStore((s) => s.radarSite);
  const flights = useMemo(
    () => allFlights.filter((f) => !f.radar_name || f.radar_name === radarSite.name),
    [allFlights, radarSite.name],
  );
  const losResults = useAppStore((s) => s.losResults);
  const removeLoSResult = useAppStore((s) => s.removeLoSResult);
  const [viewMode, setViewMode] = useState<"by-flight" | "los-saved">("by-flight");
  const [losPreview, setLosPreview] = useState<LoSProfileData | null>(null);
  // 비행별 카드 펼침 상태
  const [expandedFlightIds, setExpandedFlightIds] = useState<Set<string>>(new Set());

  // 등록된 비행검사기 Mode-S 코드 집합
  const registeredModeSCodes = useMemo(() => {
    const codes = new Set<string>();
    for (const a of aircraft) {
      if (a.active && a.mode_s_code) {
        codes.add(a.mode_s_code.toUpperCase());
      }
    }
    return codes;
  }, [aircraft]);

  // 비행검사기 Loss 포인트 평탄화
  const flatLoss: FlatLoss[] = useMemo(() => {
    const items: FlatLoss[] = [];
    let idx = 0;
    for (const f of flights) {
      if (!registeredModeSCodes.has(f.mode_s.toUpperCase())) continue;
      const label = flightLabel(f, aircraft);
      for (const lp of f.loss_points) {
        items.push({
          index: idx++,
          flightId: f.id,
          flightLabel: label,
          point: lp,
        });
      }
    }
    return items;
  }, [flights, registeredModeSCodes, aircraft]);

  // 통계
  const stats = useMemo(() => {
    if (flatLoss.length === 0)
      return { totalDuration: 0, avgDuration: 0, maxDuration: 0, totalPoints: 0, gapCount: 0 };
    // gap별 고유 지속시간 합산
    const gapDurations = new Map<string, number>();
    for (const f of flatLoss) {
      const key = `${f.point.mode_s}_${f.point.gap_start_time}`;
      if (!gapDurations.has(key)) gapDurations.set(key, f.point.gap_duration_secs);
    }
    const durations = Array.from(gapDurations.values());
    const totalDuration = durations.reduce((s, d) => s + d, 0);
    return {
      totalDuration,
      avgDuration: durations.length > 0 ? totalDuration / durations.length : 0,
      maxDuration: durations.reduce((m, d) => d > m ? d : m, 0),
      totalPoints: flatLoss.length,
      gapCount: gapDurations.size,
    };
  }, [flatLoss]);

  // 비행검사기 비행만 필터
  const registeredFlights = useMemo(
    () => flights.filter((f) => registeredModeSCodes.has(f.mode_s.toUpperCase())),
    [flights, registeredModeSCodes]
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">통계 / 분석</h1>
          {viewMode === "by-flight" && (
            <p className="mt-1 text-sm text-gray-500">
              비행검사기 항적 통계 및 표적소실 구간 분석
            </p>
          )}
          {viewMode === "los-saved" && !losPreview && (
            <p className="mt-1 text-sm text-gray-500">
              저장된 LoS 단면도 분석 결과
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1">
          {(
            [
              ["by-flight", "비행별"],
              ["los-saved", `LoS (${losResults.length})`],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                viewMode === mode
                  ? "bg-[#a60739] text-white"
                  : "text-gray-500 hover:text-gray-900"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {viewMode === "los-saved" ? (
        <>
          {/* ── 저장된 LoS 분석 뷰 ── */}
          {losPreview ? (
            /* 상세 미리보기 */
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setLosPreview(null)}
                  className="rounded-md border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
                >
                  목록으로
                </button>
                <span className="text-sm font-medium text-gray-800">
                  {losPreview.radarSiteName} → {losPreview.bearing.toFixed(1)}° / {losPreview.totalDistance.toFixed(1)}km
                </span>
                <span className={`ml-auto rounded px-2 py-0.5 text-xs font-bold ${
                  losPreview.losBlocked ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"
                }`}>
                  {losPreview.losBlocked ? "차단" : "양호"}
                </span>
              </div>
              {losPreview.mapScreenshot && (
                <SimpleCard className="!p-0 overflow-hidden">
                  <img src={losPreview.mapScreenshot} alt="맵 스크린샷" className="w-full" />
                </SimpleCard>
              )}
              {losPreview.chartScreenshot && (
                <SimpleCard className="!p-0 overflow-hidden">
                  <img src={losPreview.chartScreenshot} alt="단면도" className="w-full" />
                </SimpleCard>
              )}
              {!losPreview.mapScreenshot && !losPreview.chartScreenshot && (
                <SimpleCard>
                  <p className="py-8 text-center text-sm text-gray-400">
                    스크린샷 없음 (이전 버전에서 저장된 결과)
                  </p>
                </SimpleCard>
              )}
            </div>
          ) : losResults.length === 0 ? (
            <SimpleCard>
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-sm text-gray-500">
                <Crosshair className="h-8 w-8 text-gray-300" />
                <p>저장된 LoS 분석 결과가 없습니다.</p>
                <p className="text-xs">항적 지도에서 LoS 분석 후 저장하세요.</p>
              </div>
            </SimpleCard>
          ) : (
            <div className="space-y-2">
              {[...losResults].reverse().map((r) => (
                <SimpleCard key={r.id} className="!p-0 overflow-hidden">
                  <div className="flex items-stretch">
                    {/* 썸네일 (맵 + 차트) */}
                    <button
                      onClick={() => setLosPreview(r)}
                      className="flex shrink-0 gap-0.5 bg-gray-50 hover:bg-gray-100 transition-colors"
                    >
                      {r.mapScreenshot ? (
                        <img src={r.mapScreenshot} alt="" className="h-[72px] w-[100px] object-cover" />
                      ) : (
                        <div className="flex h-[72px] w-[100px] items-center justify-center text-gray-300">
                          <MapPin size={20} />
                        </div>
                      )}
                      {r.chartScreenshot ? (
                        <img src={r.chartScreenshot} alt="" className="h-[72px] w-[120px] object-cover" />
                      ) : (
                        <div className="flex h-[72px] w-[120px] items-center justify-center text-gray-300">
                          <Crosshair size={20} />
                        </div>
                      )}
                    </button>
                    {/* 정보 */}
                    <button
                      onClick={() => setLosPreview(r)}
                      className="flex min-w-0 flex-1 flex-col justify-center gap-1 px-3 py-2 text-left hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-800 truncate">
                          {r.radarSiteName}
                        </span>
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          r.losBlocked ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"
                        }`}>
                          {r.losBlocked ? "차단" : "양호"}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-[11px] text-gray-500">
                        <span>방위 <b className="text-gray-700">{r.bearing.toFixed(1)}°</b></span>
                        <span>거리 <b className="text-gray-700">{r.totalDistance.toFixed(1)}km</b></span>
                        {r.maxBlockingPoint && (
                          <span>최대차단 <b className="text-gray-700">{r.maxBlockingPoint.elevation.toFixed(0)}m</b>
                            {r.maxBlockingPoint.name && ` (${r.maxBlockingPoint.name})`}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-gray-400">
                        {new Date(r.timestamp > 1e12 ? r.timestamp : r.timestamp * 1000).toLocaleString("ko-KR")}
                        <span className="ml-2">
                          목표 ({r.targetLat.toFixed(4)}, {r.targetLon.toFixed(4)})
                        </span>
                      </div>
                    </button>
                    {/* 삭제 */}
                    <button
                      onClick={() => removeLoSResult(r.id)}
                      className="flex shrink-0 items-center px-3 text-gray-300 hover:text-red-500 transition-colors"
                      title="삭제"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </SimpleCard>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          {/* ── Loss 비행별 뷰 ── */}
          {/* Stats */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card
              title="미탐지 포인트"
              value={`${flatLoss.length}pt / ${stats.gapCount}gap`}
              icon={BarChart3}
              accent="#a60739"
            />
            <Card
              title="총 소실 시간"
              value={`${stats.totalDuration.toFixed(1)}초`}
              icon={Clock}
              accent="#f59e0b"
            />
            <Card
              title="평균 gap 시간"
              value={`${stats.avgDuration.toFixed(1)}초`}
              icon={Ruler}
              accent="#3b82f6"
            />
            <Card
              title="최대 gap 시간"
              value={`${stats.maxDuration.toFixed(1)}초`}
              icon={Mountain}
              accent="#10b981"
            />
          </div>

          {/* 비행별 뷰 */}
          {registeredFlights.length === 0 ? (
            <SimpleCard>
              <p className="text-center text-sm text-gray-500 py-8">
                분석 결과가 없습니다
              </p>
            </SimpleCard>
          ) : (
            <div className="space-y-2">
              {registeredFlights.map((f) => {
                const pct = f.loss_percentage;
                const typeCounts = f.radar_type_counts;
                const typeLabels: Record<string, string> = {
                  mode_ac: "Mode A/C",
                  mode_ac_psr: "A/C+PSR",
                  mode_s_allcall: "S All-Call",
                  mode_s_rollcall: "S Roll-Call",
                  mode_s_allcall_psr: "S AC+PSR",
                  mode_s_rollcall_psr: "S RC+PSR",
                };

                // 60NM 이내 PSR 탐지율 계산
                const within60Total = f.within_60nm_stats?.total ?? 0;
                const within60Psr = f.within_60nm_stats?.psr ?? 0;
                const psrRate = within60Total > 0 ? (within60Psr / within60Total) * 100 : null;

                const isExpanded = expandedFlightIds.has(f.id);
                const toggleExpand = () => {
                  setExpandedFlightIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(f.id)) next.delete(f.id);
                    else next.add(f.id);
                    return next;
                  });
                };
                const fmtTime = (ts: number) => {
                  const d = new Date(ts * 1000);
                  return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
                };
                const fmtDate = (ts: number) => {
                  const d = new Date(ts * 1000);
                  return `${d.getMonth() + 1}/${d.getDate()}`;
                };

                return (
                  <SimpleCard key={`flight-${f.id}`} className="!py-2.5 !px-3 cursor-pointer" onClick={toggleExpand}>
                    {/* 1행: 비행라벨 + 핵심 수치 */}
                    <div className="flex items-center gap-3">
                      <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-gray-800">
                        {flightLabel(f, aircraft)}
                      </h3>
                      <div className="flex shrink-0 items-center gap-3 text-[11px] text-gray-500">
                        <span><b className="text-gray-700">{f.loss_points.length}</b>pt / <b className="text-gray-700">{f.loss_segments.length}</b>gap</span>
                        <span>소실 <b className="text-gray-700">{f.total_loss_time.toFixed(1)}</b>초</span>
                        <span>추적 <b className="text-gray-700">{(f.total_track_time / 60).toFixed(1)}</b>분</span>
                      </div>
                      {psrRate !== null && (
                        <span className="shrink-0 rounded px-2 py-0.5 text-xs font-bold bg-blue-100 text-blue-700" title={`60NM 이내 SSR 대비 PSR 탐지율 (${within60Psr}/${within60Total})`}>
                          PSR {psrRate.toFixed(1)}%
                        </span>
                      )}
                      <span className="shrink-0 rounded px-2 py-0.5 text-xs font-bold bg-[#a60739]/15 text-[#a60739]">
                        {pct.toFixed(1)}%
                      </span>
                    </div>
                    {/* 2행: 소실비율 바 + 레이더 유형 */}
                    <div className="mt-1.5 flex items-center gap-3">
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${Math.min(pct, 100)}%`,
                            backgroundColor: "#a60739",
                          }}
                        />
                      </div>
                      {Object.keys(typeCounts).length > 0 && (
                        <div className="flex shrink-0 items-center gap-2 text-[10px] text-gray-400">
                          {Object.entries(typeCounts).map(([type, count]) => (
                            <span key={type}>{typeLabels[type] ?? type} <b className="text-gray-600">{count.toLocaleString()}</b></span>
                          ))}
                        </div>
                      )}
                    </div>
                    {/* 상세 정보 (펼침) */}
                    {isExpanded && (
                      <div className="mt-3 border-t border-gray-100 pt-3">
                        {/* 비행 요약 */}
                        <div className="mb-2 grid grid-cols-2 gap-x-6 gap-y-1 text-[11px] text-gray-500 sm:grid-cols-4">
                          <span>비행시간 <b className="text-gray-700">{fmtDate(f.start_time)} {fmtTime(f.start_time)}</b> ~ <b className="text-gray-700">{fmtTime(f.end_time)}</b></span>
                          <span>포인트 <b className="text-gray-700">{f.point_count.toLocaleString()}</b>개</span>
                          <span>최대레이더거리 <b className="text-gray-700">{f.max_radar_range_km.toFixed(1)}</b>km</span>
                          <span>매칭 <b className="text-gray-700">{f.match_type}</b></span>
                        </div>
                        {/* Loss 세그먼트 테이블 */}
                        {f.loss_segments.length > 0 ? (
                          <div className="max-h-60 overflow-auto rounded border border-gray-100">
                            <table className="w-full text-[11px]">
                              <thead className="sticky top-0 bg-gray-50 text-gray-500">
                                <tr>
                                  <th className="px-2 py-1 text-left font-medium">#</th>
                                  <th className="px-2 py-1 text-left font-medium">유형</th>
                                  <th className="px-2 py-1 text-left font-medium">시작</th>
                                  <th className="px-2 py-1 text-left font-medium">종료</th>
                                  <th className="px-2 py-1 text-right font-medium">지속(초)</th>
                                  <th className="px-2 py-1 text-right font-medium">거리(km)</th>
                                  <th className="px-2 py-1 text-right font-medium">시작고도(ft)</th>
                                  <th className="px-2 py-1 text-right font-medium">종료고도(ft)</th>
                                  <th className="px-2 py-1 text-right font-medium">레이더거리(km)</th>
                                </tr>
                              </thead>
                              <tbody>
                                {f.loss_segments.map((seg, i) => (
                                  <tr key={i} className="border-t border-gray-50 hover:bg-gray-50/50">
                                    <td className="px-2 py-1 text-gray-400">{i + 1}</td>
                                    <td className="px-2 py-1">
                                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${seg.loss_type === "signal_loss" ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-600"}`}>
                                        {seg.loss_type === "signal_loss" ? "소실" : "범위이탈"}
                                      </span>
                                    </td>
                                    <td className="px-2 py-1 text-gray-700">{fmtTime(seg.start_time)}</td>
                                    <td className="px-2 py-1 text-gray-700">{fmtTime(seg.end_time)}</td>
                                    <td className="px-2 py-1 text-right font-medium text-gray-700">{seg.duration_secs.toFixed(1)}</td>
                                    <td className="px-2 py-1 text-right text-gray-600">{seg.distance_km.toFixed(1)}</td>
                                    <td className="px-2 py-1 text-right text-gray-600">{Math.round(seg.start_altitude * 3.28084).toLocaleString()}</td>
                                    <td className="px-2 py-1 text-right text-gray-600">{Math.round(seg.end_altitude * 3.28084).toLocaleString()}</td>
                                    <td className="px-2 py-1 text-right text-gray-600">{seg.start_radar_dist_km.toFixed(1)}~{seg.end_radar_dist_km.toFixed(1)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <p className="text-center text-[11px] text-gray-400">소실 구간 없음</p>
                        )}
                      </div>
                    )}
                  </SimpleCard>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
