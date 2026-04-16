# Browserbase DevTools Verification Guide

## Scope

This guide records the final verification state for the Browserbase DevTools integration in this worktree.

Validated artifacts:

- `1_registry_offering.json`
- `2_app_manifest.json`
- `3_tool_schemas.json`
- `4_skill_playbook.json`

Reference pattern used for comparison:

- `/Users/mohamed/Documents/Claude Code/minds-system/skills/integrations/superior-trade/`

Verification timestamp:

- `2026-04-16`

## Structural Result

The integration now follows the expected four-artifact layout.

Reference-pattern comparison:

- `1_registry_offering.json` matches the Superior Trade top-level shape: `offeringId`, `title`, `description`, `endpoints`, `lastUpdate`.
- `2_app_manifest.json` matches the Superior Trade top-level shape: `appName`, `description`, `domain`, `use_case`, `tier`, `auth_type`, `header_key`, `versions`.
- `4_skill_playbook.json` matches the Superior Trade top-level shape: `skillId`, `skillArtifactId`, `name`, `description`, `isListed`, `version`, `tools_used`, `compatibility_formula`, `progressive_unlock`, `constraints`, `steps`.
- `3_tool_schemas.json` preserves the same base schema pattern used by the reference (`toolSlug`, `toolPurpose`, `created_by`, `parameters`, `schemaArtifactId`) and extends it with Browserbase-specific execution metadata: `httpMethod`, `endpoint`, and `inputsSpec`.

Slug and artifact consistency:

- Manifest tool count: `24`
- Tool schema count: `24`
- Playbook tool count: `24`
- Prefix check: every slug uses `BB_`
- Artifact check: every schema entry uses `BBDT-ART-001` and the playbook uses `skillArtifactId: BBDT-ART-001`

Deprecated transport/runtime wording sweep:

- The four skill artifacts were checked for outdated transport/runtime phrasing and cleaned so the current set no longer contains those legacy references.

## Live Smoke Tests

### Tier 1

Intended checks:

- `BB_FetchPage`
- `BB_WebSearch`
- `BB_GetUsage`

Execution status:

- Reached Browserbase successfully, but all three calls returned `401 Unauthorized`.

Evidence captured from the local Browserbase Functions `.env`:

- `BROWSERBASE_API_KEY`: placeholder value detected, length `17`, prefix `your`
- `BROWSERBASE_PROJECT_ID`: placeholder value detected, length `20`, prefix `your_pro`

Observed responses:

- `POST /v1/fetch` -> `401`
- `POST /v1/search` -> `401`
- `GET /v1/projects/{projectId}/usage` -> `401`

Conclusion:

- The Tier 1 smoke tests are blocked by placeholder credentials in the only Browserbase config found locally. This is an environment gap, not a schema mismatch.

### Tier 2

Intended check:

- `BB_Screenshot` with a deployed Browserbase Function

Execution status:

- Blocked.

Reason:

- Tier 2 depends on valid Browserbase authentication first, and no usable Browserbase credentials or deployed Function mapping were available in this checkout.

Conclusion:

- The screenshot wrapper contract is structurally present and correctly modeled as a convenience wrapper around `BB_InvokeFunction`, but the live invocation path could not be verified without valid credentials plus a deployed screenshot Function ID.

## Verification Checklist

- [x] All 4 JSON files are present and parse successfully
- [x] Every slug in `versions[0].tools` matches `3_tool_schemas.json`
- [x] Every slug in `tools_used` matches `3_tool_schemas.json`
- [x] All 24 tool slugs use the `BB_` prefix consistently
- [x] `skillArtifactId` matches `schemaArtifactId` across the playbook and schemas (`BBDT-ART-001`)
- [x] Constraints cover auth, function IDs, async invocation, anti-hallucination, URL safety, write gates, Tier 1 direct tools, contexts, fetch-vs-session guidance, diagnostics, state handling, rate limits, and human-readable output
- [x] The artifact set matches the Superior Trade reference pattern at the file-layout and top-level-schema level
- [x] Browserbase Function wrappers are documented in the tool schemas and playbook
- [x] Legacy transport/runtime wording has been removed from the four skill artifacts
- [x] Tier 1 direct tools have full parameter schemas
- [x] Tier 2 Function-backed tools are documented as wrappers around `BB_InvokeFunction`
- [ ] Tier 1 live smoke tests pass
- [ ] Tier 2 screenshot smoke test passes with a deployed Function

## Gap Log

Open verification gaps:

- Live Browserbase credentials were not available locally. The only discovered `.env` used template placeholders, which caused consistent `401 Unauthorized` responses.
- No deployed screenshot Function mapping was available for a live `BB_Screenshot` invocation after the auth failure.

What remains to close the final two checklist items:

1. Replace the placeholder Browserbase API key and project ID with real values.
2. Provide or deploy the screenshot Function and record its Function ID in the runtime config.
3. Re-run the Tier 1 probes against `fetch`, `search`, and `usage`.
4. Invoke the screenshot Function and confirm the returned payload contains a base64 image plus page metadata.
