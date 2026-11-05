// Verify multi-module T-Box merge against a large real-world ontology stack.
// Run: MAESTRO_ONTOLOGIES=/path/to/ontologies npx tsx scripts/maestro-check.ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTBox, mergeTBox } from "../src/lib/ontology/tboxParser.ts";
import type { TBoxModel } from "../src/types/tbox.ts";

// Point this at any directory tree of .ttl/.owl/.rdf modules. The old hard-coded
// developer path made this script unrunnable for anyone else.
const ROOT = process.env.MAESTRO_ONTOLOGIES || "../MAESTRO/ontologies";

if (!existsSync(ROOT)) {
  console.log(`Skipped: no ontology directory at "${ROOT}". Set MAESTRO_ONTOLOGIES to run this check.`);
  process.exit(0);
}

const files = readdirSync(ROOT, { recursive: true, encoding: "utf8" }).filter((f) => /\.(ttl|owl|rdf)$/i.test(f));
console.log(`Found ${files.length} ontology files.`);

const models: TBoxModel[] = [];
let failed = 0;
for (const rel of files) {
  try {
    const text = readFileSync(join(ROOT, rel), "utf8");
    const m = parseTBox(text);
    models.push(m);
    console.log(`  ${rel.padEnd(40)} classes=${m.classes.length} obj=${m.objectProps.length} data=${m.dataProps.length}`);
  } catch (e) {
    failed++;
    console.log(`  ${rel.padEnd(40)} PARSE ERROR: ${e instanceof Error ? e.message : e}`);
  }
}

const merged = mergeTBox(models);
console.log(`\nMERGED T-Box: ${merged.classes.length} classes, ${merged.objectProps.length} object props, ${merged.dataProps.length} data props`);
console.log(`baseIri: ${merged.baseIri}`);
console.log(`prefixes: ${Object.keys(merged.prefixes).length}`);
console.log(`subClassOf edges: ${Object.keys(merged.subClassOf).length}`);
console.log(`parse failures: ${failed}`);

// spot-check a cross-module property (skill:requiresMotion: domain core:Skill, range motion:Motion)
const rm = merged.objectProps.find((p) => p.uri.endsWith("requiresMotion"));
if (rm) console.log(`\nrequiresMotion → domain=${rm.domain.join(",")} range=${rm.range.join(",")}`);
console.log("\nSample classes:", merged.classes.slice(0, 12).map((c) => c.label || c.uri.split(/[#/]/).pop()).join(", "));
