/**
 * OM 보고서 §4 소실상세 — 장애물 추가 기인 소실표적 top-down(위에서 본) 분포 도면.
 *
 * 섹션3 영향범위 도면(ReportOMRadarBuildingMap)과 동일한 정적 래스터 타일 합성 방식
 * (공유 헬퍼: fitProjection·composeTiles — 라이브 MapLibre 미사용, WebGL 고갈/PDF 캡처 불안정 회피)으로
 * 레이더 · 분석 대상 건물 footprint · '장애물 추가 기인'으로 분류된 소실표적을 한 지도에 겹쳐
 * 표가 보여주지 못하는 공간 분포를 보여준다.
 *
 *  - 레이아웃: 도면이 페이지 콘텐츠 폭 전체를 채우는 **정사각형**(공간 분포 위주 페이지), 범례는 도면
 *    아래 가로 나열. 남는 페이지 공간에 이벤트 표가 들어간다(행수 산정: ReportOMLossEvents).
 *  - 소실표적: 이벤트 대표점이 아닌 분류된 보간점 전수를 그대로 찍는다(다운샘플링 금지 원칙).
 *  - 건물: 이 레이더에서 LoS 결과가 있는 분석 대상 건물만 — 표 분류 대상과 동일 집합.
 *  - PDF 안전: 단일 canvas + data-map-canvas/data-map-ready·data-map-complete 게이트(useReportExport 폴링) — §3 도면과 동일.
 */
import { useEffect, useMemo, useRef } from "react";
import type { ManualBuilding, BuildingGroup, RadarSite } from "../../types";
import { groupColorOf } from "./BuildingGroupBadge";
import OMEditable from "./OMEditable";
import {
  fitProjection, composeTiles, buildingPolygons, hexA,
  drawScaleBar, drawNorth, drawAttribution, type MapProjection,
} from "./ReportOMRadarBuildingMap";

/** 정사각 백킹 픽셀 — fullwidth 표시(콘텐츠 폭 182mm ≈ 688px)의 약 2배 밀도로 PDF 출력에서 또렷하게.
 *  §3 도면(BACK_W×BACK_H)과 동일 헬퍼를 정사각(w=h)으로 호출 — 표시 스케일(≈2×)도 §3 과 동일. */
const SQ = 1376;

interface Props {
  radarSite: RadarSite;
  /** 이 레이더에서 LoS 결과가 있는 분석 대상 건물 (표 분류 대상과 동일 집합) */
  buildings: ManualBuilding[];
  buildingGroups: BuildingGroup[];
  /** '장애물 추가 기인' 분류 소실표적 보간점 [lat, lon] — 전수 */
  lossPts: [number, number][];
}

interface Geom {
  proj: MapProjection;
  radarPx: [number, number];
  /** 건물별 footprint 픽셀 폴리곤(들) + 그룹 색 — footprint 없으면(점 건물) centerPx 마커 */
  bldgs: { polysPx: [number, number][][]; centerPx: [number, number]; color: string }[];
  lossPx: [number, number][];
}

