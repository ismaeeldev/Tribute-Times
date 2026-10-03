'use strict';

const crypto = require('crypto');
const {
  PRODUCT_TIERS,
  DELIVERY_OPTIONS,
  SOURCE_PORTALS,
  PAYMENT_STATUS,
  ATTRIBUTION_SOURCE,
  SUPPORTED_COUNTRIES,
  WATERMARK_STATUS,
} = require('./constants');
const { PHASE2_CONFIG } = require('./config');
const { getNextOrderNumber } = require('./order-number');
const { saveKeepsakeRecord, updateKeepsakeRecord } = require('./save-keepsake');
const { generatePdfFromHtml } = require('./pdf-service');
const { buildPublicOrderAdminEmail, buildPublicOrderCustomerEmail, buildSecondPurchaseDiscountEmail } = require('./email-service');
const { resolvePaidOrderAttribution } = require('./attribution');
const { tryRedeemGcashPaidPromoCode } = require('./gcash-payment-requests');
const { issueSecondPurchaseDiscountCode, SECOND_PURCHASE_DISCOUNT_PERCENT } = require('./second-purchase-discount');
const { captureMarketingContact } = require('./marketing-contacts');

function registerPublicCheckoutRoutes(app, { stripe, supabase, sendEmail }) {
  if (!app) throw new Error('Express app is required.');
  if (!stripe) throw new Error('Stripe client is required.');
  if (!supabase) throw new Error('Supabase client is required.');

  app.post('/api/public/checkout-session', async (req, res) => {
    try {
      const rawPayload = normalizePayload(req.body || {}, req.ip);
      const payload = await enrichPayloadFromExistingKeepsake(supabase, rawPayload);
      // stripe threaded through, 31 Aug 2026 (client request, Col: "GCash
      // should be operating as stripe is") — needed so a GCash-redeemed
      // order can issue the same automatic Thank-You/second-purchase
      // discount the Stripe path already sends (issueSecondPurchaseDiscountCode
      // needs a real Stripe client to create/reuse its coupon).
      const gcashRedemption = await tryRedeemGcashPaidPromoCode({
        supabase,
        sendEmail,
        stripe,
        payload,
      });
      if (gcashRedemption) {
        return res.json(gcashRedemption);
      }

      const baseUrl = getBaseUrl(req);
      const attribution = await resolvePaidOrderAttribution({
        supabase,
        promoCode: payload.promoCode,
        existingKeepsake: payload.existingKeepsake,
        postcode: payload.shippingPostcode,
        country: payload.shippingCountry || payload.country,
      });

      // Phase 7 — client request 21 Aug 2026 (Col, Scenario A): moved
      // resolveViralShareRow() up to run BEFORE createPendingOrder() below
      // (it used to run much later, after the order was already created —
      // found during implementation that a fallback added after that
      // point would be too late, since the order's sales_consultant_id is
      // set from `attribution` at creation time, not updated afterward).
      // resolvePaidOrderAttribution() itself is untouched — its own
      // priority order (promo code -> existing keepsake -> postcode) is
      // exactly as before. This only fills in the gap when NONE of those
      // three produced a consultant: an explicit promo code, or a real
      // postcode-territory match, still always wins over an inherited
      // referral attribution.
      const viralShare = payload.referralCode ? await resolveViralShareRow(supabase, payload.referralCode) : null;
      if (!attribution.salesConsultantId && viralShare?.origin_consultant_id) {
        attribution.salesConsultantId = viralShare.origin_consultant_id;
        attribution.attributionSource = ATTRIBUTION_SOURCE.referral;
      }

      // Fix, Oct 2026 (checklist item 20): a campaign code's `country`
      // restriction is meant to describe the CUSTOMER (where they are,
      // what currency/price they saw), not where the physical keepsake
      // ships — those can legitimately differ (e.g. an NZ-based customer
      // shipping a printed keepsake to an overseas relative). Previously
      // checked shippingCountry/country (the shipping-destination fields)
      // here, which incorrectly rejected genuine NZ customers shipping
      // overseas against an NZ-restricted code like CDMFREE. Now prefers
      // the customer's own detected pricing country (the flag they picked
      // on the checkout-country selector, same source already proven
      // correct in Items 6/7), falling back to the old fields only if a
      // pricing country was never sent (e.g. an older cached page).
      const customerCountry = payload.pricingCountry || payload.shippingCountry || payload.country;
      const campaignCode = payload.promoCode
        ? await resolveCampaignPromoCode(supabase, payload.promoCode, customerCountry)
        : null;

      // Fix, Oct 2026 (checklist item 24): a typed code that matches
      // NEITHER a campaign discount code (campaignCode above) NOR a
      // consultant attribution code (attribution.attributionSource,
      // resolved just above from the same payload.promoCode) previously
      // fell through silently on both paths and let checkout proceed at
      // full price with zero explanation — the customer typed a code
      // expecting a discount and got none, with no error shown. Every
      // OTHER failure reason (expired, used up, wrong country) already
      // throws a clear message via resolveCampaignPromoCode() above; this
      // closes the one remaining silent case. Does NOT change the
      // deliberate 11 Aug 2026 fix in attribution.js (a code that
      // correctly matches an attribution-only code with no discount must
      // never block payment) — this only fires when the code matched
      // nothing recognizable at all. Checked here, before any keepsake/
      // order row is created, so a rejected code never leaves behind an
      // orphaned pending order.
      if (payload.promoCode && !campaignCode && attribution.attributionSource !== ATTRIBUTION_SOURCE.promoCode) {
        throwStatus(400, 'That promo code was not recognised. Check it and try again, or leave it blank to pay full price.');
      }

      const keepsakeId = payload.keepsakeId || await createKeepsakeIfNeeded(supabase, payload, attribution);
      const tier = PRODUCT_TIERS[payload.productTier];
      const delivery = payload.deliveryOption ? DELIVERY_OPTIONS[payload.deliveryOption] : null;
      const orderNumber = await getNextOrderNumber(supabase);
      const orderRecord = await createPendingOrder({
        supabase,
        keepsakeId,
        orderNumber,
        payload,
        tier,
        delivery,
        attribution,
      });

      const lineItems = buildLineItems(tier, delivery);

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        customer_email: payload.customerEmail,
        billing_address_collection: 'auto',
        line_items: lineItems,
        ...(campaignCode
          ? { discounts: [{ coupon: campaignCode.stripe_coupon_id }] }
          : viralShare && process.env.STRIPE_VIRAL_SHARE_COUPON_ID
          ? { discounts: [{ coupon: process.env.STRIPE_VIRAL_SHARE_COUPON_ID }] }
          : {}),
        success_url: `${baseUrl}/public?checkout=success&order=${orderRecord.id}`,
        cancel_url: `${baseUrl}/public?checkout=cancelled&order=${orderRecord.id}`,
        metadata: {
          type: 'public_order',
          order_id: orderRecord.id,
          order_number: orderNumber,
          keepsake_id: keepsakeId,
          source_portal: SOURCE_PORTALS.public,
          tier: payload.productTier,
          delivery_option: payload.deliveryOption || '',
          promo_code: attribution.promoCode || payload.promoCode || '',
          attribution_source: orderRecord.attribution_source || ATTRIBUTION_SOURCE.none,
          sales_consultant_id: orderRecord.sales_consultant_id || '',
          territory_id: orderRecord.territory_id || '',
          viral_share_code: viralShare ? payload.referralCode.toUpperCase() : '',
          campaign_code: campaignCode ? campaignCode.code : '',
          marketing_consent: payload.marketingConsent ? '1' : '0',
        },
      });

      await supabase
        .from('orders')
        .update({ stripe_checkout_session_id: session.id })
        .eq('id', orderRecord.id);

      if (viralShare) {
        await supabase
          .from('viral_shares')
          .update({ redeemed_count: (viralShare.redeemed_count || 0) + 1 })
          .eq('id', viralShare.id);
      }

      if (campaignCode) {
        // Same atomic, self-verifying consume pattern as the GCash-generated
        // codes (Step 2) — a conditional update guarded on used_count/active/
        // expiry, checked for zero-row failure, not a blind increment.
        await consumeCampaignPromoCode(supabase, campaignCode, orderRecord.id);
      }

      return res.json({
        url: session.url,
        orderId: orderRecord.id,
        orderNumber,
        checkoutSessionId: session.id,
      });
    } catch (error) {
      console.error('Public checkout error:', error);
      return res.status(400).json({ error: error.message || 'Unable to create checkout session.' });
    }
  });

  app.get('/api/public/orders/:orderId', async (req, res) => {
    try {
      const order = await loadPublicOrder(supabase, req.params.orderId);
      const resolvedOrder = await resolvePublicOrderStatus({
        stripe,
        supabase,
        sendEmail,
        order,
      });

      return res.json(buildPublicOrderResponse(resolvedOrder));
    } catch (error) {
      console.error('Public order lookup error:', error);
      return res.status(404).json({ error: error.message || 'Order not found.' });
    }
  });

  // Lets the frontend confirm a ?ref= code is real BEFORE telling the visitor
  // "10% off applied" — the checkout-session route below re-validates this
  // same code server-side regardless, this is purely so the UI never claims
  // a discount that won't actually show up at Stripe checkout.
  app.get('/api/public/share/validate', async (req, res) => {
    const code = String(req.query.code || '').trim();
    if (!code) return res.json({ valid: false });
    const row = await resolveViralShareRow(supabase, code);
    return res.json({ valid: Boolean(row) });
  });

  // Client-reported bug (11 Aug 2026, urgent — "Promo/referral discount
  // doesn't apply"): the checkout promo code field had no Apply button and
  // no way to trigger validation — entering a code and tabbing out gave no
  // confirmation and no error either way, same complaint the share-code
  // validate route above already solved for referral links. Mirrors that
  // exact pattern for the checkout promo field: lets the frontend show a
  // real "valid"/"not valid, here's why" message as soon as the customer
  // leaves the field, using the same resolveCampaignPromoCode() check the
  // checkout-session route re-runs anyway — so this is purely an early,
  // friendlier preview, never the sole gate (checkout-session below still
  // authoritatively re-validates before any Stripe session is created).
  app.get('/api/public/promo/validate', async (req, res) => {
    const code = String(req.query.code || '').trim();
    const country = String(req.query.country || '').trim();
    if (!code) return res.json({ valid: false });
    try {
      const campaign = await resolveCampaignPromoCode(supabase, code, country);
      return res.json({ valid: Boolean(campaign) });
    } catch (error) {
      return res.json({ valid: false, message: error.message || 'That promo code is not valid.' });
    }
  });

  // Viral share loop (Tasks 1.7/1.8). Pre-payment shares unlock 10% off
  // immediately for the sharer; post-purchase shares create a link that
  // gives the next visitor 10% off at their own checkout.
  app.post('/api/public/share', async (req, res) => {
    try {
      const keepsakeId = req.body?.keepsakeId || null;
      const orderId = req.body?.orderId || null;
      if (!keepsakeId && !orderId) {
        throwStatus(400, 'A keepsake or order is required to create a share link.');
      }

      const originType = orderId ? 'post_purchase' : 'pre_payment';
      const code = await createOrReuseShareCode(supabase, { keepsakeId, orderId, originType });
      const baseUrl = getBaseUrl(req);

      return res.json({
        code,
        shareUrl: `${baseUrl}/public?ref=${encodeURIComponent(code)}`,
        discountUnlocked: originType === 'pre_payment',
      });
    } catch (error) {
      console.error('Share link error:', error);
      return res.status(error.statusCode || 400).json({ error: error.message || 'Unable to create share link.' });
    }
  });
}

