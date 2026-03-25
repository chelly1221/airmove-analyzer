import { useState, useMemo, useCallback } from "react";
import { Filter, X, Plane, CheckSquare, Square } from "lucide-react";
import Modal from "./Modal";
import type { Aircraft } from "../../types";

/** 필터 논리 (조건 간 결합) */
export type FilterLogic = "and" | "or";

/** 파싱 필터 결과 */
export interface ParseFilterResult {
  modeSFilter: string[];
  mode3aFilter: number[];
  filterLogic: FilterLogic;
  /** true이면 modeSFilter에 해당하는 항적을 제외 */
  modeSExclude: boolean;
  /** true이면 mode3aFilter에 해당하는 항적을 제외 */
  mode3aExclude: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onConfirm: (filter: ParseFilterResult) => void;
  aircraft: Aircraft[];
}

/** Squawk 코드 문자열(4자리 8진수)을 u16으로 변환 */
function parseSquawk(s: string): number | null {
  const trimmed = s.trim();
  if (!/^[0-7]{4}$/.test(trimmed)) return null;
  return parseInt(trimmed, 8);
}

/** u16 squawk 값을 4자리 8진수 문자열로 변환 */
function formatSquawk(v: number): string {
  return v.toString(8).padStart(4, "0");
}

export default function ParseFilterModal({ open, onClose, onConfirm, aircraft }: Props) {
  // 전체 데이터 모드
  const [noFilter, setNoFilter] = useState(false);

  // 비행검사기 선택
  const [selectedAircraftIds, setSelectedAircraftIds] = useState<Set<string>>(new Set());

  // Mode-S 직접 입력
  const [modeSInput, setModeSInput] = useState("");
  const [modeSList, setModeSList] = useState<string[]>([]);

  // Squawk 코드 입력
  const [squawkInput, setSquawkInput] = useState("");
  const [squawkList, setSquawkList] = useState<number[]>([]);

  // 조건 간 논리 (Mode-S 그룹과 Squawk 그룹 사이)
  const [filterLogic, setFilterLogic] = useState<FilterLogic>("and");

  // 각 그룹별 포함/제외 모드
  const [modeSExclude, setModeSExclude] = useState(false);
  const [squawkExclude, setSquawkExclude] = useState(false);

  const activeAircraft = useMemo(
    () => aircraft.filter((a) => a.active),
    [aircraft],
  );

  // 전체 선택 여부
  const allSelected = activeAircraft.length > 0 && activeAircraft.every((a) => selectedAircraftIds.has(a.id));

  const toggleAll = useCallback(() => {
    if (allSelected) {
      setSelectedAircraftIds(new Set());
    } else {
      setSelectedAircraftIds(new Set(activeAircraft.map((a) => a.id)));
    }
  }, [allSelected, activeAircraft]);

  const toggleAircraft = useCallback((id: string) => {
    setSelectedAircraftIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const addModeS = useCallback(() => {
    const code = modeSInput.trim().toUpperCase();
    if (code.length >= 4 && code.length <= 6 && /^[0-9A-F]+$/.test(code)) {
      if (!modeSList.includes(code)) {
        setModeSList((prev) => [...prev, code]);
      }
      setModeSInput("");
    }
  }, [modeSInput, modeSList]);

  const removeModeS = useCallback((code: string) => {
    setModeSList((prev) => prev.filter((c) => c !== code));
  }, []);

  const addSquawk = useCallback(() => {
    const val = parseSquawk(squawkInput);
    if (val !== null && !squawkList.includes(val)) {
      setSquawkList((prev) => [...prev, val]);
      setSquawkInput("");
    }
  }, [squawkInput, squawkList]);

  const removeSquawk = useCallback((val: number) => {
    setSquawkList((prev) => prev.filter((v) => v !== val));
  }, []);

  // Mode-S 필터: 선택된 비행검사기 + 직접 입력 합산
  const combinedModeSCodes = useMemo(() => {
    const codes = new Set<string>();
    for (const a of activeAircraft) {
      if (selectedAircraftIds.has(a.id)) {
        codes.add(a.mode_s_code.toUpperCase());
      }
    }
    for (const c of modeSList) {
      codes.add(c);
    }
    return [...codes];
  }, [activeAircraft, selectedAircraftIds, modeSList]);

  const hasModeSFilter = combinedModeSCodes.length > 0;
  const hasSquawkFilter = squawkList.length > 0;

  const handleConfirm = useCallback(() => {
    if (noFilter) {
      onConfirm({ modeSFilter: [], mode3aFilter: [], filterLogic: "and", modeSExclude: false, mode3aExclude: false });
      return;
    }
    onConfirm({
      modeSFilter: combinedModeSCodes,
      mode3aFilter: [...squawkList],
      filterLogic,
      modeSExclude,
      mode3aExclude: squawkExclude,
    });
  }, [noFilter, combinedModeSCodes, squawkList, filterLogic, modeSExclude, squawkExclude, onConfirm]);

  // 확인 가능: 전체 데이터이거나, 최소 하나의 필터 조건이 있어야 함
  const canConfirm = noFilter || hasModeSFilter || hasSquawkFilter;

  return (
    <Modal open={open} onClose={onClose} title="파싱 필터 설정" width="max-w-md">
      <div className="flex flex-col gap-3">
        {/* 전체 데이터 토글 */}
        <label className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${
          noFilter
            ? "border-[#a60739] bg-[#a60739]/5"
            : "border-gray-200 bg-white hover:border-gray-300"
        }`}>
          <input
            type="checkbox"
            checked={noFilter}
            onChange={(e) => setNoFilter(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-gray-300 text-[#a60739] accent-[#a60739]"
          />
          <div className="flex-1">
            <div className={`text-sm font-medium ${noFilter ? "text-[#a60739]" : "text-gray-700"}`}>
              전체 데이터
            </div>
            <div className={`text-[11px] ${noFilter ? "text-[#a60739]/60" : "text-gray-400"}`}>
              필터 없이 모든 항적 파싱
            </div>
          </div>
        </label>

        {!noFilter && (
          <>
            {/* Mode-S 필터 그룹 */}
            <div className="rounded-lg border border-gray-200 overflow-hidden">
              <div className="flex items-center gap-2 bg-gray-50 px-3 py-2 border-b border-gray-100">
                <Plane size={14} className="text-gray-500" />
                <span className="text-xs font-medium text-gray-600">Mode-S 필터</span>
                <div className="ml-auto flex items-center gap-1.5">
                  <div className="flex rounded-full border border-gray-200 overflow-hidden">
                    <button
                      onClick={() => setModeSExclude(false)}
                      className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                        !modeSExclude ? "bg-[#a60739] text-white" : "bg-white text-gray-400 hover:bg-gray-50"
                      }`}
                    >
                      포함
                    </button>
                    <button
                      onClick={() => setModeSExclude(true)}
                      className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                        modeSExclude ? "bg-red-500 text-white" : "bg-white text-gray-400 hover:bg-gray-50"
                      }`}
                    >
                      제외
                    </button>
                  </div>
                  {hasModeSFilter && (
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                      modeSExclude ? "text-red-500 bg-red-50" : "text-[#a60739] bg-[#a60739]/10"
                    }`}>
                      {combinedModeSCodes.length}건
                    </span>
                  )}
                </div>
              </div>
              <div className="p-3 flex flex-col gap-2.5">
                {/* 비행검사기 목록 */}
                {activeAircraft.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-[11px] text-gray-500">비행검사기</span>
                      <button
                        onClick={toggleAll}
                        className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-[#a60739] transition-colors"
                      >
                        {allSelected ? <CheckSquare size={12} /> : <Square size={12} />}
                        전체
                      </button>
                    </div>
                    <div className="flex flex-col gap-0.5 max-h-32 overflow-y-auto">
                      {activeAircraft.map((a) => {
                        const checked = selectedAircraftIds.has(a.id);
                        return (
                          <label
                            key={a.id}
                            className={`flex items-center gap-2 rounded-md px-2 py-1 cursor-pointer transition-colors ${
                              checked ? "bg-[#a60739]/5" : "hover:bg-gray-50"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleAircraft(a.id)}
                              className="h-3 w-3 rounded border-gray-300 text-[#a60739] accent-[#a60739]"
                            />
                            <span className="text-xs text-gray-700 font-medium">{a.name}</span>
                            <span className="text-[10px] text-gray-400">{a.registration}</span>
                            <span className="text-[10px] text-gray-400 ml-auto font-mono">{a.mode_s_code}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Mode-S 직접 입력 */}
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] text-gray-500">직접 입력</span>
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      value={modeSInput}
                      onChange={(e) => setModeSInput(e.target.value.toUpperCase())}
                      onKeyDown={(e) => { if (e.key === "Enter") addModeS(); }}
                      placeholder="Mode-S (예: 71BF79)"
                      maxLength={6}
                      className="flex-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-mono placeholder:text-gray-300 focus:border-[#a60739] focus:outline-none focus:ring-1 focus:ring-[#a60739]/20"
                    />
                    <button
                      onClick={addModeS}
                      disabled={!/^[0-9A-F]{4,6}$/.test(modeSInput.trim().toUpperCase())}
                      className="rounded-md bg-[#a60739] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[#8a062f] disabled:opacity-40 transition-colors"
                    >
                      추가
                    </button>
                  </div>
                  {modeSList.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {modeSList.map((code) => (
                        <span
                          key={code}
                          className="inline-flex items-center gap-0.5 rounded-full bg-[#a60739]/10 px-2 py-0.5 text-[11px] font-mono text-[#a60739]"
                        >
                          {code}
                          <button onClick={() => removeModeS(code)} className="hover:text-[#8a062f]">
                            <X size={10} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* AND/OR 토글 (양쪽 필터가 있을 때만 의미 있음) */}
            <div className="flex items-center justify-center gap-1">
              <div className="flex-1 h-px bg-gray-200" />
              <div className="flex rounded-full border border-gray-200 overflow-hidden">
                <button
                  onClick={() => setFilterLogic("and")}
                  className={`px-3 py-1 text-[11px] font-medium transition-colors ${
                    filterLogic === "and"
                      ? "bg-[#a60739] text-white"
                      : "bg-white text-gray-500 hover:bg-gray-50"
                  }`}
                >
                  AND
                </button>
                <button
                  onClick={() => setFilterLogic("or")}
                  className={`px-3 py-1 text-[11px] font-medium transition-colors ${
                    filterLogic === "or"
                      ? "bg-[#a60739] text-white"
                      : "bg-white text-gray-500 hover:bg-gray-50"
                  }`}
                >
                  OR
                </button>
              </div>
              <div className="flex-1 h-px bg-gray-200" />
            </div>

            {/* Squawk 필터 그룹 */}
            <div className="rounded-lg border border-gray-200 overflow-hidden">
              <div className="flex items-center gap-2 bg-gray-50 px-3 py-2 border-b border-gray-100">
                <Filter size={14} className="text-gray-500" />
                <span className="text-xs font-medium text-gray-600">Squawk 필터</span>
                <div className="ml-auto flex items-center gap-1.5">
                  <div className="flex rounded-full border border-gray-200 overflow-hidden">
                    <button
                      onClick={() => setSquawkExclude(false)}
                      className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                        !squawkExclude ? "bg-[#a60739] text-white" : "bg-white text-gray-400 hover:bg-gray-50"
                      }`}
                    >
                      포함
                    </button>
                    <button
                      onClick={() => setSquawkExclude(true)}
                      className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                        squawkExclude ? "bg-red-500 text-white" : "bg-white text-gray-400 hover:bg-gray-50"
                      }`}
                    >
                      제외
                    </button>
                  </div>
                  {hasSquawkFilter && (
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                      squawkExclude ? "text-red-500 bg-red-50" : "text-[#a60739] bg-[#a60739]/10"
                    }`}>
                      {squawkList.length}건
                    </span>
                  )}
                </div>
              </div>
              <div className="p-3 flex flex-col gap-1.5">
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={squawkInput}
                    onChange={(e) => setSquawkInput(e.target.value.replace(/[^0-7]/g, "").slice(0, 4))}
                    onKeyDown={(e) => { if (e.key === "Enter") addSquawk(); }}
                    placeholder="Squawk (예: 2000)"
                    maxLength={4}
                    className="flex-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-mono placeholder:text-gray-300 focus:border-[#a60739] focus:outline-none focus:ring-1 focus:ring-[#a60739]/20"
                  />
                  <button
                    onClick={addSquawk}
                    disabled={parseSquawk(squawkInput) === null}
                    className="rounded-md bg-[#a60739] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[#8a062f] disabled:opacity-40 transition-colors"
                  >
                    추가
                  </button>
                </div>
                <p className="text-[10px] text-gray-400">4자리 8진수 (0~7 숫자만 사용)</p>
                {squawkList.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {squawkList.map((val) => (
                      <span
                        key={val}
                        className="inline-flex items-center gap-0.5 rounded-full bg-[#a60739]/10 px-2 py-0.5 text-[11px] font-mono text-[#a60739]"
                      >
                        {formatSquawk(val)}
                        <button onClick={() => removeSquawk(val)} className="hover:text-[#8a062f]">
                          <X size={10} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* 필터 설명 */}
            {(hasModeSFilter || hasSquawkFilter) && (
              <p className="text-[10px] text-gray-400 text-center">
                {(() => {
                  const parts: string[] = [];
                  if (hasModeSFilter) parts.push(`Mode-S ${modeSExclude ? "제외" : "포함"}`);
                  if (hasModeSFilter && hasSquawkFilter) parts.push(filterLogic === "and" ? "AND" : "OR");
                  if (hasSquawkFilter) parts.push(`Squawk ${squawkExclude ? "제외" : "포함"}`);
                  return parts.join(" ");
                })()}
              </p>
            )}
          </>
        )}

        {/* 확인/취소 */}
        <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
          >
            취소
          </button>
          <button
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white hover:bg-[#8a062f] disabled:opacity-40 transition-colors"
          >
            파싱 시작
          </button>
        </div>
      </div>
    </Modal>
  );
}
