# juris-tests

More test coverage for `juris` and `juris-kit`, kept out of both packages.
Each is linked from its sibling checkout (`../juris`, `../juris-kit`), so the tests import them by
package name, as an app does, and run against whatever is checked out there.

    npm install              # links ../juris and ../juris-kit
    npm test                 # every test
    npm run test:juris       # tests/juris/
    npm run test:kit         # tests/juris-kit/
    npm run coverage         # coverage of ../juris/*.js and ../juris-kit/server/**
    npm run coverage:juris   # tests/juris/ alone, against ../juris/*.js
    npm run coverage:kit     # tests/juris-kit/ alone, against ../juris-kit/server/**

Node 24 and `node:test`, with no other dependency, the same as both packages' own tests.

## Coverage

Each package is held to 99% or more from its own folder here, not counting the package's own tests:
`coverage:juris` for Juris, `coverage:kit` for the kit. Every source file is loaded by some test, so
none is missing from the report (Node reports only the files a test loads). Neither package carries
a coverage-ignore comment.

## What is here

    tests/fixtures/   the catalogs: every HTML, SVG and MathML element, every attribute (HTML, ARIA,
                      event handlers, SVG, MathML), each with its kind
    tests/support/    dom.mjs and markup.mjs: a stand-in DOM (with a serializer, to compare with the
                      server's markup) and a reader for the server's start tags. The rest are named for
                      the source file whose tests use them (a browser for client.js, fake pg and MySQL
                      pools for the outbox buses, an app directory for the kernel, …); ssr-renderer.mjs
                      gives an instance the kit's string renderer (withSSR), for every test that
                      renders on the server
    tests/juris/      elements.test.mjs    every element, on both renderers
                      attributes.test.mjs  every attribute, on both renderers, reactive changes included
                      matrix.test.mjs      every element with every attribute of its namespace at once
                      classes.test.mjs     class, className and classList together, on both
                                           renderers: the first draw, and the client after a change
                      <file>.test.mjs, <file>.<topic>.test.mjs: one source file of ../juris each
    tests/juris-kit/  <file>.test.mjs, <file>.<topic>.test.mjs: one file of ../juris-kit/server each,
                      ssr-renderer.js, the string renderer, among them
    bench/            devtools.bench.mjs: what the devtools feature (devtools.js) costs a devMode page,
                      against REFERENCE.md's budget; run by hand (node --expose-gc
                      bench/devtools.bench.mjs), never a test, since timings are not asserted

The string renderer is the kit's (server/ssr-renderer.js), given to an instance as `features: { ssr:
SSRRenderer }`; juris.js has none of its own. So its tests are in tests/juris-kit/, and the tests in
tests/juris/ that render on the server (both renderers' catalogs among them) give their instance
the kit's, through support/ssr-renderer.mjs.

The tests are written to the standards and to REFERENCE.md, not to what Juris does today, so a
failing one is a gap in Juris: fix Juris, never the test, unless the test misreads the standard.

A test marked `todo` holds a bug found in Juris or the kit: it asserts the right behaviour, runs
(and counts for coverage), and reports without failing the suite. Its reason names the source line
and the bug. Fixing the bug turns it into a passing test; then take the `todo` off. A few hold a
gap from the standard that the contract accepts by decision (`<xmp>`, `<noembed>` and `<noframes>`
are ordinary elements, their text escaped); their reason says so.
