export type DataDumpNode = {
  _id: string;
  parentNodeId: string | null;
  sourceMeta?: unknown;
};

export type DataDumpManifestInput = {
  generatedAt: string;
  exportedPageCount: number;
  excludedPageCount: number;
  exportedArchivedNodeSubtreeCount: number;
  excludedNodeSubtreeCount: number;
  excludedNodeCount: number;
  legacyFileCount: number;
  contentFileCount: number;
};

const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

function getSourceMeta(record: { sourceMeta?: unknown } | null | undefined) {
  return record && typeof record.sourceMeta === "object" && record.sourceMeta
    ? (record.sourceMeta as Record<string, unknown>)
    : {};
}

export function isDataDumpExcluded(
  record: { sourceMeta?: unknown } | null | undefined,
) {
  return getSourceMeta(record).excludeFromDataDump === true;
}

export function filterDataDumpNodes<TNode extends DataDumpNode>(nodes: TNode[]) {
  const nodeById = new Map(nodes.map((node) => [node._id as string, node]));
  const childrenByParent = new Map<string | null, TNode[]>();

  for (const node of nodes) {
    const key = node.parentNodeId ?? null;
    const bucket = childrenByParent.get(key) ?? [];
    bucket.push(node);
    childrenByParent.set(key, bucket);
  }

  function hasExcludedAncestor(node: TNode) {
    const visited = new Set<string>();
    let currentParentId = node.parentNodeId;

    while (currentParentId) {
      if (visited.has(currentParentId)) {
        break;
      }
      visited.add(currentParentId);

      const parentNode = nodeById.get(currentParentId);
      if (!parentNode) {
        break;
      }
      if (isDataDumpExcluded(parentNode)) {
        return true;
      }

      currentParentId = parentNode.parentNodeId;
    }

    return false;
  }

  const excludedNodeIds = new Set<string>();
  const excludedRootIds = new Set<string>();

  function markSubtreeExcluded(rootNodeId: string) {
    const queue = [rootNodeId];

    while (queue.length > 0) {
      const currentNodeId = queue.shift()!;
      if (excludedNodeIds.has(currentNodeId)) {
        continue;
      }

      excludedNodeIds.add(currentNodeId);
      for (const child of childrenByParent.get(currentNodeId) ?? []) {
        queue.push(child._id as string);
      }
    }
  }

  for (const node of nodes) {
    const nodeId = node._id as string;
    if (!isDataDumpExcluded(node) || hasExcludedAncestor(node)) {
      continue;
    }

    excludedRootIds.add(nodeId);
    markSubtreeExcluded(nodeId);
  }

  return {
    nodes: nodes.filter((node) => !excludedNodeIds.has(node._id as string)),
    excludedNodeIds,
    excludedRootIds,
    excludedNodeCount: excludedNodeIds.size,
    excludedNodeSubtreeCount: excludedRootIds.size,
  };
}

