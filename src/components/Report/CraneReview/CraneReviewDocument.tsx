/**
 * 타워크레인 전파영향 검토 보고서 본문 — 크레인 × 시설별 방위각 전 범위 검토.
 *
 * 프레임 규약(산식 단일 원천 = utils/craneReviewShared.ts 헤더):
 *   BRA 초과량 = 실제지구 기하(Rust 스윕, 부위별 2D 최근접 경계 판정)
 *   LoS 초과량 = 4/3 유효지구 음영고도 대비(지브를 레이더 방위 단면에 투영한 근사)
 *   단면도 표시 = 실제지구 디스플레이 프레임(elev − curvDrop)
 *
 * `<AutoPaginate>` 의 각 자식은 atomic 블록이며, 모든 문구·수치 셀은 `OMEditable` 로 인라인
 * 편집된다. 편집키 접두사 — 전역 `crv.` / 크레인별 `crv.c<id>.` / 크레인×시설별
 * `crv.c<id>.f<시설명>.` (여러 번 렌더되는 블록은 반드시 인스턴스 접두사, OM 규칙).
 * 차트 SVG 안 텍스트는 편집 불가 — 수치 편집은 캡션·표 셀이 담당한다.
 */
import { useMemo } from "react";
import { format } from "date-fns";
import AutoPaginate from "../AutoPaginate";
import OMEditable from "../OMEditable";
import CraneReviewCrossSection from "./CraneReviewCrossSection";
import CraneReviewPolarChart from "./CraneReviewPolarChart";
import { fmt, toDms, RADAR_NEAR_EXCLUDE_M } from "../../../utils/braReviewAnalysis";
import {
  CRANE_JIB_TRUSS_H, CRANE_SELF_EXCLUDE_M, jibRadialOffsetsKm, shadowMslAt,
  type CraneAnalysis, type CraneCaseVerdict, type CraneFacilityAnalysis, type CraneReviewResult,
} from "../../../utils/craneReviewShared";
import type { ReportMetadata } from "../../../types";
import "./craneReviewStyles.css";

/** 항목 기호 — 가, 나, 다, … */
const ORDINALS = ["가", "나", "다", "라", "마", "바", "사", "아", "자", "차", "카", "타", "파", "하"];
const ord = (i: number) => ORDINALS[Math.min(Math.max(i, 0), ORDINALS.length - 1)];

/** 케이스 판정표 1개당 최대 열 수 — 지정 각도가 많아도(예: 16방위) A4 폭을 넘지 않게 분할 */
const MAX_CASE_COLS = 8;

/** 초과/여유 수치 표기 — 양수(초과)는 빨강 +, 음수(여유)는 회색 − */
function ExcessCell({ id, value }: { id: string; value: number }) {
  const positive = value > 0;
  const text = positive ? `+${fmt(value, 2)}` : `−${fmt(Math.abs(value), 2)}`;
  return <OMEditable id={id} value={text} tag="td" className={`num ${positive ? "pos" : "neg"}`} />;
}

/** 침범 방위 구간 폭 (°) — 랩어라운드 포함, 1° 빈 폭 가산 */
function rangeWidthDeg(startDeg: number, endDeg: number): number {
  return (((endDeg - startDeg + 360) % 360) + 1);
}

/** 침범 구간 요약 문자열 — "150°–210° (최대 +17.9 m @179°)" */
function rangeText(ranges: { startDeg: number; endDeg: number; maxExceedM: number; maxAtDeg: number }[]): string {
  return ranges
    .map((r) => `${r.startDeg}°–${r.endDeg}° (최대 +${fmt(r.maxExceedM, 1)} m @${r.maxAtDeg}°)`)
    .join(", ");
}

/** 전 방위 침범 여부 — penetratingRanges 의 전방위 표현(0°–359° 단일 구간) */
function isAllPenetrating(ranges: { startDeg: number; endDeg: number }[]): boolean {
  return ranges.length === 1 && ranges[0].startDeg === 0 && ranges[0].endDeg === 359;
}

/** 케이스가 차지하는 반경 구간의 **최근접 거리** (km) — CraneReviewCrossSection 내부 계산과 동일 규약.
 *  (단면도는 props 계약이 고정되어 값을 되돌려받을 수 없어 캡션용으로 여기서 다시 구한다) */
function caseNearKm(f: CraneFacilityAnalysis, a: CraneAnalysis, c: CraneCaseVerdict): number {
  const crane = a.crane;
  const halfMastKm = crane.mast_width / 2000;
  if (c.kind === "full") {
    return f.distKm - Math.max(crane.jib_length, crane.counter_jib_length) / 1000;
  }
  if (c.jibDeg == null) return f.distKm - halfMastKm;
  const o = jibRadialOffsetsKm(crane, f.azimuthDeg, c.jibDeg);
  return f.distKm + Math.min(0, o.jibTipKm, o.counterTipKm) - halfMastKm;
}

interface Props {
  result: CraneReviewResult;
  metadata: ReportMetadata;
}

