export class SchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SchemaError';
  }
}

// Thrown when previously-established identity/provenance (suite digest, grader
// version, config fingerprint, origin, run identity, task content) does not
// match what a later call or record claims. Distinct from SchemaError: the
// individual records are well-formed, but they do not belong together.
export class ProvenanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProvenanceError';
  }
}
