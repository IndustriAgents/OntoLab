# OntoLab evaluation replay

This release contains experimental outputs and tools for checking the reported benchmark scores. For the public source code, see [IndustriAgents/OntoLab](https://github.com/IndustriAgents/OntoLab). `experiments/ONTOLAB_VERSION.md` identifies the source revisions and measurement patches.

Run the following from the archive root with Python 3.11 or 3.12.

```sh
cd experiments
python3 -m venv .venv
.venv/bin/python -m pip install -r replay-requirements.txt
bash converters/run_stats.sh
.venv/bin/python ../paper/figures/make_figures.py
```

The replay uses frozen predictions, benchmark indices and archived official scores. Its default alignment task fetches the public OAEI reference archives and validates their checksums. `--offline` omits that task. The SHA-256 file at the top level covers each release payload. This archive excludes reviewer packs, private assignments, human ratings and protected competency-question materials.

The real-document pH walkthrough is under `examples/usgs-ph-review/`. It demonstrates review and committed provenance export on two actual proposals. Its illustrative decisions are separate from the independent human study.

## Data sources and terms

- Benchmark identifiers, ontologies, reference facts and derivatives of Text2KGBench are credited to Nandana Mihindukulasooriya, Sanju Tiwari, Carlos F. Enguix and Kavitha Srinivas. The upstream project identifies its [DBpedia-WebNLG source](https://gitlab.com/shimorina/webnlg-dataset) as CC BY-NC-SA 4.0 and its [Wikidata-TekGen source](https://github.com/google-research-datasets/KELM-corpus) as CC BY-SA 2.0. The associated [Text2KGBench repository and license notice](https://github.com/cenguix/Text2KGBench#license) describe the source data. These terms continue to apply to the respective benchmark materials and their derivatives. The replay omits benchmark sentence text from reference and per-sentence evaluator snapshots. Reference scores and prediction outputs are frozen at the versions in the accompanying files.
- The [OAEI 2023 Conference track](https://oaei.ontologymatching.org/2023/conference/) reference is fetched from the public upstream site by the replay script. The archive retains OntoLab and baseline mapping outputs.
- Taxonomy metric files are from the OntoLab experiments on the [OLLM arXiv benchmark](https://github.com/andylolu2/ollm); they contain experimental scores.
- The USGS worked example uses text from [Use of Multiparameter Instruments for Routine Field Measurements](https://doi.org/10.3133/tm9A6.8), Techniques and Methods 9-A6.8 (ver. 1.1, June 2025). Credit U.S. Geological Survey. The text excerpt retains its U.S. public-domain status. [USGS copyright and credit policy](https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits)
