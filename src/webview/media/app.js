"use strict";

const vscode = acquireVsCodeApi();
let analysis = null;
let exportPath = null;
let packageXmlPath = null;
let edgeByPair = new Map();
let visibleTree = null;

const KIND_COLORS = {
  lwcBundle: "#1f8bff",
  auraBundle: "#ff8d3a",
  apexClass: "#1e6f5c",
  apexTrigger: "#b34a4a",
  customLabel: "#7a5cff",
  customObject: "#008b7f",
  customField: "#7f5a3a",
  customMetadataType: "#b26a00",
  customMetadataRecord: "#5b6cff"
};

const NODE_WIDTH = 290;
const NODE_HEIGHT = 92;
const HORIZONTAL_GAP = 90;
const VERTICAL_GAP = 20;
const PADDING_X = 40;
const PADDING_Y = 34;
let textMeasureContext = null;

const savedState = vscode.getState() || {};
let tree = null;
const state = {
  selectedKey: savedState.selectedKey || null,
  collapsed: new Set(savedState.collapsed || []),
  activeTypes: new Set(savedState.activeTypes || [])
};

const elements = {
  canvas: document.getElementById("canvas"),
  svg: document.getElementById("mindmap"),
  empty: document.getElementById("emptyState"),
  rootTitle: document.getElementById("rootTitle"),
  rootType: document.getElementById("rootType"),
  nodeCount: document.getElementById("nodeCount"),
  edgeCount: document.getElementById("edgeCount"),
  maxDepth: document.getElementById("maxDepth"),
  warningCount: document.getElementById("warningCount"),
  typeFilterSummary: document.getElementById("typeFilterSummary"),
  selectedLabel: document.getElementById("selectedLabel"),
  selectedType: document.getElementById("selectedType"),
  selectedPath: document.getElementById("selectedPath"),
  jumpToOriginalBtn: document.getElementById("jumpToOriginalBtn"),
  warningList: document.getElementById("warningList"),
  assumptionList: document.getElementById("assumptionList"),
  legendRows: document.getElementById("legendRows"),
  openNodeBtn: document.getElementById("openNodeBtn"),
  openExportBtn: document.getElementById("openExportBtn"),
  openPackageBtn: document.getElementById("openPackageBtn"),
  showAllTypesBtn: document.getElementById("showAllTypesBtn"),
  showRootOnlyBtn: document.getElementById("showRootOnlyBtn")
};

document.getElementById("expandAllBtn").addEventListener("click", () => {
  state.collapsed.clear();
  render();
});

document.getElementById("collapseAllBtn").addEventListener("click", () => {
  state.collapsed = new Set(defaultCollapsedKeys(tree, 1));
  state.selectedKey = tree?.key || null;
  render();
});

document.getElementById("focusRootBtn").addEventListener("click", () => {
  state.selectedKey = visibleTree?.key || tree?.key || null;
  render();
  scrollToSelected();
});

elements.openNodeBtn.addEventListener("click", () => {
  const node = findNodeByKey(visibleTree || tree, state.selectedKey);
  if (node?.path) {
    vscode.postMessage({ type: "openNode", path: node.path });
  }
});

elements.jumpToOriginalBtn.addEventListener("click", () => {
  jumpToOriginalNode();
});

elements.openExportBtn.addEventListener("click", () => {
  if (exportPath) {
    vscode.postMessage({ type: "openExport" });
  }
});

elements.openPackageBtn.addEventListener("click", () => {
  if (packageXmlPath) {
    vscode.postMessage({ type: "openPackageXml" });
  }
});

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type !== "setData") {
    return;
  }

  analysis = message.analysis || null;
  exportPath = message.exportPath || null;
  packageXmlPath = message.packageXmlPath || null;
  edgeByPair = new Map(
    (analysis?.graph?.edges || []).map((edge) => [
      edge.from + "->" + edge.to,
      edge
    ])
  );
  tree = hydrateTree(analysis?.tree || null);
  visibleTree = null;
  state.selectedKey = tree?.key || null;
  state.collapsed = new Set(defaultCollapsedKeys(tree));
  syncActiveTypes();
  renderStaticMeta();
  render();
});

