'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const {
  PRODUCT_TIERS,
  DELIVERY_OPTIONS,
  SOURCE_PORTALS,
  PAYMENT_STATUS,
  ATTRIBUTION_SOURCE,
  SUPPORTED_COUNTRIES,
  WATERMARK_STATUS,
  FLORIST_CREDIT_PACK_TYPES,
  FLORIST_WHOLESALE_PRICING,
  FLORIST_WHOLESALE_MAX_QUANTITY,
} = require('./constants');
const { PHASE2_CONFIG } = require('./config');
const { getNextOrderNumber } = require('./order-number');
const { saveKeepsakeRecord, updateKeepsakeRecord } = require('./save-keepsake');
const { generatePdfFromHtml } = require('./pdf-service');
const {
  buildGcashPaymentRejectedEmail,
  buildGcashPromoApprovedEmail,
  buildGcashManualPaymentApprovedEmail,
  buildFrameOrderAdminEmail,
  buildPublicOrderAdminEmail,
  buildPublicOrderCustomerEmail,
  buildSecondPurchaseDiscountEmail,
} = require('./email-service');
const { normalizePromoCode } = require('./attribution');
const { getNzdToPhpRate } = require('./exchange-rate');
// Client request, 31 Aug 2026 (Col): "GCash should be operating as
// stripe is, is that correct?" — it wasn't. Two real gaps found on audit:
// a GCash-redeemed order never attributed back to the reseller/influencer
// whose code was used (sales_consultant_id was hardcoded null, twice —
// see createPaidPublicOrderFromGcashPromo and
// ensureCleanPaidKeepsakeForRedeem below), and it never sent the
// customer the same automatic Thank-You/second-purchase discount email
// the Stripe path already sends. Both fixed below, reusing the exact
// same functions the Stripe path already uses (second-purchase-discount.js,
// marketing-contacts.js) rather than writing a second version of either.
const { issueSecondPurchaseDiscountCode, SECOND_PURCHASE_DISCOUNT_PERCENT } = require('./second-purchase-discount');
const { captureMarketingContact } = require('./marketing-contacts');

function registerGcashPaymentRoutes(app, { supabase, sendEmail, authAdmin, stationBilling = {} }) {
  if (!app) throw new Error('Express app is required.');
  if (!supabase) throw new Error('Supabase client is required.');
  if (!authAdmin) throw new Error('Admin auth middleware is required.');
  const billing = normalizeStationBilling(stationBilling);

  app.get('/api/public/gcash/settings', async (req, res) => {
    return res.json(await getGcashSettings());
  });

  app.post('/api/public/gcash/payment-request', async (req, res) => {
    try {
      const rawPayload = normalizePublicGcashPayload(req.body || {}, req.ip);
      const payload = await enrichPayloadFromExistingKeepsake(supabase, rawPayload);
      const settings = await getGcashSettings();
      const request = await createGcashPaymentRequest({
        supabase,
        payload,
        gcashSenderName: req.body.gcashSenderName,
        gcashReferenceId: req.body.gcashReferenceId,
        settings,
      });

      if (sendEmail) {
        sendGcashAdminAlert({ sendEmail, request }).catch(error => {
          console.error('GCash admin alert email failed:', error);
        });
      }

      return res.json({
        request: buildGcashRequestResponse(request),
        settings,
        message: 'Payment proof received. After verification, your one-time promo code will be sent by email.',
      });
    } catch (error) {
      console.error('GCash payment request error:', error);
      return res.status(error.statusCode || 400).json({ error: error.message || 'Unable to save GCash payment request.' });
    }
  });

  app.post('/api/gcash/florist/credits/payment-request', async (req, res) => {
    try {
      const station = await loadAuthenticatedStationFromRequest(supabase, req, { accountType: ['florist', 'gift_shop', 'cake_shop'] });
      const settings = await getGcashSettings();
      const request = await createFloristCreditGcashPaymentRequest({
        supabase,
        station,
        body: req.body || {},
        settings,
      });

      if (sendEmail) {
        sendGcashAdminAlert({ sendEmail, request }).catch(error => {
          console.error('GCash florist credit admin alert email failed:', error);
        });
      }

      return res.json({
        request: buildGcashRequestResponse(request),
        settings,
        message: 'GCash payment proof received. After admin verification, credits will be added to this florist account.',
      });
    } catch (error) {
      console.error('GCash florist credit payment request error:', error);
      return res.status(error.statusCode || 400).json({ error: error.message || 'Unable to save GCash payment request.' });
    }
  });

  app.post('/api/gcash/station/subscription/payment-request', async (req, res) => {
    try {
      const station = await loadAuthenticatedStationFromRequest(supabase, req, { excludeAccountType: ['florist', 'gift_shop', 'cake_shop'] });
      const settings = await getGcashSettings();
      const request = await createStationSubscriptionGcashPaymentRequest({
        supabase,
        station,
        body: req.body || {},
        settings,
        billing,
      });

      if (sendEmail) {
        sendGcashAdminAlert({ sendEmail, request }).catch(error => {
          console.error('GCash station subscription admin alert email failed:', error);
        });
      }

      return res.json({
        request: buildGcashRequestResponse(request),
        settings,
        message: 'GCash payment proof received. After admin verification, the station plan will be activated.',
      });
    } catch (error) {
      console.error('GCash station subscription payment request error:', error);
      return res.status(error.statusCode || 400).json({ error: error.message || 'Unable to save GCash payment request.' });
    }
  });

  app.post('/api/gcash/station/frames/payment-request', async (req, res) => {
    try {
      const station = await loadAuthenticatedStationFromRequest(supabase, req, { excludeAccountType: ['florist', 'gift_shop', 'cake_shop'] });
      const settings = await getGcashSettings();
      const request = await createStationFrameGcashPaymentRequest({
        supabase,
        station,
        body: req.body || {},
        settings,
        billing,
      });

      if (sendEmail) {
        sendGcashAdminAlert({ sendEmail, request }).catch(error => {
          console.error('GCash station frame admin alert email failed:', error);
        });
      }

      return res.json({
        request: buildGcashRequestResponse(request),
        settings,
        message: 'GCash payment proof received. After admin verification, the frame order will be added.',
      });
    } catch (error) {
      console.error('GCash station frame payment request error:', error);
      return res.status(error.statusCode || 400).json({ error: error.message || 'Unable to save GCash payment request.' });
    }
  });

  app.get('/api/admin/gcash-payments', authAdmin, async (req, res) => {
    try {
      const page = Math.max(Number(req.query.page) || 1, 1);
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
      const status = String(req.query.status || '').trim().toLowerCase();
      const start = (page - 1) * limit;
      const end = start + limit - 1;

      let query = supabase
        .from('gcash_payment_requests')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(start, end);

      if (['pending', 'approved', 'rejected', 'cancelled'].includes(status)) {
        query = query.eq('status', status);
      }

      const { data, count, error } = await query;
      if (error) {
        throw new Error(`Unable to load GCash payment requests: ${error.message}`);
      }

      const promoById = await loadPromoCodeMapForRequests(supabase, data || []);

      return res.json({
        items: (data || []).map(row => buildGcashRequestResponse(row, promoById.get(row.generated_promo_code_id))),
        total: count || 0,
        page,
        limit,
      });
    } catch (error) {
      console.error('Admin GCash payment load error:', error);
      return res.status(400).json({ error: error.message || 'Unable to load GCash payments.' });
    }
  });

  app.patch('/api/admin/gcash-payments/:id/approve', authAdmin, async (req, res) => {
    try {
      const request = await loadGcashPaymentRequest(supabase, req.params.id);
      if (request.status === 'approved' && request.generated_promo_code_id) {
        const promo = await loadPromoCodeById(supabase, request.generated_promo_code_id);
        return res.json({
          request: buildGcashRequestResponse(request, promo),
          promoCode: promo,
          emailSent: false,
          alreadyApproved: true,
        });
      }
      if (request.status !== 'pending') {
        throwStatus(400, 'Only pending GCash payment requests can be approved.');
      }

      if (getPaymentContext(request) === 'public_order') {
        const promo = await createGcashPaidPromoCode({
          supabase,
          request,
          adminNote: req.body?.adminNote,
        });
        const reviewedAt = new Date().toISOString();
        const { data: updatedRequest, error: updateError } = await supabase
          .from('gcash_payment_requests')
          .update({
            status: 'approved',
            admin_note: String(req.body?.adminNote || '').trim() || null,
            reviewed_by_admin_id: req.admin.id,
            reviewed_at: reviewedAt,
            updated_at: reviewedAt,
            generated_promo_code_id: promo.id,
          })
          .eq('id', request.id)
          .eq('status', 'pending')
          .select('*')
          .single();

        if (updateError || !updatedRequest) {
          await supabase.from('promo_codes').delete().eq('id', promo.id).eq('used_count', 0);
          throw new Error(`Unable to approve GCash payment request: ${updateError?.message || 'request was already changed'}`);
        }

        let emailSent = false;
        if (sendEmail) {
          try {
            emailSent = await sendEmail({
              to: updatedRequest.customer_email,
              subject: 'Your Tribute Times GCash promo code',
              html: buildGcashPromoApprovedEmail({
                request: updatedRequest,
                promoCode: promo,
                appUrl: process.env.APP_URL || '',
              }),
            });
          } catch (emailError) {
            console.error('GCash promo approval email failed:', emailError);
          }
        }

        return res.json({
          request: buildGcashRequestResponse(updatedRequest, promo),
          promoCode: promo,
          emailSent: Boolean(emailSent),
        });
      }

      const approval = await approveAccountGcashPaymentRequest({
        supabase,
        sendEmail,
        request,
        adminId: req.admin.id,
        adminNote: req.body?.adminNote,
        billing,
      });

      return res.json(approval);
    } catch (error) {
      console.error('Admin GCash approve error:', error);
      return res.status(error.statusCode || 400).json({ error: error.message || 'Unable to approve GCash payment.' });
    }
  });

  // Fix, Oct 2026 (checklist item 38): no way existed to resend the GCash
  // approval email, which is the single real delivery mechanism for a
  // paid GCash customer's one-time redeem code — the most urgent real
  // case found for this gap, since (unlike the Stripe path) there is no
  // browser-redirect fallback at all on GCash. Lets an admin optionally
  // correct the customer's email (if it was typo'd) and re-sends the
  // exact same approval email, reusing the already-generated code rather
  // than creating a new one (a customer should never need a second code
  // just because the first email didn't arrive).
  app.post('/api/admin/gcash-payments/:id/resend', authAdmin, async (req, res) => {
    try {
      const request = await loadGcashPaymentRequest(supabase, req.params.id);
      if (request.status !== 'approved' || !request.generated_promo_code_id) {
        throwStatus(400, 'Only an already-approved GCash request with a generated code can be resent.');
      }

      const correctedEmail = String(req.body?.email || '').trim().toLowerCase();
      let targetRequest = request;
      if (correctedEmail && correctedEmail !== request.customer_email) {
        const { data: updatedRequest, error: updateError } = await supabase
          .from('gcash_payment_requests')
          .update({ customer_email: correctedEmail })
          .eq('id', request.id)
          .select('*')
          .single();
        if (updateError || !updatedRequest) {
          throw new Error(updateError?.message || 'Unable to update the request email.');
        }
        targetRequest = updatedRequest;

        // Bug fix (found verifying this fix): the generated code's own
        // locked_customer_email (checked at redemption time,
        // validateGcashPaidPromoForPayload() below) was left pinned to
        // the OLD email — correcting only the request's email would
        // resend to the right address but leave the customer unable to
        // actually redeem the code, since their real email wouldn't
        // match the stale lock.
        await supabase
          .from('promo_codes')
          .update({ locked_customer_email: correctedEmail })
          .eq('id', targetRequest.generated_promo_code_id);
      }

      const promo = await loadPromoCodeById(supabase, targetRequest.generated_promo_code_id);

      let emailSent = false;
      if (sendEmail) {
        try {
          emailSent = await sendEmail({
            to: targetRequest.customer_email,
            subject: 'Your Tribute Times GCash promo code',
            html: buildGcashPromoApprovedEmail({
              request: targetRequest,
              promoCode: promo,
              appUrl: process.env.APP_URL || '',
            }),
          });
        } catch (emailError) {
          console.error('GCash resend email failed:', emailError);
        }
      }

      return res.json({
        request: buildGcashRequestResponse(targetRequest, promo),
        promoCode: promo,
        emailSent: Boolean(emailSent),
      });
    } catch (error) {
      console.error('Admin GCash resend error:', error);
      return res.status(error.statusCode || 400).json({ error: error.message || 'Unable to resend GCash confirmation.' });
    }
  });

  app.patch('/api/admin/gcash-payments/:id/reject', authAdmin, async (req, res) => {
    try {
      const request = await loadGcashPaymentRequest(supabase, req.params.id);
      if (request.status === 'approved') {
        throwStatus(400, 'Approved GCash payment requests cannot be rejected.');
      }
      if (request.status === 'rejected') {
        return res.json({ request: buildGcashRequestResponse(request), emailSent: false, alreadyRejected: true });
      }

      const reviewedAt = new Date().toISOString();
      const adminNote = String(req.body?.adminNote || '').trim();
      const { data: updatedRequest, error } = await supabase
        .from('gcash_payment_requests')
        .update({
          status: 'rejected',
          admin_note: adminNote || null,
          reviewed_by_admin_id: req.admin.id,
          reviewed_at: reviewedAt,
          updated_at: reviewedAt,
        })
        .eq('id', request.id)
        .eq('status', 'pending')
        .select('*')
        .single();

      if (error || !updatedRequest) {
        throw new Error(`Unable to reject GCash payment request: ${error?.message || 'request was already changed'}`);
      }

      let emailSent = false;
      if (sendEmail) {
        try {
          emailSent = await sendEmail({
            to: updatedRequest.customer_email,
            subject: 'Your Tribute Times GCash payment review',
            html: buildGcashPaymentRejectedEmail({ request: updatedRequest }),
          });
        } catch (emailError) {
          console.error('GCash rejection email failed:', emailError);
        }
      }

      return res.json({ request: buildGcashRequestResponse(updatedRequest), emailSent: Boolean(emailSent) });
    } catch (error) {
      console.error('Admin GCash reject error:', error);
      return res.status(error.statusCode || 400).json({ error: error.message || 'Unable to reject GCash payment.' });
    }
  });
}

