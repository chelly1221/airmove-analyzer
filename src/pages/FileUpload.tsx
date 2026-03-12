import { useState, useCallback } from "react";
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
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store";
import type { AnalysisResult, UploadedFile } from "../types";

export default function FileUpload() {
  const uploadedFiles = useAppStore((s) => s.uploadedFiles);
  const addUploadedFile = useAppStore((s) => s.addUploadedFile);
  const updateUploadedFile = useAppStore((s) => s.updateUploadedFile);
  const removeUploadedFile = useAppStore((s) => s.removeUploadedFile);
  const clearUploadedFiles = useAppStore((s) => s.clearUploadedFiles);
  const addAnalysisResult = useAppStore((s) => s.addAnalysisResult);
  const setLoading = useAppStore((s) => s.setLoading);
  const setLoadingMessage = useAppStore((s) => s.setLoadingMessage);

  const [dragOver, setDragOver] = useState(false);
  const [errorLog, setErrorLog] = useState<string[]>([]);

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

      // Tauri 환경에서 drag & drop 은 제한적이므로 안내
      setErrorLog((prev) => [
        ...prev,
        "드래그 앤 드롭은 Tauri 환경에서 제한될 수 있습니다. 파일 선택 버튼을 사용하세요.",
      ]);
    },
    []
  );

  const parseFile = async (file: UploadedFile) => {
    updateUploadedFile(file.path, { status: "parsing" });
    setLoading(true);
    setLoadingMessage(`파싱 중: ${file.name}`);
    try {
      const result: AnalysisResult = await invoke("parse_and_analyze", {
        filePath: file.path,
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
    }
  };

  const parseAll = async () => {
    const pending = uploadedFiles.filter((f) => f.status === "pending");
    for (const file of pending) {
      await parseFile(file);
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">자료 업로드</h1>
        <p className="mt-1 text-sm text-gray-400">
          NEC RDRS ASS 파일을 업로드하여 파싱합니다
        </p>
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
          클릭하여 ASS 파일 선택
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
            {uploadedFiles.map((file) => (
              <div
                key={file.path}
                className="flex items-center gap-3 px-4 py-3"
              >
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
                        : file.status === "parsing"
                          ? "text-blue-400"
                          : "text-gray-500"
                  }`}
                >
                  {statusText(file)}
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
            ))}
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
