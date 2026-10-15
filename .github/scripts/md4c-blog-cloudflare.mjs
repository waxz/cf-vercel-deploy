#!/usr/bin/env node
// Cloudflare setup for the md4c blog, run by deploy-waxz-md4c-blog.yaml.
// Idempotent: safe to run on every deploy. Uses only CLOUDFLARE_API_TOKEN
// and CLOUDFLARE_ACCOUNT_ID; everything else is created or discovered:
//
//   1. the public and the private (drafts) R2 buckets
//   2. the blog's public URL: BLOG_DOMAIN connected to the bucket, or the
//      bucket's r2.dev URL
//   3. the admin's hostname: ADMIN_DOMAIN, or <worker>.<subdomain>.workers.dev
//   4. the Zero Trust team domain
//   5. a Cloudflare Access application for the admin hostname, with an
//      "allow" policy for ADMIN_EMAILS (needed on the first run; later runs
//      keep the existing list unless new emails are given), and its AUD tag
//   6. a KV namespace for storage added on the admin's Storage page
//      (optional: without "Workers KV Storage: Edit" on the token, the admin
//      keeps such storage in each browser instead)
//
// Results go to $GITHUB_OUTPUT (and stdout): public_url, admin_host,
// admin_on_workers_dev, access_team_domain, access_aud, kv_namespace_id.

import { appendFileSync } from 'node:fs';

const API = (process.env.CF_API_BASE ?? 'https://api.cloudflare.com/client/v4').replace(/\/$/, '');
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const BLOG_BUCKET = process.env.BLOG_BUCKET || 'md4c-blog';
const DRAFTS_BUCKET = process.env.DRAFTS_BUCKET || 'md4c-blog-drafts';
const WORKER_NAME = process.env.WORKER_NAME || 'md4c-blog-admin';
const BLOG_DOMAIN = (process.env.BLOG_DOMAIN ?? '').trim().toLowerCase();
const ADMIN_DOMAIN = (process.env.ADMIN_DOMAIN ?? '').trim().toLowerCase();
const EMAILS = (process.env.ADMIN_EMAILS ?? '').split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
const POLICY_NAME = `md4c blog admins (${WORKER_NAME})`;
const KV_TITLE = `${WORKER_NAME}-settings`;

// What each API area needs, to turn a 403 into an actionable message.
const PERMISSION = {
  r2: 'Account → Workers R2 Storage: Edit',
  workers: 'Account → Workers Scripts: Edit',
  access: 'Account → Access: Apps and Policies: Edit',
  org: 'Account → Access: Organizations, Identity Providers, and Groups: Read',
  zones: 'Zone → Zone: Read (for custom domains)',
  kv: 'Account → Workers KV Storage: Edit',
};

class SetupError extends Error {}

function fail(message) {
  throw new SetupError(message);
}

async function cf(method, path, body, area) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const msg = (data.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${res.status}`;
    const err = new SetupError(`${method} ${path.replace(ACCOUNT, '<account>')} failed: ${msg}` +
      (res.status === 403 || res.status === 401 ? `\n  The API token probably lacks the permission "${PERMISSION[area]}".` : ''));
    err.status = res.status;
    err.cfErrors = data.errors ?? [];
    throw err;
  }
  return data.result;
}

const acct = (p) => `/accounts/${ACCOUNT}${p}`;
const log = (msg) => console.log(msg);

async function ensureBucket(name) {
  try {
    await cf('GET', acct(`/r2/buckets/${name}`), undefined, 'r2');
    log(`✓ bucket ${name} exists`);
  } catch (err) {
    if (err.status !== 404) throw err;
    await cf('POST', acct('/r2/buckets'), { name }, 'r2');
    log(`✓ created bucket ${name}`);
  }
}

async function zoneIdFor(hostname) {
  const labels = hostname.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const zones = await cf('GET', `/zones?name=${encodeURIComponent(labels.slice(i).join('.'))}&account.id=${ACCOUNT}`, undefined, 'zones');
    if (zones?.length) return zones[0].id;
  }
  fail(`No Cloudflare zone in this account contains ${hostname}. Add the domain to Cloudflare first, or leave the domain empty.`);
}

async function publicUrl() {
  if (BLOG_DOMAIN) {
    const zoneId = await zoneIdFor(BLOG_DOMAIN);
    const custom = await cf('GET', acct(`/r2/buckets/${BLOG_BUCKET}/domains/custom`), undefined, 'r2');
    if ((custom?.domains ?? []).some((d) => d.domain === BLOG_DOMAIN)) {
      log(`✓ ${BLOG_DOMAIN} is connected to ${BLOG_BUCKET}`);
    } else {
      await cf('POST', acct(`/r2/buckets/${BLOG_BUCKET}/domains/custom`), { domain: BLOG_DOMAIN, zoneId, enabled: true }, 'r2');
      log(`✓ connected ${BLOG_DOMAIN} to ${BLOG_BUCKET}`);
    }
    return `https://${BLOG_DOMAIN}/`;
  }
  const managed = await cf('PUT', acct(`/r2/buckets/${BLOG_BUCKET}/domains/managed`), { enabled: true }, 'r2');
  if (!managed?.domain) fail('Could not enable the bucket\'s r2.dev URL.');
  log(`✓ blog is public at https://${managed.domain}/ (r2.dev; set a blog domain for production)`);
  return `https://${managed.domain}/`;
}

