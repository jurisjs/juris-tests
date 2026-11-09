// A stand-in DOM, enough for the DOM renderer to draw into, and the means to read back what it was
// asked to do. Not a browser: it does what the renderer asks and throws where a browser throws
// (classList with a bad token). It follows the juris package's own tests/render.test.mjs, with what
// these tests also read: a <template>'s content, cssText, and a serializer to compare with the
// server's markup.
import { HTML } from "../fixtures/elements.mjs";

export class FakeNode {
    static ELEMENT_NODE = 1;
    static TEXT_NODE = 3;
    static DOCUMENT_FRAGMENT_NODE = 11;
    constructor(nodeType) {
        this.nodeType = nodeType;
        this.parentNode = null;
        this.childNodes = [];
    }
    get firstChild() { return this.childNodes[0] ?? null; }
    get lastChild() { return this.childNodes.at(-1) ?? null; }
    get nextSibling() {
        const siblings = this.parentNode?.childNodes;
        return siblings ? (siblings[siblings.indexOf(this) + 1] ?? null) : null;
    }
    get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
    appendChild(node) { return this.insertBefore(node, null); }
    insertBefore(node, ref) {
        if (node.parentNode) node.parentNode.removeChild(node);
        const index = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
        this.childNodes.splice(index, 0, node);
        node.parentNode = this;
        return node;
    }
    removeChild(node) {
        this.childNodes.splice(this.childNodes.indexOf(node), 1);
        node.parentNode = null;
        return node;
    }
    remove() { this.parentNode?.removeChild(this); }
    replaceWith(node) {
        const parent = this.parentNode;
        parent.insertBefore(node, this);
        parent.removeChild(this);
    }
    get isConnected() { return true; }
    get textContent() { return this.childNodes.map((n) => n.textContent).join(""); }
    set textContent(value) {
        for (const child of [...this.childNodes]) this.removeChild(child);
        this.html = undefined; // the text replaces markup innerHTML gave, as in a browser
        if (value !== "") this.appendChild(new FakeText(String(value)));
    }
}

export class FakeText extends FakeNode {
    constructor(text) { super(3); this.nodeValue = text; }
    get textContent() { return this.nodeValue; }
}

export class FakeFragment extends FakeNode {
    constructor() { super(11); }
}

const domError = (name) => Object.assign(new Error(name), { name });

export class FakeElement extends FakeNode {
    constructor(localName, namespaceURI) {
        super(1);
        this.localName = localName;
        this.namespaceURI = namespaceURI;
        this.attrs = new Map(); // qualified name -> { ns, value }
        this.html = undefined; // what innerHTML was given, if anything
        // As in a browser, appending to a <template> makes a child; only the parser fills `content`.
        if (localName === "template" && namespaceURI === HTML) this.content = new FakeFragment();
        const custom = {};
        const element = this;
        this.style = {
            custom,
            setProperty: (name, value) => { custom[name] = value; },
            removeProperty: (name) => { delete custom[name]; },
            set cssText(value) { if (value === "") element.removeAttribute("style"); else element.setAttribute("style", value); },
            get cssText() { return element.getAttribute("style") ?? ""; },
        };
        this.classList = {
            tokens() { return (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean); },
            check(token) {
                if (token === "") throw domError("SyntaxError");
                if (/[\t\n\f\r ]/.test(token)) throw domError("InvalidCharacterError");
            },
            toggle(token, force) {
                this.check(token);
                const set = new Set(this.tokens());
                const on = force ?? !set.has(token);
                if (on) set.add(token); else set.delete(token);
                element.setAttribute("class", [...set].join(" "));
                return on;
            },
            remove(token) {
                this.check(token);
                element.setAttribute("class", this.tokens().filter((t) => t !== token).join(" "));
            },
            contains(token) { return this.tokens().includes(token); },
        };
        this.listeners = [];
        if (namespaceURI === HTML) defineValue(this);
    }
    // HTML elements in an HTML document lower-case an attribute's name; others keep it.
    qualified(name) { return this.namespaceURI === HTML ? String(name).toLowerCase() : String(name); }
    setAttribute(name, value) { this.attrs.set(this.qualified(name), { ns: null, value: String(value) }); }
    setAttributeNS(ns, name, value) { this.attrs.set(name, { ns, value: String(value) }); }
    getAttribute(name) { return this.attrs.get(this.qualified(name))?.value ?? null; }
    hasAttribute(name) { return this.attrs.has(this.qualified(name)); }
    removeAttribute(name) { this.attrs.delete(this.qualified(name)); }
    toggleAttribute(name, force) { if (force) this.setAttribute(name, ""); else this.removeAttribute(name); }
    addEventListener(type, listener) { this.listeners.push({ type, listener }); }
    removeEventListener(type, listener) { this.listeners = this.listeners.filter((l) => l.type !== type || l.listener !== listener); }
    get dataset() {
        const out = {};
        for (const [name, { value }] of this.attrs) if (name.startsWith("data-")) out[name.slice(5)] = value;
        return out;
    }
    get innerHTML() { return this.html ?? ""; }
    set innerHTML(value) {
        for (const child of [...this.childNodes]) this.removeChild(child);
        this.html = String(value);
    }
    // Where it is on screen: `rect`, which a test sets, or nothing.
    getBoundingClientRect() { return this.rect ?? { left: 0, top: 0, width: 0, height: 0 }; }
    // A shadow root, which the test reads back as `shadow` (and its mode as `shadowMode`).
    attachShadow({ mode }) {
        this.shadowMode = mode;
        this.shadow = new FakeFragment();
        return this.shadow;
    }
}

