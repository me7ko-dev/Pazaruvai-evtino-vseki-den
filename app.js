'use strict';

// ---------- Състояние ----------

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('pazar.' + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('pazar.' + k, JSON.stringify(v));
    } catch {}
  },
};

let meta = null; // категории, вериги, градове
const cityCache = new Map(); // файл → магазини
let basket = store.get('basket', []); // [{id, qty}]
let me = null; // {lat, lon, label}
let sortBy = 'price';
let lastResults = null;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const eur = (n) => n.toFixed(2).replace('.', ',') + ' €';
const norm = (s) => s.toLowerCase().replace(/ё/g, 'е').trim();

const QUICK = ['хляб', 'мляко', 'олио', 'яйца', 'сирене', 'кашкавал', 'масло', 'захар', 'брашно', 'ориз', 'кафе', 'пилешко', 'картофи', 'домати', 'банани', 'ябълки'];

// ---------- Данни ----------

async function loadMeta() {
  const res = await fetch('data/meta.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('Няма данни');
  meta = await res.json();
  meta.byId = new Map(meta.categories.map((c) => [c.id, c]));
  for (const c of meta.categories) c.search = norm([c.name, ...c.kw].join(' '));
}

async function loadCity(file) {
  if (!cityCache.has(file)) {
    cityCache.set(
      file,
      fetch(`data/c/${file}.json`).then((r) => (r.ok ? r.json() : { stores: [] })).then((d) => d.stores),
    );
  }
  return cityCache.get(file);
}

function km(a, b) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const catName = (id) => meta.byId.get(id)?.name || `Продукт ${id}`;

// ---------- Списък ----------

function saveBasket() {
  store.set('basket', basket);
  renderBasket();
}

function addToBasket(id) {
  const item = basket.find((b) => b.id === id);
  if (item) item.qty++;
  else basket.push({ id, qty: 1 });
  saveBasket();
}

function renderBasket() {
  basket = basket.filter((b) => meta.byId.has(b.id));
  $('basket').innerHTML = basket
    .map(
      (b) => `<li data-id="${esc(b.id)}">
        <span class="name">${esc(catName(b.id))}</span>
        <span class="qty">
          <button type="button" data-act="minus" aria-label="По-малко">−</button>
          <span>${b.qty}</span>
          <button type="button" data-act="plus" aria-label="Повече">+</button>
        </span>
        <button type="button" class="x" data-act="del" aria-label="Махни">×</button>
      </li>`,
    )
    .join('');
  $('emptyBasket').hidden = basket.length > 0;
  updateGo();
}

$('basket').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = btn.closest('li').dataset.id;
  const item = basket.find((b) => b.id === id);
  if (!item) return;
  if (btn.dataset.act === 'plus') item.qty++;
  if (btn.dataset.act === 'minus') item.qty--;
  if (btn.dataset.act === 'del' || item.qty < 1) basket = basket.filter((b) => b !== item);
  saveBasket();
});

// ---------- Търсене ----------

let sel = -1;
let matches = [];

function search(q) {
  q = norm(q);
  if (!q) return [];
  const words = q.split(/\s+/);
  return meta.categories
    .map((c) => {
      if (!words.every((w) => c.search.includes(w))) return null;
      // по-напред: съвпадение в началото на името
      const score = (norm(c.name).startsWith(words[0]) ? 0 : 1) + (norm(c.name).includes(q) ? 0 : 1);
      return { c, score };
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score || (b.c.n ?? 0) - (a.c.n ?? 0) || a.c.name.localeCompare(b.c.name, 'bg'))
    .slice(0, 10)
    .map((m) => m.c);
}

function renderSuggest() {
  const ul = $('suggest');
  const q = $('q').value;
  matches = search(q);
  if (!q.trim()) {
    ul.hidden = true;
    return;
  }
  ul.innerHTML = matches.length
    ? matches
        .map(
          (c, i) => `<li role="option" data-id="${esc(c.id)}" aria-selected="${i === sel}">
            ${esc(c.name || catName(c.id))}<span class="ex">${esc(c.kw.slice(0, 5).join(', '))}</span></li>`,
        )
        .join('')
    : `<li class="muted" aria-disabled="true">Няма такъв продукт в данните на КЗП</li>`;
  ul.hidden = false;
}

function pick(id) {
  addToBasket(id);
  $('q').value = '';
  sel = -1;
  renderSuggest();
  $('q').focus();
}

$('q').addEventListener('input', () => {
  sel = -1;
  renderSuggest();
});
$('q').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    sel = Math.max(-1, Math.min(matches.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)));
    renderSuggest();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const m = matches[sel >= 0 ? sel : 0];
    if (m) pick(m.id);
  } else if (e.key === 'Escape') {
    $('suggest').hidden = true;
  }
});
$('suggest').addEventListener('mousedown', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) {
    e.preventDefault();
    pick(li.dataset.id);
  }
});
$('q').addEventListener('blur', () =>
  setTimeout(() => {
    if (document.activeElement !== $('q')) $('suggest').hidden = true;
  }, 150),
);

