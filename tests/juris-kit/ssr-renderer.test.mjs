// server/ssr-renderer.js, the markup: what renderToString writes for text, elements, attributes,
// classes, styles, values, <select>/<option>, raw <style> text, namespaces and their integration
// points, and what it refuses to write (html-safety.js's rules, on the server's side). Values that
// are functions, settled values and real promises are here too; components, boundaries and the trace
// are in ssr-renderer.components.test.mjs. The renderer is given to the instance as a feature
// (`features: { ssr: SSRRenderer }`), as the kit's server gives its own. Held to REFERENCE.md's
// "server/ssr-renderer.js", "Components and layouts" and "Safe by default".
import { test } from "node:test";
import assert from "node:assert/strict";

import Juris from "juris/juris.js";
import SSRRenderer, { escapeText, escapeAttribute } from "juris-kit/server/ssr-renderer.js";
import { settled, settledError } from "juris/state-manager.js";
import { attributesIn, startTag } from "../support/markup.mjs";

const SVG = "http://www.w3.org/2000/svg";
const MATHML = "http://www.w3.org/1998/Math/MathML";

const server = (options = {}) => new Juris({ isServer: true, ...options, features: { ssr: SSRRenderer, ...options.features } });
const html = (layout, options) => server(options).renderToString(layout);

// Runs `fn` with console.warn and console.error collected; answers { result, warned, errored }.
function said(fn) {
    const warned = [];
    const errored = [];
    const original = { warn: console.warn, error: console.error };
    console.warn = (...args) => warned.push(args.map(String).join(" "));
    console.error = (...args) => errored.push(args.map(String).join(" "));
    try {
        return { result: fn(), warned, errored };
    } finally {
        Object.assign(console, original);
    }
}

// ---- the escapers ---------------------------------------------------------------------------

test("escapeText escapes &, < and >, and nothing else", () => {
    assert.equal(escapeText(`a & b < c > d "e" 'f'`), `a &amp; b &lt; c &gt; d "e" 'f'`);
    assert.equal(escapeText("&amp;"), "&amp;amp;");
    assert.equal(escapeText(42), "42");
    assert.equal(escapeText(null), "null");
});

test("escapeAttribute escapes both quotes as well, so either quoting is safe", () => {
    assert.equal(escapeAttribute(`a & b < c > d "e" 'f'`), "a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39;");
    assert.equal(escapeAttribute(0), "0");
});

// ---- text and elements ------------------------------------------------------------------------

test("a text layout is its text, escaped; null, undefined and booleans are nothing", () => {
    const juris = server();
    assert.equal(juris.renderToString("<b>&</b>"), "&lt;b&gt;&amp;&lt;/b&gt;");
    assert.equal(juris.renderToString(42), "42");
    assert.equal(juris.renderToString(0), "0");
    assert.equal(juris.renderToString(null), "");
    assert.equal(juris.renderToString(undefined), "");
    assert.equal(juris.renderToString(true), "");
    assert.equal(juris.renderToString(false), "");
});

test("an element's content may be its text, or null for an empty element", () => {
    const juris = server();
    assert.equal(juris.renderToString({ p: "Nothing <here>." }), "<p>Nothing &lt;here&gt;.</p>");
    assert.equal(juris.renderToString({ p: 7 }), "<p>7</p>");
    assert.equal(juris.renderToString({ p: null }), "<p></p>");
    assert.equal(juris.renderToString({ p: undefined }), "<p></p>");
    assert.equal(juris.renderToString({ p: {} }), "<p></p>");
});

test("a void element is written without an end tag, and nothing inside it", () => {
    for (const tag of ["area", "br", "col", "hr", "img", "input", "source", "track", "wbr"]) {
        assert.equal(html({ [tag]: { children: "x", textContent: "y" } }), `<${tag}>`, tag);
    }
    assert.equal(html({ IMG: { alt: "a" } }), '<IMG alt="a">');
});

test("children are a layout, a list, text, or a function run once", () => {
    const juris = server();
    assert.equal(juris.renderToString({ ul: { children: { li: "one" } } }), "<ul><li>one</li></ul>");
    assert.equal(juris.renderToString({ ul: { children: [{ li: "a" }, "b & c", 3, null, { li: null }] } }), "<ul><li>a</li>b &amp; c3<li></li></ul>");
    assert.equal(juris.renderToString({ ul: { children: () => [{ li: "x" }, { li: "y" }] } }), "<ul><li>x</li><li>y</li></ul>");
    assert.equal(juris.renderToString({ ul: { children: null } }), "<ul></ul>");
    assert.equal(juris.renderToString({ ul: { children: () => undefined } }), "<ul></ul>");
});

test("a seat is run once, given null for the element it has none of, and a seat it answers is run in turn", () => {
    const given = [];
    const out = html({
        p: {
            children: [
                (element) => {
                    given.push(element);
                    return (inner) => {
                        given.push(inner);
                        return "deep";
                    };
                },
            ],
        },
    });
    assert.equal(out, "<p>deep</p>");
    assert.deepEqual(given, [null, null]);
});

test("an attribute's function is run once and given null", () => {
    let calls = 0;
    const out = html({
        a: {
            title: (element) => {
                calls += 1;
                assert.equal(element, null);
                return "t";
            },
        },
    });
    assert.equal(out, '<a title="t"></a>');
    assert.equal(calls, 1);
});

test("an empty object, or a list, is no layout", () => {
    const { result, warned } = said(() => server({ devMode: true }).renderToString({ div: { children: [{}] } }));
    assert.equal(result, "<div></div>");
    assert.match(warned.join("\n"), /dropped tag name "undefined" is not a tag/);
    assert.throws(() => html([{ p: "a" }, { p: "b" }]), { name: "Error", message: /a layout is one \{ tag: content \} object/ });
});

