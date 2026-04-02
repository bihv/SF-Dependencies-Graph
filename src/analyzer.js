"use strict";

const { ApexParserFactory } = require("@apexdevtools/apex-parser");
const { parse: parseJavaScriptModule } = require("@babel/parser");
const fs = require("fs");
const { XMLParser } = require("fast-xml-parser");
const parseFormula = require("forcemula");
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

const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: true,
  trimValues: false
});

const XML_VALUE_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: false
});

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

  for (const filePath of node.files) {
    if (path.extname(filePath) !== ".js") {
      continue;
    }

    const source = safeRead(index, filePath);
    const program = parseJavaScriptSafely(index, node, filePath, source);
    if (!program) {
      continue;
    }

    for (const statement of program.body) {
      if (statement.type !== "ImportDeclaration") {
        continue;
      }

      const specifier = typeof statement.source?.value === "string"
        ? statement.source.value
        : "";
      if (!specifier) {
        continue;
      }

      if (specifier.startsWith("c/")) {
        addDependencyByName(index, deps, node, "lwc", specifier.slice(2), {
          edgeType: "usesLwc",
          confidence: "high",
          source: "LWC import"
        });
        continue;
      }

      if (specifier.startsWith("@salesforce/apex/")) {
        const apexRef = getApexClassNameFromImport(specifier);
        if (apexRef) {
          addDependencyByName(index, deps, node, "apex", apexRef, {
            edgeType: "callsApex",
            confidence: "high",
            source: "Apex import"
          });
        }
        continue;
      }

      if (specifier.startsWith("@salesforce/label/")) {
        const labelName = getLabelNameFromImport(specifier);
        if (labelName) {
          addDependencyByName(index, deps, node, "label", labelName, {
            edgeType: "usesLabel",
            confidence: "high",
            source: "Label import"
          });
        }
        continue;
      }

      if (specifier.startsWith("@salesforce/schema/")) {
        const schemaRef = specifier.slice("@salesforce/schema/".length).trim();
        if (schemaRef) {
          addSchemaDependency(index, deps, node, schemaRef, "LWC schema import");
        }
      }
    }
  }

  return uniqueDependencies(deps);
}

function extractAuraDependencies(index, node) {
  const deps = [];

  for (const filePath of node.files) {
    if (!looksLikeXmlFile(filePath)) {
      continue;
    }

    const source = safeRead(index, filePath);
    const document = parseXmlSafely(index, filePath, source);
    if (!document) {
      continue;
    }

    walkXml(document, ({ tagName, attributes, text }) => {
      if (tagName) {
        const [namespace, componentName] = tagName.split(":");
        if (namespace && componentName && namespace !== "aura") {
          const matchedId =
            index.auraByName.get(componentName.toLowerCase()) ||
            index.lwcByName.get(componentName.toLowerCase());

          if (matchedId) {
            deps.push(
              createDependency(node.id, matchedId, "usesComponent", "high", "Aura markup")
            );
          } else if (namespace === "c") {
            recordUnresolvedReference(
              index,
              node,
              "Aura/LWC component",
              componentName,
              "Aura markup"
            );
          }
        }

        const controllerName = attributes?.["@_controller"];
        if (isIdentifier(controllerName)) {
          addDependencyByName(index, deps, node, "apex", controllerName, {
            edgeType: "usesApexController",
            confidence: "high",
            source: "Aura controller attribute"
          });
        }

        for (const value of Object.values(attributes || {})) {
          addAuraLabelsFromValue(index, deps, node, value);
        }
      }

      if (typeof text === "string") {
        addAuraLabelsFromValue(index, deps, node, text);
      }
    });
  }

  return uniqueDependencies(deps);
}

