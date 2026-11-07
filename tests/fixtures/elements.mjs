// Every element a layout can name: HTML (WHATWG, the living standard), SVG 2 and MathML (Core,
// with MathML 3's presentation elements browsers still parse). Each with what the tests need to
// know of it: whether HTML's serialization has no end tag (void), and whether Juris refuses it
// (html-safety.js REFUSED_TAGS) unless `allowTags` names it.

export const HTML = "http://www.w3.org/1999/xhtml";
export const SVG = "http://www.w3.org/2000/svg";
export const MATHML = "http://www.w3.org/1998/Math/MathML";

// The HTML elements of the living standard.
export const HTML_ELEMENTS = [
    "a", "abbr", "address", "area", "article", "aside", "audio",
    "b", "base", "bdi", "bdo", "blockquote", "body", "br", "button",
    "canvas", "caption", "cite", "code", "col", "colgroup",
    "data", "datalist", "dd", "del", "details", "dfn", "dialog", "div", "dl", "dt",
    "em", "embed",
    "fieldset", "figcaption", "figure", "footer", "form",
    "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr", "html",
    "i", "iframe", "img", "input", "ins",
    "kbd",
    "label", "legend", "li", "link",
    "main", "map", "mark", "menu", "meta", "meter",
    "nav", "noscript",
    "object", "ol", "optgroup", "option", "output",
    "p", "picture", "pre", "progress",
    "q",
    "rp", "rt", "ruby",
    "s", "samp", "script", "search", "section", "select", "selectedcontent", "slot", "small", "source", "span",
    "strong", "style", "sub", "summary", "sup",
    "table", "tbody", "td", "template", "textarea", "tfoot", "th", "thead", "time", "title", "tr", "track",
    "u", "ul",
    "var", "video",
    "wbr",
];

// Elements the standard lists as obsolete, which a parser still reads and an old layout may name.
export const OBSOLETE_HTML_ELEMENTS = [
    "acronym", "applet", "basefont", "bgsound", "big", "blink", "center", "dir", "font", "frame", "frameset",
    "isindex", "keygen", "listing", "marquee", "menuitem", "multicol", "nextid", "nobr", "noembed", "noframes",
    "param", "plaintext", "rb", "rtc", "spacer", "strike", "tt", "xmp",
];

// HTML's void elements: no end tag, no content.
export const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

// The obsolete elements the parser also treats as void (an end tag for one is ignored).
export const OBSOLETE_VOID_ELEMENTS = new Set(["basefont", "bgsound", "frame", "keygen", "param"]);

// What Juris will not draw from a layout unless `allowTags` names it, in lower case.
export const REFUSED_TAGS = new Set([
    "script", "iframe", "frame", "frameset", "object", "embed", "applet", "portal",
    "base", "meta", "link",
    "set", "animate", "animatemotion", "animatetransform",
    "plaintext", "style",
]);

// Elements whose content the HTML parser reads as text rather than markup. RAWTEXT takes the text
// as it is (no character references); escapable raw text decodes references but makes no elements.
export const RAWTEXT_ELEMENTS = new Set(["style", "xmp", "iframe", "noembed", "noframes"]);
export const ESCAPABLE_RAWTEXT_ELEMENTS = new Set(["textarea", "title"]);

// The SVG 2 elements, in their case.
export const SVG_ELEMENTS = [
    "a", "animate", "animateMotion", "animateTransform", "circle", "clipPath", "defs", "desc", "discard",
    "ellipse",
    "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting",
    "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB", "feFuncG", "feFuncR",
    "feGaussianBlur", "feImage", "feMerge", "feMergeNode", "feMorphology", "feOffset", "fePointLight",
    "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence", "filter", "foreignObject",
    "g", "image", "line", "linearGradient", "marker", "mask", "metadata", "mpath", "path", "pattern", "polygon",
    "polyline", "radialGradient", "rect", "script", "set", "stop", "style", "svg", "switch", "symbol", "text",
    "textPath", "title", "tspan", "use", "view",
];

// SVG's HTML integration points: inside these, the markup is HTML again.
export const SVG_HTML_INTEGRATION = ["foreignObject", "desc", "title"];

// The MathML elements: MathML Core, then MathML 3's that Core left out.
export const MATHML_ELEMENTS = [
    "math", "annotation", "annotation-xml", "maction", "merror", "mfrac", "mi", "mmultiscripts", "mn", "mo",
    "mover", "mpadded", "mphantom", "mprescripts", "mroot", "mrow", "ms", "mspace", "msqrt", "mstyle", "msub",
    "msubsup", "msup", "mtable", "mtd", "mtext", "mtr", "munder", "munderover", "semantics",
    "maligngroup", "malignmark", "menclose", "mfenced", "mglyph", "mlabeledtr", "mlongdiv", "mscarries", "mscarry",
    "msgroup", "msline", "msrow", "mstack", "none",
];

// MathML's token elements: what is inside them is HTML, but for mglyph and malignmark.
export const MATHML_TOKEN_ELEMENTS = ["mi", "mo", "mn", "ms", "mtext"];

export const isRefused = (tag) => REFUSED_TAGS.has(tag.toLowerCase());
