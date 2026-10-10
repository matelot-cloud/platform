# Step 14 — Public API, API keys, SDKs, GraphQL, outbound webhooks, automation endpoints ⏳

**Goal.** Let customers integrate the platform into their own systems.

## Scope
* API keys (organization/project scoped, permission-bound like memberships, rotated, audited) and
  service accounts.
* Versioned public REST API (`/api/v1` hardened: pagination, filtering, rate limits, OpenAPI
  published); GraphQL facade for the catalog/graph; automation endpoints for common flows.
* SDKs generated from OpenAPI: TypeScript and Python first; Go later.
* Outbound webhooks (finding created, gate evaluated, exception approved, incident opened…) with
  signatures, retries, delivery log.

## Acceptance criteria
- [ ] A scoped API key can read its project and nothing else; audit shows the key as actor.
- [ ] A customer webhook receives a signed event within 5 s of a finding; failed deliveries retry.
