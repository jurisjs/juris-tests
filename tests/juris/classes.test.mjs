// class, className and classList on both renderers: the rule that makes one class attribute of them
// (REFERENCE.md, "Components and layouts"), held as a property over many combinations of the three.
// `class` or `className` gives the base (the later of the two when both are given); classList turns
// each class it names on or off, key by key in order, so the last key naming a class decides it, and
// it never writes a class that is there already. The server's class attribute is the client's after
// its first draw, to the byte, and after any change the client has the classes the server writes for
// the new state.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";

import { installDom, Element, HTML } from "../support/dom-renderer-dom.mjs";
import { attributesIn } from "../support/markup.mjs";
import { withSSR } from "../support/ssr-renderer.mjs";

let dom;
beforeEach(() => {
    dom = installDom();
});
afterEach(() => dom.restore());

const server = (state) => new Juris(withSSR({ isServer: true, state }));
const client = (state) => new Juris({ isServer: false, state });
const host = () => dom.document.body.appendChild(new Element("div", HTML));

// No base: the key is left out of the layout, or, where class and className are both given, the
// later of them is undefined.
const ABSENT = Symbol("absent");

// What `class` or `className` gives: nothing, empty, one class, two, two with a run of spaces, and
// one written twice.
const BASES = [ABSENT, null, "", "menu", "menu open", "menu  open", "open menu open"];

// What classList gives, as [key, on] pairs in key order: a key may name several classes, and several
// keys may name one.
const LISTS = [
    [],
    [["open", true]],
    [["open", false]],
    [["menu", false], ["open", true]],
    [["a b", true], ["b", true]],
    [["a b", true], ["b", false]],
    [["b", false], ["a b", true]],
    [["open wide", true], ["open", false]],
    [["", true], ["  ", true], ["wide", true]],
    [["menu", true], ["menu open", false], ["open", true]],
];

// The three ways to write a classList, given `valueOf(index)`, the value of the key at `index`: an
// object of values, an object with a function for each key, and a function giving the whole object.
const FORMS = {
    "an object": (pairs, valueOf) => Object.fromEntries(pairs.map(([key], index) => [key, valueOf(index)])),
    "an object of functions": (pairs, valueOf) => Object.fromEntries(
        pairs.map(([key], index) => [key, () => valueOf(index)]),
    ),
    "a function": (pairs, valueOf) => () => Object.fromEntries(pairs.map(([key], index) => [key, valueOf(index)])),
};

// Where the base goes: in className before the classList, in class after it, or in the later of the
// two, the earlier one given something never used.
const ARRANGEMENTS = {
    "className, classList": (base, classList) => ({
        ...(base === ABSENT ? {} : { className: base }),
        classList,
    }),
    "classList, class": (base, classList) => ({
        classList,
        ...(base === ABSENT ? {} : { class: base }),
    }),
    "class, classList, className": (base, classList) => ({
        class: "unused",
        classList,
        className: base === ABSENT ? undefined : base,
    }),
    "className, class, classList": (base, classList) => ({
        className: () => "unused",
        class: base === ABSENT ? undefined : base,
        classList,
    }),
};

// The classes the rule gives, sorted, once each: the base's, then each key's in order, on or off.
// The attribute may name a class twice only where it is the base as written, which classList left
// alone, as element.classList.toggle leaves an attribute it does not change.
function classesOf(base, pairs) {
    const split = (text) => text.split(/[\t\n\f\r ]+/).filter(Boolean);
    const classes = new Set(typeof base === "string" ? split(base) : []);
    for (const [key, on] of pairs) {
        for (const name of split(key)) {
            if (on) classes.add(name);
            else classes.delete(name);
        }
    }
    return [...classes].sort();
}

// Every base, given as it is and as a function giving it, with every list.
function* firstDraws() {
    for (const reactive of [false, true]) {
        for (const base of BASES) {
            for (const pairs of LISTS) yield { reactive, base, pairs };
        }
    }
}

