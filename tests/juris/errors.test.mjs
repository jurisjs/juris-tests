// errors.js (REFERENCE.md, "errors.js"): FallbackSignal, the ServiceError a service refuses with and
// fail() that throws one, and the rule (defaultExposeError, mayExpose, publicMessage) that decides
// whether a caller may read a failure's words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FallbackSignal, ServiceError, fail, defaultExposeError, mayExpose, publicMessage } from "juris/errors.js";
import { FallbackSignal as FallbackFromCore } from "juris/juris.js";

// ---- FallbackSignal --------------------------------------------------------------------------

test("a FallbackSignal carries its boundary, its layout and the error that caused it", () => {
    const boundary = { name: "Panel" };
    const layout = { p: "Something went wrong" };
    const cause = new Error("boom");
    const signal = new FallbackSignal(boundary, layout, cause);
    assert.ok(signal instanceof Error);
    assert.equal(signal.message, 'Juris: fallback for "Panel"');
    assert.equal(signal.boundary, boundary);
    assert.equal(signal.layout, layout);
    assert.equal(signal.cause, cause);
});

test("the core re-exports the one FallbackSignal class, so instanceof holds across modules", () => {
    assert.equal(FallbackFromCore, FallbackSignal);
});

// ---- ServiceError ----------------------------------------------------------------------------

test("a ServiceError is exposed, named, and answers 400 unless told otherwise", () => {
    const error = new ServiceError("Give the post a title.");
    assert.ok(error instanceof Error);
    assert.equal(error.name, "ServiceError");
    assert.equal(error.message, "Give the post a title.");
    assert.equal(error.status, 400);
    assert.equal(error.expose, true);
});

test("a ServiceError has fields, field and code only when they are given", () => {
    const error = new ServiceError("No.");
    assert.equal(Object.hasOwn(error, "fields"), false);
    assert.equal(Object.hasOwn(error, "field"), false);
    assert.equal(Object.hasOwn(error, "code"), false);
});

test("a ServiceError keeps the status and code it is given", () => {
    const error = new ServiceError("Not yours.", { status: 403, code: "post.forbidden" });
    assert.equal(error.status, 403);
    assert.equal(error.code, "post.forbidden");
});

test("a ServiceError keeps a code it is given even when that code is null", () => {
    const error = new ServiceError("No.", { code: null });
    assert.equal(Object.hasOwn(error, "code"), true);
    assert.equal(error.code, null);
});

test("a ServiceError keeps the fields it is given when no singular field is named", () => {
    const fields = { title: "Required.", body: "Too short." };
    const error = new ServiceError("Fix the form.", { fields });
    assert.deepEqual(error.fields, { title: "Required.", body: "Too short." });
    assert.equal(Object.hasOwn(error, "field"), false);
});

test("a singular field is kept as given and folded into fields with the error's message", () => {
    const error = new ServiceError("Give the post a title.", { field: "title" });
    assert.equal(error.field, "title");
    assert.deepEqual(error.fields, { title: "Give the post a title." });
});

test("a singular field is added beside the fields given, which are not changed", () => {
    const fields = { body: "Too short." };
    const error = new ServiceError("Give the post a title.", { field: "title", fields });
    assert.deepEqual(error.fields, { body: "Too short.", title: "Give the post a title." });
    assert.deepEqual(fields, { body: "Too short." }, "the caller's object is left alone");
});

test("a singular field keeps what fields already says for it", () => {
    const error = new ServiceError("Fix the form.", { field: "title", fields: { title: "Shorter, please." } });
    assert.equal(error.field, "title");
    assert.deepEqual(error.fields, { title: "Shorter, please." });
});

test("a fields entry that says nothing (null) for the named field takes the error's message", () => {
    const error = new ServiceError("Give the post a title.", { field: "title", fields: { title: null } });
    assert.deepEqual(error.fields, { title: "Give the post a title." });
});

