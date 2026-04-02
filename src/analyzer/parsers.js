"use strict";

const { ApexParserFactory } = require("@apexdevtools/apex-parser");
const { parse: parseJavaScriptModule } = require("@babel/parser");
const { XML_PARSER } = require("./constants");
const {
  formatWarningPath,
  isCustomFieldApiName,
  isCustomObjectApiName,
  isIdentifier,
  pushWarning
} = require("./utils");

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
  ].includes(require("path").extname(filePath));
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

function getParentObjectNameFromQualifiedField(fieldName) {
  const normalized = String(fieldName || "");
  const separatorIndex = normalized.indexOf(".");
  return separatorIndex > 0 ? normalized.slice(0, separatorIndex) : "";
}

module.exports = {
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
};
