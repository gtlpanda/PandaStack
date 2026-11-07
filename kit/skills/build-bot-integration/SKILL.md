---
name: build-bot-integration
description: Add a new site integration to SuppleAIO - reconnaissance, monitors, ATC, checkout, and full wiring into the existing engine. Use when the user says "add site support", "build integration for", "add a new store", "build monitors for", "add checkout for", or names a specific retailer/store to integrate.
---

# Build Bot Integration

Add a new site integration to SuppleAIO — from reconnaissance through monitors, ATC, checkout, and full wiring into the existing engine.

Use when the user says "add site support", "build integration for", "add a new store", "build monitors for", "add checkout for", or names a specific retailer/store to integrate.

---

## Protocol

This is a 6-phase process. Each phase must complete before the next begins.

Before starting Phase 1, **always confirm the user's scope**. A "Costco integration" can mean account+monitor only, or monitor+ATC, or full checkout. The phases below assume full checkout; trim to fit. Account-only and monitor-only are valid stopping points and have been shipped this way before.

---

### Phase 1: Reconnaissance

Before writing ANY code, investigate the target site.

#### 1.1 Platform detection
- Shopify, WooCommerce, BigCommerce, custom, major retailer (Target/Walmart/Amazon)?
- Probes: `/products.json`, `/cart.json`, Shopify meta tags, WooCommerce REST (`/wp-json/wc/`), `__NEXT_DATA__`, page-source platform indicators

#### 1.2 Product data endpoints
- Product page URL format(s) — most sites have **multiple URL patterns for the same product** (canonical, legacy, ID-only). The `extract{Site}Id` function must handle all of them.
- Where stock/availability lives: SSR'd `__NEXT_DATA__`, JSON-LD, inline `window.*` globals, separate XHR endpoint, hydrated DOM
- Variant/size structure (parent ID vs child SKU is common — IBM WCS, Shopify variants, etc.)
- Price + availability fields

#### 1.3 Cart mechanism
- ATC endpoint (`/cart/add.js`, GraphQL mutation, REST API)
- Required headers, tokens, cookies (CSRF, session, anti-bot trust cookies)
- Variant ID format (URL ID vs internal SKU vs catEntryId)

#### 1.4 Checkout flow
- Guest vs account-only (Costco: account required, membership optional with surcharge; Walmart: account required; Amazon: account required)
- Payment gateway (Shopify Checkout, Stripe, PayPal, Cybersource, custom)
- Step count (single page vs multi-step)
- Required fields per step

#### 1.5 Anti-bot stack
- Rate limiting behavior + thresholds
- CAPTCHA: reCAPTCHA, hCaptcha, Cloudflare Turnstile, Arkose/FunCAPTCHA, AWS WAF, press-and-hold
- Queue system: Queue-it (Costco, Pokemon Center), Shopify queue, custom waitroom
- Bot detection vendor: PerimeterX/HUMAN, Akamai BMP, DataDome, Cloudflare, Kasada
- Device fingerprinting at payment: ThreatMetrix, Cybersource Decision Manager
- IP/JA3 fingerprint sensitivity

**Vendor identification tips:**
- Cookies: `_abck`/`bm_sz`/`bm_sv` (Akamai), `_px*` (PerimeterX), `datadome` (DataDome), `__cf_bm` (Cloudflare)
- CSP headers: whitelisted domains in `script-src`/`frame-src` reveal CAPTCHA vendor
- `Server-Timing: ak_p; desc=...` (Akamai routing fingerprint)
- `Server: AkamaiGHost` (Akamai WAF response)

#### 1.6 HAR analysis (when user provides one)

**HAR pitfall — response bodies are often dropped by browser DevTools.** If the HAR has `"compression": N` but no `"text": "..."` field on responses, the bodies were stripped at capture time. Tell the user to:
1. In DevTools → Network → settings (gear icon)
2. Enable **"Preserve log"**
3. Right-click columns → enable **"Response"**
4. Make sure **"Disable cache"** is OFF if studying caching behavior, ON if studying origin behavior
5. Re-capture

**What to extract from a HAR:**
- Unique URL list grouped by host (`grep -oE '"url": "https://[^"]+"' har | sort -u`)
- Status codes per URL (`"status":` count)
- Required request headers + cookies (especially custom ones like `client-identifier`, `costco-env`)
- Response Set-Cookie headers (anti-bot trust signals)
- CORS preflight (OPTIONS) responses — the `Access-Control-Allow-Headers` lists the custom headers you must send
- `__NEXT_DATA__` or other inline JSON blobs (often contain the canonical schema)

