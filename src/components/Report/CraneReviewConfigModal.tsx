/**
 * 「타워크레인 전파영향 검토 보고서」 설정 모달 (메인 창 · 보고서 생성 페이지).
 *
 * 크레인·시설·BRA 기준각·분석 각도를 골라 페이로드를 IndexedDB 에 쓰고 별도 창(crane-review)을 연다.
 * 분석 자체는 그 창이 수행한다(의견서 bra-review 와 동일한 아키텍처).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { Loader2 } from "lucide-react";
import Modal from "../common/Modal";
import { writeCraneReviewPayload } from "../../utils/reportTransfer";
import type { CraneReviewPayload } from "../../utils/craneReviewShared";
import type { RadarSite, TowerCrane } from "../../types";

/** BRA 기준각 허용 범위 (°) */
const ANGLE_MIN = 0.05;
const ANGLE_MAX = 10;

interface Props {
  open: boolean;
  onClose: () => void;
  /** 등록된 타워크레인 (스토어 towerCranes) */
  cranes: TowerCrane[];
  /** 검토 대상 후보 시설 (활성 customRadarSites) */
  radarSites: RadarSite[];
  /** BRA 기준각 기본값 (스토어 braAngleDeg) */
  defaultBraAngleDeg: number;
}

/** 지정 방위각 문자열 파싱 — 쉼표 구분 정수 0–359. 잘못된 토큰이 하나라도 있으면 에러 */
function parseCustomAngles(text: string): { angles: number[]; error: string | null } {
  const raw = text.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  const angles: number[] = [];
  for (const token of raw) {
    if (!/^\d{1,3}$/.test(token)) {
      return { angles: [], error: `방위각 '${token}' 은(는) 0–359 정수가 아닙니다` };
    }
    const v = Number(token);
    if (v > 359) {
      return { angles: [], error: `방위각 '${token}' 은(는) 0–359 범위를 벗어났습니다` };
    }
    if (!angles.includes(v)) angles.push(v);
  }
  angles.sort((a, b) => a - b);
  return { angles, error: null };
}

