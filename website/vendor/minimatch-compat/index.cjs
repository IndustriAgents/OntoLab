// serve-handler 6 calls the module directly; minimatch 11 exports named APIs.
// Keep that calling convention while using the patched upstream matcher.
const modern = require("minimatch-modern");
module.exports = Object.assign(modern.minimatch, modern);
