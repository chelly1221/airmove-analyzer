/**
 * 토픽: BDS 레지스터·ACAS 상세.
 *
 * I048/250 Mode-S MB 블록(BDS 레지스터)과 ACAS 해결권고(RA) 발생을 함께 본다.
 * - 레지스터 분포는 "MB 블록 수" 기준 — 한 레코드에 MB 블록이 여러 개(최대 8) 실리므로
 *   레코드 수와 분모가 다르다. 점유율 분모는 항상 MB 블록 총수.
 * - ACAS RA 레코드 수(stats.acas_ra_records)는 I048/260 또는 BDS 3,0 보유 레코드 기준이라
 *   BDS 3,0 MB 블록 수와 반드시 일치하지는 않는다(I260만 있는 레코드 존재).
 *
 * 전수 렌더 — 다운샘플링 없이 스크롤 컨테이너로 처리.
 */

import { useMemo } from "react";
import { BarRow, Section, StatCard } from "../shared";
import { formatTime, labelFor } from "../format";
import { useAppStore } from "../../../store";
import type { AsterixDetailStats, TzMode } from "../../../types/asterixDetail";
import type { Aircraft } from "../../../types";

/** BDS 계열 색 — 대시보드 "BDS 레지스터 (I048/250)" 카드와 동일 */
const BDS_INK = "#7c3aed";

/**
 * 레지스터별 의미 툴팁 (로컬 정의).
 * 표의 "이름" 열에는 Rust bds_reg_label 의 한글명이 이미 들어가므로
 * 여기서는 ICAO 규격 명칭과 실제 내용/분류(ELS·EHS)만 보탠다 — 한글명 중복 금지.
 * 김포#1 관측 세트 = EHS/ELS + RA (BDS 2,0 / 4,0 / 5,0 / 6,0 / 3,0).
 */
const BDS_REG_TIP: Record<string, string> = {
  "0,0": "Empty register — 미지원/무응답 레지스터 (내용 없음)",
  "1,0": "Data link capability report — 기체가 지원하는 Mode-S 데이터링크 기능 비트맵",
  "1,6": "ACAS coordination reply — ACAS 간 회피 방향 조정 응답",
  "1,7": "Common usage GICB capability report — 지상 요청(GICB)으로 읽을 수 있는 레지스터 목록",
  "2,0": "Aircraft identification — 8문자 호출부호 IA5 (ELS 필수 항목)",
  "3,0": "ACAS active resolution advisory — 활성 RA 내용 (ARA/RAC/위협 식별)",
  "4,0": "Selected vertical intention — MCP/FCU 선택고도·FMS 선택고도·기압설정 (EHS)",
  "5,0": "Track and turn report — 롤각·트랙각·지상속도·트랙각속도·진대기속도 (EHS)",
  "6,0": "Heading and speed report — 자기기수·IAS/Mach·상승률 (EHS)",
};

/** 점유율 표기 — 표 셀용 (0 분모 방어) */
function pctText(count: number, total: number): string {
  if (total <= 0) return "—";
  const p = (count / total) * 100;
  return p >= 0.01 ? `${p.toFixed(2)}%` : "<0.01%";
}

/**
 * labelFor 결과에서 기체명만 분리 — labelFor 는 `${name} (${modeS})` 규칙이라
 * 등록 기체가 없으면 hex 원문이 그대로 돌아온다(= 표시할 이름 없음).
 * Mode-S hex 는 표에서 모노스페이스로 따로 렌더하므로 이름만 떼어 회색으로 병기한다.
 */
function aircraftName(modeS: string, aircraft: Aircraft[]): string | null {
  const lbl = labelFor(modeS, aircraft);
  return lbl === modeS ? null : lbl.slice(0, lbl.length - modeS.length - 3);
}

