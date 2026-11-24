'use strict';
/* حاسبة التكلفة والتسعير – elhassan home. بدون سيرفر. البيانات في localStorage على الجهاز فقط. */

/* ================= حسابات نقية (قابلة للاختبار) ================= */
const UNITS = {
  weight: { base: 'كجم', opts: [['kg', 'كجم'], ['g', 'جرام']] },
  volume: { base: 'لتر', opts: [['L', 'لتر'], ['ml', 'مل']] },
  set: { base: 'طقم', opts: [['set', 'طقم']] }
};
const UNIT_LABEL = { kg: 'كجم', g: 'جرام', L: 'لتر', ml: 'مل', set: 'طقم' };
const UNIT_FACTOR = { kg: 1, g: 0.001, L: 1, ml: 0.001, set: 1 };
const CATS = { raw: 'خامات', finish: 'تشطيب', pack: 'تغليف', labor: 'مصنعية' };
const FINISHES = { plain: 'سادة', gold: 'تشبيح ورق دهب', munaqqash: 'منقرش', custom: 'لون خاص (بتكلفة إضافية)' };

function num(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  let s = String(v == null ? '' : v).trim();
  s = s.replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
       .replace(/[٬\s]/g, '');
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  s = s.replace(/[٫,]/g, '.');
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}
function toBase(q, unit) { return num(q) * (UNIT_FACTOR[unit] || 1); }
function packBase(m) { return toBase(m.packQty, m.packUnit); }
function unitPrice(m) { const b = packBase(m); return b > 0 ? num(m.price) / b : 0; }   // سعر الوحدة الأساسية (كجم/لتر/طقم)
function lineUnitOk(m, unit) { return !!m && (UNITS[m.kind].opts.some(o => o[0] === unit)); }

function recipeCost(r, mats, s) {
  const byId = Object.fromEntries(mats.map(m => [m.id, m]));
  const parts = { raw: 0, finish: 0, pack: 0, labor: 0 };
  const missing = [];
  const lines = (r.lines || []).map(l => {
    const m = byId[l.matId];
    if (!m) { missing.push(l.matId); return { l, cost: 0, base: 0, m: null }; }
    const base = toBase(l.qty, lineUnitOk(m, l.unit) ? l.unit : UNITS[m.kind].opts[0][0]);
    const cost = base * unitPrice(m);
    parts[m.cat] = (parts[m.cat] || 0) + cost;
    return { l, cost, base, m };
  });
  let finishCost = 0, finishMissing = false;
  if (r.finish === 'custom') finishCost = Math.max(0, num(r.customExtra));
  else if (r.finish === 'gold' || r.finish === 'munaqqash') {
    const fm = mats.find(m => m.finishKey === r.finish);
    if (fm) finishCost = unitPrice(fm); else finishMissing = true;
  }
  parts.finish += finishCost;
  const direct = parts.raw + parts.finish + parts.pack + parts.labor;
  const wastePct = Math.max(0, num(s.waste));
  const waste = direct * wastePct / 100;
  return { lines, parts, direct, waste, total: direct + waste, missing, finishMissing };
}
function ceilTo(x, step) { if (!(step > 0)) return x; return Math.ceil(x / step - 1e-9) * step; }
function floorPrice(cost, s) {                       // أقل سعر يحقق الهامش الآمن (مقرّب لأعلى لأقرب جنيه)
  const f = Math.min(Math.max(num(s.floor), 0), 95) / 100;
  return Math.ceil(cost / (1 - f) - 1e-9);
}
function pricingOf(r, cost, s) {
  let price = 0, auto = false;
  if (r.priceMode === 'target') {
    const t = Math.max(0, num(r.targetPct));
    let p = 0;
    if (r.targetType === 'markup') p = cost * (1 + t / 100);
    else p = t < 95 ? cost / (1 - t / 100) : 0;
    price = ceilTo(p, Math.max(0, num(s.roundStep))); auto = true;
  } else price = Math.max(0, num(r.price));
  const profit = price - cost;
  return { price, auto, profit, margin: price > 0 ? profit / price * 100 : 0, markup: cost > 0 ? profit / cost * 100 : 0 };
}
function statusOf(p, cost, s) {
  if (!(p.price > 0)) return { k: 'low', t: 'اكتب سعر البيع أو نسبة الربح' };
  if (p.price <= cost) return { k: 'loss', t: 'السعر أقل من أو يساوي التكلفة: خسارة' };
  if (p.margin < num(s.floor)) return { k: 'low', t: 'الهامش أقل من الحد الآمن اللي حددته (' + num(s.floor) + '%)' };
  if (p.margin < num(s.excellent)) return { k: 'ok', t: 'هامش مقبول' };
  return { k: 'good', t: 'هامش ممتاز حسب الحد اللي حددته (' + num(s.excellent) + '%)' };
}
function suggestedDiscount(tiers, sets) {
  let best = 0;
  (tiers || []).forEach(t => { if (sets >= num(t.min) && num(t.disc) > best) best = num(t.disc); });
  return best;
}
function negoCalc(lines, recipes, mats, s, disc) {
  const d = Math.min(Math.max(num(disc), 0), 100);
  let cost = 0, rev = 0, list = 0, sets = 0;
  const rows = [];
  lines.forEach(l => {
    const r = recipes.find(x => x.id === l.recipeId); if (!r) return;
    const qty = Math.max(0, Math.floor(num(l.qty)));
    const c = recipeCost(r, mats, s).total;
    const lp = pricingOf(r, c, s).price;
    const special = num(l.special) > 0 ? num(l.special) : 0;
    const net = special > 0 ? special : lp * (1 - d / 100);
    const fl = floorPrice(c, s);
    rows.push({ r, qty, c, lp, net, special: special > 0, fl, profitPer: net - c, below: net < fl, loss: net < c });
    cost += qty * c; rev += qty * net; list += qty * lp; sets += qty;
  });
  const profit = rev - cost;
  const f = Math.min(Math.max(num(s.floor), 0), 95) / 100;
  const maxDisc = list > 0 ? Math.max(0, (1 - cost / ((1 - f) * list)) * 100) : 0; // أقصى خصم موحّد يحافظ على الهامش الآمن للأوردر ككل
  return { rows, cost, rev, list, profit, sets, margin: rev > 0 ? profit / rev * 100 : 0, perSet: sets ? profit / sets : 0, maxDisc, d };
}
function procure(lines, recipes, mats, s, addWaste) {
  const need = {};            // matId -> كمية بالوحدة الأساسية
  lines.forEach(l => {
    const r = recipes.find(x => x.id === l.recipeId); if (!r) return;
    const qty = Math.max(0, Math.floor(num(l.qty))); if (!qty) return;
    const c = recipeCost(r, mats, s);
    c.lines.forEach(x => { if (x.m) need[x.m.id] = (need[x.m.id] || 0) + x.base * qty; });
    if (r.finish === 'gold' || r.finish === 'munaqqash') {
      const fm = mats.find(m => m.finishKey === r.finish); if (fm) need[fm.id] = (need[fm.id] || 0) + qty;
    }
  });
  const k = addWaste ? 1 + Math.max(0, num(s.waste)) / 100 : 1;
  const out = [];
  mats.forEach(m => {
    if (!(need[m.id] > 0)) return;
    const net = need[m.id], gross = m.kind === 'set' ? net : net * k, pb = packBase(m);
    const hasPacks = m.kind !== 'set' && pb > 0;
    const packs = hasPacks ? Math.ceil(gross / pb - 1e-9) : 0;
    const buyCost = hasPacks ? packs * num(m.price) : gross * unitPrice(m);
    out.push({ m, net, gross, packs, pb, hasPacks, buyCost, useCost: gross * unitPrice(m), leftover: hasPacks ? packs * pb - gross : 0 });
  });
  return out;
}
function customFinishExtraSets(lines, recipes) {
  return lines.reduce((a, l) => { const r = recipes.find(x => x.id === l.recipeId); return a + (r && r.finish === 'custom' ? Math.max(0, Math.floor(num(l.qty))) : 0); }, 0);
}