// Phase 7 — true whenever Supabase/PostgREST reports a column that
// doesn't exist yet (src/db.phase7.sql not yet run). Found during testing
// that INSERT and SELECT report this differently through PostgREST — an
// INSERT against an unknown column returns PGRST204 ("schema cache"
// miss), while a SELECT/filter against one returns the raw Postgres
// 42703 — so both codes need checking, not just one, or this only
// half-works depending which operation hit the missing column.
function isMissingColumnError(error) {
  return error?.code === '42703' || error?.code === 'PGRST204';
}

// Phase 7 — client request 21 Aug 2026 (Col, Scenario A): looks up the
// origin order/keepsake's sales_consultant_id (the same field
// resolvePaidOrderAttribution() already reads from these exact tables) so
// a referred friend's purchase can later be traced back to it. Returns
// null (not an error) if the lookup fails or the origin never had a
// consultant — that's a normal, valid case (an organic sale's referral
// link correctly carries no attribution forward), not a failure.
async function lookupOriginConsultantId(supabase, { keepsakeId, orderId }) {
  try {
    if (orderId) {
      const { data } = await supabase.from('orders').select('sales_consultant_id').eq('id', orderId).maybeSingle();
      return data?.sales_consultant_id || null;
    }
    if (keepsakeId) {
      const { data } = await supabase.from('keepsakes').select('sales_consultant_id').eq('id', keepsakeId).maybeSingle();
      return data?.sales_consultant_id || null;
    }
  } catch (err) {
    console.warn('lookupOriginConsultantId failed, proceeding with no consultant link:', err.message);
  }
  return null;
}

