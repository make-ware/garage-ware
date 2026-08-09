#!/usr/bin/env node

/**
 * Promote an existing user to an app admin by adding their row to the Admins
 * collection.
 *
 *   yarn workspace @garage-ware/pb seed-admin <user-email>
 *
 * The user must already have signed up — this grants the admin scope, it does
 * not create an account.
 *
 * Runs as a PocketBase superuser because the Admins createRule
 * (`@collection.Admins.user ?= @request.auth.id`) means only an existing admin
 * may promote anyone, which is exactly the state that does not yet hold when
 * seeding the first one.
 *
 * Talks to the REST API with plain fetch rather than the `pocketbase` SDK: this
 * workspace declares no dependencies, and the SDK is only importable here by
 * hoisting accident from another workspace.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The `dev` script sources ../webapp/.env so the PB process sees the shared
// env; do the same here so the two commands need the same setup. A variable
// already present in the real environment always wins.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!key || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    process.env[key] = quoted ? value.slice(1, -1) : value;
  }
}

loadEnvFile(path.resolve(HERE, '../../webapp/.env'));

// No default credential on purpose — same reasoning as
// shared/pocketbase-migrate.config.js: a fallback password ships a known
// credential and turns a missing-env mistake into a confusing auth failure.
function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} must be set to seed an admin. See .env.example; create the superuser with \`yarn workspace @garage-ware/pb admin\`.`
    );
  }
  return value;
}

const PB_URL = (process.env.POCKETBASE_URL || 'http://localhost:8090').replace(
  /\/+$/,
  ''
);

/** Addresses are compared lowercased everywhere; look them up that way too. */
function normaliseEmail(email) {
  return email.trim().toLowerCase();
}

async function api(pathname, init = {}) {
  let response;
  try {
    response = await fetch(`${PB_URL}${pathname}`, init);
  } catch (cause) {
    throw new Error(
      `Cannot reach PocketBase at ${PB_URL} — is it running? Start it with \`yarn workspace @garage-ware/pb dev\`.\n   ${cause.message}`
    );
  }

  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const error = new Error(
      body?.message || `HTTP ${response.status} ${response.statusText}`
    );
    error.status = response.status;
    error.data = body?.data;
    throw error;
  }

  return body;
}

function usage() {
  return [
    'Usage: yarn workspace @garage-ware/pb seed-admin <user-email>',
    '',
    'Adds the user to the Admins collection. The user must already exist —',
    'have them sign up first.',
  ].join('\n');
}

async function seedAdmin() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    throw new Error(
      `${args.length === 0 ? 'Missing user email.' : 'Expected exactly one user email.'}\n\n${usage()}`
    );
  }

  const email = normaliseEmail(args[0]);
  if (!email.includes('@')) {
    throw new Error(`"${args[0]}" is not an email address.\n\n${usage()}`);
  }

  const adminEmail = required('POCKETBASE_ADMIN_EMAIL');
  const adminPassword = required('POCKETBASE_ADMIN_PASSWORD');

  const json = { 'Content-Type': 'application/json' };

  let auth;
  try {
    auth = await api('/api/collections/_superusers/auth-with-password', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ identity: adminEmail, password: adminPassword }),
    });
  } catch (error) {
    if (error.status === 400) {
      throw new Error(
        `Superuser auth failed for ${adminEmail}. Check POCKETBASE_ADMIN_EMAIL / POCKETBASE_ADMIN_PASSWORD, or create the superuser with \`yarn workspace @garage-ware/pb admin\`.`
      );
    }
    throw error;
  }

  const authed = { Authorization: auth.token };

  // Quotes are stripped rather than escaped, mirroring findUserIdByEmail in
  // webapp/src/lib/storage/invites.ts — no address contains one.
  const userFilter = encodeURIComponent(`email = "${email.replace(/"/g, '')}"`);
  const users = await api(
    `/api/collections/Users/records?perPage=1&filter=${userFilter}`,
    { headers: authed }
  );
  const user = users.items?.[0];
  if (!user) {
    throw new Error(
      `No user with email ${email}. This grants the admin scope, it does not create accounts — have them sign up first.`
    );
  }

  const adminFilter = encodeURIComponent(`user = "${user.id}"`);
  const existing = await api(
    `/api/collections/Admins/records?perPage=1&filter=${adminFilter}`,
    { headers: authed }
  );
  if (existing.items?.[0]) {
    console.log(
      `✅ ${email} is already an admin (Admins row ${existing.items[0].id})`
    );
    return;
  }

  const record = await api('/api/collections/Admins/records', {
    method: 'POST',
    headers: { ...authed, ...json },
    body: JSON.stringify({ user: user.id }),
  });

  console.log(`✅ Promoted ${email} to admin (Admins row ${record.id})`);
}

seedAdmin().catch((error) => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});