export default function ReportOMLossEventsMap({ radarSite, buildings, buildingGroups, lossPts }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ── 기하 계산 — bbox(레이더+건물+소실표적) → 공유 투영(정사각) → 픽셀 좌표 ──
  const geom = useMemo<Geom>(() => {
    const pts: [number, number][] = [[radarSite.latitude, radarSite.longitude]];
    const polysByBldg = buildings.map((b) => buildingPolygons(b));
    for (let i = 0; i < buildings.length; i++) {
      pts.push([buildings[i].latitude, buildings[i].longitude]);
      for (const poly of polysByBldg[i]) for (const p of poly) pts.push(p);
    }
    for (const p of lossPts) pts.push(p);

    // 레이더·소실표적이 한눈에 최대 줌으로 보이도록 분수 줌(정수 floor 미적용 → bbox 대비 최대 ~2배
    //   줌아웃 해소) + 패딩 축소(0.06)로 정사각 프레임을 꽉 채운다. §1 히트맵·§2 위치도가 쓰는 검증된
    //   경로(composeTiles zInt=round(z) 타일 배치·축척막대 mpp 분수 z 성립). §3 부채꼴 도면은 기본 인자 경로라 불변.
    const proj = fitProjection(pts, SQ, SQ, { fractionalZoom: true, padRatio: 0.06 });
    const { project } = proj;

    return {
      proj,
      radarPx: project(radarSite.latitude, radarSite.longitude),
      bldgs: buildings.map((b, i) => ({
        polysPx: polysByBldg[i].map((poly) => poly.map(([la, lo]) => project(la, lo))),
        centerPx: project(b.latitude, b.longitude),
        color: groupColorOf(b.group_id, buildingGroups) ?? "#a60739",
      })),
      lossPx: lossPts.map(([la, lo]) => project(la, lo)),
    };
  }, [radarSite, buildings, buildingGroups, lossPts]);

  // ── 렌더: 타일 합성(공유 composeTiles) + 오버레이 ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // willReadFrequently: 소프트웨어(CPU) 백킹 강제 — 1376² 대형 정사각 백킹(~7.6MB)이 레이더 수만큼
    // 반복되므로 GPU 가속 백킹이면 공유 GPU 프로세스 상주 메모리를 크게 점유(§3 도면과 동일 근거).
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    canvas.width = SQ;
    canvas.height = SQ;
    // PDF 내보내기(useReportExport)가 data-map-ready 폴링 — §3 도면과 동일 게이트
    canvas.setAttribute("data-map-ready", "false");
    canvas.setAttribute("data-map-complete", "false");

    return composeTiles(ctx, geom.proj, `${radarSite.name} 소실상세`, (online, complete) => {
      // 소실표적 점 — 보간점 전수 (반투명 겹침으로 밀집도 표현, 보고서 통일 색 #ff1745)
      ctx.fillStyle = "rgba(255,23,69,0.55)";
      for (const [px, py] of geom.lossPx) { ctx.beginPath(); ctx.arc(px, py, 2.2, 0, Math.PI * 2); ctx.fill(); }

      // 건물 footprint (그룹 색) — 소실점 위에 그려 대상 위치가 묻히지 않게
      for (const bg of geom.bldgs) {
        if (bg.polysPx.length > 0) {
          for (const poly of bg.polysPx) {
            ctx.beginPath();
            for (let i = 0; i < poly.length; i++) { const [px, py] = poly[i]; if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
            ctx.closePath();
            ctx.fillStyle = hexA(bg.color, 0.65);
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = bg.color;
            ctx.stroke();
          }
        } else {
          const [bx, by] = bg.centerPx;
          ctx.beginPath();
          ctx.arc(bx, by, 5, 0, Math.PI * 2);
          ctx.fillStyle = hexA(bg.color, 0.85);
          ctx.fill();
          ctx.lineWidth = 1.5; ctx.strokeStyle = "#fff"; ctx.stroke();
        }
      }

      // 레이더 마커 (◉)
      const [rx, ry] = geom.radarPx;
      ctx.beginPath(); ctx.arc(rx, ry, 7, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
      ctx.beginPath(); ctx.arc(rx, ry, 5, 0, Math.PI * 2); ctx.fillStyle = "#1d4ed8"; ctx.fill();
      ctx.beginPath(); ctx.arc(rx, ry, 2, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();

      drawScaleBar(ctx, geom.proj.mpp, SQ);
      drawNorth(ctx, SQ);
      drawAttribution(ctx, online, SQ, SQ);

      // 렌더 완료 — 내보내기 게이트 통과 허용 (오프라인 폴백도 '완료'로 간주해 무한 대기 방지)
      canvas.setAttribute("data-map-ready", "true");
      // 타일 부분 유실 자가치유(백그라운드 재시도 재합성) 진행 여부 — 내보내기 게이트가 잠시 대기
      canvas.setAttribute("data-map-complete", complete ? "true" : "false");
    }, SQ, SQ);
  }, [geom, radarSite.name]);

  const eid = `lossmap.${radarSite.name}`;

  return (
    <div className="mb-2">
      <div className="mb-1 flex items-center justify-between text-[12px]">
        <OMEditable id={`${eid}.title`} value="장애물 추가 기인 소실표적 분포 — 위에서 본 도면" tag="span" className="font-semibold text-gray-800" />
        <span className="text-[10px] text-gray-400">소실 보간점 {lossPts.length.toLocaleString()}개</span>
      </div>

      {/* 정사각 도면 — 페이지 콘텐츠 폭 전체 */}
      <canvas
        ref={canvasRef}
        width={SQ}
        height={SQ}
        data-map-canvas="1"
        data-map-ready="false"
        data-map-complete="false"
        style={{ width: "100%", height: "auto", display: "block", border: "1px solid #e5e7eb", borderRadius: 4 }}
      />

      {/* 범례 — 도면 아래 가로 나열: 레이더/소실표적 + 분석 대상 건물별 그룹 색 */}
      <div className="mt-1.5 text-[10px] text-gray-600">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "#1d4ed8", boxShadow: "0 0 0 1px #fff" }} />
            <OMEditable id={`${eid}.legend.radar`} value="레이더" tag="span" /> ({radarSite.name})
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "rgba(255,23,69,0.9)" }} />
            <OMEditable id={`${eid}.legend.loss`} value="장애물 추가 기인 소실표적" tag="span" />
          </span>
          {geom.bldgs.map((bg, i) => (
            <span key={buildings[i].id} className="flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: bg.color, opacity: 0.7, border: `1px solid ${bg.color}` }} />
              {buildings[i].name || `건물 ${buildings[i].id}`}
            </span>
          ))}
        </div>
        <div className="mt-1 text-[9px] text-gray-400 leading-snug">
          <OMEditable id={`${eid}.note`} value="점은 아래 표(이벤트 단위)의 대표 좌표가 아닌 '장애물 추가 기인'으로 분류된 소실 보간점 전수 — 공간 분포 확인용." tag="span" />
        </div>
      </div>
    </div>
  );
}
