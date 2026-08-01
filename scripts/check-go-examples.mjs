#!/usr/bin/env node
/**
 * Compile every Go example in every SKILL.md against the real
 * `github.com/dodopayments/dodopayments-go` SDK.
 *
 * The skills are pasted verbatim into agent context, so a wrong field name
 * propagates as reliably as a wrong hostname — and fails silently rather than
 * loudly. Prose review does not reliably catch that class of error; the
 * compiler does. The TypeScript examples get this via `typecheck-examples.mjs`;
 * this is the Go counterpart.
 *
 * How it works
 *   1. Extract every ```go fenced block from each SKILL.md.
 *   2. Skip blocks marked as deliberate counter-examples ("Wrong:", "Broken:",
 *      "Anti-pattern") — those are supposed to be incorrect.
 *   3. Wrap each block in `package main`: hoist its own imports out, prepend a
 *      fixed supplemental import set plus `ctx`/`client` so bare fragments
 *      compile, and neutralize unused-import noise. A blank line replaces every
 *      hoisted line so reported lines still line up with the original block.
 *   4. `go build` the whole set and map diagnostics back to SKILL.md:<line>.
 *
 * Usage:
 *   node scripts/check-go-examples.mjs           # report
 *   node scripts/check-go-examples.mjs --json    # machine readable
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = join(ROOT, 'dodo-payments');
const WORK = join(ROOT, '.gocheck-tmp');
const JSON_OUT = process.argv.includes('--json');

/**
 * Pinned deliberately. The examples are written against exactly these symbols
 * (option.WithEnvironmentTestMode, param.Field[time.Time] fields, the
 * two-argument Webhooks.Unwrap), so checking them against a floating latest
 * would report drift that the docs never claimed to track. Bump this in lockstep
 * with the version quoted in the skills themselves.
 */
const SDK_MODULE = 'github.com/dodopayments/dodopayments-go';
const SDK_VERSION = 'v1.110.0';

/** Fences we attempt to compile. */
const GO_LANGS = new Set(['go']);

/**
 * A block is a deliberate counter-example only when it is EXPLICITLY labelled
 * as one — a bolded label such as `**Wrong:**`, or an opt-out comment. Same
 * rule as the TS checker: inferring intent from bare prose silently removes
 * coverage, so opting out has to be a marker you can grep for.
 */
