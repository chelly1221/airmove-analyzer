import { Fragment, useState } from "react";
import type { DecodedFrame } from "../../utils/asterixDecoder";

/** 해석 값 렌더 — "\n" 포함 시 줄바꿈, 없으면 단일 텍스트, null 이면 대시 */
function renderValue(v?: string) {
  if (v == null || v === "") return <span className="text-gray-300">—</span>;
  if (!v.includes("\n")) return v;
  return v.split("\n").map((line, i) => <div key={i}>{line}</div>);
}

/**
 * ASTERIX 프레임 전문 인스펙터 — ACAS 전문보기 / ASTERIX 분석 공용.
 * 좌: 디코드 해석 트리(항목 hover), 우: RAW HEX(해당 바이트 크로스 하이라이트).
 */

export type ByteRange = { start: number; len: number } | null;

export const CAT_LABEL: Record<number, string> = {
  0x30: "CAT048 표적보고",
  0x22: "CAT034 서비스",
  0x08: "CAT008 기상",
};

/**
 * 디코드 트리를 특정 레코드 하나로 좁히기 위한 식별자.
 * 한 NEC 프레임에 여러 표적보고(레코드)가 섞여 있을 때, ACAS 전문보기에서
 * 해당 RA 레코드만 해석 트리에 노출하는 용도. (RAW HEX는 프레임 전체 유지)
 */
export interface FrameFocus {
  /** 1순위 매칭: I048/260(ACAS RA 보고) 7바이트 hex — 공백/대소문자 무관 */
  i260Hex?: string;
  /** 2순위 매칭: I048/220(항공기 주소, Mode-S) hex */
  modeSHex?: string;
}

const normHex = (s: string) => s.replace(/[^0-9a-fA-F]/g, "").toLowerCase();

/** focus에 해당하는 (블록, 레코드) 인덱스 탐색 — 못 찾으면 null(전체 표시 폴백) */
function findFocusedRecord(frame: DecodedFrame, focus?: FrameFocus): { bi: number; ri: number } | null {
  if (!focus) return null;
  const i260 = focus.i260Hex ? normHex(focus.i260Hex) : "";
  const modeS = focus.modeSHex && focus.modeSHex !== "NO_MODES" ? normHex(focus.modeSHex) : "";
  const scan = (itemId: string, target: string) => {
    for (let bi = 0; bi < frame.blocks.length; bi++) {
      const recs = frame.blocks[bi].records;
      for (let ri = 0; ri < recs.length; ri++) {
        if (recs[ri].items.some((it) => it.id === itemId && normHex(it.rawHex) === target)) return { bi, ri };
      }
    }
    return null;
  };
  // I260 직접 매칭(소스 0) → 실패 시 Mode-S 매칭(BDS 소스 1/2)
  return (i260 && scan("I048/260", i260)) || (modeS && scan("I048/220", modeS)) || null;
}