/* ================= بيانات تجريبية ================= */
function demoData() {
  const M = (id, name, cat, kind, price, qty, unit, packName, extra) => Object.assign({ id, name, cat, kind, price, packQty: qty, packUnit: unit, packName: packName || '', demo: true }, extra || {});
  const materials = [
    M('m_gyp', 'جبس', 'raw', 'weight', 150, 50, 'kg', 'شكارة'),
    M('m_fil', 'فيلر تأسيس', 'raw', 'weight', 500, 25, 'kg', 'جركن'),
    M('m_var', 'ورنيش حماية بلمعة السيراميك', 'raw', 'volume', 600, 4, 'L', 'علبة'),
    M('m_start', 'دهان Start', 'raw', 'weight', 480, 4, 'kg', 'علبة'),
    M('m_glc', 'دهان GLC', 'raw', 'weight', 600, 4, 'kg', 'علبة'),
    M('m_gold', 'تشبيح ورق دهب (تقديري للطقم)', 'finish', 'set', 20, 1, 'set', '', { finishKey: 'gold' }),
    M('m_mun', 'منقرش (تقديري للطقم)', 'finish', 'set', 15, 1, 'set', '', { finishKey: 'munaqqash' }),
    M('m_pack', 'تغليف: بابل راب + كرتونة + سوليتيب (للطقم)', 'pack', 'set', 12, 1, 'set'),
    M('m_l1', 'مصنعية صب', 'labor', 'set', 10, 1, 'set'),
    M('m_l2', 'مصنعية صنفرة وتأسيس', 'labor', 'set', 8, 1, 'set'),
    M('m_l3', 'مصنعية دهان', 'labor', 'set', 10, 1, 'set'),
    M('m_l4', 'مصنعية تغليف', 'labor', 'set', 4, 1, 'set')
  ];
  const L = (matId, qty, unit) => ({ matId, qty, unit });
  const labor = [L('m_l1', 1, 'set'), L('m_l2', 1, 'set'), L('m_l3', 1, 'set'), L('m_l4', 1, 'set')];
  const R = (id, name, code, pieces, lines, finish) => ({ id, name, code, pieces, lines: lines.concat([L('m_pack', 1, 'set')], labor), finish: finish || 'plain', customExtra: 0, priceMode: 'target', targetType: 'margin', targetPct: 30, price: 0, demo: true });
  const recipes = [
    R('r1', 'دوناتس سادة (مثال)', 'DEMO-01', 3, [L('m_gyp', 900, 'g'), L('m_fil', 90, 'g'), L('m_var', 30, 'ml'), L('m_start', 70, 'g')]),
    R('r2', 'دوناتس ورق دهب (مثال)', 'DEMO-02', 3, [L('m_gyp', 900, 'g'), L('m_fil', 90, 'g'), L('m_var', 30, 'ml'), L('m_glc', 70, 'g')], 'gold'),
    R('r3', 'طقم ملكي (مثال)', 'DEMO-03', 6, [L('m_gyp', 3.2, 'kg'), L('m_fil', 300, 'g'), L('m_var', 90, 'ml'), L('m_start', 250, 'g'), L('m_glc', 100, 'g')], 'gold'),
    R('r4', 'طقم مفكر (مثال)', 'DEMO-04', 3, [L('m_gyp', 1.1, 'kg'), L('m_fil', 110, 'g'), L('m_var', 40, 'ml'), L('m_start', 90, 'g')]),
    R('r5', 'طقم يقطينة (مثال)', 'DEMO-05', 3, [L('m_gyp', 1.3, 'kg'), L('m_fil', 120, 'g'), L('m_var', 40, 'ml'), L('m_glc', 90, 'g')], 'munaqqash')
  ];
  return { v: 1, materials, recipes };
}
function defaultSettings() {
  return { waste: 10, floor: 15, excellent: 30, roundStep: 5, tiers: [{ min: 50, disc: 3 }, { min: 100, disc: 5 }, { min: 200, disc: 8 }], tiersDemo: true };
}

/* ================= الحالة والتخزين ================= */
const LS = 'elhassan_pricing_v1', LS_PIN = 'elhassan_pricing_pin_v1';
let state, ui = { tab: 'materials', draft: null, recipeId: null };
function freshState() { const d = demoData(); return { v: 1, settings: defaultSettings(), materials: d.materials, recipes: d.recipes, nego: { lines: [], disc: 0 }, order: { lines: [], waste: true } }; }
function normalizeState(x) {
  const f = freshState();
  if (!x || typeof x !== 'object') return f;
  const s = Object.assign({}, f.settings, x.settings || {});
  s.tiers = Array.isArray(s.tiers) ? s.tiers.map(t => ({ min: num(t.min), disc: num(t.disc) })) : f.settings.tiers;
  const kinds = ['weight', 'volume', 'set'], cats = Object.keys(CATS);
  const materials = (Array.isArray(x.materials) ? x.materials : f.materials).filter(m => m && m.id && kinds.includes(m.kind)).map(m => ({
    id: String(m.id), name: String(m.name || 'خامة'), cat: cats.includes(m.cat) ? m.cat : 'raw', kind: m.kind,
    price: Math.max(0, num(m.price)), packQty: num(m.packQty) > 0 ? num(m.packQty) : 1,
    packUnit: UNITS[m.kind].opts.some(o => o[0] === m.packUnit) ? m.packUnit : UNITS[m.kind].opts[0][0],
    packName: String(m.packName || ''), demo: !!m.demo, finishKey: m.finishKey === 'gold' || m.finishKey === 'munaqqash' ? m.finishKey : undefined
  }));
  const recipes = (Array.isArray(x.recipes) ? x.recipes : f.recipes).filter(r => r && r.id).map(r => ({
    id: String(r.id), name: String(r.name || 'طقم'), code: String(r.code || ''), pieces: Math.max(0, Math.floor(num(r.pieces))),
    lines: (Array.isArray(r.lines) ? r.lines : []).filter(l => l && l.matId).map(l => ({ matId: String(l.matId), qty: Math.max(0, num(l.qty)), unit: String(l.unit || '') })),
    finish: FINISHES[r.finish] ? r.finish : 'plain', customExtra: Math.max(0, num(r.customExtra)),
    priceMode: r.priceMode === 'price' ? 'price' : 'target', targetType: r.targetType === 'markup' ? 'markup' : 'margin',
    targetPct: Math.max(0, num(r.targetPct)), price: Math.max(0, num(r.price)), demo: !!r.demo
  }));
  const clean = a => (Array.isArray(a) ? a : []).map(l => ({ recipeId: String(l.recipeId || ''), qty: Math.max(0, Math.floor(num(l.qty))), special: Math.max(0, num(l.special)) }));
  return { v: 1, settings: s, materials, recipes,
    nego: { lines: clean(x.nego && x.nego.lines), disc: Math.min(100, Math.max(0, num(x.nego && x.nego.disc))) },
    order: { lines: clean(x.order && x.order.lines), waste: !(x.order && x.order.waste === false) } };
}
function load() { try { state = normalizeState(JSON.parse(localStorage.getItem(LS))); } catch (e) { state = freshState(); } if (!localStorage.getItem(LS)) save(); }
function save() { try { localStorage.setItem(LS, JSON.stringify(state)); } catch (e) { toast('تعذر الحفظ في المتصفح'); } }

