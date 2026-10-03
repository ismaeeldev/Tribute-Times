'use strict';

const fetch = require('node-fetch');
const { PHASE2_CONFIG } = require('./config');

const DEFAULT_FROM = PHASE2_CONFIG.resendFromEmail || 'The Tribute Times <hello@tributetimes.co.nz>';

async function sendEmail({ to, cc, subject, html, text, attachments = [], replyTo }) {
  // Bug fix, 1 Oct 2026 (found while investigating Col's "0 of 8 thank-you
  // codes ever redeemed" report, new_changes.md Step 9): a missing/blank
  // RESEND_API_KEY used to return false here with zero logging — every
  // caller only awaits this and checks for a *thrown* error, so a missing
  // key meant every email silently vanished with no trace anywhere. Now
  // throws loudly so a misconfigured key is never silent again.
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not set — email not sent.');
  }

  const payload = {
    from: DEFAULT_FROM,
    to,
    subject,
    html,
  };

  if (cc) payload.cc = cc;
  if (text) payload.text = text;
  if (replyTo) payload.reply_to = replyTo;
  if (attachments.length) {
    payload.attachments = attachments.map(normalizeAttachment);
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Resend request failed (${response.status}): ${body.slice(0, 200)}`);
  }

  return true;
}

// Client request, 1 Oct 2026 (Col): "every email has premium template" —
// deep email audit found every customer-facing email used the same bare
// `<div><p>...</p></div>` block (no branding, no header/footer, no
// mobile-safe table layout). This wraps a template's inner HTML in a
// single shared, branded shell (logo, site's actual gold/green
// vintage-newspaper colors, serif heading font, footer with contact info)
// instead of writing one from scratch per email. Table-based layout for
// real email-client compatibility (not flexbox/grid, which many clients
// strip). See new_changes.md Step 9 (email deep audit).
function wrapBrandedEmail({ heading, bodyHtml, appUrl }) {
  const baseUrl = (appUrl || process.env.APP_URL || 'https://tributetimes.co.nz').replace(/\/$/, '');
  const logoUrl = `${baseUrl}/logo_header.png`;
  const year = new Date().getFullYear();

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0;padding:0;background:#F7F3E3;font-family:Georgia,'Playfair Display',serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F3E3;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#FFFFFF;border:1px solid #E4DCC3;border-radius:12px;overflow:hidden;">
          <tr>
            <td align="center" style="background:#FFFFFF;padding:28px 24px 20px;border-bottom:1px solid #E4DCC3;">
              <img src="${escapeHtml(logoUrl)}" alt="The Tribute Times" width="220" style="display:block;max-width:220px;height:auto;" />
            </td>
          </tr>
          <tr>
            <td style="padding:32px 36px;color:#3D4122;font-family:Arial,sans-serif;line-height:1.6;font-size:15px;">
              ${heading ? `<h1 style="font-family:Georgia,'Playfair Display',serif;color:#8A6A1F;font-size:1.5rem;margin:0 0 20px;">${escapeHtml(heading)}</h1>` : ''}
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="background:#F4F0DE;padding:20px 36px;text-align:center;font-family:Arial,sans-serif;font-size:12px;color:#6B6F4C;">
              <p style="margin:0 0 6px;">The Tribute Times — Personalised Vintage Newspaper Keepsakes</p>
              <p style="margin:0;">Questions? Reply to this email or contact <a href="mailto:hello@tributetimes.co.nz" style="color:#8A6A1F;">hello@tributetimes.co.nz</a></p>
              <p style="margin:6px 0 0;color:#9a9d7a;">&copy; ${year} The Tribute Times</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function normalizeAttachment(attachment) {
  if (!attachment || !attachment.filename) {
    throw new Error('Each attachment must include a filename.');
  }

  const content = Buffer.isBuffer(attachment.content)
    ? attachment.content.toString('base64')
    : String(attachment.content || '');

  return {
    filename: attachment.filename,
    content,
  };
}

function buildStationWelcomeEmail(name, tier) {
  return wrapBrandedEmail({
    heading: 'Welcome to The Tribute Times',
    bodyHtml: `
    <p>Hi ${escapeHtml(name)},</p>
    <p>Your <strong>${escapeHtml(tierLabel(tier))}</strong> station account is ready. You have a 14-day free trial — no card required.</p>
    <p>Log in at <a href="https://tributetimes.co.nz/login" style="color:#8A6A1F;">tributetimes.co.nz</a> to set up your station branding, add your DJs, and start creating your first birthday keepsakes.</p>
    <p>Questions? Reply to this email — we're here to help.</p>`,
  });
}