export default function CraneReviewConfigModal({
  open,
  onClose,
  cranes,
  radarSites,
  defaultBraAngleDeg,
}: Props) {
  const [craneIds, setCraneIds] = useState<number[]>([]);
  const [siteNames, setSiteNames] = useState<string[]>([]);
  const [angleText, setAngleText] = useState(String(defaultBraAngleDeg));
  const [customText, setCustomText] = useState("");
  const [customCrossSections, setCustomCrossSections] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 모달을 열 때마다 기본값 재시드 (전체 선택 · 스토어 기준각)
  useEffect(() => {
    if (!open) return;
    setCraneIds(cranes.map((c) => c.id));
    setSiteNames(radarSites.map((s) => s.name));
    setAngleText(String(defaultBraAngleDeg));
    setCustomText("");
    setCustomCrossSections(false);
    setSubmitError(null);
    setSubmitting(false);
  }, [open, cranes, radarSites, defaultBraAngleDeg]);

  const parsed = useMemo(() => parseCustomAngles(customText), [customText]);
  const braAngleDeg = Number(angleText);
  const angleValid =
    angleText.trim().length > 0 &&
    Number.isFinite(braAngleDeg) &&
    braAngleDeg >= ANGLE_MIN &&
    braAngleDeg <= ANGLE_MAX;

  const validationError =
    craneIds.length === 0
      ? "타워크레인을 1기 이상 선택하세요"
      : siteNames.length === 0
        ? "검토 시설을 1개 이상 선택하세요"
        : !angleValid
          ? `BRA 기준각은 ${ANGLE_MIN}–${ANGLE_MAX}° 범위의 값이어야 합니다`
          : parsed.error;

  const toggleCrane = useCallback((id: number) => {
    setCraneIds((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));
  }, []);
  const toggleSite = useCallback((name: string) => {
    setSiteNames((prev) => (prev.includes(name) ? prev.filter((v) => v !== name) : [...prev, name]));
  }, []);

  const handleGenerate = useCallback(async () => {
    if (validationError) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // 선택 순서가 아닌 등록 순서를 유지한다 (문서 표·차트 순서 안정)
      const selectedCranes = cranes.filter((c) => craneIds.includes(c.id));
      const selectedSites = radarSites.filter((s) => siteNames.includes(s.name));
      const angles = parsed.angles;
      const payload: CraneReviewPayload = {
        version: 1,
        generatedAt: new Date().toISOString(),
        cranes: selectedCranes,
        radarSites: selectedSites,
        braAngleDeg,
        customAngles: angles,
        customCrossSections,
        reviewKey: [
          selectedCranes.map((c) => c.id).join(","),
          selectedSites.map((s) => s.name).join(","),
          braAngleDeg,
          angles.join(","),
          customCrossSections,
        ].join("|"),
      };
      await writeCraneReviewPayload(payload);
      const existing = (await getAllWebviewWindows()).find((w) => w.label === "crane-review");
      if (existing) {
        await emit("cranereview:reload");
        await existing.setFocus();
      } else {
        new WebviewWindow("crane-review", {
          url: "index.html",
          title: "타워크레인 전파영향 검토 보고서 — AirMove Analyzer",
          width: 940,
          height: 1000,
          minWidth: 820,
          minHeight: 700,
          decorations: false,
          shadow: true,
          center: true,
        });
      }
      onClose();
    } catch (e) {
      setSubmitError(`보고서 창 열기 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSubmitting(false);
    }
  }, [
    validationError, cranes, radarSites, craneIds, siteNames,
    parsed.angles, braAngleDeg, customCrossSections, onClose,
  ]);

  return (
    <Modal open={open} onClose={onClose} title="타워크레인 전파영향 검토 보고서" width="max-w-2xl">
      <div className="space-y-5">
        {/* ① 검토 대상 타워크레인 */}
        <section>
          <h3 className="mb-2 text-sm font-semibold text-gray-700">검토 대상 타워크레인</h3>
          <div className="max-h-52 overflow-y-auto rounded-lg border border-gray-200">
            {cranes.map((c) => (
              <label
                key={c.id}
                className="flex cursor-pointer items-center gap-2 border-b border-gray-100 px-3 py-2 last:border-b-0 hover:bg-gray-50"
              >
                <input
                  type="checkbox"
                  checked={craneIds.includes(c.id)}
                  onChange={() => toggleCrane(c.id)}
                  className="h-3.5 w-3.5 accent-[#a60739]"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-gray-800">{c.name}</span>
                <span className="shrink-0 text-[11px] text-gray-500">
                  지브고 {c.jib_height.toFixed(1)} m · 지브 {c.jib_length.toFixed(1)} m
                </span>
              </label>
            ))}
          </div>
        </section>

        {/* ② 검토 시설 */}
        <section>
          <h3 className="mb-2 text-sm font-semibold text-gray-700">검토 시설</h3>
          <div className="max-h-40 overflow-y-auto rounded-lg border border-gray-200">
            {radarSites.map((s) => (
              <label
                key={s.name}
                className="flex cursor-pointer items-center gap-2 border-b border-gray-100 px-3 py-2 last:border-b-0 hover:bg-gray-50"
              >
                <input
                  type="checkbox"
                  checked={siteNames.includes(s.name)}
                  onChange={() => toggleSite(s.name)}
                  className="h-3.5 w-3.5 accent-[#a60739]"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-gray-800">{s.name}</span>
                <span className="shrink-0 text-[11px] text-gray-500">
                  안테나 {(s.altitude + s.antenna_height).toFixed(1)} m MSL
                </span>
              </label>
            ))}
          </div>
        </section>

        {/* ③ BRA 기준각 */}
        <section>
          <h3 className="mb-2 text-sm font-semibold text-gray-700">BRA 기준각</h3>
          <div className="flex items-center gap-2">
            <input
              type="number"
              step={0.05}
              min={ANGLE_MIN}
              max={ANGLE_MAX}
              value={angleText}
              onChange={(e) => setAngleText(e.target.value)}
              className="w-28 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-800 focus:border-[#a60739] focus:outline-none"
            />
            <span className="text-sm text-gray-500">° ({ANGLE_MIN}–{ANGLE_MAX})</span>
          </div>
        </section>

        {/* ④ 분석 각도 */}
        <section>
          <h3 className="mb-2 text-sm font-semibold text-gray-700">분석 각도</h3>
          <p className="mb-2 text-[11px] leading-relaxed text-gray-500">
            최악각·최선각·전방위 최악조건·등록 방위각은 자동 포함됩니다. 추가로 검토할 지브 방위각을 지정하세요.
          </p>
          <input
            type="text"
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            placeholder="예: 0, 45, 90 (쉼표 구분 정수 0–359)"
            className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-800 focus:border-[#a60739] focus:outline-none"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => setCustomText([0, 45, 90, 135, 180, 225, 270, 315].join(", "))}
              className="rounded-md border border-gray-200 px-2.5 py-1 text-[11px] text-gray-600 transition-colors hover:bg-gray-100"
            >
              8방위
            </button>
            <button
              onClick={() =>
                setCustomText(
                  Array.from({ length: 16 }, (_, i) => Math.round(i * 22.5)).join(", "),
                )
              }
              className="rounded-md border border-gray-200 px-2.5 py-1 text-[11px] text-gray-600 transition-colors hover:bg-gray-100"
            >
              16방위
            </button>
            <button
              onClick={() => setCustomText("")}
              className="rounded-md border border-gray-200 px-2.5 py-1 text-[11px] text-gray-600 transition-colors hover:bg-gray-100"
            >
              지우기
            </button>
          </div>
          <label className="mt-3 flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={customCrossSections}
              onChange={(e) => setCustomCrossSections(e.target.checked)}
              className="h-3.5 w-3.5 accent-[#a60739]"
            />
            <span className="text-sm text-gray-700">지정 각도 수직 단면도 포함</span>
          </label>
        </section>

        {/* 검증·실행 */}
        {(validationError || submitError) && (
          <p className="text-[12px] text-[#e94560]">{submitError ?? validationError}</p>
        )}
        <div className="flex justify-end gap-2 border-t border-gray-200 pt-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-200 px-4 py-1.5 text-sm text-gray-600 transition-colors hover:bg-gray-100"
          >
            취소
          </button>
          <button
            onClick={() => void handleGenerate()}
            disabled={validationError != null || submitting}
            className="flex items-center gap-1.5 rounded-lg bg-[#a60739] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#85062e] disabled:opacity-40"
          >
            {submitting && <Loader2 size={14} className="animate-spin" />}
            보고서 생성
          </button>
        </div>
      </div>
    </Modal>
  );
}
