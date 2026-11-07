// The wiring, held by a test: the juris-kit package resolves from ../juris-kit, and its document renders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDocument } from "juris-kit/server/document.js";

test("juris-kit: a document renders with its entry script", () => {
    const page = renderDocument({ html: "", json: "{}" }, { entry: "/app.js" });
    assert.match(page, /<script type="module">/);
});
