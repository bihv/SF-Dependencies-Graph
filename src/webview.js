"use strict";

const vscode = require("vscode");
const { getWebviewHtml } = require("./webview/html");

let currentPanel = null;
let currentPayload = null;

function showDependenciesMindmap({ extensionContext, analysis, exportPath, packageXmlPath }) {
  const column = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.Beside;
  currentPayload = { analysis, exportPath, packageXmlPath };
  const mediaRoot = vscode.Uri.joinPath(
    extensionContext.extensionUri,
    "src",
    "webview",
    "media"
  );

  if (currentPanel) {
    currentPanel.reveal(column);
    currentPanel.title = `SF Dependencies Graph: ${analysis.root.label}`;
    currentPanel.webview.html = getWebviewHtml(
      currentPanel.webview,
      extensionContext.extensionUri
    );
    return;
  }

  currentPanel = vscode.window.createWebviewPanel(
    "sfDependenciesGraph.mindmap",
    `SF Dependencies Graph: ${analysis.root.label}`,
    column,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaRoot]
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
      case "openPackageXml":
        if (currentPayload?.packageXmlPath) {
          await openPath(currentPayload.packageXmlPath);
        }
        break;
      default:
        break;
    }
  }, null, extensionContext.subscriptions);

  currentPanel.webview.html = getWebviewHtml(
    currentPanel.webview,
    extensionContext.extensionUri
  );
  extensionContext.subscriptions.push(currentPanel);
}

function postCurrentPayload() {
  if (!currentPanel || !currentPayload) {
    return;
  }

  currentPanel.webview.postMessage({
    type: "setData",
    analysis: currentPayload.analysis,
    exportPath: currentPayload.exportPath,
    packageXmlPath: currentPayload.packageXmlPath
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

module.exports = {
  showDependenciesMindmap
};