/* ================= أدوات واجهة ================= */
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => (Math.round((n + Number.EPSILON) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' ج';
const qtyFmt = n => (Math.round(n * 1000) / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 });
const pct = n => (Math.round(n * 10) / 10).toLocaleString('en-US') + '%';
const uid = p => p + '_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
let toastT; function toast(m) { const e = $('toast'); e.textContent = m; e.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => e.classList.remove('show'), 2400); }
function copyText(t) {
  const fallback = () => { const a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (e) {} a.remove(); toast(ok ? 'تم النسخ' : 'انسخ النص يدوياً'); };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(t).then(() => toast('تم النسخ'), fallback); else fallback();
}
function matOptions(sel, filter) { return state.materials.filter(filter || (() => true)).map(m => `<option value="${esc(m.id)}" ${m.id === sel ? 'selected' : ''}>${esc(m.name)}</option>`).join(''); }
function recipeOptions(sel) { return state.recipes.map(r => `<option value="${esc(r.id)}" ${r.id === sel ? 'selected' : ''}>${esc(r.name)}${r.code ? ' (' + esc(r.code) + ')' : ''}</option>`).join(''); }
function costOf(r) { return recipeCost(r, state.materials, state.settings); }
function demoNow() { return state.materials.some(m => m.demo) || state.recipes.some(r => r.demo); }
function updateBanner() { $('demoBanner').classList.toggle('hidden', !demoNow()); }

