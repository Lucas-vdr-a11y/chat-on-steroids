# Plugin notices and 2.0.8 source audit

Reviewed on 2026-09-08 for the full 2.0.8 source update, **Darkex by dark tibo**.
This review covers package notices, catalog license provenance, public source scope and
the automated validation pipeline. It does not establish clearance for every hosted-service
use, trademark, generated asset or native binary distribution.

## Findings

- All five downloadable catalog distributions were fetched from their recorded npm/PyPI
  URLs. Their archive integrity and retained license hashes match the inventory. Playwright
  supplies Apache-2.0; Blender, Fetch and Unity supply MIT. No separate NOTICE was present
  in those direct distributions. Transitive plugin dependencies are installed separately
  and retain their own package contents; these snapshots are not a complete dependency audit.
- Knowledge Memory 2026.8.31 omits LICENSE from its npm archive. Its retained supplement
  matches the package's exact upstream Git revision and preserves the MIT/Apache transition
  and documentation terms. The installed-plugin label now uses that reviewed information
  only for the exact package version. Custom/future versions do not inherit an old review.
- HeyGen and Recraft are hosted services with separate terms, account permissions and usage
  requirements. The catalog does not represent either service as MIT software or grant rights
  to every generated output. Their official terms links were checked.
- Catalog SVGs are code-drawn illustrations with repository MIT attribution and a statement
  that they are not official logos. No remote artwork is fetched by the catalog UI.
- A clean Windows dependency installation supplies 88 production npm packages. The notice
  generator preserves their supplied license/notice files, native README attribution and
  the retained supplements, plus all seven catalog references. The flora-colossus supplement
  was compared against its upstream author's LICENSE.
- CI now validates this inventory, installed versions against the lockfile, missing production
  license material and catalog notice hashes. Optional packages absent on another target are
  permitted; an invalid installed manifest is not silently skipped. Packaging regenerates the
  notices on the packaging host and its runtime smoke check requires the output file.

## Binary distribution remains a separate check

The native sharp/libvips distributions contain LGPL/MPL components. Retained full license
texts and links to upstream build projects do not establish complete corresponding source,
component copyright attribution or replacement/relinking compliance for an exact installer.
Before binary publication, verify the source delivery method, exact per-target component
versions, patches/build recipes and applicable replacement conditions; inspect Electron,
Chromium, tunnel, ripgrep and image-library notices in every actual artifact. This source PR
and ordinary CI do not produce that evidence.

## Primary sources

- [MIT license](https://opensource.org/license/mit): preservation of copyright and permission notices.
- [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0), section 4: license and applicable NOTICE retention;
  section 6: limits on trademark rights.
- [Memory's exact upstream LICENSE](https://github.com/modelcontextprotocol/servers/blob/a40bc270fb5ece62673f8a1196f57116d885c5eb/LICENSE):
  mixed contribution licensing during the upstream transition.
- [Catalog archive URLs, integrity and license hashes](licenses/plugins/inventory.json): exact direct-package evidence.
- [HeyGen terms](https://www.heygen.com/terms) and [Recraft terms](https://www.recraft.ai/legal/terms): separate service conditions.
- [LGPLv3](https://www.gnu.org/licenses/lgpl-3.0.html), section 4, and
  [MPL 2.0](https://www.mozilla.org/en-US/MPL/2.0/), sections 3.2 and 3.4:
  binary/source and notice duties. The GNU endpoint could not be re-fetched during this review;
  the retained publisher text and the earlier native supplement provenance were inspected.
- [Native supplement provenance](licenses/native/README.md) and
  [flora-colossus supplement provenance](licenses/README.md).

## Scope and validation record

The update was assembled in an isolated checkout based on current public main. It includes
the current source, tests, extension, packaging changes and public documentation. Recordings,
downloaded applications, screenshots, credentials, generated build directories and private
working notes are excluded. The original shared checkout is preserved.

The app, lockfile and companion version are 2.0.8. Release notes retain the requested name.
The existing browser, session, model-picker, plan, transcript and UI changes are included with
the plugin implementation; their regression suites run in the full CI gate.

A clean dependency install exposed concurrent Electron lazy downloads when multiple Vitest
workers first imported the module. Verification now resolves Electron once before starting
parallel tests. This prepares the dependency without launching the desktop application.

The first hosted CI run caught Git normalizing the upstream Playwright LICENSE's CRLF
bytes, invalidating its recorded hash on checkout. License snapshots and the generated
notice inventory now disable Git text conversion so the upstream bytes survive publication.
Local catalog package tests passed for all five downloadable entries, including Playwright
page-content verification independent of its inline/file snapshot presentation.

Local validation: clean dependency installation; exact upstream archive/notice comparisons;
`npm run verify` passed 3,402 main tests and two shutdown tests (27 existing opt-in/platform
skips); production build passed. The new cross-platform live-plugin checks are tracked in the
PR's GitHub CI run. Source privacy and staged-file scope checks passed before publication.

CI also runs the opt-in published-package tests on Windows x64, macOS arm64 and Linux x64:
Memory writes/reads through the real CoS HTTP proxy and rejects a disabled cached call;
Fetch retrieves a loopback fixture; Playwright launches isolated headless Chromium and
navigates to a loopback page; Blender and Unity establish stdio connections and expose their
documented tools. Python 3.12 and uv 0.12.5 are provisioned explicitly. OAuth protocol tests
use local fixtures, not user accounts. Editor-side operations and paid hosted accounts remain
outside unattended CI, and these jobs do not test a packaged application's GUI runtime lookup.
