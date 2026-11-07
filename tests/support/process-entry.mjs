// An app's entry, as tests/juris-kit/process.test.mjs runs it in a child process: startProcess on
// Node's own cluster and console, at the top level, as an entry calls it. The mode is argv[2]:
//   refuse-throw   two workers beside live queries, no exit: the refusal is thrown at the top level
//   refuse-exit    the same with the entry's own exit (process.exit)
//   cluster        two workers, no live queries: each worker reports its env through IPC, the first
//                  crashes once (exit code 3) and is replaced; the primary prints what it saw on exit
import cluster from "node:cluster";
import { startProcess } from "juris-kit/server/process.js";

const mode = process.argv[2];

if (mode === "refuse-throw") {
    startProcess({ workers: 2 });
    console.log("still running");
} else if (mode === "refuse-exit") {
    startProcess({ workers: 2, exit: (code) => process.exit(code) });
    console.log("still running");
} else if (mode === "cluster") {
    const role = startProcess({
        workers: 2,
        liveQueries: false,
        env: { JT_BUILD: "b7" },
        workerIdEnv: "JT_WORKER",
        backoff: { minMs: 20, maxMs: 40, resetAfterMs: 60_000 },
    });
    if (role === "primary") {
        // A guard, should the workers keep failing: the primary would replace them for ever.
        setTimeout(() => process.exit(9), 5000).unref();
        const seen = [];
        let exits = 0;
        cluster.on("message", (worker, message) => seen.push(message));
        cluster.on("exit", (worker, code) => { exits++; if (exits >= 6) process.exit(8); });
        process.on("exit", () => console.log(JSON.stringify({ role, isPrimary: cluster.isPrimary, seen })));
    } else {
        const id = process.env.JT_WORKER;
        process.send({ role, id, build: process.env.JT_BUILD, isWorker: cluster.isWorker }, () => process.exit(id === "1" ? 3 : 0));
    }
} else {
    throw new Error(`process-entry: unknown mode ${mode}`);
}
