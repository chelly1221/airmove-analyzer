/**
 * OM 기준데이터 관리 모달
 *
 * 헤드라인 심각도 판정(추가 차단영역 소실율)을 "기준데이터(임의 참조 달 1달치) 대비 편차 Δ%p"로
 * 판정하기 위한 기준데이터를 관리한다. 레이더 단위 행 목록 하나로 저장 데이터·신규 등록을 통합하고,
 * 파일·기준월 선택은 레이더별 설정 서브모달로 분리한다(파일 선택 시 펼쳐지던 드럼휠이 본 모달을 늘리지 않게).
 *
 * 재설계: 등록은 원본 ASS 사본을 보관하고 메타만 남긴다(집계·재계산 없음). 심각도 판정용 히스토그램은
 * 보고서 생성 시 분석월과 동일 쐐기 파이프라인으로 **현재 설정으로 재집계**되므로, 좌표·안테나고 정합성
 * 배지가 필요 없다(같은 월 → Δ=0). 등록 오케스트레이션은 이 모달이 아니라 스토어(useOmReferenceBuildStore)가
 * 소유한다 — 모달을 닫아도 복사(수 GB 가능)는 백그라운드로 계속된다.
 *
 * - register_om_reference: 원본 ASS 복사(stage "copy")만 수행. 부분 성공 계약 — 실패 레이더는 반환 목록에서
 *   제외되며, 스토어가 job.status="error" 로 판정한다. 동일 radar_name 재등록은 덮어쓰기(캐시 무효화).
 * - meta.ass_bytes===0 = 원본 미보관(구버전) → "재등록 필요"(재집계 불가).
 *
 * 폼 상태(forms Map)는 이 부모가 소유 — 설정 서브모달은 뷰일 뿐이다.
 * 레이더 A 설정 → 닫기 → B 설정 후 본 모달의 일괄 등록이 유지되도록.
 */
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { format } from "date-fns";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Radio, FolderOpen, Trash2, Loader2, Database, TriangleAlert, RefreshCw, Settings, X } from "lucide-react";
import Modal from "../common/Modal";
import MonthPicker from "../common/MonthPicker";
import { extractDateFromFilename, filterFilesByMonth } from "../../utils/omFiles";
import { useOmReferenceBuildStore, type OmRefJobStatus } from "../../store/omReferenceBuild";
import type { RadarSite, OmReferenceMeta } from "../../types";

interface OMReferenceModalProps {
  open: boolean;
  onClose: () => void;
  customRadarSites: RadarSite[];
}

/** 레이더별 폼 상태 */
interface RadarForm {
  files: string[];
  month: string;
}

/** 바이트 → 자동 단위(GB/MB/KB/B) */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** 파일 목록에서 최빈 월("YYYY-MM") 추출. 없으면 "" */
function mostCommonMonth(files: string[]): string {
  const counts = new Map<string, number>();
  for (const f of files) {
    const d = extractDateFromFilename(f);
    if (d) { const k = d.slice(0, 7); counts.set(k, (counts.get(k) ?? 0) + 1); }
  }
  let best = "", bestC = 0;
  for (const [k, c] of counts) if (c > bestC) { best = k; bestC = c; }
  return best;
}

/** 작업 상태 칩 표기 (진행 카드) */
const STATUS_CHIP: Record<OmRefJobStatus, { label: string; cls: string }> = {
  pending: { label: "대기", cls: "bg-gray-100 text-gray-400" },
  running: { label: "진행중", cls: "bg-[#a60739]/10 text-[#a60739]" },
  done: { label: "완료", cls: "bg-emerald-50 text-emerald-600" },
  error: { label: "실패", cls: "bg-red-50 text-red-600" },
  cancelled: { label: "취소", cls: "bg-gray-100 text-gray-400" },
};

/**
 * 레이더별 설정 서브모달 내용 (파일 선택 + 기준월).
 * 폼 상태는 부모 소유 — 여기선 표시·조작 콜백만 받는다.
 */
