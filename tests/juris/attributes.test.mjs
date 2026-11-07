// Every attribute, held by a test on both renderers: each of HTML's (global and per element), each
// of WAI-ARIA's, every event handler, each of SVG 2's and of MathML's. A text attribute is written
// as given and escaped, a boolean one is present or absent, a URL is held to the scheme rule, an
// event handler is a listener and never markup, and the client agrees with the server, on the first
// draw and on every reactive change after it.
import { test } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";

import { HTML, SVG, isRefused } from "../fixtures/elements.mjs";
import {
    HTML_GLOBAL_ATTRIBUTES, HTML_ELEMENT_ATTRIBUTES, ARIA_ATTRIBUTES, EVENT_HANDLER_ATTRIBUTES, SVG_ATTRIBUTES,
    ATTRIBUTE_NAMESPACES, MATHML_ATTRIBUTES, MATHML_FALSE_IS_A_VALUE, FALSE_IS_A_VALUE, URL_ATTRIBUTES,
    BAD_ATTRIBUTE_NAMES,
} from "../fixtures/attributes.mjs";
import { FakeElement, withDom, warnings } from "../support/dom.mjs";
import { attributesIn } from "../support/markup.mjs";
import { withSSR } from "../support/ssr-renderer.mjs";

const server = (options = {}) => new Juris(withSSR({ isServer: true, ...options }));
const client = (options = {}) => new Juris({ isServer: false, ...options });
const host = () => new FakeElement("div", HTML);

const VALUE = `v&<>"'`;
const allowFor = (tag) => (isRefused(tag) ? { allowTags: [tag] } : {});

// The attribute `name` as the server wrote it on the element `tag` (undefined when it did not).
const ssrAttribute = (tag, props, name, options = {}) => attributesIn(server({ ...allowFor(tag), ...options }).renderToString({ [tag]: props }))[name];

// The element the client drew for `tag`.
const domElement = (tag, props, options = {}) => client({ ...allowFor(tag), ...options }).render(host(), { [tag]: props });

