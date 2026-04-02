"use strict";

const { SUPPORTED_METADATA } = require("./analyzer/constants");
const { buildTree, traverseDependencies } = require("./analyzer/graph");
const {
  buildIndex,
  resolveTargetNode,
  walkFiles
} = require("./analyzer/indexing");
const { sanitizeNode } = require("./analyzer/utils");

async function analyzeSelection({ workspaceFolder, targetUri, progress }) {
  const workspaceRoot = workspaceFolder.uri.fsPath;
  const files = walkFiles(workspaceRoot);
  progress.report({ message: `Indexing ${files.length} files...` });

  const index = buildIndex(workspaceRoot, files);
  progress.report({ message: "Resolving selected metadata..." });

  const rootNode = resolveTargetNode(index, targetUri.fsPath);
  if (!rootNode) {
    throw new Error(
      [
        "Unsupported selection.",
        "Phase 1 currently supports:",
        SUPPORTED_METADATA.join(", ")
      ].join(" ")
    );
  }

  progress.report({ message: "Building dependency graph..." });
  const graph = traverseDependencies(index, rootNode.id);
  const tree = buildTree(graph.rootId, graph.adjacency, graph.nodesById);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    workspaceRoot,
    root: sanitizeNode(graph.nodesById.get(graph.rootId)),
    summary: {
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      maxDepth: tree.maxDepth,
      supportedMetadata: SUPPORTED_METADATA
    },
    assumptions: [
      "Static analysis only. Dynamic references may be missing.",
      "Dependencies marked confidence=low are heuristic matches and should be manually reviewed before deployment.",
      "Only downward dependencies from the selected file or bundle are included in phase 1."
    ],
    warnings: graph.warnings,
    graph: {
      nodes: graph.nodes.map(sanitizeNode),
      edges: graph.edges
    },
    tree: tree.node
  };
}

module.exports = {
  analyzeSelection,
  buildIndex,
  resolveTargetNode,
  traverseDependencies,
  buildTree
};
