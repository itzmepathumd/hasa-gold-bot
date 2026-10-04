/*
|--------------------------------------------------------------------------
| FIRESTORE OVER REST
|--------------------------------------------------------------------------
| The Firestore Admin SDK speaks gRPC, which needs HTTP/2. Some hosts and
| proxies terminate TLS and only offer HTTP/1.1, and there the SDK hangs
| until it gives up. The Firestore REST API needs neither, so this module
| exposes the same interface the SDK does and the project carries on.
|
| Only the operations this project actually uses are implemented:
| get, set (replace and merge), create, list, where, limit, select, batch
| commit and transactions.
|
| Transactions are the reason Firestore was worth moving to, so they are
| modelled faithfully rather than approximated. A read inside a transaction
| is sent with the transaction id so it comes from the same snapshot as the
| write, and a commit that reports a conflict is retried against fresh
| state, which is what stops two approvals landing at once.
*/

const { GoogleAuth } = require("google-auth-library");

const API_ROOT = "https://firestore.googleapis.com/v1";

let auth = null;
let cachedToken = null;
let tokenExpiry = 0;

/**
 * A short-lived token is reused across calls so a migration does not mint
 * one per document.
 */
async function accessToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) {
    return cachedToken;
  }

  if (!auth) {
    auth = new GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: [
        "https://www.googleapis.com/auth/datastore",
        "https://www.googleapis.com/auth/cloud-platform",
      ],
    });
  }

  const client = await auth.getClient();
  const token = await client.getAccessToken();

  cachedToken = token.token;
  // google-auth-library does not expose the lifetime, so a conservative
  // window is used and a 401 simply refreshes it.
  tokenExpiry = Date.now() + 45 * 60 * 1000;

  return cachedToken;
}

async function apiFetch(url, options = {}) {
  const token = await accessToken();

  let response;

  try {
    response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    throw new Error(`Firestore REST request failed: ${error.message}`);
  }

  if (response.status === 401) {
    // The cached token went stale.
    cachedToken = null;

    throw new Error("Firestore REST request was refused (401)");
  }

  const text = await response.text();

  if (!response.ok) {
    let message = `HTTP ${response.status}`;

    try {
      const parsed = JSON.parse(text);

      message = parsed.error ? parsed.error.message : text.slice(0, 200);
    } catch (error) {
      message = text.slice(0, 200);
    }

    const failure = new Error(message);

    failure.status = response.status;

    if (response.status === 409) {
      failure.code = 6; // ALREADY_EXISTS / ABORTED, as the SDK reports it
    }

    throw failure;
  }

  if (!text) {
    return {};
  }

  return JSON.parse(text);
}

/*
|--------------------------------------------------------------------------
| VALUE ENCODING
|--------------------------------------------------------------------------
*/

function encodeValue(value) {
  if (value === null || value === undefined) {
    return { nullValue: null };
  }

  if (typeof value === "string") {
    return { stringValue: value };
  }

  if (typeof value === "boolean") {
    return { booleanValue: value };
  }

  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }

  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeValue) } };
  }

  if (value instanceof Date) {
    return { timestampValue: value.toISOString() };
  }

  return { mapValue: { fields: encodeFields(value) } };
}

function encodeFields(object) {
  const fields = {};

  for (const [key, value] of Object.entries(object)) {
    // Firestore rejects undefined outright, so it never reaches the wire.
    if (value !== undefined) {
      fields[key] = encodeValue(value);
    }
  }

  return fields;
}

function decodeValue(typed) {
  if (!typed || typeof typed !== "object") {
    return null;
  }

  if ("nullValue" in typed) {
    return null;
  }

  if ("stringValue" in typed) {
    return typed.stringValue;
  }

  if ("booleanValue" in typed) {
    return typed.booleanValue;
  }

  if ("integerValue" in typed) {
    return Number(typed.integerValue);
  }

  if ("doubleValue" in typed) {
    return typed.doubleValue;
  }

  if ("timestampValue" in typed) {
    return typed.timestampValue;
  }

  if ("arrayValue" in typed) {
    return (typed.arrayValue.values || []).map(decodeValue);
  }

  if ("mapValue" in typed) {
    return decodeFields(typed.mapValue.fields || {});
  }

  return null;
}

