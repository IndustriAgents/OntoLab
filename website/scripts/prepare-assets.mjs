import { copyFile, readFile, writeFile } from "node:fs/promises";
// Keep public tutorial downloads tied to the exact sample shipped by the app.
for (const name of ["mechatronic-tbox.ttl", "distributing-manual.txt"]) {
  await copyFile(new URL(`../../samples/${name}`, import.meta.url), new URL(`../static/${name}`, import.meta.url));
}

// Reuse the application's actual paper-theme tokens without importing app layout CSS.
const theme = await readFile(new URL("../../src/styles/helix.css", import.meta.url), "utf8");
const boundary = theme.indexOf("/* OntoLab's tokens");
if (boundary < 0) throw new Error("Product theme token boundary changed; review the docs theme extraction.");
await writeFile(new URL("../src/css/product-tokens.css", import.meta.url), theme.slice(0, boundary));
