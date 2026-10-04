// Сваля дневните отворени данни на kolkostruva.bg и ги подрежда за приложението.
//
//   node scripts/build-data.mjs                 сваля последния наличен ден
//   node scripts/build-data.mjs --dir sample    чете CSV файлове от папка (за проба)
//   --no-geocode                                без търсене на адреси в OpenStreetMap
//   --max-geocode <брой>                        най-много нови адреси за едно пускане (1500)
//   --geocache <файл>                           друг кеш с координати (по подразбиране data/geocache.json)
//   --ekatte <файл>                             друг файл с населените места (по подразбиране data/ekatte.json)
//   --report                                    отчет за веригите и групите продукти в лога
//
// Входни данни (формат на КЗП): CSV по един файл на търговец, с колони
//   Населено място (код по ЕКАТТЕ) | Търговски обект | Наименование на продукта |
//   Код на продукта | Категория (1–101) | Цена на дребно | Цена в промоция
//
// Резултат: site/data/meta.json и site/data/c/<град>.json

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'site', 'data');
const UA = 'pazaruvai-evtino/0.1 (+https://github.com/me7ko-dev/pazaruvai-evtino-vseki-den)';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const NO_GEOCODE = args.includes('--no-geocode');
const REPORT = args.includes('--report');
const MAX_GEOCODE = Number(opt('--max-geocode') ?? 1500);
const GEOCACHE = path.resolve(opt('--geocache') ?? path.join(ROOT, 'data', 'geocache.json'));

const readJson = (p, d) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : d);
const EKATTE = readJson(path.resolve(opt('--ekatte') ?? path.join(ROOT, 'data', 'ekatte.json')), {}); // код → [име, ширина, дължина]
const CATEGORY_NAMES = readJson(path.join(ROOT, 'data', 'categories.json'), {}); // номер → име

// Групи, които за купувача са едно и също (КЗП ги дели на две, напр. сирене насипно и пакетирано).
const MERGE = { 9: '8', 11: '10', 32: '31' };

// Обекти, в които не се пазарува на място: онлайн магазини, складове, безмитни зони.
const NOT_A_SHOP = /онлайн|online|https?:\/\/|централен склад|терминал|дюфри|duty free|travel free/i;

// ---------- 1. Сваляне ----------

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function downloadLatest(tmp) {
  const today = new Date();
  for (let back = 0; back < 21; back++) {
    const date = isoDate(new Date(today.getTime() - back * 86400000));
    const url = `https://kolkostruva.bg/opendata_files/${date}.zip`;
    const res = await fetch(url, { headers: { 'User-Agent': UA } }).catch((e) => ({ ok: false, status: e.message }));
    if (!res.ok) {
      console.log(`${date}: няма (${res.status})`);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000 || buf.subarray(0, 2).toString() !== 'PK') {
      console.log(`${date}: не е ZIP (${buf.length} байта)`);
      continue;
    }
    const zip = path.join(tmp, `${date}.zip`);
    fs.writeFileSync(zip, buf);
    const dir = path.join(tmp, date);
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
    console.log(`${date}: свален, ${(buf.length / 1e6).toFixed(1)} MB`);
    return { date, dir };
  }
  throw new Error('Няма данни на kolkostruva.bg за последните 3 седмици');
}

function listCsv(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listCsv(p));
    else if (/\.csv$/i.test(e.name)) out.push(p);
  }
  return out.sort();
}

// ---------- 2. Четене на CSV ----------

function splitCsvLine(line, delim) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"' && cur.trim() === '') q = true;
    else if (c === delim) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// Някои търговци слагат кавички вътре в полето без да ги удвояват