function decodeFields(fields) {
  const out = {};

  for (const [key, typed] of Object.entries(fields || {})) {
    out[key] = decodeValue(typed);
  }

  return out;
}

/*
|--------------------------------------------------------------------------
| SNAPSHOTS
|--------------------------------------------------------------------------
*/

class RestSnapshot {
  constructor(id, fields) {
    this.id = id;
    this.exists = fields !== undefined;
    this._fields = fields;
  }

  data() {
    if (!this.exists) {
      return undefined;
    }

    return decodeFields(this._fields);
  }

  get size() {
    return this.exists ? 1 : 0;
  }
}

class RestQuerySnapshot {
  constructor(docs) {
    this.docs = docs;
    this.size = docs.length;
    this.empty = docs.length === 0;
  }
}

function project() {
  return (
    process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "unknown-project"
  );
}

/**
 * A relative resource name, as :commit and :runQuery require. Passing a full
 * URL there is rejected with "lacks projects at index 0".
 */
function relativeName(collectionName, id) {
  return `projects/${project()}/databases/(default)/documents/${encodeURIComponent(
    collectionName
  )}/${encodeURIComponent(id)}`;
}

/**
 * The documents root, used for get/list/patch/create.
 */
function baseUrl() {
  return `${API_ROOT}/projects/${project()}/databases/(default)/documents`;
}

/*
|--------------------------------------------------------------------------
| REFERENCES, QUERIES, BATCHES
|--------------------------------------------------------------------------
*/

/**
 * Build a :commit write that replaces the masked paths. A masked path absent
 * from fields is deleted, which is how a full overwrite is expressed.
 */
function replaceWrite(name, fields, mask) {
  const write = { update: { name, fields } };

  if (mask.length) {
    write.updateMask = { fieldPaths: mask };
  }

  return write;
}

class RestDocumentReference {
  constructor(collectionName, id) {
    this.collectionName = collectionName;
    this.id = id;
    this.path = `${collectionName}/${id}`;
  }

  _url() {
    return `${baseUrl()}/${encodeURIComponent(this.collectionName)}/${encodeURIComponent(this.id)}`;
  }

  async get(transactionId) {
    const url = transactionId
      ? `${this._url()}?transaction=${encodeURIComponent(transactionId)}`
      : this._url();

    try {
      const body = await apiFetch(url);

      // A missing document is a normal answer, not an error.
      if (!body.name) {
        return new RestSnapshot(this.id, undefined);
      }

      return new RestSnapshot(this.id, body.fields || {});
    } catch (error) {
      if (error.status === 404) {
        return new RestSnapshot(this.id, undefined);
      }

      throw error;
    }
  }

  /**
   * Writing with an updateMask of the supplied keys is exactly the SDK's merge
   * behaviour, which is what makes a second migration run harmless.
   *
   * There is no overwrite verb on documents.patch, so a plain set() is done
   * through :commit, whose updateMask both writes the new fields and removes
   * any that the document had and the caller did not supply. That means the
   * current keys have to be known, hence the extra read.
   */
  async set(data, options = {}) {
    const fields = encodeFields(data);

    if (options.merge) {
      const mask = Object.keys(fields)
        .map((key) => `updateMask.fieldPaths=${encodeURIComponent(key)}`)
        .join("&");

      return apiFetch(this._url() + (mask ? `?${mask}` : ""), {
        method: "PATCH",
        body: JSON.stringify({ fields }),
      });
    }

    const current = await this.get();
    const stale = Object.keys(current.data() || {}).filter(
      (key) => !(key in fields)
    );

    return apiFetch(`${baseUrl()}:commit`, {
      method: "POST",
      body: JSON.stringify({
        writes: [replaceWrite(relativeName(this.collectionName, this.id), fields, [
          ...Object.keys(fields),
          ...stale,
        ])],
      }),
    });
  }

