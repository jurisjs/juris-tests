// juris.compile (juris.js), and its server half (server/ssr-renderer.js): a layout with named slots
// is drawn once, into fixed text and the places values go, and then filled. What it writes is held to
// what the ordinary renderer writes for the same layout and values, across every place a slot can
// stand and every kind of value; what it cannot keep that promise for is refused when it is compiled.
// Held to REFERENCE.md ("Compiled layouts").
import { test } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";
import { withSSR } from "../support/ssr-renderer.mjs";

const server = (options = {}) => new Juris(withSSR({ isServer: true, ...options }));
const compileError = (reason) => ({ name: "TypeError", message: reason });

// Every place a slot can stand. Each is written once: given `slot` it is what is compiled, and given
// a function that reads the values it is the ordinary layout the compiled one must match.
const PLACES = {
    "the whole content": (slot) => ({ td: slot("a") }),
    textContent: (slot) => ({ td: { className: "cell", textContent: slot("a") } }),
    "a text child": (slot) => ({ p: { children: ["Hi ", slot("a"), "!"] } }),
    "the whole children": (slot) => ({ p: { children: slot("a") } }),
    "a nested element": (slot) => ({ tr: { children: [{ td: { children: [{ a: { textContent: slot("a") } }] } }] } }),
    "an attribute": (slot) => ({ a: { title: slot("a"), id: "fixed" } }),
    "an attribute after a fixed one": (slot) => ({ a: { id: "fixed", title: slot("a") } }),
    "a data attribute": (slot) => ({ div: { "data-id": slot("a") } }),
    className: (slot) => ({ div: { className: slot("a") } }),
    class: (slot) => ({ div: { class: slot("a"), id: "fixed" } }),
    key: (slot) => ({ tr: { key: slot("a"), className: "row" } }),
    htmlFor: (slot) => ({ label: { htmlFor: slot("a"), textContent: "Name" } }),
    "for, given twice": (slot) => ({ label: { for: "fixed", htmlFor: slot("a") } }),
    "data-key, given twice": (slot) => ({ tr: { "data-key": "fixed", key: slot("a") } }),
    href: (slot) => ({ a: { href: slot("a"), textContent: "Open" } }),
    src: (slot) => ({ img: { src: slot("a"), alt: "" } }),
    "an input's value": (slot) => ({ input: { type: "text", value: slot("a") } }),
    "a textarea's value": (slot) => ({ textarea: { value: slot("a") } }),
    "an output's value": (slot) => ({ output: { value: slot("a") } }),
    "a boolean": (slot) => ({ input: { type: "checkbox", checked: slot("a"), id: "fixed" } }),
    hidden: (slot) => ({ div: { hidden: slot("a") } }),
    "an option's value": (slot) => ({ option: { value: slot("a"), textContent: "One" } }),
    "an option's selected": (slot) => ({ option: { selected: slot("a"), textContent: "One" } }),
    "an attribute in an svg": (slot) => ({ svg: { children: [{ circle: { r: slot("a") } }] } }),
    "a value in an svg": (slot) => ({ svg: { children: [{ text: { value: slot("a") } }] } }),
    "hidden in an svg": (slot) => ({ svg: { hidden: slot("a") } }),
    "text inside a foreignObject": (slot) => ({
        svg: { children: [{ foreignObject: { children: [{ p: slot("a") }] } }] },
    }),
    "a text looking like an attribute": (slot) => ({ p: { children: [' a b="', slot("a"), '"'] } }),
    "a place of its own": (slot) => slot("a"),
};

const VALUES = [
    "plain",
    "",
    " ",
    0,
    -0,
    1.5,
    NaN,
    10n,
    null,
    undefined,
    true,
    false,
    "<script>alert(1)</script>",
    '"><img src=x onerror=alert(1)>',
    "a & b < c > d",
    `' " & < >`,
    "&amp;",
    "javascript:alert(1)",
    " JaVa\tScript:alert(1)",
    "https://shop.example/?a=1&b=2",
    "/relative/path",
    "data:text/html,<script>alert(1)</script>",
    "data:image/png;base64,AAAA",
    "until-found",
    { b: "a layout" },
    ["a", "list"],
    [{ b: "a layout in a list" }],
    () => "from a function",
    () => ({ b: "a layout from a function" }),
];

