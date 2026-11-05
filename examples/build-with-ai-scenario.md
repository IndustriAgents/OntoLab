# Test scenario — Build with AI (no documents)

A copy-paste scenario for the **Build with AI** page that exercises the purpose / scope /
competency-question / guidance path **without uploading any documents** — generation runs
from the specification alone.

**How to use:** T-Box Generation → step 1 *Base T-Box* → **Build with AI** → paste each
section below into the matching field → **Generate T-Box** → validate → commit.
Leave *Source documents* and *Standards* empty.

---

## Purpose — what is this ontology for?

```
Describe a wind farm and its maintenance operations so that a planning system can
reason over turbines, their components, the sensors monitoring them, and the
maintenance tasks scheduled to keep them running.
```

## Scope — what is in / out of scope?

```
In scope: wind turbines and their major components (rotor, gearbox, generator,
tower), condition-monitoring sensors and their readings, faults detected on
components, and maintenance tasks with schedules and technicians.
Out of scope: electricity market prices, grid transmission infrastructure,
procurement, and personnel management beyond task assignment.
```

## Competency questions

Add each as its own question row:

```
Which sensors monitor which turbine components?
```

```
Which components have an open fault, and which turbine do they belong to?
```

```
Which maintenance tasks are due, and which technician is assigned to each?
```

```
What is the latest reading value and unit reported by a given sensor?
```

## Additional guidance (optional)

```
Keep the hierarchy shallow (max 3 levels). Use one Component superclass with the
major parts as subclasses. Model readings with a numeric value, a unit and a
timestamp as data properties. Prefer camelCase object properties like
monitors, hasComponent, detectedOn, assignedTo.
```

## Base IRI

```
http://ontolab.example/windfarm#
```

---

## What to check after generation

- The draft opens in the **Edit Turtle** tab with classes like `Turbine`, `Component`,
  `Sensor`, `Fault`, `MaintenanceTask` and the properties the guidance asked for.
- Every competency question is answerable from the schema (e.g. Q1 needs
  `Sensor —monitors→ Component` and `Turbine —hasComponent→ Component`).
- **Validate & Commit** passes with no errors.
- After a later A-Box extraction, **Review → Questions** shows the four questions
  pre-loaded under *Saved questions* (the carry-forward feature).
