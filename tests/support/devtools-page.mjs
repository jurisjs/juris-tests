// A page for the devtools feature (devtools.js) to run in: the stand-in DOM of dom.mjs as the
// document, with what the feature reaches for beyond what the renderer needs: the document element
// (the outline's host is appended there), the page's JSON scripts (#juris-dev, read once), listeners
// in the capture phase (the picker), a window that is an EventTarget (the registry's event), and
// animation frames a test runs by hand. `inspect` builds a devMode instance with the feature and a
// connection to its endpoint.
import Juris from "juris/juris.js";
import { Devtools } from "juris/devtools.js";
import { FakeElement, FakeNode, fakeDocument } from "./dom.mjs";
import { HTML } from "../fixtures/elements.mjs";
import { withGlobals } from "./remote-services-fakes.mjs";

export { Devtools };

// `scripts` are [id, text] JSON scripts the page carries.
export function devtoolsPage({ scripts = [] } = {}) {
    const documentElement = new FakeElement("html", HTML);
    const listeners = [];
    const document = {
        ...fakeDocument,
        documentElement,
        listeners,
        querySelectorAll(selector) {
            if (selector !== 'script[type="application/json"]') throw new Error(`the stand-in document does not answer ${selector}`);
            return scripts.map(([id, textContent]) => ({ id, textContent }));
        },
        addEventListener(type, listener, capture) { listeners.push({ type, listener, capture }); },
        removeEventListener(type, listener, capture) {
            const index = listeners.findIndex((entry) => entry.type === type && entry.listener === listener && entry.capture === capture);
            if (index !== -1) listeners.splice(index, 1);
        },
    };
    const window = new EventTarget();
    const registered = [];
    window.addEventListener("juris:devtools", (event) => registered.push(event.detail));
    const frames = [];
    return {
        document,
        window,
        registered,
        frames,
        // Runs the animation frames asked for so far.
        runFrames() { for (const fn of frames.splice(0)) fn(performance.now()); },
        // An event dispatched to the document's capture listeners, as a browser dispatches one to
        // them first: answers it, with whether it was kept from the page's own handlers.
        dispatch(type, target) {
            const event = {
                type, target, defaultPrevented: false, stopped: false,
                preventDefault() { this.defaultPrevented = true; },
                stopPropagation() { this.stopped = true; },
                stopImmediatePropagation() { this.stopped = true; },
            };
            for (const entry of [...listeners]) if (entry.type === type && entry.capture === true) entry.listener(event);
            return event;
        },
    };
}

// The page's document, window, Node and requestAnimationFrame as the global ones while `fn` runs.
export function withDevtoolsPage(page, fn) {
    return withGlobals({ document: page.document, window: page.window, Node: FakeNode, requestAnimationFrame: (callback) => page.frames.push(callback) }, () => fn(page));
}

// devMode's console line for an instance on window, kept off the test's output.
export function quietInfo(fn) {
    const info = console.info;
    console.info = () => { };
    try {
        return fn();
    } finally {
        console.info = info;
    }
}

// A devMode instance with the feature (and `options`), and one connection to its endpoint:
// `answer` is a request's whole answer, `ask` its result (it throws on a refusal), `refusal` the
// refusal's code, `drain` the connection's events.
export function inspect(options = {}) {
    const juris = quietInfo(() => new Juris({ isServer: false, devMode: true, ...options, features: { devtools: Devtools, ...options.features } }));
    const { endpoint } = juris.devtools;
    const connection = endpoint.connect();
    const answer = (method, params) => endpoint.request(connection, method, params);
    const ask = (method, params) => {
        const answered = answer(method, params);
        if (!answered.ok) throw new Error(`${method}: ${answered.error.code}: ${answered.error.message}`);
        return answered.result;
    };
    return {
        juris,
        endpoint,
        connection,
        answer,
        ask,
        refusal: (method, params) => answer(method, params).error?.code,
        drain: () => endpoint.drain(connection),
        events: (type) => endpoint.drain(connection).events.filter((event) => type === undefined || event.type === type),
        done: () => endpoint.disconnect(connection),
    };
}

// A detached <div> to draw into.
export const host = () => new FakeElement("div", HTML);