// What a render gives: its markup, or what it threw, as a list in one child's place is refused.
const outcome = (render) => {
    try {
        return render();
    } catch (error) {
        return `threw: ${error.message}`;
    }
};

const shown = (value) => (typeof value === "object" ? JSON.stringify(value) : String(value));

for (const [place, layout] of Object.entries(PLACES)) {
    test(`a slot in ${place} writes what the ordinary layout writes, for every value`, () => {
        const juris = server();
        const compiled = juris.compile(layout);

        for (const value of VALUES) {
            const expected = outcome(() => juris.renderToString(layout(() => value)));
            assert.equal(outcome(() => juris.renderToString(compiled({ a: value }))), expected, shown(value));
        }
    });

    test(`a slot in ${place} writes what the ordinary layout writes, for a field not given`, () => {
        const juris = server();

        const drawn = juris.renderToString(juris.compile(layout)({}));

        assert.equal(drawn, juris.renderToString(layout(() => undefined)));
    });
}

test("a row with several slots writes the row the ordinary layout writes", () => {
    const juris = server();
    const layout = (slot) => ({
        tr: {
            key: slot("id"),
            className: "row",
            children: [
                { td: { className: "id", textContent: slot("id") } },
                { td: { children: [{ a: { href: slot("url"), title: slot("hint"), textContent: slot("label") } }] } },
                {
                    td: {
                        children: [{ input: { type: "checkbox", checked: slot("done"), disabled: slot("locked") } }],
                    },
                },
            ],
        },
    });
    const row = juris.compile(layout);
    const rows = [
        { id: 1, url: "/a", hint: "First", label: "One", done: true, locked: false },
        { id: 2, url: "/b", hint: null, label: "<b>Two</b>", done: false, locked: true },
        { id: 3, url: "javascript:alert(1)", hint: '"', label: null, done: null },
    ];

    for (const values of rows) {
        const read = (name) => values[name];
        assert.equal(juris.renderToString(row(values)), juris.renderToString(layout(read)));
    }
});

// A layout written as a function runs once when compiled, and again only for a row a place cannot
// write: how many times it ran says whether the row was written from the compiled form.
const counted = (juris, layout) => {
    const count = { runs: 0 };
    const compiled = juris.compile((slot) => {
        count.runs += 1;
        return layout(slot);
    });
    return { compiled, count };
};

const QUICK = [
    ["text", (slot) => ({ td: slot("a") }), ["One", "<b>", "", 0, 1.5, null, undefined]],
    ["an attribute", (slot) => ({ td: { title: slot("a") } }), ["One", '"', "", 0, null, undefined]],
    ["a class", (slot) => ({ td: { className: slot("a") } }), ["one two", "", 0, null, undefined]],
    ["a key", (slot) => ({ tr: { key: slot("a") } }), ["one", 7]],
    ["a URL", (slot) => ({ a: { href: slot("a") } }), ["/one", "https://shop.example/", null]],
    ["a boolean", (slot) => ({ input: { checked: slot("a") } }), [true, false, null, undefined]],
];

for (const [place, layout, values] of QUICK) {
    test(`${place} is written from the compiled form, with no layout drawn`, () => {
        const juris = server();
        const { compiled, count } = counted(juris, layout);

        for (const value of values) juris.renderToString(compiled({ a: value }));

        assert.equal(count.runs, 1);
    });
}

const ORDINARY = [
    ["text given an object", (slot) => ({ td: { children: [slot("a")] } }), { b: "Bold" }],
    ["text given a boolean", (slot) => ({ td: slot("a") }), true],
    ["an attribute given a boolean", (slot) => ({ td: { title: slot("a") } }), true],
    ["a key given null", (slot) => ({ tr: { key: slot("a") } }), null],
    ["a value given null", (slot) => ({ input: { value: slot("a") } }), null],
    ["a URL refused", (slot) => ({ a: { href: slot("a") } }), "javascript:alert(1)"],
    ["a boolean given text", (slot) => ({ div: { hidden: slot("a") } }), "until-found"],
];

for (const [place, layout, value] of ORDINARY) {
    test(`${place} is drawn from the ordinary layout`, () => {
        const juris = server();
        const { compiled, count } = counted(juris, layout);

        juris.renderToString(compiled({ a: value }));

        assert.equal(count.runs, 2);
    });
}

