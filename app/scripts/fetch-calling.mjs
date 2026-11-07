// Fetch only the two reviewed calling artifacts, verifying their exact identities before image packaging.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const base = 'https://teams.public.onecdn.static.microsoft/teams-modular-packages/hashed-assets/';
const files = [
 ['cmd-trouter-14c2944133b694b2.js', 'cmd-trouter.js', 'ae686dad9c49f198dc2fe41bdd68a78ca29e38b1c070f3d708fd1ea08aeabae8'],
 ['calling-pluginless-24b5e59cf0d574dc.js', 'calling-pluginless.js', '7df71e7009a880cc0fe6cd83b0ae201de00698ec670030369c9e3a893aad74d9'],
];
fs.mkdirSync('/agent/calling', { recursive: true });
for (const [remote, local, hash] of files) {
 const r = await fetch(base + remote, { signal: AbortSignal.timeout(60000) });
 if (!r.ok) throw new Error(`calling artifact ${r.status}`);
 const bytes = Buffer.from(await r.arrayBuffer());
 if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('calling artifact digest mismatch');
 fs.writeFileSync('/agent/calling/' + local, bytes);
}
