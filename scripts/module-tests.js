"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildTree } = require("../src/analyzer/graph");
const {
  DEFAULT_PACKAGE_API_VERSION
} = require("../src/package-xml/constants");
const {
  collectManifestMembers,
  buildPackageXml,
  normalizeApiVersion
} = require("../src/package-xml/manifest");
const {
  resolvePackageApiVersion
} = require("../src/package-xml/api-version");
const {
  escapeXml,
  escapeXmlComment
} = require("../src/package-xml/xml");

function main() {
  verifyManifestMemberCollection();
  verifyPackageXmlEscaping();
  verifyApiVersionHelpers();
  verifyBuildTreeReferenceHandling();

  console.log(
    JSON.stringify(
      {
        ok: true,
        checks: 4
      },
      null,
      2
    )
  );
}

function verifyManifestMemberCollection() {
  const membersByType = collectManifestMembers({
    graph: {
      nodes: [
        createManifestNode("lwcBundle", "orderSummary"),
        createManifestNode("lwcBundle", "orderSummary"),
        createManifestNode("customMetadataType", "App_Config__mdt"),
        createManifestNode("customMetadataRecord", "App_Config.Default"),
        createManifestNode("customField", "Invoice__c.Amount__c")
      ]
    }
  });

  assert(
    membersByType.get("LightningComponentBundle")?.has("orderSummary"),
    "Manifest collector should map LWC bundles"
  );
  assert(
    membersByType.get("CustomObject")?.has("App_Config__mdt"),
    "Manifest collector should map custom metadata types to CustomObject"
  );
  assert(
    membersByType.get("CustomMetadata")?.has("App_Config.Default"),
    "Manifest collector should map custom metadata records"
  );
  assert(
    membersByType.get("LightningComponentBundle").size === 1,
    "Manifest collector should deduplicate members"
  );
}

function verifyPackageXmlEscaping() {
  const xml = buildPackageXml(
    {
      graph: {
        nodes: [
          createManifestNode("customLabel", 'Label<&>"\''),
          createManifestNode("lwcBundle", "bundle")
        ]
      }
    },
    { apiVersion: "62.0" }
  );

  assert(
    xml.includes("<members>Label&lt;&amp;&gt;&quot;&apos;</members>"),
    "package.xml should escape member values"
  );
  assert(
    escapeXmlComment("a--b") === "a- -b",
    "XML comments should sanitize double dashes"
  );
  assert(
    escapeXml('A&B<>"\'') === "A&amp;B&lt;&gt;&quot;&apos;",
    "XML escaping helper should cover all reserved characters"
  );
}

function verifyApiVersionHelpers() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sf-deps-module-api-"));

  try {
    assert(normalizeApiVersion("64.0") === "64.0", "normalizeApiVersion should accept valid values");
    assert(normalizeApiVersion("invalid") === "", "normalizeApiVersion should reject invalid values");

    fs.writeFileSync(
      path.join(tempRoot, "sfdx-project.json"),
      JSON.stringify({ sourceApiVersion: "65.0" }, null, 2),
      "utf8"
    );
    assert(
      resolvePackageApiVersion(tempRoot) === "65.0",
      "resolvePackageApiVersion should read sfdx-project.json"
    );

    fs.writeFileSync(
      path.join(tempRoot, "sfdx-project.json"),
      JSON.stringify({ sourceApiVersion: "invalid" }, null, 2),
      "utf8"
    );
    assert(
      resolvePackageApiVersion(tempRoot) === DEFAULT_PACKAGE_API_VERSION,
      "Invalid sourceApiVersion should fall back to default"
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function verifyBuildTreeReferenceHandling() {
  const nodesById = new Map(
    [
      createGraphNode("root"),
      createGraphNode("left"),
      createGraphNode("right"),
      createGraphNode("shared")
    ].map((node) => [node.id, node])
  );
  const adjacency = new Map([
    ["root", ["left", "right"]],
    ["left", ["shared"]],
    ["right", ["shared"]],
    ["shared", []]
  ]);

  const tree = buildTree("root", adjacency, nodesById);
  const sharedReference = tree.node.children[1].children[0];

  assert(tree.maxDepth === 2, "buildTree should compute max depth");
  assert(sharedReference.reference === true, "Repeated nodes should become references");
  assert(sharedReference.children.length === 0, "Reference nodes should not duplicate children");
}

function createManifestNode(kind, name) {
  return {
    kind,
    name,
    label: name
  };
}

function createGraphNode(id) {
  return {
    id,
    kind: "apexClass",
    metadataType: "Apex Class",
    name: id,
    label: id,
    path: id
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

main();
