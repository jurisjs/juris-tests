// The kit's minifier (server/minify.js): jsTokens' reading of code (the texts of its tokens are the
// source again, and a `/` is a regex or a division as code reads it), minifyJs (comments and
// whitespace only, never what the code does), and minifyCss (comments, whitespace, and the `;`
// that cannot matter, never inside a string).
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { minifyJs, minifyCss, jsTokens } from "juris-kit/server/minify.js";

// What `code` leaves in `result`, run as a script in a context of its own.
const outcome = (code) => {
    const context = vm.createContext({});
    try {
        vm.runInContext(code, context);
        return { result: JSON.stringify(context.result) };
    } catch (error) {
        return { error: `${error.name}: ${error.message}` };
    }
};

// The minified code does what the code did.
const sameMeaning = (code) => {
    const before = outcome(code);
    assert.ok(!before.error, `the case itself fails: ${before.error}`);
    const minified = minifyJs(code);
    assert.deepEqual(outcome(minified), before, `minified to:\n${minified}`);
};

const joined = (src) => jsTokens(src).map((token) => token.text).join("");
// The tokens that are code (no space, no comment), as "type:text".
const code = (src) => jsTokens(src).filter((t) => t.type !== "space" && t.type !== "comment").map((t) => `${t.type}:${t.text}`);

// ---- jsTokens ---------------------------------------------------------------------------------

test("jsTokens: the texts of the tokens, joined, are the source again", () => {
    const sources = [
        "",
        'import { a } from "./a.js";\nexport const b = `x${a + `y${1}`}z` / 2; // done\n',
        "const re = /[/\\]]+/gi, d = a / b / c; /* block\ncomment */",
        "x = 'it\\'s' + \"q\\\"\" + `t\\`${'}'}`",
        "label: { break label } case 1: default: a ? b : c",
        "café = naïve ?? x?.y ?? z?.5 : 1",
        ") } ] ( [ {",                      // brackets that close nothing, and ones never closed
        "a = /unterminated regex",          // a regex that runs to the end of the source
        "x = /a\\",                          // an escape at the very end
        "`never closed ${ a",               // a substitution never closed
        "`never closed",                    // a template's text never closed
        '"never closed',
        "/* never closed",
        "x?.",
        "a\u00a0b\u2028c\u2029d\r\ne",
    ];
    for (const src of sources) assert.equal(joined(src), src, JSON.stringify(src));
});

test("jsTokens: each token says what it is: space, comment, string, template, regex, word or punct", () => {
    const tokens = jsTokens('a.b = "s" + `t${x}u` + /r/g; // c\n');
    assert.deepEqual(tokens.map(({ type, text }) => [type, text]), [
        ["word", "a"], ["punct", "."], ["word", "b"], ["space", " "], ["punct", "="], ["space", " "],
        ["string", '"s"'], ["space", " "], ["punct", "+"], ["space", " "],
        ["template", "`t${"], ["word", "x"], ["template", "}u`"], ["space", " "], ["punct", "+"], ["space", " "],
        ["regex", "/r/g"], ["punct", ";"], ["space", " "], ["comment", "// c"], ["space", "\n"],
    ]);
    assert.equal(tokens.find((t) => t.text === "b").property, true, "a name after a `.` is a property");
    assert.equal(tokens.find((t) => t.text === "a").property, false);
    assert.equal(tokens.find((t) => t.text === "`t${").open, true, "a template piece that stops at ${ is open");
    assert.equal(tokens.find((t) => t.text === "}u`").open, false);
});

test("jsTokens: a / at the very start of the source begins a regex", () => {
    assert.deepEqual(code("/a  b/.test(s)").slice(0, 2), ["regex:/a  b/", "punct:."]);
});

test("jsTokens: a / inside a regex's character class does not end it, and its flags are part of it", () => {
    assert.deepEqual(code("x = /[/]a/gimsuy.source"), ["word:x", "punct:=", "regex:/[/]a/gimsuy", "punct:.", "word:source"]);
});

test("jsTokens: a / that cannot be a regex on its line is division", () => {
    // `await` is a name in a script outside an async function, but the reader takes it for the
    // keyword and tries a regex after it: none ends on that line, or the line ends in an escape, so
    // it is division, and the string after it is read as a string.
    assert.ok(code('await / 2\nresult = "a  b"').includes('string:"a  b"'));
    assert.ok(code('await / "a\\\nb".length').includes('string:"a\\\nb"'));
    sameMeaning('var await = 8; result = await / 2\n+ "a  b"');
});