// ---- attributes -----------------------------------------------------------------------------

test("an attribute's value is escaped for either quoting, and read back exactly", () => {
    const value = `"><script>alert('x')</script>&amp;`;
    const out = html({ div: { title: value, "data-x": "a'b" } });
    assert.doesNotMatch(out, /<script>/);
    assert.deepEqual(attributesIn(out), { title: value, "data-x": "a'b" });
});

test("attributes are written in the order the layout gives them, values as text", () => {
    const out = html({ div: { id: "main", "aria-hidden": false, tabindex: 0, "data-n": 1.5 } });
    assert.deepEqual(startTag(out).attributes, [["id", "main"], ["aria-hidden", "false"], ["tabindex", "0"], ["data-n", "1.5"]]);
});

test("an attribute of null or undefined is left out", () => {
    assert.equal(html({ div: { title: null, lang: undefined, id: () => null } }), "<div></div>");
});

test("htmlFor is written as for, className as class", () => {
    assert.equal(html({ label: { htmlFor: "name", className: "field" } }), '<label for="name" class="field"></label>');
});

test("key is written as data-key, and left out when undefined", () => {
    assert.equal(html({ li: { key: 7 } }), '<li data-key="7"></li>');
    assert.equal(html({ li: { key: 0 } }), '<li data-key="0"></li>');
    assert.equal(html({ li: { key: "a\"b" } }), '<li data-key="a&quot;b"></li>');
    assert.equal(html({ li: { key: undefined } }), "<li></li>");
});

test("a listener has no HTML, and an on… attribute with a string is never written", () => {
    let ran = false;
    const { result, warned } = said(() =>
        server({ devMode: true }).renderToString({ button: { onclick: () => { ran = true; }, onmouseover: "alert(1)", ONERROR: "alert(2)", type: "button" } }),
    );
    assert.equal(result, '<button type="button"></button>');
    assert.equal(ran, false);
    assert.match(warned.join("\n"), /dropped attribute name "onmouseover" is not allowed/);
    assert.match(warned.join("\n"), /dropped attribute name "ONERROR" is not allowed/);
});

test("an attribute name from data is left out whole", () => {
    const row = { "x onmouseover=alert(1)": "y", "a b": 1, title: "kept" };
    assert.equal(html({ div: { ...row } }), '<div title="kept"></div>');
});

test("a URL attribute whose scheme runs code is left out, and named in devMode", () => {
    const { result, warned } = said(() =>
        server({ devMode: true }).renderToString({ a: { href: "java\tscript:alert(1)", children: "x" } }),
    );
    assert.equal(result, "<a>x</a>");
    assert.match(warned.join("\n"), /dropped href refuses "java\tscript:alert\(1\)": scheme not allowed/);
    assert.equal(html({ a: { href: "https://example.com/?a=1&b=2" } }), '<a href="https://example.com/?a=1&amp;b=2"></a>');
    assert.equal(html({ img: { src: "data:text/html,<script>" } }), "<img>");
    assert.equal(html({ img: { src: "data:image/png;base64,AA" } }), '<img src="data:image/png;base64,AA">');
});

test("allowSchemes opens a scheme in a URL attribute, on the instance given it", () => {
    assert.equal(html({ a: { href: "magnet:?xt=1" } }), "<a></a>");
    assert.equal(html({ a: { href: "magnet:?xt=1" } }, { allowSchemes: ["magnet"] }), '<a href="magnet:?xt=1"></a>');
});

test("srcdoc is never written, whatever the instance allows", () => {
    const out = html({ iframe: { srcdoc: "<script>alert(1)</script>", src: "/x" } }, { allowTags: ["iframe"], allowInnerHTML: true });
    assert.equal(out, '<iframe src="/x"></iframe>');
});

test("silently outside devMode: a refused attribute says nothing on the console", () => {
    const { result, warned } = said(() => html({ a: { href: "javascript:x", onclick: "y", style: { color: "a;b" } } }));
    assert.equal(result, "<a></a>");
    assert.deepEqual(warned, []);
});

test("a layout given where only text is taken is ignored, and named in devMode", () => {
    const { result, warned } = said(() =>
        server({ devMode: true }).renderToString({ p: { title: { b: "x" }, textContent: { i: "y" } } }),
    );
    assert.equal(result, "<p></p>");
    assert.equal(warned.filter((line) => /"title" was given an object, and takes text/.test(line)).length, 1);
    assert.equal(warned.filter((line) => /"textContent" was given an object/.test(line)).length, 1);
    assert.equal(html({ p: { title: () => ["a"] } }), "<p></p>");
});

// A tag's whole content as a function gives text; the DOM renderer says the same (dom-renderer).
test("devMode: a function as the whole content that returns a layout is pointed at children", () => {
    const { result, warned } = said(() => server({ devMode: true }).renderToString({ ul: () => [{ li: "Milk" }] }));
    assert.equal(result, "<ul></ul>");
    assert.deepEqual(warned, [
        "Juris: <ul> was given a function as its whole content, which gives text, and it returned a list"
            + " (to draw layouts, make the function its children: { ul: { children: () => [...] } }); ignored [object Object]",
    ]);
});

test("a function as the whole content that returns text writes it, and says nothing", () => {
    const { result, warned } = said(() => server({ devMode: true }).renderToString({ b: () => 3 }));
    assert.equal(result, "<b>3</b>");
    assert.deepEqual(warned, []);
});