elements.showAllTypesBtn.addEventListener("click", () => {
  state.activeTypes = new Set(getTypeEntries().map(([metadataType]) => metadataType));
  render();
});

elements.showRootOnlyBtn.addEventListener("click", () => {
  state.activeTypes.clear();
  render();
});

vscode.postMessage({ type: "ready" });
renderStaticMeta();
render();

function renderStaticMeta() {
  elements.rootTitle.textContent = analysis?.root?.label || "Waiting for analysis";
  elements.rootType.textContent = analysis?.root?.metadataType || "";
  elements.warningCount.textContent = String((analysis?.warnings || []).length);

  renderList(elements.warningList, analysis?.warnings || ["No warnings"]);
  renderList(elements.assumptionList, analysis?.assumptions || []);
  renderLegend();
}

function render() {
  visibleTree = filterTreeForActiveTypes(tree);
  const filteredSummary = summarizeVisibleGraph(visibleTree);
  renderGraphSummary(filteredSummary);
  renderLegend();

  const selectedNode = findNodeByKey(visibleTree, state.selectedKey) || visibleTree;
  if (selectedNode) {
    state.selectedKey = selectedNode.key;
  }

  elements.selectedLabel.textContent = selectedNode?.label || "No node selected";
  elements.selectedType.textContent = selectedNode?.metadataType || "";
  elements.selectedPath.textContent = selectedNode?.path || "";
  elements.openNodeBtn.disabled = !selectedNode?.path;
  elements.jumpToOriginalBtn.disabled = !selectedNode?.reference;
  elements.openExportBtn.disabled = !exportPath;
  elements.openPackageBtn.disabled = !packageXmlPath;

  if (!analysis || !visibleTree) {
    elements.svg.innerHTML = "";
    elements.empty.style.display = analysis ? "block" : "none";
    return;
  }

  elements.empty.style.display = "none";

  const measured = measureTree(visibleTree, 0);
  const layout = positionTree(measured, PADDING_Y);
  const nodes = [];
  const links = [];
  flattenLayout(layout, nodes, links);

  const deepestDepth = nodes.reduce((maxDepth, node) => Math.max(maxDepth, node.depth), 0);
  const width = PADDING_X * 2 + (deepestDepth + 1) * (NODE_WIDTH + HORIZONTAL_GAP) + NODE_WIDTH;
  const height = Math.max(layout.subtreeHeight + PADDING_Y * 2, 240);

  elements.svg.setAttribute("viewBox", "0 0 " + width + " " + height);
  elements.svg.setAttribute("width", String(width));
  elements.svg.setAttribute("height", String(height));
  elements.svg.innerHTML = renderSvg(links, nodes);

  bindSvgEvents();
  persistState();
}

function bindSvgEvents() {
  for (const element of document.querySelectorAll("[data-node-key]")) {
    element.addEventListener("click", () => {
      state.selectedKey = element.getAttribute("data-node-key");
      render();
    });

    element.addEventListener("dblclick", () => {
      const node = findNodeByKey(visibleTree, element.getAttribute("data-node-key"));
      if (node?.path) {
        vscode.postMessage({ type: "openNode", path: node.path });
      }
    });
  }

  for (const element of document.querySelectorAll("[data-toggle-key]")) {
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      const key = element.getAttribute("data-toggle-key");
      if (state.collapsed.has(key)) {
        state.collapsed.delete(key);
      } else {
        state.collapsed.add(key);
        if (state.selectedKey && isDescendantKey(key, state.selectedKey)) {
          state.selectedKey = key;
        }
      }
      render();
    });
  }
}

function persistState() {
  vscode.setState({
    selectedKey: state.selectedKey,
    collapsed: Array.from(state.collapsed),
    activeTypes: Array.from(state.activeTypes)
  });
}

function scrollToSelected() {
  const selected = document.querySelector('[data-node-key="' + CSS.escape(state.selectedKey) + '"]');
  if (selected) {
    selected.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  }
}