test("the same name in two places is filled in both", () => {
    const juris = server();
    const row = juris.compile((slot) => ({ tr: { key: slot("id"), children: [{ td: slot("id") }] } }));

    assert.equal(juris.renderToString(row({ id: 7 })), '<tr data-key="7"><td>7</td></tr>');
});

test("compiled rows draw as children among ordinary ones, whole and in a function's list", () => {
    const juris = server();
    const row = juris.compile((slot) => ({ li: slot("label") }));
    const items = [{ label: "One" }, { label: "Two" }];
    const expected = "<ul><li>First</li><li>One</li><li>Two</li></ul>";

    const mixed = { ul: { children: [{ li: "First" }, ...items.map(row)] } };
    const fromAFunction = { ul: { children: () => [{ li: "First" }, ...items.map(row)] } };

    assert.equal(juris.renderToString(mixed), expected);
    assert.equal(juris.renderToString(fromAFunction), expected);
    assert.equal(juris.renderToString({ ul: { children: row({ label: "One" }) } }), "<ul><li>One</li></ul>");
    assert.equal(juris.renderToString({ ul: { children: [() => row({ label: "One" })] } }), "<ul><li>One</li></ul>");
});

test("a compiled layout is the result of a component, its key taken as an ordinary layout's is", () => {
    const juris = server();
    const row = juris.compile((slot) => ({ li: { className: "item", textContent: slot("label") } }));
    const keyed = juris.compile((slot) => ({ li: { key: slot("id"), textContent: slot("label") } }));
    juris.registerComponent("Row", (props) => row(props));
    juris.registerComponent("OwnKey", (props) => keyed(props));
    juris.registerComponent("Later", (props) => () => row(props));

    assert.equal(juris.renderToString({ Row: { label: "One" } }), '<li class="item">One</li>');
    assert.equal(juris.renderToString({ Row: { key: "a", label: "One" } }), '<li class="item" data-key="a">One</li>');
    assert.equal(juris.renderToString({ OwnKey: { key: "a", id: "b", label: "One" } }), '<li data-key="b">One</li>');
    assert.equal(juris.renderToString({ Later: { key: "a", label: "One" } }), '<li class="item" data-key="a">One</li>');
});

test("a compiled layout is a component's fallback, its key taken with it", () => {
    const juris = server();
    const row = juris.compile((slot) => ({ li: slot("label") }));
    juris.registerComponent("Broken", (props, api) => {
        api.onError(() => row({ label: "Failed" }));
        throw new Error("no row");
    });

    assert.equal(juris.renderToString({ Broken: { key: "a" } }), '<li data-key="a">Failed</li>');
});

test("a value that is a compiled layout draws in a child's place", () => {
    const juris = server();
    const badge = juris.compile((slot) => ({ b: slot("text") }));
    const cell = juris.compile((slot) => ({ td: { children: [slot("inside")] } }));

    const drawn = juris.renderToString(cell({ inside: badge({ text: "New" }) }));

    assert.equal(drawn, "<td><b>New</b></td>");
});

test("inside an <svg> a compiled layout made for HTML writes what the ordinary layout writes there", () => {
    const juris = server();
    const layout = (slot) => ({ text: { hidden: slot("hidden"), children: [{ source: {} }] } });
    const compiled = juris.compile(layout);
    const values = { hidden: true };

    const inHTML = juris.renderToString(compiled(values));
    const inSVG = juris.renderToString({ svg: { children: [compiled(values)] } });

    assert.equal(inHTML, '<text hidden=""><source></text>');
    assert.equal(inSVG, '<svg><text hidden="true"><source></source></text></svg>');
    assert.equal(inSVG, juris.renderToString({ svg: { children: [layout((name) => values[name])] } }));
});

test("inside a <select> with a value a compiled option is selected as an ordinary one is", () => {
    const juris = server();
    const option = juris.compile((slot) => ({ option: { value: slot("id"), textContent: slot("name") } }));
    const options = [{ id: "a", name: "One" }, { id: "b", name: "Two" }];

    const drawn = juris.renderToString({ select: { value: "b", children: options.map(option) } });

    assert.equal(drawn, '<select><option value="a">One</option><option value="b" selected="">Two</option></select>');
});

