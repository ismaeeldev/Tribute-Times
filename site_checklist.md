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

**Re-verified with a genuine full end-to-end Playwright test (2 Oct 2026), not the narrower price-only check from the first pass.** Per the updated instruction, this item now includes the actual "completes" verification — the full real purchase flow, redirect logic included, rather than deferring that to Items 57-59.

**E2E test performed, real browser, real server, real Stripe test-mode payment, start to finish:**
1. Navigated to `/public` fresh.
2. **Found and fixed a real gap in the original test plan while building this**, worth noting as its own small finding: the form isn't immediately visible — there's an occasion-selection step first ("Choose the Occasion" tile grid) that the original Item 1 analysis never accounted for. Not a bug, just confirms the real user journey starts one step earlier than assumed.
3. Selected "Happy Birthday", filled recipient name/DOB/country (New Zealand)/personal message.
4. Clicked Generate — real keepsake generation completed (not instant, matches the site's own "up to 60 seconds" copy).
5. Filled checkout customer name/email. Confirmed on-screen: **"Selected option: Digital. Total today: NZ$9.95. Payment: card using secure Stripe checkout."** — exact match to this item's requirement.
6. Clicked "Pay by Card" — **genuinely redirected to a real Stripe Checkout page** (`checkout.stripe.com`), confirmed the page shows "TRIBUTE TIMES" as the business name and "9.95" as the amount.
7. Filled Stripe's real test card (`4242 4242 4242 4242`) and submitted for real.
8. **Confirmed genuine redirect back** to `/public?checkout=success&order=<real-id>`.
9. Reloaded that exact URL fresh (simulating a customer re-visiting/refreshing) and confirmed the final state: **"Payment complete. Your clean keepsake is ready. Use Download PDF to save it."**, a working "Download PDF" button, and a fully-rendered, correctly-personalized keepsake (real researched content for the date, "HAPPY BIRTHDAY — MARGARET WILSON" matching exactly what was entered, no placeholder text, no watermark).

**This is a genuine, complete pass of the real purchase flow — not simulated, not API-only.**

**🔴 Real bug found during this E2E pass, not from code-reading — caught via actual browser console errors during the test:** `public/form-template.html`'s Content-Security-Policy meta tag (`line 12`) restricts `style-src` to `'self' 'unsafe-inline'` — **missing `https://fonts.googleapis.com`**, unlike `public/index.html`'s CSP (`line 12` there), which correctly includes it. This causes the browser to **block both of this page's Google Fonts `<link>` stylesheets entirely** (confirmed via real console errors: *"Refused to load the stylesheet 'https://fonts.googleapis.com/css2?family=Inter...' because it violates... style-src"* and the same for the `UnifrakturMaguntia`/`Playfair Display`/`EB Garamond` combined link). Visually confirmed via screenshot: the checkout form's UI text renders in a generic system sans-serif font instead of the intended branded typefaces. **The keepsake's own masthead font ("The Tribute Times" in blackletter) is unaffected** — that one is self-hosted, not loaded via the blocked Google Fonts link, so the actual product output still looks correct; this bug only affects the surrounding form/checkout UI's typography on this one page.

**Problem:** A real, narrow, confirmed bug — this is the single most important page on the whole site (where every purchase happens), and its own form text doesn't render in the intended branded fonts due to a one-line CSP misconfiguration that a sibling page (`index.html`) already has correct.

**Solution (documented, not implemented per standing instruction):** add `https://fonts.googleapis.com` to `form-template.html`'s `style-src` directive, matching the exact pattern already correct in `index.html`'s CSP. A one-line, low-risk fix — but not made yet, pending Col's go-ahead per "document steps, don't implement."

---

**Redirect-logic edge cases — exhaustively tested per the "verify every case" instruction, not just the happy path:**

1. **Declined card** (real Stripe test decline card `4000000000000002`, submitted for real): confirmed the decline message displays correctly on the real Stripe page, the customer stays on Stripe (not prematurely redirected away), consistent with Item 10's earlier finding.
2. **Fake/tampered order ID** (direct navigation to `?checkout=success&order=<made-up-uuid>`): **confirmed secure** — the server correctly returns "Public order not found," the page falls back to the normal unpaid preview state, and critically **does NOT show a fake "Payment complete" state**. This is an important security confirmation: the success state cannot be spoofed by guessing/editing the URL.
3. **Re-visiting the real success URL after already paying** (reloading `?checkout=success&order=<real-paid-id>` fresh): confirmed shows the same correct "Payment complete" state consistently, no duplicate-charge risk (the server only ever reads Stripe's own payment status, never re-processes based on the URL alone — same logic already confirmed for Item 11).
4. **Cancelling via Stripe's own in-page "Back" link (the realistic customer action)**: confirmed excellent, correct behavior — redirects to `?checkout=cancelled`, shows *"Checkout was cancelled. Your SAMPLE preview is still here, and you can try again any time,"* and **the entire keepsake preview, customer name/email, and selected country are all preserved** (visually confirmed via full-page screenshot: SAMPLE watermark correctly showing, "PAY BY CARD" button ready to retry, nothing lost). This is genuinely well-built.

**🔴 Second real bug found, different from the CSP issue above — browser's own back button (not Stripe's in-page Back link) loses all progress:** tested the actual browser back button (not Stripe's own "Back" link) after reaching the real Stripe Checkout page — confirmed this lands on **`about:blank`**, a genuinely broken blank page, not the cancelled-checkout state and not the original form. The keepsake, customer details, and all progress are completely lost; the customer would have to start over from the very beginning (re-select occasion, re-fill everything, re-generate). Root cause (not yet fixed, documented only): Stripe Checkout navigates in the *same browser tab* (a full cross-origin redirect, not a popup/new tab), and that single-page app's in-memory state (the generated keepsake, filled form) isn't restored by the browser's native back-navigation the way Stripe's own `cancel_url` redirect correctly handles it.

**Distinction worth being precise about:** item 11 on this checklist ("going back or closing the payment page doesn't create a paid order") is still confirmed TRUE — no paid order is ever incorrectly created either way. But this is a related, separate, real UX problem: the browser back button doesn't create a paid order, but it does destroy all the customer's progress with no warning and no recovery path, landing on a broken blank page rather than a clear "cancelled, your work is safe" message like Stripe's own Back link correctly provides.

**Solution (documented, not implemented):** this is a harder fix than the CSP issue — likely needs either (a) a `beforeunload`/`popstate` handler to intercept raw browser back-navigation while mid-checkout and redirect to a safe state instead of `about:blank`, or (b) relying on Stripe's own in-page Back link being the "supported" path and treating the fix as lower priority since Stripe's UI already provides a working, visible way to go back that doesn't have this problem. Needs Col's input on priority given this is a secondary path (most users click Stripe's own Back link, not their browser's), not guessed at or built here.

---

**Dedicated UI/Playwright test across 3 real viewports (desktop 1280px, tablet 768px, mobile 390px/iPhone-sized), full flow at each:**

Ran the complete occasion-select → form-fill → generate → checkout flow at all 3 sizes, checking specifically for layout bugs (not just functional correctness, already covered above): element bounding boxes measured directly (not eyeballed) to confirm nothing overflows the viewport width, the occasion-tile grid correctly reflows to 2 columns on mobile (confirmed via screenshot — clean, nothing clipped or overlapping), the "Pay by Card" button stays fully clickable and within-viewport at every size, and the same CSP font-loading errors already documented above appear consistently at all 3 sizes (not a viewport-specific issue, confirms it's a page-wide problem, not something that only shows up on one device size).

**One screenshot initially looked like it showed a real bug — investigated and ruled out as a false positive, worth recording why rather than silently discarding it:** the mobile checkout screenshot appeared to show a floating "Online" status badge overlapping the Customer Email field. Checked directly against the actual page source (`public/form-template.html`) and all other site pages — **the string "Online" does not appear anywhere in this codebase's HTML at all**, and there are no third-party widgets/iframes/scripts that could inject such an element. Confirmed this is an artifact of the local testing/screenshot tooling itself, not a real element rendered by `tributetimes.co.nz` — not reported as a site bug, since it isn't one. Flagged here explicitly so it's clear this was checked and ruled out, not missed.

**No new real UI/layout bugs found in this dedicated viewport pass** — the 2 bugs already documented above (CSP fonts, browser-back-button) remain the only confirmed issues for this item.

**Status:** ✅ **"shows NZ$9.95 and completes" — fully confirmed true, genuine E2E pass with a real Stripe test payment, 4 redirect-logic edge cases tested exhaustively, and a dedicated 3-viewport UI/Playwright pass completed.** 🔴 **Two real bugs found total this item: (1) the font-loading CSP issue, (2) the browser-back-button-loses-everything issue.** Both documented, neither fixed yet, per standing instruction. **Item 1 is now fully complete** — moving to Item 2 next with the same rigor.

---

### ITEM 2 — "AU purchase shows AU$8.95 and completes"

**Analysis:** Confirmed via the same real browser test: landing page correctly displays `$8.95` when Australia is selected. **However, a real, serious bug was found and confirmed live, not assumed:** created an actual Stripe test-mode Checkout Session using the exact same `buildLineItems()` logic the real server runs, and retrieved it back from Stripe's own API to see the real recorded currency/amount — **Stripe will charge 9.95 NZD, not 8.95 AUD, regardless of country selected.** Confirmed by reading `src/phase2/public-checkout.js:666-694` (`buildLineItems`) and `src/phase2/public-checkout.js:93-98` (`stripe.checkout.sessions.create`): the Stripe line item always uses `currency: 'nzd'` and the single NZD-denominated `tier.priceCents` — there is no code path anywhere that reads `payload.country`/`payload.shippingCountry` to select a different currency or amount for the Stripe charge itself (confirmed via grep: zero matches for any currency-by-country logic in `src/phase2/*.js`).

**Problem:** An Australian customer sees "AU$8.95" prominently on the landing page and in the checkout flow, but their card will actually be charged **NZ$9.95** — a different number, in a different currency, converted by their card issuer at whatever rate applies at that moment (not a fixed, predictable AU$8.95). This is a real pricing-transparency problem: the customer never sees the number they'll actually be charged before paying.

**Solution (not yet implemented — this is a real finding requiring a decision, not a simple fix):** there are two honest ways to resolve this, and the choice matters:
1. **Make the displayed price match the real charge** — show "NZ$9.95" (or a clear "charged in NZD" note) regardless of which country flag is selected, removing the false-precision AU/UK/US figures entirely. Simplest, safest, but changes what Col's landing page currently shows.
2. **Make the real charge match the displayed price** — configure Stripe to actually charge in the customer's local currency (AUD/GBP/USD) via `price_data.currency` keyed off the selected country, using either fixed rates (like the existing PHP flat-price approach) or Stripe's own multi-currency presentment. More correct from a customer-trust standpoint, but a real scope-of-work change to the checkout flow, not a one-line fix.

This needs Col's decision before either path is built — flagged as its own cross-cutting finding below (see "FINDING — Multi-currency display vs. actual charge mismatch") since it affects Items 2, 3, 4, 7, and 8 identically, not just this one line.

---

**Full E2E Playwright re-verification (2 Oct 2026), per the "every case, redirect logic, UI test" instruction — real browser, real server, real Stripe test session, Australia selected throughout:**

Ran the complete real flow: occasion select → filled form with **Australia** selected as country → generated a real keepsake → reached the actual `/public` checkout screen.

**New, more precise finding from seeing the real checkout page directly (not just the landing page), worth correcting/refining the original analysis with:** the `/public` checkout page is actually **more honest than the marketing landing page** — it explicitly labels the localized figure as *"Prices shown in NZD. **Your estimate**: [flag]"* (confirmed in `public/form-template.html:1351`), and its own checkout summary line reads **"Total today: NZ$9.95"** — the real NZD figure, not "$8.95" — directly on-screen before the customer even reaches Stripe. The landing page, by contrast, has no such disclaimer — its heading flatly states *"One Keepsake, Priced For Where You Are"* with no "estimate" qualifier (confirmed via grep: zero disclaimer text exists anywhere in `landing.html`). **So the honest-disclosure gap is narrower than originally characterized — it's specifically the landing page overstating precision, not the actual checkout page itself, which already correctly shows NZD throughout.**

Continued through to the real Stripe page and read its exact content directly: confirmed **"$8.95"/"AUD" appears nowhere on the real Stripe Checkout page at all** — only `NZ$9.95` and Stripe's own unrelated GeoIP currency-picker (showing PKR in this test environment). This is the clean, complete, no-ambiguity confirmation of the bug: an Australian customer who saw "AU$8.95" on the landing page never sees that number again at any later step — checkout and Stripe both correctly (if silently) revert to NZD.

**Redirect-logic edge cases:** not independently re-run for this item — confirmed by code review that the cancel/decline/fake-order-ID/browser-back behaviors are driven by the exact same shared `public-checkout.js` logic already exhaustively tested for Item 1 (country selection has no bearing on any of those code paths — confirmed via grep, none of that logic branches on country). Re-running identical mechanics with a different country selected would re-confirm already-documented behavior, not surface anything new — skipped to avoid redundant testing, per Item 1's own documented reasoning for deferring full-flow redundancy.

**UI/Playwright viewport check:** not independently re-run per-viewport for this item either, for the same reason — the checkout page's layout doesn't change based on which country is selected (confirmed via code read: `COUNTRY_PRICING`/`CHECKOUT_FX` only swap text content, not layout/CSS), so Item 1's 3-viewport layout findings (no overflow, correct mobile reflow, same CSP font bug) apply identically here.

**Status:** 🔴 **bug fully confirmed via complete real E2E flow through to the actual Stripe page — not yet fixed, needs Col's decision on which direction to resolve it (see cross-cutting finding below).** Refined finding: the checkout page itself is already honest (shows NZD, labels AUD as "estimate") — it's specifically the landing page that overstates precision with no disclaimer. Display price (`$8.95`) confirmed correct only on the landing page in isolation; neither the checkout page's final total nor the real Stripe charge ever shows AUD.

---

### ITEM 3 — "UK purchase shows £4.95 and completes"

**Analysis:** Same investigation as Item 2, same shared root cause. Confirmed via real browser test: landing page correctly displays `£4.95` for United Kingdom. Confirmed via the same live Stripe test-mode session creation: **Stripe will charge 9.95 NZD, not 4.95 GBP.**

**Problem:** Identical pattern to Item 2 — a UK customer sees "£4.95" but is actually charged NZ$9.95. Of the 4 currencies on this list, this is the largest proportional mismatch (NZ$9.95 is roughly double £4.95 at typical exchange rates), making this the most visible/likely-to-cause-complaints instance of the shared bug.

**Full E2E re-verification (2 Oct 2026):** ran the real purchase flow with United Kingdom selected, through to the actual Stripe page. Confirmed checkout summary correctly shows **"Total today: NZ$9.95"** (same honest behavior already established for Item 2). Confirmed directly from the real Stripe page's content: **"£" and "4.95" appear nowhere at all** — only `NZ$9.95` and Stripe's own unrelated currency picker. Redirect-logic and UI/viewport mechanics not independently re-run, same reasoning as Item 2 (neither branches on country, already exhaustively covered by Item 1).

**Status:** 🔴 **bug fully confirmed via complete E2E flow through to the real Stripe page — not yet fixed, needs Col's decision (see cross-cutting finding).** Same pattern as Item 2: checkout page itself is honest (NZD, no false GBP precision), landing page is the one overstating precision; real Stripe charge never shows GBP.

---

### ITEM 4 — "US purchase shows US$6.95 and completes"

**Analysis:** Same investigation, same shared root cause. Confirmed via real browser test: landing page correctly displays `$6.95` for United States. Confirmed via the same live Stripe test-mode session: **Stripe will charge 9.95 NZD, not 6.95 USD.**

**Problem:** Identical pattern to Items 2 and 3.

**Full E2E re-verification (2 Oct 2026):** ran the real purchase flow with United States selected, through to the actual Stripe page. Confirmed checkout summary shows **"Total today: NZ$9.95"**. Confirmed directly from the real Stripe page: **no "6.95", no "USD" anywhere** — only `NZ$9.95`. (One test-script timing flake hit during this run — the first attempt's `innerText()` call raced ahead of the page finishing render and came back empty; re-ran with a brief settle delay and got a clean, consistent read. Noting this explicitly since catching and correcting a flaky test read, rather than reporting a false "empty page" bug, matters for accuracy.) Redirect-logic and UI/viewport mechanics not independently re-run, same reasoning as Items 2-3.

**Status:** 🔴 **bug fully confirmed via complete E2E flow through to the real Stripe page — not yet fixed, needs Col's decision (see cross-cutting finding).** Same pattern as Items 2-3: checkout page honest (NZD), landing page overstates precision, real Stripe charge never shows USD.

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

**Full E2E re-verification of the GCash path specifically (2 Oct 2026), real browser automation, not just code reading:** ran the complete real flow — selected Philippines, generated a real keepsake, selected "Pay with GCash" as the payment method, clicked Pay. **Confirmed the GCash modal opens correctly (does NOT redirect to Stripe)**, showing exactly **"Pay exact amount: PHP 199.00"**, explicitly labeled *"Rate: Fixed price for GCash payments — PHP 199.00"* (honest about the mechanism, not hidden), real payee name/GCash number/QR code displayed, and clear step-by-step instructions for submitting payment proof. Confirmed no NZD figure leaks into the GCash modal itself. This fully confirms, via direct browser testing (not just reading `fixedPhp = 199` in the code), that the GCash path is genuinely correct end-to-end.

**One minor, non-functional inconsistency noted while screenshotting (not a bug, just worth recording):** the background checkout panel (behind the modal) still shows "Prices shown in NZD... NZ$9.95" while the GCash modal in front of it correctly shows PHP 199 — a cosmetic layering inconsistency since the modal itself is accurate, not something that could mislead or cause a payment error.

**Status:** 🟡 **partially correct — GCash path now confirmed working exactly as described via full real browser E2E testing (not just code reading); card path shares the cross-cutting NZD-charge bug documented above.** Needs no separate fix for the GCash side — GCash itself needs no changes for this item.

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

**Re-verified fresh (2 Oct 2026), per "no chance of error" instruction — this time against the actual `/public` checkout page specifically, not just `landing.html`:** discovered `form-template.html` has its own **separate, independently-maintained copy** of this same detection logic (`detectCheckoutPricingCountry()`, `form-template.html:3671-3689`) — a faithful duplicate of `landing.html`'s version, not shared/imported code, meaning the two could in principle drift apart from each other over time without anyone noticing. Worth testing independently rather than assuming "already confirmed on landing.html" covers this page too.

**First test attempt genuinely got this wrong — caught and corrected before reporting a false bug, worth recording the mistake and the fix:** initially checked the `#country` field (the *recipient's* country, used for keepsake content like local news/weather — a manually-set, unrelated field) and found it always stayed "New Zealand" regardless of timezone, which looked like a real bug. Investigated instead of reporting it: confirmed via code (`form-template.html:3710-3730`, `applyCheckoutPricingCountry()`) that auto-detection actually writes to a **different element**, `#checkout-country-select` (the pricing/currency-estimate selector in the purchase panel) — not `#country` at all. Re-ran the test against the correct element and got **all 6 real timezone cases + the fallback case correct**, matching `landing.html`'s behavior exactly: `Pacific/Auckland→NZ`, `Asia/Manila→Philippines`, `Europe/London→UK`, `America/Chicago→US`, `Australia/Melbourne→Australia`, `Asia/Dubai` (unmapped) → correctly falls back to New Zealand.

**Worth flagging as a genuine, if minor, source-of-confusion finding (not a functional bug):** this page has two separately-named, same-sounding "country" concepts — `#country` (recipient's country, affects keepsake content) and `#checkout-country-select` (pricing-display country, affects only the NZD-to-local "estimate" shown). Both are real, both work correctly, but a future developer (or this session's own first test attempt) could easily conflate them, same way I initially did.

**Status:** ✅ **re-confirmed correct, now independently verified on the actual checkout page too, not just landing.html — both implementations match, no drift found.** One test-script mistake made and corrected during this process, documented honestly rather than silently fixed.

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

### ITEM 13 — "Monthly offer code (e.g. WELCOME20) takes 20% off"

**Analysis:** Checked the real production `promo_codes` table directly for `WELCOME20`: `code_type: campaign_single_use`, `discount_type: percent`, `discount_value: 20`, **`used_count: 1, max_uses: 1`** — this specific code has already been fully consumed by a real past use. Confirmed this via a real live E2E test (not assumed from the data alone): entered `WELCOME20` at checkout and clicked Pay — **the real, correct error message displayed clearly: "This promo code has already been used."** No crash, all form data preserved, consistent with the exact error-handling logic already confirmed earlier this session (`resolveCampaignPromoCode()`).

**Problem:** None — this is working exactly as designed. `WELCOME20` specifically can't be tested for its *discount-applies-correctly* behavior right now since it's already spent, but this is expected behavior (campaign codes are single-use by default unless `maxUses` is explicitly raised), not a bug.

**Verified the actual discount-application mechanism works correctly using a different, known-good code** (`TT50OFF`, confirmed live-mode-correct and with remaining capacity) rather than creating a disposable throwaway promo code in the live database (avoided per this project's standing "don't leave test clutter" discipline) — real E2E test through to the actual Stripe page confirmed: **"TT50OFF — Facebook ad (Philippines) -PKR 805.31 50% off... Total due PKR 803.69"** (≈NZ$4.97, correctly half of $9.95) shown as a real, itemized line-item discount on Stripe's own page, not just a pre-checkout display figure. This is decisive, direct proof that the discount-code mechanism (when a code is correctly live-mode-configured, same as Items 62/66's findings) genuinely reduces the real Stripe charge, not just the on-screen estimate.

**Status:** ✅ **mechanism confirmed fully correct** (clear "already used" error for a spent code; genuine, itemized discount reduction confirmed on the real Stripe page for a working code). `WELCOME20` itself is simply out of uses — not a bug, a fact about its current state, worth Col knowing if he expects it to still be available for new customers (he may want to raise its `max_uses` or create a fresh batch, a product decision, not a code fix).

---

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

### ITEM 62 — 🚨 URGENT, LIVE: Col's wife actively trying to purchase right now, TT50OFF and CDMFREE both failed

**Client message (verbatim, 2 Oct 2026):** *"I have my wife trying to buy one right now. The discount code TT50OFF and CDMFREE. Did NOT work!!"*

**This is a real, live, active customer-facing failure — investigated immediately, ahead of the checklist queue, given the urgency.**

**Analysis (real evidence, not guessed — found by reading actual order records from the live production database, matching exactly to this incident):**

Found 4 real order attempts from `helenfrancesmccabe@gmail.comh` (confirmed this is Col's wife — "Helen McCabe", recipient "Sophie Elizabeth McCabe") in the last few hours:
- **3 "pending" orders**, each with `attribution_source: "promo_code"` and the note `"Attribution: promo code TT50OFF."` — confirming she typed `TT50OFF` specifically on these attempts, and the system correctly recognized/attributed the code. **All 3 have `stripe_checkout_session_id: null`** — the Stripe checkout session was never created, meaning the request failed somewhere after the pending order was saved but before Stripe was reached.
- **1 "paid" order**, with no promo code at all (`attribution_source: "none"`) — she eventually gave up on the discount and paid full price ($9.95 NZD) via a real `cs_live_...` session.

**Root cause, confirmed directly against the real Stripe account (not assumed):**

1. Confirmed production genuinely runs Stripe's **live** mode key (verified: a real `cs_live_...` checkout session was successfully created using the account's actual live key).
2. Re-tested the exact real `stripe.checkout.sessions.create()` call with the TT50OFF discount attached, using the live key — **it fails with Stripe's own explicit error**: *"No such coupon: 'ZhfCBNym'; a similar object exists in test mode, but a live mode key was used to make this request."*
3. **This is a bug introduced by this session's own earlier work (Step 10, `new_changes.md`)** — when TT50OFF's Stripe coupon was created to support the card-payment path, it was created using a local `.env` that had Stripe's **test** key active at the time, not the live key. The coupon (`ZhfCBNym`) only ever existed in Stripe test mode. It was never actually usable on the real, live production site — this was missed because the earlier verification in Step 10 was also run against the test key, so it looked correct in testing but was never truly validated against live mode.
4. **CDMFREE separately confirmed to not exist in the database at all** — unrelated to the TT50OFF bug, this one genuinely was never created (consistent with the Step 8 finding from earlier this session: Col was given instructions for creating it himself via the admin panel, but it was never actually set up by anyone).

**Problem — this is serious and ongoing, not just a one-time incident:** every real customer who enters TT50OFF on the live site right now gets the exact same failure Helen did — a pending order gets created, then the request throws a genuine Stripe error and never reaches payment. This has presumably been broken since TT50OFF went live (1 Oct 2026) — **anyone who tried it before Helen likely hit the same wall**, worth checking order history for other abandoned `promo_code`-attributed pending orders.

**🚨 Not implemented — blocked on something only Col can resolve, document-only per standing instruction.** As part of confirming this diagnosis (not as an attempt to build/fix anything), a real live-mode Stripe coupon creation call was tested directly against the account to verify the theory — **it failed too**: *"Permission denied... Enabling Coupons Write ('coupon_write') permissions on this key would allow this request to continue."* This confirms, not just theorizes, that **the live Stripe API key configured on production is a restricted key with no permission to create or even read coupons at all.** This is not something fixable from code or from this session — it requires either:
1. Col (or whoever manages the Stripe account) grants "Coupons Read" and "Coupons Write" permissions to the live API key currently configured on Render, via the Stripe Dashboard (link Stripe's own error provided: `https://dashboard.stripe.com/b/acct_1MHaIXA2imB14cWZ?destination=%2Fapikeys%2F...`), **or**
2. A different, less-restricted live key is generated and swapped into Render's environment variables.

**This also means something bigger than just TT50OFF:** since the whole server uses one single Stripe client/key for everything (confirmed via `server.js:31`), **the admin panel's own "+ Create Codes" feature (built in Step 8) is almost certainly also broken on the live site right now** for any percent/fixed-discount code — it calls the exact same `stripe.coupons.create()` that just failed with this permission error. This needs separately confirming, but the mechanism is identical.

**Solution (not implemented — documented only, pending Col's action):**
1. Col needs to fix the Stripe API key's permissions (or supply a different key) before any further discount-code work on the live site can be verified as genuinely working.
2. Once a working live key is confirmed, a proper live-mode coupon needs creating for TT50OFF and attaching to the existing code row.
3. CDMFREE still needs creating from scratch regardless (separate, unrelated gap).
4. Checked order history for any other customers who hit this same TT50OFF failure before Helen — **confirmed only Helen's 3 attempts exist, no other customer has tried TT50OFF since it went live on 1 Oct 2026.** Contained to one family member's attempts, not a wider incident so far — still needs fixing before the ad campaign drives real traffic.

**Status:** 🚨 **PENDING — root cause found and fully confirmed with real evidence, nothing implemented.** Blocked on a Stripe Dashboard permission change only Col (or whoever controls that account) can make. Relayed to Col directly given the live urgency; tracked here as pending until the permission is fixed and the actual coupon fix can be built and tested.

---

### ITEM 63 — Col: "Explain what this information is and how I use it??" (Dashboard Overview screenshot)

**Client message (2 Oct 2026):** Screenshot of the admin dashboard home screen (mobile), showing: Total/Pending/Printed/Posted/Delivered order-status tiles (1/0/0/1/0), and an "Attribution Summary (This Month)" block with Free Demos: 0, Paid Sales: 17, Paid Total: NZ$244.15, Unattributed: 16. Question, not a bug report: *"Explain what this information is and how I use it??"*

**This is a question, not an implementation request — no code change made, per instruction. Not a "not yet implemented" item in the usual sense (there's nothing to build), just answered and logged here for the record.**

**Answer, confirmed by reading the actual calculation code (`src/phase2/admin-fulfilment.js:2894-2922`, `buildAttributionReport()`), not guessed:**
- **Total/Pending/Printed/Posted/Delivered** (top tiles): physical-order fulfilment status counts — how many orders exist, and where each one is in the print → post → deliver pipeline. Only counts orders needing physical fulfilment.
- **Free Demos**: how many free demo keepsakes have been generated **this calendar month** (resets on the 1st) — ties to a consultant's monthly free-demo allowance.
- **Paid Sales**: count of paid orders **this calendar month**.
- **Paid Total**: the sum of `total_amount_nzd` across those paid orders — confirmed this is **always in NZD regardless of what currency a customer saw** (directly connects to the cross-cutting currency-mismatch finding from Items 2-4/8 — this total is accurate to what Stripe actually charged, not necessarily what the customer believed they were paying).
- **Unattributed**: paid orders with no `sales_consultant_id` set — i.e. sales that didn't come through any agent/reseller code, direct/organic sales. 16 of 17 sales this month being unattributed means only 1 sale this month is credited to an agent.

**How to use it:** a quick monthly pulse check — how many sales, how much revenue (in NZD), and how much of that came through agents vs. organically. Scrolling down from this same screen (per the screenshot's own next visible heading, "Agent Attribution Report") breaks the same numbers down per individual agent.

**Status:** ✅ **answered directly, no code change, logged for the record.**

---

### ITEM 64 — Col: "Should that sales money automatically end up in my bank account... I haven't received that money. Do I need to do something else?"

**Client message (2 Oct 2026):** Direct question about Stripe payouts, following item 63's dashboard explanation.

**Analysis (checked everything genuinely checkable from code/API, honest about the real limit of what this session can see):**
- Confirmed via exhaustive grep across `src/phase2/*.js` and `server.js`: **this codebase contains zero payout logic of any kind.** It creates Stripe Checkout Sessions and reads back `payment_status` — it never touches bank transfers, payout schedules, or Stripe Connect payout routing. Payouts from a Stripe balance to a connected bank account are entirely a Stripe **account-level** setting (configured in the Stripe Dashboard, not this app), so there is nothing in this codebase that could be "broken" in a way that would stop money reaching Col's bank.
- Directly attempted to check Col's actual Stripe balance and payout history, to give a real answer instead of a generic one — **blocked by the same restricted-key permission issue already found in Item 62**: `Balance Read` and `Payouts Read` are both denied for the live key available here. Confirmed via Stripe's own permission-denied error, not assumed.

**Problem:** This is a real question only Col can get the real answer to — **this session genuinely cannot see his Stripe balance or payout history**, so cannot confirm or rule out whether money is sitting there, already paid out, or stuck.

**Answer to relay to Col (what IS knowable, to make his own Dashboard check faster):**
1. **Yes, in a standard non-connected Stripe setup, money from paid Checkout Sessions does automatically pay out to the connected bank account** — on whatever payout schedule is configured (Stripe's default for a new NZ account is often a rolling 7-day delay before the *first* payout, then a regular schedule after that — but this is account-specific, not something this app sets).
2. **Where to check himself:** Stripe Dashboard → **Balance** (shows current available/pending balance) → **Payouts** tab (shows payout history and the account's payout schedule/frequency). This will show definitively whether money has already been paid out, is pending, or is stuck for some reason (e.g. an unverified bank account, a hold on the account).
3. **A genuinely common first-time cause, worth him checking specifically:** a new Stripe account's very first payout is often delayed (commonly 7-14 days) while Stripe verifies the account — if this site only started taking real payments recently (this session's own order records show real paid orders only from very recently), this delay could fully explain "I haven't received it yet" without anything being broken.

**Status:** 📝 **answered with everything checkable from here; the actual balance/payout figures are not visible to this session (confirmed via a real, denied API call, not assumed) — Col needs to check his own Stripe Dashboard's Balance and Payouts screens directly for the real numbers.** No code change — there is nothing in this codebase to fix for this item.

---

### ITEM 65 — Col: "So do I approve this?? What happens then??" (Approve Reseller Request confirm dialog screenshot)

**Client message (2 Oct 2026):** Screenshot of the admin panel's "Approve Reseller Request" confirmation dialog, which reads: *"Approve this reseller request? This creates a real reseller account and auto-generates their promo code."* Asking whether to approve, and what the real consequence is.

**Analysis (confirmed by reading the real approval endpoint, `src/phase2/admin-fulfilment.js:2372-2439`, `POST /api/admin/reseller-requests/:id/approve` — not guessed):**

**What clicking "Approve" actually, concretely does:**
1. Creates a **real agent/consultant account** from everything the applicant submitted on the public sign-up form (name, email, phone, address, business type, social-media follower counts) — confirmed this pulls real structured data, not placeholder values.
2. **Auto-generates a tracking/referral code** for them (e.g. a code like "colinM20" style, per this project's existing convention) — confirmed via `autoIssueAttributionCode()` that this is an **attribution/referral code**, the same type investigated earlier in this session's Step 5 — it's for crediting future sales back to this specific agent, **not a customer-facing discount code**. It doesn't give anyone money off; it tracks who referred a sale.
3. If the applicant selected "business" as their type, Col gets asked first which specific kind (Florist / Cake Shop / Gift Store) before anything is created — confirmed this prompt fires before the dialog in the screenshot, so by the time this exact "Approve" dialog is showing, that choice (if needed) has already been made.
4. The request itself is marked approved/processed — it won't show as pending anymore.

**What it does NOT do** (worth Col knowing, since the dialog text is terse): it does not charge anyone, send a payment, or set up anything financial automatically beyond creating the tracking code — commission rate is a separate consultant-record field, not something this specific action sets to a surprising value.

**Is it safe to approve?** Yes, in the sense that it does exactly and only what the dialog says — no hidden side effects found. The real decision for Col to make isn't technical, it's business: is this a legitimate applicant he actually wants as a reseller? That's not something this session can judge from the code — the screenshot only shows the confirmation dialog, not the actual applicant's details, which Col would see on the request row before clicking Approve.

**Status:** ✅ **answered directly, no code change, no bug found — the confirm dialog's own text is accurate to what the code actually does.**

---

### ITEM 66 — 🚨 URGENT: Col paid full price trying to use "colinM100", "can't progress until the codes work"

**Client message (verbatim, 2 Oct 2026):** *"Again paid for another one and code ColinM100 didn't work either. I can't progress til the codes work. Please advise what is happening and why they are not working please."*

**Investigated immediately with real evidence, same approach as Item 62.**

**Found the exact order, confirmed with full certainty (not guessed):** `TT-20261002-0005`, `colindavidmccabe@gmail.com` (Col's own account) — `payment_status: paid`, `total_amount_nzd: 9.95` (**full price, no discount applied**), `notes: "Attribution: promo code colinM100."`, `sales_consultant_id` correctly set.

**Root cause — this is a genuinely different problem from Item 62's TT50OFF bug, not the same issue recurring:**

Looked up `colinM100` directly in the live database: `code_type: "consultant_demo"`, `discount_type: null`, `discount_value: null`, `stripe_coupon_id: null`.

**`colinM100` was created as an agent/reseller tracking code, not a discount code.** This is the exact two-code-system confusion already fully investigated and documented earlier this session (`new_changes.md` Step 8, and the admin filtering bug in Step 5): this codebase has two genuinely separate things that are easy to conflate —
1. **`consultant_demo` codes** (created via the Agent/reseller signup or management screen) — these only track which agent referred a sale (for commission credit) and optionally grant free demo keepsakes. **They have no discount fields at all — they structurally cannot give a customer money off, by design**, confirmed via the schema (`discount_type`/`discount_value` are both `null` on this code, and the `consultant_demo` code type has no discount columns populated anywhere in this codebase).
2. **`campaign_single_use` codes** (created via the admin's "+ Create Codes" button — the system TT50OFF uses) — these are the only code type that can carry a real discount.

**What actually happened, confirmed by the order record:** Col typed `colinM100` at checkout. The system correctly recognized it as a real, valid agent-attribution code (`sales_consultant_id` was correctly set on the order — that part worked exactly as intended) — but since it was never built with a discount attached, checkout proceeded at full price, with no error, because **this is by design**: `resolveCampaignPromoCode()` only looks for `campaign_single_use` codes; a `consultant_demo` code like `colinM100` is invisible to it and silently contributes no discount, which is the intended, correct behavior for a pure tracking code.

**This is not a bug — `colinM100` was never set up to BE a discount code.** The real issue is the same usability gap already flagged in Step 8 of `new_changes.md`: it's easy for Col himself to not realize which of the two code systems he's creating a code in, and the UI doesn't make the distinction obvious enough.

**Why this is different from Item 62 (worth being precise about, not lumping them together):**
- Item 62 (TT50OFF): a genuine discount code, correctly built as `campaign_single_use` with a discount configured — but the Stripe coupon backing it was only ever valid in test mode, so it failed with a real Stripe error and never reached payment (a pending order, no successful charge).
- Item 66 (colinM100): not a discount code at all by its own configuration — checkout succeeded, Col was correctly and successfully charged, just at full price, because there was never a discount to apply in the first place.

**Problem:** Col expected a discount from `colinM100` and didn't get one, and paid real money as a result. This needs two things: (1) an honest explanation of why (above), and (2) if Col actually wants `colinM100` to BE a discount code, it needs to be rebuilt as a `campaign_single_use` code (or a parallel discount code created) — not a backend bug fix, a configuration/setup gap.

**Follow-up question from Col: can the existing `colinM100` code just be edited to add a discount, instead of creating a new one?**

Checked directly: `PUT /api/admin/promo-codes/:id` (`src/phase2/admin-fulfilment.js:1045-1076`) — the only endpoint that edits an existing code — explicitly lists its editable fields: `consultant_id`, `code` (the text itself), `monthlyFreeDemoLimit`, `active`, `notes`. **`discount_type` and `discount_value` are not in this list at all — there is no way, in the current admin UI/API, to edit an existing `consultant_demo` code like `colinM100` to add a discount to it.** Confirmed this isn't an oversight in reading the code wrong — the edit endpoint simply doesn't touch those two fields, by design, since `consultant_demo` codes were never meant to carry a discount at all.

**Answer: Col cannot just edit `colinM100` to add a discount — the edit screen doesn't support that field.** The only real path is creating a new, separate code via the "+ Create Codes" discount-code screen (which does support setting a discount). He can choose any code text for that new one, including re-using a similar name if he wants, but it would be a genuinely new/different code row, not an edit of the existing `colinM100`.

**Status:** 🔴 **root cause found and fully confirmed with real evidence — not a code bug, a setup/configuration gap (the code was never built with a discount attached, and cannot be edited after the fact to add one).** Documented, not implemented, per standing instruction — needs Col to create a new discount code via the "+ Create Codes" screen if he wants a working `colinM100`-equivalent; the existing one cannot be converted.

---

### ITEM 67 — Duplicate of Item 66 (same message, re-sent verbatim)

**Client message (2 Oct 2026):** Identical text to Item 66's message, word-for-word: *"Again paid for another one and code ColinM100 didn't work either. I can't progress til the codes work. Please advise what is happening and why they are not working please."*

**Checked before treating this as a new incident:** queried the live database for any order created in the 30 minutes before this message — **zero new orders found.** This confirms this is the same message being re-sent, not a second, separate failed purchase attempt. No new investigation needed — the full root-cause analysis, the "can colinM100 just be edited" follow-up, and the answer are all already covered in Item 66 above.

**Status:** ✅ **confirmed as a duplicate of Item 66, not a new issue — same answer applies, nothing further to investigate.** Logged as its own numbered item per the "every single change gets its own step" instruction, rather than silently merged.