function buildDjWelcomeEmail(name, email, password) {
  return wrapBrandedEmail({
    heading: 'Your Tribute Times DJ Account',
    bodyHtml: `
    <p>Hi ${escapeHtml(name)},</p>
    <p>Your station manager has set up your DJ account on The Tribute Times.</p>
    <p><strong>Login:</strong> <a href="https://tributetimes.co.nz/dj" style="color:#8A6A1F;">tributetimes.co.nz/dj</a><br/>
    <strong>Email:</strong> ${escapeHtml(email)}<br/>
    <strong>Password:</strong> ${escapeHtml(password)}</p>
    <p>Please change your password after first login.</p>`,
  });
}

function buildSubscriptionActiveEmail(name, tier) {
  return wrapBrandedEmail({
    heading: 'Subscription Active',
    bodyHtml: `
    <p>Hi ${escapeHtml(name)},</p>
    <p>Your <strong>${escapeHtml(tierLabel(tier))}</strong> plan is now active. You can generate up to ${escapeHtml(tierKeepsakes(tier))} keepsakes per month.</p>
    <p>Log in at <a href="https://tributetimes.co.nz/dashboard" style="color:#8A6A1F;">tributetimes.co.nz/dashboard</a></p>`,
  });
}

function buildPublicOrderAdminEmail(order) {
  const shippingLines = order.needs_fulfilment
    ? [
        order.shipping_name,
        order.shipping_address_line1,
        order.shipping_address_line2,
        [order.shipping_city, order.shipping_region].filter(Boolean).join(', '),
        [order.shipping_postcode, order.shipping_country].filter(Boolean).join(' ').trim(),
      ].filter(Boolean)
    : [];

  return `
    <h2>New public order paid</h2>
    <p><strong>Order number:</strong> ${escapeHtml(order.order_number)}</p>
    <p><strong>Customer:</strong> ${escapeHtml(order.customer_name || '')}</p>
    <p><strong>Email:</strong> ${escapeHtml(order.customer_email || '')}</p>
    <p><strong>Recipient:</strong> ${escapeHtml(order.recipient_name || '')}</p>
    <p><strong>Tier:</strong> ${escapeHtml(order.product_tier || '')}</p>
    <p><strong>Delivery:</strong> ${escapeHtml(order.delivery_option || 'digital')}</p>
    <p><strong>Total:</strong> NZ$${Number(order.total_amount_nzd || 0).toFixed(2)}</p>
    ${shippingLines.length ? `<p><strong>Shipping address:</strong><br/>${shippingLines.map(escapeHtml).join('<br/>')}</p>` : '<p><strong>Delivery:</strong> Digital only</p>'}
  `;
}

// Fix, Oct 2026 (checklist item 33): the Stripe/card public-purchase path
// had no customer-facing "your order is confirmed" email at all — only
// buildPublicOrderAdminEmail() above (an internal notification to Col) and
// the unrelated second-purchase discount email ever fired. A customer's
// only way to reach their keepsake was the post-Stripe browser redirect,
// with no fallback if that redirect didn't complete (closed tab, phone
// interruption, browser crash). This gives every real customer a durable,
// resendable link back to their own paid order (same success-page URL the
// redirect itself uses, GET /api/public/orders/:orderId — already proven
// in item 37's testing to have no expiry and to work regardless of
// elapsed time), so losing the redirect doesn't mean losing the keepsake.
function buildPublicOrderCustomerEmail(order, appUrl) {
  const product = productLabel(order.product_tier);
  const delivery = order.delivery_option ? ` with ${deliveryLabel(order.delivery_option)} delivery` : '';
  const total = Number(order.total_amount_nzd || 0).toFixed(2);
  const baseUrl = appUrl ? String(appUrl).replace(/\/$/, '') : '';
  const orderUrl = `${baseUrl}/public?checkout=success&order=${encodeURIComponent(order.id)}`;

  return wrapBrandedEmail({
    heading: 'Your Keepsake Is Ready',
    appUrl,
    bodyHtml: `
    <p>Hi ${escapeHtml(order.customer_name || 'there')},</p>
    <p>Thank you for your order! Your payment for <strong>${escapeHtml(product)}${escapeHtml(delivery)}</strong> (NZ$${escapeHtml(total)}) has been received, and your personalised keepsake newspaper is ready.</p>
    <p><strong>Order number:</strong> ${escapeHtml(order.order_number || '')}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;">
      <tr><td>
        <a href="${escapeHtml(orderUrl)}" style="display:inline-block;background:#8A6A1F;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold;">View &amp; Download Your Keepsake</a>
      </td></tr>
    </table>
    <p>Keep this email — this link will always take you back to your keepsake, so you can download it again any time.</p>`,
  });
}

