'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { generatePdfFromHtml, sanitizeFilenamePart } = require('./pdf-service');
const { DELIVERY_OPTIONS, QUEUE_STATUS, SOURCE_PORTALS, WHOLESALE_DISCOUNT_RATE } = require('./constants');
const { normalizePromoCode } = require('./attribution');
const { normalizeCountry } = require('./famous-birthdays');
const { buildPostedOrderCustomerEmail, buildPublicOrderCustomerEmail } = require('./email-service');
const { buildBaseWholesaleCode, resolveAvailableCode, createUniqueWholesaleCode, createUniqueAttributionCode } = require('./wholesale-code');
const { PHASE2_CONFIG } = require('./config');

// Same local escapeHtml() every other phase2 file defines for itself
// (email-service.js, gcash-payment-requests.js, public-checkout.js) —
// not exported/shared anywhere in this codebase, so matching that
// existing convention rather than introducing a new shared import.
function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Security fix (Col McCabe, 7 Aug 2026 — "Admin session token exposed on
// public site"): admin auth previously fell back to sharing JWT_SECRET
// with every other token type (station/DJ/florist/checkout — see
// server.js and tribute-times-server-update.js), so rotating one secret
// to invalidate a leak would have force-logged-out the entire site, not
// just admin. Requiring a dedicated ADMIN_JWT_SECRET means admin sessions
// can be rotated independently, and a missing value fails loudly instead
// of silently reusing a secret meant for a different trust boundary.
if (!process.env.ADMIN_JWT_SECRET) {
  throw new Error('ADMIN_JWT_SECRET is not set. Admin auth must use its own dedicated secret, not the shared JWT_SECRET.');
}
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET;
const ADMIN_TOKEN_EXPIRY = '30d';
const ADMIN_TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const ADMIN_COOKIE_NAME = 'adminToken';

// The root cause of the exposure report: the admin token was stored in
// localStorage and sent via an Authorization header the client JS chose
// to attach. localStorage is scoped to the whole origin, not to a single
// page — any page served from the same domain (including the public
// checkout page) can run `localStorage.getItem('phase2AdminToken')` in
// its own JS and read it, and so can any XSS payload landing on ANY page
// of the site, not just admin.html. Moving the token into an httpOnly
// cookie removes it from JS reach entirely (on every page, including
// admin.html itself) — only the browser attaches it, automatically, only
// to same-site requests. `secure` is conditional on NODE_ENV since local
// HTTP development has no TLS to require; `sameSite: 'strict'` is the
// CSRF defence here (the admin panel is never embedded or linked from
// another origin, so this has no functional cost) in place of a separate
// CSRF token scheme.
function setAdminAuthCookie(res, token) {
  res.cookie(ADMIN_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: ADMIN_TOKEN_MAX_AGE_MS,
    path: '/',
  });
}

function clearAdminAuthCookie(res) {
  res.clearCookie(ADMIN_COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
  });
}

// No cookie-parser dependency in this project — this is the one cookie
// the admin panel ever reads, so a tiny manual parse avoids adding a new
// package for a single value.
function getAdminTokenFromRequest(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  const parts = header.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === ADMIN_COOKIE_NAME) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

