// Local adapter: JSON files and blobs on disk under DATA_DIR.
//
// Used for development, tests and single-machine installs. Every path is
// partitioned by user id (`u/<user>/…`), so one user's requests can never even
// address another user's files — ownership holds by construction. Writes go
// through write-to-temp + rename so a crash never leaves half a JSON file, and
// read-modify-write sequences (commit, lease) are serialised per key in-process.

import { mkdir, readFile, writeFile, rename, rm, readdir, link, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  Conversation,
  DocumentChunk,
  ExtractionRun,
  JobCheckpoint,
  OntologyRevision,
  Project,
  ProjectDocument,
  RevisionContent,
  RevisionWithContent,
  StoredValidationReport,
  User,
} from "../../src/types/project.ts";
import { ConflictError, NotFoundError, type ChunkHit, type Store, type StoredDocumentText, type UserStore } from "./types.ts";
import { scoreChunks } from "./search.ts";
import type { StoredConnection } from "../connections/types.ts";
import type { Evaluation } from "../../src/types/evaluation.ts";
import { activeEvaluationStates } from "../../src/types/evaluation.ts";
import { assertEvaluationVersion, evaluationSummary } from "./evaluation.ts";

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,120}$/;

/** Reject anything that is not a plain id before it becomes part of a path. */
function safeId(id: string, what = "resource"): string {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new NotFoundError(what);
  return id;
}

function safeRelPath(path: string): string {
  const segs = path.split("/");
  if (!segs.length || segs.some((s) => !SEGMENT_RE.test(s) || s === "." || s === "..")) throw new NotFoundError("file");
  return join(...segs);
}

/** File-name-safe encoding for checkpoint keys like `chunk:doc_1:3`. */
const keyFile = (key: string) => Buffer.from(key, "utf8").toString("base64url") + ".json";

const locks = new Map<string, Promise<unknown>>();

/** Serialise async critical sections on the same key (in-process). */
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => next);
  locks.set(key, chained);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function writeAtomic(path: string, data: string | Buffer): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, data);
  // Windows refuses to rename over a file another process (an indexer, an
  // antivirus scan) briefly holds open — retry a few times before giving up.
  for (let i = 0; ; i++) {
    try {
      await rename(tmp, path);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
        await rm(tmp, { force: true });
        throw e;
      }
      await new Promise((r) => setTimeout(r, 20 * (i + 1)));
    }
  }
}

const writeJson = (path: string, value: unknown) => writeAtomic(path, JSON.stringify(value));

async function listJson<T>(dir: string, suffix = ".json"): Promise<T[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: T[] = [];
  for (const n of names) {
    if (!n.endsWith(suffix) || n.endsWith(".tmp")) continue;
    const v = await readJson<T>(join(dir, n));
    if (v) out.push(v);
  }
  return out;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else total += (await stat(p)).size;
  }
  return total;
}

interface StoredText extends StoredDocumentText {
  chunks: DocumentChunk[];
}

const ACTIVE_RUN = new Set(["queued", "running"]);

