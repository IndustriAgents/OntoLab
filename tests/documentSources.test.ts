import { describe, expect, it, vi } from "vitest";
import type { ProjectDocument, RunView } from "../src/types/project";
import {
  chunkConfigurationLabel,
  groupSourceDocuments,
  removeSourceDocuments,
  selectSourceConfiguration,
  sourceDocumentName,
} from "../src/lib/documentSources";

const original = { id: "original", name: "manual.xml", chunkCount: 8 } as ProjectDocument;
const variant = {
  id: "variant",
  name: "manual · experiment paragraph 2000t 12pct.xml",
  variantOf: "original",
  chunkCount: 46,
} as ProjectDocument;
const sibling = { ...variant, id: "sibling" };
const other = { ...original, id: "other", name: "other.xml" };

describe("uploaded documents and chunk configurations", () => {
  it("groups preparations under their uploaded file without grouping separate uploads by filename", () => {
    const secondUpload = { ...original, id: "second-upload" };
    const groups = groupSourceDocuments([variant, original, sibling, secondUpload]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ id: "original", original, name: "manual.xml" });
    expect(groups[0].configurations.map((configuration) => configuration.id)).toEqual(["variant", "original", "sibling"]);
    expect(groups[1].configurations).toEqual([secondUpload]);
  });
  it("retains a readable source when only saved preparations remain", () => {
    const group = groupSourceDocuments([variant, sibling])[0];
    expect(group.name).toBe("manual.xml");
    expect(group.original).toBeUndefined();
    expect(group.configurations).toHaveLength(2);
    expect(sourceDocumentName(original)).toBe(original.name);
  });
  it("switches configurations instead of appending another copy of the source to the build", () => {
    const docs = [original, variant, sibling, other];
    expect(selectSourceConfiguration([original.id, other.id], docs, original.id, variant.id)).toEqual([other.id, variant.id]);
    expect(selectSourceConfiguration([original.id, sibling.id, other.id], docs, original.id, variant.id)).toEqual([other.id, variant.id]);
    expect(selectSourceConfiguration([variant.id, other.id], docs, original.id, null)).toEqual([other.id]);
    expect(selectSourceConfiguration([], docs, original.id, variant.id)).toEqual([variant.id]);
    expect(selectSourceConfiguration([other.id], docs, original.id, "foreign")).toEqual([other.id]);
    expect(selectSourceConfiguration([original.id, other.id], docs, original.id, "foreign")).toEqual([original.id, other.id]);
  });
  it("describes the preparation with its model, method and budgets instead of an invented filename", () => {
    const configured = {
      ...variant,
      preprocessing: {
        settings: {
          method: "paragraph",
          unit: "tokens",
          maxChars: 12000,
          overlap: 0.12,
          tokens: { generation: { provider: "codex-cli", model: "test-model", maxTokens: 2000 } },
        },
      },
    } as ProjectDocument;
    expect(chunkConfigurationLabel(configured)).toBe("Codex / test-model · Paragraph + boundary overlap · 2,000 tokens · 12% overlap");
    expect(chunkConfigurationLabel({ ...original, chunkCount: 0 })).toBe("Chunks not configured");
    const withEmbedding = (profile: string) => ({
      ...configured,
      preprocessing: {
        ...configured.preprocessing!,
        settings: {
          ...configured.preprocessing!.settings,
          tokens: { ...configured.preprocessing!.settings.tokens!, embedding: { profile, maxTokens: 256 } },
        },
      },
    });
    expect(chunkConfigurationLabel(withEmbedding("hash:384"))).not.toBe(chunkConfigurationLabel(withEmbedding("local:MiniLM")));
  });
  it("checks every configuration for active runs before removing any part of a document", async () => {
    const actions = {
      listRuns: vi.fn(async () => [{ status: "running", documentIds: [variant.id] }] as RunView[]),
      removeDocument: vi.fn(async () => undefined),
    };
    await expect(removeSourceDocuments("p", [original.id, variant.id], actions)).rejects.toThrow("active run");
    expect(actions.removeDocument).not.toHaveBeenCalled();
    actions.listRuns.mockResolvedValue([]);
    await removeSourceDocuments("p", [original.id, variant.id], actions);
    expect(actions.removeDocument.mock.calls).toEqual([
      ["p", original.id],
      ["p", variant.id],
    ]);
  });
});
