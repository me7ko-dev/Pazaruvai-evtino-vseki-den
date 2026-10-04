// Сваля всички населени места в България с код по ЕКАТТЕ и координати от Wikidata.
// Записва data/ekatte.json: { "68134": ["София", 42.6975, 23.3242], ... }
// Пуска се рядко (селищата не се местят) – при липса на файла или с --force.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'data', 'ekatte.json');
if (fs.existsSync(OUT) && !process.argv.includes('--force')) {
  console.log('data/ekatte.json вече го има');
  process.exit(0);
}

const query = `SELECT ?e ?c ?l WHERE {
  ?i wdt:P3990 ?e; wdt:P625 ?c.
  OPTIONAL { ?i rdfs:label ?l FILTER(lang(?l) = "bg") }
}`;
const res = await fetch('https://query.wikidata.org/sparql?query=' + encodeURIComponent(query), {
  headers: {
    Accept: 'application/sparql-results+json',
    'User-Agent': 'pazaruvai-evtino/0.1 (+https://github.com/me7ko-dev/pazaruvai-evtino-vseki-den)',
  },
});
if (!res.ok) throw new Error(`Wikidata: HTTP ${res.status}`);
const { results } = await res.json();
const out = {};
for (const b of results.bindings) {
  const code = b.e.value.replace(/\D/g, '').padStart(5, '0');
  const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(b.c.value);
  if (!m || code.length !== 5 || out[code]) continue;
  out[code] = [b.l?.value ?? '', Number(Number(m[2]).toFixed(4)), Number(Number(m[1]).toFixed(4))];
}
const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, '{\n' + Object.entries(sorted).map(([k, v]) => `"${k}":${JSON.stringify(v)}`).join(',\n') + '\n}\n');
console.log(`${Object.keys(sorted).length} населени места → data/ekatte.json`);
