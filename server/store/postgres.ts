// Long-lived Node/Cloud Run process: TCP pg pool, using Neon's pooled URL.
// Every operation runs as a non-owner role with transaction-local RLS context.
import { Pool, type PoolClient } from "pg";
import { postgresConnectionString } from "./connection.ts";
import type {
  Conversation,
  DocumentChunk,
  ExtractionRun,
  JobCheckpoint,
  OntologyRevision,
  Project,
  ProjectDocument,
  RevisionContent,
  StoredValidationReport,
  User,
} from "../../src/types/project.ts";
import { ConflictError, NotFoundError, type Store, type UserStore } from "./types.ts";
import { tokenize } from "./search.ts";
import type { StoredConnection } from "../connections/types.ts";
import type { Evaluation, EvaluationSummary } from "../../src/types/evaluation.ts";
import { assertEvaluationVersion } from "./evaluation.ts";

const json = (value: unknown) => JSON.stringify(value);
type Kind = "document" | "text" | "chunk" | "revision" | "run" | "checkpoint" | "report" | "conversation" | "evaluation";
type Row<T> = { data: T; content: RevisionContent; lease_holder: string | null; lease_expires_at: Date | null };

export function createPostgresStore(connectionString: string): Store {
  const pool = new Pool({
    connectionString: postgresConnectionString(connectionString),
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 30_000,
    application_name: "ontolab",
  });
  pool.on("error", () => console.error("Postgres idle connection failed; the pool will reconnect."));

  async function transaction<T>(userId: string, fn: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await pool.connect();
    try {
      await db.query("begin");
      await db.query("set local role ontolab_app");
      await db.query("select set_config('ontolab.user_id', $1, true)", [userId]);
      const result = await fn(db);
      await db.query("commit");
      return result;
    } catch (error) {
      await db.query("rollback").catch(() => {});
      throw error;
    } finally {
      db.release();
    }
  }

  function bind(user: User): UserStore {
    const tx = <T>(fn: (db: PoolClient) => Promise<T>) => transaction(user.id, fn);
    const get = async <T>(db: PoolClient, pid: string, kind: Kind, id: string, lock = false): Promise<Row<T> | null> =>
      (
        await db.query<Row<T>>(
          `select * from ontolab.records where owner_id=$1 and project_id=$2 and kind=$3 and id=$4${lock ? " for update" : ""}`,
          [user.id, pid, kind, id],
        )
      ).rows[0] ?? null;
    const list = <T>(pid: string, kind: Kind, descending = false) =>
      tx(async (db) =>
        (
          await db.query<Row<T>>(
            `select data from ontolab.records where owner_id=$1 and project_id=$2 and kind=$3 order by coalesce(data->>'createdAt',data->>'updatedAt') ${descending ? "desc" : "asc"}, id`,
            [user.id, pid, kind],
          )
        ).rows.map((r) => r.data),
      );
    const put = async (db: PoolClient, pid: string, kind: Kind, id: string, data: unknown, upsert = false) => {
      await db.query(
        `insert into ontolab.records(owner_id,project_id,kind,id,data) values($1,$2,$3,$4,$5)${upsert ? " on conflict(owner_id,project_id,kind,id) do update set data=excluded.data" : ""}`,
        [user.id, pid, kind, id, json(data)],
      );
    };
    const remove = (pid: string, kind: Kind, id: string) =>
      tx(async (db) => {
        await db.query("delete from ontolab.records where owner_id=$1 and project_id=$2 and kind=$3 and id=$4", [user.id, pid, kind, id]);
      });
    const update = <T>(pid: string, kind: Kind, id: string, patch: unknown) =>
      tx(async (db) => {
        const row = (
          await db.query<Row<T>>(
            "update ontolab.records set data=data || $5::jsonb where owner_id=$1 and project_id=$2 and kind=$3 and id=$4 returning data",
            [user.id, pid, kind, id, json(patch)],
          )
        ).rows[0];
        if (!row) throw new NotFoundError(kind);
        return row.data;
      });
    const run = (r: Row<ExtractionRun>): ExtractionRun => ({
      ...r.data,
      lease: r.lease_holder && r.lease_expires_at ? { holder: r.lease_holder, expiresAt: r.lease_expires_at.toISOString() } : null,
    });
    const checkpointId = (runId: string, key: string) => json([runId, key]);

    return {
      evaluations: {
        list: (pid) =>
          tx(async (db) =>
            (
              await db.query<{ data: EvaluationSummary }>(
                `select jsonb_build_object(
            'id',id,'projectId',project_id,'title',data->'title','createdAt',data->'createdAt','updatedAt',data->'updatedAt',
            'state',data->'state','provider',data->'provider','model',data->'model','recordedCostUsd',data->'recordedCostUsd',
            'baseline',jsonb_build_object('number',data->'baseline'->'number','revisionId',data->'baseline'->'revisionId'),
            'candidate',jsonb_build_object('number',data->'candidate'->'number','revisionId',data->'candidate'->'revisionId'),
            'questionCount',jsonb_array_length(data->'questions'),
            'completedAnswers',coalesce(jsonb_array_length(data->'attempts'->-1->'captures'),0),
            'totalAnswers',jsonb_array_length(data->'questions')*2,
            'reportCount',jsonb_array_length(data->'reports')) as data
           from ontolab.records where owner_id=$1 and project_id=$2 and kind='evaluation' order by data->>'createdAt' desc`,
                [user.id, pid],
              )
            ).rows.map((r) => r.data),
          ),
        get: (pid, id) => tx(async (db) => (await get<Evaluation>(db, pid, "evaluation", id))?.data ?? null),
        put: (value, expected) =>
          tx(async (db) => {
            assertEvaluationVersion(value, expected);
            const data = json({ ...value, ownerId: user.id });
            const result =
              expected === null
                ? await db.query(
                    "insert into ontolab.records(owner_id,project_id,kind,id,data) values($1,$2,'evaluation',$3,$4) on conflict do nothing",
                    [user.id, value.projectId, value.id, data],
                  )
                : await db.query(
                    "update ontolab.records set data=$4 where owner_id=$1 and project_id=$2 and kind='evaluation' and id=$3 and (data->>'version')::int=$5",
                    [user.id, value.projectId, value.id, data, expected],
                  );
            if (!result.rowCount) throw new ConflictError("Evaluation changed. Refresh and try again.");
          }),
      },
      revisionPreconditions: true,
      user,
      connections: {
        list: () =>
          tx(async (db) =>
            (
              await db.query<{ data: StoredConnection }>("select data from ontolab.graph_connections where owner_id=$1 order by id", [
                user.id,
              ])
            ).rows.map((r) => r.data),
          ),
        get: (id) =>
          tx(
            async (db) =>
              (
                await db.query<{ data: StoredConnection }>("select data from ontolab.graph_connections where owner_id=$1 and id=$2", [
                  user.id,
                  id,
                ])
              ).rows[0]?.data ?? null,
          ),
        put: (value, expected) =>
          tx(async (db) => {
            const result =
              expected === null
                ? await db.query("insert into ontolab.graph_connections(owner_id,id,data) values($1,$2,$3) on conflict do nothing", [
                    user.id,
                    value.id,
                    json(value),
                  ])
                : await db.query(
                    "update ontolab.graph_connections set data=$3 where owner_id=$1 and id=$2 and (data->>'version')::int=$4",
                    [user.id, value.id, json(value), expected],
                  );
            if (!result.rowCount) throw new ConflictError("Connection changed. Refresh and try again.");
          }),
        delete: (id, expected) =>
          tx(async (db) => {
            const result = await db.query(
              "delete from ontolab.graph_connections where owner_id=$1 and id=$2 and (data->>'version')::int=$3",
              [user.id, id, expected],
            );
            if (!result.rowCount) throw new ConflictError("Connection changed. Refresh and try again.");
          }),
      },
      projects: {
        compareAndSwapSettings: (id, expected, settings, now, competencyQuestions) =>
          tx(async (db) => {
            const row = (
              await db.query<{ data: Project }>(
                "update ontolab.projects set data=jsonb_set(jsonb_set(data,'{settings}',$4::jsonb),'{updatedAt}',to_jsonb($5::text)) || $6::jsonb where owner_id=$1 and id=$2 and data->'settings'=$3::jsonb returning data",
                [user.id, id, json(expected), json(settings), now, json(competencyQuestions ? { competencyQuestions } : {})],
              )
            ).rows[0];
            if (!row) throw new ConflictError("Corpus sources or settings changed. Refresh and try again.");
            return row.data;
          }),
        list: () =>
          tx(async (db) =>
            (
              await db.query<{ data: Project }>("select data from ontolab.projects where owner_id=$1 order by data->>'updatedAt' desc", [
                user.id,
              ])
            ).rows.map((r) => r.data),
          ),
        get: (id) =>
          tx(
            async (db) =>
              (await db.query<{ data: Project }>("select data from ontolab.projects where owner_id=$1 and id=$2", [user.id, id])).rows[0]
                ?.data ?? null,
          ),
        create: (p) =>
          tx(async (db) => {
            const data = { ...p, ownerId: user.id };
            await db.query("insert into ontolab.projects(owner_id,id,data) values($1,$2,$3)", [user.id, p.id, json(data)]);
            return data;
          }),
        update: (id, patch) =>
          tx(async (db) => {
            const row = (
              await db.query<{ data: Project }>(
                "update ontolab.projects set data=case when data#>'{settings,corpus}' is not null and $3::jsonb ? 'settings' then jsonb_set(data || $3::jsonb,'{settings,corpus}',(data#>'{settings,corpus}') || jsonb_build_object('version',(data#>>'{settings,corpus,version}')::int+1)) else data || $3::jsonb end where owner_id=$1 and id=$2 returning data",
                [user.id, id, json(patch)],
              )
            ).rows[0];
            if (!row) throw new NotFoundError("project");
            return row.data;
          }),
        delete: (id) =>
          tx(async (db) => {
            await db.query("delete from ontolab.projects where owner_id=$1 and id=$2", [user.id, id]);
          }),
      },
      documents: {
        claimProcessing: (pid, id, holder, expiresAt, now, unchunked) =>
          tx(async (db) => {
            const row = await get<ProjectDocument>(db, pid, "document", id, true);
            const doc = row?.data;
            if (
              !doc ||
              (unchunked ? doc.parseState !== "parsed" || doc.chunkCount > 0 : doc.parseState !== "pending") ||
              (doc.processing?.expiresAt && doc.processing.expiresAt > now)
            )
              return null;
            const data: ProjectDocument = {
              ...doc,
              parseState: "pending",
              processing: { ...doc.processing, stage: unchunked ? "chunking" : "parsing", holder, expiresAt },
            };
            await put(db, pid, "document", id, data, true);
            return data;
          }),
        finishProcessing: (pid, id, holder, patch, output) =>
          tx(async (db) => {
            const doc = (await get<ProjectDocument>(db, pid, "document", id, true))?.data;
            if (!doc || doc.processing?.holder !== holder) return null;
            if (output) {
              await put(db, pid, "text", id, output.text, true);
              await db.query(
                "delete from ontolab.records where owner_id=$1 and project_id=$2 and kind='chunk' and data->>'documentId'=$3",
                [user.id, pid, id],
              );
              for (const chunk of output.chunks) await put(db, pid, "chunk", chunk.id, chunk);
            }
            const data = { ...doc, ...patch, processing: null };
            await put(db, pid, "document", id, data, true);
            return data;
          }),
        list: (pid) => list<ProjectDocument>(pid, "document"),
        get: (pid, id) => tx(async (db) => (await get<ProjectDocument>(db, pid, "document", id))?.data ?? null),
        create: (doc) =>
          tx(async (db) => {
            const data = { ...doc, ownerId: user.id };
            await put(db, doc.projectId, "document", doc.id, data);
            return data;
          }),
        update: (pid, id, patch) => update<ProjectDocument>(pid, "document", id, patch),
        delete: (pid, id) =>
          tx(async (db) => {
            await db.query(
              "delete from ontolab.records where owner_id=$1 and project_id=$2 and ((kind in ('document','text') and id=$3) or (kind='chunk' and data->>'documentId'=$3))",
              [user.id, pid, id],
            );
          }),
        putText: (pid, id, text, chunks) =>
          tx(async (db) => {
            if (!(await get(db, pid, "document", id))) throw new NotFoundError("document");
            await put(db, pid, "text", id, text, true);
            await db.query("delete from ontolab.records where owner_id=$1 and project_id=$2 and kind='chunk' and data->>'documentId'=$3", [
              user.id,
              pid,
              id,
            ]);
            for (const chunk of chunks) await put(db, pid, "chunk", chunk.id, chunk);
          }),
        getText: (pid, id) =>
          tx(async (db) => (await get<Awaited<ReturnType<UserStore["documents"]["getText"]>>>(db, pid, "text", id))?.data ?? null),
        chunks: async (pid, ids) =>
          (await list<DocumentChunk>(pid, "chunk"))
            .filter((c) => !ids || ids.includes(c.documentId))
            .sort((a, b) => a.documentId.localeCompare(b.documentId) || a.ordinal - b.ordinal),
        search: (pid, query, limit) =>
          tx(async (db) => {
            const terms = [...new Set(tokenize(query))].slice(0, 24);
            if (!terms.length) return [];
            const rows = await db.query<{ data: DocumentChunk; score: number }>(
              "select data,ts_rank(to_tsvector('simple',data->>'text'),q) as score from ontolab.records,to_tsquery('simple',$3) q where owner_id=$1 and project_id=$2 and kind='chunk' and to_tsvector('simple',data->>'text') @@ q order by score desc limit $4",
              [user.id, pid, terms.join(" | "), Math.max(1, Math.min(50, limit))],
            );
            return rows.rows.map((r) => ({ ...r.data, score: Number(r.score) }));
          }),
      },
      revisions: {
        list: (pid) => list<OntologyRevision>(pid, "revision", true),
        get: (pid, id) =>
          tx(async (db) => {
            const r = await get<OntologyRevision>(db, pid, "revision", id);
            return r ? { ...r.data, content: r.content } : null;
          }),
        create: (rev, content) =>
          tx(async (db) => {
            await db.query("insert into ontolab.records(owner_id,project_id,kind,id,data,content) values($1,$2,'revision',$3,$4,$5)", [
              user.id,
              rev.projectId,
              rev.id,
              json(rev),
              json(content),
            ]);
            return rev;
          }),
        updateDraft: (pid, id, meta, content, expectedHash) =>
          tx(async (db) => {
            const r = await get<OntologyRevision>(db, pid, "revision", id, true);
            if (!r) throw new NotFoundError("revision");
            if (r.data.status !== "draft") throw new ConflictError("Committed revisions cannot be changed — create a new draft.");
            if (expectedHash !== undefined && r.data.contentHash !== expectedHash)
              throw new ConflictError("This draft changed. Compare your edits with the latest draft.");
            const data = { ...r.data, ...meta };
            await db.query("update ontolab.records set data=$5,content=$6 where owner_id=$1 and project_id=$2 and kind=$3 and id=$4", [
              user.id,
              pid,
              "revision",
              id,
              json(data),
              json(content),
            ]);
            return data;
          }),
        commit: (pid, id, expectedParentId, now, expectedHash) =>
          tx(async (db) => {
            const p = (
              await db.query<{ data: Project }>("select data from ontolab.projects where owner_id=$1 and id=$2 for update", [user.id, pid])
            ).rows[0];
            if (!p) throw new NotFoundError("project");
            if (p.data.currentRevisionId !== expectedParentId)
              throw new ConflictError("The project changed since this draft was started — another revision was committed.");
            const r = await get<OntologyRevision>(db, pid, "revision", id, true);
            if (!r) throw new NotFoundError("revision");
            if (r.data.status !== "draft") throw new ConflictError("The draft was already committed.");
            if (expectedHash !== undefined && r.data.contentHash !== expectedHash)
              throw new ConflictError("The draft changed during review.");
            const n = (
              await db.query<{ n: number }>(
                "select coalesce(max((data->>'number')::integer),0)+1 as n from ontolab.records where owner_id=$1 and project_id=$2 and kind='revision'",
                [user.id, pid],
              )
            ).rows[0].n;
            const data = { ...r.data, number: n, status: "committed" as const, committedAt: now, updatedAt: now };
            await db.query("update ontolab.records set data=$4 where owner_id=$1 and project_id=$2 and kind='revision' and id=$3", [
              user.id,
              pid,
              id,
              json(data),
            ]);
            await db.query("update ontolab.projects set data=data || $3::jsonb where owner_id=$1 and id=$2", [
              user.id,
              pid,
              json({ currentRevisionId: id, updatedAt: now }),
            ]);
            return data;
          }),
        delete: (pid, id) => remove(pid, "revision", id),
      },
      runs: {
        list: (pid) =>
          tx(async (db) =>
            (
              await db.query<Row<ExtractionRun>>(
                "select * from ontolab.records where owner_id=$1 and project_id=$2 and kind='run' order by data->>'createdAt' desc",
                [user.id, pid],
              )
            ).rows.map(run),
          ),
        get: (pid, id) =>
          tx(async (db) => {
            const r = await get<ExtractionRun>(db, pid, "run", id);
            return r ? run(r) : null;
          }),
        create: (r) =>
          tx(async (db) => {
            const data = { ...r, ownerId: user.id };
            await put(db, r.projectId, "run", r.id, data);
            return data;
          }),
        update: (pid, id, patch, statuses) =>
          tx(async (db) => {
            const r = await get<ExtractionRun>(db, pid, "run", id, true);
            if (!r) throw new NotFoundError("run");
            if (statuses && !statuses.includes(r.data.status)) return run(r);
            const data = { ...r.data, ...patch, id, projectId: pid, ownerId: user.id };
            data.lease = null;
            await db.query("update ontolab.records set data=$4 where owner_id=$1 and project_id=$2 and kind='run' and id=$3", [
              user.id,
              pid,
              id,
              json(data),
            ]);
            return run({ ...r, data });
          }),
        acquireLease: (pid, id, holder, ttlMs, now) =>
          tx(async (db) => {
            const r = (
              await db.query<Row<ExtractionRun>>(
                "update ontolab.records set lease_holder=$4,lease_expires_at=$5::timestamptz + $6::double precision * interval '1 millisecond' where owner_id=$1 and project_id=$2 and kind='run' and id=$3 and (lease_holder is null or lease_holder=$4 or lease_expires_at <= $5::timestamptz) returning *",
                [user.id, pid, id, holder, now.toISOString(), ttlMs],
              )
            ).rows[0];
            return r ? run(r) : null;
          }),
        releaseLease: (pid, id, holder) =>
          tx(async (db) => {
            await db.query(
              "update ontolab.records set lease_holder=null,lease_expires_at=null where owner_id=$1 and project_id=$2 and kind='run' and id=$3 and lease_holder=$4",
              [user.id, pid, id, holder],
            );
          }),
        checkpoints: async (pid, rid) =>
          (await list<JobCheckpoint>(pid, "checkpoint")).filter((cp) => cp.runId === rid).sort((a, b) => a.ordinal - b.ordinal),
        putCheckpoint: (pid, cp) =>
          tx(async (db) => {
            const result = await db.query(
              "insert into ontolab.records(owner_id,project_id,kind,id,data) values($1,$2,'checkpoint',$3,$4) on conflict do nothing returning id",
              [user.id, pid, checkpointId(cp.runId, cp.key), json(cp)],
            );
            return result.rowCount === 1;
          }),
        deleteCheckpoints: (pid, rid, prefix) =>
          tx(async (db) => {
            await db.query(
              "delete from ontolab.records where owner_id=$1 and project_id=$2 and kind='checkpoint' and data->>'runId'=$3 and left(data->>'key',length($4))=$4",
              [user.id, pid, rid, prefix],
            );
          }),
      },
      reports: {
        latest: (pid, rid) => tx(async (db) => (await get<StoredValidationReport>(db, pid, "report", rid))?.data ?? null),
        put: (report) => tx((db) => put(db, report.projectId, "report", report.revisionId, report, true)),
      },
      conversations: {
        list: (pid) => list<Conversation>(pid, "conversation", true),
        get: (pid, id) => tx(async (db) => (await get<Conversation>(db, pid, "conversation", id))?.data ?? null),
        put: (c) => tx((db) => put(db, c.projectId, "conversation", c.id, c, true)),
        delete: (pid, id) => remove(pid, "conversation", id),
      },
      blobs: {
        put: (path, bytes, contentType) =>
          tx(async (db) => {
            await db.query(
              "insert into ontolab.blobs(owner_id,project_id,path,bytes,content_type) values($1,$2,$3,$4,$5) on conflict(owner_id,path) do update set bytes=excluded.bytes,content_type=excluded.content_type",
              [user.id, path.startsWith("agent/") ? null : path.split("/")[0], path, bytes, contentType],
            );
          }),
        get: (path) =>
          tx(
            async (db) =>
              (await db.query<{ bytes: Buffer }>("select bytes from ontolab.blobs where owner_id=$1 and path=$2", [user.id, path])).rows[0]
                ?.bytes ?? null,
          ),
        delete: (path) =>
          tx(async (db) => {
            await db.query("delete from ontolab.blobs where owner_id=$1 and path=$2", [user.id, path]);
          }),
      },
      usage: () =>
        tx(async (db) => {
          const { rows } = await db.query<{ projects: string; documents: string; used_bytes: string }>(
            "select (select count(*) from ontolab.projects where owner_id=$1) as projects,(select count(*) from ontolab.records where owner_id=$1 and kind='document') as documents,coalesce((select sum(octet_length(bytes)) from ontolab.blobs where owner_id=$1),0)+coalesce((select sum(octet_length(data::text)+coalesce(octet_length(content::text),0)) from ontolab.records where owner_id=$1),0) as used_bytes",
            [user.id],
          );
          return { projects: Number(rows[0].projects), documents: Number(rows[0].documents), usedBytes: Number(rows[0].used_bytes) };
        }),
    };
  }

  return {
    kind: "postgres",
    forUser: bind,
    close: () => pool.end(),
    worker: {
      activeEvaluations: async () => {
        const db = await pool.connect();
        try {
          await db.query("begin");
          await db.query("set local role ontolab_worker");
          const result = await db.query<{ owner_id: string; project_id: string; id: string }>(
            "select owner_id,project_id,id from ontolab.records where kind='evaluation' and data->>'state' in ('queued','running','cancelling') order by data->>'updatedAt' limit 100",
          );
          await db.query("commit");
          return result.rows.map((r) => ({ ownerId: r.owner_id, projectId: r.project_id, evaluationId: r.id }));
        } catch (error) {
          await db.query("rollback").catch(() => {});
          throw error;
        } finally {
          db.release();
        }
      },
      pendingDocuments: async () => {
        const db = await pool.connect();
        try {
          await db.query("begin");
          await db.query("set local role ontolab_worker");
          const result = await db.query<{ owner_id: string; project_id: string; id: string }>(
            "select owner_id,project_id,id from ontolab.records where kind='document' and data->>'parseState'='pending' and (data->'processing'->>'expiresAt' is null or (data->'processing'->>'expiresAt')::timestamptz <= now()) order by data->>'createdAt' limit 100",
          );
          await db.query("commit");
          return result.rows.map((r) => ({ ownerId: r.owner_id, projectId: r.project_id, documentId: r.id }));
        } catch (error) {
          await db.query("rollback").catch(() => {});
          throw error;
        } finally {
          db.release();
        }
      },
      activeRuns: async () => {
        const db = await pool.connect();
        try {
          await db.query("begin");
          await db.query("set local role ontolab_worker");
          const result = await db.query<{ owner_id: string; project_id: string; id: string }>(
            "select owner_id,project_id,id from ontolab.records where kind='run' and data->>'status' in ('queued','running') limit 500",
          );
          await db.query("commit");
          return result.rows.map((r) => ({ ownerId: r.owner_id, projectId: r.project_id, runId: r.id }));
        } catch (error) {
          await db.query("rollback").catch(() => {});
          throw error;
        } finally {
          db.release();
        }
      },
      forOwner: (id) => bind({ id }),
    },
  };
}
