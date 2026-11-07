// forms.js: the plugin and createForm, the state a form keeps under its path (values, touched,
// errors, valid, dirty, submitted, submitting, error, serverErrors), field() and props() for the
// elements, error(), and submit() with its service, its refusals, double clicks, reset() and dispose().
import { test } from "node:test";
import assert from "node:assert/strict";
import Juris from "juris/juris.js";
import formsDefault, { forms, createForm } from "juris/forms.js";
import { ServiceError } from "juris/errors.js";
import { withSSR } from "../support/ssr-renderer.mjs";
import { installDom, Element, HTML } from "../support/dom-renderer-dom.mjs";

const browser = (config = {}) => new Juris({ isServer: false, ...config });
const raw = (juris, path) => juris.toRaw(juris.peek(path));

// A promise and the means to settle it.
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

// Lets the promise reactions queued so far run (no timer).
async function settle(turns = 10) {
    for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

// Collects console.error's calls for the length of `fn`, and puts console.error back after.
async function capturingErrors(fn) {
    const said = [];
    const original = console.error;
    console.error = (...args) => said.push(args);
    try {
        await fn();
    } finally {
        console.error = original;
    }
    return said;
}

const required = (message) => (value) => (value ? null : message);

// A sign-in form on a fresh instance.
function signIn(options = {}, juris = browser()) {
    const form = createForm(juris, "signin", {
        fields: { email: "", password: "", remember: false },
        validate: { email: required("Give your email"), password: required("Give a password") },
        ...options,
    });
    return { juris, form };
}

// ---- the plugin and the state --------------------------------------------------------------------

test("forms() installs api.form, the default export, making the same form as createForm", () => {
    assert.equal(formsDefault, forms);
    const juris = browser();
    juris.use(forms());
    assert.equal(typeof juris.api.form, "function");
    const form = juris.api.form("contact", { fields: { name: "Ann" } });
    assert.equal(form.path, "contact");
    assert.deepEqual(form.values(), { name: "Ann" });
    for (const name of ["values", "set", "touch", "reset", "error", "field", "props", "submit", "dispose"]) assert.equal(typeof form[name], "function", name);
});

test("createForm writes the form's state under its path", () => {
    const { juris } = signIn();
    assert.deepEqual(raw(juris, "signin"), {
        values: { email: "", password: "", remember: false },
        touched: {},
        submitted: false,
        submitting: false,
        error: null,
        serverErrors: {},
        errors: { email: "Give your email", password: "Give a password", remember: null },
        valid: false,
        dirty: false,
    });
});

test("createForm copies the initial values: the caller's fields object is never the form's state", () => {
    const fields = { name: "Ann" };
    const juris = browser();
    const form = createForm(juris, "f", { fields });
    form.set("name", "Bo");
    assert.deepEqual(fields, { name: "Ann" });
    form.reset();
    assert.equal(juris.peek("f.values.name"), "Ann");
});

test("createForm with no options is an empty form, valid and clean", async () => {
    const juris = browser();
    const form = createForm(juris, "empty");
    assert.deepEqual(form.values(), {});
    assert.equal(juris.peek("empty.valid"), true);
    assert.equal(juris.peek("empty.dirty"), false);
    assert.deepEqual(await form.submit(), {}, "no service: the values");
});

test("a form on a path that already has one takes over its state", () => {
    const juris = browser();
    const first = createForm(juris, "f", { fields: { name: "" } });
    first.set("name", "kept");
    first.touch("name");
    first.dispose();
    const second = createForm(juris, "f", { fields: { name: "" }, validate: { name: required("Name?") } });
    assert.deepEqual(second.values(), { name: "kept" });
    assert.equal(juris.peek("f.touched.name"), true);
    assert.equal(juris.peek("f.dirty"), true, "kept differs from the initial value");
    assert.equal(juris.peek("f.valid"), true);
});

// Two forms live on one path would be one form typed into from both, with two sets of rules
// computing its errors, valid and dirty: the second is refused, in words that name the form, where
// the state manager's "is already computed" named a computed path the app never wrote.
const formTaken = (path) => `Juris form "${path}": a form is live on this path already; dispose it first`
    + " (a component's form goes with the component), or give this form a path of its own";

test("a second form on a path whose form is still live is refused, naming the path, and the first is untouched", () => {
    const juris = browser();
    const first = createForm(juris, "order", { fields: { sku: "" }, validate: { sku: required("Which item?") } });
    first.set("sku", "milk");
    for (const options of [{ fields: { sku: "" } }, { fields: { qty: 1 } }, undefined]) {
        assert.throws(() => createForm(juris, "order", options), { message: formTaken("order") });
    }
    assert.deepEqual(first.values(), { sku: "milk" }, "the refusal wrote nothing");
    first.set("sku", "");
    assert.equal(juris.peek("order.errors.sku"), "Which item?", "the first form's rules still compute");
    assert.equal(juris.peek("order.valid"), false);
    first.dispose();
    assert.equal(createForm(juris, "order", { fields: { sku: "" } }).path, "order", "once disposed, the path is free");
});

test("two components drawing a form on one path at once are refused with the form's words", () => {
    const juris = new Juris(withSSR({ isServer: true }));
    juris.use(forms());
    juris.registerComponent("Newsletter", (props, api) => {
        const form = api.form("newsletter", { fields: { email: "" } });
        return { input: form.field("email") };
    });
    const page = { div: { children: [{ Newsletter: {} }, { Newsletter: {} }] } };
    assert.throws(() => juris.renderToString(page), { message: formTaken("newsletter") });
    assert.equal(
        juris.renderToString({ Newsletter: {} }),
        '<input name="email" value="">',
        "the failed render's instances were cleaned up, its form with them",
    );
});

test("values() answers an empty object once the form's state is gone", () => {
    const juris = browser();
    const form = createForm(juris, "f", { fields: { a: 1 } });
    juris.deleteState("f.values");
    assert.deepEqual(form.values(), {});
});

// ---- validation ------------------------------------------------------------------------------------

test("errors: a rule's message per field; null, undefined and an empty string are no error", () => {
    const juris = browser();
    createForm(juris, "f", {
        fields: { a: "", b: "", c: "", d: "", e: "", f: "" },
        validate: { a: () => "bad", b: () => null, c: () => undefined, d: () => "", e: "not a rule" },
    });
    assert.deepEqual(raw(juris, "f.errors"), { a: "bad", b: null, c: null, d: null, e: null, f: null });
    assert.equal(juris.peek("f.valid"), false);
});

test("errors: a rule is given the field's value and every value", () => {
    const seen = [];
    const juris = browser();
    const form = createForm(juris, "f", { fields: { a: 1, b: 2 }, validate: { a: (value, values) => void seen.push([value, { ...values }]) } });
    form.set("b", 3);
    assert.deepEqual(seen, [[1, { a: 1, b: 2 }], [1, { a: 1, b: 3 }]]);
});

test("errors: a rule that reads two fields wakes when either changes", () => {
    const juris = browser();
    const form = createForm(juris, "f", {
        fields: { password: "", confirm: "" },
        validate: { confirm: (value, values) => (value === values.password ? null : "They differ") },
    });
    assert.equal(juris.peek("f.errors.confirm"), null);
    form.set("password", "secret");
    assert.equal(juris.peek("f.errors.confirm"), "They differ");
    form.set("confirm", "secret");
    assert.equal(juris.peek("f.errors.confirm"), null);
    assert.equal(juris.peek("f.valid"), true);
});

test("valid follows every field's error, and dirty any value that differs from its initial one", () => {
    const { juris, form } = signIn();
    form.set("email", "ann@example.com");
    assert.equal(juris.peek("signin.valid"), false);
    assert.equal(juris.peek("signin.dirty"), true);
    form.set("password", "pw");
    assert.equal(juris.peek("signin.valid"), true);
    form.set("email", "");
    form.set("password", "");
    assert.equal(juris.peek("signin.dirty"), false, "back to the initial values");
    form.set("remember", 0);
    assert.equal(juris.peek("signin.dirty"), true, "0 is not false");
});

test(
    "dirty is false for a form nobody changed, whatever its fields hold",
    () => {
        const juris = browser();
        createForm(juris, "f", { fields: { tags: ["a"], address: { city: "x" } } });
        assert.equal(juris.peek("f.dirty"), false);
    },
);

test(
    "reset() restores a list field's initial value after an item of it was written",
    () => {
        const juris = browser();
        const fields = { tags: ["a"] };
        const form = createForm(juris, "f", { fields });
        juris.setValue("f.values.tags.0", "b");
        form.reset();
        assert.deepEqual(juris.toRaw(juris.peek("f.values.tags")), ["a"]);
        assert.deepEqual(fields, { tags: ["a"] });
    },
);

test("dirty: a list or object field is compared by what it holds, and a write to one item of it wakes dirty", () => {
    const juris = browser();
    const form = createForm(juris, "f", { fields: { tags: ["a"], address: { city: "x" } } });
    juris.setValue("f.values.tags.0", "b");
    assert.equal(juris.peek("f.dirty"), true, "an item written");
    juris.setValue("f.values.tags.0", "a");
    assert.equal(juris.peek("f.dirty"), false, "and written back");
    juris.setValue("f.values.tags.1", "b");
    assert.equal(juris.peek("f.dirty"), true, "an item added");
    form.set("tags", ["a"]);
    assert.equal(juris.peek("f.dirty"), false, "a new list holding the same");
    form.set("tags", { 0: "a" });
    assert.equal(juris.peek("f.dirty"), true, "an object is no list");
    form.set("tags", ["a"]);
    juris.setValue("f.values.address.town", "x");
    assert.equal(juris.peek("f.dirty"), true, "a key added");
    form.set("address", { town: "x" });
    assert.equal(juris.peek("f.dirty"), true, "a key in place of another");
    form.set("address", ["x"]);
    assert.equal(juris.peek("f.dirty"), true, "a list is no object");
    form.set("address", null);
    assert.equal(juris.peek("f.dirty"), true, "nothing is no object");
});

test("a value that is neither a list nor a plain object is kept as given, not copied into a plain one", () => {
    const juris = browser();
    const when = new Date(0);
    const form = createForm(juris, "f", { fields: { when } });
    assert.equal(raw(juris, "f.values.when"), when);
    assert.equal(juris.peek("f.dirty"), false);
    form.set("when", new Date(1));
    assert.equal(juris.peek("f.dirty"), true);
    form.reset();
    assert.equal(raw(juris, "f.values.when"), when);
    assert.equal(juris.peek("f.dirty"), false);
});

// ---- set, touch and error ------------------------------------------------------------------------------

test("set() writes one value and touch() marks one field", () => {
    const { juris, form } = signIn();
    form.set("email", "a@b");
    form.touch("email");
    assert.deepEqual(form.values(), { email: "a@b", password: "", remember: false });
    assert.deepEqual(raw(juris, "signin.touched"), { email: true });
});

test("error(name): the rule's message once the field is touched, or for every field after a submit", async () => {
    const { form } = signIn();
    assert.equal(form.error("email"), null, "not shown before the user has been there");
    form.touch("email");
    assert.equal(form.error("email"), "Give your email");
    assert.equal(form.error("password"), null);
    await form.submit();
    assert.equal(form.error("password"), "Give a password");
    assert.equal(form.error("remember"), null);
    assert.equal(form.error("nosuchfield"), null);
});

test("error(name) is tracked, so a binding follows it", () => {
    const { juris, form } = signIn();
    const seen = [];
    juris.bindState(() => form.error("email"), (message) => seen.push(message));
    form.touch("email");
    form.set("email", "a@b");
    form.set("email", "");
    assert.deepEqual(seen, [null, "Give your email", null, "Give your email"]);
});

// ---- field() and props() ----------------------------------------------------------------------------

test("field(): an input's props, its value following the state, input writing it and blur touching it", () => {
    const { juris, form } = signIn();
    const props = form.field("email", { type: "email", placeholder: "you@example.com", autocomplete: "email" });
    assert.equal(props.name, "email");
    assert.equal(props.type, "email");
    assert.equal(props.placeholder, "you@example.com");
    assert.equal(props.autocomplete, "email");
    assert.equal(props.value(), "");
    props.oninput({ target: { value: "ann@example.com" } });
    assert.equal(juris.peek("signin.values.email"), "ann@example.com");
    assert.equal(props.value(), "ann@example.com");
    assert.equal(juris.peek("signin.touched.email"), undefined);
    props.onblur({});
    assert.equal(juris.peek("signin.touched.email"), true);
    assert.equal("checked" in props, false);
    form.set("email", null);
    assert.equal(props.value(), "", "null reads as empty");
    assert.equal(form.field("unknown").value(), "", "nor does a field the form has no value for");
});

// A radio stands for one value of the field: its `value` is its own, and the field's value says which
// radio of the group is checked. It used to be drawn as a text input, its value overwritten by the
// field's, so every radio of a group held the same value and none was ever checked.
const planForm = (plan = "pro") => {
    const juris = browser();
    return { juris, form: createForm(juris, "signup", { fields: { plan } }) };
};

test("field(): a radio keeps its own value, and is checked when the field holds it", () => {
    const { juris, form } = planForm();
    const free = form.field("plan", { type: "radio", value: "free" });
    const pro = form.field("plan", { type: "radio", value: "pro" });
    assert.equal(free.name, "plan");
    assert.equal(free.type, "radio");
    assert.equal(free.value, "free");
    assert.equal(pro.value, "pro");
    assert.equal(free.checked(), false);
    assert.equal(pro.checked(), true);
    assert.equal("oninput" in free, false);
    juris.setValue("signup.values.plan", "free");
    assert.equal(free.checked(), true);
    assert.equal(pro.checked(), false);
});

test("field(): change on a radio writes the radio's value, and its own onchange runs after", () => {
    const { juris, form } = planForm();
    const seen = [];
    const free = form.field("plan", {
        type: "radio",
        value: "free",
        onchange: (event) => seen.push([event.id, juris.peek("signup.values.plan")]),
    });
    free.onchange({ id: 1, target: { value: "free" } });
    assert.equal(juris.peek("signup.values.plan"), "free");
    assert.deepEqual(seen, [[1, "free"]]);
    assert.equal(juris.peek("signup.dirty"), true);
    form.reset();
    assert.equal(free.checked(), false, "reset goes back to the radio that was checked");
});

test("field(): a radio's number stays a number in the form, and matches a field that holds it as text", () => {
    const juris = browser();
    const form = createForm(juris, "order", { fields: { size: 2, copies: "1" } });
    const size = form.field("size", { type: "radio", value: 2 });
    const larger = form.field("size", { type: "radio", value: 3 });
    assert.equal(size.checked(), true);
    larger.onchange({ target: { value: "3" } });
    assert.equal(larger.checked(), true);
    assert.equal(form.values().size, 3, "the value the radio was given, not the attribute's text");
    assert.equal(form.field("copies", { type: "radio", value: 1 }).checked(), true);
});

test("field(): a radio whose value is a function reads it where it is used, as any value function", () => {
    const { juris, form } = planForm();
    juris.setValue("offer", "pro");
    const radio = form.field("plan", { type: "radio", value: () => juris.getState("offer") });
    assert.equal(radio.checked(), true);
    juris.setValue("offer", "team");
    assert.equal(radio.checked(), false);
    radio.onchange({ target: { value: "team" } });
    assert.equal(juris.peek("signup.values.plan"), "team");
});

test("field(): a radio for no value at all is checked while the field is empty, whatever empty is", () => {
    const juris = browser();
    const form = createForm(juris, "f", { fields: { plan: null } });
    const none = form.field("plan", { type: "radio", value: "" });
    const pro = form.field("plan", { type: "radio", value: "pro" });
    assert.equal(none.checked(), true);
    assert.equal(pro.checked(), false);
});

test("field(): a radio given no value is the browser's: \"on\"", () => {
    const { juris, form } = planForm("");
    const radio = form.field("plan", { type: "radio" });
    assert.equal(radio.checked(), false);
    radio.onchange({ target: { value: "on" } });
    assert.equal(juris.peek("signup.values.plan"), "on");
    assert.equal(radio.checked(), true);
});

test("field(): a radio's other handlers stay its own, and blur still touches the field", () => {
    const { juris, form } = planForm();
    const seen = [];
    const free = form.field("plan", { type: "radio", value: "free", oninput: () => seen.push("input") });
    free.oninput();
    free.onblur();
    assert.deepEqual(seen, ["input"]);
    assert.equal(juris.peek("signup.touched.plan"), true);
});

test("field(): the group, drawn: each radio keeps its value, and only the field's is checked", () => {
    const dom = installDom();
    try {
        const { juris, form } = planForm();
        const target = dom.document.body.appendChild(new Element("div", HTML));
        const div = juris.render(target, {
            div: {
                children: [
                    { input: form.field("plan", { type: "radio", value: "free" }) },
                    { input: form.field("plan", { type: "radio", value: "pro" }) },
                ],
            },
        });
        const [free, pro] = div.childNodes;
        assert.deepEqual([free.value, pro.value], ["free", "pro"]);
        assert.deepEqual([free.checked, pro.checked], [false, true]);
        form.set("plan", "free");
        assert.deepEqual([free.checked, pro.checked], [true, false]);
    } finally {
        dom.restore();
    }
});

test("field(): the group, on the server: each radio's value, and checked on the field's", () => {
    const juris = new Juris(withSSR({ isServer: true }));
    const form = createForm(juris, "signup", { fields: { plan: "pro" } });
    const html = juris.renderToString({
        div: {
            children: [
                { input: form.field("plan", { type: "radio", value: "free" }) },
                { input: form.field("plan", { type: "radio", value: "pro" }) },
            ],
        },
    });
    assert.equal(
        html,
        '<div><input name="plan" type="radio" value="free">'
            + '<input name="plan" type="radio" checked="" value="pro"></div>',
    );
    form.dispose();
});

test("field(): a checkbox is checked from the state, and change writes it", () => {
    const { juris, form } = signIn();
    const props = form.field("remember", { type: "checkbox" });
    assert.equal(props.type, "checkbox");
    assert.equal(props.checked(), false);
    assert.equal("value" in props, false);
    assert.equal("oninput" in props, false);
    props.onchange({ target: { checked: true } });
    assert.equal(juris.peek("signin.values.remember"), true);
    assert.equal(props.checked(), true);
    form.set("remember", "yes");
    assert.equal(props.checked(), true, "checked is a boolean");
    props.onblur({});
    assert.equal(juris.peek("signin.touched.remember"), true);
});

test("field(): the caller's own onblur, oninput and onchange run after the form's, never instead", () => {
    const { juris, form } = signIn();
    const order = [];
    const input = form.field("email", {
        onblur: (event) => order.push(["blur", event.id, juris.peek("signin.touched.email")]),
        oninput: (event) => order.push(["input", event.id, juris.peek("signin.values.email")]),
        onchange: () => order.push(["never on a text input"]),
    });
    input.oninput({ id: 1, target: { value: "x" } });
    input.onblur({ id: 2 });
    const box = form.field("remember", { type: "checkbox", onchange: (event) => order.push(["change", event.id, juris.peek("signin.values.remember")]) });
    box.onchange({ id: 3, target: { checked: true } });
    assert.deepEqual(order, [["input", 1, "x"], ["blur", 2, true], ["change", 3, true]], "the form's write is done when theirs runs");
    assert.equal(typeof input.onchange, "function", "a text input keeps the caller's onchange as given");
});

test("props(): novalidate and method post, the caller's merged in, and an onsubmit that keeps the browser from submitting", async () => {
    const { form, juris } = signIn();
    const props = form.props({ id: "signin-form", class: "card" });
    assert.equal(props.novalidate, true);
    assert.equal(props.method, "post", "a native submit must never put the fields in the URL");
    assert.equal(props.id, "signin-form");
    assert.equal(props.class, "card");
    let prevented = 0;
    const done = props.onsubmit({ preventDefault: () => (prevented += 1) });
    assert.equal(prevented, 1);
    assert.equal(typeof done.then, "function", "the submit it starts");
    assert.equal(await done, undefined, "invalid, so nothing sent");
    assert.equal(juris.peek("signin.submitted"), true);
    assert.equal(form.props({ method: "dialog" }).method, "dialog", "the caller may say otherwise");
    assert.equal(await form.props().onsubmit(), undefined, "no event, no failure");
    assert.equal(await form.props().onsubmit({}), undefined, "an event without preventDefault too");
});

// ---- submit ------------------------------------------------------------------------------------------

test("submit: an invalid form is not sent, every error shows, and it resolves undefined", async () => {
    let calls = 0;
    const { juris, form } = signIn({ submit: async () => void (calls += 1) });
    assert.equal(await form.submit(), undefined);
    assert.equal(calls, 0);
    assert.equal(juris.peek("signin.submitted"), true);
    assert.equal(juris.peek("signin.submitting"), false);
    assert.equal(form.error("email"), "Give your email");
});

test("submit: a function service is given the values and the form, and the submit resolves with its result", async () => {
    const gate = deferred();
    const given = [];
    const succeeded = [];
    const { juris, form } = signIn({
        submit: (values, f) => (given.push([values, f]), gate.promise),
        onSuccess: (result, f) => succeeded.push([result, f]),
        onError: () => assert.fail("no error"),
    });
    form.set("email", "ann@example.com");
    form.set("password", "pw");
    const done = form.submit();
    await settle();
    assert.deepEqual(given, [[{ email: "ann@example.com", password: "pw", remember: false }, form]]);
    assert.equal(juris.peek("signin.submitting"), true);
    gate.resolve({ id: 7 });
    assert.deepEqual(await done, { id: 7 });
    assert.deepEqual(succeeded, [[{ id: 7 }, form]]);
    assert.equal(juris.peek("signin.submitting"), false);
    assert.equal(juris.peek("signin.error"), null);
});

test("submit: a service named by a string is called through the instance with the values", async () => {
    const calls = [];
    const juris = browser({ services: { signIn: async (values) => (calls.push(values), { token: "t" }) } });
    const { form } = signIn({ submit: "signIn" }, juris);
    form.set("email", "a@b");
    form.set("password", "pw");
    assert.deepEqual(await form.submit(), { token: "t" });
    assert.deepEqual(calls, [{ email: "a@b", password: "pw", remember: false }]);
});

test("submit: a service the instance does not have is the submit's error", async () => {
    const errors = [];
    const { juris, form } = signIn({ fields: { a: "" }, validate: {}, submit: "missing", onError: (error) => errors.push(error) });
    assert.equal(await form.submit(), undefined);
    assert.equal(juris.peek("signin.error"), 'Juris.call: unknown service "missing"');
    assert.equal(errors.length, 1);
    assert.equal(juris.peek("signin.submitting"), false);
});

test("submit: without a service it resolves with the values once they are valid", async () => {
    const { juris, form } = signIn({ submit: undefined });
    form.set("email", "a@b");
    form.set("password", "pw");
    assert.deepEqual(await form.submit(), { email: "a@b", password: "pw", remember: false });
    assert.equal(juris.peek("signin.submitting"), false);
    const { form: numbered } = signIn({ submit: 42 }, browser());
    numbered.set("email", "a@b");
    numbered.set("password", "pw");
    assert.deepEqual(await numbered.submit(), { email: "a@b", password: "pw", remember: false }, "nor with a submit that is no service");
});

test("submit: a call made while the service has not answered is ignored, and resolves undefined at once", async () => {
    const gate = deferred();
    let calls = 0;
    const { juris, form } = signIn({ fields: { a: "" }, validate: {}, submit: () => (calls += 1, gate.promise) });
    const first = form.submit();
    await settle();
    juris.setValue("signin.error", "left alone");
    const second = form.submit();
    let answered = false;
    second.then(() => (answered = true));
    await settle(1);
    assert.equal(answered, true, "at once");
    assert.equal(await second, undefined);
    assert.equal(juris.peek("signin.error"), "left alone", "the ignored call changed nothing");
    assert.equal(calls, 1);
    gate.resolve("done");
    assert.equal(await first, "done");
    await form.submit();
    assert.equal(calls, 2, "once it answered, the form submits again");
});

test("submit: the form on the same path that comes next refuses to submit while the last one's submit waits", async () => {
    let calls = 0;
    const juris = browser();
    const first = createForm(juris, "f", { fields: { a: "" }, submit: () => (calls += 1, new Promise(() => { })) });
    first.submit();
    await settle();
    first.dispose();
    const second = createForm(juris, "f", { fields: { a: "" }, submit: () => (calls += 1, "second") });
    assert.equal(await second.submit(), undefined);
    assert.equal(calls, 1);
});

test("submit: a refusal's message goes to error, onError hears it, and the submit resolves undefined", async () => {
    const heard = [];
    const refusal = new Error("Wrong password");
    const { juris, form } = signIn({ submit: async () => { throw refusal; }, onError: (error, f) => heard.push([error, f]), onSuccess: () => assert.fail("not a success") });
    form.set("email", "a@b");
    form.set("password", "pw");
    assert.equal(await form.submit(), undefined);
    assert.equal(juris.peek("signin.error"), "Wrong password");
    assert.equal(juris.peek("signin.submitting"), false);
    assert.deepEqual(heard, [[refusal, form]]);
});

test("submit: a refusal that is not an Error is its own message", async () => {
    for (const [thrown, said] of [["plain words", "plain words"], [404, "404"], [null, "null"], [{ message: "an object's" }, "an object's"]]) {
        const { juris, form } = signIn({ fields: { a: "" }, validate: {}, submit: () => Promise.reject(thrown) });
        await form.submit();
        assert.equal(juris.peek("signin.error"), said, String(thrown));
        assert.deepEqual(raw(juris, "signin.serverErrors"), {});
    }
});

test("submit: a refusal's fields go to serverErrors, keeping only string messages under names a path can address", async () => {
    const fields = JSON.parse('{"email": "Taken", "a.b": "dotted", "count": 3, "__proto__": "proto", "password": "Too short"}');
    const { juris, form } = signIn({ submit: async () => { throw new ServiceError("Check the form", { fields }); } });
    form.set("email", "a@b");
    form.set("password", "pw");
    await form.submit();
    assert.deepEqual(raw(juris, "signin.serverErrors"), { email: "Taken", password: "Too short" });
    assert.equal(Object.getPrototypeOf(raw(juris, "signin.serverErrors")), Object.prototype);
    assert.equal(juris.peek("signin.error"), "Check the form");
    assert.equal(form.error("email"), "Taken", "no rule message to show, so the server's");
    const single = signIn({ submit: async () => { throw new ServiceError("Give the post a title.", { field: "email" }); } });
    single.form.set("email", "a@b");
    single.form.set("password", "pw");
    await single.form.submit();
    assert.deepEqual(raw(single.juris, "signin.serverErrors"), { email: "Give the post a title." });
});

test("submit: fields that are not an object are no field messages", async () => {
    for (const fields of ["email", 5, null]) {
        const { juris, form } = signIn({ fields: { a: "" }, validate: {}, submit: async () => { throw Object.assign(new Error("No"), { fields }); } });
        await form.submit();
        assert.deepEqual(raw(juris, "signin.serverErrors"), {}, String(fields));
    }
});

test("error(name): the rule's message wins over the server's while it has one to show", async () => {
    const juris = browser();
    const form = createForm(juris, "f", {
        fields: { name: "x", code: "c" },
        validate: { code: (value, values) => (values.name === "bad" ? "Not with that name" : null) },
        submit: async () => { throw new ServiceError("No", { fields: { name: "Name taken", code: "Code taken" } }); },
    });
    await form.submit();
    assert.equal(form.error("name"), "Name taken");
    assert.equal(form.error("code"), "Code taken");
    form.set("name", "bad");
    assert.equal(form.error("code"), "Not with that name", "the rule's, though the server's is still there");
    assert.equal(juris.peek("f.serverErrors.code"), "Code taken");
    form.set("name", "good");
    assert.equal(form.error("code"), "Code taken", "the rule has nothing to say again, so the server's");
});

test("set(): a field's change clears the server's word on it, and only on it", async () => {
    const { juris, form } = signIn({ submit: async () => { throw new ServiceError("No", { fields: { email: "Taken", password: "Weak" } }); } });
    form.set("email", "a@b");
    form.set("password", "pw");
    await form.submit();
    const input = form.field("email");
    input.oninput({ target: { value: "b@c" } });
    assert.deepEqual(raw(juris, "signin.serverErrors"), { password: "Weak" });
    assert.equal(form.error("email"), null);
    assert.equal(form.error("password"), "Weak");
    form.set("remember", true);
    assert.deepEqual(raw(juris, "signin.serverErrors"), { password: "Weak" }, "a field the server said nothing of");
});

test("submit: each submit clears serverErrors and error as it starts, even one the rules stop", async () => {
    let refuse = true;
    const { juris, form } = signIn({ submit: async () => { if (refuse) throw new ServiceError("No", { fields: { email: "Taken" } }); return "ok"; } });
    form.set("email", "a@b");
    form.set("password", "pw");
    await form.submit();
    assert.deepEqual(raw(juris, "signin.serverErrors"), { email: "Taken" });
    juris.setValue("signin.values.password", "");
    assert.equal(await form.submit(), undefined);
    assert.deepEqual(raw(juris, "signin.serverErrors"), {}, "stopped by the rules: none left");
    assert.equal(juris.peek("signin.error"), null);
    juris.setValue("signin.values.password", "pw");
    await form.submit();
    refuse = false;
    assert.equal(await form.submit(), "ok");
    assert.deepEqual(raw(juris, "signin.serverErrors"), {}, "a success leaves none");
    assert.equal(juris.peek("signin.error"), null);
});

test("onSuccess throwing goes to the console; the submit stays a success", async () => {
    let errors = 0;
    const failure = new Error("onSuccess broke");
    const { juris, form } = signIn({ fields: { a: "" }, validate: {}, submit: async () => ({ id: 1 }), onSuccess: () => { throw failure; }, onError: () => (errors += 1) });
    let result;
    const said = await capturingErrors(async () => { result = await form.submit(); });
    assert.deepEqual(result, { id: 1 });
    assert.equal(juris.peek("signin.error"), null);
    assert.equal(juris.peek("signin.submitting"), false);
    assert.equal(errors, 0);
    assert.deepEqual(said, [['Juris form "signin": onSuccess failed after the submit succeeded', failure]]);
});

test("onSuccess rejecting goes to the console too; one that resolves says nothing", async () => {
    const failure = new Error("later");
    const { juris, form } = signIn({ fields: { a: "" }, validate: {}, submit: async () => 1, onSuccess: async () => { throw failure; } });
    const said = await capturingErrors(async () => {
        assert.equal(await form.submit(), 1);
        await settle();
    });
    assert.equal(juris.peek("signin.error"), null);
    assert.deepEqual(said, [['Juris form "signin": onSuccess failed after the submit succeeded', failure]]);
    const quiet = signIn({ fields: { a: "" }, validate: {}, submit: async () => 2, onSuccess: async () => "fine" });
    const none = await capturingErrors(async () => {
        assert.equal(await quiet.form.submit(), 2);
        await settle();
    });
    assert.deepEqual(none, []);
});

// ---- reset and dispose ----------------------------------------------------------------------------------

test("reset() starts the form over, submitting included", async () => {
    let calls = 0;
    const { juris, form } = signIn({ submit: () => (calls += 1, new Promise(() => { })) });
    form.set("email", "a@b");
    form.set("password", "pw");
    form.touch("email");
    form.submit();
    await settle();
    juris.setValue("signin.error", "something");
    juris.setValue("signin.serverErrors.email", "x");
    assert.equal(juris.peek("signin.submitting"), true);
    form.reset();
    assert.deepEqual(raw(juris, "signin"), {
        values: { email: "", password: "", remember: false },
        touched: {},
        submitted: false,
        submitting: false,
        error: null,
        serverErrors: {},
        errors: { email: "Give your email", password: "Give a password", remember: null },
        valid: false,
        dirty: false,
    });
    form.set("email", "a@b");
    form.set("password", "pw");
    form.submit();
    await settle();
    assert.equal(calls, 2, "a hung submit no longer refuses the next");
});

test("reset(): a submit made before it answers into nothing, but onSuccess is still told", async () => {
    const answers = [];
    const told = [];
    const juris = browser();
    const form = createForm(juris, "f", { fields: {}, submit: () => new Promise((resolve) => answers.push(resolve)), onSuccess: (result) => told.push(result) });
    const first = form.submit();
    await settle();
    form.reset();
    const second = form.submit();
    await settle();
    answers[0]("old");
    assert.equal(await first, "old");
    assert.deepEqual(told, ["old"]);
    assert.equal(juris.peek("f.submitting"), true, "the newer submit is still waiting");
    answers[1]("new");
    assert.equal(await second, "new");
    assert.equal(juris.peek("f.submitting"), false);
});

test("reset(): a refusal of a submit made before it leaves the form alone, but onError is still told", async () => {
    const answers = [];
    const told = [];
    const juris = browser();
    const form = createForm(juris, "f", { fields: {}, submit: () => new Promise((_, reject) => answers.push(reject)), onError: (error) => told.push(error.message) });
    const first = form.submit();
    await settle();
    form.reset();
    answers[0](new ServiceError("the old one failed", { fields: { a: "x" } }));
    assert.equal(await first, undefined);
    assert.deepEqual(told, ["the old one failed"]);
    assert.equal(juris.peek("f.error"), null);
    assert.deepEqual(raw(juris, "f.serverErrors"), {});
    assert.equal(juris.peek("f.submitting"), false);
});

test("dispose(): the form's computeds stop following its values", () => {
    const { juris, form } = signIn();
    form.dispose();
    form.set("email", "a@b");
    form.set("password", "pw");
    assert.equal(juris.peek("signin.errors.email"), "Give your email");
    assert.equal(juris.peek("signin.valid"), false);
    assert.equal(juris.peek("signin.dirty"), false);
    assert.doesNotThrow(() => form.dispose(), "a second dispose is no failure");
});

test("api.form in a component definition: the form ends with the instance", () => {
    const juris = new Juris(withSSR({ isServer: true }));
    juris.use(forms());
    juris.registerComponent("SignIn", (props, api) => {
        const form = api.form("signin", { fields: { email: "" }, validate: { email: required("Email?") } });
        return { form: { ...form.props(), children: [{ input: form.field("email", { type: "email" }) }] } };
    });
    const html = juris.renderToString({ SignIn: {} });
    assert.match(html, /^<form [^>]*method="post"[^>]*>/);
    assert.match(html, /<input name="email" type="email" value="">/);
    juris.setValue("signin.values.email", "a@b");
    assert.equal(juris.peek("signin.errors.email"), "Email?", "the render is over, and its computeds with it");
    assert.doesNotThrow(() => juris.renderToString({ SignIn: {} }), "so the next render makes the form again");
});
