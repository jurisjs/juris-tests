// A stand-in document for the DOM renderer's own tests (tests/juris/dom-renderer*.test.mjs), built on
// dom.mjs's nodes. It adds what enhance() and the renderer's other paths ask of a real document:
// ids (getElementById), simple selectors (matches, querySelectorAll), whether an element is in the
// document (isConnected), a MutationObserver a test fires by hand, a <select> whose value is its
// selected option's (lost when that option goes, as in a browser), a style that is a declaration
// list (removing the `style` attribute clears it, as in a browser), and an <input>'s `checked`,
// `disabled` and `indeterminate` properties. Not a browser either: it does what the renderer asks,
// and lets a test read back what was asked.
import { FakeNode, FakeText, FakeFragment, FakeElement } from "./dom.mjs";
import { HTML } from "../fixtures/elements.mjs";

export { FakeNode, FakeText, FakeFragment, HTML };
export const SVG = "http://www.w3.org/2000/svg";
export const MATHML = "http://www.w3.org/1998/Math/MathML";
export const XLINK = "http://www.w3.org/1999/xlink";
export const XML = "http://www.w3.org/XML/1998/namespace";
export const XMLNS = "http://www.w3.org/2000/xmlns/";

// `marginTop` -> `margin-top`, `WebkitTransform` -> `-webkit-transform`, `cssFloat` -> `float`, and
// `webkitTransform`, in lower case, -> `-webkit-transform` too (CSSOM's webkit-cased attributes).
const cssName = (key) => {
    if (key.startsWith("--")) return key;
    if (key === "cssFloat") return "float";
    const kebab = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    return /^(ms|webkit)-/.test(kebab) ? `-${kebab}` : kebab;
};

