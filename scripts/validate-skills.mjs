#!/usr/bin/env node
// Validates the dodopayments/skills repo before opening a PR.
// Usage: node validate-skills.mjs /path/to/skills-pr

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) {
    console.error('usage: node validate-skills.mjs <repo-root>');
    process.exit(2);
}

const errors = [];
const warnings = [];
const err = (f, m) => errors.push(`${f}: ${m}`);
const warn = (f, m) => warnings.push(`${f}: ${m}`);

const skillsDir = join(root, 'dodo-payments');
const dirs = readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory()).sort();

// name field is allowed to differ from dir only for this one legacy case
const NAME_EXCEPTIONS = { 'best-practices': 'dodo-best-practices' };

// Banned content. Each: [regex, human explanation]
const BANNED = [
    [/api\.dodopayments\.com/, 'dead hostname (no DNS record) — use live./test.dodopayments.com'],
    [/\bsk_(test|live)_/, 'Stripe key format — Dodo uses dodo_test_ / dodo_live_'],
    [/\bpk_(test|live)_/, 'Stripe-style publishable API key - Dodo issues no such credential'],
    // NOTE: `publishable_key` IS a real field on CheckoutSessionResponse (returned
    // with `client_secret` when confirm=true), so the bare word must not be banned.
    // What must never appear is treating it as a client-side API *credential*.
    [
        /(?:apiKey|api_key)\s*[:=]\s*['"`]?(?:your[_-]?)?publishable|NEXT_PUBLIC_[A-Z_]*PUBLISHABLE|PUBLISHABLE_(?:API_)?KEY\s*=/,
        'publishable_key is a per-session checkout field, not an API credential',
    ],
    [/createPortalSession/, 'not a real method — use customers.customerPortal.create(id, {...})'],
    [/payments\.create\s*\(/, 'deprecated — use checkoutSessions.create()'],
    [/createHmac\(\s*['"]sha256['"]\s*\)?/, 'hand-rolled webhook HMAC is forbidden — use webhooks.unwrap() or standardwebhooks'],
    [/@ts-(ignore|expect-error)/, 'type suppression'],
    [/\bas any\b/, 'type suppression'],
    [/dodopayments-webhooks/, 'deprecated third-party package'],
    [/proration_behavior/, 'wrong param name — plan changes use proration_billing_mode'],
];

// Signing-string check: if a skill shows the algorithm it must include all three parts.
const SIGNING_HINT = /webhook-id\s*\.\s*webhook-timestamp|webhook-id`?\s*\+|\$\{?webhookId\}?\./;

const seenNames = new Map();

for (const dir of dirs) {
    const file = join(skillsDir, dir, 'SKILL.md');
    const rel = `dodo-payments/${dir}/SKILL.md`;
    if (!existsSync(file)) {
        err(rel, 'missing SKILL.md');
        continue;
    }
    const raw = readFileSync(file, 'utf8');

    // --- frontmatter ---
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
    if (!fm) {
        err(rel, 'missing or malformed YAML frontmatter');
        continue;
    }
    const body = raw.slice(fm[0].length);
    const nameM = fm[1].match(/^name:\s*(.+)$/m);
    const descM = fm[1].match(/^description:\s*(.+)$/m);
    if (!nameM) err(rel, 'frontmatter missing `name`');
    if (!descM) err(rel, 'frontmatter missing `description`');

    if (nameM) {
        const name = nameM[1].trim();
        const expected = NAME_EXCEPTIONS[dir] ?? dir;
        if (name !== expected) err(rel, `frontmatter name "${name}" != expected "${expected}"`);
        if (seenNames.has(name)) err(rel, `duplicate skill name "${name}" (also in ${seenNames.get(name)})`);
        seenNames.set(name, rel);
    }
    if (descM) {
        const d = descM[1].trim();
        if (d.length < 40) warn(rel, `description is very short (${d.length} chars) — weakens skill matching`);
        if (d.length > 400) warn(rel, `description is very long (${d.length} chars)`);
    }

    // extra frontmatter keys
    for (const line of fm[1].split('\n')) {
        const k = line.match(/^([a-zA-Z_-]+):/);
        if (k && !['name', 'description'].includes(k[1])) warn(rel, `unexpected frontmatter key "${k[1]}"`);
    }

    // --- banned content ---
    // Only CODE is held to the API-shape rules. Prose is where "never do X" warnings live,
    // so prose is only flagged when it asserts the bad pattern without negating it.
    // Code fences introduced as negative examples ("Wrong:", "Don't:", "Incorrect") are skipped.
    const lines = body.split('\n');
    const NEGATION = /\b(never|not|no|none|don't|do not|avoid|wrong|incorrect|dead|deprecated|does not exist|doesn't exist|instead of|rather than|is secret)\b/i;
    const NEG_EXAMPLE = /\b(wrong|incorrect|don't|do not|avoid|bad|anti-pattern|broken|never)\b/i;

    let inFence = false;
    let fenceIsNegative = false;
    lines.forEach((line, idx) => {
        const lineNo = idx + 2; // +1 for 0-index, +1 for frontmatter offset approximation
        if (/^```/.test(line)) {
            if (!inFence) {
                // look back up to 4 non-empty lines for a negative-example marker
                let marker = false;
                for (let j = idx - 1, seen = 0; j >= 0 && seen < 4; j--) {
                    if (!lines[j].trim()) continue;
                    seen++;
                    if (NEG_EXAMPLE.test(lines[j])) { marker = true; break; }
                    if (/^#{1,6}\s/.test(lines[j])) break; // stop at a heading
                }
                fenceIsNegative = marker;
                inFence = true;
            } else {
                inFence = false;
                fenceIsNegative = false;
            }
            return;
        }

        for (const [re, why] of BANNED) {
            if (!re.test(line)) continue;
            if (inFence) {
                if (fenceIsNegative) continue; // deliberate counter-example
                err(rel, `line ${lineNo} (code): ${why} -> ${line.trim().slice(0, 100)}`);
            } else {
                // prose: only an error if stated affirmatively
                if (!NEGATION.test(line)) {
                    err(rel, `line ${lineNo} (prose): ${why} -> ${line.trim().slice(0, 100)}`);
                }
            }
        }
    });

    // --- webhook signing string sanity ---
    if (/timestamp\s*\}?\s*\.\s*\$?\{?payload/i.test(body) && !SIGNING_HINT.test(body)) {
        err(rel, 'shows a signed message of timestamp.payload without webhook-id — signatures will never validate');
    }

    // --- code fences must be tagged and balanced ---
    const fences = body.match(/^```.*$/gm) ?? [];
    if (fences.length % 2 !== 0) err(rel, `unbalanced code fences (${fences.length})`);
    fences.forEach((f, i) => {
        if (i % 2 === 0 && f.trim() === '```') err(rel, 'untagged code fence — every block needs a language');
    });

    // --- empty catch blocks ---
    if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(body)) err(rel, 'empty catch block');

    // --- emoji ---
    if (/[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{2600}-\u{26FF}]/u.test(body)) {
        warn(rel, 'contains emoji (house style says none)');
    }

    if (body.split('\n').length < 40) warn(rel, 'suspiciously short skill');
}

