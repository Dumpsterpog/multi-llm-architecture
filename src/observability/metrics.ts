/**
 * Prometheus metrics, exposed at GET /metrics for Prometheus/Grafana to scrape.
 *
 * The dashboards an AI company actually lives on:
 *  - requests by strategy and outcome     (traffic, error rate)
 *  - model call latency and errors        (which vendor is slow or down)
 *  - tokens in/out per model              (usage trends)
 *  - cost and price in micro-USD          (burn rate and margin, in real time)
 *  - limit rejections by kind             (are limits too tight? abuse?)
 *
 * Keep label values LOW-cardinality (model ids, strategy names). Never use
 * user ids or request ids as labels: it explodes Prometheus memory.
 */
import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const metrics = {
  requests: new client.Counter({
    name: "mlm_requests_total",
    help: "Chat requests by strategy and outcome",
    labelNames: ["strategy", "outcome"] as const,
    registers: [registry],
  }),
  requestLatency: new client.Histogram({
    name: "mlm_request_duration_seconds",
    help: "End-to-end request latency",
    labelNames: ["strategy"] as const,
    buckets: [0.5, 1, 2, 5, 10, 20, 40, 60, 120],
    registers: [registry],
  }),
  modelCalls: new client.Counter({
    name: "mlm_model_calls_total",
    help: "Model calls by model, stage and outcome",
    labelNames: ["model", "stage", "outcome"] as const,
    registers: [registry],
  }),
  modelLatency: new client.Histogram({
    name: "mlm_model_call_duration_seconds",
    help: "Latency of individual model calls",
    labelNames: ["model"] as const,
    buckets: [0.25, 0.5, 1, 2, 5, 10, 20, 40, 60],
    registers: [registry],
  }),
  tokens: new client.Counter({
    name: "mlm_tokens_total",
    help: "Tokens processed by model and direction",
    labelNames: ["model", "direction"] as const,
    registers: [registry],
  }),
  costMicros: new client.Counter({
    name: "mlm_cost_micros_total",
    help: "Vendor cost in micro-USD (what we pay)",
    registers: [registry],
  }),
  priceMicros: new client.Counter({
    name: "mlm_price_micros_total",
    help: "Customer price in micro-USD (what we charge)",
    registers: [registry],
  }),
  limitRejections: new client.Counter({
    name: "mlm_limit_rejections_total",
    help: "Requests rejected by a limit",
    labelNames: ["type"] as const,
    registers: [registry],
  }),
  cacheHits: new client.Counter({
    name: "mlm_cache_hits_total",
    help: "Responses served from cache (zero model cost)",
    registers: [registry],
  }),
};
