// Stand-ins for what the browser half of services and live queries reaches for on globalThis
// (remote-services.js, client.js): an EventSource a test drives, a fetch whose answers a test
// chooses or holds back, a document whose visibility a test sets, and the means to put any global
// back however a test ends.

// Replaces globalThis[name] for each entry while `fn` runs (a value of undefined removes it), and
// puts every one back as it was, whatever happens.
export async function withGlobals(values, fn) {
    const before = new Map();
    for (const [name, value] of Object.entries(values)) {
        before.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        if (value === undefined) delete globalThis[name];
        else Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: true });
    }
    try {
        return await fn();
    } finally {
        for (const [name, descriptor] of before) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    }
}

// Collects console[method]'s calls while `fn` runs, and answers them.
export async function quiet(method, fn) {
    const said = [];
    const original = console[method];
    console[method] = (...args) => said.push(args);
    try {
        await fn(said);
    } finally {
        console[method] = original;
    }
    return said;
}

// Lets every pending promise callback run. setImmediate, so mock.timers on setTimeout stops nothing.
export async function flush(rounds = 8) {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

// A promise and the means to settle it.
export function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

// A fresh EventSource class for one test, with every stream it opened, in order. A stream's
// readyState is 0 (connecting) until a hello, 1 once greeted, 2 once closed.
export function eventSources() {
    const opened = [];
    class FakeEventSource {
        constructor(url) {
            this.url = url;
            this.readyState = 0;
            this.listeners = new Map();
            opened.push(this);
        }
        addEventListener(type, fn) {
            this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
        }
        // `data` as the server would write it: JSON, unless a string is given to be sent as it is.
        emit(type, data) {
            const text = data === undefined || typeof data === "string" ? data : JSON.stringify(data);
            for (const fn of this.listeners.get(type) ?? []) fn({ data: text });
        }
        hello(client) {
            this.readyState = 1;
            this.emit("hello", { client });
        }
        // The browser's error event: 0 while it retries by itself, 2 once it has given up.
        fail(readyState) {
            this.readyState = readyState;
            this.emit("error");
        }
        patch(body) {
            this.emit("patch", body);
        }
        close() {
            this.readyState = 2;
        }
        get closed() {
            return this.readyState === 2;
        }
    }
    return { FakeEventSource, opened, get last() { return opened.at(-1); } };
}

// A dispatcher's /_live endpoint: every request it is sent, and the answer `answer(body, request)`
// chooses, { status, statusText, body } (200 and {} unless said), or an Error to fail on the
// network. An answer may be a promise, which holds the request until the test settles it.
export function liveEndpoint(answer = () => ({})) {
    const requests = [];
    const fetch = async (url, init) => {
        const request = { url, init, body: JSON.parse(init.body) };
        requests.push(request);
        const said = (await answer(request.body, request)) ?? {};
        if (said instanceof Error) throw said;
        const status = said.status ?? 200;
        const response = { ok: status >= 200 && status < 300, status, statusText: said.statusText };
        if (said.json !== false) response.json = async () => (said.body === undefined ? {} : said.body);
        if (said.badJson) response.json = async () => { throw new SyntaxError("Unexpected token <"); };
        return response;
    };
    return {
        fetch,
        requests,
        bodies: () => requests.map((request) => request.body),
        subscribes: () => requests.filter((request) => request.body.subscribe).map((request) => request.body),
        unsubscribes: () => requests.filter((request) => request.body.unsubscribe).map((request) => request.body),
    };
}

// A window with only what the live client asks of one: its pagehide and pageshow listeners.
// hide(persisted) and show(persisted) tell every listener, as a browser does when a page is put in
// the back/forward cache (persisted true) or leaves for good, and when it is shown from the cache.
export function pageWindow({ removable = true } = {}) {
    const listeners = new Map(); // type -> Set of listeners
    const tell = (type, persisted) => {
        for (const fn of [...(listeners.get(type) ?? [])]) fn({ type, persisted });
    };
    const win = {
        listeners,
        addEventListener(type, fn) {
            listeners.set(type, new Set([...(listeners.get(type) ?? []), fn]));
        },
        hide(persisted = true) {
            tell("pagehide", persisted);
        },
        show(persisted = true) {
            tell("pageshow", persisted);
        },
        count(type) {
            return listeners.get(type)?.size ?? 0;
        },
    };
    if (removable) {
        win.removeEventListener = (type, fn) => {
            listeners.get(type)?.delete(fn);
        };
    }
    return win;
}

// A document with only what the live client asks of one: its visibility and the listener for it.
// show(state) changes the state and tells every listener, as a browser does.
export function visibilityDocument(state = "visible", { removable = true } = {}) {
    const listeners = new Set();
    const doc = {
        visibilityState: state,
        listeners,
        addEventListener(type, fn) { if (type === "visibilitychange") listeners.add(fn); },
        show(next) {
            doc.visibilityState = next;
            for (const fn of [...listeners]) fn();
        },
    };
    if (removable) doc.removeEventListener = (type, fn) => { if (type === "visibilitychange") listeners.delete(fn); };
    return doc;
}
