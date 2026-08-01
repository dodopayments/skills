#!/usr/bin/env node
/**
 * Type-check every TypeScript example in every SKILL.md against the real
 * `dodopayments` SDK types.
 *
 * The skills are pasted verbatim into agent context, so a wrong field name
 * propagates as reliably as a wrong hostname — and fails silently rather than
 * loudly. Prose review does not reliably catch that class of error; the
 * compiler does.
 *
 * How it works
 *   1. Extract every ```typescript / ```ts fenced block from each SKILL.md.
 *   2. Skip blocks marked as deliberate counter-examples ("Wrong:", "Broken:",
 *      "Anti-pattern") — those are supposed to be incorrect.
 *   3. Wrap each block in a module with the SDK imported and a permissive
 *      ambient preamble that declares app-level helpers (db, grantAccess, ...)
 *      as `any`, so we only surface SDK-shape errors, not missing-app-code noise.
 *   4. Compile the whole set with tsc and map diagnostics back to
 *      SKILL.md:<line>.
 *
 * Usage:
 *   node scripts/typecheck-examples.mjs           # report
 *   node scripts/typecheck-examples.mjs --json    # machine readable
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = join(ROOT, 'dodo-payments');
const WORK = join(ROOT, '.typecheck-tmp');
const JSON_OUT = process.argv.includes('--json');

/** Fences we attempt to compile. */
const TS_LANGS = new Set(['typescript', 'ts', 'tsx']);

/**
 * A block is a deliberate counter-example if the nearby preceding prose says so.
 * Those blocks are *meant* to be wrong and must not be type-checked.
 */