async function createOrReuseShareCode(supabase, { keepsakeId, orderId, originType }) {
  const matchColumn = orderId ? 'origin_order_id' : 'origin_keepsake_id';
  const matchValue = orderId || keepsakeId;

  let { data: existing, error: existingErr } = await supabase
    .from('viral_shares')
    .select('code, origin_consultant_id')
    .eq('origin_type', originType)
    .eq(matchColumn, matchValue)
    .maybeSingle();

  // Bug found during review, 23 Aug 2026: this select previously ignored
  // its own `error` entirely — with origin_consultant_id now in the
  // select list, a missing-column error (migration pending) would make
  // `existing` come back undefined even when a share code already DOES
  // exist for this origin, causing the dedup check below to silently
  // skip and create a SECOND code for the same origin instead of reusing
  // the first — breaking the exact "same origin always gets the same
  // code" guarantee this function exists to provide. Same graceful-degrade
  // fallback as everywhere else in this file: retry with the old,
  // narrower select the moment the new column isn't available yet.
  if (isMissingColumnError(existingErr)) {
    ({ data: existing, error: existingErr } = await supabase
      .from('viral_shares')
      .select('code')
      .eq('origin_type', originType)
      .eq(matchColumn, matchValue)
      .maybeSingle());
  }

  if (existing) {
    // Bug found during review, 23 Aug 2026: a share link created in the
    // window before src/db.phase7.sql is run would otherwise never get
    // origin_consultant_id backfilled, even after the migration runs
    // later — this code path just returns the same existing code forever
    // once created, so a link generated "too early" would permanently
    // carry no attribution. Backfill it here on read if it's missing and
    // now computable, rather than leaving a silent permanent gap.
    if (existing.origin_consultant_id === undefined || existing.origin_consultant_id === null) {
      const backfillId = await lookupOriginConsultantId(supabase, { keepsakeId, orderId });
      if (backfillId) {
        await supabase.from('viral_shares').update({ origin_consultant_id: backfillId })
          .eq('origin_type', originType).eq(matchColumn, matchValue)
          .then(() => {}, () => {}); // best-effort — migration may still be pending, don't fail the request over it
      }
    }
    return existing.code;
  }

  const originConsultantId = await lookupOriginConsultantId(supabase, { keepsakeId, orderId });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const insertRow = {
      code,
      origin_type: originType,
      origin_keepsake_id: keepsakeId || null,
      origin_order_id: orderId || null,
      origin_consultant_id: originConsultantId,
    };
    let { data, error } = await supabase.from('viral_shares').insert(insertRow).select('code').single();

    // Found during testing, 22 Aug 2026: this feature previously worked
    // fine and unconditionally included origin_consultant_id would break
    // the entire "Share the Love" link generation with a 400 error for
    // every user the moment this code shipped, until src/db.phase7.sql is
    // run — reproduced directly (400, "Could not find the
    // 'origin_consultant_id' column"). A working feature must never
    // regress just because a *new, additive* column hasn't been migrated
    // yet. If the column genuinely doesn't exist (Postgres 42703), retry
    // once without it — same behavior as before this phase, just without
    // the new attribution link until the migration runs.
    if (isMissingColumnError(error)) {
      delete insertRow.origin_consultant_id;
      ({ data, error } = await supabase.from('viral_shares').insert(insertRow).select('code').single());
    }

    if (!error) return data.code;
    if (error.code !== '23505') {
      throw new Error(`Unable to create share link: ${error.message}`);
    }
  }

  throw new Error('Unable to generate a unique share code.');
}