function RadarConfigForm({
  radar, form, existing, building,
  onSelectFiles, onMonthChange, onClearFiles, onConfirm,
}: {
  radar: RadarSite;
  form: RadarForm | undefined;
  existing: OmReferenceMeta | undefined;
  building: boolean;
  onSelectFiles: () => void;
  onMonthChange: (month: string) => void;
  onClearFiles: () => void;
  onConfirm: () => void;
}) {
  const files = form?.files ?? [];
  const month = form?.month ?? format(new Date(), "yyyy-MM");
  const monthFiles = files.length > 0 ? filterFilesByMonth(files, month) : [];
  const unknownCount = files.filter((f) => extractDateFromFilename(f) === null).length;
  // 파일명 월 분포
  const distMap = new Map<string, number>();
  for (const f of files) {
    const d = extractDateFromFilename(f);
    const key = d ? d.slice(0, 7) : "미상";
    distMap.set(key, (distMap.get(key) ?? 0) + 1);
  }
  const monthDist = [...distMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div className="space-y-3">
      {/* 파일 선택 */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-gray-400">{radar.latitude.toFixed(4)}°N {radar.longitude.toFixed(4)}°E</span>
        <button onClick={onSelectFiles} disabled={building}
          className="flex items-center gap-1.5 rounded-lg bg-gray-100 px-3 py-1.5 text-[11px] text-gray-600 hover:bg-gray-200 disabled:opacity-40">
          <FolderOpen size={12} /> 파일 선택
        </button>
      </div>

      {files.length === 0 ? (
        <p className="text-[10px] text-gray-400">이 레이더의 기준월 ASS 파일을 선택하세요.</p>
      ) : (
        <div className="space-y-2.5">
          {/* 선택 요약 */}
          <div>
            <p className="text-[10px] font-medium text-[#a60739]">
              {files.length}개 선택 · {monthFiles.length}개 파싱 예정
              {files.length - monthFiles.length > 0 ? ` (${files.length - monthFiles.length}개 월 불일치 제외)` : ""}
              {unknownCount > 0 ? ` · 날짜 미상 ${unknownCount}개 포함(파싱에 포함됨)` : ""}
            </p>
            {monthDist.length > 0 && (
              <p className="mt-1 text-[10px] text-gray-400">
                월 분포: {monthDist.map(([m, c]) => `${m} ${c}개`).join(" · ")}
              </p>
            )}
          </div>

          {/* 월 파일 0 경고 (빌드 대상 제외) */}
          {monthFiles.length === 0 && (
            <p className="flex items-center gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[10px] text-amber-600">
              <TriangleAlert size={11} className="shrink-0" /> 선택한 월에 해당하는 파일이 없습니다 — 빌드 대상에서 제외됩니다.
            </p>
          )}

          {/* 덮어쓰기 경고 */}
          {existing && monthFiles.length > 0 && (
            <p className="flex items-center gap-1.5 text-[10px] text-amber-600">
              <TriangleAlert size={11} className="shrink-0" /> 빌드 시 {existing.month_label} 기준데이터를 덮어씁니다.
            </p>
          )}

          {/* 기준월 선택 */}
          <div className="rounded-lg border border-gray-100 bg-gray-50/50 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold text-gray-600">기준월</span>
              <span className="font-mono text-[11px] text-[#a60739]">{month}</span>
            </div>
            <div className={`flex justify-center ${building ? "pointer-events-none opacity-40" : ""}`}>
              <MonthPicker value={month} onChange={onMonthChange} />
            </div>
          </div>

          {/* 파일 선택 해제 */}
          <div className="flex justify-end">
            <button onClick={onClearFiles} disabled={building}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-40">
              <X size={11} /> 파일 선택 해제
            </button>
          </div>
        </div>
      )}

      {/* 확인 — 서브모달 닫기 (빌드는 본 모달 하단 버튼에서 일괄 실행) */}
      <div className="flex justify-end border-t border-gray-100 pt-3">
        <button onClick={onConfirm}
          className="rounded-lg bg-[#a60739] px-4 py-2 text-[12px] font-medium text-white transition-colors hover:bg-[#85062e]">
          확인
        </button>
      </div>
    </div>
  );
}

export default function OMReferenceModal({ open, onClose, customRadarSites }: OMReferenceModalProps) {
  // 저장된 기준데이터 목록
  const [references, setReferences] = useState<OmReferenceMeta[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  // 레이더별 폼 상태 (파일 선택 + 기준월)
  const [forms, setForms] = useState<Map<string, RadarForm>>(new Map());

  // 설정 서브모달 대상 (radar_name). null 이면 닫힘
  const [configTarget, setConfigTarget] = useState<string | null>(null);

  // 삭제 확인
  const [deleteTarget, setDeleteTarget] = useState<OmReferenceMeta | null>(null);

  // ── 빌드 스토어 구독 (모달 밖 오케스트레이션) ──
  const building = useOmReferenceBuildStore((s) => s.building);
  const cancelRequested = useOmReferenceBuildStore((s) => s.cancelRequested);
  const jobs = useOmReferenceBuildStore((s) => s.jobs);
  const progress = useOmReferenceBuildStore((s) => s.progress);
  const startBuild = useOmReferenceBuildStore((s) => s.startBuild);
  const requestCancel = useOmReferenceBuildStore((s) => s.requestCancel);
  const clearJobs = useOmReferenceBuildStore((s) => s.clearJobs);

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

  // 본 모달이 닫히면 설정 서브모달도 함께 정리 (고아 서브모달 방지)
  useEffect(() => {
    if (!open) setConfigTarget(null);
  }, [open]);

  // 빌드 종료 감지(true→false) — done 레이더 파일선택만 클리어(error/cancelled 는 재시도용 유지) + 목록 갱신
  const prevBuildingRef = useRef(building);
  useEffect(() => {
    if (prevBuildingRef.current && !building) {
      const doneRadars = new Set(jobs.filter((j) => j.status === "done").map((j) => j.radarName));
      if (doneRadars.size > 0) {
        setForms((prev) => {
          const next = new Map(prev);
          for (const r of doneRadars) next.delete(r);
          return next;
        });
      }
      refreshList();
    }
    prevBuildingRef.current = building;
  }, [building, jobs, refreshList]);

  // ── 레이더별 폼 조작 ──
  const handleSelectFiles = useCallback(async (radarName: string) => {
    const result = await openDialog({ multiple: true, filters: [{ name: "ASS Files", extensions: ["ass", "ASS"] }] });
    if (!result || !Array.isArray(result)) return;
    const picked = result as string[];
    const best = mostCommonMonth(picked);
    setForms((prev) => {
      const next = new Map(prev);
      const cur = next.get(radarName);
      // 파일 선택 시 최빈 월 자동 설정 (없으면 기존 월/오늘 유지)
      next.set(radarName, { files: picked, month: best || cur?.month || format(new Date(), "yyyy-MM") });
      return next;
    });
  }, []);

  const handleMonthChange = useCallback((radarName: string, month: string) => {
    setForms((prev) => {
      const next = new Map(prev);
      const cur = next.get(radarName) ?? { files: [], month };
      next.set(radarName, { ...cur, month });
      return next;
    });
  }, []);

  const handleClearFiles = useCallback((radarName: string) => {
    setForms((prev) => {
      const next = new Map(prev);
      next.delete(radarName);
      return next;
    });
  }, []);

  // 빌드 대상 항목 — 파일이 선택됐고 해당 월 파일이 1개 이상인 레이더만 (파싱할 파일은 월 필터 적용본)
  const buildItems = useMemo(() => {
    const items: { radar: RadarSite; files: string[]; month: string }[] = [];
    for (const radar of customRadarSites) {
      const form = forms.get(radar.name);
      if (!form || form.files.length === 0) continue;
      const monthFiles = filterFilesByMonth(form.files, form.month);
      if (monthFiles.length === 0) continue;
      items.push({ radar, files: monthFiles, month: form.month });
    }
    return items;
  }, [customRadarSites, forms]);

  const handleBuild = useCallback(() => {
    if (buildItems.length === 0 || building) return;
    startBuild(buildItems);
  }, [buildItems, building, startBuild]);

  const handleDelete = useCallback(async (radarName: string) => {
    try { await invoke("delete_om_reference", { radarName }); }
    catch (e) { console.warn("[OMReference] 삭제 실패:", e); }
    setDeleteTarget(null);
    await refreshList();
  }, [refreshList]);

  const progressPct = progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : null;
  const errorJobs = jobs.filter((j) => j.status === "error");

  // 레이더 미등록 저장 데이터 (customRadarSites 에 없는 radar_name — 삭제만 가능)
  const unregisteredRefs = useMemo(
    () => references.filter((r) => !customRadarSites.some((s) => s.name === r.radar_name)),
    [references, customRadarSites],
  );

  // 설정 서브모달 대상 레이더 (등록 레이더만 — 미등록/미존재면 null 로 닫힘 처리)
  const configRadar = configTarget ? customRadarSites.find((s) => s.name === configTarget) ?? null : null;

  const isEmpty = customRadarSites.length === 0 && unregisteredRefs.length === 0;

  return (
    <>
      <Modal open={open} onClose={onClose} title="기준데이터 관리" width="max-w-3xl" closable>
        <div className="space-y-5">
          {/* 안내 문구 */}
          <div className="flex items-start gap-2 rounded-lg bg-[#a60739]/5 px-3.5 py-2.5">
            <Database size={15} className="mt-0.5 shrink-0 text-[#a60739]" />
            <p className="text-[11px] leading-relaxed text-gray-500">
              기준데이터는 임의 참조 달 1달치의 원본 ASS 사본으로, 헤드라인 심각도를 기준월 대비 편차(Δ%p)로 판정하는 데 쓰입니다.
              {" "}기준월 재집계는 보고서 생성 시 현재 레이더 설정으로 수행되므로, 좌표·안테나고를 바꿔도 재등록 없이 반영됩니다.
            </p>
          </div>

          {/* ── 레이더별 기준데이터 (저장 데이터 + 신규/재계산 통합) ── */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.06em] text-gray-400">레이더별 기준데이터</h3>
              <button onClick={refreshList} disabled={loadingList}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-40">
                <RefreshCw size={11} className={loadingList ? "animate-spin" : ""} /> 새로고침
              </button>
            </div>

            {isEmpty ? (
              <div className="rounded-xl border border-dashed border-gray-200 px-4 py-6 text-center text-[11px] text-gray-400">
                {loadingList ? "불러오는 중..." : "등록된 레이더가 없습니다. 레이더를 먼저 등록하세요."}
              </div>
            ) : (
              <div className="space-y-2">
                {/* 등록 레이더 행 */}
                {customRadarSites.map((radar) => {
                  const existing = references.find((r) => r.radar_name === radar.name);
                  // 원본 보관(ass_bytes>0)이면 적용 가능 — 재집계는 생성 시 현재 설정으로 수행되므로 정합성 게이트 없음.
                  const hasStored = !!existing && existing.ass_bytes > 0;
                  const form = forms.get(radar.name);
                  const files = form?.files ?? [];
                  const month = form?.month ?? "";
                  const monthFiles = files.length > 0 ? filterFilesByMonth(files, month) : [];

                  return (
                    <div key={radar.name} className="rounded-xl border border-gray-200 p-3">
                      {/* 1행(주): 아이콘 + 이름 + 상태 배지 + 액션 */}
                      <div className="flex items-center gap-2">
                        <Radio size={14} className="shrink-0 text-[#a60739]" />
                        <span className="text-[12px] font-semibold text-gray-700">{radar.name}</span>

                        <div className="flex flex-wrap items-center gap-1">
                          {existing ? (
                            <>
                              <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[9px] text-gray-500">기준월 {existing.month_label}</span>
                              {hasStored ? (
                                <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[9px] text-emerald-600">적용 가능</span>
                              ) : (
                                <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[9px] text-amber-600" title="원본 ASS 미보관(구버전 등록) — 기준월 재집계 불가. 파일을 다시 선택해 재등록하세요.">
                                  원본 미보관 · 재등록 필요
                                </span>
                              )}
                            </>
                          ) : (
                            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[9px] text-gray-400">기준데이터 없음</span>
                          )}
                          {/* 폼에 파일이 선택돼 있으면 파싱 예정 배지 */}
                          {files.length > 0 && (
                            monthFiles.length > 0 ? (
                              <span className="rounded bg-[#a60739]/10 px-1.5 py-0.5 text-[9px] text-[#a60739]">
                                {monthFiles.length}개 파싱 예정 · {month}
                              </span>
                            ) : (
                              <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[9px] text-amber-600">선택 월 파일 없음</span>
                            )
                          )}
                        </div>

                        <div className="ml-auto flex items-center gap-0.5">
                          {existing && (
                            <button onClick={() => setDeleteTarget(existing)} disabled={building}
                              className="rounded-md p-1 text-gray-300 hover:bg-red-50 hover:text-red-500 disabled:opacity-40" title="삭제">
                              <Trash2 size={13} />
                            </button>
                          )}
                          <button onClick={() => setConfigTarget(radar.name)}
                            className="flex items-center gap-1 rounded-lg bg-[#a60739] px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-[#85062e]">
                            <Settings size={12} /> {existing ? "재등록" : "설정"}
                          </button>
                        </div>
                      </div>

                      {/* 2행(부, 저장 데이터 있을 때만): 상세 */}
                      {existing && (
                        <p className="mt-1.5 pl-[22px] font-mono text-[10px] text-gray-400">
                          기간 {existing.first_date} ~ {existing.last_date} · 파일 {existing.file_count}개
                          {" · "}원본 ASS {existing.ass_bytes > 0 ? formatBytes(existing.ass_bytes) : "미보관"}
                          {" · "}생성 {existing.created_at.slice(0, 10)}
                        </p>
                      )}
                    </div>
                  );
                })}

                {/* 레이더 미등록 저장 데이터 행 (삭제만 가능) */}
                {unregisteredRefs.map((r) => (
                  <div key={r.radar_name} className="rounded-xl border border-gray-200 p-3">
                    <div className="flex items-center gap-2">
                      <Radio size={14} className="shrink-0 text-gray-300" />
                      <span className="text-[12px] font-semibold text-gray-700">{r.radar_name}</span>
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[9px] text-gray-400">레이더 미등록</span>
                        <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[9px] text-gray-500">기준월 {r.month_label}</span>
                      </div>
                      <div className="ml-auto flex items-center gap-0.5">
                        <button onClick={() => setDeleteTarget(r)} disabled={building}
                          className="rounded-md p-1 text-gray-300 hover:bg-red-50 hover:text-red-500 disabled:opacity-40" title="삭제">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                    <p className="mt-1.5 pl-[22px] font-mono text-[10px] text-gray-400">
                      기간 {r.first_date} ~ {r.last_date} · 파일 {r.file_count}개
                      {" · "}원본 ASS {r.ass_bytes > 0 ? formatBytes(r.ass_bytes) : "미보관"}
                      {" · "}생성 {r.created_at.slice(0, 10)}
                    </p>
                  </div>
                ))}

                {/* 각주 — 저장 데이터가 있을 때만 (기간 표기 관련) */}
                {references.length > 0 && (
                  <p className="px-1 pt-0.5 text-[10px] text-gray-400">
                    기간에는 전월 마지막날 파일(자정 이후 데이터 보정)이 포함될 수 있습니다.
                  </p>
                )}
              </div>
            )}
          </section>

          {/* ── 진행 카드 (스토어 구독) ── */}
          {building && (
            <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <div className="flex items-center gap-2">
                <Loader2 size={16} className="animate-spin text-[#a60739]" />
                <h4 className="text-[13px] font-semibold text-gray-800">기준데이터 빌드 중</h4>
                {progress && <span className="text-[11px] text-gray-400">· {progress.radarName}</span>}
                <div className="flex-1" />
                {progressPct !== null && <span className="text-[11px] font-medium text-gray-500">{progressPct}%</span>}
                <button onClick={requestCancel} disabled={cancelRequested}
                  className="rounded-lg border border-red-200 bg-white px-2.5 py-1 text-[11px] text-red-600 hover:bg-red-50 disabled:opacity-40">
                  {cancelRequested ? "취소 중…" : "취소"}
                </button>
              </div>
              <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-gray-100">
                <div className="h-full bg-[#a60739] transition-all duration-300" style={{ width: `${progressPct ?? 8}%` }} />
              </div>
              {progress && <p className="mt-2 text-[11px] text-gray-500">{progress.message}</p>}
              {/* 레이더별 상태 칩 */}
              {jobs.length > 1 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {jobs.map((j) => {
                    const chip = STATUS_CHIP[j.status];
                    return (
                      <span key={j.radarName} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ${chip.cls}`}>
                        <span className="font-medium">{j.radarName}</span>
                        <span className="opacity-70">{chip.label}</span>
                      </span>
                    );
                  })}
                </div>
              )}
              <p className="mt-2.5 text-[10px] text-gray-400">모달을 닫아도 빌드는 백그라운드로 계속됩니다.</p>
            </div>
          )}

          {/* ── 빌드 결과 에러 요약 (종료 후) ── */}
          {!building && errorJobs.length > 0 && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3">
              <div className="flex items-start gap-2">
                <TriangleAlert size={14} className="mt-0.5 shrink-0 text-red-500" />
                <div className="flex-1">
                  <p className="text-[12px] font-semibold text-red-700">일부 레이더 빌드 실패</p>
                  <ul className="mt-1.5 space-y-1">
                    {errorJobs.map((j) => (
                      <li key={j.radarName} className="text-[11px] text-red-600">
                        <span className="font-medium">{j.radarName}</span>: {j.error ?? "빌드 실패"}
                      </li>
                    ))}
                  </ul>
                </div>
                <button onClick={clearJobs} className="rounded-md p-1 text-red-400 hover:bg-red-100 hover:text-red-600" title="닫기">
                  <X size={14} />
                </button>
              </div>
            </div>
          )}

          {/* ── 하단 버튼 ── */}
          <div className="flex items-center justify-end gap-2 border-t border-gray-100 pt-4">
            <button onClick={onClose}
              className="rounded-lg border border-gray-200 px-4 py-2 text-[12px] text-gray-600 hover:bg-gray-50">닫기</button>
            <button onClick={handleBuild} disabled={buildItems.length === 0 || building}
              className="flex items-center gap-1.5 rounded-lg bg-[#a60739] px-5 py-2 text-[12px] font-medium text-white transition-colors hover:bg-[#85062e] disabled:opacity-40">
              {building ? <Loader2 size={14} className="animate-spin" /> : <Database size={14} />}
              기준데이터 생성 ({buildItems.length}개 레이더)
            </button>
          </div>
        </div>
      </Modal>

      {/* 레이더별 설정 서브모달 — 본 모달 뒤(JSX상 나중)에 두어 동일 z에서 위에 그려짐 */}
      <Modal
        open={configRadar !== null}
        onClose={() => setConfigTarget(null)}
        title={configRadar ? `기준데이터 설정 — ${configRadar.name}` : ""}
        width="max-w-md"
        closable
      >
        {configRadar && (
          <RadarConfigForm
            radar={configRadar}
            form={forms.get(configRadar.name)}
            existing={references.find((r) => r.radar_name === configRadar.name)}
            building={building}
            onSelectFiles={() => handleSelectFiles(configRadar.name)}
            onMonthChange={(m) => handleMonthChange(configRadar.name, m)}
            onClearFiles={() => handleClearFiles(configRadar.name)}
            onConfirm={() => setConfigTarget(null)}
          />
        )}
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
                {deleteTarget.ass_bytes > 0
                  ? <>보관된 원본 ASS({formatBytes(deleteTarget.ass_bytes)})와 재집계 캐시가 함께 삭제됩니다.</>
                  : <>재집계 캐시가 함께 삭제됩니다.</>}
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
