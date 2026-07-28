// JSON Schemas for model output. Backends with guided decoding (vLLM/xgrammar, Ollama
// format, LiteLLM json_schema pass-through) enforce these at the token level, so a weak
// open model spends its capability budget on judgement instead of on formatting.
//
// Note what is absent: no line numbers. Coordinates are the pipeline's job (PROPOSAL §9.8).
import { FINDING_CATEGORIES, SEVERITIES } from "../config";
import { REQ_VERDICTS } from "../libs/types";

export const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "severity", "confidence", "file", "quote", "claim"],
        properties: {
          category: { type: "string", enum: [...FINDING_CATEGORIES] },
          severity: { type: "string", enum: [...SEVERITIES] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          file: { type: "string" },
          quote: {
            type: "string",
            description: "The exact source line(s) this finding is about, copied verbatim.",
          },
          context_before: { type: "string" },
          context_after: { type: "string" },
          side: { type: "string", enum: ["right", "left"] },
          claim: { type: "string" },
          evidence: { type: "string" },
          suggested_fix: { type: "string" },
          boundary_owner: { type: "string", enum: ["current", "external"] },
        },
      },
    },
  },
} as const;

// Requirement axis. Runs independently of the finder — it never sees code findings, and
// the finder never sees this, so neither can be used to excuse the other (PROPOSAL §6.1).
export const REQUIREMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["criteria"],
  properties: {
    criteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["workItemId", "criterion", "verdict", "note"],
        properties: {
          workItemId: { type: "number" },
          criterion: {
            type: "string",
            description: "The acceptance criterion being judged, copied verbatim.",
          },
          verdict: { type: "string", enum: [...REQ_VERDICTS] },
          note: { type: "string" },
          quote: {
            type: "string",
            description: "Exact source line(s) from the diff that evidence this verdict.",
          },
          file: { type: "string" },
        },
      },
    },
    extras: {
      type: "array",
      description: "Changes in the diff that no criterion asked for (scope creep).",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "file"],
        properties: {
          claim: { type: "string" },
          file: { type: "string" },
          quote: { type: "string" },
        },
      },
    },
  },
} as const;