#### 1.7 Behavioral signal mapping (CRITICAL for monitor design)

Test the candidate monitor URL **from at least two IP profiles**:
- Datacenter IP (cloud, Anthropic, AWS) — represents the worst case for proxies
- Residential IP (your machine) — represents the best case

For each, capture:
- In-stock product → status, headers, cookies set
- Out-of-stock product → status, headers, cookies set

You're looking for **signal asymmetry**:

| Datacenter IP | Residential IP | Implication |
|---|---|---|
| OOS = 404, in-stock = 200 | Same | Symmetric, monitor signal trustworthy from any IP |
| OOS = 404, in-stock = 403 | OOS = 404, in-stock = 200 | **Asymmetric** — datacenter monitors only get reliable negative signal |
| Both 403 | Both 200 | Datacenter useless for monitoring; need residential |

Asymmetric sites (Akamai-protected like Costco, Target post-April-2026, PX-protected like Walmart) require treating non-404 as **"investigate further"** rather than **"in stock"** when running from cheap proxies.

#### 1.8 Edge cache lag

If the OOS response carries `Cache-Control: max-age=N` and `server-timing: cdn-cache; desc=HIT`, the response is **edge-cached** for N seconds. When the product flips from OOS→in-stock, the monitor may see stale 404 for up to N seconds.

Costco example: OOS 404 cached 15 minutes. Mitigations:
- Send `Cache-Control: no-cache` request header (often ignored by edge)
- Cache-busting query param (often ignored)
- Rotate IPs/proxies — different edge POP, different cache key
- Fall back to authoritative API on a slower schedule regardless of edge result

**Document the edge-cache TTL in recon.** It directly determines worst-case detection latency.

#### 1.9 Output: reconnaissance report
Structure as: confirmed / likely / unknown. With every claim cite the evidence (HAR line, curl output, public source). End with a **recommended approach**:
- HTTP-only (Shopify-class)
- Hybrid HTTP+browser (Target, Amazon)
- Browser-required (Walmart)
- Two-tier HTTP (cheap probe + authoritative API — Costco-class)

---

### Phase 2: Determine Scope

Based on recon, confirm with the user what to build. **Do not assume.**

| Tier | Scope | Components |
|------|-------|------------|
| **Account only** | Encrypted credential storage + IMAP linking, no monitor or checkout | Account model + view |
| **Monitor only** | Stock alerts, no purchasing | Monitor parser + dispatch wiring |
| **Monitor + ATC** | Stock detection + add to cart | Monitor parser + ATC module |
| **Full checkout** | End-to-end automated purchase | Monitor parser + ATC + checkout flow + session management |

Account-only and monitor-only are **legitimate stopping points**. Don't insist on building checkout if the user wants to ship an early-stage version.

When tiers are deferred, design with forward-compatibility: account schema should accommodate future checkout fields (membership info, warehouse number, billing zip), even if Phase 1 leaves them unused.

---

### Phase 3: Build Monitor Parser

**New file:** `src/main/engine/sites/{site}/monitor-parser.ts`

#### 3.1 Required exports

```typescript
// Required export — called by monitor-pool.ts via fetchCandidate()
export async function fetch{Site}Product(
  pid: string,
  options?: {
    proxy?: string
    fingerprint?: string
    cookies?: Record<string, string>
    // site-specific options as needed (e.g., whsNumber for Costco, locale for international)
  }
): Promise<{Site}Product | null>

// Required export — extract product ID from URL or input
export function extract{Site}Id(input: string): string | null
```

#### 3.2 Product type — universal vs site-specific shape

**Universal fields** (every site has these):
```typescript
interface {Site}Product {
  // Universal
  pid: string                   // canonical product ID (sites use different names: tcin, id, handle — pick one)
  title: string
  url?: string
  price: number | undefined     // undefined when unknown — DO NOT default to 0
  inStock: boolean              // some sites use boolean | null when truly unknown
  imageUrl?: string
}
```

**Common optional fields:**
```typescript
  availableQuantity?: number
  maxPurchaseQuantity?: number  // per-order limit
  variants?: Array<{ id: string; title: string; available: boolean; price?: number; sku?: string }>
```

**Site-specific naming convention.** Existing parsers use site-native ID names:
- Target: `tcin`
- Walmart: `id`
- Shopify: `handle`/`id` (and `variants[]`)
- Amazon: `asin` (commonly)

