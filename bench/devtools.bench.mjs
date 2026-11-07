// What the devtools feature (devtools.js) costs a devMode page, against the budget in REFERENCE.md
// ("devtools.js", "What it costs"): a script to run by hand, never a test (D19: timings are not
// asserted in CI). On the stand-in DOM of tests/support/dom.mjs, so it measures Juris's own work,
// not a browser's layout; the budget's other half is checked in Chrome on a page of the same size.
//
//   node --expose-gc bench/devtools.bench.mjs
//
// The page: a list of 500 rows, each a component with 3 bindings (a class, two texts), and a footer
// of 300 seats: 1,800 bindings and 500 component instances.
// Four ways to run it: devMode off; devMode on without the feature; with the feature and no
// connection; with the feature and the timeline subscribed.
import Juris from "juris/juris.js";
import { Devtools } from "juris/devtools.js";
import { fakeDocument, FakeNode, FakeElement } from "../tests/support/dom.mjs";
import { HTML } from "../tests/fixtures/elements.mjs";

const ROWS = 500;
const SEATS = 300;
const WARMUP = 3; // rounds run and thrown away, so every variant is measured warm
const ROUNDS = 25; // each round runs every variant once, in a rotated order
const WRITES = 10_000;

globalThis.document = fakeDocument;
globalThis.Node = FakeNode;
globalThis.window = new EventTarget();
globalThis.requestAnimationFrame = () => 0; // frames never come: a drain is measured on its own
console.info = () => { };

const VARIANTS = [
    { name: "devMode off", options: {} },
    { name: "devMode on", options: { devMode: true } },
    { name: "feature, no connection", options: { devMode: true, features: { devtools: Devtools } } },
    { name: "feature, timeline", options: { devMode: true, features: { devtools: Devtools } }, timeline: true },
];

const rows = () => Array.from({ length: ROWS }, (_, i) => ({ id: i, name: `row ${i}`, qty: i % 7 }));

function page(options, timeline) {
    const juris = new Juris({ isServer: false, ...options, state: { rows: rows(), selected: -1, footer: Array.from({ length: SEATS }, (_, i) => i) } });
    juris.registerComponent("Row", (props, api) => ({
        li: {
            classList: { selected: () => api.getState("selected") === props.index },
            children: [
                { span: { textContent: () => api.getState(`rows.${props.index}.name`) } },
                { b: { textContent: () => String(api.getState(`rows.${props.index}.qty`)) } },
            ],
        },
    }));
    const connection = timeline ? juris.devtools.endpoint.connect() : null;
    if (timeline) juris.devtools.endpoint.request(connection, "subscribe", { topic: "timeline" });
    const root = new FakeElement("div", HTML);
    const mount = () => juris.render(root, {
        div: {
            children: [
                { ul: { children: Array.from({ length: ROWS }, (_, index) => ({ Row: { key: index, index } })) } },
                { footer: { children: Array.from({ length: SEATS }, (_, i) => () => String(juris.getState(`footer.${i}`))) } },
            ],
        },
    });
    return { juris, mount, connection };
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const gc = () => { for (let i = 0; i < 3; i += 1) globalThis.gc?.(); };
const time = (fn) => {
    gc();
    const start = performance.now();
    fn();
    return performance.now() - start;
};

const samples = Object.fromEntries(VARIANTS.map((variant) => [variant.name, { mount: [], one: [], many: [], drain: [], full: [], bindings: null }]));
for (let round = 0; round < WARMUP + ROUNDS; round += 1) {
    for (let turn = 0; turn < VARIANTS.length; turn += 1) {
        const variant = VARIANTS[(round + turn) % VARIANTS.length];
        const { juris, mount, connection } = page(variant.options, variant.timeline);
        // Creating the bindings: the whole page mounted.
        const mounted = time(mount);
        // A pass that wakes one binding (a row's quantity), and one that wakes 500 (the selection).
        const one = (time(() => { for (let i = 0; i < WRITES; i += 1) juris.setValue(`rows.${i % ROWS}.qty`, i); }) / WRITES) * 1000;
        const many = (time(() => { for (let i = 0; i < 300; i += 1) juris.setValue("selected", i % ROWS); }) / 300) * 1000;
        // A drain of one pass that woke 500, and a drain that stops at 1 MiB (the queue is full of
        // the passes above).
        let drain = null;
        let full = null;
        if (connection !== null) {
            const { endpoint } = juris.devtools;
            full = time(() => endpoint.drain(connection));
            while (endpoint.drain(connection).more);
            juris.setValue("selected", 1);
            drain = time(() => endpoint.drain(connection));
        }
        if (round < WARMUP) continue;
        const into = samples[variant.name];
        into.mount.push(mounted);
        into.one.push(one);
        into.many.push(many);
        if (drain !== null) into.drain.push(drain);
        if (full !== null) into.full.push(full);
        into.bindings = juris.devtools?.live.size ?? null;
    }
}
const results = Object.fromEntries(Object.entries(samples).map(([name, s]) => [name, { mount: median(s.mount), one: median(s.one), many: median(s.many), drain: s.drain.length ? median(s.drain) : null, full: s.full.length ? median(s.full) : null, bindings: s.bindings }]));

// Memory: what the page holds with the feature, beyond devMode without it, per live binding.
const heldBy = (options) => {
    gc();
    const before = process.memoryUsage().heapUsed;
    const kept = page(options);
    kept.mount();
    gc();
    const after = process.memoryUsage().heapUsed;
    return { bytes: after - before, kept };
};
const perBinding = [];
for (let run = 0; run < 7; run += 1) {
    const plain = heldBy({ devMode: true });
    const featured = heldBy({ devMode: true, features: { devtools: Devtools } });
    perBinding.push((featured.bytes - plain.bytes) / featured.kept.juris.devtools.live.size);
}

const base = results["devMode on"];
const percent = (value, of) => ` (${value >= of ? "+" : ""}${(((value - of) / of) * 100).toFixed(0)}%)`;
const against = (name, value, of) => (name.startsWith("feature") ? percent(value, of) : "");
console.log(`devtools.js overhead, ${new Date().toISOString().slice(0, 10)}, Node ${process.versions.node}: ${ROWS} rows (${ROWS} component instances), ${results["feature, no connection"].bindings} bindings; medians of ${ROUNDS} rounds after ${WARMUP} of warm-up`);
console.log("");
console.log("| | mount (creates every binding) | a pass waking 1 binding | a pass waking 500 | a drain: one pass waking 500 | a drain: 1 MiB |");
console.log("| --- | --- | --- | --- | --- | --- |");
for (const [name, { mount, one, many, drain, full }] of Object.entries(results)) {
    console.log(`| ${name} | ${mount.toFixed(2)} ms${against(name, mount, base.mount)} | ${one.toFixed(2)} µs${against(name, one, base.one)} | ${many.toFixed(1)} µs${against(name, many, base.many)} | ${drain === null ? "" : `${drain.toFixed(2)} ms`} | ${full === null ? "" : `${full.toFixed(2)} ms`} |`);
}
console.log("");
console.log(`Memory per live binding, the feature's beyond devMode without it: ${Math.round(median(perBinding))} bytes (median of ${perBinding.length}${globalThis.gc ? "" : "; run with --expose-gc for a figure to trust"})`);
console.log("Percentages are against devMode on without the feature, the budget's baseline.");
