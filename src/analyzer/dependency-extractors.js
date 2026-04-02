"use strict";

const parseFormula = require("forcemula");
const path = require("path");
const {
  formatWarningPath,
  getXmlTagValues,
  isCustomFieldApiName,
  isCustomObjectApiName,
  isIdentifier,
  matchAll,
  pushWarning,
  recordUnresolvedReference,
  safeRead
} = require("./utils");
const {
  addCustomSchemaTokens,
  createApexParser,
  getApexAccessPath,
  getApexClassNameFromImport,
  getApexLabelName,
  getApexTypeName,
  getLabelNameFromImport,
  getParentObjectNameFromQualifiedField,
  looksLikeXmlFile,
  parseJavaScriptSafely,
  parseXmlSafely,
  registerApexVariableTypes,
  walkApexContexts,
  walkXml
} = require("./parsers");

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
    addSchemaDependency(
      index,
      deps,
      node,
      token,
      token.includes(".") ? "Apex field token" : "Apex custom schema token"
    );
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

function addAuraLabelsFromValue(index, deps, node, value) {
  for (const labelName of matchAll(String(value || ""), /\$Label\.c\.([a-zA-Z0-9_]+)/g)) {
    addDependencyByName(index, deps, node, "label", labelName, {
      edgeType: "usesLabel",
      confidence: "high",
      source: "Aura label reference"
    });
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

module.exports = {
  extractDependencies
};
