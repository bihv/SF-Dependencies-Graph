"use strict";

const fs = require("fs");
const path = require("path");
const { DEFAULT_PACKAGE_API_VERSION } = require("./constants");
const { normalizeApiVersion } = require("./manifest");

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

module.exports = {
  resolvePackageApiVersion
};
