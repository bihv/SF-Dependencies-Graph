"use strict";

const { XMLParser } = require("fast-xml-parser");

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

module.exports = {
  DIRECTORY_EXCLUSIONS,
  SUPPORTED_METADATA,
  XML_PARSER,
  XML_VALUE_PARSER
};