async function resolveViralShareRow(supabase, referralCode) {
  const code = String(referralCode || '').trim().toUpperCase();
  if (!code) return null;

  let { data, error } = await supabase
    .from('viral_shares')
    .select('id, redeemed_count, origin_consultant_id')
    .ilike('code', code)
    .maybeSingle();

  // Same graceful-degrade as createOrReuseShareCode above, and for the
  // same reason: found during testing that selecting a not-yet-migrated
  // column here silently broke the EXISTING, already-working 10%
  // referral discount for every real referral code, since this function
  // already treats any error as "code not found" (line below) — a
  // genuinely valid referral link would silently stop giving its
  // discount, not just lose the new attribution feature. Retry without
  // the new column so the pre-existing discount behavior is unaffected
  // while the migration is pending.
  if (isMissingColumnError(error)) {
    ({ data, error } = await supabase.from('viral_shares').select('id, redeemed_count').ilike('code', code).maybeSingle());
  }

  if (error || !data) return null;
  return data;
}

// Single-use, batch-generated campaign codes (Step 5, new_changes.md — the
// Philippines florist/GCash single-use promo code system). Distinct from
// resolveViralShareRow (referral codes) and the gcash_paid_access codes
// handled in gcash-payment-requests.js.
async function resolveCampaignPromoCode(supabase, code, customerCountry) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return null;

  const { data, error } = await supabase
    .from('promo_codes')
    .select('id, code, used_count, max_uses, active, valid_until, country, stripe_coupon_id')
    .ilike('code', normalized)
    .eq('code_type', 'campaign_single_use')
    .maybeSingle();
  // Not a campaign code at all (wrong code_type or genuinely doesn't exist) —
  // return null quietly and let the earlier attribution lookup in
  // attribution.js handle "this code doesn't exist anywhere" with its own
  // error. But once we've found a row that IS a campaign code, every
  // remaining failure reason below throws a specific, honest error instead
  // of silently letting checkout proceed at full price — the same principle
  // as the referral-discount fix: never let a customer submit a code and
  // have it silently not apply with no explanation.
  if (error || !data) return null;

  if (!data.active || Number(data.used_count || 0) >= Number(data.max_uses || 1)) {
    throwStatus(400, 'This promo code has already been used.');
  }
  if (data.valid_until && new Date(data.valid_until) < new Date()) {
    throwStatus(400, 'This promo code has expired.');
  }
  if (data.country && customerCountry && data.country.toLowerCase() !== String(customerCountry).toLowerCase()) {
    throwStatus(400, `This promo code is only valid for customers in ${data.country}.`);
  }
  if (!data.stripe_coupon_id) {
    throwStatus(500, 'This promo code is misconfigured — no discount is attached. Please contact support.');
  }

  return data;
}

