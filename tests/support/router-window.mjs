// What the router's tests share: globals swapped for the length of a test and put back whatever
// happens, a window whose location and history follow each other as a browser's do (a trail of
// entries, popstate on a traversal), a Storage, and a promise settled from outside.

// Replaces globalThis[name] for the length of `fn` (sync or async), and puts every one back after.
export async function withGlobals(values, fn) {
    const before = {};
    for (const [name, value] of Object.entries(values)) {
        before[name] = Object.getOwnPropertyDescriptor(globalThis, name);
        Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
    }
    try {
        return await fn();
    } finally {
        for (const [name, descriptor] of Object.entries(before)) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    }
}

// A browser tab at `address`, on an entry that carries `state`. `calls` records what the page asked
// of it, in order: ["push", url, state], ["replace", url, state], ["back"], ["forward"],
// ["scrollTo", x, y], ["reload"]. `traverse(delta)` is the visitor's Back (-1) or Forward (+1),
// `anchor(hash)` an in-page #link; both fire popstate as a browser does.
export function fakeWindow(address = "/", { state = null, scrollTo = true } = {}) {
    const calls = [];
    const listeners = new Map();
    const location = {
        pathname: "/",
        search: "",
        hash: "",
        reload() {
            calls.push(["reload"]);
        },
    };
    const resolve = (url) => new URL(url, `http://site${location.pathname}${location.search}`);
    const show = (url) => {
        const next = resolve(url);
        location.pathname = next.pathname;
        location.search = next.search;
        location.hash = next.hash;
    };
    const here = () => `${location.pathname}${location.search}${location.hash}`;
    show(address);
    const entries = [{ url: here(), state }];
    let at = 0;
    const history = {
        get state() {
            return entries[at].state;
        },
        get length() {
            return entries.length;
        },
        replaceState(next, _title, url) {
            calls.push(["replace", url, next]);
            if (url !== undefined) show(url);
            entries[at] = { url: here(), state: next };
        },
        pushState(next, _title, url) {
            calls.push(["push", url, next]);
            show(url);
            entries.splice(at + 1);
            entries.push({ url: here(), state: next });
            at += 1;
        },
        back() {
            calls.push(["back"]);
        },
        forward() {
            calls.push(["forward"]);
        },
    };
    const fire = (type, event) => {
        for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    };
    const win = {
        location,
        history,
        calls,
        entries,
        addEventListener(type, listener) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(listener);
        },
        removeEventListener(type, listener) {
            listeners.get(type)?.delete(listener);
        },
        listenerCount: (type) => listeners.get(type)?.size ?? 0,
        address: here,
        traverse(delta) {
            at += delta;
            if (at < 0 || at >= entries.length) throw new RangeError(`no entry ${delta} away`);
            show(entries[at].url);
            fire("popstate", { state: entries[at].state });
        },
        anchor(hash) {
            show(`#${hash}`);
            entries.splice(at + 1);
            entries.push({ url: here(), state: null });
            at += 1;
            fire("popstate", { state: null });
        },
    };
    if (scrollTo) win.scrollTo = (x, y) => calls.push(["scrollTo", x, y]);
    return win;
}

// The calls of one kind, e.g. pushes(win) -> [[url, state], …].
export const pushes = (win) => win.calls.filter(([how]) => how === "push").map(([, url, state]) => [url, state]);
export const replaces = (win) => win.calls.filter(([how]) => how === "replace").map(([, url, state]) => [url, state]);

// A Storage (getItem, setItem) holding `initial`, recording each write. `fail: true` makes both
// throw, as a browser's does in some private modes.
export function fakeStorage(initial = {}, { fail = false } = {}) {
    const items = new Map(Object.entries(initial));
    const writes = [];
    return {
        items,
        writes,
        getItem(key) {
            if (fail) throw new Error("storage: denied");
            return items.has(key) ? items.get(key) : null;
        },
        setItem(key, value) {
            if (fail) throw new Error("storage: denied");
            writes.push([key, value]);
            items.set(key, String(value));
        },
    };
}

// A promise and the means to settle it.
export function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

// Lets every promise reaction queued so far run (a handful of microtask turns, no timer).
export async function settle(turns = 10) {
    for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

// Collects console.error's calls for the length of `fn`, and puts console.error back after.
export async function capturingErrors(fn) {
    const said = [];
    const original = console.error;
    console.error = (...args) => said.push(args);
    try {
        await fn(said);
    } finally {
        console.error = original;
    }
    return said;
}

// A plain copy of what a router answers: its queries have no prototype, which deepStrictEqual tells
// apart from {}.
export const plain = (value) => JSON.parse(JSON.stringify(value));
