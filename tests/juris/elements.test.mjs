// Every element, held by a test on both renderers: each HTML element of the living standard (and
// the obsolete ones a parser still reads), each SVG 2 element and each MathML element. The server
// writes it with its end tag but for HTML's void elements, the client creates it in the right
// namespace, the two agree, and a refused tag is drawn by neither unless `allowTags` names it.
import { test } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";

import {
    HTML, SVG, MATHML, HTML_ELEMENTS, OBSOLETE_HTML_ELEMENTS, VOID_ELEMENTS, RAWTEXT_ELEMENTS, SVG_ELEMENTS,
    SVG_HTML_INTEGRATION, MATHML_ELEMENTS, MATHML_TOKEN_ELEMENTS, isRefused,
} from "../fixtures/elements.mjs";
import { FakeElement, FakeNode, withDom, serialize, created } from "../support/dom.mjs";
import { withSSR } from "../support/ssr-renderer.mjs";

const server = (options = {}) => new Juris(withSSR({ isServer: true, ...options }));
const client = (options = {}) => new Juris({ isServer: false, ...options });
const host = () => new FakeElement("div", HTML);

const TEXT = "a<b&c";
const ESCAPED = "a&lt;b&amp;c";

// What the server writes for `tag` given an id and TEXT, drawn in HTML.
function expectedHtml(tag) {
    if (VOID_ELEMENTS.has(tag)) return `<${tag} id="t">`;
    if (tag === "style") return `<style id="t">${TEXT}</style>`; // CSS, written raw (an allowed <style>)
    return `<${tag} id="t">${ESCAPED}</${tag}>`;
}

// ---- HTML ------------------------------------------------------------------------------------

for (const tag of [...HTML_ELEMENTS, ...OBSOLETE_HTML_ELEMENTS]) {
    const refused = isRefused(tag);
    const layout = { [tag]: { id: "t", textContent: TEXT } };

    test(`<${tag}> SSR: ${refused ? "left out, and drawn once allowTags names it" : "written with its id and text"}`, () => {
        if (refused) {
            assert.equal(server().renderToString(layout), "");
            assert.equal(server().renderToString({ div: { children: [layout, { p: "after" }] } }), "<div><p>after</p></div>");
            assert.equal(server({ allowTags: [tag.toUpperCase()] }).renderToString(layout), expectedHtml(tag));
        } else {
            assert.equal(server().renderToString(layout), expectedHtml(tag));
        }
    });

    test(`<${tag}> DOM: ${refused ? "never created, an empty text node in its place, until allowTags names it" : "created as an HTML element"}`, () => withDom(() => {
        if (refused) {
            const node = client().render(host(), layout);
            assert.equal(node.nodeType, FakeNode.TEXT_NODE);
            assert.equal(node.nodeValue, "");
            assert.equal(created.length, 0, "no element was made");
        }
        const el = client(refused ? { allowTags: [tag] } : {}).render(host(), layout);
        assert.equal(el.nodeType, FakeNode.ELEMENT_NODE);
        assert.equal(el.localName, tag);
        assert.equal(el.namespaceURI, HTML);
        assert.equal(el.getAttribute("id"), "t");
    }));

    if (!refused && !VOID_ELEMENTS.has(tag) && !RAWTEXT_ELEMENTS.has(tag)) {
        test(`<${tag}> parity: the client draws what the server wrote`, () => withDom(() => {
            const nested = { [tag]: { id: "t", title: "x\"y", children: [TEXT, { span: { class: "c", textContent: "s" } }] } };
            const el = client().render(host(), nested);
            assert.equal(serialize(el), server().renderToString(nested));
        }));
    }
}

for (const tag of VOID_ELEMENTS) {
    test(`<${tag}> void: holds nothing in either renderer, whatever the layout puts inside it`, () => withDom(() => {
        const allowTags = isRefused(tag) ? [tag] : [];
        for (const inside of [{ textContent: "x" }, { children: ["x", { b: "y" }] }]) {
            const layout = { [tag]: { id: "t", ...inside } };
            assert.equal(server({ allowTags }).renderToString(layout), `<${tag} id="t">`);
            const el = client({ allowTags }).render(host(), layout);
            assert.equal(el.childNodes.length, 0, `the client put ${JSON.stringify(inside)} inside <${tag}>`);
        }
    }));
}

