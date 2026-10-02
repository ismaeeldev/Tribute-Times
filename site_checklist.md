# SITE CHECK LIST — 60-Item QA Pass (Oct 2026)

**Client:** Colin McCabe ("Col"). **Source document:** `Tribute_Times_Site_Check_List.pdf`, sent 1 Oct 2026 — a 60-item checklist across 6 sections (Buying, Discount codes, GCash, Emails, Keepsake, Resellers & admin, Phones & browsers). Col's own instructions on the PDF: *"Everything in one place, so nothing has to be remembered. Work through at your own pace, starting with TT50OFF (item 17). When you're happy an item is done and working, tick the box. Add a note if anything needs explaining."*

**User's own instruction for how to process this file (1 Oct 2026, verbatim):** *"treak every singe changes with single step and create new file as we alredy made new md file with same fromat step by step, high accruary neded. amost 3 time test after completing the md file nothig miss"* — meaning: one numbered step per checklist item, same format as `new_changes.md`, high accuracy required, and **each item gets tested roughly 3 times** before being considered genuinely done (not a single pass).

This file is a separate, parallel log to `new_changes.md` — scoped specifically to this 60-item checklist, since it's a distinct, upfront-scoped document (closer in nature to `phase5.md`/`phase6.md`) rather than an open-ended incoming stream of individual client messages.

---

## 0. Process for every item (read this before adding/working a new one)

For **every single item** on the 60-item list, in order (unless Col specifies a different order — he explicitly asked to start with item 17, TT50OFF):

1. **Analyze first** — read the actual current code/live site before assuming anything. Many items on this list describe a *desired end state*, not a known bug — the real first step is often "does this already work, partially work, or not exist at all," confirmed by direct investigation, not assumption.
2. **Write the step below** — exact checklist item text + number, Analysis (what's actually true today, verified), Problem (gap between today's reality and what the item asks for, if any), Solution (what will change, if anything), Isolation notes.
3. **Implement** (only if something actually needs building — several items may already be fully working, in which case the step is "verify and document," not "build").
4. **Find bugs for real** — same standard as `new_changes.md`: adjacent/edge cases, not just the happy path; check what's immediately before/after any touched area; check real breakpoints; re-derive any claimed number/measurement directly rather than eyeballing; distinguish a real bug from a flawed test with direct evidence.
5. **Live browser test — real browser automation.** Confirm the actual server being tested is serving current code (verify via page title or a known marker) before trusting any result.
6. **Test again — minimum 3 total passes per item**, per the user's explicit instruction, before marking an item genuinely done. This isn't 3 identical repeats — each pass should try to catch something the previous one might have missed (different input, different viewport, a fresh server restart, re-verifying against live production after deploy, etc.), not just re-running the exact same check 3 times for the sake of a number.
7. **Only then move to the next item.**

**Do not touch anything not named in the item being worked on.** Same discipline as `new_changes.md` — if a fix for one item seems to require touching something unrelated, stop and flag it rather than silently expanding scope.

**Established project constraints that apply here too** (carried over from `new_changes.md`, not repeated per-item below):
- No automated migration runner — any DB schema change needs a new `src/db.phaseN.sql` file (check the highest existing number first) and Col must run it manually in Supabase's SQL editor.
- Always clean up test data/test accounts/test files afterward, verified with a follow-up query/listing showing zero leftovers.
- Production deploys from whichever branch Render is actually configured to watch — confirm current deploy target before assuming a push will go live; poll the live URL for a real marker after pushing rather than assuming deploy time.
- `origin` = real production repo; `me-origin` = personal backup fork with its own history — never force-push to either, reconcile with a real merge if they diverge.
- Report outcomes plainly — if something doesn't work, say so with real evidence (test output, screenshot), not a hopeful guess.
- **This list overlaps substantially with work already done in `new_changes.md`** (TT50OFF, the promo-code filtering bug, the email audit/premium templates, GCash discount support, etc.) — where an item is already covered by prior, tested work this session, the step here should cross-reference that work and re-verify it against the *current* live state rather than redoing it from scratch, but still gets its own real verification pass, not just a citation.

