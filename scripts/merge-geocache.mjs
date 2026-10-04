// Слива два кеша с адреси: node scripts/merge-geocache.mjs <другият.json> <нашият.json>
// Резултатът се записва в нашия. Намерен адрес е по-ценен от „не е намерен“ (null).
import fs from 'node:fs';

const [otherPath, ourPath] = process.argv.slice(2);
const read = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
};
const merged = { ...read(otherPath) };
for (const [k, v] of Object.entries(read(ourPath))) if (v || !(k in merged)) merged[k] = v;
const entries = Object.entries(merged).sort(([a], [b]) => a.localeCompare(b));
fs.writeFileSync(ourPath, '{\n' + entries.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',\n') + '\n}\n');
console.log(`Кеш с адреси: ${entries.length} записа`);
