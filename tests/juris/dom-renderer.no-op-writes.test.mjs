// The DOM renderer (dom-renderer.js), work a draw does not need to do: text and attributes already as
// a layout says are left alone, a node with nothing of its own is passed through on disposal, and a
// list none of whose rows stay goes in one step. Each is held to doing what the slower way did.
// The tag check's memory (html-safety.js) is here too: only what passed is remembered.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";
import { checkTag, allowedTags } from "juris/html-safety.js";

import { installDom, el, FakeNode } from "../support/dom-renderer-dom.mjs";

let dom;
beforeEach(() => {
    dom = installDom();
});
afterEach(() => dom.restore());

const client = (options = {}) => new Juris({ isServer: false, ...options });
const put = (element) => dom.document.body.appendChild(element);
const first = (root, selector) => root.querySelectorAll(selector)[0] ?? null;

// A page drawing `list` from state, which a test replaces to make the renderer draw again.
function listPage(juris, rows) {
    juris.setValue("rows", rows);
    const page = put(el("div"));
    juris.render(page, { ul: { children: () => juris.getState("rows") } });
    return page;
}

// ---- text ------------------------------------------------------------------------------------------

test("a redraw that gives the same text keeps the text node", () => {
    const juris = client();
    const page = listPage(juris, [{ li: { key: "a", textContent: "Milk" } }]);
    const row = first(page, "li");
    const text = row.firstChild;

    juris.setValue("rows", [{ li: { key: "a", textContent: "Milk" } }]);

    assert.equal(first(page, "li"), row);
    assert.equal(row.firstChild, text);
    assert.equal(row.textContent, "Milk");
});

test("a redraw that gives other text shows it", () => {
    const juris = client();
    const page = listPage(juris, [{ li: { key: "a", textContent: "Milk" } }]);

    juris.setValue("rows", [{ li: { key: "a", textContent: "Eggs" } }]);

    assert.equal(first(page, "li").textContent, "Eggs");
});

test("a function giving the same text on a redraw keeps the text node too", () => {
    const juris = client();
    const page = listPage(juris, [{ li: { key: "a", textContent: () => "Milk" } }]);
    const text = first(page, "li").firstChild;

    juris.setValue("rows", [{ li: { key: "a", textContent: () => "Milk" } }]);

    assert.equal(first(page, "li").firstChild, text);
    assert.equal(first(page, "li").textContent, "Milk");
});

test("text the same as what child elements spell replaces them: elements are not text", () => {
    const juris = client();
    const page = listPage(juris, [{ li: { key: "a", children: [{ b: "Milk" }] } }]);

    juris.setValue("rows", [{ li: { key: "a", textContent: "Milk" } }]);

    const row = first(page, "li");
    assert.equal(first(row, "b"), null);
    assert.equal(row.textContent, "Milk");
    assert.equal(row.firstChild.nodeType, FakeNode.TEXT_NODE);
});

test("empty text empties an element, and an empty element stays empty", () => {
    const juris = client();
    const page = listPage(juris, [{ li: { key: "a", textContent: "Milk" } }, { li: { key: "b", textContent: "" } }]);

    juris.setValue("rows", [{ li: { key: "a", textContent: "" } }, { li: { key: "b", textContent: "" } }]);

    assert.equal(page.querySelectorAll("li")[0].textContent, "");
    assert.equal(page.querySelectorAll("li")[1].textContent, "");
});

test("a value that is no text leaves nothing behind: the old text goes", () => {
    const juris = client();
    const page = listPage(juris, [{ li: { key: "a", textContent: "Milk" } }]);

    juris.setValue("rows", [{ li: { key: "a", textContent: { not: "text" } } }]);

    assert.equal(first(page, "li").textContent, "");
});

test("text kept on one redraw is no reason to keep it on the next, if that one gives none", () => {
    const juris = client();
    const page = listPage(juris, [{ li: { key: "a", textContent: "Milk" } }]);
    juris.setValue("rows", [{ li: { key: "a", textContent: "Milk" } }]);

    juris.setValue("rows", [{ li: { key: "a", textContent: { not: "text" } } }]);

    assert.equal(first(page, "li").textContent, "");
});

test("a binding's own change still shows after a redraw that kept the text node", () => {
    const juris = client();
    juris.setValue("name", "Milk");
    const row = () => [{ li: { key: "a", textContent: () => juris.getState("name") } }];
    const page = listPage(juris, row());
    juris.setValue("rows", row());

    juris.setValue("name", "Eggs");

    assert.equal(first(page, "li").textContent, "Eggs");
});

// ---- attributes ------------------------------------------------------------------------------------

test("a redraw writes no attribute that already holds the value, and writes one that does not", () => {
    const juris = client();
    const page = listPage(juris, [{ li: { key: "a", title: "same", lang: "en" } }]);
    const row = first(page, "li");
    const written = [];
    const original = row.setAttribute;
    row.setAttribute = function setAttribute(name, value) {
        written.push(name);
        return original.call(this, name, value);
    };

    juris.setValue("rows", [{ li: { key: "a", title: "same", lang: "fr" } }]);

    assert.deepEqual(written, ["lang"]);
    assert.equal(row.getAttribute("lang"), "fr");
    assert.equal(row.getAttribute("title"), "same");
});

