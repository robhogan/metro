/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Asks Node, webpack and Vite whether a module specifier written with Windows
 * separators is a *relative* specifier. See README.md for why.
 *
 * Specifier strings are escaped exactly once, by JSON.stringify, rather than by
 * hand. Extensions are always explicit: ESM does no extension searching, so an
 * extensionless specifier would fail there for a reason that has nothing to do
 * with separators, and would make the run unreadable.
 */

import {spawnSync} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {fileURLToPath, pathToFileURL} from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// `make` takes the target's filename and the fixture root, and returns the
// specifier to test, so the separator is the only thing that varies within a
// family. `control` cases are pure posix relative: a resolver that fails one is
// misconfigured, and its other answers can't be read.
//
// Absolute cases are here because Metro reaches the same branch by either route
// — `isRelativeImport(specifier) || path.isAbsolute(specifier)` — so a rule that
// covers only relative specifiers would answer half the question.
const CASES = [
  // Relative.
  {id: 'rel-posix-dot', make: f => `./sub/${f}`, control: true},
  {id: 'rel-posix-dotdot', make: f => `../root/sub/${f}`, control: true},
  {id: 'rel-back-dot', make: f => `.\\sub\\${f}`, control: false},
  {id: 'rel-back-dotdot', make: f => `..\\root\\sub\\${f}`, control: false},
  {id: 'rel-mixed-posix-lead', make: f => `./sub\\${f}`, control: false},
  {id: 'rel-mixed-back-lead', make: f => `.\\sub/${f}`, control: false},

  // Absolute. On Windows `abs-native` is backslashed and `abs-posix` is the
  // `C:/…` form; on posix the two coincide, which is itself worth seeing.
  {
    id: 'abs-native',
    make: (f, root) => path.join(root, 'sub', f),
    control: false,
  },
  {
    id: 'abs-posix',
    make: (f, root) => path.join(root, 'sub', f).split(path.sep).join('/'),
    control: false,
  },
  {
    id: 'abs-back',
    make: (f, root) => path.join(root, 'sub', f).split('/').join('\\'),
    control: false,
  },
  // The canonical ESM absolute form, and the reason the question has an answer:
  // ESM specifiers are URLs, and URLs separate with '/'.
  {
    id: 'abs-file-url',
    make: (f, root) => pathToFileURL(path.join(root, 'sub', f)).href,
    control: false,
  },
];

const RESOLVED = 'resolved';
const FAILED = 'failed';
const UNAVAILABLE = 'unavailable';

const CJS_TARGET = 'mod.cjs';
const ESM_TARGET = 'mod.mjs';

/**
 * One-line summary of an error. Node leads its output with a source locator
 * (`node:internal/modules/cjs/loader:1247`) and only reaches the message some
 * lines later, so prefer a recognisable error line and fall back to the locator.
 */
function brief(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('at ') && l !== '^');
  const message = lines.find(l => /^([A-Z]\w*(Error|Exception)\b|Error:)/.test(l));
  return (message ?? lines[0] ?? '(no message)').slice(0, 220);
}

/**
 * Builds the fixture:
 *
 *   <tmp>/root/sub/mod.cjs     target for require() and webpack
 *   <tmp>/root/sub/mod.mjs     target for import and Vite
 *   <tmp>/root/entry-<id>.cjs  requires the specifier
 *   <tmp>/root/entry-<id>.mjs  statically imports the specifier
 *
 * `root/` is nested one level down so the `..` cases have somewhere to go.
 */
function buildFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'separator-probe-'));
  const root = path.join(dir, 'root');
  fs.mkdirSync(path.join(root, 'sub'), {recursive: true});
  fs.writeFileSync(path.join(root, 'sub', CJS_TARGET), 'module.exports = 42;\n');
  fs.writeFileSync(path.join(root, 'sub', ESM_TARGET), 'export default 42;\n');
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({name: 'fixture', version: '0.0.0'}, null, 2),
  );

  for (const c of CASES) {
    fs.writeFileSync(
      path.join(root, `entry-${c.id}.cjs`),
      `require(${JSON.stringify(c.make(CJS_TARGET, root))});\nconsole.log("PROBE_OK");\n`,
    );
    // Static import, not dynamic: it is what a bundler actually analyses, and
    // it avoids top-level await, which needs an esnext target under Vite.
    fs.writeFileSync(
      path.join(root, `entry-${c.id}.mjs`),
      `import ${JSON.stringify(c.make(ESM_TARGET, root))};\nconsole.log("PROBE_OK");\n`,
    );
  }
  return root;
}

function runNode(file, cwd) {
  const out = spawnSync(process.execPath, [file], {cwd, encoding: 'utf8'});
  if (out.status === 0 && (out.stdout ?? '').includes('PROBE_OK')) {
    return {status: RESOLVED, detail: ''};
  }
  return {status: FAILED, detail: brief(out.stderr || out.stdout)};
}

