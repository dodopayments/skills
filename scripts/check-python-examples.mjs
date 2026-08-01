#!/usr/bin/env node
/**
 * Type-check every Python example in every SKILL.md against the real
 * `dodopayments` Python SDK types.
 *
 * The skills are pasted verbatim into agent context, so a wrong parameter type
 * propagates as reliably as a wrong hostname — and fails silently rather than
 * loudly. The most dangerous case here is concrete: the client's `environment`
 * option is typed `Literal["live_mode", "test_mode"] | NotGiven`, and passing an
 * unnarrowed `os.getenv(...)` (which is `str | None`) both type-errors AND blows
 * up at runtime with `ValueError: Unknown environment: None`. Prose review does
 * not reliably catch that class of error; the type checker does.
 *
 * How it works
 *   1. Extract every ```python fenced block from each SKILL.md.
 *   2. Skip blocks marked as deliberate counter-examples ("**Wrong:**", etc.)
 *      or with an explicit opt-out comment — those are supposed to be incorrect.
 *   3. Emit each block at MODULE LEVEL (Python is indentation-sensitive, so
 *      wrapping in a function would change indentation and break the mapping)
 *      with a fixed-height preamble that binds commonly-referenced names —
 *      crucially a REAL `client: DodoPayments`, so field/argument errors on the
 *      SDK surface even in fragment blocks that never re-construct the client.
 *   4. Run pyright against a venv that has the REAL `dodopayments` installed and
 *      map diagnostics back to SKILL.md:<line>.
 *
 * Why pyright (not mypy)
 *   pyright understands `Literal` narrowing and `NotGiven` overloads out of the
 *   box, reports precise `reportArgumentType` on the exact expression, emits
 *   machine-readable JSON with 0-based line/character ranges (so the mapping is
 *   exact, not a regex guess), and runs non-interactively via `npx pyright` on
 *   GitHub Actions ubuntu-latest with zero extra setup. mypy would need a
 *   config, stub coordination, and is fussier about our synthetic preamble.
 *
 * Usage:
 *   node scripts/check-python-examples.mjs           # report
 *   node scripts/check-python-examples.mjs --json    # machine readable
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = join(ROOT, 'dodo-payments');
const WORK = join(ROOT, '.pycheck-tmp');
// Persisted across runs so the venv (the slow part) is created once and reused.
// This dir is gitignored; see .gitignore.
const VENV_ROOT = join(ROOT, '.python-check-venv');
const VENV = join(VENV_ROOT, 'venv');
const JSON_OUT = process.argv.includes('--json');

/** Fences we attempt to check. */
const PY_LANGS = new Set(['python', 'py']);

/**
 * A block is a deliberate counter-example only when it is EXPLICITLY labelled
 * as one — a bolded label such as `**Wrong:**`, or an opt-out comment.
 *
 * Inferring intent from bare prose ("this fails if...") silently removes
 * coverage; requiring a marker makes opting out deliberate and greppable. This
 * mirrors the TypeScript checker so the two behave identically.
 */
