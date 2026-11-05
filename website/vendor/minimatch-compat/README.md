# Docs server matcher compatibility

`serve-handler@6.1.7`, used by Docusaurus's local preview server, calls `require("minimatch")` as a function. Patched minimatch 11 exposes that function as a named export. This adapter preserves the legacy calling convention and forwards the remaining upstream exports, using `minimatch@11.0.3` for all matching.

The website's scoped npm override installs the packed adapter only for `serve-handler`. The dependency alias prevents the override from also replacing the adapter's own matcher dependency. Remove the adapter when serve-handler supports a patched minimatch release directly.

To regenerate the checked-in package after changing its source, run `npm pack ./website/vendor/minimatch-compat --pack-destination website/vendor` from the repository root. Run the website checks, security audit and full build after updating the package or matcher version.