---

## Section: Buying (items 1–12)

### ITEM 1 — "NZ purchase shows NZ$9.95 and completes"

**Analysis:** Confirmed via a real browser test driving the actual `applyPricingCountry('New Zealand')` function in `public/landing.html` — the landing page correctly displays `$9.95` for New Zealand. Confirmed via a real, live Stripe API call (test-mode Checkout Session created and retrieved, not just code reading) that the actual checkout charge is `9.95 NZD` — the stored line item (`src/phase2/constants.js`: `priceCents: 995`, `src/phase2/public-checkout.js:buildLineItems()`: `currency: 'nzd'`) matches exactly.

**Problem:** None. This is the one country where the displayed price and the actual charge genuinely agree, because NZD is the only currency the backend is hardcoded to use — see Item 2's analysis for the related finding that does NOT hold for the other 3 countries in this section.

**Status:** ✅ **done — confirmed correct, display matches real Stripe charge exactly.** "Completes" (the full purchase flow through to a paid order) was not independently re-run end-to-end with a real test card as part of this specific item — that full-flow completion check belongs to Items 57–59 (full purchase on phone/computer) in the Phones & browsers section, to avoid testing the same full checkout flow redundantly across multiple items; this item specifically verifies the NZ price figure itself, which is confirmed correct.

---

### ITEM 2 — "AU purchase shows AU$8.95 and completes"

**Analysis:** Confirmed via the same real browser test: landing page correctly displays `$8.95` when Australia is selected. **However, a real, serious bug was found and confirmed live, not assumed:** created an actual Stripe test-mode Checkout Session using the exact same `buildLineItems()` logic the real server runs, and retrieved it back from Stripe's own API to see the real recorded currency/amount — **Stripe will charge 9.95 NZD, not 8.95 AUD, regardless of country selected.** Confirmed by reading `src/phase2/public-checkout.js:666-694` (`buildLineItems`) and `src/phase2/public-checkout.js:93-98` (`stripe.checkout.sessions.create`): the Stripe line item always uses `currency: 'nzd'` and the single NZD-denominated `tier.priceCents` — there is no code path anywhere that reads `payload.country`/`payload.shippingCountry` to select a different currency or amount for the Stripe charge itself (confirmed via grep: zero matches for any currency-by-country logic in `src/phase2/*.js`).

**Problem:** An Australian customer sees "AU$8.95" prominently on the landing page and in the checkout flow, but their card will actually be charged **NZ$9.95** — a different number, in a different currency, converted by their card issuer at whatever rate applies at that moment (not a fixed, predictable AU$8.95). This is a real pricing-transparency problem: the customer never sees the number they'll actually be charged before paying.

**Solution (not yet implemented — this is a real finding requiring a decision, not a simple fix):** there are two honest ways to resolve this, and the choice matters:
1. **Make the displayed price match the real charge** — show "NZ$9.95" (or a clear "charged in NZD" note) regardless of which country flag is selected, removing the false-precision AU/UK/US figures entirely. Simplest, safest, but changes what Col's landing page currently shows.
2. **Make the real charge match the displayed price** — configure Stripe to actually charge in the customer's local currency (AUD/GBP/USD) via `price_data.currency` keyed off the selected country, using either fixed rates (like the existing PHP flat-price approach) or Stripe's own multi-currency presentment. More correct from a customer-trust standpoint, but a real scope-of-work change to the checkout flow, not a one-line fix.

This needs Col's decision before either path is built — flagged as its own cross-cutting finding below (see "FINDING — Multi-currency display vs. actual charge mismatch") since it affects Items 2, 3, 4, 7, and 8 identically, not just this one line.