test("jsTokens: a name after a single . is a property, and one after a spread's ... is a keyword", () => {
    assert.deepEqual(code("x.return / 2"), ["word:x", "punct:.", "word:return", "punct:/", "word:2"]);
    assert.deepEqual(code("[...typeof /a  b/]"), ["punct:[", "punct:.", "punct:.", "punct:.", "word:typeof", "regex:/a  b/", "punct:]"]);
    assert.equal(jsTokens("x.return").at(-1).property, true);
    assert.equal(jsTokens("[...typeof x]").find((t) => t.text === "typeof").property, false);
});

test("jsTokens: `of` takes a regex after it in a for head, for await included, and is a name elsewhere", () => {
    assert.ok(code("for (const x of /a  b/g.exec(s)) ;").includes("regex:/a  b/g"));
    assert.ok(code("for await (const x of /a  b/g.exec(s)) ;").includes("regex:/a  b/g"));
    assert.deepEqual(code("of / 2 / 3"), ["word:of", "punct:/", "word:2", "punct:/", "word:3"]);
    // The ) of a for await head may be followed by a regex, as a for's is.
    assert.ok(code("for await (const x of y) /a  b/.test(x)").includes("regex:/a  b/"));
});

test("jsTokens: after a template's open ${ a / is a regex; after a closed template, a string or ] it is division", () => {
    assert.ok(code("`a${/x  y/.source}b`").includes("regex:/x  y/"));
    assert.deepEqual(code("`a` / 2 / 3"), ["template:`a`", "punct:/", "word:2", "punct:/", "word:3"]);
    assert.deepEqual(code('"a" / 2 / 3'), ['string:"a"', "punct:/", "word:2", "punct:/", "word:3"]);
    assert.deepEqual(code("a[0] / 2 / 3"), ["word:a", "punct:[", "word:0", "punct:]", "punct:/", "word:2", "punct:/", "word:3"]);
});

test("jsTokens: a postfix ++ or -- ends an expression; a - before another, apart, does not", () => {
    assert.deepEqual(code("i-- / 2 / 3").slice(3), ["punct:/", "word:2", "punct:/", "word:3"]);
    assert.ok(code("1 - -/a  b/.source").includes("regex:/a  b/"));
});

test("jsTokens: a ternary's : is told from a property's and a label's, and ?. and ?? are no ternary", () => {
    const colons = (src) => jsTokens(src).filter((t) => t.text === ":").map((t) => t.colon);
    assert.deepEqual(colons("a ? b : c"), ["ternary"]);
    assert.deepEqual(colons("x = { a: 1 }"), ["property"]);
    assert.deepEqual(colons("lbl: for (;;) break lbl"), ["label"]);
    assert.deepEqual(colons("a?.b ?? c ? d : e"), ["ternary"]);
    assert.deepEqual(colons("a ?.5 : 1"), ["ternary"], "?.5 is a ternary before a number");
    assert.deepEqual(colons("x = { a: b ? c : d }"), ["property", "ternary"]);
});

// ---- minifyJs ---------------------------------------------------------------------------------

test("minifyJs: comments, indentation, trailing whitespace and blank lines go; a run of whitespace is one character", () => {
    assert.equal(minifyJs("const a = 1;   // trailing\n\n\n    const b = 2;   \n\n"), "const a = 1;\nconst b = 2;");
    assert.equal(minifyJs("a /* inline */ + b"), "a + b");
    assert.equal(minifyJs("a\t\t  +    b"), "a + b");
    assert.equal(minifyJs("a /* one\nline more */ b"), "a\nb", "a comment that held a line is a newline");
    assert.equal(minifyJs("a\n// one\n   // two\n\tb"), "a\nb", "a run of lines and comments is one newline");
    assert.equal(minifyJs("a\n   /* x */   b"), "a\nb", "a newline earlier in the run is kept");
});

test("minifyJs: every line terminator JavaScript has is a newline", () => {
    for (const terminator of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
        assert.equal(minifyJs(`a  ${terminator}  b`), "a\nb", JSON.stringify(terminator));
        assert.equal(minifyJs(`a /* x${terminator}y */ b`), "a\nb", JSON.stringify(terminator));
    }
});

test("minifyJs: strings, a template's text and regular expressions pass through untouched", () => {
    const src = "x = \"a  //  b\" + 'c  /* d */' + `e  ${ f  +  g }  h` + /i  j/.source;";
    assert.equal(minifyJs(src), "x = \"a  //  b\" + 'c  /* d */' + `e  ${ f + g }  h` + /i  j/.source;");
});

test("minifyJs: two lines are never joined, so semicolon insertion comes out as written", () => {
    sameMeaning("var a = 1\nvar b = a\n++a\nresult = [a, b]");
    sameMeaning("function f() { return   \n   1 } result = f();");
    sameMeaning("var a = 1, b = 2\n;[a, b] = [b, a]\nresult = [a, b]");
    sameMeaning("var i = 0\ni\n++\ni\nresult = i");
});

