import { describe, it, expect } from "vitest";
import { normalize, type GraphModel } from "../graph";

describe("graph normalize", () => {
  it("de-dupes nodes by id, keeping the first occurrence", () => {
    const model: GraphModel = {
      nodes: [
        { id: "a", label: "First", props: { x: "1" } },
        { id: "a", label: "Second", props: { x: "2" } },
        { id: "b", label: "B", props: {} },
      ],
      edges: [],
    };
    const out = normalize(model);
    expect(out.nodes).toHaveLength(2);
    expect(out.nodes[0]).toMatchObject({ id: "a", label: "First", props: { x: "1" } });
  });

  it("falls back to the id when a node has no label", () => {
    const out = normalize({ nodes: [{ id: "a", label: "", props: {} }], edges: [] });
    expect(out.nodes[0].label).toBe("a");
  });

  it("drops nodes without an id", () => {
    const out = normalize({ nodes: [{ id: "", label: "ghost", props: {} }], edges: [] });
    expect(out.nodes).toHaveLength(0);
  });

  it("materialises missing edge endpoints as nodes", () => {
    const out = normalize({
      nodes: [{ id: "a", label: "A", props: {} }],
      edges: [{ id: "e1", source: "a", target: "b", label: "rel", props: {} }],
    });
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    const b = out.nodes.find((n) => n.id === "b")!;
    expect(b).toEqual({ id: "b", label: "b", props: {} });
    expect(out.edges).toHaveLength(1);
  });

  it("does not clobber an existing node when it is also an edge endpoint", () => {
    const out = normalize({
      nodes: [{ id: "a", label: "Alpha", props: { k: "v" } }],
      edges: [{ id: "e", source: "a", target: "a", props: {} }],
    });
    expect(out.nodes).toHaveLength(1);
    expect(out.nodes[0].label).toBe("Alpha");
  });

  it("skips edges missing an endpoint", () => {
    const out = normalize({
      nodes: [],
      edges: [
        { id: "e1", source: "", target: "b", props: {} },
        { id: "e2", source: "a", target: "", props: {} },
      ],
    });
    expect(out.edges).toHaveLength(0);
    expect(out.nodes).toHaveLength(0);
  });

  it("derives and de-duplicates edge ids", () => {
    const out = normalize({
      nodes: [],
      edges: [
        { id: "", source: "a", target: "b", label: "rel", props: {} },
        { id: "", source: "a", target: "b", label: "rel", props: {} },
      ],
    });
    expect(out.edges.map((e) => e.id)).toEqual(["a__rel__b", "a__rel__b_"]);
  });
});
