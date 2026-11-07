// Every element with every attribute: each HTML element given all of HTML's attributes at once (and
// ARIA's, data-*, and every event handler as a string), each SVG element all of SVG's, each MathML
// element all of MathML's. Held on both renderers: every attribute is written once, as its kind
// says, whatever element carries it and whatever else it carries; nothing that is refused gets
// through in company. Booleans are given `true` here; what `false` does is held per attribute in
// attributes.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";

import { HTML, SVG, MATHML, HTML_ELEMENTS, OBSOLETE_HTML_ELEMENTS, VOID_ELEMENTS, SVG_ELEMENTS, MATHML_ELEMENTS, isRefused } from "../fixtures/elements.mjs";
import {
    HTML_GLOBAL_ATTRIBUTES, HTML_ELEMENT_ATTRIBUTES, ARIA_ATTRIBUTES, EVENT_HANDLER_ATTRIBUTES, SVG_ATTRIBUTES,
    ATTRIBUTE_NAMESPACES, MATHML_ATTRIBUTES, JURIS_BOOLEAN_ATTRIBUTES,
} from "../fixtures/attributes.mjs";
import { FakeElement, withDom } from "../support/dom.mjs";
import { attributesIn, startTag } from "../support/markup.mjs";
import { withSSR } from "../support/ssr-renderer.mjs";

const VALUE = `v&<>"'`;
const URL = "https://example.test/a?b=1&c=2";
const STYLE = "color: red";

// The props given, and what each attribute should come out as: a string, PRESENT (a boolean, any
// value), or ABSENT.
const PRESENT = Symbol("present");
const ABSENT = Symbol("absent");

function htmlCase() {
    const props = {};
    const expected = {};
    for (const [name, kind] of [...HTML_GLOBAL_ATTRIBUTES, ...HTML_ELEMENT_ATTRIBUTES]) {
        if (kind === "text") { props[name] = name === "style" ? STYLE : VALUE; expected[name] = props[name]; }
        if (kind === "boolean") { props[name] = true; expected[name] = PRESENT; }
        if (kind === "url") { props[name] = URL; expected[name] = URL; }
        if (kind === "refused") { props[name] = "<script>alert(1)</script>"; expected[name] = ABSENT; }
    }
    for (const name of ARIA_ATTRIBUTES) { props[name] = VALUE; expected[name] = VALUE; }
    for (const name of ["data-x", "data-foo-bar"]) { props[name] = VALUE; expected[name] = VALUE; }
    for (const name of EVENT_HANDLER_ATTRIBUTES) { props[name] = "alert(1)"; expected[name] = ABSENT; }
    return { props, expected };
}

function foreignCase(names) {
    const props = {};
    const expected = {};
    for (const name of names) {
        props[name] = name === "href" || name === "xlink:href" ? "#a" : name === "style" ? STYLE : VALUE;
        // A name Juris holds as a boolean is one, whatever the element (an SVG or MathML attribute
        // that shares the name is written as presence): see attributes.test.mjs, "math open".
        expected[name] = JURIS_BOOLEAN_ATTRIBUTES.has(name.toLowerCase()) ? PRESENT : props[name];
    }
    for (const name of [...ARIA_ATTRIBUTES, "role", "data-x"]) { props[name] = VALUE; expected[name] = VALUE; }
    for (const name of EVENT_HANDLER_ATTRIBUTES) { props[name] = "alert(1)"; expected[name] = ABSENT; }
    return { props, expected };
}

// Holds `actual` (name -> value) to `expected`, and says every attribute that differs at once.
function compare(actual, expected, label) {
    const wrong = [];
    for (const [name, want] of Object.entries(expected)) {
        const got = actual[name];
        if (want === ABSENT ? got !== undefined : want === PRESENT ? got === undefined : got !== want) {
            wrong.push(`${name}: ${got === undefined ? "absent" : JSON.stringify(got)}, wanted ${want === ABSENT ? "absent" : want === PRESENT ? "present" : JSON.stringify(want)}`);
        }
    }
    for (const name of Object.keys(actual)) if (!(name in expected)) wrong.push(`${name}: written, and never given`);
    assert.deepEqual(wrong, [], `${label}:\n  ${wrong.join("\n  ")}`);
}

