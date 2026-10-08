/**
 * Generate an API key for a developer customer and save it to Firestore.
 *
 *   npm run create-key -- <org_id> [name]
 *
 * Uses the same Firebase env vars as the server (.env). Prints the raw key
 * ONCE (give it to the customer; it can't be recovered). Firestore stores
 * only its SHA-256 hash. The org doc must already exist in llm_orgs.
 * In a real product this lives behind a "Create API key" button in the dashboard.
 */
import { randomBytes } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { loadEnv } from "../src/config/env.js";
import { initFirebase } from "../src/firebase.js";
import { API_KEY_PREFIX, hashApiKey } from "../src/gateway/auth.js";

const [orgId, name = "default"] = process.argv.slice(2);
if (!orgId) {
  console.error("usage: npm run create-key -- <org_id> [name]");
  process.exit(1);
}

const env = loadEnv();
const { db } = initFirebase(env);
const col = (c: string) => db.collection(`${env.FIRESTORE_COLLECTION_PREFIX}${c}`);

const org = await col("orgs").doc(orgId).get();
if (!org.exists) {
  console.error(`No org "${orgId}" in ${env.FIRESTORE_COLLECTION_PREFIX}orgs. A website user's org id is their Firebase uid.`);
  process.exit(1);
}

// 32 random bytes = 256 bits of entropy: unguessable.
const raw = `${API_KEY_PREFIX}live_${randomBytes(32).toString("base64url")}`;
await col("apiKeys").doc(hashApiKey(raw)).set({
  orgId,
  userId: null,
  name,
  prefix: raw.slice(0, 12),
  createdAt: FieldValue.serverTimestamp(),
  revokedAt: null,
});

console.log(`\nAPI key for org ${orgId} (shown once, store it safely):\n\n  ${raw}\n`);
console.log(`Revoke later by setting revokedAt on ${env.FIRESTORE_COLLECTION_PREFIX}apiKeys/<hash> in the Firebase console.\n`);
process.exit(0);
