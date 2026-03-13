import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
  Upload,
  FileUp,
  Trash2,
  Play,
  CheckCircle2,
  XCircle,
  Loader2,
  FolderOpen,
  AlertCircle,
  Radio,
  Plus,
  Pencil,
  X,
  MapPin,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import maplibregl from "maplibre-gl";
import { useAppStore } from "../store";
import type { AnalysisResult, RadarSite, UploadedFile } from "../types";

/** 기본 레이더 사이트 */
const DEFAULT_RADAR_SITE: RadarSite = {
  name: "김포", latitude: 37.5585, longitude: 126.7906, altitude: 18, antenna_height: 30, range_nm: 60,
};

/** 레이더 사이트 편집 폼 */
function RadarSiteEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial?: RadarSite;
  onSave: (site: RadarSite) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [lat, setLat] = useState(initial?.latitude.toString() ?? "");
  const [lon, setLon] = useState(initial?.longitude.toString() ?? "");
  const [alt, setAlt] = useState(initial?.altitude.toString() ?? "0");
  const [antH, setAntH] = useState(initial?.antenna_height.toString() ?? "25");
  const [rangeNm, setRangeNm] = useState(initial?.range_nm?.toString() ?? "60");
  const [pickMode, setPickMode] = useState(false);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);

  // 미니맵 초기화
  useEffect(() => {
    if (!pickMode || !mapContainerRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
      center: [
        parseFloat(lon) || 127.0,
        parseFloat(lat) || 36.5,
      ],
      zoom: 6,
    });

    // 기존 좌표에 마커 표시
    const initLat = parseFloat(lat);
    const initLon = parseFloat(lon);
    if (!isNaN(initLat) && !isNaN(initLon)) {
      markerRef.current = new maplibregl.Marker({ color: "#e94560" })
        .setLngLat([initLon, initLat])
        .addTo(map);
    }

    map.on("click", (e) => {
      const { lng, lat: clickLat } = e.lngLat;
      setLat(clickLat.toFixed(4));
      setLon(lng.toFixed(4));

      if (markerRef.current) {
        markerRef.current.setLngLat([lng, clickLat]);
      } else {
        markerRef.current = new maplibregl.Marker({ color: "#e94560" })
          .setLngLat([lng, clickLat])
          .addTo(map);
      }
    });

    mapRef.current = map;
    return () => {
      markerRef.current = null;
      map.remove();
    };
  }, [pickMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = () => {
    const latitude = parseFloat(lat);
    const longitude = parseFloat(lon);
    const altitude = parseFloat(alt) || 0;
    const antenna_height = parseFloat(antH) || 25;
    const range_nm = parseFloat(rangeNm) || 60;
    if (!name.trim() || isNaN(latitude) || isNaN(longitude)) return;
    onSave({ name: name.trim(), latitude, longitude, altitude, antenna_height, range_nm });
  };

  return (
    <div className="rounded-xl border border-white/10 bg-[#0d1b2a] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">
          {initial ? "레이더 사이트 수정" : "새 레이더 사이트 등록"}
        </h3>
        <button onClick={onCancel} className="text-gray-400 hover:text-white">
          <X size={16} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="block text-xs text-gray-400 mb-1">사이트 이름</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="예: 서울레이더"
            className="w-full rounded-lg border border-white/10 bg-[#16213e] px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-[#e94560] focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">위도 (°N)</label>
          <input
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            placeholder="37.5585"
            type="number"
            step="0.0001"
            className="w-full rounded-lg border border-white/10 bg-[#16213e] px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-[#e94560] focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">경도 (°E)</label>
          <input
            value={lon}
            onChange={(e) => setLon(e.target.value)}
            placeholder="126.7906"
            type="number"
            step="0.0001"
            className="w-full rounded-lg border border-white/10 bg-[#16213e] px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-[#e94560] focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">해발 고도 (m)</label>
          <input
            value={alt}
            onChange={(e) => setAlt(e.target.value)}
            placeholder="0"
            type="number"
            className="w-full rounded-lg border border-white/10 bg-[#16213e] px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-[#e94560] focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">안테나 높이 (m)</label>
          <input
            value={antH}
            onChange={(e) => setAntH(e.target.value)}
            placeholder="25"
            type="number"
            className="w-full rounded-lg border border-white/10 bg-[#16213e] px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-[#e94560] focus:outline-none"
          />
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-gray-400 mb-1">제원상 지원범위 (NM)</label>
          <input
            value={rangeNm}
            onChange={(e) => setRangeNm(e.target.value)}
            placeholder="60"
            type="number"
            step="1"
            className="w-full rounded-lg border border-white/10 bg-[#16213e] px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-[#e94560] focus:outline-none"
          />
        </div>
      </div>

      {/* 지도에서 좌표 선택 */}
      <button
        onClick={() => setPickMode(!pickMode)}
        className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
          pickMode
            ? "bg-[#e94560] text-white"
            : "border border-white/10 text-gray-400 hover:border-white/30 hover:text-white"
        }`}
      >
        <MapPin size={14} />
        {pickMode ? "지도 닫기" : "지도에서 클릭하여 좌표 선택"}
      </button>

      {pickMode && (
        <div
          ref={mapContainerRef}
          className="h-64 w-full rounded-lg overflow-hidden border border-white/10"
        />
      )}

      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-lg border border-white/10 px-4 py-2 text-sm text-gray-400 hover:bg-white/5"
        >
          취소
        </button>
        <button
          onClick={handleSave}
          disabled={!name.trim() || !lat || !lon}
          className="rounded-lg bg-[#e94560] px-4 py-2 text-sm font-medium text-white hover:bg-[#d63851] disabled:opacity-40"
        >
          {initial ? "수정" : "등록"}
        </button>
      </div>
    </div>
  );
}

export default function FileUpload() {
  const uploadedFiles = useAppStore((s) => s.uploadedFiles);
  const addUploadedFile = useAppStore((s) => s.addUploadedFile);
  const updateUploadedFile = useAppStore((s) => s.updateUploadedFile);
  const removeUploadedFile = useAppStore((s) => s.removeUploadedFile);
  const clearUploadedFiles = useAppStore((s) => s.clearUploadedFiles);
  const addAnalysisResult = useAppStore((s) => s.addAnalysisResult);
  const radarSite = useAppStore((s) => s.radarSite);
  const setRadarSite = useAppStore((s) => s.setRadarSite);
  const customRadarSites = useAppStore((s) => s.customRadarSites);
  const addCustomRadarSite = useAppStore((s) => s.addCustomRadarSite);
  const updateCustomRadarSite = useAppStore((s) => s.updateCustomRadarSite);
  const removeCustomRadarSite = useAppStore((s) => s.removeCustomRadarSite);
  const setLoading = useAppStore((s) => s.setLoading);
  const setLoadingMessage = useAppStore((s) => s.setLoadingMessage);

  const [dragOver, setDragOver] = useState(false);
  const [errorLog, setErrorLog] = useState<string[]>([]);
  const [showEditor, setShowEditor] = useState(false);
  const [editingSite, setEditingSite] = useState<RadarSite | undefined>();

  /** 파싱 진행률 상태 { filename -> { percent, records, trackPoints, errors } } */
  const [parseProgress, setParseProgress] = useState<
    Record<string, { percent: number; records: number; trackPoints: number; errors: number }>
  >({});

  // 파싱 진행률 이벤트 리스너
  useEffect(() => {
    const unlisten = listen<{
      filename: string;
      percent: number;
      records: number;
      track_points: number;
      errors: number;
    }>("parse-progress", (event) => {
      const p = event.payload;
      setParseProgress((prev) => ({
        ...prev,
        [p.filename]: {
          percent: p.percent,
          records: p.records,
          trackPoints: p.track_points,
          errors: p.errors,
        },
      }));
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const handleFilePick = async () => {
    try {
      const result = await open({
        multiple: true,
        filters: [
          { name: "ASS Files", extensions: ["ass", "ASS"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });
      if (result) {
        const paths = Array.isArray(result) ? result : [result];
        for (const filePath of paths) {
          if (typeof filePath === "string") {
            const name = filePath.split(/[/\\]/).pop() ?? filePath;
            if (!uploadedFiles.find((f) => f.path === filePath)) {
              addUploadedFile({
                path: filePath,
                name,
                status: "pending",
              });
            }
          }
        }
      }
    } catch (err) {
      setErrorLog((prev) => [
        ...prev,
        `파일 선택 오류: ${err instanceof Error ? err.message : String(err)}`,
      ]);
    }
  };

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      setErrorLog((prev) => [
        ...prev,
        "드래그 앤 드롭은 Tauri 환경에서 제한될 수 있습니다. 파일 선택 버튼을 사용하세요.",
      ]);
    },
    []
  );

  const parseFile = async (file: UploadedFile) => {
    updateUploadedFile(file.path, { status: "parsing" });
    setLoading(false);
    setLoadingMessage("");
    try {
      const result: AnalysisResult = await invoke("parse_and_analyze", {
        filePath: file.path,
        radarLat: radarSite.latitude,
        radarLon: radarSite.longitude,
      });
      updateUploadedFile(file.path, {
        status: "done",
        parsedFile: result.file_info,
      });
      addAnalysisResult(result);

      if (result.file_info.parse_errors.length > 0) {
        setErrorLog((prev) => [
          ...prev,
          ...result.file_info.parse_errors.map(
            (e) => `[${file.name}] ${e}`
          ),
        ]);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      updateUploadedFile(file.path, {
        status: "error",
        error: errMsg,
      });
      setErrorLog((prev) => [...prev, `[${file.name}] 파싱 오류: ${errMsg}`]);
    } finally {
      setLoading(false);
      setLoadingMessage("");
      // 진행률 정리
      setParseProgress((prev) => {
        const next = { ...prev };
        delete next[file.name];
        return next;
      });
    }
  };

  const parseAll = async () => {
    const pending = uploadedFiles.filter((f) => f.status === "pending");
    for (const file of pending) {
      await parseFile(file);
    }
  };

  const handleSaveCustomSite = (site: RadarSite) => {
    if (editingSite) {
      updateCustomRadarSite(editingSite.name, site);
      if (radarSite.name === editingSite.name) {
        setRadarSite(site);
      }
    } else {
      addCustomRadarSite(site);
    }
    setRadarSite(site);
    setShowEditor(false);
    setEditingSite(undefined);
  };

  const handleEditSite = (site: RadarSite) => {
    // 프리셋이 아직 커스텀에 없으면 먼저 추가
    if (!customRadarSites.some((s) => s.name === site.name)) {
      addCustomRadarSite(site);
    }
    setEditingSite(site);
    setShowEditor(true);
  };

  const handleDeleteSite = (site: RadarSite) => {
    removeCustomRadarSite(site.name);
    if (radarSite.name === site.name) {
      setRadarSite(DEFAULT_RADAR_SITE);
    }
  };

  const pendingCount = uploadedFiles.filter(
    (f) => f.status === "pending"
  ).length;
  const parsingCount = uploadedFiles.filter(
    (f) => f.status === "parsing"
  ).length;

  const statusIcon = (status: UploadedFile["status"]) => {
    switch (status) {
      case "pending":
        return <FileUp size={16} className="text-gray-400" />;
      case "parsing":
        return <Loader2 size={16} className="animate-spin text-blue-400" />;
      case "done":
        return <CheckCircle2 size={16} className="text-green-400" />;
      case "error":
        return <XCircle size={16} className="text-red-400" />;
    }
  };

  const statusText = (file: UploadedFile) => {
    switch (file.status) {
      case "pending":
        return "대기 중";
      case "parsing":
        return "파싱 중...";
      case "done":
        return `완료 (${file.parsedFile?.total_records ?? 0} 레코드)`;
      case "error":
        return file.error ?? "오류";
    }
  };

  // 김포 기본값 + 커스텀 사이트 (커스텀에 김포가 있으면 그걸 사용)
  const allSites = useMemo(() => {
    const hasDefault = customRadarSites.some((s) => s.name === DEFAULT_RADAR_SITE.name);
    if (hasDefault) return customRadarSites;
    return [DEFAULT_RADAR_SITE, ...customRadarSites];
  }, [customRadarSites]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">자료 업로드</h1>
        <p className="mt-1 text-sm text-gray-400">
          NEC ASS 파일을 업로드하여 파싱합니다
        </p>
      </div>

      {/* Radar Site Selector */}
      <div className="rounded-xl border border-white/10 bg-[#16213e] p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Radio size={16} className="text-[#e94560]" />
            <h2 className="text-sm font-semibold text-white">레이더 사이트</h2>
            <span className="text-xs text-gray-500">
              {radarSite.name} ({radarSite.latitude.toFixed(4)}°N, {radarSite.longitude.toFixed(4)}°E
              {radarSite.altitude > 0 ? `, ${radarSite.altitude}m` : ""})
            </span>
          </div>
          <button
            onClick={() => {
              setEditingSite(undefined);
              setShowEditor(!showEditor);
            }}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-gray-400 hover:border-white/30 hover:text-white transition-colors"
          >
            <Plus size={14} />
            직접 등록
          </button>
        </div>

        {/* 프리셋 + 커스텀 사이트 버튼 */}
        <div className="flex flex-wrap gap-2">
          {allSites.map((site) => (
            <div key={site.name} className="relative group">
              <button
                onClick={() => setRadarSite(site)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  radarSite.name === site.name
                    ? "bg-[#e94560] text-white"
                    : "border border-white/10 text-gray-400 hover:border-white/30 hover:text-white"
                }`}
              >
                {site.name}
              </button>
              {/* 수정/삭제 버튼 */}
              <div className="absolute -top-1 -right-1 hidden group-hover:flex gap-0.5">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleEditSite(site);
                  }}
                  className="rounded-full bg-blue-500 p-0.5 text-white hover:bg-blue-400"
                  title="수정"
                >
                  <Pencil size={10} />
                </button>
                {allSites.length > 1 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteSite(site);
                    }}
                    className="rounded-full bg-red-500 p-0.5 text-white hover:bg-red-400"
                    title="삭제"
                  >
                    <X size={10} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* 사이트 편집 폼 */}
        {showEditor && (
          <div className="mt-3">
            <RadarSiteEditor
              initial={editingSite}
              onSave={handleSaveCustomSite}
              onCancel={() => {
                setShowEditor(false);
                setEditingSite(undefined);
              }}
            />
          </div>
        )}
      </div>

      {/* Drop Zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={handleFilePick}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-16 transition-all ${
          dragOver
            ? "border-[#e94560] bg-[#e94560]/10"
            : "border-white/20 bg-[#16213e]/50 hover:border-white/40 hover:bg-[#16213e]"
        }`}
      >
        <div
          className={`mb-4 flex h-16 w-16 items-center justify-center rounded-full ${dragOver ? "bg-[#e94560]/20" : "bg-[#0f3460]/50"}`}
        >
          <Upload
            size={28}
            className={dragOver ? "text-[#e94560]" : "text-gray-400"}
          />
        </div>
        <p className="text-sm font-medium text-gray-300">
          클릭하여 NEC ASS 파일 선택
        </p>
        <p className="mt-1 text-xs text-gray-500">
          또는 파일을 이 영역에 드래그 앤 드롭
        </p>
      </div>

      {/* File List */}
      {uploadedFiles.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-white">
              업로드 파일 ({uploadedFiles.length}개)
            </h2>
            <div className="flex items-center gap-2">
              {pendingCount > 0 && (
                <button
                  onClick={parseAll}
                  disabled={parsingCount > 0}
                  className="flex items-center gap-2 rounded-lg bg-[#e94560] px-3 py-2 text-sm font-medium text-white hover:bg-[#d63851] disabled:opacity-50 transition-colors"
                >
                  <Play size={14} />
                  <span>전체 파싱 ({pendingCount}건)</span>
                </button>
              )}
              <button
                onClick={clearUploadedFiles}
                className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-400 hover:bg-white/5 transition-colors"
              >
                <Trash2 size={14} />
                <span>전체 삭제</span>
              </button>
            </div>
          </div>

          <div className="divide-y divide-white/5 overflow-hidden rounded-xl border border-white/10 bg-[#16213e]">
            {uploadedFiles.map((file) => {
              const prog = parseProgress[file.name];
              const isParsing = file.status === "parsing";
              return (
                <div key={file.path} className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    {statusIcon(file.status)}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <FolderOpen size={12} className="text-gray-500 shrink-0" />
                        <p className="truncate text-sm text-white">{file.name}</p>
                      </div>
                      <p className="text-xs text-gray-500 truncate">{file.path}</p>
                    </div>
                    <span
                      className={`shrink-0 text-xs ${
                        file.status === "done"
                          ? "text-green-400"
                          : file.status === "error"
                            ? "text-red-400"
                            : isParsing
                              ? "text-blue-400"
                              : "text-gray-500"
                      }`}
                    >
                      {isParsing && prog
                        ? `파싱 중... ${prog.percent.toFixed(0)}%`
                        : statusText(file)}
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                      {file.status === "pending" && (
                        <button
                          onClick={() => parseFile(file)}
                          className="rounded p-1.5 text-gray-400 hover:bg-white/10 hover:text-white transition-colors"
                          title="파싱"
                        >
                          <Play size={14} />
                        </button>
                      )}
                      <button
                        onClick={() => removeUploadedFile(file.path)}
                        className="rounded p-1.5 text-gray-400 hover:bg-red-500/20 hover:text-red-400 transition-colors"
                        title="제거"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  {/* 프로그레스 바 */}
                  {isParsing && prog && (
                    <div className="mt-2 space-y-1">
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                        <div
                          className="h-full rounded-full bg-blue-500 transition-all duration-200"
                          style={{ width: `${prog.percent}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-gray-500">
                        <span>레코드: {prog.records.toLocaleString()}</span>
                        <span>항적포인트: {prog.trackPoints.toLocaleString()}</span>
                        {prog.errors > 0 && (
                          <span className="text-yellow-500">오류: {prog.errors}</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Error Log */}
      {errorLog.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-base font-semibold text-white">
              <AlertCircle size={16} className="text-yellow-400" />
              오류 로그
            </h2>
            <button
              onClick={() => setErrorLog([])}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              로그 삭제
            </button>
          </div>
          <div className="max-h-48 overflow-auto rounded-xl border border-white/10 bg-[#0d1b2a] p-4">
            {errorLog.map((msg, idx) => (
              <p
                key={`err-${idx}`}
                className="font-mono text-xs text-yellow-400/80 leading-relaxed"
              >
                {msg}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
