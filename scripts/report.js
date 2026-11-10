// Rapport quotidien (3h) et mensuel (1er du mois, 3h) envoyé au gérant par e-mail.
// Lancé par GitHub Actions. Secrets : FIREBASE_SERVICE_ACCOUNT, SMTP_USER, SMTP_PASS
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const MODE = process.env.MODE || 'auto'; // auto | daily | monthly
const pad = n => String(n).padStart(2, '0');

function paris(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute };
}
const fmtT = d => { const p = paris(d); return `${pad(p.h)}:${pad(p.min)}`; };
const fmtH = ms => { const m = Math.round(ms / 60000); return `${Math.floor(m / 60)}h${pad(m % 60)}`; };
const eur = n => n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

async function corrections(since) {
  const snap = await db.collection('logs').where('at', '>=', admin.firestore.Timestamp.fromDate(since)).get();
  return snap.docs.map(d => d.data()).filter(l => /pointage/.test(l.action) && l.detail && l.detail.name)
    .sort((a, b) => a.at.seconds - b.at.seconds);
}
function correctionsHtml(list) {
  if (!list.length) return '<p>✅ Aucune correction d’horaire sur la période.</p>';
  const rows = list.map(l => {
    const d = l.detail, label = { 'modif pointage': 'Modifié', 'ajout pointage': 'Ajouté à la main', 'suppr pointage': 'Supprimé' }[l.action] || l.action;
    const avant = d.before ? `${d.before.s} → ${d.before.e}` : '—', apres = d.after ? `${d.after.s} → ${d.after.e}` : '—';
    return `<tr><td>${fmtT(l.at.toDate())}</td><td>${esc(l.by)}</td><td>${label}</td><td>${esc(d.name)} (service du ${esc(d.day)})</td><td>${esc(avant)}</td><td>${esc(apres)}</td></tr>`;
  }).join('');
  return `<h3 style="color:#c0392b">⚠ ${list.length} correction(s) d’horaire</h3><table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>Heure</th><th>Par</th><th>Action</th><th>Salarié</th><th>Avant</th><th>Après</th></tr>${rows}</table>`;
}

async function build(from, to, users, dels, settings) {
  const [ps, ds] = await Promise.all([
    db.collection('punches').where('day', '>=', from).where('day', '<=', to).get(),
    db.collection('deliveries').where('day', '>=', from).where('day', '<=', to).get()]);
  const punches = ps.docs.map(d => d.data()), deliveries = ds.docs.map(d => d.data());
  let tc = 0, td = 0, html = '<h3>Salariés</h3><table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>Salarié</th><th>Heures</th><th>Coût</th><th>Détail</th></tr>';
  for (const u of users.filter(u => u.role === 'employee')) {
    const mine = punches.filter(p => p.uid === u.id).sort((a, b) => a.start.seconds - b.start.seconds);
    const done = mine.filter(p => p.end);
    const ms = done.reduce((t, p) => t + (p.end.toMillis() - p.start.toMillis()), 0), cost = ms / 3600000 * (u.rate || 0);
    tc += cost;
    const detail = mine.map(p => `${p.day} ${fmtT(p.start.toDate())}→${p.end ? fmtT(p.end.toDate()) : '⚠ SORTIE NON POINTÉE'}${p.corrected ? ' ✎ corrigé' : ''}`).join('<br>');
    if (mine.length) html += `<tr><td>${esc(u.firstName)} <small>${esc(u.code)} ${esc(u.profile)}</small></td><td>${fmtH(ms)}</td><td>${eur(cost)}</td><td><small>${detail}</small></td></tr>`;
  }
  html += `<tr><th>Total salariés</th><th></th><th>${eur(tc)}</th><th></th></tr></table><h3>Livreurs</h3><table border="1" cellpadding="6" style="border-collapse:collapse">`;
  const pct = settings.uberRate ?? 36;
  const stats = list => { const c = { dishop: [0, 0], uber: [0, 0], phone: [0, 0] }; list.forEach(x => { const k = c[x.channel] || c.phone; k[0]++; k[1] += x.amount; });
    const gross = c.dishop[1] + c.uber[1] + c.phone[1], fee = c.uber[1] * pct / 100; return { c, gross, fee, net: gross - fee }; };
  const line = (n, s) => `<tr><td>${n}</td><td>${s.c.dishop[0]} Dishop ${eur(s.c.dishop[1])}</td><td>${s.c.uber[0]} Uber ${eur(s.c.uber[1])}</td><td>${s.c.phone[0]} Tél. ${eur(s.c.phone[1])}</td><td>brut ${eur(s.gross)}</td><td>−Uber ${pct}% ${eur(s.fee)}</td><td><b>${eur(s.net)}</b></td></tr>`;
  const all = stats(deliveries); td = all.net;
  for (const d of dels) { const mine = deliveries.filter(x => x.delivererId === d.id); if (mine.length) html += line(`${esc(d.firstName)} <small>${esc(d.code)}</small>`, stats(mine)); }
  html += `</table><h3>Total général (salaires + livreurs net) : ${eur(tc + td)}</h3>`;
  return html;
}