Pick whichever matches the canonical site terminology. Internally, `monitor-pool.ts` calls these via the dispatch in `fetchCandidate()` — the contract is the function signature, not a uniform field name.

#### 3.3 Two-tier monitor pattern (when applicable)

If the site has a **cheap public probe** (HEAD/GET on a URL that 404s when OOS) AND a **separate authoritative API** with richer data, fold both into the single `fetch{Site}Product()` function:

```typescript
async function fetchCostcoProduct(pid, options) {
  // Tier A: cheap probe — works from any IP, 15-min edge cache
  const probeStatus = await httpBridge.head(`https://www.costco.com/.product.${pid}.html`, options)
  if (probeStatus === 404) {
    return { pid, title: '', price: undefined, inStock: false, url }
  }

  // Tier B: authoritative API — only fired when probe says "maybe in stock"
  const summary = await fetchProductSummary(pid, options)
  return parseSummary(summary)
}
```

Benefits: 99% of polls are cheap (HEAD on edge-cached 404). The expensive API call only fires when the signal might have flipped. If the API is rate-limited, you've minimized your exposure.

**Catch:** non-404 from Tier A on a flagged datacenter IP is ambiguous (could be in-stock OR a 403 bot block). Run Tier B unconditionally on non-404 to disambiguate.

#### 3.4 Patterns to follow
- `src/main/engine/sites/target/monitor-parser.ts` — HTTP + `__NEXT_DATA__` parsing, browser fallback
- `src/main/engine/sites/shopify/monitor-parser.ts` — JSON API + `/products/handle.json`
- `src/main/engine/sites/walmart/monitor-parser.ts` — HTTP + session warming + browser-required mode
- `src/main/engine/sites/amazon/monitor-parser.ts` — AOD endpoint, multi-seller offer parsing

#### 3.5 Implementation rules
- Use `httpBridge.request()` for HTTP calls (CycleTLS, JA3 fingerprinting). For HEAD-style probes, use `httpBridge.head()` or `httpBridge.request({ method: 'HEAD' })`.
- Use `createLogger('{site}-monitor-parser')` for structured logging.
- Decode response body with `decodeBody()` (handles CycleTLS Buffer encoding) — find the existing helper in any site's monitor-parser.
- **Return `null` on parse failure, never throw.** The monitor pool treats null as "skip this poll" with backoff; throws cause the loop to error.
- Handle rate limiting passively — the monitor pool externally applies backoff. Don't sleep inside the parser.
- **Never log credentials, cookies, or PII** — the structured logger auto-masks but custom fields you add will not be auto-masked.

---

### Phase 4: Build ATC + Checkout (if applicable)

#### 4.1 ATC + checkout file
**Path:** `src/main/engine/sites/{site}/checkout.ts`

```typescript
export async function run{Site}Checkout(task: TaskConfig): Promise<{Site}CheckoutResult>

