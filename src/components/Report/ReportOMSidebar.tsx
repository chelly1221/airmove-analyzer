/**
 * OM 보고서 좌측 사이드바
 *
 * 디자인 핸드오프(design_handoff_om_report_sidebar) 스펙 적용:
 *  - 폭 192px (w-48) — 기존 메인 Sidebar.tsx 와 동일
 *  - 우측 1px 구분선은 상위 ReportApp 에서 별도 div(top-8 bottom-0)로 배치 →
 *    32px 타이틀바가 사이드바를 가로질러 흐르도록 한 기존 셸 패턴과 일치
 *  - 브랜드 헤더(32px) → 문서 정보 → 목차(TOC, flex:1) → PDF 옵션·CTA
 *
 * TOC active/jump 는 부모(ReportApp)에서 IntersectionObserver 로 결정해
 * prop 으로 내려준다. 데이터 anchor 는 `[data-toc-key]` (ReportPreviewContent
 * 의 마커 div).
 */
import { Download, Loader2, SlidersHorizontal } from "lucide-react";

export interface OMSidebarTocItem {
  key: string;
  num: string;       // 표지="00", 이후 콘텐츠 섹션 "01"~"NN" 누적
  name: string;      // 한글 라벨
  page: number;      // 프리뷰 내 해당 anchor 의 1-based 페이지 인덱스 (없으면 0)
}

interface ReportOMSidebarProps {
  /** 발행 기간 뱃지 텍스트 (예: "2026년 4월"). 비면 표시 안 함 */
  docPeriod?: string;
  /** 보고서 제목 (예: "장애물 월간 분석 보고서") */
  docTitle: string;
  /** 문서 번호 (예: "RDR-RPT-2604-007") */
  docNo: string;
  /** 발행 기관 (예: "김포공항") */
  agency?: string;
  /** 분석 기간 ISO (예: "2026-04") */
  periodIso?: string;
  /** 목차 데이터 */
  toc: OMSidebarTocItem[];
  /** 현재 활성 섹션 key */
  activeKey?: string | null;
  /** 현재 페이지 / 총 페이지 (헤더 우측 표시) */
  currentPage: number;
  totalPages: number;
  /** 목차 클릭 — 해당 섹션으로 점프 */
  onJump: (key: string) => void;
  /** "보고서 설정" 모달 열기 (표시 섹션 + 메타데이터) */
  onOpenSettings: () => void;
  /** PDF 내보내기 에러 텍스트 — 있으면 빨간 배너로 표시 */
  exportError?: string | null;
  /** "PDF로 저장" 클릭 — PDF 내보내기 모달 열기 */
  onSave: () => void;
  generating: boolean;
  disabled: boolean;
  /** disabled 상태일 때 hover 툴팁 */
  disabledTitle?: string;
  /** 생성 중 경과 초 */
  elapsedSec?: number;
}

