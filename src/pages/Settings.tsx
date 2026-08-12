import { useState, useEffect, useRef } from "react";
import {
  Check,
  Database,
  Download,
  Upload,
  AlertTriangle,
  Mountain,
  Building2,
  ExternalLink,
  Loader2,
  Globe,
  Eye,
  EyeOff,
  Save,
  KeyRound,
  ChevronDown,
  Boxes,
  Trash2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import Modal from "../components/common/Modal";
import { useAppStore } from "../store";
import type { PeakImportStatus } from "../types";

// ─── DB 내보내기/가져오기 섹션 ────────────────────────────────────────

/** 백업 전송 진행 이벤트 페이로드 — unit 으로 바이트/파일 수 표기를 분기 */
type DbTransferProgress = { phase: string; unit: "bytes" | "files"; current: number; total: number };

/** 바이트 → MB/GB 표기 (Rust format_backup_size 와 동일 규칙) */
const formatBackupBytes = (bytes: number) => {
  const MB = 1024 * 1024;
  const GB = MB * 1024;
  return bytes >= GB ? `${(bytes / GB).toFixed(1)}GB` : `${(bytes / MB).toFixed(1)}MB`;
};

export function DatabaseSection() {
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [confirmImport, setConfirmImport] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<DbTransferProgress | null>(null);

  const handleExport = async () => {
    let unlisten: (() => void) | null = null;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const dest = await save({
        title: "데이터베이스 내보내기",
        defaultPath: `airmove-backup-${new Date().toISOString().slice(0, 10)}.zip`,
        filters: [{ name: "AirMove 백업", extensions: ["zip"] }],
      });
      if (!dest) return;

      setExporting(true);
      setStatus(null);
      setTransfer(null);
      try {
        unlisten = await listen<DbTransferProgress>("db-transfer-progress", (e) => setTransfer(e.payload));
      } catch { /* 리스너 실패 시 진행률 없이 진행 */ }

      const msg = await invoke<string>("export_database", { destPath: dest });
      setStatus({ type: "success", message: msg });
    } catch (e) {
      setStatus({ type: "error", message: `내보내기 실패: ${e}` });
    } finally {
      if (unlisten) unlisten();
      setExporting(false);
      setTransfer(null);
    }
  };

  const handleImportClick = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const src = await open({
        title: "데이터베이스 가져오기",
        filters: [{ name: "AirMove 백업", extensions: ["zip", "db"] }],
        multiple: false,
        directory: false,
      });
      if (!src) return;
      const path = typeof src === "string" ? src : src;
      setConfirmImport(path as string);
    } catch (e) {
      setStatus({ type: "error", message: `파일 선택 실패: ${e}` });
    }
  };

  const handleImportConfirm = async () => {
    if (!confirmImport) return;
    let unlisten: (() => void) | null = null;
    try {
      setImporting(true);
      setStatus(null);
      setTransfer(null);
      setConfirmImport(null);
      try {
        unlisten = await listen<DbTransferProgress>("db-transfer-progress", (e) => setTransfer(e.payload));
      } catch { /* 리스너 실패 시 진행률 없이 진행 */ }

      const msg = await invoke<string>("import_database", { srcPath: confirmImport });
      setStatus({ type: "success", message: `${msg} 페이지를 새로고침합니다...` });
      // 상태 반영을 위해 앱 새로고침
      setTimeout(() => window.location.reload(), 1500);
    } catch (e) {
      setStatus({ type: "error", message: `가져오기 실패: ${e}` });
    } finally {
      if (unlisten) unlisten();
      setImporting(false);
      setTransfer(null);
    }
  };

  const transferPct = transfer && transfer.total > 0
    ? Math.min(100, Math.round((transfer.current / transfer.total) * 100))
    : 0;

  return (
    <div data-tour="settings-db-section" className="space-y-4">
      <div className="flex items-center gap-2">
        <Database size={16} className="text-[#a60739]" />
        <h2 className="text-lg font-semibold text-gray-800">데이터베이스 관리</h2>
      </div>
      <p className="text-xs text-gray-500">
        운항이력, ADS-B 항적, 파싱 데이터 등 모든 저장 데이터를 내보내거나 가져올 수 있습니다.
        실측 3D 타일 폴더가 등록되어 있으면 백업(ZIP)에 타일 파일까지 함께 포함됩니다.
      </p>

      <div className="flex gap-3">
        <button
          data-tour="settings-db-export"
          onClick={handleExport}
          disabled={exporting || importing}
          className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-gray-400 hover:text-gray-900 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Download size={14} />
          {exporting ? "내보내는 중..." : "DB 내보내기"}
        </button>
        <button
          data-tour="settings-db-import"
          onClick={handleImportClick}
          disabled={exporting || importing}
          className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-gray-400 hover:text-gray-900 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Upload size={14} />
          {importing ? "가져오는 중..." : "DB 가져오기"}
        </button>
      </div>

      {/* 내보내기/가져오기 진행률 */}
      {(exporting || importing) && (
        <div className="space-y-1">
          {transfer && transfer.total > 0 && (
            <div className="h-1.5 w-full rounded-full bg-gray-200 overflow-hidden">
              <div className="h-full rounded-full bg-[#a60739] transition-all duration-300" style={{ width: `${transferPct}%` }} />
            </div>
          )}
          <p className="text-xs text-gray-500">
            {transfer
              ? transfer.unit === "bytes"
                ? `${transfer.phase} ${formatBackupBytes(transfer.current)} / ${formatBackupBytes(transfer.total)}`
                : `${transfer.phase} ${transfer.current.toLocaleString()} / ${transfer.total.toLocaleString()}`
              : exporting ? "백업 파일 준비 중..." : "백업 파일 확인 중..."}
          </p>
        </div>
      )}

      {status && (
        <div className={`rounded-lg px-4 py-3 text-sm ${
          status.type === "success"
            ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
            : "bg-red-50 text-red-700 border border-red-200"
        }`}>
          {status.message}
        </div>
      )}

      {/* 가져오기 확인 모달 */}
      <Modal
        open={confirmImport !== null}
        onClose={() => setConfirmImport(null)}
        title="데이터베이스 가져오기"
        width="max-w-sm"
      >
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg bg-amber-50 border border-amber-200 p-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-600" />
            <p className="text-sm text-amber-800">
              현재 저장된 모든 데이터(운항이력, ADS-B 항적, 파싱 데이터, 설정)가 선택한 파일의 데이터로 교체됩니다. 이 작업은 되돌릴 수 없습니다.
              ZIP 백업에 실측 3D 타일이 포함되어 있으면 타일 폴더도 함께 복원되어 새 경로로 재등록됩니다.
            </p>
          </div>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setConfirmImport(null)}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 transition-colors"
            >
              취소
            </button>
            <button
              onClick={handleImportConfirm}
              className="rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white hover:bg-[#85062e] transition-colors"
            >
              가져오기
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ─── 고도 데이터 사전 적재 ────────────────────────────────────────────────

