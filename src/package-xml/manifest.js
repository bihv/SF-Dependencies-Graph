"use strict";

const {
  DEFAULT_PACKAGE_API_VERSION,
  PACKAGE_TYPE_BY_KIND,
  PACKAGE_TYPE_COMMENTS
} = require("./constants");
const { escapeXml, escapeXmlComment } = require("./xml");

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

module.exports = {
  buildPackageXml,
  collectManifestMembers,
  normalizeApiVersion,
  normalizeMemberName
};
