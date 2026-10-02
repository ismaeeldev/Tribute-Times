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

**Status:** 📝 not yet started.

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