// ("САЛВИЯ-Пожарна" ВЕЛИКО ТЪРНОВО...). Тогава полетата се броят отзад напред:
// последните 4 колони са код, категория, цена и промоция и не съдържат запетаи.
function splitLenient(line, delim, n) {
  const parts = line.split(delim).map((s) => s.trim().replace(/^"+|"+$/g, ''));
  if (parts.length < n) return null;
  const tail = parts.slice(parts.length - 4);
  const head = parts.slice(0, parts.length - 4);
  // първите 2 са град и обект; всичко между тях и опашката е името на продукта
  return [head[0], head[1], head.slice(2).join(delim), ...tail];
}

// Колоните се търсят по името им, не по реда, за да не зависим от точния формат.
const COLUMNS = {
  city: /насел|град|city|ekatte|екатте/i,
  store: /обект|магазин|store|адрес/i,
  product: /наименован|продукт|артикул|name/i,
  code: /^код|code/i,
  category: /категор|category|група/i,
  price: /дребно|цена(?!.*промо)|price/i,
  promo: /промо|promo/i,
};

function mapHeader(header) {
  const map = {};
  const taken = new Set();
  // Промоцията първо, иначе „Цена в промоция“ се хваща като обикновена цена.
  for (const key of ['promo', 'category', 'city', 'store', 'code', 'product', 'price']) {
    const i = header.findIndex((h, idx) => !taken.has(idx) && COLUMNS[key].test(h));
    if (i >= 0) {
      map[key] = i;
      taken.add(i);
    }
  }
  return map;
}

function parsePrice(s) {
  if (!s) return NaN;
  const n = Number(String(s).replace(/\s/g, '').replace(',', '.').replace(/[^\d.]/g, ''));
  return n > 0 && n < 10000 ? Math.round(n * 100) / 100 : NaN;
}

// Името на файла е „Марка (Фирма ООД)_ЕИК.csv“. Взимаме марката.
// Цяла дума и на кирилица (\b в JS работи само с латиница).
const word = (src) => new RegExp(`(?<![а-яa-z])(?:${src})(?![а-яa-z])`, 'i');
const CHAINS = [
  ['лидл|lidl', 'Lidl'],
  ['кауфланд|kaufland', 'Kaufland'],
  ['бил+а|billa', 'BILLA'],
  ['фантастико|fantastico', 'Фантастико'],
  ['т\\s*-?\\s*маркет|t\\s*-?\\s*market', 'T MARKET'],
  ['дм|dm', 'dm'],
].map(([src, name]) => [word(src), name]);

function chainName(file) {
  const base = path.basename(file, path.extname(file)).replace(/[_-]?\d{9,13}$/, '').replace(/_/g, ' ').trim();
  const brand = base.split(' (')[0].trim();
  for (const [re, name] of CHAINS) if (re.test(brand)) return name;
  if (brand && brand !== base) return brand;
  return base.replace(/(?<![а-яa-z])(ЕООД|ООД|ЕАД|АД|ЕТ|КД|ЕНД КО)(?![а-яa-z])/gi, '').replace(/\s+/g, ' ').trim() || base;
}

// излишни кавички в краищата от развалени редове, двойни интервали
const clean = (s) => (s ?? '').replace(/^["\s]+|["\s]+$/g, '').replace(/\s+/g, ' ');

async function readCsv(file, onRow) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let header = null;
  let delim = ',';
  let map = null;
  let rows = 0;
  let bad = 0;
  for await (let line of rl) {
    if (!header) {
      line = line.replace(/^﻿/, '');
      if (!line.trim()) continue;
      delim = [',', ';', '\t'].reduce((a, b) => (line.split(b).length > line.split(a).length ? b : a));
      header = splitCsvLine(line, delim);
      map = mapHeader(header);
      if (map.category == null || map.price == null) console.log(`  ⚠ непознати колони: ${JSON.stringify(header)}`);
      continue;
    }
    if (!line.trim()) continue;
    let f = splitCsvLine(line, delim);
    if (f.length !== header.length) f = header.length === 7 ? splitLenient(line, delim, 7) : null;
    if (!f) {
      bad++;
      continue;
    }
    onRow({
      city: f[map.city] ?? '',
      store: clean(f[map.store]),
      product: clean(f[map.product]),
      category: (f[map.category] ?? '').trim(),
      price: parsePrice(f[map.price]),
      promo: parsePrice(f[map.promo]),
    });
    rows++;
  }
  return { rows, bad };
}