// The parser reads a RAWTEXT element's content as it is, so text written escaped reaches the page
// with its references showing; <style> is written raw (and refused when it would end early).
// Juris draws these three as ordinary elements, their text escaped, by decision (2026-11-05): raw text
// is not safe inside a <noscript> or a <select>, and they are obsolete. So the standard's reading is
// held here as todo, a gap the contract accepts, not a bug to fix.
const RAWTEXT_ACCEPTED = "ssr-renderer: <xmp>, <noembed> and <noframes> are ordinary elements with their text escaped (a decision): text holding < or & shows its references until the client draws it";
for (const tag of ["xmp", "noembed", "noframes"]) {
    test(`<${tag}> rawtext: the parser reads the server's text as the text the client draws`, { todo: RAWTEXT_ACCEPTED }, () => {
        const html = server().renderToString({ [tag]: TEXT });
        assert.equal(html, `<${tag}>${TEXT}</${tag}>`);
    });
}

test("<template> DOM: its children are its content, as the parser makes them of the server's markup", () => withDom(() => {
    const layout = { template: { children: [{ p: "x" }] } };
    assert.equal(server().renderToString(layout), "<template><p>x</p></template>");
    const template = client().render(host(), layout);
    assert.equal(template.content.childNodes.length, 1, "the <p> is in template.content");
    assert.equal(template.childNodes.length, 0, "and not a child of the <template>");
}));

// ---- custom elements and tag names from data -------------------------------------------------

for (const tag of ["my-widget", "x-1", "a-b-c", "x-élément", "x-a.b", "x-a_b"]) {
    test(`custom element <${tag}>: a valid custom element name is drawn by both`, () => withDom(() => {
        assert.equal(server().renderToString({ [tag]: "x" }), `<${tag}>x</${tag}>`);
        assert.equal(client().render(host(), { [tag]: "x" }).localName, tag);
    }));
}

for (const tag of ["img src=x onerror=alert(1)", "a b", "a/b", "a>b", "1a", "-a", "a\"b", "a\nb", "a=b", "a\u0000b"]) {
    test(`tag ${JSON.stringify(tag)}: not a tag's name, drawn by neither`, () => withDom(() => {
        assert.equal(server().renderToString({ div: { children: [{ [tag]: {} }] } }), "<div></div>");
        const node = client().render(host(), { [tag]: {} });
        assert.equal(node.nodeType, FakeNode.TEXT_NODE);
        assert.equal(created.length, 0);
        assert.equal(server({ allowTags: [] }).renderToString({ [tag]: {} }), "");
    }));
}

// ---- SVG -------------------------------------------------------------------------------------

for (const tag of SVG_ELEMENTS) {
    const refused = isRefused(tag);
    const layout = { svg: { children: [{ [tag]: { id: "t", textContent: TEXT } }] } };

    test(`<svg><${tag}> SSR: ${refused ? "left out, and drawn once allowTags names it" : "written in its case, with an end tag"}`, () => {
        const drawn = `<svg><${tag} id="t">${ESCAPED}</${tag}></svg>`;
        if (refused) {
            assert.equal(server().renderToString(layout), "<svg></svg>");
            assert.equal(server({ allowTags: [tag] }).renderToString(layout), drawn);
        } else {
            assert.equal(server().renderToString(layout), drawn);
        }
    });

    test(`<svg><${tag}> DOM: ${refused ? "never created until allowTags names it" : "created in the SVG namespace, in its case"}`, () => withDom(() => {
        if (refused) {
            const svg = client().render(host(), layout);
            assert.equal(svg.children.length, 0);
        }
        const svg = client(refused ? { allowTags: [tag] } : {}).render(host(), layout);
        assert.equal(svg.namespaceURI, SVG);
        const el = svg.children[0];
        assert.equal(el.localName, tag);
        assert.equal(el.namespaceURI, SVG);
        if (!refused) assert.equal(serialize(svg), server().renderToString(layout));
    }));
}

