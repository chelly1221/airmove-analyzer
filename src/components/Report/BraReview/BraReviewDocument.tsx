/**
 * 전파영향성 검토 의견서 본문 — 참고 문서(한국공항공사 BRA Viewer 산출물) 구성 1:1.
 *
 * 프레임 규약(상세는 utils/braReviewAnalysis.ts 헤더):
 *   BRA 제한고도 = 실제지구 기하 / LoS 차폐 = 4/3 유효지구 / 단면도 표시 = 실제지구 디스플레이 프레임.
 *
 * `<AutoPaginate>` 의 각 자식은 atomic 블록(A~I)이며, 모든 문구·수치 셀은 `OMEditable` 로
 * 인라인 편집된다(편집키 접두사 `brv.`, 시설별은 `brv.fac.<시설명>.`).
 */
import { useMemo } from "react";
import { format } from "date-fns";
import AutoPaginate from "../AutoPaginate";
import OMEditable from "../OMEditable";
import BraReviewCrossSection from "./BraReviewCrossSection";
import {
  fmt, toDms, GROUND_SOURCE_LABEL, HEIGHT_SOURCE_LABEL, RADAR_NEAR_EXCLUDE_M,
  type BraReviewFacility, type BraReviewResult,
} from "../../../utils/braReviewAnalysis";
import type { ReportMetadata } from "../../../types";

/** 항목 기호 — 가, 나, 다, … (블록 G 시설별 단면도는 '다' 부터 이어붙임) */
const ORDINALS = ["가", "나", "다", "라", "마", "바", "사", "아", "자", "차", "카", "타", "파", "하"];

/** 초과/여유 수치 표기 — 양수(초과)는 빨강 +, 음수(여유)는 회색 − */
function ExcessCell({ id, value }: { id: string; value: number }) {
  const positive = value > 0;
  const text = positive ? `+${fmt(value, 2)}` : `−${fmt(Math.abs(value), 2)}`;
  return <OMEditable id={id} value={text} tag="td" className={`num ${positive ? "pos" : "neg"}`} />;
}

interface Props {
  result: BraReviewResult;
  metadata: ReportMetadata;
}

