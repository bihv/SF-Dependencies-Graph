"use strict";

const path = require("path");
const vscode = require("vscode");
const { analyzeSelection } = require("./analyzer");
const { showDependenciesMindmap } = require("./webview");

function activate(context) {
  const disposable = vscode.commands.registerCommand(
    "sfDependenciesGraph.analyzeSelection",
    async (resourceUri) => {
      try {
        const targetUri = resourceUri || vscode.window.activeTextEditor?.document?.uri;

        if (!targetUri || targetUri.scheme !== "file") {
          vscode.window.showErrorMessage(
            "Select a Salesforce metadata file or bundle in Explorer, or open a file in the editor first."
          );
          return;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetUri);
        if (!workspaceFolder) {
          vscode.window.showErrorMessage(
            "The selected file is not inside an open workspace folder."
          );
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Analyzing Salesforce dependencies",
            cancellable: false
          },
          async (progress) => {
            progress.report({ message: "Scanning metadata index..." });

            const result = await analyzeSelection({
              vscodeApi: vscode,
              workspaceFolder,
              targetUri,
              progress
            });

            const outputDir = path.join(
              workspaceFolder.uri.fsPath,
              ".sf-dependencies-graph"
            );

            await vscode.workspace.fs.createDirectory(vscode.Uri.file(outputDir));

            const safeName = result.root.label.replace(/[^a-z0-9._-]+/gi, "_");
            const timestamp = new Date()
              .toISOString()
              .replace(/[:.]/g, "-");
            const outputPath = path.join(
              outputDir,
              `${safeName}-${timestamp}.dependencies.json`
            );

            const serialized = serializeAnalysisResult(result);

            await vscode.workspace.fs.writeFile(
              vscode.Uri.file(outputPath),
              Buffer.from(serialized, "utf8")
            );

            showDependenciesMindmap({
              extensionContext: context,
              analysis: result,
              exportPath: outputPath
            });

            vscode.window.showInformationMessage(
              `Dependency mindmap ready. JSON exported: ${path.basename(outputPath)}`
            );
          }
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown analysis error";
        vscode.window.showErrorMessage(`SF Dependencies Graph: ${message}`);
      }
    }
  );

  context.subscriptions.push(disposable);
}

function deactivate() {}

function serializeAnalysisResult(result) {
  try {
    return JSON.stringify(result);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new Error(
        "Analysis result is too large to serialize. The dependency graph is likely extremely dense."
      );
    }
    throw error;
  }
}

module.exports = {
  activate,
  deactivate
};