function buildSecondPurchaseDiscountEmail({ customerName, code, discountPercent, validUntil, appUrl }) {
  const expiry = validUntil
    ? new Date(validUntil).toLocaleDateString('en-NZ', { year: 'numeric', month: 'long', day: 'numeric' })
    : '90 days from today';
  const publicUrl = appUrl ? `${String(appUrl).replace(/\/$/, '')}/public` : '/public';

  return wrapBrandedEmail({
    heading: 'Thank You For Your Keepsake',
    appUrl,
    bodyHtml: `
    <p>Hi ${escapeHtml(customerName || 'there')},</p>
    <p>We hope your keepsake newspaper brought a smile. As a thank-you, here's <strong>${escapeHtml(String(discountPercent))}% off</strong> your next Tribute Times keepsake.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;">
      <tr><td style="background:#F4F0DE;border:1px dashed #8A6A1F;border-radius:8px;padding:14px 22px;">
        <span style="font-size:1.3rem;font-weight:bold;letter-spacing:1px;color:#8A6A1F;font-family:Georgia,serif;">${escapeHtml(code)}</span>
      </td></tr>
    </table>
    <p>This code works once and is valid until <strong>${escapeHtml(expiry)}</strong>.</p>
    <p>Create another keepsake at <a href="${escapeHtml(publicUrl)}" style="color:#8A6A1F;">The Tribute Times</a> and enter this code at checkout.</p>`,
  });
}

function buildGcashPromoApprovedEmail({ request, promoCode, appUrl }) {
  const expiry = promoCode?.valid_until
    ? new Date(promoCode.valid_until).toLocaleDateString('en-NZ', { year: 'numeric', month: 'long', day: 'numeric' })
    : '30 days from approval';
  const product = productLabel(request?.product_tier);
  const delivery = request?.delivery_option ? ` with ${deliveryLabel(request.delivery_option)} delivery` : '';
  const totalNzd = Number(request?.expected_amount_nzd || 0).toFixed(2);
  const phpAmount = request?.expected_amount_php
    ? ` / PHP ${Number(request.expected_amount_php || 0).toFixed(2)}`
    : '';
  const publicUrl = appUrl ? `${String(appUrl).replace(/\/$/, '')}/public` : '/public';

  return wrapBrandedEmail({
    heading: 'Your GCash Payment Is Approved',
    appUrl,
    bodyHtml: `
    <p>Hi ${escapeHtml(request?.customer_name || 'there')},</p>
    <p>Your GCash payment for <strong>${escapeHtml(product)}${escapeHtml(delivery)}</strong> has been verified.</p>
    <p><strong>Approved amount:</strong> NZ$${escapeHtml(totalNzd)}${escapeHtml(phpAmount)}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;">
      <tr><td style="background:#F4F0DE;border:1px dashed #8A6A1F;border-radius:8px;padding:14px 22px;">
        <span style="font-size:1.3rem;font-weight:bold;letter-spacing:1px;color:#8A6A1F;font-family:Georgia,serif;">${escapeHtml(promoCode?.code || '')}</span>
      </td></tr>
    </table>
    <p>This code works only once, is valid until <strong>${escapeHtml(expiry)}</strong>, and can only be used for the same product and delivery option you paid for.</p>
    <p>Return to <a href="${escapeHtml(publicUrl)}" style="color:#8A6A1F;">The Tribute Times public checkout</a>, select the same product, enter this code in the promo code field, and continue to payment. The site will unlock your paid order without charging your card.</p>`,
  });
}

