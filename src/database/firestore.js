/*
|--------------------------------------------------------------------------
| FIRESTORE CONNECTION
|--------------------------------------------------------------------------
| Holds the only Firebase Admin handle in the project. Nothing else imports
| firebase-admin, so credentials are read in exactly one place and there is
| one obvious file to audit.
|
| Authentication supports the two ways a Node backend is normally deployed:
|
|   1. Explicit service account fields in the environment:
|        FIREBASE_PROJECT_ID
|        FIREBASE_CLIENT_EMAIL
|        FIREBASE_PRIVATE_KEY
|      The private key may be written with literal "\n" instead of real
|      newlines, because hosting secret UIs store values on one line.
|
|   2. Application Default Credentials, when FIREBASE_CLIENT_EMAIL is absent
|      and GOOGLE_APPLICATION_CREDENTIALS points at a key file, or the
|      runtime is already inside Google Cloud (Cloud Run, App Engine,
|      Functions). ADC is the preferred option on Google Cloud because it
|      means no secret is ever copied into the environment.
|
| If neither is present the project stays on its JSON store instead of
| failing to boot, so a missing credential can never take the shop offline.
|
| No value from this file is ever logged. describeStatus() reports presence
| flags and the project id only, which are not secret.
*/

const admin = require("firebase-admin");

let app = null;
let db = null;
let initError = null;
let connecting = null;

/**
 * True when the environment provides enough information to reach Firestore.
 */
function isConfigured() {
  return Boolean(
    process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY
  );
}

/**
 * True when the runtime should be able to use Application Default
 * Credentials instead of explicit service account fields.
 */
function hasApplicationDefaultCredentials() {
  return Boolean(
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      process.env.GCLOUD_PROJECT ||
      process.env.K_SERVICE ||
      process.env.FUNCTION_TARGET
  );
}

/**
 * Whether the bot should use Firestore rather than the JSON files.
 */
function shouldUseFirestore() {
  if (process.env.FIRESTORE_ENABLED === "false") {
    return false;
  }

  return isConfigured() || hasApplicationDefaultCredentials();
}

/**
 * Private keys pasted into a secret store usually arrive as one line with
 * escaped newlines. Put the real newlines back.
 */
function normalizePrivateKey(raw) {
  return String(raw).replace(/\\n/g, "\n");
}

/**
 * Build the credential without ever putting key material into a log line.
 */
function buildCredential() {
  if (isConfigured()) {
    return admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // The parsed form of the PEM, never logged.
      privateKey: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY),
    });
  }

  // No explicit service account: let the SDK find one itself.
  return admin.credential.applicationDefault();
}

/**
 * The Firestore instance, initialised on first use.
 *
 * Returns null when Firestore is not configured, so callers can fall back
 * to the JSON store instead of throwing during startup.
 */
async function getDb() {
  if (db) {
    return db;
  }

  if (!shouldUseFirestore()) {
    return null;
  }

  // Several updates can arrive together on boot; initialise once.
  if (connecting) {
    return connecting;
  }

  connecting = (async () => {
    try {
      if (!app) {
        app =
          admin.apps.length > 0
            ? admin.app()
            : admin.initializeApp({
                credential: buildCredential(),
                projectId:
                  process.env.FIREBASE_PROJECT_ID ||
                  process.env.GCLOUD_PROJECT ||
                  undefined,
              });
      }

      db = app.firestore();

      return db;
    } catch (error) {
      initError = error;

      console.error(
        "[DB] Firestore initialisation failed, falling back to JSON files:",
        error.message
      );

      // A broken Firestore config must not stop the shop from trading, so
      // mark it unusable and let the JSON store carry the order.
      return null;
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

/**
 * Verify the connection actually works, not merely that it was constructed.
 * Returns { ok, error }. Never throws.
 */
async function healthCheck() {
  try {
    const database = await getDb();

    if (!database) {
      return {
        ok: false,
        error: initError ? initError.message : "Firestore is not configured",
      };
    }

    // A cheap read that proves credentials, network and rules all line up.
    await database.collection("settings").doc("healthcheck").get();

    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Safe status for startup logs. Contains no credential material.
 */
function describeStatus() {
  const mode = shouldUseFirestore() ? "firestore" : "json";

  return {
    mode,
    explicitServiceAccount: isConfigured(),
    applicationDefault: !isConfigured() && hasApplicationDefaultCredentials(),
    projectId: process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || null,
    disabled: process.env.FIRESTORE_ENABLED === "false",
  };
}

/**
 * Close the connection. Used on shutdown so the process can exit.
 */
async function closeDb() {
  db = null;
  app = null;

  try {
    if (admin.apps.length > 0) {
      await admin.app().delete();
    }
  } catch (error) {
    // Nothing useful to do while shutting down.
  }
}

/*
|--------------------------------------------------------------------------
| TEST SEAM
|--------------------------------------------------------------------------
| The Firestore emulator needs Java, which is not available everywhere, so
| the database tests drive an in-memory double instead. Injecting the handle
| here keeps that fake out of every other module: the rest of the project
| still goes through getDb() and sees real Firestore in production.
*/
function __setDbForTests(injected) {
  db = injected;
  app = injected ? { firestore: () => injected, delete: async () => {} } : null;
}

module.exports = {
  getDb,
  isConfigured,
  hasApplicationDefaultCredentials,
  shouldUseFirestore,
  healthCheck,
  describeStatus,
  closeDb,
  __setDbForTests,
};