async function consumeCampaignPromoCode(supabase, promo, orderId) {
  const { data, error } = await supabase
    .from('promo_codes')
    .update({
      used_count: Number(promo.used_count || 0) + 1,
      used_at: new Date().toISOString(),
      used_order_id: orderId,
      active: Number(promo.used_count || 0) + 1 >= Number(promo.max_uses || 1) ? false : true,
    })
    .eq('id', promo.id)
    .eq('active', true)
    .lt('used_count', Number(promo.max_uses || 1))
    .select('id')
    .single();

  if (error || !data) {
    // Lost the race (redeemed by someone else a moment earlier) — the
    // discount has already been applied to this Stripe session, which is
    // the same acceptable tradeoff the existing viral-share codes make
    // (consumed at session-creation time, not at confirmed-payment time).
    // Logged, not thrown, so a rare double-attempt doesn't break checkout.
    console.warn('Campaign promo code consume race or already used:', promo.code);
  }
}

function getBaseUrl(req) {
  const host = req.get('host') || '';
  const forwardedProto = req.get('x-forwarded-proto');
  const protocol = forwardedProto || req.protocol || 'http';

  if (/^localhost(?::\d+)?$/i.test(host) || /^127\.0\.0\.1(?::\d+)?$/i.test(host)) {
    return `${protocol}://${host}`;
  }

  return process.env.APP_URL || 'http://localhost:3000';
}

function normalizePayload(body, requestIp) {
  const productTier = String(body.productTier || '').trim().toLowerCase();
  const deliveryOptionRaw = String(body.deliveryOption || '').trim().toLowerCase();
  const promoCode = String(body.promoCode || '').trim();
  const referralCode = String(body.referralCode || '').trim();

  if (!PRODUCT_TIERS[productTier]) {
    throw new Error('Invalid product tier.');
  }

  // Digital-only for the public portal for now (new_changes.md bug #12,
  // client decision, 7 Aug 2026) — Standard/Premium are hidden in the
  // checkout UI, but this is the actual enforcement: a direct API request
  // bypassing the frontend can't select a tier that isn't for sale.
  if (productTier !== 'digital') {
    throw new Error('This product option is not currently available. Digital is the only option right now.');
  }

  const needsFulfilment = PRODUCT_TIERS[productTier].needsFulfilment;
  const deliveryOption = needsFulfilment ? (deliveryOptionRaw || 'standard') : null;

  if (deliveryOption && !DELIVERY_OPTIONS[deliveryOption]) {
    throw new Error('Invalid delivery option.');
  }

  if (!body.customerName || !String(body.customerName).trim()) {
    throw new Error('Customer name is required.');
  }
  if (!body.customerEmail || !String(body.customerEmail).trim()) {
    throw new Error('Customer email is required.');
  }
  const keepsakeId = body.keepsakeId || null;
  const recipientName = String(body.recipientName || '').trim();
  const dateOfBirth = String(body.dateOfBirth || '').trim();
  const country = String(body.country || '').trim();

  if (!keepsakeId && !recipientName) {
    throw new Error('Recipient name is required.');
  }
  if (!keepsakeId && !dateOfBirth) {
    throw new Error('Date is required.');
  }
  if (country && !SUPPORTED_COUNTRIES.includes(country)) {
    throw new Error('Unsupported country.');
  }

  if (needsFulfilment) {
    validateShippingFields(body);
  }

  return {
    keepsakeId,
    productTier,
    deliveryOption,
    promoCode,
    referralCode,
    customerName: String(body.customerName).trim(),
    customerEmail: String(body.customerEmail).trim(),
    marketingConsent: body.marketingConsent !== false,
    recipientName,
    dateOfBirth,
    country,
    residenceCountry: String(body.residenceCountry || '').trim() || null,
    occasion: String(body.occasion || 'Birthday').trim(),
    senderName: String(body.senderName || '').trim() || null,
    stationName: String(body.stationName || '').trim() || null,
    personalMessage: String(body.personalMessage || '').trim() || null,
    renderedHtml: typeof body.renderedHtml === 'string' ? body.renderedHtml : null,
    generatedContent: body.generatedContent && typeof body.generatedContent === 'object' ? body.generatedContent : null,
    requestIp: requestIp || body.requestIp || null,
    shippingName: String(body.shippingName || body.customerName || '').trim() || null,
    shippingAddressLine1: String(body.shippingAddressLine1 || '').trim() || null,
    shippingAddressLine2: String(body.shippingAddressLine2 || '').trim() || null,
    shippingCity: String(body.shippingCity || '').trim() || null,
    shippingRegion: String(body.shippingRegion || '').trim() || null,
    shippingPostcode: String(body.shippingPostcode || '').trim() || null,
    shippingCountry: String(body.shippingCountry || country || 'New Zealand').trim(),
  };
}

