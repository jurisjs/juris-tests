// html-safety.js on its own: every refusal both renderers share (attribute names, tags, innerHTML,
// classList keys, style keys and values, URL schemes, srcdoc), the opt-in lists an app builds
// (allowTags, allowSchemes) and what each check answers, reasons included. Held to REFERENCE.md's
// "html-safety.js" and "Safe by default", and to the module's own comments.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
    safeAttributeName,
    allowedTags,
    safeTagName,
    checkTag,
    reusableElement,
    checkInnerHTML,
    classTokens,
    checkStyle,
    allowedSchemes,
    safeUrl,
    checkAttribute,
} from "juris/html-safety.js";

// The refused tags, as REFERENCE.md lists them (SVG's animation elements in the case SVG spells them).
const REFUSED = [
    "script", "iframe", "frame", "frameset", "object", "embed", "applet", "portal",
    "base", "meta", "link", "set", "animate", "animateMotion", "animateTransform", "plaintext", "style",
];

const URL_ATTRIBUTES = ["href", "src", "action", "formaction", "xlink:href", "poster", "cite", "data"];

// ---- attribute names -------------------------------------------------------------------------

test("safeAttributeName takes names of letters, digits, '-', '_', ':' and '.'", () => {
    for (const name of ["class", "id", "data-user-id", "aria-label", "xlink:href", "xml:lang", "_private", ":colon", "a.b", "x1", "viewBox"]) {
        assert.equal(safeAttributeName(name), true, name);
    }
});

test("safeAttributeName refuses an empty name, a leading digit, dash or dot, and any other character", () => {
    for (const name of ["", "1x", "-x", ".x", "x y", "x=y", 'x"', "x'", "x>", "x/", "x\n", "xé", "x onmouseover=alert(1)"]) {
        assert.equal(safeAttributeName(name), false, JSON.stringify(name));
    }
});

test("safeAttributeName refuses what is not a string", () => {
    for (const name of [undefined, null, 1, true, {}, ["href"], Symbol("href")]) {
        assert.equal(safeAttributeName(name), false, String(name?.toString?.() ?? name));
    }
});

test("safeAttributeName refuses every name that starts with 'on', in any case", () => {
    for (const name of ["onclick", "onerror", "ONLOAD", "OnMouseOver", "on", "on-x"]) {
        assert.equal(safeAttributeName(name), false, name);
    }
    // "on" only at the start: a name that merely contains it is a name.
    assert.equal(safeAttributeName("data-on"), true);
    assert.equal(safeAttributeName("button"), true);
});

// ---- allowTags --------------------------------------------------------------------------------

test("allowedTags of nothing is an empty set", () => {
    const tags = allowedTags(undefined);
    assert.ok(tags instanceof Set);
    assert.equal(tags.size, 0);
    assert.equal(allowedTags().size, 0);
});

test("allowedTags lower-cases each name once, and keeps each once", () => {
    assert.deepEqual([...allowedTags(["IFRAME", "my-widget", "Script", "iframe", "h1"])], ["iframe", "my-widget", "script", "h1"]);
    assert.deepEqual([...allowedTags([])], []);
});

test("allowedTags refuses a value that is not a list", () => {
    for (const list of [null, "script", { 0: "script" }, new Set(["script"]), 1]) {
        assert.throws(() => allowedTags(list), { name: "TypeError", message: 'Juris: allowTags is a list of tags\' names ("iframe", "my-widget")' });
    }
});

test("allowedTags refuses an entry that is not a tag's name, never cleaning it up", () => {
    for (const entry of ["", "1h", "-x", "my widget", "img src=x", "<script>", "x_y", "x:y", "script\u0000"]) {
        assert.throws(() => allowedTags(["div", entry]), {
            name: "TypeError",
            message: `Juris: allowTags: ${JSON.stringify(entry)} is not a tag's name (a letter, then letters, digits or "-")`,
        }, JSON.stringify(entry));
    }
});

