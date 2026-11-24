// Временен тест: кой вид заявка намира адресите, които сега не се намират.
import fs from 'node:fs';
const UA = 'pazaruvai-evtino/0.1 (+https://github.com/me7ko-dev/pazaruvai-evtino-vseki-den)';
const S = JSON.parse(fs.readFileSync(new URL('./sample.json', import.meta.url)));
let last = 0;
async function q(params) {
  const wait = last + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const u = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=bg&addressdetails=1&' + new URLSearchParams(params);
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'bg' } });
    const [h] = await r.json();
    return h ? `${h.addresstype || h.type}: ${h.display_name.slice(0, 70)}` : null;
  } catch (e) {
    return 'ERR ' + e.message;
  }
}
const parse = (k) => {
  const parts = k.split(',').map((s) => s.trim());
  const country = parts.pop();
  const city = parts.pop();
  return { addr: parts.join(', '), city };
};
const strip = (a) => a.replace(/^(ул\s*\.?|улица|бул\s*\.?|булевард|ж\.?\s?к\.?)\s*/i, '');
const noNum = (a) => a.replace(/\s+\d+\s*[А-Яа-яA-Za-z]?(\s*[-–]\s*\d+\S*)?$/, '').replace(/\s+(No\.?|N)$/i, '').trim();
const variants = {
  stripType: ({ addr, city }) => ({ q: `${strip(addr)}, ${city}, България` }),
  ulitsa: ({ addr, city }) => ({ q: `${addr.replace(/^ул\s*\.?\s*/i, 'улица ')}, ${city}, България` }),
  structured: ({ addr, city }) => {
    const a = strip(addr.split(',').pop().trim());
    const m = a.match(/^(.*?)\s+(\d+\S*)$/);
    return { street: m ? `${m[2]} ${m[1]}` : a, city, country: 'България' };
  },
  streetOnly: ({ addr, city }) => ({ q: `${noNum(strip(addr.split(',').pop().trim()))}, ${city}, България` }),
};
const score = {};
for (const [group, list] of Object.entries(S)) {
  for (const k of list) {
    const p = parse(k);
    console.log(`\n# [${group}] ${k}`);
    for (const [name, fn] of Object.entries(variants)) {
      const params = fn(p);
      const res = await q(params);
      score[`${group}/${name}`] = (score[`${group}/${name}`] ?? 0) + (res && !res.startsWith('ERR') ? 1 : 0);
      console.log(`  ${name.padEnd(11)} ${JSON.stringify(params).slice(0, 70).padEnd(72)} → ${res}`);
    }
  }
}
console.log('\n===== РЕЗУЛТАТ =====');
for (const [g, l] of Object.entries(S)) for (const n of Object.keys(variants)) console.log(`${g}/${n}: ${score[`${g}/${n}`] ?? 0} от ${l.length}`);