export function SrtmDownloadSection() {
  const [srtmStatus, setSrtmStatus] = useState<[number, number] | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  const loading = useAppStore((s) => s.srtmDownloading);
  const progress = useAppStore((s) => s.srtmProgress);
  const result = useAppStore((s) => s.srtmResult);
  const startSrtmDownload = useAppStore((s) => s.startSrtmDownload);

  const loadStatus = async () => {
    try {
      const s = await invoke<[number, number] | null>("get_srtm_status");
      setSrtmStatus(s);
    } catch {
      // 무시
    } finally {
      setStatusLoading(false);
    }
  };

  useEffect(() => { loadStatus(); }, []);

  // 다운로드 완료 감지 → 상태 갱신
  const prevLoading = useRef(loading);
  useEffect(() => {
    if (prevLoading.current && !loading) {
      loadStatus();
    }
    prevLoading.current = loading;
  }, [loading]);

  const handleDownload = async () => {
    await startSrtmDownload();
  };

  const done = progress ? (progress.downloaded + (progress.skipped ?? 0)) : 0;
  const pct = progress && progress.total > 0
    ? Math.round((done / progress.total) * 100)
    : 0;

  const hasExtra = (loading && progress) || result;

  return (
    <div className="px-5 py-[13px]">
      <div className="grid items-center gap-3" style={{ gridTemplateColumns: "220px 1fr auto" }}>
        <div className="flex items-center gap-2">
          <Mountain size={16} className="text-[#a60739] shrink-0" />
          <h2 className="text-sm font-semibold text-gray-800 whitespace-nowrap">SRTM 지형 데이터 (30m)</h2>
        </div>
        <div className="flex items-center gap-2 min-w-0">
          {!statusLoading && srtmStatus ? (
            <>
              <span className="w-24 shrink-0 text-xs text-gray-600"><Check size={11} className="inline text-emerald-500" /> {srtmStatus[0]}개 타일</span>
              <span className="inline-flex items-center rounded-full bg-white/80 px-2 py-0.5 text-xs text-gray-500">{new Date(srtmStatus[1] * 1000).toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\.$/, "")}</span>
            </>
          ) : (
            <span className="text-xs text-gray-400">한국 영역 ~250MB · LoS/커버리지 오프라인 지형</span>
          )}
          <a
            href="https://www.earthdata.nasa.gov/data/instruments/srtm"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-0.5 text-xs text-blue-500 hover:text-blue-700 transition-colors shrink-0"
            onClick={(e) => {
              e.preventDefault();
              import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
                openUrl("https://www.earthdata.nasa.gov/data/instruments/srtm")
              );
            }}
          >
            <ExternalLink size={11} />
            NASA
          </a>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleDownload}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg bg-[#a60739] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#8a0630] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Download size={13} />
            {loading ? "다운로드 중..." : "다운로드"}
          </button>
        </div>
      </div>

      {hasExtra && (
        <div className="mt-3 space-y-2">
          {loading && progress && (
            <div className="space-y-1">
              <div className="h-1.5 w-full rounded-full bg-gray-200 overflow-hidden">
                <div
                  className="h-full rounded-full bg-[#a60739] transition-all duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="text-xs text-gray-500">
                {progress.current_tile && <span className="font-mono">{progress.current_tile}</span>}
                {" "}{done} / {progress.total} 타일 ({pct}%)
                {progress.downloaded > 0 && <span> · {progress.downloaded}개 다운로드</span>}
                {(progress.skipped ?? 0) > 0 && <span> · {progress.skipped}개 스킵(해양)</span>}
              </p>
            </div>
          )}

          {result && (
            <div className={`rounded-lg px-3 py-2 text-xs ${
              result.type === "success"
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                : "bg-red-50 text-red-700 border border-red-200"
            }`}>
              {result.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── vworld 계정 관리 ────────────────────────────────────────────────

export function VworldAccountSection() {
  const [id, setId] = useState("");
  const [pw, setPw] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [loaded, setLoaded] = useState(false);

  // DB에서 저장된 계정 로드
  useEffect(() => {
    (async () => {
      try {
        const savedId = await invoke<string | null>("load_setting", { key: "vworld_id" });
        const savedPw = await invoke<string | null>("load_setting", { key: "vworld_pw" });
        if (savedId) setId(savedId);
        if (savedPw) setPw(atob(savedPw));
        setLoaded(true);
      } catch {
        setLoaded(true);
      }
    })();
  }, []);

  const handleSave = async () => {
    if (!id.trim()) {
      setStatus({ type: "error", message: "아이디를 입력해 주세요." });
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      await invoke("save_setting", { key: "vworld_id", value: id.trim() });
      await invoke("save_setting", { key: "vworld_pw", value: btoa(pw) });
      setStatus({ type: "success", message: "vworld 계정이 저장되었습니다." });
    } catch (e) {
      setStatus({ type: "error", message: `저장 실패: ${e}` });
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <KeyRound size={16} className="text-blue-600" />
        <h2 className="text-lg font-semibold text-gray-800">vworld 계정</h2>
      </div>
      <p className="text-xs text-gray-500">
        건물통합정보 / 산 이름 데이터 자동 다운로드에 사용하는 vworld 계정입니다.
      </p>

      <div className="flex items-end gap-3">
        <div className="flex-1">
          <label className="block text-[11px] font-medium text-gray-500 mb-1">vworld ID</label>
          <input
            type="text"
            value={id}
            onChange={(e) => { setId(e.target.value); setStatus(null); }}
            placeholder="아이디"
            className="w-full rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-800 placeholder-gray-400 focus:border-blue-400 focus:outline-none"
          />
        </div>
        <div className="flex-1">
          <label className="block text-[11px] font-medium text-gray-500 mb-1">비밀번호</label>
          <div className="relative">
            <input
              type={showPw ? "text" : "password"}
              value={pw}
              onChange={(e) => { setPw(e.target.value); setStatus(null); }}
              placeholder="비밀번호"
              className="w-full rounded-md border border-gray-200 bg-white px-3 py-1.5 pr-8 text-sm text-gray-800 placeholder-gray-400 focus:border-blue-400 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setShowPw(!showPw)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              tabIndex={-1}
            >
              {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Save size={14} />
          {saving ? "저장 중..." : "저장"}
        </button>
      </div>

      {status && (
        <div className={`rounded-lg px-4 py-2.5 text-sm ${
          status.type === "success"
            ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
            : "bg-red-50 text-red-700 border border-red-200"
        }`}>
          {status.message}
        </div>
      )}
    </div>
  );
}


// ─── 토지이용계획도 (vworld WMS 타일 직접 다운로드) ──────────────────

export function LandUseDataSection() {
  const [tileCount, setTileCount] = useState(0);
  const [downloadedAt, setDownloadedAt] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState(true);

  const downloading = useAppStore((s) => s.landuseDownloading);
  const landuseProgress = useAppStore((s) => s.landuseProgress);
  const result = useAppStore((s) => s.landuseResult);
  const startLanduseDownload = useAppStore((s) => s.startLanduseDownload);

  // landuseProgress를 기존 UI가 기대하는 형태로 변환
  const progress = landuseProgress ? { message: landuseProgress.message, current: landuseProgress.current, total: landuseProgress.total } : null;

  const loadTileCount = async () => {
    try {
      const count = await invoke<number>("get_landuse_tile_count");
      setTileCount(count);
    } catch { /* ignore */ }
  };

  const loadDownloadedAt = async () => {
    try {
      const val = await invoke<string | null>("load_setting", { key: "landuse_downloaded_at" });
      if (val) setDownloadedAt(Number(val));
    } catch { /* ignore */ }
  };

  useEffect(() => { loadTileCount(); loadDownloadedAt(); }, []);

  // 다운로드 완료 감지 → 타일 수 갱신 + 다운로드 일시 저장
  const prevDownloading = useRef(downloading);
  useEffect(() => {
    if (prevDownloading.current && !downloading) {
      loadTileCount();
      const now = Math.floor(Date.now() / 1000);
      invoke("save_setting", { key: "landuse_downloaded_at", value: String(now) });
      setDownloadedAt(now);
    }
    prevDownloading.current = downloading;
  }, [downloading]);

  const handleDownload = async () => {
    await startLanduseDownload();
  };

  const pct = progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
  const hasExtra = (downloading && progress) || result;
  const isCollapsible = tileCount > 0 && !downloading && hasExtra;
  const isExpanded = !isCollapsible || !collapsed;

  return (
    <div className={`px-5 py-[13px] ${isCollapsible ? "cursor-pointer select-none" : ""}`} onClick={(e) => { if (isCollapsible && !(e.target as HTMLElement).closest("button, a")) setCollapsed((c) => !c); }}>
      <div className="grid items-center gap-3" style={{ gridTemplateColumns: "220px 1fr auto" }}>
        <div
          className="flex items-center gap-2"
        >
          {isCollapsible && (
            <ChevronDown
              size={14}
              className={`text-gray-400 shrink-0 transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`}
            />
          )}
          <Globe size={16} className="text-[#a60739] shrink-0" />
          <h2 className="text-sm font-semibold text-gray-800 whitespace-nowrap">토지이용계획도</h2>
        </div>
        <div className="flex items-center gap-2 min-w-0">
          {tileCount > 0 ? (
            <>
              <span className="w-24 shrink-0 text-xs text-gray-600"><Check size={11} className="inline text-emerald-500" /> {tileCount.toLocaleString()}개 타일</span>
              {downloadedAt && <span className="inline-flex items-center rounded-full bg-white/80 px-2 py-0.5 text-xs text-gray-500">{new Date(downloadedAt * 1000).toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\.$/, "")}</span>}
            </>
          ) : (
            <span className="text-xs text-gray-400">vworld WMS · 서울/인천/경기</span>
          )}
          <a
            href="https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?searchKeyword=%ED%86%A0%EC%A7%80%EC%9D%B4%EC%9A%A9&searchSvcCde=&searchOrganization=&searchBrmCode=&searchTagList=&searchFrm=&pageIndex=1&gidmCd=&gidsCd=&sortType=00&svcCde=DT&dsId=DAT_0000000000000128&listPageIndex=1"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-0.5 text-xs text-blue-500 hover:text-blue-700 transition-colors shrink-0"
            onClick={(e) => {
              e.preventDefault();
              import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
                openUrl("https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?searchKeyword=%ED%86%A0%EC%A7%80%EC%9D%B4%EC%9A%A9&searchSvcCde=&searchOrganization=&searchBrmCode=&searchTagList=&searchFrm=&pageIndex=1&gidmCd=&gidsCd=&sortType=00&svcCde=DT&dsId=DAT_0000000000000128&listPageIndex=1")
              );
            }}
          >
            <ExternalLink size={11} />
            vworld
          </a>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleDownload}
            disabled={downloading}
            className="flex items-center gap-1.5 rounded-lg bg-[#a60739] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#8a0630] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {downloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            {downloading ? "다운로드 중..." : "다운로드"}
          </button>
        </div>
      </div>

      {hasExtra && isExpanded && (
        <div className="mt-3 space-y-2" onClick={(e) => e.stopPropagation()}>
          {downloading && progress && (
            <div className="space-y-1">
              <div className="h-1.5 w-full rounded-full bg-gray-200 overflow-hidden">
                <div
                  className="h-full rounded-full bg-[#a60739] transition-all duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="text-xs text-gray-500">{progress.message} ({pct}%)</p>
            </div>
          )}

          {result && !downloading && (
            <div className={`rounded-lg px-3 py-2 text-xs ${
              result.type === "success"
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                : "bg-red-50 text-red-700 border border-red-200"
            }`}>
              {result.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── 건물통합정보 (F_FAC_BUILDING) ──────────────────────────────────

interface FacBuildingImportStatus {
  region: string;
  file_date: string;
  imported_at: number;
  record_count: number;
}

export function FacBuildingDataSection() {
  const [importStatus, setImportStatus] = useState<FacBuildingImportStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(true); // 데이터 있으면 접힌 상태 기본

  // ─── vworld 자동 다운로드 (store에서 관리 — 페이지 이동해도 유지) ───
  const facDownloading = useAppStore((s) => s.facBuildingDownloading);
  const facProgress = useAppStore((s) => s.facBuildingProgress);
  const facResult = useAppStore((s) => s.facBuildingResult);
  const startFacDownload = useAppStore((s) => s.startFacBuildingDownload);

  const [zipImporting, setZipImporting] = useState(false);
  const [zipResult, setZipResult] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const handleDownload = async () => {
    await startFacDownload();
    await loadStatus();
  };

  const handleZipImport = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        title: "건물통합정보 가져오기 (SHP ZIP)",
        filters: [{ name: "ZIP", extensions: ["zip"] }],
        multiple: true,
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      setZipImporting(true);
      setZipResult(null);
      let totalCount = 0;
      for (const p of paths) {
        const fname = (p as string).replace(/\\/g, "/").split("/").pop() || "";
        // 파일명에서 행정구역 코드 추정
        let region = "기타";
        if (fname.includes("_11_") || fname.includes("_11.")) region = "서울";
        else if (fname.includes("_28_") || fname.includes("_28.")) region = "인천";
        else if (fname.includes("_41_") || fname.includes("_41.")) region = "경기";
        const msg = await invoke<string>("import_fac_building_data", { zipPath: p, region });
        const m = msg.match(/(\d[\d,]*)건/);
        if (m) totalCount += parseInt(m[1].replace(/,/g, ""), 10);
      }
      setZipResult({ type: "success", message: `건물통합정보 ${totalCount.toLocaleString()}건 임포트 완료` });
      await loadStatus();
    } catch (e) {
      setZipResult({ type: "error", message: `임포트 실패: ${e}` });
    } finally {
      setZipImporting(false);
    }
  };

  // 다운로드 완료 감지 → 테이블 갱신
  const prevDownloading = useRef(facDownloading);
  useEffect(() => {
    if (prevDownloading.current && !facDownloading && facResult?.type === "success") {
      loadStatus();
    }
    prevDownloading.current = facDownloading;
  }, [facDownloading]);

  const loadStatus = async () => {
    try {
      const status = await invoke<FacBuildingImportStatus[]>("get_fac_building_import_status");
      setImportStatus(status);
    } catch {
      // 무시
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStatus();
  }, []);

  const handleClear = async (regionKey: string) => {
    try {
      await invoke("clear_fac_building_data", { region: regionKey });
      setDeleteConfirm(null);
      await loadStatus();
    } catch (e) {
      console.warn("삭제 실패:", e);
    }
  };

  /** 실측3D 행은 별도 섹션(MeasuredBuildingDataSection)이 표시 — 이중 표시 방지 위해 제외 */
  const facStatus = importStatus.filter((s) => s.region !== "실측3D");

  const totalRecords = facStatus.reduce((sum, s) => sum + s.record_count, 0);
  const latestImport = facStatus.length > 0
    ? Math.max(...facStatus.map((s) => s.imported_at))
    : 0;

  const facHasExtra = (facDownloading && facProgress) || facResult || zipResult || (!loading && facStatus.length > 0);
  const isCollapsible = !loading && totalRecords > 0 && !facDownloading && !zipImporting;
  const isExpanded = !isCollapsible || !collapsed;

  return (
    <div className={`px-5 py-[13px] ${isCollapsible ? "cursor-pointer select-none" : ""}`} onClick={(e) => { if (isCollapsible && !(e.target as HTMLElement).closest("button, a")) setCollapsed((c) => !c); }}>
      <div className="grid items-center gap-3" style={{ gridTemplateColumns: "220px 1fr auto" }}>
        <div
          className="flex items-center gap-2"
        >
          {isCollapsible && (
            <ChevronDown
              size={14}
              className={`text-gray-400 shrink-0 transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`}
            />
          )}
          <Building2 size={16} className="text-[#a60739] shrink-0" />
          <h2 className="text-sm font-semibold text-gray-800 whitespace-nowrap">건물 데이터 (건물통합정보)</h2>
        </div>
        <div className="flex items-center gap-2 min-w-0">
          {!loading && totalRecords > 0 ? (
            <>
              <span className="w-24 shrink-0 text-xs text-gray-600"><Check size={11} className="inline text-emerald-500" /> {totalRecords.toLocaleString()}건</span>
              <span className="inline-flex items-center rounded-full bg-white/80 px-2 py-0.5 text-xs text-gray-500">{new Date(latestImport * 1000).toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\.$/, "")}</span>
            </>
          ) : (
            <span className="text-xs text-gray-400">F_FAC_BUILDING SHP · 3D 건물 시각화</span>
          )}
          <a
            href="https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?searchKeyword=%EA%B1%B4%EB%AC%BC%ED%86%B5%ED%95%A9%EC%A0%95%EB%B3%B4&searchSvcCde=&searchOrganization=&searchBrmCode=&searchTagList=&searchFrm=&pageIndex=1&gidmCd=&gidsCd=&sortType=00&svcCde=MK&dsId=30524&listPageIndex=1"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-0.5 text-xs text-blue-500 hover:text-blue-700 transition-colors shrink-0"
            onClick={(e) => {
              e.preventDefault();
              import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
                openUrl("https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?searchKeyword=%EA%B1%B4%EB%AC%BC%ED%86%B5%ED%95%A9%EC%A0%95%EB%B3%B4&searchSvcCde=&searchOrganization=&searchBrmCode=&searchTagList=&searchFrm=&pageIndex=1&gidmCd=&gidsCd=&sortType=00&svcCde=MK&dsId=30524&listPageIndex=1")
              );
            }}
          >
            <ExternalLink size={11} />
            vworld
          </a>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleZipImport}
            disabled={zipImporting || facDownloading}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:border-[#a60739]/40 hover:text-[#a60739] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Upload size={13} />
            {zipImporting ? "임포트 중..." : "ZIP 가져오기"}
          </button>
          <button
            onClick={handleDownload}
            disabled={facDownloading || zipImporting}
            className="flex items-center gap-1.5 rounded-lg bg-[#a60739] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#8a0630] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {facDownloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            {facDownloading ? "다운로드 중..." : "다운로드"}
          </button>
        </div>
      </div>

      {facHasExtra && isExpanded && (
        <div className="mt-3 space-y-2" onClick={(e) => e.stopPropagation()}>
          {facDownloading && facProgress && (
            <div className="space-y-1">
              <div className="h-1.5 w-full rounded-full bg-gray-200 overflow-hidden">
                <div
                  className="h-full rounded-full bg-[#a60739] transition-all duration-300"
                  style={{
                    width: `${Math.round((facProgress.current / facProgress.total) * 100)}%`,
                  }}
                />
              </div>
              <p className="text-xs text-gray-500">{facProgress.message}</p>
            </div>
          )}

          {facResult && !facDownloading && (
            <div
              className={`rounded-lg px-3 py-2 text-xs ${
                facResult.type === "success"
                  ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                  : "bg-red-50 text-red-600 border border-red-200"
              }`}
            >
              {facResult.message}
            </div>
          )}

          {zipResult && !zipImporting && (
            <div
              className={`rounded-lg px-3 py-2 text-xs ${
                zipResult.type === "success"
                  ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                  : "bg-red-50 text-red-600 border border-red-200"
              }`}
            >
              {zipResult.message}
            </div>
          )}

          {!loading && facStatus.length > 0 && (
            <div className="rounded-xl border border-gray-200 overflow-hidden">
              <div className="grid grid-cols-[minmax(120px,1fr)_80px_100px] gap-2 bg-gray-100 px-4 py-1 text-[11px] font-normal text-gray-500 uppercase tracking-wider">
                <span>지역</span>
                <span className="text-right">건물 수</span>
                <span className="text-right">업로드 일자</span>
              </div>
              {facStatus.map((s, idx) => (
                <div key={s.region}>
                  <div className={`grid grid-cols-[minmax(120px,1fr)_80px_100px] items-center gap-2 px-4 py-1 ${idx % 2 === 0 ? "bg-white" : "bg-gray-50"}`}>
                    <span className="text-xs font-normal text-gray-800">{s.region}</span>
                    <span className="text-right text-xs tabular-nums text-gray-700">
                      {s.record_count.toLocaleString()}
                    </span>
                    <span className="text-right text-xs text-gray-500">
                      {new Date(s.imported_at * 1000).toLocaleDateString("ko-KR")}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 삭제 확인 모달 */}
      <Modal
        open={deleteConfirm !== null}
        onClose={() => setDeleteConfirm(null)}
        title="건물통합정보 삭제"
        width="max-w-sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            {deleteConfirm} 지역의 건물통합정보를 삭제하시겠습니까?
          </p>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setDeleteConfirm(null)}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 transition-colors"
            >
              취소
            </button>
            <button
              onClick={() => deleteConfirm && handleClear(deleteConfirm)}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors"
            >
              삭제
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ─── 실측 3D 건물 (1m DSM) — buildings_3d.bin 임포트 + 3D 타일셋 폴더 ───

export function MeasuredBuildingDataSection() {
  const [importStatus, setImportStatus] = useState<FacBuildingImportStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(true); // 데이터 있으면 접힌 상태 기본

  const [measuredImporting, setMeasuredImporting] = useState(false);
  const [measuredProgress, setMeasuredProgress] = useState<{ total: number; processed: number; status: string } | null>(null);
  const [measuredResult, setMeasuredResult] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [tiles3dDir, setTiles3dDir] = useState<string | null>(null);
  const [measuredDeleteConfirm, setMeasuredDeleteConfirm] = useState(false);

  // 실측 임포트는 fac_buildings 테이블에 쓰므로 vworld 다운로드 중에는 금지
  const facDownloading = useAppStore((s) => s.facBuildingDownloading);

  const loadStatus = async () => {
    try {
      const status = await invoke<FacBuildingImportStatus[]>("get_fac_building_import_status");
      setImportStatus(status);
    } catch {
      // 무시
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStatus();
    // 등록된 3D 타일셋 폴더 조회 (미등록이면 null)
    invoke<string | null>("get_tiles3d_dir").then(setTiles3dDir).catch(() => { /* 무시 */ });
  }, []);

  /** 실측 3D 임포트 — 타일셋 폴더 등록(선택 파일의 상위 폴더) 후 buildings_3d.bin 반영 */
  const handleMeasuredImport = async () => {
    let unlisten: (() => void) | null = null;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        title: "실측 3D 건물 가져오기 (buildings_3d.bin)",
        filters: [{ name: "buildings_3d.bin", extensions: ["bin"] }],
        multiple: false,
      });
      if (!selected) return;
      const binPath = selected as string;
      // 선택 경로에서 파일명 제거 → 타일셋 폴더 (Windows \ · POSIX / 모두 처리)
      const sepIdx = Math.max(binPath.lastIndexOf("\\"), binPath.lastIndexOf("/"));
      const dir = sepIdx > 0 ? binPath.slice(0, sepIdx) : null;

      setMeasuredImporting(true);
      setMeasuredProgress(null);
      setMeasuredResult(null);

      // 3D 타일 폴더 등록 — 실패해도 임포트는 계속 (경고만)
      if (dir) {
        try {
          await invoke("set_tiles3d_dir", { dir });
          setTiles3dDir(dir);
          // 열려 있는 지도 창에 즉시 반영 (없으면 재시작해야 메시가 보임)
          emit("tiles3d-changed", { dir }).catch(() => {});
        } catch (e) {
          console.warn("3D 타일 폴더 등록 실패:", e);
        }
      }

      try {
        unlisten = await listen<{ total: number; processed: number; status: string }>(
          "measured-building-import-progress",
          (e) => setMeasuredProgress(e.payload),
        );
      } catch { /* 리스너 실패 시 진행률 없이 진행 */ }

      const r = await invoke<{
        total: number;
        matched: number;
        inserted: number;
        skipped: number;
        corrected_cells: number;
      }>("import_measured_buildings", { binPath });
      setMeasuredResult({
        type: "success",
        message: `실측 건물 반영 완료 — 매칭 ${r.matched.toLocaleString()}건 · 신규 ${r.inserted.toLocaleString()}건 · 제외 ${r.skipped.toLocaleString()}건 · 지반보정 ${r.corrected_cells.toLocaleString()}셀`,
      });
      await loadStatus();
    } catch (e) {
      setMeasuredResult({ type: "error", message: `실측 3D 임포트 실패: ${e}` });
    } finally {
      if (unlisten) unlisten();
      setMeasuredImporting(false);
      setMeasuredProgress(null);
    }
  };

  /** 3D 타일 폴더 해제 — 타일 표출만 중지 (실측 높이 데이터는 유지) */
  const handleClearTilesDir = async () => {
    try {
      await invoke("set_tiles3d_dir", { dir: null });
      setTiles3dDir(null);
      emit("tiles3d-changed", { dir: null }).catch(() => {});
    } catch (e) {
      console.warn("타일 폴더 해제 실패:", e);
    }
  };

  /** 실측 건물 데이터 삭제 — 전용 커맨드 (clear_fac_building_data 아님) */
  const handleClearMeasured = async () => {
    try {
      await invoke("clear_measured_buildings");
      setMeasuredDeleteConfirm(false);
      setMeasuredResult({ type: "success", message: "실측 건물 데이터를 삭제했습니다." });
      await loadStatus();
    } catch (e) {
      setMeasuredDeleteConfirm(false);
      setMeasuredResult({ type: "error", message: `실측 데이터 삭제 실패: ${e}` });
    }
  };

  /** 실측3D 임포트 이력 존재 여부 (get_fac_building_import_status 의 "실측3D" 행) */
  const measuredStatus = importStatus.find((s) => s.region === "실측3D");
  const measuredPct = measuredProgress && measuredProgress.total > 0
    ? Math.min(100, Math.round((measuredProgress.processed / measuredProgress.total) * 100))
    : 0;

  const measuredHasExtra = !!tiles3dDir || measuredImporting || !!measuredResult;
  const isCollapsible = !loading && !!measuredStatus && !measuredImporting;
  const isExpanded = !isCollapsible || !collapsed;

  return (
    <div className={`px-5 py-[13px] ${isCollapsible ? "cursor-pointer select-none" : ""}`} onClick={(e) => { if (isCollapsible && !(e.target as HTMLElement).closest("button, a")) setCollapsed((c) => !c); }}>
      <div className="grid items-center gap-3" style={{ gridTemplateColumns: "220px 1fr auto" }}>
        <div className="flex items-center gap-2">
          {isCollapsible && (
            <ChevronDown
              size={14}
              className={`text-gray-400 shrink-0 transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`}
            />
          )}
          <Boxes size={16} className="text-[#a60739] shrink-0" />
          <h2 className="text-sm font-semibold text-gray-800 whitespace-nowrap">실측 3D 건물 (1m DSM)</h2>
        </div>
        <div className="flex items-center gap-2 min-w-0">
          {measuredStatus ? (
            <>
              <span className="w-24 shrink-0 text-xs text-gray-600"><Check size={11} className="inline text-emerald-500" /> {measuredStatus.record_count.toLocaleString()}건</span>
              <span className="inline-flex items-center rounded-full bg-white/80 px-2 py-0.5 text-xs text-gray-500">{new Date(measuredStatus.imported_at * 1000).toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\.$/, "")}</span>
            </>
          ) : (
            <span className="text-xs text-gray-400">항공 LiDAR 실측 지붕고 · Cesium 3D 타일셋</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleMeasuredImport}
            disabled={measuredImporting || facDownloading}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:border-[#a60739]/40 hover:text-[#a60739] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {measuredImporting ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            {measuredImporting ? "임포트 중..." : "실측 3D 임포트 (buildings_3d.bin)"}
          </button>
          {measuredStatus && (
            <button
              onClick={() => setMeasuredDeleteConfirm(true)}
              disabled={measuredImporting}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:border-red-300 hover:text-red-600 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Trash2 size={13} />
              실측 데이터 삭제
            </button>
          )}
        </div>
      </div>

      {measuredHasExtra && isExpanded && (
        <div className="mt-3 space-y-2" onClick={(e) => e.stopPropagation()}>
          {/* 등록된 3D 타일셋 폴더 */}
          {tiles3dDir && (
            <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
              <span className="shrink-0 rounded-sm bg-gray-200 px-1.5 py-[1px] text-[9px] font-semibold text-gray-600">타일 폴더</span>
              <span className="truncate" title={tiles3dDir}>{tiles3dDir}</span>
              <button
                onClick={handleClearTilesDir}
                className="shrink-0 text-[11px] text-gray-400 underline-offset-2 transition-colors hover:text-[#a60739] hover:underline"
              >
                해제
              </button>
            </div>
          )}

          {/* 임포트 진행률 */}
          {measuredImporting && (
            <div className="space-y-1">
              {measuredProgress && measuredProgress.total > 0 && (
                <div className="h-1.5 w-full rounded-full bg-gray-200 overflow-hidden">
                  <div className="h-full rounded-full bg-[#a60739] transition-all duration-300" style={{ width: `${measuredPct}%` }} />
                </div>
              )}
              <p className="text-xs text-gray-500">
                {measuredProgress
                  ? `${measuredProgress.status} ${measuredProgress.processed.toLocaleString()} / ${measuredProgress.total.toLocaleString()}`
                  : "실측 건물 파일 읽는 중..."}
              </p>
            </div>
          )}

          {measuredResult && !measuredImporting && (
            <div
              className={`rounded-lg px-3 py-2 text-xs ${
                measuredResult.type === "success"
                  ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                  : "bg-red-50 text-red-600 border border-red-200"
              }`}
            >
              {measuredResult.message}
            </div>
          )}
        </div>
      )}

      {/* 실측 3D 건물 삭제 확인 모달 */}
      <Modal
        open={measuredDeleteConfirm}
        onClose={() => setMeasuredDeleteConfirm(false)}
        title="실측 3D 건물 삭제"
        width="max-w-sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            실측 3D 건물(1m DSM) 데이터를 삭제하시겠습니까? 건물통합정보에 반영된 실측 지붕고도 함께 해제됩니다.
          </p>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setMeasuredDeleteConfirm(false)}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 transition-colors"
            >
              취소
            </button>
            <button
              onClick={handleClearMeasured}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors"
            >
              삭제
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ─── V-World 3D 건물 (XDO 타일 다운로드 → 3D Tiles 변환) ───────────────

/** vworld3d_status 원본 응답 — Rust serde 직렬화 케이스(camel/snake)가 갈릴 수 있어 양쪽 모두 수용 */
type Vworld3dRegionRaw = { lon: number; lat: number; radiusKm?: number; radius_km?: number; ts?: number };
type Vworld3dStatusRaw = {
  tileCount?: number; tile_count?: number;
  objectCount?: number; object_count?: number;
  totalBytes?: number; total_bytes?: number;
  regions?: Vworld3dRegionRaw[];
};
type Vworld3dRegion = { lon: number; lat: number; radiusKm: number; ts: number };
type Vworld3dStatus = { tileCount: number; objectCount: number; totalBytes: number; regions: Vworld3dRegion[] };

/** vworld3d-progress 이벤트 페이로드 (Rust emit_all 계약) */
type Vworld3dProgress = { phase: string; done: number; total: number; message?: string };

/** 진행 단계 한글 라벨 — 미지 phase 는 원문 그대로 표시 */
const VWORLD3D_PHASE_LABEL: Record<string, string> = {
  enumerate: "타일 열거",
  download: "다운로드",
  convert: "변환",
  tileset: "타일셋 생성",
};

/** 바이트 → KB/MB/GB 표기 (타일 용량은 KB~GB 폭이 넓어 formatBackupBytes 와 별도) */
const formatVworldBytes = (bytes: number) => {
  const KB = 1024, MB = KB * 1024, GB = MB * 1024;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)}GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)}MB`;
  return `${(bytes / KB).toFixed(0)}KB`;
};

const normalizeVworld3dStatus = (raw: Vworld3dStatusRaw | null): Vworld3dStatus | null => {
  if (!raw) return null;
  return {
    tileCount: raw.tileCount ?? raw.tile_count ?? 0,
    objectCount: raw.objectCount ?? raw.object_count ?? 0,
    totalBytes: raw.totalBytes ?? raw.total_bytes ?? 0,
    regions: (raw.regions ?? []).map((r) => ({
      lon: r.lon,
      lat: r.lat,
      radiusKm: r.radiusKm ?? r.radius_km ?? 0,
      ts: r.ts ?? 0,
    })),
  };
};

export function Vworld3dBuildingSection() {
  const [collapsed, setCollapsed] = useState(true);

  // API 키 / 리퍼러 (설정 저장 — vworld_id/vworld_pw 와 동일하게 save_setting/load_setting)
  const [apiKey, setApiKey] = useState("");
  const [referer, setReferer] = useState("http://localhost");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [keyResult, setKeyResult] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // 현황 (manifest 요약 — 소용량 JSON)
  const [status, setStatus] = useState<Vworld3dStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  // 다운로드 대상
  const [targetMode, setTargetMode] = useState<"site" | "manual">("site");
  const [siteName, setSiteName] = useState("");
  const [lonText, setLonText] = useState("");
  const [latText, setLatText] = useState("");
  const [radiusKm, setRadiusKm] = useState(5);

  const [downloading, setDownloading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<Vworld3dProgress | null>(null);
  const [result, setResult] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [clearConfirm, setClearConfirm] = useState(false);

  /** 이 마운트에서 다운로드를 시작해 이미 끝냈는지 — 늦게 도착한 progress 이벤트가
   *  완료된 다운로드를 되살리는 것을 막는 가드 (자가 복구는 최초 1회만 필요) */
  const doneRef = useRef(false);

  const radarSites = useAppStore((s) => s.customRadarSites);

  const loadStatus = async () => {
    try {
      const raw = await invoke<Vworld3dStatusRaw | null>("vworld3d_status");
      setStatus(normalizeVworld3dStatus(raw));
    } catch {
      // 백엔드 미탑재/디렉터리 없음 — 현황 없음으로 표시
      setStatus(null);
    } finally {
      setStatusLoading(false);
    }
  };

  // 저장된 키/리퍼러 + 현황 로드
  useEffect(() => {
    (async () => {
      try {
        const savedKey = await invoke<string | null>("load_setting", { key: "vworld_apikey" });
        const savedRef = await invoke<string | null>("load_setting", { key: "vworld_referer" });
        if (savedKey) setApiKey(savedKey);
        if (savedRef) setReferer(savedRef);
      } catch { /* 무시 */ }
    })();
    loadStatus();
  }, []);

  // 레이더 사이트 기본 선택 (활성 사이트 우선)
  useEffect(() => {
    if (siteName || radarSites.length === 0) return;
    const first = radarSites.find((s) => s.active !== false) ?? radarSites[0];
    setSiteName(first.name);
  }, [radarSites, siteName]);

  // 진행률/완료 이벤트 구독 — 마운트 동안 상시. 다른 창에서 시작했거나 페이지를 다시 열어
  // 로컬 downloading 플래그가 없는 경우에도 진행 상태를 자가 복구한다.
  useEffect(() => {
    const unProgress = listen<Vworld3dProgress>("vworld3d-progress", (e) => {
      setProgress(e.payload);
      setDownloading((prev) => prev || !doneRef.current);
    });
    // 완료/삭제 알림 — 로컬 state 만 갱신(재영속 금지)
    const unChanged = listen("vworld3d-changed", () => {
      setDownloading(false);
      setProgress(null);
      loadStatus();
    });
    return () => { unProgress.then((f) => f()); unChanged.then((f) => f()); };
  }, []);

  const handleSaveKey = async () => {
    if (!apiKey.trim()) {
      setKeyResult({ type: "error", message: "API 키를 입력해 주세요." });
      return;
    }
    setSaving(true);
    setKeyResult(null);
    try {
      await invoke("save_setting", { key: "vworld_apikey", value: apiKey.trim() });
      await invoke("save_setting", { key: "vworld_referer", value: referer.trim() || "http://localhost" });
      setKeyResult({ type: "success", message: "V-World 3D API 키가 저장되었습니다." });
    } catch (e) {
      setKeyResult({ type: "error", message: `저장 실패: ${e}` });
    } finally {
      setSaving(false);
    }
  };

  const handleTestKey = async () => {
    if (!apiKey.trim()) {
      setKeyResult({ type: "error", message: "API 키를 입력해 주세요." });
      return;
    }
    setTesting(true);
    setKeyResult(null);
    try {
      const msg = await invoke<string>("vworld3d_test_key", {
        apiKey: apiKey.trim(),
        referer: referer.trim() || "http://localhost",
      });
      setKeyResult({ type: "success", message: `연결 성공 — ${msg}` });
    } catch (e) {
      setKeyResult({ type: "error", message: `연결 실패: ${e}` });
    } finally {
      setTesting(false);
    }
  };

  const selectedSite = radarSites.find((s) => s.name === siteName) ?? null;
  /** 다운로드 중심 좌표 — 사이트 선택 또는 직접 입력. 유효 범위 밖이면 null(시작 버튼 비활성) */
  const center = (() => {
    const lon = targetMode === "site" ? selectedSite?.longitude : parseFloat(lonText);
    const lat = targetMode === "site" ? selectedSite?.latitude : parseFloat(latText);
    if (lon === undefined || lat === undefined || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    // 동아시아 유효 범위 (파서 규약과 동일)
    if (lat < 25 || lat > 50 || lon < 115 || lon > 145) return null;
    return { lon, lat };
  })();

  const handleStart = async () => {
    if (!center) {
      setResult({ type: "error", message: "다운로드 중심 좌표가 올바르지 않습니다 (위도 25~50°, 경도 115~145°)." });
      return;
    }
    doneRef.current = false;
    setDownloading(true);
    setCancelling(false);
    setProgress(null);
    setResult(null);
    try {
      await invoke("vworld3d_download", { centerLon: center.lon, centerLat: center.lat, radiusKm });
      setResult({
        type: "success",
        message: `V-World 3D 건물 다운로드 완료 — 중심 ${center.lat.toFixed(4)}, ${center.lon.toFixed(4)} · 반경 ${radiusKm}km`,
      });
    } catch (e) {
      setResult({ type: "error", message: `다운로드 실패: ${e}` });
    } finally {
      doneRef.current = true;
      setDownloading(false);
      setCancelling(false);
      setProgress(null);
      loadStatus();
    }
  };

  const handleCancel = async () => {
    setCancelling(true);
    try {
      await invoke("vworld3d_cancel");
    } catch (e) {
      console.warn("V-World 3D 다운로드 취소 실패:", e);
      setCancelling(false);
    }
  };

  const handleClear = async () => {
    try {
      await invoke("vworld3d_clear");
      setClearConfirm(false);
      setResult({ type: "success", message: "V-World 3D 건물 타일을 모두 삭제했습니다." });
      await loadStatus();
    } catch (e) {
      setClearConfirm(false);
      setResult({ type: "error", message: `삭제 실패: ${e}` });
    }
  };

  const hasData = !!status && status.tileCount > 0;
  const pct = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.done / progress.total) * 100))
    : 0;
  const phaseLabel = progress ? (VWORLD3D_PHASE_LABEL[progress.phase] ?? progress.phase) : "";

  const isCollapsible = !statusLoading && !downloading;
  const isExpanded = !isCollapsible || !collapsed;

  return (
    <div className={`px-5 py-[13px] ${isCollapsible ? "cursor-pointer select-none" : ""}`} onClick={(e) => { if (isCollapsible && !(e.target as HTMLElement).closest("button, a, input, select, label")) setCollapsed((c) => !c); }}>
      <div className="grid items-center gap-3" style={{ gridTemplateColumns: "220px 1fr auto" }}>
        <div className="flex items-center gap-2">
          {isCollapsible && (
            <ChevronDown
              size={14}
              className={`text-gray-400 shrink-0 transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`}
            />
          )}
          <Globe size={16} className="text-[#a60739] shrink-0" />
          <h2 className="text-sm font-semibold text-gray-800 whitespace-nowrap">V-World 3D 건물</h2>
        </div>
        <div className="flex items-center gap-2 min-w-0">
          {hasData && status ? (
            <>
              <span className="w-24 shrink-0 text-xs text-gray-600"><Check size={11} className="inline text-emerald-500" /> {status.tileCount.toLocaleString()}타일</span>
              <span className="inline-flex items-center rounded-full bg-white/80 px-2 py-0.5 text-xs text-gray-500">{status.objectCount.toLocaleString()}동</span>
              <span className="inline-flex items-center rounded-full bg-white/80 px-2 py-0.5 text-xs text-gray-500">{formatVworldBytes(status.totalBytes)}</span>
            </>
          ) : (
            <span className="text-xs text-gray-400">V-World XDO 건물 → 3D Tiles 변환 · 지도 표출 전용</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {downloading ? (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:border-red-300 hover:text-red-600 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Loader2 size={13} className="animate-spin" />
              {cancelling ? "취소 중..." : "취소"}
            </button>
          ) : (
            <button
              onClick={() => { setCollapsed(false); handleStart(); }}
              disabled={!center}
              className="flex items-center gap-1.5 rounded-lg bg-[#a60739] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#8a0630] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Download size={13} />
              다운로드
            </button>
          )}
          {hasData && (
            <button
              onClick={() => setClearConfirm(true)}
              disabled={downloading}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:border-red-300 hover:text-red-600 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Trash2 size={13} />
              전체 삭제
            </button>
          )}
        </div>
      </div>

      {isExpanded && (
        <div className="mt-3 space-y-3" onClick={(e) => e.stopPropagation()}>
          {/* API 키 / 리퍼러 */}
          <div className="rounded-xl border border-gray-200 bg-white p-3 space-y-2">
            <div className="flex items-center gap-1.5">
              <KeyRound size={13} className="text-[#a60739]" />
              <span className="text-xs font-semibold text-gray-700">V-World 3D API 키</span>
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1 min-w-0">
                <label className="block text-[11px] font-medium text-gray-500 mb-1">API 키</label>
                <div className="relative">
                  <input
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => { setApiKey(e.target.value); setKeyResult(null); }}
                    placeholder="V-World 3D 인증키"
                    className="w-full rounded-md border border-gray-200 bg-white px-3 py-1.5 pr-8 text-sm text-gray-800 placeholder-gray-400 focus:border-[#a60739]/50 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    tabIndex={-1}
                  >
                    {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
              <div className="w-56 shrink-0">
                <label className="block text-[11px] font-medium text-gray-500 mb-1">Referer (키 발급 시 등록 URL)</label>
                <input
                  type="text"
                  value={referer}
                  onChange={(e) => { setReferer(e.target.value); setKeyResult(null); }}
                  placeholder="http://localhost"
                  className="w-full rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-800 placeholder-gray-400 focus:border-[#a60739]/50 focus:outline-none"
                />
              </div>
              <button
                onClick={handleTestKey}
                disabled={testing || saving}
                className="flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:border-[#a60739]/40 hover:text-[#a60739] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {testing ? <Loader2 size={14} className="animate-spin" /> : <Globe size={14} />}
                {testing ? "확인 중..." : "연결 테스트"}
              </button>
              <button
                onClick={handleSaveKey}
                disabled={saving || testing}
                className="flex shrink-0 items-center gap-1.5 rounded-lg bg-[#a60739] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#8a0630] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Save size={14} />
                {saving ? "저장 중..." : "저장"}
              </button>
            </div>
            {keyResult && (
              <div className={`rounded-lg px-3 py-2 text-xs ${
                keyResult.type === "success"
                  ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                  : "bg-red-50 text-red-600 border border-red-200"
              }`}>
                {keyResult.message}
              </div>
            )}
          </div>

          {/* 다운로드 대상 */}
          <div className="rounded-xl border border-gray-200 bg-white p-3 space-y-2.5">
            <div className="flex items-center gap-1.5">
              <Boxes size={13} className="text-[#a60739]" />
              <span className="text-xs font-semibold text-gray-700">다운로드 영역</span>
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-1.5 text-xs text-gray-600">
                <input
                  type="radio"
                  checked={targetMode === "site"}
                  onChange={() => setTargetMode("site")}
                  className="accent-[#a60739]"
                />
                레이더 사이트
              </label>
              <label className="flex items-center gap-1.5 text-xs text-gray-600">
                <input
                  type="radio"
                  checked={targetMode === "manual"}
                  onChange={() => setTargetMode("manual")}
                  className="accent-[#a60739]"
                />
                좌표 직접 입력
              </label>
            </div>

            {targetMode === "site" ? (
              <div className="flex items-end gap-3">
                <div className="w-64">
                  <label className="block text-[11px] font-medium text-gray-500 mb-1">사이트</label>
                  <select
                    value={siteName}
                    onChange={(e) => setSiteName(e.target.value)}
                    className="w-full rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-800 focus:border-[#a60739]/50 focus:outline-none"
                  >
                    {radarSites.length === 0 && <option value="">등록된 사이트 없음</option>}
                    {radarSites.map((s) => (
                      <option key={s.name} value={s.name}>{s.name}</option>
                    ))}
                  </select>
                </div>
                {selectedSite && (
                  <span className="pb-1.5 text-[11px] tabular-nums text-gray-500">
                    {selectedSite.latitude.toFixed(5)}, {selectedSite.longitude.toFixed(5)}
                  </span>
                )}
              </div>
            ) : (
              <div className="flex items-end gap-3">
                <div className="w-40">
                  <label className="block text-[11px] font-medium text-gray-500 mb-1">위도 (°)</label>
                  <input
                    type="text"
                    value={latText}
                    onChange={(e) => setLatText(e.target.value)}
                    placeholder="37.5490"
                    className="w-full rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm tabular-nums text-gray-800 placeholder-gray-400 focus:border-[#a60739]/50 focus:outline-none"
                  />
                </div>
                <div className="w-40">
                  <label className="block text-[11px] font-medium text-gray-500 mb-1">경도 (°)</label>
                  <input
                    type="text"
                    value={lonText}
                    onChange={(e) => setLonText(e.target.value)}
                    placeholder="126.7937"
                    className="w-full rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm tabular-nums text-gray-800 placeholder-gray-400 focus:border-[#a60739]/50 focus:outline-none"
                  />
                </div>
                {!center && (latText || lonText) && (
                  <span className="pb-1.5 text-[11px] text-red-500">위도 25~50°, 경도 115~145° 범위로 입력</span>
                )}
              </div>
            )}

            <div>
              <div className="mb-1 flex items-baseline justify-between">
                <label className="text-[11px] font-medium text-gray-500">반경</label>
                <span className="text-xs font-semibold tabular-nums text-[#a60739]">{radiusKm}km</span>
              </div>
              <input
                type="range"
                min={1}
                max={15}
                step={1}
                value={radiusKm}
                onChange={(e) => setRadiusKm(Number(e.target.value))}
                disabled={downloading}
                className="w-full accent-[#a60739] disabled:opacity-40"
              />
            </div>

            <div className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
              <AlertTriangle size={13} className="mt-[1px] shrink-0" />
              <span>
                대용량 주의 — 도심 반경 5km 는 수만 건의 서버 요청과 수 GB 저장 용량이 필요할 수 있습니다.
                반경을 넓힐수록 소요 시간·용량이 제곱으로 증가하며, 이미 받은 타일은 자동으로 건너뜁니다(재개 가능).
                이 데이터는 지도 표출 전용으로, LoS·커버리지·BRA 등 분석에는 사용되지 않습니다.
              </span>
            </div>
          </div>

          {/* 진행률 */}
          {downloading && (
            <div className="space-y-1">
              {progress && progress.total > 0 && (
                <div className="h-1.5 w-full rounded-full bg-gray-200 overflow-hidden">
                  <div className="h-full rounded-full bg-[#a60739] transition-all duration-300" style={{ width: `${pct}%` }} />
                </div>
              )}
              <p className="text-xs text-gray-500">
                {progress
                  ? <>
                      <span className="font-medium text-gray-600">{phaseLabel}</span>{" "}
                      {progress.total > 0 && <>{progress.done.toLocaleString()} / {progress.total.toLocaleString()} ({pct}%)</>}
                      {progress.message && <span> · {progress.message}</span>}
                    </>
                  : "V-World 3D 건물 다운로드 준비 중..."}
              </p>
            </div>
          )}

          {result && !downloading && (
            <div className={`rounded-lg px-3 py-2 text-xs ${
              result.type === "success"
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                : "bg-red-50 text-red-600 border border-red-200"
            }`}>
              {result.message}
            </div>
          )}

          {/* 다운로드된 영역 목록 */}
          {status && status.regions.length > 0 && (
            <div className="rounded-xl border border-gray-200 overflow-hidden">
              <div className="grid grid-cols-[minmax(160px,1fr)_80px_100px] gap-2 bg-gray-100 px-4 py-1 text-[11px] font-normal text-gray-500 uppercase tracking-wider">
                <span>중심 좌표</span>
                <span className="text-right">반경</span>
                <span className="text-right">다운로드 일자</span>
              </div>
              {status.regions.map((r, idx) => (
                <div
                  key={`${r.lon}_${r.lat}_${r.ts}_${idx}`}
                  className={`grid grid-cols-[minmax(160px,1fr)_80px_100px] items-center gap-2 px-4 py-1 ${idx % 2 === 0 ? "bg-white" : "bg-gray-50"}`}
                >
                  <span className="text-xs tabular-nums text-gray-800">{r.lat.toFixed(5)}, {r.lon.toFixed(5)}</span>
                  <span className="text-right text-xs tabular-nums text-gray-700">{r.radiusKm}km</span>
                  <span className="text-right text-xs text-gray-500">
                    {r.ts > 0 ? new Date(r.ts * 1000).toLocaleDateString("ko-KR") : "-"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 전체 삭제 확인 모달 */}
      <Modal
        open={clearConfirm}
        onClose={() => setClearConfirm(false)}
        title="V-World 3D 건물 삭제"
        width="max-w-sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            다운로드한 V-World 3D 건물 타일을 모두 삭제하시겠습니까? 다시 보려면 재다운로드가 필요합니다.
          </p>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setClearConfirm(false)}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 transition-colors"
            >
              취소
            </button>
            <button
              onClick={handleClear}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors"
            >
              삭제
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ─── 산 이름 데이터 (연속수치지형도) ──────────────────────────────────

export function PeakDataSection() {
  const [status, setStatus] = useState<PeakImportStatus | null>(null);
  const [loading, setLoading] = useState(true);
  // ─── N3P 자동 다운로드 (store에서 관리 — 페이지 이동해도 유지) ───
  const n3pDownloading = useAppStore((s) => s.n3pDownloading);
  const n3pProgress = useAppStore((s) => s.n3pProgress);
  const n3pResult = useAppStore((s) => s.n3pResult);
  const startN3pDownload = useAppStore((s) => s.startN3pDownload);

  // ─── 산 ZIP 임포트 (store에서 관리 — 페이지 이동해도 유지) ───
  const importing = useAppStore((s) => s.peakImporting);
  const progress = useAppStore((s) => s.peakImportProgress);
  const result = useAppStore((s) => s.peakImportResult);
  const startPeakImport = useAppStore((s) => s.startPeakImport);

  const handleN3pDownload = async () => {
    await startN3pDownload();
    await loadStatus();
  };

  // 다른 페이지 갔다가 돌아올 때: 다운로드/임포트 완료 상태면 테이블 갱신
  const prevN3pDownloading = useRef(n3pDownloading);
  useEffect(() => {
    if (prevN3pDownloading.current && !n3pDownloading && n3pResult?.type === "success") {
      loadStatus();
    }
    prevN3pDownloading.current = n3pDownloading;
  }, [n3pDownloading]);

  const prevImporting = useRef(importing);
  useEffect(() => {
    if (prevImporting.current && !importing) {
      loadStatus();
    }
    prevImporting.current = importing;
  }, [importing]);

  const loadStatus = async () => {
    try {
      const s = await invoke<PeakImportStatus | null>("get_peak_import_status");
      setStatus(s);
    } catch {
      // 무시
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStatus();
  }, []);

  const handleImport = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        title: "산 이름 데이터 가져오기 (연속수치지형도 N3P ZIP)",
        filters: [{ name: "ZIP", extensions: ["zip"] }],
        multiple: false,
      });
      if (!selected) return;
      await startPeakImport(selected as string);
    } catch (e) {
      console.warn("[PeakImport] 파일 선택 실패:", e);
    }
  };

  const pct = progress && progress.total > 0
    ? Math.round((progress.processed / progress.total) * 100)
    : 0;

  const hasExtra = (importing && progress) || result;

  return (
    <div className="px-5 py-[13px]">
      <div className="grid items-center gap-3" style={{ gridTemplateColumns: "220px 1fr auto" }}>
        <div className="flex items-center gap-2">
          <Mountain size={16} className="text-[#a60739] shrink-0" />
          <h2 className="text-sm font-semibold text-gray-800 whitespace-nowrap">산 이름 데이터 (N3P)</h2>
        </div>
        <div className="flex items-center gap-2 min-w-0">
          {!loading && status ? (
            <>
              <span className="w-24 shrink-0 text-xs text-gray-600"><Check size={11} className="inline text-emerald-500" /> {status.record_count.toLocaleString()}건</span>
              <span className="inline-flex items-center rounded-full bg-white/80 px-2 py-0.5 text-xs text-gray-500">{new Date(status.imported_at * 1000).toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\.$/, "")}</span>
            </>
          ) : (
            <span className="text-xs text-gray-400">연속수치지형도 · LoS/파노라마 산 이름 오프라인 조회</span>
          )}
          <a
            href="https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?searchKeyword=%EC%82%B0%EB%A7%A5&searchSvcCde=&searchOrganization=&searchBrmCode=&searchTagList=&searchFrm=&pageIndex=1&gidmCd=&gidsCd=&sortType=00&svcCde=MK&dsId=30193&listPageIndex=1"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-0.5 text-xs text-blue-500 hover:text-blue-700 transition-colors shrink-0"
            onClick={(e) => {
              e.preventDefault();
              import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
                openUrl("https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?searchKeyword=%EC%82%B0%EB%A7%A5&searchSvcCde=&searchOrganization=&searchBrmCode=&searchTagList=&searchFrm=&pageIndex=1&gidmCd=&gidsCd=&sortType=00&svcCde=MK&dsId=30193&listPageIndex=1")
              );
            }}
          >
            <ExternalLink size={11} />
            vworld
          </a>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleImport}
            disabled={importing || n3pDownloading}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:border-[#a60739]/40 hover:text-[#a60739] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Upload size={13} />
            {importing ? "임포트 중..." : "ZIP 가져오기"}
          </button>
          <button
            onClick={handleN3pDownload}
            disabled={n3pDownloading || importing}
            className="flex items-center gap-1.5 rounded-lg bg-[#a60739] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#8a0630] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {n3pDownloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            {n3pDownloading ? "다운로드 중..." : "다운로드"}
          </button>
        </div>
      </div>

      {/* N3P 자동 다운로드 진행률 */}
      {n3pDownloading && n3pProgress && (
        <div className="mt-2 space-y-1">
          <div className="flex items-center gap-2 text-xs text-emerald-700">
            <Loader2 size={12} className="animate-spin" />
            {n3pProgress.message}
          </div>
          {n3pProgress.total > 0 && (
            <div className="h-1.5 w-full rounded-full bg-gray-200 overflow-hidden">
              <div
                className="h-full rounded-full bg-[#a60739] transition-all duration-300"
                style={{
                  width: `${Math.round((n3pProgress.current / n3pProgress.total) * 100)}%`,
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* N3P 자동 다운로드 결과 */}
      {n3pResult && !n3pDownloading && (
        <div
          className={`mt-2 rounded-lg px-3 py-2 text-xs ${
            n3pResult.type === "success"
              ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
              : "bg-red-50 text-red-600 border border-red-200"
          }`}
        >
          {n3pResult.message}
        </div>
      )}

      {hasExtra && (
        <div className="mt-3 space-y-2">
          {importing && progress && (
            <div className="space-y-1">
              <div className="h-1.5 w-full rounded-full bg-gray-200 overflow-hidden">
                <div
                  className="h-full rounded-full bg-[#a60739] transition-all duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="text-xs text-gray-500">
                {progress.status} ({pct}%)
              </p>
            </div>
          )}

          {result && (
            <div className={`rounded-lg px-3 py-2 text-xs ${
              result.type === "success"
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                : "bg-red-50 text-red-700 border border-red-200"
            }`}>
              {result.message}
            </div>
          )}
        </div>
      )}

    </div>
  );
}



// ─── 개발자 모드 ──────────────────────────────────────────────────────
function DevModeSection() {
  const devMode = useAppStore((s) => s.devMode);
  const setDevMode = useAppStore((s) => s.setDevMode);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-800">
            <AlertTriangle size={20} className="text-amber-500" />
            개발자 모드
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            UI 요소 우클릭 시 소스 파일 위치를 표시합니다
          </p>
        </div>
        <button
          onClick={() => setDevMode(!devMode)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            devMode ? "bg-amber-500" : "bg-gray-300"
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm ${
              devMode ? "translate-x-6" : "translate-x-1"
            }`}
          />
        </button>
      </div>
      {devMode && (
        <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800">
          UI 요소를 우클릭하면 해당 소스 파일 위치가 표시되고 클립보드에 복사됩니다.
        </div>
      )}
    </div>
  );
}

// ─── 설정 메인 페이지 ──────────────────────────────────────────────────

export default function Settings() {
  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-800">설정</h1>
        <p className="mt-1 text-sm text-gray-500">
          앱 설정을 관리합니다
        </p>
      </div>

      {/* vworld 계정 */}
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-5">
        <VworldAccountSection />
      </div>

      {/* DB 관리 */}
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-5">
        <DatabaseSection />
      </div>

      {/* 개발자 모드 */}
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-5">
        <DevModeSection />
      </div>

    </div>
  );
}
