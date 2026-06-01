/**
 * OM 보고서 — 건물 그룹 메타 인라인 배지.
 *
 * 건물명 옆에 색상 점 + 그룹명을 작게 표시. group_id 가 null 이거나 매칭되는 그룹이 없으면
 * 아무것도 렌더하지 않는다. SVG 컨텍스트(예: 폴라 커버리지 다이프 라벨)에서는 색상만 필요한
 * 경우가 있어서 별도 헬퍼(`groupColorOf`) 도 함께 노출한다.
 */
import type { BuildingGroup } from "../../types";

interface Props {
  groupId: number | null;
  groups: BuildingGroup[];
  /** "inline" (기본) — 점+이름 / "dot" — 점만 / "name" — 이름만 (색상 적용) */
  variant?: "inline" | "dot" | "name";
  /** "after" (기본) — 대상 뒤(오른쪽) 여백 / "before" — 대상 앞(왼쪽), 여백 방향 반전 */
  placement?: "after" | "before";
  /** 추가 className */
  className?: string;
}

/** 그룹 ID 로 BuildingGroup 조회 — 없으면 undefined */
export function findGroup(groupId: number | null | undefined, groups: BuildingGroup[]): BuildingGroup | undefined {
  if (groupId == null) return undefined;
  return groups.find((g) => g.id === groupId);
}

/** 그룹 색상만 반환 — SVG 라벨/도트 등에 사용 (없으면 undefined) */
export function groupColorOf(groupId: number | null | undefined, groups: BuildingGroup[]): string | undefined {
  return findGroup(groupId, groups)?.color;
}

export default function BuildingGroupBadge({ groupId, groups, variant = "inline", placement = "after", className }: Props) {
  const g = findGroup(groupId, groups);
  if (!g) return null;

  // placement 에 따라 여백을 대상 앞/뒤로 분기 (앞이면 오른쪽 여백)
  const marginKey = placement === "before" ? "marginRight" : "marginLeft";

  const dot = (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 7,
        height: 7,
        borderRadius: 2,
        background: g.color,
        border: "1px solid rgba(0,0,0,0.15)",
        flexShrink: 0,
      }}
    />
  );

  if (variant === "dot") {
    return <span className={className} title={g.name} style={{ display: "inline-flex", [marginKey]: 4, verticalAlign: "middle" }}>{dot}</span>;
  }
  if (variant === "name") {
    return (
      <span className={className} style={{ color: g.color, fontWeight: 600, fontSize: "0.85em", [marginKey]: 4 }}>
        {g.name}
      </span>
    );
  }
  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        [marginKey]: 6,
        padding: "0 5px",
        borderRadius: 3,
        background: `${g.color}1a`, // 10% alpha
        border: `1px solid ${g.color}55`,
        color: g.color,
        fontSize: "0.78em",
        fontWeight: 600,
        verticalAlign: "middle",
        lineHeight: 1.4,
        whiteSpace: "nowrap",
      }}
    >
      {dot}
      <span>{g.name}</span>
    </span>
  );
}
