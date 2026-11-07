// juris.layoutFromData (juris.js): a layout that came as data, such as a database row. Every component
// it names is refused unless the call lists it, wherever it stands; what is left is the same layout.
// Held to REFERENCE.md ("Layouts from a database").
import { test } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";
import { withSSR } from "../support/ssr-renderer.mjs";

const instance = (options = {}) => {
    const juris = new Juris(withSSR({ isServer: true, ...options }));
    juris.registerComponent("Badge", ({ text }) => ({ b: { textContent: text } }));
    juris.registerComponent("RefundButton", ({ order }) => ({ button: `Refund order ${order}` }));
    return juris;
};

const parsed = (text) => JSON.parse(text);

test("a layout with no component comes back the same, as a copy", () => {
    const juris = instance();
    const stored = parsed('{"div":{"className":"card","children":[{"h2":"Lot 42"},{"p":{"textContent":"Step 3"}}]}}');

    const layout = juris.layoutFromData(stored);

    assert.deepEqual(layout, stored);
    assert.notEqual(layout, stored);
    assert.notEqual(layout.div.children, stored.div.children);
});

test("a component the call does not list is left out, in a list of children", () => {
    const juris = instance();
    const stored = parsed('{"ul":{"children":[{"li":"Milk"},{"RefundButton":{"order":7}},{"li":"Eggs"}]}}');

    const layout = juris.layoutFromData(stored);

    assert.deepEqual(layout, { ul: { children: [{ li: "Milk" }, { li: "Eggs" }] } });
    assert.equal(juris.renderToString(layout), "<ul><li>Milk</li><li>Eggs</li></ul>");
});

test("a component the call lists is kept, with its props", () => {
    const juris = instance();
    const stored = parsed('{"div":{"children":[{"Badge":{"text":"Passed"}},{"RefundButton":{"order":7}}]}}');

    const layout = juris.layoutFromData(stored, { components: ["Badge"] });

    assert.deepEqual(layout, { div: { children: [{ Badge: { text: "Passed" } }] } });
    assert.equal(juris.renderToString(layout), "<div><b>Passed</b></div>");
});

test("a whole layout that is a refused component answers null, which draws nothing", () => {
    const juris = instance();

    const layout = juris.layoutFromData(parsed('{"RefundButton":{"order":7}}'));

    assert.equal(layout, null);
    assert.equal(juris.renderToString({ main: { children: [layout] } }), "<main></main>");
});

test("children given as one object, not a list, are held to the same rule", () => {
    const juris = instance();

    const layout = juris.layoutFromData(parsed('{"div":{"id":"a","children":{"RefundButton":{"order":7}}}}'));

    assert.deepEqual(layout, { div: { id: "a" } });
});

test("a refused component inside an allowed one's props goes too, whichever prop holds it", () => {
    const juris = instance();
    const stored = parsed('{"Badge":{"text":"a","header":{"RefundButton":{"order":7}},"items":[{"RefundButton":{}}]}}');

    const layout = juris.layoutFromData(stored, { components: ["Badge"] });

    assert.deepEqual(layout, { Badge: { text: "a", items: [] } });
});

test("a name with a capital is taken for a component even before one is registered under it", () => {
    const juris = instance();

    const layout = juris.layoutFromData(parsed('{"div":{"children":[{"LaterOne":{}},{"p":"after"}]}}'));

    assert.deepEqual(layout, { div: { children: [{ p: "after" }] } });
});

test("a component registered with a small letter is refused as well", () => {
    const juris = instance();
    juris.registerComponent("shipIt", () => ({ button: "Ship" }));

    const layout = juris.layoutFromData(parsed('{"div":{"children":[{"shipIt":{}}]}}'));

    assert.deepEqual(layout, { div: { children: [] } });
});

test("a style object keeps its keys, capitals included", () => {
    const juris = instance();

    const layout = juris.layoutFromData(parsed('{"p":{"style":{"WebkitBoxFlex":"1","color":"red"}}}'));

    assert.deepEqual(layout, { p: { style: { WebkitBoxFlex: "1", color: "red" } } });
});

test("__proto__ in the data reaches no prototype", () => {
    const juris = instance();

    const layout = juris.layoutFromData(parsed('{"div":{"__proto__":{"polluted":true},"id":"a"}}'));

    assert.equal(layout.div.polluted, undefined);
    assert.equal({}.polluted, undefined);
    assert.deepEqual(Object.keys(layout.div), ["id"]);
});

test("text, a number and null come back as they are", () => {
    const juris = instance();

    assert.equal(juris.layoutFromData("Lot 42"), "Lot 42");
    assert.equal(juris.layoutFromData(7), 7);
    assert.equal(juris.layoutFromData(null), null);
});

test("a layout read from state inside a binding is walked as what it holds", () => {
    const juris = instance();
    juris.setValue("doc", parsed('{"div":{"children":[{"RefundButton":{"order":7}},{"p":"after"}]}}'));

    const html = juris.renderToString({ main: { children: () => [juris.layoutFromData(juris.getState("doc"))] } });

    assert.equal(html, "<main><div><p>after</p></div></main>");
});

test("components must be a list of names", () => {
    const juris = instance();

    for (const components of ["Badge", null, 1, {}, [1]]) {
        assert.throws(
            () => juris.layoutFromData({ p: "a" }, { components }),
            (error) => error instanceof TypeError && /components is a list of component names/.test(error.message),
        );
    }
});

test("in devMode a refused component says so, and out of it nothing is said", () => {
    const said = [];
    const original = console.warn;
    console.warn = (...args) => said.push(args.join(" "));

    try {
        instance().layoutFromData(parsed('{"RefundButton":{"order":7}}'));
        assert.deepEqual(said, []);

        instance({ devMode: true }).layoutFromData(parsed('{"RefundButton":{"order":7}}'));
        assert.equal(said.length, 1);
        assert.match(said[0], /RefundButton/);
    } finally {
        console.warn = original;
    }
});
