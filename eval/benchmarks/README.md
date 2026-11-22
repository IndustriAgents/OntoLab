# OntoLab benchmark replay

## OAEI Conference ontology alignment

This offline comparison scores frozen OntoLab predictions and archived OAEI 2023 and 2025 submissions on the same 21 public Conference ontology pairs and 305 reference equivalences in `ra1-M3`. [Results CSV](oaei-conference.csv)

| System | True positives | Predictions | Precision | Recall | F1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| GraphMatcher (2023) | 243 | 315 | 0.771 | 0.797 | 0.784 |
| OntoLab + Gemini | 214 | 272 | 0.787 | 0.702 | 0.742 |
| SORBETMtch (2023) | 194 | 248 | 0.782 | 0.636 | 0.702 |
| OntoLab + Haiku | 198 | 271 | 0.731 | 0.649 | 0.688 |
| ALIN (2025) | 214 | 325 | 0.658 | 0.702 | 0.679 |
| LogMap (2025) | 177 | 218 | 0.812 | 0.580 | 0.677 |
| Matcha (2025) | 171 | 202 | 0.847 | 0.561 | 0.675 |
| OntoLab + Luna | 169 | 213 | 0.793 | 0.554 | 0.653 |
| MDMapper (2025) | 161 | 202 | 0.797 | 0.528 | 0.635 |
| Agent-OM (2025) | 183 | 275 | 0.665 | 0.600 | 0.631 |

The table shows each archived system once, using its higher-scoring campaign year, down to Agent-OM. The [CSV](oaei-conference.csv) lists every submission from both years.

With Gemini, OntoLab recovered as many reference equivalences as the highest-scoring archived 2025 submission and made 53 fewer predictions. The result is model-dependent. GraphMatcher scored higher on this reference, and the OAEI organizers report that GraphMatcher used reference alignments in cross-validation. This replay uses the public reference. The official campaigns use the blind `rar2-M3` reference for their main rankings.

OntoLab was not blind to this reference either. Fixes in OntoLab's grounding, extraction and alignment code ([#43](https://github.com/IndustriAgents/OntoLab/pull/43), [#44](https://github.com/IndustriAgents/OntoLab/pull/44)) came from running these benchmarks against the public `ra1-M3` reference. Treat the OntoLab rows as development-set scores. The archived entrants, by contrast, get the confidence threshold that maximizes their F1 on the same reference, which favors them. [OAEI 2023](https://oaei.ontologymatching.org/2023/results/conference/) · [OAEI 2025](https://oaei.ontologymatching.org/2025/results/conference/)

### Reproduce

Use Python 3.11 or later and `rdflib==7.6.0`. The frozen OntoLab predictions are in [`predictions/`](predictions/), one JSON file per verifier model. Each file holds the scored candidates and token usage for every ontology pair. The Gemini file also contains three MSE pairs, which the scorer skips. The OntoLab paper's replay kit can prepare the 21 pair folders from checksum-verified upstream reference archives. Point `TRACKS` at those folders, each with `source.owl`, `target.owl`, and `reference.rdf`. Download the two submission archives separately. The code invokes no LLM.

```bash
curl -fL https://oaei.ontologymatching.org/2023/conference/data/conference2023results.zip -o conference-2023.zip
curl -fL https://oaei.ontologymatching.org/2025/results/conference/conference_files/conference-track-2025.zip -o conference-2025.zip

python eval/benchmarks/compare_oaei_conference.py "$TRACKS" \
  --archive 2023=conference-2023.zip --archive 2025=conference-2025.zip \
  --ontolab "Gemini=eval/benchmarks/predictions/gemini-3.8-flash-low.json" \
  --ontolab "Haiku=eval/benchmarks/predictions/haiku.json" \
  --ontolab "Luna=eval/benchmarks/predictions/gpt-6-luna.json" \
  > oaei-conference-replay.csv
```

| Archive | SHA-256 |
| --- | --- |
| 2023 submissions | `59baf5add725f3e1d6d402f4e2dcf4cbb6c82b916f9fa885e8f56a5a96710ba9` |
| 2025 submissions | `e2266b2dedbf7636196e315fa9b8f12ebe327aa2226381a355d9beb5becceb7f` |

The scorer counts declared class and property equivalences and micro-averages the counts over ontology pairs. It reconciles the `confOf` namespace spelling used in the submissions. For the archived entrants, the threshold maximizes F1 on the public reference. For OntoLab, the replay applies the frozen equivalence verdicts and the archived greedy matching rule. The table is a retrospective comparison of saved outputs. It measures equivalence matching on this track.
