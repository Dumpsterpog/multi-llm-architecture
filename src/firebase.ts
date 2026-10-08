/**
 * Firebase Admin setup (server side only).
 *
 * The Admin SDK bypasses Firestore security rules, so it must only ever run
 * on the server, never in the browser. The browser uses the normal Firebase
 * client SDK just to log in, then sends its ID token to this API.
 *
 * Credentials, in order:
 *  1. FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
 *     (a service account key, same variables the FORKSAI app uses), or
 *  2. nothing at all on Google Cloud Run / Cloud Functions: the machine's
 *     own service account is picked up automatically ("application default
 *     credentials"), so there is no private key to leak.
 */
import { applicationDefault, cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import type { Env } from "./config/env.js";

export interface FirebaseServices {
  app: App;
  db: Firestore;
  auth: Auth;
}

let cached: FirebaseServices | undefined;

export function initFirebase(env: Env): FirebaseServices {
  if (cached) return cached;

  const app =
    getApps()[0] ??
    initializeApp({
      credential:
        env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY
          ? cert({
              projectId: env.FIREBASE_PROJECT_ID,
              clientEmail: env.FIREBASE_CLIENT_EMAIL,
              // Env vars usually store the key with literal "\n"; turn them into real newlines.
              privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
            })
          : applicationDefault(),
      projectId: env.FIREBASE_PROJECT_ID,
    });

  const db = getFirestore(app);
  // Optional fields left undefined are simply not written instead of throwing.
  db.settings({ ignoreUndefinedProperties: true });

  cached = { app, db, auth: getAuth(app) };
  return cached;
}
