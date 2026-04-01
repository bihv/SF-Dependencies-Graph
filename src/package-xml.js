"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_PACKAGE_API_VERSION = "61.0";

const PACKAGE_TYPE_BY_KIND = Object.freeze({
  lwcBundle: "LightningComponentBundle",
  auraBundle: "AuraDefinitionBundle",
  apexClass: "ApexClass",
  apexTrigger: "ApexTrigger",
  customLabel: "CustomLabel",
  customObject: "CustomObject",
  customField: "CustomField",
  customMetadataType: "CustomObject",
  customMetadataRecord: "CustomMetadata"
});

const PACKAGE_TYPE_COMMENTS = Object.freeze({
  LightningComponentBundle: "LWC Bundles",
  AuraDefinitionBundle: "Aura Bundles",
  ApexClass: "Apex Classes",
  ApexTrigger: "Apex Triggers",
  CustomLabel: "Custom Labels",
  CustomObject: "Custom Objects and Custom Metadata Types",
  CustomField: "Custom Fields",
  CustomMetadata: "Custom Metadata Records"
});

function buildPackageXml(analysis, options = {}) {
  const apiVersion = normalizeApiVersion(options.apiVersion) || DEFAULT_PACKAGE_API_VERSION;
  const membersByType = collectManifestMembers(analysis);
  const types = Array.from(membersByType.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([typeName, members]) => ({
      typeName,
      members: Array.from(members).sort((left, right) => left.localeCompare(right))
    }));

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">'
  ];

  for (const type of types) {
    const comment = PACKAGE_TYPE_COMMENTS[type.typeName];
    if (comment) {
      lines.push(`    <!-- ${escapeXmlComment(comment)} -->`);
    }
    lines.push("    <types>");
    for (const member of type.members) {
      lines.push(`        <members>${escapeXml(member)}</members>`);
    }
    lines.push(`        <name>${type.typeName}</name>`);
    lines.push("    </types>");
  }

  lines.push(`    <version>${apiVersion}</version>`);
  lines.push("</Package>");

  return lines.join("\n");
}

function resolvePackageApiVersion(workspaceRoot) {
  if (!workspaceRoot) {
    return DEFAULT_PACKAGE_API_VERSION;
  }

  const projectFilePath = path.join(workspaceRoot, "sfdx-project.json");
  if (!fs.existsSync(projectFilePath)) {
    return DEFAULT_PACKAGE_API_VERSION;
  }

  try {
    const projectConfig = JSON.parse(fs.readFileSync(projectFilePath, "utf8"));
    return normalizeApiVersion(projectConfig.sourceApiVersion) || DEFAULT_PACKAGE_API_VERSION;
  } catch (error) {
    return DEFAULT_PACKAGE_API_VERSION;
  }
}

function collectManifestMembers(analysis) {
  const membersByType = new Map();
  const nodes = Array.isArray(analysis?.graph?.nodes) ? analysis.graph.nodes : [];

  for (const node of nodes) {
    const typeName = PACKAGE_TYPE_BY_KIND[node?.kind];
    const memberName = normalizeMemberName(node);

    if (!typeName || !memberName) {
      continue;
    }

    if (!membersByType.has(typeName)) {
      membersByType.set(typeName, new Set());
    }

    membersByType.get(typeName).add(memberName);
  }

  return membersByType;
}

function normalizeMemberName(node) {
  if (!node) {
    return "";
  }

  return String(node.name || node.label || "").trim();
}

function normalizeApiVersion(value) {
  const normalized = String(value || "").trim();
  return /^\d+\.\d+$/.test(normalized) ? normalized : "";
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeXmlComment(value) {
  return String(value).replace(/--/g, "- -").trim();
}

module.exports = {
  DEFAULT_PACKAGE_API_VERSION,
  buildPackageXml,
  resolvePackageApiVersion
};