// It need not be a layout: devMode says what it was given, and never that a layout was returned.
test("devMode names a plain object or a list given as an attribute's value for what it is", () => {
    const { result, warned } = said(() =>
        server({ devMode: true }).renderToString({
            div: { "data-cart": { items: 2 }, "data-skus": ["milk"] },
        }),
    );
    assert.equal(result, "<div></div>");
    assert.deepEqual(warned, [
        'Juris: "data-cart" was given an object, and takes text (a string or a number;'
            + " a layout goes in children); ignored [object Object]",
        'Juris: "data-skus" was given a list, and takes text (a string or a number;'
            + " a layout goes in children); ignored milk",
    ]);
});

// ---- boolean attributes -----------------------------------------------------------------------

test("a boolean attribute is present when its value is truthy, and absent otherwise", () => {
    assert.equal(html({ input: { disabled: true, checked: 1, required: "yes", hidden: false, readonly: 0, autofocus: null } }), '<input disabled="" checked="" required="">');
    assert.equal(html({ details: { open: () => true } }), '<details open=""></details>');
    assert.equal(html({ details: { open: () => false } }), "<details></details>");
});

test("every boolean attribute HTML has is written bare", () => {
    const names = ["allowfullscreen", "async", "autofocus", "autoplay", "checked", "controls", "default", "defer", "disabled", "formnovalidate", "hidden", "inert", "ismap", "itemscope", "loop", "multiple", "muted", "nomodule", "novalidate", "open", "playsinline", "readonly", "required", "reversed", "selected"];
    for (const name of names) {
        assert.deepEqual(attributesIn(html({ div: { [name]: true } })), { [name]: "" }, name);
        assert.equal(html({ div: { [name]: false } }), "<div></div>", name);
    }
});

test("hidden=\"until-found\" is written as given, in any case; any other value is the boolean", () => {
    assert.equal(html({ div: { hidden: "until-found" } }), '<div hidden="until-found"></div>');
    assert.equal(html({ div: { hidden: () => "UNTIL-FOUND" } }), '<div hidden="UNTIL-FOUND"></div>');
    assert.equal(html({ div: { hidden: "until" } }), '<div hidden=""></div>');
});

test("on an SVG or MathML element, a name HTML holds as a boolean is written as given", () => {
    assert.equal(html({ svg: { hidden: false, children: [{ rect: { disabled: "no" } }] } }), '<svg hidden="false"><rect disabled="no"></rect></svg>');
    assert.equal(html({ math: { children: [{ mfenced: { open: "[", close: "]" } }] } }), '<math><mfenced open="[" close="]"></mfenced></math>');
    assert.equal(html({ math: { children: [{ mtext: { children: [{ details: { open: true } }] } }] } }), '<math><mtext><details open=""></details></mtext></math>', "HTML again inside a token element");
});

// HTML has no indeterminate attribute: it is an <input>'s property alone, which the client sets.
test("indeterminate on an <input> writes nothing, its function never run; on another element it is an attribute", () => {
    let ran = false;
    const indeterminate = () => {
        ran = true;
        return true;
    };
    assert.equal(html({ input: { type: "checkbox", indeterminate: true } }), '<input type="checkbox">');
    assert.equal(html({ input: { type: "checkbox", indeterminate } }), '<input type="checkbox">');
    assert.equal(ran, false);
    assert.equal(html({ "x-check": { indeterminate: true } }), '<x-check indeterminate="true"></x-check>');
    assert.equal(
        html({ svg: { children: [{ input: { indeterminate: true } }] } }),
        '<svg><input indeterminate="true"></input></svg>',
        "inside <svg> an input is no HTML input",
    );
});

test("an <output>'s value is its text, escaped, and no attribute, as the client's output.value shows it", () => {
    assert.equal(html({ output: { value: "a < b", name: "o" } }), '<output name="o">a &lt; b</output>');
    assert.equal(html({ output: { value: () => 7 } }), "<output>7</output>");
    assert.equal(html({ output: { value: null } }), "<output></output>");
});

// ---- classes ----------------------------------------------------------------------------------

test("class and className are the class attribute; null leaves it out", () => {
    assert.equal(html({ p: { class: "a b" } }), '<p class="a b"></p>');
    assert.equal(html({ p: { className: () => "c" } }), '<p class="c"></p>');
    assert.equal(html({ p: { class: null, id: "x" } }), '<p id="x"></p>');
});

test("a classList adds the names whose value is truthy, a function's included", () => {
    assert.equal(html({ p: { classList: { on: true, off: false, live: () => 1, dead: () => 0 } } }), '<p class="on live"></p>');
});

test("a classList key is one or more class names, split on whitespace, an empty key nothing", () => {
    assert.equal(html({ p: { classList: { "btn  active": true, "": true, "\t": true, x: true } } }), '<p class="btn active x"></p>');
});

test("class and classList go into one attribute, where the first of them appeared", () => {
    const out = html({ p: { id: "a", classList: { extra: true }, title: "t", class: "base" } });
    assert.deepEqual(startTag(out).attributes, [["id", "a"], ["class", "base extra"], ["title", "t"]]);
});

test("no class attribute when nothing names a class", () => {
    assert.equal(html({ p: { classList: { a: false } } }), "<p></p>");
    assert.equal(html({ p: { classList: {}, class: undefined } }), "<p></p>");
});

test("a function as classList is run for its whole { name: boolean } object, merged with class as an object is", () => {
    const juris = server({ state: { menu: { open: true, wide: false } } });
    const nav = juris.renderToString({
        nav: { className: "menu", classList: () => juris.getState("menu") },
    });
    assert.equal(nav, '<nav class="menu open"></nav>');
    const out = html({
        p: { id: "a", classList: () => ({ extra: true }), title: "t", class: "base" },
    });
    assert.deepEqual(startTag(out).attributes, [["id", "a"], ["class", "base extra"], ["title", "t"]]);
});