async function tryRedeemGcashPaidPromoCode({ supabase, sendEmail, stripe, payload }) {
  const code = normalizePromoCode(payload?.promoCode);
  if (!code) return null;
  if (!isGeneratedGcashPromoCode(code)) return null;

  const promo = await loadPromoCodeByCode(supabase, code);
  if (!promo || promo.code_type !== 'gcash_paid_access') {
    return null;
  }

  validateGcashPaidPromoForPayload(promo, payload);
  const consumedPromo = await consumeGcashPaidPromoCode(supabase, promo);

  try {
    const order = await createPaidPublicOrderFromGcashPromo({
      supabase,
      payload,
      promo: consumedPromo,
    });

    await supabase
      .from('promo_codes')
      .update({ used_order_id: order.id })
      .eq('id', consumedPromo.id);

    if (sendEmail) {
      sendGcashRedeemedAdminAlert({ sendEmail, order, payload }).catch(error => {
        console.error('GCash redeemed admin alert failed:', error);
      });
    }

    // Client request, 31 Aug 2026 (Col): "GCash should be operating as
    // stripe is." Both of these already run for the Stripe path
    // (reconcilePublicOrderPaymentFromSession, public-checkout.js) but
    // were missing entirely here — fire-and-forget with their own
    // try/catch each, same as the admin alert above, so a marketing-list
    // or email failure never blocks the redemption response the customer
    // is waiting on.
    if (order.customer_email) {
      captureMarketingContact(supabase, {
        email: order.customer_email,
        name: order.customer_name,
        source: 'public_checkout',
        consented: payload.marketingConsent !== false,
      }).catch(error => {
        console.error('GCash redeemed marketing capture failed:', error);
      });
    }

    if (stripe && sendEmail && order.customer_email) {
      (async () => {
        try {
          const discountCode = await issueSecondPurchaseDiscountCode({ supabase, stripe, consultantId: order.sales_consultant_id });
          await sendEmail({
            to: order.customer_email,
            subject: 'A thank-you discount for your next Tribute Times keepsake',
            html: buildSecondPurchaseDiscountEmail({
              customerName: order.customer_name,
              code: discountCode.code,
              discountPercent: SECOND_PURCHASE_DISCOUNT_PERCENT,
              validUntil: discountCode.valid_until,
              appUrl: process.env.APP_URL || '',
            }),
          });
        } catch (discountError) {
          console.error('GCash redeemed second-purchase discount email failed:', discountError);
        }
      })();
    }

    return {
      redeemed: true,
      paymentProvider: 'gcash_manual_promo',
      orderId: order.id,
      orderNumber: order.order_number,
      url: `/public?checkout=success&order=${encodeURIComponent(order.id)}`,
    };
  } catch (error) {
    await rollbackConsumedPromoCode(supabase, promo).catch(rollbackError => {
      console.error('GCash promo rollback failed:', rollbackError);
    });
    throw error;
  }
}

