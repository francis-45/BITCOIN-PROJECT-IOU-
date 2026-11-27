require('dotenv').config();
const express = require('express'), https = require('https'), fs = require('fs');
const QRCode = require('qrcode');
const app = express(); app.use(express.json());
// The Android app (Capacitor) runs from its own local origin, so allow only those origins.
const APP_ORIGINS = ['http://localhost', 'https://localhost', 'capacitor://localhost', 'ionic://localhost'];
app.use((q, r, n) => { const o = q.headers.origin;
  if (APP_ORIGINS.includes(o)) { r.setHeader('Access-Control-Allow-Origin', o); r.setHeader('Access-Control-Allow-Headers', 'Content-Type'); r.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); }
  q.method === 'OPTIONS' ? r.sendStatus(204) : n(); }); app.use(express.static('public')); app.use('/vendor', express.static('node_modules/jsqr/dist'));
const RATE = +process.env.MWK_PER_BTC || 160000000;
const toSats = m => Math.max(1, Math.round(m / RATE * 1e8));
const PORTS = { alice: 8081, bob: 8082, carol: 8083 };
const agent = new https.Agent({ rejectUnauthorized: false }); // Polar uses self-signed TLS

function lnd(node, method, path, body) {
  return new Promise((resolve, reject) => {
    const U = node.toUpperCase(), mac = process.env[U + '_MACAROON'];
    if (!mac) return reject(new Error('Set ' + U + '_MACAROON in .env'));
    const url = new URL((process.env[U + '_REST'] || 'https://127.0.0.1:' + PORTS[node]) + path);
    const req = https.request(url, { method, agent, headers: {
      'Grpc-Metadata-macaroon': fs.readFileSync(mac).toString('hex'), 'Content-Type': 'application/json' } }, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => { try { const j = JSON.parse(b); res.statusCode >= 400 ? reject(new Error(j.message || b)) : resolve(j); }
        catch (e) { reject(new Error(b.slice(0, 200))); } });
    });
    req.on('error', e => reject(new Error(node + ' node unreachable: ' + e.message)));
    if (body) req.write(JSON.stringify(body)); req.end();
  });
}
// One real Lightning payment: `to` creates an invoice, `from` pays it.
async function pay(from, to, sats, memo) {
  const inv = await lnd(to, 'POST', '/v1/invoices', { value: String(sats), memo });
  const p = await lnd(from, 'POST', '/v1/channels/transactions', { payment_request: inv.payment_request });
  if (p.payment_error) throw new Error(p.payment_error);
  return { hash: Buffer.from(p.payment_hash || '', 'base64').toString('hex'), fee: +(p.payment_route?.total_fees || 0) };
}

let db = { bills: [], savings: [], txs: [] };
try { db = JSON.parse(fs.readFileSync('data.json')); } catch (e) {}   // history survives restarts
db.groups = db.groups || []; db.invoices = db.invoices || {};
const save = () => fs.writeFileSync('data.json', JSON.stringify(db));
const BM_FEE = (+process.env.BITMSIKA_FEE_PCT || 1.5) / 100;   // Bitmsika fee (demo value)
const METHODS = ['Airtel Money', 'TNM Mpamba', 'National Bank', 'Standard Bank', 'FDH Bank', 'NBS Bank', 'Ecobank', 'First Capital', 'CDH Bank'];
function cashInput(b) {
  const method = String(b.method || ''); if (!METHODS.includes(method)) throw new Error('Choose how you want to pay or be paid');
  const account = String(b.account || '').replace(/[\s-]/g, '');
  if (!/^\+?\d{6,15}$/.test(account)) throw new Error('Enter a valid phone or account number');
  const mwk = num(b.mwk, 'amount'); if (mwk < 1000) throw new Error('The minimum is MWK 1,000');
  return { method, account, mwk, mask: '****' + account.slice(-4), fee: Math.round(mwk * BM_FEE) };
}
const cap = x => x[0].toUpperCase() + x.slice(1);
const receipt = (t, r, extra) => ({ id: t.id, title: t.title, category: t.category, mwk: t.mwk, sats: t.sats, fee: r.fee, rate: RATE, at: t.at, ref: r.hash, ...extra });
const num = (x, name) => { x = +x; if (!(x > 0) || !isFinite(x)) throw new Error('Enter a valid ' + name); return x; };
const id = () => Math.random().toString(36).slice(2, 8);
const log = (user, category, title, mwk, sats, dir = 'out') => { const t = { id: id(), user, category, title, mwk, sats, dir, at: Date.now() }; db.txs.unshift(t); return t; };
const h = fn => (q, s) => fn(q).then(r => { save(); s.json(r); }).catch(e => s.status(400).json({ error: e.message }));
const saved = s => s.deposits.reduce((a, d) => a + d.mwk, 0);
const unlocked = s => saved(s) >= s.target && (!s.unlockDate || Date.now() >= new Date(s.unlockDate + 'T00:00:00').getTime());

