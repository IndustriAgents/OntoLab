// Minimal ambient types for the RDF/JS packages that ship no declarations.
declare module "@rdfjs/dataset" {
  import type { DatasetCore, Quad } from "@rdfjs/types";
  const factory: { dataset(quads?: Iterable<Quad>): DatasetCore<Quad, Quad> };
  export default factory;
}