function renderChips() {
  const chips = QUICK.filter((w) => search(w).length);
  $('chips').innerHTML = chips.map((w) => `<button type="button" class="chip">${esc(w)}</button>`).join('');
}
$('chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const found = search(chip.textContent);
  if (found.length === 1) return pick(found[0].id);
  $('q').value = chip.textContent;
  $('q').focus();
  renderSuggest();
});

// ---------- Местоположение ----------

function setMe(m) {
  me = m;
  store.set('me', m);
  $('locStatus').textContent = m ? `Търся около: ${m.label}` : '';
  updateGo();
}

$('locBtn').addEventListener('click', () => {
  if (!navigator.geolocation) {
    $('locStatus').textContent = 'Браузърът не дава местоположение. Избери град.';
    return;
  }
  $('locStatus').textContent = 'Търся къде си…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const p = [pos.coords.latitude, pos.coords.longitude];
      const near = meta.cities.filter((c) => c.ll).sort((a, b) => km(p, a.ll) - km(p, b.ll))[0];
      $('city').value = '';
      setMe({ lat: p[0], lon: p[1], label: near ? `моето местоположение (до ${near.name})` : 'моето местоположение' });
    },
    (err) => {
      $('locStatus').textContent =
        err.code === 1 ? 'Не разреши местоположение. Избери град от списъка.' : 'Не успях да намеря къде си. Избери град.';
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
  );
});

$('city').addEventListener('change', () => {
  const c = meta.cities.find((x) => x.file === $('city').value);
  setMe(c ? { lat: c.ll?.[0], lon: c.ll?.[1], city: c.file, label: c.name } : null);
});

$('radius').addEventListener('change', () => {
  store.set('radius', $('radius').value);
  if (lastResults) run();
});

function renderCities() {
  const opts = meta.cities
    .filter((c) => c.n > 0)
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'bg'))
    .map((c) => `<option value="${esc(c.file)}">${esc(c.name)} (${c.n})</option>`);
  $('city').insertAdjacentHTML('beforeend', opts.join(''));
}

function updateGo() {
  $('go').disabled = !meta || !basket.length || !me;
  $('go').textContent = !basket.length ? 'Добави продукти в списъка' : !me ? 'Избери къде пазаруваш' : 'Къде е най-евтино?';
}

// ---------- Сметката ----------