const NEGATIVE_MARKER = /\b(wrong|incorrect|don't|do not|avoid|bad|anti-pattern|broken|never|fails|mistake)\b/i;

/**
 * App-level identifiers that skills legitimately reference without defining.
 * Declaring them `any` keeps the signal on SDK shapes.
 */
const PREAMBLE = `
/* eslint-disable */
import DodoPayments from 'dodopayments';

// Most blocks use \`client\` without re-constructing it (it is set up in an
// earlier block of the same SKILL.md). Without a TYPED declaration here, the
// identifier resolves to \`any\` and the SDK is never actually checked - which
// is precisely how a "clean" run can hide every field-name error.
// Blocks that do declare their own \`const client\` shadow this legally.
declare const client: DodoPayments;
declare const dodo: DodoPayments;
declare const dodoClient: DodoPayments;

declare var db: any;
declare var prisma: any;
declare var redis: any;
declare var queue: any;
declare var eventQueue: any;
declare var Worker: any;
declare var Queue: any;
declare var app: any;
declare var express: any;
declare var req: any;
declare var res: any;
declare var request: any;
declare var response: any;
declare var next: any;
declare var logger: any;
declare var console: any;
// Typed deliberately: env vars are \`string | undefined\`, and the SDK's
// \`environment\` option is a narrow union. Leaving this \`any\` would hide the
// very common mistake of passing an unnarrowed env var straight through.
declare var process: { env: Record<string, string | undefined>; [k: string]: any };
declare var fetch: any;
declare var Buffer: any;
declare var crypto: any;
declare var NextResponse: any;
declare var NextRequest: any;
declare var authClient: any;
declare var auth: any;
declare var config: any;
declare var Conf: any;
declare var machineIdSync: any;
declare var Store: any;
declare function grantAccess(...args: any[]): any;
declare function revokeAccess(...args: any[]): any;
declare function grantCustomerAccess(...args: any[]): any;
declare function revokeCustomerAccess(...args: any[]): any;
declare function restoreCustomerAccess(...args: any[]): any;
declare function handlePaymentSucceeded(...args: any[]): any;
declare function handleSubscriptionActive(...args: any[]): any;
declare function markDisputeResolved(...args: any[]): any;
declare function getLicenseKeyIdsForSubscription(...args: any[]): any;
declare function notify(...args: any[]): any;
declare function sendEmail(...args: any[]): any;
declare function getUser(...args: any[]): any;
declare function requireUser(...args: any[]): any;
declare function lookupProductId(...args: any[]): any;
declare function planToProductId(...args: any[]): any;
`;

/**
 * Skills legitimately elide irrelevant arguments as `{...}`. That is not valid
 * TypeScript, and an unparseable file gets NO semantic checking at all - which
 * would silently hide every type error in it. Normalize the elisions instead.
 */
function normalizeElisions(code) {
    let out = code
        // `foo({...})` -> `foo({} as any)`
        .replace(/\{\s*\.\.\.\s*\}/g, '{} as any')
        // `product_cart: [...]` -> `product_cart: ([] as any)`
        .replace(/\[\s*\.\.\.\s*\]/g, '([] as any)')
        // `unwrap(...)` -> spread of any[], which satisfies any arity so we do
        // not invent false "expected 2 arguments" errors on elided calls.
        .replace(/\(\s*\.\.\.\s*\)/g, '(...([] as any[]))')
        // a line consisting only of `...` or `...,`
        .replace(/^([ \t]*)\.\.\.[ \t]*,?[ \t]*$/gm, '$1// ...');

    // Some blocks are switch-case fragments shown without the enclosing switch.
    if (/^\s*case\s+['"]/m.test(out) && !/\bswitch\s*\(/.test(out)) {
        out = `switch ((null as any)) {\n${out}\n}`;
    }
    return out;
}

/** JSX needs a .tsx extension or it will not parse. */
function looksLikeJsx(code) {
    return /<\/[A-Za-z][\w.]*>|<[A-Z][\w.]*[\s/>]|<>/.test(code);
}

/**
 * `export` is only legal at module top level, but we wrap blocks in a function
 * so top-level await works. Framework examples (Next.js route handlers etc.)
 * are full of `export const GET = ...`. Strip the modifier - it does not affect
 * the type checking we care about, and leaving it makes the file unparseable,
 * which would silently skip the whole file.
 */
function stripExports(code) {
    return code
        .replace(/^(\s*)export\s+default\s+(function|class|async\s+function)\b/gm, '$1$2')
        .replace(/^(\s*)export\s+default\s+/gm, '$1const __default__ = ')
        .replace(/^(\s*)export\s+(?=(const|let|var|function|async|class|interface|type|enum|abstract)\b)/gm, '$1')
        .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '');
}

/**
 * Imports are only legal at module top level, but we wrap each block in a
 * function so top-level await works. Hoist any import statements out.
 */
function hoistImports(code) {
    const imports = [];
    const rest = [];
    for (const line of code.split('\n')) {
        if (/^\s*import\s.+from\s+['"][^'"]+['"];?\s*$/.test(line) || /^\s*import\s+['"][^'"]+['"];?\s*$/.test(line)) {
            // The preamble already imports the SDK; re-importing it collides.
            if (/from\s+['"]dodopayments['"]/.test(line)) continue;
            imports.push(line.trim());
        } else {
            rest.push(line);
        }
    }
    return { imports: imports.join('\n'), body: rest.join('\n') };
}

function listSkillDirs() {
    return readdirSync(SKILLS_DIR)
        .filter((d) => statSync(join(SKILLS_DIR, d)).isDirectory())
        .sort();
}

/**
 * Extract compilable TS blocks with their 1-based start line in the source file.
 */
function extractBlocks(md) {
    const lines = md.split('\n');
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
        const open = lines[i].match(/^```([a-zA-Z]*)\s*$/);
        if (!open) {
            i++;
            continue;
        }
        const lang = open[1].toLowerCase();
        // find close
        let j = i + 1;
        while (j < lines.length && !/^```\s*$/.test(lines[j])) j++;

        if (TS_LANGS.has(lang)) {
            // negative-example detection: scan back up to 4 non-empty lines
            let negative = false;
            for (let k = i - 1, seen = 0; k >= 0 && seen < 4; k--) {
                if (!lines[k].trim()) continue;
                seen++;
                if (NEGATIVE_MARKER.test(lines[k])) {
                    negative = true;
                    break;
                }
                if (/^#{1,6}\s/.test(lines[k])) break;
            }
            if (!negative) {
                blocks.push({
                    startLine: i + 2, // first line of code, 1-based
                    code: lines.slice(i + 1, j).join('\n'),
                });
            }
        }
        i = j + 1;
    }
    return blocks;
}

function main() {
    if (!existsSync(join(ROOT, 'node_modules', 'dodopayments'))) {
        console.error(
            'dodopayments is not installed. Run `npm install` in the repo root first.',
        );
        process.exit(2);
    }

    rmSync(WORK, { recursive: true, force: true });
    mkdirSync(WORK, { recursive: true });

    /** @type {Map<string,{file:string,startLine:number,offset:number}>} */
    const index = new Map();
    let n = 0;

    for (const dir of listSkillDirs()) {
        const rel = `dodo-payments/${dir}/SKILL.md`;
        const md = readFileSync(join(SKILLS_DIR, dir, 'SKILL.md'), 'utf8');
        for (const b of extractBlocks(md)) {
            const normalized = stripExports(normalizeElisions(b.code));
            const { imports, body: inner } = hoistImports(normalized);
            const ext = looksLikeJsx(normalized) ? 'tsx' : 'ts';
            const name = `case_${String(n).padStart(4, '0')}.${ext}`;

            const header = `${PREAMBLE}\n${imports}\nexport {};\nasync function __case() {\n`;
            const body = `${header}${inner}\n}\nvoid __case;\n`;
            writeFileSync(join(WORK, name), body);
            index.set(name, {
                file: rel,
                startLine: b.startLine,
                // lines added before the user's code begins. Imports were
                // hoisted out of the body, so account for how many were moved.
                offset: header.split('\n').length - 1,
                hoisted: imports ? imports.split('\n').length : 0,
            });
            n++;
        }
    }

    writeFileSync(
        join(WORK, 'tsconfig.json'),
        JSON.stringify(
            {
                compilerOptions: {
                    target: 'ES2022',
                    module: 'ESNext',
                    moduleResolution: 'bundler',
                    jsx: 'preserve',
                    strict: false,
                    noImplicitAny: false,
                    skipLibCheck: true,
                    noEmit: true,
                    allowJs: false,
                    esModuleInterop: true,
                    baseUrl: '.',
                    paths: { '*': ['../node_modules/*'] },
                    types: [],
                },
                include: ['*.ts', '*.tsx'],
            },
            null,
            2,
        ),
    );

    // tsc suppresses ALL semantic diagnostics program-wide when any file has a
    // syntax error. So: pass 1 finds unparseable files, pass 2 excludes them and
    // type-checks the rest. Without this, a single bad block hides every real
    // error in all 17 skills.
    const runTsc = (exclude = []) => {
        const cfg = JSON.parse(readFileSync(join(WORK, 'tsconfig.json'), 'utf8'));
        cfg.exclude = exclude;
        writeFileSync(join(WORK, 'tsconfig.json'), JSON.stringify(cfg, null, 2));
        const r = spawnSync(
            process.execPath,
            [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(WORK, 'tsconfig.json'), '--pretty', 'false'],
            { encoding: 'utf8' },
        );
        return (r.stdout || '') + (r.stderr || '');
    };

    const pass1 = runTsc();
    const broken = new Set();
    for (const line of pass1.split('\n')) {
        const m = line.match(/(?:^|[/\\])(case_\d+\.tsx?)\(\d+,\d+\):\s+error\s+TS1\d{3}:/);
        if (m) broken.add(m[1]);
    }

    const out = broken.size ? pass1 + '\n' + runTsc([...broken]) : pass1;
    const diags = [];
    const unparseable = [];
    let sdkResolutionFailed = false;

    for (const line of out.split('\n')) {
        // tsc prints paths relative to cwd, e.g. `.typecheck-tmp/case_0001.ts(42,13): error ...`
        const m = line.match(/(?:^|[/\\])(case_\d+\.tsx?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/);
        if (!m) continue;
        const [, name, lineNo, , code, message] = m;
        const meta = index.get(name);
        if (!meta) continue;

        const srcLine = meta.startLine + (Number(lineNo) - meta.offset);
        const entry = { file: meta.file, line: srcLine, code, message };

        // A file that fails to PARSE gets no semantic checking at all, so every
        // type error inside it would be silently hidden. Surface these loudly
        // rather than letting them masquerade as a clean run.
        if (/^TS1\d{3}$/.test(code)) {
            unparseable.push(entry);
            continue;
        }

        if (code === 'TS2307') {
            // Non-SDK imports (next/server, express, @dodopayments/*) are not
            // installed and are expected to be unresolvable. But if the SDK
            // itself cannot resolve, every check below is meaningless.
            if (/'dodopayments'/.test(message)) sdkResolutionFailed = true;
            continue;
        }

        // Undeclared app-level identifiers are not what we are testing.
        if (code === 'TS2304' || code === 'TS2552') continue;
        if (/Cannot find namespace/.test(message)) continue;
        // Artifacts of compiling doc fragments in isolation, not SDK errors.
        if (code === 'TS2451' || code === 'TS2440' || code === 'TS2393') continue; // redeclare
        if (code === 'TS2686' || code === 'TS6133') continue;
        if (code === 'TS2528' || code === 'TS2323') continue;
        // Runtime/framework globals we deliberately do not ship types for
        // (Astro/Vite import.meta.env, Bun, Electron preload, DOM extras).
        // These are not SDK-shape errors.
        if (/'env' does not exist on type 'ImportMeta'/.test(message)) continue;
        if (code === 'TS2868' || /Cannot find name 'Bun'/.test(message)) continue;
        if (/does not exist on type 'Window/.test(message)) continue;
        // Artifacts of our own elision normalization / isolated fragments.
        if (code === 'TS2556' || code === 'TS2347' || code === 'TS18004') continue;

        // Deduplicate: pass 1 and pass 2 overlap.
        if (diags.some((d) => d.file === entry.file && d.line === entry.line && d.code === code)) continue;

        diags.push(entry);
    }

    if (sdkResolutionFailed) {
        console.error(
            "FATAL: the 'dodopayments' module did not resolve, so no SDK types were checked.\n" +
            'Run `npm install` in the repo root. Refusing to report a passing run.',
        );
        rmSync(WORK, { recursive: true, force: true });
        process.exit(2);
    }

    rmSync(WORK, { recursive: true, force: true });

    if (JSON_OUT) {
        console.log(JSON.stringify(diags, null, 2));
        process.exit(diags.length ? 1 : 0);
    }

    console.log(`Type-checked ${n} TypeScript examples across ${listSkillDirs().length} skills.\n`);

    if (unparseable.length) {
        const files = new Map();
        for (const u of unparseable) {
            if (!files.has(u.file)) files.set(u.file, []);
            files.get(u.file).push(u);
        }
        console.log(`SYNTAX ERRORS - these blocks got NO type checking (${unparseable.length}):`);
        for (const [file, list] of [...files.entries()].sort()) {
            for (const u of list.slice(0, 3)) {
                console.log(`  ${file}:${u.line} ${u.code}: ${u.message}`);
            }
            if (list.length > 3) console.log(`  ${file}: ...and ${list.length - 3} more`);
        }
        console.log();
    }

    if (!diags.length && !unparseable.length) {
        console.log('No SDK type errors found.');
        return;
    }

    const byFile = new Map();
    for (const d of diags) {
        if (!byFile.has(d.file)) byFile.set(d.file, []);
        byFile.get(d.file).push(d);
    }

    for (const [file, list] of [...byFile.entries()].sort()) {
        console.log(`${file} (${list.length})`);
        for (const d of list.sort((a, b) => a.line - b.line)) {
            console.log(`  L${d.line} ${d.code}: ${d.message}`);
        }
        console.log();
    }

    console.log(`${diags.length} type error(s) across ${byFile.size} file(s).`);
    if (unparseable.length) console.log(`${unparseable.length} block(s) failed to parse.`);
    process.exit(1);
}

main();