function buildGcashPaymentRejectedEmail({ request }) {
  const note = request?.admin_note
    ? `<p><strong>Review note:</strong> ${escapeHtml(request.admin_note)}</p>`
    : '';

  return wrapBrandedEmail({
    heading: 'GCash Payment Could Not Be Verified',
    bodyHtml: `
    <p>Hi ${escapeHtml(request?.customer_name || 'there')},</p>
    <p>We could not verify the GCash payment details submitted for request ${escapeHtml(request?.request_number || '')}.</p>
    ${note}
    <p>Please reply with the correct GCash sender name, transaction/reference ID, and payment screenshot if available.</p>`,
  });
}

function buildGcashManualPaymentApprovedEmail({ request, result }) {
  const phpAmount = request?.expected_amount_php
    ? ` / PHP ${Number(request.expected_amount_php || 0).toFixed(2)}`
    : '';
  const item = request?.item_label || manualPaymentItemLabel(request, result);
  const context = manualPaymentContextLabel(request?.payment_context);
  const outcome = manualPaymentOutcomeText(request, result);

  return wrapBrandedEmail({
    heading: 'Your GCash Payment Is Approved',
    bodyHtml: `
    <p>Hi ${escapeHtml(request?.customer_name || 'there')},</p>
    <p>Your GCash payment for <strong>${escapeHtml(item)}</strong> has been verified.</p>
    <p><strong>Payment type:</strong> ${escapeHtml(context)}</p>
    <p><strong>Approved amount:</strong> NZ$${Number(request?.expected_amount_nzd || 0).toFixed(2)}${escapeHtml(phpAmount)}</p>
    <p>${escapeHtml(outcome)}</p>`,
  });
}

function buildRadioOrderAdminEmail(order) {
  const shippingLines = [
    order.shipping_name,
    order.shipping_address_line1,
    order.shipping_address_line2,
    [order.shipping_city, order.shipping_region].filter(Boolean).join(', '),
    [order.shipping_postcode, order.shipping_country].filter(Boolean).join(' ').trim(),
  ].filter(Boolean);

  return `
    <h2>New radio order paid</h2>
    <p><strong>Order number:</strong> ${escapeHtml(order.order_number)}</p>
    <p><strong>Listener:</strong> ${escapeHtml(order.recipient_name || '')}</p>
    <p><strong>Email:</strong> ${escapeHtml(order.customer_email || '')}</p>
    <p><strong>Station name:</strong> ${escapeHtml(order.station_name || '')}</p>
    <p><strong>DJ / Presenter:</strong> ${escapeHtml(order.sender_name || '')}</p>
    <p><strong>Postal address:</strong><br/>${shippingLines.map(escapeHtml).join('<br/>')}</p>
  `;
}

function buildFloristLowCreditEmail(station, repEmail) {
  return wrapBrandedEmail({
    heading: 'Florist Credits Running Low',
    bodyHtml: `
    <p>Hi ${escapeHtml(station?.name || 'there')},</p>
    <p>Your florist credit balance is down to ${escapeHtml(String(station?.florist_credit_balance ?? 0))} credits.</p>
    <p>Purchase another pack to top up your balance. The current low-credit threshold is ${escapeHtml(String(station?.florist_low_credit_threshold ?? PHASE2_CONFIG.floristLowCreditThreshold))} credits.</p>`,
  });
}

// Bug fix, 1 Oct 2026 (found during the email deep audit, new_changes.md
// Step 9): this used to take zero parameters, so the `updatedOrder`
// argument its only caller (admin-fulfilment.js) passed was silently
// discarded — the email never showed an order number or customer name,
// just one generic sentence. Now actually uses the order.
function buildPostedOrderCustomerEmail(order) {
  return wrapBrandedEmail({
    heading: 'Your Keepsake Has Been Posted',
    bodyHtml: `
    <p>Hi ${escapeHtml(order?.customer_name || 'there')},</p>
    <p>Your Tribute Times keepsake${order?.order_number ? ` (order <strong>${escapeHtml(order.order_number)}</strong>)` : ''} has been posted and is on its way.</p>
    <p><strong>Standard delivery:</strong> 3–5 days<br/>
    <strong>2 Day delivery:</strong> 2 days<br/>
    <strong>Overnight delivery:</strong> tomorrow</p>`,
  });
}