app.get('/api/state', h(async q => {
  const u = q.query.user, days = +q.query.days || 0; let bal = null, inb = null, error;
  try { const b = await lnd(u, 'GET', '/v1/balance/channels');
    bal = +(b.local_balance?.sat ?? b.local_balance ?? 0); inb = +(b.remote_balance?.sat ?? b.remote_balance ?? 0); }
  catch (e) { error = e.message; }
  const toMwk = x => x == null ? null : Math.round(x / 1e8 * RATE);
  const mine = db.txs.filter(t => t.user === u && (!days || t.at >= Date.now() - days * 864e5));
  const sum = a => a.reduce((x, t) => x + t.mwk, 0);
  const spent = mine.filter(t => t.dir !== 'in' && !['Savings', 'Withdrawal'].includes(t.category)), byCat = {};
  spent.forEach(t => byCat[t.category] = (byCat[t.category] || 0) + t.mwk);
  let owe = 0, oweCount = 0, owed = 0;
  db.bills.forEach(b => { const m = b.members.find(x => x.user === u);
    if (m && !m.paid && b.creator !== u) { owe += b.share; oweCount++; }
    if (b.creator === u) owed += b.members.filter(x => !x.paid).length * b.share; });
  return { rate: RATE, bmFee: BM_FEE, balanceSats: bal, balanceMwk: toMwk(bal), inboundMwk: toMwk(inb), error,
    summary: { spent: sum(spent), received: sum(mine.filter(t => t.dir === 'in')),
      saved: sum(mine.filter(t => t.category === 'Savings' && t.dir !== 'in')), byCat },
    owe, oweCount, owed, txs: mine.slice(0, 15), bills: db.bills.filter(b => b.members.some(m => m.user === u)), groups: db.groups.filter(g => g.members.includes(u)),
    savings: db.savings.filter(s => s.members.includes(u)).map(s => ({ ...s, saved: saved(s), unlocked: unlocked(s) })) };
}));

// Split bills: every member pays the creator's node over Lightning.
app.post('/api/bills', h(async q => {
  const { creator } = q.body, g = db.groups.find(x => x.id === q.body.groupId), members = g ? g.members : q.body.members, title = String(q.body.title || '').trim(), total = num(q.body.total, 'amount');
  if (!title) throw new Error('Add a name for this bill');
  if (!members || !members.includes(creator)) throw new Error('Pick a group first');
  const b = { id: id(), groupId: g && g.id, title, total: +total, creator, share: Math.round(total / members.length),
    members: members.map(m => ({ user: m, paid: m === creator })) };
  db.bills.unshift(b); return b;
}));
app.post('/api/bills/:id/pay', h(async q => {
  const b = db.bills.find(x => x.id === q.params.id), m = b && b.members.find(x => x.user === q.body.user);
  if (!m || m.paid) throw new Error('Nothing to pay');
  const sats = toSats(b.share), r = await pay(m.user, b.creator, sats, 'Split: ' + b.title);
  m.paid = true; const t = log(m.user, 'Split bill', b.title, b.share, sats);
  log(b.creator, 'Split bill', b.title + ' (from ' + m.user + ')', b.share, sats, 'in');
  return receipt(t, r, { to: cap(b.creator), from: cap(m.user), note: b.title, via: 'Lightning, node to node' });
}));

