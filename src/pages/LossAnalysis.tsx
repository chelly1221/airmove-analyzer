import { useState, useMemo, useRef, useEffect } from "react";
import {
  MapContainer,
  TileLayer,
  Polyline,
  CircleMarker,
  Tooltip,
  useMap,
} from "react-leaflet";
import { format } from "date-fns";
import {
  BarChart3,
  Clock,
  Ruler,
  Mountain,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import Card from "../components/common/Card";
import { SimpleCard } from "../components/common/Card";
import DataTable from "../components/common/DataTable";
import { useAppStore } from "../store";
import { flightLabel } from "../utils/flightConsolidation";
import type { LossSegment } from "../types";

/** 미니맵 줌 이동 */
function ZoomToSegment({ segment }: { segment: LossSegment | null }) {
  const map = useMap();
  const prevSeg = useRef<LossSegment | null>(null);

  useEffect(() => {
    if (segment && segment !== prevSeg.current) {
      const bounds: [[number, number], [number, number]] = [
        [
          Math.min(segment.start_lat, segment.end_lat),
          Math.min(segment.start_lon, segment.end_lon),
        ],
        [
          Math.max(segment.start_lat, segment.end_lat),
          Math.max(segment.start_lon, segment.end_lon),
        ],
      ];
      map.fitBounds(bounds, { padding: [60, 60], maxZoom: 14 });
      prevSeg.current = segment;
    }
  }, [map, segment]);

  return null;
}

interface FlatLoss {
  index: number;
  flightId: string;
  flightLabel: string;
  segment: LossSegment;
}

export default function LossAnalysis() {
  const flights = useAppStore((s) => s.flights);
  const aircraft = useAppStore((s) => s.aircraft);
  const [selectedLoss, setSelectedLoss] = useState<FlatLoss | null>(null);
  const [sortField, setSortField] = useState<string>("start_time");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [viewMode, setViewMode] = useState<"table" | "by-flight" | "compare">(
    "table"
  );

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

  // 비행검사기 Loss만 평탄화
  const flatLoss: FlatLoss[] = useMemo(() => {
    const items: FlatLoss[] = [];
    let idx = 0;
    for (const f of flights) {
      if (!registeredModeSCodes.has(f.mode_s.toUpperCase())) continue;
      const label = flightLabel(f, aircraft);
      for (const seg of f.loss_segments) {
        items.push({
          index: idx++,
          flightId: f.id,
          flightLabel: label,
          segment: seg,
        });
      }
    }
    return items;
  }, [flights, registeredModeSCodes, aircraft]);

  // 정렬
  const sorted = useMemo(() => {
    const arr = [...flatLoss];
    arr.sort((a, b) => {
      let va: number, vb: number;
      switch (sortField) {
        case "duration":
          va = a.segment.duration_secs;
          vb = b.segment.duration_secs;
          break;
        case "distance":
          va = a.segment.distance_km;
          vb = b.segment.distance_km;
          break;
        case "altitude":
          va = a.segment.last_altitude;
          vb = b.segment.last_altitude;
          break;
        default:
          va = a.segment.start_time;
          vb = b.segment.start_time;
      }
      return sortDir === "asc" ? va - vb : vb - va;
    });
    return arr;
  }, [flatLoss, sortField, sortDir]);

  // 통계
  const stats = useMemo(() => {
    if (flatLoss.length === 0)
      return { totalDuration: 0, avgDuration: 0, maxDuration: 0, totalDistance: 0 };
    const durations = flatLoss.map((f) => f.segment.duration_secs);
    const totalDuration = durations.reduce((s, d) => s + d, 0);
    return {
      totalDuration,
      avgDuration: totalDuration / durations.length,
      maxDuration: Math.max(...durations),
      totalDistance: flatLoss.reduce((s, f) => s + f.segment.distance_km, 0),
    };
  }, [flatLoss]);

  const toggleSort = (field: string) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const SortIcon = ({ field }: { field: string }) => {
    if (sortField !== field) return null;
    return sortDir === "asc" ? (
      <ChevronUp size={12} />
    ) : (
      <ChevronDown size={12} />
    );
  };

  // 비행검사기 비행만 필터
  const registeredFlights = useMemo(
    () => flights.filter((f) => registeredModeSCodes.has(f.mode_s.toUpperCase())),
    [flights, registeredModeSCodes]
  );

  const columns = [
    {
      key: "index",
      header: "#",
      width: "50px",
      render: (row: FlatLoss) => (
        <span className="text-gray-500">{row.index + 1}</span>
      ),
    },
    {
      key: "mode_s",
      header: "Mode-S",
      render: (row: FlatLoss) => (
        <span className="font-mono text-xs text-gray-600">{row.segment.mode_s}</span>
      ),
    },
    {
      key: "flight",
      header: "비행",
      render: (row: FlatLoss) => (
        <span className="text-gray-600 text-xs">{row.flightLabel}</span>
      ),
    },
    {
      key: "start_time",
      header: "시작 시각",
      render: (row: FlatLoss) =>
        format(new Date(row.segment.start_time * 1000), "yyyy-MM-dd HH:mm:ss"),
    },
    {
      key: "end_time",
      header: "종료 시각",
      render: (row: FlatLoss) =>
        format(new Date(row.segment.end_time * 1000), "MM-dd HH:mm:ss"),
    },
    {
      key: "duration",
      header: "지속시간(초)",
      render: (row: FlatLoss) => row.segment.duration_secs.toFixed(1),
      align: "right" as const,
    },
    {
      key: "distance",
      header: "거리(km)",
      render: (row: FlatLoss) => row.segment.distance_km.toFixed(2),
      align: "right" as const,
    },
    {
      key: "altitude",
      header: "고도(m)",
      render: (row: FlatLoss) => row.segment.last_altitude.toFixed(0),
      align: "right" as const,
    },
    {
      key: "position",
      header: "위치",
      render: (row: FlatLoss) => (
        <span className="font-mono text-xs text-gray-500">
          {row.segment.start_lat.toFixed(3)},{row.segment.start_lon.toFixed(3)}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">통계/분석</h1>
          <p className="mt-1 text-sm text-gray-500">
            비행검사기 항적 통계 및 표적소실 구간 분석
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1">
          {(
            [
              ["table", "테이블"],
              ["by-flight", "비행별"],
              ["compare", "비교"],
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

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card
          title="총 소실 건수"
          value={flatLoss.length}
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
          title="평균 지속시간"
          value={`${stats.avgDuration.toFixed(1)}초`}
          icon={Ruler}
          accent="#3b82f6"
        />
        <Card
          title="총 소실 거리"
          value={`${stats.totalDistance.toFixed(2)}km`}
          icon={Mountain}
          accent="#10b981"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Table or alternate views */}
        <div className="lg:col-span-2">
          {viewMode === "table" && (
            <div>
              {/* Sortable header buttons */}
              <div className="mb-2 flex items-center gap-2 text-xs text-gray-500">
                <span>정렬:</span>
                {[
                  { field: "start_time", label: "시각" },
                  { field: "duration", label: "지속시간" },
                  { field: "distance", label: "거리" },
                  { field: "altitude", label: "고도" },
                ].map(({ field, label }) => (
                  <button
                    key={field}
                    onClick={() => toggleSort(field)}
                    className={`flex items-center gap-0.5 rounded px-2 py-1 transition-colors ${sortField === field ? "bg-gray-100 text-gray-800" : "hover:bg-gray-100"}`}
                  >
                    {label}
                    <SortIcon field={field} />
                  </button>
                ))}
              </div>
              <DataTable
                columns={columns}
                data={sorted}
                rowKey={(row) => `loss-${row.index}`}
                onRowClick={(row) => setSelectedLoss(row)}
                selectedKey={selectedLoss ? `loss-${selectedLoss.index}` : undefined}
                emptyMessage="표적소실 구간이 없습니다. 비행검사기를 등록하고 자료를 파싱하세요."
                maxHeight="max-h-[500px]"
              />
            </div>
          )}

          {viewMode === "by-flight" && (
            <div className="space-y-4">
              {registeredFlights.length === 0 ? (
                <SimpleCard>
                  <p className="text-center text-sm text-gray-500 py-8">
                    분석 결과가 없습니다
                  </p>
                </SimpleCard>
              ) : (
                registeredFlights.map((f) => {
                  // 이 비행의 포인트 타입별 통계
                  const typeCounts: Record<string, number> = {};
                  for (const p of f.track_points) {
                    typeCounts[p.radar_type] = (typeCounts[p.radar_type] ?? 0) + 1;
                  }
                  const typeLabels: Record<string, string> = {
                    mode_ac: "Mode A/C",
                    mode_ac_psr: "A/C+PSR",
                    mode_s_allcall: "S All-Call",
                    mode_s_rollcall: "S Roll-Call",
                    mode_s_allcall_psr: "S AC+PSR",
                    mode_s_rollcall_psr: "S RC+PSR",
                  };

                  return (
                    <SimpleCard key={`flight-${f.id}`}>
                      <div className="mb-3 flex items-center justify-between">
                        <h3 className="font-medium text-gray-800">
                          {flightLabel(f, aircraft)}
                        </h3>
                        <span className="rounded bg-[#a60739]/15 px-2 py-0.5 text-xs font-medium text-[#a60739]">
                          소실 {f.loss_percentage.toFixed(1)}%
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-3 text-center text-xs">
                        <div className="rounded-lg bg-gray-50 p-2">
                          <p className="text-gray-500">소실 건수</p>
                          <p className="text-lg font-bold text-gray-800">
                            {f.loss_segments.length}
                          </p>
                        </div>
                        <div className="rounded-lg bg-gray-50 p-2">
                          <p className="text-gray-500">총 소실 시간</p>
                          <p className="text-lg font-bold text-gray-800">
                            {f.total_loss_time.toFixed(1)}초
                          </p>
                        </div>
                        <div className="rounded-lg bg-gray-50 p-2">
                          <p className="text-gray-500">추적 시간</p>
                          <p className="text-lg font-bold text-gray-800">
                            {(f.total_track_time / 60).toFixed(1)}분
                          </p>
                        </div>
                      </div>
                      {/* 레이더 타입별 포인트 통계 */}
                      {Object.keys(typeCounts).length > 0 && (
                        <div className="mt-3 border-t border-gray-100 pt-2">
                          <p className="mb-1.5 text-[11px] font-medium text-gray-500">레이더 탐지 유형별 포인트</p>
                          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                            {Object.entries(typeCounts).map(([type, count]) => (
                              <div key={type} className="flex items-center gap-1.5">
                                <span className="text-gray-500">{typeLabels[type] ?? type}</span>
                                <span className="font-mono font-semibold text-gray-800">{count.toLocaleString()}</span>
                              </div>
                            ))}
                            <div className="flex items-center gap-1.5">
                              <span className="text-gray-500">합계</span>
                              <span className="font-mono font-semibold text-gray-800">{f.track_points.length.toLocaleString()}</span>
                            </div>
                          </div>
                        </div>
                      )}
                    </SimpleCard>
                  );
                })
              )}
            </div>
          )}

          {viewMode === "compare" && (
            <SimpleCard>
              <h3 className="mb-4 font-medium text-gray-800">
                비행별 소실 비율 비교
              </h3>
              {registeredFlights.length === 0 ? (
                <p className="text-center text-sm text-gray-500 py-8">
                  비교할 분석 결과가 없습니다
                </p>
              ) : (
                <div className="space-y-3">
                  {registeredFlights.map((f) => {
                    const pct = f.loss_percentage;
                    const label = flightLabel(f, aircraft);
                    return (
                      <div key={`cmp-${f.id}`}>
                        <div className="mb-1 flex items-center justify-between text-xs">
                          <span className="text-gray-600">
                            {label}
                          </span>
                          <span
                            className={
                              pct > 5 ? "text-[#a60739]" : "text-green-600"
                            }
                          >
                            {pct.toFixed(1)}%
                          </span>
                        </div>
                        <div className="h-3 overflow-hidden rounded-full bg-gray-100">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{
                              width: `${Math.min(pct, 100)}%`,
                              backgroundColor:
                                pct > 5 ? "#a60739" : "#10b981",
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </SimpleCard>
          )}
        </div>

        {/* Mini map */}
        <div>
          <SimpleCard className="overflow-hidden p-0">
            <div className="border-b border-gray-200 px-4 py-3">
              <h3 className="text-sm font-semibold text-gray-800">위치 미리보기</h3>
              {selectedLoss && (
                <p className="text-xs text-gray-500 mt-0.5">
                  소실 #{selectedLoss.index + 1} -{" "}
                  {format(
                    new Date(selectedLoss.segment.start_time * 1000),
                    "MM-dd HH:mm:ss"
                  )}
                </p>
              )}
            </div>
            <div className="h-72">
              <MapContainer
                center={[36.5, 127.0]}
                zoom={7}
                className="h-full w-full"
                zoomControl={false}
              >
                <TileLayer
                  url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
                  attribution=""
                />
                {selectedLoss && (
                  <>
                    <ZoomToSegment segment={selectedLoss.segment} />
                    <Polyline
                      positions={[
                        [
                          selectedLoss.segment.start_lat,
                          selectedLoss.segment.start_lon,
                        ],
                        [
                          selectedLoss.segment.end_lat,
                          selectedLoss.segment.end_lon,
                        ],
                      ]}
                      pathOptions={{
                        color: "#a60739",
                        weight: 3,
                        dashArray: "6, 4",
                      }}
                    >
                      <Tooltip sticky opacity={0.95}>
                        <div style={{ fontSize: 11 }}>
                          <b>{selectedLoss.segment.mode_s}</b> — {selectedLoss.segment.duration_secs.toFixed(1)}초 / {selectedLoss.segment.distance_km.toFixed(2)}km
                        </div>
                      </Tooltip>
                    </Polyline>
                    <CircleMarker
                      center={[
                        selectedLoss.segment.start_lat,
                        selectedLoss.segment.start_lon,
                      ]}
                      radius={6}
                      pathOptions={{
                        color: "#a60739",
                        fillColor: "#a60739",
                        fillOpacity: 1,
                      }}
                    >
                      <Tooltip direction="top" offset={[0, -8]} opacity={0.95}>
                        <div style={{ fontSize: 11, lineHeight: 1.5 }}>
                          <div><b>Loss 시작</b></div>
                          <div>{format(new Date(selectedLoss.segment.start_time * 1000), "MM-dd HH:mm:ss")}</div>
                          <div>고도: {selectedLoss.segment.start_altitude.toFixed(0)}m</div>
                          <div>{selectedLoss.segment.start_lat.toFixed(4)}°N {selectedLoss.segment.start_lon.toFixed(4)}°E</div>
                        </div>
                      </Tooltip>
                    </CircleMarker>
                    <CircleMarker
                      center={[
                        selectedLoss.segment.end_lat,
                        selectedLoss.segment.end_lon,
                      ]}
                      radius={5}
                      pathOptions={{
                        color: "#ff8a80",
                        fillColor: "#ff8a80",
                        fillOpacity: 1,
                      }}
                    >
                      <Tooltip direction="top" offset={[0, -8]} opacity={0.95}>
                        <div style={{ fontSize: 11, lineHeight: 1.5 }}>
                          <div><b>Loss 종료</b></div>
                          <div>{format(new Date(selectedLoss.segment.end_time * 1000), "MM-dd HH:mm:ss")}</div>
                          <div>고도: {selectedLoss.segment.end_altitude.toFixed(0)}m</div>
                          <div>{selectedLoss.segment.end_lat.toFixed(4)}°N {selectedLoss.segment.end_lon.toFixed(4)}°E</div>
                        </div>
                      </Tooltip>
                    </CircleMarker>
                  </>
                )}
              </MapContainer>
            </div>
            {!selectedLoss && (
              <div className="px-4 py-3 text-center text-xs text-gray-500">
                테이블에서 소실 구간을 클릭하면 지도에 표시됩니다
              </div>
            )}
          </SimpleCard>
        </div>
      </div>
    </div>
  );
}
