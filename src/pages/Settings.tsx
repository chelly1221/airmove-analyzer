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
  MapPin,
  Trash2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import Modal from "../components/common/Modal";
import { useAppStore } from "../store";
import type { PeakImportStatus } from "../types";

// ─── DB 내보내기/가져오기 섹션 ────────────────────────────────────────

export function DatabaseSection() {
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [confirmImport, setConfirmImport] = useState<string | null>(null);

  const handleExport = async () => {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const dest = await save({
        title: "데이터베이스 내보내기",
        defaultPath: `airmove-backup-${new Date().toISOString().slice(0, 10)}.db`,
        filters: [{ name: "SQLite Database", extensions: ["db"] }],
      });
      if (!dest) return;

      setExporting(true);
      setStatus(null);
      await invoke("export_database", { destPath: dest });
      setStatus({ type: "success", message: "데이터베이스를 내보냈습니다." });
    } catch (e) {
      setStatus({ type: "error", message: `내보내기 실패: ${e}` });
    } finally {
      setExporting(false);
    }
  };

  const handleImportClick = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const src = await open({
        title: "데이터베이스 가져오기",
        filters: [{ name: "SQLite Database", extensions: ["db"] }],
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
    try {
      setImporting(true);
      setStatus(null);
      setConfirmImport(null);
      await invoke("import_database", { srcPath: confirmImport });
      setStatus({ type: "success", message: "데이터베이스를 가져왔습니다. 페이지를 새로고침합니다..." });
      // 상태 반영을 위해 앱 새로고침
      setTimeout(() => window.location.reload(), 1500);
    } catch (e) {
      setStatus({ type: "error", message: `가져오기 실패: ${e}` });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Database size={16} className="text-[#a60739]" />
        <h2 className="text-lg font-semibold text-gray-800">데이터베이스 관리</h2>
      </div>
      <p className="text-xs text-gray-500">
        운항이력, ADS-B 항적, 파싱 데이터 등 모든 저장 데이터를 내보내거나 가져올 수 있습니다.
      </p>

      <div className="flex gap-3">
        <button
          onClick={handleExport}
          disabled={exporting || importing}
          className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-gray-400 hover:text-gray-900 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Download size={14} />
          {exporting ? "내보내는 중..." : "DB 내보내기"}
        </button>
        <button
          onClick={handleImportClick}
          disabled={exporting || importing}
          className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-gray-400 hover:text-gray-900 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Upload size={14} />
          {importing ? "가져오는 중..." : "DB 가져오기"}
        </button>
      </div>

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

  const totalRecords = importStatus.reduce((sum, s) => sum + s.record_count, 0);
  const latestImport = importStatus.length > 0
    ? Math.max(...importStatus.map((s) => s.imported_at))
    : 0;

  const facHasExtra = (facDownloading && facProgress) || facResult || zipResult || (!loading && importStatus.length > 0);
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

          {!loading && importStatus.length > 0 && (
            <div className="rounded-xl border border-gray-200 overflow-hidden">
              <div className="grid grid-cols-[minmax(120px,1fr)_80px_100px] gap-2 bg-gray-100 px-4 py-1 text-[11px] font-normal text-gray-500 uppercase tracking-wider">
                <span>지역</span>
                <span className="text-right">건물 수</span>
                <span className="text-right">업로드 일자</span>
              </div>
              {importStatus.map((s, idx) => (
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



// ─── 도로명주소 데이터 ──────────────────────────────────────────────────

interface JusoImportStatus {
  region: string;
  file_date: string;
  imported_at: number;
  record_count: number;
}

export function JusoDataSection() {
  const [importStatus, setImportStatus] = useState<JusoImportStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(true);
  const [zipResult, setZipResult] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [zipImporting, setZipImporting] = useState(false);

  const jusoDownloading = useAppStore((s) => s.jusoDownloading);
  const jusoProgress = useAppStore((s) => s.jusoProgress);
  const jusoResult = useAppStore((s) => s.jusoResult);
  const startJusoDownload = useAppStore((s) => s.startJusoDownload);

  const loadStatus = async () => {
    try {
      const status = await invoke<JusoImportStatus[]>("get_juso_import_status");
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

  // 다운로드 완료 감지 → 상태 새로고침
  const prevDownloading = useRef(jusoDownloading);
  useEffect(() => {
    if (prevDownloading.current && !jusoDownloading && jusoResult?.type === "success") {
      loadStatus();
    }
    prevDownloading.current = jusoDownloading;
  }, [jusoDownloading, jusoResult]);

  const handleDownload = async () => {
    await startJusoDownload();
  };

  const handleZipImport = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        title: "주소 데이터 가져오기 (주소DB ZIP)",
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
        // 파일명에서 지역 추출
        let region = "기타";
        const regions = ["서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "경기", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주"];
        for (const r of regions) {
          if (fname.includes(r)) { region = r; break; }
        }
        const msg = await invoke<string>("import_juso_address_data", { zipPath: p, region });
        const m = msg.match(/(\d[\d,]*)건/);
        if (m) totalCount += parseInt(m[1].replace(/,/g, ""), 10);
      }
      setZipResult({ type: "success", message: `주소 ${totalCount.toLocaleString()}건 임포트 완료` });
      await loadStatus();
    } catch (e) {
      setZipResult({ type: "error", message: `임포트 실패: ${e}` });
    } finally {
      setZipImporting(false);
    }
  };

  const handleCoordImport = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        title: "좌표 데이터 가져오기 (좌표DB ZIP)",
        filters: [{ name: "ZIP", extensions: ["zip"] }],
        multiple: true,
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      setZipImporting(true);
      setZipResult(null);

      for (const p of paths) {
        await invoke<string>("import_juso_coord_data", { zipPath: p });
      }
      setZipResult({ type: "success", message: "좌표 매칭 완료" });
      await loadStatus();
    } catch (e) {
      setZipResult({ type: "error", message: `좌표 임포트 실패: ${e}` });
    } finally {
      setZipImporting(false);
    }
  };

  const handleClear = async (regionKey: string) => {
    try {
      await invoke("clear_juso_data", { region: regionKey });
      setDeleteConfirm(null);
      await loadStatus();
    } catch (e) {
      console.warn("삭제 실패:", e);
    }
  };

  const totalRecords = importStatus.reduce((sum, s) => sum + s.record_count, 0);
  const hasExtra = (jusoDownloading && jusoProgress) || jusoResult || zipResult || (!loading && importStatus.length > 0);
  const isCollapsible = !loading && totalRecords > 0 && !jusoDownloading && !zipImporting;
  const isExpanded = !isCollapsible || !collapsed;

  return (
    <div
      className={`px-5 py-[13px] ${isCollapsible ? "cursor-pointer select-none" : ""}`}
      onClick={(e) => {
        if (isCollapsible && !(e.target as HTMLElement).closest("button, a"))
          setCollapsed((c) => !c);
      }}
    >
      <div className="grid items-center gap-3" style={{ gridTemplateColumns: "220px 1fr auto" }}>
        <div className="flex items-center gap-2">
          {isCollapsible && (
            <ChevronDown
              size={14}
              className={`text-gray-400 shrink-0 transition-transform duration-200 ${
                collapsed ? "-rotate-90" : ""
              }`}
            />
          )}
          <MapPin size={16} className="text-[#a60739] shrink-0" />
          <h2 className="text-sm font-semibold text-gray-800 whitespace-nowrap">주소 데이터 (도로명주소)</h2>
        </div>
        <div className="flex items-center gap-2 min-w-0">
          {!loading && totalRecords > 0 ? (
            <>
              <span className="w-24 shrink-0 text-xs text-gray-600">
                <Check size={11} className="inline text-emerald-500" /> {totalRecords.toLocaleString()}건
              </span>
              {importStatus.length > 0 && (
                <span className="inline-flex items-center rounded-full bg-white/80 px-2 py-0.5 text-xs text-gray-500">
                  {new Date(Math.max(...importStatus.map((s) => s.imported_at)) * 1000).toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\.$/, "")}
                </span>
              )}
            </>
          ) : (
            <span className="text-xs text-gray-400">도로명주소 · 오프라인 주소 검색</span>
          )}
          <a
            href="https://business.juso.go.kr/jst/jstAddressDetailsSearch"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-0.5 text-xs text-blue-500 hover:text-blue-700 transition-colors shrink-0"
            onClick={(e) => {
              e.preventDefault();
              import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
                openUrl("https://business.juso.go.kr/jst/jstAddressDetailsSearch")
              );
            }}
          >
            <ExternalLink size={11} />
            juso.go.kr
          </a>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleZipImport}
            disabled={zipImporting || jusoDownloading}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:border-[#a60739]/40 hover:text-[#a60739] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Upload size={13} />
            {zipImporting ? "임포트 중..." : "주소DB ZIP"}
          </button>
          <button
            onClick={handleCoordImport}
            disabled={zipImporting || jusoDownloading}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:border-[#a60739]/40 hover:text-[#a60739] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Globe size={13} />
            {zipImporting ? "임포트 중..." : "좌표DB ZIP"}
          </button>
          <button
            onClick={handleDownload}
            disabled={jusoDownloading || zipImporting}
            className="flex items-center gap-1.5 rounded-lg bg-[#a60739] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#8a0630] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {jusoDownloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            {jusoDownloading ? "다운로드 중..." : "다운로드"}
          </button>
        </div>
      </div>

      {hasExtra && isExpanded && (
        <div className="mt-3 space-y-2" onClick={(e) => e.stopPropagation()}>
          {/* 자동 다운로드 진행률 */}
          {jusoDownloading && jusoProgress && (
            <div className="space-y-1">
              <div className="h-1.5 w-full rounded-full bg-gray-200 overflow-hidden">
                <div
                  className="h-full rounded-full bg-[#a60739] transition-all duration-300"
                  style={{
                    width: `${Math.round((jusoProgress.current / jusoProgress.total) * 100)}%`,
                  }}
                />
              </div>
              <p className="text-xs text-gray-500">{jusoProgress.message}</p>
            </div>
          )}

          {/* 다운로드 결과 */}
          {jusoResult && !jusoDownloading && (
            <div
              className={`rounded-lg px-3 py-2 text-xs ${
                jusoResult.type === "success"
                  ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                  : "bg-red-50 text-red-600 border border-red-200"
              }`}
            >
              {jusoResult.message}
            </div>
          )}

          {/* ZIP 임포트 결과 */}
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

          {importStatus.length > 0 && (
            <div className="rounded-xl border border-gray-200 overflow-hidden">
              <div className="grid grid-cols-[minmax(80px,1fr)_80px_100px_40px] gap-2 bg-gray-100 px-4 py-1 text-[11px] font-normal text-gray-500 uppercase tracking-wider">
                <span>지역</span>
                <span className="text-right">주소 수</span>
                <span className="text-right">임포트 일자</span>
                <span />
              </div>
              {importStatus.map((s, idx) => (
                <div key={s.region}>
                  <div
                    className={`grid grid-cols-[minmax(80px,1fr)_80px_100px_40px] items-center gap-2 px-4 py-1 ${
                      idx % 2 === 0 ? "bg-white" : "bg-gray-50"
                    }`}
                  >
                    <span className="text-xs font-normal text-gray-800">{s.region}</span>
                    <span className="text-right text-xs tabular-nums text-gray-700">
                      {s.record_count.toLocaleString()}
                    </span>
                    <span className="text-right text-xs text-gray-500">
                      {new Date(s.imported_at * 1000).toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\.$/, "")}
                    </span>
                    <div className="flex justify-end">
                      {deleteConfirm === s.region ? (
                        <button
                          onClick={() => handleClear(s.region)}
                          className="text-[10px] text-red-500 hover:text-red-700 font-medium"
                        >
                          확인
                        </button>
                      ) : (
                        <button
                          onClick={() => setDeleteConfirm(s.region)}
                          className="text-gray-300 hover:text-red-400 transition-colors"
                        >
                          <Trash2 size={11} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
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
