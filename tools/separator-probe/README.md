# separator-probe

A throwaway instrument, not part of Metro. It exists to answer one question that has blocked two pull requests for years.

## The question

`metro-resolver` classifies a specifier as relative with:

```js
// packages/metro-resolver/src/resolve.js
function isRelativeImport(filePath: string) {
  return /^[.][.]?(?:[/]|$)/.test(filePath);
}
```

[#648](https://github.com/react/metro/pull/648) (2021) and [#1286](https://github.com/react/metro/pull/1286) (2024) both propose adding `\` to that character class, so that `.\foo` is treated as relative on Windows. They are the same one-line change, written two ways, and neither has landed.

Both stalled on the same unanswered question. From #648:

> Before merging, we should probably double-check that Node and other bundlers implement the same behaviour, as I don't see any reference to that above or in #595.

This probe answers it by measurement rather than argument, on the platform where it matters.

## What it does

For each specifier form, it asks six resolvers to resolve the same target file and records whether they did:

| resolver | how |
|---|---|
| `node (cjs require)` | child process running `require(<specifier>)` |
| `node (esm import)` | child process running `import <specifier>` |
| `webpack (enhanced-resolve)` | webpack's resolver, called directly |
| `webpack (full build)` | a real webpack build, reading resolution errors off the stats |
| `vite (esm build)` | a real `vite build` of an `import`, catching the rollup resolution error |
| `vite (cjs build)` | the same for a `require()`, with the commonjs plugin opted in to the fixture |

Specifier forms cover both branches Metro reaches by the same route — `isRelativeImport(specifier) || path.isAbsolute(specifier)`:

- **relative** — posix (`./sub/mod`), backslash (`.\sub\mod`), and both mixtures
- **absolute** — native, posix-slash, backslash, and a `file://` URL

A Vite build that cannot resolve a specifier does not always fail: rollup's commonjs plugin emits `UNRESOLVED_IMPORT` and treats the module as external, so the build succeeds having resolved nothing. Both Vite runners therefore treat an unresolved-import warning as a failure. Scoring on exit status alone reported every backslash case as a success, which is wrong in precisely the cases under test.

The two pure-posix relative cases are **controls**. If a resolver fails one, it is misconfigured and its other answers in that run cannot be read, so the probe exits non-zero and says so. Both earlier drafts of this script were caught that way.

Specifiers always carry an explicit extension: ESM does no extension searching, so an extensionless specifier fails there for a reason that has nothing to do with separators.

## Running it

```sh
cd tools/separator-probe
npm install
node probe.mjs
```

It prints a table, writes `result-<platform>.json`, and appends to the GitHub step summary when running in CI. The workflow at `.github/workflows/separator-probe.yml` runs it across `windows-latest`, `ubuntu-latest` and `macos-latest` on two Node versions, and uploads each result as an artifact.

## Reading the result

The interesting comparison is Windows against the others. A specifier that only works on Windows tells you the behaviour is platform-dependent; one that works nowhere tells you it is not a valid specifier at all, and that normalisation belongs in whatever produced it.

Note that a "no" from Node ESM comes with its reasoning attached — `ERR_INVALID_MODULE_SPECIFIER: Invalid module ".\sub\mod.mjs" is not a valid package name` is Node performing the same classification `isRelativeImport` does, and reaching a verdict.
