# OAEI tracks for the alignment stage

`npm run eval -- --stages alignment` runs every track folder here through
OntoLab's alignment service (lexical, semantic and structural matchers, and
optional model verification). It reports precision, recall and F1 against the
reference alignment, and how many classes the mappings make unsatisfiable
before and after coherence repair.

The OAEI test sets are not bundled because their licences differ by track. To
add a track:

1. Download a pair from <https://oaei.ontologymatching.org> (for example a
   Conference track pair such as `cmt`–`conference`).
2. Create a folder per pair and put three files in it:

```
eval/gold-oaei/<track>/
  source.owl     (or .rdf / .ttl)
  target.owl     (or .rdf / .ttl)
  reference.rdf  (Alignment API RDF/XML)
```

Files in OWL/XML syntax must first be saved as RDF/XML or Turtle, for example
with Protégé.

Matcher ablations (study 2) are in `eval/grids/study2-align-evolve.json`.
