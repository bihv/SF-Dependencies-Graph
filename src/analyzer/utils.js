"use strict";

const fs = require("fs");
const path = require("path");
const { XML_VALUE_PARSER } = require("./constants");

function saveNode(index, node) {
  index.nodesById.set(node.id, node);

  for (const filePath of node.files) {
    index.nodesByPath.set(normalizePath(filePath), node.id);
  }

  index.nodesByPath.set(normalizePath(node.path), node.id);
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

function safeRead(index, filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    pushWarning(
      index,
      `Could not read file: ${formatWarningPath(index, filePath)}${error && error.code ? ` (${error.code})` : ""}`
    );
    return "";
  }
}

function pushWarning(index, message) {
  if (!index || !message || index.warningKeys.has(message)) {
    return;
  }

  index.warningKeys.add(message);
  index.warnings.push(message);
}

function recordUnresolvedReference(index, node, category, rawName, source) {
  if (!index || !node || !rawName) {
    return;
  }

  const key = [node.id, category, source].join("|");
  let entry = index.unresolvedReferences.get(key);
  if (!entry) {
    entry = {
      nodeId: node.id,
      nodeLabel: node.label || node.name || node.id,
      category,
      source,
      names: new Set()
    };
    index.unresolvedReferences.set(key, entry);
  }

  entry.names.add(String(rawName));
}

function appendUnresolvedReferenceWarnings(index, warnings, visitedNodeIds) {
  const entries = [...index.unresolvedReferences.values()].sort((left, right) => {
    if (left.nodeLabel !== right.nodeLabel) {
      return left.nodeLabel.localeCompare(right.nodeLabel);
    }
    if (left.category !== right.category) {
      return left.category.localeCompare(right.category);
    }
    return left.source.localeCompare(right.source);
  });

  for (const entry of entries) {
    if (!visitedNodeIds.has(entry.nodeId)) {
      continue;
    }

    const names = [...entry.names].sort((left, right) => left.localeCompare(right));
    const preview = names.slice(0, 3).join(", ");
    const moreCount = Math.max(0, names.length - 3);
    const suffix = moreCount > 0 ? `, +${moreCount} more` : "";
    const referenceLabel = names.length === 1 ? "reference" : "references";

    warnings.push(
      `Unresolved ${entry.category} ${referenceLabel} from ${entry.nodeLabel} (${names.length}) via ${entry.source}: ${preview}${suffix}`
    );
  }
}

function matchAll(text, regex) {
  const matches = [];
  for (const match of text.matchAll(regex)) {
    matches.push(match[1]);
  }
  return matches;
}

function toRelative(root, target) {
  return path.relative(root, target);
}

function formatWarningPath(index, filePath) {
  if (!index?.workspaceRoot) {
    return filePath;
  }

  const relative = toRelative(index.workspaceRoot, filePath);
  if (!relative || relative.startsWith("..")) {
    return filePath;
  }

  return relative;
}

function normalizePath(value) {
  return path.normalize(value);
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

function getXmlTagValues(source, tagName) {
  if (!source || !tagName) {
    return [];
  }

  try {
    const document = XML_VALUE_PARSER.parse(source);
    const values = [];
    collectXmlTagValues(document, tagName, values);
    return values;
  } catch (error) {
    return [];
  }
}

function collectXmlTagValues(node, tagName, values) {
  if (!node || typeof node !== "object") {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectXmlTagValues(item, tagName, values);
    }
    return;
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === tagName) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string") {
            values.push(item);
          }
        }
      } else if (typeof value === "string") {
        values.push(value);
      }
    }

    collectXmlTagValues(value, tagName, values);
  }
}

function isIdentifier(value) {
  const normalized = String(value || "");
  if (!normalized) {
    return false;
  }

  const first = normalized.charCodeAt(0);
  if (!(isUppercaseLetter(first) || isLowercaseLetter(first) || normalized[0] === "_")) {
    return false;
  }

  for (let index = 1; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    if (
      !isUppercaseLetter(code) &&
      !isLowercaseLetter(code) &&
      !isDigit(code) &&
      normalized[index] !== "_"
    ) {
      return false;
    }
  }

  return true;
}

function isCustomObjectApiName(value) {
  return endsWithCustomSuffix(value, "__c") || endsWithCustomSuffix(value, "__mdt");
}

function isCustomFieldApiName(value) {
  return endsWithCustomSuffix(value, "__c") || endsWithCustomSuffix(value, "__r");
}

function endsWithCustomSuffix(value, suffix) {
  return (
    String(value || "").endsWith(suffix) &&
    isIdentifier(String(value || "").slice(0, -suffix.length))
  );
}

function isUppercaseLetter(code) {
  return code >= 65 && code <= 90;
}

function isLowercaseLetter(code) {
  return code >= 97 && code <= 122;
}

function isDigit(code) {
  return code >= 48 && code <= 57;
}

module.exports = {
  appendUnresolvedReferenceWarnings,
  formatWarningPath,
  getXmlTagValues,
  isAuraFile,
  isCustomFieldApiName,
  isCustomMetadataRecord,
  isCustomObjectApiName,
  isDigit,
  isFieldDefinition,
  isIdentifier,
  isLowercaseLetter,
  isLwcFile,
  isObjectDefinition,
  isUppercaseLetter,
  matchAll,
  normalizePath,
  pushWarning,
  recordUnresolvedReference,
  safeRead,
  sanitizeNode,
  saveNode,
  toRelative
};
