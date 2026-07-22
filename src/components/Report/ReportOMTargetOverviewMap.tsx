/**
 * OM 보고서 §2 분석 대상 위치 도면 — 레이더(들) + 전체 분석 대상 건물을 한 장에 담은 top-down 지도.
 *
 * §1 히트맵(ReportOMTargetHeatmapMap)·§3/§4 도면(ReportOMRadarBuildingMap·ReportOMLossEventsMap)과
 * 동일한 정적 래스터 타일 합성 방식(공유 헬퍼: fitProjection·composeTiles·축척/나침반/저작권)으로 그린다.
 *
 *  - 라이브 MapLibre/deck.gl 미사용: 보고서는 도면이 여러 장 반복되므로 WebGL 컨텍스트 고갈/PDF 캡처
 *      불안정을 피해 정적 래스터로 1회 그린다(§1/§3/§4 와 동일 근거).
 *  - 꽉 찬 fit: fitProjection 을 분수 줌(fractionalZoom)+얇은 패딩(padRatio 0.05)으로 호출해 대상
 *      (레이더+건물)이 프레임을 거의 채우게 한다(§1 히트맵과 동일 분수 줌 경로).
 *  - 토지이용계획도 오버레이: 로컬 캐시(landuse_tiles, VWorld, z12–15)의 래스터 타일을 base 위에
 *      alpha 0.6 으로 얹는다. 레이어는 오프스크린 2장(baseCanvas: 타일 합성 / landuseCanvas: 토지이용
 *      타일)으로 분리하고, 자가치유 재합성(composeTiles onDone)·비동기 토지이용 로드 어느 시점에서든
 *      redraw() 가 base→토지이용→오버레이 순으로 보이는 canvas 에 재합성한다.
 *  - CPU 백킹(getContext willReadFrequently): 보이는 canvas + 오프스크린 2장 모두 소프트웨어 래스터로
 *      강제 — 공유 GPU 프로세스 메모리 상주 회피(§1/§3/§4 동일). §2 는 보고서당 1장이라 오프스크린
 *      2장(~8.6MB) 추가는 허용.
 *  - PDF 안전: 단일 <canvas> + data-map-canvas/ready/complete 게이트. data-map-ready 는 base 첫 onDone
 *      시점에 열려 토지이용 로드가 내보내기 게이트(4초 예산)를 지연시키지 않는다. data-map-complete 는
 *      base 자가치유 확정 **및** 토지이용 로드 확정(전 타일 처리 또는 재시도 패스 소진/스킵) 양쪽이 끝나야 true — 의미 확장.
 *  - 표↔지도 대조: 각 건물 centroid 에 §2 표 행 번호(buildings 배열 순서 index+1)와 동일한 번호 칩을
 *      찍어 "한눈에" 위치를 대응시킨다.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ManualBuilding, BuildingGroup, RadarSite } from "../../types";
import {
  fitProjection, composeTiles, buildingPolygons, hexA,
  drawScaleBar, drawNorth, drawAttribution, TILE, type MapProjection,
} from "./ReportOMRadarBuildingMap";
import { groupColorOf } from "./BuildingGroupBadge";
import OMEditable from "./OMEditable";

/** 백킹 픽셀(렌더 해상도) — 16:9. 콘텐츠 폭(182mm) 표시의 약 2배 밀도로 PDF 에서 또렷. */
const W = 1376;
const H = 774;

interface Props {
  buildings: ManualBuilding[];
  buildingGroups: BuildingGroup[];
  radarSites: RadarSite[];
}

/** 건물 1개의 사전 투영 기하 — 렌더 핫패스(onDone 재합성마다 재그림)라 memoize */
interface BldgPx {
  /** footprint 폴리곤(픽셀). 점 건물이면 빈 배열 → 원형 마커 폴백 */
  polysPx: [number, number][][];
  /** centroid 픽셀 — 번호 칩 위치 */
  centerPx: [number, number];
  /** 그룹색 (미분류/미매칭이면 액센트) */
  color: string;
  /** 표 행 번호(= index+1) 문자열 */
  label: string;
}

