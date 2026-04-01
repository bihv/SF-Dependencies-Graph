"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { analyzeSelection, buildTree } = require("../src/analyzer");
const {
  DEFAULT_PACKAGE_API_VERSION,
  buildPackageXml,
  resolvePackageApiVersion
} = require("../src/package-xml");

async function main() {
  const workspaceRoot = path.join(__dirname, "..", "test-fixtures", "simple");
  const result = await runAnalysis(
    workspaceRoot,
    path.join("force-app", "main", "default", "lwc", "orderSummary")
  );

  assert(result.root.id === "lwc:orderSummary", "Root node should be orderSummary LWC");
  assert(
    result.graph.nodes.some((node) => node.id === "apexClass:OrderController"),
    "OrderController should be included"
  );
  assert(
    result.graph.nodes.some((node) => node.id === "apexClass:PaymentService"),
    "PaymentService should be included transitively"
  );
  assert(
    result.graph.nodes.some((node) => node.id === "customLabel:Order_Title"),
    "Custom label should be included"
  );
  assert(
    result.graph.nodes.some((node) => node.id === "customObject:Invoice__c"),
    "Custom object should be included"
  );
  assert(
    result.graph.nodes.some((node) => node.id === "customField:Invoice__c.Amount__c"),
    "Custom field should be included"
  );
  assert(
    result.graph.nodes.some((node) => node.id === "customMetadataType:App_Config__mdt"),
    "Custom metadata type should be included"
  );
  assert(
    result.graph.edges.some(
      (edge) =>
        edge.from === "apexClass:OrderController" &&
        edge.to === "apexClass:ItemService"
    ),
    "OrderController should reference ItemService"
  );
  assertWarningIncludes(
    result.warnings,
    "low-confidence heuristic edges",
    "Low-confidence heuristic warnings should be surfaced"
  );
  verifyPackageXml(result);
  await verifyPackageXmlForCustomMetadataRecord();

  verifyCompactTree();
  await verifyWarningAggregation();
  await verifyPackageApiVersionResolution();

  console.log(
    JSON.stringify(
      {
        summary: result.summary,
        root: result.root,
        warnings: result.warnings,
        sampleEdges: result.graph.edges.slice(0, 6)
      },
      null,
      2
    )
  );
}

function verifyCompactTree() {
  const nodesById = new Map(
    [
      createNode("root"),
      createNode("left"),
      createNode("right"),
      createNode("shared"),
      createNode("leaf")
    ].map((node) => [node.id, node])
  );
  const adjacency = new Map([
    ["root", ["left", "right"]],
    ["left", ["shared"]],
    ["right", ["shared"]],
    ["shared", ["leaf"]],
    ["leaf", []]
  ]);

  const tree = buildTree("root", adjacency, nodesById);
  const rightBranchShared = tree.node.children[1].children[0];

  assert(rightBranchShared.reference === true, "Repeated shared node should be emitted as a reference leaf");
  assert(
    rightBranchShared.children.length === 0,
    "Reference leaf should not duplicate the shared subtree"
  );
}

function verifyPackageXml(result) {
  const xml = buildPackageXml(result, { apiVersion: "62.0" });

  assert(
    xml.includes("<!-- LWC Bundles -->") &&
    xml.includes("<name>LightningComponentBundle</name>") &&
      xml.includes("<members>orderSummary</members>"),
    "LWC bundles should be included in package.xml"
  );
  assert(
    xml.includes("<!-- Apex Classes -->") &&
    xml.includes("<name>ApexClass</name>") &&
      xml.includes("<members>OrderController</members>") &&
      xml.includes("<members>PaymentService</members>"),
    "Apex classes should be included in package.xml"
  );
  assert(
    xml.includes("<!-- Custom Objects and Custom Metadata Types -->") &&
    xml.includes("<name>CustomObject</name>") &&
      xml.includes("<members>Invoice__c</members>") &&
      xml.includes("<members>App_Config__mdt</members>"),
    "Custom objects and custom metadata types should share the CustomObject manifest type"
  );
  assert(
    xml.includes("<!-- Custom Fields -->") &&
    xml.includes("<name>CustomField</name>") &&
      xml.includes("<members>Invoice__c.Amount__c</members>"),
    "Custom fields should be included in package.xml"
  );
  assert(
    xml.includes("<!-- Custom Labels -->") &&
    xml.includes("<name>CustomLabel</name>") &&
      xml.includes("<members>Order_Title</members>"),
    "Custom labels should be included in package.xml"
  );
  assert(
    xml.includes("<version>62.0</version>"),
    "package.xml should include the requested API version"
  );
}