test("inside a <select> with no value a compiled option is written as it is", () => {
    const juris = server();
    const option = juris.compile((slot) => ({ option: { value: slot("id"), textContent: slot("name") } }));

    const drawn = juris.renderToString({ select: { children: [option({ id: "a", name: "One" })] } });

    assert.equal(drawn, '<select><option value="a">One</option></select>');
});

test("a <select> with no slot in it is fixed text, its option selected", () => {
    const juris = server();
    const layout = {
        div: {
            title: { $slot: "title" },
            children: [{ select: { value: "b", children: [{ option: { value: "b", textContent: "Two" } }] } }],
        },
    };

    const drawn = juris.renderToString(juris.compile(layout)({ title: "Pick" }));

    assert.equal(drawn, '<div title="Pick"><select><option value="b" selected="">Two</option></select></div>');
});

test("a URL a value gives is held to the instance's allowSchemes", () => {
    const juris = server({ allowSchemes: ["magnet"] });
    const link = juris.compile((slot) => ({ a: { href: slot("url") } }));

    assert.equal(juris.renderToString(link({ url: "magnet:?xt=1" })), '<a href="magnet:?xt=1"></a>');
    assert.equal(juris.renderToString(link({ url: "ftp2:x" })), "<a></a>");
});

test("a refused URL is said in devMode, as an ordinary layout's is", (t) => {
    const warn = t.mock.method(console, "warn", () => { });
    const juris = server({ devMode: true });
    const link = juris.compile((slot) => ({ a: { href: slot("url") } }));

    const drawn = juris.renderToString(link({ url: "javascript:alert(1)" }));

    assert.equal(drawn, "<a></a>");
    assert.match(String(warn.mock.calls[0].arguments[0]), /href refuses/);
});

test("a slot reads a field of the values' own, never one they inherit", () => {
    const juris = server();
    const row = juris.compile({ td: { $slot: "constructor" } });
    const inherited = juris.compile({ td: { children: [{ $slot: "__proto__" }, { $slot: "toString" }] } });

    assert.equal(juris.renderToString(row({})), "<td></td>");
    assert.equal(juris.renderToString(row()), "<td></td>");
    assert.equal(juris.renderToString(inherited({})), "<td></td>");
    assert.equal(juris.renderToString(row({ constructor: "Mine" })), "<td>Mine</td>");
});

test("a field a value's prototype holds is not its own, as in the browser", () => {
    const juris = server();
    const row = juris.compile((slot) => ({ td: { title: slot("label"), textContent: slot("label") } }));

    const drawn = juris.renderToString(row(Object.create({ label: "Inherited" })));

    assert.equal(drawn, "<td></td>");
});

test("a value is never read back as a slot, or as a word only the compile knows", () => {
    const juris = server();
    const row = juris.compile((slot) => ({ td: { title: slot("a"), textContent: slot("b") } }));

    const drawn = juris.renderToString(row({ a: "juris-slot-1", b: "{ $slot: a }" }));

    assert.equal(drawn, '<td title="juris-slot-1">{ $slot: a }</td>');
});

test("text a layout holds is kept, however much it looks like a slot's mark", () => {
    const juris = server();
    const row = juris.compile((slot) => ({ td: { title: "juris-slot-0-", children: ["juris-slot-1-", slot("a")] } }));

    assert.equal(juris.renderToString(row({ a: "x" })), '<td title="juris-slot-0-">juris-slot-1-x</td>');
});

test("a layout with no slot is fixed text", () => {
    const juris = server();

    assert.equal(juris.renderToString(juris.compile({ hr: {} })()), "<hr>");
    assert.equal(juris.renderToString(juris.compile("Plain & simple")()), "Plain &amp; simple");
    assert.equal(juris.renderToString(juris.compile(null)()), "");
});

test("a layout stored as JSON compiles, and the checks of layoutFromData come first", () => {
    const juris = server();
    const stored = JSON.parse(`{
        "div": {
            "className": "card",
            "children": [
                { "h2": { "$slot": "title" } },
                { "Admin": { "secret": { "$slot": "title" } } },
                { "a": { "href": { "$slot": "url" }, "textContent": "Open" } }
            ]
        }
    }`);

    const card = juris.compile(juris.layoutFromData(stored));
    const drawn = juris.renderToString(card({ title: "<Lot 42>", url: "/lots/42" }));

    assert.equal(drawn, '<div class="card"><h2>&lt;Lot 42&gt;</h2><a href="/lots/42">Open</a></div>');
});

