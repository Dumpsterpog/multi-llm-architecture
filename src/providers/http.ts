/**
 * Small fetch wrapper shared by all adapters: JSON in, JSON out, vendor
 * errors turned into ProviderError with the right `retryable` flag.
 *
 * We call vendor REST APIs with plain fetch instead of their SDKs on
 * purpose: fewer dependencies, identical error handling across vendors,
 * and full control over timeouts and retries (handled in resilience.ts).
 */
import { ProviderError, isRetryableStatus, type ProviderName } from "./types.js";

export async function postJson<T>(
  provider: ProviderName,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // Network failure or abort. Aborts are NOT retryable (someone chose to stop).
    const aborted = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
    throw new ProviderError(
      `${provider} request failed: ${(err as Error).message}`,
      provider,
      undefined,
      !aborted,
    );
  }

  if (!res.ok) {
    // Never include the request body or headers in errors: they hold the API
    // key and the user's prompt, and errors end up in logs.
    const text = await res.text().catch(() => "");
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new ProviderError(
      `${provider} HTTP ${res.status}: ${text.slice(0, 300)}`,
      provider,
      res.status,
      isRetryableStatus(res.status),
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }
  return (await res.json()) as T;
}

/** Split off system messages: Anthropic and Google want them in a separate field. */
export function splitSystem<M extends { role: string; content: string }>(
  messages: M[],
): { system: string | undefined; rest: M[] } {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  return { system: system || undefined, rest: messages.filter((m) => m.role !== "system") };
}
