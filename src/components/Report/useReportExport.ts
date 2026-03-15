import { useCallback } from "react";
import { jsPDF } from "jspdf";
import html2canvas from "html2canvas";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

export function useReportExport() {
  const exportPDF = useCallback(
    async (
      containerRef: React.RefObject<HTMLDivElement | null>,
      defaultFilename: string
    ): Promise<{ success: boolean; error?: string }> => {
      if (!containerRef.current) {
        return { success: false, error: "미리보기 컨테이너를 찾을 수 없습니다" };
      }

      // 저장 경로 먼저 선택
      const savePath = await save({
        defaultPath: defaultFilename,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });

      if (!savePath) {
        return { success: false, error: "저장이 취소되었습니다" };
      }

      // 페이지 div들 수집
      const pages = containerRef.current.querySelectorAll<HTMLDivElement>("[data-page]");
      if (pages.length === 0) {
        return { success: false, error: "보고서 페이지가 없습니다" };
      }

      const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      const pdfW = 210;
      const pdfH = 297;

      let isFirstPage = true;
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];

        // html2canvas로 캡처
        const canvas = await html2canvas(page, {
          scale: 2,
          useCORS: true,
          backgroundColor: "#ffffff",
          logging: false,
        });

        // 캡처된 이미지의 실제 비율 계산
        const imgAspect = canvas.height / canvas.width;
        const imgHeightMM = pdfW * imgAspect;

        const imgData = canvas.toDataURL("image/jpeg", 0.92);

        if (imgHeightMM <= pdfH) {
          // A4 한 페이지에 들어가면 그대로 출력
          if (!isFirstPage) doc.addPage();
          doc.addImage(imgData, "JPEG", 0, 0, pdfW, imgHeightMM);
          isFirstPage = false;
        } else {
          // A4보다 길면 여러 페이지로 분할
          const totalPdfPages = Math.ceil(imgHeightMM / pdfH);
          for (let p = 0; p < totalPdfPages; p++) {
            if (!isFirstPage) doc.addPage();
            // 이미지를 전체 너비로 배치하되 Y 오프셋으로 잘라서 보여줌
            const yOffset = -(p * pdfH);
            doc.addImage(imgData, "JPEG", 0, yOffset, pdfW, imgHeightMM);
            isFirstPage = false;
          }
        }
      }

      // 페이지 번호 추가
      const totalPages = doc.getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);
        doc.setFontSize(8);
        doc.setTextColor(150);
        doc.text(`- ${i} / ${totalPages} -`, pdfW / 2, pdfH - 5, { align: "center" });
      }

      // base64로 변환 후 Tauri로 저장
      const pdfBase64 = doc.output("datauristring").split(",")[1];
      await invoke("write_file_base64", { path: savePath, data: pdfBase64 });

      return { success: true };
    },
    []
  );

  return { exportPDF };
}
