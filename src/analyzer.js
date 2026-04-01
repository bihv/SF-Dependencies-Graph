"use strict";

const fs = require("fs");
const path = require("path");

const DIRECTORY_EXCLUSIONS = new Set([
  ".git",
  ".sf",
  ".sfdx",
  ".vscode",
  ".idea",
  "node_modules",
  ".sf-dependencies-graph",
  "coverage",
  "dist",
  "out",
  "tmp",
  "temp"
]);

const SUPPORTED_METADATA = [
  "LWC Bundle",
  "Aura Bundle",
  "Apex Class",
  "Apex Trigger",
  "Custom Label",
  "Custom Object",
  "Custom Field",
  "Custom Metadata Type",
  "Custom Metadata Record"
];

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

function walkFiles(rootDir) {
  const results = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (!DIRECTORY_EXCLUSIONS.has(entry.name)) {
          stack.push(fullPath);
        }
        continue;
      }

      results.push(fullPath);
    }
  }

  return results;
}

function buildIndex(workspaceRoot, files) {
  const index = {
    workspaceRoot,
    nodesById: new Map(),
    nodesByPath: new Map(),
    lwcByName: new Map(),
    auraByName: new Map(),
    apexByName: new Map(),
    triggersByName: new Map(),
    labelsByName: new Map(),
    objectsByName: new Map(),
    fieldsByQualifiedName: new Map(),
    customMetadataTypesByName: new Map(),
    customMetadataRecordsByName: new Map(),
    dependencies: new Map(),
    warnings: []
  };

  for (const filePath of files) {
    registerMetadataNode(index, filePath);
  }

  for (const node of index.nodesById.values()) {
    index.dependencies.set(node.id, extractDependencies(index, node));
  }

  return index;
}

function registerMetadataNode(index, filePath) {
  const relativePath = toRelative(index.workspaceRoot, filePath);
  const parts = relativePath.split(path.sep);
  const ext = path.extname(filePath);

  if (isLwcFile(parts, ext)) {
    const bundleName = parts[parts.length - 2];
    const bundleDir = path.dirname(filePath);
    const bundleId = `lwc:${bundleName}`;
    if (!index.nodesById.has(bundleId)) {
      const filesInBundle = fs
        .readdirSync(bundleDir)
        .map((name) => path.join(bundleDir, name))
        .filter((candidate) => fs.statSync(candidate).isFile());

      const node = {
        id: bundleId,
        kind: "lwcBundle",
        metadataType: "LWC Bundle",
        name: bundleName,
        label: bundleName,
        path: bundleDir,
        files: filesInBundle
      };
      saveNode(index, node);
      index.lwcByName.set(bundleName.toLowerCase(), node.id);
    }
    return;
  }

  if (isAuraFile(parts, ext)) {
    const bundleName = parts[parts.length - 2];
    const bundleDir = path.dirname(filePath);
    const bundleId = `aura:${bundleName}`;
    if (!index.nodesById.has(bundleId)) {
      const filesInBundle = fs
        .readdirSync(bundleDir)
        .map((name) => path.join(bundleDir, name))
        .filter((candidate) => fs.statSync(candidate).isFile());

      const node = {
        id: bundleId,
        kind: "auraBundle",
        metadataType: "Aura Bundle",
        name: bundleName,
        label: bundleName,
        path: bundleDir,
        files: filesInBundle
      };
      saveNode(index, node);
      index.auraByName.set(bundleName.toLowerCase(), node.id);
    }
    return;
  }

  if (ext === ".cls") {
    const name = path.basename(filePath, ".cls");
    const node = {
      id: `apexClass:${name}`,
      kind: "apexClass",
      metadataType: "Apex Class",
      name,
      label: name,
      path: filePath,
      files: [filePath]
    };
    saveNode(index, node);
    index.apexByName.set(name.toLowerCase(), node.id);
    return;
  }

  if (ext === ".trigger") {
    const name = path.basename(filePath, ".trigger");
    const node = {
      id: `apexTrigger:${name}`,
      kind: "apexTrigger",
      metadataType: "Apex Trigger",
      name,
      label: name,
      path: filePath,
      files: [filePath]
    };
    saveNode(index, node);
    index.triggersByName.set(name.toLowerCase(), node.id);
    return;
  }

  if (path.basename(filePath) === "CustomLabels.labels-meta.xml") {
    const content = safeRead(filePath);
    const labels = matchAll(content, /<fullName>([^<]+)<\/fullName>/g);
    for (const labelName of labels) {
      const node = {
        id: `customLabel:${labelName}`,
        kind: "customLabel",
        metadataType: "Custom Label",
        name: labelName,
        label: labelName,
        path: filePath,
        files: [filePath]
      };
      saveNode(index, node);
      index.labelsByName.set(labelName.toLowerCase(), node.id);
    }
    return;
  }

  if (isObjectDefinition(filePath, parts)) {
    const objectName = parts[parts.length - 2];
    const metadataType = objectName.endsWith("__mdt")
      ? "Custom Metadata Type"
      : "Custom Object";
    const kind = objectName.endsWith("__mdt")
      ? "customMetadataType"
      : "customObject";
    const idPrefix = objectName.endsWith("__mdt")
      ? "customMetadataType"
      : "customObject";
    const node = {
      id: `${idPrefix}:${objectName}`,
      kind,
      metadataType,
      name: objectName,
      label: objectName,
      path: filePath,
      files: [filePath]
    };
    saveNode(index, node);
    index.objectsByName.set(objectName.toLowerCase(), node.id);
    if (kind === "customMetadataType") {
      index.customMetadataTypesByName.set(objectName.toLowerCase(), node.id);
    }
    return;
  }

  if (isFieldDefinition(filePath, parts)) {
    const objectsIndex = parts.indexOf("objects");
    const objectName = objectsIndex >= 0 ? parts[objectsIndex + 1] : null;
    if (!objectName) {
      return;
    }
    const fieldName = path.basename(filePath, ".field-meta.xml");
    const qualifiedName = `${objectName}.${fieldName}`;
    const node = {
      id: `customField:${qualifiedName}`,
      kind: "customField",
      metadataType: "Custom Field",
      name: qualifiedName,
      label: qualifiedName,
      path: filePath,
      files: [filePath]
    };
    saveNode(index, node);
    index.fieldsByQualifiedName.set(qualifiedName.toLowerCase(), node.id);
    return;
  }

  if (isCustomMetadataRecord(filePath, parts)) {
    const recordName = path.basename(filePath, ".md-meta.xml");
    const typeName = recordName.includes(".")
      ? `${recordName.split(".")[0]}__mdt`
      : null;
    const node = {
      id: `customMetadataRecord:${recordName}`,
      kind: "customMetadataRecord",
      metadataType: "Custom Metadata Record",
      name: recordName,
      label: recordName,
      path: filePath,
      files: [filePath],
      typeName
    };
    saveNode(index, node);
    index.customMetadataRecordsByName.set(recordName.toLowerCase(), node.id);
  }
}

