import { useEffect, useRef, useState } from "react";
import { ChevronRight, FileText, Search, X } from "lucide-react";

/**
 * 투어 전용 가상 파일 선택 화면 (Windows 탐색기 "열기"/"다른 이름으로 저장" 다이얼로그 모사).
 * 시각적 시뮬레이션 전용 — 실제 파일시스템 접근·파싱은 일절 없다.
 */

export interface FakeFile {
  name: string;
  modified: string;
  size: string;
}

/** 가상 ASS 파일 목록 (실제 자료 아님) */
const FAKE_FILES: FakeFile[] = [
  { name: "GMP_RDR1_20260807_0900.ass", modified: "2026-08-07 오전 10:05", size: "412 MB" },
  { name: "GMP_RDR1_20260807_1200.ass", modified: "2026-08-07 오후 1:03", size: "398 MB" },
  { name: "GMP_RDR2_20260807_0900.ass", modified: "2026-08-07 오전 10:07", size: "405 MB" },
];

interface Props {
  /** 파일을 처음 선택했을 때 (최초 1회만) */
  onPick: () => void;
  onOpen: () => void;
  onCancel: () => void;
  /** "save" 는 저장 다이얼로그 모사 — 목록은 장식이고 파일명은 프리필된다 (기본 "open") */
  mode?: "open" | "save";
  /** 목록에 표시할 가상 파일 (기본 ASS 저장자료) */
  files?: FakeFile[];
  /** 경로 표시줄 세그먼트 (마지막 항목이 현재 폴더) */
  pathSegments?: string[];
  /** 파일 형식 표기 */
  filterLabel?: string;
  /** save 모드 파일 이름 프리필 */
  defaultName?: string;
}

export default function TourFakeFileDialog({
  onPick,
  onOpen,
  onCancel,
  mode = "open",
  files = FAKE_FILES,
  pathSegments = ["내 PC", "문서", "레이더저장자료"],
  filterLabel = "ASS 파일 (*.ass)",
  defaultName = "",
}: Props) {
  const isSave = mode === "save";
  const [selected, setSelected] = useState<number | null>(null);
  // onPick 은 최초 선택 1회만 — 다른 파일로 바꿔도 스텝이 중복 진행되지 않도록
  const pickedRef = useRef(false);
  // [열기] 2연타로 advance 가 두 번 돌아 스텝이 스킵되는 것 방지 (마운트당 1회)
  const openedRef = useRef(false);

  // ESC 취소 (투어 ESC 종료 핸들러는 오버레이 활성 중 억제됨)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  const pick = (i: number) => {
    setSelected(i);
    if (!pickedRef.current) {
      pickedRef.current = true;
      onPick();
    }
  };

  const open = () => {
    if (openedRef.current) return;
    openedRef.current = true;
    onOpen();
  };

  return (
    <div className="fixed inset-0 z-[10005] flex items-center justify-center bg-black/30">
      <div className="w-[560px] overflow-hidden rounded-lg border border-gray-300 bg-white shadow-2xl">
        {/* 타이틀바 */}
        <div className="flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2">
          <span className="text-xs font-medium text-gray-700">{isSave ? "다른 이름으로 저장" : "열기"}</span>
          <span className="rounded bg-[#a60739]/10 px-1.5 py-0.5 text-[10px] text-[#a60739]">
            투어 시뮬레이션 — 실제 파일이 아닙니다
          </span>
          <button
            onClick={onCancel}
            className="ml-auto rounded p-0.5 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-700"
            aria-label="닫기"
          >
            <X size={14} />
          </button>
        </div>

        {/* 경로 + 검색창(장식) */}
        <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2">
          <div className="flex flex-1 items-center gap-1 rounded border border-gray-200 bg-white px-2 py-1 text-[11px] text-gray-600">
            {pathSegments.map((seg, i) => (
              <span key={seg} className="flex items-center gap-1">
                {i > 0 && <ChevronRight size={11} className="text-gray-400" />}
                <span className={i === pathSegments.length - 1 ? "font-medium text-gray-800" : undefined}>{seg}</span>
              </span>
            ))}
          </div>
          <div className="flex w-32 items-center gap-1 rounded border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] text-gray-400">
            <Search size={11} />
            <span>검색</span>
          </div>
        </div>

        {/* 컬럼 헤더 */}
        <div className="flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-1.5 text-[10px] font-medium text-gray-500">
          <span className="flex-1">이름</span>
          <span className="w-36">수정한 날짜</span>
          <span className="w-16 text-right">크기</span>
        </div>

        {/* 파일 목록 — save 모드는 기존 백업을 보여주는 장식이라 클릭 불가 */}
        <div data-tour="fake-file-list" className="max-h-52 overflow-y-auto py-1">
          {files.map((f, i) => {
            const row = (
              <>
                <FileText size={13} className="shrink-0 text-gray-400" />
                <span className="flex-1 truncate text-[11px] text-gray-800">{f.name}</span>
                <span className="w-36 text-[10px] text-gray-400">{f.modified}</span>
                <span className="w-16 text-right text-[10px] text-gray-400">{f.size}</span>
              </>
            );
            return isSave ? (
              <div key={f.name} className="flex w-full items-center gap-2 px-3 py-1.5 text-left">
                {row}
              </div>
            ) : (
              <button
                key={f.name}
                onClick={() => pick(i)}
                onDoubleClick={() => { pick(i); open(); }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                  selected === i ? "bg-[#a60739]/10" : "hover:bg-gray-50"
                }`}
              >
                {row}
              </button>
            );
          })}
        </div>

        {/* 하단: 파일 이름 + 형식 + 버튼 */}
        <div className="border-t border-gray-200 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="w-14 text-[11px] text-gray-500">파일 이름</span>
            <input
              type="text"
              readOnly
              value={isSave ? defaultName : selected === null ? "" : files[selected].name}
              className="flex-1 rounded border border-gray-200 bg-white px-2 py-1 text-[11px] text-gray-700 outline-none"
            />
            <span className="text-[11px] text-gray-400">{filterLabel}</span>
          </div>
          <div className="mt-2.5 flex items-center justify-end gap-2">
            {isSave ? (
              <button
                data-tour="fake-file-save"
                onClick={open}
                className="rounded-lg bg-[#a60739] px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#8a062f]"
              >
                저장
              </button>
            ) : (
              <button
                data-tour="fake-file-open"
                onClick={open}
                disabled={selected === null}
                className="rounded-lg bg-[#a60739] px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#8a062f] disabled:opacity-40"
              >
                열기
              </button>
            )}
            <button
              onClick={onCancel}
              className="rounded-lg border border-gray-200 px-4 py-1.5 text-xs text-gray-600 transition-colors hover:bg-gray-50"
            >
              취소
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