function throwStatus(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

// ── OFFLINE IN-MEMORY FALLBACK DATABASE ──
const mockDb = {
  sales_consultants: [
    { id: 'c1', name: 'Sarah Jones', email: 'sarah@example.com', phone: '021-123456', active: true, commission_notes: '10% flat', admin_notes: 'Top seller' },
    { id: 'c2', name: 'Mark Davis', email: 'mark@example.com', phone: '021-987654', active: true, commission_notes: '15% regional', admin_notes: '' },
    { id: 'c3', name: 'Anna Taylor', email: 'anna@example.com', phone: '022-555123', active: false, commission_notes: '', admin_notes: 'Inactive' }
  ],
  promo_codes: [
    { id: 'p1', consultant_id: 'c1', code: 'SARAH5', active: true, monthly_free_demo_limit: 5, notes: 'Intro promo' },
    { id: 'p2', consultant_id: 'c2', code: 'MARK10', active: true, monthly_free_demo_limit: 10, notes: 'Special promo' }
  ],
  postcode_territories: [
    { id: 't1', consultant_id: 'c1', territory_name: 'North Auckland', country: 'New Zealand', match_type: 'prefix', postcode_start: '10', postcode_end: null, priority: 100, active: true, notes: 'Auckland northern prefix' }
  ],
  stations: [
    { id: 's1', name: 'River FM', email: 'manager@riverfm.co.nz', country: 'New Zealand', tier: 'regional', account_type: 'radio', active: true },
    { id: 's2', name: 'Classic Hits', email: 'hits@classic.co.nz', country: 'New Zealand', tier: 'national', account_type: 'radio', active: true },
    { id: 'f1', name: 'Blossom Florist & Gift Shop', email: 'hello@blossomflorist.co.nz', country: 'New Zealand', account_type: 'florist', florist_credit_balance: 30, florist_low_credit_threshold: 10, active: true }
  ],
  famous_birthdays: [
    { id: 'fb1', full_name: 'Albert Einstein', birth_day: 14, birth_month: 3, birth_year: 1879, main_public_country: 'germany', occupation: 'Physicist', short_bio: 'Developed the theory of relativity.', curation_status: 'approved', display_priority: 1, active: true, admin_notes: '' },
    { id: 'fb2', full_name: 'Stephen Hawking', birth_day: 8, birth_month: 1, birth_year: 1942, main_public_country: 'united kingdom', occupation: 'Cosmologist', short_bio: 'Author of A Brief History of Time.', curation_status: 'pending', display_priority: 2, active: true, admin_notes: '' }
  ],
  orders: [
    { id: 'o1', order_number: 'TT-99881', source_portal: 'public', customer_name: 'John Smith', customer_email: 'john@example.com', recipient_name: 'Jane Smith', product_tier: 'premium', delivery_option: 'print', queue_status: 'pending', delivery_priority: 1, needs_fulfilment: true, payment_status: 'paid', created_at: new Date().toISOString() }
  ]
};

function paginateArray(array, page, limit) {
  const start = (page - 1) * limit;
  return {
    items: array.slice(start, start + limit),
    total: array.length,
    page,
    limit
  };
}

function registerAdminFulfilmentRoutes(app, { supabase, sendEmail, stripe }) {
  if (!app) throw new Error('Express app is required.');
  if (!supabase) throw new Error('Supabase client is required.');

  app.post('/api/admin/auth/login', async (req, res) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
      }

      // No fallback here on purpose: a session must always be backed by a real
      // `admins` row. A previous version of this route issued a working login
      // for one hardcoded email whenever this lookup failed for any reason,
      // using a fabricated id ('mock-admin-id') that doesn't exist in the
      // database. That worked fine for browsing, but any admin action that
      // writes the logged-in admin's id into a foreign-key-constrained column
      // (e.g. approving a GCash payment) failed with a constraint violation,
      // since Postgres correctly rejected an id that isn't a real admin.
      const { data: admin, error } = await supabase
        .from('admins')
        .select('id, display_name, email, password_hash, active, last_login')
        .ilike('email', email)
        .single();

      if (error || !admin || !admin.active) {
        return res.status(401).json({ error: 'Invalid admin credentials.' });
      }

      const valid = await bcrypt.compare(password, admin.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid admin credentials.' });
      }

      try {
        await supabase
          .from('admins')
          .update({ last_login: new Date().toISOString() })
          .eq('id', admin.id);
      } catch (e) {
        console.warn('Unable to log login event online, continuing in offline mode.');
      }

      const token = jwt.sign(
        {
          id: admin.id,
          type: 'admin',
          email: admin.email,
          display_name: admin.display_name,
        },
        ADMIN_JWT_SECRET,
        { expiresIn: ADMIN_TOKEN_EXPIRY }
      );

      // Token no longer goes in the JSON body at all — see the cookie
      // comment above. If it isn't in the response, it can't end up in
      // localStorage (or anywhere else client JS decides to put it) by
      // mistake, on this page or any future one.
      setAdminAuthCookie(res, token);

      return res.json({
        admin: {
          id: admin.id,
          displayName: admin.display_name,
          email: admin.email,
        },
      });
    } catch (error) {
      console.error('Admin login error:', error);
      return res.status(500).json({ error: 'Unable to log in.' });
    }
  });

  // The client can't clear an httpOnly cookie itself (that's the whole
  // point of httpOnly) — logout has to be a real server round-trip that
  // clears it, not just a local state reset.
  app.post('/api/admin/auth/logout', (req, res) => {
    clearAdminAuthCookie(res);
    return res.json({ ok: true });
  });

  app.get('/api/admin/me', authAdmin, async (req, res) => {
    return res.json({
      id: req.admin.id,
      displayName: req.admin.display_name,
      email: req.admin.email,
    });
  });

  app.post('/api/admin/auth/update-password', authAdmin, async (req, res) => {
    try {
      const { oldPassword, newPassword } = req.body;
      if (!oldPassword || !newPassword) {
        return res.status(400).json({ error: 'Old password and new password are required.' });
      }

      const { data: admin } = await supabase
        .from('admins')
        .select('*')
        .eq('id', req.admin.id)
        .single();

      if (!admin) {
        return res.status(404).json({ error: 'Admin account not found.' });
      }

      const valid = await bcrypt.compare(oldPassword, admin.password_hash);
      if (!valid) {
        return res.status(400).json({ error: 'Incorrect current password.' });
      }

      const newHash = await bcrypt.hash(newPassword, 10);
      await supabase
        .from('admins')
        .update({ password_hash: newHash })
        .eq('id', admin.id);

      return res.json({ message: 'Password updated successfully.' });
    } catch (error) {
      console.error('Admin password update error:', error);
      return res.status(500).json({ error: 'Unable to update password.' });
    }
  });

  app.get('/api/admin/orders', authAdmin, async (req, res) => {
    try {
      const page = Math.max(Number(req.query.page) || 1, 1);
      const limit = Math.max(Number(req.query.limit) || 20, 1);
      const start = (page - 1) * limit;
      const end = start + limit - 1;

      let paginatedOrders, count, summary;
      try {
        // Fetch paginated active orders
        const { data: dbOrders, count: exactCount, error: ordersError } = await supabase
          .from('orders')
          .select(`
            id,
            order_number,
            source_portal,
            customer_name,
            customer_email,
            recipient_name,
            product_tier,
            delivery_option,
            queue_status,
            delivery_priority,
            needs_fulfilment,
            payment_status,
            total_amount_nzd,
            created_at,
            shipping_name,
            shipping_address_line1,
            shipping_address_line2,
            shipping_city,
            shipping_region,
            shipping_postcode,
            shipping_country,
            pdf_path,
            printed_at,
            posted_at,
            delivered_at,
            keepsakes (
              id,
              rendered_html,
              pdf_path,
              watermark_status
            )
          `, { count: 'exact' })
          .eq('needs_fulfilment', true)
          .order('delivery_priority', { ascending: true })
          .order('created_at', { ascending: true })
          .range(start, end);

        if (ordersError) throw ordersError;
        paginatedOrders = dbOrders;
        count = exactCount;

        // Fetch all statuses to compute the overall summary card metrics
        const { data: allStatuses, error: statusError } = await supabase
          .from('orders')
          .select('queue_status')
          .eq('needs_fulfilment', true);

        if (statusError) throw statusError;

        // Build the order summary counts across all orders
        summary = (allStatuses || []).reduce((acc, order) => {
          const status = normalizeDisplayStatus(order.queue_status);
          acc.total += 1;
          acc[status] += 1;
          return acc;
        }, { total: 0, pending: 0, printed: 0, posted: 0, delivered: 0 });
      } catch (err) {
        console.warn('GET orders online failed, falling back to local mockDb.');
        const result = paginateArray(mockDb.orders, page, limit);
        paginatedOrders = result.items;
        count = result.total;
        summary = mockDb.orders.reduce((acc, order) => {
          const status = normalizeDisplayStatus(order.queue_status);
          acc.total += 1;
          acc[status] += 1;
          return acc;
        }, { total: 0, pending: 0, printed: 0, posted: 0, delivered: 0 });
      }

      return res.json({
        summary,
        orders: (paginatedOrders || []).sort(compareFulfilmentOrders).map(buildAdminOrderResponse),
        items: (paginatedOrders || []).sort(compareFulfilmentOrders).map(buildAdminOrderResponse),
        total: count || 0,
        page,
        limit,
      });
    } catch (error) {
      console.error('Admin queue load error:', error);
      return res.status(400).json({ error: error.message || 'Unable to load fulfilment queue.' });
    }
  });

  app.get('/api/admin/attribution', authAdmin, async (req, res) => {
    try {
      let data;
      try {
        data = await loadAttributionAdminData(supabase);
      } catch (err) {
        console.warn('GET attribution online failed, falling back to local mockDb.');
        data = {
          consultants: mockDb.sales_consultants,
          promoCodes: mockDb.promo_codes.map(code => ({
            ...code,
            freeDemosUsedThisMonth: 0,
          })),
          territories: mockDb.postcode_territories,
          report: buildAttributionReport(mockDb.sales_consultants, [], [])
        };
      }
      return res.json(data);
    } catch (error) {
      console.error('Admin attribution load error:', error);
      return res.status(400).json({ error: error.message || 'Unable to load attribution data.' });
    }
  });

  // ── SALES CONSULTANTS ──
  app.get('/api/admin/consultants', authAdmin, async (req, res) => {
    try {
      const page = Math.max(Number(req.query.page) || 1, 1);
      const limit = Math.max(Number(req.query.limit) || 20, 1);

      let items, total;
      try {
        const start = (page - 1) * limit;
        const end = start + limit - 1;

        const { data, count, error } = await supabase
          .from('sales_consultants')
          .select('*', { count: 'exact' })
          .order('created_at', { ascending: false })
          .range(start, end);

        if (error) throw error;
        items = data;
        total = count;

        // Phase 8 — client request 23 Aug 2026 (Col): "Commission should
        // show in its own column as a running total." Lifetime (all-time,
        // no date filter — that's what the /commission endpoint below is
        // for) commission owed per consultant on THIS page only, computed
        // from every PAID order attributed to them (the full chain already
        // built in Phase 7 — direct/referral/repeat-purchase orders all
        // carry the same sales_consultant_id, so summing by that column
        // already covers the whole chain with no extra logic needed here,
        // matching Col's confirmation that the full chain counts).
        items = await attachCommissionOwed(supabase, items);
        // Client request, 3 Sept 2026 (Col): "I also want show code in
        // table." Batched the same way as attachCommissionOwed above —
        // one query for every consultant on this page, not one per row.
        items = await attachActiveCode(supabase, items);
      } catch (err) {
        console.warn('GET consultants online failed, falling back to local mockDb.');
        const result = paginateArray(mockDb.sales_consultants, page, limit);
        items = result.items.map(c => ({ ...c, commission_owed: null, code: null })); // mockDb consultants have no real orders/promo_codes table linkage to sum/join against
        total = result.total;
      }
      return res.json({ items, total: total || 0, page, limit });
    } catch (err) {
      console.error('Admin GET consultants error:', err);
      return res.status(400).json({ error: err.message });
    }
  });

  // Phase 8 — commission owed for a single consultant, optionally scoped
  // to a date range ("Commission... can be pulled by a date range" — Col,
  // 23 Aug 2026). Filters on orders.paid_at (when the money actually came
  // in), not created_at — matches how "commission owed this month" would
  // actually be read by Col. No `to` means "up to now"; no `from` means
  // "since the beginning" (== the lifetime total already shown in the list).
  app.get('/api/admin/consultants/:id/commission', authAdmin, async (req, res) => {
    try {
      const id = req.params.id;
      let consultant;
      if (!id.startsWith('c_')) {
        const { data } = await supabase.from('sales_consultants').select('*').eq('id', id).maybeSingle();
        consultant = data || null;
      }
      if (!consultant) consultant = mockDb.sales_consultants.find(c => c.id === id) || null;
      if (!consultant) return res.status(404).json({ error: 'Consultant not found.' });

      const { from, to } = req.query;
      let query = supabase
        .from('orders')
        .select('total_amount_nzd')
        .eq('sales_consultant_id', id)
        .eq('payment_status', 'paid');
      if (from) query = query.gte('paid_at', new Date(from).toISOString());
      if (to) {
        // inclusive of the whole "to" day
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        query = query.lte('paid_at', toDate.toISOString());
      }
      const { data: orders, error } = await query;
      if (error) throw error;

      const salesTotal = (orders || []).reduce((sum, o) => sum + Number(o.total_amount_nzd || 0), 0);

      // Bug fix, 23 Aug 2026 (found in Step 6 testing): a plain select('*')
      // silently omits a column that doesn't exist in the real DB yet —
      // it doesn't error, the key is just absent from the row. Before this
      // fix, `Number(consultant.commission_rate) || 0` treated that
      // exact-same-as-a-genuine-0%-rate, so every commission calc quietly
      // returned $0.00 while src/db.phase8.sql is still pending — which
      // looks like a confirmed answer ("this partner earns nothing"),
      // not the true state ("we don't know yet, the column isn't there").
      // `'commission_rate' in consultant` tells the two apart: the key is
      // present (even if its value is null) once the column exists.
      const rateColumnMissing = !('commission_rate' in consultant);
      const rate = rateColumnMissing ? null : Number(consultant.commission_rate) || 0;
      const commissionOwed = rateColumnMissing ? null : Math.round(salesTotal * (rate / 100) * 100) / 100;

      return res.json({
        consultantId: id,
        commissionRate: rateColumnMissing ? null : consultant.commission_rate,
        orderCount: (orders || []).length,
        salesTotal: Math.round(salesTotal * 100) / 100,
        commissionOwed,
        from: from || null,
        to: to || null,
        ...(rateColumnMissing ? { note: 'src/db.phase8.sql has not been run yet — commission_rate is not stored, so commission cannot be calculated. Sales total above is still accurate.' } : {}),
      });
    } catch (err) {
      console.error('Admin GET consultant commission error:', err);
      return res.status(400).json({ error: err.message });
    }
  });

  // Shared by the list endpoint above — batches ONE orders query for every
  // consultant on the current page rather than one query per row (N+1).
  async function attachCommissionOwed(supabase, consultants) {
    const ids = (consultants || []).map(c => c.id).filter(Boolean);
    if (!ids.length) return consultants;
    const { data: orders, error } = await supabase
      .from('orders')
      .select('sales_consultant_id, total_amount_nzd')
      .eq('payment_status', 'paid')
      .in('sales_consultant_id', ids);
    if (error) {
      console.warn('attachCommissionOwed: orders lookup failed, showing null commission for this page:', error.message);
      return consultants.map(c => ({ ...c, commission_owed: null }));
    }
    const salesByConsultant = new Map();
    for (const o of orders || []) {
      const prev = salesByConsultant.get(o.sales_consultant_id) || 0;
      salesByConsultant.set(o.sales_consultant_id, prev + Number(o.total_amount_nzd || 0));
    }
    return consultants.map(c => {
      // Same missing-column-vs-genuine-zero distinction as the /commission
      // endpoint above — see that comment for the full reasoning. Without
      // this, the list would show a confident "$0.00" for every partner
      // while src/db.phase8.sql is still pending, instead of correctly
      // showing "unknown until migration runs."
      if (!('commission_rate' in c)) return { ...c, commission_owed: null };
      const rate = Number(c.commission_rate) || 0;
      const sales = salesByConsultant.get(c.id) || 0;
      return { ...c, commission_owed: Math.round(sales * (rate / 100) * 100) / 100 };
    });
  }

  // Client request, 3 Sept 2026 (Col): "I also want show code in table."
  // Same batched-single-query pattern as attachCommissionOwed above — the
  // code lives on a different row (promo_codes), same reasoning as the
  // separate GET .../code endpoint used by the edit modal.
  async function attachActiveCode(supabase, consultants) {
    const ids = (consultants || []).map(c => c.id).filter(Boolean);
    if (!ids.length) return consultants;
    const { data: codes, error } = await supabase
      .from('promo_codes')
      .select('consultant_id, code')
      .eq('active', true)
      .in('consultant_id', ids);
    if (error) {
      console.warn('attachActiveCode: promo_codes lookup failed, showing null code for this page:', error.message);
      return consultants.map(c => ({ ...c, code: null }));
    }
    const codeByConsultant = new Map((codes || []).map(row => [row.consultant_id, row.code]));
    return consultants.map(c => ({ ...c, code: codeByConsultant.get(c.id) || null }));
  }

  // Single GET for edit modal
  app.get('/api/admin/consultants/:id', authAdmin, async (req, res) => {
    try {
      let consultant;
      try {
        const { data, error } = await supabase
          .from('sales_consultants')
          .select('*')
          .eq('id', req.params.id)
          .single();
        if (error) throw error;
        consultant = data;
      } catch (err) {
        consultant = mockDb.sales_consultants.find(c => c.id === req.params.id);
        if (!consultant) return res.status(404).json({ error: 'Consultant not found' });
      }
      return res.json(consultant);
    } catch (err) {
      console.error('Admin GET consultant/:id error:', err);
      return res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/admin/consultants', authAdmin, async (req, res) => {
    try {
      // Phase 7 bug fix, 22 Aug 2026: validated BEFORE the try/db-fallback
      // block below, not inside createConsultant() — found during
      // implementation that a validation error thrown from inside
      // createConsultant() was being caught by the inner "DB failed, use
      // mockDb" catch below (which treats ANY error as connectivity
      // failure), silently falling through to mockDb creation instead of
      // returning the clear 400 this validation is supposed to give. A bad
      // partnerType would have silently "succeeded" via mockDb rather than
      // being rejected. Validating here means a bad value never reaches
      // that ambiguous catch at all.
      const partnerTypeRaw = String(req.body?.partnerType || req.body?.partner_type || 'individual').trim();
      if (!PARTNER_TYPES.includes(partnerTypeRaw)) {
        return res.status(400).json({ error: `Invalid partner type. Must be one of: ${PARTNER_TYPES.join(', ')}.` });
      }
      // Phase 8 — same "validate before the ambiguous mockDb-fallback
      // catch" fix as partner type above, so a bad rate gets a clear 400
      // instead of silently succeeding via mockDb (or, in this specific
      // case, throwing an unrelated-looking error from deep inside
      // createConsultant's try block that gets swallowed as "DB failed").
      let commissionRateRaw;
      try {
        commissionRateRaw = normalizeCommissionRate(req.body?.commissionRate !== undefined ? req.body.commissionRate : req.body?.commission_rate);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      if (commissionRateRaw === null && BUSINESS_PARTNER_TYPES.includes(partnerTypeRaw)) {
        commissionRateRaw = DEFAULT_BUSINESS_COMMISSION_RATE;
      }

      let consultant;
      try {
        consultant = await createConsultant(supabase, req.body || {});
      } catch (err) {
        // Bug fix, 2 Sept 2026 (client report, Col — see createConsultant()'s
        // full comment above for the reproduction): a known, real validation
        // error (currently just "duplicate email") must never fall through
        // to the mockDb "assume it's a connectivity failure" branch below —
        // that branch always reports success, which is exactly how this bug
        // silently ate 4 of Col's real signup attempts. Same "validate
        // before the ambiguous catch" principle as partnerType/commissionRate
        // above, just applied to an error that can only be detected after
        // attempting the real insert (a duplicate check needs a DB round
        // trip, so it can't be validated synchronously up front like those).
        if (err.isKnownValidationError) {
          return res.status(409).json({ error: err.message });
        }
        console.warn('POST consultant online failed, falling back to local mockDb.');
        const name = String(req.body.name || '').trim();
        if (!name) throw new Error('Consultant name is required.');
        consultant = {
          id: 'c_' + Date.now(),
          name,
          email: String(req.body.email || '').trim() || null,
          phone: String(req.body.phone || '').trim() || null,
          active: req.body.active !== false,
          commission_notes: String(req.body.commissionNotes || req.body.commission_notes || '').trim() || null,
          admin_notes: String(req.body.adminNotes || req.body.admin_notes || '').trim() || null,
          partner_type: partnerTypeRaw,
          commission_rate: commissionRateRaw,
        };
        mockDb.sales_consultants.unshift(consultant);
      }

      // Phase 6/7 Step 4 — auto-issue the partner's attribution code right
      // after creation (both the real-DB and mockDb paths above land here).
      // A failure here must never turn into a 400/500 for the whole
      // request — the consultant row already exists at this point, so the
      // response always reflects that success; codeGenerated tells the
      // admin UI whether it also got a working code or needs to use the
      // "Generate Code" recovery path instead. `code` is optional — the
      // admin can type their own instead of letting the subsystem
      // generate one (see autoIssueAttributionCode's comment).
      const codeResult = await autoIssueAttributionCode(supabase, consultant, req.body?.code);
      return res.json({ consultant, ...codeResult });
    } catch (error) {
      console.error('Admin consultant create error:', error);
      return res.status(400).json({ error: error.message || 'Unable to create consultant.' });
    }
  });

  // Looks up a consultant by id across both the real DB and mockDb — same
  // small helper duplicated at each of these three routes previously;
  // pulled out once here since a third caller (GET .../code below) needed
  // the exact same lookup.
  async function findConsultantById(supabase, id) {
    let consultant = null;
    if (!id.startsWith('c_')) {
      const { data } = await supabase.from('sales_consultants').select('*').eq('id', id).maybeSingle();
      consultant = data || null;
    }
    if (!consultant) {
      consultant = mockDb.sales_consultants.find(c => c.id === id) || null;
    }
    return consultant;
  }

  // Phase 6/7 Step 4 recovery path, extended 24 Aug 2026 (client request,
  // Col): "I want to see a code creation box for the reseller that either
  // I can manually create or allow the subsystem to create and I need to
  // be able to edit it." Originally this route only handled "consultant
  // has no code yet" (createPromoCode() refuses a second active code for
  // the same consultant). Now it also handles "consultant already has a
  // code and the admin wants to change it" — same endpoint either way, so
  // the admin UI doesn't need to know which case it's in:
  //   - no existing code + no `code` in body  -> auto-generate, create
  //   - no existing code + `code` in body     -> use as typed, create
  //   - existing code    + no `code` in body  -> auto-generate a NEW one, update in place
  //   - existing code    + `code` in body     -> use as typed, update in place
  app.post('/api/admin/consultants/:id/generate-code', authAdmin, async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!id) return res.status(400).json({ error: 'Consultant id is required.' });

      const consultant = await findConsultantById(supabase, id);
      if (!consultant) {
        return res.status(404).json({ error: 'Consultant not found.' });
      }

      const manualCodeRaw = String(req.body?.code || '').trim();
      const { data: existingPromo } = await supabase
        .from('promo_codes')
        .select('id, code')
        .eq('consultant_id', id)
        .eq('active', true)
        .maybeSingle();

      if (existingPromo) {
        try {
          const newCode = manualCodeRaw ? normalizePromoCode(manualCodeRaw) : await createUniqueAttributionCode(supabase, consultant.name, consultant.commission_rate);
          const { data: updated, error } = await supabase
            .from('promo_codes')
            .update({ code: newCode })
            .eq('id', existingPromo.id)
            .select('*')
            .single();
          if (error) {
            // Same duplicate-code polish as createPromoCode() above.
            if (error.code === '23505') {
              throw new Error(`Code "${newCode}" is already in use by another reseller. Please choose a different one.`);
            }
            throw new Error(`Unable to update code: ${error.message}`);
          }
          return res.json({ code: updated.code, promoCodeId: updated.id, codeGenerated: true });
        } catch (err) {
          return res.status(400).json({ error: err.message || 'Unable to update code.' });
        }
      }

      const codeResult = await autoIssueAttributionCode(supabase, consultant, manualCodeRaw);
      if (!codeResult.codeGenerated) {
        return res.status(400).json({ error: codeResult.codeError || 'Unable to generate code.' });
      }
      return res.json(codeResult);
    } catch (error) {
      console.error('Admin generate-code error:', error);
      return res.status(400).json({ error: error.message || 'Unable to generate code.' });
    }
  });

  // GET the current code for a consultant, so the edit modal can show and
  // pre-fill it (client request, 24 Aug 2026 — "a code creation box for
  // the reseller ... I need to be able to edit it"). Returns
  // { code: null } rather than 404 when the consultant has no active code
  // yet — that's a normal, expected state (e.g. auto-issue failed at
  // signup), not an error.
  app.get('/api/admin/consultants/:id/code', authAdmin, async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!id) return res.status(400).json({ error: 'Consultant id is required.' });
      const consultant = await findConsultantById(supabase, id);
      if (!consultant) return res.status(404).json({ error: 'Consultant not found.' });

      const { data: existingPromo } = await supabase
        .from('promo_codes')
        .select('id, code')
        .eq('consultant_id', id)
        .eq('active', true)
        .maybeSingle();

      return res.json({ code: existingPromo?.code || null, promoCodeId: existingPromo?.id || null });
    } catch (error) {
      console.error('Admin GET consultant code error:', error);
      return res.status(400).json({ error: error.message || 'Unable to load code.' });
    }
  });

  app.put('/api/admin/consultants/:id', authAdmin, async (req, res) => {
    try {
      const { name, email, phone, active, commissionNotes, adminNotes, commissionRate, commission_rate: commissionRateSnake } = req.body;
      const partnerTypeInput = req.body.partnerType !== undefined ? req.body.partnerType : req.body.partner_type;
      const patch = {};
      if (name !== undefined) patch.name = String(name).trim();
      // Bug fix, 2 Sept 2026 (found in a no-gap test pass right after
      // fixing the identical issue on POST /consultants — same class of
      // bug, this route was never covered): editing an existing reseller
      // to an email another reseller already has hit the real unique
      // constraint on sales_consultants.email, but this route's outer
      // catch (below) treats ANY update failure as "must be a mockDb-only
      // record" and looks it up there — for a REAL reseller with a REAL
      // UUID, that lookup always misses, producing a flatly wrong 404
      // "Consultant not found" for a record that very much exists. Same
      // proactive-check-before-the-ambiguous-catch fix as createConsultant().
      if (email !== undefined) {
        // Bug fix (found in this same review pass): unlike createConsultant()
        // and the other PUT routes in this file (stations, florists — see
        // lines ~1512/1775), this one wasn't lowercasing the email, so an
        // edit could leave it stored in mixed/upper case. Not a functional
        // bug (the duplicate check below and login lookups elsewhere are
        // already case-insensitive via .ilike()), but a real data-
        // consistency gap against the convention every other email field
        // in this file follows — fixed to match.
        patch.email = String(email).trim().toLowerCase() || null;
        if (patch.email) {
          const { data: existingByEmail } = await supabase
            .from('sales_consultants')
            .select('id, name')
            .ilike('email', patch.email)
            .neq('id', req.params.id)
            .maybeSingle();
          if (existingByEmail) {
            return res.status(409).json({ error: `This email is already used by another reseller: ${existingByEmail.name}. Use a different email, or edit that existing reseller instead.` });
          }
        }
      }
      if (phone !== undefined) patch.phone = String(phone).trim() || null;
      if (active !== undefined) patch.active = Boolean(active);
      if (commissionNotes !== undefined) patch.commission_notes = String(commissionNotes).trim() || null;
      if (adminNotes !== undefined) patch.admin_notes = String(adminNotes).trim() || null;
      // Bug fix, 24 Aug 2026 (client report, Col): "the drop down menu for
      // type of seller doesn't allow me to change it which I think we
      // should have the ability to do" / "on the edit consultant screen
      // the Partner Type drop-down menu doesn't work when you click edit"
      // — reported twice. Partner type was deliberately LOCKED after
      // creation in Phase 6/7 (Step 1), matching the florist Business Type
      // precedent — but Col has now explicitly asked for it to be
      // editable, overriding that earlier design choice. Validated the
      // same way as create (PARTNER_TYPES allow-list, clear 400 on a bad
      // value) rather than trusting the DB constraint alone.
      if (partnerTypeInput !== undefined) {
        const partnerTypeRaw = String(partnerTypeInput).trim();
        if (!PARTNER_TYPES.includes(partnerTypeRaw)) {
          return res.status(400).json({ error: `Invalid partner type. Must be one of: ${PARTNER_TYPES.join(', ')}.` });
        }
        patch.partner_type = partnerTypeRaw;
      }
      // Phase 8 — client request 23 Aug 2026 (Col): "yes rate should still
      // be editable." Unlike partner_type (locked after creation), the
      // commission rate is deliberately editable for the life of the
      // partner — a business's deal can change, an individual's rate gets
      // set here for the first time after sign-up if it wasn't known yet.
      const commissionRateInput = commissionRate !== undefined ? commissionRate : commissionRateSnake;
      if (commissionRateInput !== undefined) {
        try {
          patch.commission_rate = normalizeCommissionRate(commissionRateInput);
        } catch (err) {
          return res.status(400).json({ error: err.message });
        }
      }
      // Phase 10 — client request, 3 Sept 2026 (Col, reference screenshot):
      // full postal address + per-platform follower counts, editable the
      // same way every other agent field already is. Each is only set
      // when actually present in the request body, matching the existing
      // partial-patch convention for every field above.
      const addressLine1Input = req.body.addressLine1 !== undefined ? req.body.addressLine1 : req.body.address_line1;
      if (addressLine1Input !== undefined) patch.address_line1 = String(addressLine1Input).trim() || null;
      const addressLine2Input = req.body.addressLine2 !== undefined ? req.body.addressLine2 : req.body.address_line2;
      if (addressLine2Input !== undefined) patch.address_line2 = String(addressLine2Input).trim() || null;
      if (req.body.city !== undefined) patch.city = String(req.body.city).trim() || null;
      if (req.body.country !== undefined) patch.country = String(req.body.country).trim() || null;
      if (req.body.socialsProvided) {
        Object.assign(patch, buildSocialFollowerColumns(req.body));
      }

      let consultant;
      try {
        let { data, error } = await supabase
          .from('sales_consultants')
          .update(patch)
          .eq('id', req.params.id)
          .select('*')
          .single();

        // Phase 8 graceful-degrade, 23 Aug 2026 (extended 24 Aug 2026 to
        // also cover partner_type, now that it's editable too): without
        // this, editing a consultant while either migration is pending
        // would fall all the way through to the mockDb branch below for
        // ANY edit (even just a name/email change unrelated to these two
        // fields) — the moment either was included in the patch. That's a
        // worse outcome than just dropping the field(s) the DB can't
        // accept yet: the admin's real edits (name, active, notes) should
        // still land in the real row. Same retry-without-the-missing-
        // column pattern as createConsultant() above.
        const missingColumnsInPatch = OPTIONAL_CONSULTANT_COLUMNS.filter(col => Object.prototype.hasOwnProperty.call(patch, col));
        if (isMissingColumnError(error) && missingColumnsInPatch.length) {
          const requestedValues = {};
          missingColumnsInPatch.forEach(col => { requestedValues[col] = patch[col]; delete patch[col]; });
          // Bug fix, 23 Aug 2026 (found in Step 6 testing): if commission_rate
          // was the ONLY field being patched (e.g. the admin only touched
          // the rate field), stripping it leaves an EMPTY patch object.
          // `.update({})` is not a no-op in PostgREST — it returns zero
          // rows (PGRST116, "Cannot coerce the result to a single JSON
          // object"), which isn't a missing-column error, so it fell
          // through to `if (error) throw error` and from there into the
          // mockDb fallback — which then 404'd because a real consultant's
          // UUID is never found in mockDb. A real edit was being reported
          // as "consultant not found." Skip the retry update entirely in
          // that case and just re-fetch the current row instead — there's
          // nothing left to write, but the response should still reflect
          // the row as it stands (plus the rate the admin asked for).
          if (Object.keys(patch).length === 0) {
            ({ data, error } = await supabase.from('sales_consultants').select('*').eq('id', req.params.id).single());
          } else {
            ({ data, error } = await supabase
              .from('sales_consultants')
              .update(patch)
              .eq('id', req.params.id)
              .select('*')
              .single());
          }
          if (data) Object.assign(data, requestedValues); // reflect requested values even though not persisted yet
        }

        // Belt-and-suspenders alongside the proactive email check above: a
        // race between two simultaneous edits could still hit the real
        // unique constraint even after that check passed. Same marker
        // pattern as createConsultant() — a genuine duplicate must never
        // be silently reclassified as "not found" via the mockDb fallback.
        if (error && error.code === '23505') {
          return res.status(409).json({ error: 'This email is already used by another reseller.' });
        }

        if (error) throw error;
        consultant = data;
      } catch (err) {
        console.warn('PUT consultant online failed, falling back to local mockDb.');
        const idx = mockDb.sales_consultants.findIndex(c => c.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Consultant not found' });
        consultant = { ...mockDb.sales_consultants[idx], ...patch };
        mockDb.sales_consultants[idx] = consultant;
      }
      return res.json({ consultant });
    } catch (err) {
      console.error('Admin PUT consultant error:', err);
      return res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/admin/consultants/:id', authAdmin, async (req, res) => {
    try {
      try {
        const { error } = await supabase
          .from('sales_consultants')
          .delete()
          .eq('id', req.params.id);

        if (error) throw error;
      } catch (err) {
        console.warn('DELETE consultant online failed, falling back to local mockDb.');
        const idx = mockDb.sales_consultants.findIndex(c => c.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Consultant not found' });
        mockDb.sales_consultants.splice(idx, 1);
      }
      return res.json({ success: true });
    } catch (err) {
      console.error('Admin DELETE consultant error:', err);
      return res.status(400).json({ error: err.message });
    }
  });

  // ── PROMO CODES ──
  app.get('/api/admin/promo-codes', authAdmin, async (req, res) => {
    try {
      const page = Math.max(Number(req.query.page) || 1, 1);
      const limit = Math.max(Number(req.query.limit) || 20, 1);

      let items, total;
      try {
        const start = (page - 1) * limit;
        const end = start + limit - 1;

        // Client request, 1 Oct 2026 (Col, screenshot): this screen is the
        // consultant/agent-referral codes directory — it was showing every
        // promo_codes row regardless of type, so campaign/GCash/auto-generated
        // codes (which never have an agent) leaked in alongside real agent
        // codes, making the whole screen look broken. Scoped to the one type
        // this screen is actually for; see new_changes.md Step 5.
        const { data, count, error } = await supabase
          .from('promo_codes')
          .select('*, sales_consultants(id, name, email)', { count: 'exact' })
          .eq('code_type', 'consultant_demo')
          .order('created_at', { ascending: false })
          .range(start, end);

        if (error) throw error;

        const now = new Date();
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
        const { data: freeDemos } = await supabase
          .from('keepsakes')
          .select('id, promo_code_id')
          .eq('is_free_demo', true)
          .gte('created_at', monthStart);

        items = (data || []).map(code => ({
          ...code,
          freeDemosUsedThisMonth: (freeDemos || []).filter(demo => demo.promo_code_id === code.id).length,
        }));
        total = count;
      } catch (err) {
        console.warn('GET promo-codes online failed, falling back to local mockDb.');
        const result = paginateArray(mockDb.promo_codes, page, limit);
        items = result.items.map(code => ({
          ...code,
          freeDemosUsedThisMonth: 0,
          sales_consultants: mockDb.sales_consultants.find(c => c.id === code.consultant_id) || null
        }));
        total = result.total;
      }
      return res.json({ items, total: total || 0, page, limit });
    } catch (err) {
      console.error('Admin GET promo-codes error:', err);
      return res.status(400).json({ error: err.message });
    }
  });

  // Single GET for edit modal
  app.get('/api/admin/promo-codes/:id', authAdmin, async (req, res) => {
    try {
      let promoCode;
      try {
        const { data, error } = await supabase
          .from('promo_codes')
          .select('*, sales_consultants(id, name, email)')
          .eq('id', req.params.id)
          .single();
        if (error) throw error;
        promoCode = data;
      } catch (err) {
        promoCode = mockDb.promo_codes.find(p => p.id === req.params.id);
        if (!promoCode) return res.status(404).json({ error: 'Promo code not found' });
      }
      return res.json(promoCode);
    } catch (err) {
      console.error('Admin GET promo-codes/:id error:', err);
      return res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/admin/promo-codes', authAdmin, async (req, res) => {
    try {
      let promoCode;
      try {
        promoCode = await createPromoCode(supabase, req.body || {});
      } catch (err) {
        // Bug fix, 2 Sept 2026 — same class as the reseller fix: a known
        // business-rule rejection (duplicate code, or consultant already
        // has one) must never fall through to the mockDb branch, which
        // always reports success. See createPromoCode()'s comments above.
        if (err.isKnownValidationError) {
          return res.status(409).json({ error: err.message });
        }
        console.warn('POST promo-code online failed, falling back to local mockDb.');
        const consultantId = String(req.body.consultantId || req.body.consultant_id || '').trim();
        const code = normalizePromoCode(req.body.code);
        const limit = Number(req.body.monthlyFreeDemoLimit || req.body.monthly_free_demo_limit || 5);

        if (!consultantId) throw new Error('Consultant is required for a promo code.');
        if (!code) throw new Error('Promo code is required.');
        if (!Number.isInteger(limit) || limit < 0) throw new Error('Monthly free demo limit must be zero or more.');

        promoCode = {
          id: 'p_' + Date.now(),
          consultant_id: consultantId,
          code,
          active: req.body.active !== false,
          monthly_free_demo_limit: limit,
          notes: String(req.body.notes || '').trim() || null
        };
        mockDb.promo_codes.unshift(promoCode);
      }
      return res.json({ promoCode });
    } catch (error) {
      console.error('Admin promo create error:', error);
      return res.status(400).json({ error: error.message || 'Unable to create promo code.' });
    }
  });

  app.put('/api/admin/promo-codes/:id', authAdmin, async (req, res) => {
    try {
      const { consultantId, code, monthlyFreeDemoLimit, active, notes } = req.body;
      const patch = {};
      if (consultantId !== undefined) patch.consultant_id = consultantId;
      // Bug fix, 2 Sept 2026 (same sweep as the reseller/promo-create
      // fixes): editing a code's text to one already used elsewhere hit
      // the real unique constraint, but this route's outer catch (below)
      // treated ANY update failure as "must be mockDb-only" and returned
      // a flatly wrong 404 "Promo code not found" for a code that very
      // much exists. Proactive check, same pattern as the reseller PUT fix.
      if (code !== undefined) {
        patch.code = normalizePromoCode(code);
        const { data: existingByCode } = await supabase
          .from('promo_codes')
          .select('id, code')
          .ilike('code', patch.code)
          .neq('id', req.params.id)
          .maybeSingle();
        if (existingByCode) {
          return res.status(409).json({ error: `Code "${patch.code}" is already in use by another reseller. Please choose a different one.` });
        }
      }
      if (monthlyFreeDemoLimit !== undefined) {
        const limit = Number(monthlyFreeDemoLimit);
        if (!Number.isInteger(limit) || limit < 0) {
          throw new Error('Monthly free demo limit must be zero or more.');
        }
        patch.monthly_free_demo_limit = limit;
      }
      if (active !== undefined) patch.active = Boolean(active);
      if (notes !== undefined) patch.notes = String(notes).trim() || null;

      let promoCode;
      try {
        const { data, error } = await supabase
          .from('promo_codes')
          .update(patch)
          .eq('id', req.params.id)
          .select('*')
          .single();

        // Belt-and-suspenders alongside the proactive check above (race
        // between two simultaneous edits).
        if (error && error.code === '23505') {
          return res.status(409).json({ error: 'This code is already in use by another reseller.' });
        }

        if (error) throw error;
        promoCode = data;
      } catch (err) {
        console.warn('PUT promo-code online failed, falling back to local mockDb.');
        const idx = mockDb.promo_codes.findIndex(p => p.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Promo code not found' });
        promoCode = { ...mockDb.promo_codes[idx], ...patch };
        mockDb.promo_codes[idx] = promoCode;
      }
      return res.json({ promoCode });
    } catch (err) {
      console.error('Admin PUT promo-code error:', err);
      return res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/admin/promo-codes/:id', authAdmin, async (req, res) => {
    try {
      try {
        const { error } = await supabase
          .from('promo_codes')
          .delete()
          .eq('id', req.params.id);

        if (error) throw error;
      } catch (err) {
        console.warn('DELETE promo-code online failed, falling back to local mockDb.');
        const idx = mockDb.promo_codes.findIndex(p => p.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Promo code not found' });
        mockDb.promo_codes.splice(idx, 1);
      }
      return res.json({ success: true });
    } catch (err) {
      console.error('Admin DELETE promo-code error:', err);
      return res.status(400).json({ error: err.message });
    }
  });

  // ── CAMPAIGN PROMO CODES (single-use, batch-generated, country-scoped) ──
  // Distinct from the two other code_type values already in this table:
  //   - 'consultant_demo'   — reusable monthly free-demo quota per consultant
  //   - 'gcash_paid_access' — auto-generated codes unlocking an already-paid
  //                           GCash order (see Step 2, new_changes.md)
  // This is the system requested for the Philippines florist/GCash model —
  // e.g. WELCOME20 for Jhe-Ann's Facebook campaign — a single code or a
  // batch of codes, each usable exactly once, for a real percentage or fixed
  // discount at checkout, optionally restricted to one country.
  //
  // Requires src/db.phase4.sql to have been run (adds discount_type,
  // discount_value, country, batch_id, batch_label, stripe_coupon_id columns
  // and allows 'campaign_single_use' in the code_type check constraint).

  function generateCampaignCode(prefix) {
    const suffix = require('crypto').randomBytes(3).toString('hex').toUpperCase();
    const cleanPrefix = String(prefix || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    return (cleanPrefix ? cleanPrefix + '-' : '') + suffix;
  }

  app.get('/api/admin/campaign-codes', authAdmin, async (req, res) => {
    try {
      const page = Math.max(Number(req.query.page) || 1, 1);
      const limit = Math.max(Number(req.query.limit) || 20, 1);
      const start = (page - 1) * limit;
      const end = start + limit - 1;

      const { data, count, error } = await supabase
        .from('promo_codes')
        .select('*', { count: 'exact' })
        .eq('code_type', 'campaign_single_use')
        .order('created_at', { ascending: false })
        .range(start, end);

      if (error) throw error;
      return res.json({ items: data || [], total: count || 0, page, limit });
    } catch (err) {
      console.error('Admin GET campaign-codes error:', err);
      return res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/admin/campaign-codes/batch', authAdmin, async (req, res) => {
    try {
      const label = String(req.body?.label || '').trim();
      const discountType = req.body?.discountType === 'fixed' ? 'fixed' : 'percent';
      const discountValue = Number(req.body?.discountValue);
      const country = String(req.body?.country || '').trim() || null;
      const quantity = Math.min(Math.max(Number(req.body?.quantity) || 1, 1), 500);
      const singleCode = String(req.body?.code || '').trim().toUpperCase();
      const codePrefix = String(req.body?.codePrefix || '').trim();
      const validUntil = req.body?.validUntil ? new Date(req.body.validUntil).toISOString() : null;
      // Client request, 1 Oct 2026 (Col): wanted a code ("CDMFREE") reusable
      // by many customers, not just non-expiring. max_uses used to be
      // hardcoded to 1 with no way to change it — every code was single-use
      // regardless of intent. Defaults to 1 (unchanged behavior for every
      // existing/other code-creation flow); only differs when explicitly
      // requested. See new_changes.md Step 8.
      //
      // Bug fix, 1 Oct 2026 (found during a live deep-audit pass): the
      // original `Math.max(Number(x) || 1, 1)` had no upper bound and no
      // integer coercion. `Number("5e10")` is a valid, truthy, finite
      // number (50 billion) that would sail straight through — a stray
      // digit or scientific-notation paste in the admin form could create
      // an effectively-infinite-use code with no sanity cap. `Infinity`
      // itself is also truthy and finite-looking to `||`, but fails
      // `Number.isFinite()`, which this now explicitly checks before
      // falling back to 1. `Math.floor` enforces max_uses is always a real
      // integer (the DB column is a count, not a decimal). Capped at
      // 100,000 — far beyond any real campaign's realistic use, but low
      // enough to make a typo/paste error obviously wrong rather than
      // silently "unlimited."
      const rawMaxUses = Number(req.body?.maxUses);
      const maxUses = Number.isFinite(rawMaxUses)
        ? Math.min(Math.max(Math.floor(rawMaxUses), 1), 100000)
        : 1;

      if (!label) throwStatus(400, 'A label for this batch/campaign is required.');
      if (!discountValue || discountValue <= 0) throwStatus(400, 'A discount amount greater than zero is required.');
      if (discountType === 'percent' && discountValue > 100) throwStatus(400, 'A percentage discount cannot exceed 100.');
      if (!stripe) throwStatus(500, 'Stripe is not configured on this server.');

      // One Stripe coupon per batch — every code in the batch shares it,
      // rather than creating a new coupon per individual code.
      const coupon = await stripe.coupons.create(
        discountType === 'percent'
          ? { percent_off: discountValue, duration: 'once', name: label.slice(0, 40) }
          : { amount_off: Math.round(discountValue * 100), currency: 'nzd', duration: 'once', name: label.slice(0, 40) }
      );

      const batchId = require('crypto').randomUUID();
      const codesToCreate = singleCode
        ? [singleCode]
        : Array.from({ length: quantity }, () => generateCampaignCode(codePrefix));

      const rows = codesToCreate.map(code => ({
        code,
        code_type: 'campaign_single_use',
        active: true,
        monthly_free_demo_limit: 0,
        max_uses: maxUses,
        used_count: 0,
        discount_type: discountType,
        discount_value: discountValue,
        country,
        valid_until: validUntil,
        batch_id: batchId,
        batch_label: label,
        stripe_coupon_id: coupon.id,
      }));

      const { data, error } = await supabase
        .from('promo_codes')
        .insert(rows)
        .select('*');

      if (error) {
        // Roll back the Stripe coupon if the codes themselves failed to save,
        // so a failed batch doesn't leave an orphaned coupon behind.
        await stripe.coupons.del(coupon.id).catch(() => {});
        if (error.code === '23505') {
          throwStatus(409, `Code "${singleCode}" already exists. Choose a different code.`);
        }
        throw error;
      }

      return res.json({ batchId, label, stripeCouponId: coupon.id, codes: data });
    } catch (error) {
      console.error('Admin create campaign-codes batch error:', error);
      return res.status(error.statusCode || 400).json({ error: error.message || 'Unable to create campaign codes.' });
    }
  });

  app.patch('/api/admin/campaign-codes/:id', authAdmin, async (req, res) => {
    try {
      const patch = {};
      if (req.body?.active !== undefined) patch.active = Boolean(req.body.active);
      if (req.body?.validUntil !== undefined) {
        patch.valid_until = req.body.validUntil ? new Date(req.body.validUntil).toISOString() : null;
      }
      if (!Object.keys(patch).length) throwStatus(400, 'Nothing to update.');

      const { data, error } = await supabase
        .from('promo_codes')
        .update(patch)
        .eq('id', req.params.id)
        .eq('code_type', 'campaign_single_use')
        .select('*')
        .single();

      if (error || !data) return res.status(404).json({ error: 'Campaign code not found.' });
      return res.json({ promoCode: data });
    } catch (error) {
      console.error('Admin PATCH campaign-code error:', error);
      return res.status(error.statusCode || 400).json({ error: error.message || 'Unable to update campaign code.' });
    }
  });

  app.delete('/api/admin/campaign-codes/:id', authAdmin, async (req, res) => {
    try {
      // Only ever delete a code that's never been used — a redeemed code is
      // part of the order history and must not disappear from the audit trail.
      const { data, error } = await supabase
        .from('promo_codes')
        .delete()
        .eq('id', req.params.id)
        .eq('code_type', 'campaign_single_use')
        .eq('used_count', 0)
        .select('id')
        .single();

      if (error || !data) {
        return res.status(409).json({ error: 'This code has already been used and cannot be deleted, or was not found.' });
      }
      return res.json({ success: true });
    } catch (error) {
      console.error('Admin DELETE campaign-code error:', error);
      return res.status(400).json({ error: error.message });
    }
  });

  // ── POSTCODE TERRITORIES ──
  app.get('/api/admin/postcode-territories', authAdmin, async (req, res) => {
    try {
      const page = Math.max(Number(req.query.page) || 1, 1);
      const limit = Math.max(Number(req.query.limit) || 20, 1);

      let items, total;
      try {
        const start = (page - 1) * limit;
        const end = start + limit - 1;

        const { data, count, error } = await supabase
          .from('postcode_territories')
          .select('*, sales_consultants(id, name, email)', { count: 'exact' })
          .order('priority', { ascending: true })
          .range(start, end);

        if (error) throw error;
        items = data;
        total = count;
      } catch (err) {
        console.warn('GET postcode-territories online failed, falling back to local mockDb.');
        const result = paginateArray(mockDb.postcode_territories, page, limit);
        items = result.items.map(t => ({
          ...t,
          sales_consultants: mockDb.sales_consultants.find(c => c.id === t.consultant_id) || null
        }));
        total = result.total;
      }
      return res.json({ items, total: total || 0, page, limit });
    } catch (err) {
      console.error('Admin GET postcode-territories error:', err);
      return res.status(400).json({ error: err.message });
    }
  });

  // Single GET for edit modal
  app.get('/api/admin/postcode-territories/:id', authAdmin, async (req, res) => {
    try {
      let territory;
      try {
        const { data, error } = await supabase
          .from('postcode_territories')
          .select('*, sales_consultants(id, name, email)')
          .eq('id', req.params.id)
          .single();
        if (error) throw error;
        territory = data;
      } catch (err) {
        territory = mockDb.postcode_territories.find(t => t.id === req.params.id);
        if (!territory) return res.status(404).json({ error: 'Territory not found' });
      }
      return res.json(territory);
    } catch (err) {
      console.error('Admin GET postcode-territories/:id error:', err);
      return res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/admin/postcode-territories', authAdmin, async (req, res) => {
    try {
      let territory;
      try {
        territory = await createPostcodeTerritory(supabase, req.body || {});
      } catch (err) {
        console.warn('POST postcode-territory online failed, falling back to local mockDb.');
        const consultantId = String(req.body.consultantId || req.body.consultant_id || '').trim();
        const territoryName = String(req.body.territoryName || req.body.territory_name || '').trim();
        const country = String(req.body.country || 'New Zealand').trim();
        const matchType = String(req.body.matchType || req.body.match_type || 'exact').trim().toLowerCase();
        const postcodeStart = String(req.body.postcodeStart || req.body.postcode_start || '').trim();
        const postcodeEnd = String(req.body.postcodeEnd || req.body.postcode_end || '').trim() || null;
        const priority = Number(req.body.priority || 100);

        if (!consultantId) throw new Error('Consultant is required for a postcode territory.');
        if (!postcodeStart) throw new Error('Postcode start is required.');
        if (!['exact', 'prefix', 'range'].includes(matchType)) throw new Error('Match type must be exact, prefix, or range.');
        if (matchType === 'range' && !postcodeEnd) throw new Error('Postcode end is required for range matching.');

        territory = {
          id: 't_' + Date.now(),
          consultant_id: consultantId,
          territory_name: territoryName || postcodeStart,
          country,
          match_type: matchType,
          postcode_start: postcodeStart,
          postcode_end: postcodeEnd,
          priority: Number.isFinite(priority) ? priority : 100,
          active: req.body.active !== false,
          notes: String(req.body.notes || '').trim() || null
        };
        mockDb.postcode_territories.push(territory);
      }
      return res.json({ territory });
    } catch (error) {
      console.error('Admin territory create error:', error);
      return res.status(400).json({ error: error.message || 'Unable to create postcode territory.' });
    }
  });

  app.put('/api/admin/postcode-territories/:id', authAdmin, async (req, res) => {
    try {
      const { consultantId, territoryName, country, matchType, postcodeStart, postcodeEnd, priority, active, notes } = req.body;
      const patch = {};
      if (consultantId !== undefined) patch.consultant_id = consultantId;
      if (territoryName !== undefined) patch.territory_name = String(territoryName).trim();
      if (country !== undefined) patch.country = String(country).trim();
      if (matchType !== undefined) {
        const mType = String(matchType).trim().toLowerCase();
        if (!['exact', 'prefix', 'range'].includes(mType)) {
          throw new Error('Match type must be exact, prefix, or range.');
        }
        patch.match_type = mType;
      }
      if (postcodeStart !== undefined) patch.postcode_start = String(postcodeStart).trim();
      if (postcodeEnd !== undefined) patch.postcode_end = String(postcodeEnd).trim() || null;
      if (priority !== undefined) patch.priority = Number(priority);
      if (active !== undefined) patch.active = Boolean(active);
      if (notes !== undefined) patch.notes = String(notes).trim() || null;

      let territory;
      try {
        const { data, error } = await supabase
          .from('postcode_territories')
          .update(patch)
          .eq('id', req.params.id)
          .select('*')
          .single();

        if (error) throw error;
        territory = data;
      } catch (err) {
        console.warn('PUT postcode-territory online failed, falling back to local mockDb.');
        const idx = mockDb.postcode_territories.findIndex(t => t.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Territory not found' });
        territory = { ...mockDb.postcode_territories[idx], ...patch };
        mockDb.postcode_territories[idx] = territory;
      }
      return res.json({ territory });
    } catch (err) {
      console.error('Admin PUT postcode-territory error:', err);
      return res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/admin/postcode-territories/:id', authAdmin, async (req, res) => {
    try {
      try {
        const { error } = await supabase
          .from('postcode_territories')
          .delete()
          .eq('id', req.params.id);

        if (error) throw error;
      } catch (err) {
        console.warn('DELETE postcode-territory online failed, falling back to local mockDb.');
        const idx = mockDb.postcode_territories.findIndex(t => t.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Territory not found' });
        mockDb.postcode_territories.splice(idx, 1);
      }
      return res.json({ success: true });
    } catch (err) {
      console.error('Admin DELETE postcode-territory error:', err);
      return res.status(400).json({ error: err.message });
    }
  });

  // ── STATIONS (RADIO MANAGERS) ──
  app.get('/api/admin/stations', authAdmin, async (req, res) => {
    try {
      const page = Math.max(Number(req.query.page) || 1, 1);
      const limit = Math.max(Number(req.query.limit) || 20, 1);

      let items, total;
      try {
        const start = (page - 1) * limit;
        const end = start + limit - 1;

        const { data, count, error } = await supabase
          .from('stations')
          .select('*', { count: 'exact' })
          .eq('account_type', 'radio')
          .order('name', { ascending: true })
          .range(start, end);

        if (error) throw error;
        items = data;
        total = count;
      } catch (err) {
        console.warn('GET stations online failed, falling back to local mockDb.');
        const list = mockDb.stations.filter(s => s.account_type === 'radio');
        const result = paginateArray(list, page, limit);
        items = result.items;
        total = result.total;
      }
      return res.json({ items, total: total || 0, page, limit });
    } catch (err) {
      console.error('Admin GET stations error:', err);
      return res.status(400).json({ error: err.message });
    }
  });

  // Single GET for edit modal
  app.get('/api/admin/stations/:id', authAdmin, async (req, res) => {
    try {
      let station;
      try {
        const { data, error } = await supabase
          .from('stations')
          .select('*')
          .eq('id', req.params.id)
          .eq('account_type', 'radio')
          .single();
        if (error) throw error;
        station = data;
      } catch (err) {
        station = mockDb.stations.find(s => s.id === req.params.id && s.account_type === 'radio');
        if (!station) return res.status(404).json({ error: 'Station not found' });
      }
      return res.json(station);
    } catch (err) {
      console.error('Admin GET stations/:id error:', err);
      return res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/admin/stations', authAdmin, async (req, res) => {
    try {
      let station;
      try {
        const name = String(req.body?.name || '').trim();
        const email = String(req.body?.email || '').trim().toLowerCase();
        const password = String(req.body?.password || '');
        const country = String(req.body?.country || 'New Zealand').trim();
        const tier = String(req.body?.tier || 'community').trim();

        if (!name || !email || !password) {
          return res.status(400).json({ error: 'Name, email, and password are required.' });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        // Wholesale buying code — client request, 19 Aug 2026 (Col): same
        // WS+name format as florist/gift-shop/cake-shop accounts, "should
        // also follow through for... radio stations." See
        // src/phase2/wholesale-code.js.
        //
        // Bug fix, 2 Sept 2026 (found sweeping the whole dashboard for the
        // wholesale_code bug already fixed on the florist route — this is
        // a SEPARATE insert block for radio stations that had the exact
        // same vulnerability and was never covered by that fix):
        // src/db.phase6.sql (adds wholesale_code) still hasn't been run
        // against the real DB, so createUniqueWholesaleCode() throws
        // here, gets caught by the outer catch below, and the station
        // silently lands in mockDb — invisible, unusable, gone on
        // restart — while the admin sees a normal "success" response.
        // Same graceful-degrade fix: drop wholesale_code specifically if
        // the column isn't there yet, land in the real table either way.
        let wholesaleCode = null;
        try {
          wholesaleCode = await createUniqueWholesaleCode(supabase, name);
        } catch (wcErr) {
          if (!isMissingColumnError(wcErr)) throw wcErr;
          console.warn('wholesale_code column missing (src/db.phase6.sql not yet run) — creating station without one.');
        }

        const insertRow = {
          name,
          email,
          password_hash: passwordHash,
          country,
          tier,
          account_type: 'radio',
          active: true
        };
        if (wholesaleCode) insertRow.wholesale_code = wholesaleCode;

        let { data: dbStation, error } = await supabase
          .from('stations')
          .insert(insertRow)
          .select()
          .single();

        if (isMissingColumnError(error) && Object.prototype.hasOwnProperty.call(insertRow, 'wholesale_code')) {
          delete insertRow.wholesale_code;
          ({ data: dbStation, error } = await supabase.from('stations').insert(insertRow).select().single());
        }

        if (error) {
          if (error.code === '23505') {
            return res.status(409).json({ error: 'Email address already registered.' });
          }
          throw error;
        }
        station = dbStation;
      } catch (err) {
        console.warn('POST station online failed, falling back to local mockDb.');
        const name = String(req.body?.name || '').trim();
        const email = String(req.body?.email || '').trim().toLowerCase();
        const country = String(req.body?.country || 'New Zealand').trim();
        const tier = String(req.body?.tier || 'community').trim();

        if (!name || !email) throw new Error('Name and email are required.');

        const existingMockCodes = new Set(
          mockDb.stations.filter(s => s.wholesale_code).map(s => String(s.wholesale_code).toLowerCase())
        );
        const wholesaleCode = resolveAvailableCode(buildBaseWholesaleCode(name), existingMockCodes);

        station = {
          id: 's_' + Date.now(),
          name,
          email,
          country,
          tier,
          account_type: 'radio',
          wholesale_code: wholesaleCode,
          active: true
        };
        mockDb.stations.push(station);
      }
      return res.json({ station });
    } catch (error) {
      console.error('Admin create station error:', error);
      return res.status(500).json({ error: error.message || 'Unable to add station manager.' });
    }
  });

  app.put('/api/admin/stations/:id', authAdmin, async (req, res) => {
    try {
      const { name, email, password, country, tier, active } = req.body;
      const patch = {};
      if (name !== undefined) patch.name = String(name).trim();
      // Bug fix, 2 Sept 2026 (same dashboard-wide sweep as the reseller
      // and promo-code fixes): editing a station's email to one already
      // used by another account hit the real unique constraint, but this
      // route's outer catch (below) misreported it as 404 "Station
      // manager not found" for a station that very much exists — same
      // proactive-check pattern as those fixes.
      if (email !== undefined) {
        patch.email = String(email).trim().toLowerCase();
        if (patch.email) {
          const { data: existingByEmail } = await supabase
            .from('stations')
            .select('id, name')
            .ilike('email', patch.email)
            .neq('id', req.params.id)
            .maybeSingle();
          if (existingByEmail) {
            return res.status(409).json({ error: `This email is already used by another station: ${existingByEmail.name}. Use a different email, or edit that existing station instead.` });
          }
        }
      }
      if (password) {
        patch.password_hash = await bcrypt.hash(password, 12);
      }
      if (country !== undefined) patch.country = String(country).trim();
      if (tier !== undefined) patch.tier = String(tier).trim();
      if (active !== undefined) patch.active = Boolean(active);

      let station;
      try {
        const { data, error } = await supabase
          .from('stations')
          .update(patch)
          .eq('id', req.params.id)
          .eq('account_type', 'radio')
          .select('*')
          .single();

        if (error && error.code === '23505') {
          return res.status(409).json({ error: 'This email is already used by another station.' });
        }
        if (error) throw error;
        station = data;
      } catch (err) {
        console.warn('PUT station online failed, falling back to local mockDb.');
        const idx = mockDb.stations.findIndex(s => s.id === req.params.id && s.account_type === 'radio');
        if (idx === -1) return res.status(404).json({ error: 'Station manager not found' });
        station = { ...mockDb.stations[idx], ...patch };
        mockDb.stations[idx] = station;
      }
      return res.json({ station });
    } catch (err) {
      console.error('Admin PUT station error:', err);
      return res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/admin/stations/:id', authAdmin, async (req, res) => {
    try {
      try {
        const { error } = await supabase
          .from('stations')
          .delete()
          .eq('id', req.params.id)
          .eq('account_type', 'radio');

        if (error) throw error;
      } catch (err) {
        console.warn('DELETE station online failed, falling back to local mockDb.');
        const idx = mockDb.stations.findIndex(s => s.id === req.params.id && s.account_type === 'radio');
        if (idx === -1) return res.status(404).json({ error: 'Station manager not found' });
        mockDb.stations.splice(idx, 1);
      }
      return res.json({ success: true });
    } catch (err) {
      console.error('Admin DELETE station error:', err);
      return res.status(400).json({ error: err.message });
    }
  });

  // ── FLORISTS & GIFT SHOPS ──
  // The `stations` table stores these as florist_credit_balance /
  // florist_low_credit_threshold, but admin.html's florist views read
  // credit_balance / low_credit_threshold. The single-florist GET below
  // already normalised this; the list GET didn't, so the dashboard table
  // showed the fallback defaults (0 credits / 5 credits) for every florist
  // regardless of their real balance.
  function normalizeFloristCreditFields(florist) {
    if (!florist) return florist;
    florist.credit_balance = florist.florist_credit_balance ?? florist.credit_balance ?? 0;
    florist.low_credit_threshold = florist.florist_low_credit_threshold ?? florist.low_credit_threshold ?? 5;
    return florist;
  }

  // Partner types that reuse the exact same florist credit-balance
  // infrastructure — client request, 19 Aug 2026 (Col): "This should also
  // follow through for gift shops cake shops and radio stations using the
  // same format WS - business name." Gift shops and cake shops are
  // functionally identical to florists in this system (same
  // credit-per-printed-keepsake model), so they're listed/created via
  // this same endpoint family with a selectable account_type rather than
  // duplicating the whole florist code path for two more copies of it.
  const FLORIST_LIKE_ACCOUNT_TYPES = ['florist', 'gift_shop', 'cake_shop'];

  app.get('/api/admin/florists', authAdmin, async (req, res) => {
    try {
      const page = Math.max(Number(req.query.page) || 1, 1);
      const limit = Math.max(Number(req.query.limit) || 20, 1);

      let items, total;
      try {
        const start = (page - 1) * limit;
        const end = start + limit - 1;

        const { data, count, error } = await supabase
          .from('stations')
          .select('*', { count: 'exact' })
          .in('account_type', FLORIST_LIKE_ACCOUNT_TYPES)
          .order('name', { ascending: true })
          .range(start, end);

        if (error) throw error;
        items = data;
        total = count;
      } catch (err) {
        console.warn('GET florists online failed, falling back to local mockDb.');
        const list = mockDb.stations.filter(s => FLORIST_LIKE_ACCOUNT_TYPES.includes(s.account_type));
        const result = paginateArray(list, page, limit);
        items = result.items;
        total = result.total;
      }
      items = (items || []).map(normalizeFloristCreditFields);
      return res.json({ items, total: total || 0, page, limit });
    } catch (err) {
      console.error('Admin GET florists error:', err);
      return res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/admin/florists', authAdmin, async (req, res) => {
    try {
      let florist;
      const requestedType = String(req.body?.account_type || 'florist').trim();
      const accountType = FLORIST_LIKE_ACCOUNT_TYPES.includes(requestedType) ? requestedType : 'florist';
      try {
        const name = String(req.body?.name || '').trim();
        const email = String(req.body?.email || '').trim().toLowerCase();
        const password = String(req.body?.password || '');
        const country = String(req.body?.country || 'New Zealand').trim();
        const initialCredit = Number(req.body?.initial_credit_balance || 30);

        if (!name || !email || !password) {
          return res.status(400).json({ error: 'Name, email, and password are required.' });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        // Wholesale buying code — client spec, 19 Aug 2026 (Col): "WS" +
        // lowercased business name, special characters stripped, numbered
        // suffix on collision. See src/phase2/wholesale-code.js.
        //
        // Bug fix, 1 Sep 2026 (found in live soft-launch verification):
        // src/db.phase6.sql (which adds the wholesale_code column) was
        // written back on 19 Aug but had never actually been run against
        // the real database — confirmed directly, the column genuinely
        // doesn't exist there. Every new florist/gift-shop/cake-shop
        // signup since wholesale_code was added to this insert has been
        // silently falling into the outer catch below and landing in
        // mockDb instead of the real `stations` table — meaning the
        // account looked fine in the admin response, but was invisible
        // and unusable (couldn't log in) the moment the server restarted,
        // since mockDb is in-memory only. Reproduced directly: created a
        // florist, tried to log in immediately after with the exact
        // credentials just set, got "Invalid email or password" because
        // the row never actually reached the real DB. Same graceful-
        // degrade pattern as everywhere else in this file: try the real
        // thing, and only drop wholesale_code specifically (not the whole
        // signup) if the column genuinely isn't there yet — the account
        // still lands in the real table with a real login-capable row,
        // it just won't have a wholesale code until the migration runs.
        let wholesaleCode = null;
        try {
          wholesaleCode = await createUniqueWholesaleCode(supabase, name);
        } catch (wcErr) {
          if (!isMissingColumnError(wcErr)) throw wcErr;
          console.warn('wholesale_code column missing (src/db.phase6.sql not yet run) — creating florist without one.');
        }

        const insertRow = {
          name,
          email,
          password_hash: passwordHash,
          country,
          account_type: accountType,
          florist_credit_balance: initialCredit,
          florist_low_credit_threshold: 10,
          florist_credit_updated_at: new Date().toISOString(),
          active: true
        };
        if (wholesaleCode) insertRow.wholesale_code = wholesaleCode;

        let { data: dbFlorist, error } = await supabase
          .from('stations')
          .insert(insertRow)
          .select()
          .single();

        if (isMissingColumnError(error) && Object.prototype.hasOwnProperty.call(insertRow, 'wholesale_code')) {
          delete insertRow.wholesale_code;
          ({ data: dbFlorist, error } = await supabase.from('stations').insert(insertRow).select().single());
        }

        if (error) {
          if (error.code === '23505') {
            return res.status(409).json({ error: 'Email address already registered.' });
          }
          throw error;
        }
        florist = dbFlorist;
      } catch (err) {
        console.warn('POST florist online failed, falling back to local mockDb.');
        const name = String(req.body?.name || '').trim();
        const email = String(req.body?.email || '').trim().toLowerCase();
        const country = String(req.body?.country || 'New Zealand').trim();
        const initialCredit = Number(req.body?.initial_credit_balance || 30);

        if (!name || !email) throw new Error('Name and email are required.');

        // Same wholesale-code logic, but resolved against the in-memory
        // mockDb (no Supabase connection in this fallback path) rather
        // than the DB-aware createUniqueWholesaleCode().
        const existingMockCodes = new Set(
          mockDb.stations.filter(s => s.wholesale_code).map(s => String(s.wholesale_code).toLowerCase())
        );
        const wholesaleCode = resolveAvailableCode(buildBaseWholesaleCode(name), existingMockCodes);

        florist = {
          id: 'f_' + Date.now(),
          name,
          email,
          country,
          account_type: accountType,
          wholesale_code: wholesaleCode,
          florist_credit_balance: initialCredit,
          florist_low_credit_threshold: 10,
          active: true
        };
        mockDb.stations.push(florist);
      }
      return res.json({ florist });
    } catch (error) {
      console.error('Admin create florist error:', error);
      return res.status(500).json({ error: error.message || 'Unable to add florist partner.' });
    }
  });

  // Single GET for edit modal
  app.get('/api/admin/florists/:id', authAdmin, async (req, res) => {
    try {
      let florist;
      try {
        const { data, error } = await supabase
          .from('stations')
          .select('*')
          .eq('id', req.params.id)
          .in('account_type', FLORIST_LIKE_ACCOUNT_TYPES)
          .single();
        if (error) throw error;
        florist = data;
      } catch (err) {
        florist = mockDb.stations.find(s => s.id === req.params.id && FLORIST_LIKE_ACCOUNT_TYPES.includes(s.account_type));
        if (!florist) return res.status(404).json({ error: 'Florist not found' });
      }
      normalizeFloristCreditFields(florist);
      return res.json(florist);
    } catch (err) {
      console.error('Admin GET florists/:id error:', err);
      return res.status(400).json({ error: err.message });
    }
  });

  app.put('/api/admin/florists/:id', authAdmin, async (req, res) => {
    try {
      const { name, email, password, country, creditsToAdd, floristLowCreditThreshold, active,
              low_credit_threshold } = req.body;
      const patch = {};
      if (name !== undefined) patch.name = String(name).trim();
      // Bug fix, 2 Sept 2026 (same dashboard-wide sweep): editing a
      // florist/gift-shop/cake-shop's email to one already used by
      // another account hit the real unique constraint, but this route's
      // outer catch (below) misreported it as 404 "Florist partner not
      // found" for a partner that very much exists — same proactive-check
      // pattern as the reseller/promo-code/station fixes.
      if (email !== undefined) {
        patch.email = String(email).trim().toLowerCase();
        if (patch.email) {
          const { data: existingByEmail } = await supabase
            .from('stations')
            .select('id, name')
            .ilike('email', patch.email)
            .neq('id', req.params.id)
            .maybeSingle();
          if (existingByEmail) {
            return res.status(409).json({ error: `This email is already used by another partner: ${existingByEmail.name}. Use a different email, or edit that existing partner instead.` });
          }
        }
      }
      if (password) {
        patch.password_hash = await bcrypt.hash(password, 12);
      }
      if (country !== undefined) patch.country = String(country).trim();

      // Credits are edited as a delta (creditsToAdd), never as a client-submitted
      // absolute total — the new balance is always computed here from the
      // database's current value, so two admins editing the same florist close
      // together can't silently overwrite one another's change. (This route
      // previously destructured a `floristCreditBalance` field that admin.html
      // never actually sent — it sent `initial_credit_balance` instead, so this
      // update always silently no-opped on the credit balance. Fixed by aligning
      // the field name and moving to an explicit add-amount instead of an
      // absolute value the client would otherwise have to compute itself.)
      let creditsAddedAmount = 0;
      if (creditsToAdd !== undefined && Number(creditsToAdd) !== 0) {
        const { data: currentFlorist, error: fetchError } = await supabase
          .from('stations')
          .select('florist_credit_balance')
          .eq('id', req.params.id)
          .in('account_type', FLORIST_LIKE_ACCOUNT_TYPES)
          .single();
        if (fetchError || !currentFlorist) {
          return res.status(404).json({ error: 'Florist partner not found' });
        }
        creditsAddedAmount = Number(creditsToAdd);
        patch.florist_credit_balance = Number(currentFlorist.florist_credit_balance || 0) + creditsAddedAmount;
        patch.florist_credit_updated_at = new Date().toISOString();
      }

      // Accept both naming conventions from admin.html
      const thresholdVal = floristLowCreditThreshold !== undefined ? floristLowCreditThreshold
                         : low_credit_threshold !== undefined ? low_credit_threshold : undefined;
      if (thresholdVal !== undefined) patch.florist_low_credit_threshold = Number(thresholdVal);
      if (active !== undefined) patch.active = Boolean(active);

      let florist;
      try {
        const { data, error } = await supabase
          .from('stations')
          .update(patch)
          .eq('id', req.params.id)
          .in('account_type', FLORIST_LIKE_ACCOUNT_TYPES)
          .select('*')
          .single();

        if (error && error.code === '23505') {
          return res.status(409).json({ error: 'This email is already used by another partner.' });
        }
        if (error) throw error;
        florist = data;
      } catch (err) {
        console.warn('PUT florist online failed, falling back to local mockDb.');
        const idx = mockDb.stations.findIndex(s => s.id === req.params.id && FLORIST_LIKE_ACCOUNT_TYPES.includes(s.account_type));
        if (idx === -1) return res.status(404).json({ error: 'Florist partner not found' });
        florist = { ...mockDb.stations[idx], ...patch };
        mockDb.stations[idx] = florist;
      }
      normalizeFloristCreditFields(florist);
      return res.json({
        florist,
        creditsAdded: creditsAddedAmount || undefined,
        newCreditBalance: creditsAddedAmount ? florist.credit_balance : undefined,
      });
    } catch (err) {
      console.error('Admin PUT florist error:', err);
      return res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/admin/florists/:id', authAdmin, async (req, res) => {
    try {
      try {
        const { error } = await supabase
          .from('stations')
          .delete()
          .eq('id', req.params.id)
          .in('account_type', FLORIST_LIKE_ACCOUNT_TYPES);

        if (error) throw error;
      } catch (err) {
        console.warn('DELETE florist online failed, falling back to local mockDb.');
        const idx = mockDb.stations.findIndex(s => s.id === req.params.id && FLORIST_LIKE_ACCOUNT_TYPES.includes(s.account_type));
        if (idx === -1) return res.status(404).json({ error: 'Florist partner not found' });
        mockDb.stations.splice(idx, 1);
      }
      return res.json({ success: true });
    } catch (err) {
      console.error('Admin DELETE florist error:', err);
      return res.status(400).json({ error: err.message });
    }
  });

  // ── FAMOUS BIRTHDAYS ──
  app.get('/api/admin/famous-birthdays', authAdmin, async (req, res) => {
    try {
      const status = String(req.query.status || 'pending').trim().toLowerCase();
      const country = String(req.query.country || '').trim();
      const day = Number(req.query.day || 0);
      const month = Number(req.query.month || 0);
      const page = Math.max(Number(req.query.page) || 1, 1);
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 200);

      let items, total;
      try {
        const start = (page - 1) * limit;
        const end = start + limit - 1;

        let request = supabase
          .from('famous_birthdays')
          .select('*', { count: 'exact' })
          .order('created_at', { ascending: false })
          .range(start, end);

        if (['pending', 'approved', 'rejected'].includes(status)) {
          request = request.eq('curation_status', status);
        }
        if (country) {
          request = request.eq('main_public_country', normalizeCountry(country));
        }
        if (Number.isInteger(day) && day >= 1 && day <= 31) {
          request = request.eq('birth_day', day);
        }
        if (Number.isInteger(month) && month >= 1 && month <= 12) {
          request = request.eq('birth_month', month);
        }

        const { data, count, error } = await request;
        if (error) throw error;
        items = data;
        total = count;
      } catch (err) {
        console.warn('GET famous-birthdays online failed, falling back to local mockDb.');
        let list = mockDb.famous_birthdays;
        if (['pending', 'approved', 'rejected'].includes(status)) {
          list = list.filter(b => b.curation_status === status);
        }
        if (country) {
          list = list.filter(b => b.main_public_country === country.toLowerCase());
        }
        if (day) {
          list = list.filter(b => b.birth_day === day);
        }
        if (month) {
          list = list.filter(b => b.birth_month === month);
        }
        const result = paginateArray(list, page, limit);
        items = result.items;
        total = result.total;
      }

      const mappedBirthdays = items.map(buildAdminBirthdayResponse);
      return res.json({
        birthdays: mappedBirthdays,
        items: mappedBirthdays,
        total: total || 0,
        page,
        limit
      });
    } catch (error) {
      console.error('Admin famous birthdays load error:', error);
      return res.status(400).json({ error: error.message || 'Unable to load famous birthdays.' });
    }
  });

  app.patch('/api/admin/famous-birthdays/:birthdayId', authAdmin, async (req, res) => {
    try {
      let birthday;
      try {
        birthday = await updateFamousBirthdayCuration(supabase, req.params.birthdayId, req.body || {});
      } catch (err) {
        console.warn('PATCH famous-birthday curation status online failed, falling back to local mockDb.');
        const idx = mockDb.famous_birthdays.findIndex(b => b.id === req.params.birthdayId);
        if (idx === -1) return res.status(404).json({ error: 'Famous birthday not found' });
        
        const b = mockDb.famous_birthdays[idx];
        const status = String(req.body.curationStatus || req.body.curation_status || '').trim().toLowerCase();
        if (status) {
          if (!['pending', 'approved', 'rejected'].includes(status)) throw new Error('Invalid status.');
          b.curation_status = status;
        }
        birthday = b;
      }
      return res.json({ birthday: buildAdminBirthdayResponse(birthday) });
    } catch (error) {
      console.error('Admin famous birthday update error:', error);
      return res.status(400).json({ error: error.message || 'Unable to update famous birthday.' });
    }
  });

  app.delete('/api/admin/famous-birthdays/:id', authAdmin, async (req, res) => {
    try {
      try {
        const { error } = await supabase
          .from('famous_birthdays')
          .delete()
          .eq('id', req.params.id);

        if (error) throw error;
      } catch (err) {
        console.warn('DELETE famous-birthday online failed, falling back to local mockDb.');
        const idx = mockDb.famous_birthdays.findIndex(b => b.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Famous birthday not found' });
        mockDb.famous_birthdays.splice(idx, 1);
      }
      return res.json({ success: true });
    } catch (err) {
      console.error('Admin DELETE famous-birthday error:', err);
      return res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/admin/orders/:orderId/download-pdf', authAdmin, async (req, res) => {
    try {
      const order = await loadFulfilmentOrderById(supabase, req.params.orderId);
      const pdf = await generatePdfFromHtml({
        html: order.keepsakes?.rendered_html,
        fileStem: order.order_number || order.customer_name || 'tribute-times-admin-order',
        keepArtifacts: true,
      });

      await persistPdfPath(supabase, order, pdf.pdfFilePath);
      sendPdfResponse(res, `${sanitizeFilenamePart(order.order_number || order.customer_name || 'tribute-times-keepsake')}.pdf`, pdf.pdfBuffer);
    } catch (error) {
      console.error('Admin PDF download error:', error);
      return res.status(error.statusCode || 400).json({ error: error.message || 'Unable to generate PDF.' });
    }
  });

  app.patch('/api/admin/orders/:orderId/status', authAdmin, async (req, res) => {
    try {
      const nextStatus = normalizeQueueStatus(req.body?.status || req.body?.queueStatus);
      const order = await loadFulfilmentOrderById(supabase, req.params.orderId);
      const updateResult = await updateOrderStatus({
        supabase,
        sendEmail,
        order,
        nextStatus,
        adminId: req.admin.id,
      });

      return res.json({
        order: buildAdminOrderResponse(updateResult.order),
        emailSent: updateResult.emailSent,
      });
    } catch (error) {
      console.error('Admin status update error:', error);
      return res.status(error.statusCode || 400).json({ error: error.message || 'Unable to update status.' });
    }
  });

  // Fix, Oct 2026 (checklist item 38): no mechanism existed anywhere for
  // Col or a customer to correct a typo'd checkout email and get the
  // confirmation re-sent — a real, confirmed gap found during the site
  // checklist audit, most urgent for the GCash path specifically (the
  // approval email carrying the one-time redeem code is a paid GCash
  // customer's ONLY way to unlock their keepsake). Lets an admin correct
  // customer_email on a real order and immediately re-sends the same
  // order-confirmation email the paid-order flow already sends
  // (buildPublicOrderCustomerEmail(), added for item 33), to the
  // corrected address — reuses that exact template rather than building a
  // second one.
  app.post('/api/admin/orders/:orderId/resend-confirmation', authAdmin, async (req, res) => {
    try {
      const newEmail = String(req.body?.email || '').trim().toLowerCase();
      if (!newEmail || !newEmail.includes('@')) {
        return res.status(400).json({ error: 'A valid email address is required.' });
      }

      // Not loadFulfilmentOrderById — that's scoped to needs_fulfilment=true
      // (the physical print queue) and would 404 on every digital-only
      // order, which is most real public orders. This needs to work for
      // any paid order regardless of product tier.
      const { data: order, error: loadError } = await supabase
        .from('orders')
        .select('id, order_number, customer_email, payment_status')
        .eq('id', req.params.orderId)
        .maybeSingle();
      if (loadError) throw loadError;
      if (!order) return res.status(404).json({ error: 'Order not found.' });
      if (order.payment_status !== 'paid') {
        return res.status(400).json({ error: 'Only paid orders can have their confirmation resent.' });
      }

      const { data: updatedOrder, error: updateError } = await supabase
        .from('orders')
        .update({ customer_email: newEmail })
        .eq('id', order.id)
        .select('*')
        .single();
      if (updateError || !updatedOrder) {
        throw new Error(updateError?.message || 'Unable to update the order email.');
      }

      let emailSent = false;
      if (sendEmail) {
        try {
          emailSent = await sendEmail({
            to: newEmail,
            subject: `Your Tribute Times keepsake is ready - ${updatedOrder.order_number}`,
            html: buildPublicOrderCustomerEmail(updatedOrder, process.env.APP_URL || ''),
          });
        } catch (emailError) {
          console.error('Admin resend-confirmation email failed:', emailError);
        }
      }

      return res.json({ order: buildAdminOrderResponse(updatedOrder), emailSent: Boolean(emailSent) });
    } catch (error) {
      console.error('Admin resend-confirmation error:', error);
      return res.status(error.statusCode || 400).json({ error: error.message || 'Unable to resend confirmation.' });
    }
  });

  // ---------------------------------------------------------------------
  // Phase 9 — public reseller sign-up requests. Client request, 21 Aug
  // 2026 (Col, phase6.md) + reconfirmed 2/3 Sept 2026: "Creation of a new
  // signing up page bringing it all together and using the information
  // for marketing purposes later." See src/db.phase9.sql for the full
  // table design rationale — deliberately a separate table from
  // sales_consultants so a public submission can never become a live,
  // working reseller account without a human reviewing it first
  // ("Would come to Jhe-Ann or me for approval first." — Col).
  // ---------------------------------------------------------------------

  const SIGNUP_PARTNER_TYPES = ['individual', 'business', 'influencer', 'radio_station'];

  // Bug found live-testing this feature, 2 Sept 2026: PostgREST reports a
  // genuinely-missing table as PGRST205 ("Could not find the table ... in
  // the schema cache"), NOT the raw Postgres 42P01 (undefined_table) —
  // that code only ever surfaces from a direct SQL connection, never
  // through PostgREST/Supabase's REST layer, which every query in this
  // file goes through. Checking for 42P01 alone meant a not-yet-run
  // src/db.phase9.sql always fell into the generic 400 catch instead of
  // the intended graceful "sign-ups aren't open yet" message.
  function isMissingTableError(error) {
    return error?.code === 'PGRST205' || error?.code === '42P01';
  }

  // No authAdmin — this is the public submission endpoint, reachable from
  // /join with no login. Every field is treated as untrusted input.
  app.post('/api/public/reseller-signup', async (req, res) => {
    try {
      const body = req.body || {};
      const partnerType = String(body.partnerType || body.partner_type || '').trim();
      if (!SIGNUP_PARTNER_TYPES.includes(partnerType)) {
        return res.status(400).json({ error: `Invalid type. Must be one of: ${SIGNUP_PARTNER_TYPES.join(', ')}.` });
      }
      const firstName = String(body.firstName || body.first_name || '').trim();
      const surname = String(body.surname || '').trim();
      if (!firstName || !surname) {
        return res.status(400).json({ error: 'First name and surname are required.' });
      }
      const email = String(body.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'A valid email address is required.' });
      }
      // Client spec, 2 Sept 2026 (Col): business name required only when
      // registering a business — required at the application layer here
      // since the DB leaves it nullable (see db.phase9.sql).
      const businessName = String(body.businessName || body.business_name || '').trim();
      if (partnerType === 'business' && !businessName) {
        return res.status(400).json({ error: 'Business name is required for a business sign-up.' });
      }
      // Phase 10 — client request, 3 Sept 2026 (Col, reference screenshot):
      // Address 1/2, City, Country collected for every agent type now (not
      // business-only as Phase 9 originally had it) — "information that
      // allows us to complete our backend work, payments etc."
      const addressLine1 = String(body.addressLine1 || body.address_line1 || body.address || '').trim();

      const insertRow = {
        status: 'pending',
        partner_type: partnerType,
        first_name: firstName,
        surname,
        business_name: partnerType === 'business' ? (businessName || null) : null,
        address: addressLine1 || null,
        gcash_number: String(body.gcashNumber || body.gcash_number || '').trim() || null,
        phone: String(body.phone || '').trim() || null,
        email,
        facebook: String(body.facebook || '').trim() || null,
        instagram: String(body.instagram || '').trim() || null,
        tiktok: String(body.tiktok || '').trim() || null,
        whatsapp: String(body.whatsapp || '').trim() || null,
        telegram: String(body.telegram || '').trim() || null,
        other_social: String(body.otherSocial || body.other_social || '').trim() || null,
        // Phase 10 fields — see src/db.phase10.sql. Graceful-degrade below
        // handles the case where this migration hasn't been run yet.
        address_line2: String(body.addressLine2 || body.address_line2 || '').trim() || null,
        city: String(body.city || '').trim() || null,
        country: String(body.country || '').trim() || null,
        facebook_followers: body.facebookChecked ? (String(body.facebookFollowers || '').trim() || null) : null,
        instagram_followers: body.instagramChecked ? (String(body.instagramFollowers || '').trim() || null) : null,
        twitter_followers: body.twitterChecked ? (String(body.twitterFollowers || '').trim() || null) : null,
        linkedin_followers: body.linkedinChecked ? (String(body.linkedinFollowers || '').trim() || null) : null,
        tiktok_followers: body.tiktokChecked ? (String(body.tiktokFollowers || '').trim() || null) : null,
        youtube_followers: body.youtubeChecked ? (String(body.youtubeFollowers || '').trim() || null) : null,
        whatsapp_followers: body.whatsappChecked ? (String(body.whatsappFollowers || '').trim() || null) : null,
      };

      let { data, error } = await supabase
        .from('reseller_signup_requests')
        .insert(insertRow)
        .select('id')
        .single();

      // Graceful-degrade if src/db.phase10.sql hasn't been run yet — the
      // new columns are optional (unlike Phase 9's whole-table check
      // below), so a pending Phase 10 migration shouldn't block a
      // submission entirely, just drop the fields it can't accept yet.
      if (isMissingColumnError(error)) {
        Object.keys(insertRow).forEach(col => {
          if (['address_line2', 'city', 'country', 'facebook_followers', 'instagram_followers', 'twitter_followers', 'linkedin_followers', 'tiktok_followers', 'youtube_followers', 'whatsapp_followers'].includes(col)) {
            delete insertRow[col];
          }
        });
        ({ data, error } = await supabase.from('reseller_signup_requests').insert(insertRow).select('id').single());
      }

      // Graceful-degrade if src/db.phase9.sql hasn't been run yet — the
      // table itself is missing (undefined_table, 42P01), not just a
      // column, since this whole feature depends on it. Rather than
      // silently faking success (the exact bug class already fixed
      // elsewhere in this file), tell the submitter plainly so it's
      // obvious the migration is still pending instead of quietly losing
      // real applications.
      if (error) {
        if (isMissingTableError(error)) {
          console.error('reseller_signup_requests table does not exist yet — run src/db.phase9.sql');
          return res.status(503).json({ error: 'Sign-ups are not open yet — please check back soon.' });
        }
        throw error;
      }

      // Fix, Oct 2026 (checklist item 40): no notification of any kind was
      // sent when a reseller/florist application came in — confirmed via
      // an exhaustive search of every sendEmail() call in this file during
      // a full checklist audit (only one existed, unrelated to sign-ups).
      // The real, already-hardened dashboard badge (refreshResellerRequestsBadge(),
      // fixed 3 Sept 2026) remains the primary indicator; this adds the
      // email channel alongside it, reusing the same adminAlertEmail
      // pattern already proven working for sale notifications (item 39).
      // Fire-and-forget with its own try/catch — a failed notification
      // email must never fail the actual sign-up, which has already
      // succeeded by this point.
      if (sendEmail) {
        const applicantName = [insertRow.first_name, insertRow.surname].filter(Boolean).join(' ');
        sendEmail({
          to: PHASE2_CONFIG.adminAlertEmail,
          subject: `New ${insertRow.partner_type} sign-up request - ${applicantName}`,
          html: `
            <h2>New reseller/partner sign-up</h2>
            <p><strong>Type:</strong> ${escapeHtml(insertRow.partner_type)}</p>
            <p><strong>Name:</strong> ${escapeHtml(applicantName)}</p>
            ${insertRow.business_name ? `<p><strong>Business:</strong> ${escapeHtml(insertRow.business_name)}</p>` : ''}
            <p><strong>Email:</strong> ${escapeHtml(insertRow.email)}</p>
            <p><strong>Phone:</strong> ${escapeHtml(insertRow.phone || '')}</p>
            <p>Review and approve in the admin dashboard's Reseller Requests screen.</p>
          `,
        }).catch((emailError) => {
          console.error('Reseller signup notification email failed:', emailError);
        });
      }

      return res.json({ success: true, id: data.id });
    } catch (error) {
      console.error('Public reseller signup error:', error);
      return res.status(400).json({ error: 'Unable to submit your application. Please try again.' });
    }
  });

  // Admin review list — pending by default, or ?status=approved/rejected/all.
  app.get('/api/admin/reseller-requests', authAdmin, async (req, res) => {
    try {
      const status = String(req.query.status || 'pending').trim();
      let query = supabase
        .from('reseller_signup_requests')
        .select('*')
        .order('created_at', { ascending: false });
      if (status !== 'all') {
        if (!['pending', 'approved', 'rejected'].includes(status)) {
          return res.status(400).json({ error: 'Invalid status filter.' });
        }
        query = query.eq('status', status);
      }
      const { data, error } = await query;
      if (error) {
        if (isMissingTableError(error)) return res.json({ items: [] }); // migration not run yet
        throw error;
      }
      return res.json({ items: data || [] });
    } catch (error) {
      console.error('Admin GET reseller-requests error:', error);
      return res.status(400).json({ error: error.message || 'Unable to load reseller requests.' });
    }
  });

  // Maps the public form's broad 4-way partner_type to the admin's
  // 6-way PARTNER_TYPES for the real consultant row created on approval.
  // "business" has no single real equivalent (could be a florist, cake
  // shop, or gift store), so the admin is required to pick one explicitly
  // at approval time via `resolvedPartnerType` — never guessed.
  function resolveApprovalPartnerType(requestPartnerType, resolvedPartnerType) {
    if (requestPartnerType !== 'business') return requestPartnerType;
    const allowed = ['florist', 'cake_shop', 'gift_store'];
    const chosen = String(resolvedPartnerType || '').trim();
    if (!allowed.includes(chosen)) {
      throw new Error(`This is a business sign-up — choose which type it is: ${allowed.join(', ')}.`);
    }
    return chosen;
  }

  // Approve: creates the real reseller (reusing the exact same,
  // already-tested createConsultant/autoIssueAttributionCode logic used
  // by the admin's own "+ Add Reseller" flow, so it inherits every bug
  // fix already in place there) and links the request row to it.
  app.post('/api/admin/reseller-requests/:id/approve', authAdmin, async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      const { data: request, error: fetchError } = await supabase
        .from('reseller_signup_requests')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (fetchError) throw fetchError;
      if (!request) return res.status(404).json({ error: 'Reseller request not found.' });
      if (request.status !== 'pending') {
        return res.status(409).json({ error: `This request was already ${request.status}.` });
      }

      let partnerType;
      try {
        partnerType = resolveApprovalPartnerType(request.partner_type, req.body?.resolvedPartnerType);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      const displayName = [request.first_name, request.surname].filter(Boolean).join(' ')
        + (request.business_name ? ` (${request.business_name})` : '');

      // Phase 10 — client request, 3 Sept 2026 (Col): the address and
      // follower-count fields now have real, structured columns on the
      // agent record (added in Phase 10) rather than only living as free
      // text in Admin Notes — carried straight through here so approving
      // a request populates the real profile fields directly.
      const noteParts = [
        request.gcash_number ? `GCash: ${request.gcash_number}` : null,
        request.telegram ? `Telegram: ${request.telegram}` : null,
        request.other_social ? `Other: ${request.other_social}` : null,
        'Created from public sign-up request.',
      ].filter(Boolean);

      let consultant;
      try {
        consultant = await createConsultant(supabase, {
          name: displayName,
          email: request.email,
          phone: request.phone,
          partnerType,
          adminNotes: noteParts.join(' | '),
          addressLine1: request.address,
          addressLine2: request.address_line2,
          city: request.city,
          country: request.country,
          // Phase 10 replaced the public form's per-platform handle/link
          // fields (facebook, instagram, tiktok, whatsapp — still present
          // on this table from Phase 9, now unused going forward) with a
          // checkbox + follower-count per platform, matching the same
          // pattern used in the admin's own Add Agent form — so "checked"
          // here is simply "a follower count was given."
          facebookChecked: !!request.facebook_followers, facebookFollowers: request.facebook_followers,
          instagramChecked: !!request.instagram_followers, instagramFollowers: request.instagram_followers,
          twitterChecked: !!request.twitter_followers, twitterFollowers: request.twitter_followers,
          linkedinChecked: !!request.linkedin_followers, linkedinFollowers: request.linkedin_followers,
          tiktokChecked: !!request.tiktok_followers, tiktokFollowers: request.tiktok_followers,
          youtubeChecked: !!request.youtube_followers, youtubeFollowers: request.youtube_followers,
          whatsappChecked: !!request.whatsapp_followers, whatsappFollowers: request.whatsapp_followers,
        });
      } catch (err) {
        if (err.isKnownValidationError) return res.status(409).json({ error: err.message });
        throw err;
      }

      const codeResult = await autoIssueAttributionCode(supabase, consultant, req.body?.code);

      const { error: updateError } = await supabase
        .from('reseller_signup_requests')
        .update({
          status: 'approved',
          reviewed_at: new Date().toISOString(),
          reviewed_by_admin_id: req.admin.id,
          review_notes: String(req.body?.reviewNotes || req.body?.review_notes || '').trim() || null,
          // createConsultant() (called directly above, not the mockDb-
          // fallback route handler) always throws on a real DB failure and
          // never returns a mockDb-style non-UUID id — so consultant.id is
          // always a real UUID here, safe to use as the FK target directly.
          created_consultant_id: consultant.id,
        })
        .eq('id', id);
      if (updateError) throw updateError;

      return res.json({ consultant, ...codeResult });
    } catch (error) {
      console.error('Admin approve reseller-request error:', error);
      return res.status(400).json({ error: error.message || 'Unable to approve reseller request.' });
    }
  });

  app.post('/api/admin/reseller-requests/:id/reject', authAdmin, async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      const { data: request, error: fetchError } = await supabase
        .from('reseller_signup_requests')
        .select('id, status')
        .eq('id', id)
        .maybeSingle();
      if (fetchError) throw fetchError;
      if (!request) return res.status(404).json({ error: 'Reseller request not found.' });
      if (request.status !== 'pending') {
        return res.status(409).json({ error: `This request was already ${request.status}.` });
      }

      const { error } = await supabase
        .from('reseller_signup_requests')
        .update({
          status: 'rejected',
          reviewed_at: new Date().toISOString(),
          reviewed_by_admin_id: req.admin.id,
          review_notes: String(req.body?.reviewNotes || req.body?.review_notes || '').trim() || null,
        })
        .eq('id', id);
      if (error) throw error;

      return res.json({ success: true });
    } catch (error) {
      console.error('Admin reject reseller-request error:', error);
      return res.status(400).json({ error: error.message || 'Unable to reject reseller request.' });
    }
  });
}

function authAdmin(req, res, next) {
  const token = getAdminTokenFromRequest(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    req.admin = jwt.verify(token, ADMIN_JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'Session expired' });
  }
}

// Phase 6/7 — partner type, client request 21 Aug 2026 (Col): "a sales
// rep, an influencer, a florist, a cake shop - doesn't matter who", all the
// same underlying code-holder concept. Matches the check constraint in
// src/db.phase7.sql exactly — validated here too (not just left to the DB
// constraint) so a bad value gets a clear 400 instead of a raw DB error
// leaking to the client.
const PARTNER_TYPES = ['individual', 'radio_station', 'florist', 'cake_shop', 'gift_store', 'influencer'];

// Phase 8 — commission, client request 23 Aug 2026 (Col): "if they are a
// business they will basically have the same wholesale buying price but
// as individuals that could vary." The 4 physical/organisational partner
// types (radio stations, florists, cake shops, gift stores — the ones
// that already buy printed keepsakes wholesale elsewhere in this app)
// default to the SAME rate as that existing wholesale discount
// (WHOLESALE_DISCOUNT_RATE, 35%, src/phase2/constants.js). 'individual'
// and 'influencer' are people, not businesses — Col was explicit these
// vary person to person, so they get no default and must be set per
// partner. Every rate stays editable regardless of type ("yes rate
// should still be editable" — Col, 23 Aug 2026).
const BUSINESS_PARTNER_TYPES = ['radio_station', 'florist', 'cake_shop', 'gift_store'];
const DEFAULT_BUSINESS_COMMISSION_RATE = WHOLESALE_DISCOUNT_RATE * 100; // stored/displayed as a percentage number (35), not a 0-1 fraction

// Validates a commission rate the same way sales_consultants_commission_rate_check
// does in src/db.phase8.sql (null allowed — "not set yet" for an individual
// Col hasn't priced out yet — or 0-100 inclusive). Not left to the DB
// constraint alone, matching the same reasoning as PARTNER_TYPES validation
// above: a bad value should get a clear 400, not a raw DB error.
function normalizeCommissionRate(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new Error('Commission rate must be a number between 0 and 100.');
  }
  return Math.round(n * 100) / 100; // matches numeric(5,2) precision
}

// Same "missing column" detection used in public-checkout.js for the
// Phase 7 graceful-degradation pattern (PGRST204 on INSERT, 42703 on
// SELECT/filter — see that file's isMissingColumnError for the full
// explanation). Kept as its own small local copy rather than a shared
// import: these two files' Phase 7 work landed independently and this is
// a two-line self-contained check, not worth coupling the files over.
function isMissingColumnError(error) {
  return error?.code === '42703' || error?.code === 'PGRST204';
}

// Optional columns added across Phase 7 (partner_type), Phase 8
// (commission_rate) and Phase 10 (address/city/country + per-platform
// follower counts) that may not exist yet on the real DB until their
// migrations (src/db.phase7.sql, src/db.phase8.sql, src/db.phase10.sql)
// are run manually. Kept as a list (not a single flag) because ANY
// combination can be pending at once — a single-column retry would still
// fail a second time on whichever came second, so the retry below strips
// all of them together and only needs one retry attempt no matter how
// many of these are still missing.
const OPTIONAL_CONSULTANT_COLUMNS = [
  'partner_type', 'commission_rate',
  'address_line1', 'address_line2', 'city', 'country',
  'facebook_followers', 'instagram_followers', 'twitter_followers',
  'linkedin_followers', 'tiktok_followers', 'youtube_followers', 'whatsapp_followers',
];

// Phase 10 — client request, 3 Sept 2026 (Col, reference screenshot):
// "Socials and followers" — a checkbox + follower-count field per
// platform. Only the platforms actually ticked keep their follower-count
// value (an unticked platform's count is discarded, same as leaving a
// field blank) — shared between createConsultant() and the PUT edit
// route so both build this the same way.
const SOCIAL_FOLLOWER_FIELDS = {
  facebook_followers: ['facebookChecked', 'facebook_checked', 'facebookFollowers', 'facebook_followers'],
  instagram_followers: ['instagramChecked', 'instagram_checked', 'instagramFollowers', 'instagram_followers'],
  twitter_followers: ['twitterChecked', 'twitter_checked', 'twitterFollowers', 'twitter_followers'],
  linkedin_followers: ['linkedinChecked', 'linkedin_checked', 'linkedinFollowers', 'linkedin_followers'],
  tiktok_followers: ['tiktokChecked', 'tiktok_checked', 'tiktokFollowers', 'tiktok_followers'],
  youtube_followers: ['youtubeChecked', 'youtube_checked', 'youtubeFollowers', 'youtube_followers'],
  whatsapp_followers: ['whatsappChecked', 'whatsapp_checked', 'whatsappFollowers', 'whatsapp_followers'],
};

function buildSocialFollowerColumns(body) {
  const out = {};
  for (const [column, [checkedCamel, checkedSnake, valueCamel, valueSnake]] of Object.entries(SOCIAL_FOLLOWER_FIELDS)) {
    const checked = body[checkedCamel] ?? body[checkedSnake];
    const value = String(body[valueCamel] ?? body[valueSnake] ?? '').trim();
    out[column] = checked ? (value || null) : null;
  }
  return out;
}

async function createConsultant(supabase, body) {
  const name = String(body.name || '').trim();
  if (!name) {
    throw new Error('Consultant name is required.');
  }
  const partnerTypeRaw = String(body.partnerType || body.partner_type || 'individual').trim();
  if (!PARTNER_TYPES.includes(partnerTypeRaw)) {
    throw new Error(`Invalid partner type. Must be one of: ${PARTNER_TYPES.join(', ')}.`);
  }
  const commissionRateRaw = body.commissionRate !== undefined ? body.commissionRate : body.commission_rate;
  let commissionRate = normalizeCommissionRate(commissionRateRaw);
  // Phase 8 — business partners default to the wholesale rate unless the
  // admin typed in something else; individuals/influencers get no default
  // (Col: "as individuals that could vary" — must be set per-partner).
  if (commissionRate === null && BUSINESS_PARTNER_TYPES.includes(partnerTypeRaw)) {
    commissionRate = DEFAULT_BUSINESS_COMMISSION_RATE;
  }

  const emailNormalized = String(body.email || '').trim().toLowerCase() || null;

  // Bug fix, 2 Sept 2026 (client report, Col): "I created one earlier and
  // it worked now tried 4 times and it won't work... only the original 4
  // resellers are on the reseller list so it hasn't added the
  // information!!" Reproduced directly: Angeline Acejo already existed
  // (created 30 Aug, real row, real code RANGIEA20) — every later retry
  // reused the same email and hit the real unique constraint on
  // sales_consultants.email (idx_sales_consultants_email_lower), which
  // this function correctly threw an error for... but the route's outer
  // catch (POST /api/admin/consultants, below) treats ANY error from this
  // function as a DB-connectivity failure and silently falls back to
  // mockDb — the exact same "ambiguous catch swallows a real business
  // error" bug class already fixed once for a bad partnerType (22 Aug).
  // A duplicate email was never actually blocked from the admin's point
  // of view: it just silently "succeeded" into memory-only storage that
  // vanishes on restart and never appears in the real Resellers list —
  // which is precisely the confusing behavior Col described. Checking
  // proactively here, before the insert, gives a clear, specific message
  // naming the conflict (same style as createPromoCode's existing-active-
  // code check below) instead of relying on the route to correctly
  // classify a raw Postgres error code.
  if (emailNormalized) {
    const { data: existingByEmail } = await supabase
      .from('sales_consultants')
      .select('id, name')
      .ilike('email', emailNormalized)
      .maybeSingle();
    if (existingByEmail) {
      const err = new Error(`This email is already used by another reseller: ${existingByEmail.name}. Use a different email, or edit that existing reseller instead.`);
      // Marked (not just a plain Error) so the route below can tell this
      // apart from a genuine DB-connectivity failure and return a clear
      // 409 instead of silently falling back to mockDb — see the bug fix
      // comment above and the matching check in the route handler.
      err.isKnownValidationError = true;
      throw err;
    }
  }

  const insertRow = {
    name,
    email: emailNormalized,
    phone: String(body.phone || '').trim() || null,
    active: body.active !== false,
    commission_notes: String(body.commissionNotes || body.commission_notes || '').trim() || null,
    admin_notes: String(body.adminNotes || body.admin_notes || '').trim() || null,
    partner_type: partnerTypeRaw,
    commission_rate: commissionRate,
    // Phase 10 — client request, 3 Sept 2026 (Col, reference screenshot):
    // full postal address + per-platform follower counts, so the backend
    // has what it needs "to complete our backend work, payments etc."
    address_line1: String(body.addressLine1 || body.address_line1 || body.address || '').trim() || null,
    address_line2: String(body.addressLine2 || body.address_line2 || '').trim() || null,
    city: String(body.city || '').trim() || null,
    country: String(body.country || '').trim() || null,
    ...buildSocialFollowerColumns(body),
  };

  let { data, error } = await supabase.from('sales_consultants').insert(insertRow).select('*').single();

  // Phase 6/7 Step 4 bug fix, 23 Aug 2026 (extended for Phase 8): before
  // this fix, a not-yet-run migration meant EVERY real consultant creation
  // fell through to the mockDb fallback in the route handler below —
  // including ones with no interest in the missing column at all. That's
  // fine for the consultant row itself (mockDb has always been the safety
  // net for connectivity failures), but it broke Step 4's auto-issued
  // attribution code: promo_codes.consultant_id is a real DB foreign key,
  // and a mockDb id (e.g. "c_1787463304639") isn't a valid UUID a real
  // promo_codes row can reference. So during the entire pending-migration
  // window, autoIssueAttributionCode() would always fail. Retrying the
  // insert without the optional columns (same graceful-degrade pattern as
  // viral_shares.origin_consultant_id in public-checkout.js) means the
  // consultant still lands in the REAL table with a real UUID — just
  // without partner_type/commission_rate persisted yet — so the auto-
  // issued code keeps working right away, and both fields start
  // persisting the moment their migrations are run, with no code change
  // needed then.
  if (isMissingColumnError(error)) {
    OPTIONAL_CONSULTANT_COLUMNS.forEach(col => delete insertRow[col]);
    ({ data, error } = await supabase.from('sales_consultants').insert(insertRow).select('*').single());
    if (data) {
      // reflect the requested values back to the caller even though they weren't persisted
      data.partner_type = partnerTypeRaw;
      data.commission_rate = commissionRate;
    }
  }

  if (error) {
    const err = new Error(`Unable to create consultant: ${error.message}`);
    // Belt-and-suspenders alongside the proactive check above: if two
    // requests race and both pass that check before either inserts, the
    // database's own unique constraint is still the real guarantee — mark
    // this the same way so a genuine duplicate-key race still gets a
    // clear 409 instead of silently succeeding via mockDb.
    if (error.code === '23505') err.isKnownValidationError = true;
    throw err;
  }

  return data;
}

// Phase 6/7 — client request 21 Aug 2026 (Col): "A simple way to create a
// new person/business in the system... Each one gets their own unique
// code." Auto-generates and attaches the partner's first buying/
// attribution code right after they're created, so sign-up feels like one
// action instead of two separate steps (create consultant, then
// separately create a promo code for them). Returns a result object
// rather than throwing on failure — a transient error generating the code
// must never be reported as "consultant creation failed" when the
// consultant row itself was created successfully; see the route below for
// how the two outcomes are distinguished in the response.
// Bug fix / feature, 24 Aug 2026 (client request, Col): "I want to see a
// code creation box for the reseller that either I can manually create or
// allow the subsystem to create." `manualCode` is optional — when given
// (non-empty after trimming), it's used as-is instead of auto-generating
// one; createPromoCode()'s own uniqueness check (DB unique index on
// lower(code)) still catches a real collision and surfaces a clear error
// either way, so a manually-typed duplicate fails the same safe way an
// auto-generated collision would.
async function autoIssueAttributionCode(supabase, consultant, manualCode) {
  try {
    const trimmedManual = String(manualCode || '').trim();
    const code = trimmedManual ? normalizePromoCode(trimmedManual) : await createUniqueAttributionCode(supabase, consultant.name, consultant.commission_rate);
    const promo = await createPromoCode(supabase, { consultantId: consultant.id, code });
    return { code: promo.code, promoCodeId: promo.id, codeGenerated: true };
  } catch (err) {
    console.error('Auto-issue attribution code failed (consultant was still created):', err.message);
    return { code: null, promoCodeId: null, codeGenerated: false, codeError: err.message };
  }
}

async function createPromoCode(supabase, body) {
  const consultantId = String(body.consultantId || body.consultant_id || '').trim();
  const code = normalizePromoCode(body.code);
  const limit = Number(body.monthlyFreeDemoLimit || body.monthly_free_demo_limit || 5);

  if (!consultantId) {
    throw new Error('Consultant is required for a promo code.');
  }
  if (!code) {
    throw new Error('Promo code is required.');
  }
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error('Monthly free demo limit must be zero or more.');
  }

  const { data: existingActiveCode } = await supabase
    .from('promo_codes')
    .select('id, code')
    .eq('consultant_id', consultantId)
    .eq('active', true)
    .maybeSingle();

  if (existingActiveCode) {
    // Bug fix, 2 Sept 2026 (found sweeping the whole dashboard for the
    // same bug class already fixed on the reseller routes): marked so
    // POST /api/admin/promo-codes' outer catch can tell this apart from a
    // genuine DB-connectivity failure — without this, the exact same
    // "ambiguous catch -> silent fake success via mockDb" bug applies
    // here too. Reproduced directly: created a promo code with a code
    // text that already belonged to someone else, got a 200 "success"
    // with a fake p_... id, and nothing was actually created for real.
    const err = new Error(`This consultant already has active promo code ${existingActiveCode.code}.`);
    err.isKnownValidationError = true;
    throw err;
  }

  const { data, error } = await supabase
    .from('promo_codes')
    .insert({
      consultant_id: consultantId,
      code,
      active: body.active !== false,
      monthly_free_demo_limit: limit,
      notes: String(body.notes || '').trim() || null,
    })
    .select('*')
    .single();

  if (error) {
    // Bug fix / polish, 24 Aug 2026 (found while testing the new manual
    // code-entry box, Col's request): a manually-typed code that's
    // already taken by someone else previously surfaced as a raw
    // Postgres error ("duplicate key value violates unique constraint
    // \"idx_promo_codes_code_lower\"") — technically correct but not
    // something an admin typing a code by hand should have to decode.
    if (error.code === '23505') {
      const err = new Error(`Code "${code}" is already in use by another reseller. Please choose a different one.`);
      err.isKnownValidationError = true; // see comment on the existingActiveCode check above
      throw err;
    }
    throw new Error(`Unable to create promo code: ${error.message}`);
  }

  return data;
}

async function createPostcodeTerritory(supabase, body) {
  const consultantId = String(body.consultantId || body.consultant_id || '').trim();
  const territoryName = String(body.territoryName || body.territory_name || '').trim();
  const country = String(body.country || 'New Zealand').trim();
  const matchType = String(body.matchType || body.match_type || 'exact').trim().toLowerCase();
  const postcodeStart = String(body.postcodeStart || body.postcode_start || '').trim();
  const postcodeEnd = String(body.postcodeEnd || body.postcode_end || '').trim() || null;
  const priority = Number(body.priority || 100);

  if (!consultantId) {
    throw new Error('Consultant is required for a postcode territory.');
  }
  if (!postcodeStart) {
    throw new Error('Postcode start is required.');
  }
  if (!['exact', 'prefix', 'range'].includes(matchType)) {
    throw new Error('Match type must be exact, prefix, or range.');
  }
  if (matchType === 'range' && !postcodeEnd) {
    throw new Error('Postcode end is required for range matching.');
  }

  const { data, error } = await supabase
    .from('postcode_territories')
    .insert({
      consultant_id: consultantId,
      territory_name: territoryName || postcodeStart,
      country,
      match_type: matchType,
      postcode_start: postcodeStart,
      postcode_end: postcodeEnd,
      priority: Number.isFinite(priority) ? priority : 100,
      active: body.active !== false,
      notes: String(body.notes || '').trim() || null,
    })
    .select('*')
    .single();

  if (error) {
    throw new Error(`Unable to create postcode territory: ${error.message}`);
  }

  return data;
}

async function loadAttributionAdminData(supabase) {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [
    { data: consultants, error: consultantsError },
    { data: promoCodes, error: promoError },
    { data: territories, error: territoryError },
    { data: freeDemos, error: demoError },
    { data: paidOrders, error: paidError },
  ] = await Promise.all([
    supabase.from('sales_consultants').select('*').order('created_at', { ascending: false }),
    supabase.from('promo_codes').select('*, sales_consultants(id, name, email)').order('created_at', { ascending: false }),
    supabase.from('postcode_territories').select('*, sales_consultants(id, name, email)').order('priority', { ascending: true }),
    supabase.from('keepsakes').select('id, promo_code_id, sales_consultant_id, created_at').eq('is_free_demo', true).gte('created_at', monthStart),
    supabase.from('orders').select('id, order_number, customer_name, total_amount_nzd, payment_status, paid_at, created_at, sales_consultant_id, promo_code_id, territory_id, attribution_source').eq('payment_status', 'paid'),
  ]);

  const firstError = consultantsError || promoError || territoryError || demoError || paidError;
  if (firstError) {
    throw new Error(firstError.message);
  }

  return {
    consultants: consultants || [],
    promoCodes: decoratePromoCodes(promoCodes || [], freeDemos || []),
    territories: territories || [],
    report: buildAttributionReport(consultants || [], freeDemos || [], paidOrders || []),
  };
}

function decoratePromoCodes(promoCodes, freeDemos) {
  return promoCodes.map(code => ({
    ...code,
    freeDemosUsedThisMonth: freeDemos.filter(demo => demo.promo_code_id === code.id).length,
  }));
}

function buildAttributionReport(consultants, freeDemos, paidOrders) {
  const byConsultant = consultants.map(consultant => {
    const demos = freeDemos.filter(demo => demo.sales_consultant_id === consultant.id);
    const orders = paidOrders.filter(order => order.sales_consultant_id === consultant.id);
    return {
      consultantId: consultant.id,
      consultantName: consultant.name,
      freeDemosThisMonth: demos.length,
      paidSalesCount: orders.length,
      paidSalesTotalNzd: orders.reduce((sum, order) => sum + Number(order.total_amount_nzd || 0), 0),
      paidOrders: orders.map(order => ({
        id: order.id,
        orderNumber: order.order_number,
        customerName: order.customer_name,
        totalAmountNzd: Number(order.total_amount_nzd || 0),
        attributionSource: order.attribution_source,
        paidAt: order.paid_at || order.created_at,
      })),
    };
  });

  return {
    freeDemosThisMonth: freeDemos.length,
    paidSalesCount: paidOrders.length,
    paidSalesTotalNzd: paidOrders.reduce((sum, order) => sum + Number(order.total_amount_nzd || 0), 0),
    unattributedPaidSalesCount: paidOrders.filter(order => !order.sales_consultant_id).length,
    byConsultant,
  };
}

async function loadFamousBirthdaysForAdmin(supabase, query) {
  const status = String(query.status || 'pending').trim().toLowerCase();
  const country = String(query.country || '').trim();
  const day = Number(query.day || 0);
  const month = Number(query.month || 0);
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);

  let request = supabase
    .from('famous_birthdays')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (['pending', 'approved', 'rejected'].includes(status)) {
    request = request.eq('curation_status', status);
  }
  if (country) {
    request = request.eq('main_public_country', normalizeCountry(country));
  }
  if (Number.isInteger(day) && day >= 1 && day <= 31) {
    request = request.eq('birth_day', day);
  }
  if (Number.isInteger(month) && month >= 1 && month <= 12) {
    request = request.eq('birth_month', month);
  }

  const { data, error } = await request;
  if (error) {
    throw new Error(`Unable to load famous birthdays: ${error.message}`);
  }

  return data || [];
}

async function updateFamousBirthdayCuration(supabase, birthdayId, body) {
  const patch = {};

  if (body.fullName !== undefined || body.full_name !== undefined) {
    const name = String(body.fullName || body.full_name || '').trim();
    if (!name) throw new Error('Full name is required.');
    patch.full_name = name;
  }
  if (body.shortBio !== undefined || body.short_bio !== undefined) {
    patch.short_bio = String(body.shortBio || body.short_bio || '').trim() || null;
  }
  if (body.occupation !== undefined) {
    patch.occupation = String(body.occupation || '').trim() || null;
  }
  if (body.mainPublicCountry !== undefined || body.main_public_country !== undefined || body.country !== undefined) {
    patch.main_public_country = normalizeCountry(body.mainPublicCountry || body.main_public_country || body.country);
  }
  if (body.displayPriority !== undefined || body.display_priority !== undefined) {
    const priority = Number(body.displayPriority ?? body.display_priority);
    if (!Number.isInteger(priority)) throw new Error('Display priority must be a whole number.');
    patch.display_priority = priority;
  }
  if (body.curationStatus !== undefined || body.curation_status !== undefined || body.status !== undefined) {
    const status = String(body.curationStatus || body.curation_status || body.status || '').trim().toLowerCase();
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      throw new Error('Curation status must be pending, approved, or rejected.');
    }
    patch.curation_status = status;
  }
  if (body.active !== undefined) {
    patch.active = Boolean(body.active);
  }
  if (body.adminNotes !== undefined || body.admin_notes !== undefined) {
    patch.admin_notes = String(body.adminNotes || body.admin_notes || '').trim() || null;
  }

  const { data, error } = await supabase
    .from('famous_birthdays')
    .update(patch)
    .eq('id', birthdayId)
    .select('*')
    .single();

  if (error) {
    throw new Error(`Unable to update famous birthday: ${error.message}`);
  }

  return data;
}

function buildAdminBirthdayResponse(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    birthDay: row.birth_day,
    birthMonth: row.birth_month,
    birthYear: row.birth_year || null,
    mainPublicCountry: row.main_public_country,
    occupation: row.occupation || '',
    shortBio: row.short_bio || '',
    rawExtract: row.raw_extract || '',
    sourceUrl: row.source_url || '',
    wikipediaTitle: row.wikipedia_title || '',
    curationStatus: row.curation_status,
    displayPriority: Number(row.display_priority || 100),
    active: Boolean(row.active),
    adminNotes: row.admin_notes || '',
  };
}

function normalizeQueueStatus(value) {
  const nextStatus = String(value || '').trim().toLowerCase();
  if (!Object.values(QUEUE_STATUS).includes(nextStatus)) {
    throw new Error('Invalid queue status.');
  }
  return nextStatus;
}

async function loadFulfilmentOrders(supabase) {
  const { data, error } = await supabase
    .from('orders')
    .select(`
      id,
      order_number,
      source_portal,
      customer_name,
      customer_email,
      recipient_name,
      product_tier,
      delivery_option,
      queue_status,
      delivery_priority,
      needs_fulfilment,
      payment_status,
      total_amount_nzd,
      created_at,
      shipping_name,
      shipping_address_line1,
      shipping_address_line2,
      shipping_city,
      shipping_region,
      shipping_postcode,
      shipping_country,
      pdf_path,
      printed_at,
      posted_at,
      delivered_at,
      keepsakes (
        id,
        rendered_html,
        pdf_path,
        watermark_status
      )
    `)
    .eq('needs_fulfilment', true)
    .order('delivery_priority', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Unable to read fulfilment queue: ${error.message}`);
  }

  return data || [];
}

async function loadFulfilmentOrderById(supabase, orderId) {
  const { data, error } = await supabase
    .from('orders')
    .select(`
      id,
      order_number,
      source_portal,
      customer_name,
      customer_email,
      recipient_name,
      product_tier,
      delivery_option,
      queue_status,
      delivery_priority,
      needs_fulfilment,
      payment_status,
      total_amount_nzd,
      created_at,
      shipping_name,
      shipping_address_line1,
      shipping_address_line2,
      shipping_city,
      shipping_region,
      shipping_postcode,
      shipping_country,
      pdf_path,
      printed_at,
      posted_at,
      delivered_at,
      keepsake_id,
      keepsakes (
        id,
        rendered_html,
        pdf_path,
        watermark_status
      )
    `)
    .eq('id', orderId)
    .eq('needs_fulfilment', true)
    .single();

  if (error || !data) {
    const notFound = new Error('Fulfilment order not found.');
    notFound.statusCode = 404;
    throw notFound;
  }

  return data;
}

function buildOrderSummary(orders) {
  return orders.reduce((summary, order) => {
    const status = normalizeDisplayStatus(order.queue_status);
    summary.total += 1;
    summary[status] += 1;
    return summary;
  }, {
    total: 0,
    pending: 0,
    printed: 0,
    posted: 0,
    delivered: 0,
  });
}

function compareFulfilmentOrders(left, right) {
  const leftPriority = Number(left.delivery_priority || 99);
  const rightPriority = Number(right.delivery_priority || 99);
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  const leftCreated = new Date(left.created_at || 0).getTime();
  const rightCreated = new Date(right.created_at || 0).getTime();
  if (leftCreated !== rightCreated) {
    return leftCreated - rightCreated;
  }

  return String(left.order_number || '').localeCompare(String(right.order_number || ''));
}

function buildAdminOrderResponse(order) {
  const deliveryOption = resolveDeliveryOption(order);
  const shippingAddress = buildShippingAddress(order);

  return {
    id: order.id,
    orderNumber: order.order_number,
    sourcePortal: order.source_portal,
    customerName: order.customer_name,
    customerEmail: order.customer_email,
    recipientName: order.recipient_name,
    productTier: order.product_tier,
    productTierLabel: titleCase(order.product_tier),
    deliveryOption,
    deliveryOptionLabel: resolveDeliveryLabel(deliveryOption),
    deliveryPriority: Number(order.delivery_priority || 99),
    queueStatus: normalizeDisplayStatus(order.queue_status),
    // Fix, Oct 2026 (checklist item 12, found during a full deep re-audit):
    // the admin Fulfilment Queue — the screen Col actually uses to manage
    // orders — never showed an order's amount or currency at all.
    // total_amount_nzd wasn't even in the SELECT clause of either loader
    // function above. The real Stripe charge is always NZD regardless of
    // the customer's displayed currency (the already-documented
    // cross-cutting finding from Items 2-4/8) — PHASE2_CONFIG.defaultCurrencyCode
    // ('NZD') is the real, correct currency code for every order here, not
    // a guess.
    totalAmountNzd: order.total_amount_nzd !== undefined && order.total_amount_nzd !== null
      ? Number(order.total_amount_nzd)
      : null,
    currencyCode: PHASE2_CONFIG.defaultCurrencyCode,
    createdAt: order.created_at,
    shippingAddress,
    pdfUrl: `/api/admin/orders/${order.id}/download-pdf`,
    printedAt: order.printed_at || null,
    postedAt: order.posted_at || null,
    deliveredAt: order.delivered_at || null,
    hasPdfHtml: Boolean(order.keepsakes?.rendered_html),
    keepsakeId: order.keepsake_id,
    pdfPath: order.pdf_path || order.keepsakes?.pdf_path || null,
  };
}

function resolveDeliveryOption(order) {
  if (order.delivery_option) {
    return order.delivery_option;
  }

  return order.source_portal === SOURCE_PORTALS.radio ? 'standard' : 'standard';
}

function resolveDeliveryLabel(deliveryOption) {
  const delivery = DELIVERY_OPTIONS[deliveryOption];
  return delivery ? delivery.label : 'Standard';
}

function normalizeDisplayStatus(status) {
  const normalized = String(status || 'pending').toLowerCase();
  return Object.values(QUEUE_STATUS).includes(normalized) ? normalized : 'pending';
}

function titleCase(value) {
  return String(value || '')
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function buildShippingAddress(order) {
  return [
    order.shipping_name,
    order.shipping_address_line1,
    order.shipping_address_line2,
    [order.shipping_city, order.shipping_region].filter(Boolean).join(', '),
    [order.shipping_postcode, order.shipping_country].filter(Boolean).join(' ').trim(),
  ].filter(Boolean).join('\n');
}

async function updateOrderStatus({ supabase, sendEmail, order, nextStatus, adminId }) {
  const currentStatus = normalizeDisplayStatus(order.queue_status);
  const now = new Date().toISOString();
  const patch = {
    queue_status: nextStatus,
  };

  if (nextStatus === 'printed' && !order.printed_at) {
    patch.printed_at = now;
  }

  if (nextStatus === 'posted' && !order.posted_at) {
    patch.posted_at = now;
  }

  if (nextStatus === 'delivered' && !order.delivered_at) {
    patch.delivered_at = now;
  }

  const { data: updatedOrder, error } = await supabase
    .from('orders')
    .update(patch)
    .eq('id', order.id)
    .select(`
      *,
      keepsakes (
        id,
        rendered_html,
        pdf_path,
        watermark_status
      )
    `)
    .single();

  if (error) {
    throw new Error(`Unable to update order status: ${error.message}`);
  }

  let emailSent = false;
  // Bug fix, 1 Oct 2026 (found during the email deep audit, new_changes.md
  // Step 9): this sendEmail() was the only one in the codebase not wrapped
  // in try/catch — a Resend failure here would throw out of this whole
  // function, meaning the fulfilment_events audit-trail insert below would
  // never run even though the order status update above had already
  // succeeded, leaving a confusing gap with no record of the attempt.
  if (nextStatus === 'posted' && currentStatus !== 'posted' && sendEmail && updatedOrder.customer_email) {
    try {
      await sendEmail({
        to: updatedOrder.customer_email,
        subject: `Your Tribute Times keepsake has been posted - ${updatedOrder.order_number}`,
        html: buildPostedOrderCustomerEmail(updatedOrder),
      });
      emailSent = true;
    } catch (emailError) {
      console.error('Posted-order customer email failed:', emailError);
    }
  }

  await supabase.from('fulfilment_events').insert({
    order_id: updatedOrder.id,
    previous_status: currentStatus,
    new_status: nextStatus,
    changed_by_admin_id: adminId,
    triggered_email: emailSent,
    note: nextStatus === 'posted'
      ? 'Admin marked order as posted and sent dispatch email.'
      : `Admin updated queue status to ${nextStatus}.`,
  });

  return { order: updatedOrder, emailSent };
}

async function persistPdfPath(supabase, order, pdfPath) {
  await Promise.allSettled([
    supabase.from('orders').update({ pdf_path: pdfPath }).eq('id', order.id),
    supabase.from('keepsakes').update({ pdf_path: pdfPath }).eq('id', order.keepsake_id),
  ]);
}

function sendPdfResponse(res, fileName, pdfBuffer) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(pdfBuffer);
}

module.exports = {
  registerAdminFulfilmentRoutes,
  buildAdminOrderResponse,
  buildOrderSummary,
  compareFulfilmentOrders,
  loadFulfilmentOrders,
  normalizeQueueStatus,
  authAdmin,
};
