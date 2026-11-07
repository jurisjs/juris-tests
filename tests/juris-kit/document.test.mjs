// The HTML document around a server-rendered page (server/document.js): what renderDocument writes
// and in what order, that every value is escaped where it is written (trustedHead alone excepted),
// what it refuses rather than escapes, the loader that boots the entry, and inlineScriptHashes.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { renderDocument, inlineScriptHashes } from "juris-kit/server/document.js";
import { attributesIn } from "../support/markup.mjs";

const ENTRY = "/app/boot.js";
const page = (options = {}, body = { html: "", json: "{}" }) => renderDocument(body, { entry: ENTRY, ...options });
const headOf = (html) => /<head>\n([\s\S]*?)\n<\/head>/.exec(html)[1];
// The start tags in the head, one per line as the document writes them.
const headTags = (html) => headOf(html).split("\n");
const loaderOf = (html) => /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1];
const sha256 = (text) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

// ---- the whole document -----------------------------------------------------------------------

test("renderDocument: given only an entry, it writes the doctype, a head of charset, viewport and title, and the body's parts", () => {
    const html = page();
    assert.ok(html.startsWith('<!doctype html>\n<html lang="en">\n<head>\n'), html.slice(0, 60));
    assert.deepEqual(headTags(html), [
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        "<title></title>",
    ]);
    const body = /<body>\n([\s\S]*)\n<\/body>\n<\/html>$/.exec(html)[1];
    assert.ok(body.startsWith('<div id="app"></div>\n<script type="application/json" id="state">{}</script>\n<script type="module">'), body);
    assert.ok(!html.includes('id="services"'), "no service names were given");
    assert.equal((html.match(/<script/g) ?? []).length, 2, "the state and the loader, and no reload client");
});

test("renderDocument: with no page given, the body is empty and the state is {}", () => {
    const html = renderDocument(undefined, { entry: ENTRY });
    assert.ok(html.includes('<div id="app"></div>'));
    assert.ok(html.includes('<script type="application/json" id="state">{}</script>'));
});

test("renderDocument: the head is written in its fixed order, whatever order the options come in", () => {
    const html = page({
        trustedHead: "<!-- trusted -->",
        styles: [{ text: ".a{}" }, { href: "/s.css" }],
        preload: [{ href: "/app/a.js", as: "script" }],
        buildMeta: { name: "x-build", content: "b1" },
        meta: [{ property: "og:title", content: "T" }],
        links: [{ rel: "icon", href: "/i.png" }],
        canonical: "https://example.com/p",
        description: "D",
        title: "T",
        viewport: "width=500",
    });
    assert.deepEqual(headTags(html), [
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=500">',
        "<title>T</title>",
        '<meta name="description" content="D">',
        '<link rel="canonical" href="https://example.com/p">',
        '<link rel="icon" href="/i.png">',
        '<meta property="og:title" content="T">',
        '<meta name="x-build" content="b1">',
        '<link rel="preload" href="/app/a.js" as="script">',
        "<style>.a{}</style>",
        '<link rel="stylesheet" href="/s.css">',
        "<!-- trusted -->",
    ]);
});

test("renderDocument: only what is given is written: no viewport for null, an empty title for null", () => {
    const html = page({ viewport: null, title: null, description: null, canonical: null, buildMeta: null });
    assert.deepEqual(headTags(html), ['<meta charset="utf-8">', "<title></title>"]);
});

// ---- escaping ---------------------------------------------------------------------------------

test("renderDocument: a title is text: markup in it is escaped, whoever wrote it", () => {
    const html = page({ title: `<script>alert("x")</script> & 'co'` });
    assert.ok(html.includes("<title>&lt;script&gt;alert(\"x\")&lt;/script&gt; &amp; 'co'</title>"), headOf(html));
    assert.equal(html.match(/<script/g).length, 2, "the title opened no script");
});

