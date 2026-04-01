"use strict";

const vscode = require("vscode");

let currentPanel = null;
let currentPayload = null;

function showDependenciesMindmap({ extensionContext, analysis, exportPath }) {
  const column = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.Beside;
  currentPayload = { analysis, exportPath };

  if (currentPanel) {
    currentPanel.reveal(column);
    currentPanel.title = `SF Dependencies Graph: ${analysis.root.label}`;
    postCurrentPayload();
    return;
  }

  currentPanel = vscode.window.createWebviewPanel(
    "sfDependenciesGraph.mindmap",
    `SF Dependencies Graph: ${analysis.root.label}`,
    column,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );

  currentPanel.onDidDispose(() => {
    currentPanel = null;
    currentPayload = null;
  });

  currentPanel.webview.onDidReceiveMessage(async (message) => {
    switch (message?.type) {
      case "ready":
        postCurrentPayload();
        break;
      case "openNode":
        await openPath(message.path);
        break;
      case "openExport":
        if (currentPayload?.exportPath) {
          await openPath(currentPayload.exportPath);
        }
        break;
      default:
        break;
    }
  }, null, extensionContext.subscriptions);

  currentPanel.webview.html = getWebviewHtml(currentPanel.webview);
  extensionContext.subscriptions.push(currentPanel);
}

function postCurrentPayload() {
  if (!currentPanel || !currentPayload) {
    return;
  }

  currentPanel.webview.postMessage({
    type: "setData",
    analysis: currentPayload.analysis,
    exportPath: currentPayload.exportPath
  });
}

async function openPath(fsPath) {
  if (!fsPath) {
    return;
  }

  const uri = vscode.Uri.file(fsPath);

  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type & vscode.FileType.Directory) {
      await vscode.commands.executeCommand("revealInExplorer", uri);
      return;
    }

    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: false
    });
  } catch (error) {
    vscode.window.showErrorMessage(`Unable to open path: ${fsPath}`);
  }
}