export function createLocalStore(dataDir: string): Store {
  const root = resolve(dataDir);

  const self: Store = {
    kind: "local",
    worker: {
      async activeEvaluations() {
        const out: { ownerId: string; projectId: string; evaluationId: string }[] = [];
        for (const u of await readdir(join(root, "u")).catch(() => [] as string[])) {
          for (const p of await readdir(join(root, "u", u, "p")).catch(() => [] as string[])) {
            for (const item of await listJson<Evaluation>(join(root, "u", u, "p", p, "evaluations"))) {
              if (activeEvaluationStates.includes(item.state)) out.push({ ownerId: u, projectId: p, evaluationId: item.id });
            }
          }
        }
        return out;
      },
      // The background worker sees every user's runnable runs; it then acts
      // through forUser(owner), so ownership partitioning still applies.
      async pendingDocuments() {
        const out: { ownerId: string; projectId: string; documentId: string }[] = [];
        const users = await readdir(join(root, "u")).catch(() => [] as string[]);
        for (const u of users) {
          for (const p of await readdir(join(root, "u", u, "p")).catch(() => [] as string[])) {
            for (const doc of await listJson<ProjectDocument>(join(root, "u", u, "p", p, "docs"))) {
              if (doc.parseState === "pending") out.push({ ownerId: u, projectId: p, documentId: doc.id });
            }
          }
        }
        return out;
      },
      async activeRuns() {
        const out: { ownerId: string; projectId: string; runId: string }[] = [];
        let users: string[] = [];
        try {
          users = await readdir(join(root, "u"));
        } catch {
          return out;
        }
        for (const u of users) {
          let projects: string[] = [];
          try {
            projects = await readdir(join(root, "u", u, "p"));
          } catch {
            continue;
          }
          for (const p of projects) {
            for (const run of await listJson<ExtractionRun>(join(root, "u", u, "p", p, "runs"))) {
              if (ACTIVE_RUN.has(run.status)) out.push({ ownerId: u, projectId: p, runId: run.id });
            }
          }
        }
        return out;
      },
      forOwner(ownerId: string) {
        return self.forUser({ id: ownerId });
      },
    },
    forUser(user: User): UserStore {
      const userDir = join(root, "u", safeId(user.id, "user"));
      const projectDir = (pid: string) => join(userDir, "p", safeId(pid, "project"));
      const blobDir = join(userDir, "blobs");

      const requireProjectDir = async (pid: string) => {
        const dir = projectDir(pid);
        if (!(await readJson<Project>(join(dir, "project.json")))) throw new NotFoundError("project");
        return dir;
      };

      const revMeta = (pid: string, id: string) => join(projectDir(pid), "revisions", `${safeId(id, "revision")}.meta.json`);
      const revContent = (pid: string, id: string) => join(projectDir(pid), "revisions", `${safeId(id, "revision")}.content.json`);
      const runFile = (pid: string, id: string) => join(projectDir(pid), "runs", `${safeId(id, "run")}.json`);
      const cpDir = (pid: string, runId: string) => join(projectDir(pid), "runs", `${safeId(runId, "run")}.cp`);

      const store: UserStore = {
        evaluations: {
          async list(pid) {
            await requireProjectDir(pid);
            return (await listJson<Evaluation>(join(projectDir(pid), "evaluations")))
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .map(evaluationSummary);
          },
          get: (pid, id) => readJson<Evaluation>(join(projectDir(pid), "evaluations", `${safeId(id)}.json`)),
          async put(value, expected) {
            assertEvaluationVersion(value, expected);
            await requireProjectDir(value.projectId);
            const file = join(projectDir(value.projectId), "evaluations", `${safeId(value.id)}.json`);
            await withLock(file, async () => {
              const old = await readJson<Evaluation>(file);
              if ((old?.version ?? null) !== expected) throw new ConflictError("Evaluation changed. Refresh and try again.");
              await writeJson(file, { ...value, ownerId: user.id });
            });
          },
        },
        revisionPreconditions: true,
        user,
        connections: {
          list: () => listJson<StoredConnection>(join(userDir, "connections")),
          get: (id) => readJson<StoredConnection>(join(userDir, "connections", `${safeId(id)}.json`)),
          async put(value, expected) {
            const file = join(userDir, "connections", `${safeId(value.id)}.json`);
            await withLock(file, async () => {
              const old = await readJson<StoredConnection>(file);
              if ((old?.version ?? null) !== expected) throw new ConflictError("Connection changed. Refresh and try again.");
              await writeJson(file, value);
            });
          },
          async delete(id, expected) {
            const file = join(userDir, "connections", `${safeId(id)}.json`);
            await withLock(file, async () => {
              if ((await readJson<StoredConnection>(file))?.version !== expected)
                throw new ConflictError("Connection changed. Refresh and try again.");
              await rm(file, { force: true });
            });
          },
        },

        projects: {
          async compareAndSwapSettings(id, expected, settings, now, competencyQuestions) {
            return withLock(`project:${user.id}:${id}`, async () => {
              const file = join(projectDir(id), "project.json");
              const cur = await readJson<Project>(file);
              if (!cur) throw new NotFoundError("project");
              if (JSON.stringify(cur.settings) !== JSON.stringify(expected))
                throw new ConflictError("Corpus sources or settings changed. Refresh and try again.");
              const next = { ...cur, settings, updatedAt: now, ...(competencyQuestions ? { competencyQuestions } : {}) };
              await writeJson(file, next);
              return next;
            });
          },
          async list() {
            return listJsonDirs<Project>(join(userDir, "p"), "project.json");
          },
          async get(id) {
            return readJson<Project>(join(projectDir(id), "project.json"));
          },
          async create(project) {
            await writeJson(join(projectDir(project.id), "project.json"), project);
            return project;
          },
          async update(id, patch) {
            return withLock(`project:${user.id}:${id}`, async () => {
              const file = join(projectDir(id), "project.json");
              const cur = await readJson<Project>(file);
              if (!cur) throw new NotFoundError("project");
              const next = { ...cur, ...patch, id: cur.id, ownerId: cur.ownerId, createdAt: cur.createdAt };
              if (patch.settings && cur.settings.corpus)
                next.settings = { ...patch.settings, corpus: { ...cur.settings.corpus, version: cur.settings.corpus.version + 1 } };
              await writeJson(file, next);
              return next;
            });
          },
          async delete(id) {
            await rm(projectDir(id), { recursive: true, force: true });
            await rm(join(blobDir, safeId(id, "project")), { recursive: true, force: true });
          },
        },

        documents: {
          async claimProcessing(pid, id, holder, expiresAt, now, unchunked) {
            return withLock(`doc:${user.id}:${id}`, async () => {
              const file = join(projectDir(pid), "docs", `${safeId(id)}.json`);
              const doc = await readJson<ProjectDocument>(file);
              if (
                !doc ||
                (unchunked ? doc.parseState !== "parsed" || doc.chunkCount > 0 : doc.parseState !== "pending") ||
                (doc.processing?.expiresAt && doc.processing.expiresAt > now)
              )
                return null;
              const next: ProjectDocument = {
                ...doc,
                parseState: "pending",
                processing: { ...doc.processing, stage: unchunked ? "chunking" : "parsing", holder, expiresAt },
              };
              await writeJson(file, next);
              return next;
            });
          },
          async finishProcessing(pid, id, holder, patch, output) {
            return withLock(`doc:${user.id}:${id}`, async () => {
              const file = join(projectDir(pid), "docs", `${safeId(id)}.json`);
              const doc = await readJson<ProjectDocument>(file);
              if (!doc || doc.processing?.holder !== holder) return null;
              if (output) await writeJson(join(projectDir(pid), "text", `${safeId(id)}.json`), { ...output.text, chunks: output.chunks });
              const next = { ...doc, ...patch, processing: null };
              await writeJson(file, next);
              return next;
            });
          },
          async list(pid) {
            await requireProjectDir(pid);
            const docs = await listJson<ProjectDocument>(join(projectDir(pid), "docs"));
            return docs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          },
          async get(pid, id) {
            return readJson<ProjectDocument>(join(projectDir(pid), "docs", `${safeId(id, "document")}.json`));
          },
          async create(doc) {
            await requireProjectDir(doc.projectId);
            const target = join(projectDir(doc.projectId), "docs", `${safeId(doc.id, "document")}.json`);
            await mkdir(resolve(target, ".."), { recursive: true });
            const tmp = `${target}.${randomUUID()}.tmp`;
            await writeFile(tmp, JSON.stringify(doc));
            try {
              await link(tmp, target);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ConflictError("Document already exists.");
              throw error;
            } finally {
              await rm(tmp, { force: true });
            }
            return doc;
          },
          async update(pid, id, patch) {
            return withLock(`doc:${user.id}:${id}`, async () => {
              const file = join(projectDir(pid), "docs", `${safeId(id, "document")}.json`);
              const cur = await readJson<ProjectDocument>(file);
              if (!cur) throw new NotFoundError("document");
              const next = { ...cur, ...patch, id: cur.id, projectId: cur.projectId, ownerId: cur.ownerId };
              await writeJson(file, next);
              return next;
            });
          },
          async delete(pid, id) {
            await withLock(`doc:${user.id}:${id}`, async () => {
              await rm(join(projectDir(pid), "docs", `${safeId(id, "document")}.json`), { force: true });
              await rm(join(projectDir(pid), "text", `${safeId(id, "document")}.json`), { force: true });
            });
          },
          async putText(pid, id, text, chunks) {
            await writeJson(join(projectDir(pid), "text", `${safeId(id, "document")}.json`), { ...text, chunks } satisfies StoredText);
          },
          async getText(pid, id) {
            const t = await readJson<StoredText>(join(projectDir(pid), "text", `${safeId(id, "document")}.json`));
            return t
              ? { text: t.text, pages: t.pages, sections: t.sections ?? [], tables: t.tables ?? [], sourceSpans: t.sourceSpans }
              : null;
          },
          async chunks(pid, documentIds) {
            await requireProjectDir(pid);
            const ids = documentIds ?? (await this.list(pid)).map((d) => d.id);
            const out: DocumentChunk[] = [];
            for (const id of ids) {
              const t = await readJson<StoredText>(join(projectDir(pid), "text", `${safeId(id, "document")}.json`));
              if (t) out.push(...t.chunks);
            }
            return out;
          },
          async search(pid, query, limit): Promise<ChunkHit[]> {
            const chunks = await this.chunks(pid);
            return scoreChunks(chunks, query, limit);
          },
        },

        revisions: {
          async list(pid) {
            await requireProjectDir(pid);
            const metas = await listJson<OntologyRevision>(join(projectDir(pid), "revisions"), ".meta.json");
            return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          },
          async get(pid, id) {
            const meta = await readJson<OntologyRevision>(revMeta(pid, id));
            if (!meta) return null;
            const content = await readJson<RevisionContent>(revContent(pid, id));
            return { ...meta, content: content ?? { modules: [], abox: null, baseIri: "" } } satisfies RevisionWithContent;
          },
          async create(rev, content) {
            await requireProjectDir(rev.projectId);
            await writeJson(revContent(rev.projectId, rev.id), content);
            await writeJson(revMeta(rev.projectId, rev.id), rev);
            return rev;
          },
          async updateDraft(pid, id, meta, content, expectedHash) {
            return withLock(`project:${user.id}:${pid}`, async () => {
              const cur = await readJson<OntologyRevision>(revMeta(pid, id));
              if (!cur) throw new NotFoundError("revision");
              if (cur.status !== "draft") throw new ConflictError("Committed revisions cannot be changed — create a new draft.");
              if (expectedHash !== undefined && cur.contentHash !== expectedHash)
                throw new ConflictError("This draft changed. Your edits are preserved; compare with the latest draft before saving.");
              const next = { ...cur, ...meta };
              await writeJson(revContent(pid, id), content);
              await writeJson(revMeta(pid, id), next);
              return next;
            });
          },
          async commit(pid, id, expectedParentId, now, expectedHash) {
            return withLock(`project:${user.id}:${pid}`, async () => {
              const pfile = join(projectDir(pid), "project.json");
              const project = await readJson<Project>(pfile);
              if (!project) throw new NotFoundError("project");
              if (project.currentRevisionId !== expectedParentId) {
                throw new ConflictError(
                  "The project changed since this draft was started — another revision was committed. Rebase the draft onto the current revision.",
                );
              }
              const rev = await readJson<OntologyRevision>(revMeta(pid, id));
              if (!rev) throw new NotFoundError("revision");
              if (rev.status !== "draft") throw new ConflictError("This revision is already committed.");
              if (expectedHash !== undefined && rev.contentHash !== expectedHash)
                throw new ConflictError("The draft changed during review. Validate the latest content before saving a version.");
              const all = await listJson<OntologyRevision>(join(projectDir(pid), "revisions"), ".meta.json");
              const number = all.reduce((n, r) => Math.max(n, r.number ?? 0), 0) + 1;
              const committed: OntologyRevision = { ...rev, status: "committed", number, committedAt: now, updatedAt: now };
              await writeJson(revMeta(pid, id), committed);
              await writeJson(pfile, { ...project, currentRevisionId: id, updatedAt: now });
              return committed;
            });
          },
          async delete(pid, id) {
            await rm(revMeta(pid, id), { force: true });
            await rm(revContent(pid, id), { force: true });
          },
        },

        runs: {
          async list(pid) {
            await requireProjectDir(pid);
            const runs = await listJson<ExtractionRun>(join(projectDir(pid), "runs"));
            return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          },
          async get(pid, id) {
            return readJson<ExtractionRun>(runFile(pid, id));
          },
          async create(run) {
            await requireProjectDir(run.projectId);
            await writeJson(runFile(run.projectId, run.id), run);
            return run;
          },
          async update(pid, id, patch, statuses) {
            return withLock(`run:${user.id}:${id}`, async () => {
              const cur = await readJson<ExtractionRun>(runFile(pid, id));
              if (!cur) throw new NotFoundError("run");
              if (statuses && !statuses.includes(cur.status)) return cur;
              const next = { ...cur, ...patch, id: cur.id, projectId: cur.projectId, ownerId: cur.ownerId };
              await writeJson(runFile(pid, id), next);
              return next;
            });
          },
          async acquireLease(pid, id, holder, ttlMs, now) {
            return withLock(`run:${user.id}:${id}`, async () => {
              const cur = await readJson<ExtractionRun>(runFile(pid, id));
              if (!cur) throw new NotFoundError("run");
              if (cur.lease && cur.lease.holder !== holder && new Date(cur.lease.expiresAt) > now) return null;
              const next = { ...cur, lease: { holder, expiresAt: new Date(now.getTime() + ttlMs).toISOString() } };
              await writeJson(runFile(pid, id), next);
              return next;
            });
          },
          async releaseLease(pid, id, holder) {
            await withLock(`run:${user.id}:${id}`, async () => {
              const cur = await readJson<ExtractionRun>(runFile(pid, id));
              if (!cur || cur.lease?.holder !== holder) return;
              await writeJson(runFile(pid, id), { ...cur, lease: null });
            });
          },
          async checkpoints(pid, runId) {
            const cps = await listJson<JobCheckpoint>(cpDir(pid, runId));
            return cps.sort((a, b) => a.ordinal - b.ordinal);
          },
          async putCheckpoint(pid, cp) {
            const dir = cpDir(pid, cp.runId);
            await mkdir(dir, { recursive: true });
            // Write the full body to a temp file, then hard-link it into place:
            // link() fails with EEXIST if the key is taken, so insert-if-absent is
            // atomic and the checkpoint is never visible half-written.
            const target = join(dir, keyFile(cp.key));
            const tmp = `${target}.${randomUUID()}.tmp`;
            await writeFile(tmp, JSON.stringify(cp));
            try {
              await link(tmp, target);
              return true;
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
              throw e;
            } finally {
              await rm(tmp, { force: true });
            }
          },
          async deleteCheckpoints(pid, runId, keyPrefix) {
            const dir = cpDir(pid, runId);
            let names: string[] = [];
            try {
              names = await readdir(dir);
            } catch {
              return;
            }
            for (const n of names) {
              if (!n.endsWith(".json")) continue;
              const base = n.slice(0, -".json".length);
              let key = "";
              try {
                key = Buffer.from(base, "base64url").toString("utf8");
              } catch {
                continue;
              }
              if (key.startsWith(keyPrefix)) await rm(join(dir, n), { force: true });
            }
          },
        },

        reports: {
          async latest(pid, revisionId) {
            return readJson<StoredValidationReport>(join(projectDir(pid), "reports", `${safeId(revisionId, "revision")}.json`));
          },
          async put(report) {
            await writeJson(join(projectDir(report.projectId), "reports", `${safeId(report.revisionId, "revision")}.json`), report);
          },
        },

        conversations: {
          async list(pid) {
            await requireProjectDir(pid);
            const all = await listJson<Conversation>(join(projectDir(pid), "conversations"));
            return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          },
          async get(pid, id) {
            return readJson<Conversation>(join(projectDir(pid), "conversations", `${safeId(id, "conversation")}.json`));
          },
          async put(c) {
            await writeJson(join(projectDir(c.projectId), "conversations", `${safeId(c.id, "conversation")}.json`), c);
          },
          async delete(pid, id) {
            await rm(join(projectDir(pid), "conversations", `${safeId(id, "conversation")}.json`), { force: true });
          },
        },

        blobs: {
          async put(path, bytes) {
            await writeAtomic(join(blobDir, safeRelPath(path)), bytes);
          },
          async get(path) {
            try {
              return await readFile(join(blobDir, safeRelPath(path)));
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
              throw e;
            }
          },
          async delete(path) {
            await rm(join(blobDir, safeRelPath(path)), { force: true });
          },
        },

        async usage() {
          const projects = await store.projects.list();
          let documents = 0;
          for (const p of projects) documents += (await store.documents.list(p.id)).length;
          return { usedBytes: await dirSize(userDir), projects: projects.length, documents };
        },
      };
      return store;
    },
  };
  return self;
}

/** Read `<dir>/<child>/<file>` for every child directory. */
async function listJsonDirs<T>(dir: string, file: string): Promise<T[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: T[] = [];
  for (const n of names) {
    const v = await readJson<T>(join(dir, n, file));
    if (v) out.push(v);
  }
  return out;
}