test("a classList function's keys are split on whitespace, and an object naming no class writes none", () => {
    const out = html({
        p: { classList: () => ({ "btn  active": true, "": true, "\t": true, off: 0 }) },
    });
    assert.equal(out, '<p class="btn active"></p>');
    for (const nothing of [null, undefined, {}, { off: false }]) {
        assert.equal(html({ p: { classList: () => nothing } }), "<p></p>");
    }
});

test("the object a classList function gives is used as it is: a function in it is not run, and is true", () => {
    let runs = 0;
    const isOpen = () => {
        runs += 1;
        return false;
    };
    assert.equal(html({ p: { classList: () => ({ open: isOpen }) } }), '<p class="open"></p>');
    assert.equal(runs, 0);
});

test("classList decides the classes it names over className's, and writes none twice", () => {
    assert.equal(
        html({ nav: { className: "menu open", classList: { open: false } } }),
        '<nav class="menu"></nav>',
    );
    assert.equal(
        html({ nav: { className: "menu open", classList: { open: true } } }),
        '<nav class="menu open"></nav>',
    );
    assert.equal(
        html({ nav: { classList: () => ({ menu: false, open: true }), class: "menu" } }),
        '<nav class="open"></nav>',
    );
});

test("where two classList keys name a class, the later decides it, and it is written once", () => {
    assert.equal(html({ p: { classList: { "a b": true, b: true } } }), '<p class="a b"></p>');
    assert.equal(html({ p: { classList: { "a b": true, b: false } } }), '<p class="a"></p>');
    assert.equal(html({ p: { classList: { b: false, "a b": () => true } } }), '<p class="a b"></p>');
    assert.equal(html({ p: { classList: () => ({ "a b": true, b: false }) } }), '<p class="a"></p>');
});

test("className is written as given until classList changes it, then its classes once each, a space apart", () => {
    assert.equal(html({ p: { className: "a  b", classList: { a: true } } }), '<p class="a  b"></p>');
    assert.equal(html({ p: { className: "a  b a", classList: { c: true } } }), '<p class="a b c"></p>');
    assert.equal(html({ p: { className: "", classList: { c: true } } }), '<p class="c"></p>');
    assert.equal(html({ p: { className: "a", classList: { a: false } } }), '<p class=""></p>');
    assert.equal(html({ p: { classList: { "a ": true, a: false } } }), "<p></p>");
});

test("class and className are one attribute: given both, the later is it, and the earlier is never run", () => {
    let runs = 0;
    const counted = () => {
        runs += 1;
        return "a";
    };
    assert.equal(html({ p: { class: counted, className: "b" } }), '<p class="b"></p>');
    assert.equal(runs, 0);
    assert.equal(html({ p: { className: "b", id: "x", class: "a" } }), '<p class="a" id="x"></p>');
    assert.equal(html({ p: { className: "b", class: undefined } }), "<p></p>");
});

test("a class given as a layout or a list is left out, as the client leaves it", () => {
    assert.equal(html({ p: { className: ["a", "b"] } }), "<p></p>");
    assert.equal(html({ p: { class: () => ({ span: "a" }), classList: { x: true } } }), '<p class="x"></p>');
});

// ---- styles -----------------------------------------------------------------------------------

test("a style object is written as declarations, camelCase as CSS names", () => {
    assert.equal(
        html({ div: { style: { marginTop: "1px", WebkitTransform: "none", msTransform: "none", cssFloat: "left", "--accent": "#f00", zIndex: 0 } } }),
        '<div style="margin-top:1px;-webkit-transform:none;-ms-transform:none;float:left;--accent:#f00;z-index:0"></div>',
    );
});

test("a style string is written as given, escaped for the attribute", () => {
    assert.equal(html({ div: { style: 'color: red; content: "x"' } }), '<div style="color: red; content: &quot;x&quot;"></div>');
});

test("a style of nothing, or of nothing kept, writes no style attribute", () => {
    assert.equal(html({ div: { style: null } }), "<div></div>");
    assert.equal(html({ div: { style: undefined } }), "<div></div>");
    assert.equal(html({ div: { style: {} } }), "<div></div>");
    assert.equal(html({ div: { style: { color: null, top: undefined, left: "" } } }), "<div></div>");
});

test("a style key that is no property, or a value that would end its declaration, is left out", () => {
    const { result, warned } = said(() =>
        server({ devMode: true }).renderToString({
            div: { style: { color: "red;background:url(//x)", cssText: "a:b", "margin-top": "1px", width: "10px", height: { px: 1 }, top: "1px /* x" } },
        }),
    );
    assert.equal(result, '<div style="width:10px"></div>');
    assert.equal(warned.length, 5);
    assert.match(warned.join("\n"), /dropped style color refuses "red;background:url\(\/\/x\)": not a single value/);
    assert.match(warned.join("\n"), /dropped style key "cssText" is not a property/);
});

test("webkitTransform, in lower case, is -webkit-transform, as WebkitTransform is", () => {
    assert.equal(
        html({ div: { style: { webkitTransform: "none", webkitUserSelect: "none" } } }),
        '<div style="-webkit-transform:none;-webkit-user-select:none"></div>',
    );
});

test("a style may be a function, run once, answering an object or a string", () => {
    assert.equal(html({ div: { style: () => ({ color: "blue" }) } }), '<div style="color:blue"></div>');
    assert.equal(html({ div: { style: () => "color: green" } }), '<div style="color: green"></div>');
});

// ---- textContent and innerHTML ------------------------------------------------------------------

test("textContent is text, always escaped, in place of the children", () => {
    assert.equal(html({ p: { textContent: "<b>a & b</b>" } }), "<p>&lt;b&gt;a &amp; b&lt;/b&gt;</p>");
    assert.equal(html({ p: { textContent: () => 5 } }), "<p>5</p>");
    assert.equal(html({ p: { textContent: null } }), "<p></p>");
});

