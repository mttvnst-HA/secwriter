/**
 * Builds a hierarchical tree from flat block array.
 * Used for the navigation sidebar.
 */
export function buildTree(blocks) {
  const titles = blocks.filter(b => b.type === "title");
  const root = { id: "root", children: [], text: "Document", depth: -1 };
  const stack = [root];

  for (const t of titles) {
    const node = { id: t.id, text: t.html, depth: t.depth, part: t.part, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].depth >= t.depth) {
      stack.pop();
    }
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root.children;
}