test("a stored layout's own __proto__ key changes nothing", () => {
    const juris = server();
    const stored = JSON.parse('{ "p": { "__proto__": { "polluted": 1 }, "textContent": { "$slot": "a" } } }');

    const drawn = juris.renderToString(juris.compile(stored)({ a: "Safe" }));

    assert.equal(drawn, "<p>Safe</p>");
    assert.equal({}.polluted, undefined);
});

test("listeners stay in the layout and have no HTML, as in an ordinary layout", () => {
    const juris = server();
    const row = juris.compile((slot) => ({ button: { onclick: () => slot("id"), textContent: slot("label") } }));

    assert.equal(juris.renderToString(row({ id: 1, label: "Open" })), "<button>Open</button>");
});

test("a compiled render's trace says nothing ran and nothing was read", () => {
    const juris = server();
    const row = juris.compile((slot) => ({ li: slot("label") }));

    juris.renderToString(row({ label: "One" }), null, { trace: true });

    const { reactive, paths, static: unchanging } = juris.renderTrace();
    assert.deepEqual([reactive, paths, unchanging], [0, [], true]);
});

test("in the browser, or with no string renderer, a compiled layout is the ordinary layout", () => {
    const juris = new Juris({});
    const layout = (slot) => ({
        tr: {
            key: slot("id"),
            onclick: () => slot("id"),
            children: [{ td: slot("label") }],
        },
    });

    const row = juris.compile(layout)({ id: 1, label: "One" });

    assert.equal(row.tr.key, 1);
    assert.equal(row.tr.onclick(), 1);
    assert.deepEqual(row.tr.children, [{ td: "One" }]);
});

test("in the browser a stored layout is filled, and a slot reads a field of its own", () => {
    const juris = new Juris({});
    const cells = '[{ "td": { "$slot": "a" } }, { "td": { "$slot": "toString" } }]';
    const stored = JSON.parse(`{ "tr": { "children": ${cells} } }`);

    const row = juris.compile(stored)({ a: "One" });

    assert.deepEqual(row, { tr: { children: [{ td: "One" }, { td: undefined }] } });
});

// ---- what cannot keep the promise is refused when compiled -----------------------------------------

const REFUSED = {
    "a function in text": [
        { td: { textContent: () => "now" } },
        /Juris\.compile: textContent is a function/,
    ],
    "a function as children": [
        { ul: { children: () => [] } },
        /Juris\.compile: children is a function/,
    ],
    "a function as the whole content": [
        { td: () => "now" },
        /Juris\.compile: <td> is given a function/,
    ],
    "a function in a child's place": [
        { ul: { children: [() => ({ li: "One" })] } },
        /Juris\.compile: a function in a child's place/,
    ],
    "a function in an attribute": [
        { div: { title: () => "now" } },
        /Juris\.compile: title is a function/,
    ],
    "a function in a style": [
        { div: { style: { color: () => "red" } } },
        /Juris\.compile: color is a function/,
    ],
    "a registered component": [
        { div: { children: [{ Badge: {} }] } },
        /Juris\.compile: <Badge> is a component/,
    ],
    "a capitalised tag": [
        { Later: {} },
        /Juris\.compile: <Later> is a component/,
    ],
    "a <style>": [
        { style: { textContent: "a { }" } },
        /Juris\.compile: <style>/,
    ],
    innerHTML: [
        { div: { innerHTML: "<b>x</b>" } },
        /Juris\.compile: innerHTML/,
    ],
    "a slot inside a <select>": [
        { select: { children: [{ option: { value: { $slot: "a" } } }] } },
        /Juris\.compile: slot "a" is inside a <select>/,
    ],
    "a slot as a <select>'s value": [
        { select: { value: { $slot: "a" } } },
        /Juris\.compile: slot "a" is inside a <select>/,
    ],
    "a slot as a class beside a classList": [
        { div: { className: { $slot: "a" }, classList: { on: false } } },
        /Juris\.compile: slot "a" in className is beside a classList/,
    ],
    "a slot in a classList": [
        { div: { classList: { on: { $slot: "a" } } } },
        /Juris\.compile: slot "a" has no place in the markup/,
    ],
    "a slot as a style": [
        { div: { style: { $slot: "a" } } },
        /Juris\.compile: slot "a" is only part of what is written/,
    ],
    "a slot in a style": [
        { div: { style: { width: { $slot: "a" } } } },
        /Juris\.compile: slot "a" is only part of what is written/,
    ],
    "a slot as a math annotation's encoding": [
        { math: { children: [{ "annotation-xml": { encoding: { $slot: "a" } } }] } },
        /Juris\.compile: slot "a" in encoding/,
    ],
    "a slot in a void element's text": [
        { img: { textContent: { $slot: "a" } } },
        /Juris\.compile: slot "a" has no place in the markup/,
    ],
    "a slot beside what the element holds": [
        { p: { textContent: "Fixed", children: [{ $slot: "a" }] } },
        /Juris\.compile: slot "a" has no place in the markup/,
    ],
    "a slot in a refused attribute": [
        { div: { srcdoc: { $slot: "a" } } },
        /Juris\.compile: slot "a" has no place in the markup/,
    ],
    "a slot in an event attribute": [
        { button: { onclick: { $slot: "a" } } },
        /Juris\.compile: slot "a" has no place in the markup/,
    ],
    "a slot in a refused tag": [
        { script: { textContent: { $slot: "a" } } },
        /Juris\.compile: slot "a" has no place in the markup/,
    ],
    "a slot with no name": [
        { p: { $slot: "" } },
        /Juris\.compile: a slot's name is a field's name/,
    ],
    "a slot whose name is not a string": [
        { p: { $slot: 7 } },
        /Juris\.compile: a slot's name is a field's name/,
    ],
};