function buildAnthropicSpendAlertEmail({ usageDate, totalUsd, thresholdUsd }) {
  return `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#1f1f1f;line-height:1.6">
    <h1 style="color:#8A6A1F;">Anthropic Spend Alert</h1>
    <p>The estimated Anthropic spend on ${escapeHtml(usageDate)} has reached US$${Number(totalUsd || 0).toFixed(2)}.</p>
    <p>The current alert threshold is US$${Number(thresholdUsd || PHASE2_CONFIG.anthropicDailyAlertThresholdUsd).toFixed(2)}.</p>
  </div>`;
}

function buildFrameOrderAdminEmail({ stationId, qty, deliveryName, deliveryAddress, deliveryCity, deliveryPostcode, deliveryCountry }) {
  return `<p>Station ${escapeHtml(stationId)} ordered ${escapeHtml(String(qty))} frames. Deliver to: ${escapeHtml(deliveryName)}, ${escapeHtml(deliveryAddress)}, ${escapeHtml(deliveryCity)}, ${escapeHtml(deliveryPostcode)}, ${escapeHtml(deliveryCountry)}</p>`;
}

function tierLabel(tier) {
  return {
    community: 'Community',
    regional: 'Regional',
    city: 'City',
    national: 'National',
  }[tier] || String(tier || '');
}

function tierKeepsakes(tier) {
  return {
    community: 30,
    regional: 75,
    city: 200,
    national: 9999,
  }[tier] || 0;
}

function productLabel(value) {
  return {
    digital: 'Digital',
    standard: 'Standard',
    premium: 'Premium',
  }[value] || String(value || '');
}

function manualPaymentContextLabel(value) {
  return {
    florist_credits: 'Florist credits',
    station_subscription: 'Station subscription',
    station_frames: 'Station frame order',
  }[value] || 'GCash payment';
}

function manualPaymentItemLabel(request, result) {
  if (request?.payment_context === 'florist_credits') {
    return `${result?.creditsAdded || request?.quantity || ''} florist credits`.trim();
  }
  if (request?.payment_context === 'station_subscription') {
    return `${result?.tierLabel || result?.tier || 'Station'} plan`;
  }
  if (request?.payment_context === 'station_frames') {
    return `${result?.quantity || request?.quantity || ''} frames`.trim();
  }
  return 'your purchase';
}

function manualPaymentOutcomeText(request, result) {
  if (request?.payment_context === 'florist_credits') {
    return `${result?.creditsAdded || request?.quantity || 0} credits have been added to the florist account.`;
  }
  if (request?.payment_context === 'station_subscription') {
    return `The station plan is now active${result?.tierLabel ? ` on ${result.tierLabel}` : ''}${result?.interval ? ` (${result.interval})` : ''}.`;
  }
  if (request?.payment_context === 'station_frames') {
    return `The frame order has been recorded and ${result?.quantity || request?.quantity || 0} frames were added to station stock.`;
  }
  return 'Your payment has been approved.';
}

function deliveryLabel(value) {
  if (value === '2day') return '2 Day';
  if (value === 'overnight') return 'Overnight';
  return 'Standard';
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
  sendEmail,
  buildStationWelcomeEmail,
  buildDjWelcomeEmail,
  buildSubscriptionActiveEmail,
  buildPublicOrderAdminEmail,
  buildPublicOrderCustomerEmail,
  buildSecondPurchaseDiscountEmail,
  buildGcashPromoApprovedEmail,
  buildGcashPaymentRejectedEmail,
  buildGcashManualPaymentApprovedEmail,
  buildRadioOrderAdminEmail,
  buildFloristLowCreditEmail,
  buildPostedOrderCustomerEmail,
  buildAnthropicSpendAlertEmail,
  buildFrameOrderAdminEmail,
};
