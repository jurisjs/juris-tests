// A server-rendered page as the client boot (client.js hydrate) finds it, and the browser around it:
// a document holding the root element with the server's markup and the JSON scripts the server
// wrote (and, when asked, elements a page's content drew with the same ids, earlier in the
// document), a window whose location and history follow each other, sessionStorage, a
// requestIdleCallback a test runs by hand, navigator.serviceWorker, fetch and EventSource. Built on
// the stand-in DOM in ./dom.mjs; withPage installs it all on globalThis and puts back what was there.
import { FakeElement, FakeNode, FakeText, FakeFragment } from "./dom.mjs";
import { HTML } from "../fixtures/elements.mjs";
import { withGlobals, eventSources } from "./remote-services-fakes.mjs";

// An element of the page, its `id` reflecting the attribute as a browser's does.
const element = (tag, attributes = {}, text) => {
    const el = new FakeElement(tag, HTML);
    Object.defineProperty(el, "id", { get: () => el.getAttribute("id") ?? "", set: (value) => el.setAttribute("id", value) });
    for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
    if (text !== undefined) el.textContent = text;
    return el;
};

const jsonScript = (id, value) => element("script", { type: "application/json", id }, typeof value === "string" ? value : JSON.stringify(value));

// The document. `state` is written as #state (or `stateId`), `services` as #services unless it is
// undefined, `decoys` are [tag, attributes, text] drawn before the scripts, as content is.
export function fakePage({ state = { $route: { path: "/" } }, services, stateId = "state", rootId = "app", markup = "the server's markup", decoys = [], extraScripts = [] } = {}) {
    const root = element("div", { id: rootId }, markup);
    const body = element("body");
    body.appendChild(root);
    for (const [tag, attributes, text] of decoys) body.appendChild(element(tag, attributes, text));
    body.appendChild(jsonScript(stateId, state));
    if (services !== undefined) body.appendChild(jsonScript("services", services));
    for (const [id, value] of extraScripts) body.appendChild(jsonScript(id, value));

    const everything = () => {
        const out = [];
        const walk = (node) => { for (const child of node.childNodes) if (child.nodeType === 1) { out.push(child); walk(child); } };
        walk(body);
        return out;
    };
    const reads = [];          // every lookup the page was asked for, so a test can tell it was not read
    const listeners = new Set();
    const document = {
        title: "Server title",
        visibilityState: "visible",
        body,
        reads,
        querySelectorAll(selector) {
            reads.push(["querySelectorAll", selector]);
            if (selector !== 'script[type="application/json"]') throw new Error(`the stand-in document does not answer ${selector}`);
            return everything().filter((el) => el.localName === "script" && el.getAttribute("type") === "application/json");
        },
        getElementById(id) {
            reads.push(["getElementById", id]);
            return everything().find((el) => el.getAttribute("id") === id) ?? null;
        },
        createElement: (tag) => new FakeElement(tag.toLowerCase(), HTML),
        createElementNS: (ns, tag) => new FakeElement(tag, ns),
        createTextNode: (text) => new FakeText(text),
        createDocumentFragment: () => new FakeFragment(),
        addEventListener(type, fn) { if (type === "visibilitychange") listeners.add(fn); },
        removeEventListener(type, fn) { listeners.delete(fn); },
    };
    return { document, root, body };
}

// A window at `address`, whose history writes the location as a browser's does. It keeps its
// listeners, and dispatch(type, extra) hands each of that type an event, as a browser does with
// pagehide and pageshow ({ persisted }).
export function fakeWindow(address = "/") {
    const listeners = new Map(); // type -> Set of listeners
    const addEventListener = (type, listener) => {
        listeners.set(type, new Set([...(listeners.get(type) ?? []), listener]));
    };
    const removeEventListener = (type, listener) => {
        listeners.get(type)?.delete(listener);
    };
    const dispatch = (type, extra = {}) => {
        const event = { type, ...extra };
        for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
        return event;
    };
    const reloads = [];
    const location = { reload: () => reloads.push(`${location.pathname}${location.search}${location.hash}`) };
    const go = (url) => {
        const next = new URL(url, `http://site${location.pathname ?? "/"}`);
        location.pathname = next.pathname;
        location.search = next.search;
        location.hash = next.hash;
    };
    go(address);
    const history = {
        state: null,
        replaceState(entry, _title, url) { this.state = entry; if (url !== undefined) go(url); },
        pushState(entry, _title, url) { this.state = entry; go(url); },
        back() { },
        forward() { },
    };
    return {
        location,
        history,
        reloads,
        listeners,
        addEventListener,
        removeEventListener,
        dispatch,
        scrollTo() { },
    };
}

// sessionStorage, with every write it was asked for. `blocked`: setItem throws (a browser's storage
// turned off); `forgetful`: it takes the write and keeps nothing; `unreadable`: getItem throws.
export function fakeStorage({ blocked = false, forgetful = false, unreadable = false, unclearable = false } = {}) {
    const items = new Map();
    const writes = [];
    return {
        items,
        writes,
        getItem(key) {
            if (unreadable) throw new Error("SecurityError");
            return items.has(key) ? items.get(key) : null;
        },
        setItem(key, value) {
            writes.push(["set", key, String(value)]);
            if (blocked) throw new Error("QuotaExceededError");
            if (!forgetful) items.set(key, String(value));
        },
        removeItem(key) {
            writes.push(["remove", key]);
            if (unclearable) throw new Error("SecurityError");
            items.delete(key);
        },
    };
}

// requestIdleCallback, held: run() calls what was handed to it, in order, and empties the list.
export function fakeIdle() {
    const callbacks = [];
    const requestIdleCallback = (fn) => { callbacks.push(fn); return callbacks.length; };
    return { requestIdleCallback, callbacks, run() { for (const fn of callbacks.splice(0)) fn(); } };
}

// navigator.serviceWorker: what it was asked to register, and emit(data) for a message from it.
export function fakeServiceWorker(register = async () => ({})) {
    const registered = [];
    const listeners = [];
    return {
        registered,
        listeners,
        container: {
            register(url) { registered.push(url); return register(url); },
            addEventListener(type, fn) { listeners.push([type, fn]); },
        },
        emit(data) {
            const event = { data, type: "message" };
            for (const [type, fn] of listeners) if (type === "message") fn(event);
            return event;
        },
    };
}

// Installs the page and its browser on globalThis while `fn` runs. Every part may be replaced:
// { page, address, window, storage, idle, worker, fetch, EventSource, extra }, where `idle: false` leaves no
// requestIdleCallback, `worker: false` no navigator.serviceWorker, and `extra` names more globals.
export async function withPage(parts, fn) {
    const page = parts.page ?? fakePage();
    const win = parts.window ?? fakeWindow(parts.address ?? "/");
    const storage = parts.storage ?? fakeStorage();
    const idle = parts.idle === false ? null : (parts.idle ?? fakeIdle());
    const worker = parts.worker === false ? null : (parts.worker ?? fakeServiceWorker());
    const sources = parts.sources ?? eventSources();
    const globals = {
        document: page.document,
        Node: FakeNode,
        window: win,
        location: win.location,
        history: win.history,
        sessionStorage: storage,
        requestIdleCallback: idle ? idle.requestIdleCallback : undefined,
        navigator: worker ? { serviceWorker: worker.container } : { },
        fetch: parts.fetch ?? (async () => { throw new Error("no fetch in this test"); }),
        EventSource: parts.EventSource ?? sources.FakeEventSource,
        ...(parts.extra ?? {}),
    };
    return withGlobals(globals, () => fn({ page, window: win, storage, idle, worker, sources }));
}