const NEGATIVE_MARKER =
    /(?:\*\*|__)\s*(?:wrong|incorrect|don't|do not|avoid|bad|anti-pattern|broken|unsafe|never)\b[^*_\n]{0,60}?(?:\*\*|__)/i;

/** Explicit, greppable opt-out for blocks that cannot compile by design. */
const SKIP_COMMENT = /<!--\s*gocheck:\s*skip\s*-->/i;

/**
 * The fixed supplemental preamble prepended to every block.
 *
 * Fragment blocks reference `client` and `ctx` without constructing them (they
 * were set up in an earlier block of the same SKILL.md). Declaring them at
 * package level keeps such fragments compiling AND keeps the SDK actually
 * checked — an untyped `client` would resolve nothing, which is exactly how a
 * "clean" run hides every method-name error.
 *
 * Blocks that declare their own `client :=` simply shadow this one, which is
 * legal Go.
 *
 * `main` lives here (once) so the package links; every case body is a uniquely
 * named function that Go tolerates being unused at package scope. Go errors on
 * unused IMPORTS and unused LOCAL variables, but never on unused funcs or
 * unused package-level vars, so this file carries the machinery that would
 * otherwise trip those rules.
 */
const SUPPORT = `package main

import (
	"context"

	"github.com/dodopayments/dodopayments-go"
)

var ctx = context.Background()
var client = dodopayments.NewClient()

func main() {}
`;

/**
 * Imports are file-scoped in Go, so each case file must carry the full set it
 * might touch. This is the fixed supplemental import block prepended to every
 * case. Fragments lean on it; blocks with their own `import (...)` get theirs
 * hoisted to blank lines (see hoistImports) and fall back on this set.
 *
 * Each import is immediately referenced by a package-scope `var _ = ...` so an
 * import the block never uses does not trip "imported and not used" — the Go
 * analogue of the TS preamble's `any` declarations. `_ = ctx` / `_ = client`
 * likewise silence the case where a block touches neither.
 */
/** Stdlib qualifiers a skill might use; see the `undefined:` filter below. */
const GO_STDLIB = new Set([
	'os', 'io', 'http', 'time', 'context', 'fmt', 'json', 'errors',
	'strings', 'strconv', 'bytes', 'log', 'sql', 'url',
]);

const FIXED_IMPORTS = `import (
	"io"
	"net/http"
	"os"
	"time"

	"github.com/dodopayments/dodopayments-go"
	"github.com/dodopayments/dodopayments-go/option"
)
`;

/**
 * Reference every fixed import exactly once so unused ones stay quiet — the Go
 * analogue of the TS preamble's `any` declarations. `_ = ctx` / `_ = client`
 * likewise silence the case where a block touches neither. Uses package-scope
 * vars (never an unused-local error). `param` is deliberately absent: it lives
 * under `internal/` in the SDK and is not importable from outside the module;
 * blocks reach `param.Field[T]` through `dodopayments.F(...)`, which is exactly
 * how the docs use it.
 */
const FIXED_NEUTRALIZERS = `var (
	_ = io.ReadAll
	_ = http.MethodGet
	_ = os.Getenv
	_ = time.Now
	_ = option.WithBearerToken
	_ = dodopayments.NewClient
	_ = ctx
	_ = client
)
`;

function listSkillDirs() {
    return readdirSync(SKILLS_DIR)
        .filter((d) => statSync(join(SKILLS_DIR, d)).isDirectory())
        .sort();
}

/**
 * Extract compilable Go blocks with their 1-based start line in the source file.
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

        if (GO_LANGS.has(lang)) {
            // Explicit markers only, and only in the 2 lines immediately above.
            let negative = false;
            for (let k = i - 1, seen = 0; k >= 0 && seen < 2; k--) {
                if (!lines[k].trim()) continue;
                seen++;
                if (SKIP_COMMENT.test(lines[k]) || NEGATIVE_MARKER.test(lines[k])) {
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

/**
 * Hoist any `import "..."` / `import ( ... )` out of the block.
 *
 * Each hoisted line is replaced by a BLANK line rather than removed, so the
 * body keeps the same line count as the original block. That makes the
 * source-line mapping a single fixed offset instead of a per-block correction —
 * the same discipline the TS checker uses so reported line numbers never drift.
 *
 * Blocks that declare their own imports still fall back on FIXED_IMPORTS, which
 * is a superset of what the skills touch; anything they import that we already
 * have resolves identically, and the blanked lines preserve the mapping.
 */
function hoistImports(code) {
    const lines = code.split('\n');
    const out = [];
    let inGroup = false;
    for (const line of lines) {
        if (inGroup) {
            // Inside a parenthesized `import ( ... )`. Blank every line until
            // the closing paren, which we also blank.
            out.push('');
            if (/^\s*\)\s*$/.test(line)) inGroup = false;
            continue;
        }
        if (/^\s*import\s*\(\s*$/.test(line)) {
            inGroup = true;
            out.push('');
            continue;
        }
        // Single-line import: `import "x"` or `import alias "x"`.
        if (/^\s*import\s+(?:[\w.]+\s+)?["`][^"`]+["`]\s*$/.test(line)) {
            out.push('');
            continue;
        }
        out.push(line);
    }
    return out.join('\n');
}

/**
 * Index of the last line belonging to the block's own import declaration, or -1
 * when it has none.
 *
 * Blocks that ship an import group are compiled with THAT group, not a
 * substituted superset. Blanking it and prepending a known-good set validated
 * the statements while silently excusing the snippet's own imports - so a
 * quick-start could call `os.Getenv` without importing `os`, fail the moment a
 * reader pasted it, and still be reported clean.
 */
function findImportEnd(lines) {
    let end = -1;
    let inGroup = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (inGroup) {
            end = i;
            if (/^\s*\)\s*$/.test(line)) inGroup = false;
            continue;
        }
        if (/^\s*import\s*\(\s*$/.test(line)) {
            inGroup = true;
            end = i;
            continue;
        }
        if (/^\s*import\s+(?:[\w.]+\s+)?["`][^"`]+["`]\s*$/.test(line)) {
            end = i;
        }
    }
    return end;
}