async function enrichPayloadFromExistingKeepsake(supabase, payload) {
  if (!payload.keepsakeId) {
    return payload;
  }

  const { data, error } = await supabase
    .from('keepsakes')
    .select('listener_name, listener_dob, country, occasion, sender_name, station_name, dj_message, rendered_html, content, promo_code_id, sales_consultant_id, is_free_demo')
    .eq('id', payload.keepsakeId)
    .single();

  if (error || !data) {
    throw new Error('Unable to find the existing keepsake for this order.');
  }

  return {
    ...payload,
    recipientName: payload.recipientName || data.listener_name,
    dateOfBirth: payload.dateOfBirth || data.listener_dob,
    country: payload.country || data.country,
    occasion: payload.occasion || data.occasion || 'Birthday',
    senderName: payload.senderName || data.sender_name,
    stationName: payload.stationName || data.station_name,
    personalMessage: payload.personalMessage || data.dj_message,
    renderedHtml: payload.renderedHtml || data.rendered_html,
    generatedContent: payload.generatedContent || data.content,
    existingKeepsake: data,
  };
}

function validateShippingFields(body) {
  const required = [
    ['shippingName', 'Shipping name'],
    ['shippingAddressLine1', 'Shipping address'],
    ['shippingCity', 'Shipping city'],
    ['shippingPostcode', 'Shipping postcode'],
    ['shippingCountry', 'Shipping country'],
  ];

  for (const [field, label] of required) {
    if (!body[field] || !String(body[field]).trim()) {
      throw new Error(`${label} is required for printed orders.`);
    }
  }
}

async function createKeepsakeIfNeeded(supabase, payload, attribution = {}) {
  if (!payload.renderedHtml) {
    throw new Error('Generated keepsake preview is required before checkout.');
  }

  const record = await saveKeepsakeRecord(supabase, {
    sourcePortal: SOURCE_PORTALS.public,
    edition: SOURCE_PORTALS.public,
    occasion: payload.occasion,
    recipientName: payload.recipientName,
    dateOfBirth: payload.dateOfBirth,
    country: payload.country,
    residenceCountry: payload.residenceCountry,
    senderName: payload.senderName,
    stationName: payload.stationName,
    customerName: payload.customerName,
    customerEmail: payload.customerEmail,
    personalMessage: payload.personalMessage,
    content: payload.generatedContent,
    renderedHtml: payload.renderedHtml,
    watermarkStatus: WATERMARK_STATUS.samplePreview,
    promoCodeId: attribution.promoCodeId || null,
    salesConsultantId: attribution.salesConsultantId || null,
    isFreeDemo: false,
    requestIp: payload.requestIp,
  });

  return record.id;
}

async function createPendingOrder({ supabase, keepsakeId, orderNumber, payload, tier, delivery, attribution = {} }) {
  const needsFulfilment = Boolean(tier.needsFulfilment);
  const deliveryPriority = needsFulfilment ? (delivery ? delivery.priority : DELIVERY_OPTIONS.standard.priority) : 99;
  const deliveryCode = needsFulfilment ? (payload.deliveryOption || 'standard') : null;
  const surcharge = delivery ? delivery.surchargeNzd : 0;
  const total = Number((tier.priceNzd + surcharge).toFixed(2));

  const insertPayload = {
    keepsake_id: keepsakeId,
    order_number: orderNumber,
    source_portal: SOURCE_PORTALS.public,
    customer_name: payload.customerName,
    customer_email: payload.customerEmail,
    recipient_name: payload.recipientName,
    product_tier: payload.productTier,
    delivery_option: deliveryCode,
    queue_status: needsFulfilment ? 'pending' : null,
    payment_status: PAYMENT_STATUS.pending,
    attribution_source: attribution.attributionSource || ATTRIBUTION_SOURCE.none,
    promo_code_id: attribution.promoCodeId || null,
    sales_consultant_id: attribution.salesConsultantId || null,
    territory_id: attribution.territoryId || null,
    needs_fulfilment: needsFulfilment,
    delivery_priority: deliveryPriority,
    currency_code: PHASE2_CONFIG.defaultCurrencyCode,
    base_amount_nzd: tier.priceNzd,
    delivery_surcharge_nzd: surcharge,
    total_amount_nzd: total,
    packaging_notes: tier.packagingNotes,
    includes_frame: Boolean(tier.includesFrame),
    shipping_name: needsFulfilment ? payload.shippingName : null,
    shipping_address_line1: needsFulfilment ? payload.shippingAddressLine1 : null,
    shipping_address_line2: needsFulfilment ? payload.shippingAddressLine2 : null,
    shipping_city: needsFulfilment ? payload.shippingCity : null,
    shipping_region: needsFulfilment ? payload.shippingRegion : null,
    shipping_postcode: needsFulfilment ? payload.shippingPostcode : null,
    shipping_country: needsFulfilment ? payload.shippingCountry : null,
    notes: buildAttributionNote(payload, attribution),
  };

  const { data, error } = await supabase
    .from('orders')
    .insert(insertPayload)
    .select('*')
    .single();

  if (error) {
    throw new Error(`Unable to create order: ${error.message}`);
  }

  return data;
}