function getWebviewHtml(webview) {
  const nonce = getNonce();

  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    "img-src data:",
    "font-src data:"
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SF Dependencies Graph</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: var(--vscode-editor-background);
      --panel: color-mix(in srgb, var(--vscode-sideBar-background) 84%, transparent);
      --panel-strong: color-mix(in srgb, var(--vscode-editorWidget-background) 88%, transparent);
      --border: color-mix(in srgb, var(--vscode-editor-foreground) 16%, transparent);
      --text: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --accent: var(--vscode-textLink-foreground);
      --accent-soft: color-mix(in srgb, var(--vscode-textLink-foreground) 20%, transparent);
      --shadow: 0 14px 30px rgba(0, 0, 0, 0.12);
    }

    * {
      box-sizing: border-box;
    }

    html,
    body {
      height: 100vh;
      overflow: hidden;
    }

    body {
      margin: 0;
      font: 13px/1.5 var(--vscode-font-family);
      color: var(--text);
      background:
        radial-gradient(circle at top right, color-mix(in srgb, var(--accent) 12%, transparent), transparent 28%),
        linear-gradient(180deg, color-mix(in srgb, var(--bg) 88%, transparent), var(--bg));
      min-height: 100vh;
    }

    .app {
      display: grid;
      grid-template-columns: minmax(260px, 320px) 1fr;
      height: 100vh;
      overflow: hidden;
    }

    .sidebar {
      border-right: 1px solid var(--border);
      background: var(--panel);
      backdrop-filter: blur(12px);
      padding: 18px 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      min-height: 0;
      overflow: auto;
    }

    .canvas-shell {
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 14px 18px;
      border-bottom: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel-strong) 92%, transparent);
      backdrop-filter: blur(10px);
      position: sticky;
      top: 0;
      z-index: 10;
    }

    .canvas {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 20px;
    }

    .section {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 14px;
      border: 1px solid var(--border);
      border-radius: 16px;
      background: color-mix(in srgb, var(--panel-strong) 82%, transparent);
      box-shadow: var(--shadow);
    }

    .eyebrow {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
    }

    .root-title {
      font-size: 22px;
      line-height: 1.15;
      font-weight: 700;
      word-break: break-word;
    }

    .root-type {
      color: var(--muted);
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .stat {
      padding: 10px 12px;
      border-radius: 12px;
      background: color-mix(in srgb, var(--accent) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent);
    }

    .stat strong {
      display: block;
      font-size: 18px;
      line-height: 1.1;
    }

    .actions,
    .legend,
    .warnings,
    .assumptions {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .toolbar-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    button {
      border: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel-strong) 86%, transparent);
      color: var(--text);
      padding: 8px 12px;
      border-radius: 999px;
      cursor: pointer;
      font: inherit;
      transition: background 120ms ease, border-color 120ms ease, transform 120ms ease;
    }

    button:hover:not(:disabled) {
      background: color-mix(in srgb, var(--accent) 14%, transparent);
      border-color: color-mix(in srgb, var(--accent) 34%, transparent);
      transform: translateY(-1px);
    }

    button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .ghost-link {
      color: var(--accent);
      text-decoration: none;
      cursor: pointer;
    }

    .ghost-link:hover {
      text-decoration: underline;
    }

    .selected-card {
      padding: 12px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel-strong) 88%, transparent);
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-height: 124px;
    }

    .selected-path {
      font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
      font-size: 12px;
      word-break: break-word;
      color: var(--muted);
    }

    .list {
      margin: 0;
      padding-left: 18px;
      color: var(--muted);
    }

    .list li + li {
      margin-top: 6px;
    }

    .legend-row {
      display: grid;
      grid-template-columns: 14px 1fr;
      gap: 10px;
      align-items: center;
      color: var(--muted);
    }

    .legend-swatch {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      border: 1px solid rgba(255, 255, 255, 0.12);
    }

    .canvas-empty {
      display: none;
      padding: 24px;
      color: var(--muted);
    }

    svg {
      display: block;
      min-width: 100%;
    }

    .node-card {
      filter: drop-shadow(0 10px 18px rgba(0, 0, 0, 0.12));
    }

    .node-body {
      cursor: pointer;
      transition: transform 120ms ease, stroke-width 120ms ease;
    }

    .node-body:hover {
      transform: translateY(-1px);
    }

    .node-title {
      font-size: 13px;
      font-weight: 700;
      fill: #ffffff;
    }

    .node-meta {
      font-size: 11px;
      fill: rgba(255, 255, 255, 0.82);
    }

    .node-badge {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.05em;
      fill: rgba(255, 255, 255, 0.94);
      text-transform: uppercase;
    }

    .toggle-hitbox {
      cursor: pointer;
    }

    .toggle-circle {
      fill: rgba(255, 255, 255, 0.18);
      stroke: rgba(255, 255, 255, 0.32);
      stroke-width: 1.2;
    }

    .toggle-mark {
      stroke: white;
      stroke-width: 1.8;
      stroke-linecap: round;
    }

    .connector {
      fill: none;
      stroke: color-mix(in srgb, var(--accent) 48%, var(--text) 22%);
      stroke-opacity: 0.72;
      stroke-width: 2;
    }

    .connector.low-confidence {
      stroke-dasharray: 6 5;
      stroke-opacity: 0.46;
    }

    .selected-outline {
      fill: none;
      stroke: #ffffff;
      stroke-width: 2.5;
      stroke-opacity: 0.82;
    }

    @media (max-width: 980px) {
      html,
      body {
        height: auto;
        overflow: auto;
      }

      .app {
        grid-template-columns: 1fr;
        height: auto;
        overflow: visible;
      }

      .sidebar {
        border-right: 0;
        border-bottom: 1px solid var(--border);
        min-height: auto;
        overflow: visible;
      }

      .canvas-shell {
        min-height: auto;
        overflow: visible;
      }

      .canvas {
        min-height: 60vh;
      }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <section class="section">
        <div class="eyebrow">Root Selection</div>
        <div class="root-title" id="rootTitle"></div>
        <div class="root-type" id="rootType"></div>
      </section>

      <section class="section">
        <div class="eyebrow">Graph Summary</div>
        <div class="stats">
          <div class="stat"><span>Nodes</span><strong id="nodeCount"></strong></div>
          <div class="stat"><span>Edges</span><strong id="edgeCount"></strong></div>
          <div class="stat"><span>Depth</span><strong id="maxDepth"></strong></div>
          <div class="stat"><span>Warnings</span><strong id="warningCount"></strong></div>
        </div>
      </section>

      <section class="section actions">
        <div class="eyebrow">Actions</div>
        <div class="toolbar-actions">
          <button id="expandAllBtn">Expand all</button>
          <button id="collapseAllBtn">Collapse branches</button>
        </div>
        <div class="toolbar-actions">
          <button id="openNodeBtn" disabled>Open selected</button>
          <button id="openExportBtn">Open JSON export</button>
        </div>
      </section>

      <section class="section">
        <div class="eyebrow">Selected Node</div>
        <div class="selected-card">
          <strong id="selectedLabel">No node selected</strong>
          <span id="selectedType" class="root-type"></span>
          <div id="selectedPath" class="selected-path"></div>
        </div>
      </section>

      <section class="section legend">
        <div class="eyebrow">Legend</div>
        <div id="legendRows"></div>
        <div class="root-type">Dashed connectors indicate low-confidence heuristic matches.</div>
      </section>

      <section class="section warnings">
        <div class="eyebrow">Warnings</div>
        <ul id="warningList" class="list"></ul>
      </section>

      <section class="section assumptions">
        <div class="eyebrow">Assumptions</div>
        <ul id="assumptionList" class="list"></ul>
      </section>
    </aside>

    <main class="canvas-shell">
      <div class="topbar">
        <div>
          <strong>Dependency Mindmap</strong>
          <div class="root-type">Click a node to inspect it. Use the +/- circle to expand or collapse its branch.</div>
        </div>
        <div class="toolbar-actions">
          <button id="focusRootBtn">Focus root</button>
        </div>
      </div>
      <div class="canvas" id="canvas">
        <svg id="mindmap" role="img" aria-label="Salesforce dependency mindmap"></svg>
        <div class="canvas-empty" id="emptyState">No dependency nodes were returned for this selection.</div>
      </div>
    </main>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let analysis = null;
    let exportPath = null;
    let edgeByPair = new Map();

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

    const NODE_WIDTH = 230;
    const NODE_HEIGHT = 72;
    const HORIZONTAL_GAP = 90;
    const VERTICAL_GAP = 20;
    const PADDING_X = 40;
    const PADDING_Y = 34;

    const savedState = vscode.getState() || {};
    let tree = null;
    const state = {
      selectedKey: savedState.selectedKey || null,
      collapsed: new Set(savedState.collapsed || [])
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
      selectedLabel: document.getElementById("selectedLabel"),
      selectedType: document.getElementById("selectedType"),
      selectedPath: document.getElementById("selectedPath"),
      warningList: document.getElementById("warningList"),
      assumptionList: document.getElementById("assumptionList"),
      legendRows: document.getElementById("legendRows"),
      openNodeBtn: document.getElementById("openNodeBtn"),
      openExportBtn: document.getElementById("openExportBtn")
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
      state.selectedKey = tree?.key || null;
      render();
      scrollToSelected();
    });

    elements.openNodeBtn.addEventListener("click", () => {
      const node = findNodeByKey(tree, state.selectedKey);
      if (node?.path) {
        vscode.postMessage({ type: "openNode", path: node.path });
      }
    });

    elements.openExportBtn.addEventListener("click", () => {
      if (exportPath) {
        vscode.postMessage({ type: "openExport" });
      }
    });

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message?.type !== "setData") {
        return;
      }

      analysis = message.analysis || null;
      exportPath = message.exportPath || null;
      edgeByPair = new Map(
        (analysis?.graph?.edges || []).map((edge) => [
          edge.from + "->" + edge.to,
          edge
        ])
      );
      tree = hydrateTree(analysis?.tree || null);
      state.selectedKey = tree?.key || null;
      state.collapsed = new Set(defaultCollapsedKeys(tree));
      renderStaticMeta();
      render();
    });

    vscode.postMessage({ type: "ready" });
    renderStaticMeta();
    render();

    function renderStaticMeta() {
      elements.rootTitle.textContent = analysis?.root?.label || "Waiting for analysis";
      elements.rootType.textContent = analysis?.root?.metadataType || "";
      elements.nodeCount.textContent = String(analysis?.summary?.nodeCount || 0);
      elements.edgeCount.textContent = String(analysis?.summary?.edgeCount || 0);
      elements.maxDepth.textContent = String(analysis?.summary?.maxDepth || 0);
      elements.warningCount.textContent = String((analysis?.warnings || []).length);

      renderList(elements.warningList, analysis?.warnings || ["No warnings"]);
      renderList(elements.assumptionList, analysis?.assumptions || []);
      renderLegend();
    }

    function render() {
      const selectedNode = findNodeByKey(tree, state.selectedKey) || tree;
      if (selectedNode) {
        state.selectedKey = selectedNode.key;
      }

      elements.selectedLabel.textContent = selectedNode?.label || "No node selected";
      elements.selectedType.textContent = selectedNode?.metadataType || "";
      elements.selectedPath.textContent = selectedNode?.path || "";
      elements.openNodeBtn.disabled = !selectedNode?.path;
      elements.openExportBtn.disabled = !exportPath;

      if (!analysis || !tree) {
        elements.svg.innerHTML = "";
        elements.empty.style.display = analysis ? "block" : "none";
        return;
      }

      elements.empty.style.display = "none";

      const measured = measureTree(tree, 0);
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
          const node = findNodeByKey(tree, element.getAttribute("data-node-key"));
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
        collapsed: Array.from(state.collapsed)
      });
    }

    function scrollToSelected() {
      const selected = document.querySelector('[data-node-key="' + CSS.escape(state.selectedKey) + '"]');
      if (selected) {
        selected.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
      }
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
      const kinds = Array.from(
        new Map((analysis?.graph?.nodes || []).map((node) => [node.kind, node.metadataType])).entries()
      );

      elements.legendRows.innerHTML = kinds
        .map(([kind, metadataType]) => {
          const color = KIND_COLORS[kind] || "#888888";
          return (
            '<div class="legend-row">' +
              '<span class="legend-swatch" style="background:' + color + '"></span>' +
              "<span>" + escapeHtml(metadataType || kind) + "</span>" +
            "</div>"
          );
        })
        .join("");
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
      const resolvedBadge = node.reference ? "Ref" : badge;
      const icon = isCollapsed ? "+" : "-";

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
            '<rect x="' + node.x + '" y="' + node.y + '" rx="16" ry="16" width="' + NODE_WIDTH + '" height="' + NODE_HEIGHT + '" fill="' + color + '"></rect>' +
            '<rect x="' + (node.x + 14) + '" y="' + (node.y + 12) + '" rx="9" ry="9" width="86" height="20" fill="rgba(255,255,255,0.15)"></rect>' +
            '<text class="node-badge" x="' + (node.x + 24) + '" y="' + (node.y + 26) + '">' + escapeHtml(resolvedBadge) + "</text>" +
            '<text class="node-title" x="' + (node.x + 18) + '" y="' + (node.y + 48) + '">' + escapeHtml(trimLabel(node.label, 26)) + "</text>" +
            '<text class="node-meta" x="' + (node.x + 18) + '" y="' + (node.y + 64) + '">' + escapeHtml(trimLabel(node.metadataType || "", 30)) + "</text>" +
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

    function trimLabel(value, max) {
      if (!value) {
        return "";
      }
      return value.length > max ? value.slice(0, max - 3) + "..." : value;
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
  </script>
</body>
</html>`;
}

function getNonce() {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";

  for (let index = 0; index < 32; index += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }

  return value;
}

module.exports = {
  showDependenciesMindmap
};