function jumpToOriginalNode() {
  const selectedNode = findNodeByKey(visibleTree || tree, state.selectedKey);
  if (!selectedNode?.reference) {
    return;
  }

  const targetPath = findOriginalNodePath(tree, selectedNode.id);
  if (!targetPath || targetPath.length === 0) {
    return;
  }

  for (const ancestorKey of targetPath.slice(0, -1)) {
    state.collapsed.delete(ancestorKey);
  }

  state.selectedKey = targetPath[targetPath.length - 1];
  render();
  requestAnimationFrame(scrollToSelected);
}

function hydrateTree(node, parentKey = "", depth = 0, index = 0) {
  if (!node) {
    return null;
  }

  const key = parentKey
    ? parentKey + "." + index + "." + sanitizeKeyPart(node.id)
    : sanitizeKeyPart(node.id || "root");

  return {
    ...node,
    depth,
    key,
    children: (node.children || []).map((child, childIndex) =>
      hydrateTree(child, key, depth + 1, childIndex)
    )
  };
}

function sanitizeKeyPart(value) {
  return String(value || "node").replace(/[^a-zA-Z0-9_.:-]/g, "_");
}

function findOriginalNodePath(node, nodeId, path = []) {
  if (!node) {
    return null;
  }

  const nextPath = path.concat(node.key);
  if (node.id === nodeId && !node.reference) {
    return nextPath;
  }

  for (const child of node.children || []) {
    const match = findOriginalNodePath(child, nodeId, nextPath);
    if (match) {
      return match;
    }
  }

  return null;
}

function defaultCollapsedKeys(node, expandedDepth = 2, acc = []) {
  if (!node) {
    return acc;
  }

  if ((node.children || []).length > 0 && node.depth >= expandedDepth) {
    acc.push(node.key);
  }

  for (const child of node.children || []) {
    defaultCollapsedKeys(child, expandedDepth, acc);
  }

  return acc;
}

function renderList(target, values) {
  if (!values.length) {
    target.innerHTML = "<li>None</li>";
    return;
  }

  target.innerHTML = values.map((value) => "<li>" + escapeHtml(value) + "</li>").join("");
}

function renderLegend() {
  const typeEntries = getTypeEntries();
  const kindByMetadataType = new Map(
    (analysis?.graph?.nodes || []).map((node) => [node.metadataType || node.kind || "Unknown", node.kind])
  );
  const activeCount = typeEntries.filter(([metadataType]) => state.activeTypes.has(metadataType)).length;

  if (!typeEntries.length) {
    elements.legendRows.innerHTML = '<div class="root-type">No metadata types available.</div>';
    elements.typeFilterSummary.textContent = "";
    return;
  }

  elements.legendRows.innerHTML = typeEntries
    .map(([metadataType, count]) => {
      const kind = kindByMetadataType.get(metadataType);
      const checked = state.activeTypes.has(metadataType) ? " checked" : "";
      const filterId = "type-filter-" + sanitizeKeyPart(metadataType);
      const kindAttribute = kind ? ' data-kind="' + escapeAttribute(kind) + '"' : "";
      return (
        '<label class="legend-row" for="' + escapeAttribute(filterId) + '">' +
          '<input id="' + escapeAttribute(filterId) + '" type="checkbox" data-type-filter="' + escapeAttribute(metadataType) + '"' + checked + ">" +
          '<span class="legend-swatch"' + kindAttribute + "></span>" +
          '<span class="legend-label">' + escapeHtml(metadataType) + "</span>" +
          '<span class="legend-count">' + count + "</span>" +
        "</label>"
      );
    })
    .join("");

  elements.typeFilterSummary.textContent =
    activeCount + " / " + typeEntries.length + " types visible. Root node is always shown.";

  for (const input of elements.legendRows.querySelectorAll("[data-type-filter]")) {
    input.addEventListener("change", () => {
      const metadataType = input.getAttribute("data-type-filter");
      if (!metadataType) {
        return;
      }

      if (input.checked) {
        state.activeTypes.add(metadataType);
      } else {
        state.activeTypes.delete(metadataType);
      }

      render();
    });
  }
}

