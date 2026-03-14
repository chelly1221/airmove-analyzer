interface Column<T> {
  key: string;
  header: string;
  render?: (row: T, index: number) => React.ReactNode;
  width?: string;
  align?: "left" | "center" | "right";
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  rowKey: (row: T, index: number) => string;
  onRowClick?: (row: T, index: number) => void;
  selectedKey?: string;
  emptyMessage?: string;
  maxHeight?: string;
}

export default function DataTable<T>({
  columns,
  data,
  rowKey,
  onRowClick,
  selectedKey,
  emptyMessage = "데이터가 없습니다",
  maxHeight = "max-h-[600px]",
}: DataTableProps<T>) {
  return (
    <div
      className={`overflow-auto rounded-lg border border-white/10 ${maxHeight}`}
    >
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-[#0f3460] text-gray-300">
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                className="whitespace-nowrap px-4 py-3 text-left font-medium"
                style={{
                  width: col.width,
                  textAlign: col.align ?? "left",
                }}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {data.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="px-4 py-12 text-center text-gray-500"
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            data.map((row, idx) => {
              const key = rowKey(row, idx);
              const isSelected = selectedKey !== undefined && key === selectedKey;
              return (
              <tr
                key={key}
                className={`transition-colors ${isSelected ? "bg-[#e94560]/15 ring-1 ring-inset ring-[#e94560]/30" : "bg-[#16213e] hover:bg-[#1a2a4e]"} ${onRowClick ? "cursor-pointer" : ""}`}
                onClick={() => onRowClick?.(row, idx)}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className="whitespace-nowrap px-4 py-3 text-gray-300"
                    style={{ textAlign: col.align ?? "left" }}
                  >
                    {col.render
                      ? col.render(row, idx)
                      : String((row as Record<string, unknown>)[col.key] ?? "")}
                  </td>
                ))}
              </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
