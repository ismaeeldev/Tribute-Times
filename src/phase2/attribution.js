'use strict';

const { ATTRIBUTION_SOURCE } = require('./constants');

// Bug fix, 2 Sept 2026 (client report, Col — screenshot showing a reseller
// code saved as "MUHAMMADISMAEEL" instead of his required format): this
// used to force every code to uppercase, unconditionally. That's harmless
// for lookups (every real lookup already matches case-insensitively via
// .ilike() — confirmed by checking every call site — and the DB's own
// unique index is `lower(code)`, also case-insensitive), but it silently
// destroyed the exact mixed-case format Col specified for reseller codes:
// "firstname lower case, surname first letter in Caps" (e.g. "colinM20",
// "jhe-annB20") — typing or generating that exact case now survives all
// the way to storage and display, since nothing downstream actually
// depends on codes being uppercase, only on matching them case-
// insensitively. Trim only; case is preserved as given.
function normalizePromoCode(value) {
  return String(value || '').trim();
}

function normalizePostcode(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function monthStartIso(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

async function resolveFreeDemoAttribution({ supabase, promoCode }) {
  const code = normalizePromoCode(promoCode);
  if (!code) {
    return buildNoneAttribution();
  }

  const promo = await loadPromoCode(supabase, code);
  const usedThisMonth = await countMonthlyFreeDemos(supabase, promo.id);
  const limit = Number(promo.monthly_free_demo_limit || 0);

  // Fix, 6 Oct 2026 (client confusion, Col: TT50OFF "not working" when
  // typed into this form): this field is for free-demo codes only — a
  // code like TT50OFF (code_type 'campaign_single_use', a payment
  // discount, monthly_free_demo_limit 0) was never meant to be usable
  // here at all, and the generic "used all 0 free demos" message read
  // like a bug. Distinguishing that case from a real monthly-limit
  // exhaustion (limit > 0) so the message tells the customer where the
  // code actually belongs instead of implying something is broken.
  if (usedThisMonth >= limit) {
    const error = limit <= 0
      ? new Error(`Promo code ${promo.code} is a discount code for the payment step, not a free-demo code. Leave this field blank and enter it at checkout instead.`)
      : new Error(`Promo code ${promo.code} has used all ${limit} free demos for this month.`);
    error.statusCode = limit <= 0 ? 400 : 429;
    throw error;
  }

  return {
    attributionSource: ATTRIBUTION_SOURCE.promoCode,
    promoCodeId: promo.id,
    salesConsultantId: promo.consultant_id || null,
    territoryId: null,
    isFreeDemo: true,
    promoCode: promo.code,
    freeDemosUsedThisMonth: usedThisMonth + 1,
    freeDemoLimit: limit,
    consultantName: promo.sales_consultants?.name || '',
  };
}

async function resolvePaidOrderAttribution({ supabase, promoCode, existingKeepsake, postcode, country }) {
  const code = normalizePromoCode(promoCode);
  if (code) {
    // Client-reported bug (11 Aug 2026, URGENT — "Pay by Card does nothing"):
    // loadPromoCode() here only recognises sales-consultant attribution
    // codes (the `promo_codes` table with no code_type filter). It has no
    // knowledge of customer-facing discount codes like "WELCOME20" — those
    // are a separate concept, resolved later by resolveCampaignPromoCode()
    // in public-checkout.js (code_type = 'campaign_single_use'), which
    // already fails gracefully (returns null) when a code isn't a campaign
    // code. Before this fix, any code that wasn't ALSO a recognised
    // consultant code threw here and aborted checkout-session creation
    // entirely — so typing a real, working customer promo code into the
    // checkout box, or simply mistyping one, silently blocked payment with
    // no Stripe redirect at all. Reproduced directly: same request without
    // a promo code created a real Stripe session and redirected correctly;
    // adding an unrecognised code made the whole request 400 before Stripe
    // was ever contacted. A bad/unknown attribution code should only mean
    // "no consultant credit for this order" — never "this customer can't
    // pay" — so it now falls through to the same no-attribution outcome as
    // if no code had been entered, instead of throwing. The actual
    // customer-facing discount (resolveCampaignPromoCode) is untouched by
    // this change and still applies (or still correctly rejects) exactly
    // as before.
    try {
      const promo = await loadPromoCode(supabase, code);
      return {
        attributionSource: ATTRIBUTION_SOURCE.promoCode,
        promoCodeId: promo.id,
        salesConsultantId: promo.consultant_id || null,
        territoryId: null,
        promoCode: promo.code,
        consultantName: promo.sales_consultants?.name || '',
      };
    } catch (error) {
      console.warn(`Promo/attribution code "${code}" did not resolve to a sales-consultant code (${error.message}) — proceeding without consultant attribution.`);
    }
  }

  if (existingKeepsake?.promo_code_id || existingKeepsake?.sales_consultant_id) {
    return {
      attributionSource: existingKeepsake.promo_code_id ? ATTRIBUTION_SOURCE.promoCode : ATTRIBUTION_SOURCE.manual,
      promoCodeId: existingKeepsake.promo_code_id || null,
      salesConsultantId: existingKeepsake.sales_consultant_id || null,
      territoryId: null,
      promoCode: '',
      consultantName: '',
    };
  }

  const territory = await matchPostcodeTerritory({ supabase, postcode, country });
  if (territory) {
    return {
      attributionSource: ATTRIBUTION_SOURCE.postcode,
      promoCodeId: null,
      salesConsultantId: territory.consultant_id || null,
      territoryId: territory.id,
      promoCode: '',
      consultantName: territory.sales_consultants?.name || '',
    };
  }

  return buildNoneAttribution();
}

async function loadPromoCode(supabase, code) {
  const normalized = normalizePromoCode(code);
  const { data, error } = await supabase
    .from('promo_codes')
    .select('id, code, active, monthly_free_demo_limit, consultant_id, sales_consultants(id, name, email, active)')
    .ilike('code', normalized)
    .single();

  if (error || !data || !data.active) {
    const notFound = new Error('Promo code is not valid.');
    notFound.statusCode = 400;
    throw notFound;
  }
  if (data.sales_consultants && data.sales_consultants.active === false) {
    const inactive = new Error('Promo code consultant is inactive.');
    inactive.statusCode = 400;
    throw inactive;
  }

  return data;
}

async function countMonthlyFreeDemos(supabase, promoCodeId, now = new Date()) {
  const { count, error } = await supabase
    .from('keepsakes')
    .select('id', { count: 'exact', head: true })
    .eq('promo_code_id', promoCodeId)
    .eq('is_free_demo', true)
    .gte('created_at', monthStartIso(now));

  if (error) {
    throw new Error(`Unable to count free demos: ${error.message}`);
  }

  return count || 0;
}

async function matchPostcodeTerritory({ supabase, postcode, country }) {
  const normalizedPostcode = normalizePostcode(postcode);
  if (!normalizedPostcode) return null;

  const { data, error } = await supabase
    .from('postcode_territories')
    .select('id, consultant_id, territory_name, country, match_type, postcode_start, postcode_end, priority, sales_consultants(id, name, email, active)')
    .eq('active', true)
    .eq('country', country || 'New Zealand')
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Unable to match postcode territory: ${error.message}`);
  }

  return (data || []).find(territory => territoryMatchesPostcode(territory, normalizedPostcode)) || null;
}

function territoryMatchesPostcode(territory, normalizedPostcode) {
  const start = normalizePostcode(territory.postcode_start);
  const end = normalizePostcode(territory.postcode_end);

  if (territory.match_type === 'prefix') {
    return Boolean(start) && normalizedPostcode.startsWith(start);
  }

  if (territory.match_type === 'range') {
    if (!start || !end) return false;
    const postNumber = Number(normalizedPostcode);
    const startNumber = Number(start);
    const endNumber = Number(end);
    if ([postNumber, startNumber, endNumber].every(Number.isFinite)) {
      return postNumber >= startNumber && postNumber <= endNumber;
    }
    return normalizedPostcode >= start && normalizedPostcode <= end;
  }

  return normalizedPostcode === start;
}

function buildNoneAttribution() {
  return {
    attributionSource: ATTRIBUTION_SOURCE.none,
    promoCodeId: null,
    salesConsultantId: null,
    territoryId: null,
    isFreeDemo: false,
    promoCode: '',
    consultantName: '',
  };
}

module.exports = {
  normalizePromoCode,
  resolveFreeDemoAttribution,
  resolvePaidOrderAttribution,
  countMonthlyFreeDemos,
  matchPostcodeTerritory,
};