test("a number is written once as its text, and the same number is not written again", () => {
    const juris = client();
    const page = listPage(juris, [{ li: { key: "a", "data-count": 7 } }]);
    const row = first(page, "li");
    let writes = 0;
    const original = row.setAttribute;
    row.setAttribute = function setAttribute(name, value) {
        writes += 1;
        return original.call(this, name, value);
    };

    juris.setValue("rows", [{ li: { key: "a", "data-count": 7 } }]);

    assert.equal(writes, 0);
    assert.equal(row.getAttribute("data-count"), "7");
});

// ---- disposal --------------------------------------------------------------------------------------

test("disposal goes through nodes with nothing of their own to a binding below them", () => {
    const juris = client();
    let cleaned = 0;
    juris.registerComponent("Deep", (props, { onCleanup }) => {
        onCleanup(() => {
            cleaned += 1;
        });
        return { b: "deep" };
    });
    juris.setValue("show", true);
    const page = put(el("div"));
    const inner = { section: { children: [{ div: { children: [{ Deep: {} }] } }] } };
    juris.render(page, { main: { children: () => (juris.getState("show") ? [inner] : []) } });

    juris.setValue("show", false);

    assert.equal(cleaned, 1);
});

// ---- a list none of whose rows stay ----------------------------------------------------------------

const cleanedRow = (juris, cleaned, id) => {
    juris.registerComponent(`Row${id}`, (props, { onCleanup }) => {
        onCleanup(() => cleaned.push(id));
        return { li: `row ${id}` };
    });
    return { [`Row${id}`]: { key: id } };
};

test("a list emptied at once disposes every row and holds nothing", () => {
    const juris = client();
    const cleaned = [];
    const page = listPage(juris, [cleanedRow(juris, cleaned, 1), cleanedRow(juris, cleaned, 2)]);

    juris.setValue("rows", []);

    assert.deepEqual(cleaned.sort(), [1, 2]);
    assert.equal(first(page, "ul").childNodes.length, 0);
});

test("a list whose rows are all replaced shows the new ones, in order, and the old ones go", () => {
    const juris = client();
    const page = listPage(juris, [{ li: { key: "a", textContent: "A" } }, { li: { key: "b", textContent: "B" } }]);
    const old = first(page, "li");

    juris.setValue("rows", [{ li: { key: "c", textContent: "C" } }, { li: { key: "d", textContent: "D" } }]);

    assert.deepEqual([...page.querySelectorAll("li")].map((row) => row.textContent), ["C", "D"]);
    assert.notEqual(first(page, "li"), old);
    assert.equal(old.parentNode, null);
});

test("a row whose cleanup throws as a list empties keeps none from going, and the error goes on", () => {
    const juris = client();
    const cleaned = [];
    juris.registerComponent("Bad", (props, { onCleanup }) => {
        onCleanup(() => {
            throw new Error("cleanup failed");
        });
        return { li: "bad" };
    });
    const page = listPage(juris, [{ Bad: { key: 0 } }, cleanedRow(juris, cleaned, 1)]);

    assert.throws(() => juris.setValue("rows", []), /cleanup failed/);

    assert.deepEqual(cleaned, [1]);
    assert.equal(first(page, "ul").childNodes.length, 0);
});

// ---- the tag check ---------------------------------------------------------------------------------

test("a tag that passed passes again, and the answer is the same", () => {
    assert.deepEqual(checkTag("section"), { ok: true });
    assert.deepEqual(checkTag("section"), { ok: true });
});

test("a refused tag stays refused, however often it is asked", () => {
    for (let time = 0; time < 3; time += 1) {
        assert.equal(checkTag("script").ok, false);
        assert.equal(checkTag("img src=x onerror=alert(1)").ok, false);
    }
});

test("what one list of allowed tags let through is nothing to another", () => {
    const open = allowedTags(["iframe"]);
    const closed = allowedTags([]);

    assert.equal(checkTag("iframe", open).ok, true);
    assert.equal(checkTag("iframe", closed).ok, false);
    assert.equal(checkTag("iframe").ok, false);
    assert.equal(checkTag("iframe", open).ok, true);
});

test("a tag allowed on one instance is drawn there, and refused on another", () => {
    const open = client({ allowTags: ["iframe"] });
    const closed = client();
    const here = put(el("div"));
    const there = put(el("div"));

    open.render(here, { iframe: { src: "/a" } });
    closed.render(there, { iframe: { src: "/a" } });

    assert.ok(first(here, "iframe"));
    assert.equal(first(there, "iframe"), null);
});

test("tags past what is remembered are still checked, each as it comes", () => {
    for (let index = 0; index < 700; index += 1) {
        assert.equal(checkTag(`x-tag-${index}`).ok, true);
    }

    assert.equal(checkTag("script").ok, false);
    assert.equal(checkTag("x-tag-699").ok, true);
});
