export type QuickAddPlanNode = {
  title: string;
  /** Parent node inside this same Quick Add expression. null means the current view/context parent. */
  parentIndex: number | null;
};

/**
 * Quick Add hierarchy syntax:
 *   >   next task is a child of the current task
 *   ,   next task is a sibling of the current task
 *   <   move up one existing level, then create the next task beneath that ancestor
 *   <<  move up two levels, etc.
 *
 * Example:
 *   Dinner > Main > Steak << Dessert > Cake, Ice Cream
 */
export function parseQuickAddHierarchy(input: string): QuickAddPlanNode[] {
  const tokens = input
    .split(/([><]+|,)/g)
    .map(token => token.trim())
    .filter(Boolean);

  const nodes: QuickAddPlanNode[] = [];
  let currentIndex: number | null = null;
  let pendingOperator: string | null = null;

  const parentOf = (index: number | null) => index === null ? null : nodes[index]?.parentIndex ?? null;

  for (const token of tokens) {
    if (/^[><]+$/.test(token) || token === ",") {
      pendingOperator = token;
      continue;
    }

    const title = token.trim();
    if (!title) continue;

    let parentIndex: number | null = null;
    if (nodes.length === 0) {
      parentIndex = null;
    } else if (pendingOperator === ">") {
      parentIndex = currentIndex;
    } else if (pendingOperator === "," || pendingOperator === null) {
      parentIndex = parentOf(currentIndex);
    } else if (pendingOperator?.startsWith("<")) {
      let ancestor = currentIndex;
      for (let step = 0; step < pendingOperator.length && ancestor !== null; step += 1) {
        ancestor = parentOf(ancestor);
      }
      // If we climbed beyond this expression's root, create at the context/root level.
      parentIndex = ancestor;
    } else {
      parentIndex = parentOf(currentIndex);
    }

    nodes.push({ title, parentIndex });
    currentIndex = nodes.length - 1;
    pendingOperator = null;
  }

  return nodes;
}
