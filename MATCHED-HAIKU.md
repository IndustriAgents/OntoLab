# Matched-citation Haiku results

## Replicate 1

| Arm | Whole-graph P | R | Lenient F1 | Strict F1 | Official sentence F1 | Located-citation coverage |
|---|---:|---:|---:|---:|---:|---:|
| ontolab | 0.606 | 0.459 | 0.523 | 0.391 | 0.180 | 1.000 |
| two-pass | 0.647 | 0.516 | 0.574 | 0.428 | 0.340 | 1.000 |

## Replicate 2

| Arm | Whole-graph P | R | Lenient F1 | Strict F1 | Official sentence F1 | Located-citation coverage |
|---|---:|---:|---:|---:|---:|---:|
| ontolab | 0.663 | 0.439 | 0.528 | 0.416 | 0.180 | 1.000 |
| two-pass | 0.662 | 0.532 | 0.590 | 0.443 | 0.350 | 1.000 |

## Paired bootstrap over topics

Replicates for a topic travel together. Confidence intervals condition on the observed runs.

| Metric | OntoLab [95% CI] | Two-pass [95% CI] | Difference [95% CI] | p |
|---|---:|---:|---:|---:|
| F1 | 0.525 [0.442, 0.605] | 0.582 [0.522, 0.636] | -0.057 [-0.117, +0.002] | 0.061 |
| Precision | 0.633 [0.541, 0.720] | 0.655 [0.581, 0.728] | -0.022 [-0.077, +0.049] | 0.473 |
| Recall | 0.449 [0.368, 0.530] | 0.524 [0.466, 0.578] | -0.075 [-0.140, -0.015] | 0.010 |
| F1 (strict) | 0.403 [0.316, 0.496] | 0.435 [0.350, 0.520] | -0.033 [-0.085, +0.016] | 0.198 |
| Located citation coverage | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] | +0.000 [+0.000, +0.000] | 1.000 |

## Cost per document

Token and API-equivalent USD estimates are means across document runs. Wall times are medians for the successful workflow executions under concurrency. Incomplete attempts are included when usage was emitted. Unmetered attempts are counted separately.

| Arm | Docs | Invocation count | Unmetered | Uncached input | Cache writes | Cache reads | Output | Total tokens | API-equiv. USD | API s | Wall s |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ontolab | 38 | 99 | 0 | 5 | 17,990 | 8,409 | 14,459 | 40,864 | 0.0109 | 67.4 | 75.6 |
| two-pass | 38 | 77 | 0 | 4 | 11,745 | 7,231 | 22,673 | 41,652 | 0.0138 | 82.8 | 82.0 |