function extractApexDependencies(index, node, isTrigger) {
  const deps = [];
  const source = safeRead(index, node.path);
  const parser = createApexParser(index, node, source);
  if (!parser) {
    return uniqueDependencies(deps);
  }

  const root = isTrigger ? parser.triggerUnit() : parser.compilationUnit();
  const variableTypes = new Map();
  const schemaTokens = new Set();
  const labelNames = new Set();
  const apexClassCandidates = new Set();

  if (isTrigger) {
    const triggerObject = root.id?.(1)?.getText?.();
    if (triggerObject) {
      addSchemaDependency(index, deps, node, triggerObject, "Trigger target object");
    }
  }

  walkApexContexts(root, parser, (context, ruleName) => {
    if (ruleName === "localVariableDeclaration") {
      const typeName = getApexTypeName(context.typeRef?.());
      registerApexVariableTypes(variableTypes, typeName, context.variableDeclarators?.());
      addCustomSchemaTokens(schemaTokens, typeName);
      return;
    }

    if (ruleName === "formalParameter") {
      const typeName = getApexTypeName(context.typeRef?.());
      const parameterName = context.id?.()?.getText?.();
      if (typeName && parameterName) {
        variableTypes.set(parameterName, typeName);
        addCustomSchemaTokens(schemaTokens, typeName);
      }
      return;
    }

    if (ruleName === "typeRef") {
      addCustomSchemaTokens(schemaTokens, getApexTypeName(context));
      return;
    }

    if (ruleName !== "expression") {
      return;
    }

    const accessPath = getApexAccessPath(context);
    const labelName = getApexLabelName(accessPath);
    if (labelName) {
      labelNames.add(labelName);
      return;
    }

    if (accessPath?.length === 1 && isCustomObjectApiName(accessPath[0])) {
      schemaTokens.add(accessPath[0]);
    }

    if (
      accessPath?.length === 2 &&
      isCustomObjectApiName(accessPath[0]) &&
      isCustomFieldApiName(accessPath[1])
    ) {
      schemaTokens.add(`${accessPath[0]}.${accessPath[1]}`);
    }

    const fieldName = context.anyId?.()?.getText?.();
    const baseContext = context.expression?.();
    const baseExpression = baseContext?.getText?.();
    const baseAccessPath = getApexAccessPath(baseContext);
    if (fieldName && baseExpression && variableTypes.has(baseExpression)) {
      addCustomSchemaTokens(
        schemaTokens,
        `${variableTypes.get(baseExpression)}.${fieldName}`
      );
    }

    const methodCall = context.dotMethodCall?.();
    if (
      methodCall &&
      baseAccessPath?.length === 1 &&
      isIdentifier(baseAccessPath[0]) &&
      !variableTypes.has(baseAccessPath[0])
    ) {
      apexClassCandidates.add(baseAccessPath[0]);
    }
  });

  for (const labelName of labelNames) {
    addDependencyByName(index, deps, node, "label", labelName, {
      edgeType: "usesLabel",
      confidence: "high",
      source: "Apex label reference"
    });
  }

  for (const token of schemaTokens) {
    addSchemaDependency(index, deps, node, token, token.includes(".")
      ? "Apex field token"
      : "Apex custom schema token");
  }

  for (const candidate of apexClassCandidates) {
    if (candidate === node.name || !index.apexByName.has(candidate.toLowerCase())) {
      continue;
    }

    addDependencyByName(index, deps, node, "apex", candidate, {
      edgeType: "referencesApex",
      confidence: "low",
      source: "Apex identifier match"
    });
  }

  return uniqueDependencies(deps);
}

function extractFieldDependencies(index, node) {
  const deps = [];
  const xml = safeRead(index, node.path);
  const referenceTos = getXmlTagValues(xml, "referenceTo");
  for (const referenceTo of referenceTos) {
    addSchemaDependency(index, deps, node, referenceTo, "Field referenceTo");
  }

  const formulas = getXmlTagValues(xml, "formula");
  for (const formula of formulas) {
    addFormulaDependencies(index, deps, node, formula);
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

function parseJavaScriptSafely(index, node, filePath, source) {
  try {
    return parseJavaScriptModule(source, {
      sourceType: "module",
      errorRecovery: true,
      plugins: [
        "classProperties",
        "decorators-legacy",
        "dynamicImport",
        "importAssertions"
      ]
    }).program;
  } catch (error) {
    pushWarning(
      index,
      `Could not parse JavaScript module: ${formatWarningPath(index, filePath)}`
    );
    return null;
  }
}

function getApexClassNameFromImport(specifier) {
  const remainder = String(specifier || "").slice("@salesforce/apex/".length);
  const segments = remainder.split(".").filter(Boolean);
  return segments.length >= 2 ? segments[segments.length - 2] : "";
}

function getLabelNameFromImport(specifier) {
  const remainder = String(specifier || "").slice("@salesforce/label/".length);
  return remainder.startsWith("c.") ? remainder.slice(2) : "";
}

function looksLikeXmlFile(filePath) {
  return [
    ".cmp",
    ".app",
    ".evt",
    ".intf",
    ".design",
    ".xml"
  ].includes(path.extname(filePath));
}

function parseXmlSafely(index, filePath, source) {
  try {
    return XML_PARSER.parse(source);
  } catch (error) {
    pushWarning(index, `Could not parse XML: ${formatWarningPath(index, filePath)}`);
    return null;
  }
}

function walkXml(nodes, visitor) {
  if (!Array.isArray(nodes)) {
    return;
  }

  for (const entry of nodes) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    for (const [key, value] of Object.entries(entry)) {
      if (key === "#text") {
        visitor({ text: value });
        continue;
      }

      if (key === ":@") {
        continue;
      }

      const attributes = entry[":@"] || {};
      visitor({ tagName: key, attributes });
      if (Array.isArray(value)) {
        walkXml(value, visitor);
      }
    }
  }
}

function addAuraLabelsFromValue(index, deps, node, value) {
  for (const labelName of matchAll(String(value || ""), /\$Label\.c\.([a-zA-Z0-9_]+)/g)) {
    addDependencyByName(index, deps, node, "label", labelName, {
      edgeType: "usesLabel",
      confidence: "high",
      source: "Aura label reference"
    });
  }
}

function createApexParser(index, node, source) {
  try {
    return ApexParserFactory.createParser(source);
  } catch (error) {
    pushWarning(index, `Could not parse Apex source: ${formatWarningPath(index, node.path)}`);
    return null;
  }
}

function walkApexContexts(context, parser, visitor) {
  if (!context || context.ruleIndex === undefined) {
    return;
  }

  visitor(context, parser.ruleNames[context.ruleIndex]);

  for (let index = 0; index < context.getChildCount(); index += 1) {
    const child = context.getChild(index);
    if (child && child.ruleIndex !== undefined) {
      walkApexContexts(child, parser, visitor);
    }
  }
}

function registerApexVariableTypes(variableTypes, typeName, variableDeclarators) {
  if (!typeName || !variableDeclarators) {
    return;
  }

  const declarators = variableDeclarators.variableDeclarator_list?.() || [];
  for (const declarator of declarators) {
    const variableName = declarator.id?.()?.getText?.();
    if (variableName) {
      variableTypes.set(variableName, typeName);
    }
  }
}

function getApexTypeName(typeRefContext) {
  if (!typeRefContext) {
    return "";
  }

  const typeName = typeRefContext.typeName?.()?.getText?.();
  if (typeName) {
    return typeName;
  }

  const typeNames = typeRefContext.typeName_list?.() || [];
  if (typeNames.length > 0) {
    return typeNames.map((entry) => entry.getText()).join(".");
  }

  return String(typeRefContext.getText?.() || "").trim();
}

function getApexAccessPath(expressionContext) {
  if (!expressionContext) {
    return null;
  }

  const primaryText = expressionContext.primary?.()?.getText?.();
  if (isIdentifier(primaryText)) {
    return [primaryText];
  }

  const childExpression = expressionContext.expression?.();
  const memberName = expressionContext.anyId?.()?.getText?.();
  if (childExpression && isIdentifier(memberName)) {
    const basePath = getApexAccessPath(childExpression);
    if (Array.isArray(basePath) && basePath.length > 0) {
      return [...basePath, memberName];
    }
  }

  return null;
}

function getApexLabelName(accessPath) {
  if (!Array.isArray(accessPath)) {
    return "";
  }

  if (accessPath.length === 2 && accessPath[0] === "Label") {
    return accessPath[1];
  }

  if (
    accessPath.length === 3 &&
    accessPath[0] === "System" &&
    accessPath[1] === "Label"
  ) {
    return accessPath[2];
  }

  return "";
}

function addCustomSchemaTokens(target, value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return;
  }

  if (isCustomObjectApiName(normalized)) {
    target.add(normalized);
    return;
  }

  const segments = normalized.split(".");
  if (
    segments.length === 2 &&
    isCustomObjectApiName(segments[0]) &&
    isCustomFieldApiName(segments[1])
  ) {
    target.add(`${segments[0]}.${segments[1]}`);
  }
}

