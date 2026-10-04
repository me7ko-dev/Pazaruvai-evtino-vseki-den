// Сваля дневните отворени данни на kolkostruva.bg и ги подрежда за приложението.
//
//   node scripts/build-data.mjs                 сваля последния наличен ден
//   node scripts/build-data.mjs --dir sample    чете CSV файлове от папка (за проба)
//   node scripts/build-data.mjs --no-geocode    без търсене на адреси в OpenStreetMap
//   --geocache <файл>                           друг кеш с координати (по подразбиране data/geocache.json)
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
const MAX_GEOCODE = Number(opt('--max-geocode') ?? 1500);
const GEOCACHE = path.resolve(opt('--geocache') ?? path.join(ROOT, 'data', 'geocache.json'));

// ---------- 1. Сваляне ----------

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function downloadLatest(tmp) {
  const today = new Date();
  for (let back = 0; back < 21; back++) {
    const d = new Date(today.getTime() - back * 86400000);
    const date = isoDate(d);
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
  return out;
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
    } else if (c === '"') q = true;
    else if (c === delim) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
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
  return n > 0 && n < 10000 ? n : NaN;
}

// Името на файла е името на фирмата; превръщаме го в познатото име на веригата.
// Цяла дума и на кирилица (\b в JS работи само с латиница).
const word = (src) => new RegExp(`(?<![а-яa-z])(?:${src})(?![а-яa-z])`, 'i');
const CHAINS = [
  ['лидл|lidl', 'Lidl'],
  ['кауфланд|kaufland', 'Kaufland'],
  ['бил+а|billa', 'BILLA'],
  ['фантастико|ван холдинг|fantastico', 'Фантастико'],
  ['т\\s*-?\\s*маркет|t\\s*-?\\s*market', 'T MARKET'],
  ['метро|metro', 'METRO'],
  ['cba|си би ей', 'CBA'],
  ['лекс|lex', 'Лекс'],
  ['пени|penny', 'Penny'],
  ['етап|etap', 'Етап'],
  ['аванти|avanti', 'Аванти'],
  ['супер ваня|vanya', 'Супер Ваня'],
  ['софарма|sopharma', 'Софарма'],
  ['субра|subra', 'Субра'],
  ['марешки|mareshki', 'Марешки'],
  ['дм|dm', 'dm'],
].map(([src, name]) => [word(src), name]);

function chainName(file) {
  const base = path.basename(file, path.extname(file)).replace(/[_-]?\d{9,13}$/, '').replace(/_/g, ' ').trim();
  for (const [re, name] of CHAINS) if (re.test(base)) return name;
  return base.replace(/\b(ЕООД|ООД|ЕАД|АД|ЕТ|КД|ЕНД КО)\b/gi, '').replace(/\s+/g, ' ').trim() || base;
}

async function readCsv(file, onRow) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let header = null;
  let delim = ',';
  let map = null;
  let rows = 0;
  for await (let line of rl) {
    if (!header) {
      line = line.replace(/^﻿/, '');
      if (!line.trim()) continue;
      delim = [',', ';', '\t'].reduce((a, b) => (line.split(b).length > line.split(a).length ? b : a));
      header = splitCsvLine(line, delim);
      map = mapHeader(header);
      console.log(`  колони: ${JSON.stringify(header)} → ${JSON.stringify(map)}`);
      continue;
    }
    if (!line.trim()) continue;
    const f = splitCsvLine(line, delim);
    onRow({
      city: f[map.city] ?? '',
      store: f[map.store] ?? '',
      product: f[map.product] ?? '',
      category: f[map.category] ?? '',
      price: parsePrice(f[map.price]),
      promo: parsePrice(f[map.promo]),
    });
    rows++;
  }
  return rows;
}

// ---------- 3. Местоположение (OpenStreetMap / Nominatim, кеширано) ----------

