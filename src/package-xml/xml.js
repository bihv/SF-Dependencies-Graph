"use strict";

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeXmlComment(value) {
  return String(value).replace(/--/g, "- -").trim();
}

module.exports = {
  escapeXml,
  escapeXmlComment
};
