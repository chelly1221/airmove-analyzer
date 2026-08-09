import { useRef } from "react";
import { AlertTriangle } from "lucide-react";
import Modal from "../components/common/Modal";

/**
 * 투어 전용 가상 "데이터베이스 가져오기" 확인 모달 (Settings.tsx 확인 모달 모사).
 * 시각적 시뮬레이션 전용 — 실제 가져오기(데이터 교체)는 일절 실행하지 않는다.
 */

interface Props {
  onConfirm: () => void;
  onCancel: () => void;
}

export default function TourFakeImportConfirm({ onConfirm, onCancel }: Props) {
  // [가져오기] 2연타로 advance 가 두 번 돌아 스텝이 스킵되는 것 방지 (마운트당 1회)
  const confirmedRef = useRef(false);

  const confirm = () => {
    if (confirmedRef.current) return;
    confirmedRef.current = true;
    onConfirm();
  };

  return (
    <Modal open onClose={onCancel} title="데이터베이스 가져오기" width="max-w-sm">
      <div className="space-y-4">
        <span className="inline-block rounded bg-[#a60739]/10 px-1.5 py-0.5 text-[10px] text-[#a60739]">
          투어 시뮬레이션 — 실제 데이터가 변경되지 않습니다
        </span>
        <div className="flex items-start gap-3 rounded-lg bg-amber-50 border border-amber-200 p-3">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-600" />
          <p className="text-sm text-amber-800">
            현재 저장된 모든 데이터(운항이력, ADS-B 항적, 파싱 데이터, 설정)가 선택한 파일의 데이터로 교체됩니다. 이 작업은 되돌릴 수 없습니다.
            ZIP 백업에 실측 3D 타일이 포함되어 있으면 타일 폴더도 함께 복원되어 새 경로로 재등록됩니다.
          </p>
        </div>
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 transition-colors"
          >
            취소
          </button>
          <button
            data-tour="fake-import-confirm"
            onClick={confirm}
            className="rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white hover:bg-[#85062e] transition-colors"
          >
            가져오기
          </button>
        </div>
      </div>
    </Modal>
  );
}
