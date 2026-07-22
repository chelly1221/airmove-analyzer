/**
 * OM 기준데이터 관리 모달
 *
 * 헤드라인 심각도 판정(추가 차단영역 소실율)을 "기준데이터(임의 참조 달 1달치) 대비 편차 Δ%p"로
 * 판정하기 위한 기준데이터를 관리한다. 저장된 기준데이터 목록(레이더별)을 보여주고, 신규/재계산
 * (ASS 파일 선택 → 월 필터 → build_om_reference)을 수행한다.
 *
 * - build_om_reference: 파싱·집계·저장까지 백엔드가 수행(전방위 처리 — azimuth_sectors/building_* 무시).
 *   레이더별 실패는 om-reference-progress stage:"error"로 알리고 반환 목록에서 제외(부분 성공). 완료
 *   후에는 반환값 대신 list_om_references 로 재조회해 갱신한다.
 * - 원시 포인트가 아카이브(바이너리)로 함께 보관되어 ASS 원본 없이도 추후 재집계가 가능하다.
 * - 동일 radar_name 재빌드는 덮어쓰기다.
 */
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { format } from "date-fns";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Radio, FolderOpen, Trash2, Loader2, Database, TriangleAlert, RefreshCw } from "lucide-react";
import Modal from "../common/Modal";
import MonthPicker from "../common/MonthPicker";
import { extractDateFromFilename, filterFilesByMonth } from "../../utils/omFiles";
import type { RadarSite, Aircraft, OmReferenceMeta, ObstacleMonthlyProgress } from "../../types";

interface OMReferenceModalProps {
  open: boolean;
  onClose: () => void;
  customRadarSites: RadarSite[];
  aircraft: Aircraft[];
}