export default function CraneReviewDocument({ result, metadata }: Props) {
  const { payload, cranes } = result;
  const org = metadata.organization || "한국공항공사";
  const dept = metadata.department;
  const theta = payload.braAngleDeg;

  // 문서번호·작성일 — 페이로드 생성 시각 고정(렌더마다 흔들리지 않게)
  const issued = useMemo(() => {
    const d = new Date(payload.generatedAt);
    return Number.isNaN(d.getTime()) ? new Date() : d;
  }, [payload.generatedAt]);
  const docNo = `TCR-${format(issued, "yyyyMMdd")}-${format(issued, "HHmm")}`;
  const docDate = `${issued.getFullYear()}. ${issued.getMonth() + 1}. ${issued.getDate()}.`;

  const craneNames = cranes.map((c) => c.crane.name).join(", ");
  const siteNames = payload.radarSites.map((s) => s.name).join("·");
  const pairs = cranes.flatMap((a) => a.facilities.map((f) => ({ a, f })));
  // 각주용 샘플 간격 (대표 시설 기준)
  const stepM = pairs.length > 0 ? Math.round(pairs[0].f.sampleStepM) : 0;

  /** 크레인 접두사 · 크레인×시설 접두사 (인스턴스 편집키) */
  const ck = (a: CraneAnalysis, suffix: string) => `crv.c${a.crane.id}.${suffix}`;
  const fk = (a: CraneAnalysis, f: CraneFacilityAnalysis, suffix: string) =>
    `crv.c${a.crane.id}.f${f.site.name}.${suffix}`;

  // ── 블록 A: 머리 ──
  const blockHead = (
    <div className="brv-head">
      <div className="brv-doc-meta">
        <OMEditable id="crv.head.docno" value={`문서번호 : ${docNo}`} tag="div" />
        <OMEditable id="crv.head.dept" value={`${org}${dept ? ` ${dept}` : ""}`} tag="div" />
        <OMEditable id="crv.head.docdate" value={`작성일 : ${docDate}`} tag="div" />
      </div>
      <OMEditable id="crv.head.title" value="타워크레인 전파영향 검토 보고서" tag="h1" className="brv-h1" />
      <OMEditable
        id="crv.head.subtitle"
        value={`${org} 항행안전시설(레이더 ${siteNames}) — 타워크레인 ${cranes.length}기 (${craneNames})`}
        tag="p"
        className="brv-subtitle"
      />
      <div className="brv-rule" />
    </div>
  );

  // ── 블록 B: 1. 개요 ──
  const blockOverview = (
    <section className="brv-sec">
      <OMEditable id="crv.s1.h" value="1. 개요" tag="h2" className="brv-h2" />
      <OMEditable
        id="crv.s1.p1"
        value={
          `등록 타워크레인 ${cranes.length}기(${craneNames})가 ${org} 항행안전시설 ${payload.radarSites.length}개소` +
          `(${siteNames})에 미치는 전파영향성(ICAO EUR DOC 015 전파장애물 제한구역, BRA 기준각 θ = ${theta}°) ` +
          `저촉 여부를 검토한 결과임.`
        }
        tag="p"
        className="brv-p"
      />
      <OMEditable
        id="crv.s1.p2"
        value={
          "타워크레인은 지브 선회에 따라 마스트 밖으로 뻗은 지브·카운터지브의 위치가 바뀌어 제한표면 침범 여부와 " +
          "초과량이 달라지므로, 지브 방위각 전 범위(0°~359°, 1° 간격)를 스윕하여 최악각·최선각·전방위 최악조건·" +
          `지정 각도(${payload.customAngles.length > 0 ? `${payload.customAngles.map((d) => `${d}°`).join(", ")}` : "지정 없음"})` +
          " 별로 검토하였음."
        }
        tag="p"
        className="brv-p"
      />
    </section>
  );

  // ── 블록 C: 2. 관련 근거 (의견서 §2 재사용) ──
  const basisLines = [
    "가. ICAO EUR DOC 015 — Building Restricted Area",
    "나. 항행안전시설 관리 및 운영규정 (국토교통부 고시)",
    "다. 항행안전무선시설의 설치 및 기술기준 (국토교통부 고시)",
    "라. 항행안전시설 전파장애 유발 가능성 검토기준",
  ];
  const blockBasis = (
    <section className="brv-sec">
      <OMEditable id="crv.s2.h" value="2. 관련 근거" tag="h2" className="brv-h2" />
      <div className="brv-basis">
        {basisLines.map((line, i) => (
          <OMEditable key={i} id={`crv.s2.l${i}`} value={line} tag="div" className="brv-basis-line" />
        ))}
      </div>
    </section>
  );

  // ── 블록 D: 3. 검토 대상 타워크레인 제원 (크레인 1기 = 1 블록) ──
  const blockSpecs = cranes.map((a, i) => {
    const c = a.crane;
    return (
      <section className="brv-sec" key={ck(a, "spec")}>
        {i === 0 && <OMEditable id="crv.s3.h" value="3. 검토 대상 타워크레인 제원" tag="h2" className="brv-h2" />}
        {cranes.length > 1 && (
          <OMEditable id={ck(a, "spec.sub")} value={`3-${i + 1}. ${c.name}`} tag="div" className="crv-subh" />
        )}
        <table className="brv-table brv-table-spec">
          <tbody>
            <tr>
              <OMEditable id={ck(a, "spec.k.name")} value="명칭 / ID" tag="th" />
              <td><OMEditable id={ck(a, "spec.v.name")} value={`${c.name} (ID ${c.id})`} tag="span" /></td>
            </tr>
            <tr>
              <OMEditable id={ck(a, "spec.k.pos")} value="위치 (WGS84)" tag="th" />
              <td>
                <OMEditable id={ck(a, "spec.v.pos")}
                  value={`${toDms(c.latitude, "lat")} / ${toDms(c.longitude, "lon")}`} tag="span" />
              </td>
            </tr>
            <tr>
              <OMEditable id={ck(a, "spec.k.ground")} value="지반고 (MSL)" tag="th" />
              <td>
                <OMEditable id={ck(a, "spec.v.ground")} value={`${fmt(c.ground_elev, 2)} m`} tag="span" />
                <span className="brv-badge">{c.elev_mode === "manual" ? "직접 입력" : "SRTM 스냅샷"}</span>
              </td>
            </tr>
            <tr>
              <OMEditable id={ck(a, "spec.k.jibh")} value="지브 설치고 (AGL)" tag="th" />
              <td><OMEditable id={ck(a, "spec.v.jibh")} value={`${fmt(c.jib_height, 2)} m`} tag="span" /></td>
            </tr>
            <tr>
              <OMEditable id={ck(a, "spec.k.toph")} value="최상단 높이 (AGL)" tag="th" />
              <td><OMEditable id={ck(a, "spec.v.toph")} value={`${fmt(c.top_height, 2)} m`} tag="span" /></td>
            </tr>
            <tr>
              <OMEditable id={ck(a, "spec.k.len")} value="지브 / 카운터지브 길이" tag="th" />
              <td>
                <OMEditable id={ck(a, "spec.v.len")}
                  value={`${fmt(c.jib_length, 1)} m / ${fmt(c.counter_jib_length, 1)} m`} tag="span" />
              </td>
            </tr>
            <tr>
              <OMEditable id={ck(a, "spec.k.mastw")} value="마스트 단면 폭" tag="th" />
              <td><OMEditable id={ck(a, "spec.v.mastw")} value={`${fmt(c.mast_width, 2)} m (정사각)`} tag="span" /></td>
            </tr>
            <tr>
              <OMEditable id={ck(a, "spec.k.az")} value="등록 방위각 / 선회 모드" tag="th" />
              <td>
                <OMEditable id={ck(a, "spec.v.az")}
                  value={`${fmt(c.jib_azimuth_deg, 0)}° / ${c.rotation_mode === "full" ? "전방위 선회" : "고정"}`}
                  tag="span" />
              </td>
            </tr>
            <tr>
              <OMEditable id={ck(a, "spec.k.jibtop")} value="지브 상단고 (MSL)" tag="th" />
              <td>
                <OMEditable id={ck(a, "spec.v.jibtop")}
                  value={`${fmt(a.jibTopMslM, 2)} m (지브 설치고 + 트러스 ${CRANE_JIB_TRUSS_H} m)`} tag="span" />
              </td>
            </tr>
            <tr>
              <OMEditable id={ck(a, "spec.k.top")} value="최상단고 (MSL)" tag="th" />
              <td>
                <OMEditable id={ck(a, "spec.v.top")} value={`${fmt(a.mastTopMslM, 2)} m`} tag="span" className="strong" />
              </td>
            </tr>
            {c.memo && (
              <tr>
                <OMEditable id={ck(a, "spec.k.memo")} value="메모" tag="th" />
                <td><OMEditable id={ck(a, "spec.v.memo")} value={c.memo} tag="span" /></td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    );
  });

  // ── 블록 E: 4. 검토 시설 ──
  const blockSites = (
    <section className="brv-sec">
      <OMEditable id="crv.s4.h" value="4. 검토 시설" tag="h2" className="brv-h2" />
      <table className="brv-table">
        <thead>
          <tr>
            <OMEditable id="crv.s4.h0" value="시설명" tag="th" />
            <OMEditable id="crv.s4.h1" value="위치 (WGS84)" tag="th" />
            <OMEditable id="crv.s4.h2" value="안테나 정점 (MSL, m)" tag="th" />
            {cranes.map((a) => (
              <OMEditable key={ck(a, "s4.hd")} id={ck(a, "s4.hd")}
                value={cranes.length > 1 ? `${a.crane.name} 거리 (km)` : "거리 (km)"} tag="th" />
            ))}
            {cranes.map((a) => (
              <OMEditable key={ck(a, "s4.ha")} id={ck(a, "s4.ha")}
                value={cranes.length > 1 ? `${a.crane.name} 방위 (°)` : "방위 (°)"} tag="th" />
            ))}
          </tr>
        </thead>
        <tbody>
          {payload.radarSites.map((s) => {
            const facOf = (a: CraneAnalysis) => a.facilities.find((f) => f.site.name === s.name);
            return (
              <tr key={`crv.s4.r.${s.name}`}>
                <OMEditable id={`crv.s4.r.${s.name}.name`} value={s.name} tag="td" />
                <OMEditable id={`crv.s4.r.${s.name}.pos`}
                  value={`${toDms(s.latitude, "lat")} / ${toDms(s.longitude, "lon")}`} tag="td" />
                <OMEditable id={`crv.s4.r.${s.name}.hant`}
                  value={`${fmt(s.altitude + s.antenna_height, 2)} (기초 ${fmt(s.altitude, 2)} + 안테나 ${fmt(s.antenna_height, 2)})`}
                  tag="td" className="num" />
                {cranes.map((a) => {
                  const f = facOf(a);
                  return (
                    <OMEditable key={ck(a, `s4.d.${s.name}`)} id={ck(a, `s4.d.${s.name}`)}
                      value={f ? fmt(f.distKm, 3) : "-"} tag="td" className="num" />
                  );
                })}
                {cranes.map((a) => {
                  const f = facOf(a);
                  return (
                    <OMEditable key={ck(a, `s4.a.${s.name}`)} id={ck(a, `s4.a.${s.name}`)}
                      value={f ? f.azimuthDeg.toFixed(1) : "-"} tag="td" className="num" />
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );

  // ── 블록 F: 5. 검토 내용 (크레인 × 시설 서브섹션) ──
  const blockReview: React.ReactNode[] = [];
  let pairIdx = 0;
  for (const a of cranes) {
    for (const f of a.facilities) {
      pairIdx += 1;
      const idx = pairIdx;
      const subTitle = `5-${idx}. ${a.crane.name} — ${f.site.name}`;
      const cases = f.cases;
      const shadowStr = f.shadowAtMastM != null ? `${fmt(f.shadowAtMastM, 2)} m` : "전방 장애물 없음";

      // (가) 케이스 판정표 — 열이 많으면 MAX_CASE_COLS 단위로 분할(가로 스크롤 금지)
      const chunks: CraneCaseVerdict[][] = [];
      for (let i = 0; i < cases.length; i += MAX_CASE_COLS) chunks.push(cases.slice(i, i + MAX_CASE_COLS));

      blockReview.push(
        <section className="brv-sec" key={fk(a, f, "verdict")}>
          {idx === 1 && <OMEditable id="crv.s5.h" value="5. 검토 내용" tag="h2" className="brv-h2" />}
          <OMEditable id={fk(a, f, "subh")} value={subTitle} tag="div" className="crv-subh" />
          <p className="brv-p">
            <span className="brv-ord">{ord(0)}.</span>{" "}
            <OMEditable
              id={fk(a, f, "verdict.lead")}
              value={
                `안테나(정점표고 ${fmt(f.hAntM, 2)} m MSL)로부터 방위 ${f.azimuthDeg.toFixed(1)}°, ` +
                `수평거리 ${fmt(f.distKm, 3)} km 지점의 마스트 중심 기준 BRA 제한고도는 ${fmt(f.coneMslAtMastM, 2)} m (MSL), ` +
                `동 지점의 4/3 음영고도는 ${shadowStr} 임. 케이스별 판정은 다음과 같음.`
              }
              tag="span"
            />
          </p>
          {chunks.map((chunk, ci) => (
            <table className="crv-case-table" key={fk(a, f, `tbl${ci}`)}>
              <thead>
                <tr>
                  <OMEditable id={fk(a, f, `tbl${ci}.h`)} value="구분" tag="th" className="crv-rowh" />
                  {chunk.map((c) => (
                    <OMEditable
                      key={fk(a, f, `tbl.${c.kind}.${c.jibDeg ?? "x"}.h`)}
                      id={fk(a, f, `tbl.${c.kind}.${c.jibDeg ?? "x"}.h`)}
                      value={c.label}
                      tag="th"
                      className={c.kind === "worst" ? "crv-worst" : c.kind === "best" ? "crv-best" : ""}
                    />
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <OMEditable id={fk(a, f, `tbl${ci}.r0`)} value="지브 방위각" tag="th" className="crv-rowh" />
                  {chunk.map((c) => (
                    <OMEditable
                      key={fk(a, f, `tbl.${c.kind}.${c.jibDeg ?? "x"}.jib`)}
                      id={fk(a, f, `tbl.${c.kind}.${c.jibDeg ?? "x"}.jib`)}
                      value={c.jibDeg != null ? `${c.jibDeg}°` : c.kind === "full" ? "전방위" : "해당 없음"}
                      tag="td"
                    />
                  ))}
                </tr>
                <tr>
                  <OMEditable id={fk(a, f, `tbl${ci}.r1`)} value="BRA 초과량 (m)" tag="th" className="crv-rowh" />
                  {chunk.map((c) =>
                    f.sweep == null ? (
                      <OMEditable
                        key={fk(a, f, `tbl.${c.kind}.${c.jibDeg ?? "x"}.bra`)}
                        id={fk(a, f, `tbl.${c.kind}.${c.jibDeg ?? "x"}.bra`)}
                        value="산출 실패" tag="td" className="fail"
                      />
                    ) : (
                      <ExcessCell
                        key={fk(a, f, `tbl.${c.kind}.${c.jibDeg ?? "x"}.bra`)}
                        id={fk(a, f, `tbl.${c.kind}.${c.jibDeg ?? "x"}.bra`)}
                        value={c.braExceedM}
                      />
                    ),
                  )}
                </tr>
                <tr>
                  <OMEditable id={fk(a, f, `tbl${ci}.r2`)} value="BRA 판정" tag="th" className="crv-rowh" />
                  {chunk.map((c) => (
                    <OMEditable
                      key={fk(a, f, `tbl.${c.kind}.${c.jibDeg ?? "x"}.brav`)}
                      id={fk(a, f, `tbl.${c.kind}.${c.jibDeg ?? "x"}.brav`)}
                      value={f.sweep == null ? "판정 불가" : c.braExceeded ? "침범" : "적합"}
                      tag="td"
                      className={f.sweep == null ? "fail" : c.braExceeded ? "bad" : "ok"}
                    />
                  ))}
                </tr>
                <tr>
                  <OMEditable id={fk(a, f, `tbl${ci}.r3`)} value="LoS 초과량 (m)" tag="th" className="crv-rowh" />
                  {chunk.map((c) =>
                    c.losExceedM == null ? (
                      <OMEditable
                        key={fk(a, f, `tbl.${c.kind}.${c.jibDeg ?? "x"}.los`)}
                        id={fk(a, f, `tbl.${c.kind}.${c.jibDeg ?? "x"}.los`)}
                        value={f.error ? "분석 실패" : "산출 실패"} tag="td" className="fail"
                      />
                    ) : (
                      <ExcessCell
                        key={fk(a, f, `tbl.${c.kind}.${c.jibDeg ?? "x"}.los`)}
                        id={fk(a, f, `tbl.${c.kind}.${c.jibDeg ?? "x"}.los`)}
                        value={c.losExceedM}
                      />
                    ),
                  )}
                </tr>
                <tr>
                  <OMEditable id={fk(a, f, `tbl${ci}.r4`)} value="LoS 판정" tag="th" className="crv-rowh" />
                  {chunk.map((c) => (
                    <OMEditable
                      key={fk(a, f, `tbl.${c.kind}.${c.jibDeg ?? "x"}.losv`)}
                      id={fk(a, f, `tbl.${c.kind}.${c.jibDeg ?? "x"}.losv`)}
                      value={c.losShielded == null ? "판정 불가" : c.losShielded ? "차폐" : "가시(우려)"}
                      tag="td"
                      className={c.losShielded == null ? "fail" : c.losShielded ? "ok" : "bad"}
                    />
                  ))}
                </tr>
              </tbody>
            </table>
          ))}
          {f.error && (
            <OMEditable
              id={fk(a, f, "verdict.err")}
              value={`※ 전방 차폐(LoS) 단면 분석 실패 — ${f.error}. LoS 열은 판정 불가로 표기함.`}
              tag="p" className="crv-note"
            />
          )}
          {f.sweep == null && (
            <OMEditable
              id={fk(a, f, "verdict.sweeperr")}
              value="※ BRA 방위각 스윕 산출 실패 — 크레인이 원추면 도달 가능 반경 밖이거나 조회에 실패함. 재분석 필요."
              tag="p" className="crv-note"
            />
          )}
        </section>,
      );

      // (나) 방위각별 초과량 폴라 차트
      blockReview.push(
        <section className="brv-sec" key={fk(a, f, "polar")}>
          <p className="brv-p">
            <span className="brv-ord">{ord(1)}.</span>{" "}
            <OMEditable id={fk(a, f, "polar.h")} value="지브 방위각별 초과량 (폴라 차트)" tag="span" />
          </p>
          {f.series == null ? (
            <div className="brv-chart-error">
              <OMEditable
                id={fk(a, f, "polar.err")}
                value={`방위각별 곡선을 생성하지 못했습니다 — ${f.error ?? "BRA 스윕 산출 실패"}`}
                tag="span"
              />
            </div>
          ) : (
            <>
              <div className="crv-polar-wrap">
                <div className="brv-chart-title">
                  지브 방위각별 초과량 — {a.crane.name} / {f.site.name}
                </div>
                <div className="brv-chart-sub">
                  원점 = 마스트 · 정북 위 · 시계방향 · 반경 = 초과량(m) · 0 m 기준원 안쪽 = 여유 / 바깥 = 침범
                </div>
                <CraneReviewPolarChart
                  series={f.series}
                  azimuthDeg={f.azimuthDeg}
                  registeredDeg={a.crane.rotation_mode === "full" ? null : Math.round(a.crane.jib_azimuth_deg) % 360}
                />
              </div>
              <p className="brv-caption">
                <OMEditable
                  id={fk(a, f, "polar.cap")}
                  value={
                    `BRA 최악각 ${f.series.braWorstDeg}° (${fmt(f.series.braExceedByDeg[f.series.braWorstDeg], 2)} m), ` +
                    `최선각 ${f.series.braBestDeg}° (${fmt(f.series.braExceedByDeg[f.series.braBestDeg], 2)} m). ` +
                    (f.series.braPenetratingRanges.length > 0
                      ? `침범 방위: ${rangeText(f.series.braPenetratingRanges)}. `
                      : "전 방위에서 BRA 제한표면 이내. ") +
                    (f.series.losExceedByDeg && f.series.losWorstDeg != null && f.series.losBestDeg != null
                      ? `LoS 최악각 ${f.series.losWorstDeg}° (${fmt(f.series.losExceedByDeg[f.series.losWorstDeg], 2)} m), ` +
                        `최선각 ${f.series.losBestDeg}° (${fmt(f.series.losExceedByDeg[f.series.losBestDeg], 2)} m). `
                      : "LoS 곡선은 단면 분석 실패로 표시하지 않음. ")
                  }
                  tag="span"
                />
                <OMEditable
                  id={fk(a, f, "polar.cap.note")}
                  value={
                    "※ BRA 초과량은 부위별 2D 최근접 경계 판정(정확)이고, LoS 초과량은 지브·카운터지브를 " +
                    "레이더–마스트 방위 단면에 투영한 근사임(지브 끝의 횡방향 오프셋은 수 km 거리에서 방위 변화가 미소)."
                  }
                  tag="span"
                />
              </p>
            </>
          )}
        </section>,
      );

      // (다) 침범 방위 구간
      if (f.series != null) {
        const ranges = f.series.braPenetratingRanges;
        blockReview.push(
          <section className="brv-sec" key={fk(a, f, "ranges")}>
            <p className="brv-p">
              <span className="brv-ord">{ord(2)}.</span>{" "}
              <OMEditable id={fk(a, f, "ranges.h")} value="BRA 침범 방위 구간" tag="span" />
            </p>
            {ranges.length === 0 ? (
              <OMEditable
                id={fk(a, f, "ranges.none")}
                value="전 방위에서 BRA 적합 — 지브를 어느 방위로 두어도 제한표면을 침범하지 않음."
                tag="div" className="crv-range-none"
              />
            ) : isAllPenetrating(ranges) ? (
              <OMEditable
                id={fk(a, f, "ranges.all")}
                value={`전 방위 침범(마스트 단독 초과) — 최대 +${fmt(ranges[0].maxExceedM, 2)} m @ ${ranges[0].maxAtDeg}°`}
                tag="div" className="crv-range-all"
              />
            ) : (
              <table className="crv-range-table">
                <thead>
                  <tr>
                    <OMEditable id={fk(a, f, "ranges.h0")} value="구간" tag="th" />
                    <OMEditable id={fk(a, f, "ranges.h1")} value="시작 방위 (°)" tag="th" />
                    <OMEditable id={fk(a, f, "ranges.h2")} value="끝 방위 (°)" tag="th" />
                    <OMEditable id={fk(a, f, "ranges.h3")} value="폭 (°)" tag="th" />
                    <OMEditable id={fk(a, f, "ranges.h4")} value="최대 초과량 (m)" tag="th" />
                    <OMEditable id={fk(a, f, "ranges.h5")} value="최대 방위 (°)" tag="th" />
                  </tr>
                </thead>
                <tbody>
                  {ranges.map((r, ri) => (
                    <tr key={fk(a, f, `ranges.r${ri}`)}>
                      <OMEditable id={fk(a, f, `ranges.r${ri}.i`)} value={`${ri + 1}`} tag="td" />
                      <OMEditable id={fk(a, f, `ranges.r${ri}.s`)} value={`${r.startDeg}`} tag="td" className="num" />
                      <OMEditable id={fk(a, f, `ranges.r${ri}.e`)} value={`${r.endDeg}`} tag="td" className="num" />
                      <OMEditable id={fk(a, f, `ranges.r${ri}.w`)}
                        value={`${rangeWidthDeg(r.startDeg, r.endDeg)}`} tag="td" className="num" />
                      <OMEditable id={fk(a, f, `ranges.r${ri}.m`)}
                        value={`+${fmt(r.maxExceedM, 2)}`} tag="td" className="num pos" />
                      <OMEditable id={fk(a, f, `ranges.r${ri}.a`)} value={`${r.maxAtDeg}`} tag="td" className="num" />
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {ranges.length > 0 && !isAllPenetrating(ranges) && (
              <OMEditable
                id={fk(a, f, "ranges.note")}
                value={`※ 랩어라운드 구간(예: 350°→10°)은 끝 방위가 시작 방위보다 작게 표기됨. 침범 방위 합계 ${ranges.reduce((s, r) => s + rangeWidthDeg(r.startDeg, r.endDeg), 0)}°.`}
                tag="p" className="crv-note"
              />
            )}
          </section>,
        );
      }

      // (라~) 케이스별 수직 단면도 — 최악각·최선각·전방위(+지정 각도 옵션)
      const chartCases = cases.filter(
        (c) => c.kind === "worst" || c.kind === "best" || c.kind === "full"
          || (c.kind === "custom" && payload.customCrossSections),
      );
      if (f.error != null || f.profile.length === 0) {
        blockReview.push(
          <section className="brv-sec" key={fk(a, f, "xs.err")}>
            <p className="brv-p">
              <span className="brv-ord">{ord(3)}.</span>{" "}
              <OMEditable id={fk(a, f, "xs.err.h")} value="수직 단면도" tag="span" />
            </p>
            <div className="brv-chart-error">
              <OMEditable
                id={fk(a, f, "xs.err.msg")}
                value={`단면도를 생성하지 못했습니다 — ${f.error ?? "지형 프로파일 없음"}`}
                tag="span"
              />
            </div>
          </section>,
        );
      } else {
        chartCases.forEach((c, xi) => {
          const nearKm = Math.max(0.001, caseNearKm(f, a, c));
          const shadow = shadowMslAt(f.profile, f.pathBuildings, f.hAntM, nearKm);
          blockReview.push(
            <section className="brv-sec" key={fk(a, f, `xs.${c.kind}.${c.jibDeg ?? "x"}`)}>
              <p className="brv-p">
                <span className="brv-ord">{ord(3 + xi)}.</span>{" "}
                <OMEditable
                  id={fk(a, f, `xs.${c.kind}.${c.jibDeg ?? "x"}.h`)}
                  value={`수직 단면도 — ${c.label}`}
                  tag="span"
                />
              </p>
              <div className="brv-chart-wrap">
                <div className="brv-chart-title">
                  타워크레인 BRA 수직단면도 — {a.crane.name} / {f.site.name} ({c.label})
                </div>
                <div className="brv-chart-sub">
                  안테나 → 크레인 방위 {f.azimuthDeg.toFixed(1)}° 방사 단면 · 고도 기준 MSL ·
                  {" "}지형·건물 프로파일 포함 (SRTM {stepM} m 간격 전수)
                </div>
                <CraneReviewCrossSection
                  facility={f}
                  analysis={a}
                  caseKind={c.kind}
                  jibDeg={c.jibDeg}
                  braAngleDeg={theta}
                />
              </div>
              <p className="brv-caption">
                <OMEditable
                  id={fk(a, f, `xs.${c.kind}.${c.jibDeg ?? "x"}.cap`)}
                  value={
                    `제한고도 ${fmt(f.coneMslAtMastM, 2)} m (MSL, 마스트 중심 d = ${fmt(f.distKm, 3)} km, θ = ${theta}°) · ` +
                    `음영고도 ${shadow != null ? `${fmt(shadow, 2)} m (최근접 부위 d = ${fmt(nearKm, 3)} km 기준)` : "전방 장애물 없음"} · ` +
                    `크레인 최상단 ${fmt(a.mastTopMslM, 2)} m / 지브 상단 ${fmt(a.jibTopMslM, 2)} m → `
                  }
                  tag="span"
                />
                <OMEditable
                  id={fk(a, f, `xs.${c.kind}.${c.jibDeg ?? "x"}.cap.v`)}
                  value={
                    (c.braExceeded ? `BRA 약 ${fmt(c.braExceedM, 2)} m 초과` : `BRA ${fmt(-c.braExceedM, 2)} m 여유`) +
                    (c.losExceedM == null
                      ? ", LoS 판정 불가"
                      : c.losShielded
                        ? `, LoS 음영 아래 ${fmt(-c.losExceedM, 2)} m (차폐)`
                        : `, LoS 약 ${fmt(c.losExceedM, 2)} m 가시`)
                  }
                  tag="span"
                  className={c.braExceeded ? "brv-strong-bad" : "brv-strong-ok"}
                />
              </p>
            </section>,
          );
        });
      }
    }
  }

  // ── 블록 G: 6. 검토 결과 (크레인 1기 = 1 블록) ──
  const anyFail = pairs.some((p) => p.f.sweep == null || p.f.error != null);
  const mastPairs = pairs.filter((p) => {
    const m = p.f.cases.find((c) => c.kind === "mast");
    return p.f.sweep != null && m != null && m.braExceedM > 0;
  });
  const rangePairs = pairs.filter(
    (p) => p.f.sweep != null && (p.f.series?.braPenetratingRanges.length ?? 0) > 0 && !mastPairs.includes(p),
  );
  const visiblePairs = pairs.filter((p) => p.f.cases.some((c) => c.losShielded === false));

  const blockResults = cranes.map((a, i) => (
    <section className="brv-sec" key={ck(a, "concl")}>
      {i === 0 && <OMEditable id="crv.s6.h" value="6. 검토 결과" tag="h2" className="brv-h2" />}
      {cranes.length > 1 && (
        <OMEditable id={ck(a, "concl.sub")} value={`6-${i + 1}. ${a.crane.name}`} tag="div" className="crv-subh" />
      )}
      <ul className="brv-list">
        {a.facilities.map((f) => {
          const m = f.cases.find((c) => c.kind === "mast");
          const ranges = f.series?.braPenetratingRanges ?? [];
          const worstV = f.series ? f.series.braExceedByDeg[f.series.braWorstDeg] : 0;
          const braText =
            f.sweep == null
              ? "BRA 방위각 스윕 산출 실패 — 침범 여부를 판정하지 못하였으므로 재분석이 필요함"
              : m != null && m.braExceedM > 0
                ? `마스트(지브 제외) 단독으로 제한고도를 ${fmt(m.braExceedM, 2)} m 초과 — 지브 방위와 무관하게 침범하므로 최상단 높이 조정(감축)이 필요함`
                : isAllPenetrating(ranges)
                  ? `전 방위에서 침범(최대 +${fmt(ranges[0].maxExceedM, 2)} m @ ${ranges[0].maxAtDeg}°) — 선회 제한으로는 회피할 수 없어 설치 높이 조정이 필요함`
                  : ranges.length > 0
                    ? `지브 방위 ${rangeText(ranges)} 구간에서 침범하고 그 외 방위는 적합 — 운용 시 해당 방위 회피(선회 제한 설정) 권고`
                    : `전 방위에서 적합(최악각 ${f.series?.braWorstDeg ?? 0}° 기준 여유 ${fmt(-worstV, 2)} m)`;
          const visCases = f.cases.filter((c) => c.losShielded === false);
          const losText = f.error != null
            ? `전방 차폐(LoS) 분석 실패 — ${f.error}`
            : visCases.length === 0
              ? `검토한 전 케이스가 전방 지형·건물 음영 아래(차폐, 마스트 거리 음영고도 ${f.shadowAtMastM != null ? `${fmt(f.shadowAtMastM, 2)} m` : "산출 없음"})에 위치함`
              : `${visCases.map((c) => c.label).join(", ")} 케이스에서 음영고도를 최대 ${fmt(Math.max(...visCases.map((c) => c.losExceedM ?? 0)), 2)} m 초과해 안테나에서 직접 가시(전파 영향 우려)`;
          return (
            <OMEditable
              key={fk(a, f, "concl.li")}
              id={fk(a, f, "concl.li")}
              value={`${f.site.name} — ${braText}. 전방 차폐: ${losText}.`}
              tag="li"
            />
          );
        })}
      </ul>
    </section>
  ));

  const overall =
    anyFail
      ? `→ 일부 검토 항목(BRA 스윕 또는 LoS 단면)의 산출이 실패하여 판정을 확정하지 못하였으므로, 재분석 후 전문기관 전파영향 분석 및 협의가 필요함.`
      : mastPairs.length > 0
        ? `→ ${mastPairs.map((p) => `${p.a.crane.name}(${p.f.site.name})`).join(", ")} 은(는) 지브 방위와 무관하게 제한표면을 침범하므로, 최상단 높이 조정 및 전문기관 전파영향 분석 시뮬레이션·협의가 필요함.`
        : rangePairs.length > 0
          ? `→ ${rangePairs.map((p) => `${p.a.crane.name}(${p.f.site.name})`).join(", ")} 은(는) 특정 지브 방위 구간에서만 제한표면을 침범하므로, 해당 방위를 회피하도록 선회 제한을 설정하고 사전 협의 후 운용하여야 함.`
          : `→ 검토 대상 타워크레인은 전 방위·전 시설에 대하여 전파영향성 제한표면 이내에 위치하여, 항행안전시설 전파 영향은 없을 것으로 판단됨.`;

  const blockConclusion = (
    <section className="brv-sec">
      <p className="brv-p brv-concl">
        <OMEditable id="crv.s6.concl" value={overall} tag="span" className="brv-strong" />
      </p>
      {visiblePairs.length > 0 && (
        <OMEditable
          id="crv.s6.concl.los"
          value={`※ 전방 차폐(LoS) 기준으로는 ${visiblePairs.map((p) => `${p.a.crane.name}(${p.f.site.name})`).join(", ")} 가 안테나에서 직접 가시 상태인 케이스를 포함함 — 침범 방위 운용 시 전파 영향이 우려됨.`}
          tag="p" className="crv-note"
        />
      )}
    </section>
  );

  // ── 블록 H: 유의사항 ──
  const cautions = [
    "본 검토의 방위각별 판정은 지브가 해당 방위에 정지해 있는 상태를 기준으로 산출한 것임. 실제 운용 중에는 선회로 지브 방위가 수시로 변하므로, 침범 방위 구간이 존재하는 경우 해당 구간을 물리적으로 회피(선회 제한 설정·작업계획 조정)하여야 함.",
    "지브가 수평인 T형(해머헤드) 타워크레인을 기준으로 산출하였으며, 러핑(기복)형 지브의 상향 각도에 따른 높이 증가는 반영하지 않았음 — 러핑형은 최대 기복각 기준으로 별도 검토가 필요함.",
    "마스트 클라이밍·지브 교체·설치 위치 변경 등으로 최상단고·지브 설치고·지브 길이가 변경되는 경우 반드시 재검토 후 우리 공사와 사전 협의하여야 함.",
    "단계별 마스트 클라이밍 계획이 있는 경우, 각 단계의 최상단고에 대하여 사전에 단계별 검토를 시행할 것을 권고함.",
    `검토 산식 — BRA 초과량은 실제지구 기하(coneMSL = h_ant + d·tanθ + d²/2R, θ = ${theta}°)로 마스트·지브·카운터지브 각 부위의 최근접 경계에서 판정한 값이며, LoS 초과량은 4/3 유효지구 음영고도 대비 값으로 지브를 레이더 방위 단면에 투영한 근사임.`,
  ];
  const blockCautions = (
    <section className="brv-sec">
      <ul className="brv-list">
        {cautions.map((c, i) => (
          <OMEditable key={i} id={`crv.s6.caution${i}`} value={c} tag="li" />
        ))}
      </ul>
    </section>
  );

  // ── 블록 I: 서명 · 각주 ──
  const blockSign = (
    <section className="brv-sec brv-sign-sec">
      <div className="brv-sign">
        <OMEditable id="crv.sign.role" value={`${org} 항행안전시설 관리자`} tag="div" className="brv-sign-role" />
        <OMEditable id="crv.sign.org" value="한 국 공 항 공 사" tag="div" className="brv-sign-org" />
      </div>
      <OMEditable
        id="crv.foot"
        value={
          "본 보고서는 NEC ASTERIX 항적분석체계(BRA 방위각 스윕·LoS 분석 모듈)로 자동 산출되었으며, 정밀 판정은 " +
          `전문기관 전파영향분석을 따른다. 산정 조건: 지형 SRTM 약 ${stepM} m 간격 전수, 경로 건물 코리도 100 m, ` +
          `BRA 실제지구 기하(θ = ${theta}°), LoS 차폐 4/3 유효지구, 크레인 위치 건물(${CRANE_SELF_EXCLUDE_M} m 이내) 및 ` +
          `레이더 자체 건물·레이더 주변 ${RADAR_NEAR_EXCLUDE_M} m 이내 건물 제외` +
          (pairs.length > 0
            ? `(${pairs.map((p) => `${p.a.crane.name}/${p.f.site.name} 근접 ${p.f.nearRadarExcluded}동·자기 ${p.f.selfExcluded}동`).join(", ")}).`
            : ".")
        }
        tag="p"
        className="brv-foot"
      />
    </section>
  );

  return (
    <AutoPaginate>
      {blockHead}
      {blockOverview}
      {blockBasis}
      {blockSpecs}
      {blockSites}
      {blockReview}
      {blockResults}
      {blockConclusion}
      {blockCautions}
      {blockSign}
    </AutoPaginate>
  );
}
