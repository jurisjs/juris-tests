// What an element holds, on both renderers: textContent, innerHTML, an <output>'s or a <textarea>'s
// value, children, and true or false as the content, held as a property over many combinations of
// them (REFERENCE.md, "Components and layouts"). An element holds one thing: its textContent, or an
// innerHTML the instance allows, the later of the two; else an <output>'s or a <textarea>'s value;
// else its children. The keys decide it, whatever their values and order. The server's markup is the
// client's after its first draw, to the byte, and after a change the client holds what the server
// writes for the new layout. The same for the style keys the DOM spells its own way, and for
// indeterminate, which the server writes nothing for.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";

import { installDom, Element, HTML } from "../support/dom-renderer-dom.mjs";
import { serialize } from "../support/dom.mjs";
import { attributesIn, unescape } from "../support/markup.mjs";
import { withSSR } from "../support/ssr-renderer.mjs";

let dom;
beforeEach(() => {
    dom = installDom();
});
afterEach(() => dom.restore());

const server = (options) => new Juris(withSSR({ isServer: true, ...options }));
const client = (options) => new Juris({ isServer: false, ...options });
// Detached: thousands of draws, none of which needs the document.
const host = () => new Element("div", HTML);

// A key left out of the layout.
const ABSENT = Symbol("absent");

// What textContent gives: text, nothing in each of its forms, a number, both booleans, text to
// escape, a function, and a layout (refused, so it writes nothing).
const TEXTS = [ABSENT, "y", "", null, undefined, 0, false, true, "<t>&", () => "f", { i: "x" }];
// What innerHTML gives: markup, nothing, a boolean, and a function.
const MARKUP = [ABSENT, "<b>h</b>", "", false, null, () => "<i>f</i>"];
// What children gives: a list, an empty one, text, nothing, booleans among text, and a seat.
const CHILDREN = [ABSENT, ["a", { b: "c" }], [], "a", null, [false, "a", true], () => ["s"]];
// What value gives: a number, nothing, and empty text.
const VALUES = [ABSENT, 42, "", null];
// <p>'s value is an attribute, so it is left out here: what it holds is the point.
const VALUES_OF = { p: [ABSENT], output: VALUES, textarea: VALUES };

const run = (value) => (typeof value === "function" ? value() : value);
const textOf = (value) => (value === null || value === undefined || typeof value === "boolean" ? "" : String(value));
const escape = (text) => text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const isLayout = (value) => value !== null && typeof value === "object";
const show = (value) => {
    if (value === ABSENT) return "absent";
    if (typeof value === "function") return `() => ${JSON.stringify(value())}`;
    if (value === undefined) return "undefined";
    return JSON.stringify(value);
};

// The layout's content: the keys given, in the order given, those ABSENT left out.
const contentOf = (entries) => Object.fromEntries(entries.filter(([, value]) => value !== ABSENT));

// Every combination for `tag`, each in two orders: as listed and reversed.
function* combinations(tag) {
    for (const allowed of [false, true]) {
        for (const text of TEXTS) {
            for (const markup of MARKUP) {
                for (const value of VALUES_OF[tag]) {
                    for (const children of CHILDREN) {
                        const entries = [
                            ["textContent", text],
                            ["innerHTML", markup],
                            ["value", value],
                            ["children", children],
                        ];
                        for (const order of [entries, [...entries].reverse()]) {
                            const label = `${allowed ? "allowInnerHTML, " : ""}`
                                + order.filter(([, v]) => v !== ABSENT).map(([k, v]) => `${k}: ${show(v)}`).join(", ");
                            yield { allowed, content: contentOf(order), label };
                        }
                    }
                }
            }
        }
    }
}

// What the element holds by the rule, as markup; undefined where the held key's value is a layout,
// which writes nothing of its own (the agreement of the two renderers is checked there all the same).
function expectedInside(tag, content, allowed) {
    let held = null;
    for (const key of Object.keys(content)) {
        if (key === "textContent" || (key === "innerHTML" && allowed)) held = key;
    }
    if (held !== null) {
        const given = run(content[held]);
        if (isLayout(given)) return undefined;
        return held === "textContent" ? escape(textOf(given)) : textOf(given);
    }
    if (tag !== "p" && "value" in content) {
        return escape(content.value === null || content.value === undefined ? "" : String(content.value));
    }
    const children = run(content.children);
    const list = children === null || children === undefined ? [] : [children].flat();
    return list.map((child) => (isLayout(child) ? `<b>${child.b}</b>` : escape(textOf(child)))).join("");
}

// What the server's element holds, as markup.
const insideOf = (tag, html) => new RegExp(`^<${tag}[^>]*>([\\s\\S]*)</${tag}>$`).exec(html)[1];

// The client's element as markup. A <textarea> shows its value, which a property may hold and its
// markup not: what it shows is compared, as the server's text, unless elements or markup were drawn
// in it (a browser's parser reads them in the server's markup as its text).
function drawnOf(tag, element) {
    if (tag !== "textarea" || element.children.length > 0 || element.html !== undefined) return serialize(element);
    return `<textarea>${escape(element.value)}</textarea>`;
}