const nodeCjs = (root, c) => runNode(path.join(root, `entry-${c.id}.cjs`), root);
const nodeEsm = (root, c) => runNode(path.join(root, `entry-${c.id}.mjs`), root);

async function enhancedResolve(root, c) {
  const {default: resolver} = await import('enhanced-resolve');
  return new Promise(done => {
    resolver.create({})(root, c.make(CJS_TARGET, root), err =>
      done(
        err == null
          ? {status: RESOLVED, detail: ''}
          : {status: FAILED, detail: brief(err.message)},
      ),
    );
  });
}

async function webpackBuild(root, c) {
  const {default: webpack} = await import('webpack');
  return new Promise(done => {
    webpack(
      {
        mode: 'development',
        entry: path.join(root, `entry-${c.id}.cjs`),
        output: {path: path.join(root, 'out', c.id)},
        bail: false,
      },
      (err, stats) => {
        if (err) {
          return done({status: FAILED, detail: brief(err.message)});
        }
        const json = stats.toJson({errors: true});
        return done(
          json.errors?.length
            ? {
                status: FAILED,
                detail: brief(json.errors[0].message ?? json.errors[0]),
              }
            : {status: RESOLVED, detail: ''},
        );
      },
    );
  });
}

async function viteBuild(root, c) {
  const {build} = await import('vite');
  try {
    await build({
      root,
      logLevel: 'silent',
      configFile: false,
      build: {
        write: false,
        target: 'esnext',
        rollupOptions: {input: path.join(root, `entry-${c.id}.mjs`)},
      },
    });
    return {status: RESOLVED, detail: ''};
  } catch (e) {
    return {status: FAILED, detail: brief(e.message)};
  }
}

const RESOLVERS = [
  {name: 'node (cjs require)', run: nodeCjs, target: CJS_TARGET},
  {name: 'node (esm import)', run: nodeEsm, target: ESM_TARGET},
  {name: 'webpack (enhanced-resolve)', run: enhancedResolve, target: CJS_TARGET},
  {name: 'webpack (full build)', run: webpackBuild, target: CJS_TARGET},
  {name: 'vite (build)', run: viteBuild, target: ESM_TARGET},
];

async function main() {
  const root = buildFixture();
  const results = [];

  for (const resolver of RESOLVERS) {
    for (const c of CASES) {
      let outcome;
      try {
        outcome = await resolver.run(root, c);
      } catch (e) {
        // A resolver that won't even load is reported per-case rather than
        // taking the whole run down with it.
        outcome = {status: UNAVAILABLE, detail: brief(e.message)};
      }
      results.push({
        resolver: resolver.name,
        id: c.id,
        spec: c.make(resolver.target, root),
        control: c.control,
        ...outcome,
      });
    }
  }

  const platform = `${os.platform()} ${os.arch()} / node ${process.version}`;
  const mark = r =>
    r.status === RESOLVED ? 'yes' : r.status === FAILED ? 'no' : '?';

  const header = ['case', ...RESOLVERS.map(r => r.name)];
  const rows = CASES.map(c => [
    c.id,
    ...RESOLVERS.map(res =>
      mark(results.find(r => r.resolver === res.name && r.id === c.id)),
    ),
  ]);

  const table = [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map(r => `| ${r.join(' | ')} |`),
  ].join('\n');

  const specs = CASES.map(
    c => `- \`${c.id}\` — \`${c.make('mod.<ext>', root)}\``,
  ).join('\n');
  const failures = results
    .filter(r => r.status !== RESOLVED)
    .map(r => `- **${r.resolver}** / \`${r.id}\`: ${r.status} — ${r.detail}`)
    .join('\n');

  const report = [
    `## Separator probe — ${platform}`,
    '',
    'Does each resolver treat a specifier written with `\\` as relative? "yes" means it resolved.',
    '',
    table,
    '',
    '### Specifiers',
    '',
    specs,
    '',
    '### Messages',
    '',
    failures || '_(everything resolved)_',
    '',
  ].join('\n');

  console.log(report);
  fs.writeFileSync(
    path.join(HERE, `result-${os.platform()}.json`),
    JSON.stringify({platform, results}, null, 2),
  );
  if (process.env.GITHUB_STEP_SUMMARY != null) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  }

  const brokenControls = results.filter(r => r.control && r.status !== RESOLVED);
  if (brokenControls.length > 0) {
    console.error(
      '\nControl cases failed — the other answers in this run are not readable:',
    );
    for (const r of brokenControls) {
      console.error(`  ${r.resolver} / ${r.id}: ${r.detail}`);
    }
    process.exitCode = 1;
  }
}

await main();