test("innerHTML is left out by default, its function never run, and named in devMode", () => {
    let ran = false;
    const { result, warned } = said(() =>
        server({ devMode: true }).renderToString({ div: { innerHTML: () => { ran = true; return "<img src=x onerror=alert(1)>"; }, children: "safe" } }),
    );
    assert.equal(result, "<div>safe</div>");
    assert.equal(ran, false);
    assert.match(warned.join("\n"), /dropped innerHTML: markup is not written from a layout/);
    assert.equal(html({ div: { ...{ innerHTML: "<b>x</b>" } } }), "<div></div>");
});

test("allowInnerHTML writes innerHTML as given", () => {
    const juris = server({ allowInnerHTML: true });
    assert.equal(juris.renderToString({ div: { innerHTML: "<b>bold</b> & raw" } }), "<div><b>bold</b> & raw</div>");
    assert.equal(juris.renderToString({ div: { innerHTML: () => "<i>x</i>" } }), "<div><i>x</i></div>");
    assert.equal(juris.renderToString({ div: { innerHTML: null } }), "<div></div>");
    assert.equal(juris.renderToString({ div: { innerHTML: { b: "x" } } }), "<div></div>");
});

// What an element holds is one thing (REFERENCE.md, "Components and layouts"): its textContent, or
// an innerHTML the instance allows, the later of the two; else an <output>'s or a <textarea>'s
// value; else its children. The keys decide it, whatever their values and order.
test("textContent is all an element holds: children beside it are not drawn, whatever its value", () => {
    const children = ["a", { b: "c" }];
    assert.equal(html({ p: { textContent: "y", children } }), "<p>y</p>");
    assert.equal(html({ p: { children, textContent: "y" } }), "<p>y</p>", "in either order");
    for (const text of ["", null, undefined, false, () => null]) {
        assert.equal(html({ p: { textContent: text, children } }), "<p></p>", String(text));
    }
    assert.equal(html({ p: { textContent: { i: "x" }, children } }), "<p></p>", "a layout in it, refused, too");
});

test("an allowed innerHTML is all an element holds; a refused one is left out, and the children are drawn", () => {
    const allowed = server({ allowInnerHTML: true });
    assert.equal(allowed.renderToString({ p: { innerHTML: "<b>y</b>", children: ["a"] } }), "<p><b>y</b></p>");
    assert.equal(allowed.renderToString({ p: { children: ["a"], innerHTML: { i: "x" } } }), "<p></p>");
    assert.equal(allowed.renderToString({ p: { textContent: "<t>", innerHTML: "<b>h</b>" } }), "<p><b>h</b></p>");
    assert.equal(allowed.renderToString({ p: { innerHTML: "<b>h</b>", textContent: "<t>" } }), "<p>&lt;t&gt;</p>");
    assert.equal(html({ p: { innerHTML: "<b>y</b>", children: ["a"] } }), "<p>a</p>");
});

test("an <output> or a <textarea> holds its textContent over its value, and its value over its children", () => {
    assert.equal(html({ output: { textContent: "x", value: 42 } }), "<output>x</output>");
    assert.equal(html({ output: { value: 42, textContent: "x" } }), "<output>x</output>");
    assert.equal(html({ textarea: { value: "y", textContent: "x" } }), "<textarea>x</textarea>");
    assert.equal(html({ output: { value: 42, children: ["a", { b: "c" }] } }), "<output>42</output>");
    assert.equal(html({ textarea: { children: "a", value: "y" } }), "<textarea>y</textarea>");
});

test("devMode names the children, or the value, that what an element holds leaves out", () => {
    const { warned } = said(() => {
        const juris = server({ devMode: true, allowInnerHTML: true });
        juris.renderToString({ p: { textContent: "y", children: ["a"] } });
        juris.renderToString({ p: { innerHTML: "<b>y</b>", children: "a" } });
        juris.renderToString({ output: { textContent: "x", value: 42 } });
        juris.renderToString({ textarea: { value: "y", children: ["a"] } });
        juris.renderToString({ p: { textContent: "y", children: null } });
        juris.renderToString({ p: { textContent: "y", children: undefined } });
        juris.renderToString({ input: { textContent: "y", children: ["a"] } });
    });
    assert.deepEqual(warned, [
        "Juris: dropped children: <p> holds its textContent, and nothing beside it",
        "Juris: dropped children: <p> holds its innerHTML, and nothing beside it",
        "Juris: dropped value: <output> holds its textContent, and nothing beside it",
        "Juris: dropped children: <textarea> holds its value, and nothing beside it",
    ]);
});

test("true and false as the content, in textContent or in innerHTML, are nothing, as in children", () => {
    assert.equal(html({ p: false }), "<p></p>");
    assert.equal(html({ p: true }), "<p></p>");
    assert.equal(html({ p: { textContent: false } }), "<p></p>");
    assert.equal(html({ p: { textContent: () => true } }), "<p></p>");
    assert.equal(server({ allowInnerHTML: true }).renderToString({ p: { innerHTML: false } }), "<p></p>");
    assert.equal(html({ p: { children: [false, "a", true] } }), "<p>a</p>");
    const isAdmin = false;
    assert.equal(html({ p: isAdmin && "Admin" }), "<p></p>");
    assert.equal(html({ p: 0 }), "<p>0</p>", "a number is text, 0 included");
});

// ---- refused tags ---------------------------------------------------------------------------------