function getTypeEntries() {
  const counts = new Map();

  for (const node of analysis?.graph?.nodes || []) {
    const metadataType = node.metadataType || node.kind || "Unknown";
    counts.set(metadataType, (counts.get(metadataType) || 0) + 1);
  }

  const rootType = analysis?.root?.metadataType || "";
  return Array.from(counts.entries()).sort(([left], [right]) => {
    if (left === rootType && right !== rootType) {
      return -1;
    }
    if (right === rootType && left !== rootType) {
      return 1;
    }
    return left.localeCompare(right);
  });
}

function syncActiveTypes() {
  state.activeTypes = new Set(getTypeEntries().map(([metadataType]) => metadataType));
}

function renderGraphSummary(summary) {
  elements.nodeCount.textContent = formatSummaryCount(
    summary.nodeCount,
    analysis?.summary?.nodeCount || 0
  );
  elements.edgeCount.textContent = formatSummaryCount(
    summary.edgeCount,
    analysis?.summary?.edgeCount || 0
  );
  elements.maxDepth.textContent = formatSummaryCount(
    summary.maxDepth,
    analysis?.summary?.maxDepth || 0
  );
}

function formatSummaryCount(visible, total) {
  if (!total || visible === total) {
    return String(visible);
  }

  return visible + " / " + total;
}

function summarizeVisibleGraph(node) {
  const visibleNodeIds = collectVisibleNodeIds(node);
  const visibleEdgeCount = (analysis?.graph?.edges || []).filter((edge) =>
    visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to)
  ).length;

  return {
    nodeCount: visibleNodeIds.size,
    edgeCount: visibleEdgeCount,
    maxDepth: summarizeVisibleDepth(node)
  };
}

function collectVisibleNodeIds(node, acc = new Set()) {
  if (!node) {
    return acc;
  }

  acc.add(node.id);

  for (const child of node.children || []) {
    collectVisibleNodeIds(child, acc);
  }

  return acc;
}

function summarizeVisibleDepth(node, depth = 0) {
  if (!node) {
    return 0;
  }

  let maxDepth = depth;

  for (const child of node.children || []) {
    maxDepth = Math.max(maxDepth, summarizeVisibleDepth(child, depth + 1));
  }

  return maxDepth;
}

function filterTreeForActiveTypes(node) {
  if (!node) {
    return null;
  }

  const visibleChildren = [];
  for (const child of node.children || []) {
    const childResults = collectFilteredNodes(child);
    visibleChildren.push(...childResults);
  }

  return {
    ...node,
    children: visibleChildren
  };
}

function collectFilteredNodes(node) {
  if (!node) {
    return [];
  }

  const visibleChildren = [];
  for (const child of node.children || []) {
    visibleChildren.push(...collectFilteredNodes(child));
  }

  if (state.activeTypes.has(node.metadataType || "")) {
    return [
      {
        ...node,
        children: visibleChildren
      }
    ];
  }

  return visibleChildren;
}

function measureTree(node, depth) {
  const visibleChildren = state.collapsed.has(node.key) ? [] : (node.children || []);
  const measuredChildren = visibleChildren.map((child) => measureTree(child, depth + 1));
  const childrenHeight = measuredChildren.reduce((sum, child) => sum + child.subtreeHeight, 0) +
    Math.max(0, measuredChildren.length - 1) * VERTICAL_GAP;
  const subtreeHeight = Math.max(NODE_HEIGHT, childrenHeight);

  return {
    ...node,
    depth,
    visibleChildren: measuredChildren,
    subtreeHeight
  };
}

