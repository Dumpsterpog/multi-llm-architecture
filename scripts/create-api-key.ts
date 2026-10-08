/**
 * Generate an API key for a developer customer.
 *
 *   npm run create-key -- <org_id> [name]
 *
 * Prints the raw key ONCE (give it to the customer; it can't be recovered)
 * and the SQL row to store, which contains only the hash.
 * In a real product this lives behind a "Create API key" button in the dashboard.
 */
import { randomBytes } from "node:crypto";
import { API_KEY_PREFIX, hashApiKey } from "../src/gateway/auth.js";

const [orgId, name = "default"] = process.argv.slice(2);
if (!orgId) {
  console.error("usage: npm run create-key -- <org_id> [name]");
  process.exit(1);
}

// 32 random bytes = 256 bits of entropy: unguessable.
const raw = `${API_KEY_PREFIX}live_${randomBytes(32).toString("base64url")}`;
const hash = hashApiKey(raw);
const prefix = raw.slice(0, 12);
const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

console.log("\nAPI key (shown once, store it safely):\n");
console.log(`  ${raw}\n`);
console.log("SQL to register it:\n");
console.log(
  `  INSERT INTO api_keys(org_id, name, key_prefix, key_hash) VALUES (${sqlString(orgId)}, ${sqlString(name)}, ${sqlString(prefix)}, ${sqlString(hash)});\n`,
);