function normalizePublicGcashPayload(body, requestIp) {
  const productTier = String(body.productTier || '').trim().toLowerCase();
  const deliveryOptionRaw = String(body.deliveryOption || '').trim().toLowerCase();
  const customerName = String(body.customerName || body.gcashCustomerName || '').trim();
  const customerEmail = String(body.customerEmail || body.gcashCustomerEmail || '').trim().toLowerCase();
  const recipientName = String(body.recipientName || '').trim();
  const dateOfBirth = String(body.dateOfBirth || '').trim();
  const country = String(body.country || '').trim();

  if (!PRODUCT_TIERS[productTier]) {
    throwStatus(400, 'Invalid product tier.');
  }

  // Same Digital-only enforcement as the card-payment checkout
  // (src/phase2/public-checkout.js, bug #12) — found missing here while
  // verifying the GCash flat-price fix (11 Aug 2026): Standard/Premium
  // are hidden in the UI but weren't actually blocked at this endpoint,
  // so a direct API request could still request one via GCash.
  if (productTier !== 'digital') {
    throwStatus(400, 'This product option is not currently available. Digital is the only option right now.');
  }

  const needsFulfilment = PRODUCT_TIERS[productTier].needsFulfilment;
  const deliveryOption = needsFulfilment ? (deliveryOptionRaw || 'standard') : null;
  if (deliveryOption && !DELIVERY_OPTIONS[deliveryOption]) {
    throwStatus(400, 'Invalid delivery option.');
  }
  if (!customerName) {
    throwStatus(400, 'Customer name is required.');
  }
  if (!customerEmail) {
    throwStatus(400, 'Customer email is required.');
  }
  if (!body.keepsakeId && !recipientName) {
    throwStatus(400, 'Recipient name is required.');
  }
  if (!body.keepsakeId && !dateOfBirth) {
    throwStatus(400, 'Date is required.');
  }
  if (country && !SUPPORTED_COUNTRIES.includes(country)) {
    throwStatus(400, 'Unsupported country.');
  }
  if (needsFulfilment) {
    validateShippingFields(body);
  }

  return {
    keepsakeId: body.keepsakeId || null,
    productTier,
    deliveryOption,
    promoCode: String(body.promoCode || '').trim(),
    // Bug fix, 31 Aug 2026 (found during the GCash-attribution bug-hunt
    // pass, same class as the promoCode fix above): the frontend already
    // sends marketingConsent on this exact payload (buildCheckoutPayload()
    // in form-template.html — the same object openGcashModal() is called
    // with, spread straight into this endpoint's request body) but this
    // normalizer silently dropped it, so a GCash customer who unchecked
    // "send me updates" was still added to the marketing list, unlike the
    // Stripe path which correctly reads and respects this same checkbox.
    marketingConsent: body.marketingConsent !== false,
    customerName,
    customerEmail,
    recipientName,
    dateOfBirth,
    country,
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
    throwStatus(404, 'Unable to find the existing keepsake for this payment.');
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
      throwStatus(400, `${label} is required for printed orders.`);
    }
  }
}

// Bug fix, 1 Oct 2026 (urgent client request, Col: a live Facebook ad
// campaign — Tagalog creative, "50% OFF... ₱99 NGAYON... dati ₱199",
// code TT50OFF — was about to launch pointing customers at a promo code
// that structurally could not work). Investigation found the flat PHP
// price in createGcashPaymentRequest() below (`expectedAmountPhp`) had
// no discount mechanism at all — `campaign_single_use` codes (the admin
// "+ Create Codes" system, new_changes.md Step 8) only ever applied to
// the Stripe/NZD checkout path via resolveCampaignPromoCode() in
// public-checkout.js, which GCash payments never call. A customer typing
// TT50OFF into the GCash flow would have paid the full ₱199 with zero
// indication anything went wrong.
//
// This resolves the SAME `promo_codes` table / `campaign_single_use`
// rows the admin "+ Create Codes" screen already creates (so Col uses
// one familiar screen for both payment paths, not two separate code
// systems) but reads `discount_type`/`discount_value` directly instead
// of requiring a Stripe coupon — GCash payments never touch Stripe at
// all, so the Stripe-coupon requirement in resolveCampaignPromoCode()
// would be a dead end here even if it were reachable. Mirrors that
// function's validation checks (active, used_count, valid_until) but
// intentionally does NOT require `stripe_coupon_id` to be set, since a
// code meant for GCash-only use will never have one.
async function resolveGcashDiscountCode(supabase, code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return null;

  const { data, error } = await supabase
    .from('promo_codes')
    .select('id, code, used_count, max_uses, active, valid_until, discount_type, discount_value')
    .ilike('code', normalized)
    .eq('code_type', 'campaign_single_use')
    .maybeSingle();

  // Not a campaign code at all (wrong code_type, or genuinely doesn't
  // exist) — return null quietly rather than error, same principle as
  // resolveCampaignPromoCode: a typo'd/unrelated code string shouldn't
  // block the GCash flow, it just means no discount applies.
  if (error || !data) return null;

  if (!data.active || Number(data.used_count || 0) >= Number(data.max_uses || 1)) {
    throwStatus(400, 'This promo code has already been used.');
  }
  if (data.valid_until && new Date(data.valid_until) < new Date()) {
    throwStatus(400, 'This promo code has expired.');
  }
  if (!data.discount_type || !data.discount_value) {
    // A campaign code that exists but has no discount configured at all
    // (shouldn't happen via the admin UI, which requires a discount value
    // to create one, but guard against a malformed/manually-edited row)
    // — treat as "no discount," not a hard error, since this code might
    // validly be a Stripe-only code with no PHP-relevant fields set.
    return null;
  }

  return data;
}

// Applies a resolved discount code to a PHP amount, always rounded DOWN
// to the nearest whole peso. Bug fix, 1 Oct 2026 (found during final
// verification of TT50OFF before the live ad launch): rounding to the
// NEAREST peso meant ₱199 × 50% = ₱99.50 → ₱100, one peso more than the
// ad creative's literal "₱99 NGAYON" promise — a real mismatch between
// what the ad says and what the customer is actually charged. Floor
// guarantees the charged amount can never exceed what an ad promises,
// which is the safer direction to round when the two could ever
// disagree (a customer paying 1 peso less than advertised is a non-issue;
// paying 1 peso more than advertised is a real, avoidable discrepancy).
function applyPhpDiscount(baseAmountPhp, discountCode) {
  if (!discountCode || !Number.isFinite(baseAmountPhp)) return baseAmountPhp;

  if (discountCode.discount_type === 'percent') {
    const pct = Math.min(Math.max(Number(discountCode.discount_value) || 0, 0), 100);
    return Math.floor(baseAmountPhp * (1 - pct / 100));
  }
  if (discountCode.discount_type === 'fixed') {
    // `discount_value` for fixed-amount codes is stored in NZD elsewhere
    // in this codebase (admin-fulfilment.js's Stripe coupon creation uses
    // it directly as NZD cents) — there's no PHP-fixed-amount concept, so
    // a fixed-type code is intentionally not applied here to avoid
    // silently treating an NZD figure as a peso figure. Percent-type
    // codes (TT50OFF's case) are the only kind this function discounts.
    return baseAmountPhp;
  }
  return baseAmountPhp;
}

// Atomically marks a promo code as consumed (mirrors consumeCampaignPromoCode
// in public-checkout.js) — called only after the GCash payment request row
// has been successfully inserted, so a failed insert never burns the code.
async function consumeGcashDiscountCode(supabase, discountCode, requestId) {
  if (!discountCode) return;
  const { error } = await supabase
    .from('promo_codes')
    .update({
      used_count: Number(discountCode.used_count || 0) + 1,
      used_at: new Date().toISOString(),
      active: Number(discountCode.used_count || 0) + 1 >= Number(discountCode.max_uses || 1) ? false : true,
    })
    .eq('id', discountCode.id)
    .eq('active', true)
    .lt('used_count', Number(discountCode.max_uses || 1));

  if (error) {
    console.error('GCash discount code consume failed:', discountCode.code, error);
  }
}

