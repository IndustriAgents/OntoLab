// The DL reasoner sidecar's HTTP contract, against a stand-in server (the real
// one is Java: sidecar/reasoner), and the fallback to the in-process RL tier.
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalStore } from "../server/store/local.ts";
import { silentLogger } from "../server/services/context.ts";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { effectiveTier, reasonContent } from "../server/services/reasoner.ts";
import type { RevisionContent } from "../src/types/project.ts";

const TTL = `@prefix : <http://ex/r#> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
:Person owl:disjointWith :Organization . :worksAt a owl:ObjectProperty ; rdfs:range :Organization .`;
const content: RevisionContent = {
  modules: [{ id: "m1", name: "core.ttl", turtle: TTL }],
  abox: {
    individuals: [
      { id: "sarah", classUri: "http://ex/r#Person", objectProperties: [{ propUri: "http://ex/r#worksAt", targetId: "oxford" }] },
      { id: "oxford", classUri: "http://ex/r#Person" },
    ],
  },
  baseIri: "http://ex/data#",
};

async function withServer(handler: http.RequestListener, fn: (url: string) => Promise<void>) {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

describe("DL reasoner sidecar contract", () => {
  it("sends the modules and the A-Box, and maps individual IRIs back to A-Box ids", async () => {
    let body: Record<string, any> = {};
    await withServer(
      (req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          body = JSON.parse(raw);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              tier: "dl",
              reasoner: "hermit",
              consistent: false,
              clashes: [
                {
                  code: "inconsistent",
                  message: "contradiction",
                  subjects: ["http://ex/data#oxford"],
                  explanation: [
                    { id: "d0", kind: "type", args: ["http://ex/data#oxford", "http://ex/r#Person"], individualId: "http://ex/data#oxford" },
                    { id: "d1", kind: "range", args: ["http://ex/r#worksAt", "http://ex/r#Organization"], module: "core.ttl" },
                    { id: "d2", kind: "other", args: ["Person DisjointWith Organization"], module: "core.ttl" },
                  ],
                },
              ],
              unsatisfiable: [],
              subsumptions: [],
              propertySubsumptions: [],
              inferredTypes: { "http://ex/data#oxford": ["http://ex/r#Organization"] },
              inferredLinks: [],
              sameAs: [],
              incomplete: ["Classification and unsatisfiable classes are not computed for an inconsistent ontology"],
              stats: { axioms: 5, facts: 0, ms: 12 },
            }),
          );
        });
      },
      async (url) => {
        const r = await reasonContent(null, "p1", content, { tier: "dl", url });
        expect(body.modules).toEqual([{ name: "core.ttl", turtle: TTL }]);
        expect(body.abox).toMatch(/@prefix abox: <http:\/\/ex\/data#>[\s\S]*abox:oxford/);
        expect(body.reasoner).toBe("hermit");
        expect(r).toMatchObject({ tier: "dl", consistent: false });
        expect(r!.clashes[0].subjects).toEqual(["oxford"]);
        expect(r!.clashes[0].explanation[0]).toMatchObject({ args: ["oxford", "http://ex/r#Person"], individualId: "oxford" });
        expect(r!.inferredTypes).toEqual({ oxford: ["http://ex/r#Organization"] });
      },
    );
  });

  it("falls back to the RL tier, and says so, when the sidecar fails", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
      },
      async (url) => {
        const r = await reasonContent(null, "p1", content, { tier: "dl", url });
        expect(r!.tier).toBe("rl");
        expect(r!.consistent).toBe(false); // oxford is a Person and, through the range, an Organization
        expect(r!.incomplete[0]).toMatch(/DL reasoner was unreachable \(boom\)/);
      },
    );
  });

  it("resolves the tier from the configuration", () => {
    expect(effectiveTier("auto", "")).toBe("rl");
    expect(effectiveTier("auto", "http://x")).toBe("dl");
    expect(effectiveTier("dl", "")).toBe("rl");
    expect(effectiveTier("off", "http://x")).toBe("off");
  });
});


it("does not reuse a cached report from the union-flattening reasoner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ontolab-reason-cache-"));
  try {
    const user = { id: "test" };
    const store = createLocalStore(dir).forUser(user);
    const key = createHash("sha256")
      .update(JSON.stringify(["reason-1", "rl", true, true, content.modules.map((m) => [m.name, m.turtle]), content.abox, content.baseIri]))
      .digest("hex").slice(0, 40);
    await store.blobs.put(`p1/reasoning/${key}.json`, Buffer.from(JSON.stringify({ reasoner: "obsolete-result" })), "application/json");
    const ctx = { store, user, log: silentLogger, now: () => new Date(), requestId: "upgrade-test" };
    const result = await reasonContent(ctx, "p1", content, { tier: "rl" });
    expect(result!.reasoner).toBe("ontolab-rl");
    expect(result!.clashes.length).toBeGreaterThan(0);
    expect(await reasonContent(ctx, "p1", content, { tier: "rl" })).toEqual(result);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
