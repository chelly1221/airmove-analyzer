import React, { useState, useCallback, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Upload,
  Map as MapIcon,
  PencilRuler,
  BarChart3,
  FileText,
  Settings,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Loader2,
  Radio,
  Search,
  Mountain,
  Building2,
  Database,
  Key,
  Pencil,
  Eye,
  MapPin,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { format } from "date-fns";
import { ko } from "date-fns/locale";
import Modal from "../common/Modal";
import { useAppStore } from "../../store";
import { mergeFlightRecords } from "../../utils/flightConsolidation";
import { summarizeGarbleByModeS } from "../../utils/reflectorAnalysis";
import type { FlightRecord, PageId } from "../../types";

/** 항공기별 색상 팔레트 (TrackMap과 동일) */
const AIRCRAFT_COLORS: [number, number, number][] = [
  [59, 130, 246],   // blue
  [16, 185, 129],   // emerald
  [139, 92, 246],   // violet
  [6, 182, 212],    // cyan
  [249, 115, 22],   // orange
  [236, 72, 153],   // pink
  [132, 204, 22],   // lime
  [245, 158, 11],   // amber
  [99, 102, 241],   // indigo
  [20, 184, 166],   // teal
];

interface NavItem {
  id: PageId;
  label: string;
  icon: LucideIcon;
  path: string;
}

const navItems: NavItem[] = [
  { id: "upload", label: "자료 관리", icon: Upload, path: "/" },
  { id: "map", label: "항적 지도", icon: MapIcon, path: "/map" },
  { id: "drawing", label: "도면", icon: PencilRuler, path: "/drawing" },
  { id: "analysis", label: "통계 / 분석", icon: BarChart3, path: "/analysis" },
  { id: "report", label: "보고서", icon: FileText, path: "/report" },
];

const settingsItem: NavItem = {
  id: "settings", label: "설정", icon: Settings, path: "/settings",
};

// ─── 공항 ICAO → 한글명 ─────────────────────────────────────────────
const AIRPORT_NAMES: Record<string, string> = {
  // 한국 국제공항
  RKSI: "인천", RKSS: "김포", RKPK: "김해", RKPC: "제주",
  RKTN: "대구", RKJJ: "광주", RKNY: "양양", RKTU: "청주",
  RKJK: "군산", RKNW: "원주", RKJY: "여수", RKPU: "울산",
  RKPS: "사천", RKTH: "포항", RKJB: "무안",
  // 한국 군용/기타
  RKSO: "K-55", RKSG: "평택", RKSM: "성남", RKSE: "서울",
  RKSW: "K-13", RKTI: "K-75", RKJM: "목포", RKTE: "예천",
  RKTP: "패평", RKNN: "강릉", RKNC: "춘천", RKRA: "안동",
  RKRN: "속초", RKUL: "G-536", RKRB: "G-103",
  // 일본 주요
  RJTT: "하네다", RJAA: "나리타", RJBB: "간사이", RJOO: "이타미",
  RJFF: "후쿠오카", RJCC: "신치토세", RJGG: "주부", RJSN: "니가타",
  RJFK: "가고시마", RJNK: "고마츠", ROAH: "나하",
  // 중국 주요
  ZBAA: "베이징", ZSPD: "상하이푸동", ZSSS: "상하이홍차오",
  ZGGG: "광저우", ZGSZ: "선전", ZUUU: "청두", VHHH: "홍콩",
  RCTP: "타오위안", RCSS: "쑹산",
  // 동남아/기타
  WSSS: "싱가포르", VTBS: "수완나품", RPLL: "마닐라",
  WIII: "자카르타", RKDD: "동두천",
};

/** 공항 ICAO → 상세 설명 (툴팁용) */
const AIRPORT_TOOLTIP: Record<string, string> = {
  RKSO: "K-55 전술항공작전기지",
  RKSW: "K-13 전술항공작전기지",
  RKTI: "K-75 전술항공작전기지",
  RKUL: "G-536 지원항공작전기지",
  RKRB: "G-103 헬기전용작전기지",
};

function airportLabel(code: string | null | undefined): string {
  if (!code) return "?";
  const name = AIRPORT_NAMES[code.toUpperCase()];
  return name ? `${code}(${name})` : code;
}

function airportTooltip(code: string | null | undefined): string | undefined {
  if (!code) return undefined;
  return AIRPORT_TOOLTIP[code.toUpperCase()];
}

// ─── 항적지도 탭: 운항이력 패널 ──────────────────────────────────────

function MapFlightPanel() {
  const aircraft = useAppStore((s) => s.aircraft);
  const flightHistory = useAppStore((s) => s.flightHistory);
  const selectedFlight = useAppStore((s) => s.selectedFlight);
  const setSelectedFlight = useAppStore((s) => s.setSelectedFlight);
  const openskySync = useAppStore((s) => s.openskySync);
  const openskySyncProgress = useAppStore((s) => s.openskySyncProgress);
  const mergeFlights = useAppStore((s) => s.mergeFlights);
  const setFlightHistory = useAppStore((s) => s.setFlightHistory);

  const activeAircraft = useMemo(
    () => aircraft.filter((a) => a.active && a.mode_s_code),
    [aircraft]
  );

  // 같은 날 4시간 이내 출발/도착 레코드 병합
  const mergedFlightHistory = useMemo(
    () => mergeFlightRecords(flightHistory),
    [flightHistory]
  );

  const [selectedAcId, setSelectedAcId] = useState<string | "__ALL__">("__ALL__");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  // 수동 병합용 다중 선택
  const [mergeMode, setMergeMode] = useState(false);
  const [mergeSelection, setMergeSelection] = useState<Set<string>>(new Set());

  // 선택된 항공기에 따른 비행 기록 필터 (최신순)
  const flights = useMemo(() => {
    if (selectedAcId === "__ALL__") {
      return [...mergedFlightHistory].sort((a, b) => b.first_seen - a.first_seen);
    }
    const ac = activeAircraft.find((a) => a.id === selectedAcId);
    if (!ac) return [];
    const ms = ac.mode_s_code.toLowerCase();
    return mergedFlightHistory
      .filter((f) => f.icao24.toLowerCase() === ms)
      .sort((a, b) => b.first_seen - a.first_seen);
  }, [selectedAcId, activeAircraft, mergedFlightHistory]);

  // 선택 항공기 이름
  const selectedLabel = selectedAcId === "__ALL__"
    ? "전체"
    : activeAircraft.find((a) => a.id === selectedAcId)?.name ?? "전체";

  // icao24 → 항공기 이름 매핑
  const icaoToName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const ac of activeAircraft) {
      m[ac.mode_s_code.toLowerCase()] = ac.name;
    }
    return m;
  }, [activeAircraft]);

  const setSelectedModeS = useAppStore((s) => s.setSelectedModeS);
  const setSelectedFlightId = useAppStore((s) => s.setSelectedFlightId);
  const storeFlights = useAppStore((s) => s.flights);

  // 항공기 인덱스 → 색상 매핑
  const acColorMap = useMemo(() => {
    const m: Record<string, [number, number, number]> = {};
    activeAircraft.forEach((ac, i) => {
      m[ac.mode_s_code.toLowerCase()] = AIRCRAFT_COLORS[i % AIRCRAFT_COLORS.length];
    });
    return m;
  }, [activeAircraft]);

  // FlightRecord → 대응하는 store Flight ID 찾기
  const findStoreFlightId = useCallback((f: FlightRecord): string | null => {
    const modeS = f.icao24.toUpperCase();
    const matched = storeFlights.find((sf) =>
      sf.mode_s.toUpperCase() === modeS &&
      sf.start_time <= f.last_seen + 300 &&
      sf.end_time >= f.first_seen - 300
    );
    return matched?.id ?? null;
  }, [storeFlights]);

  // FlightRecord 고유 키 (병합 선택용)
  const flightRecordKey = useCallback(
    (f: FlightRecord) => `${f.icao24.toUpperCase()}_${f.first_seen}`,
    []
  );

  const handleSelect = (f: FlightRecord) => {
    // 병합 모드: FlightRecord 키 기반 다중 선택 토글
    if (mergeMode) {
      const key = flightRecordKey(f);
      setMergeSelection((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      return;
    }

    const isSame =
      selectedFlight?.icao24 === f.icao24 &&
      selectedFlight?.first_seen === f.first_seen;
    if (isSame) {
      setSelectedFlight(null);
      setSelectedModeS(null);
      setSelectedFlightId(null);
    } else {
      setSelectedFlight(f);
      setSelectedModeS(f.icao24.toUpperCase());
      const flightId = findStoreFlightId(f);
      setSelectedFlightId(flightId);
    }
  };

  // flightHistory에서 선택된 FlightRecord들을 하나로 병합
  const mergeSelectedFlightHistory = () => {
    const selectedRecords = flights.filter((f) => mergeSelection.has(flightRecordKey(f)));
    if (selectedRecords.length < 2) return;
    const selectedKeys = new Set(selectedRecords.map((r) => flightRecordKey(r)));
    const sorted = [...selectedRecords].sort((a, b) => a.first_seen - b.first_seen);
    const mergedRecord: FlightRecord = {
      ...sorted[0],
      first_seen: Math.min(...sorted.map((r) => r.first_seen)),
      last_seen: Math.max(...sorted.map((r) => r.last_seen)),
      est_departure_airport: sorted.find((r) => r.est_departure_airport)?.est_departure_airport ?? null,
      est_arrival_airport: [...sorted].reverse().find((r) => r.est_arrival_airport)?.est_arrival_airport ?? null,
      callsign: sorted.find((r) => r.callsign)?.callsign ?? null,
    };
    // 원본 flightHistory에서 선택된 레코드 제거 + 병합본 추가
    const currentHistory = useAppStore.getState().flightHistory;
    const remaining = currentHistory.filter((r) => !selectedKeys.has(flightRecordKey(r)));
    setFlightHistory([...remaining, mergedRecord]);
  };

  // 병합 실행: FlightRecord 키 → store Flight ID 매핑 후 병합
  const handleMerge = () => {
    if (mergeSelection.size < 2) return;
    const currentFlights = useAppStore.getState().flights;

    // 선택된 FlightRecord 키에 대응하는 store Flight ID 수집
    const storeFlightIds = new Set<string>();
    for (const f of flights) {
      const key = flightRecordKey(f);
      if (!mergeSelection.has(key)) continue;
      const modeS = f.icao24.toUpperCase();
      for (const sf of currentFlights) {
        if (
          sf.mode_s.toUpperCase() === modeS &&
          sf.start_time <= f.last_seen + 300 &&
          sf.end_time >= f.first_seen - 300
        ) {
          storeFlightIds.add(sf.id);
        }
      }
    }

    if (storeFlightIds.size < 2) {
      // 같은 store Flight에 매핑된 경우 → 같은 날 같은 항공기 전체 비행 수집
      const selectedRecords = flights.filter((f) => mergeSelection.has(flightRecordKey(f)));
      if (selectedRecords.length >= 2) {
        const modeS = selectedRecords[0].icao24.toUpperCase();
        // 선택된 레코드의 날짜 범위 (같은 날)
        const minTs = Math.min(...selectedRecords.map((r) => r.first_seen));
        const maxTs = Math.max(...selectedRecords.map((r) => r.last_seen));
        for (const sf of currentFlights) {
          if (
            sf.mode_s.toUpperCase() === modeS &&
            sf.start_time <= maxTs + 300 &&
            sf.end_time >= minTs - 300
          ) {
            storeFlightIds.add(sf.id);
          }
        }
      }
      if (storeFlightIds.size < 2) {
        // 항적 없이 FlightRecord 시각 기준으로 병합 (빈 Flight 생성)
        const selectedRecords = flights.filter((f) => mergeSelection.has(flightRecordKey(f)));
        if (selectedRecords.length < 2) {
          alert("병합할 수 있는 비행이 2개 이상 필요합니다.");
          return;
        }
        const modeS = selectedRecords[0].icao24.toUpperCase();
        if (!selectedRecords.every((r) => r.icao24.toUpperCase() === modeS)) {
          alert("같은 항공기(Mode-S)의 비행만 병합할 수 있습니다.");
          return;
        }
        // FlightRecord 메타데이터로 빈 Flight 생성 후 store에 추가
        const sorted = [...selectedRecords].sort((a, b) => a.first_seen - b.first_seen);
        const startTime = sorted[0].first_seen;
        const endTime = sorted[sorted.length - 1].last_seen;
        const callsign = sorted.find((r) => r.callsign)?.callsign ?? undefined;
        const departure = sorted.find((r) => r.est_departure_airport)?.est_departure_airport ?? undefined;
        const arrival = [...sorted].reverse().find((r) => r.est_arrival_airport)?.est_arrival_airport ?? undefined;
        // 기존 store Flight 중 시간범위 내 있는 것들의 track_points 수집
        const allPoints: import("../../types").TrackPoint[] = [];
        for (const sf of currentFlights) {
          if (sf.mode_s.toUpperCase() === modeS && sf.start_time <= endTime + 300 && sf.end_time >= startTime - 300) {
            allPoints.push(...sf.track_points);
          }
        }
        const acName = activeAircraft.find((a) => a.mode_s_code.toUpperCase() === modeS)?.name;
        const mergedFlight: import("../../types").Flight = {
          id: `${modeS}_${startTime}`,
          mode_s: modeS,
          aircraft_name: acName,
          callsign,
          departure_airport: departure,
          arrival_airport: arrival,
          start_time: startTime,
          end_time: endTime,
          track_points: allPoints.sort((a, b) => a.timestamp - b.timestamp),
          loss_points: [],
          loss_segments: [],
          total_loss_time: 0,
          total_track_time: endTime - startTime,
          loss_percentage: 0,
          max_radar_range_km: 0,
          match_type: "manual",
        };
        // 기존 flights에서 겹치는 것 제거 후 병합된 Flight 추가
        const state = useAppStore.getState();
        const overlapping = new Set(currentFlights
          .filter((sf) => sf.mode_s.toUpperCase() === modeS && sf.start_time <= endTime + 300 && sf.end_time >= startTime - 300)
          .map((sf) => sf.id));
        const remaining = currentFlights.filter((f) => !overlapping.has(f.id));
        state.setFlights([...remaining, mergedFlight].sort((a, b) => a.start_time - b.start_time));
        mergeSelectedFlightHistory();
        setMergeMode(false);
        setMergeSelection(new Set());
        setSelectedFlightId(null);
        return;
      }
    }

    const selected = currentFlights.filter((f) => storeFlightIds.has(f.id));
    const modeS = selected[0].mode_s.toUpperCase();
    if (!selected.every((f) => f.mode_s.toUpperCase() === modeS)) {
      alert("같은 항공기(Mode-S)의 비행만 병합할 수 있습니다.");
      return;
    }
    mergeFlights(Array.from(storeFlightIds));
    mergeSelectedFlightHistory();
    setMergeMode(false);
    setMergeSelection(new Set());
    setSelectedFlightId(null);
  };

  // 병합 모드 취소
  const handleMergeCancel = () => {
    setMergeMode(false);
    setMergeSelection(new Set());
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 헤더: 항공기 드롭다운 + 병합 뱃지 + 동기화 상태 */}
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <div className="relative flex-1">
          <button
            onClick={() => !mergeMode && setDropdownOpen(!dropdownOpen)}
            className={`flex w-full items-center justify-between rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] font-medium text-gray-700 hover:border-gray-300 transition-colors ${mergeMode ? "opacity-50 pointer-events-none" : ""}`}
          >
            <span className="truncate">{selectedLabel}</span>
            <ChevronDown size={12} className={`shrink-0 text-gray-400 transition-transform ${dropdownOpen ? "rotate-180" : ""}`} />
          </button>
          {dropdownOpen && (
            <div className="absolute left-0 right-0 top-full z-20 mt-0.5 rounded-md border border-gray-200 bg-white shadow-lg py-0.5">
              <button
                onClick={() => { setSelectedAcId("__ALL__"); setDropdownOpen(false); }}
                className={`w-full px-2 py-1 text-left text-[11px] hover:bg-gray-50 ${selectedAcId === "__ALL__" ? "font-semibold text-[#a60739]" : "text-gray-600"}`}
              >
                전체 ({mergedFlightHistory.length})
              </button>
              {activeAircraft.map((ac) => {
                const count = mergedFlightHistory.filter(
                  (f) => f.icao24.toLowerCase() === ac.mode_s_code.toLowerCase()
                ).length;
                return (
                  <button
                    key={ac.id}
                    onClick={() => { setSelectedAcId(ac.id); setDropdownOpen(false); }}
                    className={`w-full px-2 py-1 text-left text-[11px] hover:bg-gray-50 ${selectedAcId === ac.id ? "font-semibold text-[#a60739]" : "text-gray-600"}`}
                  >
                    {ac.name}
                    <span className="ml-1 text-gray-400">({count})</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {/* 병합 뱃지 */}
        {!mergeMode ? (
          <button
            onClick={() => { setMergeMode(true); setMergeSelection(new Set()); }}
            title="비행 수동 병합"
            className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 hover:bg-gray-200 hover:text-gray-700 transition-colors"
          >
            병합
          </button>
        ) : (
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={handleMerge}
              disabled={mergeSelection.size < 2}
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold transition-colors ${
                mergeSelection.size >= 2
                  ? "bg-[#a60739] text-white hover:bg-[#8a0630]"
                  : "bg-gray-100 text-gray-300 cursor-not-allowed"
              }`}
            >
              병합({mergeSelection.size})
            </button>
            <button
              onClick={handleMergeCancel}
              className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-gray-200 transition-colors"
            >
              취소
            </button>
          </div>
        )}
        {openskySync && (
          <Loader2 size={12} className="shrink-0 animate-spin text-[#a60739]" />
        )}
      </div>

      {/* 병합 모드 안내 */}
      {mergeMode && (
        <div className="px-2 pb-1">
          <p className="text-[10px] text-[#a60739]">병합할 비행을 2개 이상 선택하세요</p>
        </div>
      )}

      {/* 동기화 에러만 표시 (진행상태는 숨김) */}
      {openskySyncProgress && openskySyncProgress.includes("확인하세요") && (
        <div className="px-2 pb-1">
          <p className="text-[10px] truncate text-red-500">{openskySyncProgress}</p>
        </div>
      )}

      {/* 비행 목록 */}
      <div className="flex-1 overflow-y-auto px-1.5 pb-2 scrollbar-thin">
        {flights.length === 0 ? (
          <div className="py-6 text-center text-[11px] text-gray-400">
            {openskySync ? "조회 중..." : "운항 기록 없음"}
          </div>
        ) : (
          <div className="space-y-0.5">
            {flights.map((f) => {
              const isMergeSelected = mergeMode && mergeSelection.has(flightRecordKey(f));
              const isSelected = !mergeMode &&
                selectedFlight?.icao24 === f.icao24 &&
                selectedFlight?.first_seen === f.first_seen;
              const date = new Date(f.first_seen * 1000);
              const dur = Math.round((f.last_seen - f.first_seen) / 60);
              const acName = selectedAcId === "__ALL__"
                ? icaoToName[f.icao24.toLowerCase()]
                : undefined;
              const pointColor = acColorMap[f.icao24.toLowerCase()] ?? [128, 128, 128];
              return (
                <button
                  key={`${f.icao24}_${f.first_seen}`}
                  onClick={() => handleSelect(f)}
                  className={`w-full rounded-md px-2 py-1.5 text-left transition-colors ${
                    isMergeSelected
                      ? "ring-2 ring-[#a60739] bg-[#a60739]/10"
                      : isSelected ? "" : "hover:bg-gray-50"
                  }`}
                  style={isSelected && !mergeMode ? { backgroundColor: `rgb(${pointColor[0]},${pointColor[1]},${pointColor[2]})` } : undefined}
                >
                  {/* 날짜 + 시각 + 시간 + 콜사인/항공기명 */}
                  <div className="flex items-center justify-between">
                    <span className={`text-[11px] font-medium ${isSelected ? "text-white" : "text-gray-700"}`}>
                      {format(date, "yyyy/MM/dd (EEE)", { locale: ko })}
                      <span className={`ml-1 font-normal ${isSelected ? "text-white/70" : "text-gray-400"}`}>
                        {format(date, "HH:mm")}
                      </span>
                      <span className={`ml-0.5 font-normal ${isSelected ? "text-white/50" : "text-gray-300"}`}>
                        {dur}분
                      </span>
                    </span>
                    <span className={`text-[10px] font-mono ${isSelected ? "text-white/70" : "text-gray-400"}`}>
                      {acName ?? f.callsign?.trim() ?? "—"}
                    </span>
                  </div>
                  {/* 출발→도착 */}
                  <div className={`mt-0.5 flex items-center gap-1 text-[10px] ${isSelected ? "text-white/80" : "text-gray-500"}`}>
                    <span className={isSelected ? "text-white/90" : "text-gray-600"} title={airportTooltip(f.est_departure_airport)}>{airportLabel(f.est_departure_airport)}</span>
                    <span className={isSelected ? "text-white/40" : "text-gray-300"}>&rarr;</span>
                    <span className={isSelected ? "text-white/90" : "text-gray-600"} title={airportTooltip(f.est_arrival_airport)}>{airportLabel(f.est_arrival_airport)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Garble 분석 패널 ────────────────────────────────────────────────

function GarbleAircraftPanel() {
  const aircraft = useAppStore((s) => s.aircraft);
  const garblePoints = useAppStore((s) => s.garblePoints);
  const garbleSelectedModeS = useAppStore((s) => s.garbleSelectedModeS);
  const setGarbleSelectedModeS = useAppStore((s) => s.setGarbleSelectedModeS);
  const [search, setSearch] = useState("");

  // Mode-S → 항공기 이름 매핑
  const acNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of aircraft) {
      if (a.mode_s_code) {
        m.set(a.mode_s_code.toUpperCase(), a.name);
      }
    }
    return m;
  }, [aircraft]);

  const summaries = useMemo(
    () => summarizeGarbleByModeS(garblePoints, acNameMap),
    [garblePoints, acNameMap]
  );

  // 검색 필터
  const filtered = useMemo(() => {
    if (!search.trim()) return summaries;
    const q = search.trim().toUpperCase();
    return summaries.filter(
      (s) =>
        s.mode_s.toUpperCase().includes(q) ||
        (s.aircraftName && s.aircraftName.toUpperCase().includes(q))
    );
  }, [summaries, search]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 헤더 */}
      <div className="flex items-center gap-1.5 border-b border-gray-100 px-2 py-1.5">
        <Radio size={12} className="shrink-0 text-[#e94560]" />
        <span className="text-[11px] font-semibold text-gray-700">Garble 항공기</span>
        <span className="ml-auto text-[10px] text-gray-400">{summaries.length}</span>
      </div>

      {/* 검색 */}
      <div className="px-2 py-1.5">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Mode-S 검색..."
            className="w-full rounded-md border border-gray-200 bg-white py-1 pl-7 pr-2 text-[11px] text-gray-700 placeholder:text-gray-400 focus:border-gray-300 focus:outline-none"
          />
        </div>
      </div>

      {/* 항공기 목록 */}
      <div className="flex-1 overflow-y-auto px-1.5 pb-2 scrollbar-thin">
        {filtered.length === 0 ? (
          <div className="py-6 text-center text-[11px] text-gray-400">
            {garblePoints.length === 0 ? "Garble 데이터 없음" : "검색 결과 없음"}
          </div>
        ) : (
          <div className="space-y-0.5">
            {filtered.map((s) => {
              const isSelected = garbleSelectedModeS === s.mode_s;
              // 다중경로가 사이드로브보다 많으면 orange, 아니면 yellow
              const dominantColor =
                s.multipathCount > s.sidelobeCount
                  ? "rgb(249, 115, 22)"  // orange
                  : "rgb(234, 179, 8)";  // yellow
              return (
                <button
                  key={s.mode_s}
                  onClick={() =>
                    setGarbleSelectedModeS(isSelected ? null : s.mode_s)
                  }
                  className={`w-full rounded-md px-2 py-1.5 text-left transition-colors ${
                    isSelected
                      ? "bg-[#e94560]/10 ring-1 ring-[#e94560]/40"
                      : "hover:bg-gray-50"
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    {/* 유형 색상 점 */}
                    <div
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: dominantColor }}
                    />
                    {/* Mode-S 코드 */}
                    <span
                      className={`font-mono text-[11px] font-medium ${
                        isSelected ? "text-[#e94560]" : "text-gray-700"
                      }`}
                    >
                      {s.mode_s}
                    </span>
                    {/* 건수 */}
                    <span className="ml-auto text-[10px] text-gray-400">
                      {s.totalCount}건
                    </span>
                  </div>
                  {/* 기체명 (있으면) */}
                  {s.aircraftName && (
                    <div className="mt-0.5 pl-3.5 text-[10px] text-gray-500">
                      {s.aircraftName}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── 업로드 탭: 데이터 관리 패널 ──────────────────────────────────────

function UploadDataPanel() {
  const [openModal, setOpenModal] = useState<"srtm" | "building" | "db" | "opensky" | null>(null);

  const items = [
    { key: "srtm" as const, icon: Mountain, label: "SRTM 지형", color: "text-emerald-600" },
    { key: "building" as const, icon: Building2, label: "GIS 건물", color: "text-slate-600" },
    { key: "db" as const, icon: Database, label: "DB 관리", color: "text-[#a60739]" },
    { key: "opensky" as const, icon: Key, label: "운항이력 API", color: "text-amber-600" },
  ];

  return (
    <>
      <div className="flex flex-col gap-0.5 px-2 py-1.5">
        {items.map(({ key, icon: Icon, label, color }) => (
          <button
            key={key}
            onClick={() => setOpenModal(key)}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[11px] font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors"
          >
            <Icon size={13} className={`shrink-0 ${color}`} />
            {label}
          </button>
        ))}
      </div>

      {openModal && <UploadDataModal type={openModal} onClose={() => setOpenModal(null)} />}
    </>
  );
}

/** 모달을 별도 컴포넌트로 분리하여 내부 섹션이 openModal 변경 시에만 마운트 */
function UploadDataModal({ type, onClose }: { type: "srtm" | "building" | "db" | "opensky"; onClose: () => void }) {
  // lazy import로 Settings.tsx에서 가져오기
  const [Comp, setComp] = useState<React.ComponentType | null>(null);
  const [title, setTitle] = useState("");

  React.useEffect(() => {
    import("../../pages/Settings").then((mod) => {
      if (type === "srtm") {
        setComp(() => mod.SrtmDownloadSection);
        setTitle("SRTM 지형 데이터");
      } else if (type === "building") {
        setComp(() => mod.BuildingDataSection);
        setTitle("건물 데이터 (GIS건물통합정보)");
      } else if (type === "opensky") {
        setComp(() => mod.OpenSkyCredentialsSection);
        setTitle("운항이력 API 인증");
      } else {
        setComp(() => mod.DatabaseSection);
        setTitle("데이터베이스 관리");
      }
    });
  }, [type]);

  if (!Comp) return null;

  return (
    <Modal open onClose={onClose} title={title} width="max-w-xl">
      <Comp />
    </Modal>
  );
}

// ─── 보고서 탭: 메타데이터 패널 ──────────────────────────────────────

function ReportMetadataPanel() {
  const reportMetadata = useAppStore((s) => s.reportMetadata);
  const setReportMetadata = useAppStore((s) => s.setReportMetadata);
  const [modalOpen, setModalOpen] = useState(false);

  const fields = [
    { label: "기관", value: reportMetadata.organization },
    { label: "부서", value: reportMetadata.department },
    { label: "현장", value: reportMetadata.siteName },
    { label: "작성자", value: reportMetadata.author || "—" },
    { label: "문서접두", value: reportMetadata.docPrefix },
  ];

  return (
    <>
      <div className="flex flex-col gap-0.5 px-2 py-1.5">
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">보고서 메타데이터</span>
          <button
            onClick={() => setModalOpen(true)}
            className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
            title="메타데이터 수정"
          >
            <Pencil size={11} />
          </button>
        </div>
        {fields.map(({ label, value }) => (
          <div key={label} className="flex items-center justify-between px-2 py-0.5">
            <span className="text-[11px] text-gray-400">{label}</span>
            <span className="text-[11px] font-medium text-gray-600 truncate ml-2 max-w-[120px]">{value}</span>
          </div>
        ))}
      </div>

      {modalOpen && (
        <ReportMetadataModal
          metadata={reportMetadata}
          onSave={(meta) => { setReportMetadata(meta); setModalOpen(false); }}
          onClose={() => setModalOpen(false)}
        />
      )}
    </>
  );
}

function ReportMetadataModal({
  metadata,
  onSave,
  onClose,
}: {
  metadata: { department: string; author: string; docPrefix: string; organization: string; siteName: string; footer: string };
  onSave: (meta: Partial<typeof metadata>) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState({ ...metadata });

  const fields: { key: keyof typeof form; label: string; placeholder: string }[] = [
    { key: "organization", label: "기관명", placeholder: "예: 김포공항" },
    { key: "department", label: "부서명", placeholder: "예: 레이더관제부" },
    { key: "siteName", label: "현장명", placeholder: "예: 레이더송신소" },
    { key: "author", label: "작성자", placeholder: "예: 홍길동" },
    { key: "docPrefix", label: "문서번호 접두사", placeholder: "예: RDR-RPT" },
    { key: "footer", label: "하단 푸터", placeholder: "보고서 하단 문구" },
  ];

  return (
    <Modal open onClose={onClose} title="보고서 기본 메타데이터" width="max-w-md">
      <div className="space-y-3">
        {fields.map(({ key, label, placeholder }) => (
          <div key={key}>
            <label className="mb-1 block text-xs font-medium text-gray-600">{label}</label>
            <input
              type="text"
              value={form[key]}
              onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
              placeholder={placeholder}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800 placeholder:text-gray-400 focus:border-[#a60739] focus:outline-none focus:ring-1 focus:ring-[#a60739]/20"
            />
          </div>
        ))}
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
          >
            취소
          </button>
          <button
            onClick={() => onSave(form)}
            className="rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white hover:bg-[#85062e] transition-colors"
          >
            저장
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── 전파 장애물 (파노라마) 패널 ─────────────────────────────────────

function PanoramaObstaclePanel() {
  const pt = useAppStore((s) => s.panoramaActivePoint);
  const pinned = useAppStore((s) => s.panoramaPinned);

  if (!pt) {
    return (
      <div className="flex flex-col items-center justify-center gap-1.5 py-4 text-center">
        <Eye size={16} className="text-gray-300" />
        <p className="text-[10px] text-gray-400">
          차트 위를 호버하거나 클릭하여<br />장애물 정보를 확인하세요
        </p>
      </div>
    );
  }

  const isBuilding = pt.obstacle_type !== "terrain";
  const typeLabel =
    pt.obstacle_type === "terrain" ? "지형"
    : pt.obstacle_type === "gis_building" ? "GIS 건물"
    : "수동 건물";
  const typeColor =
    pt.obstacle_type === "terrain" ? "bg-green-100 text-green-700"
    : pt.obstacle_type === "gis_building" ? "bg-orange-100 text-orange-700"
    : "bg-red-100 text-red-700";
  const elevASL = isBuilding
    ? pt.ground_elev_m + pt.obstacle_height_m
    : pt.ground_elev_m;

  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      {/* 유형 뱃지 + 이름 + 고정 상태 */}
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={`shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium ${typeColor}`}>
          {typeLabel}
        </span>
        {pinned && (
          <span className="shrink-0 whitespace-nowrap rounded bg-yellow-100 px-1 py-0.5 text-[9px] text-yellow-700">
            고정
          </span>
        )}
        {pt.name && (
          <span className="min-w-0 text-[11px] font-semibold text-gray-800 truncate" title={pt.name}>
            {pt.name}
          </span>
        )}
      </div>

      {/* 공통 수치 — 모든 유형 동일 위치 */}
      <div className="grid grid-cols-3 gap-x-2 gap-y-1">
        <div>
          <span className="text-[9px] text-gray-400">방위</span>
          <p className="font-mono text-[11px] font-medium text-gray-700">{pt.azimuth_deg.toFixed(1)}°</p>
        </div>
        <div>
          <span className="text-[9px] text-gray-400">앙각</span>
          <p className="font-mono text-[11px] font-medium text-gray-700">{pt.elevation_angle_deg.toFixed(3)}°</p>
        </div>
        <div>
          <span className="text-[9px] text-gray-400">거리</span>
          <p className="font-mono text-[11px] font-medium text-gray-700">{pt.distance_km.toFixed(2)} km</p>
        </div>
      </div>

      {/* 높이 정보 — 동일 그리드, 유형별 추가 필드 */}
      <div className="grid grid-cols-3 gap-x-2 gap-y-1">
        <div>
          <span className="text-[9px] text-gray-400">해발고도</span>
          <p className="font-mono text-[11px] font-medium text-gray-700">{elevASL.toFixed(0)} m</p>
        </div>
        <div>
          <span className="text-[9px] text-gray-400">지면표고</span>
          <p className="font-mono text-[11px] font-medium text-gray-700">{pt.ground_elev_m.toFixed(0)} m</p>
        </div>
        {isBuilding ? (
          <div>
            <span className="text-[9px] text-gray-400">건물높이</span>
            <p className="font-mono text-[11px] font-medium text-gray-700">{pt.obstacle_height_m.toFixed(1)} m</p>
          </div>
        ) : (
          <div />
        )}
      </div>

      {/* 좌표 */}
      <div className="flex items-center gap-1 text-[10px] text-gray-500">
        <MapPin size={10} className="shrink-0 text-gray-400" />
        <span className="font-mono">{pt.lat.toFixed(5)}°N {pt.lon.toFixed(5)}°E</span>
      </div>

      {/* 건물 추가 정보: 주소/용도 */}
      {isBuilding && (pt.address || pt.usage) && (
        <div className="border-t border-gray-100 pt-1.5 space-y-0.5">
          {pt.address && (
            <div>
              <span className="text-[9px] text-gray-400">주소</span>
              <p className="text-[10px] text-gray-600 break-words">{pt.address}</p>
            </div>
          )}
          {pt.usage && (
            <div>
              <span className="text-[9px] text-gray-400">용도</span>
              <p className="text-[10px] text-gray-600">{pt.usage}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── 사이드바 메인 ───────────────────────────────────────────────────

export default function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const setActivePage = useAppStore((s) => s.setActivePage);
  const [collapsed, setCollapsed] = useState(false);
  const [edgeHover, setEdgeHover] = useState(false);
  const [mouseY, setMouseY] = useState(0);

  const handleNav = (item: NavItem) => {
    setActivePage(item.id);
    navigate(item.path);
  };

  const isActive = (item: NavItem) => {
    if (item.path === "/") return location.pathname === "/";
    return location.pathname.startsWith(item.path);
  };

  const handleEdgeMove = useCallback((e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setMouseY(e.clientY - rect.top);
  }, []);

  // 현재 페이지에 따른 하단 패널
  const isUploadPage = location.pathname === "/";
  const isMapPage = location.pathname === "/map";
  const isDrawingPage = location.pathname === "/drawing";
  const isReportPage = location.pathname === "/report";
  const garbleViewActive = useAppStore((s) => s.garbleViewActive);
  const panoramaViewActive = useAppStore((s) => s.panoramaViewActive);

  return (
    <div className="relative flex h-full shrink-0">
      <aside
        className={`flex h-full flex-col bg-white transition-[width] duration-200 ${
          collapsed ? "w-14" : "w-56"
        }`}
      >
        {/* App header + 설정 */}
        <div className="flex h-8 shrink-0 items-center px-2" data-tauri-drag-region>
          <button
            onClick={() => handleNav(settingsItem)}
            title="설정"
            className={`flex h-6 items-center gap-1.5 rounded px-1.5 text-xs font-medium transition-colors pointer-events-auto ${
              isActive(settingsItem)
                ? "text-[#a60739]"
                : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            }`}
          >
            <Settings size={12} className="shrink-0" />
            {!collapsed && <span>설정</span>}
          </button>
        </div>

        {/* Navigation */}
        <nav className="px-2 py-2">
          <div className="space-y-1">
            {navItems.map((item) => {
              const active = isActive(item);
              return (
                <button
                  key={item.id}
                  onClick={() => handleNav(item)}
                  title={collapsed ? item.label : undefined}
                  className={`flex w-full items-center rounded-lg py-2.5 text-sm font-medium transition-all ${
                    collapsed ? "justify-center px-0" : "gap-3 px-3"
                  } ${
                    active
                      ? "bg-[#a60739] text-white shadow-sm"
                      : "text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                  }`}
                >
                  <item.icon size={18} className="shrink-0" />
                  {!collapsed && <span className="whitespace-nowrap">{item.label}</span>}
                </button>
              );
            })}
          </div>
        </nav>

        {/* 전파 장애물 (파노라마) 활성 시 장애물 정보 패널 — nav 바로 아래 */}
        {!collapsed && panoramaViewActive && (
          <div className="border-t border-gray-100 overflow-y-auto">
            <PanoramaObstaclePanel />
          </div>
        )}

        {/* 업로드 탭: 데이터 관리 버튼 */}
        {!collapsed && isUploadPage && (
          <div className="mt-auto border-t border-gray-100">
            <UploadDataPanel />
          </div>
        )}

        {/* 보고서 탭: 메타데이터 패널 */}
        {!collapsed && isReportPage && (
          <div className="mt-auto border-t border-gray-100">
            <ReportMetadataPanel />
          </div>
        )}

        {/* 탭별 하단 컨텍스트 패널 */}
        {!collapsed && (isMapPage || isDrawingPage) && (
          <div className="flex flex-1 flex-col overflow-hidden border-t border-gray-100">
            <MapFlightPanel />
          </div>
        )}

        {/* Garble 분석 활성 시 항공기 패널 */}
        {!collapsed && garbleViewActive && (
          <div className="flex flex-1 flex-col overflow-hidden border-t border-gray-100">
            <GarbleAircraftPanel />
          </div>
        )}
      </aside>

      {/* 경계선 + 호버 토글 핸들 */}
      <div
        className="relative flex-shrink-0 w-px cursor-pointer"
        onMouseEnter={() => setEdgeHover(true)}
        onMouseLeave={() => setEdgeHover(false)}
        onMouseMove={handleEdgeMove}
        onClick={() => setCollapsed(!collapsed)}
        style={{ padding: "0 6px", margin: "0 -6px" }}
      >
        {/* 시각적 1px 경계선 (타이틀바 아래부터) */}
        <div className="absolute left-1/2 top-8 bottom-0 w-px -translate-x-px bg-gray-200 pointer-events-none" />
        <div
          className={`absolute left-1/2 flex h-6 w-4 items-center justify-center rounded-r-md border border-l-0 border-gray-300 bg-white shadow-sm transition-all duration-150 ${
            edgeHover ? "opacity-100 scale-100" : "opacity-0 scale-75"
          }`}
          style={{ top: Math.max(8, Math.min(mouseY - 12, 9999)) }}
        >
          {collapsed
            ? <ChevronRight size={10} className="text-gray-400" />
            : <ChevronLeft size={10} className="text-gray-400" />
          }
        </div>
      </div>
    </div>
  );
}
