/**
 * Structured JSON logging (pino). Every line is JSON with a requestId, so in
 * production you can search "show me everything about request X" across all
 * servers in your log tool (Datadog, Grafana Loki, CloudWatch...).
 *
 * PRIVACY RULE: never log prompts, answers, API keys or auth tokens. Log
 * ids, sizes, timings and token counts. The `redact` list is a safety net.
 */
import { pino } from "pino";

export function createLogger(level: string) {
  return pino({
    level,
    redact: {
      paths: ["req.headers.authorization", "*.apiKey", "*.content", "*.messages", "*.text"],
      censor: "[redacted]",
    },
    base: { service: "multi-llm-gateway" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = ReturnType<typeof createLogger>;