test("minifyJs: a regex is kept a regex where code reads one", () => {
    sameMeaning('/a  b/.test("a  b") && (result = 1)');
    sameMeaning('{} /a  b/.test("a  b") && (result = 2)');
    sameMeaning('var f = (s) => /a  b/.test(s); result = f("a  b");');
    sameMeaning('var g = () => {}\n/a  b/.test("a  b") && (result = 3)');
    sameMeaning('var r = [...typeof /a  b/].join(""); result = r;');
    sameMeaning('var r = 0; if (1) {} else {} /a  b/.test("a  b") && r++; result = r;');
    sameMeaning('var r = 0; ;{} /a  b/.test("a  b") && r++; result = r;');
    sameMeaning('var r = 0; { {} /a  b/.test("a  b") && r++; } result = r;');
    sameMeaning('var r = 0; with ({}) /a  b/.test("a  b") && r++; result = r;');
    sameMeaning("var r = 1 - -/a  b/.source.length; result = r;");
    sameMeaning('function* g() { yield /a  b/; } result = g().next().value.source;');
    sameMeaning('var r = `x${ /a  b/.source }y`; result = r;');
});

test("minifyJs: a division is kept a division where code reads one", () => {
    sameMeaning('function f() { return {} / 2 + "a/  b"; } result = f();');
    sameMeaning('var r = false ?.5 : {} / 2 + "a/  b"; result = r;');
    sameMeaning('var i = 4; i-- / 2; result = i-- / 2 + "a/  b";');
    sameMeaning('var a = [4]; result = a[0] / 2 + "a/  b" + a[0] / 4;');
    sameMeaning('var t = `4` / 2 + "a/  b" + `8` / 4; result = t;');
    sameMeaning('var s = "4" / 2 + "a/  b" + "8" / 4; result = s;');
    sameMeaning('var café = 4; result = café / 2 + "a/  b" + café / 4;');
    sameMeaning('var x = { typeof: 4 }; result = x.typeof / 2 + "a/  b" + x.typeof / 4;');
    sameMeaning('var x = /a/g / 2 + "a/  b" + /a/ / 4; result = x;');
    // A { after a > that is not an arrow's opens an object.
    sameMeaning('var a = 1; result = [a > {} / 2, a>{} / 2, a >> {} / 2, "a/  b"];');
});

test("minifyJs: brackets that close nothing do not throw, and what follows is still read", () => {
    assert.equal(minifyJs(")  }  ]  x  =  1"), ") } ] x = 1");
});

test("minifyJs: division right after a function expression's } is division", () => {
    sameMeaning('var f = function () {} / 2 + "a/  b"; result = f;');
    sameMeaning('var c = class {} / 2 + "a/  b"; result = c;');
});

test("minifyJs: an async function expression, and one right after an arrow, is an expression too", () => {
    sameMeaning('var f = async function () {} / 2 + "a/  b"; result = f;');
    sameMeaning('var g = () => function () {} / 2 + "a/  b"; result = g();');
});

test("minifyJs: a function or class declaration ends a statement, so a regex after its } stays a regex", () => {
    sameMeaning('var r = 0; function g() {} /a  b/.test("a  b") && r++; result = r;');
    sameMeaning('var r = 0; async function g() {} /a  b/.test("a  b") && r++; result = r;');
    sameMeaning('var r = 0; class A {} /a  b/.test("a  b") && r++; result = r;');
    // After an expression's end, a statement begins on the next line (ASI).
    sameMeaning('var r = 0, i = 0; i++\nfunction g() {} /a  b/.test("a  b") && r++; result = r;');
    sameMeaning('var r = 0, a = [0]; a[0]\nfunction g() {} /a  b/.test("a  b") && r++; result = r;');
});

test("jsTokens: `export default function` and `export default class` declare, so a / after their } is a regex", () => {
    // A module's code, so read, not run.
    assert.ok(code("export default function () {}\n/a  b/.test(s)").includes("regex:/a  b/"));
    assert.ok(code("export default class {}\n/a  b/.test(s)").includes("regex:/a  b/"));
});

test("minifyJs: a block after a statement that ends in a string is a block, so a regex after it stays a regex", () => {
    sameMeaning('var r = 0; "use strict"\n{}\n/a  b/.test("a  b") && r++; result = r;');
});