test("allowedTags names an entry that is not a string by its text", () => {
    assert.throws(() => allowedTags([42]), { name: "TypeError", message: 'Juris: allowTags: 42 is not a tag\'s name (a letter, then letters, digits or "-")' });
    assert.throws(() => allowedTags([null]), { name: "TypeError", message: /^Juris: allowTags: null is not a tag's name/ });
    assert.throws(() => allowedTags([undefined]), { name: "TypeError", message: /^Juris: allowTags: undefined is not a tag's name/ });
});

// ---- tag names --------------------------------------------------------------------------------

test("safeTagName takes HTML, SVG, MathML and custom elements' names", () => {
    for (const tag of ["div", "DIV", "h1", "svg", "foreignObject", "math", "annotation-xml", "my-widget", "x-1", "Home"]) {
        assert.equal(safeTagName(tag), true, tag);
    }
});

test("safeTagName refuses a name that is not a tag: data that reached a child position", () => {
    for (const tag of ["", "1div", "-x", "img src=x onerror=alert(1)", "div>", "<div", "a:b", "a_b", "a.b", "dïv", "div\n"]) {
        assert.equal(safeTagName(tag), false, JSON.stringify(tag));
    }
    for (const tag of [undefined, null, 1, {}, ["div"]]) assert.equal(safeTagName(tag), false, String(tag));
});

test("safeTagName refuses every tag that runs code, loads a document or reaches the whole page, in any case", () => {
    for (const tag of REFUSED) {
        assert.equal(safeTagName(tag), false, tag);
        assert.equal(safeTagName(tag.toUpperCase()), false, tag.toUpperCase());
        assert.equal(safeTagName(tag.toLowerCase()), false, tag.toLowerCase());
    }
});

test("safeTagName opens a refused tag only when the allowed set names it", () => {
    const allowed = allowedTags(["iframe", "Style"]);
    assert.equal(safeTagName("iframe", allowed), true);
    assert.equal(safeTagName("IFrame", allowed), true);
    assert.equal(safeTagName("style", allowed), true);
    assert.equal(safeTagName("script", allowed), false);
    assert.equal(safeTagName("script", null), false);
    assert.equal(safeTagName("script", new Set()), false);
    // An allowed set opens refused tags; it never lets a malformed name through.
    assert.equal(safeTagName("img src=x", new Set(["img src=x"])), false);
});

test("checkTag answers ok for a tag both renderers draw", () => {
    assert.deepEqual(checkTag("div"), { ok: true });
    assert.deepEqual(checkTag("my-widget", null), { ok: true });
    assert.deepEqual(checkTag("iframe", new Set(["iframe"])), { ok: true });
});

test("checkTag says a malformed name is a value from data, quoting at most 60 characters of it", () => {
    assert.deepEqual(checkTag("img src=x onerror=alert(1)"), {
        ok: false,
        reason: 'tag name "img src=x onerror=alert(1)" is not a tag: a value from data reached a child position',
    });
    const long = `x ${"y".repeat(200)}`;
    const { ok, reason } = checkTag(long);
    assert.equal(ok, false);
    assert.equal(reason, `tag name ${JSON.stringify(long).slice(0, 60)} is not a tag: a value from data reached a child position`);
    assert.deepEqual(checkTag(undefined), { ok: false, reason: 'tag name "undefined" is not a tag: a value from data reached a child position' });
    assert.deepEqual(checkTag(7), { ok: false, reason: 'tag name "7" is not a tag: a value from data reached a child position' });
});

test("checkTag says how to open a refused tag, naming it in lower case", () => {
    assert.deepEqual(checkTag("script"), { ok: false, reason: '<script> is not allowed in a layout (pass allowTags: ["script"] if it really is wanted)' });
    assert.deepEqual(checkTag("IFRAME", new Set(["object"])), { ok: false, reason: '<IFRAME> is not allowed in a layout (pass allowTags: ["iframe"] if it really is wanted)' });
});

test("reusableElement takes an element of the same tag, in any case, that the renderers would draw", () => {
    assert.equal(reusableElement("div", "div"), true);
    assert.equal(reusableElement("DIV", "div"), true);
    assert.equal(reusableElement("foreignobject", "foreignObject"), true);
    assert.equal(reusableElement("span", "div"), false);
    assert.equal(reusableElement("iframe", "iframe"), false);
    assert.equal(reusableElement("iframe", "iframe", new Set(["iframe"])), true);
    assert.equal(reusableElement("style", "style", null), false);
});

test("reusableElement refuses a tag that is not a string, whatever the element is", () => {
    assert.equal(reusableElement("div", undefined), false);
    assert.equal(reusableElement("null", null), false);
    assert.equal(reusableElement("1", 1), false);
    assert.equal(reusableElement(undefined, "div"), false);
});

// ---- innerHTML, classes -----------------------------------------------------------------------

test("checkInnerHTML opens markup only for allowed === true", () => {
    assert.deepEqual(checkInnerHTML(true), { ok: true });
    for (const allowed of [false, undefined, null, "true", 1, {}, [true]]) {
        assert.deepEqual(checkInnerHTML(allowed), {
            ok: false,
            reason: "innerHTML: markup is not written from a layout (use textContent, or pass allowInnerHTML: true to Juris for the app's own markup)",
        }, String(allowed));
    }
    assert.deepEqual(checkInnerHTML(), checkInnerHTML(false));
});

test("classTokens splits a classList key on ASCII whitespace and skips empty tokens", () => {
    assert.deepEqual(classTokens("btn"), ["btn"]);
    assert.deepEqual(classTokens("btn active"), ["btn", "active"]);
    assert.deepEqual(classTokens(" \ta\nb\fc\rd  e "), ["a", "b", "c", "d", "e"]);
    assert.deepEqual(classTokens(""), []);
    assert.deepEqual(classTokens(" \t\n "), []);
});

test("classTokens leaves whitespace that is not ASCII inside the token, as the DOM does", () => {
    assert.deepEqual(classTokens("a b"), ["a b"]);
    assert.deepEqual(classTokens("a b c"), ["a b", "c"]);
    assert.deepEqual(classTokens("a\vb"), ["a\vb"]);
});

test("classTokens reads a key that is not a string as its text", () => {
    assert.deepEqual(classTokens(42), ["42"]);
    assert.deepEqual(classTokens(null), ["null"]);
});

// ---- styles -----------------------------------------------------------------------------------

test("checkStyle turns a camelCase key into its CSS name", () => {
    assert.deepEqual(checkStyle("color", "red"), { ok: true, name: "color" });
    assert.deepEqual(checkStyle("marginTop", "1px"), { ok: true, name: "margin-top" });
    assert.deepEqual(checkStyle("borderTopLeftRadius", 4), { ok: true, name: "border-top-left-radius" });
    assert.deepEqual(checkStyle("zIndex", 0), { ok: true, name: "z-index" });
    assert.deepEqual(checkStyle("float", "left"), { ok: true, name: "float" });
});

test("checkStyle leads a vendor prefix with '-', msTransform's lower-case one too, and reads cssFloat as float", () => {
    assert.deepEqual(checkStyle("WebkitTransform", "none"), { ok: true, name: "-webkit-transform" });
    assert.deepEqual(checkStyle("MozAppearance", "none"), { ok: true, name: "-moz-appearance" });
    assert.deepEqual(checkStyle("msTransform", "none"), { ok: true, name: "-ms-transform" });
    assert.deepEqual(checkStyle("MsTransform", "none"), { ok: true, name: "-ms-transform" });
    assert.deepEqual(checkStyle("cssFloat", "left"), { ok: true, name: "float" });
});

// CSSOM's webkit-cased attributes: style.webkitTransform, in lower case, is -webkit-transform, as
// style.WebkitTransform is, in a browser; and nothing else in lower case is a vendor prefix.
test("checkStyle leads webkit's lower-case prefix with '-', as the DOM's style object reads it", () => {
    assert.deepEqual(checkStyle("webkitTransform", "none"), { ok: true, name: "-webkit-transform" });
    assert.deepEqual(checkStyle("webkitUserSelect", "none"), { ok: true, name: "-webkit-user-select" });
    assert.deepEqual(checkStyle("webkit", "none"), { ok: true, name: "webkit" });
    assert.deepEqual(checkStyle("mozAppearance", "none"), { ok: true, name: "moz-appearance" });
});

test("checkStyle keeps a custom property's name as written", () => {
    assert.deepEqual(checkStyle("--accent", "#f00"), { ok: true, name: "--accent" });
    assert.deepEqual(checkStyle("--Main_color-2", "blue"), { ok: true, name: "--Main_color-2" });
});

test("checkStyle refuses a key that is no property, quoting at most 40 characters of it", () => {
    const keys = ["", "margin-top", "color;", "color:red", "a b", "1x", "-x", "--", "--a b", "--a;b", "--a:b", "xé"];
    for (const key of keys) {
        assert.deepEqual(checkStyle(key, "red"), { ok: false, reason: `style key ${JSON.stringify(key).slice(0, 40)} is not a property (a camelCase name, or --custom)` }, JSON.stringify(key));
    }
    const long = `a;${"b".repeat(80)}`;
    assert.equal(checkStyle(long, "red").reason, `style key ${JSON.stringify(long).slice(0, 40)} is not a property (a camelCase name, or --custom)`);
});

test("checkStyle refuses cssText and the names of CSSStyleDeclaration's own members", () => {
    for (const key of ["cssText", "length", "parentRule", "item", "getPropertyValue", "getPropertyPriority", "setProperty", "removeProperty"]) {
        const result = checkStyle(key, "x");
        assert.equal(result.ok, false, key);
        assert.equal(result.name, undefined, key);
        assert.match(result.reason, new RegExp(`^style key "${key}" is not a property`));
    }
});

test("checkStyle refuses a key that is not a string", () => {
    assert.deepEqual(checkStyle(1, "red"), { ok: false, reason: 'style key "1" is not a property (a camelCase name, or --custom)' });
    assert.deepEqual(checkStyle(undefined, "red"), { ok: false, reason: 'style key "undefined" is not a property (a camelCase name, or --custom)' });
    assert.equal(checkStyle(null, "red").ok, false);
});

test("checkStyle reads null, undefined and the empty string as a removal, never refused", () => {
    for (const value of [null, undefined, ""]) {
        assert.deepEqual(checkStyle("marginTop", value), { ok: true, name: "margin-top" }, String(value));
        assert.deepEqual(checkStyle("--accent", value), { ok: true, name: "--accent" }, String(value));
    }
});

test("checkStyle takes a string or a number that is one value", () => {
    for (const value of ["1px solid red", "rgb(0, 0, 0)", "16/9", "calc(100% - 2px)", "'Helvetica Neue', sans-serif", "url(a.png)", 0, 1.5, -2]) {
        assert.deepEqual(checkStyle("border", value), { ok: true, name: "border" }, String(value));
    }
});

test("checkStyle refuses a value that would end its declaration, open a block, escape, hide or comment", () => {
    const refused = ["red;background:url(//elsewhere)", "red}", "{", "a<b", "\\3b", "red\n", "red\r", "red\t", "a\u0000", "a\u001f", "a\u007f", "red /* x", "/*"];
    for (const value of refused) {
        const result = checkStyle("color", value);
        assert.equal(result.ok, false, JSON.stringify(value));
        assert.equal(result.name, "color", JSON.stringify(value));
        assert.equal(result.reason, `style color refuses ${JSON.stringify(value).slice(0, 40)}: not a single value`);
    }
});

test("checkStyle refuses a value that is not a string or a number, naming its type, and gives the name still", () => {
    for (const [value, type] of [[true, "boolean"], [{}, "object"], [[1], "object"], [() => "red", "function"], [10n, "bigint"]]) {
        assert.deepEqual(checkStyle("marginTop", value), { ok: false, name: "margin-top", reason: `style marginTop refuses ${JSON.stringify(type)}: not a single value` }, type);
    }
});

test("checkStyle quotes at most 40 characters of a refused value", () => {
    const value = `red;${"x".repeat(100)}`;
    assert.equal(checkStyle("color", value).reason, `style color refuses ${JSON.stringify(value).slice(0, 40)}: not a single value`);
});

test("checkStyle holds a custom property's value to the same rule", () => {
    assert.deepEqual(checkStyle("--accent", "red;x:y"), { ok: false, name: "--accent", reason: 'style --accent refuses "red;x:y": not a single value' });
});

// ---- allowSchemes -----------------------------------------------------------------------------

test("allowedSchemes of nothing is an empty set", () => {
    const schemes = allowedSchemes(undefined);
    assert.ok(schemes instanceof Set);
    assert.equal(schemes.size, 0);
    assert.equal(allowedSchemes().size, 0);
});

test("allowedSchemes lower-cases each name once", () => {
    assert.deepEqual([...allowedSchemes(["Magnet", "web+app", "x-y.z", "MAGNET", "irc6"])], ["magnet", "web+app", "x-y.z", "irc6"]);
});

test("allowedSchemes refuses a value that is not a list", () => {
    for (const list of [null, "magnet", { 0: "magnet" }, new Set(["magnet"])]) {
        assert.throws(() => allowedSchemes(list), {
            name: "TypeError",
            message: 'Juris: allowSchemes is a list of URL schemes\' names ("magnet", "web+app"), without the colon',
        });
    }
});

test("allowedSchemes refuses an entry that is not a scheme's name, a colon included", () => {
    for (const entry of ["", "magnet:", "1abc", "+x", "a b", "a/b", "sçheme", "java\tscript"]) {
        assert.throws(() => allowedSchemes([entry]), {
            name: "TypeError",
            message: `Juris: allowSchemes: ${JSON.stringify(entry)} is not a scheme's name (a letter, then letters, digits, "+", "-" or "."; no colon)`,
        }, JSON.stringify(entry));
    }
    assert.throws(() => allowedSchemes([7]), { name: "TypeError", message: /^Juris: allowSchemes: 7 is not a scheme's name/ });
    assert.throws(() => allowedSchemes([null]), { name: "TypeError", message: /^Juris: allowSchemes: null is not a scheme's name/ });
});

test("allowedSchemes refuses data, in any case: it keeps its own rule, an image only", () => {
    for (const entry of ["data", "DATA", "Data"]) {
        assert.throws(() => allowedSchemes(["magnet", entry]), { name: "TypeError", message: "Juris: allowSchemes: data: is allowed for an image only, and no option widens it" });
    }
});

test("allowedSchemes refuses javascript and vbscript, in any case", () => {
    for (const [entry, scheme] of [["javascript", "javascript"], ["JavaScript", "javascript"], ["VBScript", "vbscript"]]) {
        assert.throws(() => allowedSchemes([entry]), { name: "TypeError", message: `Juris: allowSchemes: ${scheme}: runs code in the page, and is never allowed` });
    }
});

// ---- URLs -------------------------------------------------------------------------------------

test("safeUrl takes nothing at all", () => {
    assert.equal(safeUrl(""), true);
    assert.equal(safeUrl("   "), true);
    assert.equal(safeUrl("\t\n\u0000"), true);
});

test("safeUrl takes a relative URL and a fragment, a colon after a path, query or fragment separator included", () => {
    for (const url of ["/a/b", "a/b", "./x", "../x", "page.html", "?q=1", "#top", "/a:b", "a/b:c", "?next=javascript:alert(1)", "#javascript:x", "//cdn.example/x.js", "no-colon-at-all"]) {
        assert.equal(safeUrl(url), true, url);
    }
});

test("safeUrl takes http, https, mailto, tel, sms, geo and ftp, in any case", () => {
    for (const url of ["http://a", "https://a/b?c#d", "mailto:a@b", "tel:+1", "sms:+1", "geo:1,2", "ftp://a", "HTTPS://A", "MailTo:a@b"]) {
        assert.equal(safeUrl(url), true, url);
    }
});

test("safeUrl refuses javascript: and vbscript:, however the value spells them", () => {
    const spellings = [
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        "  javascript:alert(1)",
        "java\tscript:alert(1)",
        "java\nscript:alert(1)",
        "java\rscript:alert(1)",
        "\u0001javascript:alert(1)",
        "java\u0000script:alert(1)",
        "java\u007fscript:alert(1)",
        "java\u0085script:alert(1)",
        "java\u009fscript:alert(1)",
        "﻿javascript:alert(1)",
        "java script:alert(1)",
        "java script:alert(1)",
        "javascript :alert(1)",
        "vbscript:msgbox(1)",
        "VBScript:msgbox(1)",
    ];
    for (const url of spellings) assert.equal(safeUrl(url), false, JSON.stringify(url));
});

test("safeUrl takes data: for an image only", () => {
    for (const url of [
        "data:image/png;base64,AAAA",
        "data:image/jpeg;base64,AAAA",
        "data:image/jpg;base64,AAAA",
        "data:image/gif;base64,AAAA",
        "data:image/webp;base64,AAAA",
        "data:image/avif;base64,AAAA",
        "data:image/svg+xml;utf8,<svg/>",
        // An inline SVG written the usual way, with no parameter before its data.
        "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'/%3E",
        "data:image/svg+xml,<svg/>",
        "DATA:IMAGE/PNG;base64,AAAA",
        " data:image/png;base64,AAAA",
    ]) {
        assert.equal(safeUrl(url), true, url);
    }
    for (const url of ["data:text/html,<script>alert(1)</script>", "data:text/html;base64,PHNjcmlwdD4=", "data:image/bmp;base64,AAAA", "data:application/javascript,alert(1)", "data:,x", "data:image/pngx;base64,AA",
        // A type and no data: neither a parameter nor the comma that starts the data.
        "data:image/svg+xml", "data:image/svg+xmlx,<svg/>"]) {
        assert.equal(safeUrl(url), false, url);
    }
});

test("safeUrl refuses any other scheme unless the app added it", () => {
    assert.equal(safeUrl("magnet:?xt=urn:x"), false);
    assert.equal(safeUrl("web+app:open"), false);
    assert.equal(safeUrl("file:///etc/passwd"), false);
    const added = allowedSchemes(["magnet", "web+app"]);
    assert.equal(safeUrl("magnet:?xt=urn:x", added), true);
    assert.equal(safeUrl("MAGNET:?xt=urn:x", added), true);
    assert.equal(safeUrl("web+app:open", added), true);
    assert.equal(safeUrl("file:///etc/passwd", added), false);
    assert.equal(safeUrl("magnet:x", null), false);
});

test("safeUrl refuses javascript:, vbscript: and data: for a document whatever set it is given", () => {
    const handedIn = new Set(["javascript", "vbscript", "data"]);
    assert.equal(safeUrl("javascript:alert(1)", handedIn), false);
    assert.equal(safeUrl("vbscript:x", handedIn), false);
    assert.equal(safeUrl("data:text/html,<script>alert(1)</script>", handedIn), false);
});

test("safeUrl reads a value that is not a string as its text", () => {
    assert.equal(safeUrl(42), true);
    assert.equal(safeUrl(null), true);
    assert.equal(safeUrl({ toString: () => "javascript:alert(1)" }), false);
    assert.equal(safeUrl({ toString: () => "https://a" }), true);
});

// ---- attributes -------------------------------------------------------------------------------

test("checkAttribute takes an ordinary attribute whatever its value", () => {
    assert.deepEqual(checkAttribute("title", "javascript:alert(1)"), { ok: true });
    assert.deepEqual(checkAttribute("data-x", "<script>"), { ok: true });
    assert.deepEqual(checkAttribute("aria-label", null), { ok: true });
});

test("checkAttribute refuses a name that is not allowed, quoting it", () => {
    assert.deepEqual(checkAttribute("x onmouseover", "1"), { ok: false, reason: 'attribute name "x onmouseover" is not allowed' });
    assert.deepEqual(checkAttribute("onclick", "alert(1)"), { ok: false, reason: 'attribute name "onclick" is not allowed' });
    assert.deepEqual(checkAttribute("ONERROR", "x"), { ok: false, reason: 'attribute name "ONERROR" is not allowed' });
    assert.deepEqual(checkAttribute(undefined, "x"), { ok: false, reason: 'attribute name "undefined" is not allowed' });
    assert.deepEqual(checkAttribute("", "x"), { ok: false, reason: 'attribute name "" is not allowed' });
});

test("checkAttribute refuses srcdoc outright, in any case, whatever its value and schemes", () => {
    for (const name of ["srcdoc", "SrcDoc", "SRCDOC"]) {
        assert.deepEqual(checkAttribute(name, "<p>hi</p>", allowedSchemes(["magnet"])), { ok: false, reason: `${name} takes a document, not a value, and is never written from a layout` });
        assert.equal(checkAttribute(name, null).ok, false);
        assert.equal(checkAttribute(name, "").ok, false);
    }
});

test("checkAttribute holds every URL attribute to the scheme rules, in any case", () => {
    for (const name of [...URL_ATTRIBUTES, "HREF", "XLink:Href", "FormAction"]) {
        assert.deepEqual(checkAttribute(name, "javascript:alert(1)"), { ok: false, reason: `${name} refuses "javascript:alert(1)": scheme not allowed` }, name);
        assert.deepEqual(checkAttribute(name, "https://example.com/"), { ok: true }, name);
        assert.deepEqual(checkAttribute(name, "/relative"), { ok: true }, name);
    }
    assert.equal(checkAttribute("src", "data:image/png;base64,AA").ok, true);
    assert.equal(checkAttribute("data", "data:text/html,<p>").ok, false);
});

test("checkAttribute quotes at most 40 characters of a refused URL", () => {
    const value = `javascript:${"a".repeat(100)}`;
    assert.deepEqual(checkAttribute("href", value), { ok: false, reason: `href refuses "${value.slice(0, 40)}": scheme not allowed` });
});

test("checkAttribute lets a URL attribute of null or undefined through, there being nothing to write", () => {
    assert.deepEqual(checkAttribute("href", null), { ok: true });
    assert.deepEqual(checkAttribute("src", undefined), { ok: true });
});

test("checkAttribute opens an added scheme in a URL attribute's value, and no attribute", () => {
    const schemes = allowedSchemes(["magnet"]);
    assert.deepEqual(checkAttribute("href", "magnet:?xt=1"), { ok: false, reason: 'href refuses "magnet:?xt=1": scheme not allowed' });
    assert.deepEqual(checkAttribute("href", "magnet:?xt=1", schemes), { ok: true });
    assert.equal(checkAttribute("onclick", "magnet:x", schemes).ok, false);
    assert.equal(checkAttribute("href", "javascript:x", schemes).ok, false);
});