function buildLineItems(tier, delivery) {
  const items = [
    {
      price_data: {
        currency: 'nzd',
        unit_amount: tier.priceCents,
        product_data: {
          name: `The Tribute Times - ${tier.label}`,
        },
      },
      quantity: 1,
    },
  ];

  if (delivery && delivery.surchargeCents > 0) {
    items.push({
      price_data: {
        currency: 'nzd',
        unit_amount: delivery.surchargeCents,
        product_data: {
          name: `Delivery Upgrade - ${delivery.label}`,
        },
      },
      quantity: 1,
    });
  }

  return items;
}

function buildAttributionNote(payload, attribution) {
  if (attribution.attributionSource === ATTRIBUTION_SOURCE.promoCode) {
    const code = attribution.promoCode || payload.promoCode || 'existing keepsake promo';
    return `Attribution: promo code ${code}.`;
  }
  if (attribution.attributionSource === ATTRIBUTION_SOURCE.postcode) {
    return `Attribution: postcode territory matched from ${payload.shippingPostcode || 'checkout postcode'}.`;
  }
  if (attribution.attributionSource === ATTRIBUTION_SOURCE.manual) {
    return 'Attribution: inherited from existing keepsake.';
  }
  if (attribution.attributionSource === ATTRIBUTION_SOURCE.referral) {
    return 'Attribution: inherited from referral link (Share the Love).';
  }
  return null;
}

async function loadPublicOrder(supabase, orderId) {
  const { data, error } = await supabase
    .from('orders')
    .select(`
      *,
      keepsakes (
        id,
        listener_dob,
        country,
        occasion,
        sender_name,
        station_name,
        dj_message,
        rendered_html,
        pdf_path,
        watermark_status
      )
    `)
    .eq('id', orderId)
    .eq('source_portal', SOURCE_PORTALS.public)
    .single();

  if (error || !data) {
    throw new Error('Public order not found.');
  }

  return data;
}

async function resolvePublicOrderStatus({ stripe, supabase, sendEmail, order }) {
  if (!order || order.payment_status === PAYMENT_STATUS.paid || !order.stripe_checkout_session_id) {
    return order;
  }

  const session = await stripe.checkout.sessions.retrieve(order.stripe_checkout_session_id);

  if (session.payment_status === 'paid') {
    return reconcilePublicOrderPaymentFromSession({ stripe, supabase, sendEmail, session });
  }

  if (session.status === 'expired') {
    await supabase
      .from('orders')
      .update({ payment_status: PAYMENT_STATUS.cancelled })
      .eq('id', order.id)
      .eq('payment_status', PAYMENT_STATUS.pending);

    return loadPublicOrder(supabase, order.id);
  }

  return order;
}

