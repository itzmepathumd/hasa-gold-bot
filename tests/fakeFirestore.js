/*
|--------------------------------------------------------------------------
| IN-MEMORY FIRESTORE DOUBLE
|--------------------------------------------------------------------------
| Implements the slice of the Firestore API this project uses, so the
| Firestore code path can be exercised without a project, credentials or the
| Java-based emulator.
|
| It is a test tool, not a database. It is deliberately strict about the two
| things that matter for correctness: create() refusing to overwrite an
| existing document, and runTransaction() detecting a conflicting write so
| the callback runs again the way Firestore does.
*/

class FakeDocumentSnapshot {
  constructor(id, data) {
    this.id = id;
    this.exists = data !== undefined;
    this._data = data;
  }

  data() {
    // Real Firestore returns undefined for a document that does not exist.
    // It does not throw, and code that assumes otherwise breaks only once it
    // meets the real client.
    return this.exists ? { ...this._data } : undefined;
  }

  get size() {
    return this.exists ? 1 : 0;
  }
}

class FakeQuerySnapshot {
  constructor(docs) {
    this.docs = docs;
    this.size = docs.length;
    this.empty = docs.length === 0;
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function matches(doc, field, op, value) {
  const actual = doc[field];

  switch (op) {
    case "==":
      return actual === value;
    case "!=":
      return actual !== value;
    case "in":
      return Array.isArray(value) && value.includes(actual);
    case "not-in":
      return Array.isArray(value) && !value.includes(actual);
    default:
      throw new Error(`FakeFirestore does not support operator "${op}"`);
  }
}

class FakeDocumentReference {
  constructor(store, collectionName, id) {
    this.store = store;
    this.collectionName = collectionName;
    this.id = id;
    this.path = `${collectionName}/${id}`;
  }

  _key() {
    return `${this.collectionName}/${this.id}`;
  }

  async get() {
    if (this.store.hang) {
      // Never settles, the way an unreachable host behaves.
      await new Promise(() => {});
    }

    if (!this.store.connected) {
      throw new Error("FakeFirestore: backend is down");
    }

    const stored = this.store.data.get(this._key());

    return new FakeDocumentSnapshot(
      this.id,
      stored === undefined ? undefined : clone(stored)
    );
  }

  async set(data, options = {}) {
    this.store.writes++;

    if (!this.store.connected) {
      throw new Error("FakeFirestore: backend is down");
    }

    for (const value of Object.values(data)) {
      if (value === undefined) {
        throw new Error(
          "FakeFirestore: set() was given an undefined value, which real Firestore rejects"
        );
      }
    }

    const existing = this.store.data.get(this._key());
    const merged = options.merge
      ? { ...(existing || {}), ...clone(data) }
      : clone(data);

    this.store.data.set(this._key(), merged);

    return new FakeDocumentSnapshot(this.id, clone(merged));
  }

  /**
   * Fails when the document already exists, which is how duplicate orders
   * are prevented in production.
   */
  async create(data) {
    this.store.writes++;

    if (this.store.data.has(this._key())) {
      const error = new Error(
        `FakeFirestore: ${this.path} already exists`
      );

      // 6 is the real ALREADY_EXISTS code.
      error.code = 6;

      throw error;
    }

    return this.set(data);
  }

  async update(data) {
    const existing = this.store.data.get(this._key());

    if (existing === undefined) {
      throw new Error(`FakeFirestore: ${this.path} does not exist`);
    }

    return this.set(data, { merge: true });
  }

  async delete() {
    this.store.data.delete(this._key());
  }
}

class FakeQuery {
  constructor(store, collectionName, constraints) {
    this.store = store;
    this.collectionName = collectionName;
    this.constraints = constraints || { filters: [], limit: null, fields: null };
  }

  where(field, op, value) {
    return new FakeQuery(this.store, this.collectionName, {
      ...this.constraints,
      filters: [...this.constraints.filters, { field, op, value }],
    });
  }

  orderBy() {
    // Ordering is done in memory by the caller in this project.
    return this;
  }

  limit(n) {
    return new FakeQuery(this.store, this.collectionName, {
      ...this.constraints,
      limit: n,
    });
  }

  select(fields) {
    // `select()` with no argument loads whole documents. `select("a")`
    // projects to just that field, which is how a per-status count avoids
    // downloading every order.
    const names = Array.isArray(fields) ? fields : [];

    return new FakeQuery(this.store, this.collectionName, {
      ...this.constraints,
      fields: names.length ? names : null,
    });
  }

  async get() {
    if (this.store.hang) {
      // Never settles, the way an unreachable host behaves.
      await new Promise(() => {});
    }

    const prefix = `${this.collectionName}/`;
    let docs = [];

    for (const [key, value] of this.store.data.entries()) {
      if (!key.startsWith(prefix)) {
        continue;
      }

      const id = key.slice(prefix.length);
      const data = clone(value);

      const passes = this.constraints.filters.every((filter) =>
        matches(data, filter.field, filter.op, filter.value)
      );

      if (!passes) {
        continue;
      }

      if (this.constraints.fields) {
        const projected = {};

        for (const name of this.constraints.fields) {
          if (name in data) {
            projected[name] = data[name];
          }
        }

        docs.push(new FakeDocumentSnapshot(id, projected));
        continue;
      }

      docs.push(new FakeDocumentSnapshot(id, data));
    }

    if (this.constraints.limit) {
      docs = docs.slice(0, this.constraints.limit);
    }

    return new FakeQuerySnapshot(docs);
  }
}

class FakeCollectionReference extends FakeQuery {
  constructor(store, name) {
    super(store, name, { filters: [], limit: null, fields: null });
  }

  doc(id) {
    return new FakeDocumentReference(this.store, this.collectionName, id);
  }
}

class FakeBatch {
  constructor(store) {
    this.store = store;
    this.operations = [];
  }

  set(ref, data, options = {}) {
    this.operations.push({ type: "set", ref, data, options });
  }

  delete(ref) {
    this.operations.push({ type: "delete", ref });
  }

  async commit() {
    this.store.writes += this.operations.length;

    for (const op of this.operations) {
      if (op.type === "delete") {
        await op.ref.delete();
      } else {
        await op.ref.set(op.data, op.options);
      }
    }
  }
}

class FakeFirestore {
  constructor() {
    this.data = new Map();
    this.writes = 0;
    this.connected = true;
    // When true every read hangs, to model an unreachable host.
    this.hang = false;
    // Used to prove a transaction re-reads and retries on a conflict.
    this.transactionRetries = 0;
    // Serialises transactions, which is what makes optimistic concurrency
    // observable in a single-process double.
    this.txLock = Promise.resolve();
  }

  collection(name) {
    return new FakeCollectionReference(this, name);
  }

  batch() {
    return new FakeBatch(this);
  }

  /**
   * Runs the callback, and if another writer committed the same document
   * while it was running, runs it again from the new state.
   *
   * Transactions are serialised, which is what makes that guarantee real:
   * two approvals arriving together cannot both read "pending_approval" and
   * both commit, because the second one runs after the first has committed
   * and re-reads the new state. Real Firestore reaches the same outcome by
   * aborting the conflicting transaction and retrying it.
   *
   * The version check is kept as well, so a write that lands outside the
   * lock still forces a retry rather than being silently overwritten.
   */
  async runTransaction(callback) {
    const previous = this.txLock;

    let release;

    this.txLock = new Promise((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const readVersions = new Map();
        const staged = new Map();

        const tx = {
          get: async (ref) => {
            const key = `${ref.collectionName}/${ref.id}`;

            // A real transaction sees its own pending writes.
            if (staged.has(key)) {
              return new FakeDocumentSnapshot(ref.id, clone(staged.get(key)));
            }

            readVersions.set(key, clone(this.data.get(key)));

            return await ref.get();
          },
          set: (ref, data) => {
            for (const value of Object.values(data)) {
              if (value === undefined) {
                throw new Error(
                  "FakeFirestore: transaction set() was given an undefined value"
                );
              }
            }

            staged.set(`${ref.collectionName}/${ref.id}`, clone(data));
          },
          delete: (ref) => {
            staged.delete(`${ref.collectionName}/${ref.id}`);
          },
        };

        const result = await callback(tx);

        // A network failure during commit fails the whole transaction, so the
        // staged writes must not be applied when the backend is gone.
        if (!this.connected) {
          throw new Error("FakeFirestore: backend is down");
        }

        // Conflict check: anything read must not have moved underneath us.
        let conflict = false;

        for (const [key, seen] of readVersions.entries()) {
          if (JSON.stringify(seen) !== JSON.stringify(this.data.get(key))) {
            conflict = true;
            break;
          }
        }

        if (!conflict) {
          for (const [key, value] of staged.entries()) {
            this.data.set(key, value);
          }

          this.writes += staged.size;

          return result;
        }

        this.transactionRetries++;
      }

      throw new Error("FakeFirestore: transaction gave up after 5 attempts");
    } finally {
      release();
    }
  }
}

module.exports = { FakeFirestore, FakeDocumentSnapshot, FakeQuerySnapshot };