for (const tag of ["p", "output", "textarea"]) {
    test(`<${tag}>: the client's first draw holds what the server writes, and what the rule says`, () => {
        const wrong = [];
        for (const { allowed, content, label } of combinations(tag)) {
            const fromServer = server({ allowInnerHTML: allowed }).renderToString({ [tag]: content });
            const element = client({ allowInnerHTML: allowed }).render(host(), { [tag]: content });
            const fromClient = drawnOf(tag, element);
            if (fromServer !== fromClient) {
                wrong.push(`${label}: the server wrote ${fromServer}, the client ${fromClient}`);
            }
            const expected = expectedInside(tag, content, allowed);
            const inside = insideOf(tag, fromServer);
            if (expected !== undefined && inside !== expected) {
                wrong.push(`${label}: it holds ${JSON.stringify(inside)},`
                    + ` where the rule says ${JSON.stringify(expected)}`);
            }
        }
        assert.deepEqual(wrong, [], `\n  ${wrong.slice(0, 40).join("\n  ")}\n  (${wrong.length} in all)`);
    });

    test(`<${tag}>: an element reused for another layout holds what the server writes for that one`, () => {
        // From what an element may hold before, to every combination: its children, its text, or its
        // value (an attribute on a <p>). Not from innerHTML: the stand-in DOM keeps that markup
        // aside, as no child node, so taking off the element's children cannot reach it, where in a
        // browser the markup is parsed into the children that go. Not from a <textarea>'s value
        // either: that is the user's, left alone by a re-draw that gives none (REFERENCE.md).
        const befores = [
            { children: ["old", { i: "old" }] },
            { textContent: "old" },
        ];
        if (tag !== "textarea") befores.push({ value: 7 });
        const wrong = [];
        for (const before of befores) {
            for (const { allowed, content, label } of combinations(tag)) {
                const juris = client({ allowInnerHTML: allowed, state: { step: 0 } });
                const layouts = [{ [tag]: before }, { [tag]: content }];
                const parent = juris.render(host(), {
                    div: { children: () => [layouts[juris.getState("step")]] },
                });
                const element = parent.firstChild;
                juris.setValue("step", 1);
                if (parent.firstChild !== element) {
                    wrong.push(`${label}: the element was not reused`);
                    continue;
                }
                const fromServer = server({ allowInnerHTML: allowed }).renderToString({ [tag]: content });
                const fromClient = drawnOf(tag, element);
                if (fromServer !== fromClient) {
                    wrong.push(`from ${JSON.stringify(before)} to ${label}: the server writes ${fromServer},`
                        + ` the client holds ${fromClient}`);
                }
            }
        }
        assert.deepEqual(wrong, [], `\n  ${wrong.slice(0, 40).join("\n  ")}\n  (${wrong.length} in all)`);
    });
}

test("true or false as the whole content is nothing, as text, a number or null is what it was", () => {
    const wrong = [];
    for (const tag of ["p", "span", "output", "li"]) {
        const contents = [[false, ""], [true, ""], ["y", "y"], [0, "0"], [null, ""], ["<b>", "&lt;b&gt;"]];
        for (const [given, inside] of contents) {
            const fromServer = server({}).renderToString({ [tag]: given });
            const fromClient = serialize(client({}).render(host(), { [tag]: given }));
            const expected = `<${tag}>${inside}</${tag}>`;
            if (fromServer !== expected || fromClient !== expected) {
                wrong.push(`{ ${tag}: ${show(given)} }: the server wrote ${fromServer}, the client ${fromClient}`);
            }
        }
    }
    assert.deepEqual(wrong, [], `\n  ${wrong.join("\n  ")}`);
});

test("a style key the DOM spells its own way is the CSS property the server writes", () => {
    // The CSS properties the server's style attribute names, in order.
    const fromMarkup = (html) => (attributesIn(html).style ?? "").split(";").filter(Boolean).map((part) => {
        const colon = part.indexOf(":");
        return [part.slice(0, colon), part.slice(colon + 1)];
    });
    const keys = [
        "webkitTransform",
        "WebkitTransform",
        "msTransform",
        "MozAppearance",
        "cssFloat",
        "marginTop",
        "--accent",
    ];
    const wrong = [];
    for (const key of keys) {
        const layout = { p: { style: { [key]: "none" } } };
        const fromServer = fromMarkup(server({}).renderToString(layout));
        const fromClient = [...client({}).render(host(), layout).declarations];
        if (JSON.stringify(fromServer) !== JSON.stringify(fromClient)) {
            wrong.push(`${key}: the server wrote ${JSON.stringify(fromServer)},`
                + ` the client ${JSON.stringify(fromClient)}`);
        }
    }
    assert.deepEqual(wrong, [], `\n  ${wrong.join("\n  ")}`);
});

test("indeterminate: the markup is the same on both, and the client's property alone says it", () => {
    const layout = { input: { type: "checkbox", indeterminate: true } };
    const fromServer = server({}).renderToString(layout);
    const box = client({}).render(host(), layout);
    assert.equal(fromServer, '<input type="checkbox">');
    assert.equal(serialize(box), fromServer);
    assert.equal(box.indeterminate, true);
    assert.equal(unescape(fromServer).includes("indeterminate"), false);
});
