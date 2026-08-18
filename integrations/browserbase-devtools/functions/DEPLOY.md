# Deploy the DevTools Functions to your Browserbase account (one-time)

BrowserbaseDevTools_Suite is **bring-your-own-key**: its screenshot, Lighthouse, JavaScript-evaluate, DOM-query, network, console, page-health and form-fill tools each run a small serverless **Browserbase Function**. Browserbase Functions live inside *your* Browserbase project, so you deploy them once against your own key. The session, context, fetch, search and usage tools need none of this and work the moment you equip the app.

You run this once per Browserbase account. It takes about a minute.

## Prerequisites
- Node.js 18+ and this `functions/` folder (source + pinned deps).
- Your Browserbase API key (`bb_live_…`) and project id, from https://browserbase.com/settings.

## Deploy

```bash
cd functions
npm install            # or: pnpm install  (first time only)
BROWSERBASE_API_KEY=bb_live_YOURKEY \
BROWSERBASE_PROJECT_ID=YOUR_PROJECT_ID \
  npx bb publish index.ts
```

The build runs on Browserbase and takes ~1 minute. On success it prints nine functions with their ids. You do **not** need to record the ids — the Mind resolves them at call time.

## Verify

```bash
curl -s https://api.browserbase.com/v1/functions \
  -H "X-BB-API-Key: bb_live_YOURKEY" \
  | python3 -c "import json,sys; [print(f['name']) for f in json.load(sys.stdin)['data']]"
```

You should see all nine names:
`navigate-and-screenshot, run-lighthouse, evaluate-script, query-dom, inspect-network, get-console-logs, check-page-health, fill-and-submit-form, redact-session-logs`.

## After deploy
Nothing else to configure. In the Mind, the DevTools capability tools call `BB_ListFunctions` to find these by name in your account and invoke them. If a capability tool ever returns "function not found," it means the deploy hasn't run on the key currently in use — re-run the publish above with that account's key.

## Re-deploy / update
Re-running `bb publish index.ts` overwrites the same nine functions in place (their ids are stable across republishes), so updates are safe and need no changes in the Mind. **Because this is BYOK, bug fixes only reach your account when you re-run the publish above** — a fix landing in this repo does not touch already-deployed accounts.

The current bundle is the **2026-08-18** build (see `Integrations/Browserbase/DEVTOOLS_FIXES_2026-08-17.md`). If you deployed before that, re-publish to get: `check-page-health` no longer hanging on heavy pages; screenshots/logs that fit the platform result cap instead of failing; and `BB_FillForm` selecting radios/checkboxes — including ARIA `role="radio"` widgets like Google Forms — not just text fields.

## Behavior notes (result size)
Browserbase caps a Function's result at **64 KB**; over that the call fails `RESULTS_TOO_LARGE`. So the suite fits within it:
- `BB_Screenshot` returns a **JPEG**, and on a rich/tall page it lowers quality and, if needed, downscales the render (fields `screenshotRenderWidth`, `screenshotTruncated` tell you when). For a pixel-exact full-resolution capture, screenshot a narrower region.
- `BB_CheckPageHealth` returns a **structured verdict** (`loaded`, `httpStatus`, `title`, console `errors`, `failedRequests`, `metrics`) and **no** screenshot by design — call `BB_Screenshot` for a visual.
- `BB_InspectNetwork` / `BB_GetConsoleLogs` / `BB_RedactSessionLogs` return **bounded** results on very chatty pages/sessions and report `*Total`/`*Dropped` (or `entriesTotal/Dropped`) so you know when a slice was truncated.

## Notes
- The functions run in `us-west-2` and consume browser-minutes from *your* Browserbase plan (one short session per capability call).
- The screenshot and evaluate capabilities have no hosted (function-free) equivalent, which is why the deploy is required to use them. Everything else in the suite is function-free.
- **`BB_RunLighthouse` is currently non-functional** in the Function sandbox (it exceeds the sandbox's resources and the invocation dies with `WORKLOAD_ERROR`). This is a platform limitation, not a deploy problem — re-publishing will not fix it. Use `BB_CheckPageHealth` for basic load-timing metrics until Browserbase raises Function memory.
