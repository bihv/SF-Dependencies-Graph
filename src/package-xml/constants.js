"use strict";

const DEFAULT_PACKAGE_API_VERSION = "61.0";

const PACKAGE_TYPE_BY_KIND = Object.freeze({
  lwcBundle: "LightningComponentBundle",
  auraBundle: "AuraDefinitionBundle",
  apexClass: "ApexClass",
  apexTrigger: "ApexTrigger",
  customLabel: "CustomLabel",
  customObject: "CustomObject",
  customField: "CustomField",
  customMetadataType: "CustomObject",
  customMetadataRecord: "CustomMetadata"
});

const PACKAGE_TYPE_COMMENTS = Object.freeze({
  LightningComponentBundle: "LWC Bundles",
  AuraDefinitionBundle: "Aura Bundles",
  ApexClass: "Apex Classes",
  ApexTrigger: "Apex Triggers",
  CustomLabel: "Custom Labels",
  CustomObject: "Custom Objects and Custom Metadata Types",
  CustomField: "Custom Fields",
  CustomMetadata: "Custom Metadata Records"
});

module.exports = {
  DEFAULT_PACKAGE_API_VERSION,
  PACKAGE_TYPE_BY_KIND,
  PACKAGE_TYPE_COMMENTS
};