// Savings: deposits go to the vault (Carol). Withdrawal is refused until the rules are met.
app.post('/api/savings', h(async q => {
  const { type, unlockDate, creator, members } = q.body, name = String(q.body.name || '').trim(), target = num(q.body.target, 'target');
  if (!name) throw new Error('Name your savings pot');
  const s = { id: id(), name, type, target: +target, unlockDate: unlockDate || null,
    members: type === 'group' ? [...new Set([creator, ...(members || [])])] : [creator], deposits: [], emoji: String(q.body.emoji || '🎯').slice(0, 4), withdrawn: false, paidOut: {} };
  db.savings.unshift(s); return s;
}));
app.post('/api/savings/:id/deposit', h(async q => {
  const s = db.savings.find(x => x.id === q.params.id), { user } = q.body, mwk = num(q.body.mwk, 'amount');
  if (!s || s.withdrawn) throw new Error('This savings pot is closed');
  const sats = toSats(mwk); await pay(user, 'carol', sats, 'Savings: ' + s.name);
  s.deposits.push({ user, mwk: +mwk, sats }); log(user, 'Savings', s.name, +mwk, sats); return s;
}));
app.post('/api/savings/:id/withdraw', h(async q => {
  const s = db.savings.find(x => x.id === q.params.id);
  if (!s || s.withdrawn) throw new Error('Already withdrawn');
  if (!unlocked(s)) throw new Error(saved(s) < s.target ? 'Save ' + (s.target - saved(s)).toLocaleString() + ' MWK more to unlock this' : 'Your target is reached. This unlocks on ' + s.unlockDate);
  const per = {}; s.deposits.forEach(d => per[d.user] = (per[d.user] || 0) + d.sats);
  s.paidOut = s.paidOut || {};
  for (const [u, sats] of Object.entries(per)) { if (s.paidOut[u]) continue;
    await pay('carol', u, sats, 'Payout: ' + s.name); s.paidOut[u] = true;
    log(u, 'Savings payout', s.name, Math.round(sats / 1e8 * RATE), sats, 'in'); }
  s.withdrawn = true; return s;
}));

// Payments: user pays Carol (acts as the Bitmsika gateway). Payout to the provider is simulated.
app.post('/api/pay', h(async q => {
  const { user, category, provider, recipient } = q.body, mwk = num(q.body.mwk, 'amount'), sats = toSats(mwk);
  const r = await pay(user, 'carol', sats, category + ': ' + provider);
  const t = log(user, category, provider + (recipient ? ' to ' + recipient : ''), mwk, sats);
  return receipt(t, r, { to: provider + (recipient ? ' (' + recipient + ')' : ''), via: 'Lightning via Bitmsika (payout simulated)' });
}));

// Pay a person directly: node to node, no gateway in between.
app.post('/api/send', h(async q => {
  const { from, to } = q.body, note = String(q.body.note || '').trim().slice(0, 60), mwk = num(q.body.mwk, 'amount');
  if (!['alice', 'bob'].includes(from) || !['alice', 'bob'].includes(to) || from === to) throw new Error('Choose a person to pay');
  const sats = toSats(mwk), r = await pay(from, to, sats, note || 'Payment from ' + cap(from));
  const t = log(from, 'Send money', 'To ' + cap(to) + (note ? ': ' + note : ''), mwk, sats);
  log(to, 'Send money', 'From ' + cap(from) + (note ? ': ' + note : ''), mwk, sats, 'in');
  return receipt(t, r, { to: cap(to), from: cap(from), note, via: 'Lightning, node to node' });
}));


// ---- Node identity: people are found by node name or node ID (public key) ----
const known = {};
async function nodeInfo(n) { if (!known[n]) { const i = await lnd(n, 'GET', '/v1/getinfo'); known[n] = { name: n, alias: i.alias, pubkey: i.identity_pubkey }; } return known[n]; }
async function resolve(idf) {
  const x = String(idf || '').trim().toLowerCase();
  if (['alice', 'bob'].includes(x)) return x;
  if (x.length >= 8 && /^[0-9a-f]+$/.test(x)) for (const n of ['alice', 'bob']) { try { if ((await nodeInfo(n)).pubkey.startsWith(x)) return n; } catch (e) {} }
  throw new Error('No node found for "' + idf + '". Use a node name like bob, or a full node ID.');
}
app.get('/api/nodes', h(async () => { const out = {}; for (const n of ['alice', 'bob']) { try { out[n] = await nodeInfo(n); } catch (e) { out[n] = { name: n, pubkey: null }; } } return out; }));
app.post('/api/groups', h(async q => {
  const { type, creator } = q.body, name = String(q.body.name || '').trim();
  if (!name) throw new Error('Name your group');
  const members = [creator];
  for (const i of q.body.members || []) { const u = await resolve(i); if (!members.includes(u)) members.push(u); }
  if (members.length < 2) throw new Error('Add at least one other person by node name or ID');
  const g = { id: id(), type: String(type || 'Other'), emoji: String(q.body.emoji || '👥').slice(0, 4), name, creator, members };
  db.groups.unshift(g); return g;
}));