function saveNode(index, node) {
  index.nodesById.set(node.id, node);

  for (const filePath of node.files) {
    index.nodesByPath.set(normalizePath(filePath), node.id);
  }

  index.nodesByPath.set(normalizePath(node.path), node.id);
}

function extractDependencies(index, node) {
  switch (node.kind) {
    case "lwcBundle":
      return extractLwcDependencies(index, node);
    case "auraBundle":
      return extractAuraDependencies(index, node);
    case "apexClass":
      return extractApexDependencies(index, node, false);
    case "apexTrigger":
      return extractApexDependencies(index, node, true);
    case "customField":
      return extractFieldDependencies(index, node);
    case "customObject":
    case "customMetadataType":
      return extractObjectDependencies(index, node);
    case "customMetadataRecord":
      return extractCustomMetadataRecordDependencies(index, node);
    default:
      return [];
  }
}

function extractLwcDependencies(index, node) {
  const deps = [];
  const bundleText = joinNodeFiles(node);

  for (const specifier of matchAll(bundleText, /from\s+['"]c\/([a-zA-Z0-9_]+)['"]/g)) {
    addDependencyByName(index, deps, node, "lwc", specifier, {
      edgeType: "usesLwc",
      confidence: "high",
      source: "LWC import"
    });
  }

  for (const apexRef of matchAll(
    bundleText,
    /@salesforce\/apex\/(?:[a-zA-Z0-9_]+\.)?([a-zA-Z0-9_]+)\.[a-zA-Z0-9_]+/g
  )) {
    addDependencyByName(index, deps, node, "apex", apexRef, {
      edgeType: "callsApex",
      confidence: "high",
      source: "Apex import"
    });
  }

  for (const labelName of matchAll(
    bundleText,
    /@salesforce\/label\/c\.([a-zA-Z0-9_]+)/g
  )) {
    addDependencyByName(index, deps, node, "label", labelName, {
      edgeType: "usesLabel",
      confidence: "high",
      source: "Label import"
    });
  }

  for (const schemaRef of matchAll(
    bundleText,
    /@salesforce\/schema\/([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)?)/g
  )) {
    addSchemaDependency(index, deps, node, schemaRef, "LWC schema import");
  }

  return uniqueDependencies(deps);
}

function extractAuraDependencies(index, node) {
  const deps = [];
  const bundleText = joinNodeFiles(node);

  for (const componentName of matchAll(
    bundleText,
    /<(?:c|[a-zA-Z0-9_]+):([A-Z_a-z][a-zA-Z0-9_]*)\b/g
  )) {
    const matchedId =
      index.auraByName.get(componentName.toLowerCase()) ||
      index.lwcByName.get(componentName.toLowerCase());

    if (matchedId) {
      deps.push(
        createDependency(node.id, matchedId, "usesComponent", "high", "Aura markup")
      );
    }
  }

  for (const controllerName of matchAll(
    bundleText,
    /\bcontroller\s*=\s*"([A-Za-z_][A-Za-z0-9_]*)"/g
  )) {
    addDependencyByName(index, deps, node, "apex", controllerName, {
      edgeType: "usesApexController",
      confidence: "high",
      source: "Aura controller attribute"
    });
  }

  for (const labelName of matchAll(
    bundleText,
    /\$Label\.c\.([a-zA-Z0-9_]+)/g
  )) {
    addDependencyByName(index, deps, node, "label", labelName, {
      edgeType: "usesLabel",
      confidence: "high",
      source: "Aura label reference"
    });
  }

  return uniqueDependencies(deps);
}

function extractApexDependencies(index, node, isTrigger) {
  const deps = [];
  const source = stripCommentsAndStrings(joinNodeFiles(node));

  if (isTrigger) {
    const triggerObject = matchFirst(source, /\btrigger\s+\w+\s+on\s+([A-Za-z0-9_]+)\s*\(/);
    if (triggerObject) {
      addSchemaDependency(index, deps, node, triggerObject, "Trigger target object");
    }
  }

  for (const labelName of matchAll(
    source,
    /\b(?:System\.)?Label\.([a-zA-Z0-9_]+)/g
  )) {
    addDependencyByName(index, deps, node, "label", labelName, {
      edgeType: "usesLabel",
      confidence: "high",
      source: "Apex label reference"
    });
  }

  for (const objectName of matchAll(source, /\b([A-Za-z][A-Za-z0-9_]*__(?:c|mdt))\b/g)) {
    addSchemaDependency(index, deps, node, objectName, "Apex custom schema token");
  }

  for (const fieldRef of matchAll(
    source,
    /\b([A-Za-z][A-Za-z0-9_]*__(?:c|mdt)\.[A-Za-z][A-Za-z0-9_]*__(?:c|r))\b/g
  )) {
    addSchemaDependency(index, deps, node, fieldRef, "Apex field token");
  }

  const apexNames = [...index.apexByName.keys()]
    .map((name) => index.nodesById.get(index.apexByName.get(name)).name)
    .filter((name) => name !== node.name)
    .sort((left, right) => right.length - left.length);

  for (const candidate of apexNames) {
    const regex = new RegExp(`\\b${escapeRegex(candidate)}\\b`, "g");
    if (regex.test(source)) {
      addDependencyByName(index, deps, node, "apex", candidate, {
        edgeType: "referencesApex",
        confidence: "low",
        source: "Apex identifier match"
      });
    }
  }

  return uniqueDependencies(deps);
}

function extractFieldDependencies(index, node) {
  const deps = [];
  const xml = safeRead(node.path);

  const referenceTos = matchAll(xml, /<referenceTo>([^<]+)<\/referenceTo>/g);
  for (const referenceTo of referenceTos) {
    addSchemaDependency(index, deps, node, referenceTo, "Field referenceTo");
  }

  const formula = matchFirst(xml, /<formula>([\s\S]*?)<\/formula>/);
  if (formula) {
    for (const token of matchAll(formula, /\b([A-Za-z][A-Za-z0-9_]*__(?:c|mdt))\b/g)) {
      addSchemaDependency(index, deps, node, token, "Field formula token");
    }
    for (const token of matchAll(
      formula,
      /\b([A-Za-z][A-Za-z0-9_]*__(?:c|mdt)\.[A-Za-z][A-Za-z0-9_]*__c)\b/g
    )) {
      addSchemaDependency(index, deps, node, token, "Field formula field token");
    }
  }

  return uniqueDependencies(deps);
}

function extractObjectDependencies(index, node) {
  const deps = [];
  const qualifiedPrefix = `${node.name.toLowerCase()}.`;

  for (const [fieldQualifiedName, fieldId] of index.fieldsByQualifiedName.entries()) {
    if (fieldQualifiedName.startsWith(qualifiedPrefix)) {
      deps.push(
        createDependency(node.id, fieldId, "containsField", "high", "Object child field")
      );
    }
  }

  return uniqueDependencies(deps);
}

function extractCustomMetadataRecordDependencies(index, node) {
  const deps = [];

  if (node.typeName) {
    addDependencyByName(index, deps, node, "object", node.typeName, {
      edgeType: "belongsToType",
      confidence: "high",
      source: "Custom metadata record naming"
    });
  }

  return uniqueDependencies(deps);
}

function addSchemaDependency(index, deps, node, token, source) {
  const normalized = token.toLowerCase();
  const fieldId = index.fieldsByQualifiedName.get(normalized);
  if (fieldId) {
    deps.push(createDependency(node.id, fieldId, "usesField", "high", source));
    return;
  }

  const objectId =
    index.objectsByName.get(normalized) ||
    index.customMetadataTypesByName.get(normalized);
  if (objectId) {
    deps.push(createDependency(node.id, objectId, "usesObject", "high", source));
    return;
  }
}

function addDependencyByName(index, deps, node, registry, rawName, options) {
  const normalized = rawName.toLowerCase();
  const registries = {
    lwc: index.lwcByName,
    aura: index.auraByName,
    apex: index.apexByName,
    label: index.labelsByName,
    object: index.objectsByName
  };
  const map = registries[registry];
  if (!map) {
    return;
  }

  const targetId = map.get(normalized);
  if (!targetId) {
    return;
  }

  deps.push(
    createDependency(
      node.id,
      targetId,
      options.edgeType,
      options.confidence,
      options.source
    )
  );
}

function createDependency(from, to, type, confidence, source) {
  return {
    from,
    to,
    type,
    confidence,
    source
  };
}

function uniqueDependencies(deps) {
  const seen = new Set();
  return deps.filter((dep) => {
    const key = `${dep.from}|${dep.to}|${dep.type}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function resolveTargetNode(index, selectedPath) {
  let currentPath = normalizePath(selectedPath);
  const stats = fs.existsSync(currentPath) ? fs.statSync(currentPath) : null;

  if (!stats) {
    return null;
  }

  if (stats.isFile()) {
    const byFile = index.nodesByPath.get(currentPath);
    if (byFile) {
      return index.nodesById.get(byFile) || null;
    }
  }

  if (stats.isDirectory()) {
    const byDir = index.nodesByPath.get(currentPath);
    if (byDir) {
      return index.nodesById.get(byDir) || null;
    }

    const entries = fs.readdirSync(currentPath).map((name) => normalizePath(path.join(currentPath, name)));
    for (const entry of entries) {
      const match = index.nodesByPath.get(entry);
      if (match) {
        return index.nodesById.get(match) || null;
      }
    }
  }

  while (currentPath !== path.dirname(currentPath)) {
    currentPath = normalizePath(path.dirname(currentPath));
    const match = index.nodesByPath.get(currentPath);
    if (match) {
      return index.nodesById.get(match) || null;
    }
  }

  return null;
}

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

function sanitizeNode(node) {
  return {
    id: node.id,
    kind: node.kind,
    metadataType: node.metadataType,
    name: node.name,
    label: node.label,
    path: node.path
  };
}

function joinNodeFiles(node) {
  return node.files
    .map((filePath) => safeRead(filePath))
    .join("\n");
}

function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return "";
  }
}

function stripCommentsAndStrings(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, " ")
    .replace(/'(?:\\.|[^'\\])*'/g, " ")
    .replace(/`(?:\\.|[^`\\])*`/g, " ");
}

function matchAll(text, regex) {
  const matches = [];
  for (const match of text.matchAll(regex)) {
    matches.push(match[1]);
  }
  return matches;
}

function matchFirst(text, regex) {
  const match = text.match(regex);
  return match ? match[1] : null;
}

function toRelative(root, target) {
  return path.relative(root, target);
}

function normalizePath(value) {
  return path.normalize(value);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isLwcFile(parts, ext) {
  return parts.includes("lwc") && [".js", ".html", ".css", ".xml"].includes(ext);
}

function isAuraFile(parts, ext) {
  return (
    parts.includes("aura") &&
    [
      ".cmp",
      ".app",
      ".evt",
      ".intf",
      ".design",
      ".auradoc",
      ".css",
      ".js",
      ".svg",
      ".xml"
    ].includes(ext)
  );
}

function isObjectDefinition(filePath, parts) {
  return (
    parts.includes("objects") &&
    path.basename(filePath).endsWith(".object-meta.xml")
  );
}

function isFieldDefinition(filePath, parts) {
  return (
    parts.includes("objects") &&
    parts.includes("fields") &&
    path.basename(filePath).endsWith(".field-meta.xml")
  );
}

function isCustomMetadataRecord(filePath, parts) {
  return (
    parts.includes("customMetadata") &&
    path.basename(filePath).endsWith(".md-meta.xml")
  );
}

module.exports = {
  analyzeSelection,
  buildIndex,
  resolveTargetNode,
  traverseDependencies,
  buildTree
};