const tokensOf = (value) => (value ?? "").split(/[\t\n\f\r ]+/).filter(Boolean).sort();
const setOf = (value) => [...new Set(tokensOf(value))].join(" ");
const show = (value) => (value === null ? "absent" : JSON.stringify(value));
const showBase = (base) => (base === ABSENT ? "no base" : JSON.stringify(base));

for (const [formName, form] of Object.entries(FORMS)) {
    for (const [arrangement, arrange] of Object.entries(ARRANGEMENTS)) {
        test(`classList as ${formName}, ${arrangement}: the client's first draw is the server's class`, () => {
            const wrong = [];
            for (const { reactive, base, pairs } of firstDraws()) {
                const label = `${reactive ? "a function giving " : ""}${showBase(base)} + ${JSON.stringify(pairs)}`;
                const given = reactive && base !== ABSENT ? () => base : base;
                const layout = () => ({ nav: arrange(given, form(pairs, (index) => pairs[index][1])) });
                const fromServer = attributesIn(server({}).renderToString(layout())).class ?? null;
                const fromClient = client({}).render(host(), layout()).getAttribute("class");
                if (fromServer !== fromClient) {
                    wrong.push(`${label}: the server wrote ${show(fromServer)}, the client ${show(fromClient)}`);
                }
                const expected = classesOf(base, pairs).join(" ");
                if (setOf(fromServer) !== expected) {
                    wrong.push(`${label}: ${show(fromServer)}, where the classes are "${expected}"`);
                }
                if (fromServer !== base && setOf(fromServer) !== tokensOf(fromServer).join(" ")) {
                    wrong.push(`${label}: ${show(fromServer)} has a class twice`);
                }
            }
            assert.deepEqual(wrong, [], `\n  ${wrong.join("\n  ")}`);
        });

        test(`classList as ${formName}, ${arrangement}: after a change, the client has the server's classes`, () => {
            // Every base to the next one, each list's values all turned around; a function may also
            // give another object, naming other classes. An object of plain values cannot change:
            // its base alone does.
            const changes = [];
            for (const [index, base] of BASES.entries()) {
                const nextBase = BASES[(index + 1) % BASES.length];
                for (const pairs of LISTS) {
                    const flipped = pairs.map(([key, on]) => [key, !on]);
                    changes.push([base, pairs, nextBase, formName === "an object" ? pairs : flipped]);
                    if (formName === "a function") {
                        for (const other of LISTS) changes.push([base, pairs, base, other]);
                    }
                }
            }
            const wrong = [];
            for (const [base, pairs, nextBase, nextPairs] of changes) {
                // The state holds the base and the pairs; a function gives the object of the pairs
                // the state holds, whatever they name.
                const stateOf = (b, p) => ({ base: b === ABSENT ? null : b, pairs: p });
                const layoutFor = (juris) => {
                    const held = () => juris.getState("pairs");
                    const valueOf = (index) => (formName === "an object" ? pairs[index][1] : held()[index][1]);
                    const classList = formName === "a function"
                        ? () => Object.fromEntries(held())
                        : form(pairs, valueOf);
                    return { nav: arrange(base === ABSENT ? ABSENT : () => juris.getState("base"), classList) };
                };
                const juris = client(stateOf(base, pairs));
                const nav = juris.render(host(), layoutFor(juris));
                // The classList runs again first, then class or className.
                juris.setValue("pairs", nextPairs);
                juris.setValue("base", nextBase === ABSENT ? null : nextBase);
                const ssr = server(stateOf(nextBase, nextPairs));
                const fromServer = attributesIn(ssr.renderToString(layoutFor(ssr))).class ?? null;
                const fromClient = nav.getAttribute("class");
                if (setOf(fromClient) !== setOf(fromServer)) {
                    const label = `${showBase(base)} + ${JSON.stringify(pairs)},`
                        + ` then ${showBase(nextBase)} + ${JSON.stringify(nextPairs)}`;
                    wrong.push(`${label}: the client has ${show(fromClient)}, the server writes ${show(fromServer)}`);
                }
            }
            assert.deepEqual(wrong, [], `\n  ${wrong.join("\n  ")}`);
        });
    }
}