async function reconcilePublicOrderPaymentFromSession({ stripe, supabase, sendEmail, session }) {
  if (!session?.metadata || session.metadata.type !== 'public_order') {
    return null;
  }

  const order = await loadPublicOrder(supabase, session.metadata.order_id);
  if (order.payment_status === PAYMENT_STATUS.paid) {
    return order;
  }

  const paidAt = new Date().toISOString();
  const { data: updatedRows, error } = await supabase
    .from('orders')
    .update({
      payment_status: PAYMENT_STATUS.paid,
      paid_at: paidAt,
      stripe_payment_intent_id: session.payment_intent || null,
      customer_email: order.customer_email || session.customer_details?.email || null,
      customer_name: order.customer_name || session.customer_details?.name || null,
    })
    .eq('id', order.id)
    .eq('payment_status', PAYMENT_STATUS.pending)
    .select('*');

  if (error) {
    throw new Error(`Unable to mark public order as paid: ${error.message}`);
  }

  if (!updatedRows || updatedRows.length === 0) {
    return loadPublicOrder(supabase, order.id);
  }

  const updatedOrder = updatedRows[0];

  await updateKeepsakeRecord(supabase, order.keepsake_id, {
    watermarkStatus: WATERMARK_STATUS.cleanPaid,
    customerEmail: updatedOrder.customer_email,
    customerName: updatedOrder.customer_name,
  });

  if (updatedOrder.needs_fulfilment) {
    await supabase
      .from('fulfilment_events')
      .insert({
        order_id: updatedOrder.id,
        previous_status: null,
        new_status: 'pending',
        triggered_email: false,
        note: 'Public printed order paid and added to fulfilment queue.',
      });
  }

  if (sendEmail) {
    // Bug fix (found verifying the item 33 fix below): this was declared
    // inside the admin-email try block, so the new customer-email block
    // underneath threw ReferenceError: attachments is not defined on
    // every real paid order — caught by its own try/catch so it never
    // surfaced as a user-facing failure, but the customer confirmation
    // email was silently never sent. Hoisted out so both blocks share it.
    let attachments = [];
    try {
      try {
        const pdf = await generatePdfFromHtml({
          html: updatedOrder.keepsakes?.rendered_html || order.keepsakes?.rendered_html || '',
          fileStem: updatedOrder.order_number || 'tribute-times-public-order',
        });
        attachments = [{
          filename: `${updatedOrder.order_number || 'tribute-times-order'}.pdf`,
          content: pdf.pdfBuffer,
        }];
      } catch (pdfError) {
        console.error('Public order email PDF attachment failed:', pdfError);
      }

      await sendEmail({
        to: PHASE2_CONFIG.adminAlertEmail,
        subject: `New public order paid - ${updatedOrder.order_number}`,
        html: buildPublicOrderAdminEmail(updatedOrder),
        attachments,
      });
    } catch (emailError) {
      console.error('Public order admin email failed:', emailError);
    }

    // Fix, Oct 2026 (checklist item 33): the customer previously received
    // no confirmation of any kind for a card purchase — only this internal
    // admin alert above. Sent as its own try/catch (not nested inside the
    // admin-email one) so a failure here never blocks or gets blocked by
    // the admin notification; reuses the same PDF attachment already
    // generated above rather than rendering it twice.
    if (updatedOrder.customer_email) {
      try {
        await sendEmail({
          to: updatedOrder.customer_email,
          subject: `Your Tribute Times keepsake is ready - ${updatedOrder.order_number}`,
          html: buildPublicOrderCustomerEmail(updatedOrder, process.env.APP_URL || ''),
          attachments,
        });
      } catch (emailError) {
        console.error('Public order customer confirmation email failed:', emailError);
      }
    }
  }

  // ── MAILING LIST CAPTURE (new_changes.md Step 8) ──
  // Consent comes from the checkout-time checkbox, carried through on the
  // Stripe session metadata (no new database column needed) rather than
  // defaulting to true unconditionally, now that the Privacy Policy this
  // checkbox links to actually exists (Step 18).
  if (updatedOrder.customer_email) {
    await captureMarketingContact(supabase, {
      email: updatedOrder.customer_email,
      name: updatedOrder.customer_name,
      source: 'public_checkout',
      consented: session.metadata?.marketing_consent !== '0',
    });
  }

  // ── SECOND-PURCHASE DISCOUNT (new_changes.md Step 7) ──
  // Every completed direct-consumer purchase automatically gets a
  // follow-up discount code for a second keepsake. This block only ever
  // runs once per order: reaching this point already required the atomic
  // `payment_status = 'pending' -> 'paid'` update above to have won, so a
  // retried status check for an already-paid order returns early at the
  // top of this function and never reaches here again.
  if (stripe && sendEmail && updatedOrder.customer_email) {
    try {
      // Phase 7 — client request 21 Aug 2026 (Col, Scenario B): carries
      // this order's own attribution forward onto its auto-issued
      // follow-up code, so a second purchase using it still credits the
      // same consultant. `updatedOrder.sales_consultant_id` is already
      // available here (select('*') above) — no new lookup needed.
      // Correctly stays null for an organic (unattributed) sale.
      const discountCode = await issueSecondPurchaseDiscountCode({ supabase, stripe, consultantId: updatedOrder.sales_consultant_id });
      await sendEmail({
        to: updatedOrder.customer_email,
        subject: 'A thank-you discount for your next Tribute Times keepsake',
        html: buildSecondPurchaseDiscountEmail({
          customerName: updatedOrder.customer_name,
          code: discountCode.code,
          discountPercent: SECOND_PURCHASE_DISCOUNT_PERCENT,
          validUntil: discountCode.valid_until,
          appUrl: process.env.APP_URL || '',
        }),
      });
    } catch (discountError) {
      console.error('Second-purchase discount email failed:', discountError);
    }
  }

  return loadPublicOrder(supabase, updatedOrder.id);
}

function buildPublicOrderResponse(order) {
  const keepsake = order.keepsakes || {};

  return {
    id: order.id,
    orderNumber: order.order_number,
    keepsakeId: order.keepsake_id,
    customerName: order.customer_name,
    customerEmail: order.customer_email,
    recipientName: order.recipient_name,
    productTier: order.product_tier,
    deliveryOption: order.delivery_option,
    paymentStatus: order.payment_status,
    needsFulfilment: Boolean(order.needs_fulfilment),
    totalAmountNzd: Number(order.total_amount_nzd || 0),
    shippingName: order.shipping_name,
    shippingAddressLine1: order.shipping_address_line1,
    shippingAddressLine2: order.shipping_address_line2,
    shippingCity: order.shipping_city,
    shippingRegion: order.shipping_region,
    shippingPostcode: order.shipping_postcode,
    shippingCountry: order.shipping_country,
    downloadPdfUrl: `/api/public/orders/${order.id}/download-pdf`,
    dateOfBirth: keepsake.listener_dob || null,
    country: keepsake.country || null,
    occasion: keepsake.occasion || null,
    senderName: keepsake.sender_name || null,
    stationName: keepsake.station_name || null,
    personalMessage: keepsake.dj_message || null,
    renderedHtml: keepsake.rendered_html || '',
    pdfPath: keepsake.pdf_path || null,
    watermarkStatus: keepsake.watermark_status || WATERMARK_STATUS.none,
  };
}

function throwStatus(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  registerPublicCheckoutRoutes,
  reconcilePublicOrderPaymentFromSession,
};
