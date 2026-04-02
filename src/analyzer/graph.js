"use strict";

const {
  appendUnresolvedReferenceWarnings,
  sanitizeNode
} = require("./utils");

function traverseDependencies(index, rootId) {
  const visited = new Set();
  const nodes = [];
  const edges = [];
  const warnings = [...index.warnings];
  const adjacency = new Map();
  const queue = [{ id: rootId, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current.id)) {
      continue;
    }

    visited.add(current.id);
    const node = index.nodesById.get(current.id);
    if (!node) {
      warnings.push(`Missing node in index: ${current.id}`);
      continue;
    }

    nodes.push(node);
    const nodeDeps = index.dependencies.get(current.id) || [];
    adjacency.set(current.id, nodeDeps.map((dep) => dep.to));

    for (const dep of nodeDeps) {
      edges.push(dep);
      if (!visited.has(dep.to)) {
        queue.push({ id: dep.to, depth: current.depth + 1 });
      }
    }
  }

  appendUnresolvedReferenceWarnings(index, warnings, visited);

  const lowConfidenceEdges = edges.filter((edge) => edge.confidence === "low");
  if (lowConfidenceEdges.length > 0) {
    const lowConfidenceNodes = new Set(lowConfidenceEdges.map((edge) => edge.from));
    warnings.push(
      `Found ${lowConfidenceEdges.length} low-confidence heuristic edge${lowConfidenceEdges.length === 1 ? "" : "s"} across ${lowConfidenceNodes.size} node${lowConfidenceNodes.size === 1 ? "" : "s"}. Review dashed connectors before deployment.`
    );
  }

  return {
    rootId,
    nodes,
    edges,
    warnings,
    adjacency,
    nodesById: index.nodesById
  };
}

function buildTree(rootId, adjacency, nodesById) {
  let maxDepth = 0;
  const globallyExpanded = new Set();

  function visit(nodeId, depth, lineage) {
    maxDepth = Math.max(maxDepth, depth);
    const node = nodesById.get(nodeId);
    const children = [];
    const alreadyExpanded = globallyExpanded.has(nodeId);

    if (!node) {
      return {
        id: nodeId,
        kind: "unknown",
        metadataType: "Unknown",
        name: nodeId,
        label: nodeId,
        path: "",
        missing: true,
        children: []
      };
    }

    if (alreadyExpanded && depth > 0) {
      return {
        ...sanitizeNode(node),
        reference: true,
        children: []
      };
    }

    globallyExpanded.add(nodeId);
    const childIds = adjacency.get(nodeId) || [];

    for (const childId of childIds) {
      if (lineage.has(childId)) {
        const cycleNode = nodesById.get(childId);
        children.push({
          ...sanitizeNode(cycleNode),
          cycle: true,
          children: []
        });
        continue;
      }

      const nextLineage = new Set(lineage);
      nextLineage.add(childId);
      children.push(visit(childId, depth + 1, nextLineage));
    }

    return {
      ...sanitizeNode(node),
      children
    };
  }

  const node = visit(rootId, 0, new Set([rootId]));

  return {
    maxDepth,
    node
  };
}

module.exports = {
  buildTree,
  traverseDependencies
};
