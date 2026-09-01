// Local verification harness for the run-lighthouse rewrite. Executes the real
// registered handler through the SDK's functionsRegistry against a locally
// launched Chrome (CDP on 127.0.0.1:9223), with a synthetic sdk-v1 context.
//
//   1. "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//        --headless=new --remote-debugging-port=9223 --user-data-dir=/tmp/bbtest-profile about:blank &
//   2. npx tsx test-local-harness.mts
//
// BB_FUNCTIONS_PHASE must not be "runtime" (the default): that starts the Lambda
// invocation loop, which exits the process when no runtime API is listening.
process.env.BB_FUNCTIONS_PHASE = "introspect";

const { functionsRegistry } = await import("@browserbasehq/sdk-functions");
await import("./index.ts");

const context = { session: { id: "local-test", connectUrl: "http://127.0.0.1:9223" } };
const CAP = 65536;

type Case = {
  label: string;
  params: Record<string, unknown>;
  expect: (r: any) => string[];
  stubPsi?: boolean;
};

// Canned PSI response: real shape, oversized audit set, to prove the distiller
// maps scores and byte-bounds the audit list under the 64KB cap.
function makeStubPsiBody(): string {
  const audits: Record<string, unknown> = {};
  const auditRefs: Array<{ id: string }> = [];
  for (let index = 0; index < 400; index++) {
    const id = `stub-audit-${index}`;
    auditRefs.push({ id });
    audits[id] = {
      title: `Stub audit ${index} with a fairly long descriptive title for size`,
      score: index % 5 === 0 ? 0.35 : 0.95,
      scoreDisplayMode: "numeric",
      displayValue: `${index} units of displayed value`,
      description: "x".repeat(400),
    };
  }
  return JSON.stringify({
    lighthouseResult: {
      lighthouseVersion: "12.0.0-stub",
      fetchTime: "2026-09-01T00:00:00.000Z",
      finalDisplayedUrl: "https://example.com/",
      categories: {
        performance: { score: 0.87, auditRefs },
        accessibility: { score: 0.91, auditRefs: auditRefs.slice(0, 10) },
        "best-practices": { score: 1, auditRefs: [] },
        seo: { score: 0.75, auditRefs: [] },
      },
      audits,
    },
  });
}

const realFetch = globalThis.fetch;