test("<svg> drawn alone, in a <div>, and inside an SVG element drawn into", () => withDom(() => {
    assert.equal(client().render(host(), { svg: {} }).namespaceURI, SVG);
    const g = client().render(host(), { svg: { children: [{ g: {} }] } }).children[0];
    // a layout drawn into an SVG element is SVG, as the parser would have it
    assert.equal(client().render(g, { circle: {} }).namespaceURI, SVG);
}));

// The tags that are void in HTML are elements like any other inside <svg>: an end tag is written.
for (const tag of ["img", "br", "input", "source", "track"]) {
    test(`<svg><${tag}>: inside SVG, ${tag} is no void element`, () => {
        assert.equal(server().renderToString({ svg: { children: [{ [tag]: {} }] } }), `<svg><${tag}></${tag}></svg>`);
    });
}

for (const point of SVG_HTML_INTEGRATION) {
    test(`<svg><${point}>: what is inside is HTML again`, () => withDom(() => {
        const layout = { svg: { children: [{ [point]: { children: [{ div: { children: [{ br: {} }, { svg: { children: [{ circle: {} }] } }] } }] } }] } };
        assert.equal(server().renderToString(layout), `<svg><${point}><div><br><svg><circle></circle></svg></div></${point}></svg>`);
        const svg = client().render(host(), layout);
        const inside = svg.children[0];
        assert.equal(inside.namespaceURI, SVG);
        const div = inside.children[0];
        assert.equal(div.namespaceURI, HTML);
        assert.equal(div.children[0].namespaceURI, HTML, "<br>");
        assert.equal(div.children[1].namespaceURI, SVG, "an <svg> inside starts SVG again");
        assert.equal(div.children[1].children[0].namespaceURI, SVG);
    }));
}

// ---- MathML ----------------------------------------------------------------------------------

for (const tag of MATHML_ELEMENTS) {
    const layout = { math: { children: [{ [tag]: { id: "t", textContent: TEXT } }] } };

    test(`<math><${tag}> SSR: written with an end tag`, () => {
        assert.equal(server().renderToString(layout), `<math><${tag} id="t">${ESCAPED}</${tag}></math>`);
    });

    test(`<math><${tag}> DOM: created in the MathML namespace`, () => withDom(() => {
        const math = client().render(host(), layout);
        assert.equal(math.namespaceURI, MATHML);
        const el = math.children[0];
        assert.equal(el.localName, tag);
        assert.equal(el.namespaceURI, MATHML);
        assert.equal(serialize(math), server().renderToString(layout));
    }));
}

for (const token of MATHML_TOKEN_ELEMENTS) {
    test(`<math><${token}>: HTML inside, but for mglyph and malignmark, and an <svg> is SVG`, () => withDom(() => {
        const layout = { math: { children: [{ [token]: { children: [{ span: {} }, { mglyph: {} }, { malignmark: {} }, { svg: {} }, { br: {} }] } }] } };
        assert.equal(server().renderToString(layout), `<math><${token}><span></span><mglyph></mglyph><malignmark></malignmark><svg></svg><br></${token}></math>`);
        const [span, mglyph, malignmark, svg, br] = client().render(host(), layout).children[0].children;
        assert.equal(span.namespaceURI, HTML);
        assert.equal(mglyph.namespaceURI, MATHML);
        assert.equal(malignmark.namespaceURI, MATHML);
        assert.equal(svg.namespaceURI, SVG);
        assert.equal(br.namespaceURI, HTML);
    }));
}

for (const [encoding, inside] of [["text/html", HTML], ["TEXT/HTML", HTML], ["application/xhtml+xml", HTML], ["Application/XHTML+XML", HTML], ["image/svg+xml", MATHML], ["", MATHML], [undefined, MATHML]]) {
    test(`<annotation-xml encoding=${JSON.stringify(encoding)}>: a <div> inside is ${inside === HTML ? "HTML" : "MathML"}, an <svg> is SVG`, () => withDom(() => {
        const layout = { math: { children: [{ semantics: { children: [{ mi: "x" }, { "annotation-xml": { encoding, children: [{ div: {} }, { svg: {} }] } }] } }] } };
        const [div, svg] = client().render(host(), layout).children[0].children[1].children;
        assert.equal(div.namespaceURI, inside);
        assert.equal(svg.namespaceURI, SVG);
    }));
}