for (const [what, [layout, reason]] of Object.entries(REFUSED)) {
    test(`${what} is refused when compiled`, () => {
        const juris = server();
        juris.registerComponent("Badge", () => ({ b: "New" }));

        assert.throws(() => juris.compile(layout), { name: "TypeError", message: reason });
    });
}

test("a component registered under a lower-case name is refused too", () => {
    const juris = server();
    juris.registerComponent("row", () => ({ tr: {} }));

    assert.throws(() => juris.compile({ row: {} }), compileError(/Juris\.compile: <row> is a component/));
});

test("a compiled layout inside a layout being compiled is refused", () => {
    const juris = server();
    const badge = juris.compile({ b: "New" });

    assert.throws(() => juris.compile({ td: { children: [badge()] } }), compileError(/already compiled/));
});

test("a slot used as a value when compiling is refused, in words that say what it is", () => {
    const juris = server();

    assert.throws(
        () => juris.compile((slot) => ({ td: `Hello ${slot("name")}` })),
        compileError(/Juris\.compile: slot\("name"\) is a place, not a value/),
    );
});

test("a slot function given no name is refused", () => {
    const juris = server();

    assert.throws(
        () => juris.compile((slot) => ({ td: slot() })),
        compileError(/Juris\.compile: a slot's name is a field's name/),
    );
});

test("a refusal holds in the middle of a list of children, and a static <select> is not one", () => {
    const juris = server();
    const fine = { div: { children: [{ select: { children: [{ option: "One" }] } }, { p: { $slot: "a" } }] } };

    assert.doesNotThrow(() => juris.compile(fine));
    assert.throws(() => juris.compile({ ul: { children: [{ li: "One" }, { Badge: {} }] } }), { name: "TypeError" });
});

// ---- devMode holds a function's layout to what it draws --------------------------------------------

test("in devMode a layout that branched on a slot is said, as the rows differ from the ordinary ones", (t) => {
    const warn = t.mock.method(console, "warn", () => { });
    const juris = server({ devMode: true });
    const row = juris.compile((slot) => ({ td: slot("sold") ? "Sold" : "In stock" }));

    const drawn = juris.renderToString(row({ sold: false }));

    assert.equal(drawn, "<td>Sold</td>");
    assert.match(String(warn.mock.calls[0].arguments[0]), /branched on a slot/);
});

test("in devMode a compiled layout that matches says nothing", (t) => {
    const warn = t.mock.method(console, "warn", () => { });
    const juris = server({ devMode: true });
    const row = juris.compile((slot) => ({ td: slot("label") }));

    assert.equal(juris.renderToString(row({ label: "One" })), "<td>One</td>");
    assert.equal(warn.mock.callCount(), 0);
});