// The HTML elements with a `value` IDL attribute, as a browser has them: on these it reflects the
// content attribute; an <input>, <textarea> and <select> keep a value of their own (the attribute
// is only the default); an <output>'s replaces its text; an <option>'s reflects, falling back to
// its text.
const REFLECTED_VALUE = new Set(["button", "data", "li", "meter", "progress", "param", "option"]);
const OWN_VALUE = new Set(["input", "textarea", "select"]);
function defineValue(element) {
    const tag = element.localName;
    if (REFLECTED_VALUE.has(tag)) {
        Object.defineProperty(element, "value", {
            get() { return element.getAttribute("value") ?? (tag === "option" ? element.textContent : ""); },
            set(value) { element.setAttribute("value", value); },
        });
    } else if (OWN_VALUE.has(tag)) {
        // Until it is given one, a <textarea>'s value is its text (its default value), as in a browser.
        let own;
        Object.defineProperty(element, "value", {
            get() {
                if (own !== undefined) return own;
                return tag === "textarea" ? element.textContent : element.getAttribute("value") ?? "";
            },
            set(value) { own = String(value); },
        });
    } else if (tag === "output") {
        Object.defineProperty(element, "value", {
            get() { return element.textContent; },
            set(value) { element.textContent = String(value); },
        });
    }
}

export const created = []; // every element the stand-in document made, in order

export const fakeDocument = {
    createElement: (tag) => { const el = new FakeElement(tag.toLowerCase(), HTML); created.push(el); return el; },
    createElementNS: (ns, tag) => { const el = new FakeElement(tag, ns); created.push(el); return el; },
    createTextNode: (text) => new FakeText(text),
    createDocumentFragment: () => new FakeFragment(),
    getElementById: () => null,
};

// Runs `fn` with the stand-in DOM as the global one.
export function withDom(fn) {
    const saved = { document: globalThis.document, Node: globalThis.Node };
    globalThis.document = fakeDocument;
    globalThis.Node = FakeNode;
    created.length = 0;
    try {
        return fn();
    } finally {
        if (saved.document === undefined) delete globalThis.document; else globalThis.document = saved.document;
        if (saved.Node === undefined) delete globalThis.Node; else globalThis.Node = saved.Node;
    }
}

// The node as the server would have written it: attributes in the order they were set, double
// quoted and escaped as the SSR renderer escapes them, HTML's void elements without an end tag.
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const escapeText = (value) => String(value).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const escapeAttribute = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export function serialize(node) {
    if (node.nodeType === FakeNode.TEXT_NODE) return escapeText(node.nodeValue);
    if (node.nodeType !== FakeNode.ELEMENT_NODE) return node.childNodes.map(serialize).join("");
    let html = `<${node.localName}`;
    for (const [name, { value }] of node.attrs) html += ` ${name}="${escapeAttribute(value)}"`;
    html += ">";
    if (node.namespaceURI === HTML && VOID.has(node.localName)) return html;
    // A <template>'s children are its content, which HTML's serialization writes in its place. What
    // innerHTML was given comes first: a node appended after it follows it, as in a browser.
    const inside = (node.html ?? "") + (node.content ?? node).childNodes.map(serialize).join("");
    return `${html}${inside}</${node.localName}>`;
}

// The element's attributes as { name: value }, in the order they were set.
export const attributesOf = (element) => Object.fromEntries([...element.attrs].map(([name, { value }]) => [name, value]));

// Collects console.warn while `fn` runs.
export function warnings(fn) {
    const said = [];
    const original = console.warn;
    console.warn = (...args) => said.push(args.map(String).join(" "));
    try {
        fn();
    } finally {
        console.warn = original;
    }
    return said;
}
