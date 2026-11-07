// A stand-in for the parts of a browser webcomponent.js uses, over the stand-in DOM in dom.mjs: a
// custom element registry, an HTMLElement to extend (its observed attributes tell
// attributeChangedCallback, as a browser's do), shadow roots attached once, events, the selectors
// getSlot and getAllSlots ask for, CSS.escape, and animation frames run when a test says so. Not a
// browser: connecting and disconnecting are what a test does by hand (connect, disconnect), the
// way the parser or appendChild would call the callbacks.
import { FakeElement, FakeFragment, FakeNode, fakeDocument } from "./dom.mjs";
import { HTML } from "../fixtures/elements.mjs";

const domError = (name, message = name) => Object.assign(new Error(message), { name });

const names = new WeakMap(); // a defined class -> the name it was defined under

export class FakeShadowRoot extends FakeFragment {
    constructor(host, mode) {
        super();
        this.host = host;
        this.mode = mode;
    }
}

// CSS.escape, as CSSOM defines it.
export function cssEscape(value) {
    const text = String(value);
    let out = "";
    for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (code === 0) out += "�";
        else if ((code >= 0x01 && code <= 0x1f) || code === 0x7f || (i === 0 && code >= 0x30 && code <= 0x39) || (i === 1 && code >= 0x30 && code <= 0x39 && text.charCodeAt(0) === 0x2d)) out += `\\${code.toString(16)} `;
        else if (i === 0 && text.length === 1 && code === 0x2d) out += `\\${text[i]}`;
        else if (code >= 0x80 || code === 0x2d || code === 0x5f || (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) out += text[i];
        else out += `\\${text[i]}`;
    }
    return out;
}

// A CSS string's escapes undone: `\` and a hex code point (and the space after it), or `\` and a character.
const cssUnescape = (text) => text.replace(/\\([0-9a-fA-F]{1,6}) ?|\\(.)/gs, (_, hex, char) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : char));

// The three selectors webcomponent.js asks for; anything else is a SyntaxError here, so a selector
// built without escaping its value shows up as one instead of matching by accident.
function matcher(selector) {
    if (selector === "[slot]") return (element) => element.hasAttribute("slot");
    if (selector === ":not([slot])") return (element) => !element.hasAttribute("slot");
    const quoted = /^\[slot="((?:[^"\\]|\\.)*)"\]$/s.exec(selector);
    if (quoted) {
        const wanted = cssUnescape(quoted[1]);
        return (element) => element.getAttribute("slot") === wanted;
    }
    throw domError("SyntaxError", `'${selector}' is not a valid selector`);
}

function* descendants(node) {
    for (const child of node.childNodes) {
        if (child.nodeType !== FakeNode.ELEMENT_NODE) continue;
        yield child;
        yield* descendants(child);
    }
}

export class FakeHTMLElement extends FakeElement {
    #shadow = null;

    constructor() {
        super(names.get(new.target) ?? "x-undefined", HTML);
        this.events = []; // every event dispatched on the element, in order
        this.selectors = []; // every selector asked of it
    }

    attachShadow(init) {
        if (this.#shadow) throw domError("NotSupportedError", "Failed to execute 'attachShadow': Shadow root cannot be created on a host which already hosts a shadow tree.");
        this.#shadow = new FakeShadowRoot(this, init?.mode);
        return this.#shadow;
    }

    // As in a browser: null for a closed root.
    get shadowRoot() {
        return this.#shadow?.mode === "open" ? this.#shadow : null;
    }

    get attachedShadowRoot() {
        return this.#shadow;
    }

    setAttribute(name, value) {
        const old = this.getAttribute(name);
        super.setAttribute(name, value);
        this.#changed(name, old, this.getAttribute(name));
    }

    removeAttribute(name) {
        if (!this.hasAttribute(name)) return;
        const old = this.getAttribute(name);
        super.removeAttribute(name);
        this.#changed(name, old, null);
    }

    #changed(name, old, value) {
        const observed = this.constructor.observedAttributes ?? [];
        if (observed.includes(name) && typeof this.attributeChangedCallback === "function") this.attributeChangedCallback(name, old, value);
    }

    dispatchEvent(event) {
        this.events.push(event);
        for (const { type, listener } of [...this.listeners]) if (type === event.type) listener.call(this, event);
        return !event.defaultPrevented;
    }

    querySelector(selector) {
        this.selectors.push(selector);
        const matches = matcher(selector);
        for (const element of descendants(this)) if (matches(element)) return element;
        return null;
    }

    querySelectorAll(selector) {
        this.selectors.push(selector);
        const matches = matcher(selector);
        return [...descendants(this)].filter(matches);
    }
}

export class FakeCustomElementRegistry {
    #defined = new Map();

    define(name, constructor) {
        if (this.#defined.has(name)) throw domError("NotSupportedError", `the name "${name}" has already been used with this registry`);
        this.#defined.set(name, constructor);
        names.set(constructor, name);
    }

    get(name) {
        return this.#defined.get(name);
    }

    get names() {
        return [...this.#defined.keys()];
    }
}

const GLOBALS = ["document", "Node", "HTMLElement", "customElements", "CSS", "requestAnimationFrame"];

// Puts the stand-in browser on globalThis; `restore()` puts back exactly what was there before.
export function installBrowser() {
    const saved = GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    const frames = [];
    const browser = {
        customElements: new FakeCustomElementRegistry(),
        body: new FakeElement("body", HTML),
        frames,
        // Runs the animation frames asked for so far (and any they ask for, on a later call).
        runFrames() {
            const due = frames.splice(0);
            for (const callback of due) callback(0);
            return due.length;
        },
        // A new element of a defined name, with these attributes set before it connects.
        create(name, attributes = {}) {
            const Element = browser.customElements.get(name);
            if (!Element) throw new Error(`no custom element "${name}" defined`);
            const element = new Element();
            for (const [attribute, value] of Object.entries(attributes)) element.setAttribute(attribute, value);
            return element;
        },
        connect(element, parent = browser.body) {
            parent.appendChild(element);
            element.connectedCallback?.();
            return element;
        },
        disconnect(element) {
            element.remove();
            element.disconnectedCallback?.();
            return element;
        },
        restore() {
            for (const [name, descriptor] of saved) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else delete globalThis[name];
            }
        },
    };
    globalThis.document = fakeDocument;
    globalThis.Node = FakeNode;
    globalThis.HTMLElement = FakeHTMLElement;
    globalThis.customElements = browser.customElements;
    globalThis.CSS = { escape: cssEscape };
    globalThis.requestAnimationFrame = (callback) => frames.push(callback);
    return browser;
}