async function createGcashPaymentRequest({ supabase, payload, gcashSenderName, gcashReferenceId, settings }) {
  const senderName = String(gcashSenderName || '').trim();
  const referenceId = String(gcashReferenceId || '').trim();
  if (!senderName) {
    throwStatus(400, 'GCash sender name is required.');
  }
  if (!referenceId) {
    throwStatus(400, 'GCash transaction/reference ID is required.');
  }

  const keepsakeId = payload.keepsakeId || await createSampleKeepsakeForGcashRequest(supabase, payload);
  const pricing = calculateProductPricing(payload.productTier, payload.deliveryOption);
  // Client decision, 11 Aug 2026: GCash + Digital product only pays a
  // flat PHP 199, not the live exchange-rate conversion — matches the
  // fixed amount shown to the customer in the checkout modal
  // (public/form-template.html, openGcashModal). Scoped strictly to
  // `productTier === 'digital'` in this one function (the public product
  // order path) — florist credits and station frames use the separate
  // `createAccountGcashPaymentRequest` function below and are untouched.
  const baseAmountPhp = payload.productTier === 'digital'
    ? 199
    : settings.phpPerNzd
    ? Number((pricing.totalAmountNzd * settings.phpPerNzd).toFixed(2))
    : null;

  // Bug fix, 1 Oct 2026 (see resolveGcashDiscountCode above for the full
  // story — urgent ad-campaign promo code, TT50OFF): the flat PHP price
  // above had no discount mechanism at all before this. Resolve against
  // the same promo_codes the admin screen creates, discount the PHP
  // amount if a valid percent-type code was entered, and consume it only
  // after the insert below actually succeeds.
  const gcashDiscountCode = await resolveGcashDiscountCode(supabase, payload.promoCode);
  const expectedAmountPhp = baseAmountPhp !== null
    ? applyPhpDiscount(baseAmountPhp, gcashDiscountCode)
    : null;

  const insertPayload = {
    request_number: generateRequestNumber(),
    payment_context: 'public_order',
    keepsake_id: keepsakeId,
    customer_name: payload.customerName,
    customer_email: payload.customerEmail,
    recipient_name: payload.recipientName,
    product_tier: payload.productTier,
    delivery_option: pricing.needsFulfilment ? (payload.deliveryOption || 'standard') : null,
    currency_code: 'NZD',
    expected_amount_nzd: pricing.totalAmountNzd,
    expected_amount_php: expectedAmountPhp,
    exchange_rate_php_per_nzd: settings.phpPerNzd || null,
    exchange_rate_source: settings.rateSource || null,
    exchange_rate_date: settings.rateDate ? String(settings.rateDate) : null,
    exchange_rate_is_live: Boolean(settings.rateIsLive),
    gcash_payee_name: settings.accountName || null,
    gcash_mobile_number: settings.mobileNumber || null,
    gcash_sender_name: senderName,
    gcash_reference_id: referenceId,
    status: 'pending',
    // Bug fix, 31 Aug 2026 (client audit, Col: "GCash should be operating
    // as stripe is"): found the actual root cause of the missing
    // reseller/influencer attribution on GCash sales — the customer's
    // typed-in promo code (checkoutPromoCode on the main form, carried
    // straight through into payload.promoCode here — confirmed already
    // wired end-to-end on the frontend, see proceedToPayment() in
    // form-template.html) was simply never being SAVED anywhere on this
    // request row, so it no longer existed by the time an admin approved
    // it and generated the one-time redeem code. No new column needed —
    // reusing action_payload, the same general-purpose jsonb bucket
    // already used for florist-credit/station-frame request details.
    // See createGcashPaidPromoCode() below for where this is read back
    // out and actually resolved to a consultant_id.
    action_payload: { promoCode: payload.promoCode || null },
  };

  const { data, error } = await supabase
    .from('gcash_payment_requests')
    .insert(insertPayload)
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') {
      throwStatus(409, 'This GCash transaction/reference ID has already been submitted.');
    }
    throw new Error(`Unable to save GCash payment request: ${error.message}`);
  }

  // Consume the discount code only now that the request row genuinely
  // exists — a failed insert above (e.g. duplicate reference ID) never
  // burns the code, matching the same "consume after success" principle
  // used by the Stripe/NZD path's consumeCampaignPromoCode.
  await consumeGcashDiscountCode(supabase, gcashDiscountCode, data.id);

  return data;
}

// PAY-AS-YOU-USE WHOLESALE CREDITS — client decision, 19-20 Aug 2026 (Col).
// Replaces the fixed-pack version — body now carries {packType, quantity}
// instead of {packType, packSize}.
async function createFloristCreditGcashPaymentRequest({ supabase, station, body, settings }) {
  const purchase = calculateWholesaleCreditPurchase(body.packType, body.quantity);
  const label = `${purchase.packType.label} wholesale credits × ${purchase.quantity}`;
  return createAccountGcashPaymentRequest({
    supabase,
    settings,
    context: 'florist_credits',
    station,
    customerName: String(body.customerName || station.name || '').trim(),
    customerEmail: String(body.customerEmail || station.email || '').trim().toLowerCase(),
    itemLabel: label,
    itemCode: `${purchase.packType.code}:${purchase.quantity}`,
    quantity: purchase.quantity,
    totalAmountNzd: purchase.totalNzd,
    actionPayload: {
      packType: purchase.packType.code,
      credits: purchase.quantity,
      unitPriceNzd: purchase.unitPriceNzd,
      totalNzd: purchase.totalNzd,
    },
    gcashSenderName: body.gcashSenderName,
    gcashReferenceId: body.gcashReferenceId,
  });
}

async function createStationSubscriptionGcashPaymentRequest({ supabase, station, body, settings, billing }) {
  const tierCode = String(body.tier || '').trim().toLowerCase();
  const interval = normalizeBillingInterval(body.interval);
  const tier = billing.tiers[tierCode];
  if (!tier) {
    throwStatus(400, 'Invalid station plan.');
  }

  const amountCents = interval === 'annual' ? tier.annual : tier.monthly;
  const totalAmountNzd = Number((amountCents / 100).toFixed(2));
  const intervalLabel = interval === 'annual' ? 'annual' : 'monthly';

  return createAccountGcashPaymentRequest({
    supabase,
    settings,
    context: 'station_subscription',
    station,
    customerName: String(body.customerName || station.name || '').trim(),
    customerEmail: String(body.customerEmail || station.email || '').trim().toLowerCase(),
    itemLabel: `${tier.label} station plan (${intervalLabel})`,
    itemCode: `${tierCode}:${interval}`,
    quantity: 1,
    totalAmountNzd,
    actionPayload: {
      tier: tierCode,
      interval,
      label: tier.label,
      amountCents,
      priceNzd: totalAmountNzd,
    },
    gcashSenderName: body.gcashSenderName,
    gcashReferenceId: body.gcashReferenceId,
  });
}

async function createStationFrameGcashPaymentRequest({ supabase, station, body, settings, billing }) {
  const qty = Math.max(parseInt(body.quantity, 10) || billing.frames.minQty, billing.frames.minQty);
  const delivery = normalizeFrameDelivery(body);
  const subtotal = qty * billing.frames.unitPriceNzd;
  const gst = subtotal * billing.frames.gstRate;
  const totalAmountNzd = Number((subtotal + gst).toFixed(2));

  return createAccountGcashPaymentRequest({
    supabase,
    settings,
    context: 'station_frames',
    station,
    customerName: String(body.customerName || station.name || '').trim(),
    customerEmail: String(body.customerEmail || station.email || '').trim().toLowerCase(),
    itemLabel: `${qty} Tribute Times clip frames`,
    itemCode: `frames:${qty}`,
    quantity: qty,
    totalAmountNzd,
    actionPayload: {
      quantity: qty,
      unitPriceNzd: billing.frames.unitPriceNzd,
      gstNzd: Number(gst.toFixed(2)),
      totalNzd: totalAmountNzd,
      ...delivery,
    },
    gcashSenderName: body.gcashSenderName,
    gcashReferenceId: body.gcashReferenceId,
  });
}

async function createAccountGcashPaymentRequest({
  supabase,
  settings,
  context,
  station,
  customerName,
  customerEmail,
  itemLabel,
  itemCode,
  quantity,
  totalAmountNzd,
  actionPayload,
  gcashSenderName,
  gcashReferenceId,
}) {
  const senderName = String(gcashSenderName || '').trim();
  const referenceId = String(gcashReferenceId || '').trim();
  if (!senderName) {
    throwStatus(400, 'GCash sender name is required.');
  }
  if (!referenceId) {
    throwStatus(400, 'GCash transaction/reference ID is required.');
  }
  if (!station?.id) {
    throwStatus(400, 'Station account is required.');
  }
  if (!String(customerName || '').trim()) {
    throwStatus(400, 'Customer name is required.');
  }
  if (!String(customerEmail || '').trim()) {
    throwStatus(400, 'Customer email is required.');
  }

  const expectedAmountPhp = settings.phpPerNzd
    ? Number((Number(totalAmountNzd || 0) * settings.phpPerNzd).toFixed(2))
    : null;

  const insertPayload = {
    request_number: generateRequestNumber(),
    payment_context: context,
    station_id: station.id,
    customer_name: customerName,
    customer_email: customerEmail,
    recipient_name: station.name,
    product_tier: null,
    delivery_option: null,
    item_label: itemLabel,
    item_code: itemCode,
    quantity: quantity || null,
    action_payload: actionPayload || {},
    currency_code: 'NZD',
    expected_amount_nzd: Number(totalAmountNzd || 0),
    expected_amount_php: expectedAmountPhp,
    exchange_rate_php_per_nzd: settings.phpPerNzd || null,
    exchange_rate_source: settings.rateSource || null,
    exchange_rate_date: settings.rateDate ? String(settings.rateDate) : null,
    exchange_rate_is_live: Boolean(settings.rateIsLive),
    gcash_payee_name: settings.accountName || null,
    gcash_mobile_number: settings.mobileNumber || null,
    gcash_sender_name: senderName,
    gcash_reference_id: referenceId,
    status: 'pending',
  };

  const { data, error } = await supabase
    .from('gcash_payment_requests')
    .insert(insertPayload)
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') {
      throwStatus(409, 'This GCash transaction/reference ID has already been submitted.');
    }
    throw new Error(`Unable to save GCash payment request: ${error.message}`);
  }

  return data;
}