const NEGATIVE_MARKER =
    /(?:\*\*|__)\s*(?:wrong|incorrect|don't|do not|avoid|bad|anti-pattern|broken|unsafe|never)\b[^*_\n]{0,60}?(?:\*\*|__)/i;

/** Explicit, greppable opt-out for blocks that cannot check by design. */
const SKIP_COMMENT = /<!--\s*(?:typecheck|pycheck):\s*skip\s*-->/i;

/**
 * Fixed-height preamble emitted before every block. Its line count never
 * changes, so the source-line mapping is a single fixed offset rather than a
 * per-block arithmetic correction.
 *
 * The `client`/`dodo` bindings are the whole point: most blocks use `client`
 * without re-constructing it (it is set up in an earlier block of the same
 * SKILL.md). Binding it to the REAL `DodoPayments` type via `cast` — rather than
 * leaving it undefined or stubbing it as `Any` — is what lets a field-name or
 * argument-type error surface. A bare annotation (`client: DodoPayments`) makes
 * pyright treat the name as *unbound*; `cast(..., None)` gives it a real value
 * of the real type. We deliberately do NOT stub `DodoPayments` itself, so every
 * SDK type error stays real.
 *
 * `os`, `logging`, `typing` etc. are real stdlib imports (no stubbing needed).
 * App-level helpers the skills legitimately reference without defining are
 * bound loosely so they generate no noise; anything SDK-shaped is left real.
 */
const PREAMBLE_LINES = [
    'from typing import cast as _cast, Any as _Any',
    'from dodopayments import DodoPayments as _DodoPayments',
    '# Typed to the REAL SDK so field/arg errors surface in fragment blocks that',
    '# reference `client` from an earlier block without re-constructing it.',
    'client = _cast(_DodoPayments, None)',
    'dodo = _cast(_DodoPayments, None)',
    'dodo_client = _cast(_DodoPayments, None)',
    '# App-level identifiers skills reference without defining. Bound to Any so',
    '# they are noise-free; nothing SDK-shaped is hidden by these.',
    'user: _Any = None',
    'db: _Any = None',
    'request: _Any = None',
    'response: _Any = None',
    'logger: _Any = None',
    'app: _Any = None',
    'config: _Any = None',
    'get_current_user: _Any = None',
    'grant_access: _Any = None',
    'revoke_access: _Any = None',
    'send_email: _Any = None',
    'notify: _Any = None',
];
const PREAMBLE = PREAMBLE_LINES.join('\n') + '\n';
// Every block body starts exactly this many lines into the emitted file, so
// body line 1 maps to SKILL.md startLine with a single fixed offset.
const PREAMBLE_HEIGHT = PREAMBLE_LINES.length;

/**
 * Hoist `import`/`from ... import` statements out of the block body.
 *
 * Imports are legal at module level (we emit at module level), but if a block
 * re-imports `DodoPayments` it collides with the preamble's alias only in name,
 * not identity — Python allows the rebind, and pyright still checks the SDK.
 * We keep imports where they are EXCEPT we must ensure the block does not shadow
 * our typed `client`/`dodo` with an untyped one in a way that hides errors; it
 * does not, because a real `DodoPayments(...)` construction is itself checked.
 *
 * Each block is emitted verbatim after the preamble — no line is added or
 * removed inside the body — so the mapping stays exact. We intentionally do NOT
 * rewrite the body (unlike the TS checker's elision normalization); the Python
 * examples here are complete, parseable fragments and rewriting them risks
 * shifting lines or masking errors.
 */

function listSkillDirs() {
    return readdirSync(SKILLS_DIR)
        .filter((d) => statSync(join(SKILLS_DIR, d)).isDirectory())
        .sort();
}

/**
 * Extract checkable Python blocks with their 1-based start line in the source.
 */
function extractBlocks(md) {
    const lines = md.split('\n');
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
        const open = lines[i].match(/^```([a-zA-Z0-9]*)\s*$/);
        if (!open) {
            i++;
            continue;
        }
        const lang = open[1].toLowerCase();
        // find close
        let j = i + 1;
        while (j < lines.length && !/^```\s*$/.test(lines[j])) j++;

        if (PY_LANGS.has(lang)) {
            // Explicit markers only, and only in the 2 non-blank lines above.
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

function venvPython() {
    const isWin = process.platform === 'win32';
    return join(VENV, isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');
}

/**
 * Create the venv with the real `dodopayments` SDK if it is not already there.
 * Reused across runs (the install is the slow part). Fully automatic — no
 * manual setup step — and non-interactive so it works on CI.
 */
function ensureVenv() {
    // Derive the interpreter path from the PLATFORM, not from whether a
    // directory happens to exist yet. Probing `VENV/bin` before the venv is
    // created always misses on a cold start and silently selects the Windows
    // `Scripts/` layout, so the first run on POSIX could never succeed.
    const py = venvPython();

    // Reuse if the venv exists AND already resolves dodopayments. A half-built
    // venv (interrupted install) would otherwise masquerade as ready and make
    // the whole run silently check nothing.
    if (existsSync(py)) {
        const probe = spawnSync(py, ['-c', 'import dodopayments'], { encoding: 'utf8' });
        if (probe.status === 0) return py;
    }

    console.error('Setting up Python venv with the dodopayments SDK (one-time)...');
    mkdirSync(VENV_ROOT, { recursive: true });
    const mk = spawnSync('python3', ['-m', 'venv', VENV], { encoding: 'utf8', stdio: 'inherit' });
    if (mk.status !== 0) {
        console.error('FATAL: could not create a Python venv with `python3 -m venv`.');
        process.exit(2);
    }
    const install = spawnSync(
        py,
        ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', 'dodopayments'],
        { encoding: 'utf8', stdio: 'inherit' },
    );
    if (install.status !== 0) {
        console.error('FATAL: `pip install dodopayments` failed. Refusing to report a passing run.');
        process.exit(2);
    }
    const probe = spawnSync(py, ['-c', 'import dodopayments'], { encoding: 'utf8' });
    if (probe.status !== 0) {
        console.error('FATAL: dodopayments did not import after install. Refusing to report a passing run.');
        process.exit(2);
    }
    return py;
}

function main() {
    ensureVenv();

    rmSync(WORK, { recursive: true, force: true });
    mkdirSync(WORK, { recursive: true });

    /** @type {Map<string,{file:string,startLine:number,offset:number}>} */
    const index = new Map();
    let n = 0;

    for (const dir of listSkillDirs()) {
        const rel = `dodo-payments/${dir}/SKILL.md`;
        const md = readFileSync(join(SKILLS_DIR, dir, 'SKILL.md'), 'utf8');
        for (const b of extractBlocks(md)) {
            const name = `case_${String(n).padStart(4, '0')}.py`;
            // Preamble is a fixed height; the block body follows verbatim so no
            // line inside it is shifted. body line 1 == emitted line PREAMBLE_HEIGHT+1.
            const body = `${PREAMBLE}${b.code}\n`;
            writeFileSync(join(WORK, name), body);
            index.set(name, {
                file: rel,
                startLine: b.startLine,
                offset: PREAMBLE_HEIGHT,
            });
            n++;
        }
    }

    // Point pyright at the venv so `dodopayments` resolves to the REAL package.
    // basic mode surfaces argument/return/attribute errors (incl. reportArgumentType
    // for the Literal `environment` mismatch) without the strict-mode noise that
    // would drown real SDK errors in unrelated `Unknown`/`reportUnknown*` churn.
    writeFileSync(
        join(WORK, 'pyrightconfig.json'),
        JSON.stringify(
            {
                venvPath: VENV_ROOT,
                venv: 'venv',
                include: ['*.py'],
                typeCheckingMode: 'basic',
                reportMissingImports: true,
                reportMissingModuleSource: false,
            },
            null,
            2,
        ),
    );

    const r = spawnSync(
        'npx',
        ['--yes', 'pyright', '--project', WORK, '--outputjson'],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    const raw = r.stdout || '';

    let report;
    try {
        report = JSON.parse(raw);
    } catch {
        console.error('FATAL: could not parse pyright output. Refusing to report a passing run.');
        console.error((r.stderr || '').slice(0, 2000));
        rmSync(WORK, { recursive: true, force: true });
        process.exit(2);
    }

    const diags = [];
    let sdkResolutionFailed = false;

    for (const d of report.generalDiagnostics || []) {
        if (d.severity !== 'error') continue;
        const name = (d.file || '').split(/[/\\]/).pop();
        const meta = index.get(name);
        if (!meta) continue;

        const rule = d.rule || '';
        const message = (d.message || '').split('\n')[0];
        // pyright ranges are 0-based; file line = start.line + 1.
        const fileLine = d.range.start.line + 1;
        // Body line 1 sits at file line PREAMBLE_HEIGHT+1 and maps to startLine.
        const srcLine = meta.startLine + (fileLine - meta.offset) - 1;
        const entry = { file: meta.file, line: srcLine, code: rule, message };

        // If the SDK itself does not resolve, every check below is meaningless —
        // surface it as FATAL rather than let a "clean" run hide it.
        if (rule === 'reportMissingImports' || rule === 'reportMissingModuleSource') {
            if (/["']dodopayments["']/.test(message)) sdkResolutionFailed = true;
            // Non-SDK imports (fastapi, flask, django, pydantic, app.*) are not
            // installed and are EXPECTED to be unresolvable. Filter them.
            continue;
        }

        // Undefined app-level identifiers are not what we are testing. The
        // preamble binds the common ones; anything else is app code we do not
        // ship. NEVER filter reportArgumentType / reportCallIssue against the
        // SDK — that is the entire point of this checker.
        if (rule === 'reportUndefinedVariable' || rule === 'reportUnboundVariable') continue;
        // Emitting doc fragments in isolation redeclares names across cases; and
        // `possibly unbound` is an artifact of fragments that assume prior setup.
        if (rule === 'reportRedeclaration' || rule === 'reportPossiblyUnbound') continue;
        // `self`-less / decorator-context artifacts from isolated fragments.
        if (rule === 'reportSelfClsParameterName') continue;

        // Deduplicate identical findings.
        if (diags.some((x) => x.file === entry.file && x.line === entry.line && x.code === rule && x.message === message)) {
            continue;
        }
        diags.push(entry);
    }

    if (sdkResolutionFailed) {
        console.error(
            "FATAL: the 'dodopayments' module did not resolve, so no SDK types were checked.\n" +
            'The venv may be corrupt — delete .python-check-venv and re-run. Refusing to report a passing run.',
        );
        rmSync(WORK, { recursive: true, force: true });
        process.exit(2);
    }

    rmSync(WORK, { recursive: true, force: true });

    if (JSON_OUT) {
        console.log(JSON.stringify(diags.map((d) => ({ file: d.file, line: d.line, message: d.message })), null, 2));
        process.exit(diags.length ? 1 : 0);
    }

    console.log(`Checked ${n} Python examples across ${listSkillDirs().length} skills.\n`);

    if (!diags.length) {
        console.log('No Python type errors found.');
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

    console.log(`${diags.length} type error(s) across ${byFile.size} file(s).`);
    process.exit(1);
}

main();
