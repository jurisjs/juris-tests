// juris.compile, against layouts nobody wrote: each is made at random, from the tags, keys and values
// the renderer treats differently, and drawn in the places that change what is written. Whatever
// compiles must write what the ordinary renderer writes. The seed is fixed, so a failure comes back
// the same; its message holds all it takes to read it. ssr-renderer.compile.test.mjs says the rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";
import { withSSR } from "../support/ssr-renderer.mjs";

const LAYOUTS = 4000;
const DRAWS = 6;
const SLOT_NAMES = ["a", "b", "c"];

const TAGS = [
    "a", "annotation-xml", "area", "b", "br", "button", "circle", "details", "div", "foreignObject", "form", "hr",
    "img", "input", "label", "li", "math", "mi", "mo", "noscript", "optgroup", "option", "output", "p", "select",
    "span", "svg", "td", "template", "text", "textarea", "title", "tr", "ul", "video", "x-card",
];

const KEYS = [
    "action", "aria-label", "checked", "cite", "CLASS", "class", "className", "classList", "data", "data-id",
    "data-key", "disabled", "encoding", "for", "formaction", "HREF", "hidden", "Hidden", "href", "htmlFor", "id",
    "indeterminate", "key", "multiple", "name", "onclick", "open", "poster", "role", "selected", "src", "srcdoc",
    "style", "textContent", "title", "type", "value", "xlink:href",
];

const FIXED_VALUES = [
    "fixed", "", "a b", 0, 3, true, false, null, undefined, "javascript:x", "text/html", "<b>", '"', "&", "/ok",
    { color: "red" }, { on: true, off: false }, { on: false },
];

const VALUES = [
    "plain", "", " ", 0, -0, 1.5, NaN, 10n, null, undefined, true, false, "<script>", '"><img src=x>', "a & b",
    "' \" &", "javascript:alert(1)", " JaVa\tScript:x", "https://shop.example/?a=1&b=2", "/relative",
    "data:text/html,x", "data:image/png;base64,AA", "until-found", "text/html", "on off", "a  b",
    { b: "x" }, ["l", "m"], [{ i: "y" }], () => "from a function", () => ({ u: "z" }), () => null,
];

// What the layout is drawn inside: each changes what the same element writes.
const SURROUNDINGS = [
    (node) => node,
    (node) => ({ div: { children: [node] } }),
    (node) => ({ svg: { children: [node] } }),
    (node) => ({ select: { value: "plain", children: [node] } }),
    (node) => ({ math: { children: [{ mi: { children: [node] } }] } }),
];

const INSTANCES = [
    {},
    { allowSchemes: ["magnet"] },
    { allowTags: ["iframe"] },
];

// A small generator of our own, as Math.random cannot be seeded.
const generator = (seed) => {
    let state = seed;
    const random = () => {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296;
    };

    return { random, pick: (list) => list[Math.floor(random() * list.length)] };
};

const { random, pick } = generator(20261108);
const slot = () => ({ $slot: pick(SLOT_NAMES) });

const child = (depth) => {
    const roll = random();

    if (roll < 0.25) return slot();
    if (roll < 0.4) return pick(["text", 7, null, " x="]);
    return element(depth + 1);
};

const children = (depth) => {
    const list = [];
    const size = Math.floor(random() * 4);

    for (let index = 0; index < size; index += 1) {
        list.push(child(depth));
    }

    return random() < 0.1 ? slot() : list;
};

const element = (depth) => {
    const tag = pick(TAGS);
    const roll = random();

    if (roll < 0.1) return { [tag]: slot() };
    if (roll < 0.15) return { [tag]: pick(["text", 5, null, ""]) };

    const content = {};
    const keys = Math.floor(random() * 5);

    for (let index = 0; index < keys; index += 1) {
        content[pick(KEYS)] = random() < 0.5 ? slot() : pick(FIXED_VALUES);
    }

    if (depth < 3 && random() < 0.7) content.children = children(depth);
    return { [tag]: content };
};

const outcome = (render) => {
    try {
        return render();
    } catch (error) {
        return `threw: ${error.message}`;
    }
};

const compiledOrNull = (juris, layout) => {
    try {
        return juris.compile(layout);
    } catch (error) {
        assert.ok(error instanceof TypeError, JSON.stringify(layout));
        assert.match(error.message, /^Juris\.compile: /, JSON.stringify(layout));
        return null;
    }
};

test("whatever compiles writes what the ordinary renderer writes", () => {
    let compiled = 0;
    let quick = 0;

    for (let round = 0; round < LAYOUTS; round += 1) {
        const juris = new Juris(withSSR({ isServer: true, ...pick(INSTANCES) }));
        const layout = element(0);
        const fill = compiledOrNull(juris, layout);

        if (fill === null) continue;
        compiled += 1;

        for (let draw = 0; draw < DRAWS; draw += 1) {
            const values = { a: pick(VALUES), b: pick(VALUES), c: pick(VALUES) };
            const inside = pick(SURROUNDINGS);
            const ordinary = juris.fillSlots(layout, (name) => values[name]);

            const expected = outcome(() => juris.renderToString(inside(ordinary)));
            const actual = outcome(() => juris.renderToString(inside(fill(values))));

            if (fill(values).written() !== null) quick += 1;
            assert.equal(actual, expected, JSON.stringify({ layout, values: Object.values(values).map(String) }));
        }
    }

    // That it held for layouts and values that mean something: most compile, and many are written
    // from the compiled form, which is the part being held.
    assert.ok(compiled > LAYOUTS / 2, `${compiled} compiled`);
    assert.ok(quick > compiled, `${quick} written from the compiled form`);
});
