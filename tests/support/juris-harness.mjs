// What the juris.js tests share: globals replaced for the length of one function and put back
// whatever happens, console output collected rather than printed, and the stand-in DOM of dom.mjs
// installed around an async function (dom.mjs's withDom is synchronous).
import { fakeDocument, FakeNode, FakeElement } from "./dom.mjs";

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Replaces globalThis[name] for each entry for the length of `fn`, and puts back what was there.
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

// Collects console[method]'s calls (each as its argument list) for the length of `fn`.
export async function capture(method, fn) {
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

// The stand-in document and Node as the global ones for the length of `fn` (sync or async).
export function withDom(fn) {
    return withGlobals({ document: fakeDocument, Node: FakeNode }, fn);
}

// A detached <div> of the stand-in DOM, to render into.
export const container = () => new FakeElement("div", "http://www.w3.org/1999/xhtml");