const geocache = fs.existsSync(GEOCACHE) ? JSON.parse(fs.readFileSync(GEOCACHE, 'utf8')) : {};
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
  const sorted = Object.fromEntries(Object.entries(geocache).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(GEOCACHE, JSON.stringify(sorted, null, 0).replace(/],"/g, '],\n"').replace(/null,"/g, 'null,\n"') + '\n');
}

// ---------- 4. Сглобяване ----------

function cleanCity(s) {
  return s.replace(/^(гр\.|град|с\.|село)\s*/i, '').replace(/\s+/g, ' ').trim();
}

function slug(s) {
  const tr = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sht', ъ: 'a', ь: 'y', ю: 'yu', я: 'ya' };
  return s.toLowerCase().split('').map((c) => tr[c] ?? c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
}

const STOP = new Set(['и', 'с', 'в', 'за', 'от', 'на', 'бр', 'кг', 'гр', 'г', 'л', 'мл', 'бг', 'пакет', 'опаковка']);

// Когато категорията е само номер: взимаме началните думи от имената на продуктите,
// които са сред най-честите в категорията („Прясно мляко 3% Верея“ → „Прясно мляко“).
function guessName(kw, examples) {
  const top = new Set(kw.slice(0, 3));
  let best = '';
  for (const ex of examples) {
    const words = ex.split(/\s+/);
    const lead = [];
    for (const w of words) {
      if (!top.has(w.toLowerCase())) break;
      lead.push(w);
    }
    if (lead.join(' ').length > best.length) best = lead.join(' ');
  }
  if (!best) best = kw.slice(0, 2).join(' ');
  return best.charAt(0).toUpperCase() + best.slice(1).toLowerCase();
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'pazar-'));
  const src = opt('--dir') ? { date: opt('--date') ?? isoDate(new Date()), dir: path.resolve(opt('--dir')) } : await downloadLatest(tmp);
  const files = listCsv(src.dir);
  if (!files.length) throw new Error(`Няма CSV файлове в ${src.dir}`);

  const stores = new Map(); // ключ: верига|град|обект
  const catWords = new Map(); // категория → брой думи в имената на продуктите
  const catNames = new Map();
  const catExamples = new Map(); // категория → няколко имена на продукти
  let total = 0;
  let skipped = 0;

  for (const file of files) {
    const chain = chainName(file);
    console.log(`${chain}  (${path.basename(file)})`);
    const n = await readCsv(file, (r) => {
      const cat = r.category.trim();
      const best = Number.isFinite(r.promo) && (!Number.isFinite(r.price) || r.promo < r.price) ? r.promo : r.price;
      if (!cat || !Number.isFinite(best) || !r.store) {
        skipped++;
        return;
      }
      const city = cleanCity(r.city);
      const key = `${chain}|${city}|${r.store}`;
      let s = stores.get(key);
      if (!s) stores.set(key, (s = { chain, city, addr: r.store.replace(/\s+/g, ' ').trim(), items: new Map() }));
      const cur = s.items.get(cat);
      if (!cur || best < cur[0]) s.items.set(cat, [best, r.product.replace(/\s+/g, ' ').trim(), Number.isFinite(r.promo) && r.promo === best ? 1 : 0]);

      // Име на категорията: ако колоната е текст, ползваме нея; иначе думите от продуктите.
      if (!/^\d+$/.test(cat)) catNames.set(cat, cat);
      const ex = catExamples.get(cat) ?? [];
      if (ex.length < 50) catExamples.set(cat, [...ex, r.product]);
      let words = catWords.get(cat);
      if (!words) catWords.set(cat, (words = new Map()));
      for (const w of r.product.toLowerCase().split(/[^a-zа-я]+/i)) {
        if (w.length > 2 && !STOP.has(w)) words.set(w, (words.get(w) ?? 0) + 1);
      }
    });
    total += n;
    console.log(`  ${n} реда`);
  }
  console.log(`Общо ${total} реда, ${stores.size} магазина, ${catWords.size} категории, пропуснати ${skipped}`);

  // Категории: име + ключови думи за търсене
  const categories = [...catWords.entries()]
    .map(([id, words]) => {
      const kw = [...words.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([w]) => w);
      return { id, name: catNames.get(id) ?? guessName(kw, catExamples.get(id) ?? []), kw };
    })
    .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0) || a.id.localeCompare(b.id));

  // Градове и координати
  const cityNames = [...new Set([...stores.values()].map((s) => s.city))].sort((a, b) => a.localeCompare(b, 'bg'));
  const cities = [];
  for (const name of cityNames) {
    const ll = await geocode(`${name}, България`);
    cities.push({ name, ll: ll ?? null });
  }

  // Магазини: точен адрес, ако го намерим; иначе центъра на града
  const byCity = new Map();
  for (const s of stores.values()) {
    const city = cities.find((c) => c.name === s.city);
    let ll = await geocode(`${s.addr}, ${s.city}, България`);
    let approx = 0;
    if (!ll) {
      ll = city?.ll ?? null;
      approx = 1;
    }
    if (!byCity.has(s.city)) byCity.set(s.city, []);
    byCity.get(s.city).push({
      ch: s.chain,
      addr: s.addr,
      ll,
      approx,
      it: Object.fromEntries([...s.items.entries()].map(([k, v]) => [k, v])),
    });
  }
  saveGeocache();
  console.log(`Геокодирани нови адреси: ${geocoded}`);

  // Запис
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'c'), { recursive: true });
  const usedSlugs = new Set();
  const cityIndex = [];
  for (const c of cities) {
    let file = slug(c.name);
    while (usedSlugs.has(file)) file += '-2';
    usedSlugs.add(file);
    const list = byCity.get(c.name) ?? [];
    fs.writeFileSync(path.join(OUT, 'c', `${file}.json`), JSON.stringify({ stores: list }));
    cityIndex.push({ name: c.name, ll: c.ll, n: list.length, file });
  }
  const chains = [...new Set([...stores.values()].map((s) => s.chain))].sort();
  fs.writeFileSync(
    path.join(OUT, 'meta.json'),
    JSON.stringify({ date: src.date, built: new Date().toISOString(), categories, chains, cities: cityIndex }),
  );
  console.log(`Готово: ${OUT} (дата на цените ${src.date})`);
}

main().catch((e) => {
  console.error(e);
  saveGeocache();
  process.exit(1);
});
