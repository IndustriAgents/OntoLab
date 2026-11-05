---
title: "Validation messages"
description: "Interpret common validation and commit failures."
---

Read the finding’s severity, affected identifier and source context. The same logical issue can be surfaced by more than one validation layer.

| Finding | What to inspect | Typical response |
| --- | --- | --- |
| Duplicate or colliding identifier | Individuals that mint the same IRI | Give distinct things distinct identifiers |
| Unknown class/property | The selected T-Box and exact IRI | Correct the assertion or propose a schema change |
| Dangling relationship target | The linked individual | Restore the target or remove/correct the link |
| Disjoint classes | An individual’s asserted and inferred types | Revisit class membership and schema meaning |
| Datatype / lexical warning | Value and datatype, such as decimal | Use a valid literal with appropriate units |
| Domain/range warning | Relationship direction and endpoint types | Correct the link or review schema constraints |
| Functional/cardinality finding | Multiple values or missing relationships | Resolve the real-world interpretation before changing data |
| Unsupported logical construct | Reasoner coverage and ontology feature | Use a suitable reasoner or model a supported construct |
| Stale report | Revision content changed since validation | Validate the selected draft again |

## Commit responses

**428 — confirmation required:** introduced warnings need review and explicit confirmation. This is a review step, not a server outage.

**422 — invalid change:** introduced blocking problems prevent the commit. Acknowledging warnings cannot override them.

**409 — conflict:** the parent revision may be stale, or a review policy may require an acknowledgement. Read the message and compare the current revision before retrying.

**401 — access denied:** reopen the workspace from the desktop app if its local session has expired.

For failed model calls, parsing failures or stalled runs, use [troubleshooting](../help/troubleshooting.md).
