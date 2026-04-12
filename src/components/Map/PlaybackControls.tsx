import { useState, useRef, useEffect } from "react";
import { Play, Pause } from "lucide-react";

const SPEED_OPTIONS = [1, 60, 120, 300];

interface Props {
  playing: boolean;
  setPlaying: (v: boolean | ((prev: boolean) => boolean)) => void;
  sliderValue: number;
  setSliderValue: (v: number | ((prev: number) => number)) => void;
  rangeStart: number;
  setRangeStart: (v: number | ((prev: number) => number)) => void;
  trailDuration: number;
  setTrailDuration: (v: number) => void;
  timeRange: { min: number; max: number };
  isAllTrackMode: boolean;
  maxWindowSecs: number;
}

export default function PlaybackControls({
  playing, setPlaying, sliderValue, setSliderValue,
  rangeStart, setRangeStart, trailDuration, setTrailDuration,
  timeRange, isAllTrackMode, maxWindowSecs,
}: Props) {
  const [playSpeed, setPlaySpeed] = useState(1);
  const [speedDropOpen, setSpeedDropOpen] = useState(false);
  const [trailDropOpen, setTrailDropOpen] = useState(false);
  const speedRef = useRef<HTMLDivElement>(null);
  const trailRef = useRef<HTMLDivElement>(null);
  const playRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 드롭다운 외부 클릭 닫기
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (speedRef.current && !speedRef.current.contains(e.target as Node)) setSpeedDropOpen(false);
      if (trailRef.current && !trailRef.current.contains(e.target as Node)) setTrailDropOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // 재생 (실제 시간 기준 배속)
  useEffect(() => {
    if (playing) {
      const totalDuration = timeRange.max - timeRange.min;
      const stepPct = totalDuration > 0 ? (0.1 * playSpeed / totalDuration) * 100 : 0.1;
      const windowPct = totalDuration > 0 ? (maxWindowSecs / totalDuration) * 100 : 100;
      playRef.current = setInterval(() => {
        setSliderValue((v: number) => {
          if (v >= 100) {
            setPlaying(false);
            return 100;
          }
          const newV = Math.min(v + stepPct, 100);
          if (isAllTrackMode && totalDuration > maxWindowSecs) {
            setRangeStart((rs: number) => {
              const gap = newV - rs;
              return gap > windowPct ? newV - windowPct : rs;
            });
          }
          return newV;
        });
      }, 100);
    } else {
      if (playRef.current) {
        clearInterval(playRef.current);
        playRef.current = null;
      }
    }
    return () => {
      if (playRef.current) clearInterval(playRef.current);
    };
  }, [playing, playSpeed, timeRange, isAllTrackMode, maxWindowSecs, setSliderValue, setRangeStart, setPlaying]);

  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">재생</div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            if (!playing && sliderValue >= 99.9) {
              setSliderValue(rangeStart);
            }
            setPlaying(!playing);
          }}
          className="flex h-7 w-7 items-center justify-center rounded-full bg-[#a60739] text-white hover:bg-[#85062e] transition-colors"
          title={playing ? "일시정지" : "재생"}
        >
          {playing ? <Pause size={12} fill="white" /> : <Play size={12} fill="white" className="ml-0.5" />}
        </button>

        {/* 배속 뱃지 */}
        <div ref={speedRef} className="relative">
          <button
            onClick={() => { setSpeedDropOpen(!speedDropOpen); setTrailDropOpen(false); }}
            className="flex h-6 items-center justify-center rounded-md border border-gray-200 bg-gray-50 px-1.5 text-[10px] font-semibold leading-none text-gray-600 hover:border-gray-300 transition-colors"
          >
            {playSpeed}x
          </button>
          {speedDropOpen && (
            <div className="absolute left-1/2 -translate-x-1/2 top-full z-[2000] mt-1 w-20 rounded-lg border border-gray-200 bg-white shadow-lg py-1">
              {SPEED_OPTIONS.map((sp) => (
                <button
                  key={sp}
                  onClick={() => { setPlaySpeed(sp); setSpeedDropOpen(false); }}
                  className={`w-full px-3 py-1 text-left text-xs transition-colors ${
                    playSpeed === sp ? "bg-[#a60739] text-white" : "text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  {sp}x
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Trail 뱃지 */}
        <div ref={trailRef} className="relative">
          <button
            onClick={() => { setTrailDropOpen(!trailDropOpen); setSpeedDropOpen(false); }}
            className="flex h-6 items-center justify-center rounded-md border border-gray-200 bg-gray-50 px-1.5 text-[10px] font-semibold leading-none text-gray-600 hover:border-gray-300 transition-colors"
          >
            {trailDuration === 0 ? "전체" : "30분"}
          </button>
          {trailDropOpen && (
            <div className="absolute left-1/2 -translate-x-1/2 top-full z-[2000] mt-1 w-20 rounded-lg border border-gray-200 bg-white shadow-lg py-1">
              {([0, 1800] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => { setTrailDuration(d); setTrailDropOpen(false); }}
                  className={`w-full px-3 py-1 text-left text-xs transition-colors ${
                    trailDuration === d ? "bg-[#a60739] text-white" : "text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  {d === 0 ? "전체" : "30분"}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