test("a refused tag is left out whole, children and all, and named in devMode", () => {
    const { result, warned } = said(() =>
        server({ devMode: true }).renderToString({ div: { children: [{ script: "alert(1)" }, { iframe: { src: "/x" } }, { p: "kept" }, { plaintext: "x" }] } }),
    );
    assert.equal(result, "<div><p>kept</p></div>");
    assert.match(warned.join("\n"), /dropped <script> is not allowed in a layout \(pass allowTags: \["script"\] if it really is wanted\)/);
    assert.match(warned.join("\n"), /dropped <iframe>/);
    assert.match(warned.join("\n"), /dropped <plaintext>/);
});

test("a tag name from data is left out, its own attributes with it", () => {
    assert.equal(html({ div: { children: [{ "img src=x onerror=alert(1)": {} }, "after"] } }), "<div>after</div>");
});

test("SVG's style and animation elements are refused inside <svg> too", () => {
    const out = html({ svg: { children: [{ style: "*{}" }, { set: { attributeName: "href", to: "javascript:x" } }, { animate: {} }, { animateMotion: {} }, { animateTransform: {} }, { circle: { r: 1 } }] } });
    assert.equal(out, '<svg><circle r="1"></circle></svg>');
});

test("allowTags opens a refused tag by name, on the instance given it", () => {
    assert.equal(html({ iframe: { src: "/frame" } }, { allowTags: ["iframe"] }), '<iframe src="/frame"></iframe>');
    assert.equal(html({ IFRAME: {} }, { allowTags: ["iframe"] }), "<IFRAME></IFRAME>");
    assert.equal(html({ object: {} }, { allowTags: ["iframe"] }), "");
});

// ---- value, textarea, select ----------------------------------------------------------------------

test("an input's value is its value attribute, written after the others, an empty one for nothing", () => {
    assert.deepEqual(startTag(html({ input: { value: "a\"b", type: "text" } })).attributes, [["type", "text"], ["value", 'a"b']]);
    assert.equal(html({ input: { value: null } }), '<input value="">');
    assert.equal(html({ input: { value: () => 3 } }), '<input value="3">');
    assert.equal(html({ button: { value: "go" } }), '<button value="go"></button>');
});

test("a textarea's value is its text, escaped, and no attribute", () => {
    assert.equal(html({ textarea: { value: "a < b", name: "t" } }), '<textarea name="t">a &lt; b</textarea>');
    assert.equal(html({ textarea: { value: undefined } }), "<textarea></textarea>");
    assert.equal(html({ textarea: { children: "default" } }), "<textarea>default</textarea>");
});

test("a select's value marks the option whose value matches, and is no attribute of the select", () => {
    const out = html({ select: { value: "b", name: "s", children: [{ option: { value: "a" } }, { option: { value: "b" } }, { option: { value: "c" } }] } });
    assert.equal(out, '<select name="s"><option value="a"></option><option value="b" selected=""></option><option value="c"></option></select>');
});

test("an option with no value attribute is matched by its text", () => {
    const out = html({
        select: {
            value: () => 2,
            children: [
                { option: "1" },
                { option: { textContent: () => "2" } },
                { option: { children: ["2"] } },
                { option: { children: () => "2" } },
                { option: { children: null } },
                { option: {} },
            ],
        },
    });
    assert.equal(
        out,
        '<select><option>1</option><option selected="">2</option><option selected="">2</option><option selected="">2</option><option></option><option></option></select>',
    );
});

test("an option's text, for matching, includes the text of the elements inside it", () => {
    const option = { option: { children: ["2", { b: "x" }] } };
    assert.equal(html({ select: { value: "2", children: [option] } }), "<select><option>2<b>x</b></option></select>");
    assert.equal(html({ select: { value: "2x", children: [option] } }), '<select><option selected="">2<b>x</b></option></select>');
});

test("an option's text, for matching, is its text as shown, not as escaped in the markup", () => {
    const option = { option: { children: ["a < b & c", { b: ">" }] } };
    assert.equal(html({ select: { value: "a < b & c>", children: [option] } }), '<select><option selected="">a &lt; b &amp; c<b>&gt;</b></option></select>');
    assert.equal(html({ select: { value: "a &lt; b &amp; c&gt;", children: [option] } }), "<select><option>a &lt; b &amp; c<b>&gt;</b></option></select>");
});

test("an option's text, for matching, has its ASCII whitespace stripped and collapsed, as option.value reads it", () => {
    const options = [{ option: " a \n\t b " }, { option: { children: [" a", { b: "  b " }] } }, { option: "a\u00A0b" }, { option: { value: " a b ", textContent: "x" } }];
    assert.equal(
        html({ select: { value: "a b", children: options } }),
        '<select><option selected=""> a \n\t b </option><option selected=""> a<b>  b </b></option><option>a\u00A0b</option><option value=" a b ">x</option></select>',
    );
});

test("an option's text is matched by the text it shows, a textContent of nothing being empty", () => {
    const out = html({ select: { value: "", children: [{ option: { textContent: null } }, { option: { value: "x" } }] } });
    assert.equal(out, '<select><option selected=""></option><option value="x"></option></select>');
});

test("an option already selected is not selected twice", () => {
    const out = html({ select: { value: "a", children: [{ option: { selected: true, value: "a" } }] } });
    assert.deepEqual(attributesIn(out.slice("<select>".length)), { selected: "", value: "a" });
});

test("an optgroup passes the select's value through; any other element stops it", () => {
    const out = html({
        select: {
            value: "x",
            children: [{ optgroup: { label: "g", children: [{ option: { value: "x" } }] } }, { div: { children: [{ option: { value: "x" } }] } }],
        },
    });
    assert.equal(out, '<select><optgroup label="g"><option value="x" selected=""></option></optgroup><div><option value="x"></option></div></select>');
});

