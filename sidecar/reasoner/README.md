# OntoLab DL reasoner sidecar

An optional Java service that runs a complete OWL 2 DL reasoner (HermiT, via
OWL API 5) for OntoLab. Without it, OntoLab uses its in-process OWL 2 RL engine
(`src/lib/ontology/reasoner/`). That engine is fast and explains every finding,
but it does not reason over the individuals that `someValuesFrom` and
`minCardinality` imply, and it ignores unions, complements and nominals. Its
reports say this under "Not checked".

The Node server uses the sidecar when `REASONER_URL` is set. If the sidecar
times out or is unreachable, the server falls back to RL and says so in the
report.

| Variable | Where | Meaning |
| --- | --- | --- |
| `REASONER_URL` | Node | e.g. `http://localhost:8091` |
| `REASONER_TOKEN` | both | shared secret sent as `x-token` (optional) |
| `REASONER_TIMEOUT_MS` | Node | how long to wait (default 60 000) |
| `REASONER_TIER` | Node | `auto` (DL when the URL is set), `rl`, `dl`, or `off` |
| `PORT` | sidecar | default 8091 |
| `REASON_TIMEOUT_MS` | sidecar | HermiT time limit per request (default 55 000) |
| `MAX_BODY_BYTES` | sidecar | default 50 MB |

## Build and run

```sh
docker build -t ontolab-reasoner sidecar/reasoner
docker run -p 127.0.0.1:8091:8091 ontolab-reasoner
REASONER_URL=http://localhost:8091 npm run dev
```

Status: written against OWL API 5.1.20, HermiT 1.4.5.519 and owlexplanation
5.0.0. It has not been built yet: the development machine has no JDK. The
first `docker build` is also the first compile. The Node side of the contract
is tested in `tests/reasoner.test.ts` against a stand-in server.

ELK is not bundled. A request with `"reasoner": "elk"` runs HermiT and records
that in `incomplete`.

## HTTP contract

### `GET /health`

```json
{"ok": true, "reasoner": "hermit", "owlapi": "5"}
```

### `POST /reason`

```json
{
  "modules": [{"name": "core.ttl", "turtle": "..."}],
  "abox": "... Turtle, may be empty ...",
  "reasoner": "hermit",
  "tasks": ["consistency", "unsat", "classify", "explain"],
  "maxExplanations": 10
}
```

`owl:imports` are never fetched; every module must be in the request.

The response has the same shape as `ReasonerReport` in
`src/lib/ontology/reasoner/types.ts`:

- `tier: "dl"`, `reasoner: "hermit"`, `consistent`
- `clashes`: when the whole is inconsistent, one clash with
  `code: "inconsistent"` and one justification. `subjects` lists the
  individual IRIs in that justification.
- `unsatisfiable`: `{cls, reason, explanation}`. At most `maxExplanations`
  of them carry an explanation.
- `subsumptions` and `propertySubsumptions`: all named pairs, inferred or
  asserted.
- `inferredTypes`: individual IRI → classes beyond the asserted ones.
- `incomplete`: what was not computed (explanation time-outs, classification
  of an inconsistent ontology, and so on).

Each axiom in an explanation is `{id, kind, args, module?, individualId?}`.
`kind` is one of the RL kinds (`subClassOf`, `disjointWith`, `domain`,
`range`, `type`, `link`, …). An axiom with no matching kind is `other`, and
its Manchester-syntax rendering is in `args[0]`. The Node server maps
individual IRIs back to A-Box ids.

Errors: `401` (bad token), `400` (bad JSON), `422` (a module does not parse),
`500`.