// An element's inline style: the declarations, readable by camelCase name or through
// getPropertyValue, serialised as the `style` attribute.
function makeStyle(declarations) {
    const write = (name, value) => {
        if (value === "" || value === null || value === undefined) declarations.delete(name);
        else declarations.set(name, String(value));
    };
    const own = {
        setProperty: (name, value) => write(name, value),
        removeProperty: (name) => { declarations.delete(name); },
        getPropertyValue: (name) => declarations.get(name) ?? "",
        get length() { return declarations.size; },
        get cssText() { return [...declarations].map(([name, value]) => `${name}: ${value};`).join(" "); },
        set cssText(text) {
            declarations.clear();
            for (const part of String(text).split(";")) {
                const colon = part.indexOf(":");
                if (colon > 0) write(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
            }
        },
    };
    return new Proxy(own, {
        get(target, key) {
            if (typeof key !== "string" || key in target) return Reflect.get(target, key);
            return declarations.get(cssName(key)) ?? "";
        },
        set(target, key, value) {
            if (key === "cssText") target.cssText = value;
            else write(cssName(String(key)), value);
            return true;
        },
    });
}

// One compound selector: an optional tag (or `*`), then any of #id, .class, [name] and [name=value].
function parseSelector(selector) {
    const text = String(selector).trim();
    const out = { tag: null, id: null, classes: [], attributes: [] };
    const head = /^(\*|[A-Za-z][A-Za-z0-9-]*)/.exec(text);
    let rest = text;
    if (head) {
        if (head[1] !== "*") out.tag = head[1].toLowerCase();
        rest = text.slice(head[0].length);
    }
    const part = /^(?:#([A-Za-z0-9_-]+)|\.([A-Za-z0-9_-]+)|\[([A-Za-z0-9_:-]+)(?:="?([^"\]]*)"?)?\])/;
    while (rest) {
        const match = part.exec(rest);
        if (!match) throw Object.assign(new Error(`unsupported selector: ${selector}`), { name: "SyntaxError" });
        if (match[1] !== undefined) out.id = match[1];
        else if (match[2] !== undefined) out.classes.push(match[2]);
        else out.attributes.push([match[3], match[4]]);
        rest = rest.slice(match[0].length);
    }
    return out;
}

function matchesParsed(element, parsed) {
    if (parsed.tag && element.localName.toLowerCase() !== parsed.tag) return false;
    if (parsed.id && element.getAttribute("id") !== parsed.id) return false;
    for (const name of parsed.classes) if (!element.classList.contains(name)) return false;
    for (const [name, value] of parsed.attributes) {
        if (!element.hasAttribute(name)) return false;
        if (value !== undefined && element.getAttribute(name) !== value) return false;
    }
    return true;
}

function* descendants(node) {
    for (const child of node.childNodes) {
        if (child.nodeType !== FakeNode.ELEMENT_NODE) continue;
        yield child;
        yield* descendants(child);
    }
}

// The options of a <select>, in tree order (inside an <optgroup> too).
const optionsOf = (select) => [...descendants(select)].filter((n) => n.localName === "option");

export class Element extends FakeElement {
    constructor(localName, namespaceURI) {
        // dom.mjs gives a <select> a value of its own, which this one replaces with a browser's.
        const isSelect = localName === "select" && namespaceURI === HTML;
        super(isSelect ? "x-select" : localName, namespaceURI);
        this.declarations = new Map();
        this.style = makeStyle(this.declarations);
        // DOMTokenList's update steps: an element with no class attribute whose token set ends up
        // empty is given none (dom.mjs writes class="" there).
        const element = this;
        const update = (set) => {
            if (set.size === 0 && !element.hasAttribute("class")) return;
            element.setAttribute("class", [...set].join(" "));
        };
        this.classList.toggle = function toggle(token, force) {
            this.check(token);
            const set = new Set(this.tokens());
            const on = force ?? !set.has(token);
            if (on) set.add(token);
            else set.delete(token);
            update(set);
            return on;
        };
        this.classList.remove = function remove(token) {
            this.check(token);
            const set = new Set(this.tokens());
            set.delete(token);
            update(set);
        };
        if (isSelect) {
            this.localName = "select";
            Object.defineProperty(this, "value", {
                get: () => optionsOf(this).find((option) => option.selected)?.value ?? "",
                set: (value) => {
                    for (const option of optionsOf(this)) option.selected = false;
                    const match = optionsOf(this).find((option) => option.value === String(value));
                    if (match) match.selected = true;
                },
            });
        }
        if (localName === "option" && namespaceURI === HTML) this.selected = false;
        if (localName === "input" && namespaceURI === HTML) {
            this.checked = false;
            this.disabled = false;
            this.indeterminate = false;
        }
    }

    // The `style` attribute is the declarations' serialisation.
    setAttribute(name, value) {
        if (this.qualified(name) === "style") this.style.cssText = value;
        else super.setAttribute(name, value);
    }
    getAttribute(name) {
        if (this.qualified(name) === "style") return this.declarations.size ? this.style.cssText : null;
        return super.getAttribute(name);
    }
    hasAttribute(name) {
        if (this.qualified(name) === "style") return this.declarations.size > 0;
        return super.hasAttribute(name);
    }
    removeAttribute(name) {
        if (this.qualified(name) === "style") this.declarations.clear();
        else super.removeAttribute(name);
    }

    get id() { return this.getAttribute("id") ?? ""; }

    // In the document: its root is the document's root element.
    get isConnected() {
        let node = this;
        while (node.parentNode) node = node.parentNode;
        return node.isDocumentRoot === true;
    }

    matches(selector) { return matchesParsed(this, parseSelector(selector)); }
    querySelectorAll(selector) {
        const parsed = parseSelector(selector);
        return [...descendants(this)].filter((element) => matchesParsed(element, parsed));
    }

    // Calls the listeners of `type` with `event`, as dispatchEvent would.
    fire(type, event = { type }) {
        for (const { type: t, listener } of [...this.listeners]) if (t === type) listener(event);
    }
}

// A MutationObserver that delivers only when a test says so: `deliver({ addedNodes, removedNodes })`.
export class FakeMutationObserver {
    static instances = [];
    constructor(callback) {
        this.callback = callback;
        this.observed = [];
        this.connected = false;
        FakeMutationObserver.instances.push(this);
    }
    observe(target, options) {
        this.observed.push({ target, options });
        this.connected = true;
    }
    disconnect() { this.connected = false; }
    deliver(...records) {
        if (this.connected) this.callback(records.map((record) => ({ addedNodes: [], removedNodes: [], ...record })), this);
    }
}

export function createDocument() {
    const documentElement = new Element("html", HTML);
    documentElement.isDocumentRoot = true;
    const body = documentElement.appendChild(new Element("body", HTML));
    return {
        documentElement,
        body,
        createElement: (tag) => new Element(String(tag).toLowerCase(), HTML),
        createElementNS: (ns, tag) => new Element(tag, ns),
        createTextNode: (text) => new FakeText(String(text)),
        createDocumentFragment: () => new FakeFragment(),
        getElementById: (id) => [documentElement, ...descendants(documentElement)].find((element) => element.getAttribute("id") === id) ?? null,
        querySelectorAll: (selector) => {
            const parsed = parseSelector(selector);
            return [documentElement, ...descendants(documentElement)].filter((element) => matchesParsed(element, parsed));
        },
    };
}

// Builds an element (as the server's markup would have), with attributes and children, outside
// the renderer: `el("ul", { id: "list" }, el("li", { "data-key": "a" }, "A"))`.
export function el(tag, attributes = {}, ...children) {
    const element = new Element(tag, HTML);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    for (const child of children) element.appendChild(typeof child === "string" ? new FakeText(child) : child);
    return element;
}

const GLOBALS = ["document", "Node", "MutationObserver"];

// Makes the stand-in the global DOM (document, Node, MutationObserver unless told not to), and
// answers { document, restore }; restore() puts back exactly what was there before.
export function installDom({ mutationObserver = true } = {}) {
    const saved = GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    const document = createDocument();
    globalThis.document = document;
    globalThis.Node = FakeNode;
    if (mutationObserver) globalThis.MutationObserver = FakeMutationObserver;
    else delete globalThis.MutationObserver;
    FakeMutationObserver.instances.length = 0;
    return {
        document,
        restore() {
            for (const [name, descriptor] of saved) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else delete globalThis[name];
            }
        },
    };
}

// Lets every queued microtask (and the promise reactions they queue) run.
export const settle = () => new Promise((resolve) => setImmediate(resolve));

// A promise and the means to settle it from the test.
export function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}