export default function BdsDetail({ detail, tz }: { detail: AsterixDetailStats; tz: TzMode }) {
  const { bds_detail, acas_events, acas_events_truncated, modes_table, modes_table_truncated, stats } = detail;
  const aircraft = useAppStore((s) => s.aircraft);

  // 레지스터 행 — 상세(bds_detail) 우선, 없으면 대시보드 분포로 폴백(고유 Mode-S 미상)
  const regRows = useMemo(() => {
    if (bds_detail.length > 0) return bds_detail.slice().sort((a, b) => b.count - a.count);
    return stats.bds_reg_counts.map((b) => ({ key: b.key, label: b.label, count: b.count, distinct_mode_s: 0 }));
  }, [bds_detail, stats.bds_reg_counts]);

  /** MB 블록 총수 = 점유율 분모 */
  const mbTotal = useMemo(() => regRows.reduce((a, b) => a + b.count, 0), [regRows]);

  /** BDS 2,0 호출부호 — ACAS 표/막대 라벨에 병기 */
  const callsignMap = useMemo(
    () => new Map(stats.mode_s_callsigns.map((c) => [c.mode_s, c.callsign])),
    [stats.mode_s_callsigns],
  );

  // Mode-S별 ACAS 발생 — acas_count>0 행만 추려 발생 수 내림차순 (전수)
  const acasByMode = useMemo(
    () => modes_table.filter((m) => m.acas_count > 0).sort((a, b) => b.acas_count - a.acas_count),
    [modes_table],
  );
  const acasByModeSum = useMemo(() => acasByMode.reduce((a, b) => a + b.acas_count, 0), [acasByMode]);
  /** 막대 분모 — 전체 ACAS RA 레코드 수(없으면 추린 합계) */
  const acasBarTotal = stats.acas_ra_records > 0 ? stats.acas_ra_records : acasByModeSum;

  return (
    <div className="space-y-3">
      {/* 요약 */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatCard
          label="MB 블록"
          value={mbTotal.toLocaleString()}
          sub="I048/250 Mode-S 블록 총수"
          title="한 레코드에 최대 8개의 MB 블록이 실린다 — 레지스터 점유율의 분모"
        />
        <StatCard
          label="관측 레지스터"
          value={`${regRows.length.toLocaleString()}종`}
          // sub 는 한 줄 유지(카드 높이 통일) — 상위 4종만 적고 전체는 툴팁으로
          sub={
            regRows.length > 0
              ? regRows
                  .slice(0, 4)
                  .map((r) => r.key)
                  .join(" · ") + (regRows.length > 4 ? ` 외 ${regRows.length - 4}종` : "")
              : "없음"
          }
          title={
            regRows.length > 0
              ? `관측된 BDS 레지스터: ${regRows.map((r) => r.key).join(", ")}`
              : "이 자료에서 실제로 관측된 BDS 레지스터 종류"
          }
        />
        <StatCard
          label="ACAS RA 레코드"
          value={stats.acas_ra_records.toLocaleString()}
          sub={`발생 기체 ${acasByMode.length.toLocaleString()}대`}
          title="I048/260(ACAS RA 보고) 또는 BDS 3,0 을 보유한 레코드 수"
        />
        <StatCard
          label="호출부호 확보"
          value={stats.mode_s_callsigns.length.toLocaleString()}
          sub={`Mode-S 고유 ${stats.modes_distinct.toLocaleString()}대 중`}
          title="BDS 2,0(항공기 식별) 디코드로 호출부호를 얻은 Mode-S 주소 수"
        />
      </div>

      {/* 레지스터 상세 — 표 + 점유율 막대 병행 */}
      <Section
        title="BDS 레지스터 상세 (I048/250)"
        right={<span className="text-[10px] text-gray-400">MB 블록 {mbTotal.toLocaleString()}개 기준</span>}
      >
        {regRows.length === 0 ? (
          <div className="text-[11px] text-gray-400">없음</div>
        ) : (
          <>
            <div className="overflow-auto rounded border border-gray-100">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="sticky top-0 bg-gray-50 text-gray-500">
                    <th className="px-2 py-1 text-left font-medium">레지스터</th>
                    <th className="px-2 py-1 text-left font-medium">이름</th>
                    <th className="px-2 py-1 text-right font-medium">MB 블록</th>
                    <th className="px-2 py-1 text-right font-medium">점유율</th>
                    <th className="px-2 py-1 text-right font-medium" title="이 레지스터를 한 번이라도 보고한 고유 Mode-S 주소 수">
                      고유 Mode-S
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {regRows.map((r) => {
                    // label = `${key} ${한글명}` 규칙 — 이름 열에는 key 접두를 떼어 중복 표기를 피한다
                    const name = r.label.startsWith(`${r.key} `) ? r.label.slice(r.key.length + 1) : r.label;
                    const tip = BDS_REG_TIP[r.key];
                    return (
                      <tr key={r.key} className="border-t border-gray-100">
                        <td className="px-2 py-1 font-mono text-gray-700" title={tip}>
                          BDS {r.key}
                        </td>
                        <td className="px-2 py-1 text-gray-700" title={tip}>
                          {name}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums text-gray-600">{r.count.toLocaleString()}</td>
                        <td className="px-2 py-1 text-right tabular-nums text-gray-600">{pctText(r.count, mbTotal)}</td>
                        <td className="px-2 py-1 text-right tabular-nums text-gray-600">
                          {bds_detail.length > 0 ? r.distinct_mode_s.toLocaleString() : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* 점유율 막대 — 표와 같은 정렬/색으로 분포를 한눈에 */}
            <div className="mt-2">
              <div className="mb-0.5 text-[10px] uppercase tracking-wider text-gray-400">MB 블록 점유율</div>
              {regRows.map((r) => (
                <BarRow
                  key={r.key}
                  label={r.label}
                  count={r.count}
                  total={mbTotal}
                  color={BDS_INK}
                  labelWidth="w-56"
                />
              ))}
            </div>
          </>
        )}
      </Section>

      {/* ACAS RA 발생 이벤트 — 전수 스크롤 */}
      <Section
        title={`ACAS RA 발생 이벤트 (${acas_events.length.toLocaleString()}건)`}
        right={
          acas_events_truncated ? (
            <span className="text-[10px] text-amber-600">
              시각순 상위 {acas_events.length.toLocaleString()}건만 표시 — 기간 필터로 좁히세요
            </span>
          ) : undefined
        }
      >
        {acas_events.length === 0 ? (
          <div className="text-[11px] text-gray-400">ACAS RA 발생 없음</div>
        ) : (
          <div className="max-h-96 overflow-auto rounded border border-gray-100">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="sticky top-0 bg-gray-50 text-gray-500">
                  <th className="px-2 py-1 text-left font-medium">시각 ({tz})</th>
                  <th className="px-2 py-1 text-left font-medium">Mode-S</th>
                  <th className="px-2 py-1 text-left font-medium">출처 (SAC/SIC)</th>
                </tr>
              </thead>
              <tbody>
                {acas_events.map((e, i) => {
                  const hex = e.mode_s;
                  const name = hex ? aircraftName(hex, aircraft) : null;
                  const cs = hex ? callsignMap.get(hex) : undefined;
                  return (
                    <tr key={`${e.ts}:${hex ?? "-"}:${i}`} className="border-t border-gray-100">
                      <td className="px-2 py-1 font-mono text-gray-600">{e.ts != null ? formatTime(e.ts, tz) : "—"}</td>
                      <td className="px-2 py-1 text-gray-700">
                        <span className="font-mono">{hex ?? "—"}</span>
                        {name && <span className="ml-1 text-gray-500">{name}</span>}
                        {cs && (
                          <span className="ml-1 text-gray-400" title="BDS 2,0 호출부호">
                            {cs}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1 tabular-nums text-gray-600">
                        SAC {e.sac} · SIC {e.sic}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Mode-S별 ACAS 발생 상위 */}
      <Section
        title={`Mode-S별 ACAS 발생 (${acasByMode.length.toLocaleString()}대)`}
        right={
          modes_table_truncated ? (
            <span className="text-[10px] text-amber-600">
              Mode-S 상위 {modes_table.length.toLocaleString()}개 기준
            </span>
          ) : undefined
        }
      >
        {acasByMode.length === 0 ? (
          <div className="text-[11px] text-gray-400">ACAS RA 발생 없음</div>
        ) : (
          <div className="max-h-96 overflow-auto pr-1">
            {acasByMode.map((m) => (
              <BarRow
                key={m.mode_s}
                label={labelFor(m.mode_s, aircraft)}
                sub={callsignMap.get(m.mode_s)}
                count={m.acas_count}
                total={acasBarTotal}
                color={BDS_INK}
                labelWidth="w-56"
              />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