export function sanitizeDataDumpPathSegment(value: string, fallback = "untitled") {
  const cleaned = value
    .replace(/[\x00-\x1F\x7F]/g, "")
    .replace(/[<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.\.+/g, ".")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .replace(/^[._ -]+/, "")
    .replace(/[._ -]+$/, "")
    .trim();
  const segment = cleaned.length > 0 && !/^[._ -]+$/.test(cleaned) ? cleaned : fallback;
  const safeSegment = segment.slice(0, 120).trim() || fallback;

  return WINDOWS_RESERVED_NAMES.has(safeSegment.toLowerCase())
    ? `${safeSegment}-file`
    : safeSegment;
}

export function buildUniqueDataDumpPath({
  directory = [],
  name,
  extension = "",
  usedPaths,
}: {
  directory?: string[];
  name: string;
  extension?: string;
  usedPaths: Set<string>;
}) {
  const normalizedExtension = extension.replace(/^\.+/, "").trim();
  const extensionSuffix = normalizedExtension ? `.${normalizedExtension}` : "";
  const baseName =
    extensionSuffix && name.toLowerCase().endsWith(extensionSuffix.toLowerCase())
      ? name.slice(0, -extensionSuffix.length)
      : name;
  const safeDirectory = directory
    .map((segment) => sanitizeDataDumpPathSegment(segment, "folder"))
    .filter((segment) => segment.length > 0);
  const safeBaseName = sanitizeDataDumpPathSegment(baseName, "untitled");
  let suffix = 1;
  let candidate = [...safeDirectory, `${safeBaseName}${extensionSuffix}`].join("/");

  while (usedPaths.has(candidate.toLowerCase())) {
    suffix += 1;
    candidate = [...safeDirectory, `${safeBaseName} ${suffix}${extensionSuffix}`].join("/");
  }

  usedPaths.add(candidate.toLowerCase());
  return candidate;
}

export function buildDataDumpManifest(input: DataDumpManifestInput) {
  return {
    version: 1,
    generatedAt: input.generatedAt,
    counts: {
      exportedPages: input.exportedPageCount,
      excludedPages: input.excludedPageCount,
      exportedArchivedNodeSubtrees: input.exportedArchivedNodeSubtreeCount,
      excludedNodeSubtrees: input.excludedNodeSubtreeCount,
      excludedNodes: input.excludedNodeCount,
      legacyFiles: input.legacyFileCount,
      contentFiles: input.contentFileCount,
    },
  };
}

export type DataDumpVisibility<TNode extends DataDumpNode> = {
  pageExcluded: boolean;
  // Nodes left after removing excluded items and their subtrees (none when the
  // page itself is excluded).
  visibleNodes: TNode[];
  // Every hidden node id: flagged items, their descendants, or the whole page.
  excludedNodeIds: Set<string>;
};

// What a data dump would leave out of one page: the whole page when it is
// excluded, otherwise each excluded item with its subtree (filterDataDumpNodes).
export function getDataDumpVisibility<TNode extends DataDumpNode>(
  page: { sourceMeta?: unknown },
  nodes: TNode[],
): DataDumpVisibility<TNode> {
  if (isDataDumpExcluded(page)) {
    return {
      pageExcluded: true,
      visibleNodes: [],
      excludedNodeIds: new Set(nodes.map((node) => node._id as string)),
    };
  }
  const filtered = filterDataDumpNodes(nodes);
  return {
    pageExcluded: false,
    visibleNodes: filtered.nodes,
    excludedNodeIds: filtered.excludedNodeIds,
  };
}

export type DataDumpExclusionPage = { _id: string; sourceMeta?: unknown };
export type DataDumpExclusionNode = DataDumpNode & { pageId: string; position?: number };

// A page's nodes in outline order (depth first, siblings by position). Nodes
// whose parent isn't on the page count as roots.
function outlineOrder<TNode extends DataDumpExclusionNode>(nodes: TNode[]) {
  const ids = new Set(nodes.map((node) => node._id as string));
  const childrenByParent = new Map<string | null, TNode[]>();
  for (const node of nodes) {
    const key = node.parentNodeId && ids.has(node.parentNodeId) ? node.parentNodeId : null;
    const bucket = childrenByParent.get(key) ?? [];
    bucket.push(node);
    childrenByParent.set(key, bucket);
  }
  const ordered: TNode[] = [];
  const visited = new Set<string>();
  const visit = (parentId: string | null) => {
    const children = [...(childrenByParent.get(parentId) ?? [])].sort(
      (left, right) => (left.position ?? 0) - (right.position ?? 0),
    );
    for (const child of children) {
      const id = child._id as string;
      if (visited.has(id)) continue;
      visited.add(id);
      ordered.push(child);
      visit(id);
    }
  };
  visit(null);
  // Anything left is in a parent loop; keep it rather than drop it.
  return [...ordered, ...nodes.filter((node) => !visited.has(node._id as string))];
}

// Every page and item flagged excludeFromDataDump, items in outline order per
// page. An item is "alsoCoveredBy"
// its page or an excluded ancestor when including it alone wouldn't put it back
// in the dump.
export function listDataDumpExclusions<
  TPage extends DataDumpExclusionPage,
  TNode extends DataDumpExclusionNode,
>(pages: TPage[], nodes: TNode[]) {
  const pageById = new Map(pages.map((page) => [page._id as string, page]));
  const nodesByPage = new Map<string, TNode[]>();
  for (const node of nodes) {
    const bucket = nodesByPage.get(node.pageId as string) ?? [];
    bucket.push(node);
    nodesByPage.set(node.pageId as string, bucket);
  }

  const items: { node: TNode; page: TPage; alsoCoveredBy: "page" | "ancestor" | null }[] = [];
  for (const [pageId, pageNodes] of nodesByPage) {
    const page = pageById.get(pageId);
    if (!page) {
      continue;
    }
    const pageExcluded = isDataDumpExcluded(page);
    const { excludedRootIds } = filterDataDumpNodes(pageNodes);
    for (const node of outlineOrder(pageNodes)) {
      if (!isDataDumpExcluded(node)) {
        continue;
      }
      items.push({
        node,
        page,
        alsoCoveredBy: pageExcluded
          ? "page"
          : excludedRootIds.has(node._id as string)
            ? null
            : "ancestor",
      });
    }
  }

  return {
    pages: pages.filter((page) => isDataDumpExcluded(page)),
    items,
  };
}