/**
 * Does the block open with a top-level declaration (func/type/const/var/package)
 * as its first non-blank, non-import line? Such blocks are near-complete files
 * and go straight into the file body. Everything else is a statement fragment
 * that must live inside a function.
 */
function isFileScope(bodyAfterHoist) {
    for (const line of bodyAfterHoist.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('//')) continue;
        return /^(func|type|const|var|package)\b/.test(t);
    }
    return false;
}

function main() {
    // Locate the module in the local cache before doing anything. If it is
    // absent, every check below is meaningless — refuse to report a passing run,
    // exactly as the TS checker does when `dodopayments` is not installed.
    const goVersion = spawnSync('go', ['version'], { encoding: 'utf8' });
    if (goVersion.status !== 0) {
        console.error('FATAL: `go` is not on PATH. Install Go 1.25+ and retry.');
        process.exit(2);
    }

    rmSync(WORK, { recursive: true, force: true });
    mkdirSync(WORK, { recursive: true });

    writeFileSync(
        join(WORK, 'go.mod'),
        `module dodocheck\n\ngo 1.25\n\nrequire ${SDK_MODULE} ${SDK_VERSION}\n`,
    );
    writeFileSync(join(WORK, 'z_support.go'), SUPPORT);

    /** @type {Map<string,{file:string,startLine:number,offset:number}>} */
    const index = new Map();
    let n = 0;

    for (const dir of listSkillDirs()) {
        const rel = `dodo-payments/${dir}/SKILL.md`;
        const md = readFileSync(join(SKILLS_DIR, dir, 'SKILL.md'), 'utf8');
        for (const b of extractBlocks(md)) {
            const name = `case_${String(n).padStart(4, '0')}.go`;
            const srcLines = b.code.split('\n');
            const impEnd = findImportEnd(srcLines);
            const ownImports = impEnd >= 0;

            let header;
            let footer;
            let body;

            if (ownImports) {
                // Compile the snippet's OWN imports. Nothing is substituted, so
                // a missing or bogus import is a real failure here.
                header = 'package main\n\n';
                const after = srcLines.slice(impEnd + 1).join('\n');
                if (isFileScope(after)) {
                    body = b.code;
                    footer = '\n';
                } else {
                    // Statements need a function, but the opener must sit after
                    // the imports. Consume the blank line that conventionally
                    // follows the group so the body keeps its original line
                    // count and the mapping stays a single fixed offset.
                    const opener = `func case${String(n).padStart(4, '0')}() {`;
                    const blank = srcLines.findIndex((l, i) => i > impEnd && !l.trim());
                    const copy = [...srcLines];
                    if (blank !== -1) copy[blank] = opener;
                    else copy.splice(impEnd + 1, 0, opener);
                    body = copy.join('\n');
                    footer = '\n}\n';
                }
                writeFileSync(join(WORK, name), `${header}${body}${footer}`);
                index.set(name, {
                    file: rel,
                    startLine: b.startLine,
                    offset: header.split('\n').length - 1,
                    ownImports: true,
                });
                n++;
                continue;
            }

            body = hoistImports(b.code);
            if (isFileScope(body)) {
                // Near-complete file (own funcs/types). Drop it in verbatim after
                // the fixed imports; the block's declarations are just more
                // package members. No wrapping function, so nothing to close.
                header = `package main\n\n${FIXED_IMPORTS}\n${FIXED_NEUTRALIZERS}\n`;
                footer = '\n';
            } else {
                // Statement fragment. Wrap in a uniquely named function so bare
                // statements (and any `client :=` that shadows the package var)
                // are legal. `_ = ...`-style neutralizers for locals are not
                // needed at the top level, so we only close the function.
                header = `package main\n\n${FIXED_IMPORTS}\n${FIXED_NEUTRALIZERS}\nfunc case${String(n).padStart(4, '0')}() {\n`;
                footer = '\n}\n';
            }

            writeFileSync(join(WORK, name), `${header}${body}${footer}`);
            index.set(name, {
                file: rel,
                startLine: b.startLine,
                // Lines added before the block body begins. Hoisted imports
                // leave blank lines behind, so the body is line-for-line the
                // same as the original block and no further correction applies.
                offset: header.split('\n').length - 1,
                ownImports: false,
            });
            n++;
        }
    }

    // `go build` reports diagnostics as `./case_0001.go:LINE:COL: message`, one
    // per line, and exits non-zero when any file fails.
    const runBuild = (excludeNames = new Set()) => {
        // Move excluded files aside by renaming to a non-.go extension so the
        // package still links (z_support carries `main`) while the excluded
        // file is invisible to the compiler.
        for (const nm of excludeNames) {
            const p = join(WORK, nm);
            if (existsSync(p)) writeFileSync(p + '.excluded', readFileSync(p)), rmSync(p);
        }
        const r = spawnSync('go', ['build', '-o', join(WORK, 'dodocheck.bin'), './...'], {
            cwd: WORK,
            encoding: 'utf8',
            // `go mod tidy` needs the network the first time to write go.sum;
            // after that the module lives in the cache. Allow the download here
            // and nowhere else.
            env: { ...process.env, GOFLAGS: '-mod=mod' },
        });
        return (r.stdout || '') + (r.stderr || '');
    };

    // Resolve the module (writes go.sum from the cache / a single fetch). If the
    // SDK cannot be found, bail loudly rather than reporting a green run over
    // zero real checks.
    const tidy = spawnSync('go', ['mod', 'tidy'], {
        cwd: WORK,
        encoding: 'utf8',
        env: { ...process.env, GOFLAGS: '-mod=mod' },
    });
    const tidyOut = (tidy.stdout || '') + (tidy.stderr || '');
    if (tidy.status !== 0 || !existsSync(join(WORK, 'go.sum'))) {
        console.error(
            'FATAL: `go mod tidy` failed, so nothing was type-checked.\n' +
            `Usually ${SDK_MODULE} ${SDK_VERSION} is unavailable (not in the module\n` +
            'cache and not reachable). It can also mean a SKILL.md import group names a\n' +
            'package that does not exist - check the resolver output below before\n' +
            'assuming the SDK is at fault.\n' +
            'Refusing to report a passing run.\n\n' +
            tidyOut.trim(),
        );
        rmSync(WORK, { recursive: true, force: true });
        process.exit(2);
    }

    // Go, like tsc, suppresses semantic errors program-wide the moment ANY file
    // has a SYNTAX error. So: pass 1 finds unparseable files, pass 2 excludes
    // them and compiles the rest. Without this a single malformed block would
    // hide every real SDK error in all the others.
    const pass1 = runBuild();
    const broken = new Set();
    for (const line of pass1.split('\n')) {
        const m = line.match(/(?:^|[/\\])(case_\d+\.go):\d+:\d+:\s+syntax error:/);
        if (m) broken.add(m[1]);
    }

    const out = broken.size ? pass1 + '\n' + runBuild(broken) : pass1;

    const diags = [];
    const unparseable = [];
    let sdkResolutionFailed = false;

    for (const line of out.split('\n')) {
        const m = line.match(/(?:^|[/\\])(case_\d+\.go):(\d+):(?:(\d+):)?\s+(.*)$/);
        if (!m) continue;
        const [, name, lineNo, , message] = m;
        const meta = index.get(name);
        if (!meta) continue;

        // Body line 1 sits at file line offset+1 and maps to SKILL.md startLine.
        const srcLine = meta.startLine + (Number(lineNo) - meta.offset) - 1;
        const entry = { file: meta.file, line: srcLine, message: message.trim() };

        // A file that fails to PARSE gets no semantic checking at all, so every
        // type error inside it would be silently hidden. Surface these loudly
        // rather than letting them masquerade as a clean run.
        if (/^syntax error:/.test(entry.message)) {
            unparseable.push(entry);
            continue;
        }

        // If the SDK module itself does not resolve, every "undefined" below is
        // meaningless — treat it as a fatal non-check, not a wall of errors.
        if (/could not import github\.com\/dodopayments\/dodopayments-go/.test(entry.message) ||
            /cannot find module providing package github\.com\/dodopayments\/dodopayments-go/.test(entry.message)) {
            sdkResolutionFailed = true;
            continue;
        }

        // Fragments legitimately reference app-level helpers and packages the
        // skill never defines (a `handlePayment`, a `db`, a non-SDK import).
        // Those are not what we are testing. But NEVER filter an undefined that
        // names an SDK symbol — `undefined: option.WithEnvironment`,
        // `dodopayments.Foo` etc. are the entire point of this check.
        const undef = entry.message.match(/^undefined:\s+([A-Za-z_][\w.]*)/);
        if (undef) {
            const sym = undef[1];
            const isSdk = /^(dodopayments|option|param|ctx|client)\b/.test(sym) || /^dodopayments\./.test(sym);
            // When the block ships its own imports, a bare stdlib qualifier means
            // the published snippet forgot to import it - the exact defect that
            // substituting a known-good import set used to conceal.
            const isMissingStdlib = meta.ownImports && GO_STDLIB.has(sym.split('.')[0]);
            if (!isSdk && !isMissingStdlib) continue;
        }

        // Unused locals/imports are artifacts of compiling a fragment in
        // isolation, never an SDK-shape error. Wrong SDK usage never shows up
        // as "declared and not used".
        if (/declared and not used/.test(entry.message)) continue;
        // Only excusable when WE supplied the imports. When the block ships its
        // own group, an unused import is a defect in the published snippet.
        if (!meta.ownImports && /imported and not used/.test(entry.message)) continue;

        // Deduplicate: pass 1 and pass 2 overlap.
        if (diags.some((d) => d.file === entry.file && d.line === entry.line && d.message === entry.message)) continue;

        diags.push(entry);
    }

    if (sdkResolutionFailed) {
        console.error(
            `FATAL: ${SDK_MODULE} did not resolve, so no SDK types were checked.\n` +
            'Refusing to report a passing run.',
        );
        rmSync(WORK, { recursive: true, force: true });
        process.exit(2);
    }

    rmSync(WORK, { recursive: true, force: true });

    if (JSON_OUT) {
        console.log(JSON.stringify(diags, null, 2));
        process.exit(diags.length ? 1 : 0);
    }

    console.log(`Checked ${n} Go examples across ${listSkillDirs().length} skills.\n`);

    if (unparseable.length) {
        const files = new Map();
        for (const u of unparseable) {
            if (!files.has(u.file)) files.set(u.file, []);
            files.get(u.file).push(u);
        }
        console.log(`SYNTAX ERRORS — these blocks got NO type checking (${unparseable.length}):`);
        for (const [file, list] of [...files.entries()].sort()) {
            for (const u of list.slice(0, 3)) {
                console.log(`  L${u.line} ${u.message}`);
            }
            if (list.length > 3) console.log(`  ${file}: ...and ${list.length - 3} more`);
        }
        console.log();
    }

    if (!diags.length && !unparseable.length) {
        console.log('No Go compile errors found.');
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
            console.log(`  L${d.line} ${d.message}`);
        }
        console.log();
    }

    console.log(`${diags.length} compile error(s) across ${byFile.size} file(s).`);
    if (unparseable.length) console.log(`${unparseable.length} block(s) failed to parse.`);
    process.exit(1);
}

main();
