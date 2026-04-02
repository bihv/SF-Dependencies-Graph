"use strict";

const fs = require("fs");
const path = require("path");
const { DIRECTORY_EXCLUSIONS } = require("./constants");
const { extractDependencies } = require("./dependency-extractors");
const {
  getXmlTagValues,
  isAuraFile,
  isCustomMetadataRecord,
  isFieldDefinition,
  isLwcFile,
  isObjectDefinition,
  normalizePath,
  safeRead,
  saveNode,
  toRelative
} = require("./utils");

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
    warnings: [],
    warningKeys: new Set(),
    unresolvedReferences: new Map()
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
    const content = safeRead(index, filePath);
    const labels = getXmlTagValues(content, "fullName");
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

    const entries = fs
      .readdirSync(currentPath)
      .map((name) => normalizePath(path.join(currentPath, name)));
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

module.exports = {
  buildIndex,
  resolveTargetNode,
  walkFiles
};