// ---------- 3. Населени места и адреси ----------

// Кодът по ЕКАТТЕ е 5 цифри; някои го подават без водещите нули („702“ = „00702“ Асеновград).
function resolveCity(raw) {
  const s = raw.trim();
  if (/^\d{1,5}$/.test(s)) {
    const code = s.padStart(5, '0');
    const e = EKATTE[code];
    return { key: code, name: e?.[0] || `Населено място ${code}`, ll: e ? [e[1], e[2]] : null };
  }
  const name = s.replace(/^(гр\.|град|с\.|село)\s*/i, '').replace(/\s+/g, ' ').trim();
  return { key: name.toLowerCase(), name, ll: null };
}

const geocache = readJson(GEOCACHE, {});
let geocoded = 0;
let lastGeo = 0;

async function geocode(query) {
  if (query in geocache) return geocache[query];
  if (NO_GEOCODE || geocoded >= MAX_GEOCODE) return undefined;
  const wait = lastGeo + 1100 - Date.now(); // правило на Nominatim: най-много 1 заявка в секунда
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeo = Date.now();
  geocoded++;
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=bg&q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'bg' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const [hit] = await res.json();
    geocache[query] = hit ? [Number(Number(hit.lat).toFixed(5)), Number(Number(hit.lon).toFixed(5))] : null;
  } catch (e) {
    console.log(`  геокодиране „${query}“: ${e.message}`);
    return undefined; // не кешираме грешки, ще пробваме пак утре
  }
  if (geocoded % 100 === 0) saveGeocache();
  return geocache[query];
}

function saveGeocache() {
  fs.mkdirSync(path.dirname(GEOCACHE), { recursive: true });
  const entries = Object.entries(geocache).sort(([a], [b]) => a.localeCompare(b));
  fs.writeFileSync(GEOCACHE, '{\n' + entries.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',\n') + '\n}\n');
}

// Адрес за търсене в OpenStreetMap от полето „Търговски обект“. Търговците го пишат
// всеки по своему („238 - Септември/ул. Христо Ботев74“, „Кауфланд София-Младост - rp.София,ул. Филип Аврамов 3“,
// „обект: НДК адрес: гр. София ул.Фритьоф Нансен 37 А“), затова взимаме частта от първата
// дума за улица нататък и добавяме населеното място. Без такава дума („МАГАЗИН ЖИЗЕЛ 1“)
// не търсим – OpenStreetMap няма как да го намери, а всяка заявка струва секунда.
const STREET = /(?<![а-яa-z])(ул\.?|улица|бул\.?|булевард|ж\.?\s?к\.?|кв\.|пл\.|площад|шосе)(?![а-яa-z])/i;

