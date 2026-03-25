import { useState, useMemo, useCallback } from "react";
import { X, Plane, ChevronRight, ChevronDown, Plus, ShieldOff, Info } from "lucide-react";
import Modal from "./Modal";
import type { Aircraft } from "../../types";

/** 파싱 필터 결과 */
export interface ParseFilterResult {
  modeSInclude: string[];
  modeSExclude: string[];
  mode3aInclude: number[];
  mode3aExclude: number[];
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

  // 비행검사기 섹션
  const [selectedAircraftIds, setSelectedAircraftIds] = useState<Set<string>>(new Set());

  // 포함 조건 섹션
  const [includeExpanded, setIncludeExpanded] = useState(false);
  const [modeSIncludeInput, setModeSIncludeInput] = useState("");
  const [modeSIncludeList, setModeSIncludeList] = useState<string[]>([]);
  const [squawkIncludeInput, setSquawkIncludeInput] = useState("");
  const [squawkIncludeList, setSquawkIncludeList] = useState<number[]>([]);

  // 제외 조건 섹션
  const [excludeExpanded, setExcludeExpanded] = useState(false);
  const [modeSExcludeInput, setModeSExcludeInput] = useState("");
  const [modeSExcludeList, setModeSExcludeList] = useState<string[]>([]);
  const [squawkExcludeInput, setSquawkExcludeInput] = useState("");
  const [squawkExcludeList, setSquawkExcludeList] = useState<number[]>([]);

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

  // 포함 Mode-S 추가/삭제
  const addModeSInclude = useCallback(() => {
    const code = modeSIncludeInput.trim().toUpperCase();
    if (code.length >= 4 && code.length <= 6 && /^[0-9A-F]+$/.test(code)) {
      if (!modeSIncludeList.includes(code)) {
        setModeSIncludeList((prev) => [...prev, code]);
      }
      setModeSIncludeInput("");
    }
  }, [modeSIncludeInput, modeSIncludeList]);

  const removeModeSInclude = useCallback((code: string) => {
    setModeSIncludeList((prev) => prev.filter((c) => c !== code));
  }, []);

  // 포함 Squawk 추가/삭제
  const addSquawkInclude = useCallback(() => {
    const val = parseSquawk(squawkIncludeInput);
    if (val !== null && !squawkIncludeList.includes(val)) {
      setSquawkIncludeList((prev) => [...prev, val]);
      setSquawkIncludeInput("");
    }
  }, [squawkIncludeInput, squawkIncludeList]);

  const removeSquawkInclude = useCallback((val: number) => {
    setSquawkIncludeList((prev) => prev.filter((v) => v !== val));
  }, []);

  // 제외 Mode-S 추가/삭제
  const addModeSExclude = useCallback(() => {
    const code = modeSExcludeInput.trim().toUpperCase();
    if (code.length >= 4 && code.length <= 6 && /^[0-9A-F]+$/.test(code)) {
      if (!modeSExcludeList.includes(code)) {
        setModeSExcludeList((prev) => [...prev, code]);
      }
      setModeSExcludeInput("");
    }
  }, [modeSExcludeInput, modeSExcludeList]);

  const removeModeSExclude = useCallback((code: string) => {
    setModeSExcludeList((prev) => prev.filter((c) => c !== code));
  }, []);

  // 제외 Squawk 추가/삭제
  const addSquawkExclude = useCallback(() => {
    const val = parseSquawk(squawkExcludeInput);
    if (val !== null && !squawkExcludeList.includes(val)) {
      setSquawkExcludeList((prev) => [...prev, val]);
      setSquawkExcludeInput("");
    }
  }, [squawkExcludeInput, squawkExcludeList]);

  const removeSquawkExclude = useCallback((val: number) => {
    setSquawkExcludeList((prev) => prev.filter((v) => v !== val));
  }, []);

  // 비행검사기 Mode-S + 직접입력 포함 합산
  const combinedModeSInclude = useMemo(() => {
    const codes = new Set<string>();
    for (const a of activeAircraft) {
      if (selectedAircraftIds.has(a.id)) codes.add(a.mode_s_code.toUpperCase());
    }
    for (const c of modeSIncludeList) codes.add(c);
    return [...codes];
  }, [activeAircraft, selectedAircraftIds, modeSIncludeList]);

  const hasAnyFilter = combinedModeSInclude.length > 0 || squawkIncludeList.length > 0
    || modeSExcludeList.length > 0 || squawkExcludeList.length > 0;

  const canConfirm = noFilter || hasAnyFilter;

  const handleConfirm = useCallback(() => {
    if (noFilter) {
      onConfirm({ modeSInclude: [], modeSExclude: [], mode3aInclude: [], mode3aExclude: [] });
      return;
    }
    onConfirm({
      modeSInclude: combinedModeSInclude,
      modeSExclude: [...modeSExcludeList],
      mode3aInclude: [...squawkIncludeList],
      mode3aExclude: [...squawkExcludeList],
    });
  }, [noFilter, combinedModeSInclude, modeSExcludeList, squawkIncludeList, squawkExcludeList, onConfirm]);

