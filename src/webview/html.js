"use strict";

const vscode = require("vscode");

function getWebviewHtml(webview, extensionUri) {
  const mediaRoot = vscode.Uri.joinPath(extensionUri, "src", "webview", "media");
  const stylesUri = webview.asWebviewUri(
    vscode.Uri.joinPath(mediaRoot, "styles.css")
  );
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(mediaRoot, "app.js")
  );

  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource} data:`
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SF Dependencies Graph</title>
  <link rel="stylesheet" href="${stylesUri}" />
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
          <button id="openPackageBtn">Open package.xml</button>
        </div>
      </section>

      <section class="section">
        <div class="eyebrow">Selected Node</div>
        <div class="selected-card">
          <strong id="selectedLabel">No node selected</strong>
          <span id="selectedType" class="root-type"></span>
          <div id="selectedPath" class="selected-path"></div>
          <div class="toolbar-actions">
            <button id="jumpToOriginalBtn" disabled>Jump to original</button>
          </div>
        </div>
      </section>

      <section class="section legend">
        <div class="eyebrow">Legend</div>
        <div class="toolbar-actions">
          <button id="showAllTypesBtn">All types</button>
          <button id="showRootOnlyBtn">Only root</button>
        </div>
        <div id="legendRows" class="legend-rows"></div>
        <div class="root-type" id="typeFilterSummary"></div>
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

  <script src="${scriptUri}"></script>
</body>
</html>`;
}

module.exports = {
  getWebviewHtml
};