async function approveAccountGcashPaymentRequest({ supabase, sendEmail, request, adminId, adminNote, billing }) {
  const approvedAt = new Date().toISOString();
  const note = String(adminNote || '').trim();
  const { data: approvedRequest, error: approvalError } = await supabase
    .from('gcash_payment_requests')
    .update({
      status: 'approved',
      admin_note: note || null,
      reviewed_by_admin_id: adminId,
      reviewed_at: approvedAt,
      updated_at: approvedAt,
    })
    .eq('id', request.id)
    .eq('status', 'pending')
    .select('*')
    .single();

  if (approvalError || !approvedRequest) {
    throw new Error(`Unable to approve GCash payment request: ${approvalError?.message || 'request was already changed'}`);
  }

  let actionApplied = false;
  try {
    const result = await applyApprovedAccountGcashPayment({ supabase, request: approvedRequest, billing });
    actionApplied = true;
    const appliedAt = new Date().toISOString();
    const { data: finalRequest, error: finalError } = await supabase
      .from('gcash_payment_requests')
      .update({
        applied_at: appliedAt,
        applied_result: result,
        updated_at: appliedAt,
      })
      .eq('id', approvedRequest.id)
      .select('*')
      .single();

    if (finalError || !finalRequest) {
      throw new Error(`GCash payment was approved but the request result could not be saved: ${finalError?.message || 'missing request'}`);
    }

    let emailSent = false;
    if (sendEmail) {
      try {
        emailSent = await sendEmail({
          to: finalRequest.customer_email,
          subject: 'Your Tribute Times GCash payment is approved',
          html: buildGcashManualPaymentApprovedEmail({ request: finalRequest, result }),
        });
      } catch (emailError) {
        console.error('GCash manual approval email failed:', emailError);
      }

      if (getPaymentContext(finalRequest) === 'station_frames') {
        sendGcashFrameOrderAdminAlert({ sendEmail, request: finalRequest, result }).catch(emailError => {
          console.error('GCash frame order admin email failed:', emailError);
        });
      }
    }

    return {
      request: buildGcashRequestResponse(finalRequest),
      applied: result,
      emailSent: Boolean(emailSent),
    };
  } catch (error) {
    if (!actionApplied) {
      await supabase
        .from('gcash_payment_requests')
        .update({
          status: 'pending',
          admin_note: `Approval failed before applying: ${error.message}`,
          reviewed_by_admin_id: null,
          reviewed_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', approvedRequest.id)
        .is('applied_at', null);
    }
    throw error;
  }
}

async function applyApprovedAccountGcashPayment({ supabase, request, billing }) {
  const context = getPaymentContext(request);
  if (context === 'florist_credits') {
    return applyFloristCreditGcashApproval({ supabase, request });
  }
  if (context === 'station_subscription') {
    return applyStationSubscriptionGcashApproval({ supabase, request, billing });
  }
  if (context === 'station_frames') {
    return applyStationFrameGcashApproval({ supabase, request, billing });
  }
  throwStatus(400, `Unsupported GCash payment context: ${context}`);
}

async function applyFloristCreditGcashApproval({ supabase, request }) {
  const payload = parseActionPayload(request.action_payload);
  const credits = Number(payload.credits || payload.packSize || request.quantity || 0);
  if (!credits || credits < 1) {
    throw new Error('GCash florist credit request is missing credit quantity.');
  }

  const { data: station, error: stationError } = await supabase
    .from('stations')
    .select('id, name, email, florist_credit_balance')
    .eq('id', request.station_id)
    .single();

  if (stationError || !station) {
    throw new Error('Florist account not found for this GCash request.');
  }

  const newBalance = Number(station.florist_credit_balance || 0) + credits;
  const { error } = await supabase
    .from('stations')
    .update({
      florist_credit_balance: newBalance,
      florist_last_pack_size: credits,
      florist_credit_updated_at: new Date().toISOString(),
    })
    .eq('id', station.id);

  if (error) {
    throw new Error(`Unable to add florist credits: ${error.message}`);
  }

  return {
    type: 'florist_credits',
    stationId: station.id,
    creditsAdded: credits,
    newBalance,
  };
}

async function applyStationSubscriptionGcashApproval({ supabase, request, billing }) {
  const payload = parseActionPayload(request.action_payload);
  const tierCode = String(payload.tier || '').trim().toLowerCase();
  const interval = normalizeBillingInterval(payload.interval);
  const tier = billing.tiers[tierCode];
  if (!tier) {
    throw new Error('GCash station subscription request has an invalid plan.');
  }

  const { error } = await supabase
    .from('stations')
    .update({
      subscription_status: 'active',
      tier: tierCode,
      billing_interval: interval,
    })
    .eq('id', request.station_id);

  if (error) {
    throw new Error(`Unable to activate station subscription: ${error.message}`);
  }

  return {
    type: 'station_subscription',
    stationId: request.station_id,
    tier: tierCode,
    tierLabel: tier.label,
    interval,
  };
}

async function applyStationFrameGcashApproval({ supabase, request, billing }) {
  const payload = parseActionPayload(request.action_payload);
  const qty = Math.max(parseInt(payload.quantity, 10) || billing.frames.minQty, billing.frames.minQty);
  const subtotal = qty * billing.frames.unitPriceNzd;
  const gst = subtotal * billing.frames.gstRate;
  const total = subtotal + gst;

  const insertPayload = {
    station_id: request.station_id,
    quantity: qty,
    unit_price_nzd: billing.frames.unitPriceNzd,
    gst_nzd: Number(gst.toFixed(2)),
    total_nzd: Number(total.toFixed(2)),
    status: 'paid',
    delivery_name: payload.deliveryName || request.customer_name,
    delivery_address: payload.deliveryAddress || '',
    delivery_city: payload.deliveryCity || '',
    delivery_postcode: payload.deliveryPostcode || '',
    delivery_country: payload.deliveryCountry || 'New Zealand',
    payment_provider: 'gcash_manual',
    gcash_payment_request_id: request.id,
  };

  const { data: frameOrder, error } = await supabase
    .from('frame_orders')
    .insert(insertPayload)
    .select('*')
    .single();

  if (error) {
    throw new Error(`Unable to create frame order: ${error.message}`);
  }

  const { data: station } = await supabase
    .from('stations')
    .select('frames_in_stock')
    .eq('id', request.station_id)
    .single();

  await supabase
    .from('stations')
    .update({ frames_in_stock: Number(station?.frames_in_stock || 0) + qty })
    .eq('id', request.station_id);

  return {
    type: 'station_frames',
    stationId: request.station_id,
    frameOrderId: frameOrder.id,
    quantity: qty,
  };
}

async function createSampleKeepsakeForGcashRequest(supabase, payload) {
  if (!payload.renderedHtml) {
    throwStatus(400, 'Generated keepsake preview is required before GCash payment.');
  }

  const record = await saveKeepsakeRecord(supabase, {
    sourcePortal: SOURCE_PORTALS.public,
    edition: SOURCE_PORTALS.public,
    occasion: payload.occasion,
    recipientName: payload.recipientName,
    dateOfBirth: payload.dateOfBirth,
    country: payload.country,
    senderName: payload.senderName,
    stationName: payload.stationName,
    customerName: payload.customerName,
    customerEmail: payload.customerEmail,
    personalMessage: payload.personalMessage,
    content: payload.generatedContent,
    renderedHtml: payload.renderedHtml,
    watermarkStatus: WATERMARK_STATUS.samplePreview,
    isFreeDemo: false,
    requestIp: payload.requestIp,
  });

  return record.id;
}

// Bug fix, 31 Aug 2026 (client audit, Col: "GCash should be operating as
// stripe is") — looks up which reseller/influencer the customer's
// originally-typed promo code (now saved on the request's action_payload,
// see createGcashPaymentRequest above) belongs to, so the new one-time
// GCash-redeem code can be linked back to them. Returns null (not a
// throw) for a missing/invalid/unknown code — an organic GCash sale with
// no code typed in must still succeed exactly as before, same as the
// Stripe path's own graceful "no attribution" fallback.
async function resolveConsultantIdFromRequestPromoCode(supabase, request) {
  const actionPayload = parseActionPayload(request.action_payload);
  const typedCode = normalizePromoCode(actionPayload?.promoCode);
  if (!typedCode) return null;

  try {
    const { data } = await supabase
      .from('promo_codes')
      .select('consultant_id, active')
      .ilike('code', typedCode)
      .maybeSingle();
    if (!data || !data.active) return null;
    return data.consultant_id || null;
  } catch (err) {
    console.warn('resolveConsultantIdFromRequestPromoCode failed, proceeding with no attribution:', err.message);
    return null;
  }
}

async function createGcashPaidPromoCode({ supabase, request, adminNote }) {
  const validUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const notes = [
    `Created from GCash request ${request.request_number}.`,
    String(adminNote || '').trim(),
  ].filter(Boolean).join(' ');
  const consultantId = await resolveConsultantIdFromRequestPromoCode(supabase, request);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generateGcashPromoCode();
    const { data, error } = await supabase
      .from('promo_codes')
      .insert({
        consultant_id: consultantId,
        code,
        active: true,
        monthly_free_demo_limit: 0,
        notes,
        code_type: 'gcash_paid_access',
        product_tier: request.product_tier,
        delivery_option: request.delivery_option || null,
        valid_until: validUntil,
        max_uses: 1,
        used_count: 0,
        locked_customer_email: String(request.customer_email || '').trim().toLowerCase(),
        source_payment_request_id: request.id,
      })
      .select('*')
      .single();

    if (!error) {
      return data;
    }
    if (error.code !== '23505') {
      throw new Error(`Unable to create GCash promo code: ${error.message}`);
    }
  }

  throw new Error('Unable to create a unique GCash promo code.');
}

async function createPaidPublicOrderFromGcashPromo({ supabase, payload, promo }) {
  const pricing = calculateProductPricing(payload.productTier, payload.deliveryOption);
  const keepsakeId = await ensureCleanPaidKeepsakeForRedeem({ supabase, payload, promo });
  const orderNumber = await getNextOrderNumber(supabase);
  const needsFulfilment = pricing.needsFulfilment;
  const deliveryOption = needsFulfilment ? (payload.deliveryOption || 'standard') : null;
  const delivery = deliveryOption ? DELIVERY_OPTIONS[deliveryOption] : null;

  const insertPayload = {
    keepsake_id: keepsakeId,
    order_number: orderNumber,
    source_portal: SOURCE_PORTALS.public,
    customer_name: payload.customerName,
    customer_email: payload.customerEmail,
    recipient_name: payload.recipientName,
    product_tier: payload.productTier,
    delivery_option: deliveryOption,
    queue_status: needsFulfilment ? 'pending' : null,
    payment_status: PAYMENT_STATUS.paid,
    attribution_source: ATTRIBUTION_SOURCE.promoCode,
    promo_code_id: promo.id,
    // Bug fix, 31 Aug 2026 (client report, Col): was hardcoded null — a
    // GCash-redeemed sale never credited the reseller/influencer whose
    // code was used, even though promo.consultant_id was sitting right
    // there on the already-loaded promo row (loadPromoCodeByCode selects
    // '*'). Confirmed via live testing this was a genuine gap, not
    // intentional — the equivalent Stripe path has always attributed
    // correctly through resolvePaidOrderAttribution.
    sales_consultant_id: promo.consultant_id || null,
    territory_id: null,
    needs_fulfilment: needsFulfilment,
    delivery_priority: needsFulfilment ? (delivery ? delivery.priority : DELIVERY_OPTIONS.standard.priority) : 99,
    currency_code: PHASE2_CONFIG.defaultCurrencyCode,
    base_amount_nzd: pricing.tier.priceNzd,
    delivery_surcharge_nzd: pricing.deliverySurchargeNzd,
    total_amount_nzd: pricing.totalAmountNzd,
    packaging_notes: pricing.tier.packagingNotes,
    includes_frame: Boolean(pricing.tier.includesFrame),
    shipping_name: needsFulfilment ? payload.shippingName : null,
    shipping_address_line1: needsFulfilment ? payload.shippingAddressLine1 : null,
    shipping_address_line2: needsFulfilment ? payload.shippingAddressLine2 : null,
    shipping_city: needsFulfilment ? payload.shippingCity : null,
    shipping_region: needsFulfilment ? payload.shippingRegion : null,
    shipping_postcode: needsFulfilment ? payload.shippingPostcode : null,
    shipping_country: needsFulfilment ? payload.shippingCountry : null,
    payment_provider: 'gcash_manual_promo',
    notes: `Paid via manually approved GCash promo code ${promo.code}.`,
    paid_at: new Date().toISOString(),
  };

  const { data: order, error } = await supabase
    .from('orders')
    .insert(insertPayload)
    .select('*')
    .single();

  if (error) {
    throw new Error(`Unable to create paid GCash order: ${error.message}`);
  }

  if (needsFulfilment) {
    await supabase
      .from('fulfilment_events')
      .insert({
        order_id: order.id,
        previous_status: null,
        new_status: 'pending',
        triggered_email: false,
        note: 'Public GCash promo order paid and added to fulfilment queue.',
      });
  }

  return order;
}

async function ensureCleanPaidKeepsakeForRedeem({ supabase, payload, promo }) {
  if (payload.keepsakeId) {
    const updates = {
      watermarkStatus: WATERMARK_STATUS.cleanPaid,
      customerEmail: payload.customerEmail,
      customerName: payload.customerName,
      promoCodeId: promo.id,
      // Bug fix, 31 Aug 2026 — same as the order insert above; this is
      // the keepsake-record side of the same missing attribution.
      salesConsultantId: promo.consultant_id || null,
      isFreeDemo: false,
    };
    if (payload.renderedHtml) updates.renderedHtml = payload.renderedHtml;
    if (payload.generatedContent) updates.content = payload.generatedContent;
    const updated = await updateKeepsakeRecord(supabase, payload.keepsakeId, updates);
    return updated.id;
  }

  if (!payload.renderedHtml) {
    throwStatus(400, 'Generated keepsake preview is required before redeeming this promo code.');
  }

  const record = await saveKeepsakeRecord(supabase, {
    sourcePortal: SOURCE_PORTALS.public,
    edition: SOURCE_PORTALS.public,
    occasion: payload.occasion,
    recipientName: payload.recipientName,
    dateOfBirth: payload.dateOfBirth,
    country: payload.country,
    senderName: payload.senderName,
    stationName: payload.stationName,
    customerName: payload.customerName,
    customerEmail: payload.customerEmail,
    personalMessage: payload.personalMessage,
    content: payload.generatedContent,
    renderedHtml: payload.renderedHtml,
    watermarkStatus: WATERMARK_STATUS.cleanPaid,
    promoCodeId: promo.id,
    // Bug fix, 31 Aug 2026 — same as above (this is the "no existing
    // keepsake yet" branch of the same function).
    salesConsultantId: promo.consultant_id || null,
    isFreeDemo: false,
    requestIp: payload.requestIp,
  });

  return record.id;
}

function validateGcashPaidPromoForPayload(promo, payload) {
  if (!promo.active) {
    throwStatus(400, 'This GCash promo code has already been used or is inactive.');
  }
  if (Number(promo.max_uses || 0) < 1 || Number(promo.used_count || 0) >= Number(promo.max_uses || 0)) {
    throwStatus(400, 'This GCash promo code has already been used.');
  }
  if (!promo.valid_until || new Date(promo.valid_until).getTime() <= Date.now()) {
    throwStatus(400, 'This GCash promo code has expired.');
  }
  if (promo.product_tier !== payload.productTier) {
    throwStatus(400, `This GCash promo code is valid only for the ${formatProductLabel(promo.product_tier)} product.`);
  }

  const pricing = calculateProductPricing(payload.productTier, payload.deliveryOption);
  const expectedDelivery = pricing.needsFulfilment ? (promo.delivery_option || 'standard') : null;
  const selectedDelivery = pricing.needsFulfilment ? (payload.deliveryOption || 'standard') : null;
  if (expectedDelivery !== selectedDelivery) {
    throwStatus(400, `This GCash promo code is valid only for ${formatDeliveryLabel(expectedDelivery)} delivery.`);
  }

  const lockedEmail = String(promo.locked_customer_email || '').trim().toLowerCase();
  const customerEmail = String(payload.customerEmail || '').trim().toLowerCase();
  if (lockedEmail && lockedEmail !== customerEmail) {
    throwStatus(400, 'This GCash promo code is locked to the email used for the payment request.');
  }
}

async function consumeGcashPaidPromoCode(supabase, promo) {
  const nextUsedCount = Number(promo.used_count || 0) + 1;
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('promo_codes')
    .update({
      used_count: nextUsedCount,
      active: nextUsedCount >= Number(promo.max_uses || 1) ? false : promo.active,
      used_at: nowIso,
    })
    .eq('id', promo.id)
    .eq('code_type', 'gcash_paid_access')
    .eq('active', true)
    .lt('used_count', Number(promo.max_uses || 1))
    .gt('valid_until', nowIso)
    .select('*')
    .single();

  if (error || !data) {
    throwStatus(409, 'This GCash promo code could not be redeemed. It may already be used or expired.');
  }

  return data;
}

async function rollbackConsumedPromoCode(supabase, promo) {
  await supabase
    .from('promo_codes')
    .update({
      used_count: Number(promo.used_count || 0),
      active: Boolean(promo.active),
      used_at: null,
      used_order_id: null,
    })
    .eq('id', promo.id)
    .is('used_order_id', null);
}

function calculateProductPricing(productTier, deliveryOption) {
  const tier = PRODUCT_TIERS[productTier];
  if (!tier) {
    throwStatus(400, 'Invalid product tier.');
  }

  const needsFulfilment = Boolean(tier.needsFulfilment);
  const delivery = needsFulfilment ? DELIVERY_OPTIONS[deliveryOption || 'standard'] : null;
  if (needsFulfilment && !delivery) {
    throwStatus(400, 'Invalid delivery option.');
  }

  const deliverySurchargeNzd = delivery ? delivery.surchargeNzd : 0;
  const totalAmountNzd = Number((tier.priceNzd + deliverySurchargeNzd).toFixed(2));

  return {
    tier,
    delivery,
    needsFulfilment,
    deliverySurchargeNzd,
    totalAmountNzd,
  };
}

function normalizeStationBilling(stationBilling = {}) {
  return {
    tiers: stationBilling.tiers || {},
    frames: {
      unitPriceNzd: Number(stationBilling.frames?.unitPriceNzd || 1.2),
      gstRate: Number(stationBilling.frames?.gstRate || 0.15),
      minQty: Number(stationBilling.frames?.minQty || 100),
    },
  };
}

async function loadAuthenticatedStationFromRequest(supabase, req, options = {}) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    throwStatus(401, 'Please sign in before using GCash payment.');
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    throwStatus(401, 'Session expired. Please sign in again.');
  }

  if (!payload?.id || payload.type !== 'station') {
    throwStatus(403, 'Station account required.');
  }

  const { data: station, error } = await supabase
    .from('stations')
    .select('*')
    .eq('id', payload.id)
    .single();

  if (error || !station) {
    throwStatus(404, 'Station account not found.');
  }
  if (station.active === false) {
    throwStatus(403, 'This account is inactive.');
  }
  // Gift shop / cake shop accounts (added 19 Aug 2026 — client request,
  // same florist credit infrastructure reused for these two new partner
  // types) need to pass the same checks a florist account does here, and
  // be excluded the same way a florist account is from station-only GCash
  // flows — so both options now accept either a single account type
  // (unchanged, existing callers still work) or an array of them.
  if (options.accountType) {
    const allowed = Array.isArray(options.accountType) ? options.accountType : [options.accountType];
    if (!allowed.includes(station.account_type)) {
      throwStatus(403, `This payment requires a ${allowed.join('/')} account.`);
    }
  }
  if (options.excludeAccountType) {
    const excluded = Array.isArray(options.excludeAccountType) ? options.excludeAccountType : [options.excludeAccountType];
    if (excluded.includes(station.account_type)) {
      throwStatus(403, 'This payment is not available for this account type.');
    }
  }

  return station;
}

