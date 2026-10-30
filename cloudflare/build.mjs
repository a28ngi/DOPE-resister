// register.html と server.js から、Cloudflare に貼り付ける 1 ファイルの worker.js を作る
// 使い方: node cloudflare/build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const body = readFileSync(join(here, '..', 'register.html'), 'utf8');
const server = readFileSync(join(here, 'server.js'), 'utf8');
const page = '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
  '<script>window.DOPE_API = "/api";</script></head><body>' + body + '</body></html>';
const out = '// このファイルは build.mjs で自動生成。編集は register.html と cloudflare/server.js で行う。\n' +
  'const PAGE_HTML = ' + JSON.stringify(page) + ';\n\n' + server;
writeFileSync(join(here, 'worker.js'), out);
console.log('wrote cloudflare/worker.js (' + out.length + ' bytes)');