// --- marketplace.json ---
const mpPath = join(root, '.claude-plugin', 'marketplace.json');
if (!existsSync(mpPath)) {
    err('.claude-plugin/marketplace.json', 'missing');
} else {
    let mp;
    try {
        mp = JSON.parse(readFileSync(mpPath, 'utf8'));
    } catch (e) {
        err('.claude-plugin/marketplace.json', `invalid JSON: ${e.message}`);
    }
    if (mp) {
        const listed = new Set();
        for (const p of mp.plugins ?? []) {
            if (!p.name) err('marketplace.json', 'plugin entry missing name');
            if (!p.description) err('marketplace.json', `plugin "${p.name}" missing description`);
            for (const s of p.skills ?? []) {
                const abs = join(root, s);
                if (!existsSync(join(abs, 'SKILL.md'))) {
                    err('marketplace.json', `plugin "${p.name}" -> "${s}" has no SKILL.md`);
                }
                listed.add(s.replace(/^\.\//, '').replace(/\/$/, ''));
            }
        }
        for (const dir of dirs) {
            const key = `dodo-payments/${dir}`;
            if (!listed.has(key)) err('marketplace.json', `skill directory "${key}" is not registered`);
        }
    }
}

// --- README coverage ---
const readmePath = join(root, 'README.md');
if (existsSync(readmePath)) {
    const readme = readFileSync(readmePath, 'utf8');
    for (const dir of dirs) {
        if (!readme.includes(`dodo-payments/${dir}`)) {
            err('README.md', `skill "${dir}" is not listed in the README table`);
        }
    }
} else {
    err('README.md', 'missing');
}

// --- report ---
console.log(`Scanned ${dirs.length} skills in ${root}\n`);
if (warnings.length) {
    console.log(`WARNINGS (${warnings.length}):`);
    for (const w of warnings) console.log('  ! ' + w);
    console.log();
}
if (errors.length) {
    console.log(`ERRORS (${errors.length}):`);
    for (const e of errors) console.log('  x ' + e);
    console.log('\nFAILED');
    process.exit(1);
}
console.log('All checks passed.');