const cases: Case[] = [
  {
    label: "psi distillation (stubbed 400-audit LHR)",
    params: { url: "https://example.com", engine: "psi" },
    stubPsi: true,
    expect: (r) => [
      r.engine === "psi" ? "" : `engine=${r.engine}, want psi`,
      r.scores?.performance === 87 && r.scores?.seo === 75 ? "" : `score mapping wrong: ${JSON.stringify(r.scores)}`,
      r.scoresApproximate === false ? "" : "psi scores should not be approximate",
      r.auditsDropped > 0 ? "" : "oversized audit list was not byte-bounded",
      r.lighthouseVersion === "12.0.0-stub" ? "" : "missing lighthouseVersion",
      r.audits[0]?.score === 35 ? "" : "audits not sorted worst-first",
    ],
  },
  {
    label: "auto example.com (live PSI if quota allows, else local)",
    params: { url: "https://example.com", engine: "auto" },
    expect: (r) => [
      r.engine === "psi" || (r.engine === "local" && typeof r.note === "string")
        ? ""
        : `engine=${r.engine} without fallback note`,
      typeof r.scores?.performance === "number" ? "" : "missing numeric performance score",
    ],
  },
  {
    label: "local example.com (in-sandbox audit)",
    params: { url: "https://example.com", engine: "local" },
    expect: (r) => [
      r.engine === "local" ? "" : `engine=${r.engine}, want local`,
      typeof r.scores?.performance === "number" ? "" : "missing numeric performance score",
      r.scoresApproximate === true ? "" : "local scores must be flagged approximate",
      typeof r.metrics?.fcp === "number" ? "" : "missing measured FCP",
      Array.isArray(r.audits) && r.audits.length >= 8 ? "" : "too few audits",
    ],
  },
  {
    label: "local hellominds.ai (rich SPA, the old killer)",
    params: { url: "https://hellominds.ai", engine: "local", strategy: "mobile" },
    expect: (r) => [
      r.engine === "local" ? "" : `engine=${r.engine}, want local`,
      typeof r.scores?.performance === "number" ? "" : "missing numeric performance score",
      r.strategy === "mobile" ? "" : "strategy not honored",
    ],
  },
  {
    label: "auto with PSI-unreachable URL (fallback chain)",
    params: { url: "http://127.0.0.1:8077/", engine: "auto" },
    expect: (r) => [
      r.engine === "local" ? "" : `engine=${r.engine}, want local fallback`,
      typeof r.note === "string" && r.note.includes("PSI engine unavailable")
        ? ""
        : "missing fallback note",
    ],
  },
  {
    label: "auto with credential-bearing URL skips PSI",
    params: { url: "http://127.0.0.1:8077/?token=abc123", engine: "auto" },
    stubPsi: true, // stub would succeed — proving the guard, not a PSI failure, chose local
    expect: (r) => [
      r.engine === "local" ? "" : `engine=${r.engine}, want local (PSI must be skipped)`,
      typeof r.note === "string" && r.note.includes("credential-bearing")
        ? ""
        : "missing credential-guard note",
    ],
  },
  {
    label: "explicit empty categories treated as all four (local)",
    params: { url: "http://127.0.0.1:8077/", engine: "local", categories: [] },
    expect: (r) => [
      typeof r.scores?.performance === "number" &&
      typeof r.scores?.accessibility === "number" &&
      typeof r.scores?.bestPractices === "number" &&
      typeof r.scores?.seo === "number"
        ? ""
        : `empty categories not normalized: ${JSON.stringify(r.scores)}`,
    ],
  },
  {
    label: "psi runtimeError LHR is rejected (auto falls back)",
    params: { url: "http://127.0.0.1:8077/", engine: "auto", psiApiKey: "stub" },
    stubPsi: true,
    expect: (r) => [
      r.engine === "local" ? "" : `engine=${r.engine}, want local fallback`,
      typeof r.note === "string" && r.note.includes("psi_runtime_error_NO_FCP")
        ? ""
        : `note missing runtime-error reason: ${r.note}`,
    ],
  },
];

let failed = 0;
for (const testCase of cases) {
  const started = Date.now();
  globalThis.fetch = testCase.stubPsi
    ? (async (input: any) => {
        const target = String(input);
        if (!target.includes("pagespeedonline")) return realFetch(input);
        // key=stub selects the failed-run fixture: 200 with runtimeError + null scores.
        if (target.includes("key=stub")) {
          return new Response(
            JSON.stringify({
              lighthouseResult: {
                lighthouseVersion: "12.0.0-stub",
                runtimeError: { code: "NO_FCP", message: "The page did not paint any content." },
                categories: {
                  performance: { score: null, auditRefs: [] },
                  accessibility: { score: null, auditRefs: [] },
                  "best-practices": { score: null, auditRefs: [] },
                  seo: { score: null, auditRefs: [] },
                },
                audits: {},
              },
            }),
            { status: 200 },
          );
        }
        return new Response(makeStubPsiBody(), { status: 200 });
      }) as typeof fetch
    : realFetch;
  try {
    const result = await functionsRegistry.execute("run-lighthouse", testCase.params, context);
    const bytes = JSON.stringify(result).length;
    const problems = testCase.expect(result).filter(Boolean);
    if (bytes >= CAP) problems.push(`result ${bytes}B >= 64KB cap`);
    const status = problems.length === 0 ? "PASS" : "FAIL";
    if (problems.length > 0) failed++;
    console.log(
      `${status} ${testCase.label} — ${Date.now() - started}ms, ${bytes}B, scores=${JSON.stringify(
        (result as any).scores,
      )}, auditsTotal=${(result as any).auditsTotal}, dropped=${(result as any).auditsDropped}`,
    );
    for (const problem of problems) console.log(`   !! ${problem}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${testCase.label} — threw after ${Date.now() - started}ms:`, error);
  }
}

console.log(failed === 0 ? "ALL PASS" : `${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