function positionTree(node, top) {
  const x = PADDING_X + node.depth * (NODE_WIDTH + HORIZONTAL_GAP);
  const childrenHeight = node.visibleChildren.reduce((sum, child) => sum + child.subtreeHeight, 0) +
    Math.max(0, node.visibleChildren.length - 1) * VERTICAL_GAP;
  const y = top + node.subtreeHeight / 2 - NODE_HEIGHT / 2;

  let childTop = top + Math.max(0, (node.subtreeHeight - childrenHeight) / 2);
  const positionedChildren = node.visibleChildren.map((child) => {
    const positioned = positionTree(child, childTop);
    childTop += child.subtreeHeight + VERTICAL_GAP;
    return positioned;
  });

  return {
    ...node,
    x,
    y,
    visibleChildren: positionedChildren
  };
}

function flattenLayout(node, nodes, links) {
  nodes.push(node);

  for (const child of node.visibleChildren) {
    links.push({
      from: node,
      to: child,
      edge: edgeByPair.get(node.id + "->" + child.id) || null
    });
    flattenLayout(child, nodes, links);
  }
}

function renderSvg(links, nodes) {
  const linkMarkup = links.map(renderLink).join("");
  const nodeMarkup = nodes.map(renderNode).join("");
  return "<g>" + linkMarkup + nodeMarkup + "</g>";
}

function renderLink(link) {
  const startX = link.from.x + NODE_WIDTH;
  const startY = link.from.y + NODE_HEIGHT / 2;
  const endX = link.to.x;
  const endY = link.to.y + NODE_HEIGHT / 2;
  const controlOffset = Math.max(48, (endX - startX) * 0.45);
  const path = [
    "M", startX, startY,
    "C", startX + controlOffset, startY,
    endX - controlOffset, endY,
    endX, endY
  ].join(" ");
  const lowConfidence = link.edge?.confidence === "low" ? " low-confidence" : "";
  return '<path class="connector' + lowConfidence + '" d="' + path + '"></path>';
}

function renderNode(node) {
  const color = KIND_COLORS[node.kind] || "#666666";
  const isSelected = node.key === state.selectedKey;
  const hasChildren = (node.children || []).length > 0;
  const isCollapsed = state.collapsed.has(node.key);
  const badge = node.cycle ? "Cycle" : node.kind.replace(/([A-Z])/g, " $1");
  const badgeFont = getNodeFont("node-badge");
  const badgeLetterSpacing = getNodeLetterSpacing("node-badge");
  const badgeMaxWidth = NODE_WIDTH - 28;
  const badgeHorizontalPadding = 20;
  const resolvedBadge = trimTextToWidth(
    node.reference ? "Ref" : badge,
    badgeFont,
    badgeMaxWidth - badgeHorizontalPadding,
    badgeLetterSpacing
  );
  const badgeWidth = Math.max(
    44,
    Math.min(
      badgeMaxWidth,
      Math.ceil(
        measureTextWidth(
          String(resolvedBadge || "").toUpperCase(),
          badgeFont,
          badgeLetterSpacing
        ) + badgeHorizontalPadding
      )
    )
  );
  const icon = isCollapsed ? "+" : "-";
  const textLeftPadding = 18;
  const textRightPadding = hasChildren ? 28 : 18;
  const textX = node.x + textLeftPadding;
  const titleWidth = NODE_WIDTH - textLeftPadding - textRightPadding;
  const titleMarkup = renderNodeTitle(node, textX, node.y + 48, titleWidth);
  const tooltip = escapeHtml(
    [
      node.label || "",
      node.metadataType || ""
    ].filter(Boolean).join(" | ")
  );

  const outline = isSelected
    ? '<rect class="selected-outline" x="' + (node.x - 4) + '" y="' + (node.y - 4) + '" rx="18" ry="18" width="' + (NODE_WIDTH + 8) + '" height="' + (NODE_HEIGHT + 8) + '"></rect>'
    : "";

  const toggle = hasChildren
    ? (
      '<g class="toggle-hitbox" data-toggle-key="' + escapeAttribute(node.key) + '">' +
        '<circle class="toggle-circle" cx="' + (node.x + NODE_WIDTH - 16) + '" cy="' + (node.y + NODE_HEIGHT / 2) + '" r="11"></circle>' +
        '<text x="' + (node.x + NODE_WIDTH - 16) + '" y="' + (node.y + NODE_HEIGHT / 2 + 4) + '" text-anchor="middle" fill="white" font-size="15" font-weight="700">' + icon + "</text>" +
      "</g>"
    )
    : "";

  return (
    '<g class="node-card">' +
      outline +
      '<g class="node-body" data-node-key="' + escapeAttribute(node.key) + '">' +
        "<title>" + tooltip + "</title>" +
        '<rect x="' + node.x + '" y="' + node.y + '" rx="16" ry="16" width="' + NODE_WIDTH + '" height="' + NODE_HEIGHT + '" fill="' + color + '"></rect>' +
        '<rect x="' + (node.x + 14) + '" y="' + (node.y + 12) + '" rx="9" ry="9" width="' + badgeWidth + '" height="20" fill="rgba(255,255,255,0.15)"></rect>' +
        '<text class="node-badge" x="' + (node.x + 24) + '" y="' + (node.y + 26) + '">' + escapeHtml(resolvedBadge) + "</text>" +
        titleMarkup +
      "</g>" +
      toggle +
    "</g>"
  );
}