async function run() {
  const radius = Number($('radius').value);
  const here = Number.isFinite(me.lat) ? [me.lat, me.lon] : null;

  // кои градове да заредим: избрания + всички в радиуса
  const files = new Set();
  if (me.city) files.add(me.city);
  if (here) {
    for (const c of meta.cities) if (c.ll && km(here, c.ll) <= radius + 15) files.add(c.file);
    if (!files.size) {
      const near = meta.cities.filter((c) => c.ll).sort((a, b) => km(here, a.ll) - km(here, b.ll))[0];
      if (near) files.add(near.file);
    }
  }
  $('go').disabled = true;
  $('go').textContent = 'Смятам…';
  const stores = (await Promise.all([...files].map(loadCity))).flat();
  updateGo();

  const rows = [];
  for (const s of stores) {
    const dist = here && s.ll ? km(here, s.ll) : null;
    if (dist != null && dist > radius) continue;
    let total = 0;
    const lines = [];
    const missing = [];
    for (const b of basket) {
      const it = s.it[b.id];
      if (it) {
        total += it[0] * b.qty;
        lines.push({ id: b.id, qty: b.qty, price: it[0], product: it[1], promo: it[2] === 1 });
      } else missing.push(b.id);
    }
    if (!lines.length) continue;
    rows.push({ s, dist, total, lines, missing });
  }
  lastResults = rows;
  render();
  $('results').hidden = false;
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function render() {
  const rows = [...lastResults];
  // Разстоянието е сигурно само при намерен адрес; иначе е до центъра на града.
  const near = (r) => (r.dist != null && !r.s.approx ? r.dist : 1e9);
  const byPrice = (a, b) => a.missing.length - b.missing.length || a.total - b.total || near(a) - near(b);
  const byDist = (a, b) => near(a) - near(b) || byPrice(a, b);

  // Веригите често имат еднаква цена навсякъде: магазините от една верига с една и съща
  // сметка стават един ред – най-близкият от тях, плюс „още N магазина“.
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.s.ch}|${r.total.toFixed(2)}|${r.missing.join(',')}`;
    const g = groups.get(key);
    if (!g) groups.set(key, { ...r, more: 0 });
    else {
      g.more++;
      if (near(r) < near(g)) Object.assign(g, { s: r.s, dist: r.dist, lines: r.lines });
    }
  }
  const top = [...groups.values()].sort(sortBy === 'price' ? byPrice : byDist).slice(0, 10);
  const full = rows.filter((r) => !r.missing.length);
  const cheapest = full.length ? Math.min(...full.map((r) => r.total)) : null;

  $('resultsNote').textContent = rows.length
    ? `${rows.length} магазина до ${$('radius').value} км, ${full.length} от тях имат всичко. Цени от ${fmtDate(meta.date)}.`
    : `Няма магазини с данни до ${$('radius').value} км. Увеличи разстоянието или избери друг град.`;

  $('resultList').innerHTML = top
    .map((r, i) => {
      const s = r.s;
      const diff = cheapest != null && !r.missing.length && r.total > cheapest + 0.005 ? `+${eur(r.total - cheapest)}` : '';
      const dist =
        r.dist == null
          ? ''
          : s.approx
            ? `<span class="tag" title="Адресът не е намерен на картата">адресът не е на картата</span>`
            : `<span class="tag">${r.dist < 1 ? Math.round(r.dist * 1000) + ' м' : r.dist.toFixed(1).replace('.', ',') + ' км'}</span>`;
      const more = r.more ? `<span class="tag">+ още ${r.more} ${r.more === 1 ? 'магазин' : 'магазина'} ${esc(s.ch)} със същата сума</span>` : '';
      const status = r.missing.length
        ? `<span class="tag warn">липсва: ${esc(r.missing.map(catName).join(', '))}</span>`
        : `<span class="tag ok">има всичко</span>`;
      const promos = r.lines.filter((l) => l.promo).length;
      const lines = r.lines
        .map(
          (l) => `<li><span>${l.qty > 1 ? l.qty + ' × ' : ''}${esc(l.product || catName(l.id))}</span>
            <span class="p ${l.promo ? 'promo' : ''}">${eur(l.price * l.qty)}</span></li>`,
        )
        .concat(r.missing.map((id) => `<li class="miss"><span>${esc(catName(id))}</span><span>няма данни</span></li>`))
        .join('');
      const dest = s.ll ? `${s.ll[0]},${s.ll[1]}` : encodeURIComponent(`${s.ch} ${s.addr}`);
      return `<li class="res ${i === 0 && sortBy === 'price' && !r.missing.length ? 'best' : ''}">
        <div class="res-top">
          <span class="rank">${i + 1}</span>
          <div class="res-main">
            <div class="chain">${esc(s.ch)}</div>
            <div class="addr">${esc(s.addr)}</div>
          </div>
          <div class="sum"><b>${eur(r.total)}</b><span class="diff">${diff}</span></div>
        </div>
        <div class="tags">${dist}${status}${more}${promos ? `<span class="tag">${promos} в промоция</span>` : ''}</div>
        <details><summary>Какво влиза в сумата</summary><p class="muted small">Най-евтиният продукт от всяка група в този магазин.</p><ul class="lines">${lines}</ul></details>
        <a class="route" href="https://www.google.com/maps/dir/?api=1&destination=${dest}" target="_blank" rel="noopener">Маршрут до магазина →</a>
      </li>`;
    })
    .join('');
}

function fmtDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

$('go').addEventListener('click', run);
document.querySelector('.seg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-sort]');
  if (!b) return;
  sortBy = b.dataset.sort;
  document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
  if (lastResults) render();
});

// ---------- Старт ----------

(async () => {
  $('radius').value = store.get('radius', '5');
  try {
    await loadMeta();
  } catch {
    $('dataDate').textContent = 'Цените не се заредиха. Провери интернета.';
    return;
  }
  $('dataDate').textContent = `Цени от ${fmtDate(meta.date)} · ${meta.chains.length} вериги`;
  renderCities();
  renderChips();
  renderBasket();
  const saved = store.get('me', null);
  if (saved) {
    if (saved.city) $('city').value = saved.city;
    setMe(saved);
  }
  updateGo();
})();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