const SAFE_URLS = ["https://example.test/a?b=1&c=2", "http://x.test", "/path", "./rel", "../up", "page.html", "#frag", "?q=1", "mailto:a@b.test", "tel:+1", "sms:1", "geo:1,2", "ftp://x.test", "", "data:image/png;base64,AAAA", "data:image/svg+xml;utf8,<svg/>", "path/with:colon", "a/b:c", "a?b:c", "a#b:c"];
const UNSAFE_URLS = ["javascript:alert(1)", "JavaScript:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "java\nscript:alert(1)", "\u0000javascript:alert(1)", "javascript\u0001:alert(1)", "vbscript:msgbox(1)", "data:text/html,<script>alert(1)</script>", "data:image/svg+xml", "DATA:text/html;base64,PHNjcmlwdD4=", "blob:https://x.test/1", "file:///etc/passwd", "custom:thing", "a:b/c?d"];

// ---- HTML: text, boolean, URL and refused attributes ------------------------------------------

for (const [name, kind, tag] of [...HTML_GLOBAL_ATTRIBUTES, ...HTML_ELEMENT_ATTRIBUTES]) {
    if (kind === "text") {
        // An <input>'s `value` is its own property on the client (the attribute is the default).
        const isOwnValue = name === "value" && tag === "input";
        test(`${name} on <${tag}>: written as given, escaped, by both`, () => withDom(() => {
            assert.equal(ssrAttribute(tag, { [name]: VALUE }, name), VALUE);
            const el = domElement(tag, { [name]: VALUE });
            assert.equal(isOwnValue ? el.value : el.getAttribute(name), VALUE);
        }));
        test(`${name} on <${tag}>: a number is its text; null and undefined write nothing`, () => withDom(() => {
            if (name !== "style") assert.equal(ssrAttribute(tag, { [name]: 0 }, name), "0");
            if (name !== "value") {
                for (const nothing of [null, undefined]) {
                    assert.equal(ssrAttribute(tag, { [name]: nothing }, name), undefined);
                    assert.equal(domElement(tag, { [name]: nothing }).hasAttribute(name), false);
                }
            }
        }));
        if (!isOwnValue && name !== "style" && name !== "class") {
            test(`${name} on <${tag}>: a reactive value follows its state, and null takes it off`, () => withDom(() => {
                const juris = client({ ...allowFor(tag), state: { v: "one" } });
                const el = juris.render(host(), { [tag]: { [name]: () => juris.getState("v") } });
                assert.equal(el.getAttribute(name), "one");
                juris.setValue("v", "two");
                assert.equal(el.getAttribute(name), "two");
                juris.setValue("v", null);
                assert.equal(el.hasAttribute(name), false);
            }));
        }
    } else if (kind === "boolean") {
        test(`${name} on <${tag}>: a boolean, present when truthy, absent when falsy, in both`, () => withDom(() => {
            for (const on of [true, "x", 1]) {
                assert.ok(["", name].includes(ssrAttribute(tag, { [name]: on }, name)), `server, ${JSON.stringify(on)}`);
                assert.ok(["", name].includes(domElement(tag, { [name]: on }).getAttribute(name)), `client, ${JSON.stringify(on)}`);
            }
            for (const off of [false, 0, "", null, undefined]) {
                assert.equal(ssrAttribute(tag, { [name]: off }, name), undefined, `server, ${JSON.stringify(off)}`);
                assert.equal(domElement(tag, { [name]: off }).hasAttribute(name), false, `client, ${JSON.stringify(off)}`);
            }
        }));
        test(`${name} on <${tag}>: a reactive boolean is put on and taken off`, () => withDom(() => {
            const juris = client({ ...allowFor(tag), state: { on: true } });
            const el = juris.render(host(), { [tag]: { [name]: () => juris.getState("on") } });
            assert.equal(el.hasAttribute(name), true);
            juris.setValue("on", false);
            assert.equal(el.hasAttribute(name), false);
            juris.setValue("on", true);
            assert.equal(el.hasAttribute(name), true);
        }));
    } else if (kind === "url") {
        test(`${name} on <${tag}>: a URL of an allowed scheme, or relative, is written by both`, () => withDom(() => {
            for (const url of SAFE_URLS) {
                assert.equal(ssrAttribute(tag, { [name]: url }, name), url, `server: ${url}`);
                assert.equal(domElement(tag, { [name]: url }).getAttribute(name), url, `client: ${url}`);
            }
        }));
        test(`${name} on <${tag}>: a URL whose scheme runs code, or is not allowed, is written by neither`, () => withDom(() => {
            for (const url of UNSAFE_URLS) {
                assert.equal(ssrAttribute(tag, { [name]: url }, name), undefined, `server: ${JSON.stringify(url)}`);
                assert.equal(domElement(tag, { [name]: url }).hasAttribute(name), false, `client: ${JSON.stringify(url)}`);
            }
        }));
        test(`${name} on <${tag}>: allowSchemes opens a scheme, never javascript:`, () => withDom(() => {
            const options = { allowSchemes: ["custom", "web+app"] };
            assert.equal(ssrAttribute(tag, { [name]: "custom:thing" }, name, options), "custom:thing");
            assert.equal(ssrAttribute(tag, { [name]: "WEB+APP:x" }, name, options), "WEB+APP:x");
            assert.equal(domElement(tag, { [name]: "custom:thing" }, options).getAttribute(name), "custom:thing");
            assert.equal(ssrAttribute(tag, { [name]: "javascript:alert(1)" }, name, options), undefined);
            assert.throws(() => server({ allowSchemes: ["javascript"] }), TypeError);
        }));
        test(`${name} on <${tag}>: a reactive URL turned unsafe takes the safe one off`, () => withDom(() => {
            const juris = client({ ...allowFor(tag), state: { url: "/safe" } });
            const el = juris.render(host(), { [tag]: { [name]: () => juris.getState("url") } });
            assert.equal(el.getAttribute(name), "/safe");
            juris.setValue("url", "javascript:alert(1)");
            assert.equal(el.hasAttribute(name), false);
        }));
    } else if (kind === "refused") {
        test(`${name} on <${tag}>: never written, whatever the value or options`, () => withDom(() => {
            for (const value of ["<script>alert(1)</script>", "plain", ""]) {
                const options = { allowSchemes: ["custom"], allowInnerHTML: true };
                assert.equal(ssrAttribute(tag, { [name]: value }, name, options), undefined);
                assert.equal(domElement(tag, { [name]: value }, options).hasAttribute(name), false);
            }
        }));
    }
}

test("className and htmlFor: React's names are written as class and for", () => withDom(() => {
    const html = server().renderToString({ label: { className: "a", htmlFor: "b" } });
    assert.deepEqual(attributesIn(html), { class: "a", for: "b" });
    const el = domElement("label", { className: "a", htmlFor: "b" });
    assert.equal(el.getAttribute("class"), "a");
    assert.equal(el.getAttribute("for"), "b");
}));

test("class, className and classList: merged into one class attribute by both", () => withDom(() => {
    const props = { classList: { on: true, off: false }, class: "base" };
    assert.deepEqual(attributesIn(server().renderToString({ div: props })), { class: "base on" });
    assert.equal(domElement("div", props).getAttribute("class"), "base on");
}));

test("hidden: \"until-found\" is a value of its own, not just presence", () => withDom(() => {
    assert.equal(ssrAttribute("div", { hidden: "until-found" }, "hidden"), "until-found");
    assert.equal(domElement("div", { hidden: "until-found" }).getAttribute("hidden"), "until-found");
}));

for (const name of FALSE_IS_A_VALUE) {
    test(`${name}: false is written as "false", never left out`, () => withDom(() => {
        assert.equal(ssrAttribute("div", { [name]: false }, name), "false");
        assert.equal(domElement("div", { [name]: false }).getAttribute(name), "false");
        assert.equal(ssrAttribute("div", { [name]: true }, name), "true");
    }));
}

test("data-*: any name, written as given, and data-key is the layout's key", () => withDom(() => {
    const props = { "data-x": "1", "data-foo-bar": VALUE, "data-": "e", key: "k" };
    assert.deepEqual(attributesIn(server().renderToString({ div: props })), { "data-x": "1", "data-foo-bar": VALUE, "data-": "e", "data-key": "k" });
    const el = domElement("div", props);
    assert.equal(el.getAttribute("data-foo-bar"), VALUE);
}));

// The value of each element that has one, as the client sets it and the server writes it.
test("value: an attribute on <input>, the text of a <textarea>, the selected <option> of a <select>", () => withDom(() => {
    assert.equal(server().renderToString({ input: { value: VALUE } }), `<input value="v&amp;&lt;&gt;&quot;&#39;">`);
    assert.equal(server().renderToString({ textarea: { value: VALUE } }), "<textarea>v&amp;&lt;&gt;\"'</textarea>");
    const select = { select: { value: "b", children: [{ option: { value: "a", textContent: "A" } }, { optgroup: { children: [{ option: { value: "b", textContent: "B" } }] } }, { option: "c" }] } };
    assert.equal(server().renderToString(select), '<select><option value="a">A</option><optgroup><option value="b" selected="">B</option></optgroup><option>c</option></select>');
    assert.equal(server().renderToString({ select: { value: "c", children: [{ option: "c" }] } }), '<select><option selected="">c</option></select>');
    assert.equal(domElement("input", { value: VALUE }).value, VALUE);
    assert.equal(domElement("textarea", { value: VALUE }).value, VALUE);
    assert.equal(domElement("select", select.select).value, "b");
    assert.equal(domElement("option", { value: "", textContent: "Pick one" }).getAttribute("value"), "", "an empty value is not the label");
}));

for (const tag of ["button", "data", "li", "meter", "progress", "option"]) {
    test(`value on <${tag}>: an attribute, the same in both`, () => withDom(() => {
        assert.equal(ssrAttribute(tag, { value: "7" }, "value"), "7");
        assert.equal(domElement(tag, { value: "7" }).getAttribute("value"), "7");
    }));
}

test("value on <output>: the server shows what the client shows", () => withDom(() => {
    const html = server().renderToString({ output: { value: "7" } });
    const el = domElement("output", { value: "7" });
    assert.equal(el.textContent, "7", "the client's output reads 7");
    assert.match(html, />7<\/output>$/, "and so does the server's");
}));

// ---- names from data ------------------------------------------------------------------------

for (const name of BAD_ATTRIBUTE_NAMES) {
    test(`attribute name ${JSON.stringify(name)}: not a name, written by neither`, () => withDom(() => {
        const html = server().renderToString({ div: { [name]: "x", id: "ok" } });
        assert.deepEqual(attributesIn(html), { id: "ok" });
        const el = domElement("div", { [name]: "x", id: "ok" });
        assert.deepEqual([...el.attrs.keys()], ["id"]);
    }));
}

test("a dropped attribute is named on the console in devMode, by both", () => withDom(() => {
    const said = [
        ...warnings(() => server({ devMode: true }).renderToString({ a: { href: "javascript:x", "a b": 1, onclick: "x" } })),
        ...warnings(() => client({ devMode: true }).render(host(), { a: { href: "javascript:x", "a b": 1, onclick: "x" } })),
    ];
    assert.equal(said.filter((line) => /href/.test(line)).length, 2, said.join("\n"));
    assert.equal(said.filter((line) => /"a b"/.test(line)).length, 2, said.join("\n"));
    assert.equal(said.filter((line) => /onclick/.test(line)).length, 2, said.join("\n"));
}));

// ---- WAI-ARIA --------------------------------------------------------------------------------

for (const name of ARIA_ATTRIBUTES) {
    test(`${name}: written as given by both, its "false" kept`, () => withDom(() => {
        for (const value of [VALUE, "false", false, "true", 3]) {
            assert.equal(ssrAttribute("div", { [name]: value }, name), String(value));
            assert.equal(domElement("div", { [name]: value }).getAttribute(name), String(value));
        }
    }));
}

// ---- event handlers --------------------------------------------------------------------------

for (const name of EVENT_HANDLER_ATTRIBUTES) {
    const camel = `on${name[2].toUpperCase()}${name.slice(3)}`;
    test(`${name}: a string is never markup, in any case`, () => withDom(() => {
        for (const key of [name, camel, name.toUpperCase()]) {
            assert.deepEqual(attributesIn(server().renderToString({ div: { [key]: "alert(1)", id: "x" } })), { id: "x" }, key);
            const el = domElement("div", { [key]: "alert(1)", id: "x" });
            assert.deepEqual([...el.attrs.keys()], ["id"], key);
            assert.equal(el.listeners.length, 0, key);
        }
        // nor through SVG or MathML, nor when the instance opens what it can
        const options = { allowInnerHTML: true, allowSchemes: ["custom"], allowTags: ["script"] };
        assert.equal(server(options).renderToString({ svg: { children: [{ rect: { [name]: "alert(1)" } }] } }), "<svg><rect></rect></svg>");
        assert.equal(server(options).renderToString({ math: { [name]: "alert(1)" } }), "<math></math>");
    }));
    test(`${name}: a function is a listener on the client and nothing on the server`, () => withDom(() => {
        const listener = () => { };
        for (const key of [name, camel]) {
            assert.equal(server().renderToString({ div: { [key]: listener } }), "<div></div>");
            const el = domElement("div", { [key]: listener });
            assert.deepEqual(el.listeners, [{ type: name.slice(2), listener }], key);
            assert.equal(el.attrs.size, 0);
        }
    }));
}

// ---- SVG -------------------------------------------------------------------------------------

const inSvg = (props) => ({ svg: { children: [{ rect: props }] } });
const svgRect = (props, options) => client(options).render(host(), inSvg(props)).children[0];
const ssrSvgAttributes = (props, options) => attributesIn(server(options).renderToString(inSvg(props)).slice("<svg>".length));

for (const name of SVG_ATTRIBUTES) {
    const value = URL_ATTRIBUTES.has(name) || name === "href" ? "#target" : name === "style" ? "fill: red" : VALUE;
    test(`svg ${name}: written in its case by both${ATTRIBUTE_NAMESPACES[name] ? ", in its namespace on the client" : ""}`, () => withDom(() => {
        assert.deepEqual(ssrSvgAttributes({ [name]: value }), { [name]: value });
        const rect = svgRect({ [name]: value });
        assert.equal(rect.namespaceURI, SVG);
        assert.deepEqual([...rect.attrs.keys()], [name]);
        assert.equal(rect.attrs.get(name).value, value);
        assert.equal(rect.attrs.get(name).ns, ATTRIBUTE_NAMESPACES[name] ?? null);
    }));
}

for (const name of ["href", "xlink:href"]) {
    test(`svg ${name}: held to the scheme rule, on <a>, <use>, <image> and <feImage>`, () => withDom(() => {
        for (const tag of ["a", "use", "image", "feImage", "textPath", "mpath", "pattern", "linearGradient", "filter"]) {
            const layout = (url) => ({ svg: { children: [{ [tag]: { [name]: url } }] } });
            for (const url of UNSAFE_URLS) {
                assert.equal(server().renderToString(layout(url)), `<svg><${tag}></${tag}></svg>`, `${tag} ${url}`);
                assert.equal(client().render(host(), layout(url)).children[0].attrs.size, 0, `${tag} ${url}`);
            }
            assert.equal(server().renderToString(layout("#a")), `<svg><${tag} ${name}="#a"></${tag}></svg>`);
        }
    }));
}

// ---- MathML ----------------------------------------------------------------------------------

const inMath = (props) => ({ math: { children: [{ mrow: props }] } });

for (const name of MATHML_ATTRIBUTES) {
    const value = name === "href" ? "https://example.test/" : name === "style" ? "color: red" : VALUE;
    test(`math ${name}: written as given by both`, () => withDom(() => {
        assert.deepEqual(attributesIn(server().renderToString(inMath({ [name]: value })).slice("<math>".length)), { [name]: value });
        const mrow = client().render(host(), inMath({ [name]: value })).children[0];
        assert.equal(mrow.getAttribute(name), value);
    }));
}

for (const name of MATHML_FALSE_IS_A_VALUE) {
    test(`math ${name}: "false" is a value`, () => withDom(() => {
        assert.deepEqual(attributesIn(server().renderToString(inMath({ [name]: false })).slice("<math>".length)), { [name]: "false" });
        assert.equal(client().render(host(), inMath({ [name]: false })).children[0].getAttribute(name), "false");
    }));
}

test("math href: held to the scheme rule", () => withDom(() => {
    for (const url of UNSAFE_URLS) {
        assert.equal(server().renderToString(inMath({ href: url })), "<math><mrow></mrow></math>", url);
        assert.equal(client().render(host(), inMath({ href: url })).children[0].attrs.size, 0, url);
    }
}));