function findNodeByKey(node, key) {
  if (!node || !key) {
    return null;
  }

  if (node.key === key) {
    return node;
  }

  for (const child of node.children || []) {
    const match = findNodeByKey(child, key);
    if (match) {
      return match;
    }
  }

  return null;
}

function isDescendantKey(ancestorKey, descendantKey) {
  return descendantKey === ancestorKey || descendantKey.startsWith(ancestorKey + ".");
}

function renderNodeTitle(node, x, y, width) {
  const label = String(node.label || "");

  if (node.kind === "customField" && label.includes(".")) {
    const separatorIndex = label.lastIndexOf(".");
    const parentName = label.slice(0, separatorIndex);
    const childName = label.slice(separatorIndex + 1);

    return (
      '<foreignObject class="node-title-fo" x="' + x + '" y="' + y + '" width="' + width + '" height="34">' +
        '<div xmlns="http://www.w3.org/1999/xhtml" class="node-title-block is-field">' +
          '<div class="node-title-primary">' + escapeHtml(childName) + "</div>" +
          '<div class="node-title-secondary">' + escapeHtml(parentName) + "</div>" +
        "</div>" +
      "</foreignObject>"
    );
  }

  return (
    '<foreignObject class="node-title-fo" x="' + x + '" y="' + y + '" width="' + width + '" height="34">' +
      '<div xmlns="http://www.w3.org/1999/xhtml" class="node-title-block">' +
        '<div class="node-title-primary">' + escapeHtml(label) + "</div>" +
      "</div>" +
    "</foreignObject>"
  );
}

function getNodeFont(className) {
  const fontFamily = getComputedStyle(document.body).fontFamily || "sans-serif";
  if (className === "node-badge") {
    return "700 10px " + fontFamily;
  }
  if (className === "node-subtitle") {
    return "600 11px " + fontFamily;
  }
  return "700 13px " + fontFamily;
}

function getNodeLetterSpacing(className) {
  if (className === "node-badge") {
    return 0.5;
  }
  return 0;
}

function getTextMeasureContext() {
  if (!textMeasureContext) {
    textMeasureContext = document.createElement("canvas").getContext("2d");
  }
  return textMeasureContext;
}

function measureTextWidth(value, font, letterSpacing = 0) {
  const context = getTextMeasureContext();
  const normalized = String(value || "");
  context.font = font;
  const baseWidth = context.measureText(normalized).width;
  return baseWidth + Math.max(0, normalized.length - 1) * letterSpacing;
}

function trimTextToWidth(value, font, maxWidth, letterSpacing = 0) {
  const normalized = String(value || "");
  if (!normalized || measureTextWidth(normalized, font, letterSpacing) <= maxWidth) {
    return normalized;
  }

  const ellipsis = "...";
  let low = 0;
  let high = normalized.length;
  let best = "";

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = normalized.slice(0, mid).trimEnd();
    if (measureTextWidth(candidate + ellipsis, font, letterSpacing) <= maxWidth) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best ? best + ellipsis : ellipsis;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/\x60/g, "&#96;");
}