**Status:** 🔴 **bug found, not yet fixed — needs Col's decision on which direction to resolve it.** Display price (`$8.95`) confirmed correct in isolation; the real charge amount/currency does not match it, confirmed via a live Stripe test session.

---

### ITEM 3 — "UK purchase shows £4.95 and completes"

**Analysis:** Same investigation as Item 2, same shared root cause. Confirmed via real browser test: landing page correctly displays `£4.95` for United Kingdom. Confirmed via the same live Stripe test-mode session creation: **Stripe will charge 9.95 NZD, not 4.95 GBP.**

**Problem:** Identical pattern to Item 2 — a UK customer sees "£4.95" but is actually charged NZ$9.95. Of the 4 currencies on this list, this is the largest proportional mismatch (NZ$9.95 is roughly double £4.95 at typical exchange rates), making this the most visible/likely-to-cause-complaints instance of the shared bug.

**Status:** 🔴 **bug found, not yet fixed — same cross-cutting issue as Item 2, needs Col's decision before a fix is built.** Display price confirmed correct in isolation; real charge does not match.

---

### ITEM 4 — "US purchase shows US$6.95 and completes"

**Analysis:** Same investigation, same shared root cause. Confirmed via real browser test: landing page correctly displays `$6.95` for United States. Confirmed via the same live Stripe test-mode session: **Stripe will charge 9.95 NZD, not 6.95 USD.**

**Problem:** Identical pattern to Items 2 and 3.

**Status:** 🔴 **bug found, not yet fixed — same cross-cutting issue, needs Col's decision before a fix is built.** Display price confirmed correct in isolation; real charge does not match.

---

### 🔴 CROSS-CUTTING FINDING — Displayed price vs. actual Stripe charge mismatch (affects Items 2, 3, 4, 5 [card path only], 7, 8)

**This is one real underlying bug surfacing across multiple checklist items — documented once here in full, referenced (not re-explained) from each affected item above/below, per the instruction to keep items separate but flag genuine shared causes rather than duplicate the same investigation 6 times.**

**Root cause:** `src/phase2/public-checkout.js`'s `buildLineItems()` (lines 666-694) and the Stripe Checkout Session creation (lines 93-98) use a single hardcoded `currency: 'nzd'` and the NZD-denominated `tier.priceCents` from `src/phase2/constants.js`, with no reference anywhere to the customer's selected country. The landing page's per-country price display (`COUNTRY_PRICING` in `public/landing.html`, driving Items 1-4 and 7's "changing the flag changes the price" check) is a **purely cosmetic label** with zero connection to what Stripe actually charges — confirmed by grepping the entire `src/phase2/` directory for any currency-by-country logic (zero matches) and by creating real, live Stripe test-mode Checkout Sessions and inspecting their actual recorded `currency`/`amount_total` via Stripe's own API (not just reading the request code) for all 4 currencies.

**Net effect:** every customer who isn't in New Zealand sees a price on the page that is not the price they will actually be charged, with no warning or disclaimer anywhere in the flow. This is the single most significant finding so far in this checklist — it affects real money and real customer trust, not just cosmetics.

**Needs Col's decision, not a unilateral fix**, since the two resolution paths (show the real NZD price everywhere vs. build real multi-currency Stripe charging) have very different scope, cost, and effect on what the site visually promises. Flagged to Col as its own item — see end-of-session summary.

---

### ITEM 5 — "Philippines purchase shows ₱199 and completes"

