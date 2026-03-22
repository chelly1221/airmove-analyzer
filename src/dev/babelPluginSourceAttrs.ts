/**
 * Babel 플러그인: 모든 JSX 요소에 data-source="파일경로:줄번호" 속성 자동 주입
 * 개발자모드에서 우클릭 시 소스 위치를 표시하기 위한 빌드타임 변환
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function babelPluginSourceAttrs({ types: t }: { types: any }) {
  return {
    visitor: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      JSXOpeningElement(path: any, state: any) {
        const name = path.node.name;

        // Fragment 스킵 (DOM 노드 없음)
        if (t.isJSXIdentifier(name, { name: "Fragment" })) return;
        if (
          t.isJSXMemberExpression(name) &&
          t.isJSXIdentifier(name.property, { name: "Fragment" })
        )
          return;

        // 이미 data-source가 있으면 스킵
        if (
          path.node.attributes.some(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (a: any) =>
              t.isJSXAttribute(a) &&
              t.isJSXIdentifier(a.name, { name: "data-source" }),
          )
        )
          return;

        const filename = state.filename || "";
        const root = state.cwd || "";
        const rel = filename.startsWith(root)
          ? filename.slice(root.length + 1).replace(/\\/g, "/")
          : filename;
        const line = path.node.loc?.start?.line ?? 0;

        path.node.attributes.push(
          t.jsxAttribute(
            t.jsxIdentifier("data-source"),
            t.stringLiteral(`${rel}:${line}`),
          ),
        );
      },
    },
  };
}
