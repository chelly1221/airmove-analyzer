/**
 * 보고서 설정 모달 (OM 사이드바 — "표시 섹션 · 설정")
 *
 * 기존 사이드바에 인라인으로 있던 "표시 섹션" 토글을 모달로 이관하고,
 * 보고서 메타데이터(기관·부서·현장·푸터) 편집 기능을 함께 제공한다.
 * 메타데이터 변경은 즉시(onMetadataChange) 상위 state 에 반영되어
 * 표지/머리말 프리뷰에 라이브로 적용된다.
 */
import Modal from "../common/Modal";
import type { ReportMetadata } from "../../types";

export interface SettingsSectionToggle {
  key: string;
  label: string;
  active: boolean;
  onToggle: () => void;
}

interface ReportSettingsModalProps {
  open: boolean;
  onClose: () => void;
  /** 표시 섹션 토글 목록 */
  sectionToggles: SettingsSectionToggle[];
  /** 보고서 메타데이터 (표지·머리말 값) */
  metadata: ReportMetadata;
  /** 메타데이터 부분 변경 — 즉시 반영 */
  onMetadataChange: (patch: Partial<ReportMetadata>) => void;
}

const META_FIELDS: { key: keyof ReportMetadata; label: string; placeholder: string }[] = [
  { key: "organization", label: "기관", placeholder: "예: 김포공항" },
  { key: "department", label: "부서", placeholder: "예: 레이더관제부" },
  { key: "siteName", label: "현장", placeholder: "예: 레이더송신소" },
  { key: "footer", label: "푸터 문구", placeholder: "표지 하단·페이지 푸터에 표시" },
];

export default function ReportSettingsModal({
  open, onClose, sectionToggles, metadata, onMetadataChange,
}: ReportSettingsModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="보고서 설정" width="max-w-md">
      <div className="flex flex-col gap-5">
        {/* 표시 섹션 */}
        <section className="flex flex-col gap-2">
          <h3 className="text-[11px] font-bold uppercase tracking-[0.06em] text-gray-400">
            표시 섹션
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {sectionToggles.map((s) => (
              <button
                key={s.key}
                onClick={s.onToggle}
                className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                  s.active
                    ? "bg-[#a60739]/10 font-medium text-[#a60739] ring-1 ring-inset ring-[#a60739]/20"
                    : "bg-gray-50 text-gray-400 ring-1 ring-inset ring-gray-200 hover:bg-gray-100"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-gray-400">
            끄면 해당 섹션이 프리뷰·PDF 에서 제외됩니다.
          </p>
        </section>

        {/* 보고서 정보 (메타데이터) */}
        <section className="flex flex-col gap-2.5 border-t border-gray-100 pt-4">
          <h3 className="text-[11px] font-bold uppercase tracking-[0.06em] text-gray-400">
            보고서 정보
          </h3>
          <div className="grid grid-cols-2 gap-2.5">
            {META_FIELDS.map((f) => (
              <label
                key={f.key}
                className={`flex flex-col gap-1 ${f.key === "footer" ? "col-span-2" : ""}`}
              >
                <span className="text-[11px] font-medium text-gray-500">{f.label}</span>
                <input
                  type="text"
                  value={metadata[f.key] ?? ""}
                  placeholder={f.placeholder}
                  onChange={(e) => onMetadataChange({ [f.key]: e.target.value } as Partial<ReportMetadata>)}
                  className="h-9 rounded-lg border border-gray-200 px-3 text-sm text-gray-800 outline-none transition-colors placeholder:text-gray-300 focus:border-[#a60739]"
                />
              </label>
            ))}
          </div>
          <p className="text-[11px] text-gray-400">
            기관·부서는 표지 상단(KAC 마크 옆)과 발행기관 행에, 푸터는 표지 하단에 표시됩니다.
          </p>
        </section>

        {/* 완료 */}
        <div className="flex justify-end border-t border-gray-100 pt-4">
          <button
            onClick={onClose}
            className="rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#85062e]"
          >
            완료
          </button>
        </div>
      </div>
    </Modal>
  );
}