export default function ReportOMSidebar({
  docPeriod, docTitle, docNo, agency, periodIso,
  toc, activeKey, currentPage, totalPages, onJump,
  onOpenSettings, exportError,
  onSave, generating, disabled, disabledTitle, elapsedSec,
}: ReportOMSidebarProps) {
  const hasStatus = !!exportError;

  return (
    <aside className="flex h-full w-48 shrink-0 flex-col bg-white select-none">
      {/* 1) 브랜드 헤더 — 기존 메인 Sidebar 와 동일 스타일(13px / pl-3 / 32px) */}
      <div className="flex h-8 shrink-0 items-center" data-tauri-drag-region>
        <div className="flex-1 h-full flex items-center pl-3" data-tauri-drag-region>
          <span className="text-[13px] font-bold tracking-wide text-[#a60739] pointer-events-none">
            공항감시레이더 종합분석체계
          </span>
        </div>
      </div>

      {/* 2) 문서 정보 — 브랜드 헤더와 시각적으로 연속되도록 상단 보더 없음.
          (기존 타이틀바와의 경계선을 없애 좌·우 상단 32px 가 하나의 헤더 스트립처럼 흐름) */}
      <div className="flex flex-col gap-1 px-3 pb-3 pt-3.5">
        {docPeriod && (
          <span
            className="self-start rounded-[3px] bg-[#a60739] px-1.5 py-px text-[9.5px] font-extrabold tracking-wider text-white"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {docPeriod}
          </span>
        )}
        <h2
          className="text-[12.5px] font-bold leading-tight text-gray-900 break-keep"
          style={{ letterSpacing: "-0.005em", marginTop: docPeriod ? 4 : 0 }}
        >
          {docTitle}
        </h2>
        <div
          className="text-[10px] tracking-wide text-gray-400"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {docNo}
        </div>

        {(agency || periodIso) && (
          <div className="mt-2 flex flex-col gap-[3px] border-t border-gray-100 pt-2 text-[10.5px]">
            {agency && (
              <div className="flex justify-between whitespace-nowrap">
                <span className="text-gray-400">기관</span>
                <b className="overflow-hidden text-ellipsis whitespace-nowrap font-medium text-gray-600">
                  {agency}
                </b>
              </div>
            )}
            {periodIso && (
              <div className="flex justify-between whitespace-nowrap">
                <span className="text-gray-400">기간</span>
                <b
                  className="overflow-hidden text-ellipsis whitespace-nowrap font-medium text-gray-600"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {periodIso}
                </b>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 2.5) 상태 배지 — 기존 타이틀바 statusChips 의 사이드바 이관 */}
      {hasStatus && (
        <div className="flex flex-col gap-1.5 border-t border-gray-200 px-3 py-2.5">
          {exportError && (
            <span className="rounded-[5px] bg-red-50 px-2 py-1 text-[10px] font-medium leading-tight text-red-600 break-words">
              {exportError}
            </span>
          )}
        </div>
      )}

      {/* 3) 목차 — flex:1, 내부 스크롤 */}
      <div className="flex min-h-0 flex-1 flex-col border-t border-gray-200 px-2.5 pb-1.5 pt-2.5">
        <div className="flex items-center justify-between gap-1.5 px-1 pb-1.5 pt-0.5">
          <span className="whitespace-nowrap text-[9.5px] font-bold uppercase tracking-[0.06em] text-gray-400">
            목차
          </span>
          <span
            className="whitespace-nowrap text-[10px] font-semibold text-gray-500"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {currentPage}{totalPages > 0 ? ` / ${totalPages}` : ""}
          </span>
        </div>

        <div className="flex flex-1 flex-col gap-px overflow-y-auto">
          {toc.length === 0 ? (
            <div className="px-2 pt-1 text-[10.5px] text-gray-400">표시할 섹션이 없습니다</div>
          ) : toc.map((s) => {
            const active = s.key === activeKey;
            return (
              <button
                key={s.key}
                onClick={() => onJump(s.key)}
                className={`grid grid-cols-[20px_1fr_auto] items-center gap-1.5 rounded-[5px] px-2 py-1.5 text-left text-[11.5px] transition-colors duration-100 ${
                  active
                    ? "bg-[#fdf2f6] font-semibold text-[#85062e]"
                    : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                }`}
              >
                <span
                  className={`whitespace-nowrap text-[9.5px] font-bold ${active ? "text-[#a60739]" : "text-gray-400"}`}
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {s.num}
                </span>
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                  {s.name}
                </span>
                <span
                  className="whitespace-nowrap text-[9.5px] text-gray-400"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {s.page > 0 ? `p.${s.page}` : ""}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 4) 액션 — 보고서 설정 + PDF 내보내기 (옵션은 각 모달에서 설정) */}
      <div className="flex flex-col gap-2 border-t border-gray-200 bg-gray-50 px-2.5 py-3">
        {/* 표시 섹션 + 메타데이터 설정 모달 */}
        <button
          onClick={onOpenSettings}
          className="flex h-8 w-full items-center justify-center gap-1.5 rounded-[5px] border border-gray-200 bg-white text-[12px] font-medium text-gray-600 transition-colors hover:bg-gray-100"
        >
          <SlidersHorizontal size={13} />
          표시 섹션 · 설정
        </button>

        {/* PDF 내보내기 모달 열기 (생성 중에는 진행 상태 표시) */}
        <button
          onClick={onSave}
          disabled={disabled}
          title={disabled ? disabledTitle : undefined}
          className="flex h-8 w-full items-center justify-center gap-1.5 rounded-[5px] bg-[#a60739] text-[12px] font-semibold text-white transition-colors hover:bg-[#85062e] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {generating
            ? <Loader2 size={14} className="animate-spin" />
            : <Download size={14} />}
          {generating
            ? `생성 중 ${elapsedSec ?? 0}s`
            : "PDF로 저장"}
        </button>
      </div>
    </aside>
  );
}