function addFormulaDependencies(index, deps, node, formula) {
  const parentObjectName = getParentObjectNameFromQualifiedField(node.name);
  if (!parentObjectName || !formula) {
    return;
  }

  let parsed;
  try {
    parsed = parseFormula({
      parentObject: parentObjectName,
      formula
    });
  } catch (error) {
    pushWarning(index, `Could not parse formula: ${formatWarningPath(index, node.path)}`);
    return;
  }

  const summary = parsed?.json || {};

  for (const fieldName of summary.customFields || []) {
    addSchemaDependency(index, deps, node, fieldName, "Field formula field token");
  }

  for (const objectName of summary.customObjects || []) {
    addSchemaDependency(index, deps, node, objectName, "Field formula token");
  }

  for (const metadataTypeName of summary.customMetadataTypes || []) {
    addSchemaDependency(index, deps, node, metadataTypeName, "Field formula token");
  }

  for (const labelName of summary.customLabels || []) {
    addDependencyByName(index, deps, node, "label", labelName, {
      edgeType: "usesLabel",
      confidence: "high",
      source: "Field formula label reference"
    });
  }
}

function getParentObjectNameFromQualifiedField(fieldName) {
  const normalized = String(fieldName || "");
  const separatorIndex = normalized.indexOf(".");
  return separatorIndex > 0 ? normalized.slice(0, separatorIndex) : "";
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
  return String(value || "").endsWith(suffix) && isIdentifier(String(value || "").slice(0, -suffix.length));
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

  if (
    isCustomObjectApiName(token) ||
    token
      .split(".")
      .every((segment, index) =>
        index === 0 ? isCustomObjectApiName(segment) : isCustomFieldApiName(segment)
      )
  ) {
    recordUnresolvedReference(index, node, "schema", token, source);
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
    const categoryByRegistry = {
      lwc: "LWC bundle",
      aura: "Aura bundle",
      apex: "Apex class",
      label: "Custom Label",
      object: "Custom Object"
    };
    recordUnresolvedReference(
      index,
      node,
      categoryByRegistry[registry] || "metadata",
      rawName,
      options.source
    );
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

function joinNodeFiles(index, node) {
  return node.files
    .map((filePath) => safeRead(index, filePath))
    .join("\n");
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

module.exports = {
  analyzeSelection,
  buildIndex,
  resolveTargetNode,
  traverseDependencies,
  buildTree
};
