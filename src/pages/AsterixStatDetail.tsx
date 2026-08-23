/**
 * ASTERIX 통계 상세 페이지 (/asterix/stats/:topic)
 *
 * 라우트는 토픽 파라미터 하나만 갖는 단일 라우트라 토픽을 바꿔도 이 컴포넌트는
 * 리마운트되지 않는다 — 필터(useState)와 tz 가 토픽 전환 중에도 보존되는 불변식.
 * (라우트를 토픽별로 쪼개면 이 불변식이 깨지므로 금지)
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Binary, Loader2 } from "lucide-react";
import { useAppStore } from "../store";
import DetailFilterBar from "../components/asterix/DetailFilterBar";
import { useAsterixDetail } from "../hooks/useAsterixDetail";
import TimeDetail from "../components/asterix/topics/TimeDetail";
import TrafficDetail from "../components/asterix/topics/TrafficDetail";
import AltSpeedDetail from "../components/asterix/topics/AltSpeedDetail";
import IdentityDetail from "../components/asterix/topics/IdentityDetail";
import Mode3aDetail from "../components/asterix/topics/Mode3aDetail";
import BdsDetail from "../components/asterix/topics/BdsDetail";
import SourceDetail from "../components/asterix/topics/SourceDetail";
import PsrDetail from "../components/asterix/topics/PsrDetail";
import QualityDetail from "../components/asterix/topics/QualityDetail";
import { ASTERIX_STAT_TOPICS } from "../types/asterixDetail";
import type { AsterixDetailFilter, AsterixDetailStats, TzMode } from "../types/asterixDetail";

export default function AsterixStatDetail() {
  const { topic } = useParams();
  const navigate = useNavigate();
  const stats = useAppStore((s) => s.asterixStats);

  const def = ASTERIX_STAT_TOPICS.find((t) => t.id === topic);

  // 필터·tz 는 이 페이지가 소유 (토픽 전환 시에도 유지 — 상단 주석의 불변식)
  const [filter, setFilter] = useState<AsterixDetailFilter>({});
  const [tz, setTz] = useState<TzMode>("KST");
  /**
   * 실제로 "적용"되어 재집계에 반영된 필터 — 편집 중(filter)과 구분한다.
   * 토픽 본문이 서버 재집계 결과와 같은 조건으로 프런트 필터를 걸 때 쓴다(BDS·ACAS 이벤트 상속).
   */
  const [appliedFilter, setAppliedFilter] = useState<AsterixDetailFilter>({});
  const { data, loading, progress, error, run } = useAsterixDetail();

  /** run 호출과 appliedFilter 갱신을 한 곳에서 묶는다 — 둘이 갈라지지 않도록 */
  const runWith = useCallback(
    (f: AsterixDetailFilter) => {
      setAppliedFilter(f);
      run(f);
    },
    [run],
  );

  const apply = useCallback(() => runWith(filter), [runWith, filter]);

  /**
   * 퀵필터 — 토픽 본문의 차트/표에서 조건을 즉시 적용하고 그대로 재집계한다("적용" 누를 필요 없음).
   *
   * undefined 값 키는 제거한다 — DetailFilterBar 의 patch() 와 동일 규칙.
   * useAsterixDetail 의 LRU 캐시 키가 JSON.stringify(filter) 라 키가 남아 있으면
   * 같은 조건인데도 캐시가 어긋나 전수 재스캔이 다시 돈다.
   */
  const onQuickFilter = useCallback(
    (p: Partial<AsterixDetailFilter>) => {
      const next: AsterixDetailFilter = { ...filter, ...p };
      for (const k of Object.keys(next) as (keyof AsterixDetailFilter)[]) {
        if (next[k] === undefined) delete next[k];
      }
      setFilter(next);
      runWith(next);
    },
    [filter, runWith],
  );

  // 마운트 시 현재 필터로 1회 자동 실행 (캐시 히트면 재스캔 없이 즉시 반환)
  const autoRan = useRef(false);
  useEffect(() => {
    // 잘못된 토픽(리다이렉트 예정)에서는 스캔을 걸지 않는다
    if (autoRan.current || !stats || !def) return;
    autoRan.current = true;
    runWith(filter);
    // 최초 1회만 — filter 변경 시 재실행은 "적용" 버튼이 담당
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats]);

  if (!def) return <Navigate to="/asterix/stats" replace />;

  return (
    <div className="flex h-full flex-col bg-white">
      {/* 헤더 */}
      <div className="mb-3 flex items-center gap-2">
        <button
          onClick={() => navigate("/asterix/stats")}
          className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-500 transition-colors hover:border-[#a60739]/40 hover:text-[#a60739]"
        >
          <ArrowLeft size={12} />
          통계
        </button>
        <Binary size={18} className="text-[#a60739]" />
        <h1 className="text-base font-semibold text-gray-800">{def.title}</h1>
        {data && (
          <span className="ml-auto text-[11px] tabular-nums text-gray-400">
            필터 적용{" "}
            <span className="font-semibold text-gray-700">{data.stats.record_count.toLocaleString()}</span> / 전체{" "}
            {data.unfiltered_records.toLocaleString()} 레코드
          </span>
        )}
      </div>

      {!stats ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-gray-400">
          <p>ASTERIX 데이터가 없습니다. 먼저 ASS 파일을 스캔하세요.</p>
          <button
            onClick={() => navigate("/asterix/stats")}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#8a062f]"
          >
            통계 대시보드로 이동
          </button>
        </div>
      ) : (
        <>
          <DetailFilterBar
            filter={filter}
            onChange={setFilter}
            onApply={apply}
            busy={loading}
            baseStats={stats}
            tz={tz}
            setTz={setTz}
          />

          {error && (
            <div className="mt-2 rounded-lg border border-[#e94560]/30 bg-[#e94560]/5 px-3 py-2 text-[11px] text-[#e94560]">
              상세 재집계 실패 — {error}
            </div>
          )}

          <div className="relative mt-3 min-h-0 flex-1 overflow-auto">
            {data ? (
              <TopicBody
                topic={def.id}
                detail={data}
                tz={tz}
                setTz={setTz}
                appliedFilter={appliedFilter}
                onQuickFilter={onQuickFilter}
              />
            ) : loading ? (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-gray-400">
                <Loader2 size={16} className="animate-spin text-[#a60739]" />
                재집계 중{progress ? ` (파일 ${progress.done}/${progress.total})` : ""}...
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-gray-400">
                필터를 설정하고 "적용"을 누르세요
              </div>
            )}

            {/* 기존 데이터 위 반투명 오버레이 — 스캔 중에도 직전 결과를 계속 읽을 수 있게 */}
            {loading && data && (
              <div className="absolute inset-0 z-20 flex items-start justify-center bg-white/60 pt-10 backdrop-blur-[1px]">
                <div className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-[12px] text-gray-600 shadow-sm">
                  <Loader2 size={14} className="animate-spin text-[#a60739]" />
                  재집계 중{progress ? ` (파일 ${progress.done}/${progress.total})` : ""}...
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** 토픽 → 본문 컴포넌트 */
function TopicBody({
  topic,
  detail,
  tz,
  setTz,
  appliedFilter,
  onQuickFilter,
}: {
  topic: (typeof ASTERIX_STAT_TOPICS)[number]["id"];
  detail: AsterixDetailStats;
  tz: TzMode;
  /** BDS·ACAS 토픽 전용 — ACAS RA 이벤트 표의 기간 팝오버가 페이지 tz 를 그대로 바꾼다 */
  setTz: (t: TzMode) => void;
  /** 적용된 필터 — RA 이벤트 목록 상속(BDS) + 차트의 현재 필터 구간 하이라이트(시간/거리·방위/고도·속도) */
  appliedFilter: AsterixDetailFilter;
  /** 차트·표에서 조건을 즉시 적용해 재집계 (드릴다운) */
  onQuickFilter: (p: Partial<AsterixDetailFilter>) => void;
}) {
  switch (topic) {
    case "time":
      return <TimeDetail detail={detail} tz={tz} appliedFilter={appliedFilter} onQuickFilter={onQuickFilter} />;
    case "traffic":
      return <TrafficDetail detail={detail} appliedFilter={appliedFilter} onQuickFilter={onQuickFilter} />;
    case "altspeed":
      return <AltSpeedDetail detail={detail} appliedFilter={appliedFilter} onQuickFilter={onQuickFilter} />;
    case "identity":
      return <IdentityDetail detail={detail} tz={tz} onQuickFilter={onQuickFilter} />;
    case "mode3a":
      return <Mode3aDetail detail={detail} tz={tz} onQuickFilter={onQuickFilter} />;
    case "bds":
      return (
        <BdsDetail
          detail={detail}
          tz={tz}
          setTz={setTz}
          appliedFilter={appliedFilter}
          onQuickFilter={onQuickFilter}
        />
      );
    case "source":
      return <SourceDetail detail={detail} tz={tz} onQuickFilter={onQuickFilter} />;
    case "psr":
      return <PsrDetail detail={detail} tz={tz} appliedFilter={appliedFilter} onQuickFilter={onQuickFilter} />;
    case "quality":
      return <QualityDetail detail={detail} tz={tz} onQuickFilter={onQuickFilter} />;
  }
}