function getFloristCreditPack(packTypeValue, packSizeValue) {
  const packTypeCode = String(packTypeValue || '').trim();
  const size = Number(packSizeValue || 0);
  const packType = FLORIST_CREDIT_PACK_TYPES[packTypeCode];
  const price = packType?.packs?.[size];
  if (!packType || !price) {
    throwStatus(400, 'Invalid florist credit pack.');
  }
  return { packType, size, price };
}

// PAY-AS-YOU-USE WHOLESALE CREDITS — client decision, 19-20 Aug 2026 (Col).
// Same logic/reasoning as the matching function in server.js — kept as a
// separate copy here rather than a shared import since this file already
// duplicates getFloristCreditPack() above independently from server.js
// (existing pattern in this codebase, not something this change invents).
function calculateWholesaleCreditPurchase(packTypeValue, quantityValue) {
  const packTypeCode = String(packTypeValue || '').trim();
  const quantity = Math.floor(Number(quantityValue));
  const packType = FLORIST_WHOLESALE_PRICING[packTypeCode];

  if (!packType) {
    throwStatus(400, 'Invalid credit type. Choose Standard or Premium Floral.');
  }
  if (!Number.isFinite(quantity) || quantity < 1) {
    throwStatus(400, 'Please enter a quantity of at least 1 credit.');
  }
  if (quantity > FLORIST_WHOLESALE_MAX_QUANTITY) {
    throwStatus(400, `Quantity cannot exceed ${FLORIST_WHOLESALE_MAX_QUANTITY} credits per purchase.`);
  }

  const totalCents = packType.unitPriceCents * quantity;
  return {
    packType,
    quantity,
    unitPriceCents: packType.unitPriceCents,
    unitPriceNzd: packType.unitPriceNzd,
    totalCents,
    totalNzd: Number((totalCents / 100).toFixed(2)),
  };
}

