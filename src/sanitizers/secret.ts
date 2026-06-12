/**
 * Secret-redaction sanitizer.
 *
 * Per-message-role policy:
 *  - System prompt: full redaction (tier 1 + tier 2 + email).
 *  - Output assistant text / thinking: light redaction (tier 1 + email).
 *  - Output tool / tool_call / tool_result: full redaction.
 *  - Input messages: untouched by default; opt in via
 *    `SecretRedactionOptions.redactInputMessages`.
 *
 * Patterns are hand-curated high-confidence formats inspired by Gitleaks.
 * Add more when concrete unredacted secrets are observed.
 */

import type { GenerationSanitizer } from '../config.js';
import type { Generation } from '../models/generation.js';
import type { Message, Part } from '../models/message.js';

export interface SecretRedactionOptions {
  /**
   * Redact secrets in input messages too. Defaults to `false`: inputs
   * typically come from the application itself and are presumed clean.
   */
  redactInputMessages?: boolean;
  /** Redact bare email addresses. Defaults to `true`. */
  redactEmailAddresses?: boolean;
}

interface NamedPattern {
  id: string;
  re: RegExp;
}

// Tier 1 — definite secret formats. Used for everything except input-message
// content (which is opt-in via redactInputMessages).
const TIER1: NamedPattern[] = [
  { id: 'grafana-cloud-token', re: /\bglc_[A-Za-z0-9_-]{20,}/g },
  { id: 'grafana-service-account-token', re: /\bglsa_[A-Za-z0-9_-]{20,}/g },
  { id: 'aws-access-token', re: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/g },
  { id: 'github-pat', re: /\bghp_[A-Za-z0-9_]{36,}/g },
  { id: 'github-oauth', re: /\bgho_[A-Za-z0-9_]{36,}/g },
  { id: 'github-app-token', re: /\bghs_[A-Za-z0-9_]{36,}/g },
  { id: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{82}/g },
  { id: 'anthropic-api-key', re: /\bsk-ant-api03-[A-Za-z0-9_-]{93}AA/g },
  { id: 'anthropic-admin-key', re: /\bsk-ant-admin01-[A-Za-z0-9_-]{93}AA/g },
  { id: 'openai-api-key', re: /\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}/g },
  { id: 'openai-project-key', re: /\bsk-proj-[A-Za-z0-9_-]{40,}/g },
  { id: 'openai-svcacct-key', re: /\bsk-svcacct-[A-Za-z0-9_-]{40,}/g },
  { id: 'gcp-api-key', re: /\bAIza[A-Za-z0-9_-]{35}/g },
  {
    id: 'private-key',
    re: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  },
  {
    id: 'connection-string',
    re: /(?:postgres|mysql|mongodb|redis|amqp):\/\/[^\s'"]+@[^\s'"]+/g,
  },
  { id: 'bearer-token', re: /[Bb]earer\s+[A-Za-z0-9_.\-~+/]{20,}={0,3}/g },
  { id: 'slack-token', re: /\bxox[bporas]-[A-Za-z0-9-]{10,}/g },
  { id: 'stripe-key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}/g },
  { id: 'sendgrid-api-key', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g },
  { id: 'twilio-api-key', re: /\bSK[a-f0-9]{32}/g },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}/g },
  { id: 'pypi-token', re: /\bpypi-[A-Za-z0-9_-]{50,}/g },
];

const EMAIL: NamedPattern = {
  id: 'email',
  re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
};

// Tier 2 — heuristic env-var assignment. Higher false-positive rate; used only
// for tool content + system prompt, never for free-form assistant text.
const TIER2: NamedPattern[] = [
  {
    id: 'env-secret-value',
    re: /((?:PASSWORD|SECRET|TOKEN|KEY|CREDENTIAL|API_KEY|PRIVATE_KEY|ACCESS_KEY)\s*[=:]\s*)([^\s"{}\[\],]+)/gi,
  },
];

/**
 * Builds a `GenerationSanitizer` that applies the redaction policy described
 * above. Designed to be passed to `ClientConfig.generationSanitizer`.
 */
export function createSecretRedactionSanitizer(
  options: SecretRedactionOptions = {},
): GenerationSanitizer {
  const includeEmail = options.redactEmailAddresses ?? true;
  const includeInput = options.redactInputMessages ?? false;

  const redactFull = (text: string) => {
    let out = applyPatterns(text, TIER1);
    if (includeEmail) out = applyPattern(out, EMAIL);
    return applyTier2(out);
  };
  const redactLight = (text: string) => {
    let out = applyPatterns(text, TIER1);
    if (includeEmail) out = applyPattern(out, EMAIL);
    return out;
  };

  return function sanitize(generation: Generation): Generation {
    const next: Generation = { ...generation };
    if (next.systemPrompt) {
      next.systemPrompt = redactFull(next.systemPrompt);
    }

    if (includeInput && next.input) {
      next.input = next.input.map((m) =>
        sanitizeMessage(m, modeForInputRole(m.role), redactFull, redactLight),
      );
    }
    if (next.output) {
      next.output = next.output.map((m) =>
        sanitizeMessage(m, modeForOutputRole(m.role), redactFull, redactLight),
      );
    }
    return next;
  };
}

type Mode = 'full' | 'light' | 'none';

function modeForInputRole(role: Message['role']): Mode {
  if (role === 'user') return 'full';
  if (role === 'assistant') return 'light';
  if (role === 'tool') return 'full';
  return 'none';
}

function modeForOutputRole(role: Message['role']): Mode {
  if (role === 'assistant') return 'light';
  if (role === 'tool') return 'full';
  return 'none';
}

function sanitizeMessage(
  msg: Message,
  defaultMode: Mode,
  full: (t: string) => string,
  light: (t: string) => string,
): Message {
  if (defaultMode === 'none') return msg;
  return { ...msg, parts: msg.parts.map((p) => sanitizePart(p, defaultMode, full, light)) };
}

function sanitizePart(
  part: Part,
  mode: Mode,
  full: (t: string) => string,
  light: (t: string) => string,
): Part {
  if (mode === 'none') return part;
  switch (part.kind) {
    case 'text':
      return part.text ? { ...part, text: redactString(part.text, mode, full, light) } : part;
    case 'thinking':
      return part.thinking ? { ...part, thinking: light(part.thinking) } : part;
    case 'tool_call':
      if (!part.toolCall?.inputJson) return part;
      return {
        ...part,
        toolCall: { ...part.toolCall, inputJson: full(part.toolCall.inputJson) },
      };
    case 'tool_result':
      if (!part.toolResult) return part;
      return {
        ...part,
        toolResult: {
          ...part.toolResult,
          content: part.toolResult.content
            ? full(part.toolResult.content)
            : part.toolResult.content,
          contentJson: part.toolResult.contentJson
            ? full(part.toolResult.contentJson)
            : part.toolResult.contentJson,
        },
      };
  }
}

function redactString(
  value: string,
  mode: Mode,
  full: (t: string) => string,
  light: (t: string) => string,
): string {
  if (mode === 'full') return full(value);
  if (mode === 'light') return light(value);
  return value;
}

function applyPatterns(text: string, patterns: NamedPattern[]): string {
  let out = text;
  for (const p of patterns) out = applyPattern(out, p);
  return out;
}

function applyPattern(text: string, p: NamedPattern): string {
  return text.replace(p.re, `[REDACTED:${p.id}]`);
}

function applyTier2(text: string): string {
  let out = text;
  for (const p of TIER2) {
    out = out.replace(p.re, (_, prefix: string) => `${prefix}[REDACTED:${p.id}]`);
  }
  return out;
}
