'use strict';

const {createHash, timingSafeEqual} = require('node:crypto');
const TEST_e1d8e782060dd3e9bfe4c7b4beb5544a71cf73fc2e27449784db7f888be9023e = Buffer.from('e1d8e782060dd3e9bfe4c7b4beb5544a71cf73fc2e27449784db7f888be9023e', 'hex');


const FIELDS = new Set(['name', 'phone', 'email', 'updates', 'website']);
const MAX_JSON_BYTES = 4096;

function validate(b) {
  if (!b || Object.getPrototypeOf(b) !== Object.prototype ||
      Object.keys(b).length !== FIELDS.size ||
      !Object.keys(b).every((k) => FIELDS.has(k)) ||
      ['name', 'phone', 'email', 'website'].some((k) => typeof b[k] !== 'string') ||
      typeof b.updates !== 'boolean' || b.website !== '') return null;
  const name = b.name.trim();
  const phone = b.phone.replace(/[^\d+]/g, '');
  const email = b.email.trim();
  if (name.length < 2 || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name) ||
      b.phone.length > 32 || !/^(?:\+972|0)5\d{8}$/.test(phone) ||
      email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return null;
  return {name, phone, email, updates: b.updates ? 'yes' : 'no', page: 'rakafot', website: ''};
}

function makeHandler({fetchImpl = globalThis.fetch, env = process.env} = {}) {
  return async function rakafotLead(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const verificationToken = req.headers['x-rakafot-verification'];
    if (typeof verificationToken !== 'string' || !timingSafeEqual(createHash('sha256').update(verificationToken).digest(), TEST_DIGEST)) {
      return res.status(404).json({ok: false});
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ok: false});
    }
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return res.status(415).json({ok: false});
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > MAX_JSON_BYTES) return res.status(413).json({ok: false});
    let lead;
    try {
      const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      if (!raw) return res.status(400).json({ok: false});
      if (Buffer.byteLength(raw) > MAX_JSON_BYTES) return res.status(413).json({ok: false});
      lead = validate(typeof req.body === 'string' ? JSON.parse(raw) : req.body);
    } catch (_) {
      return res.status(400).json({ok: false});
    }
    if (!lead) return res.status(400).json({ok: false});
    const endpoint = env.RAKAFOT_APPS_SCRIPT_URL;
    const key = env.RAKAFOT_SHARED_KEY;
    if (typeof endpoint !== 'string' || !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(endpoint) ||
        typeof key !== 'string' || key.length < 32 || key.length > 256) return res.status(503).json({ok: false});
    try {
      const signal = AbortSignal.timeout(11000);
      let upstream = await fetchImpl(endpoint, {
        method: 'POST', body: new URLSearchParams({...lead, key}),
        redirect: 'manual', signal,
      });
      // Apps Script ContentService serves the result from an ephemeral Google-hosted URL.
      if ([301, 302, 303].includes(upstream.status)) {
        const target = new URL(upstream.headers.get('location') || '');
        if (target.origin !== 'https://script.googleusercontent.com' || target.pathname !== '/macros/echo' ||
            target.username || target.password) return res.status(502).json({ok: false});
        upstream = await fetchImpl(target.href, {method: 'GET', redirect: 'error', signal});
      }
      if (!upstream.ok || !/^application\/json(?:;|$)/i.test(upstream.headers.get('content-type') || '')) return res.status(502).json({ok: false});
      const data = await upstream.json();
      if (data?.ok !== true || data?.written !== 1) return res.status(502).json({ok: false});
      return res.status(200).json({ok: true});
    } catch (_) {
      return res.status(502).json({ok: false});
    }
  };
}

module.exports = makeHandler();
module.exports.makeHandler = makeHandler;