function normalizeBillingInterval(value) {
  return String(value || '').trim().toLowerCase() === 'annual' ? 'annual' : 'monthly';
}

function normalizeFrameDelivery(body = {}) {
  const deliveryName = String(body.deliveryName || body.delivery_name || '').trim();
  const deliveryAddress = String(body.deliveryAddress || body.delivery_address || '').trim();
  const deliveryCity = String(body.deliveryCity || body.delivery_city || '').trim();
  const deliveryPostcode = String(body.deliveryPostcode || body.delivery_postcode || '').trim();
  const deliveryCountry = String(body.deliveryCountry || body.delivery_country || 'New Zealand').trim();

  if (!deliveryName) {
    throwStatus(400, 'Delivery name is required for frame orders.');
  }
  if (!deliveryAddress) {
    throwStatus(400, 'Delivery address is required for frame orders.');
  }
  if (!deliveryCity) {
    throwStatus(400, 'Delivery city is required for frame orders.');
  }
  if (!deliveryPostcode) {
    throwStatus(400, 'Delivery postcode is required for frame orders.');
  }

  return {
    deliveryName,
    deliveryAddress,
    deliveryCity,
    deliveryPostcode,
    deliveryCountry,
  };
}

function parseActionPayload(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function getPaymentContext(request) {
  return request?.payment_context || 'public_order';
}

async function loadGcashPaymentRequest(supabase, requestId) {
  const { data, error } = await supabase
    .from('gcash_payment_requests')
    .select('*')
    .eq('id', requestId)
    .single();

  if (error || !data) {
    throwStatus(404, 'GCash payment request not found.');
  }

  return data;
}

async function loadPromoCodeById(supabase, promoCodeId) {
  const { data, error } = await supabase
    .from('promo_codes')
    .select('*')
    .eq('id', promoCodeId)
    .single();

  if (error || !data) {
    throwStatus(404, 'Promo code not found.');
  }

  return data;
}

async function loadPromoCodeByCode(supabase, code) {
  const { data, error } = await supabase
    .from('promo_codes')
    .select('*')
    .ilike('code', normalizePromoCode(code))
    .maybeSingle();

  if (error) {
    throw new Error(`Unable to load promo code: ${error.message}`);
  }

  return data || null;
}

async function loadPromoCodeMapForRequests(supabase, requests) {
  const ids = [...new Set((requests || []).map(row => row.generated_promo_code_id).filter(Boolean))];
  const promoById = new Map();
  if (!ids.length) return promoById;

  const { data, error } = await supabase
    .from('promo_codes')
    .select('*')
    .in('id', ids);

  if (error) {
    console.warn('Unable to load GCash generated promo codes:', error.message);
    return promoById;
  }

  (data || []).forEach(promo => promoById.set(promo.id, promo));
  return promoById;
}

function buildGcashRequestResponse(row, promoCode) {
  const paymentContext = getPaymentContext(row);
  return {
    id: row.id,
    requestNumber: row.request_number,
    paymentContext,
    paymentContextLabel: formatPaymentContextLabel(paymentContext),
    keepsakeId: row.keepsake_id || null,
    stationId: row.station_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    recipientName: row.recipient_name,
    productTier: row.product_tier,
    productTierLabel: formatProductLabel(row.product_tier),
    deliveryOption: row.delivery_option,
    deliveryOptionLabel: row.delivery_option ? formatDeliveryLabel(row.delivery_option) : (paymentContext === 'public_order' ? 'Digital' : ''),
    itemLabel: row.item_label || buildRequestItemLabel(row),
    itemCode: row.item_code || '',
    quantity: row.quantity === null || row.quantity === undefined ? null : Number(row.quantity || 0),
    actionPayload: row.action_payload || null,
    expectedAmountNzd: Number(row.expected_amount_nzd || 0),
    expectedAmountPhp: row.expected_amount_php === null || row.expected_amount_php === undefined
      ? null
      : Number(row.expected_amount_php || 0),
    exchangeRatePhpPerNzd: row.exchange_rate_php_per_nzd === null || row.exchange_rate_php_per_nzd === undefined
      ? null
      : Number(row.exchange_rate_php_per_nzd || 0),
    exchangeRateSource: row.exchange_rate_source || '',
    exchangeRateDate: row.exchange_rate_date || null,
    exchangeRateIsLive: Boolean(row.exchange_rate_is_live),
    gcashPayeeName: row.gcash_payee_name || '',
    gcashMobileNumber: row.gcash_mobile_number || '',
    gcashSenderName: row.gcash_sender_name || '',
    gcashReferenceId: row.gcash_reference_id || '',
    status: row.status,
    adminNote: row.admin_note || '',
    reviewedAt: row.reviewed_at || null,
    reviewedByAdminId: row.reviewed_by_admin_id || null,
    generatedPromoCodeId: row.generated_promo_code_id || null,
    appliedAt: row.applied_at || null,
    appliedResult: row.applied_result || null,
    promoCode: promoCode ? {
      id: promoCode.id,
      code: promoCode.code,
      active: Boolean(promoCode.active),
      validUntil: promoCode.valid_until,
      usedCount: Number(promoCode.used_count || 0),
      maxUses: Number(promoCode.max_uses || 0),
      usedAt: promoCode.used_at || null,
      usedOrderId: promoCode.used_order_id || null,
    } : null,
  };
}

function buildRequestItemLabel(row) {
  if (getPaymentContext(row) === 'public_order') {
    const product = formatProductLabel(row.product_tier);
    const delivery = row.delivery_option ? ` / ${formatDeliveryLabel(row.delivery_option)} delivery` : '';
    return `${product}${delivery}`.trim();
  }
  return row.item_code || '';
}

async function getGcashSettings() {
  const rate = await getNzdToPhpRate();
  return {
    accountName: process.env.GCASH_ACCOUNT_NAME || '',
    mobileNumber: process.env.GCASH_MOBILE_NUMBER || '',
    qrImageUrl: process.env.GCASH_QR_IMAGE_URL || '',
    phpPerNzd: rate.rate,
    rateSource: rate.source,
    rateSourceUrl: rate.sourceUrl,
    rateDate: rate.date,
    rateIsLive: Boolean(rate.isLive),
    rateError: rate.error || null,
    productPricesNzd: Object.fromEntries(Object.entries(PRODUCT_TIERS).map(([code, tier]) => [code, tier.priceNzd])),
    deliverySurchargesNzd: Object.fromEntries(Object.entries(DELIVERY_OPTIONS).map(([code, option]) => [code, option.surchargeNzd])),
    instructions: process.env.GCASH_PAYMENT_INSTRUCTIONS
      || 'Pay the exact amount to the GCash account shown, then submit your payment details below.',
  };
}

function generateRequestNumber() {
  const stamp = Date.now().toString(36).toUpperCase();
  const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `GCASH-${stamp}-${suffix}`;
}

function generateGcashPromoCode() {
  return `GCASH${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function isGeneratedGcashPromoCode(code) {
  return /^GCASH[A-Z0-9]+$/i.test(String(code || '').trim());
}

function formatProductLabel(value) {
  const tier = PRODUCT_TIERS[value];
  return tier ? tier.label : String(value || '').replace(/^\w/, c => c.toUpperCase());
}

function formatPaymentContextLabel(value) {
  return {
    public_order: 'Public Keepsake',
    florist_credits: 'Florist Credits',
    station_subscription: 'Station Plan',
    station_frames: 'Station Frames',
  }[value] || formatProductLabel(value);
}

function formatDeliveryLabel(value) {
  if (value === '2day') return '2 Day';
  if (value === 'overnight') return 'Overnight';
  return 'Standard';
}

// Client report, 4 Sept 2026 (Col): "promo code gcash email show 9.9NZ$
// with 199p client want only 199p." A digital-product GCash order is
// always a flat PHP 199 (client decision, 11 Aug 2026 — see the
// productTier === 'digital' branch above) — the NZ$ figure alongside it
// is only an internal accounting conversion of that same flat price, not
// a second real amount, so showing both reads as two different prices
// and is confusing noise for a payment that only ever has one real
// number. Confirmed with the client: scoped to digital orders only —
// florist credit packs and station frame orders paid via GCash keep
// showing both currencies, since those DO have a real NZD price that
// matters for reconciling actual accounts.
function formatGcashExpectedAmount(request) {
  const nzd = `NZ$${Number(request.expected_amount_nzd || 0).toFixed(2)}`;
  const php = request.expected_amount_php ? `PHP ${Number(request.expected_amount_php).toFixed(2)}` : '';
  if (request.product_tier === 'digital') return php || nzd;
  return php ? `${nzd} / ${php}` : nzd;
}

async function sendGcashAdminAlert({ sendEmail, request }) {
  await sendEmail({
    to: PHASE2_CONFIG.adminAlertEmail,
    subject: `GCash payment proof submitted - ${request.request_number}`,
    html: `
      <h2>GCash payment proof submitted</h2>
      <p><strong>Request:</strong> ${escapeHtml(request.request_number)}</p>
      <p><strong>Type:</strong> ${escapeHtml(formatPaymentContextLabel(getPaymentContext(request)))}</p>
      <p><strong>Customer:</strong> ${escapeHtml(request.customer_name)} (${escapeHtml(request.customer_email)})</p>
      <p><strong>Recipient:</strong> ${escapeHtml(request.recipient_name || '')}</p>
      <p><strong>Item:</strong> ${escapeHtml(request.item_label || buildRequestItemLabel(request))}</p>
      <p><strong>Expected:</strong> ${escapeHtml(formatGcashExpectedAmount(request))}</p>
      <p><strong>GCash sender:</strong> ${escapeHtml(request.gcash_sender_name)}</p>
      <p><strong>Reference ID:</strong> ${escapeHtml(request.gcash_reference_id)}</p>
    `,
  });
}

async function sendGcashFrameOrderAdminAlert({ sendEmail, request, result }) {
  const payload = parseActionPayload(request.action_payload);
  await sendEmail({
    to: PHASE2_CONFIG.adminAlertEmail,
    subject: `GCash frame order approved - ${request.request_number}`,
    html: buildFrameOrderAdminEmail({
      stationId: request.station_id,
      qty: result?.quantity || request.quantity || payload.quantity,
      deliveryName: payload.deliveryName || request.customer_name,
      deliveryAddress: payload.deliveryAddress || '',
      deliveryCity: payload.deliveryCity || '',
      deliveryPostcode: payload.deliveryPostcode || '',
      deliveryCountry: payload.deliveryCountry || 'New Zealand',
    }),
  });
}

async function sendGcashRedeemedAdminAlert({ sendEmail, order, payload }) {
  let attachments = [];
  try {
    if (payload.renderedHtml) {
      const pdf = await generatePdfFromHtml({
        html: payload.renderedHtml,
        fileStem: order.order_number || 'tribute-times-gcash-order',
      });
      attachments = [{
        filename: `${order.order_number || 'tribute-times-order'}.pdf`,
        content: pdf.pdfBuffer,
      }];
    }
  } catch (pdfError) {
    console.error('GCash order admin email PDF attachment failed:', pdfError);
  }

  await sendEmail({
    to: PHASE2_CONFIG.adminAlertEmail,
    subject: `New GCash promo order paid - ${order.order_number}`,
    html: buildPublicOrderAdminEmail(order),
    attachments,
  });

  // Fix, Oct 2026 (checklist item 33, extended per "GCash should be
  // operating as Stripe is" — Col, 31 Aug 2026): the GCash-redeemed path
  // had no customer confirmation email either, same gap as the Stripe
  // path. Own try/catch so a failure here never blocks the admin alert
  // above or vice versa.
  if (order.customer_email) {
    try {
      await sendEmail({
        to: order.customer_email,
        subject: `Your Tribute Times keepsake is ready - ${order.order_number}`,
        html: buildPublicOrderCustomerEmail(order, process.env.APP_URL || ''),
        attachments,
      });
    } catch (emailError) {
      console.error('GCash order customer confirmation email failed:', emailError);
    }
  }
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
  registerGcashPaymentRoutes,
  tryRedeemGcashPaidPromoCode,
};