/** 프레임 디코드 결과 트리 — 항목 hover 시 onHover로 바이트 범위 통지 */
export function FrameDecodeTree({
  frame,
  hover,
  onHover,
  focus,
}: {
  frame: DecodedFrame;
  hover: ByteRange;
  onHover: (r: ByteRange) => void;
  /** 지정 시 해당 레코드 1건만 해석 트리에 노출 (RAW HEX는 호출부에서 프레임 전체 유지) */
  focus?: FrameFocus;
}) {
  const isActive = (start: number, len: number) => hover != null && hover.start === start && hover.len === len;
  const rowCls = (start: number, len: number) =>
    `cursor-default align-top ${isActive(start, len) ? "bg-[#a60739]/10" : "hover:bg-gray-50"}`;
  const focusReq = !!(focus && (focus.i260Hex || (focus.modeSHex && focus.modeSHex !== "NO_MODES")));
  const focused = focusReq ? findFocusedRecord(frame, focus) : null;
  const totalRecords = frame.blocks.reduce((n, b) => n + b.records.length, 0);
  return (
    <div className="space-y-2 text-[10.5px]">
      {focused && totalRecords > 1 && (
        <div className="rounded bg-[#a60739]/8 px-2 py-1 text-[9.5px] text-[#a60739]">
          이 프레임의 표적보고 {totalRecords}건 중 해당 ACAS 레코드만 표시 · RAW HEX는 프레임 전체
        </div>
      )}
      {focusReq && !focused && (
        <div className="rounded bg-amber-50 px-2 py-1 text-[9.5px] text-amber-600">
          ※ 해당 ACAS 레코드를 프레임에서 식별하지 못해 전체를 표시합니다
        </div>
      )}
      {frame.necHeader && (
        <div
          className={`flex items-baseline gap-2 rounded px-1 ${isActive(frame.necHeader.start, frame.necHeader.len) ? "bg-[#a60739]/10" : "hover:bg-gray-50"}`}
          onMouseEnter={() => onHover({ start: frame.necHeader!.start, len: frame.necHeader!.len })}
          onMouseLeave={() => onHover(null)}
        >
          <span className="rounded bg-[#a60739]/10 px-1.5 py-0.5 font-medium text-[#a60739]">NEC 헤더</span>
          <span className="text-gray-800">{frame.necHeader.text}</span>
          <span className="font-mono text-gray-400">{frame.necHeader.rawHex}</span>
        </div>
      )}
      {frame.blocks.length === 0 && <div className="text-gray-400">디코드된 블록 없음</div>}
      {frame.blocks.map((blk, bi) => focused && bi !== focused.bi ? null : (
        <div key={bi} className="rounded border border-gray-100">
          <div
            className={`flex items-baseline justify-between px-2 py-1 ${isActive(blk.start, 3) ? "bg-[#a60739]/10" : "bg-gray-50 hover:bg-gray-100"}`}
            onMouseEnter={() => onHover({ start: blk.start, len: 3 })}
            onMouseLeave={() => onHover(null)}
          >
            <span className="font-medium text-gray-700">
              {CAT_LABEL[blk.cat] ?? `CAT${blk.cat.toString(16)}`}
              <span className="ml-1 font-mono text-[9px] uppercase tracking-wider text-gray-400">CAT+LEN</span>
            </span>
            <span className="text-gray-400">len {blk.len} · rec {blk.records.length}</span>
          </div>
          <div className="divide-y divide-gray-50">
            {blk.records.map((rec, ri) => focused && ri !== focused.ri ? null : (
              <div key={ri} className="px-2 py-1">
                {blk.records.length > 1 && <div className="mb-0.5 text-[9.5px] uppercase tracking-wider text-gray-400">레코드 {ri + 1}</div>}
                <table className="w-full">
                  <tbody>
                    {rec.fspec && (
                      <tr
                        className={rowCls(rec.fspec.start, rec.fspec.len)}
                        onMouseEnter={() => onHover({ start: rec.fspec!.start, len: rec.fspec!.len })}
                        onMouseLeave={() => onHover(null)}
                      >
                        <td className="whitespace-nowrap py-0.5 pr-2 font-mono text-gray-500">FSPEC</td>
                        <td className="whitespace-nowrap py-0.5 pr-2 text-gray-600">필드 명세</td>
                        <td className="py-0.5 pr-2 text-gray-400">{rec.items.length}개 항목</td>
                        <td className="py-0.5 font-mono text-[9.5px] text-gray-400 break-all">{rec.fspec.rawHex}</td>
                      </tr>
                    )}
                    {rec.items.map((it, ii) => (
                      <Fragment key={ii}>
                        <tr
                          className={rowCls(it.start, it.len)}
                          onMouseEnter={() => onHover({ start: it.start, len: it.len })}
                          onMouseLeave={() => onHover(null)}
                        >
                          <td className="whitespace-nowrap py-0.5 pr-2 font-mono text-gray-500">{it.id}</td>
                          <td className="whitespace-nowrap py-0.5 pr-2 text-gray-600">{it.name}</td>
                          <td className="py-0.5 pr-2 text-gray-900">{renderValue(it.value)}</td>
                          <td className="py-0.5 font-mono text-[9.5px] text-gray-400 break-all">{it.rawHex}</td>
                        </tr>
                        {it.children?.map((ch, ci) => (
                          <tr
                            key={`${ii}-${ci}`}
                            className={rowCls(ch.start, ch.len)}
                            onMouseEnter={() => onHover({ start: ch.start, len: ch.len })}
                            onMouseLeave={() => onHover(null)}
                          >
                            <td className="whitespace-nowrap py-0.5 pl-2 pr-2 font-mono text-[#a60739]/70">└ {ch.id}</td>
                            <td className="whitespace-nowrap py-0.5 pr-2 text-gray-500">{ch.name}</td>
                            <td className="py-0.5 pr-2 text-gray-700">{renderValue(ch.value)}</td>
                            <td className="py-0.5 font-mono text-[9.5px] text-gray-400 break-all">{ch.rawHex}</td>
                          </tr>
                        ))}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
                {rec.note && <div className="mt-0.5 text-[9.5px] text-amber-600">※ {rec.note}</div>}
              </div>
            ))}
          </div>
          {blk.note && <div className="px-2 py-1 text-[9.5px] text-amber-600">※ {blk.note}</div>}
        </div>
      ))}
      {!focused && frame.trailingRawHex && (
        <div className="text-gray-400">
          <span className="text-[9.5px] uppercase tracking-wider">잔여 </span>
          <span className="font-mono">{frame.trailingRawHex}</span>
        </div>
      )}
      {!focused && frame.note && <div className="text-[9.5px] text-amber-600">※ {frame.note}</div>}
    </div>
  );
}

/** 프레임 전문 인스펙터 — 좌: 해석(항목별 hover), 우: RAW HEX(해당 바이트 하이라이트) */
export function FrameInspector({ frameBytes, decoded, focus }: { frameBytes: number[]; decoded: DecodedFrame; focus?: FrameFocus }) {
  const [hover, setHover] = useState<ByteRange>(null);
  const hiEnd = hover ? hover.start + hover.len : -1;
  return (
    <div className="flex min-h-0 flex-1 gap-2">
      {/* 좌: 해석 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-gray-400">해석 (항목에 마우스를 올리면 우측 RAW가 강조됩니다)</div>
        <div className="flex-1 overflow-auto rounded border border-gray-200 bg-white px-2 py-1.5">
          <FrameDecodeTree frame={decoded} hover={hover} onHover={setHover} focus={focus} />
        </div>
      </div>
      {/* 우: RAW HEX — 오프셋 컬럼 + 16바이트/행 (8바이트마다 간격) */}
      <div className="flex w-[40%] min-w-0 flex-col">
        <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-gray-400">RAW HEX</div>
        <div className="flex-1 overflow-auto rounded border border-gray-200 bg-gray-50 px-2 py-1.5 font-mono text-[10.5px] leading-relaxed">
          {Array.from({ length: Math.ceil(frameBytes.length / 16) }, (_, row) => {
            const base = row * 16;
            return (
              <div key={row} className="whitespace-pre">
                <span className="select-none text-gray-300">{base.toString(16).padStart(4, "0")}</span>
                {"  "}
                {Array.from({ length: 16 }, (_, j) => {
                  const i = base + j;
                  if (i >= frameBytes.length) return null;
                  const hi = hover != null && i >= hover.start && i < hiEnd;
                  const sep = j === 0 ? "" : j === 8 ? "  " : " ";
                  return (
                    <span key={j} className={hi ? "bg-[#a60739] text-white" : "text-gray-700"}>
                      {sep}{frameBytes[i].toString(16).padStart(2, "0")}
                    </span>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
