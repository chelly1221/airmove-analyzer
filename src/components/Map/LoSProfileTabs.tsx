// LoS 단면도 탭 래퍼 — 특정 건물 분석 시 중앙/좌끝/우끝 방위별 단면도를 탭으로 전환.
// 패널(LoSProfilePanel)은 (targetLat,targetLon) 단일 타겟에 모든 계산이 종속되므로,
// 탭 전환 = 활성 view의 타겟만 스왑(패널 내부 불변). 단일 view면 탭바 없이 그대로 렌더.
import { useState, useRef, useEffect, type ComponentProps } from "react";
import LoSProfilePanel from "./LoSProfilePanel";

const ACCENT = "#a60739";

export interface AzView {
  lat: number;
  lon: number;
  /** 탭 라벨 (좌끝/중앙/우끝) */
  label: string;
  /** 방위(°) */
  az: number;
}

type PanelProps = ComponentProps<typeof LoSProfilePanel>;

interface Props extends Omit<PanelProps, "targetLat" | "targetLon"> {
  /** 방위별 타겟. length>1이면 탭 표시 */
  views: AzView[];
  /** 활성 탭 인덱스 보고 (지도 방위 마커 활성 강조 동기용) */
  onActiveViewChange?: (idx: number) => void;
}

export default function LoSProfileTabs({ views, onLoaded, searchedAddress, onActiveViewChange, ...rest }: Props) {
  const multi = views.length > 1;
  // views 시그니처 (새 건물 진입 감지)
  const viewsKey = views.map((v) => v.az.toFixed(4)).join(",");
  const centerIdx = (() => {
    const i = views.findIndex((v) => v.label === "중앙");
    return i >= 0 ? i : Math.floor(views.length / 2);
  })();

  const [activeTab, setActiveTab] = useState(centerIdx);
  const safeActive = Math.min(activeTab, views.length - 1);

  // 새 건물(또는 단일 타겟 변경) → 중앙 탭으로 리셋 + onLoaded 게이트 리셋
  const loadedOnceRef = useRef(false);
  useEffect(() => {
    setActiveTab(centerIdx);
    loadedOnceRef.current = false;
  }, [viewsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 활성 탭 인덱스 보고 — 지도 방위 마커(좌끝/중앙/우끝) 활성 강조 동기용
  useEffect(() => {
    onActiveViewChange?.(safeActive);
  }, [safeActive, viewsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 카메라 재이동(fitBounds)은 건물셋 첫 로드에만 — 탭 전환 시엔 억제
  const handleLoaded = () => {
    if (!loadedOnceRef.current) {
      loadedOnceRef.current = true;
      onLoaded?.();
    }
  };

  const active = views[safeActive];

  return (
    <div className="flex flex-col">
      {multi && (
        <div className="flex items-stretch gap-1 border-t border-gray-200 bg-gray-50 px-3 pt-1.5">
          {views.map((v, i) => {
            const on = i === safeActive;
            return (
              <button
                key={i}
                onClick={() => setActiveTab(i)}
                className={`flex items-baseline gap-1 rounded-t-md px-3 py-1.5 text-[11px] font-semibold transition-colors border-b-2 ${
                  on ? "text-[#a60739]" : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
                style={on ? { borderColor: ACCENT } : undefined}
              >
                {v.label}
                <span className="font-mono text-[9px] font-medium opacity-70">{v.az.toFixed(1)}°</span>
              </button>
            );
          })}
        </div>
      )}
      <LoSProfilePanel
        {...rest}
        targetLat={active.lat}
        targetLon={active.lon}
        // 모든 탭에 전달 — 자동선택(클릭 상태 강제)이 폐지돼 오선택 우려가 없고,
        //   좌/우끝 탭에서도 대상 건물을 목록에 강제 포함시키고 파란색으로 구분하려면 필요
        searchedAddress={searchedAddress}
        onLoaded={handleLoaded}
      />
    </div>
  );
}
