/**
 * Turn a free-form A-Box id into a safe IRI local-name segment.
 *
 * Case and non-ASCII letters are preserved (so "Sensor B1", "sensor-b1" and
 * "Zylinder Ü" all stay distinct — the old slugify lowercased and stripped
 * accents, silently merging different individuals into one subject). Runs of
 * whitespace become "-"; anything that is not a letter, digit, "-", "_", "."
 * or "~" is percent-encoded so the result is always a valid IRI segment.
 */
export function toLocalName(id: string): string {
  const s = (id ?? "").normalize("NFKC").trim().replace(/\s+/g, "-");
  if (!s) return "x";
  let out = "";
  for (const ch of s) {
    if (/[\p{L}\p{N}\-_.~]/u.test(ch)) out += ch;
    else out += encodeURIComponent(ch).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
  }
  return out;
}

/** Inverse of toLocalName for display / round-tripping (best effort). */
export function fromLocalName(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Ensure a base IRI ends with a separator. */
export function normalizeBase(baseIri: string): string {
  if (!baseIri) return "http://ontolab.example/abox#";
  return baseIri.endsWith("#") || baseIri.endsWith("/") ? baseIri : baseIri + "#";
}

/** Mint a stable individual IRI from the base IRI and an A-Box id. */
export function mintUri(baseIri: string, id: string): string {
  return normalizeBase(baseIri) + toLocalName(id);
}