/** 바이트 → 자동 단위(GB/MB/KB/B) */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export default function OMReferenceModal({ open, onClose, customRadarSites, aircraft }: OMReferenceModalProps) {
  // 저장된 기준데이터 목록
  const [references, setReferences] = useState<OmReferenceMeta[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  // 빌드 폼 상태
  const [selectedRadarName, setSelectedRadarName] = useState<string | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [month, setMonth] = useState(() => format(new Date(), "yyyy-MM"));
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState<{ message: string; current: number; total: number } | null>(null);
  const [buildError, setBuildError] = useState("");
  const cancelledRef = useRef(false);

  // 삭제 확인
  const [deleteTarget, setDeleteTarget] = useState<OmReferenceMeta | null>(null);

  const selectedRadar = useMemo(
    () => customRadarSites.find((r) => r.name === selectedRadarName) ?? null,
    [customRadarSites, selectedRadarName],
  );

  const refreshList = useCallback(async () => {
    setLoadingList(true);
    try {
      const list = await invoke<OmReferenceMeta[]>("list_om_references");
      setReferences(list ?? []);
    } catch (e) {
      console.warn("[OMReference] 목록 로드 실패:", e);
    } finally {
      setLoadingList(false);
    }
  }, []);

  // 모달 열릴 때 목록 로드
  useEffect(() => {
    if (open) refreshList();
  }, [open, refreshList]);

  // 파일 선택 시 가장 흔한 월로 기본 설정
  useEffect(() => {
    if (files.length === 0) return;
    const counts = new Map<string, number>();
    for (const f of files) {
      const d = extractDateFromFilename(f);
      if (d) { const k = d.slice(0, 7); counts.set(k, (counts.get(k) ?? 0) + 1); }
    }
    let best = "", bestC = 0;
    for (const [k, c] of counts) if (c > bestC) { best = k; bestC = c; }
    if (best) setMonth(best);
  }, [files]);

  const handleSelectFiles = useCallback(async () => {
    const result = await openDialog({ multiple: true, filters: [{ name: "ASS Files", extensions: ["ass", "ASS"] }] });
    if (result && Array.isArray(result)) setFiles(result as string[]);
  }, []);

  // 파일명 월 분포
  const monthDist = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of files) {
      const d = extractDateFromFilename(f);
      const key = d ? d.slice(0, 7) : "미상";
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [files]);

  const monthFiles = useMemo(() => filterFilesByMonth(files, month), [files, month]);

  // 선택 레이더에 이미 기준데이터가 있으면 재빌드=덮어쓰기 안내
  const existingForRadar = useMemo(
    () => (selectedRadarName ? references.find((r) => r.radar_name === selectedRadarName) : undefined),
    [references, selectedRadarName],
  );

  const canBuild = !!selectedRadar && monthFiles.length > 0 && !building;

  const handleBuild = useCallback(async () => {
    if (!selectedRadar || building) return;
    const targetFiles = filterFilesByMonth(files, month);
    if (targetFiles.length === 0) { setBuildError("선택한 월에 해당하는 파일이 없습니다."); return; }
    cancelledRef.current = false;
    setBuilding(true);
    setBuildError("");
    setProgress({ message: "기준데이터 빌드 준비 중...", current: 0, total: 0 });

    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listen<ObstacleMonthlyProgress>("om-reference-progress", (e) => {
        if (cancelledRef.current) return;
        const p = e.payload;
        setProgress({
          message: p.stage === "error" ? `⚠ ${p.radar_name}: ${p.message}` : p.message,
          current: p.total > 0 ? p.current : 0,
          total: p.total > 0 ? p.total : 0,
        });
      });
      const excludeModeS = aircraft.map((a) => a.mode_s_code).filter(Boolean);
      // 기준데이터는 전방위 처리 — azimuth_sectors/building_* 는 백엔드가 무시(빈 배열 전달).
      const radarFileSets = [{
        radar_name: selectedRadar.name,
        radar_lat: selectedRadar.latitude,
        radar_lon: selectedRadar.longitude,
        radar_altitude: selectedRadar.altitude,
        antenna_height: selectedRadar.antenna_height,
        file_paths: targetFiles,
        azimuth_sectors: [],
        min_obstacle_distance_km: 0,
        building_bearings_deg: [],
        building_az_half_extents_deg: [],
      }];
      await invoke("build_om_reference", { radarFileSets, excludeModeS, monthLabel: month });
      if (cancelledRef.current) return;
      // 부분 성공 대비 — 반환값 대신 list 재조회로 갱신
      await refreshList();
      setFiles([]);
      setProgress(null);
    } catch (err) {
      if (!cancelledRef.current) setBuildError(`빌드 실패: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      unlisten?.();
      setBuilding(false);
    }
  }, [selectedRadar, building, files, month, aircraft, refreshList]);

  const handleCancelBuild = useCallback(async () => {
    cancelledRef.current = true;
    try { await invoke("cancel_analysis"); } catch { /* ignore */ }
    setBuilding(false);
    setProgress(null);
    await refreshList();
  }, [refreshList]);

  const handleDelete = useCallback(async (radarName: string) => {
    try { await invoke("delete_om_reference", { radarName }); }
    catch (e) { console.warn("[OMReference] 삭제 실패:", e); }
    setDeleteTarget(null);
    await refreshList();
  }, [refreshList]);

  const progressPct = progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : null;

  return (
    <>
      <Modal open={open} onClose={onClose} title="기준데이터 관리" width="max-w-2xl" closable={!building}>
        <div className="space-y-5">
          {/* 안내 문구 */}
          <div className="flex items-start gap-2 rounded-lg bg-[#a60739]/5 px-3.5 py-2.5">
            <Database size={15} className="mt-0.5 shrink-0 text-[#a60739]" />
            <p className="text-[11px] leading-relaxed text-gray-500">
              기준데이터는 임의 참조 달 1달치를 전방위로 집계한 자료로, 헤드라인 심각도를 기준월 대비 편차(Δ%p)로 판정하는 데 쓰입니다.
              {" "}원시 포인트가 아카이브(바이너리)로 함께 보관되어 ASS 원본 파일 없이도 추후 재집계가 가능합니다.
            </p>
          </div>

          {/* ── 저장된 기준데이터 목록 ── */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.06em] text-gray-400">저장된 기준데이터</h3>
              <button onClick={refreshList} disabled={loadingList}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-40">
                <RefreshCw size={11} className={loadingList ? "animate-spin" : ""} /> 새로고침
              </button>
            </div>
            {references.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-200 px-4 py-6 text-center text-[11px] text-gray-400">
                {loadingList ? "불러오는 중..." : "저장된 기준데이터가 없습니다. 아래에서 새로 생성하세요."}
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-gray-200">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50 text-gray-400">
                      <th className="px-3 py-2 text-left font-medium">레이더</th>
                      <th className="px-3 py-2 text-center font-medium">기준월</th>
                      <th className="px-3 py-2 text-center font-medium">파일</th>
                      <th className="px-3 py-2 text-center font-medium">기간</th>
                      <th className="px-3 py-2 text-right font-medium">포인트</th>
                      <th className="px-3 py-2 text-right font-medium">아카이브</th>
                      <th className="px-3 py-2 text-center font-medium">생성일</th>
                      <th className="px-3 py-2 text-center font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {references.map((r) => (
                      <tr key={r.radar_name} className="border-b border-gray-50 last:border-0">
                        <td className="px-3 py-2 font-semibold text-gray-700">{r.radar_name}</td>
                        <td className="px-3 py-2 text-center font-mono text-gray-600">{r.month_label}</td>
                        <td className="px-3 py-2 text-center text-gray-500">{r.file_count}개</td>
                        <td className="px-3 py-2 text-center font-mono text-[10px] text-gray-400">
                          {r.first_date}<br />~ {r.last_date}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-gray-600">{r.total_points.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right font-mono text-gray-600">{formatBytes(r.archive_bytes)}</td>
                        <td className="px-3 py-2 text-center font-mono text-[10px] text-gray-400">{r.created_at.slice(0, 10)}</td>
                        <td className="px-3 py-2 text-center">
                          <button onClick={() => setDeleteTarget(r)} disabled={building}
                            className="rounded-md p-1 text-gray-300 hover:bg-red-50 hover:text-red-500 disabled:opacity-40" title="삭제">
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ── 신규 / 재계산 ── */}
          <section className="border-t border-gray-100 pt-4">
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.06em] text-gray-400">신규 / 재계산</h3>

            {/* 레이더 선택 */}
            <div className="space-y-1.5 rounded-xl border border-gray-200 p-3">
              <p className="mb-1 text-[11px] text-gray-500">레이더 선택</p>
              {customRadarSites.length === 0 ? (
                <p className="py-2 text-center text-[11px] text-gray-400">등록된 레이더가 없습니다.</p>
              ) : customRadarSites.map((r) => {
                const checked = selectedRadarName === r.name;
                const hasRef = references.some((x) => x.radar_name === r.name);
                return (
                  <button key={r.name} onClick={() => setSelectedRadarName(checked ? null : r.name)} disabled={building}
                    className={`flex w-full items-center gap-2.5 rounded-lg border px-3.5 py-2 text-left transition-all disabled:opacity-40 ${checked ? "border-[#a60739] bg-[#a60739] text-white shadow-sm shadow-[#a60739]/10" : "border-gray-100 hover:border-gray-300 hover:bg-gray-50"}`}>
                    <Radio size={14} className={`shrink-0 ${checked ? "text-white" : "text-[#a60739]"}`} />
                    <span className={`text-[12px] font-medium ${checked ? "text-white" : "text-gray-600"}`}>{r.name}</span>
                    {hasRef && (
                      <span className={`ml-1 rounded px-1.5 py-0.5 text-[9px] ${checked ? "bg-white/20 text-white" : "bg-amber-50 text-amber-600"}`}>기준데이터 보유</span>
                    )}
                    <span className={`ml-auto text-[10px] ${checked ? "text-white/70" : "text-gray-400"}`}>{r.latitude.toFixed(4)}°N {r.longitude.toFixed(4)}°E</span>
                  </button>
                );
              })}
            </div>

            {selectedRadar && (
              <>
                {existingForRadar && (
                  <p className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-600">
                    <TriangleAlert size={12} className="shrink-0" />
                    {selectedRadar.name}에 이미 기준데이터({existingForRadar.month_label})가 있습니다 — 빌드 시 덮어쓰기됩니다.
                  </p>
                )}

                {/* 파일 선택 */}
                <div className="mt-3 rounded-xl border border-gray-200 p-3.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-semibold text-gray-700">ASS 파일</span>
                    <button onClick={handleSelectFiles} disabled={building}
                      className="flex items-center gap-1.5 rounded-lg bg-gray-100 px-3 py-1.5 text-[11px] text-gray-600 hover:bg-gray-200 disabled:opacity-40">
                      <FolderOpen size={12} /> 파일 선택
                    </button>
                  </div>
                  {files.length > 0 ? (
                    <div className="mt-2">
                      <p className="text-[10px] font-medium text-[#a60739]">
                        {files.length}개 선택됨 · {monthFiles.length}개 파싱 예정
                        {files.length - monthFiles.length > 0 ? ` (${files.length - monthFiles.length}개 월 불일치 제외)` : ""}
                      </p>
                      {monthDist.length > 0 && (
                        <p className="mt-1 text-[10px] text-gray-400">
                          월 분포: {monthDist.map(([m, c]) => `${m} ${c}개`).join(" · ")}
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="mt-2 text-[10px] text-gray-400">기준월로 집계할 ASS 파일을 선택하세요.</p>
                  )}
                </div>

                {/* 기준월 선택 */}
                <div className="mt-3 rounded-xl border border-gray-200 p-3.5">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[12px] font-semibold text-gray-700">기준월</span>
                    <span className="font-mono text-[11px] text-[#a60739]">{month}</span>
                  </div>
                  <div className="flex justify-center">
                    <MonthPicker value={month} onChange={setMonth} />
                  </div>
                </div>
              </>
            )}

            {/* 진행 카드 */}
            {building && (
              <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                <div className="flex items-center gap-2">
                  <Loader2 size={16} className="animate-spin text-[#a60739]" />
                  <h4 className="text-[13px] font-semibold text-gray-800">기준데이터 빌드 중</h4>
                  <div className="flex-1" />
                  {progressPct !== null && <span className="text-[11px] font-medium text-gray-500">{progressPct}%</span>}
                  <button onClick={handleCancelBuild}
                    className="rounded-lg border border-red-200 bg-white px-2.5 py-1 text-[11px] text-red-600 hover:bg-red-50">취소</button>
                </div>
                <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-gray-100">
                  <div className="h-full bg-[#a60739] transition-all duration-300" style={{ width: `${progressPct ?? 8}%` }} />
                </div>
                {progress && <p className="mt-2 text-[11px] text-gray-500">{progress.message}</p>}
              </div>
            )}

            {!building && buildError && (
              <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3">
                <p className="text-[11px] text-red-700">{buildError}</p>
              </div>
            )}
          </section>

          {/* ── 하단 버튼 ── */}
          <div className="flex items-center justify-end gap-2 border-t border-gray-100 pt-4">
            <button onClick={onClose} disabled={building}
              className="rounded-lg border border-gray-200 px-4 py-2 text-[12px] text-gray-600 hover:bg-gray-50 disabled:opacity-40">닫기</button>
            <button onClick={handleBuild} disabled={!canBuild}
              className="flex items-center gap-1.5 rounded-lg bg-[#a60739] px-5 py-2 text-[12px] font-medium text-white transition-colors hover:bg-[#85062e] disabled:opacity-40">
              <Database size={14} />
              {existingForRadar ? "재계산(덮어쓰기)" : "기준데이터 생성"}
            </button>
          </div>
        </div>
      </Modal>

      {/* 삭제 확인 — 모달(z-9999) 위 */}
      {deleteTarget && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-sm rounded-xl border border-gray-200 bg-white shadow-xl">
            <div className="flex flex-col items-center gap-3 px-6 pt-6 pb-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100">
                <Trash2 size={18} className="text-red-600" />
              </div>
              <h3 className="text-base font-semibold text-gray-800">기준데이터 삭제</h3>
              <p className="text-center text-sm text-gray-500">
                <span className="font-semibold text-gray-700">{deleteTarget.radar_name}</span>의 기준데이터({deleteTarget.month_label})를 삭제하시겠습니까?<br />
                보관된 원시 포인트 아카이브({formatBytes(deleteTarget.archive_bytes)})도 함께 삭제됩니다.
              </p>
            </div>
            <div className="flex gap-2 border-t border-gray-200 px-6 py-4">
              <button onClick={() => setDeleteTarget(null)}
                className="flex-1 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100">취소</button>
              <button onClick={() => handleDelete(deleteTarget.radar_name)}
                className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700">삭제</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