test("an inherited name on fields does not count as saying something for the field", () => {
    const fields = Object.create({ title: "inherited" });
    const error = new ServiceError("Give the post a title.", { field: "title", fields });
    assert.deepEqual(error.fields, { title: "Give the post a title." });
});

test("an empty or null field names nothing", () => {
    for (const field of ["", null]) {
        const error = new ServiceError("No.", { field });
        assert.equal(Object.hasOwn(error, "field"), false, `field ${JSON.stringify(field)}`);
        assert.equal(Object.hasOwn(error, "fields"), false, `field ${JSON.stringify(field)}`);
    }
});

test("a field named by a number is a name like any other", () => {
    const error = new ServiceError("Row 0 is wrong.", { field: 0 });
    assert.equal(error.field, 0);
    assert.deepEqual(error.fields, { 0: "Row 0 is wrong." });
});

// ---- fail --------------------------------------------------------------------------------------

test("fail throws a ServiceError with the message and options it is given", () => {
    assert.throws(
        () => fail("Give the post a title.", { field: "title", status: 422, code: "post.title" }),
        (error) => {
            assert.ok(error instanceof ServiceError);
            assert.equal(error.message, "Give the post a title.");
            assert.equal(error.status, 422);
            assert.equal(error.code, "post.title");
            assert.deepEqual(error.fields, { title: "Give the post a title." });
            return true;
        },
    );
});

test("fail with no options throws a plain 400 refusal", () => {
    assert.throws(() => fail("No."), (error) => error instanceof ServiceError && error.status === 400 && error.expose === true);
});

// ---- defaultExposeError, mayExpose, publicMessage -----------------------------------------------

test("the default rule exposes only an error that says expose === true", () => {
    assert.equal(defaultExposeError(new ServiceError("ok")), true);
    assert.equal(defaultExposeError(Object.assign(new Error("x"), { expose: true })), true);
    assert.equal(defaultExposeError(new Error("relation \"users\" does not exist")), false);
    assert.equal(defaultExposeError(Object.assign(new Error("x"), { expose: "true" })), false);
    assert.equal(defaultExposeError(Object.assign(new Error("x"), { expose: 1 })), false);
    assert.equal(defaultExposeError(null), false);
    assert.equal(defaultExposeError(undefined), false);
});

test("mayExpose uses the default rule when given none", () => {
    assert.equal(mayExpose(new ServiceError("ok")), true);
    assert.equal(mayExpose(new Error("driver words")), false);
});

test("mayExpose says yes only when the rule answers exactly true", () => {
    const error = new Error("x");
    assert.equal(mayExpose(error, () => true), true);
    for (const answer of [1, "yes", {}, false, undefined, null]) {
        assert.equal(mayExpose(error, () => answer), false, `a rule answering ${String(answer)}`);
    }
});

test("mayExpose hands the rule the error it is judging", () => {
    const seen = [];
    const error = new Error("x");
    mayExpose(error, (e) => { seen.push(e); return true; });
    assert.deepEqual(seen, [error]);
});

test("a rule that throws says no", () => {
    assert.equal(mayExpose(new ServiceError("ok"), () => { throw new Error("rule bug"); }), false);
});

test("publicMessage gives an exposed error's message and hides any other", () => {
    assert.equal(publicMessage(new ServiceError("Give the post a title.")), "Give the post a title.");
    assert.equal(publicMessage(new Error('duplicate key value violates unique constraint "users_email_key"')), "request failed");
});

test("publicMessage takes the app's rule and its own fallback", () => {
    const error = new Error("visible");
    assert.equal(publicMessage(error, () => true), "visible");
    assert.equal(publicMessage(error, () => false, "Something went wrong."), "Something went wrong.");
});

test("publicMessage reads a thrown value that is not an Error as its words when the rule allows", () => {
    assert.equal(publicMessage("plain words", () => true), "plain words");
    assert.equal(publicMessage(42, () => true), "42");
});

test("publicMessage falls back when the rule throws", () => {
    assert.equal(publicMessage(new ServiceError("ok"), () => { throw new Error("rule bug"); }), "request failed");
});
