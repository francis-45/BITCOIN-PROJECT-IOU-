require('dotenv').config();
const express = require('express'), https = require('https'), fs = require('fs');
const app = express(); app.use(express.json()); app.use(express.static('public'));
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
}

let db = { bills: [], savings: [], txs: [] };
try { db = JSON.parse(fs.readFileSync('data.json')); } catch (e) {}   // history survives restarts
const save = () => fs.writeFileSync('data.json', JSON.stringify(db));
const num = (x, name) => { x = +x; if (!(x > 0) || !isFinite(x)) throw new Error('Enter a valid ' + name); return x; };
const id = () => Math.random().toString(36).slice(2, 8);
const log = (user, category, title, mwk, sats, dir = 'out') => { const t = { id: id(), user, category, title, mwk, sats, dir, at: Date.now() }; db.txs.unshift(t); return t; };
const h = fn => (q, s) => fn(q).then(r => { save(); s.json(r); }).catch(e => s.status(400).json({ error: e.message }));
const saved = s => s.deposits.reduce((a, d) => a + d.mwk, 0);
const unlocked = s => saved(s) >= s.target && (!s.unlockDate || Date.now() >= Date.parse(s.unlockDate));

app.get('/api/state', h(async q => {
  const u = q.query.user, days = +q.query.days || 0; let bal = null, inb = null, error;
  try { const b = await lnd(u, 'GET', '/v1/balance/channels');
    bal = +(b.local_balance?.sat ?? b.local_balance ?? 0); inb = +(b.remote_balance?.sat ?? b.remote_balance ?? 0); }
  catch (e) { error = e.message; }
  const toMwk = x => x == null ? null : Math.round(x / 1e8 * RATE);
  const mine = db.txs.filter(t => t.user === u && (!days || t.at >= Date.now() - days * 864e5));
  const sum = a => a.reduce((x, t) => x + t.mwk, 0);
  const spent = mine.filter(t => t.dir !== 'in' && t.category !== 'Savings'), byCat = {};
  spent.forEach(t => byCat[t.category] = (byCat[t.category] || 0) + t.mwk);
  let owe = 0, oweCount = 0, owed = 0;
  db.bills.forEach(b => { const m = b.members.find(x => x.user === u);
    if (m && !m.paid && b.creator !== u) { owe += b.share; oweCount++; }
    if (b.creator === u) owed += b.members.filter(x => !x.paid).length * b.share; });
  return { rate: RATE, balanceSats: bal, balanceMwk: toMwk(bal), inboundMwk: toMwk(inb), error,
    summary: { spent: sum(spent), received: sum(mine.filter(t => t.dir === 'in')),
      saved: sum(mine.filter(t => t.category === 'Savings' && t.dir !== 'in')), byCat },
    owe, oweCount, owed, txs: mine.slice(0, 15), bills: db.bills,
    savings: db.savings.filter(s => s.members.includes(u)).map(s => ({ ...s, saved: saved(s), unlocked: unlocked(s) })) };
}));

// Split bills: every member pays the creator's node over Lightning.
app.post('/api/bills', h(async q => {
  const { creator, members } = q.body, title = String(q.body.title || '').trim(), total = num(q.body.total, 'amount');
  if (!title) throw new Error('Add a name for this bill');
  const b = { id: id(), title, total: +total, creator, share: Math.round(total / members.length),
    members: members.map(m => ({ user: m, paid: m === creator })) };
  db.bills.unshift(b); return b;
}));
app.post('/api/bills/:id/pay', h(async q => {
  const b = db.bills.find(x => x.id === q.params.id), m = b && b.members.find(x => x.user === q.body.user);
  if (!m || m.paid) throw new Error('Nothing to pay');
  const sats = toSats(b.share); await pay(m.user, b.creator, sats, 'Split: ' + b.title);
  m.paid = true; log(m.user, 'Split bill', b.title, b.share, sats);
  log(b.creator, 'Split bill', b.title + ' (from ' + m.user + ')', b.share, sats, 'in'); return b;
}));

// Savings: deposits go to the vault (Carol). Withdrawal is refused until the rules are met.
app.post('/api/savings', h(async q => {
  const { type, unlockDate, creator, members } = q.body, name = String(q.body.name || '').trim(), target = num(q.body.target, 'target');
  if (!name) throw new Error('Name your savings pot');
  const s = { id: id(), name, type, target: +target, unlockDate: unlockDate || null,
    members: type === 'group' ? [...new Set([creator, ...(members || [])])] : [creator], deposits: [], withdrawn: false, paidOut: {} };
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
  if (!unlocked(s)) throw new Error('Locked until ' + s.target.toLocaleString() + ' MWK is saved' + (s.unlockDate ? ' and ' + s.unlockDate : ''));
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
  await pay(user, 'carol', sats, category + ': ' + provider);
  log(user, category, provider + (recipient ? ' to ' + recipient : ''), +mwk, sats);
  return { ok: true };
}));

app.listen(3000, () => console.log('I.O.U. running at http://localhost:3000'));
