# Third-party license audit

This project is [MIT licensed](LICENSE). That covers the code in this repository — it says
nothing on its own about the ~640 npm packages `package.json` pulls in, each of which carries its
own license. This file is the audit that closes that gap: every license actually present in the
installed dependency tree, checked against MIT distribution, run with
[`license-checker-rseidelsohn`](https://github.com/RSeidelsohn/license-checker) directly against
`node_modules` (i.e. against what a real `npm install` produces, not against what any single
`package.json` line claims).

Run it yourself any time with `npm run check:licenses`.

**Audited 2026-08-14. Result: no dependency's license conflicts with distributing this project
under MIT.** Everything below is either permissive (compatible by construction) or a weak/scoped
license used in exactly the way it permits.

## Permissive — the overwhelming majority, no obligations beyond attribution

| License | Packages |
|---|---|
| MIT | 354 |
| Apache-2.0 | 101 |
| ISC | 70 |
| BlueOak-1.0.0 (`minimatch` family, via `@typescript-eslint`) | 11 |
| BSD-2-Clause | 10 |
| BSD-3-Clause | 3 |
| 0BSD | 2 |
| Python-2.0 (`argparse`) | 1 |
| Unlicense (`fast-sha256`) | 1 |

All eight are OSI-approved-or-equivalent permissive terms (or, for Unlicense, a public-domain
dedication) — none require this project, or anyone who builds on it, to be licensed any
particular way.

## Weak copyleft, used unmodified — does not extend to this project's own code

| License | Packages | Why it's fine |
|---|---|---|
| LGPL-3.0-or-later | `@img/sharp-libvips-darwin-arm64` | Platform binary for `sharp`, an *optional* dependency of Next.js's image optimizer. LGPL is specifically designed to permit this: using the library as-is, without modifying or statically merging its source into your own, does not require your code to be LGPL. Nobody ships `libvips`'s source patched — it's used exactly as its own license expects. |
| Apache-2.0 AND LGPL-3.0-or-later AND MIT | `@img/sharp-wasm32` | Same package family, same reasoning, plus two permissive licenses layered on top. |
| MPL-2.0 | `axe-core`, `lightningcss`, `lightningcss-darwin-arm64` | File-level copyleft: it only obligates you if you modify *their* files and redistribute the modified source. None of these are modified here — they're used as published, which triggers no obligation. |

## Data licenses, not code licenses

| License | Package | Why it's fine |
|---|---|---|
| CC-BY-4.0 | `caniuse-lite` | A browser-compatibility *data table* (used by `browserslist`, which every modern frontend build tool depends on), not source code. It requires attribution when the data itself is redistributed as-is — this project doesn't redistribute it separately, only consumes it as a build-time input, the same way virtually every Next.js/Tailwind project does. |
| CC0-1.0 | `language-subtag-registry`, `spdx-license-ids` | Public-domain-equivalent data tables (IANA language tags; SPDX's own license-id list). Zero restriction either way. |
| CC-BY-3.0 | `spdx-exceptions` | SPDX's own license-exception text data — a dependency of the license-checking tool itself (`license-checker-rseidelsohn`), not of the app. Same reasoning as `caniuse-lite`: consumed as data, not redistributed standalone. |
| (MIT AND CC-BY-3.0) | `spdx-ranges` | Same tool, same reasoning — dual-licensed, both halves are non-restrictive for this use. |

## Keeping this honest going forward

Nothing here required removing or replacing a single dependency — the whole tree was already
clean. `npm run check:licenses` re-runs the same audit against whatever is actually installed, so
before adding a new dependency (or after a version bump pulls in new transitive ones), run it and
update this file if anything outside the categories above shows up — a real GPL/AGPL/SSPL
dependency, or anything with no license declared at all.
