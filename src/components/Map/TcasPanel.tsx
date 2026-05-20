import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldAlert, ChevronDown, Loader2, RefreshCw, List } from "lucide-react";
import type { MapRef } from "react-map-gl/maplibre";
import { useAppStore } from "../../store";
import { queryRaEvents } from "../../utils/flightConsolidationWorker";
import type { TcasEvent } from "../../utils/tcasEvents";
import type { Flight } from "../../types";
import TcasEventsModal from "./TcasEventsModal";

interface Props {
  expanded: boolean;
  setExpanded: (v: boolean) => void;
  radarName: string;
  selectedModeS: string | null;
  registeredModeS: string[];
  /** 분석 시간창 (없으면 전체) */
  timeRange?: [number, number];
  /** 현재 표시 중인 비행 — callsign/aircraft_name 조회용 */
  flights: Flight[];
  mapRef: React.RefObject<MapRef | null>;
  /** 이벤트 클릭 시 시간 윈도우 점프용 */
  onJumpToTime?: (ts: number) => void;
}

/** KST(UTC+9) 기준 시각 표시 */
function formatTime(ts: number): string {
  const d = new Date((ts + 9 * 3600) * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function labelFor(modeS: string, flights: Flight[]): string {
  const f = flights.find((fl) => fl.mode_s === modeS);
  if (!f) return modeS;
  return f.aircraft_name || f.callsign || modeS;
}

export default function TcasPanel({
  expanded, setExpanded,
  radarName, selectedModeS, registeredModeS, timeRange,
  flights, mapRef, onJumpToTime,
}: Props) {
  const tcasVisible = useAppStore((s) => s.tcasVisible);
  const setTcasVisible = useAppStore((s) => s.setTcasVisible);
  const tcasEvents = useAppStore((s) => s.tcasEvents);
  const setTcasEvents = useAppStore((s) => s.setTcasEvents);
  const tcasSelectedId = useAppStore((s) => s.tcasSelectedId);
  const setTcasSelectedId = useAppStore((s) => s.setTcasSelectedId);
  const tcasLoading = useAppStore((s) => s.tcasLoading);
  const setTcasLoading = useAppStore((s) => s.setTcasLoading);

  const [listOpen, setListOpen] = useState(false);

  const reqSeqRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 실제 쿼리
  const runQuery = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    setTcasLoading(true);
    try {
      const { events } = await queryRaEvents({
        radarName: radarName || undefined,
        selectedModeS,
        registeredModeS,
        timeRange,
      });
      if (reqSeqRef.current !== seq) return; // stale
      setTcasEvents(events);
    } catch (err) {
      console.error("[TCAS] 쿼리 실패:", err);
      if (reqSeqRef.current === seq) setTcasEvents([]);
    } finally {
      if (reqSeqRef.current === seq) setTcasLoading(false);
    }
  }, [radarName, selectedModeS, registeredModeS, timeRange, setTcasEvents, setTcasLoading]);

  // 토글 ON 또는 필터 변경 시 디바운스 재조회
  useEffect(() => {
    if (!tcasVisible) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { runQuery(); }, 500);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [tcasVisible, runQuery]);

  const handleToggle = useCallback(() => {
    const next = !tcasVisible;
    setTcasVisible(next);
    if (!next) {
      setTcasSelectedId(null);
    }
  }, [tcasVisible, setTcasVisible, setTcasSelectedId]);

  const handleEventClick = useCallback((ev: TcasEvent) => {
    setTcasSelectedId(ev.id === tcasSelectedId ? null : ev.id);
    // 지도 카메라 이동 — 자기 위치 중심
    const map = mapRef.current?.getMap();
    if (map) {
      map.easeTo({ center: [ev.ownLon, ev.ownLat], zoom: 11, duration: 500 });
    }
    // 시간 윈도우 점프 — RA 시작 시각으로
    onJumpToTime?.(ev.startTime);
  }, [tcasSelectedId, setTcasSelectedId, mapRef, onJumpToTime]);

  const isActive = tcasVisible;
  const eventCount = tcasEvents.length;

  return (
    <>
    <div className={`rounded-lg border transition-colors ${isActive ? "border-[#a60739]/30 bg-[#a60739]/5" : "border-gray-200 bg-gray-50"}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-3 py-2.5"
      >
        <div className="flex items-center gap-2">
          <ShieldAlert size={14} className={isActive ? "text-[#a60739]" : "text-gray-400"} />
          <span className={`text-xs font-medium ${isActive ? "text-[#a60739]" : "text-gray-600"}`}>TCAS RA</span>
          {tcasLoading && <>
            <Loader2 size={12} className="animate-spin text-[#a60739]" />
            <span className="text-[10px] text-[#a60739]/70">분석중</span>
          </>}
          {!tcasLoading && tcasVisible && eventCount > 0 && (
            <span className="text-[10px] text-[#a60739]/70">{eventCount}건</span>
          )}
        </div>
        <ChevronDown size={14} className={`transition-transform text-gray-400 ${expanded ? "rotate-180" : ""}`} />
      </button>

      {expanded && (
        <div className="px-3 pb-2.5 space-y-3">
          {/* 표시 토글 */}
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-gray-500">표시</span>
            <button
              onClick={handleToggle}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${isActive ? "bg-[#a60739]" : "bg-gray-300"}`}
              role="switch"
              aria-checked={isActive}
            >
              <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${isActive ? "translate-x-4.5" : "translate-x-0.5"}`} />
            </button>
          </div>

          {tcasVisible && (
            <>
              {/* 다시 계산 + 전체 보기 */}
              <div className="flex items-center gap-1.5">
                <button
                  onClick={runQuery}
                  disabled={tcasLoading}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-gray-300 bg-white px-2 py-1.5 text-[11px] text-gray-600 hover:border-[#a60739]/40 hover:text-[#a60739] disabled:opacity-50"
                >
                  <RefreshCw size={11} />
                  다시 분석
                </button>
                <button
                  onClick={() => setListOpen(true)}
                  disabled={eventCount === 0}
                  className="flex items-center justify-center gap-1.5 rounded-md border border-gray-300 bg-white px-2 py-1.5 text-[11px] text-gray-600 hover:border-[#a60739]/40 hover:text-[#a60739] disabled:opacity-50"
                  title="필터링 가능한 이벤트 목록 열기"
                >
                  <List size={11} />
                  전체 보기
                </button>
              </div>

              {/* 이벤트 리스트 */}
              {!tcasLoading && eventCount === 0 && (
                <div className="text-center text-[10px] text-gray-500 py-2">
                  RA 이벤트가 없습니다
                </div>
              )}

              {eventCount > 0 && (
                <div className="max-h-80 overflow-y-auto space-y-1.5 -mx-1 px-1">
                  {tcasEvents.map((ev) => {
                    const sel = ev.id === tcasSelectedId;
                    const tti = ev.threatTti;
                    const tidLabel = tti === 1 ? "TID(Mode-S)" : tti === 2 ? "TID(ATCRBS)" : tti === 3 ? "예비" : "상대정보없음";
                    const tidColor = tti === 1 ? "text-[#a60739]" : tti === 2 ? "text-amber-600" : "text-gray-400";
                    return (
                      <button
                        key={ev.id}
                        onClick={() => handleEventClick(ev)}
                        className={`block w-full rounded-md border px-2 py-1.5 text-left transition-colors ${
                          sel
                            ? "border-[#a60739] bg-[#a60739]/10"
                            : tti > 0
                              ? "border-gray-200 bg-white hover:border-[#a60739]/40"
                              : "border-gray-200 bg-gray-50 hover:border-gray-300"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-medium text-gray-700">
                            {formatTime(ev.startTime)}
                          </span>
                          <span className={`text-[9px] uppercase tracking-wider ${tidColor}`}>
                            {tidLabel}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-gray-800">
                          <span className="font-medium">{labelFor(ev.ownModeS, flights)}</span>
                          {tti === 1 && ev.threatModeS && (
                            <>
                              <span className="text-gray-400"> → </span>
                              <span className="font-medium">{labelFor(ev.threatModeS, flights)}</span>
                            </>
                          )}
                        </div>
                        <div className="mt-0.5 text-[10px] text-gray-500">
                          {ev.raDescription}
                          {tti === 2 && ev.threatRangeNm != null && (
                            <span className="text-[#a60739]/70 ml-1">
                              · 위협 {ev.threatRangeNm.toFixed(1)}NM
                              {ev.threatBearingDeg != null && ` · ${Math.round(ev.threatBearingDeg)}°`}
                              {ev.threatAltFt != null && ` · ${Math.round(ev.threatAltFt)}ft`}
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>

    <TcasEventsModal
      open={listOpen}
      onClose={() => setListOpen(false)}
      flights={flights}
      onSelect={handleEventClick}
    />
    </>
  );
}