interface {Site}CheckoutResult {
  success: boolean
  state: TaskState
  error?: string
  product?: { title: string; price?: number; pid?: string }
  orderId?: string
}
```

#### 4.2 Browser checkout file (if needed)
**Path:** `src/main/engine/sites/{site}/browser-checkout.ts`

Required exports follow the persistent-context pattern in the codebase:
- Acquire context via `acquirePersistentContext` from `browser-manager.ts`
- Release via `releasePersistentContext` in `finally`
- Never call `browser.close()` directly — the shared pool handles refcounting
- Per-account checkout concurrency: enforce via `activeCheckoutAccounts` Set (see Walmart/Amazon)

#### 4.3 Patterns to follow
- `src/main/engine/sites/shopify/checkout.ts` — API ATC + browser checkout, Shop Pay bypass
- `src/main/engine/sites/walmart/checkout.ts` — full browser flow, drop-queue handling
- `src/main/engine/sites/target/checkout.ts` — hybrid: API ATC with imported `_abck` + browser checkout fallback
- `src/main/engine/sites/amazon/checkout.ts` — hybrid HTTP ATC (tls-client) + browser checkout (persistent profile bypasses ACIC)

#### 4.4 Implementation rules
- `throwIfCancelled(signal)` before every major step (HTTP call, browser nav, sleep).
- Use `sleepWithCancel(ms, signal)` not raw `setTimeout` or `humanDelay` — cancellable.
- Emit status via `bus.emit({ type: 'task-status', taskId, state, message })`.
- Resolve `getProfile(task.profileId)` early — fail fast if missing.
- **Price filter MUST be enforced both API-side AND browser-side.** The monitor's filter is not authoritative; cart price can change.
- Retry loops have explicit max attempts, session-timeout, cancellation checks.
- Resource cleanup in `finally` — context release, signal abort, cookie clearing.

---

### Phase 5: Wire Into Engine

**CRITICAL: There are 12+ registration points across types, routing, validation, IPC, DB, and UI. Missing ANY ONE causes runtime errors, silent data loss, or invisible features.**

**Always run wiring verification after this phase.** Use the `wiring-check` skill in this environment, or invoke the `wiring-check` agent via `Task`.

#### 5a. Type definitions (do FIRST — TypeScript catches missing references)

| File | Update |
|---|---|
| `src/main/engine/core/task-engine.ts` | Add to `TaskConfig.site` union type |
| `src/main/engine/monitors/types.ts` | Add to `MonitorSite` union (line 1) |
| `src/main/engine/monitors/types.ts` | Confirm `MonitorInputType` covers your input format (line 2: `'pid' \| 'url' \| 'keyword'`) |

#### 5b. Site registry constants

| File | Update | Notes |
|---|---|---|
| `src/main/index.ts` | Add to `VALID_SITES` array (~line 66) | Used by `monitor:test` and `monitor:start` validation (~lines 91-129) |
| `src/main/engine/monitors/monitor-pool.ts` | Add to `SUPPORTED_MONITOR_SITES` Set (~line 87) | Used by scheduler eligibility |

`dedup.ts` and `atc-cache.ts` are **site-aware-by-key** (the site string is part of the cache key) — no list update needed there.

#### 5c. Monitor pool dispatch
**`src/main/engine/monitors/monitor-pool.ts`** (`fetchCandidate()`, ~lines 1345-1490):
- Import `fetch{Site}Product` from your monitor parser
- Add a site-conditional branch in `fetchCandidate()`. The existing pattern uses `if (monitor.config.site === 'target') { ... }` etc.
- Walmart is the *default* (line 1456: `if (monitor.config.site !== 'walmart')`) — be careful not to fall through to it accidentally for new sites

#### 5d. Monitor model — input validation (FOUR validation points!)
**`src/main/engine/monitors/monitor-model.ts`:**
- `normalizeSite()` allowlist (~line 230-233) — add the new site value
- `resolveInputPid()` site routing (~lines 240-270) — add an extraction branch using `extract{Site}Id`
- Input-type allowlist (~lines 51-56) — currently keyword + URL inputs are gated to Shopify/Smoke&Mirrors only. Add your site here if you support keyword/URL inputs.
- Metadata resolution conditions — wherever site-specific defaults live

#### 5e. Site routing scattered through `src/main/index.ts`

**Find every dispatch point with `grep -nE "=== '(target|walmart|shopify|amazon)'" src/main/index.ts` and add your case.**

Known points (line numbers drift — verify before editing):

| Approx line | Function / handler | What |
|---|---|---|
| ~249 | Task checkout dispatch ternary | `taskConfig.site === 'X' ? runXCheckout : ...` |
| ~91-129 | `monitor:test`, `monitor:start` IPC | Validates site against `VALID_SITES` |
| ~1177 | Task image backfill (#1) | Site-specific product fetch for thumbnails |
| ~1557-1587 | Login-browser IPC handlers | **FOUR separate handlers** — one per site that supports headed login (target, walmart, shopify, amazon) |
| ~1755 | Monitor fetch dispatch | Site-specific HTTP setup |
| ~1768 | Session handling | Site-specific imported-session check |
| ~1786 | Walmart-specific guards | (only relevant if cloning the Walmart pattern) |
| ~2293-2296 | Dashboard stats aggregation | Per-site totals for charts/widgets |
| ~2979 | Image backfill dispatch (#2) | **Second image backfill location** — distinct from #1 |

**Two image backfill points exist** (line 1177 and line 2979). Both must be updated or thumbnails will be missing in one of the views.

#### 5f. Preflight
**`src/main/engine/core/task-preflight.ts`:**
- Add site-specific preflight checks (account validation, session validity, membership status)
- For Phase-1 monitor-only builds, often nothing required here

#### 5g. Account model — when adding accounts for the new site

**This is more nuanced than the original skill described.** Three places update:

1. **`src/main/engine/core/account-store.ts`:**
   - `AccountData` interface (~line 15-21) — generic encrypted JSON shape (`password`, `cookies`, `accessToken`, `refreshToken`, `sessionExport`). For site-specific encrypted fields (e.g., `membershipNumber`, `warehouseNumber`), extend `AccountData` with optional fields.
   - `Account` interface (~line 63-74) — non-encrypted top-level fields.
   - `saveAccount()` / `getAccount()` / `listAccounts(site?)` — generally don't need changes; the site is just a string discriminator.
   - Site-specific bootstrap hooks — Target has `bootstrapImportedTargetSession()` called at ~line 245-249 when `account.site === 'target'`. If your site needs comparable state (e.g., a per-site session table), add a similar hook here.
   - View projection — `listAccounts()` mapping (~line 423-439) adds Target-specific fields (`targetSessionStatus`, `targetSessionCartEligible`). If your site has a status worth surfacing in the UI, add the projection here.

2. **Site-specific session table (optional).** If the account requires more state than fits in the encrypted `data` blob (e.g., decrypted-but-non-PII session metadata, expiration, status), add a dedicated table via migration. Pattern: `target_account_sessions`. Don't do this if `data` JSON suffices.

3. **`src/main/engine/sites/{site}/session-manager.ts`** (new file) — for sites with browser login or session warming. Pattern: `walmart/session-manager.ts`. Required for sites with auto-login or warmer scheduler integration.

#### 5h. Database migrations

**Constraint to know:** Both the `monitors` table (~line 40-69 of `001_baseline.ts`) and the `accounts` table (~line 105-114) have **NO flexible JSON metadata column**. Every field is an explicit column. Implications for site-specific config:

| Site-specific config | Where it goes |
|---|---|
| Encrypted, account-scoped (passwords, tokens, membership ID) | `accounts.data` (encrypted JSON) — extend `AccountData` interface |
| Non-encrypted, account-scoped (auto-login flag, last-login) | New explicit column on `accounts` (via migration) |
| Per-monitor scalars (warehouse number, client identifier) | Either a new column (preferred for queryable fields) OR pack into the existing `inputs` JSON column |
| Per-site app-level constants (static API keys, default warehouses) | `settings` table or a constants module |

**Migration file:** `src/main/db/migrations/00X_{site}.ts`

Pattern (copy from `002_jigging.ts`):
- Idempotent guards before every `ALTER TABLE` / `CREATE TABLE` / `CREATE INDEX`
- Wrap in transaction (handled by `runner.ts` automatically)
- Register in `src/main/db/migrations/runner.ts` migrations array (~line 15-22)
- Increment the version integer

#### 5i. IPC channels (if new)
**`src/preload/index.ts`** + **`src/preload/index.d.ts`**:
- Add typed methods for any new IPC handlers
- Match the existing pattern (e.g., `account:create`, `monitor:save`)
- All new mutating IPC handlers must gate on `isUnlocked()` per CLAUDE.md security policy

#### 5j. Renderer — site dropdowns + filters

| File | Update |
|---|---|
| `src/renderer/src/views/MonitorsView.vue` | Site dropdown / form |
| `src/renderer/src/views/AccountsView.vue` | Site dropdown + per-site login button (currently `form.site` defaults to `'target'` ~line 45) |
| `src/renderer/src/views/TasksView.vue` | Site dropdown (Phase 2+ if checkout exists) |
| `src/renderer/src/views/HomeView.vue` | Site filter buttons (~line 33+) |

If a view derives its site list from a backend API, the addition may flow automatically — verify by running the app, don't assume.

#### 5k. Chat / LLM context
**`src/main/engine/core/chat-context-builder.ts`** (`buildSiteKnowledge()`, ~lines 178-243):
- Add a site-specific guidance block (HTTP vs browser, intervals, proxy needs, ATC/checkout caveats, account requirements)
- Mirror the structure of existing entries (Target, Walmart, Shopify, Amazon)
- The LLM uses this for `create_monitor` / `update_monitor` recommendations

#### 5l. Site icons / branding (optional)
- If the renderer uses site logos/icons, add the asset to `src/renderer/src/assets/` and wire it into the icon helper (search for an existing site's icon usage as the template)

---

### Named Store Pattern (Smoke & Mirrors, etc.)

When adding a named store that uses an existing engine (e.g., a Shopify store as its own dropdown option):
- Add the store name as a new site value (e.g., `'smokeandmirrors'`)
- Route it to the existing engine at every dispatch point using `||`:
  ```typescript
  if (site === 'shopify' || site === 'smokeandmirrors') { ... }
  ```
- The user sees their store name; the engine treats it as the underlying platform internally
- Avoids requiring users to know what platform a store runs on

---

### Phase 6: Verify

Run in parallel after Phase 5 wiring is complete:

1. **`wiring-check` skill / agent** — verifies all 12+ registration points: imports, IPC, site registrations, UI dropdowns, dispatch tables. Catches the "I forgot to add it to the second image backfill" class of bugs.
2. **`qa-engineer` agent** — audits data flow end-to-end: from monitor poll → engine → DB → UI. Looks for race conditions, missing error handling, undefined-vs-null bugs, off-by-one in dedup/cache keys.
3. **`security` skill** — checks for credential logging, PII exposure, missing `isUnlocked()` gates on mutating handlers, IPC validation gaps, injection vectors.

**Fix all P0/P1 findings before shipping.** Do not let "minor" findings accumulate — they're how integrations regress.

After fixes, **run the app and exercise the new integration manually**:
- Create an account (if applicable)
- Create a monitor
- Verify the monitor appears in MonitorsView and HomeView
- Start the monitor; confirm it polls the site
- Stop the monitor; confirm it stops cleanly
- Lock the app; confirm sensitive views hide

---

## Integration Checklist

Before marking an integration complete, verify:

**Recon + scope**
- [ ] Reconnaissance report committed to context (or as a doc) with confirmed/likely/unknown
- [ ] Datacenter-IP signal interpretation documented (symmetric vs asymmetric)
- [ ] Edge-cache TTL noted with mitigation strategy
- [ ] Tier scope confirmed with user (account-only / monitor-only / +ATC / full checkout)

**Monitor parser**
- [ ] Returns correct stock for in-stock AND OOS — tested with real product IDs
- [ ] Product ID extraction handles every URL format the site uses (canonical, legacy, ID-only)
- [ ] Returns `null` on parse failure — never throws
- [ ] Two-tier pattern (if applicable): probe + API both wired inside `fetch{Site}Product`
- [ ] No credentials, cookies, or PII in logs

**Checkout (if applicable)**
- [ ] ATC handles variant/size selection
- [ ] All required fields covered (shipping, payment, CVV)
- [ ] Price filter enforced API-side AND browser-side
- [ ] `throwIfCancelled` before every major async op
- [ ] `sleepWithCancel` instead of raw timers
- [ ] Persistent context acquired via `acquirePersistentContext`, released in `finally`
- [ ] Per-account concurrency enforced via `activeCheckoutAccounts` Set
- [ ] Error messages actionable, not generic

**Wiring (Phase 5)**
- [ ] Site added to `VALID_SITES` AND `SUPPORTED_MONITOR_SITES`
- [ ] `MonitorSite` union type updated; `TaskConfig.site` union updated
- [ ] `fetchCandidate()` has the new site branch
- [ ] All four `monitor-model.ts` validation points updated (normalizeSite, resolveInputPid, input-type allowlist, metadata)
- [ ] All `=== 'X'` dispatch points in `index.ts` updated (use `grep -n` to verify)
- [ ] **Both image backfill dispatch points** updated (lines ~1177 and ~2979)
- [ ] Account model: `AccountData` interface extended; site-specific bootstrap hook added if needed; view projection updated
- [ ] DB migration registered in `runner.ts` and version incremented
- [ ] IPC channels exposed in `preload/index.ts` + `.d.ts`, gated on `isUnlocked()` for mutations
- [ ] Site dropdowns in MonitorsView, AccountsView, TasksView, HomeView updated
- [ ] LLM site knowledge block added to `chat-context-builder.ts`

**Verification**
- [ ] `wiring-check` passes
- [ ] `qa-engineer` audit clean of P0/P1
- [ ] Security audit clean of P0/P1
- [ ] Manual exercise: create → start → stop → lock — all work

---

## Shopify Store Shortcut

If the target is a standard Shopify store, most of the work is already done:
- **Monitor parser:** `src/main/engine/sites/shopify/monitor-parser.ts` handles `/products/{handle}.json`
- **ATC:** `src/main/engine/sites/shopify/checkout.ts` handles `/cart/add.js`
- **Checkout:** `src/main/engine/sites/shopify/browser-checkout.ts` handles Shopify Checkout

For Shopify stores, Phase 1 becomes: verify the existing Shopify integration works against this specific store. Test with a real product URL. If it works, no new code needed — just configure monitors in the app.

If the store has customizations (password page, custom checkout, anti-bot), document what's different and build targeted overrides under `src/main/engine/sites/shopify/stores/{storeName}/`.
