'use strict';
// Correctif ciblé whatsapp-web.js 1.34.7 : collision __x_id lors de l'envoi de médias.
// Référence : https://github.com/wwebjs/whatsapp-web.js/issues/201922
const fs = require('node:fs');
const path = require('node:path');
const pkg = require('whatsapp-web.js/package.json');
if (pkg.version !== '1.34.7') {
  console.error('[WA PATCH] Version inattendue:', pkg.version, '(attendu: 1.34.7)');
  process.exit(1);
}
const file = require.resolve('whatsapp-web.js/src/util/Injected/Utils.js');
const source = fs.readFileSync(file, 'utf8');
const marker = '        // JJR_MEDIA_ID_PATCH: do not overwrite outgoing MsgKey with MediaData.__x_id\n        delete message.__x_id;\n';
if (source.includes(marker)) {
  console.log('[WA PATCH] Déjà appliqué');
  process.exit(0);
}
const anchor = '        // Bot\'s won\'t reply if canonicalUrl is set (linking)';
if (!source.includes(anchor) || source.split(anchor).length !== 2 || !source.includes('const message = {')) {
  console.error('[WA PATCH] Structure du fichier inattendue, correctif non appliqué');
  process.exit(1);
}
const patched = source.replace(anchor, marker + anchor);
fs.writeFileSync(file, patched, 'utf8');
console.log('[WA PATCH] Correctif __x_id appliqué à whatsapp-web.js', pkg.version);