  async create(data) {
    const url = `${baseUrl()}/${encodeURIComponent(
      this.collectionName
    )}?documentId=${encodeURIComponent(this.id)}`;

    return apiFetch(url, {
      method: "POST",
      body: JSON.stringify({ fields: encodeFields(data) }),
    });
  }

  async update(data) {
    return this.set(data, { merge: true });
  }

  async delete() {
    return apiFetch(this._url(), { method: "DELETE" });
  }
}

class RestQuery {
  constructor(collectionName, constraints) {
    this.collectionName = collectionName;
    this.constraints = constraints || {
      filters: [],
      limit: null,
      fields: null,
      order: null,
    };
  }

  where(field, op, value) {
    return new RestQuery(this.collectionName, {
      ...this.constraints,
      filters: [...this.constraints.filters, { field, op, value }],
    });
  }

  orderBy(field, direction = "ASCENDING") {
    return new RestQuery(this.collectionName, {
      ...this.constraints,
      order: { field, direction },
    });
  }

  limit(n) {
    return new RestQuery(this.collectionName, { ...this.constraints, limit: n });
  }

  select(...fields) {
    return new RestQuery(this.collectionName, {
      ...this.constraints,
      fields: fields.flat(),
    });
  }

  async get() {
    const structured = {
      from: [{ collectionId: this.collectionName }],
    };

    for (const filter of this.constraints.filters) {
      const clause = buildFilter(filter);

      structured.where = structured.where
        ? { compositeFilter: { op: "AND", filters: [structured.where, clause] } }
        : clause;
    }

    if (this.constraints.order) {
      structured.orderBy = [
        {
          field: { fieldPath: this.constraints.order.field },
          direction: this.constraints.order.direction,
        },
      ];
    }

    if (this.constraints.limit) {
      structured.limit = { value: this.constraints.limit };
    }

    if (this.constraints.fields) {
      // FieldReference, not a bare string: Firestore rejects "status" here.
      structured.select = {
        fields: this.constraints.fields.map((field) => ({ fieldPath: field })),
      };
    }

    // runQuery streams newline-delimited results rather than a single JSON
    // body, so it is read as text and split.
    const body = await apiFetch(`${baseUrl()}:runQuery`, {
      method: "POST",
      body: JSON.stringify({ structuredQuery: structured }),
    });

    const results = parseRunQuery(body);

    return new RestQuerySnapshot(
      results
        .filter((entry) => entry.document)
        .map((entry) => {
          const segments = entry.document.name.split("/");

          return new RestSnapshot(
            segments[segments.length - 1],
            entry.document.fields || {}
          );
        })
    );
  }

  async listAll() {
    // A plain document list, paginated. Used to build the read mirror.
    //
    // No field mask: mask.fieldPaths selects fields inside the document, and
    // "fields" is not one of them, so asking for it returns every document
    // stripped bare. Unmasked already returns name, fields and timestamps.
    const docs = [];
    let pageToken = null;

    do {
      const url = new URL(`${baseUrl()}/${encodeURIComponent(this.collectionName)}`);

      url.searchParams.set("pageSize", "300");

      if (pageToken) {
        url.searchParams.set("pageToken", pageToken);
      }

      const body = await apiFetch(url.toString());

      for (const document of body.documents || []) {
        const segments = document.name.split("/");

        docs.push(
          new RestSnapshot(segments[segments.length - 1], document.fields || {})
        );
      }

      pageToken = body.nextPageToken || null;
    } while (pageToken);

    return docs;
  }
}

function buildFilter({ field, op, value }) {
  const encoded = encodeValue(value);

  if (op === "==") {
    return { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: encoded } };
  }

  if (op === "!=") {
    return {
      fieldFilter: { field: { fieldPath: field }, op: "NOT_EQUAL", value: encoded },
    };
  }

  if (op === "in") {
    return {
      fieldFilter: {
        field: { fieldPath: field },
        op: "IN",
        value: { arrayValue: { values: (value || []).map(encodeValue) } },
      },
    };
  }

  if (op === "not-in") {
    return {
      fieldFilter: {
        field: { fieldPath: field },
        op: "NOT_IN",
        value: { arrayValue: { values: (value || []).map(encodeValue) } },
      },
    };
  }

  throw new Error(`REST transport does not support operator "${op}"`);
}