test("a select with no value, or a value of nothing, marks no option", () => {
    assert.equal(html({ select: { children: [{ option: "a" }] } }), "<select><option>a</option></select>");
    assert.equal(html({ select: { value: undefined, children: [{ option: "undefined" }, { option: "" }] } }), "<select><option>undefined</option><option></option></select>");
    assert.equal(html({ select: { value: null, children: [{ option: "null" }] } }), "<select><option>null</option></select>");
    assert.equal(html({ option: { value: "a" } }), '<option value="a"></option>');
});

// ---- raw <style> ------------------------------------------------------------------------------------

test("an allowed <style> writes its text raw, the CSS the parser reads", () => {
    const juris = server({ allowTags: ["style"] });
    assert.equal(juris.renderToString({ style: { textContent: "a > b { content: '&' }" } }), "<style>a > b { content: '&' }</style>");
    assert.equal(juris.renderToString({ style: "p > a {}" }), "<style>p > a {}</style>");
    assert.equal(juris.renderToString({ style: { children: ["a > b {", () => () => " color: red ", "}", 1] } }), "<style>a > b { color: red }1</style>");
    assert.equal(juris.renderToString({ style: { children: () => "x > y" } }), "<style>x > y</style>");
    assert.equal(juris.renderToString({ style: {} }), "<style></style>");
    assert.equal(juris.renderToString({ style: { children: null } }), "<style></style>");
});

test("inside a <noscript>, at any depth, an allowed <style> keeps its raw text only with no < in it, or is left out", () => {
    const juris = server({ allowTags: ["style"] });
    assert.equal(juris.renderToString({ noscript: { children: [{ style: "</noscript><img src=x onerror=alert(1)>" }] } }), "<noscript></noscript>");
    assert.equal(juris.renderToString({ noscript: { children: [{ div: { children: [{ style: "a<b{}" }] } }] } }), "<noscript><div></div></noscript>");
    assert.equal(juris.renderToString({ noscript: { children: [{ style: "a > b { color: red }" }] } }), "<noscript><style>a > b { color: red }</style></noscript>");
});

test("inside a <select>, at any depth, an allowed <style> keeps its raw text only with no < in it, or is left out", () => {
    const juris = server({ allowTags: ["style"] });
    assert.equal(juris.renderToString({ select: { children: [{ optgroup: { children: [{ style: "<input><img src=x onerror=alert(1)>" }] } }] } }), "<select><optgroup></optgroup></select>");
    assert.equal(juris.renderToString({ select: { value: "a", children: [{ style: { children: ["a > b", () => "{}"] } }] } }), "<select><style>a > b{}</style></select>");
});

test("an allowed <style> outside a <noscript> or a <select> is written raw as before, after one of them too", () => {
    const juris = server({ allowTags: ["style"] });
    assert.equal(juris.renderToString({ div: { children: [{ style: "a<b{}" }] } }), "<div><style>a<b{}</style></div>");
    assert.equal(juris.renderToString({ div: { children: [{ noscript: "x" }, { select: {} }, { style: "a<b{}" }] } }), "<div><noscript>x</noscript><select></select><style>a<b{}</style></div>");
    juris.registerComponent("Guard", (props, api) => { api.onError(() => ({ p: "fallback" })); return { noscript: { children: [{ i: { textContent: () => { throw new Error("bad"); } } }] } }; });
    assert.equal(juris.renderToString({ div: { children: [{ Guard: {} }, { style: "a<b{}" }] } }), "<div><p>fallback</p><style>a<b{}</style></div>", "a fallback thrown from inside a <noscript> ends it too");
});

test("an allowed <style> whose text would end it early is left out, the joined children included", () => {
    const juris = server({ allowTags: ["style"], devMode: true });
    for (const layout of [
        { style: { textContent: "a{}</style><script>alert(1)</script>" } },
        { style: "</STYLE >" },
        { style: { children: ["</", "style>"] } },
    ]) {
        const { result, warned } = said(() => juris.renderToString({ div: { children: [layout, { p: "after" }] } }));
        assert.equal(result, "<div><p>after</p></div>", JSON.stringify(layout));
        assert.match(warned.join("\n"), /dropped <style>: its text contains <\/style, which would end the element/);
    }
});

test("a layout inside an allowed <style> is not CSS, and is ignored", () => {
    const { result, warned } = said(() => server({ allowTags: ["style"], devMode: true }).renderToString({ style: { children: ["a{}", { b: "x" }] } }));
    assert.equal(result, "<style>a{}</style>");
    assert.match(warned.join("\n"), /a layout inside <style> is not CSS; ignored/);
    assert.equal(server({ allowTags: ["style"] }).renderToString({ style: { children: [{ b: "x" }] } }), "<style></style>");
});

test("an allowed <style>'s innerHTML, when allowed too, is written as given", () => {
    const juris = server({ allowTags: ["style"], allowInnerHTML: true });
    assert.equal(juris.renderToString({ style: { innerHTML: "a > b {}" } }), "<style>a > b {}</style>");
});

test("inside <svg> an allowed <style>'s text is ordinary text, and is escaped", () => {
    const juris = server({ allowTags: ["style"] });
    assert.equal(juris.renderToString({ svg: { children: { style: { textContent: "a > b {}" } } } }), "<svg><style>a &gt; b {}</style></svg>");
    assert.equal(juris.renderToString({ svg: { children: { style: { children: "</style>" } } } }), "<svg><style>&lt;/style&gt;</style></svg>");
});

// ---- namespaces ---------------------------------------------------------------------------------------

test("inside <svg> nothing is void, and value is an ordinary attribute", () => {
    assert.equal(html({ svg: { children: [{ track: {} }, { image: { href: "/a.png" } }] } }), '<svg><track></track><image href="/a.png"></image></svg>');
    assert.deepEqual(startTag(html({ svg: { children: { text: { value: "v", x: 1 } } } }).slice(5)).attributes, [["value", "v"], ["x", "1"]]);
    assert.equal(html({ svg: { children: { text: { value: null } } } }), "<svg><text></text></svg>");
});