export default function BraReviewDocument({ result, metadata }: Props) {
  const { payload, groundElevM, groundSource, rooftopAmslM, facilities } = result;
  const bld = payload.building;
  const org = metadata.organization || "한국공항공사";
  const theta = payload.braAngleDeg;

  // 문서번호·작성일 — 페이로드 생성 시각 고정(렌더마다 흔들리지 않게)
  const issued = useMemo(() => {
    const d = new Date(payload.generatedAt);
    return Number.isNaN(d.getTime()) ? new Date() : d;
  }, [payload.generatedAt]);
  const docNo = `BRA-${format(issued, "yyyyMMdd")}-${format(issued, "HHmm")}`;
  const docDate = `${issued.getFullYear()}. ${issued.getMonth() + 1}. ${issued.getDate()}.`;

  const primary = facilities[0];
  const exceeded = facilities.filter((f) => f.braExceeded);
  const exceededList = exceeded.map((f) => `${f.site.name}(약 ${fmt(f.braExcessM, 1)} m 초과)`).join(", ");
  const unshielded = exceeded.filter((f) => f.los != null && !f.los.shielded);
  const losFailed = exceeded.filter((f) => f.los == null);
  const minMargin = facilities.length > 0 ? Math.min(...facilities.map((f) => -f.braExcessM)) : 0;
  const radarNames = payload.radarSites.map((s) => s.name).join("·");
  // 각주용 샘플 간격 (대표 시설 기준)
  const stepM = primary ? Math.round(primary.sampleStepM) : 20;

  const facLabel = (f: BraReviewFacility) => `${f.site.name} (PSR/SSR)`;
  const key = (f: BraReviewFacility, suffix: string) => `brv.fac.${f.site.name}.${suffix}`;

  // ── 블록 A: 머리 ──
  const blockHead = (
    <div className="brv-head">
      <div className="brv-doc-meta">
        <OMEditable id="brv.head.docno" value={`문서번호 : ${docNo}`} tag="div" />
        <OMEditable id="brv.head.docdate" value={`작성일 : ${docDate}`} tag="div" />
      </div>
      <OMEditable id="brv.head.title" value="전파영향성 검토 의견서" tag="h1" className="brv-h1" />
      <OMEditable
        id="brv.head.subtitle"
        value={`${org} 항행안전시설(레이더 ${radarNames})`}
        tag="p"
        className="brv-subtitle"
      />
      <div className="brv-rule" />
    </div>
  );

  // ── 블록 B: 1. 개요 ──
  const blockOverview = (
    <section className="brv-sec">
      <OMEditable id="brv.s1.h" value="1. 개요" tag="h2" className="brv-h2" />
      <OMEditable
        id="brv.s1.p"
        value={`「${bld.name}」 신축·설치에 따른 ${org} 항행안전시설 전파영향성(ICAO EUR DOC 015 전파장애물 제한구역, BRA) 저촉 여부 검토 결과임.`}
        tag="p"
        className="brv-p"
      />
    </section>
  );

  // ── 블록 C: 2. 관련 근거 ──
  const basisLines = [
    "가. ICAO EUR DOC 015 — Building Restricted Area",
    "나. 항행안전시설 관리 및 운영규정 (국토교통부 고시)",
    "다. 항행안전무선시설의 설치 및 기술기준 (국토교통부 고시)",
    "라. 항행안전시설 전파장애 유발 가능성 검토기준",
  ];
  const blockBasis = (
    <section className="brv-sec">
      <OMEditable id="brv.s2.h" value="2. 관련 근거" tag="h2" className="brv-h2" />
      <div className="brv-basis">
        {basisLines.map((line, i) => (
          <OMEditable key={i} id={`brv.s2.l${i}`} value={line} tag="div" className="brv-basis-line" />
        ))}
      </div>
    </section>
  );

  // ── 블록 D: 3. 검토 대상 (구조물 제원) ──
  const areaText = bld.areaM2Registry
    ? `${bld.areaM2Registry} ㎡`
    : bld.footprintAreaM2 != null
      ? `${fmt(bld.footprintAreaM2, 0)} ㎡ (도형 실측)`
      : "-";
  const floorsText = [
    bld.floorsAbove ? `지상 ${bld.floorsAbove} 층` : null,
    bld.floorsBelow ? `지하 ${bld.floorsBelow} 층` : null,
  ].filter(Boolean).join(" / ");
  const addrText = bld.roadAddr ?? bld.jibunAddr;

  const blockSpec = (
    <section className="brv-sec">
      <OMEditable id="brv.s3.h" value="3. 검토 대상 (구조물 제원)" tag="h2" className="brv-h2" />
      <table className="brv-table brv-table-spec">
        <tbody>
          <tr>
            <OMEditable id="brv.s3.k.name" value="명칭 / ID" tag="th" />
            <td><OMEditable id="brv.s3.v.name" value={bld.name} tag="span" /></td>
          </tr>
          <tr>
            <OMEditable id="brv.s3.k.pos" value="위치 (WGS84)" tag="th" />
            <td>
              <OMEditable
                id="brv.s3.v.pos"
                value={`${toDms(bld.lat, "lat")} / ${toDms(bld.lon, "lon")}`}
                tag="span"
              />
            </td>
          </tr>
          {facilities.map((f, i) => (
            <tr key={key(f, "spec")}>
              <OMEditable
                id={key(f, "spec.k")}
                value={facilities.length > 1 ? `레이더(안테나) 기준 — ${f.site.name}` : "레이더(안테나) 기준"}
                tag="th"
              />
              <td>
                <OMEditable
                  id={key(f, "spec.v")}
                  value={`${f.azimuthDeg.toFixed(0)}° 방위, ${fmt(f.distKm, 2)} km`}
                  tag="span"
                />
                {i === 0 && facilities.length === 1 && (
                  <span className="brv-badge">{f.site.name}</span>
                )}
              </td>
            </tr>
          ))}
          <tr>
            <OMEditable id="brv.s3.k.ground" value="지반고 (MSL)" tag="th" />
            <td>
              <OMEditable id="brv.s3.v.ground" value={`${fmt(groundElevM, 2)} m`} tag="span" />
              <span className="brv-badge">{GROUND_SOURCE_LABEL[groundSource]}</span>
            </td>
          </tr>
          <tr>
            <OMEditable id="brv.s3.k.height" value="구조물 높이" tag="th" />
            <td>
              <OMEditable id="brv.s3.v.height" value={`${fmt(bld.heightM, 2)} m`} tag="span" />
              <span className="brv-badge">{HEIGHT_SOURCE_LABEL[bld.heightSource]}</span>
            </td>
          </tr>
          <tr>
            <OMEditable id="brv.s3.k.rooftop" value="옥상고 (MSL)" tag="th" />
            <td>
              <OMEditable id="brv.s3.v.rooftop" value={`${fmt(rooftopAmslM, 2)} m`} tag="span" className="strong" />
            </td>
          </tr>
          <tr>
            <OMEditable id="brv.s3.k.area" value="바닥 면적" tag="th" />
            <td><OMEditable id="brv.s3.v.area" value={areaText} tag="span" /></td>
          </tr>
          {bld.usage && (
            <tr>
              <OMEditable id="brv.s3.k.usage" value="용도" tag="th" />
              <td><OMEditable id="brv.s3.v.usage" value={bld.usage} tag="span" /></td>
            </tr>
          )}
          {bld.structure && (
            <tr>
              <OMEditable id="brv.s3.k.struct" value="구조" tag="th" />
              <td><OMEditable id="brv.s3.v.struct" value={bld.structure} tag="span" /></td>
            </tr>
          )}
          {floorsText && (
            <tr>
              <OMEditable id="brv.s3.k.floors" value="층수" tag="th" />
              <td><OMEditable id="brv.s3.v.floors" value={floorsText} tag="span" /></td>
            </tr>
          )}
          {addrText && (
            <tr>
              <OMEditable id="brv.s3.k.addr" value="주소" tag="th" />
              <td><OMEditable id="brv.s3.v.addr" value={addrText} tag="span" /></td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );

  // ── 블록 E: 4. 검토 내용 — 가. 문단 + 판정 바 ──
  const blockReviewIntro = (
    <section className="brv-sec">
      <OMEditable id="brv.s4.h" value="4. 검토 내용" tag="h2" className="brv-h2" />
      <p className="brv-p">
        <span className="brv-ord">가.</span>{" "}
        <OMEditable
          id="brv.s4.a"
          value={
            primary
              ? `해당 구조물은 ${org} 항행안전시설(${primary.site.name}) 안테나로부터 약 ${primary.azimuthDeg.toFixed(0)}° 방위, ${fmt(primary.distKm, 2)} km 거리에 위치하며, 전파장애물 제한표면(BRA) 저촉 여부를 검토함.`
              : "검토 대상 항행안전시설이 지정되지 않았습니다."
          }
          tag="span"
        />
      </p>
      {exceeded.length > 0 ? (
        <div className="brv-verdict bad">
          <OMEditable
            id="brv.s4.verdict"
            value={`▲ 전파영향성 제한표면(BRA) 초과 — ${exceeded.length}개 시설 저촉`}
            tag="span"
          />
        </div>
      ) : (
        <div className="brv-verdict ok">
          <OMEditable
            id="brv.s4.verdict"
            value="● 전파영향성 제한표면(BRA) 이내 — 저촉 시설 없음"
            tag="span"
          />
        </div>
      )}
    </section>
  );

  // ── 블록 F: 나. 제한표면 및 초과 내역 표 ──
  const blockTable = (
    <section className="brv-sec">
      <p className="brv-p">
        <span className="brv-ord">나.</span>{" "}
        <OMEditable id="brv.s4.b" value="전파영향성 제한표면 및 초과 내역" tag="span" />
      </p>
      <table className="brv-table">
        <thead>
          <tr>
            <OMEditable id="brv.tbl.h0" value="시설명" tag="th" />
            <OMEditable id="brv.tbl.h1" value="지반고 (MSL, m)" tag="th" />
            <OMEditable id="brv.tbl.h2" value="구조물고도 (m)" tag="th" />
            <OMEditable id="brv.tbl.h3" value="옥상고 (MSL, m)" tag="th" />
            <OMEditable id="brv.tbl.h4" value="BRA 제한고도 (MSL, m)" tag="th" />
            <OMEditable id="brv.tbl.h5" value="초과량 (m)" tag="th" />
            <OMEditable id="brv.tbl.h6" value="LoS 음영고도 (MSL, m)" tag="th" />
            <OMEditable id="brv.tbl.h7" value="LoS 초과량 (m)" tag="th" />
          </tr>
        </thead>
        <tbody>
          {facilities.map((f) => (
            <tr key={key(f, "row")}>
              <OMEditable id={key(f, "row.name")} value={facLabel(f)} tag="td" />
              <OMEditable id={key(f, "row.ground")} value={fmt(groundElevM, 2)} tag="td" className="num" />
              <OMEditable id={key(f, "row.height")} value={fmt(bld.heightM, 2)} tag="td" className="num" />
              <OMEditable id={key(f, "row.rooftop")} value={fmt(rooftopAmslM, 2)} tag="td" className="num" />
              <OMEditable id={key(f, "row.cone")} value={fmt(f.coneMslM, 2)} tag="td" className="num" />
              <ExcessCell id={key(f, "row.excess")} value={f.braExcessM} />
              {f.los ? (
                <>
                  <OMEditable id={key(f, "row.shadow")} value={fmt(f.los.shadowAmslM, 2)} tag="td" className="num" />
                  <ExcessCell id={key(f, "row.losexcess")} value={f.los.losExcessM} />
                </>
              ) : (
                <>
                  <OMEditable id={key(f, "row.shadow")} value="산출 실패" tag="td" className="num neg" />
                  <OMEditable id={key(f, "row.losexcess")} value="산출 실패" tag="td" className="num neg" />
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );

  // ── 블록 G: 시설별 BRA 수직단면도 ──
  const blockCharts = facilities.map((f, i) => {
    const ord = ORDINALS[Math.min(2 + i, ORDINALS.length - 1)];
    return (
      <section className="brv-sec" key={key(f, "chart")}>
        <p className="brv-p">
          <span className="brv-ord">{ord}.</span>{" "}
          <OMEditable
            id={key(f, "chart.h")}
            value={`BRA 수직단면도 — ${f.site.name} 기준 (ICAO EUR DOC 015 Figure 3.3 준용)`}
            tag="span"
          />
        </p>
        {f.error || !f.los ? (
          <div className="brv-chart-error">
            <OMEditable
              id={key(f, "chart.err")}
              value={`단면도를 생성하지 못했습니다 — ${f.error ?? "LoS 산출 실패"}`}
              tag="span"
            />
          </div>
        ) : (
          <>
            <div className="brv-chart-wrap">
              <div className="brv-chart-title">
                BRA 수직단면도 (ICAO EUR DOC 015 Figure 3.3 준용) — {f.site.name}
              </div>
              <div className="brv-chart-sub">
                안테나 → 「{bld.name}」 방위 {f.azimuthDeg.toFixed(1)}° 방사 단면 · 고도 기준 MSL ·
                {" "}지형·건물 프로파일 포함 (SRTM {stepM} m 간격 전수)
              </div>
              <BraReviewCrossSection
                facility={f}
                buildingName={bld.name}
                groundElevM={groundElevM}
                rooftopAmslM={rooftopAmslM}
                braAngleDeg={theta}
              />
            </div>
            <p className="brv-caption">
              <OMEditable
                id={key(f, "chart.cap")}
                value={
                  `단면도 기준 시설 ${f.site.name}(안테나 정점표고 ${fmt(f.hAntM, 2)} m MSL, 기초표고 ${fmt(f.site.altitude, 2)} m + 안테나 ${fmt(f.site.antenna_height, 2)} m) 기준 — ` +
                  `건물까지 방위 ${f.azimuthDeg.toFixed(1)}°, 수평거리 d = ${fmt(f.distKm * 1000, 0)} m. ` +
                  `BRA 기준각 θ = ${theta}°(실제지구 곡률 포함, coneMSL = h_ant + d·tanθ + d²/2R). ` +
                  `제한고도 = ${fmt(f.coneMslM, 2)} m (MSL) · 옥상고 ${fmt(rooftopAmslM, 2)} m → `
                }
                tag="span"
              />
              <OMEditable
                id={key(f, "chart.cap.verdict")}
                value={f.braExceeded ? `약 ${fmt(f.braExcessM, 2)} m 초과` : `${fmt(-f.braExcessM, 2)} m 여유`}
                tag="span"
                className={f.braExceeded ? "brv-strong-bad" : "brv-strong-ok"}
              />
            </p>
          </>
        )}
      </section>
    );
  });

  // ── 블록 H: 5. 검토 결과 ──
  const cautions = [
    "전파영향성 제한고도를 초과하여 건축(타워크레인 등 임시구조물 포함)하는 경우, 사전에 전문기관의 전파영향 분석 시뮬레이션 및 구조물 설치상황에 대한 항행안전시설 특별 비행검사를 우리 공사와 협의 하에 시행하여야 함.",
    "건축물·건설기기·임시구조물의 최고 높이가 변경되는 경우 반드시 우리 공사와 사전 협의 후 진행하여야 함.",
    "설치 중 항공기 전파영향(난반사 등) 또는 항행안전시설 비정상 동작 등이 발생되는 경우 즉시 작업 중지 및 회피 조치(공사계획 변경·원상복구 등)가 필요함.",
    "작업 중 사용하는 무선통신시설(CCTV 영상전송장치 등)은 전파인증 받은 장비를 사용하고, 운용주파수 및 고조파가 항행안전시설 주파수와 겹치지 않도록 주의하여야 함.",
    "신축 건축물 및 임시 구조물 설치 전 본 검토의견을 바탕으로 운영 중인 항행안전시설의 전파영향성을 고려하여 사전에 관련 부서와 반드시 협의 후 진행하여야 함.",
  ];

  // 결론 — 초과 없음 / 일부 미차폐 / LoS 산출 실패(판정 불가) / 전부 차폐 순.
  // 산출 실패를 '직접 가시'로 묶지 않는다(판정 기준을 흐리는 폴백 금지).
  const conclusion =
    exceeded.length === 0
      ? "→ 계획 구조물은 전파영향성 제한표면 이내에 위치하여 항행안전시설 전파 영향은 없을 것으로 판단됨."
      : unshielded.length > 0
        ? `→ ${unshielded.map((f) => f.site.name).join(", ")} 에 대해 제한표면 초과 및 직접 가시 상태로 전파 영향이 우려되므로, 전문기관 전파영향 분석 시뮬레이션 및 협의가 필요함.`
        : losFailed.length > 0
          ? `→ ${losFailed.map((f) => f.site.name).join(", ")} 의 전방 차폐(LOS) 분석이 실패하여 음영 여부를 판정하지 못하였으므로, 재분석 후 전문기관 전파영향 분석 시뮬레이션 및 협의가 필요함.`
          : `→ 제한표면을 초과하는 모든 시설(${exceeded.map((f) => f.site.name).join(", ")})이 전방 차폐물에 의해 음영구역 내에 위치하여, 해당 구조물에 의한 항행안전시설 전파 영향은 없을 것으로 판단됨.`;

  const blockResult = (
    <section className="brv-sec">
      <OMEditable id="brv.s5.h" value="5. 검토 결과" tag="h2" className="brv-h2" />
      {exceeded.length > 0 ? (
        <p className="brv-p">
          <OMEditable
            id="brv.s5.p1"
            value={`계획 구조물 「${bld.name}」의 옥상고(${fmt(rooftopAmslM, 2)} m, MSL)가 전파영향성 제한고도를 초과하는 시설: `}
            tag="span"
          />
          <OMEditable id="brv.s5.p1b" value={`${exceededList}.`} tag="span" className="brv-strong" />
        </p>
      ) : (
        <p className="brv-p">
          <OMEditable
            id="brv.s5.p1"
            value={`계획 구조물 「${bld.name}」의 옥상고(${fmt(rooftopAmslM, 2)} m, MSL)는 검토 대상 모든 시설의 제한고도 이내(최소 여유 ${fmt(minMargin, 2)} m)임.`}
            tag="span"
          />
        </p>
      )}

      {exceeded.length > 0 && (
        <>
          <p className="brv-p">
            <OMEditable id="brv.s5.p2a" value="전방 차폐(LOS) 분석" tag="span" className="brv-strong" />
            <OMEditable
              id="brv.s5.p2b"
              value={` — 제한표면을 초과하는 각 시설에 대해 안테나→구조물 가시선의 전방 지형·건물 차폐 여부를 개별 분석함(4/3 유효지구 굴절, 자기 건물 및 레이더 주변 ${RADAR_NEAR_EXCLUDE_M} m 이내 건물 제외):`}
              tag="span"
            />
          </p>
          <ul className="brv-list">
            {exceeded.map((f) => {
              const head = `${f.site.name} (제한고도 ${fmt(f.coneMslM, 1)} m, 약 ${fmt(f.braExcessM, 1)} m 초과)`;
              if (!f.los) {
                return (
                  <OMEditable
                    key={key(f, "s5.li")}
                    id={key(f, "s5.li")}
                    value={`${head} — LoS 차폐 분석 실패 — ${f.error ?? "단면 데이터를 얻지 못해 차폐 여부를 판정하지 못함"}.`}
                    tag="li"
                  />
                );
              }
              const blk = f.los.blocker;
              const blkText = blk
                ? blk.kind === "building"
                  ? `전방 건물「${blk.name ?? "무명"}」`
                  : `지형(${blk.name ?? "능선"})`
                : "전방 장애물";
              const value = f.los.shielded && blk
                ? `${head} — 차폐됨 — 안테나 전방 약 ${fmt(blk.distKm * 1000, 0)} m 지점의 ${blkText}(${toDms(blk.lat, "lat")}, ${toDms(blk.lon, "lon")}, 표고 약 ${fmt(blk.topAmslM, 1)} m)이 LOS를 차단하여, 음영(차폐)고도 약 ${fmt(f.los.shadowAmslM, 1)} m가 옥상고보다 약 ${fmt(-f.los.losExcessM, 1)} m 높음(음영구역 내).`
                : `${head} — 차폐되지 않음 — 음영고도 약 ${fmt(f.los.shadowAmslM, 1)} m 로 옥상고가 약 ${fmt(f.los.losExcessM, 1)} m 높아 안테나에서 직접 가시(전파 영향 가능).`;
              return <OMEditable key={key(f, "s5.li")} id={key(f, "s5.li")} value={value} tag="li" />;
            })}
          </ul>
        </>
      )}

    </section>
  );
  // §5 결론·유의사항은 별도 atomic 블록 — 한 덩어리면 페이지 하단 절반이 비는 분할이 잦음
  const blockConclusion = (
    <section className="brv-sec">
      <p className="brv-p brv-concl">
        <OMEditable id="brv.s5.concl" value={conclusion} tag="span" className="brv-strong" />
      </p>
    </section>
  );
  const blockCautions = (
    <section className="brv-sec">
      <ul className="brv-list">
        {cautions.map((c, i) => (
          <OMEditable key={i} id={`brv.s5.caution${i}`} value={c} tag="li" />
        ))}
      </ul>
    </section>
  );

  // ── 블록 I: 서명 · 각주 ──
  const blockSign = (
    <section className="brv-sec brv-sign-sec">
      <div className="brv-sign">
        <OMEditable id="brv.sign.role" value={`${org} 항행안전시설 관리자`} tag="div" className="brv-sign-role" />
        <OMEditable id="brv.sign.org" value="한 국 공 항 공 사" tag="div" className="brv-sign-org" />
      </div>
      <OMEditable
        id="brv.foot"
        value={
          `본 의견서는 NEC ASTERIX 항적분석체계(LoS·BRA 분석 모듈)로 자동 산출되었으며, 정밀 판정은 전문기관 전파영향분석을 따른다. ` +
          `산정 조건: 지형 SRTM 약 ${stepM} m 간격 전수, 경로 건물 코리도 100 m, BRA 실제지구 기하(θ=${theta}°), ` +
          `LoS 차폐 4/3 유효지구, 레이더 자체 건물 및 레이더 주변 ${RADAR_NEAR_EXCLUDE_M} m 이내 건물 제외` +
          `(${facilities.map((f) => `${f.site.name} ${f.nearRadarExcluded}동`).join(", ")}).`
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
      {blockSpec}
      {blockReviewIntro}
      {blockTable}
      {blockCharts}
      {blockResult}
      {blockConclusion}
      {blockCautions}
      {blockSign}
    </AutoPaginate>
  );
}
