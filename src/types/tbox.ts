// The parsed T-Box (schema) the extraction conforms to. Produced client-side by
// tboxParser (N3) and sent to the server, which turns it into the extraction
// tool schema + system-prompt description.

export interface TBoxClass {
  uri: string;
  label?: string;
  comment?: string;
  /** owl:disjointWith (symmetric, includes owl:AllDisjointClasses members) */
  disjointWith?: string[];
  /** named owl:equivalentClass partners (recorded in both directions; may be external mapping targets) */
  equivalentTo?: string[];
}

/** OWL property characteristics beyond functional (used by the reasoner). */
export type PropertyCharacteristic = "transitive" | "symmetric" | "asymmetric" | "reflexive" | "irreflexive" | "inverseFunctional";

export interface TBoxProperty {
  uri: string;
  label?: string;
  comment?: string;
  domain: string[]; // class URIs (owl:unionOf domains are flattened — any member satisfies)
  range: string[]; // class URIs (object props) or datatype URIs (data props)
  kind: "object" | "data";
  /** owl:FunctionalProperty — at most one value per subject */
  functional?: boolean;
  /** owl:inverseOf (recorded in both directions) */
  inverseOf?: string;
  /** rdfs:subPropertyOf (direct named parents); domain/range are inherited when absent */
  subPropertyOf?: string[];
  /** owl:TransitiveProperty, owl:SymmetricProperty, … */
  characteristics?: PropertyCharacteristic[];
  /** named owl:equivalentProperty partners (both directions) */
  equivalentTo?: string[];
  /** owl:propertyDisjointWith partners (both directions) */
  disjointWith?: string[];
}

export type RestrictionKind = "someValuesFrom" | "allValuesFrom" | "minCardinality" | "maxCardinality" | "cardinality";

/** An owl:Restriction attached to a class via rdfs:subClassOf / owl:equivalentClass. */
export interface TBoxRestriction {
  onClass: string;
  onProperty: string;
  kind: RestrictionKind;
  /** filler class / datatype URI (someValuesFrom, allValuesFrom, qualified cardinalities) */
  value?: string;
  /** cardinality bound */
  n?: number;
}

export interface TBoxModel {
  /** prefix -> namespace IRI, e.g. { "": "http://ex/onto#", "xsd": "..." } */
  prefixes: Record<string, string>;
  /** base IRI used to mint A-Box individual URIs (defaults to <tbox namespace>/abox#) */
  baseIri: string;
  /** owl:Ontology IRI of the T-Box, when declared (used for owl:imports in the export) */
  ontologyIri?: string;
  /** owl:imports of the T-Box, when declared */
  imports?: string[];
  classes: TBoxClass[];
  objectProps: TBoxProperty[];
  dataProps: TBoxProperty[];
  /** child class URI -> direct named superclass URIs (rdfs:subClassOf) */
  subClassOf: Record<string, string[]>;
  /** owl:Restrictions found on classes (used for guidance + SHACL warnings) */
  restrictions?: TBoxRestriction[];
}