test("SVG's foreignObject, desc and title hold HTML again", () => {
    for (const point of ["foreignObject", "desc", "title"]) {
        assert.equal(html({ svg: { children: { [point]: { children: { br: {} } } } } }), `<svg><${point}><br></${point}></svg>`, point);
    }
    assert.equal(html({ svg: { children: { g: { children: { br: {} } } } } }), "<svg><g><br></br></g></svg>");
});

test("inside <math> nothing is void; its token elements hold HTML, but for mglyph and malignmark", () => {
    assert.equal(html({ math: { children: { br: {} } } }), "<math><br></br></math>");
    for (const token of ["mi", "mo", "mn", "ms", "mtext"]) {
        assert.equal(html({ math: { children: { [token]: { children: { span: { children: { br: {} } } } } } } }), `<math><${token}><span><br></span></${token}></math>`, token);
    }
    assert.equal(html({ math: { children: { mi: { children: { mglyph: { children: { br: {} } } } } } } }), "<math><mi><mglyph><br></br></mglyph></mi></math>");
    assert.equal(html({ math: { children: { mi: { children: { malignmark: { children: { br: {} } } } } } } }), "<math><mi><malignmark><br></br></malignmark></mi></math>");
    assert.equal(html({ math: { children: { mi: { children: { svg: { children: { br: {} } } } } } } }), "<math><mi><svg><br></br></svg></mi></math>");
});

test("an annotation-xml of an HTML encoding, in any case, holds HTML", () => {
    for (const encoding of ["text/html", "TEXT/HTML", "application/xhtml+xml", "Application/XHTML+XML"]) {
        assert.equal(
            html({ math: { children: { "annotation-xml": { encoding, children: { br: {} } } } } }),
            `<math><annotation-xml encoding="${encoding}"><br></annotation-xml></math>`,
            encoding,
        );
    }
});

test("an annotation-xml of another encoding, or none, holds MathML, but for an <svg>", () => {
    assert.equal(html({ math: { children: { "annotation-xml": { children: { br: {} } } } } }), "<math><annotation-xml><br></br></annotation-xml></math>");
    assert.equal(
        html({ math: { children: { "annotation-xml": { encoding: "image/svg+xml", children: [{ title: { children: { br: {} } } }, { svg: { children: { title: { children: { br: {} } } } } }] } } } }),
        '<math><annotation-xml encoding="image/svg+xml"><title><br></br></title><svg><title><br></title></svg></annotation-xml></math>',
    );
});

test("renderToString draws in the namespace it is given", () => {
    const juris = server();
    assert.equal(juris.renderToString({ br: {} }, SVG), "<br></br>");
    assert.equal(juris.renderToString({ br: {} }, MATHML), "<br></br>");
    assert.equal(juris.renderToString({ br: {} }, null), "<br>");
    assert.equal(juris.renderToString({ text: { value: "v" } }, SVG), '<text value="v"></text>');
});

// ---- settled values and promises ------------------------------------------------------------------------

test("a settled value is unwrapped where it stands, nested ones too", () => {
    assert.equal(html({ p: { title: settled("t"), children: settled(settled([{ b: "x" }])) } }), '<p title="t"><b>x</b></p>');
    assert.equal(html({ p: { textContent: () => settled("from a function") } }), "<p>from a function</p>");
    assert.equal(html({ input: { value: settled("v"), disabled: settled(true) } }), '<input disabled="" value="v">');
});

test("a real promise renders empty, said in devMode", async () => {
    const pending = Promise.resolve("late");
    const { result, warned } = said(() => server({ devMode: true }).renderToString({ p: { title: () => pending, children: () => pending } }));
    assert.equal(result, "<p></p>");
    assert.equal(warned.filter((line) => /a reactive function returned a promise; it renders empty on the server \(preload it\)/.test(line)).length, 2);
    const quiet = said(() => html({ p: { textContent: pending } }));
    assert.equal(quiet.result, "<p></p>");
    assert.deepEqual(quiet.warned, []);
    await pending;
});

test("a settled error renders empty, said on the console in devMode", () => {
    const failure = new Error("boom");
    const loud = said(() => server({ devMode: true }).renderToString({ p: { title: settledError(failure), children: settledError(failure) } }));
    assert.equal(loud.result, "<p></p>");
    assert.equal(loud.errored.length, 2);
    assert.match(loud.errored[0], /settled value is an error; rendering empty/);
    const quiet = said(() => html({ p: { textContent: () => settledError(failure) } }));
    assert.equal(quiet.result, "<p></p>");
    assert.deepEqual(quiet.errored, []);
});

// ---- the renderer object ------------------------------------------------------------------------

test("the instance's renderer reads its state, components and devMode from the instance", () => {
    const juris = server({ devMode: true });
    assert.ok(juris.ssrRenderer instanceof SSRRenderer);
    assert.equal(juris.ssrRenderer.juris, juris);
    assert.equal(juris.ssrRenderer.stateManager, juris.stateManager);
    assert.equal(juris.ssrRenderer.componentManager, juris.componentManager);
    assert.equal(juris.ssrRenderer.devMode, true);
    assert.equal(server().ssrRenderer.devMode, false);
});

test("a renderer built on its own renders for the instance it is given", () => {
    const juris = server();
    const renderer = new SSRRenderer(juris);
    assert.equal(renderer.instances, null);
    assert.equal(renderer.owner, null);
    assert.equal(renderer.renderToString({ p: { title: "x", children: "y" } }), '<p title="x">y</p>');
    assert.equal(renderer.instances, null);
});