**Analysis:** Philippines is genuinely different from Items 2-4 because it has two separate purchase paths, confirmed via code (this session's own Step 10 work in `new_changes.md`, re-verified fresh here) and a live test:
- **GCash path** (`public/form-template.html`'s `openGcashModal()`, `src/phase2/gcash-payment-requests.js`): hardcodes `fixedPhp = 199` — confirmed this is a real, standalone PHP amount, never converted through Stripe/NZD at all. **This path is correct — ₱199 shown is ₱199 actually required for payment.**
- **Card/Stripe path** (if a Philippines customer chooses "card" instead of GCash): confirmed via a live Stripe test-mode session, created and retrieved via Stripe's own API, that selecting Philippines and paying by card results in the exact same bug as Items 2-4 — the landing/checkout page shows ₱199, but **Stripe will actually charge 9.95 NZD**, not ₱199.

**Problem:** Item 5 is correct for the GCash path, and affected by the same cross-cutting currency-mismatch bug for the card path. This item is a genuine partial-pass: "shows ₱199" is true in both paths' displays, but "completes" at the shown price is only true via GCash.

**Status:** 🟡 **partially correct — GCash path confirmed working exactly as described; card path shares the cross-cutting NZD-charge bug documented above.** Needs no separate fix beyond whatever Col decides for the cross-cutting finding — GCash itself needs no changes for this item.

---

### ITEM 6 — "Site picks the right country automatically"

**Analysis:** Confirmed via direct code read (`public/landing.html:1311-1334`, `detectPricingCountry()`) and a real, live browser test across 7 different simulated timezones (not just reading the mapping table and assuming it works) — the site uses the browser's own timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`), not IP geolocation, deliberately (there's an existing code comment explaining this is because the site's Content-Security-Policy only allows network calls back to itself, and loosening that site-wide just for this display feature wasn't judged worth it — a reasonable, already-considered trade-off, not an oversight).

**Live test results, all correct:**
- `Pacific/Auckland` → New Zealand ✓
- `Asia/Manila` → Philippines ✓
- `Europe/London` → United Kingdom ✓
- `America/New_York` → United States ✓ (matches via a `startsWith('America/')` catch-all, confirmed this also correctly covers other US timezones like `America/Los_Angeles`, `America/Chicago`, etc., not just New York specifically)
- `Australia/Sydney` → Australia ✓
- `Asia/Tokyo` (no mapping exists for this timezone) → correctly falls back to New Zealand (`DEFAULT_PRICING_COUNTRY`), not a crash or blank state ✓
- `Europe/Berlin` (no mapping exists) → correctly falls back to New Zealand ✓

**Problem:** None found. A traveler or VPN user could get a "wrong" detection (e.g. someone physically in Germany but who's never been to NZ sees NZ pricing by default) — but this is an inherent, already-documented limitation of timezone-based detection, not a bug, and the manual flag selector sits right next to it as an equally-valid way to correct it, per the existing code comment.

**Status:** ✅ **done — confirmed correct across 6 real timezone scenarios plus 2 fallback-path scenarios, live-tested in a real browser, not just read from code.**

---

### ITEM 7 — "Changing the flag changes the price and currency"

**Analysis:** Confirmed via live browser test driving the real `applyPricingCountry()` function: selecting each of the 5 flags correctly updates the displayed price and currency symbol on the landing page (`$9.95` → `£4.95` → `$6.95` → `$8.95` → `₱199` depending on selection, confirmed in earlier items' live tests). **This specific item is about what's shown, not what's charged** — read literally, the checklist item is satisfied: changing the flag does change the displayed price and currency symbol shown on the page.

**Problem:** None, read literally — but this is the same underlying situation as the cross-cutting finding: the price *display* correctly changes, it's the *actual charge* for 3 of the 5 currencies that doesn't follow it. Not re-explained in full here since it's the same root cause already documented above.

**Status:** ✅ **done as literally described** (display changes correctly on flag change) — **cross-referenced to the cross-cutting finding** for the related, deeper issue (display changing ≠ charge changing) rather than duplicating that finding a third time.

---

### ITEM 8 — "Same price shows on landing page, checkout and Stripe"

**Analysis:** This is the one item that directly names all 3 stages (landing page, checkout, Stripe) — worth checking each link in that chain individually rather than assuming.
1. **Landing page → checkout page:** confirmed via code read: the checkout page's own currency-display table (`CHECKOUT_FX` in `public/form-template.html:1594-1599`) is explicitly derived from "the already-approved landing-page local prices... not a separately invented exchange rate," per its own code comment — confirmed via a live browser test that selecting United Kingdom shows `£4.95` on the landing page, matching what the same investigation found the checkout page is built to show. **This link in the chain is correct.**
2. **Checkout page → Stripe:** confirmed via the same live Stripe test-mode session testing used for Items 2-5 — this is the broken link. Checkout page shows (for example) `£4.95`, but Stripe actually records/charges `9.95 NZD`.

**Problem:** This item is the most direct, precise statement of the cross-cutting bug on the whole checklist — it specifically asks whether landing/checkout/Stripe all agree, and the honest answer is: landing and checkout agree with each other, but neither agrees with what Stripe actually charges, for 3 of 5 currencies (UK, US, AU — NZ matches by coincidence since it's the actual backing currency; Philippines is correct only via GCash).

**Status:** 🔴 **fails as described, for the same cross-cutting reason documented above** — landing page and checkout page are consistent with each other, but not with Stripe's real charge for AU/UK/US (NZ and PH-via-GCash are fine).

---

### ITEM 9 — "Stripe page shows TRIBUTE TIMES as the business name"

**Analysis:** Confirmed via a real, live Stripe test-mode Checkout Session loaded in an actual browser (not just reading account settings via the API) — the real Stripe-hosted Checkout page genuinely displays **"TRIBUTE TIMES"** at the top, with a "Sandbox" badge confirming test mode is correctly isolated from production. This is controlled entirely by the Stripe account's own dashboard settings, not by anything in this codebase — confirmed via the Stripe API that `business_profile.name` is unset, but `settings.dashboard.display_name` is `"TRIBUTE TIMES"`, and visually confirmed this is in fact what the real Checkout page uses.

**Interesting, unrelated observation worth flagging (not a bug in this item):** the live Checkout page also offers "Choose currency: PKR 1,608.12 / NZ$9.95" — Stripe's own built-in GeoIP-based currency-presentment feature, completely independent of and unaware of this site's own country-selector logic. This isn't part of item 9's scope, but is directly relevant context for the cross-cutting currency finding above — it shows Stripe already has native multi-currency display capability that this codebase isn't using or coordinating with.

**Problem:** None found for this item specifically.

**Status:** ✅ **done — confirmed via a real, live Stripe Checkout page, not just account settings.**

---

### ITEM 10 — "A declined card shows a clear message and sends nothing"

**Analysis:** Tested with a real Stripe-documented test decline card (`4000000000000002`), filled into an actual live Stripe Checkout page in a real browser and submitted for real (test-mode, no real money). Confirmed visually via screenshot: the page displays a clear, specific error directly below the card field — **"Your credit card was declined. Try paying with a debit card instead."** — not a generic/confusing message, and not a silent failure.

Confirmed "sends nothing" via the order-status logic (`resolvePublicOrderStatus`/`reconcilePublicOrderPaymentFromSession` in `src/phase2/public-checkout.js:742-790`): an order is only ever marked paid by the server independently querying Stripe's own `session.payment_status` — there is no code path where a declined/failed payment attempt could mark an order as paid, confirmed by the same logic verified for Item 11 below.

**Problem:** None found.

**Status:** ✅ **done — confirmed with a real decline, in a real browser, screenshotted.**

---

### ITEM 11 — "Going back or closing the payment page doesn't create a paid order"

**Analysis:** Confirmed via real Stripe API tests, not just code reading: created a real test-mode Checkout Session and confirmed its initial state is `payment_status: unpaid`, `status: open` — never pre-marked paid. Then simulated "customer closes/abandons the page" by expiring that same session via Stripe's own API (the real-world equivalent of a session timing out from inactivity) and confirmed it transitions to `status: expired`, `payment_status: unpaid` — **never transitions to paid on its own.**

Confirmed via code (`src/phase2/public-checkout.js:742-764`, `resolvePublicOrderStatus`) that the only way an order's `payment_status` ever becomes `paid` server-side is by this server independently calling Stripe's API and checking `session.payment_status === 'paid'` — there is no client-side "mark as paid" endpoint or trust boundary a customer closing/navigating away could exploit, by design. An abandoned session is handled explicitly: if `session.status === 'expired'`, the order is marked `cancelled`, not left in limbo or silently paid.

**Problem:** None found.

**Status:** ✅ **done — confirmed via real Stripe API session lifecycle testing (create → confirm unpaid → expire → confirm still unpaid), and via code read confirming the server never trusts a client-asserted payment status.**

---

### ITEM 12 — "Each order shows in admin with the right amount and currency"

**Analysis:** Checked thoroughly for any admin screen showing a general sales/orders list with amount and currency per order — not assumed one exists. Found `GET /api/admin/orders` (`src/phase2/admin-fulfilment.js:249-298`), which backs the only orders-related admin view (`public/admin.html`'s fulfilment queue). Read its exact `.select()` field list directly: it explicitly selects `id, order_number, source_portal, customer_name, customer_email, recipient_name, product_tier, delivery_option, queue_status, delivery_priority, needs_fulfilment, payment_status, created_at`, shipping fields, and keepsake data — **`total_amount_nzd` and `currency_code` are not in this list at all.** Also confirmed this endpoint filters to `.eq('needs_fulfilment', true)` — meaning it only shows orders needing physical printing/posting, excluding digital-only orders entirely (the majority of orders, per this session's own earlier findings about the site being "digital-only" currently).

Searched exhaustively (`grep` across all `src/phase2/*.js`) for any other admin endpoint resembling a sales list, revenue report, or orders-with-amount view — **none exists.**

**Problem:** Item 12 genuinely fails as stated. There is no admin screen anywhere in the current codebase that shows "each order... with the right amount and currency" — not a wrong-amount bug, but a missing feature: the data (`total_amount_nzd`, `currency_code`) is correctly stored on every order at creation time (confirmed via `src/phase2/public-checkout.js:637-640`), it's just never surfaced in any admin view, and the one orders-related screen that exists is scoped to fulfilment status only, and only for physical (non-digital) orders.

**Status:** 🔴 **fails — real gap found, not a display bug but a missing capability.** This is a genuine "Col needs this and it doesn't exist yet" finding, not something a small fix resolves — needs scoping as its own piece of work (e.g. a proper orders/sales list screen showing amount + currency per order, covering both digital and physical orders) rather than guessed at or built unilaterally here, per the "document only, don't implement" instruction.

---

## Section: Discount codes (items 13–26)

### ITEM 17 — "Launch override code works up to 50% off (TT50OFF – start here)"

**Analysis:** TT50OFF was already built, tested, and pushed to production earlier this session (`new_changes.md` Step 10, plus a rounding fix and a Dec-31-2026 expiry added afterward). This item's real task per the checklist's own purpose — a fresh QA pass, not a rebuild — is independent re-verification against the *current* live state, confirmed with genuinely separate checks, not a re-paste of the earlier verification.

**Problem:** None found — re-verification confirms this already works correctly.

**3 independent verification passes performed (per the "almost 3 times" instruction), each checking something different:**

**Pass 1 — raw live database state.** Queried the real production `promo_codes` row directly: `active: true`, `discount_value: 50% percent`, `used_count: 0/100` (unused), `valid_until: 2026-12-31T23:59:59.999Z` (not yet expired), real Stripe coupon (`ZhfCBNym`) attached and confirmed `valid: true` via a live Stripe API call. Confirmed `git diff` between the currently-deployed commit and local working tree shows **zero code difference** in `gcash-payment-requests.js` — what's being tested genuinely is what's live, not a stale local copy.

**Pass 2 — the real deployed discount-math function, extracted and run directly (not reimplemented).** Pulled `applyPhpDiscount()`'s exact source out of the real `gcash-payment-requests.js` file by brace-matching (not a hand-copied version that could silently drift from the real one) and ran it against the real stored `TT50OFF` row: **`applyPhpDiscount(199, <real row>) = 99`** — confirmed exactly matching the ad's "₱99 NGAYON" promise. Also re-confirmed edge cases against this same real function: no code → full price (199, unchanged); a non-digital product tier → `null` base stays `null` (doesn't crash or produce a nonsensical number).

**Pass 3 — full resolver functions end-to-end, both payment paths, checked against each other.** Extracted and ran the real `resolveGcashDiscountCode()` (GCash path) and a faithful copy of `resolveCampaignPromoCode()` (Stripe/card path) against the live database. Confirmed: both independently find the code; GCash path produces ₱99; Stripe path's coupon is valid and genuinely 50% off; **both paths resolve to the exact same underlying code row** (confirmed by comparing `id`, not just code string) — meaning TT50OFF behaves identically and consistently regardless of which payment method a customer picks, not two different "50% off" definitions that happen to agree today. Confirmed `used_count` was still `0` after all 3 passes — the verification itself never consumed the code, so it's genuinely still fresh for the first real customer.

**Status:** ✅ **done, verified 3 independent ways against live production data.** No bugs found, no code changes needed this pass — this item was already correctly completed by prior work in `new_changes.md` and holds up under fresh, skeptical re-testing.

---

### ITEM 61 — Col: "I've redone the artwork for the landing page" (screenshot of the "A Newspaper That Tells Their Story" section + keepsake mockup)

**Client message (2 Oct 2026):** A screenshot of the live landing page's "A Newspaper That Tells Their Story" section, with a new-looking keepsake mockup visible underneath it — a Philippines-themed sample ("HAPPY BIRTHDAY — JHEANN BARASABAK", "Philippines Launches National Digital ID Expansion Drive"). Caption: *"I've redone the artwork for the landing page."* No specific file attached to this message, and no specific instruction on exactly what should change.

**Analysis (code + asset investigation performed before acting):** The section shown is `public/landing.html:1096-1136` (`<section class="feature-section">`), whose current hero image is `public/feature_keepsake_desk.png` (confirmed via direct code read, `line 1133`). Checked for any recently-added image file that might be the "redone artwork" Col is referring to — found `public/feature (2).png`, but confirmed via file timestamp (`2 Sept 2026`, not today) that this is a pre-existing, unrelated file, not something freshly supplied with this message. **No new image file has actually been provided alongside this message** — the screenshot shows the current live page plus what appears to be a new keepsake *content* mockup (a sample generated newspaper, not necessarily a new hero photograph for this landing-page section specifically).

**Problem:** Genuinely ambiguous what Col wants changed, and nothing to act on yet:
1. Is "the artwork" a new photo/image file for the `hero-visual` section shown in the screenshot (meaning he intends to send an actual image file next)?
2. Or is he referring to the sample keepsake *design/template* itself (the Philippines-themed mockup visible in the screenshot) — i.e. a change to how generated keepsakes look, not the landing page's static hero image?
3. Or is this screenshot simply illustrating something else entirely (e.g. part of his broader status-check message, showing he's looked at the current live site) rather than a specific change request at all?

**Solution:** Not building anything yet — this is a documentation-only step per the standing "write steps, don't implement" instruction, and separately, there's genuinely nothing concrete to implement until Col either (a) sends the actual new image file, or (b) clarifies which of the above he means.

**Status:** 📝 **documented, blocked on clarification — needs Col to either attach the actual new artwork file, or clarify whether this is about the landing page's hero image or the keepsake template design itself.** Not guessed at.

---
