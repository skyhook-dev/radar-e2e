import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const K = (...a) => execFileSync('kubectl', ['--context', 'kind-radar-e2e', ...a], { encoding: 'utf8' }).trim();
const NS = 'e2e-certs';
const name = `probe-cert-${Date.now()}`;
const cn = `${name}.certs.e2e.test`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: '.run/auth.json' });
const page = await ctx.newPage();

const certCard = async () => {
  await page.goto('http://localhost:18080/');
  await page.waitForTimeout(9000);
  return page.evaluate(() => {
    const el = document.querySelector('a[href="/certs"]');
    const hit = el;
    return (hit?.innerText || '').replace(/\n/g, ' | ').slice(0, 200);
  });
};

console.log('before:', await certCard());

try { K('create', 'namespace', NS); } catch {}
const dir = mkdtempSync(path.join(tmpdir(), 'probe-certs-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'),
  '-days', '5', '-nodes', '-subj', `/CN=${cn}`, '-addext', `subjectAltName=DNS:${cn}`], { stdio: ['ignore', 'ignore', 'ignore'] });
K('-n', NS, 'create', 'secret', 'tls', name, `--cert=${path.join(dir, 'c.pem')}`, `--key=${path.join(dir, 'k.pem')}`);
console.log('\nminted 5-day cert', `${NS}/${name}`);

try {
  for (let i = 1; i <= 6; i++) {
    const card = await certCard();
    console.log(`t+${i * 10}s card:`, card);
    if (!/Nothing expiring/i.test(card)) { console.log('CARD REACTED'); break; }
  }
} finally {
  K('-n', NS, 'delete', 'secret', name, '--ignore-not-found');
  rmSync(dir, { recursive: true, force: true });
  console.log('cleaned up');
}
await browser.close();