  // 요약 텍스트
  const summaryParts: string[] = [];
  if (!noFilter) {
    const acCount = [...selectedAircraftIds].filter((id) => activeAircraft.some((a) => a.id === id)).length;
    if (acCount > 0) summaryParts.push(`비행검사기 ${acCount}대`);
    if (modeSIncludeList.length > 0) summaryParts.push(`포함 Mode-S ${modeSIncludeList.length}건`);
    if (squawkIncludeList.length > 0) summaryParts.push(`포함 Squawk ${squawkIncludeList.length}건`);
    if (modeSExcludeList.length > 0) summaryParts.push(`제외 Mode-S ${modeSExcludeList.length}건`);
    if (squawkExcludeList.length > 0) summaryParts.push(`제외 Squawk ${squawkExcludeList.length}건`);
  }

  const dimmed = noFilter;

  // 포함 조건 카운트
  const includeCount = modeSIncludeList.length + squawkIncludeList.length;
  // 제외 조건 카운트
  const excludeCount = modeSExcludeList.length + squawkExcludeList.length;

  return (
    <Modal open={open} onClose={onClose} title="파싱 필터 설정" width="max-w-md">
      <div className="flex flex-col gap-3">
        {/* ━━ 비행검사기 ━━ */}
        {activeAircraft.length > 0 && (
          <div className={`rounded-lg border border-gray-200 overflow-hidden transition-opacity ${dimmed ? "opacity-40 pointer-events-none" : ""}`}>
            <div className="flex items-center gap-2 bg-gray-50 px-3 py-2 border-b border-gray-100">
              <Plane size={14} className="text-gray-500" />
              <span className="text-xs font-medium text-gray-600">비행검사기</span>
              <button
                onClick={toggleAll}
                className="ml-auto text-[11px] text-gray-500 hover:text-[#a60739] transition-colors"
              >
                {allSelected ? "전체 해제" : "전체 선택"}
              </button>
            </div>
            <div className="p-2 flex flex-col gap-0.5 max-h-32 overflow-y-auto">
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

        {/* ━━ 포함 조건 ━━ */}
        <div className={`rounded-lg border border-gray-200 overflow-hidden transition-opacity ${dimmed ? "opacity-40 pointer-events-none" : ""}`}>
          <button
            onClick={() => setIncludeExpanded(!includeExpanded)}
            className="flex items-center gap-2 w-full bg-gray-50 px-3 py-2 border-b border-gray-100 hover:bg-gray-100 transition-colors"
          >
            {includeExpanded ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
            <Plus size={14} className="text-emerald-500" />
            <span className="text-xs font-medium text-gray-600">포함 조건</span>
            {includeCount > 0 && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full text-emerald-600 bg-emerald-50 ml-auto">
                {includeCount}건
              </span>
            )}
          </button>
          {includeExpanded && (
            <div className="p-3 flex flex-col gap-3">
              {/* Mode-S 포함 */}
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] text-gray-500">Mode-S 코드</span>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={modeSIncludeInput}
                    onChange={(e) => setModeSIncludeInput(e.target.value.toUpperCase())}
                    onKeyDown={(e) => { if (e.key === "Enter") addModeSInclude(); }}
                    placeholder="예: 71BF79"
                    maxLength={6}
                    className="flex-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-mono placeholder:text-gray-300 focus:border-[#a60739] focus:outline-none focus:ring-1 focus:ring-[#a60739]/20"
                  />
                  <button
                    onClick={addModeSInclude}
                    disabled={!/^[0-9A-F]{4,6}$/.test(modeSIncludeInput.trim().toUpperCase())}
                    className="rounded-md bg-[#a60739] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[#8a062f] disabled:opacity-40 transition-colors"
                  >
                    추가
                  </button>
                </div>
                {modeSIncludeList.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {modeSIncludeList.map((code) => (
                      <span
                        key={code}
                        className="inline-flex items-center gap-0.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-mono text-emerald-700"
                      >
                        {code}
                        <button onClick={() => removeModeSInclude(code)} className="hover:text-emerald-900">
                          <X size={10} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {/* Squawk 포함 */}
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] text-gray-500">Squawk 코드</span>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={squawkIncludeInput}
                    onChange={(e) => setSquawkIncludeInput(e.target.value.replace(/[^0-7]/g, "").slice(0, 4))}
                    onKeyDown={(e) => { if (e.key === "Enter") addSquawkInclude(); }}
                    placeholder="예: 2000"
                    maxLength={4}
                    className="flex-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-mono placeholder:text-gray-300 focus:border-[#a60739] focus:outline-none focus:ring-1 focus:ring-[#a60739]/20"
                  />
                  <button
                    onClick={addSquawkInclude}
                    disabled={parseSquawk(squawkIncludeInput) === null}
                    className="rounded-md bg-[#a60739] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[#8a062f] disabled:opacity-40 transition-colors"
                  >
                    추가
                  </button>
                </div>
                <p className="text-[10px] text-gray-400">4자리 8진수 (0~7 숫자만 사용)</p>
                {squawkIncludeList.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {squawkIncludeList.map((val) => (
                      <span
                        key={val}
                        className="inline-flex items-center gap-0.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-mono text-emerald-700"
                      >
                        {formatSquawk(val)}
                        <button onClick={() => removeSquawkInclude(val)} className="hover:text-emerald-900">
                          <X size={10} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ━━ 제외 조건 ━━ */}
        <div className={`rounded-lg border border-gray-200 overflow-hidden transition-opacity ${dimmed ? "opacity-40 pointer-events-none" : ""}`}>
          <button
            onClick={() => setExcludeExpanded(!excludeExpanded)}
            className="flex items-center gap-2 w-full bg-gray-50 px-3 py-2 border-b border-gray-100 hover:bg-gray-100 transition-colors"
          >
            {excludeExpanded ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
            <ShieldOff size={14} className="text-red-400" />
            <span className="text-xs font-medium text-gray-600">제외 조건</span>
            {excludeCount > 0 && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full text-red-500 bg-red-50 ml-auto">
                {excludeCount}건
              </span>
            )}
          </button>
          {excludeExpanded && (
            <div className="p-3 flex flex-col gap-3">
              {/* Mode-S 제외 */}
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] text-gray-500">Mode-S 코드</span>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={modeSExcludeInput}
                    onChange={(e) => setModeSExcludeInput(e.target.value.toUpperCase())}
                    onKeyDown={(e) => { if (e.key === "Enter") addModeSExclude(); }}
                    placeholder="예: 71BF79"
                    maxLength={6}
                    className="flex-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-mono placeholder:text-gray-300 focus:border-[#a60739] focus:outline-none focus:ring-1 focus:ring-[#a60739]/20"
                  />
                  <button
                    onClick={addModeSExclude}
                    disabled={!/^[0-9A-F]{4,6}$/.test(modeSExcludeInput.trim().toUpperCase())}
                    className="rounded-md bg-red-500 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-red-600 disabled:opacity-40 transition-colors"
                  >
                    추가
                  </button>
                </div>
                {modeSExcludeList.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {modeSExcludeList.map((code) => (
                      <span
                        key={code}
                        className="inline-flex items-center gap-0.5 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-mono text-red-600"
                      >
                        {code}
                        <button onClick={() => removeModeSExclude(code)} className="hover:text-red-800">
                          <X size={10} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {/* Squawk 제외 */}
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] text-gray-500">Squawk 코드</span>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={squawkExcludeInput}
                    onChange={(e) => setSquawkExcludeInput(e.target.value.replace(/[^0-7]/g, "").slice(0, 4))}
                    onKeyDown={(e) => { if (e.key === "Enter") addSquawkExclude(); }}
                    placeholder="예: 2000"
                    maxLength={4}
                    className="flex-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-mono placeholder:text-gray-300 focus:border-[#a60739] focus:outline-none focus:ring-1 focus:ring-[#a60739]/20"
                  />
                  <button
                    onClick={addSquawkExclude}
                    disabled={parseSquawk(squawkExcludeInput) === null}
                    className="rounded-md bg-red-500 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-red-600 disabled:opacity-40 transition-colors"
                  >
                    추가
                  </button>
                </div>
                <p className="text-[10px] text-gray-400">4자리 8진수 (0~7 숫자만 사용)</p>
                {squawkExcludeList.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {squawkExcludeList.map((val) => (
                      <span
                        key={val}
                        className="inline-flex items-center gap-0.5 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-mono text-red-600"
                      >
                        {formatSquawk(val)}
                        <button onClick={() => removeSquawkExclude(val)} className="hover:text-red-800">
                          <X size={10} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 요약 + 전체 데이터 + 버튼 */}
        <div className="flex flex-col gap-2 pt-1">
          {/* 요약 */}
          {summaryParts.length > 0 && (
            <p className="flex items-center gap-1 text-[10px] text-gray-400">
              <Info size={10} />
              {summaryParts.join(" + ")}
            </p>
          )}

          {/* 확인/취소 */}
          <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
            {/* 전체 데이터 체크박스 */}
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={noFilter}
                onChange={(e) => setNoFilter(e.target.checked)}
                className="h-3 w-3 rounded border-gray-300 text-[#a60739] accent-[#a60739]"
              />
              <span className={`text-[11px] ${noFilter ? "text-[#a60739] font-medium" : "text-gray-500"}`}>
                전체 데이터
              </span>
            </label>
            <div className="flex-1" />
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
      </div>
    </Modal>
  );
}