function addressQueries(store, city) {
  let a = store
    .replace(/(?<![а-яa-z])rp\./gi, 'гр.')
    .replace(/^.*адрес:\s*/i, '')
    .replace(/[„“"]/g, '')
    .replace(/№\s*/g, '')
    .replace(/\//g, ', ')
    .replace(/([а-яa-z])(\d)/gi, '$1 $2'); // „Ботев74“ → „Ботев 74“
  const m = STREET.exec(a);
  if (!m) return [];
  a = a.slice(m.index);
  a = a.replace(/,?\s*(ет\.?|етаж|мн\.?|магазин|маг\.)\s*\S+.*$/i, '').replace(/\s+/g, ' ').trim().replace(/[,\s]+$/, '');
  const full = `${a}, ${city.name}, България`;
  const short = a.split(',')[0].trim();
  return short && short !== a ? [full, `${short}, ${city.name}, България`] : [full];
}

async function locate(store, city) {
  for (const q of addressQueries(store, city)) {
    const ll = await geocode(q);
    if (ll) return ll;
  }
  return null;
}

// ---------- 4. Сглобяване ----------

function slug(s) {
  const tr = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sht', ъ: 'a', ь: 'y', ю: 'yu', я: 'ya' };
  return s.toLowerCase().split('').map((c) => tr[c] ?? c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
}

const STOP = new Set(['и', 'с', 'в', 'за', 'от', 'на', 'бр', 'кг', 'гр', 'г', 'л', 'мл', 'бг', 'пакет', 'опаковка', 'кутия', 'вакум']);
const words = (s) => s.toLowerCase().split(/[^a-zа-я]+/i).filter((w) => w.length > 2 && !STOP.has(w));

// Когато няма зададено име: началните думи от най-честите имена на продукти.
function guessName(kw, examples) {
  const top = new Set(kw.slice(0, 3));
  let best = '';
  for (const ex of examples) {
    const lead = [];
    for (const w of ex.split(/\s+/)) {
      if (!top.has(w.toLowerCase())) break;
      lead.push(w);
    }
    if (lead.join(' ').length > best.length) best = lead.join(' ');
  }
  if (!best) best = kw.slice(0, 2).join(' ');
  return best.charAt(0).toUpperCase() + best.slice(1).toLowerCase();
}

const inc = (m, k, by = 1) => m.set(k, (m.get(k) ?? 0) + by);
const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

async function main() {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'pazar-'));
  const src = opt('--dir') ? { date: opt('--date') ?? isoDate(new Date()), dir: path.resolve(opt('--dir')) } : await downloadLatest(tmp);
  const files = listCsv(src.dir);
  if (!files.length) throw new Error(`Няма CSV файлове в ${src.dir}`);

  const stores = new Map(); // ключ: верига|град|обект
  const cities = new Map(); // ключ на града → {name, ll}
  const cat = new Map(); // категория → {rows, words: Map, heads: Map, examples: []}
  const unknownCities = new Map();
  let total = 0;
  let skipped = 0;
  let notShop = 0;

  for (const file of files) {
    const chain = chainName(file);
    const fileStores = new Set();
    const fileCities = new Set();
    const { rows, bad } = await readCsv(file, (r) => {
      const best = Number.isFinite(r.promo) && (!Number.isFinite(r.price) || r.promo < r.price) ? r.promo : r.price;
      if (!/^\d{1,3}$/.test(r.category) || !Number.isFinite(best) || !r.store || !r.city) {
        skipped++;
        return;
      }
      if (NOT_A_SHOP.test(r.store) || NOT_A_SHOP.test(chain)) {
        notShop++;
        return;
      }
      r.category = MERGE[r.category] ?? r.category;
      const city = resolveCity(r.city);
      if (!cities.has(city.key)) cities.set(city.key, city);
      if (!city.ll) inc(unknownCities, `${r.city} (${chain})`);
      const key = `${chain}|${city.key}|${r.store}`;
      let s = stores.get(key);
      if (!s) stores.set(key, (s = { chain, city: city.key, addr: r.store, items: new Map() }));
      fileStores.add(key);
      fileCities.add(city.key);
      const cur = s.items.get(r.category);
      const name = r.product.length > 70 ? r.product.slice(0, 69) + '…' : r.product;
      if (!cur || best < cur[0]) s.items.set(r.category, [best, name, Number.isFinite(r.promo) && r.promo === best ? 1 : 0]);

      let c = cat.get(r.category);
      if (!c) cat.set(r.category, (c = { rows: 0, words: new Map(), heads: new Map(), examples: [] }));
      c.rows++;
      if (c.examples.length < 60) c.examples.push(r.product);
      const ws = words(r.product);
      for (const w of ws) inc(c.words, w);
      if (ws.length) inc(c.heads, ws.slice(0, 2).join(' '));
    });
    total += rows;
    const sample = [...fileStores].slice(0, 3).map((k) => k.split('|')[2]);
    console.log(`${chain} [${path.basename(file)}]: ${rows} реда${bad ? `, ${bad} развалени` : ''}, ${fileStores.size} обекта в ${fileCities.size} места  · ${sample.join(' · ')}`);
  }
  console.log(`\nОбщо ${total} реда, ${stores.size} обекта, ${cities.size} населени места, ${cat.size} групи, пропуснати ${skipped}, не са магазини ${notShop}`);
  if (unknownCities.size) console.log(`Непознати кодове на места: ${top(unknownCities, 15).map(([k, n]) => `${k}×${n}`).join(', ')}`);

  // Групи продукти: име + думи за търсене
  const storesPerCat = new Map();
  for (const s of stores.values()) for (const id of s.items.keys()) inc(storesPerCat, id);
  const categories = [...cat.entries()]
    .map(([id, c]) => {
      const kw = top(c.words, 15).map(([w]) => w);
      return { id, name: CATEGORY_NAMES[id] ?? guessName(kw, c.examples), kw, n: storesPerCat.get(id) ?? 0 };
    })
    .sort((a, b) => Number(a.id) - Number(b.id));

  if (REPORT) {
    console.log('\n===== Групи продукти =====');
    for (const c of categories) {
      const h = cat.get(c.id);
      console.log(`${c.id.padStart(3)} | ${c.name} | ${h.rows} реда, ${c.n} обекта | ${top(h.heads, 8).map(([k, n]) => `${k}(${n})`).join(', ')}`);
    }
  }

  // Места на магазините: точен адрес, ако го намерим; иначе центъра на населеното място
  const byCity = new Map();
  let exact = 0;
  for (const s of stores.values()) {
    const city = cities.get(s.city);
    let ll = await locate(s.addr, city);
    let approx = 0;
    if (ll) exact++;
    else {
      ll = city.ll;
      approx = 1;
    }
    if (!byCity.has(s.city)) byCity.set(s.city, []);
    byCity.get(s.city).push({ ch: s.chain, addr: s.addr, ll, approx, it: Object.fromEntries(s.items) });
  }
  saveGeocache();
  console.log(`Точен адрес: ${exact} от ${stores.size} обекта. Нови търсения в OpenStreetMap: ${geocoded}`);

  // Запис
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'c'), { recursive: true });
  const usedSlugs = new Set();
  const cityIndex = [];
  for (const [key, c] of cities) {
    const list = byCity.get(key);
    if (!list) continue;
    let file = /^\d{5}$/.test(key) ? `${slug(c.name)}-${key}` : slug(c.name);
    while (usedSlugs.has(file)) file += '-2';
    usedSlugs.add(file);
    fs.writeFileSync(path.join(OUT, 'c', `${file}.json`), JSON.stringify({ stores: list }));
    cityIndex.push({ name: c.name, ll: c.ll, n: list.length, file });
  }
  cityIndex.sort((a, b) => a.name.localeCompare(b.name, 'bg'));
  const chains = [...new Set([...stores.values()].map((s) => s.chain))].sort((a, b) => a.localeCompare(b, 'bg'));
  fs.writeFileSync(
    path.join(OUT, 'meta.json'),
    JSON.stringify({ date: src.date, built: new Date().toISOString(), categories, chains, cities: cityIndex }),
  );
  const size = fs.readdirSync(path.join(OUT, 'c')).reduce((n, f) => n + fs.statSync(path.join(OUT, 'c', f)).size, 0);
  console.log(`Готово: ${cityIndex.length} места, ${(size / 1e6).toFixed(1)} MB (дата на цените ${src.date})`);
}

main().catch((e) => {
  console.error(e);
  saveGeocache();
  process.exit(1);
});