// ---- QR codes: receive with an invoice, pay a scanned invoice ----
const QROPT = { margin: 1, width: 340, errorCorrectionLevel: 'M', color: { dark: '#0F1E3D', light: '#FFFFFF' } };
app.get('/api/qr', h(async q => ({ qr: await QRCode.toDataURL(String(q.query.text || '').slice(0, 600), QROPT) })));
app.post('/api/receive', h(async q => {
  const { user } = q.body, memo = String(q.body.memo || '').trim().slice(0, 60), mwk = +q.body.mwk || 0, sats = mwk > 0 ? toSats(mwk) : 0;
  const inv = await lnd(user, 'POST', '/v1/invoices', { value: String(sats), memo, expiry: '3600' });
  const hash = Buffer.from(inv.r_hash, 'base64').toString('hex');
  db.invoices[hash] = { user };
  return { payreq: inv.payment_request, hash, sats, qr: await QRCode.toDataURL(inv.payment_request.toUpperCase(), QROPT) };
}));
app.get('/api/invoice/:hash', h(async q => {
  const rec = db.invoices[q.params.hash]; if (!rec) throw new Error('Unknown invoice');
  const i = await lnd(rec.user, 'GET', '/v1/invoice/' + q.params.hash);
  if (i.state !== 'SETTLED') return { settled: false };
  const sats = +(i.amt_paid_sat || i.value || 0), mwk = Math.round(sats / 1e8 * RATE);
  let t = db.txs.find(x => x.ref === q.params.hash);
  if (!t) { t = log(rec.user, 'Received', 'Invoice payment', mwk, sats, 'in'); t.ref = q.params.hash; }
  return { settled: true, id: t.id, title: t.title, category: 'Money received', head: 'Money received', mwk, sats, fee: 0, rate: RATE, at: t.at, ref: q.params.hash, to: cap(rec.user), from: 'Lightning payer', via: 'Lightning invoice' };
}));
app.post('/api/decode', h(async q => {
  const d = await lnd(q.body.user, 'GET', '/v1/payreq/' + encodeURIComponent(String(q.body.payreq).trim()));
  return { sats: +(d.num_satoshis || 0), memo: d.description || '' };
}));
app.post('/api/payinvoice', h(async q => {
  const { user } = q.body, pr = String(q.body.payreq || '').trim();
  const d = await lnd(user, 'GET', '/v1/payreq/' + encodeURIComponent(pr));
  let sats = +(d.num_satoshis || 0); const body = { payment_request: pr };
  if (!sats) { sats = toSats(num(q.body.mwk, 'amount')); body.amt = String(sats); }
  const p = await lnd(user, 'POST', '/v1/channels/transactions', body);
  if (p.payment_error) throw new Error(p.payment_error);
  const mwk = Math.round(sats / 1e8 * RATE), t = log(user, 'Scan to pay', d.description || 'Lightning invoice', mwk, sats);
  return receipt(t, { hash: Buffer.from(p.payment_hash || '', 'base64').toString('hex'), fee: +(p.payment_route?.total_fees || 0) },
    { to: d.description || 'Lightning invoice', from: cap(user), via: 'Lightning invoice' });
}));

// ---- Bitmsika cash in / cash out (the Lightning leg is real, the mobile money or bank leg is simulated) ----
// Deposit: user pays kwacha to Bitmsika, Bitmsika (Carol) sends sats to the user over Lightning.
app.post('/api/deposit', h(async q => {
  const { user } = q.body, c = cashInput(q.body), sats = toSats(c.mwk - c.fee);
  const r = await pay('carol', user, sats, 'Bitmsika deposit via ' + c.method);
  const t = log(user, 'Deposit', 'Bitmsika deposit via ' + c.method, c.mwk, sats, 'in');
  return receipt(t, r, { head: 'Deposit complete', satsLabel: 'Received in Bitcoin', bmFee: c.fee, to: 'Your wallet', from: c.method + ' ' + c.mask, via: 'Bitmsika collection simulated, Bitcoin sent over Lightning' });
}));
// Withdraw: user sends sats to Bitmsika (Carol) over Lightning, Bitmsika pays kwacha out.
app.post('/api/withdraw', h(async q => {
  const { user } = q.body, c = cashInput(q.body), total = c.mwk + c.fee, sats = toSats(total);
  const r = await pay(user, 'carol', sats, 'Bitmsika withdrawal to ' + c.method);
  const t = log(user, 'Withdrawal', 'To ' + c.method + ' ' + c.mask, total, sats);
  return receipt(t, r, { head: 'Withdrawal sent', bmFee: c.fee, mwk: c.mwk, to: c.method + ' ' + c.mask, from: cap(user), via: 'Lightning to Bitmsika, kwacha payout simulated' });
}));

app.listen(3000, () => console.log('I.O.U. running at http://localhost:3000'));
