// Shared T-Box fixture for the manual-editing tests.
import { parseTBox } from "./tboxParser";

export const NS = "http://ex/onto#";
export const C = (n: string) => NS + n;
export const XSD = "http://www.w3.org/2001/XMLSchema#";

export const TTL = `
@prefix : <${NS}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:Station a owl:Class .
:Component a owl:Class .
:Sensor a owl:Class ; rdfs:subClassOf :Component ; owl:disjointWith :Actuator .
:Actuator a owl:Class ; rdfs:subClassOf :Component .
:partOf a owl:ObjectProperty ; rdfs:domain :Component ; rdfs:range :Station .
:locatedIn a owl:ObjectProperty ; rdfs:subPropertyOf :partOf .
:pressure a owl:DatatypeProperty ; rdfs:domain :Component ; rdfs:range xsd:decimal .
:name a owl:DatatypeProperty .
:capacity a owl:DatatypeProperty ; rdfs:domain :Station ; rdfs:range xsd:integer .
:Sensor rdfs:subClassOf [ a owl:Restriction ; owl:onProperty :partOf ; owl:someValuesFrom :Station ] .
`;

export const tbox = parseTBox(TTL);