/* ================= ١. الخامات ================= */
function renderMaterials() {
  const s = state.settings;
  const rows = state.materials.map(m => {
    const kindSel = Object.keys(UNITS).map(k => `<option value="${k}" ${m.kind === k ? 'selected' : ''}>${k === 'weight' ? 'وزن' : k === 'volume' ? 'حجم' : 'للطقم'}</option>`).join('');
    const catSel = Object.keys(CATS).map(k => `<option value="${k}" ${m.cat === k ? 'selected' : ''}>${CATS[k]}</option>`).join('');
    const unitSel = UNITS[m.kind].opts.map(o => `<option value="${o[0]}" ${m.packUnit === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('');
    return `<tr data-mid="${esc(m.id)}">
      <td><input data-f="name" value="${esc(m.name)}" style="min-width:150px">${m.demo ? ' <span class="badge">تجريبي</span>' : ''}</td>
      <td><select data-f="cat">${catSel}</select></td>
      <td><select data-f="kind">${kindSel}</select></td>
      <td><input data-f="price" inputmode="decimal" value="${esc(m.price)}"></td>
      <td><div class="row" style="flex-wrap:nowrap"><input data-f="packQty" inputmode="decimal" value="${esc(m.packQty)}" style="min-width:60px"><select data-f="packUnit">${unitSel}</select></div></td>
      <td><input data-f="packName" value="${esc(m.packName)}" placeholder="شكارة/علبة" style="min-width:80px" ${m.kind === 'set' ? 'disabled' : ''}></td>
      <td class="num" data-up>${unitPriceText(m)}</td>
      <td><button class="btn sm danger" data-del>حذف</button></td></tr>`;
  }).join('');
  $('tab-materials').innerHTML = `
    <div class="card"><h2>أسعار الخامات الأساسية</h2>
      <p class="note">اكتب سعر العبوة وحجمها (مثلاً: جبس 150 جنيه لكل 50 كجم) والحاسبة بتطلّع سعر الكجم أو اللتر لوحدها. أي تعديل هنا بيحدّث تكلفة كل الأطقم فوراً. خامات "للطقم" (تغليف، مصنعية، تشطيب) سعرها لكل طقم.</p>
      <div class="tbl-wrap"><table><thead><tr><th>الخامة</th><th>الفئة</th><th>نوع القياس</th><th>سعر العبوة (ج)</th><th>حجم العبوة</th><th>اسم العبوة</th><th>سعر الوحدة</th><th></th></tr></thead><tbody id="matBody">${rows}</tbody></table></div>
      <div class="row" style="margin-top:10px"><button id="addMat" class="btn dark">+ إضافة خامة</button></div>
    </div>
    <div class="card"><h2>الهالك والكسر ومصاريف التشغيل</h2>
      <div class="grid g3"><div><label class="f">النسبة % (كهرباء، قوالب، إيجار، كسر)</label><input id="wasteIn" inputmode="decimal" value="${esc(s.waste)}"></div></div>
      <p class="note">بتتضاف كنسبة على التكلفة المباشرة للطقم (خامات + تشطيب + تغليف + مصنعية). القيمة الافتراضية 10% افتراض مبدئي، غيّرها بأرقام مصنعك.</p>
    </div>`;
}
function unitPriceText(m) { const b = UNITS[m.kind].base; return packBase(m) > 0 ? money(unitPrice(m)) + ' / ' + b : 'حجم العبوة لازم أكبر من صفر'; }
function onMaterialsInput(e) {
  if (e.target.id === 'wasteIn') { state.settings.waste = Math.max(0, num(e.target.value)); save(); return; }
  const tr = e.target.closest('tr[data-mid]'); if (!tr || !e.target.dataset.f) return;
  const m = state.materials.find(x => x.id === tr.dataset.mid); if (!m) return;
  const f = e.target.dataset.f, v = e.target.value;
  if (f === 'name' || f === 'packName') m[f] = v;
  else if (f === 'price') m.price = Math.max(0, num(v));
  else if (f === 'packQty') m.packQty = num(v) > 0 ? num(v) : 0;
  else if (f === 'cat') m.cat = v;
  else if (f === 'packUnit') m.packUnit = v;
  else if (f === 'kind') { m.kind = v; m.packUnit = UNITS[v].opts[0][0]; if (v === 'set') m.packQty = 1; }
  if (f !== 'name' && f !== 'packName') m.demo = false;
  save(); updateBanner();
  tr.querySelector('[data-up]').textContent = unitPriceText(m);
  if (e.type === 'change' && (f === 'kind' || f === 'cat')) renderMaterials();
}
function onMaterialsClick(e) {
  if (e.target.id === 'addMat') { state.materials.push({ id: uid('m'), name: 'خامة جديدة', cat: 'raw', kind: 'weight', price: 0, packQty: 1, packUnit: 'kg', packName: '', demo: false }); save(); renderMaterials(); return; }
  if (e.target.dataset.del !== undefined) {
    const tr = e.target.closest('tr'); const id = tr.dataset.mid;
    const used = state.recipes.filter(r => r.lines.some(l => l.matId === id)).map(r => r.name);
    const m = state.materials.find(x => x.id === id);
    if (used.length) { toast('الخامة مستخدمة في: ' + used.slice(0, 3).join('، ') + (used.length > 3 ? '…' : '') + '. شيلها من الأطقم الأول.'); return; }
    if (m && m.finishKey && state.recipes.some(r => r.finish === m.finishKey)) { toast('خامة تشطيب مستخدمة في طقم محفوظ'); return; }
    if (!confirm('حذف هذه الخامة؟')) return;
    state.materials = state.materials.filter(x => x.id !== id); save(); renderMaterials();
  }
}

/* ================= ٢. الطقم ================= */
function blankRecipe() { return { id: uid('r'), name: 'طقم جديد', code: '', pieces: 3, lines: [], finish: 'plain', customExtra: 0, priceMode: 'target', targetType: 'margin', targetPct: 30, price: 0, demo: false, _new: true }; }
function ensureDraft() { if (!ui.draft) { const r = state.recipes[0]; ui.draft = r ? JSON.parse(JSON.stringify(r)) : blankRecipe(); } }
function renderRecipe() {
  ensureDraft(); const d = ui.draft;
  const saved = state.recipes.some(r => r.id === d.id);
  const lineRows = d.lines.map((l, i) => {
    const m = state.materials.find(x => x.id === l.matId);
    const unitSel = m ? UNITS[m.kind].opts.map(o => `<option value="${o[0]}" ${l.unit === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('') : '';
    return `<tr data-i="${i}"><td><select data-lf="matId">${matOptions(l.matId, x => !x.finishKey)}${m ? '' : '<option selected>(خامة محذوفة)</option>'}</select></td>
      <td><input data-lf="qty" inputmode="decimal" value="${esc(l.qty)}" style="min-width:70px"></td>
      <td><select data-lf="unit">${unitSel}</select></td><td class="num" data-lc></td><td><button class="btn sm danger" data-ldel>حذف</button></td></tr>`;
  }).join('');
  $('tab-recipe').innerHTML = `
    <div class="card"><div class="row sp"><h2>الأطقم المحفوظة</h2><div class="row">
      <select id="recSel" style="min-width:200px"><option value="">— اختر طقم محفوظ —</option>${recipeOptions(saved ? d.id : '')}</select>
      <button id="recNew" class="btn">طقم جديد</button><button id="recDup" class="btn">نسخ</button><button id="recDel" class="btn danger" ${saved ? '' : 'disabled'}>حذف</button></div></div></div>
    <div class="card"><h2>بيانات الطقم ${saved ? '' : '<span class="badge">غير محفوظ</span>'}</h2>
      <div class="grid g3">
        <div><label class="f">اسم الطقم</label><input data-rf="name" value="${esc(d.name)}"></div>
        <div><label class="f">الكود</label><input data-rf="code" value="${esc(d.code)}"></div>
        <div><label class="f">عدد القطع</label><input data-rf="pieces" inputmode="numeric" value="${esc(d.pieces)}"></div>
        <div><label class="f">نوع التشطيب</label><select data-rf="finish">${Object.keys(FINISHES).map(k => `<option value="${k}" ${d.finish === k ? 'selected' : ''}>${FINISHES[k]}</option>`).join('')}</select></div>
        <div id="customBox" class="${d.finish === 'custom' ? '' : 'hidden'}"><label class="f">تكلفة إضافية للون الخاص (ج للطقم)</label><input data-rf="customExtra" inputmode="decimal" value="${esc(d.customExtra)}"></div>
      </div>
      ${d.finish === 'gold' || d.finish === 'munaqqash' ? `<p class="note">تكلفة التشطيب بتتاخد من خامة "${esc(FINISHES[d.finish])}" في قسم الخامات (تقديرية للطقم).</p>` : ''}
      <h3>استهلاك الطقم من الخامات والتغليف والمصنعية</h3>
      <div class="tbl-wrap"><table><thead><tr><th>الخامة</th><th>الكمية للطقم</th><th>الوحدة</th><th>التكلفة</th><th></th></tr></thead><tbody id="lineBody">${lineRows}</tbody></table></div>
      <div class="row" style="margin-top:8px"><select id="addLineSel" style="max-width:300px">${matOptions('', x => !x.finishKey)}</select><button id="addLine" class="btn dark">+ إضافة للاستهلاك</button></div>
    </div>
    <div class="card"><h2>التسعير</h2>
      <div class="grid g3">
        <div><label class="f">طريقة التسعير</label><select data-rf="priceMode"><option value="price" ${d.priceMode === 'price' ? 'selected' : ''}>أدخل سعر البيع</option><option value="target" ${d.priceMode === 'target' ? 'selected' : ''}>أدخل نسبة الربح المطلوبة</option></select></div>
        <div id="priceBox" class="${d.priceMode === 'price' ? '' : 'hidden'}"><label class="f">سعر بيع الجملة (ج)</label><input data-rf="price" inputmode="decimal" value="${esc(d.price)}"></div>
        <div id="targetBox" class="${d.priceMode === 'target' ? '' : 'hidden'}"><label class="f">النسبة المطلوبة %</label><input data-rf="targetPct" inputmode="decimal" value="${esc(d.targetPct)}"></div>
        <div id="targetTypeBox" class="${d.priceMode === 'target' ? '' : 'hidden'}"><label class="f">النسبة محسوبة على</label><select data-rf="targetType"><option value="margin" ${d.targetType === 'margin' ? 'selected' : ''}>سعر البيع (هامش ربح)</option><option value="markup" ${d.targetType === 'markup' ? 'selected' : ''}>التكلفة (نسبة إضافة)</option></select></div>
      </div>
      <p class="note">هامش الربح = الربح ÷ سعر البيع. نسبة الإضافة = الربح ÷ التكلفة. الاتنين مختلفين: إضافة 30% على التكلفة بتدّي هامش حوالي 23% بس. السعر المحسوب من النسبة بيتقرّب لأعلى لأقرب ${esc(state.settings.roundStep)} جنيه (من الإعدادات).</p>
    </div>
    <div id="recipeResult"></div>
    <div class="row"><button id="recSave" class="btn primary">حفظ الطقم في القائمة</button></div>`;
  renderRecipeResult();
}
function renderRecipeResult() {
  const d = ui.draft, s = state.settings, c = recipeCost(d, state.materials, s), p = pricingOf(d, c.total, s), st = statusOf(p, c.total, s);
  document.querySelectorAll('#lineBody tr').forEach((tr, i) => { const x = c.lines[i]; const cell = tr.querySelector('[data-lc]'); if (cell && x) cell.textContent = money(x.cost); });
  const seg = [['خامات', c.parts.raw, '#b98a2e'], ['تشطيب', c.parts.finish, '#8a5a9e'], ['تغليف', c.parts.pack, '#3a7ca5'], ['مصنعية', c.parts.labor, '#2e8b57'], ['هالك وتشغيل', c.waste, '#999']];
  const tot = c.total || 1;
  const fl = floorPrice(c.total, s);
  $('recipeResult').innerHTML = `<div class="card"><h2>النتيجة</h2>
    ${c.missing.length ? '<div class="warn">في خامة محذوفة داخل الطقم، التكلفة ناقصة. شيل السطر أو اختار خامة.</div>' : ''}
    ${c.finishMissing ? '<div class="warn">خامة التشطيب المختار مش موجودة في قسم الخامات، التشطيب محسوب بصفر.</div>' : ''}
    <div class="kpis"><div class="kpi big"><small>التكلفة الإجمالية للطقم</small><b>${money(c.total)}</b></div>
      <div class="kpi"><small>سعر البيع ${p.auto ? '(محسوب)' : ''}</small><b>${money(p.price)}</b></div>
      <div class="kpi"><small>صافي الربح للطقم</small><b>${money(p.profit)}</b></div>
      <div class="kpi"><small>هامش الربح (على السعر)</small><b>${p.price > 0 ? pct(p.margin) : '—'}</b></div>
      <div class="kpi"><small>نسبة الإضافة (على التكلفة)</small><b>${c.total > 0 ? pct(p.markup) : '—'}</b></div>
      <div class="kpi"><small>أقل سعر آمن (هامش ${pct(num(s.floor))})</small><b>${money(fl)}</b></div></div>
    <div class="st ${st.k}">${esc(st.t)}</div>
    <div class="bar">${seg.map(x => `<i style="width:${Math.max(0, x[1] / tot * 100)}%;background:${x[2]}" title="${x[0]}"></i>`).join('')}</div>
    <div class="legend">${seg.map(x => `<span style="--c:${x[2]}">${x[0]}: ${money(x[1])} (${c.total > 0 ? Math.round(x[1] / tot * 100) : 0}%)</span>`).join('')}</div>
    <p class="note">الحد الآمن (${pct(num(s.floor))}) افتراض إنت اللي حددته في الإعدادات، مش ضمان إن السعر ده يغطي كل مصاريفك. الشحن وعمولات المعارض والمرتجعات مش محسوبة.</p></div>`;
}
function onRecipeInput(e) {
  const t = e.target, d = ui.draft;
  if (t.dataset.rf) {
    const f = t.dataset.rf;
    if (f === 'name' || f === 'code') d[f] = t.value;
    else if (f === 'pieces') d.pieces = Math.max(0, Math.floor(num(t.value)));
    else if (f === 'finish' || f === 'priceMode' || f === 'targetType') d[f] = t.value;
    else d[f] = Math.max(0, num(t.value));
    if (e.type === 'change' && (f === 'finish' || f === 'priceMode')) { renderRecipe(); return; }
    renderRecipeResult();
  } else if (t.dataset.lf) {
    const i = +t.closest('tr').dataset.i, l = d.lines[i], f = t.dataset.lf;
    if (f === 'qty') l.qty = Math.max(0, num(t.value));
    else if (f === 'unit') l.unit = t.value;
    else if (f === 'matId') { l.matId = t.value; const m = state.materials.find(x => x.id === t.value); l.unit = m ? UNITS[m.kind].opts[0][0] : ''; renderRecipe(); return; }
    renderRecipeResult();
  }
}
function onRecipeClick(e) {
  const t = e.target, d = ui.draft;
  if (t.id === 'addLine') {
    const id = $('addLineSel').value, m = state.materials.find(x => x.id === id); if (!m) return;
    d.lines.push({ matId: id, qty: m.kind === 'set' ? 1 : 0, unit: UNITS[m.kind].opts[0][0] }); renderRecipe();
  } else if (t.dataset.ldel !== undefined) { d.lines.splice(+t.closest('tr').dataset.i, 1); renderRecipe(); }
  else if (t.id === 'recNew') { ui.draft = blankRecipe(); renderRecipe(); }
  else if (t.id === 'recDup') { const c = JSON.parse(JSON.stringify(d)); c.id = uid('r'); c.name = d.name + ' (نسخة)'; c.demo = false; ui.draft = c; renderRecipe(); toast('اتعمل نسخة غير محفوظة'); }
  else if (t.id === 'recDel') { if (!confirm('حذف الطقم من القائمة؟ هيتشال كمان من أوردرات التفاوض والمشتريات.')) return; const id = d.id; state.recipes = state.recipes.filter(r => r.id !== id); state.nego.lines = state.nego.lines.filter(l => l.recipeId !== id); state.order.lines = state.order.lines.filter(l => l.recipeId !== id); save(); ui.draft = null; updateBanner(); renderRecipe(); toast('اتحذف'); }
  else if (t.id === 'recSave') {
    if (!d.name.trim()) { toast('اكتب اسم الطقم'); return; }
    const copy = JSON.parse(JSON.stringify(d)); delete copy._new; copy.demo = false;
    const i = state.recipes.findIndex(r => r.id === copy.id);
    if (i >= 0) state.recipes[i] = copy; else state.recipes.push(copy);
    save(); ui.draft = JSON.parse(JSON.stringify(copy)); updateBanner(); renderRecipe(); toast('اتحفظ الطقم');
  }
}
function onRecipeChangeSel(e) { if (e.target.id === 'recSel' && e.target.value) { const r = state.recipes.find(x => x.id === e.target.value); if (r) { ui.draft = JSON.parse(JSON.stringify(r)); renderRecipe(); } } }

/* ================= ٣. التفاوض ================= */
function linesTable(kind, lines, withSpecial) {
  const rows = lines.map((l, i) => `<tr data-i="${i}"><td><select data-nf="recipeId">${recipeOptions(l.recipeId)}</select></td>
    <td><input data-nf="qty" inputmode="numeric" value="${esc(l.qty)}" style="min-width:70px"></td>
    ${withSpecial ? `<td><input data-nf="special" inputmode="decimal" value="${l.special ? esc(l.special) : ''}" placeholder="اختياري" style="min-width:90px"></td>` : ''}
    <td><button class="btn sm danger" data-ndel>حذف</button></td></tr>`).join('');
  return `<div class="tbl-wrap"><table><thead><tr><th>الطقم</th><th>الكمية</th>${withSpecial ? '<th>سعر خاص للطقم (ج)</th>' : ''}<th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function renderNego() {
  const n = state.nego;
  if (!state.recipes.length) { $('tab-nego').innerHTML = '<div class="card">أضف طقم واحد على الأقل من قسم تكلفة وتسعير الطقم.</div>'; return; }
  $('tab-nego').innerHTML = `
    <div class="card"><h2>محاكي التفاوض وخصم الكميات</h2>
      <p class="note">اختار الأطقم والكميات ونسبة الخصم اللي التاجر طالبها. لو كتبت سعر خاص لطقم معين بيتحسب بدل الخصم لنفس الصنف. التكلفة ما بتقلش بالخصم.</p>
      <div id="negoLines">${linesTable('n', n.lines, true)}</div>
      <div class="row" style="margin-top:8px"><button id="negAdd" class="btn dark">+ إضافة طقم</button></div>
      <div class="grid g3" style="margin-top:10px"><div><label class="f">نسبة الخصم المطلوبة %</label><input id="negDisc" inputmode="decimal" value="${esc(n.disc)}"></div>
        <div><label class="f">خصم مقترح حسب الكمية (من الإعدادات)</label><div class="row"><b id="negSug"></b><button id="negApply" class="btn sm">استخدمه</button></div></div></div>
    </div><div id="negoResult"></div>`;
  renderNegoResult();
}
function renderNegoResult() {
  const n = state.nego, s = state.settings, r = negoCalc(n.lines, state.recipes, state.materials, s, n.disc);
  const sug = suggestedDiscount(s.tiers, r.sets); $('negSug').textContent = sug ? pct(sug) + (s.tiersDemo ? ' (تجريبي)' : '') : 'مفيش شريحة';
  const orderOK = r.rev > 0 && r.margin >= num(s.floor) && r.rev >= r.cost;
  const stKey = !r.sets ? 'low' : r.rev < r.cost ? 'loss' : r.margin < num(s.floor) ? 'low' : r.margin < num(s.excellent) ? 'ok' : 'good';
  const stTxt = !r.sets ? 'أضف كميات' : r.rev < r.cost ? 'الأوردر بخسارة: إجمالي البيع أقل من التكلفة' : r.margin < num(s.floor) ? 'هامش الأوردر ككل أقل من الحد الآمن (' + pct(num(s.floor)) + ')' : r.margin < num(s.excellent) ? 'هامش مقبول' : 'هامش ممتاز حسب الحد اللي حددته';
  const rowsHtml = r.rows.map(x => `<tr><td>${esc(x.r.name)}</td><td class="num">${x.qty}</td><td class="num">${money(x.c)}</td><td class="num">${money(x.lp)}</td><td class="num">${money(x.net)}${x.special ? ' (خاص)' : ''}</td><td class="num">${money(x.profitPer)}</td><td class="num">${money(x.fl)}</td><td>${x.loss ? '<span class="err">خسارة</span>' : x.below ? '<span class="err">تحت الحد الآمن</span>' : 'تمام'}</td></tr>`).join('');
  const maxTxt = r.list > 0 ? pct(r.maxDisc) : '—';
  const cu = customFinishExtraSets(n.lines, state.recipes);
  $('negoResult').innerHTML = `<div class="card"><h2>النتيجة</h2>
    <div class="kpis"><div class="kpi"><small>إجمالي تكلفة الأوردر عليك</small><b>${money(r.cost)}</b></div>
      <div class="kpi"><small>إجمالي البيع بعد الخصم</small><b>${money(r.rev)}</b></div>
      <div class="kpi big"><small>صافي مكسبك من الأوردر</small><b>${money(r.profit)}</b></div>
      <div class="kpi"><small>مكسبك في الطقم (متوسط)</small><b>${money(r.perSet)}</b></div>
      <div class="kpi"><small>هامش الأوردر ككل</small><b>${r.rev > 0 ? pct(r.margin) : '—'}</b></div>
      <div class="kpi"><small>أقصى خصم موحّد للأوردر يحافظ على الحد الآمن</small><b>${maxTxt}</b></div></div>
    <div class="st ${stKey}">${esc(stTxt)}</div>
    ${r.rows.some(x => x.below || x.loss) ? '<div class="warn">في صنف أو أكتر تحت الحد الآمن لوحده (حتى لو هامش الأوردر ككل أعلى منه). شوف عمود الحالة.</div>' : ''}
    ${cu ? `<div class="warn">في ${cu} طقم لون خاص: تكلفتها بتعتمد على التكلفة الإضافية اللي كتبتها في الطقم نفسه.</div>` : ''}
    <div class="tbl-wrap"><table><thead><tr><th>الطقم</th><th>الكمية</th><th>التكلفة</th><th>سعر القائمة</th><th>سعر البيع بعد الخصم</th><th>ربح الطقم</th><th>أقل سعر آمن</th><th>الحالة</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
    <p class="note">"أقل سعر آمن" = التكلفة ÷ (1 − الهامش الآمن) مقرّب لأعلى لأقرب جنيه. الأرقام مبنية على الخامات والاستهلاك اللي إنت مدخلهم، مش ضمان ربح.</p>
    <div class="row"><button id="negCopy" class="btn">نسخ ملخص التفاوض</button></div></div>`;
}
function negoSummary() {
  const n = state.nego, r = negoCalc(n.lines, state.recipes, state.materials, state.settings, n.disc);
  return 'ملخص أوردر (داخلي)\n' + r.rows.map(x => `• ${x.r.name} × ${x.qty} | بيع ${money(x.net)} | تكلفة ${money(x.c)}`).join('\n') + `\nإجمالي البيع: ${money(r.rev)}\nإجمالي التكلفة: ${money(r.cost)}\nصافي المكسب: ${money(r.profit)} (${r.rev > 0 ? pct(r.margin) : '—'})`;
}
function onListInput(which, e) {
  const t = e.target; if (!t.dataset.nf) return;
  const lines = which === 'nego' ? state.nego.lines : state.order.lines, l = lines[+t.closest('tr').dataset.i], f = t.dataset.nf;
  if (f === 'recipeId') l.recipeId = t.value; else if (f === 'qty') l.qty = Math.max(0, Math.floor(num(t.value))); else l.special = Math.max(0, num(t.value));
  save(); if (which === 'nego') renderNegoResult(); else renderOrderResult();
}
function onNegoInput(e) { if (e.target.id === 'negDisc') { state.nego.disc = Math.min(100, Math.max(0, num(e.target.value))); save(); renderNegoResult(); return; } onListInput('nego', e); }
function onNegoClick(e) {
  const t = e.target;
  if (t.id === 'negAdd') { state.nego.lines.push({ recipeId: state.recipes[0].id, qty: 50, special: 0 }); save(); renderNego(); }
  else if (t.dataset.ndel !== undefined) { state.nego.lines.splice(+t.closest('tr').dataset.i, 1); save(); renderNego(); }
  else if (t.id === 'negApply') { const sets = negoCalc(state.nego.lines, state.recipes, state.materials, state.settings, 0).sets; state.nego.disc = suggestedDiscount(state.settings.tiers, sets); save(); renderNego(); }
  else if (t.id === 'negCopy') copyText(negoSummary());
}

/* ================= ٤. المشتريات ================= */
function renderOrder() {
  const o = state.order;
  if (!state.recipes.length) { $('tab-order').innerHTML = '<div class="card">أضف طقم واحد على الأقل أولاً.</div>'; return; }
  $('tab-order').innerHTML = `<div class="card"><h2>حاسبة خامات الأوردر الكامل</h2>
    <div id="ordLines">${linesTable('o', o.lines, false)}</div>
    <div class="row" style="margin-top:8px"><button id="ordAdd" class="btn dark">+ إضافة طقم</button><button id="ordFromNego" class="btn">استيراد الأصناف من محاكي التفاوض</button></div>
    <label class="row" style="margin-top:10px"><input id="ordWaste" type="checkbox" style="width:auto;min-height:0" ${o.waste ? 'checked' : ''}> إضافة نسبة الهالك (${pct(num(state.settings.waste))}) على كميات الخامات عند الشراء</label>
  </div><div id="orderResult"></div>`;
  renderOrderResult();
}
function renderOrderResult() {
  const o = state.order, s = state.settings, items = procure(o.lines, state.recipes, state.materials, s, o.waste);
  const sets = o.lines.reduce((a, l) => a + Math.max(0, num(l.qty)), 0);
  const phys = items.filter(x => x.hasPacks), perSet = items.filter(x => !x.hasPacks);
  const rowP = x => `<tr><td>${esc(x.m.name)}</td><td class="num">${qtyFmt(x.net)} ${UNITS[x.m.kind].base}</td><td class="num">${qtyFmt(x.gross)} ${UNITS[x.m.kind].base}</td><td class="num"><b>${x.packs}</b> ${esc(x.m.packName || 'عبوة')} (${qtyFmt(x.m.packQty)} ${UNIT_LABEL[x.m.packUnit]})</td><td class="num">${qtyFmt(x.leftover)} ${UNITS[x.m.kind].base}</td><td class="num">${money(x.buyCost)}</td></tr>`;
  const rowS = x => `<tr><td>${esc(x.m.name)}</td><td class="num">${qtyFmt(x.gross)} طقم</td><td class="num">${money(x.buyCost)}</td></tr>`;
  const sum = k => perSet.filter(x => x.m.cat === k).reduce((a, x) => a + x.buyCost, 0);
  const physBuy = phys.reduce((a, x) => a + x.buyCost, 0), physUse = phys.reduce((a, x) => a + x.useCost, 0);
  $('orderResult').innerHTML = `<div class="card"><h2>قائمة المشتريات (${sets} طقم)</h2>
    ${phys.length ? `<h3>خامات بتتشرى بالعبوة</h3><div class="tbl-wrap"><table><thead><tr><th>الخامة</th><th>الصافي المطلوب</th><th>${o.waste ? 'مع الهالك' : 'المطلوب'}</th><th>عدد العبوات (مقرّب لأعلى)</th><th>الفاضل بعد الشراء</th><th>تكلفة الشراء</th></tr></thead><tbody>${phys.map(rowP).join('')}</tbody></table></div>
      <p class="note">تكلفة الشراء بالعبوات الكاملة: ${money(physBuy)}. تكلفة الكمية المستهلكة فعلياً: ${money(physUse)}. الفرق هو الفاضل في المخزن.</p>` : ''}
    ${perSet.length ? `<h3>تغليف ومصنعية وتشطيب (بالطقم)</h3><div class="tbl-wrap"><table><thead><tr><th>البند</th><th>العدد</th><th>التكلفة</th></tr></thead><tbody>${perSet.map(rowS).join('')}</tbody></table></div>
      <div class="kpis"><div class="kpi"><small>إجمالي التغليف</small><b>${money(sum('pack'))}</b></div><div class="kpi"><small>إجمالي المصنعية</small><b>${money(sum('labor'))}</b></div><div class="kpi"><small>إجمالي التشطيب</small><b>${money(sum('finish'))}</b></div></div>` : ''}
    ${!items.length ? '<p class="note">أضف أصناف وكميات علشان تظهر القائمة.</p>' : ''}
    <div class="row"><button id="ordCopy" class="btn primary" ${items.length ? '' : 'disabled'}>نسخ قائمة المشتريات للواتساب</button></div></div>`;
}
function purchaseText() {
  const o = state.order, items = procure(o.lines, state.recipes, state.materials, state.settings, o.waste);
  const head = o.lines.filter(l => num(l.qty) > 0).map(l => { const r = state.recipes.find(x => x.id === l.recipeId); return r ? `• ${r.name} × ${Math.floor(num(l.qty))}` : ''; }).filter(Boolean).join('\n');
  const phys = items.filter(x => x.hasPacks).map(x => `- ${x.m.name}: ${qtyFmt(x.gross)} ${UNITS[x.m.kind].base} = ${x.packs} ${x.m.packName || 'عبوة'} (${qtyFmt(x.m.packQty)} ${UNIT_LABEL[x.m.packUnit]})`).join('\n');
  const ps = items.filter(x => !x.hasPacks).map(x => `- ${x.m.name}: ${qtyFmt(x.gross)} طقم`).join('\n');
  return `قائمة مشتريات الورشة – elhassan home\nالأوردر:\n${head}\n\nالخامات:\n${phys || '-'}${ps ? '\n\nتغليف/مصنعية/تشطيب:\n' + ps : ''}${o.waste ? '\n\n(كميات الخامات شاملة هالك ' + pct(num(state.settings.waste)) + ')' : ''}`;
}
function onOrderInput(e) { if (e.target.id === 'ordWaste') { state.order.waste = e.target.checked; save(); renderOrderResult(); return; } onListInput('order', e); }
function onOrderClick(e) {
  const t = e.target;
  if (t.id === 'ordAdd') { state.order.lines.push({ recipeId: state.recipes[0].id, qty: 50, special: 0 }); save(); renderOrder(); }
  else if (t.dataset.ndel !== undefined) { state.order.lines.splice(+t.closest('tr').dataset.i, 1); save(); renderOrder(); }
  else if (t.id === 'ordFromNego') { state.order.lines = state.nego.lines.map(l => ({ recipeId: l.recipeId, qty: l.qty, special: 0 })); save(); renderOrder(); }
  else if (t.id === 'ordCopy') copyText(purchaseText());
}

/* ================= الإعدادات والنسخ الاحتياطي ================= */
function renderSettings() {
  const s = state.settings;
  $('settingsBody').innerHTML = `
    <div class="row sp"><h2 style="margin:0">الإعدادات</h2><button id="setClose" class="btn sm">إغلاق</button></div>
    <h3>حدود الهامش (افتراضات منك، مش ضمان)</h3>
    <div class="grid g3">
      <div><label class="f">الحد الأدنى الآمن للهامش %</label><input data-sf="floor" inputmode="decimal" value="${esc(s.floor)}"></div>
      <div><label class="f">هامش "ممتاز" يبدأ من %</label><input data-sf="excellent" inputmode="decimal" value="${esc(s.excellent)}"></div>
      <div><label class="f">تقريب السعر المحسوب لأعلى لأقرب (ج)</label><input data-sf="roundStep" inputmode="decimal" value="${esc(s.roundStep)}"></div>
    </div>
    <p class="note">الحد الآمن هو أقل هامش (على سعر البيع) إنت مستعد تقبله. الأرقام الافتراضية 15% و30% أمثلة، حدّدهم حسب مصاريفك الفعلية. أي سعر تحته بيظهر أحمر.</p>
    <h3>شرائح خصم الكميات ${s.tiersDemo ? '<span class="badge">تجريبي</span>' : ''}</h3>
    <div id="tierBox">${s.tiers.map((t, i) => `<div class="row" data-ti="${i}" style="margin-bottom:6px"><span>من</span><input data-tf="min" inputmode="numeric" value="${esc(t.min)}" style="max-width:100px"><span>طقم → خصم</span><input data-tf="disc" inputmode="decimal" value="${esc(t.disc)}" style="max-width:90px"><span>%</span><button class="btn sm danger" data-tdel>حذف</button></div>`).join('')}</div>
    <button id="tierAdd" class="btn sm">+ شريحة</button>
    <h3>الرقم السري</h3>
    <div class="grid g3"><div><label class="f">الرقم الحالي</label><input id="pinOld" type="password" inputmode="numeric" autocomplete="off"></div>
      <div><label class="f">الرقم الجديد (4 أرقام على الأقل)</label><input id="pinNew" type="password" inputmode="numeric" autocomplete="off"></div>
      <div><label class="f">تأكيد الرقم الجديد</label><input id="pinNew2" type="password" inputmode="numeric" autocomplete="off"></div></div>
    <div class="row" style="margin-top:6px"><button id="pinChange" class="btn dark">تغيير الرقم</button><span id="pinChangeMsg" class="err"></span></div>
    <p class="note">القفل بيمنع الفتح العادي بس. الأرقام نفسها محفوظة في المتصفح بدون تشفير، فما تستخدمش جهاز مش بتاعك.</p>
    <h3>نسخة احتياطية</h3>
    <div class="row"><button id="bkExport" class="btn dark">تصدير JSON</button><label class="btn" style="margin:0">استيراد JSON<input id="bkImport" type="file" accept="application/json,.json" class="hidden"></label></div>
    <p class="note">الملف بيحتوي على تكاليفك وأسعارك. احتفظ بيه في مكان خاص ومتبعتوش لحد. الرقم السري مش بيتصدّر.</p>
    <h3>إعادة ضبط</h3>
    <div class="row"><button id="resetDemo" class="btn danger">رجّع البيانات التجريبية (يمسح بياناتك)</button></div>`;
}
function exportBackup() {
  const data = { app: 'elhassan-pricing', version: 1, exportedAt: new Date().toISOString(), data: { settings: state.settings, materials: state.materials, recipes: state.recipes, nego: state.nego, order: state.order } };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'elhassan-pricing-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); toast('تم التصدير');
}
function importBackup(file) {
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const j = JSON.parse(rd.result), d = j && j.app === 'elhassan-pricing' ? j.data : null;
      if (!d || !Array.isArray(d.materials) || !Array.isArray(d.recipes)) throw new Error('bad');
      const nx = normalizeState(d);
      if (!nx.materials.length) throw new Error('empty');
      if (!confirm('الاستيراد هيستبدل الخامات والأطقم الحالية بالنسخة (' + nx.materials.length + ' خامة، ' + nx.recipes.length + ' طقم). تكمل؟')) return;
      state = nx; save(); ui.draft = null; updateBanner(); renderAll(); renderSettings(); toast('تم الاستيراد');
    } catch (e) { toast('الملف مش نسخة صالحة من الحاسبة'); }
  };
  rd.readAsText(file);
}
function onSettingsInput(e) {
  const t = e.target;
  if (t.dataset.sf) { const f = t.dataset.sf; state.settings[f] = Math.max(0, num(t.value)); if (f === 'floor' && state.settings.floor > 95) state.settings.floor = 95; save(); }
  else if (t.dataset.tf) { const i = +t.closest('[data-ti]').dataset.ti; state.settings.tiers[i][t.dataset.tf] = Math.max(0, num(t.value)); state.settings.tiersDemo = false; save(); }
}
async function onSettingsClick(e) {
  const t = e.target;
  if (t.id === 'setClose') { $('settingsModal').classList.add('hidden'); renderAll(); }
  else if (t.id === 'tierAdd') { state.settings.tiers.push({ min: 0, disc: 0 }); state.settings.tiersDemo = false; save(); renderSettings(); }
  else if (t.dataset.tdel !== undefined) { state.settings.tiers.splice(+t.closest('[data-ti]').dataset.ti, 1); save(); renderSettings(); }
  else if (t.id === 'bkExport') exportBackup();
  else if (t.id === 'resetDemo') { if (confirm('هيتمسح كل اللي أدخلته ويرجع للأمثلة التجريبية. متأكد؟')) { state = freshState(); save(); ui.draft = null; updateBanner(); renderAll(); renderSettings(); toast('رجعت البيانات التجريبية'); } }
  else if (t.id === 'pinChange') {
    const msg = $('pinChangeMsg'); msg.textContent = '';
    const o = $('pinOld').value, n = $('pinNew').value, n2 = $('pinNew2').value;
    if (!(await checkPin(o))) { msg.textContent = 'الرقم الحالي غلط'; return; }
    if (n.length < 4) { msg.textContent = 'الرقم الجديد أقل من 4 أرقام'; return; }
    if (n !== n2) { msg.textContent = 'التأكيد مش مطابق'; return; }
    await setPin(n); $('pinOld').value = $('pinNew').value = $('pinNew2').value = ''; toast('تم تغيير الرقم السري');
  }
}

/* ================= الرقم السري ================= */
async function sha(s) {
  if (window.crypto && crypto.subtle) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join(''); }
  return 'plain:' + s;
}
async function setPin(pin) { const salt = Math.random().toString(36).slice(2); localStorage.setItem(LS_PIN, JSON.stringify({ salt, hash: await sha(salt + pin) })); }
async function checkPin(pin) {
  let rec = null; try { rec = JSON.parse(localStorage.getItem(LS_PIN)); } catch (e) {}
  if (!rec || !rec.hash) return pin === '1234';
  return (await sha(rec.salt + pin)) === rec.hash;
}
let fails = 0, lockUntil = 0;
async function tryUnlock() {
  const msg = $('pinMsg'), now = Date.now();
  if (now < lockUntil) { msg.textContent = 'استنى ' + Math.ceil((lockUntil - now) / 1000) + ' ثانية'; return; }
  if (await checkPin($('pinInput').value)) { fails = 0; msg.textContent = ''; $('pinInput').value = ''; $('lock').classList.add('hidden'); $('app').classList.remove('hidden'); renderAll(); }
  else { fails++; msg.textContent = 'الرقم غلط'; if (fails >= 5) { lockUntil = Date.now() + 30000; fails = 0; msg.textContent = 'محاولات كتير، استنى 30 ثانية'; } }
}
function lockNow() { $('app').classList.add('hidden'); $('settingsModal').classList.add('hidden'); $('lock').classList.remove('hidden'); $('pinInput').focus(); }

/* ================= تشغيل ================= */
function renderAll() {
  updateBanner();
  renderMaterials(); renderRecipe(); renderNego(); renderOrder();
  ['materials', 'recipe', 'nego', 'order'].forEach(k => $('tab-' + k).classList.toggle('hidden', ui.tab !== k));
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === ui.tab));
}
function init() {
  load();
  $('pinBtn').addEventListener('click', tryUnlock);
  $('pinInput').addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); });
  $('lockBtn').addEventListener('click', lockNow);
  $('settingsBtn').addEventListener('click', () => { renderSettings(); $('settingsModal').classList.remove('hidden'); });
  $('tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (!b) return; ui.tab = b.dataset.tab; renderAll(); window.scrollTo(0, 0); });
  const m = $('tab-materials'); ['input', 'change'].forEach(ev => m.addEventListener(ev, onMaterialsInput)); m.addEventListener('click', onMaterialsClick);
  const r = $('tab-recipe'); ['input', 'change'].forEach(ev => r.addEventListener(ev, onRecipeInput)); r.addEventListener('change', onRecipeChangeSel); r.addEventListener('click', onRecipeClick);
  const n = $('tab-nego'); ['input', 'change'].forEach(ev => n.addEventListener(ev, onNegoInput)); n.addEventListener('click', onNegoClick);
  const o = $('tab-order'); ['input', 'change'].forEach(ev => o.addEventListener(ev, onOrderInput)); o.addEventListener('click', onOrderClick);
  const sb = $('settingsBody'); sb.addEventListener('input', onSettingsInput); sb.addEventListener('click', onSettingsClick);
  sb.addEventListener('change', e => { if (e.target.id === 'bkImport' && e.target.files[0]) { importBackup(e.target.files[0]); e.target.value = ''; } });
  $('settingsModal').addEventListener('click', e => { if (e.target.id === 'settingsModal') { $('settingsModal').classList.add('hidden'); renderAll(); } });
  $('pinInput').focus();
}
if (typeof document !== 'undefined' && document.getElementById('lock')) init();
if (typeof module !== 'undefined') module.exports = { num, toBase, unitPrice, recipeCost, pricingOf, statusOf, floorPrice, negoCalc, procure, demoData, defaultSettings, normalizeState, suggestedDiscount, ceilTo };