interface RadarPx {
  px: [number, number];
  name: string;
}

interface Geom {
  proj: MapProjection;
  bldgs: BldgPx[];
  radars: RadarPx[];
}

export default function ReportOMTargetOverviewMap({ buildings, buildingGroups, radarSites }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [landuseShown, setLanduseShown] = useState(false); // 토지이용 타일 1장 이상 도착 → 범례 안내 표시

  // ── 기하 계산 — fit 점집합(레이더 + 건물 centroid + footprint 꼭짓점) → 공유 투영 → 픽셀 사전투영 ──
  //   (composeTiles 의 onDone 이 재합성마다 오버레이를 다시 그리므로, 그리기 루프에서 투영/JSON 파싱을
  //    반복하지 않도록 여기서 1회 픽셀화)
  const geom = useMemo<Geom>(() => {
    // fit 대상 점: 모든 레이더 좌표 + 모든 건물 centroid + footprint 꼭짓점 전부 (아래 padRatio 0.05 패딩)
    const fitPts: [number, number][] = [];
    for (const r of radarSites) fitPts.push([r.latitude, r.longitude]);
    const polysByBldg: [number, number][][][] = [];
    for (const b of buildings) {
      fitPts.push([b.latitude, b.longitude]);
      const polys = buildingPolygons(b);
      polysByBldg.push(polys);
      for (const poly of polys) for (const p of poly) fitPts.push(p);
    }
    // 방어 — 대상이 하나도 없으면 투영이 degenerate. 최소 1점 보장(호출부에서 건물 0개면 미렌더 예정).
    if (fitPts.length === 0) fitPts.push([37.5, 127]);

    // 분수 줌 꽉 찬 fit(padRatio 0.05) — 대상(레이더+건물)이 프레임을 거의 채우게(§1 히트맵과 동일 경로).
    const proj = fitProjection(fitPts, W, H, { padRatio: 0.05, fractionalZoom: true });
    const { project } = proj;

    const bldgs: BldgPx[] = buildings.map((b, i) => {
      const polys = polysByBldg[i];
      const polysPx = polys.map((poly) => poly.map((p) => project(p[0], p[1]) as [number, number]));
      return {
        polysPx,
        centerPx: project(b.latitude, b.longitude),
        color: groupColorOf(b.group_id, buildingGroups) ?? "#a60739",
        label: String(i + 1),
      };
    });

    const radars: RadarPx[] = radarSites.map((r) => ({ px: project(r.latitude, r.longitude), name: r.name }));

    return { proj, bldgs, radars };
  }, [buildings, buildingGroups, radarSites]);

  // ── 렌더: 오프스크린 2장(base 타일 합성 + landuse 토지이용) → 보이는 canvas 로 재합성 ──
  //   자가치유 재합성(composeTiles onDone)·비동기 토지이용 로드 양쪽에서 임의 시점 재그리기가
  //   가능해야 하므로, §1/§3/§4 의 '단일-ctx 직접 그리기'와 달리 오프스크린 2장 + redraw() 로 재구성.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // willReadFrequently: 소프트웨어(CPU) 백킹 강제 — GPU 가속 백킹이면 공유 GPU 프로세스 상주 메모리를
    //   점유(§1/§3/§4 도면과 동일 근거).
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    canvas.width = W;
    canvas.height = H;
    // PDF 내보내기(useReportExport)가 data-map-ready/complete 폴링 — §1 히트맵과 동일 게이트
    canvas.setAttribute("data-map-ready", "false");
    canvas.setAttribute("data-map-complete", "false");
    setLanduseShown(false); // geom 재계산마다 초기화 — 새 뷰에 토지이용 없으면 범례 미표시

    // 오프스크린 2장(각 W×H, ~4.3MB) — 둘 다 CPU 백킹(공유 GPU 프로세스 상주 회피, 위 근거 동일).
    //   §2 는 보고서당 1장이라 추가 ~8.6MB 허용.
    const baseCanvas = document.createElement("canvas");
    baseCanvas.width = W; baseCanvas.height = H;
    const baseCtx = baseCanvas.getContext("2d", { willReadFrequently: true });
    const landuseCanvas = document.createElement("canvas");
    landuseCanvas.width = W; landuseCanvas.height = H;
    const landuseCtx = landuseCanvas.getContext("2d", { willReadFrequently: true });
    if (!baseCtx || !landuseCtx) return;

    let cancelled = false;
    let baseDrawn = false;      // base 첫 합성 완료 가드 — 이전엔 redraw 금지
    let baseOnline = false;     // 마지막 onDone 의 online (drawAttribution 용)
    let baseComplete = false;   // 마지막 onDone 의 complete (자가치유 확정 여부)
    let landuseSettled = false; // 토지이용 로드 확정(전 타일 처리/데드라인/스킵)
    let landuseCount = 0;       // landuseCanvas 에 그린 타일 수 (>0 이면 오버레이 합성)
    const luImgs: HTMLImageElement[] = []; // 진행 중 토지이용 Image (cleanup 해제용)

    // 보이는 canvas 재합성 — base(불투명 전면) → 토지이용(alpha 0.6)+흰 베일 → 기존 오버레이 → 게이트.
    const redraw = () => {
      if (!baseDrawn) return; // base 첫 합성 전엔 그리지 않음(가드)
      // ① base 타일 합성 결과 (전면 불투명 — 이전 오버레이를 덮어씀)
      ctx.drawImage(baseCanvas, 0, 0);
      // ② 토지이용계획도 오버레이 (1장 이상 도착 시) — alpha 0.6 + 가독성용 옅은 흰 베일 1회
      if (landuseCount > 0) {
        ctx.globalAlpha = 0.6;
        ctx.drawImage(landuseCanvas, 0, 0);
        ctx.globalAlpha = 1;
        ctx.fillStyle = "rgba(255,255,255,0.10)";
        ctx.fillRect(0, 0, W, H);
      }
      // ③ 기존 오버레이 — 건물 footprint → 번호 칩 → 레이더 마커/라벨 → 축척·나침반·저작권 (순서/코드 동일)
      // 3-1) 건물 footprint — 그룹색 채움(alpha 0.55) + 그룹색 stroke. 점 건물은 원형 마커.
      for (const b of geom.bldgs) {
        if (b.polysPx.length > 0) {
          for (const poly of b.polysPx) {
            ctx.beginPath();
            for (let i = 0; i < poly.length; i++) {
              const [px, py] = poly[i];
              if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.closePath();
            ctx.fillStyle = hexA(b.color, 0.55);
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = b.color;
            ctx.stroke();
          }
        } else {
          const [bx, by] = b.centerPx;
          ctx.beginPath();
          ctx.arc(bx, by, 9, 0, Math.PI * 2);
          ctx.fillStyle = hexA(b.color, 0.85);
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = "#fff";
          ctx.stroke();
        }
      }
      // 3-2) 번호 칩 — centroid 에 표 행 번호(index+1). 그룹색 배경 원 + 흰 외곽선 + 흰 bold 텍스트.
      for (const b of geom.bldgs) drawNumberChip(ctx, b.centerPx[0], b.centerPx[1], b.label, b.color);
      // 3-3) 레이더 마커 (◉) + 레이더명 라벨 칩
      for (const r of geom.radars) {
        const [rx, ry] = r.px;
        ctx.beginPath(); ctx.arc(rx, ry, 11, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
        ctx.beginPath(); ctx.arc(rx, ry, 8, 0, Math.PI * 2); ctx.fillStyle = "#1d4ed8"; ctx.fill();
        ctx.beginPath(); ctx.arc(rx, ry, 3.5, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
        drawRadarLabel(ctx, rx, ry, r.name);
      }
      // 3-4) 축척 막대 · 나침반 · 저작권
      drawScaleBar(ctx, geom.proj.mpp, H);
      drawNorth(ctx, W);
      drawAttribution(ctx, baseOnline, W, H);
      // ④ 게이트 — ready 는 base 첫 onDone 에 열림(오프라인 폴백도 '완료'로 간주). complete 는 base
      //    자가치유 확정 && 토지이용 로드 확정 둘 다일 때만 true (의미 확장 — 내보내기 게이트가 잠시 대기).
      canvas.setAttribute("data-map-ready", "true");
      canvas.setAttribute("data-map-complete", baseComplete && landuseSettled ? "true" : "false");
    };

    // ── base 타일 합성 (공유 composeTiles → 오프스크린 baseCtx). onDone 마다 상태 저장 후 redraw. ──
    const cancelBase = composeTiles(baseCtx, geom.proj, "분석 대상 위치 도면", (online, complete) => {
      baseDrawn = true;
      baseOnline = online;
      baseComplete = complete;
      redraw();
    }, W, H);

    // ── 토지이용계획도 타일 로드 (composeTiles 와 병행) ──
    //   캐시는 z12–15 만 존재 → landuseZ 로 클램프. 뷰포트 커버 타일은 composeTiles 와 동일 수식으로 열거.
    const proj = geom.proj;
    const { originX, originY } = proj;
    const landuseZ = Math.max(12, Math.min(15, Math.round(proj.z)));
    const T_lu = TILE * Math.pow(2, proj.z - landuseZ); // 화면 타일 크기(분수 줌 스케일 반영)
    const nLu = Math.pow(2, landuseZ);
    const ltx0 = Math.floor(originX / T_lu), ltx1 = Math.floor((originX + W) / T_lu);
    const lty0 = Math.floor(originY / T_lu), lty1 = Math.floor((originY + H) / T_lu);
    const luTargets: { tx: number; ty: number }[] = [];
    for (let tx = ltx0; tx <= ltx1; tx++)
      for (let ty = lty0; ty <= lty1; ty++) if (ty >= 0 && ty < nLu) luTargets.push({ tx, ty });

    // 토지이용 로드 확정 — 확정 플래그 세우고 redraw(base 미완이면 no-op → 이후 base onDone 에서 반영).
    const finalizeLanduse = () => {
      if (landuseSettled) return;
      landuseSettled = true;
      redraw();
    };

    // landuseCanvas 에 타일 그리기 — composeTiles drawAll 과 동일한 픽셀 스냅 방식.
    const drawLuTile = (t: { tx: number; ty: number }, img: HTMLImageElement) => {
      const x0 = Math.round(t.tx * T_lu - originX), y0 = Math.round(t.ty * T_lu - originY);
      const x1 = Math.round((t.tx + 1) * T_lu - originX), y1 = Math.round((t.ty + 1) * T_lu - originY);
      landuseCtx.drawImage(img, x0, y0, x1 - x0, y1 - y0);
      landuseCount++;
      if (landuseCount === 1) setLanduseShown(true); // 첫 타일 도착 → 범례에 토지이용 안내 표시
    };

    // 타일 1개 로드 결과 분류: "drawn"(성공, 그림) / "absent"(invoke null — DB에 없음, 영구, 재시도
    //   불필요) / "retry"(데드라인 만료·invoke 에러·onerror — 미처리, 다음 패스에서 재시도).
    //   잔여 예산 setTimeout 으로 invoke 행잉 시에도 반드시 데드라인 내 resolve (풀이 무한 대기 방지).
    type LuResult = "drawn" | "absent" | "retry";
    const loadOne = (t: { tx: number; ty: number }, deadline: number) => new Promise<LuResult>((resolve) => {
      let done = false;
      const finish = (r: LuResult) => { if (!done) { done = true; resolve(r); } };
      const timer = setTimeout(() => finish("retry"), Math.max(0, deadline - Date.now()));
      if (cancelled) { clearTimeout(timer); finish("retry"); return; }
      const wx = ((t.tx % nLu) + nLu) % nLu; // x 랩 (composeTiles 와 동일)
      invoke<string | null>("get_landuse_tile", { z: landuseZ, x: wx, y: t.ty })
        .then((base64) => {
          if (cancelled) { clearTimeout(timer); finish("retry"); return; }
          if (!base64) { clearTimeout(timer); finish("absent"); return; }       // DB에 없음 — 영구, 재시도 불필요
          if (Date.now() > deadline) { clearTimeout(timer); finish("retry"); return; } // 데드라인 만료 — 재시도
          const img = new Image();
          luImgs.push(img);
          img.onload = () => { clearTimeout(timer); if (!cancelled && !done) drawLuTile(t, img); finish("drawn"); };
          img.onerror = () => { clearTimeout(timer); finish("retry"); };
          img.src = `data:image/png;base64,${base64}`;
        })
        .catch(() => { clearTimeout(timer); finish("retry"); });
    });

    // 한 패스 — 대상 인덱스를 동시성 8 풀로 소진. drawn/absent 는 luStatus 에 확정 기록하고, retry 는
    //   pending 을 유지해 다음 패스로 넘긴다(데드라인 초과로 미착수된 인덱스도 pending 으로 남는다).
    const luStatus: ("pending" | "drawn" | "absent")[] = luTargets.map(() => "pending");
    const runPass = (indices: number[], deadline: number): Promise<void> => {
      let cursor = 0;
      const worker = async () => {
        while (!cancelled && Date.now() <= deadline) {
          const k = cursor++;
          if (k >= indices.length) return;
          const i = indices[k];
          const r = await loadOne(luTargets[i], deadline);
          if (r !== "retry") luStatus[i] = r; // 확정(drawn/absent)만 기록; retry 는 pending 유지 → 다음 패스
        }
      };
      const poolN = Math.min(8, indices.length); // 대상이 없으면 Promise.all([]) 즉시 resolve
      return Promise.all(Array.from({ length: poolN }, () => worker())).then(() => undefined);
    };
    const pendingIndices = (): number[] => {
      const out: number[] = [];
      for (let i = 0; i < luStatus.length; i++) if (luStatus[i] === "pending") out.push(i);
      return out;
    };

    // 초광역 뷰 가드 — 타일 400개 초과면 오버레이 전체 스킵. 그 외엔 첫 패스(4초) 후 미처리 타일이
    //   남으면 최대 2회 추가 패스(패스 전 1000ms 지연·패스당 fresh 6000ms 데드라인·동시성 8)로 재시도.
    //   미리보기 빌드 중 메인스레드 점유로 일부 타일이 조용히 누락된 채 확정되던 문제 방지.
    if (luTargets.length > 400) {
      console.warn(`[OM 지도] 토지이용 타일 ${luTargets.length}개(>400) — 초광역 뷰, 오버레이 스킵 (분석 대상 위치 도면)`);
      finalizeLanduse();
    } else {
      const runAllPasses = async () => {
        // 첫 패스 — 기존 4초 하드 데드라인·동시성 8·전 타일 대상 (현행 유지). 이 패스의 신규 타일은
        //   base onDone 재합성 또는 아래 추가 패스/finalizeLanduse 의 redraw 로 보이는 canvas 에 반영.
        await runPass(luTargets.map((_, i) => i), Date.now() + 4000);
        // 추가 패스 — 미처리가 남으면 최대 2회. base 확정 이후일 수 있어 base onDone 재합성에 편승할
        //   수 없으므로, 신규 타일이 그려진 패스는 종료 시 redraw() 1회(타일별 매번 redraw 는 핫패스라 금지).
        for (let pass = 0; pass < 2 && !cancelled; pass++) {
          const pending = pendingIndices();
          if (pending.length === 0) break;
          await new Promise((r) => setTimeout(r, 1000)); // 패스 전 지연 — 첫 패스 혼잡/행잉이 풀리길 대기
          if (cancelled) break;
          const before = landuseCount;
          await runPass(pending, Date.now() + 6000); // 패스당 fresh 데드라인 6000ms
          if (!cancelled && landuseCount > before) redraw();
        }
        if (!cancelled) finalizeLanduse();
      };
      runAllPasses();
    }

    return () => {
      cancelled = true;
      cancelBase(); // composeTiles 취소 — 미완료 타일 요청·재시도 타이머 중단 + 고아 Image 해제
      // 진행 중 토지이용 Image 디코드 버퍼 해제 (composeTiles 취소 패턴과 동일)
      for (const im of luImgs) { if (!im.complete) im.src = ""; }
    };
  }, [geom]);

  return (
    <>
      <div className="flex items-center justify-between block-h3">
        <OMEditable id="summary.map.title" value="분석 대상 위치 도면" tag="span" />
        <span className="text-[10px] text-gray-400" style={{ fontWeight: 400 }}>분석 대상 {buildings.length}개</span>
      </div>
      {/* 16:9 도면 — 페이지 콘텐츠 폭 전체 */}
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        data-map-canvas="1"
        data-map-ready="false"
        data-map-complete="false"
        style={{ width: "100%", height: "auto", display: "block", border: "1px solid #e5e7eb", borderRadius: 4 }}
      />
      <div className="mt-1 text-[10px] text-gray-500">
        <OMEditable id="summary.map.legend" value="파란 원 = 레이더 · 번호 칩 = 분석 대상 건물 (표의 번호와 동일)" tag="span" />
        {/* 토지이용 타일이 1장이라도 실렸을 때만 정적 안내 덧붙임 — 기존 legend OMEditable 의
            textOverrides 영속값과 충돌하지 않게 별도 <span>(비편집)으로 분리. */}
        {landuseShown && <span> · 색상 배경 = 토지이용계획도(VWorld)</span>}
      </div>
    </>
  );
}

// ── canvas 그리기 헬퍼 ──

/** 건물 centroid 번호 칩 — 그룹색 배경 원(반지름 20) + 흰 외곽선 + 흰 bold 번호. 표 행 번호와 대조. */
function drawNumberChip(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string) {
  ctx.beginPath();
  ctx.arc(x, y, 20, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  ctx.font = "bold 26px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  ctx.fillText(text, x, y + 1);
}

/** 레이더명 라벨 칩 — 마커 우측에 흰 반투명 배경 + 텍스트. 캔버스 경계 안으로 클램프. */
function drawRadarLabel(ctx: CanvasRenderingContext2D, x: number, y: number, name: string) {
  ctx.font = "bold 20px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const tw = ctx.measureText(name).width;
  const padX = 7, boxH = 28;
  const boxW = tw + padX * 2;
  // 마커 우측 16px 에 배치 → 오른쪽 넘치면 마커 좌측으로 반전
  let bx = x + 16;
  if (bx + boxW > W - 4) bx = x - 16 - boxW;
  bx = Math.max(2, Math.min(W - boxW - 2, bx));
  const by = Math.max(2, Math.min(H - boxH - 2, y - boxH / 2));
  roundRect(ctx, bx, by, boxW, boxH, 5);
  ctx.fillStyle = "rgba(255,255,255,0.82)";
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#1d4ed8";
  ctx.stroke();
  ctx.fillStyle = "#1e3a8a";
  ctx.fillText(name, bx + padX, by + boxH / 2 + 0.5);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