async function adminHost() {
  if (ADMIN_DOMAIN) {
    await zoneIdFor(ADMIN_DOMAIN); // fail early if the zone is not in this account
    return { host: ADMIN_DOMAIN, workersDev: false };
  }
  let sub;
  try {
    sub = (await cf('GET', acct('/workers/subdomain'), undefined, 'workers'))?.subdomain;
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  if (!sub) fail('This account has no workers.dev subdomain yet. Open Workers & Pages in the Cloudflare dashboard once to pick one, or set an admin domain.');
  return { host: `${WORKER_NAME}.${sub}.workers.dev`, workersDev: true };
}

async function teamDomain() {
  let org;
  try {
    org = await cf('GET', acct('/access/organizations'), undefined, 'org');
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  if (!org?.auth_domain) {
    fail('Cloudflare Zero Trust is not set up for this account. Open "Zero Trust" in the Cloudflare dashboard once, choose a team name and the Free plan, then run the workflow again.');
  }
  return `https://${org.auth_domain}`;
}

function emailRules() {
  for (const e of EMAILS) if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) fail(`"${e}" is not an email address`);
  return EMAILS.map((email) => ({ email: { email } }));
}

async function ensureAccessApp(host) {
  const apps = await cf('GET', acct('/access/apps'), undefined, 'access');
  const norm = (d) => String(d ?? '').toLowerCase().replace(/\/+$/, '');
  let app = (apps ?? []).find((a) => norm(a.domain) === host);
  const policies = await cf('GET', acct('/access/policies'), undefined, 'access');
  let policy = (policies ?? []).find((p) => p.name === POLICY_NAME);

  if (EMAILS.length) {
    const body = { name: POLICY_NAME, decision: 'allow', include: emailRules(), session_duration: '24h' };
    if (policy) {
      policy = await cf('PUT', acct(`/access/policies/${policy.id}`), body, 'access');
      log(`✓ Access policy allows: ${EMAILS.join(', ')}`);
    } else {
      policy = await cf('POST', acct('/access/policies'), body, 'access');
      log(`✓ created Access policy for: ${EMAILS.join(', ')}`);
    }
  }

  if (!app) {
    if (!policy) fail('The first deploy needs admin_email: the email address(es) allowed to sign in to the admin.');
    app = await cf('POST', acct('/access/apps'), {
      name: `md4c blog admin (${WORKER_NAME})`,
      type: 'self_hosted',
      domain: host,
      session_duration: '24h',
      app_launcher_visible: false,
      policies: [{ id: policy.id, precedence: 1 }],
    }, 'access');
    log(`✓ created Access application for ${host}`);
  } else {
    const attached = (app.policies ?? []).some((p) => (p.id ?? p) === policy?.id);
    if (policy && !attached) {
      app = await cf('PUT', acct(`/access/apps/${app.id}`), {
        name: app.name,
        type: app.type ?? 'self_hosted',
        domain: app.domain,
        session_duration: app.session_duration ?? '24h',
        app_launcher_visible: app.app_launcher_visible ?? false,
        policies: [...(app.policies ?? []).map((p, i) => ({ id: p.id ?? p, precedence: i + 2 })), { id: policy.id, precedence: 1 }],
      }, 'access');
      log(`✓ attached the admin policy to the existing Access application for ${host}`);
    } else {
      log(`✓ Access application for ${host} exists`);
    }
  }
  if (!app.aud) fail(`The Access application for ${host} has no AUD tag.`);
  return app.aud;
}

/** The settings KV namespace's id, created if needed; '' without permission. */
async function ensureKv() {
  try {
    for (let page = 1; ; page++) {
      const list = await cf('GET', acct(`/storage/kv/namespaces?per_page=100&page=${page}`), undefined, 'kv');
      const found = list.find((n) => n.title === KV_TITLE);
      if (found) {
        log(`✓ KV namespace ${KV_TITLE} exists`);
        return found.id;
      }
      if (list.length < 100) break;
    }
    const created = await cf('POST', acct('/storage/kv/namespaces'), { title: KV_TITLE }, 'kv');
    log(`✓ created KV namespace ${KV_TITLE}`);
    return created.id;
  } catch (err) {
    if (err.status !== 403 && err.status !== 401) throw err;
    console.log(`::warning::No KV namespace: the API token lacks "${PERMISSION.kv}". ` +
      'The admin works, but storage added on its Storage page can only be kept in each browser.');
    return '';
  }
}

function output(values) {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  for (const l of lines) log(`  ${l}`);
}

async function main() {
  if (!TOKEN) fail('The secret CLOUDFLARE_API_TOKEN is not set.');
  if (!ACCOUNT) fail('The secret CLOUDFLARE_ACCOUNT_ID is not set.');
  for (const [k, v] of [['blog bucket', BLOG_BUCKET], ['drafts bucket', DRAFTS_BUCKET]]) {
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(v)) fail(`${k} "${v}" is not a valid R2 bucket name`);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(WORKER_NAME)) fail(`worker name "${WORKER_NAME}" is invalid`);
  for (const d of [BLOG_DOMAIN, ADMIN_DOMAIN]) {
    if (d && !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(d)) fail(`"${d}" is not a hostname (use e.g. blog.example.com, without https://)`);
  }

  await ensureBucket(BLOG_BUCKET);
  await ensureBucket(DRAFTS_BUCKET);
  const url = await publicUrl();
  const { host, workersDev } = await adminHost();
  const team = await teamDomain();
  const aud = await ensureAccessApp(host);
  const kv = await ensureKv();
  output({
    public_url: url,
    admin_host: host,
    admin_on_workers_dev: String(workersDev),
    access_team_domain: team,
    access_aud: aud,
    kv_namespace_id: kv,
  });
}

main().catch((err) => {
  console.log(`::error::${String(err.message).replace(/\n/g, '%0A')}`);
  if (!(err instanceof SetupError)) console.error(err);
  process.exit(1);
});
