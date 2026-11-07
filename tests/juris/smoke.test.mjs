// The wiring, held by a test: the juris package resolves from ../juris, and a server-side instance builds.
import { test } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";

test("juris: an instance on a server builds with its defaults", () => {
    assert.equal(new Juris({ isServer: true }).allowInnerHTML, false);
});