const HTML_CASE = htmlCase();
const SVG_CASE = foreignCase(SVG_ATTRIBUTES);
const MATHML_CASE = foreignCase(MATHML_ATTRIBUTES);

// ---- HTML ------------------------------------------------------------------------------------

for (const tag of [...HTML_ELEMENTS, ...OBSOLETE_HTML_ELEMENTS]) {
    const options = isRefused(tag) ? { allowTags: [tag] } : {};
    // `value` is no attribute of a <select> (it picks an option), nor of a <textarea> or an <output>
    // (it is the text).
    const expected = { ...HTML_CASE.expected };
    if (tag === "select" || tag === "textarea" || tag === "output") expected.value = ABSENT;

    test(`<${tag}> with every HTML attribute: SSR`, () => {
        const html = new Juris(withSSR({ isServer: true, ...options })).renderToString({ [tag]: HTML_CASE.props });
        compare(attributesIn(html), expected, `<${tag}>`);
        const { rest } = startTag(html);
        if (VOID_ELEMENTS.has(tag)) assert.equal(rest, "", "a void element ends at its start tag");
        else if (tag === "textarea" || tag === "output") assert.equal(rest, `v&amp;&lt;&gt;"'</${tag}>`);
        else assert.equal(rest, `</${tag}>`);
    });

    test(`<${tag}> with every HTML attribute: DOM`, () => withDom(() => {
        const el = new Juris({ isServer: false, ...options }).render(new FakeElement("div", HTML), { [tag]: HTML_CASE.props });
        assert.equal(el.namespaceURI, HTML);
        const actual = Object.fromEntries([...el.attrs].map(([name, { value }]) => [name, value]));
        // An <input>, <textarea>, <select> and <output> take `value` as their own; the attribute stays as the server wrote it.
        const domExpected = { ...expected };
        if (["input", "textarea", "select", "output"].includes(tag)) {
            domExpected.value = ABSENT;
            assert.equal(el.value, tag === "select" ? VALUE : VALUE, `<${tag}>.value`);
        }
        compare(actual, domExpected, `<${tag}>`);
        assert.equal(el.listeners.length, 0, "a string is never a listener");
    }));
}

// ---- SVG and MathML --------------------------------------------------------------------------

const drawn = (root, tag) => (tag === root ? { [root]: {} } : null);

for (const [root, namespace, elements, kase, names] of [["svg", SVG, SVG_ELEMENTS, SVG_CASE, "SVG"], ["math", MATHML, MATHML_ELEMENTS, MATHML_CASE, "MathML"]]) {
    for (const tag of elements) {
        const options = isRefused(tag) ? { allowTags: [tag] } : {};
        const layout = drawn(root, tag) ? { [root]: kase.props } : { [root]: { children: [{ [tag]: kase.props }] } };
        const inner = (html) => (drawn(root, tag) ? html : html.slice(`<${root}>`.length));

        test(`<${root}><${tag}> with every ${names} attribute: SSR`, () => {
            const html = new Juris(withSSR({ isServer: true, ...options })).renderToString(layout);
            compare(attributesIn(inner(html)), kase.expected, `<${tag}>`);
        });

        test(`<${root}><${tag}> with every ${names} attribute: DOM`, () => withDom(() => {
            const top = new Juris({ isServer: false, ...options }).render(new FakeElement("div", HTML), layout);
            const el = drawn(root, tag) ? top : top.children[0];
            assert.equal(el.namespaceURI, namespace);
            const actual = Object.fromEntries([...el.attrs].map(([name, { value }]) => [name, value]));
            compare(actual, kase.expected, `<${tag}>`);
            for (const [name, ns] of Object.entries(ATTRIBUTE_NAMESPACES)) {
                if (el.attrs.has(name)) assert.equal(el.attrs.get(name).ns, ns, `${name} in its namespace`);
            }
        }));
    }
}