test("minifyJs: a block after a statement that ends in ] or a postfix ++ or -- is a block, so a regex after it stays a regex", () => {
    sameMeaning('var r = 0, a = [0]; a[0]\n{}\n/a  b/.test("a  b") && r++; result = r;');
    sameMeaning('var r = 0, i = 0; i++\n{}\n/a  b/.test("a  b") && r++; result = r;');
    sameMeaning('var r = 0, i = 0; i--\n{}\n/a  b/.test("a  b") && r++; result = r;');
    sameMeaning('var r = 0, m = [Object]; class A extends m[0] {} /a  b/.test("a  b") && r++; result = r;');
    // A sign apart from the one before it is no postfix: the { after it is an object.
    sameMeaning('var a = 1; result = [a + +{} / 2 + "a/  b", a - -{} / 2 + "c/  d"];');
});

test("minifyJs: a class expression whose heritage is a function or class written out is an expression too", () => {
    sameMeaning('var c = class extends class {} {} / 2 + "a/  b"; result = c;');
    sameMeaning('var c = class extends function () {} {} / 2 + "a/  b"; result = c;');
    sameMeaning('var c = class extends {}.constructor {} / 2 + "a/  b"; result = c;');
    sameMeaning('var k = "constructor"; var c = class extends {}[k] {} / 2 + "a/  b"; result = c;');
    sameMeaning('var r = 0; class A extends class {} {} /a  b/.test("a  b") && r++; result = r;');
    // An expression begins after `extends`, so a / there begins a regex.
    assert.ok(code("class A extends /a  b/.constructor {}").includes("regex:/a  b/"));
});

test("minifyJs: a { right after a template's ${ opens an object, so a / after its } is division", () => {
    sameMeaning('var t = `${ {} / 2 + "a/  b" }`; result = t;');
});

test("minifyJs: whitespace outside ASCII after a keyword is whitespace, so a regex after it stays a regex", () => {
    sameMeaning('function f() { return\u00a0/a  b/.test("a  b") } result = f();');
    assert.deepEqual(code("typeof\u00a0x"), ["word:typeof", "word:x"]);
});

// ---- minifyCss --------------------------------------------------------------------------------

test("minifyCss: comments go, whitespace collapses, and none is kept around { } ; , >", () => {
    assert.equal(minifyCss("/* head */\n.a  ,\n.b  >  .c  {\n  color: red;\n  margin: 0  auto;\n}\n"), ".a,.b>.c{color:red;margin:0 auto}");
    assert.equal(minifyCss("   .a { }   "), ".a{}", "leading and trailing whitespace is trimmed");
    assert.equal(minifyCss(".a  +  .b ~ .c { }"), ".a + .b ~ .c{}", "a combinator that is not > keeps its spaces");
    assert.equal(minifyCss(".a{}/* never closed"), ".a{}");
});

test("minifyCss: the ; before a } and every ; of a run are dropped", () => {
    assert.equal(minifyCss(".a { b: c; }"), ".a{b:c}");
    assert.equal(minifyCss(".a { b: c;;; d: e;; }"), ".a{b:c;d:e}");
    assert.equal(minifyCss('.a { content: "x;" ; }'), '.a{content:"x;"}');
});

test("minifyCss: a string is passed through as written, its comments, quotes and semicolons included", () => {
    assert.equal(minifyCss('.a { content: "  /* no */  ;}  " }'), '.a{content:"  /* no */  ;}  "}');
    assert.equal(minifyCss(".a { content: 'it\\'s  ;' }"), ".a{content:'it\\'s  ;'}");
    assert.equal(minifyCss('.a{content:"x'), '.a{content:"x', "an unterminated string runs to the end");
});

test("minifyCss: the space before a string is kept after a name and dropped after punctuation", () => {
    assert.equal(minifyCss('@import   "a.css"  screen;'), '@import "a.css" screen;');
    assert.equal(minifyCss('.a { content:   "x" }'), '.a{content:"x"}');
    assert.equal(minifyCss('  "x"'), '"x"', "nothing before it");
});

test("minifyCss: the space before a colon is kept where it was written, and only there", () => {
    assert.equal(minifyCss(".a :hover { color : red }"), ".a :hover{color :red}");
    assert.equal(minifyCss(".a:hover { color: red }"), ".a:hover{color:red}");
});

test("minifyCss: a comment leaves a space only between two characters of a name or a number", () => {
    assert.equal(minifyCss(".a/**/.b{}"), ".a.b{}");
    assert.equal(minifyCss(".a{margin:0/**/auto}"), ".a{margin:0 auto}");
    assert.equal(minifyCss(".é/**/b{}"), ".é b{}", "a letter outside ASCII is part of a name");
    assert.equal(minifyCss("/**/.a{}"), ".a{}", "a comment at the start leaves nothing");
    assert.equal(minifyCss('.a{content:/**/"x"}'), '.a{content:"x"}');
    assert.equal(minifyCss(".a/**/:hover{}"), ".a:hover{}");
});
