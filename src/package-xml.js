"use strict";

const { DEFAULT_PACKAGE_API_VERSION } = require("./package-xml/constants");
const { buildPackageXml } = require("./package-xml/manifest");
const { resolvePackageApiVersion } = require("./package-xml/api-version");

module.exports = {
  DEFAULT_PACKAGE_API_VERSION,
  buildPackageXml,
  resolvePackageApiVersion
};
