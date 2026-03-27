import { useState, useEffect, useMemo } from "react";
import { format } from "date-fns";
import type { Flight, RadarSite, TrackPoint } from "../../types";
import { flightLabel } from "../../utils/flightConsolidation";
import { useAppStore } from "../../store";
import { queryFlightPoints } from "../../utils/flightConsolidationWorker";

interface Props {
  sectionNum: number;
  flight: Flight;
  radarSite: RadarSite;
  /** 사전 로드된 포인트 — 보고서 윈도우에서 Worker가 없을 때 사용 */
  preloadedPoints?: TrackPoint[];
}

function getGrade(lossPercent: number): { label: string; color: string; bg: string } {
  if (lossPercent < 1) return { label: "양호", color: "text-green-700", bg: "bg-green-100 border-green-300" };
  if (lossPercent < 5) return { label: "주의", color: "text-yellow-700", bg: "bg-yellow-100 border-yellow-300" };
  return { label: "경고", color: "text-red-700", bg: "bg-red-100 border-red-300" };
}

/** 단일비행 상세 보고서: 비행 프로파일 (기본정보 + KPI + 고도 차트) */
export default function ReportFlightProfileSection({ sectionNum, flight, radarSite, preloadedPoints }: Props) {
  const aircraft = useAppStore((s) => s.aircraft);
  const label = flightLabel(flight, aircraft);
  const grade = getGrade(flight.loss_percentage);
  const matchTypeLabel = flight.match_type === "manual" ? "수동 병합" : "Gap 분리";

  // Worker에서 비행 포인트 비동기 로드 (preloadedPoints가 있으면 스킵)
  const [workerPoints, setWorkerPoints] = useState<TrackPoint[]>([]);
  useEffect(() => {
    if (preloadedPoints && preloadedPoints.length > 0) return;
    let cancelled = false;
    queryFlightPoints(flight.id).then((pts) => {
      if (!cancelled) setWorkerPoints(pts);
    });
    return () => { cancelled = true; };
  }, [flight.id, preloadedPoints]);

  const chartPoints = (preloadedPoints && preloadedPoints.length > 0) ? preloadedPoints : workerPoints;

  // 고도/속도 범위 (로드된 포인트 기반)
  const { minAlt, maxAlt, minSpd, maxSpd } = useMemo(() => {
    let mnA = Infinity, mxA = -Infinity, mnS = Infinity, mxS = -Infinity;
    for (const p of chartPoints) {
      if (p.altitude < mnA) mnA = p.altitude;
      if (p.altitude > mxA) mxA = p.altitude;
      if (p.speed < mnS) mnS = p.speed;
      if (p.speed > mxS) mxS = p.speed;
    }
    if (!isFinite(mnA)) { mnA = 0; mxA = 0; mnS = 0; mxS = 0; }
    return { minAlt: mnA, maxAlt: mxA, minSpd: mnS, maxSpd: mxS };
  }, [chartPoints]);

  // 최대 gap 시간
  let maxGap = 0;
  for (const lp of flight.loss_points) if (lp.gap_duration_secs > maxGap) maxGap = lp.gap_duration_secs;
  const chartW = 560;
  const chartH = 100;
  const padL = 45;
  const padR = 10;
  const padT = 10;
  const padB = 25;
  const innerW = chartW - padL - padR;
  const innerH = chartH - padT - padB;

  const tMin = flight.start_time;
  const tMax = flight.end_time;
  const tRange = tMax - tMin || 1;
  const altRange = maxAlt - minAlt || 1;

  const pathD = chartPoints.length > 1
    ? chartPoints.map((p, i) => {
        const x = padL + ((p.timestamp - tMin) / tRange) * innerW;
        const y = padT + innerH - ((p.altitude - minAlt) / altRange) * innerH;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(" ")
    : "";

  // loss 구간 밴드
  const lossSegBands = flight.loss_segments.map((seg) => {
    const x1 = padL + ((seg.start_time - tMin) / tRange) * innerW;
    const x2 = padL + ((seg.end_time - tMin) / tRange) * innerW;
    return { x: x1, w: Math.max(x2 - x1, 1) };
  });

  return (
    <div className="mb-6">
      <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[15px] font-bold text-gray-900">
        {sectionNum}. 비행 프로파일
      </h2>

      {/* 판정 뱃지 */}
      <div className="mb-4 flex items-center gap-3">
        <span className="text-[12px] text-gray-600">판정:</span>
        <span className={`rounded-md border px-3 py-1 text-[13px] font-bold ${grade.bg} ${grade.color}`}>
          {grade.label}
        </span>
        <span className="text-[11px] text-gray-400">
          소실율 {flight.loss_percentage.toFixed(1)}%
        </span>
      </div>

      {/* 기본정보 2열 박스 */}
      <div className="mb-4 rounded border border-gray-200 bg-gray-50 p-3">
        <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-[11px]">
          <InfoRow label="비행" value={label} />
          <InfoRow label="Mode-S" value={flight.mode_s} mono />
          <InfoRow label="콜사인" value={flight.callsign ?? "-"} />
          <InfoRow label="매칭 방식" value={matchTypeLabel} />
          <InfoRow label="출발 공항" value={flight.departure_airport ?? "-"} />
          <InfoRow label="도착 공항" value={flight.arrival_airport ?? "-"} />
          <InfoRow
            label="시간 범위"
            value={`${format(new Date(flight.start_time * 1000), "yyyy-MM-dd HH:mm:ss")} ~ ${format(new Date(flight.end_time * 1000), "HH:mm:ss")}`}
          />
          <InfoRow label="레이더" value={`${radarSite.name} (${radarSite.range_nm}NM)`} />
        </div>
      </div>

      {/* KPI 그리드 */}
      <div className="mb-5 grid grid-cols-4 gap-2">
        {[
          { label: "소실율", value: `${flight.loss_percentage.toFixed(1)}%`, accent: true },
          { label: "소실 건수", value: `${flight.loss_points.length}건`, accent: true },
          { label: "총 소실시간", value: `${flight.total_loss_time.toFixed(1)}초` },
          { label: "최대 gap", value: `${maxGap.toFixed(1)}초` },
          { label: "추적 시간", value: `${(flight.total_track_time / 60).toFixed(1)}분` },
          { label: "추적 포인트", value: `${flight.point_count.toLocaleString()}개` },
          { label: "고도 범위", value: `${minAlt.toFixed(0)}~${maxAlt.toFixed(0)}m` },
          { label: "속도 범위", value: `${minSpd.toFixed(0)}~${maxSpd.toFixed(0)}kts` },
        ].map((kpi) => (
          <div key={kpi.label} className="rounded border border-gray-200 bg-gray-50 px-2 py-1.5 text-center">
            <div className="text-[9px] text-gray-400">{kpi.label}</div>
            <div className={`text-[13px] font-bold ${kpi.accent ? "text-[#a60739]" : "text-gray-800"}`}>
              {kpi.value}
            </div>
          </div>
        ))}
      </div>

      {/* 고도-시간 미니차트 */}
      {chartPoints.length > 1 && (
        <div>
          <h3 className="mb-1 text-[11px] font-semibold text-gray-700">고도 추이</h3>
          <svg width="100%" viewBox={`0 0 ${chartW} ${chartH}`} className="overflow-visible">
            {/* 배경 그리드 */}
            {[0, 0.25, 0.5, 0.75, 1].map((r) => {
              const y = padT + innerH * (1 - r);
              return (
                <g key={r}>
                  <line x1={padL} y1={y} x2={padL + innerW} y2={y} stroke="#eee" strokeWidth={0.5} />
                  <text x={padL - 4} y={y + 3} textAnchor="end" fontSize={7} fill="#999">
                    {(minAlt + altRange * r).toFixed(0)}
                  </text>
                </g>
              );
            })}

            {/* Loss 구간 빨간 밴드 */}
            {lossSegBands.map((band, i) => (
              <rect key={i} x={band.x} y={padT} width={band.w} height={innerH} fill="#ef4444" opacity={0.15} />
            ))}

            {/* 고도 경로 */}
            <path d={pathD} fill="none" stroke="#3b82f6" strokeWidth={1.2} />

            {/* X축 시간 라벨 */}
            {[0, 0.25, 0.5, 0.75, 1].map((r) => {
              const t = tMin + tRange * r;
              const x = padL + innerW * r;
              return (
                <text key={r} x={x} y={padT + innerH + 14} textAnchor="middle" fontSize={7} fill="#999">
                  {format(new Date(t * 1000), "HH:mm")}
                </text>
              );
            })}

            {/* 축 라벨 */}
            <text x={padL - 4} y={padT - 3} textAnchor="end" fontSize={7} fill="#666">고도(m)</text>
          </svg>
          {flight.loss_segments.length > 0 && (
            <div className="mt-0.5 flex items-center gap-1.5 text-[8px] text-gray-400">
              <span className="inline-block h-2 w-4 rounded-sm bg-red-400/30" />
              소실 구간
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-400">{label}</span>
      <span className={`font-medium text-gray-700 ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}
