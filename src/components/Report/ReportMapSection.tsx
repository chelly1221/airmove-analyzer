interface MapSectionProps {
  sectionNum: number;
  mapImage: string | null;
}

export default function ReportMapSection({ sectionNum, mapImage }: MapSectionProps) {
  return (
    <div className="mb-8">
      <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[15px] font-bold text-gray-900">
        {sectionNum}. 항적 지도
      </h2>

      {mapImage ? (
        <div className="overflow-hidden rounded border border-gray-200">
          <img
            src={mapImage}
            alt="항적 지도"
            className="w-full"
            style={{ maxHeight: "180mm" }}
          />
        </div>
      ) : (
        <div className="flex items-center justify-center rounded border border-dashed border-gray-300 bg-gray-50 py-16">
          <p className="text-[12px] text-gray-400">
            항적 지도를 캡처하려면 먼저 지도 페이지에서 항적을 표시하세요
          </p>
        </div>
      )}
    </div>
  );
}
