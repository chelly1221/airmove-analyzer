/**
 * OM 보고서 §4 소실상세 — 장애물 추가 기인 소실표적 top-down(위에서 본) 분포 도면.
 *
 * 섹션3 영향범위 도면(ReportOMRadarBuildingMap)과 동일한 정적 래스터 타일 합성 방식
 * (공유 헬퍼: fitProjection·composeTiles — 라이브 MapLibre 미사용, WebGL 고갈/PDF 캡처 불안정 회피)으로
 * 레이더 · 분석 대상 건물 footprint · '장애물 추가 기인'으로 분류된 소실표적을 한 지도에 겹쳐
 * 표(이벤트 단위 상위 30건)가 보여주지 못하는 공간 분포를 보여준다.
 *
 *  - 소실표적: 이벤트 대표점이 아닌 분류된 보간점 전수를 그대로 찍는다(다운샘플링 금지 원칙).
 *  - 건물: 이 레이더에서 LoS 결과가 있는 분석 대상 건물만 — 표 분류 대상과 동일 집합.
 *  - PDF 안전: 단일 canvas + data-map-canvas/data-map-ready 게이트(useReportExport 폴링) — §3 도면과 동일.
 */
import { useEffect, useMemo, useRef } from "react";
import type { ManualBuilding, BuildingGroup, RadarSite } from "../../types";
import { groupColorOf } from "./BuildingGroupBadge";
import OMEditable from "./OMEditable";
import {
  BACK_W, BACK_H, fitProjection, composeTiles, buildingPolygons, hexA,
  drawScaleBar, drawNorth, drawAttribution, type MapProjection,
} from "./ReportOMRadarBuildingMap";

/** 화면/PDF 표시 폭(px) — §3 도면과 동일(백킹의 절반 고밀도). 높이는 종횡비 자동(≈ 197px). */
const DISP_W = 360;

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

  // ── 기하 계산 — bbox(레이더+건물+소실표적) → 공유 투영 → 픽셀 좌표 ──
  const geom = useMemo<Geom>(() => {
    const pts: [number, number][] = [[radarSite.latitude, radarSite.longitude]];
    const polysByBldg = buildings.map((b) => buildingPolygons(b));
    for (let i = 0; i < buildings.length; i++) {
      pts.push([buildings[i].latitude, buildings[i].longitude]);
      for (const poly of polysByBldg[i]) for (const p of poly) pts.push(p);
    }
    for (const p of lossPts) pts.push(p);

    const proj = fitProjection(pts);
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
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = BACK_W;
    canvas.height = BACK_H;
    // PDF 내보내기(useReportExport)가 data-map-ready 폴링 — §3 도면과 동일 게이트
    canvas.setAttribute("data-map-ready", "false");

    return composeTiles(ctx, geom.proj, `${radarSite.name} 소실상세`, (online) => {
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

      drawScaleBar(ctx, geom.proj.mpp);
      drawNorth(ctx);
      drawAttribution(ctx, online);

      // 렌더 완료 — 내보내기 게이트 통과 허용 (오프라인 폴백도 '완료'로 간주해 무한 대기 방지)
      canvas.setAttribute("data-map-ready", "true");
    });
  }, [geom, radarSite.name]);

  const eid = `lossmap.${radarSite.name}`;

  return (
    <div className="mb-2">
      <div className="mb-1 flex items-center justify-between text-[12px]">
        <OMEditable id={`${eid}.title`} value="장애물 추가 기인 소실표적 분포 — 위에서 본 도면" tag="span" className="font-semibold text-gray-800" />
        <span className="text-[10px] text-gray-400">소실 보간점 {lossPts.length.toLocaleString()}개</span>
      </div>

      <div className="flex items-start gap-3">
        <canvas
          ref={canvasRef}
          width={BACK_W}
          height={BACK_H}
          data-map-canvas="1"
          data-map-ready="false"
          style={{ width: DISP_W, height: "auto", display: "block", flex: "0 0 auto", border: "1px solid #e5e7eb", borderRadius: 4 }}
        />

        {/* 범례 — 레이더/소실표적 + 분석 대상 건물별 그룹 색 */}
        <div className="flex-1 text-[10px] text-gray-600">
          <div className="mb-1.5 flex flex-col gap-1">
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
    </div>
  );
}