async function verifyPackageXmlForCustomMetadataRecord() {
  const workspaceRoot = path.join(__dirname, "..", "test-fixtures", "simple");
  const result = await runAnalysis(
    workspaceRoot,
    path.join("force-app", "main", "default", "customMetadata", "App_Config.Default.md-meta.xml")
  );
  const xml = buildPackageXml(result, { apiVersion: "62.0" });

  assert(
    xml.includes("<!-- Custom Metadata Records -->") &&
    xml.includes("<name>CustomMetadata</name>") &&
      xml.includes("<members>App_Config.Default</members>"),
    "Custom metadata record selections should be included in package.xml"
  );
  assert(
    xml.includes("<name>CustomObject</name>") &&
      xml.includes("<members>App_Config__mdt</members>"),
    "Custom metadata records should also include their owning type when the graph depends on it"
  );
}

async function verifyWarningAggregation() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sf-deps-graph-warning-"));
  const workspaceRoot = path.join(tempRoot, "workspace");

  try {
    fs.cpSync(
      path.join(__dirname, "..", "test-fixtures", "simple"),
      workspaceRoot,
      { recursive: true }
    );

    const lwcPath = path.join(
      workspaceRoot,
      "force-app",
      "main",
      "default",
      "lwc",
      "orderSummary",
      "orderSummary.js"
    );

    fs.appendFileSync(
      lwcPath,
      [
        "",
        'import missingLwc from "c/missingBundle";',
        'import missingApex from "@salesforce/apex/MissingController.run";',
        'import missingLabel from "@salesforce/label/c.Missing_Label";',
        'import missingSchema from "@salesforce/schema/Missing_Object__c";',
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await runAnalysis(
      workspaceRoot,
      path.join("force-app", "main", "default", "lwc", "orderSummary")
    );

    assertWarningIncludes(
      result.warnings,
      "Unresolved LWC bundle reference from orderSummary (1) via LWC import: missingBundle",
      "Missing local LWC imports should generate a warning"
    );
    assertWarningIncludes(
      result.warnings,
      "Unresolved Apex class reference from orderSummary (1) via Apex import: MissingController",
      "Missing Apex imports should generate a warning"
    );
    assertWarningIncludes(
      result.warnings,
      "Unresolved Custom Label reference from orderSummary (1) via Label import: Missing_Label",
      "Missing custom labels should generate a warning"
    );
    assertWarningIncludes(
      result.warnings,
      "Unresolved schema reference from orderSummary (1) via LWC schema import: Missing_Object__c",
      "Missing custom schema tokens should generate a warning"
    );

    const orderControllerResult = await runAnalysis(
      workspaceRoot,
      path.join("force-app", "main", "default", "classes", "OrderController.cls")
    );

    assert(
      !orderControllerResult.warnings.some((warning) => warning.includes("MissingController")),
      "Warnings from unrelated nodes should not bleed into another root selection"
    );
    assert(
      !orderControllerResult.warnings.some((warning) => warning.includes("missingBundle")),
      "Unresolved LWC warnings should be scoped to the reachable graph"
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function verifyPackageApiVersionResolution() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sf-deps-graph-api-version-"));
  const workspaceRoot = path.join(tempRoot, "workspace");

  try {
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceRoot, "sfdx-project.json"),
      JSON.stringify({ sourceApiVersion: "64.0" }, null, 2),
      "utf8"
    );

    assert(
      resolvePackageApiVersion(workspaceRoot) === "64.0",
      "sfdx-project.json sourceApiVersion should drive package.xml version"
    );
    assert(
      resolvePackageApiVersion(path.join(workspaceRoot, "missing")) === DEFAULT_PACKAGE_API_VERSION,
      "Missing sfdx-project.json should fall back to the default package.xml API version"
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function runAnalysis(workspaceRoot, targetRelativePath) {
  return analyzeSelection({
    workspaceFolder: { uri: { fsPath: workspaceRoot } },
    targetUri: { fsPath: path.join(workspaceRoot, targetRelativePath) },
    progress: { report() {} }
  });
}

function assertWarningIncludes(warnings, fragment, message) {
  assert(
    warnings.some((warning) => warning.includes(fragment)),
    `${message}. Missing fragment: ${fragment}`
  );
}

function createNode(id) {
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

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
