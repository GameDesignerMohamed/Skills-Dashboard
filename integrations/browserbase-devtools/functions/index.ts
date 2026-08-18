import { defineFn } from "@browserbasehq/sdk-functions";
import lighthouse, { desktopConfig } from "lighthouse";
import { chromium } from "playwright-core";
import puppeteer from "puppeteer-core";
import { z } from "zod";

// Credential-surface refusal patterns — checked against caller-supplied script source
// before eval. Expanded from the skill-layer constraint list to include bracket forms
// and computed property access. Note: simple variable aliasing (var c = document; c.cookie)
// can still defeat regex; the structural boundary is assertNoContext below.
const CREDENTIAL_SURFACE_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "document.cookie", pattern: /\bdocument\s*(?:\.\s*cookie\b|\[\s*['"`]cookie['"`]\s*\])/ },
  { name: "localStorage", pattern: /\b(?:window\s*\.\s*)?localStorage\s*(?:\.|\[)/ },
  { name: "sessionStorage", pattern: /\b(?:window\s*\.\s*)?sessionStorage\s*(?:\.|\[)/ },
  { name: "indexedDB", pattern: /\b(?:window\s*\.\s*)?indexedDB\s*(?:\.|\[)/ },
  { name: "navigator.credentials", pattern: /\bnavigator\s*(?:\.\s*credentials\b|\[\s*['"`]credentials['"`]\s*\])/ },
  { name: "fetch with credentials", pattern: /\bfetch\s*\([^)]*credentials\s*:\s*['"`](?:include|same-origin)['"`]/ },
  { name: "XMLHttpRequest.withCredentials", pattern: /\bwithCredentials\s*=\s*(?:true|1)\b/ },
  // Narrowed to distinguish reads from writes. Writes we must NOT flag:
  //   `el.value = x`, `el.value += 1`, `el.value -= 1`, `el.value *= 2`, `el.value /= 2`,
  //   `el.value %= 2`, `el.value **= 2`, `el.value ||= y`, `el.value ??= y`, `el.value &&= y`,
  //   `el.value <<= 1`, `el.value >>= 1`, `el.value >>>= 1`, `el.value |= 1`, `el.value &= 1`,
  //   `el.value ^= 1`, `el.value++`, `el.value--`, `++el.value`, `--el.value`.
  // Reads we DO flag: `el.value`, `x = el.value`, `el.value == y`, `el.value === y`,
  //   `el.value != y`, `el.value !== y`, `el.value.toString()`, `fn(el.value)`.
  // Negative lookahead: after optional whitespace, NOT followed by an assignment operator
  // (=, +=, -=, *=, /=, %=, **=, ||=, ??=, &&=, <<=, >>=, >>>=, |=, &=, ^=) — and the
  // = must not be part of ==, ===, !=, !==. Also NOT immediately followed by ++ or --.
  {
    name: "form input .value read",
    // Read vs write: the negative lookahead excludes postfix writes (++ --) and all
    // assignment operators (=, +=, -=, *=, /=, %=, **=, ||=, ??=, &&=, <<=, >>=, >>>=,
    // |=, &=, ^=). The negation of = vs == is handled by the inner negative lookahead.
    //
    // KNOWN LIMITATION: prefix writes like `++el.value` or `--el.value` still match as
    // reads because detecting them would require variable-length lookbehind (to account
    // for `++a.b.c.value` chains), which JS/Python regex doesn't support cleanly.
    // Real-world impact: negligible. Prefix writes on DOM .value are effectively
    // nonexistent in production scripts (most developers use `el.value = String(n+1)`).
    // Over-flagging the rare occurrence as a "read" produces a false positive that
    // forces the caller to rephrase — over-cautious, not unsafe. Accepted tradeoff.
    pattern: /\.\s*value\b(?!\s*(?:[+\-*/%&|^]?=(?!=)|\*\*=|\|\|=|\?\?=|&&=|<<=|>>>?=|\+\+|--))/,
  },
  { name: "document.forms", pattern: /\bdocument\s*(?:\.\s*forms\b|\[\s*['"`]forms['"`]\s*\])/ },
  { name: "getAttribute for credential field", pattern: /getAttribute\s*\(\s*['"`](?:password|token|api[-_]?key|secret|auth|authorization|session|csrf)/i },
];

function scanCredentialSurface(scriptSource: string): string | null {
  for (const { name, pattern } of CREDENTIAL_SURFACE_PATTERNS) {
    if (pattern.test(scriptSource)) return name;
  }
  return null;
}

// Refuses invocation if the session is attached to a Browserbase context (saved auth).
// FAIL-CLOSED: the accessor tries multiple known SDK field paths. If NONE of them
// contain a recognizable context structure, the Function refuses the invocation
// entirely until BBDT_CONTEXT_FIELD_VERIFIED=true is set in the Function runtime env,
// acknowledging a deploy-time check has confirmed the correct accessor.
// Rationale: silently permitting when we can't verify context status is the exact
// fail-open bug Codex flagged. Default must be refuse.
type ContextExtractResult =
  | { status: "attached"; id: string }
  | { status: "none_verified" }
  | { status: "none_verified_sdk_v1" }
  | { status: "ambiguous"; reason: string };

// Deep search: find any object with an `id`-like property nested under a known container.
// Returns the first non-empty id found, or null. Used as a secondary pass after the
// five explicit candidate paths, to close the "recognized object at top level but id
// lives at an unhandled nested path" gap Codex flagged.
function deepFindContextId(root: unknown, depth: number = 0): string | null {
  if (depth > 6 || root === null || typeof root !== "object") return null;
  const obj = root as Record<string, unknown>;
  for (const [key, val] of Object.entries(obj)) {
    // Any key matching contextId / context_id (case insensitive) with a string value
    if (/^context[_-]?id$/i.test(key) && typeof val === "string" && val.length > 0) {
      return val;
    }
    // An object named "context" with a string `id` sub-field
    if (/^context$/i.test(key) && val && typeof val === "object") {
      const inner = val as Record<string, unknown>;
      if (typeof inner.id === "string" && inner.id.length > 0) return inner.id;
    }
    // Recurse into plain objects AND array elements (both depth-bounded)
    if (val && typeof val === "object") {
      if (Array.isArray(val)) {
        for (const el of val) {
          const found = deepFindContextId(el, depth + 1);
          if (found) return found;
        }
      } else {
        const found = deepFindContextId(val, depth + 1);
        if (found) return found;
      }
    }
  }
  return null;
}

function extractContextId(fnContext: unknown): ContextExtractResult {
  const ctx = fnContext as Record<string, unknown> | undefined;
  if (!ctx) return { status: "none_verified" };

  // 1) Explicit known SDK shapes — fast path, in order of likelihood:
  const candidates: Array<() => string | null | undefined> = [
    () => (ctx as { sessionCreateParams?: { context?: { id?: string } } }).sessionCreateParams?.context?.id,
    () => (ctx as { sessionCreateParams?: { browserSettings?: { context?: { id?: string } } } }).sessionCreateParams?.browserSettings?.context?.id,
    () => (ctx as { session?: { contextId?: string } }).session?.contextId,
    () => (ctx as { session?: { context?: { id?: string } } }).session?.context?.id,
    () => (ctx as { session?: { browserSettings?: { context?: { id?: string } } } }).session?.browserSettings?.context?.id,
    () => (ctx as { context?: { id?: string } }).context?.id,
    () => (ctx as { contextId?: string }).contextId,
    () => (ctx as { browserSettings?: { context?: { id?: string } } }).browserSettings?.context?.id,
  ];
  for (const getter of candidates) {
    try {
      const v = getter();
      if (v) return { status: "attached", id: v };
    } catch { /* try next */ }
  }

  // 2) Deep scan — catches shapes we didn't enumerate. Bounded depth to avoid runaway.
  const deep = deepFindContextId(ctx);
  if (deep) return { status: "attached", id: deep };

  // 3) No ID found anywhere. Verified SDK contract (2026-08-07, sdk-functions v1.0.1):
  //    FunctionInvocationContext is exactly looseObject({ session: looseObject({ id, connectUrl }) }),
  //    checked against dist/index.d.ts and the runtime event parser in dist/index.js. The runtime
  //    never places a context id in the handler context, so a shape matching that contract with a
  //    clean deep scan is the verified-absent state. This code-level verification replaces the
  //    BBDT_CONTEXT_FIELD_VERIFIED env flag (deployed Functions have no runtime env support).
  //    Residual limit: a context attached via invoke-time sessionCreateParams is invisible to the
  //    handler under this SDK; that vector is closed at the caller wire contract (the Minds tool
  //    rows send a params-only body with no sessionCreateParams field), not here.
  const topKeys = Object.keys(ctx);
  const sessObj = (ctx as { session?: Record<string, unknown> }).session;
  // Diagnostic (key NAMES only — never values; connectUrl embeds a signing key):
  console.log(
    "ctx-shape",
    JSON.stringify({ top: topKeys, session: sessObj ? Object.keys(sessObj) : null })
  );
  // Live-verified runtime shape (2026-08-07, invocation 1880e094): top-level keys are
  // ["session","invocation"] — the runtime adds benign metadata containers beyond the d.ts
  // schema, so the match keys on the invariants that matter: a v1-shaped session, no
  // context-bearing container at top level, and (guaranteed at this point in the flow) a
  // clean deep scan over EVERY key including the extras.
  const noContextishKeys = (o: Record<string, unknown>) =>
    !Object.keys(o).some((k) => /context/i.test(k));
  const matchesSdkV1Contract =
    sessObj !== undefined &&
    typeof sessObj.id === "string" &&
    typeof sessObj.connectUrl === "string" &&
    !("browserSettings" in sessObj) &&
    !("sessionCreateParams" in ctx) &&
    !("browserSettings" in ctx) &&
    noContextishKeys(ctx) &&
    noContextishKeys(sessObj);
  if (matchesSdkV1Contract) {
    return { status: "none_verified_sdk_v1" };
  }

  const contextishKey = (o: Record<string, unknown> | undefined) =>
    o !== undefined && Object.keys(o).some((k) => /context/i.test(k));
  const anyRecognized =
    (ctx as { sessionCreateParams?: unknown }).sessionCreateParams !== undefined ||
    (ctx as { session?: unknown }).session !== undefined ||
    (ctx as { context?: unknown }).context !== undefined ||
    (ctx as { browserSettings?: unknown }).browserSettings !== undefined ||
    "contextId" in ctx ||
    contextishKey(ctx) ||
    contextishKey(sessObj);

  if (anyRecognized) {
    return {
      status: "ambiguous",
      reason:
        "recognized container object present but no context id found via explicit paths or deep scan — " +
        "SDK may be exposing context at an unhandled path",
    };
  }

  return { status: "none_verified" };
}

function assertNoContext(fnContext: unknown, fnName: string): void {
  const result = extractContextId(fnContext);

  if (result.status === "attached") {
    throw new Error(
      `${fnName}_refused_contexted_session: session is attached to context id=${result.id}. ` +
      `Contexted sessions carry saved auth cookies and storage; this Function refuses to run ` +
      `on them to prevent credential exfiltration. Create a fresh un-contexted session for diagnostics, ` +
      `There is no bypass parameter: v2 removed allowContext — ` +
      `authenticated-state diagnostics are out of scope for this suite by design.`
    );
  }

  // Ambiguous status ALWAYS fail-closes, even with BBDT_CONTEXT_FIELD_VERIFIED=true.
  // Rationale: ambiguous means "recognized container exists but id is at an unhandled
  // path" — that is a sign the SDK shape has drifted since verification, and the old
  // verification flag should not paper over a newly-introduced fail-open vector.
  // Only "none_verified" (no recognized container at all) can be overridden by the env flag,
  // which covers the legitimate case where the SDK doesn't expose context info during
  // normal (un-contexted) invocation.
  if (result.status === "ambiguous") {
    throw new Error(
      `${fnName}_refused_ambiguous_context: ${result.reason}. ` +
      `This is fail-closed regardless of BBDT_CONTEXT_FIELD_VERIFIED because ambiguous status ` +
      `indicates the SDK shape has drifted — re-verification required. Resolution: inspect the ` +
      `actual Function runtime context, extend extractContextId() candidate paths or deepFindContextId() ` +
      `to handle the new shape, then redeploy.`
    );
  }

  if (result.status === "none_verified_sdk_v1") {
    return; // explicit allow: shape verified against sdk-functions v1.0.1 live contract
  }
  if (result.status === "none_verified" && process.env.BBDT_CONTEXT_FIELD_VERIFIED !== "true") {
    throw new Error(
      `${fnName}_refused_unverified_sdk_context: could not locate any known context field on the ` +
      `Function runtime input. The safe assumption is that the SDK shape is unrecognized. ` +
      `Fail-closed default is to refuse. Resolution: a maintainer must verify the SDK's context-accessor ` +
      `path against the deployed @browserbasehq/sdk-functions version, extend the candidate paths or ` +
      `deepFindContextId() in extractContextId() if needed, and set BBDT_CONTEXT_FIELD_VERIFIED=true in ` +
      `the Function runtime env. Do NOT set the env var without verifying — the entire security ` +
      `boundary depends on this.`
    );
  }
  if (result.status === "none_verified") {
    return; // explicit allow: env-flag-verified absence
  }
  // Default-deny: any status not explicitly allowed above is refused. The `never`
  // assignment forces a compile error if ContextExtractResult grows a new member
  // that is not handled explicitly — fail-closed by construction.
  const unhandled: never = result;
  throw new Error(`assertNoContext: unhandled context scan status ${JSON.stringify(unhandled)}`);
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type CapturedConsoleMessage = {
  level: string;
  text: string;
  source: string | null;
  line: number | null;
};

type CapturedPageError = {
  message: string;
  stack: string | null;
};

type NetworkRequestSummary = {
  url: string;
  method: string;
  status: number | null;
  size: number | null;
  duration: number | null;
  type: string;
  errorText?: string | null;
};

const sharedSessionConfig = {
  region: "us-west-2",
  browserSettings: {
    logSession: true,
    recordSession: true,
  },
} as const;

const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
    message: "URL must use http:// or https://",
  });

// Platform-wrapper tolerance (verified live 2026-08-08, invocation 13d53b67): the Minds
// dispatch layer stringifies scalar leaves when interpolating an object parameter into a
// body template — booleans arrive as "false"/"true", numbers as "3000". These preprocess
// wrappers accept exactly those wire forms and nothing looser ("false" maps to false, not
// truthy-string true). Applied to every scalar the capability params can carry.
// Wrapper lesson 3 (live 2026-08-09): the dispatch layer collapses SINGLE-ELEMENT arrays
// inside an interpolated object into {item: element} (or a bare element). Normalize any
// array-typed param back to a real array before validation. The cast preserves the inner
// schema's inferred type; runtime behavior is the preprocess pipeline.
const zArrLoose = <T extends z.ZodTypeAny>(inner: T): T =>
  z.preprocess((v) => {
    if (Array.isArray(v)) {
      // Wrapper lesson 4 (live 2026-08-17): at large array counts (~20+) the dispatch layer
      // DOUBLE-wraps the array as [[...]] (an array whose single element is the real array),
      // where small counts use the {item:[...]} form handled below. Unwrap one level so Zod
      // sees a flat array of objects. Guard: only unwrap when the sole element is itself an
      // array (never collapse a legitimate 1-element array-of-objects like [{selector,property}]).
      if (v.length === 1 && Array.isArray(v[0])) return v[0];
      return v;
    }
    if (v && typeof v === "object" && "item" in (v as Record<string, unknown>) && Object.keys(v as object).length === 1) {
      const it = (v as Record<string, unknown>).item;
      return Array.isArray(it) ? it : [it];
    }
    if (v !== undefined && v !== null) return [v];
    return v;
  }, inner) as unknown as T;

const zBoolLoose = (inner: ReturnType<typeof z.boolean>) =>
  z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), inner);
const zNumLoose = (inner: z.ZodType<number | undefined>) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : v), inner);

const viewportSchema = z.object({
  width: z.number().int().positive().max(4000),
  height: z.number().int().positive().max(4000),
});

const screenshotParamsSchema = z.object({
  url: httpUrlSchema,
  fullPage: zBoolLoose(z.boolean()).optional().default(false),
  viewport: viewportSchema.optional(),
});

const lighthouseCategorySchema = z.enum([
  "performance",
  "accessibility",
  "best-practices",
  "seo",
]);

const lighthouseParamsSchema = z.object({
  url: httpUrlSchema,
  categories: zArrLoose(z.array(lighthouseCategorySchema)).optional().default([
    "performance",
    "accessibility",
    "best-practices",
    "seo",
  ]),
});

const evaluateScriptParamsSchema = z.object({
  url: httpUrlSchema,
  script: z.string().min(1),
});

// BB_QueryDOM property safe-list. Reading .value on inputs is server-refused because
// typed-in credentials (passwords, tokens) land in .value on any page, and structured
// access does not improve that story. Callers that genuinely need form values must use
// BB_EvaluateScript under the full step 9 lockdown.
const QUERY_DOM_SAFE_PROPERTIES = [
  "textContent",
  "innerText",
  "boundingBox",
  "exists",
  "count",
  "visible",
] as const;

// Exact attribute names blocked from attribute:<name> queries — these routinely hold secrets.
const BLOCKED_ATTRIBUTE_NAMES = new Set([
  "value", "password", "token", "api-key", "apikey", "api_key",
  "secret", "auth", "authorization", "session", "csrf", "cookie",
]);

// Word-boundary tokens blocked from data-* / other custom attributes. We match
// on whole words (split by - _ .) to avoid false positives like `data-addressable`
// (contains "address") or `data-phone-mask` (contains "phone" but intended shape mask).
// At the same time we expand coverage to PII that was slipping through before.
const BLOCKED_ATTRIBUTE_TOKENS = new Set([
  // Credentials / auth
  "auth", "authorization", "token", "jwt", "bearer", "secret", "password", "apikey",
  "session", "csrf", "cookie", "credential", "credentials", "accesskey",
  // Identity / PII
  "email", "phone", "ssn", "sin", "dob", "birthdate", "birthday",
  "address", "addr", "street", "zip", "postcode", "postal",
  "balance", "iban", "account", "card", "cardnumber", "cvv", "pin",
  // Identifiers that often act as keys
  "userid", "uid", "username", "handle", "profileid",
]);

function tokenizeAttributeName(name: string): string[] {
  // Split on -, _, ., whitespace, and camelCase boundaries, then lowercase.
  return name
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .split(/[-_.\s]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
}

// Adjacent-token bigrams that are credential surface only in combination.
// Individual tokens like "access" and "key" are benign alone, but "access-key" is
// an API-key pattern. Catches data-access-key, data-auth-token, data-api-key, etc.
const BLOCKED_ATTRIBUTE_BIGRAMS: Array<[string, string]> = [
  ["access", "key"],
  ["access", "token"],
  ["api", "key"],
  ["auth", "token"],
  ["private", "key"],
  ["secret", "key"],
  ["refresh", "token"],
  ["id", "token"],
  ["session", "key"],
  ["session", "id"],
];

function isBlockedAttribute(name: string): { blocked: boolean; reason: string | null } {
  const lower = name.trim().toLowerCase();
  if (!lower) return { blocked: true, reason: "empty attribute name" };
  if (BLOCKED_ATTRIBUTE_NAMES.has(lower)) {
    return { blocked: true, reason: `${lower} is a credential-bearing attribute name` };
  }
  const tokens = tokenizeAttributeName(name);
  // 1) Exact whole-word match against BLOCKED_ATTRIBUTE_TOKENS
  for (const token of tokens) {
    if (BLOCKED_ATTRIBUTE_TOKENS.has(token)) {
      return { blocked: true, reason: `attribute token "${token}" is credential/PII-bearing` };
    }
    // Prefix match for compound single tokens (e.g. "apikey1", "authtoken", "sessionid")
    for (const prefix of ["auth", "token", "secret", "password", "session", "apikey", "ssn", "iban", "credential"]) {
      if (token.startsWith(prefix) && token.length > prefix.length) {
        return { blocked: true, reason: `attribute token "${token}" starts with credential prefix "${prefix}"` };
      }
    }
  }
  // 2) Sliding-window bigram check — e.g. ["data","access","key"] matches access+key
  for (let i = 0; i < tokens.length - 1; i++) {
    for (const [a, b] of BLOCKED_ATTRIBUTE_BIGRAMS) {
      if (tokens[i] === a && tokens[i + 1] === b) {
        return { blocked: true, reason: `attribute contains credential bigram "${a}-${b}"` };
      }
    }
  }
  return { blocked: false, reason: null };
}

const queryDomPropertySchema = z.string().refine(
  (v) => {
    if ((QUERY_DOM_SAFE_PROPERTIES as readonly string[]).includes(v)) return true;
    if (v.startsWith("attribute:")) {
      const name = v.slice("attribute:".length);
      return !isBlockedAttribute(name).blocked;
    }
    return false;
  },
  {
    message: `property must be one of ${QUERY_DOM_SAFE_PROPERTIES.join(", ")} or attribute:<name> where <name> is not a credential- or PII-bearing attribute (blocked tokens: ${[...BLOCKED_ATTRIBUTE_TOKENS].join(", ")})`,
  },
);

const queryDomItemSchema = z.object({
  selector: z.string().min(1),
  property: queryDomPropertySchema,
});

const queryDomParamsSchema = z.object({
  url: httpUrlSchema,
  queries: zArrLoose(z.array(queryDomItemSchema).min(1).max(50)),
});

const waitMsSchema = zNumLoose(z.number().int().min(0).max(30000)).optional().default(3000);

const inspectNetworkParamsSchema = z.object({
  url: httpUrlSchema,
  waitMs: waitMsSchema,
});

const consoleLogsParamsSchema = z.object({
  url: httpUrlSchema,
  waitMs: waitMsSchema,
});

const pageHealthParamsSchema = z.object({
  url: httpUrlSchema,
});

const formFieldSchema = z.object({
  selector: z.string().min(1),
  value: z.string(),
});

const fillFormParamsSchema = z.object({
  url: httpUrlSchema,
  fields: zArrLoose(z.array(formFieldSchema).min(1)),
  submitSelector: z.string().min(1),
});

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) {
    return null;
  }

  const serialized = JSON.stringify(value, (_key, nestedValue) => {
    if (typeof nestedValue === "bigint") {
      return nestedValue.toString();
    }

    return nestedValue;
  });

  if (serialized === undefined) {
    return null;
  }

  return JSON.parse(serialized) as JsonValue;
}

// Bound an operation that has no native timeout. page.evaluate in particular ignores
// setDefaultTimeout and waits for a stable execution context — on a heavy SPA whose context
// keeps churning it can hang to the 15-min Function limit. withDeadline caps any such call and
// rejects with a stage-labelled error so the caller can degrade gracefully (or surface which
// step stalled) instead of hanging.
async function withDeadline<T>(
  label: string,
  ms: number,
  task: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${ms}ms during: ${label}`)),
      ms,
    );
  });
  try {
    return await Promise.race([task(), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function withPlaywrightPage<T>(
  connectUrl: string,
  viewport: z.infer<typeof viewportSchema> | undefined,
  callback: (page: import("playwright-core").Page) => Promise<T>,
): Promise<T> {
  const browser = await chromium.connectOverCDP(connectUrl);

  try {
    const browserContext = browser.contexts()[0] ?? (await browser.newContext());
    const page = browserContext.pages()[0] ?? (await browserContext.newPage());

    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(30000);

    if (viewport) {
      await page.setViewportSize(viewport);
    }

    return await callback(page);
  } finally {
    // Bounded teardown: on heavy pages (continuous analytics / many open connections)
    // CDP browser.close() can hang indefinitely — and .catch() does not rescue a call that
    // never resolves, so the whole Function hangs to its 15-min limit AFTER the work is done
    // (observed live 2026-08-17 on hellominds.ai). Cap teardown; the Browserbase session
    // expires on its own if the close does not complete.
    await Promise.race([
      browser.close().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
  }
}

async function withPuppeteerPage<T>(
  connectUrl: string,
  callback: (page: import("puppeteer-core").Page) => Promise<T>,
): Promise<T> {
  const browser = await puppeteer.connect({
    browserWSEndpoint: connectUrl,
    protocolTimeout: 30000,
  });

  try {
    const pages = await browser.pages();
    const page = pages[0] ?? (await browser.newPage());
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(30000);

    return await callback(page);
  } finally {
    await Promise.race([
      browser.close().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
  }
}

async function navigateAndSettle(
  page: import("playwright-core").Page,
  url: string,
  waitMs = 0,
) {
  const response = await page.goto(url, {
    timeout: 30000,
    waitUntil: "domcontentloaded",
  });

  await page.waitForLoadState("load", { timeout: 15000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);

  if (waitMs > 0) {
    await page.waitForTimeout(waitMs);
  }

  return response;
}

// A Function's result is hard-capped at 64KB by the platform. A PNG screenshot of any rich page
// is hundreds of KB of base64, so returning one raw fails with RESULTS_TOO_LARGE. Encode as JPEG
// (honors a quality knob, compresses rich pages far smaller than PNG) and step quality down until
// the base64 fits the budget; if a full-page capture still can't fit at the floor quality, fall
// back to a viewport-only capture and flag the truncation. Always returns a usable image plus the
// metadata a caller needs to know what it got.
interface BoundedScreenshot {
  data: string | null;
  format: "jpeg";
  quality: number;
  bytes: number | null;
  fullPage: boolean;
  truncated: boolean;
  renderWidth?: number;
  note?: string;
}

async function takeBoundedScreenshot(
  page: import("playwright-core").Page,
  fullPage: boolean,
  maxB64Chars = 48000,
): Promise<BoundedScreenshot> {
  const qualities = [70, 50, 35, 20, 10];

  let smallestQuality = 15;
  let smallestBytes: number | null = null;
  let smallestLen = Number.POSITIVE_INFINITY;
  const track = (quality: number, bytes: number, b64len: number) => {
    if (b64len < smallestLen) {
      smallestLen = b64len;
      smallestQuality = quality;
      smallestBytes = bytes;
    }
  };

  // 1) Requested capture at native render size, quality stepping down.
  for (const quality of qualities) {
    const buffer = await page.screenshot({ type: "jpeg", quality, fullPage });
    const b64 = buffer.toString("base64");
    track(quality, buffer.length, b64.length);
    if (b64.length <= maxB64Chars) {
      return { data: b64, format: "jpeg", quality, bytes: buffer.length, fullPage, truncated: false };
    }
  }

  // 2) Full-page too big even at floor quality (very tall page): try viewport-only.
  if (fullPage) {
    for (const quality of qualities) {
      const buffer = await page.screenshot({ type: "jpeg", quality, fullPage: false });
      const b64 = buffer.toString("base64");
      track(quality, buffer.length, b64.length);
      if (b64.length <= maxB64Chars) {
        return {
          data: b64,
          format: "jpeg",
          quality,
          bytes: buffer.length,
          fullPage: false,
          truncated: true,
          note: "Full-page capture exceeded the 64KB result cap; returned viewport-only.",
        };
      }
    }
  }

  // 3) Still too big: downscale the render itself. Shrinking the viewport re-renders the page at
  // fewer pixels — the one lever that reliably brings a rich page under the cap without an image
  // library. Ladder widths down until a low-quality viewport JPEG fits; 360px is small but a real
  // above-the-fold thumbnail, always better than returning nothing.
  for (const width of [1024, 800, 640, 480, 360]) {
    await page
      .setViewportSize({ width, height: Math.round(width * 0.66) })
      .catch(() => undefined);
    for (const quality of [40, 25, 15]) {
      const buffer = await page.screenshot({ type: "jpeg", quality, fullPage: false });
      const b64 = buffer.toString("base64");
      track(quality, buffer.length, b64.length);
      if (b64.length <= maxB64Chars) {
        return {
          data: b64,
          format: "jpeg",
          quality,
          bytes: buffer.length,
          fullPage: false,
          truncated: true,
          renderWidth: width,
          note: `Downscaled render to ${width}px wide (viewport-only) to fit the 64KB result cap.`,
        };
      }
    }
  }

  // Nothing fit (extreme case). Return no image but report what the smallest attempt weighed.
  return {
    data: null,
    format: "jpeg",
    quality: smallestQuality,
    bytes: smallestBytes,
    fullPage,
    truncated: true,
    note: "Screenshot could not be compressed under the 64KB result cap even downscaled to 360px.",
  };
}

// The platform caps a Function result at 64KB. These two helpers keep array-returning functions
// (network log, console log) under that ceiling deterministically: clamp any single overlong
// string (a data: URL or a logged blob can be tens of KB on its own), then keep whole entries
// only while the running serialized size stays within budget, reporting how many were dropped. A
// truncated-but-returned result always beats a RESULTS_TOO_LARGE failure that returns nothing.
function clampString<S extends string | null>(value: S, max: number): S {
  if (value === null) {
    return value;
  }
  const text = value as string;
  return (text.length > max
    ? `${text.slice(0, max)}…[+${text.length - max} chars truncated]`
    : text) as S;
}

function fitArrayToBudget<T>(items: T[], maxBytes: number): { kept: T[]; dropped: number } {
  const kept: T[] = [];
  let size = 2; // enclosing []
  for (const item of items) {
    const itemSize = JSON.stringify(item).length + 1; // + separating comma
    // Keep at least one entry even if it alone exceeds budget (already string-clamped upstream),
    // so the caller never gets a mysteriously empty array.
    if (kept.length > 0 && size + itemSize > maxBytes) {
      break;
    }
    kept.push(item);
    size += itemSize;
  }
  return { kept, dropped: items.length - kept.length };
}

function attachConsoleCapture(page: import("playwright-core").Page) {
  const messages: CapturedConsoleMessage[] = [];
  const errors: CapturedPageError[] = [];

  page.on("console", (message) => {
    const location = message.location();

    messages.push({
      level: message.type(),
      text: message.text(),
      source: location.url || null,
      line: location.lineNumber ?? null,
    });

    if (message.type() === "error") {
      const locationText =
        location.url && location.lineNumber !== undefined
          ? `${location.url}:${location.lineNumber}`
          : location.url || null;

      errors.push({
        message: message.text(),
        stack: locationText,
      });
    }
  });

  page.on("pageerror", (error) => {
    errors.push({
      message: error.message,
      stack: error.stack ?? null,
    });
  });

  return { messages, errors };
}

function attachNetworkCapture(page: import("playwright-core").Page) {
  const startedAt = new Map<import("playwright-core").Request, number>();
  const requests: NetworkRequestSummary[] = [];

  page.on("request", (request) => {
    startedAt.set(request, Date.now());
  });

  page.on("response", async (response) => {
    const request = response.request();
    const startTime = startedAt.get(request);
    const headers = response.headers();
    const contentLengthHeader = headers["content-length"];
    const parsedSize = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : Number.NaN;

    requests.push({
      url: request.url(),
      method: request.method(),
      status: response.status(),
      size: Number.isFinite(parsedSize) ? parsedSize : null,
      duration: startTime ? Date.now() - startTime : null,
      type: request.resourceType(),
    });
  });

  page.on("requestfailed", (request) => {
    const startTime = startedAt.get(request);
    const failure = request.failure();

    requests.push({
      url: request.url(),
      method: request.method(),
      status: null,
      size: null,
      duration: startTime ? Date.now() - startTime : null,
      type: request.resourceType(),
      errorText: failure?.errorText ?? null,
    });
  });

  return requests;
}

function summarizeRequests(requests: NetworkRequestSummary[]) {
  const slowest =
    [...requests].sort((left, right) => (right.duration ?? -1) - (left.duration ?? -1))[0] ?? null;
  const largest =
    [...requests].sort((left, right) => (right.size ?? -1) - (left.size ?? -1))[0] ?? null;

  return {
    total: requests.length,
    failed: requests.filter((request) => request.status === null || request.status >= 400).length,
    slowest,
    largest,
  };
}

async function getPageMetrics(page: import("playwright-core").Page) {
  return page.evaluate(() => {
    const navigation = performance.getEntriesByType(
      "navigation",
    )[0] as PerformanceNavigationTiming | undefined;
    const paints = performance.getEntriesByType("paint");
    const firstPaint = paints.find((entry) => entry.name === "first-paint")?.startTime ?? null;
    const firstContentfulPaint =
      paints.find((entry) => entry.name === "first-contentful-paint")?.startTime ?? null;

    return {
      loadTime: navigation?.loadEventEnd ?? null,
      domContentLoaded: navigation?.domContentLoadedEventEnd ?? null,
      firstPaint,
      firstContentfulPaint,
    };
  });
}

function getCategoryScore(
  category: import("lighthouse").Result["categories"][string] | undefined,
) {
  if (!category || category.score === null) {
    return null;
  }

  return Math.round(category.score * 100);
}

async function fillField(
  page: import("playwright-core").Page,
  field: z.infer<typeof formFieldSchema>,
) {
  const locator = page.locator(field.selector).first();
  await locator.waitFor({ state: "visible", timeout: 10000 });

  const info = await locator.evaluate((element) => {
    const input = element instanceof HTMLInputElement ? element : null;
    return {
      tag: element.tagName.toLowerCase(),
      type: input?.type?.toLowerCase() ?? "",
      role: (element.getAttribute("role") ?? "").toLowerCase(),
      editable: element instanceof HTMLElement && element.isContentEditable,
    };
  });

  // "Off" values un-set a toggle; anything else (a label, an option value, "on") sets it.
  const isOff = ["0", "false", "no", "off", "unchecked", ""].includes(
    field.value.trim().toLowerCase(),
  );

  // Native <select>
  if (info.tag === "select") {
    await locator.selectOption({ label: field.value }).catch(async () => {
      await locator.selectOption(field.value);
    });
    return;
  }

  // Native checkbox — a reliable toggle via check()/uncheck().
  if (info.type === "checkbox") {
    if (isOff) {
      await locator.uncheck();
    } else {
      await locator.check();
    }
    return;
  }

  // Native radio — select-only; clicking/checking an already-selected radio is a no-op.
  if (info.type === "radio") {
    if (!isOff) {
      await locator.check();
    }
    return;
  }

  // ARIA radio / option (role="radio", Google Forms etc.). These are <div>s, not inputs, so the
  // old code fell through to fill() and errored. They are select-only and click-driven — their
  // handler often lives on a wrapping <label> and toggles aria-checked on click — so a plain click
  // is the correct, idempotent action. This is the actual Google-Forms radio gap Tung reported.
  if (["radio", "option", "menuitemradio"].includes(info.role)) {
    if (!isOff) {
      await locator.check().catch(() => locator.click());
    }
    return;
  }

  // ARIA checkbox / switch — a toggle. Read aria-checked and click only if the current state
  // differs from the requested one, so we never double-toggle back to where we started.
  if (["checkbox", "switch", "menuitemcheckbox"].includes(info.role)) {
    const checked = (await locator.getAttribute("aria-checked")) === "true";
    if (checked !== !isOff) {
      await locator.click();
    }
    return;
  }

  // Text-like inputs, <textarea>, and contenteditable → type the value.
  const NON_FILLABLE_INPUT = ["submit", "button", "reset", "image", "file"];
  const fillable =
    info.tag === "textarea" ||
    info.editable ||
    (info.tag === "input" && !NON_FILLABLE_INPUT.includes(info.type));
  if (fillable) {
    await locator.fill(field.value);
    return;
  }

  // Anything else (a button, link, label, or custom clickable widget) → click it. This lets a
  // field entry double as a "click this selector" step, covering widgets we don't special-case.
  await locator.click();
}

defineFn(
  "navigate-and-screenshot",
  async (context, rawParams) => {
    assertNoContext(context, "navigate-and-screenshot");
    // Runtime passes raw params without applying the Zod schema — parse explicitly so
    // wrapper-stringified scalars ("false") are coerced before use (live lesson 13d53b67).
    const params = screenshotParamsSchema.parse(rawParams);
    return withPlaywrightPage(context.session.connectUrl, params.viewport, async (page) => {
      await navigateAndSettle(page, params.url);

      // Size-bounded JPEG, not raw PNG: the platform caps Function results at 64KB and a raw
      // rich-page PNG base64 (~800KB) fails with RESULTS_TOO_LARGE. Returns a usable image that
      // fits, plus format/quality/truncated so the caller knows what it got.
      const shot = await takeBoundedScreenshot(page, params.fullPage);

      return {
        screenshot: shot.data,
        screenshotFormat: shot.format,
        screenshotQuality: shot.quality,
        screenshotBytes: shot.bytes,
        screenshotTruncated: shot.truncated,
        ...(shot.renderWidth ? { screenshotRenderWidth: shot.renderWidth } : {}),
        ...(shot.note ? { screenshotNote: shot.note } : {}),
        title: await page.title(),
        url: page.url(),
      };
    });
  },
  {
    parametersSchema: screenshotParamsSchema,
    sessionConfig: sharedSessionConfig,
  },
);

defineFn(
  "run-lighthouse",
  async (context, rawParams) => {
    assertNoContext(context, "run-lighthouse");
    const params = lighthouseParamsSchema.parse(rawParams);
    return withPuppeteerPage(context.session.connectUrl, async (page) => {
      // NOTE: lighthouse currently fails in the Function sandbox with an uncatchable process-level
      // exit (no rejected promise reaches a try/catch here; the invocation dies as WORKLOAD_ERROR
      // within ~13s). Diagnosed 2026-08-17 as a serverless resource limit (probable OOM running the
      // full audit) — not fixable from function code, since the SDK exposes no memory/timeout knob.
      // Pre-existing and independent of the 2026-08 bug fixes. For basic load timing, use
      // check-page-health (returns navigation metrics). Revisit if the platform raises Function
      // memory or exposes a config for it.
      const runnerResult = await lighthouse(
        params.url,
        {
          disableStorageReset: true,
          logLevel: "error",
          onlyCategories: params.categories,
        },
        desktopConfig,
        page,
      );

      if (!runnerResult) {
        throw new Error("Lighthouse did not return a result");
      }

      const lhr = runnerResult.lhr;
      const auditIds = [
        ...new Set(
          params.categories.flatMap(
            (category) => lhr.categories[category]?.auditRefs.map((auditRef) => auditRef.id) ?? [],
          ),
        ),
      ];

      const audits = auditIds
        .map((auditId) => {
          const audit = lhr.audits[auditId];

          if (!audit) {
            return null;
          }

          return {
            id: auditId,
            title: audit.title,
            score: audit.score === null ? null : Math.round(audit.score * 100),
            scoreDisplayMode: audit.scoreDisplayMode,
            displayValue: audit.displayValue ?? null,
            description: audit.description,
          };
        })
        .filter((audit): audit is NonNullable<typeof audit> => audit !== null)
        .sort((left, right) => (left.score ?? 101) - (right.score ?? 101));

      return {
        scores: {
          performance: getCategoryScore(lhr.categories.performance),
          accessibility: getCategoryScore(lhr.categories.accessibility),
          bestPractices: getCategoryScore(lhr.categories["best-practices"]),
          seo: getCategoryScore(lhr.categories.seo),
        },
        audits,
        fetchTime: lhr.fetchTime,
        url: lhr.finalUrl ?? params.url,
      };
    });
  },
  {
    parametersSchema: lighthouseParamsSchema,
    sessionConfig: sharedSessionConfig,
  },
);

defineFn(
  "evaluate-script",
  async (context, rawParams) => {
    const params = evaluateScriptParamsSchema.parse(rawParams);
    // Server-side security gates — both MUST pass before new Function executes.
    // These are the real boundary; skill-layer constraints (#19 EVALUATE_SCRIPT LOCKDOWN)
    // are prompt compliance and can be slipped by a model or prompt injection.
    assertNoContext(context, "evaluate-script");
    const matched = scanCredentialSurface(params.script);
    if (matched) {
      throw new Error(
        `evaluate_script_refused_credential_surface: script contains ${matched}. ` +
        `This pattern is refused server-side regardless of skill-layer confirmation. ` +
        `Rewrite the script to avoid credential surface, or use BB_QueryDOM for structured reads ` +
        `of public DOM content. Do NOT attempt obfuscation — the refusal stands.`
      );
    }

    return withPlaywrightPage(context.session.connectUrl, undefined, async (page) => {
      const consoleCapture = attachConsoleCapture(page);
      await navigateAndSettle(page, params.url);

      const result = await page.evaluate(async (scriptSource) => {
        const runner = new Function(`
          return (async () => {
            ${scriptSource}
          })();
        `);

        return runner.call(window);
      }, params.script);

      return {
        result: toJsonValue(result),
        console: consoleCapture.messages.map((message) => message.text),
        errors: consoleCapture.errors.map((error) => ({
          message: error.message,
          stack: error.stack,
        })),
      };
    });
  },
  {
    parametersSchema: evaluateScriptParamsSchema,
    sessionConfig: sharedSessionConfig,
  },
);

defineFn(
  "query-dom",
  async (context, rawParams) => {
    const params = queryDomParamsSchema.parse(rawParams);
    // Contexted-session refusal mirrors evaluate-script — reading DOM on authenticated
    // pages can leak account identifiers, balances, PII even without reading .value.
    assertNoContext(context, "query-dom");

    return withPlaywrightPage(context.session.connectUrl, undefined, async (page) => {
      await navigateAndSettle(page, params.url);

      const results = [];
      for (const query of params.queries) {
        const property = query.property;

        try {
          let value: JsonValue;

          // Uniform zero-match handling: probe count first and return a normalized
          // `null` for "no element found" across all property types (except `exists`
          // and `count`, which have defined semantics). Matches caller expectations.
          const matchCount = await page.locator(query.selector).count();

          if (property === "exists") {
            value = matchCount > 0;
          } else if (property === "count") {
            value = matchCount;
          } else if (matchCount === 0) {
            // Normalize: zero matches -> null for all other properties
            results.push({ selector: query.selector, property, value: null, matched: false });
            continue;
          } else {
            const locator = page.locator(query.selector).first();
            if (property === "visible") {
              value = await locator.isVisible();
            } else if (property === "boundingBox") {
              const box = await locator.boundingBox();
              value = box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
            } else if (property === "textContent") {
              value = await locator.textContent();
            } else if (property === "innerText") {
              value = await locator.innerText();
            } else if (property.startsWith("attribute:")) {
              const attrName = property.slice("attribute:".length);
              const guard = isBlockedAttribute(attrName);
              if (guard.blocked) {
                throw new Error(`query_dom_refused_attribute: ${guard.reason}`);
              }
              value = await locator.getAttribute(attrName);
            } else {
              throw new Error(`query_dom_unknown_property: ${property}`);
            }
          }

          results.push({ selector: query.selector, property, value, matched: matchCount > 0 });
        } catch (error) {
          results.push({
            selector: query.selector,
            property,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return { results };
    });
  },
  {
    parametersSchema: queryDomParamsSchema,
    sessionConfig: sharedSessionConfig,
  },
);

// Server-side redaction for CDP logs / network payloads / recordings.
// Skill-layer redaction (constraint #21) is prompt compliance; this is the real boundary.
const REDACTED_HEADERS = new Set([
  "authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token",
  "x-csrf-token", "proxy-authorization", "x-session-token", "x-access-token",
]);
const REDACTED_BODY_KEYS = new Set([
  "password", "token", "apikey", "api_key", "secret", "sessionid", "session_id",
  "authtoken", "auth_token", "bearer", "credentials", "credential", "otp", "pin",
  // OAuth / JWT flow keys — missing in the prior set, Codex flagged
  "access_token", "accesstoken", "refresh_token", "refreshtoken",
  "id_token", "idtoken", "client_secret", "clientsecret",
  "authorization_code", "code",
]);

const REDACTED_QUERY_KEYS = [
  "password", "token", "apikey", "api_key", "secret", "sessionid", "session_id",
  "authtoken", "auth_token", "bearer", "otp", "pin", "credentials",
  "access_token", "refresh_token", "id_token", "client_secret",
  "authorization_code", "code",
];

function redactString(input: string): string {
  // Strip common credential query string / body / header values in raw text blobs.
  // Covers: URL ?key=value, bracketed ?obj[key]=value, JSON "key":"value",
  // raw HTTP header lines like `X-Access-Token: abc` or `Authorization: Bearer xyz`.
  try {
    const queryKeyAlt = REDACTED_QUERY_KEYS.join("|");
    const headerAlt = [...REDACTED_HEADERS].join("|");
    return input
      // URL query: ?key=value or &key=value  OR  ?obj[key]=value
      .replace(
        new RegExp(`([?&])((?:[^=&\\s]*\\[)?(?:${queryKeyAlt})(?:\\])?=)[^&\\s"']+`, "gi"),
        "$1$2[REDACTED]",
      )
      // JSON body: "key":"value" or "key": "value"
      .replace(
        new RegExp(`("(?:${queryKeyAlt})"\\s*:\\s*)"[^"]*"`, "gi"),
        '$1"[REDACTED]"',
      )
      // Raw HTTP header lines (including inside log blobs where headers are
      // concatenated as strings rather than structured objects). Case-insensitive
      // header name match, redacts the value through end-of-line.
      .replace(
        new RegExp(`^(\\s*(?:${headerAlt})\\s*:\\s*).*$`, "gim"),
        "$1[REDACTED]",
      );
  } catch {
    return input;
  }
}

function redactLogPayload(value: unknown, depth: number = 0): unknown {
  // Depth cutoff: fail-closed by returning [REDACTED_TRUNCATED] rather than raw value.
  // Prior behavior was to return the raw sub-tree past depth — Codex flagged that as
  // silent leakage. Now we clamp at depth 12 (deeper than before) and mark truncation.
  if (depth > 12) return "[REDACTED_TRUNCATED]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactLogPayload(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const keyLower = k.toLowerCase();
      if (REDACTED_HEADERS.has(keyLower) || REDACTED_BODY_KEYS.has(keyLower)) {
        out[k] = "[REDACTED]";
        continue;
      }
      // Some logs nest headers under a `headers` object with preserved case;
      // handle both case-insensitive lookup and deep redaction of children.
      if (keyLower === "headers" && v && typeof v === "object") {
        const h = v as Record<string, unknown>;
        const redactedHeaders: Record<string, unknown> = {};
        for (const [hk, hv] of Object.entries(h)) {
          redactedHeaders[hk] = REDACTED_HEADERS.has(hk.toLowerCase()) ? "[REDACTED]" : redactLogPayload(hv, depth + 1);
        }
        out[k] = redactedHeaders;
        continue;
      }
      out[k] = redactLogPayload(v, depth + 1);
    }
    return out;
  }
  return value;
}

// Ensure redactLogPayload is visible to any future Function definition in this file.
// Exporting is harmless for @browserbasehq/sdk-functions (unused exports ignored).
export { redactLogPayload };

const redactSessionLogsParamsSchema = z.object({
  sessionId: z.string().min(1),
  // Browserbase API base URL (templatable for deploy envs). Default matches public endpoint.
  apiBase: z.string().url().optional().default("https://api.browserbase.com"),
});

defineFn(
  "redact-session-logs",
  async (context, params) => {
    // Resolve API key — try runtime-propagated SDK auth paths FIRST (so the caller's
    // per-invocation key is honored), then fall back to BBDT_BB_API_KEY env for deploys
    // where the runtime does not propagate. This matches how extractContextId handles
    // the similar "SDK field might be elsewhere" problem.
    const ctx = context as Record<string, unknown> | undefined;
    // Each candidate returns the RAW key value only — no header prefix. If an accessor
    // yields a full header line like "X-BB-API-Key: xyz" or "Bearer xyz", normalizeKey()
    // strips the prefix so we never double-wrap the header.
    const candidates: Array<() => string | null | undefined> = [
      () => (ctx as { auth?: { apiKey?: string } } | undefined)?.auth?.apiKey,
      () => (ctx as { auth?: { key?: string } } | undefined)?.auth?.key,
      () => (ctx as { apiKey?: string } | undefined)?.apiKey,
      () => (ctx as { headers?: { "x-bb-api-key"?: string } } | undefined)?.headers?.["x-bb-api-key"],
      () => (ctx as { headers?: { "X-BB-API-Key"?: string } } | undefined)?.headers?.["X-BB-API-Key"],
      // authHeader intentionally last — it is ambiguous (may be a raw key, a full header,
      // or a Bearer-prefixed string). normalizeKey() handles these variants.
      () => (ctx as { authHeader?: string } | undefined)?.authHeader,
    ];
    const normalizeKey = (raw: string): string => {
      let v = raw.trim();
      // Strip "X-BB-API-Key: " or "X-BB-API-KEY:" prefix if present
      v = v.replace(/^X-BB-API-Key\s*:\s*/i, "").trim();
      // Strip "Bearer" prefix even if it's the entire value (edge case: "Bearer " with
      // no key after) — \s* not \s+ so it fires on prefix-only. The subsequent trim
      // leaves an empty string in that case, which the caller detects and falls back to env.
      v = v.replace(/^Bearer\s*/i, "").trim();
      return v;
    };
    let apiKey = "";
    for (const g of candidates) {
      try {
        const v = g();
        if (v) { apiKey = normalizeKey(v); if (apiKey) break; }
      } catch { /* try next */ }
    }
    if (!apiKey) apiKey = normalizeKey(process.env.BBDT_BB_API_KEY ?? "");

    if (!apiKey) {
      throw new Error(
        "redact_session_logs_no_api_key: the Function could not resolve a Browserbase API key " +
        "from either the runtime context (checked auth.apiKey, auth.key, apiKey, authHeader, " +
        "headers['x-bb-api-key']) or the BBDT_BB_API_KEY env var. Cannot fetch logs without auth. " +
        "Resolution: set BBDT_BB_API_KEY in the Function runtime env to the same key the caller " +
        "uses for /v1/functions/{id}/invoke, OR update the candidate accessor list above if the " +
        "SDK exposes the caller's key at a different path."
      );
    }

    // Contexted-session refusal applies here too — raw CDP logs on contexted sessions
    // contain saved auth cookies in the clear.
    assertNoContext(context, "redact-session-logs");

    const url = `${params.apiBase.replace(/\/$/, "")}/v1/sessions/${encodeURIComponent(params.sessionId)}/logs`;
    const response = await fetch(url, {
      method: "GET",
      headers: { "X-BB-API-Key": apiKey, "Accept": "application/json" },
    });

    if (!response.ok) {
      throw new Error(
        `redact_session_logs_upstream_failed: ${response.status} ${response.statusText} fetching ${url}. ` +
        `If 401, the resolved API key is wrong, revoked, or missing required scope. ` +
        `If 404, sessionId is invalid or expired.`
      );
    }

    const raw = await response.json();
    const redacted = redactLogPayload(raw);
    const redactedValue = toJsonValue(redacted);

    // Session CDP logs run to many MB; the platform caps a Function result at 64KB. Return a
    // bounded, honestly-flagged slice rather than hard-failing with RESULTS_TOO_LARGE. If the log
    // is a top-level array, keep as many leading entries as fit; otherwise clip a JSON text sample.
    const MAX_LOG_BYTES = 55000;
    const serialized = JSON.stringify(redactedValue);
    if (serialized.length <= MAX_LOG_BYTES) {
      return {
        redacted: redactedValue,
        truncated: false,
        source: "redact-session-logs",
        sessionId: params.sessionId,
      };
    }
    if (Array.isArray(redactedValue)) {
      const bounded = fitArrayToBudget(redactedValue, MAX_LOG_BYTES);
      return {
        redacted: bounded.kept,
        truncated: true,
        entriesTotal: redactedValue.length,
        entriesDropped: bounded.dropped,
        note:
          "Session log exceeded the 64KB result cap; returned the leading entries that fit. " +
          "Fetch a narrower window for a complete slice.",
        source: "redact-session-logs",
        sessionId: params.sessionId,
      };
    }
    return {
      redacted: null,
      redactedTextSample: clampString(serialized, MAX_LOG_BYTES),
      truncated: true,
      bytesTotal: serialized.length,
      note:
        "Session log exceeded the 64KB result cap and is not a top-level array; returned a " +
        "clipped JSON text sample.",
      source: "redact-session-logs",
      sessionId: params.sessionId,
    };
  },
  {
    parametersSchema: redactSessionLogsParamsSchema,
    sessionConfig: sharedSessionConfig,
  },
);

defineFn(
  "inspect-network",
  async (context, rawParams) => {
    assertNoContext(context, "inspect-network");
    const params = inspectNetworkParamsSchema.parse(rawParams);
    return withPlaywrightPage(context.session.connectUrl, undefined, async (page) => {
      const requests = attachNetworkCapture(page);
      await navigateAndSettle(page, params.url, params.waitMs);

      // summary is computed over ALL requests (it stays complete); the requests array is
      // string-clamped and byte-bounded so a chatty page can't blow the 64KB result cap.
      const summary = summarizeRequests(requests);
      const clamped = requests.map((request) => ({
        ...request,
        url: clampString(request.url, 1024),
      }));
      const bounded = fitArrayToBudget(clamped, 50000);

      return {
        requests: bounded.kept,
        requestsTotal: requests.length,
        requestsDropped: bounded.dropped,
        summary,
      };
    });
  },
  {
    parametersSchema: inspectNetworkParamsSchema,
    sessionConfig: sharedSessionConfig,
  },
);

defineFn(
  "get-console-logs",
  async (context, rawParams) => {
    assertNoContext(context, "get-console-logs");
    const params = consoleLogsParamsSchema.parse(rawParams);
    return withPlaywrightPage(context.session.connectUrl, undefined, async (page) => {
      const consoleCapture = attachConsoleCapture(page);
      await navigateAndSettle(page, params.url, params.waitMs);

      // Clamp each entry's long strings, then byte-bound each array so a verbose page (SPAs can
      // log thousands of lines / large objects) can't blow the 64KB result cap.
      const clampedMessages = consoleCapture.messages.map((message) => ({
        ...message,
        text: clampString(message.text, 1000),
        source: clampString(message.source, 512),
      }));
      const clampedErrors = consoleCapture.errors.map((error) => ({
        ...error,
        message: clampString(error.message, 1000),
        stack: clampString(error.stack, 1000),
      }));
      const boundedMessages = fitArrayToBudget(clampedMessages, 26000);
      const boundedErrors = fitArrayToBudget(clampedErrors, 26000);

      return {
        messages: boundedMessages.kept,
        messagesTotal: consoleCapture.messages.length,
        messagesDropped: boundedMessages.dropped,
        errors: boundedErrors.kept,
        errorsTotal: consoleCapture.errors.length,
        errorsDropped: boundedErrors.dropped,
      };
    });
  },
  {
    parametersSchema: consoleLogsParamsSchema,
    sessionConfig: sharedSessionConfig,
  },
);

defineFn(
  "check-page-health",
  async (context, rawParams) => {
    assertNoContext(context, "check-page-health");
    const params = pageHealthParamsSchema.parse(rawParams);
    return withPlaywrightPage(context.session.connectUrl, undefined, async (page) => {
      const consoleCapture = attachConsoleCapture(page);
      const requests = attachNetworkCapture(page);
      const response = await navigateAndSettle(page, params.url, 1000);

      const failedRequests = requests.filter(
        (request) => request.status === null || request.status >= 400,
      );

      // No screenshot here by design. A Function's result is hard-capped at 64KB by the
      // platform (RESULTS_TOO_LARGE above that), and a single rich-page screenshot base64 is
      // ~800KB — so embedding one made the health check fail on every non-trivial page. A
      // health verdict is structured signal (did it load, console errors, failed requests,
      // load timing), which the calling Mind can actually reason over. For a visual, call
      // BB_Screenshot separately (it returns a size-bounded image).
      //
      // metrics runs page.evaluate, which ignores setDefaultTimeout and waits for a stable
      // execution context — on a heavy SPA (observed live on hellominds.ai 2026-08-17) that
      // evaluate can hang to the 15-min Function limit. Bound it and degrade to null so the
      // verdict still returns from everything else.
      const metrics = await withDeadline("check-page-health metrics", 10000, () =>
        getPageMetrics(page),
      ).catch(() => null);

      return {
        finalUrl: page.url(),
        title: await page.title().catch(() => null),
        httpStatus: response?.status() ?? null,
        loaded: response?.ok() ?? false,
        errors: consoleCapture.errors,
        failedRequests,
        metrics,
      };
    });
  },
  {
    parametersSchema: pageHealthParamsSchema,
    sessionConfig: sharedSessionConfig,
  },
);

defineFn(
  "fill-and-submit-form",
  async (context, rawParams) => {
    assertNoContext(context, "fill-and-submit-form");
    const params = fillFormParamsSchema.parse(rawParams);
    return withPlaywrightPage(context.session.connectUrl, undefined, async (page) => {
      await navigateAndSettle(page, params.url);

      for (const field of params.fields) {
        await fillField(page, field);
      }

      // Two size-bounded JPEGs, not raw PNGs. This result carries a before AND an after image,
      // so each gets a tighter budget (~22KB base64) to keep the pair plus the response under
      // the platform's 64KB result cap. Raw full-page PNGs here (~800KB each) guaranteed a
      // RESULTS_TOO_LARGE failure on any real form.
      const beforeScreenshot = await takeBoundedScreenshot(page, true, 22000);

      const navigationPromise = page
        .waitForNavigation({
          timeout: 15000,
          waitUntil: "domcontentloaded",
        })
        .catch(() => null);

      await page.locator(params.submitSelector).first().click();

      const navigationResponse = await navigationPromise;
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);

      const afterScreenshot = await takeBoundedScreenshot(page, true, 22000);

      return {
        beforeScreenshot: beforeScreenshot.data,
        afterScreenshot: afterScreenshot.data,
        screenshotFormat: "jpeg",
        screenshotsTruncated: beforeScreenshot.truncated || afterScreenshot.truncated,
        response: {
          url: page.url(),
          status: navigationResponse?.status() ?? null,
        },
      };
    });
  },
  {
    parametersSchema: fillFormParamsSchema,
    sessionConfig: sharedSessionConfig,
  },
);
