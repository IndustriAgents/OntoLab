import type { RouteCtx } from "./app.ts";
import type { Router } from "./router.ts";
import { FileResponse, StatusResponse } from "./router.ts";
import { requireProject } from "./services/projects.ts";
import * as evaluations from "./services/evaluations.ts";

export function registerEvaluationRoutes(r: Router<RouteCtx>) {
  const base = "/api/projects/:pid/evaluations";
  r.get(`${base}/setup`, async ({ svc, params }) => evaluations.evaluationSetup(svc, params.pid));
  r.get(base, async ({ svc, params }) => {
    await requireProject(svc, params.pid);
    return { evaluations: await svc.store.evaluations.list(params.pid) };
  });
  r.post(
    base,
    async ({ svc, params, json }) =>
      new StatusResponse(201, { evaluation: await evaluations.createEvaluation(svc, params.pid, await json()) }),
  );
  r.patch(`${base}/:eid`, async ({ svc, params, json }) => ({
    evaluation: await evaluations.updateEvaluation(svc, params.pid, params.eid, await json()),
  }));
  r.get(`${base}/:eid`, async ({ svc, params }) => ({ evaluation: await evaluations.requireEvaluation(svc, params.pid, params.eid) }));
  r.post(
    `${base}/:eid/start`,
    async ({ svc, params, json }) => ({ evaluation: await evaluations.startEvaluation(svc, params.pid, params.eid, await json()) }),
    { llm: true },
  );
  r.post(
    `${base}/:eid/retry`,
    async ({ svc, params, json }) => ({ evaluation: await evaluations.startEvaluation(svc, params.pid, params.eid, await json(), true) }),
    { llm: true },
  );
  r.post(
    `${base}/:eid/advance`,
    async ({ svc, params }) => ({ evaluation: await evaluations.advanceEvaluation(svc, params.pid, params.eid) }),
    { llm: true, abortOnClose: false },
  );
  r.post(`${base}/:eid/cancel`, async ({ svc, params }) => ({
    evaluation: await evaluations.cancelEvaluation(svc, params.pid, params.eid),
  }));
  r.post(`${base}/:eid/reviews`, async ({ svc, params, json }) => ({
    evaluation: await evaluations.reviewEvaluation(svc, params.pid, params.eid, await json()),
  }));
  r.post(`${base}/:eid/reports`, async ({ svc, params }) => ({
    evaluation: await evaluations.saveEvaluationReport(svc, params.pid, params.eid),
  }));
  r.get(`${base}/:eid/sources/:sid`, async ({ svc, params }) => evaluations.evaluationSource(svc, params.pid, params.eid, params.sid));
  r.get(
    `${base}/:eid/reports/:rid/export`,
    async ({ svc, params }) =>
      new FileResponse(
        JSON.stringify(await evaluations.exportEvaluationReport(svc, params.pid, params.eid, params.rid), null, 2),
        "application/json",
        `ontolab-evaluation-${params.rid}.json`,
      ),
  );
}