test("renderDocument: every attribute value is escaped where it is written, and reads back as given", () => {
    const nasty = `a"b'c<d>e&f`;
    const html = page({
        lang: nasty,
        htmlAttrs: { "data-x": nasty },
        viewport: nasty,
        description: nasty,
        canonical: `/p?q=${nasty}`,
        links: [{ rel: "alternate", href: `/l?${nasty}`, title: nasty }],
        meta: [{ name: "n", content: nasty }],
        buildMeta: { name: nasty, content: nasty },
        preload: [{ href: `/p?${nasty}`, as: nasty }],
        styles: [{ href: `/s?${nasty}`, media: nasty }],
        rootId: nasty,
        stateId: nasty,
    });
    const tag = (pattern) => attributesIn(html.slice(html.search(pattern)));
    assert.deepEqual(tag(/<html /), { lang: nasty, "data-x": nasty });
    assert.deepEqual(tag(/<meta name="viewport"/), { name: "viewport", content: nasty });
    assert.deepEqual(tag(/<meta name="description"/), { name: "description", content: nasty });
    assert.deepEqual(tag(/<link rel="canonical"/), { rel: "canonical", href: `/p?q=${nasty}` });
    assert.deepEqual(tag(/<link rel="alternate"/), { rel: "alternate", href: `/l?${nasty}`, title: nasty });
    assert.deepEqual(tag(/<meta name="n"/), { name: "n", content: nasty });
    assert.deepEqual(tag(/<meta name="a&quot;/), { name: nasty, content: nasty });
    assert.deepEqual(tag(/<link rel="preload"/), { rel: "preload", href: `/p?${nasty}`, as: nasty });
    assert.deepEqual(tag(/<link rel="stylesheet"/), { rel: "stylesheet", href: `/s?${nasty}`, media: nasty });
    assert.deepEqual(tag(/<div /), { id: nasty });
    assert.deepEqual(tag(/<script type="application\/json"/), { type: "application/json", id: nasty });
});

test("renderDocument: true writes a bare attribute, null, undefined and false write nothing, and the order is the object's", () => {
    const html = page({ links: [{ rel: "icon", href: "/i.png", sizes: 32, crossorigin: true, media: null, type: undefined, disabled: false }] });
    assert.ok(html.includes('<link rel="icon" href="/i.png" sizes="32" crossorigin>'), headOf(html));
    assert.ok(page({ htmlAttrs: { "data-theme": "dark", hidden: true } }).includes('<html lang="en" data-theme="dark" hidden>'));
});

test("renderDocument: the markup is written as the renderer escaped it, and the state's < is escaped", () => {
    const state = { a: "</script><!--", b: "<b>" };
    const html = renderDocument({ html: "<p>hi &amp; bye</p>", json: JSON.stringify(state) }, { entry: ENTRY, rootId: "root", stateId: "data" });
    assert.ok(html.includes('<div id="root"><p>hi &amp; bye</p></div>'));
    const text = /<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(html)[1];
    assert.ok(!text.includes("<"), text);
    assert.deepEqual(JSON.parse(text), state, "the escaped state reads back as the state");
});

test("renderDocument: trustedHead is written as given, last in the head", () => {
    const trusted = `<script>document.documentElement.dataset.theme = localStorage.theme || "light";</script>`;
    const tags = headTags(page({ trustedHead: trusted, title: "T" }));
    assert.equal(tags.at(-1), trusted);
});

// ---- what is refused --------------------------------------------------------------------------

test("renderDocument: an attribute name from data is refused, an on… handler included", () => {
    assert.throws(() => page({ links: [{ rel: "x", onload: "alert(1)" }] }), { name: "Error", message: /renderDocument: links: attribute name "onload" is not allowed/ });
    assert.throws(() => page({ meta: [{ 'a"b': "x" }] }), { name: "Error", message: /renderDocument: meta: attribute name/ });
    assert.throws(() => page({ htmlAttrs: { "x onclick": "y" } }), { name: "Error", message: /renderDocument: htmlAttrs: attribute name/ });
    assert.throws(() => page({ preload: [{ href: "/a.js", ONERROR: "x" }] }), { name: "Error", message: /renderDocument: preload: attribute name "ONERROR"/ });
});

test("renderDocument: a URL whose scheme runs code is refused wherever a URL attribute is written", () => {
    const refused = { name: "Error", message: /scheme not allowed/ };
    assert.throws(() => page({ canonical: "javascript:alert(1)" }), { name: "Error", message: /renderDocument: canonical: href refuses "javascript:alert\(1\)"/ });
    assert.throws(() => page({ links: [{ rel: "icon", href: "java\tscript:alert(1)" }] }), refused);
    assert.throws(() => page({ preload: [{ href: "vbscript:x", as: "script" }] }), refused);
    assert.throws(() => page({ styles: [{ href: "data:text/css,a{}" }] }), refused);
    assert.ok(page({ links: [{ rel: "icon", href: "data:image/png;base64,AAAA" }] }).includes('href="data:image/png;base64,AAAA"'), "an image's data: URL is allowed");
});

test("renderDocument: links, meta, preload and htmlAttrs each take objects of attributes", () => {
    for (const [options, where] of [
        [{ links: ["/i.png"] }, "links"],
        [{ links: [null] }, "links"],
        [{ meta: [["name", "x"]] }, "meta"],
        [{ preload: [null] }, "preload"],
        [{ preload: ["/a.js"] }, "preload"],
        [{ htmlAttrs: null }, "htmlAttrs"],
    ]) {
        assert.throws(() => page(options), { name: "TypeError", message: `renderDocument: ${where} takes an object of attributes` }, JSON.stringify(options));
    }
});

test("renderDocument: a preload and a stylesheet write their own rel, and refuse one given", () => {
    assert.ok(page({ preload: [{ href: "/a.js", as: "script", crossorigin: true }] }).includes('<link rel="preload" href="/a.js" as="script" crossorigin>'));
    assert.ok(page({ styles: [{ href: "/s.css", media: "print" }] }).includes('<link rel="stylesheet" href="/s.css" media="print">'));
    assert.throws(() => page({ preload: [{ rel: "modulepreload", href: "/a.js" }] }), { name: "Error", message: "renderDocument: preload writes its own rel; leave it out" });
    assert.throws(() => page({ styles: [{ href: "/s.css", rel: "alternate stylesheet" }] }), { name: "Error", message: "renderDocument: a stylesheet writes its own rel; leave it out" });
});

test("renderDocument: a style's text is raw text, and text that would end the element is refused", () => {
    const css = '.a > .b::after { content: "&<" } <!-- not special in a style -->';
    assert.ok(page({ styles: [{ text: css }] }).includes(`<style>${css}</style>`));
    assert.ok(page({ styles: [{ text: 42 }] }).includes("<style>42</style>"), "text that is not a string is written as one");
    for (const text of [".a{}</style><script>x</script>", ".a{}</STYLE >", "</style"]) {
        assert.throws(() => page({ styles: [{ text }] }), { name: "Error", message: "renderDocument: a style's text contains </style, which would end the element" }, text);
    }
});

test("renderDocument: each of styles is { text } or { href }", () => {
    for (const style of [{}, null, "/s.css", { media: "print" }]) {
        assert.throws(() => page({ styles: [style] }), { name: "TypeError", message: "renderDocument: each of styles is { text } or { href }" }, JSON.stringify(style));
    }
});

test("renderDocument: buildMeta names the build in a meta, and needs a name", () => {
    assert.ok(page({ buildMeta: { name: "x-build", content: "2026-11-05" } }).includes('<meta name="x-build" content="2026-11-05">'));
    assert.ok(page({ buildMeta: { name: "x-build" } }).includes('<meta name="x-build" content="">'), "no content is an empty one");
    for (const buildMeta of [{}, { name: "" }, { name: 5, content: "b" }, "b1"]) {
        assert.throws(() => page({ buildMeta }), { name: "TypeError", message: "renderDocument: buildMeta needs a name" }, JSON.stringify(buildMeta));
    }
});

test("renderDocument: a refresh meta's URL part is held to the scheme rules, however it is spelt", () => {
    const refresh = (content, equiv = "refresh") => page({ meta: [{ "http-equiv": equiv, content }] });
    for (const content of [
        "0;url='javascript:alert(1)",          // a quote never closed
        '0; url="javascript:x" and more',      // a quote closed, with more after it
        "1.5 , URL = javascript:x",            // a fractional delay, a comma, spaces around =
        "0;vbscript:x",                        // no url=
    ]) {
        assert.throws(() => refresh(content), { name: "Error", message: /^renderDocument: meta: a refresh to ".*": scheme not allowed$/ }, content);
    }
    assert.throws(() => refresh("0;url=javascript:x", "  Refresh "), /scheme not allowed/, "the http-equiv is read as a browser reads it");
    for (const content of ["0; url='/next' and more", "5", "0;url=https://example.com/"]) {
        assert.match(refresh(content), /<meta http-equiv="refresh" content="/, content);
    }
    assert.match(page({ meta: [{ "http-equiv": "refresh" }] }), /<meta http-equiv="refresh">/, "a refresh with no content goes nowhere");
});

test("renderDocument: a meta that is not a refresh may mention a scheme in its content", () => {
    const html = page({ meta: [{ name: "description", content: "javascript: the good parts" }, { "http-equiv": "content-language", content: "data:x" }] });
    assert.ok(html.includes('<meta name="description" content="javascript: the good parts">'));
    assert.ok(html.includes('<meta http-equiv="content-language" content="data:x">'));
});

// ---- the body's scripts -----------------------------------------------------------------------

test("renderDocument: an entry is required, as a non-empty string", () => {
    for (const entry of [undefined, "", 5, null]) {
        assert.throws(() => renderDocument({}, { entry }), { name: "TypeError", message: "renderDocument: entry, the URL of the browser entry, is required" }, String(entry));
    }
    assert.throws(() => renderDocument({}), TypeError, "no options at all");
});

test("renderDocument: the entry is written as a string literal that nothing in it can end", () => {
    const entry = `/app/boot.js?x="</script><!--'\u2028\u2029\\`;
    const loader = loaderOf(page({ entry }));
    assert.ok(!/<\/script|<!--|\u2028|\u2029/.test(loader), loader);
    const literal = /import\((.*?)\)\.then/.exec(loader)[1];
    assert.equal(vm.runInNewContext(literal), entry, "the literal is the entry again");
});

test("renderDocument: the loader boots the entry once the page has loaded and the browser is idle", async () => {
    const key = `__documentTestBoots${process.pid}`;
    const entry = `data:text/javascript,export function start() { globalThis.${key} = (globalThis.${key} ?? 0) + 1; }`;
    const run = (loader, document, requestIdleCallback) => {
        const calls = { idle: [], timeouts: [], listeners: [] };
        const idle = typeof requestIdleCallback === "function" ? (fn) => { calls.idle.push(fn); } : requestIdleCallback;
        new Function("document", "requestIdleCallback", "setTimeout", "addEventListener", loader)(
            document, idle, (fn, ms) => calls.timeouts.push([fn, ms]), (...args) => calls.listeners.push(args));
        return calls;
    };
    try {
        const loader = loaderOf(page({ entry }));

        // Loaded already: booted when idle, and booting calls start().
        const now = run(loader, { readyState: "complete" }, () => {});
        assert.equal(now.idle.length, 1);
        assert.equal(now.listeners.length, 0);
        await now.idle[0]();
        assert.equal(globalThis[key], 1, "start() was called");

        // Still loading: once, on load, and then when idle.
        const later = run(loader, { readyState: "interactive" }, () => {});
        assert.equal(later.idle.length, 0, "nothing before load");
        assert.equal(later.listeners.length, 1);
        const [type, onLoad, options] = later.listeners[0];
        assert.equal(type, "load");
        assert.deepEqual(options, { once: true });
        onLoad();
        assert.equal(later.idle.length, 1);

        // No requestIdleCallback that is a function (an element of that id, say): a timeout instead.
        const clobbered = run(loader, { readyState: "complete" }, { id: "requestIdleCallback" });
        assert.equal(clobbered.timeouts.length, 1);
        assert.equal(clobbered.timeouts[0][1], 1);
        await clobbered.timeouts[0][0]();
        assert.equal(globalThis[key], 2);
    } finally {
        delete globalThis[key];
    }
});

test("renderDocument: service names are a JSON list in #services, with < escaped, between the state and the loader", () => {
    const names = ["orders.list", "a</script>"];
    const html = page({ serviceNames: names });
    const match = /<script type="application\/json" id="state">\{\}<\/script>\n<script type="application\/json" id="services">(.*?)<\/script>\n<script type="module">/.exec(html);
    assert.ok(match, html);
    assert.ok(!match[1].includes("<"));
    assert.deepEqual(JSON.parse(match[1]), names);
    assert.ok(page({ serviceNames: [] }).includes('<script type="application/json" id="services">[]</script>'), "an empty list is still a list");
    assert.ok(!page({ serviceNames: null }).includes('id="services"'));
});

test("renderDocument: service names that are not a list of strings are refused", () => {
    for (const serviceNames of ["orders.list", ["a", 1], { a: 1 }, 5]) {
        assert.throws(() => page({ serviceNames }), { name: "TypeError", message: "renderDocument: serviceNames is a list of service names (strings), or null for none" }, JSON.stringify(serviceNames));
    }
});

test("renderDocument: the development reload client goes in a script at the end of the body", () => {
    const html = page({ devReload: "console.log('reload')" });
    assert.ok(html.endsWith("</script>\n<script>console.log('reload')</script>\n</body>\n</html>"), html.slice(-120));
    assert.ok(!page({ devReload: "" }).includes("<script>"), "an empty client is none");
});

test("renderDocument: a reload client that would end its script, or change where it ends, is refused", () => {
    for (const devReload of ["x='</script>'", "x='</SCRIPT '"]) {
        assert.throws(() => page({ devReload }), { name: "Error", message: "renderDocument: devReload contains </script, which would end the element" }, devReload);
    }
    assert.throws(() => page({ devReload: "x='<!--'" }), { name: "Error", message: "renderDocument: devReload contains <!--, which changes where the script ends" });
});

test("renderDocument: jurisDev is JSON in #juris-dev, with < escaped, after the service names and before the loader", () => {
    const html = page({ serviceNames: ["a"], jurisDev: { render: "r</script>1" } });
    const match = /<script type="application\/json" id="services">\["a"\]<\/script>\n<script type="application\/json" id="juris-dev">(.*?)<\/script>\n<script type="module">/.exec(html);
    assert.ok(match, html);
    assert.ok(!match[1].includes("<"));
    assert.deepEqual(JSON.parse(match[1]), { render: "r</script>1" });
    assert.ok(page({ jurisDev: {} }).includes('<script type="application/json" id="state">{}</script>\n<script type="application/json" id="juris-dev">{}</script>\n<script type="module">'), "with no service names, after the state");
    for (const options of [{}, { jurisDev: null }, { jurisDev: undefined }]) assert.ok(!page(options).includes("juris-dev"), JSON.stringify(options));
});

test("renderDocument: a jurisDev that is not a plain object is refused", () => {
    for (const [label, jurisDev] of [["a string", "{}"], ["a list", []], ["a number", 1], ["true", true], ["a Map", new Map()], ["a null-prototype object", Object.create(null)]]) {
        assert.throws(() => page({ jurisDev }), { name: "TypeError", message: "renderDocument: jurisDev is the page's development data, a plain object written as JSON in #juris-dev, or null for none" }, label);
    }
});

// ---- inlineScriptHashes -----------------------------------------------------------------------

test("inlineScriptHashes: the loader's hash, and the reload client's in development, never the JSON blocks'", () => {
    const plain = page({ serviceNames: ["a"] });
    assert.deepEqual(inlineScriptHashes(plain), [sha256(loaderOf(plain))]);

    const reload = "console.log('reload')";
    const dev = page({ serviceNames: ["a"], devReload: reload, jurisDev: {} });
    assert.deepEqual(inlineScriptHashes(dev), [sha256(loaderOf(dev)), sha256(reload)]);
    assert.match(inlineScriptHashes(dev)[0], /^'sha256-[A-Za-z0-9+/]+=*'$/, "quoted as a policy writes it");
});

test("inlineScriptHashes: one document is one set of hashes, read from its text", () => {
    const html = page();
    assert.deepEqual(inlineScriptHashes(html), inlineScriptHashes(page()));
    assert.deepEqual(inlineScriptHashes(Buffer.from(html)), inlineScriptHashes(html));
    assert.notDeepEqual(inlineScriptHashes(page({ entry: "/other.js" })), inlineScriptHashes(html), "another entry is another loader");
    assert.deepEqual(inlineScriptHashes(""), []);
});