class RestCollectionReference extends RestQuery {
  constructor(collectionName) {
    super(collectionName, { filters: [], limit: null, fields: null, order: null });
  }

  doc(id) {
    return new RestDocumentReference(this.collectionName, id);
  }
}

class RestBatch {
  constructor() {
    this.writes = [];
    // Non-merge writes need the document's current keys to know what to drop,
    // so they are resolved together just before the commit.
    this._replacements = [];
  }

  set(ref, data, options = {}) {
    const fields = encodeFields(data);
    const name = relativeName(ref.collectionName, ref.id);

    if (options.merge) {
      this.writes.push(replaceWrite(name, fields, Object.keys(fields)));

      return;
    }

    this._replacements.push({ name, fields, ref });
  }

  delete(ref) {
    this._replacements = this._replacements.filter(
      (item) => item.ref.id !== ref.id || item.ref.collectionName !== ref.collectionName
    );

    this.writes.push({
      delete: relativeName(ref.collectionName, ref.id),
    });
  }

  /**
   * Resolve every staged write, including the reads a non-merge overwrite
   * needs. Shared by batch() and runTransaction().
   */
  async _resolve() {
    const writes = [...this.writes];

    for (const item of this._replacements) {
      const current = await item.ref.get();
      const stale = Object.keys(current.data() || {}).filter(
        (key) => !(key in item.fields)
      );

      writes.push(
        replaceWrite(item.name, item.fields, [
          ...Object.keys(item.fields),
          ...stale,
        ])
      );
    }

    this.writes = writes;
    this._replacements = [];

    return writes;
  }

  async commit() {
    const writes = await this._resolve();

    if (!writes.length) {
      return {};
    }

    return apiFetch(`${baseUrl()}:commit`, {
      method: "POST",
      body: JSON.stringify({ writes }),
    });
  }
}

/**
 * Parse the newline-delimited payload runQuery returns.
 */
function parseRunQuery(body) {
  if (typeof body === "object") {
    return Array.isArray(body) ? body : [body];
  }

  return String(body)
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return {};
      }
    });
}

class RestFirestore {
  constructor() {
    // Collections are created lazily and cached so repeated calls are cheap.
    this._collections = new Map();
  }

  collection(name) {
    if (!this._collections.has(name)) {
      this._collections.set(name, new RestCollectionReference(name));
    }

    return this._collections.get(name);
  }

  batch() {
    return new RestBatch();
  }

  /**
   * Read, decide and write inside one transaction, retrying on conflict.
   *
   * The callback gets the same tx interface the SDK provides, so the calling
   * code is identical whichever transport is in use.
   */
  async runTransaction(callback) {
    let lastError = null;

    for (let attempt = 0; attempt < 5; attempt++) {
      let transactionId;

      try {
        const begin = await apiFetch(`${baseUrl()}:beginTransaction`, {
          method: "POST",
          body: JSON.stringify({}),
        });

        transactionId = begin.transaction;

        const staged = new RestBatch();

        const tx = {
          get: (ref) => ref.get(transactionId),
          set: (ref, data, options) => staged.set(ref, data, options),
          delete: (ref) => staged.delete(ref),
        };

        const result = await callback(tx);

        await apiFetch(`${baseUrl()}:commit`, {
          method: "POST",
          body: JSON.stringify({
            transaction: transactionId,
            writes: await staged._resolve(),
          }),
        });

        return result;
      } catch (error) {
        lastError = error;

        // 409 is the conflict signal: another writer got there first, so the
        // whole decision is made again against the state they left.
        if (error.status !== 409) {
          throw error;
        }
      }
    }

    throw lastError || new Error("Firestore REST transaction kept conflicting");
  }

  /**
   * Read a whole collection with pagination. Not part of the SDK interface;
   * the order layer calls it directly when building its mirror.
   */
  async listAll(collectionName) {
    return this.collection(collectionName).listAll();
  }
}

module.exports = { RestFirestore, RestSnapshot, encodeFields, decodeFields };