async function send(to, subject, html) {
  const t = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  await t.sendMail({ from: `Pointage Majestic <${process.env.SMTP_USER}>`, to, subject, html });
}

(async () => {
  const st = await db.collection('settings').doc('main').get();
  const { managerEmail, dayCutoffHour = 3 } = st.data() || {};
  if (!managerEmail) throw new Error('Aucun e-mail gérant dans les réglages');
  const now = new Date(), p = paris(now);
  if (MODE === 'auto' && (p.h < dayCutoffHour || p.h > dayCutoffHour + 2)) { console.log('Hors créneau, rien à faire'); return; }

  // Jour de service qui vient de se terminer
  const ref = paris(new Date(now.getTime() - dayCutoffHour * 3600000 - 60000));
  const day = `${ref.y}-${pad(ref.m)}-${pad(ref.d)}`;
  const lastDayOfMonth = new Date(Date.UTC(ref.y, ref.m, 0)).getUTCDate() === ref.d;
  const users = (await db.collection('users').get()).docs.map(d => ({ id: d.id, ...d.data() }));
  const dels = (await db.collection('deliverers').get()).docs.map(d => ({ id: d.id, ...d.data() }));

  const lastDoc = await db.collection('reports').doc('_last').get();
  const sinceDaily = lastDoc.exists ? lastDoc.data().until.toDate() : new Date(now.getTime() - 24 * 3600000);
  const jobs = [];
  if (MODE !== 'monthly') jobs.push({ key: 'd-' + day, from: day, to: day, since: sinceDaily, daily: true, subject: `Pointage Majestic — rapport du ${day}` });
  if (MODE === 'monthly' || (MODE === 'auto' && lastDayOfMonth)) {
    const ym = `${ref.y}-${pad(ref.m)}`;
    jobs.push({ key: 'm-' + ym, from: ym + '-01', to: ym + '-31', since: new Date(Date.UTC(ref.y, ref.m - 1, 1) - 2 * 3600000), subject: `Pointage Majestic — rapport mensuel ${ym}` });
  }
  for (const j of jobs) {
    const done = await db.collection('reports').doc(j.key).get();
    if (done.exists && MODE === 'auto') { console.log('Déjà envoyé', j.key); continue; }
    const corr = await corrections(j.since);
    const subject = (corr.length ? `⚠ ${corr.length} correction(s) — ` : '') + j.subject;
    await send(managerEmail, subject, `<h2>${j.subject}</h2>` + correctionsHtml(corr) + await build(j.from, j.to, users, dels, st.data()));
    await db.collection('reports').doc(j.key).set({ sentAt: admin.firestore.FieldValue.serverTimestamp() });
    if (j.daily) await db.collection('reports').doc('_last').set({ until: admin.firestore.Timestamp.fromDate(now) });
    console.log('Envoyé', j.key);
  }
})().catch(e => { console.error(e); process.exit(1); });
