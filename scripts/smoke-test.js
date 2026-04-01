"use strict";

const path = require("path");
const { analyzeSelection, buildTree } = require("../src/analyzer");

async function main() {
  const workspaceRoot = path.join(__dirname, "..", "test-fixtures", "simple");
  const targetPath = path.join(
    workspaceRoot,
    "force-app",
    "main",
    "default",
    "lwc",
    "orderSummary"
  );

  const result = await analyzeSelection({
    workspaceFolder: { uri: { fsPath: workspaceRoot } },
    targetUri: { fsPath: targetPath },
    progress: { report() {} }
  });

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

  verifyCompactTree();

  console.log(
    JSON.stringify(
      {
        summary: result.summary,
        root: result.root,
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
