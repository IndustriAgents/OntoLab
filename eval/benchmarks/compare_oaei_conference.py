"""Rescore frozen OntoLab and OAEI Conference submissions on public ra1-M3.

Requires Python 3.11+ and rdflib. Inputs are described in the benchmark report.
"""
import argparse
from collections import defaultdict
import csv
from functools import cache
import json
import sys
from pathlib import Path
import xml.etree.ElementTree as xml
from zipfile import ZipFile

from rdflib import Graph, OWL, RDF, RDFS, URIRef

RESOURCE = f"{{{RDF}}}resource"
SCHEMA_TYPES = (OWL.Class, RDFS.Class, RDF.Property, OWL.ObjectProperty,
                OWL.DatatypeProperty, OWL.AnnotationProperty)


def cells(data):
    for cell in xml.fromstring(data).findall(".//{*}Cell"):
        left = normalize_iri(cell.find("{*}entity1").attrib[RESOURCE])
        right = normalize_iri(cell.find("{*}entity2").attrib[RESOURCE])
        relation = cell.findtext("{*}relation", "=").strip()
        confidence = float(cell.findtext("{*}measure", "1"))
        yield left, right, relation, confidence


def context(left, right):
    if left.casefold() <= right.casefold():
        return f"{left.casefold()}-{right.casefold()}", False
    return f"{right.casefold()}-{left.casefold()}", True


def normalize_iri(iri):
    # The submitted files use both spellings for the confOf ontology namespace.
    if iri.startswith("http://confof#"):
        return iri.replace("http://confof#", "http://confOf#", 1)
    return iri


def oriented(left, right, reverse):
    return (right, left) if reverse else (left, right)


@cache
def schema_entities(path):
    graph = Graph().parse(path, format="xml")
    return {
        normalize_iri(str(entity))
        for kind in SCHEMA_TYPES
        for entity in graph.subjects(RDF.type, kind)
        if isinstance(entity, URIRef) and entity != OWL.Thing
    }


def load_reference(root):
    refs, terms = {}, {}
    for folder in sorted(root.iterdir()):
        if not (folder / "reference.rdf").is_file():
            continue
        pair, reverse = context(*folder.name.split("-"))
        left = schema_entities(folder / "source.owl")
        right = schema_entities(folder / "target.owl")
        terms[pair] = oriented(left, right, reverse)
        refs[pair] = {
            oriented(source, target, reverse)
            for source, target, relation, _ in cells((folder / "reference.rdf").read_bytes())
            if relation == "="
        }
    if len(refs) != 21 or sum(map(len, refs.values())) != 305:
        raise ValueError("Expected all 21 Conference ra1 pairs and 305 reference equivalences")
    return refs, terms


def load_archive(path):
    tools = defaultdict(dict)
    with ZipFile(path) as archive:
        for name in archive.namelist():
            file = Path(name)
            if file.suffix != ".rdf" or file.name.startswith("._"):
                continue
            system, left, right = file.stem.rsplit("-", 2)
            pair, reverse = context(left, right)
            if pair in tools[system]:
                raise ValueError(f"Duplicate {system} submission for {pair}")
            tools[system][pair] = [
                (*oriented(source, target, reverse), score)
                for source, target, relation, score in cells(archive.read(name))
                if relation == "="
            ]
    return tools


def load_ontolab(path):
    predictions = {}
    for row in json.loads(path.read_text()):
        names = row["track"].split("-")
        if len(names) != 2:
            continue
        pair, reverse = context(*names)
        candidates = sorted(
            ((item["score"], item["source"], item["target"])
             for item in row["candidates"] if item["relation"] == "equivalent"),
            reverse=True,
        )
        used_source, used_target, selected = set(), set(), []
        for _, source, target in candidates:
            if source in used_source or target in used_target:
                continue
            used_source.add(source)
            used_target.add(target)
            selected.append((*oriented(source, target, reverse), 1.0))
        predictions[pair] = selected
    return predictions


def score(predictions, refs, terms, threshold):
    missing = set(refs) - set(predictions)
    if missing:
        raise ValueError(f"Missing ontology pairs: {sorted(missing)}")
    tp, predicted = 0, 0
    for pair, expected in refs.items():
        left, right = terms[pair]
        pairs = {
            (source, target)
            for source, target, confidence in predictions[pair]
            if confidence >= threshold and source in left and target in right
        }
        tp += len(pairs & expected)
        predicted += len(pairs)
    gold = sum(map(len, refs.values()))
    return tp, predicted, gold


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tracks", type=Path)
    parser.add_argument("--archive", action="append", required=True, metavar="YEAR=ZIP")
    parser.add_argument("--ontolab", action="append", required=True, metavar="LABEL=JSON")
    args = parser.parse_args()
    refs, terms = load_reference(args.tracks)
    rows = []
    for spec in args.archive:
        year, path = spec.split("=", 1)
        for system, predictions in load_archive(Path(path)).items():
            thresholds = {0.0} | {confidence for values in predictions.values()
                                  for _, _, confidence in values}
            results = ((cut, *score(predictions, refs, terms, cut)) for cut in thresholds)
            rows.append((year, system, *max(results, key=lambda row: (
                2 * row[1] / (row[2] + row[3]), -row[0]))))
    for spec in args.ontolab:
        label, path = spec.split("=", 1)
        rows.append(("OntoLab", label, 0.0, *score(load_ontolab(Path(path)), refs, terms, 0.0)))

    writer = csv.writer(sys.stdout, lineterminator="\n")
    writer.writerow(("source", "matcher", "threshold", "tp", "predicted", "gold",
                     "precision", "recall", "f1"))
    for source, system, threshold, tp, predicted, gold in sorted(
        rows, key=lambda row: -2 * row[3] / (row[4] + row[5])
    ):
        writer.writerow((source, system, threshold, tp, predicted, gold,
                         f"{tp / predicted if predicted else 0:.6f}",
                         f"{tp / gold:.6f}", f"{2 * tp / (predicted + gold):.6f}"))


if __name__ == "__main__":
    main()
