// Every attribute a layout can give an element: HTML's (the WHATWG attribute index, global and per
// element), WAI-ARIA 1.3's, every event handler content attribute, SVG 2's (regular and
// presentation) and MathML's. Each with the element the per-attribute tests draw it on, and its
// kind: "text" (written as given, escaped), "boolean" (present or absent, HTML's boolean attributes),
// "url" (held to the scheme rule, html-safety.js URL_ATTRIBUTES), or "refused" (never written).

// [name, kind, host element]
export const HTML_GLOBAL_ATTRIBUTES = [
    ["accesskey", "text", "div"],
    ["autocapitalize", "text", "div"],
    ["autocorrect", "text", "div"],
    ["autofocus", "boolean", "input"],
    ["class", "text", "div"],
    ["contenteditable", "text", "div"],
    ["dir", "text", "div"],
    ["draggable", "text", "div"],
    ["enterkeyhint", "text", "div"],
    ["exportparts", "text", "div"],
    ["hidden", "boolean", "div"],
    ["id", "text", "div"],
    ["inert", "boolean", "div"],
    ["inputmode", "text", "div"],
    ["is", "text", "div"],
    ["itemid", "text", "div"],
    ["itemprop", "text", "div"],
    ["itemref", "text", "div"],
    ["itemscope", "boolean", "div"],
    ["itemtype", "text", "div"],
    ["lang", "text", "div"],
    ["nonce", "text", "div"],
    ["part", "text", "div"],
    ["popover", "text", "div"],
    ["slot", "text", "div"],
    ["spellcheck", "text", "div"],
    ["style", "text", "div"],
    ["tabindex", "text", "div"],
    ["title", "text", "div"],
    ["translate", "text", "div"],
    ["writingsuggestions", "text", "div"],
];

export const HTML_ELEMENT_ATTRIBUTES = [
    ["abbr", "text", "th"],
    ["accept", "text", "input"],
    ["accept-charset", "text", "form"],
    ["action", "url", "form"],
    ["allow", "text", "iframe"],
    ["allowfullscreen", "boolean", "iframe"],
    ["alpha", "boolean", "input"],
    ["alt", "text", "img"],
    ["as", "text", "link"],
    ["async", "boolean", "script"],
    ["autocomplete", "text", "input"],
    ["autoplay", "boolean", "video"],
    ["blocking", "text", "script"],
    ["charset", "text", "meta"],
    ["checked", "boolean", "input"],
    ["cite", "url", "blockquote"],
    ["closedby", "text", "dialog"],
    ["color", "text", "link"],
    ["colorspace", "text", "input"],
    ["cols", "text", "textarea"],
    ["colspan", "text", "td"],
    ["command", "text", "button"],
    ["commandfor", "text", "button"],
    ["content", "text", "meta"],
    ["controls", "boolean", "video"],
    ["coords", "text", "area"],
    ["crossorigin", "text", "img"],
    ["data", "url", "object"],
    ["datetime", "text", "time"],
    ["decoding", "text", "img"],
    ["default", "boolean", "track"],
    ["defer", "boolean", "script"],
    ["dirname", "text", "input"],
    ["disabled", "boolean", "button"],
    ["download", "text", "a"],
    ["enctype", "text", "form"],
    ["fetchpriority", "text", "img"],
    ["for", "text", "label"],
    ["form", "text", "input"],
    ["formaction", "url", "button"],
    ["formenctype", "text", "button"],
    ["formmethod", "text", "button"],
    ["formnovalidate", "boolean", "button"],
    ["formtarget", "text", "button"],
    ["headers", "text", "td"],
    ["height", "text", "img"],
    ["high", "text", "meter"],
    ["href", "url", "a"],
    ["hreflang", "text", "a"],
    ["http-equiv", "text", "meta"],
    ["imagesizes", "text", "link"],
    ["imagesrcset", "text", "link"],
    ["integrity", "text", "script"],
    ["ismap", "boolean", "img"],
    ["kind", "text", "track"],
    ["label", "text", "option"],
    ["list", "text", "input"],
    ["loading", "text", "img"],
    ["loop", "boolean", "audio"],
    ["low", "text", "meter"],
    ["max", "text", "input"],
    ["maxlength", "text", "input"],
    ["media", "text", "source"],
    ["method", "text", "form"],
    ["min", "text", "input"],
    ["minlength", "text", "input"],
    ["multiple", "boolean", "select"],
    ["muted", "boolean", "video"],
    ["name", "text", "input"],
    ["nomodule", "boolean", "script"],
    ["novalidate", "boolean", "form"],
    ["open", "boolean", "details"],
    ["optimum", "text", "meter"],
    ["pattern", "text", "input"],
    ["ping", "text", "a"],
    ["placeholder", "text", "input"],
    ["playsinline", "boolean", "video"],
    ["popovertarget", "text", "button"],
    ["popovertargetaction", "text", "button"],
    ["poster", "url", "video"],
    ["preload", "text", "video"],
    ["readonly", "boolean", "input"],
    ["referrerpolicy", "text", "a"],
    ["rel", "text", "a"],
    ["required", "boolean", "input"],
    ["reversed", "boolean", "ol"],
    ["rows", "text", "textarea"],
    ["rowspan", "text", "td"],
    ["sandbox", "text", "iframe"],
    ["scope", "text", "th"],
    ["selected", "boolean", "option"],
    ["shadowrootclonable", "boolean", "template"],
    ["shadowrootcustomelementregistry", "boolean", "template"],
    ["shadowrootdelegatesfocus", "boolean", "template"],
    ["shadowrootmode", "text", "template"],
    ["shadowrootserializable", "boolean", "template"],
    ["shape", "text", "area"],
    ["size", "text", "input"],
    ["sizes", "text", "img"],
    ["span", "text", "col"],
    ["src", "url", "img"],
    ["srcdoc", "refused", "iframe"],
    ["srclang", "text", "track"],
    ["srcset", "text", "img"],
    ["start", "text", "ol"],
    ["step", "text", "input"],
    ["target", "text", "a"],
    ["type", "text", "button"],
    ["usemap", "text", "img"],
    ["value", "text", "input"],
    ["width", "text", "img"],
    ["wrap", "text", "textarea"],
];

// HTML's boolean attributes, as the standard's index lists them (`hidden` is enumerated since
// "until-found", but its empty value is the boolean one, so it is here too).
export const HTML_BOOLEAN_ATTRIBUTES = new Set(
    [...HTML_GLOBAL_ATTRIBUTES, ...HTML_ELEMENT_ATTRIBUTES].filter(([, kind]) => kind === "boolean").map(([name]) => name),
);

// The boolean attributes Juris knows (BOOLEAN_ATTRIBUTES in dom-renderer.js and in the kit's
// server/ssr-renderer.js). The tests are written against the standard's list; this one says which
// of its misses are known.
export const JURIS_BOOLEAN_ATTRIBUTES = new Set([
    "allowfullscreen", "async", "autofocus", "autoplay", "checked", "controls", "default", "defer", "disabled",
    "formnovalidate", "hidden", "inert", "ismap", "itemscope", "loop", "multiple", "muted", "nomodule",
    "novalidate", "open", "playsinline", "readonly", "required", "reversed", "selected",
]);

// The attributes whose value is a URL the browser navigates to, loads or submits to.
export const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "xlink:href", "poster", "cite", "data"]);

// Attributes whose "false" is a value, not an absence: a layout's `false` must be written as
// "false", where a boolean attribute's is left out.
export const FALSE_IS_A_VALUE = ["contenteditable", "draggable", "spellcheck", "writingsuggestions", "aria-hidden", "aria-expanded", "aria-pressed", "aria-checked", "aria-selected"];

export const ARIA_ATTRIBUTES = [
    "aria-activedescendant", "aria-atomic", "aria-autocomplete", "aria-braillelabel", "aria-brailleroledescription",
    "aria-busy", "aria-checked", "aria-colcount", "aria-colindex", "aria-colindextext", "aria-colspan",
    "aria-controls", "aria-current", "aria-describedby", "aria-description", "aria-details", "aria-disabled",
    "aria-dropeffect", "aria-errormessage", "aria-expanded", "aria-flowto", "aria-grabbed", "aria-haspopup",
    "aria-hidden", "aria-invalid", "aria-keyshortcuts", "aria-label", "aria-labelledby", "aria-level", "aria-live",
    "aria-modal", "aria-multiline", "aria-multiselectable", "aria-orientation", "aria-owns", "aria-placeholder",
    "aria-posinset", "aria-pressed", "aria-readonly", "aria-relevant", "aria-required", "aria-roledescription",
    "aria-rowcount", "aria-rowindex", "aria-rowindextext", "aria-rowspan", "aria-selected", "aria-setsize",
    "aria-sort", "aria-valuemax", "aria-valuemin", "aria-valuenow", "aria-valuetext", "role",
];

// Every event handler content attribute: HTML's global ones, the body's (window's), and those
// of the pointer, touch, animation, transition, fullscreen and SVG animation events.
export const EVENT_HANDLER_ATTRIBUTES = [
    "onabort", "onauxclick", "onbeforeinput", "onbeforematch", "onbeforetoggle", "onblur", "oncancel", "oncanplay",
    "oncanplaythrough", "onchange", "onclick", "onclose", "oncommand", "oncontextlost", "oncontextmenu",
    "oncontextrestored", "oncopy", "oncuechange", "oncut", "ondblclick", "ondrag", "ondragend", "ondragenter",
    "ondragleave", "ondragover", "ondragstart", "ondrop", "ondurationchange", "onemptied", "onended", "onerror",
    "onfocus", "onformdata", "oninput", "oninvalid", "onkeydown", "onkeypress", "onkeyup", "onload", "onloadeddata",
    "onloadedmetadata", "onloadstart", "onmousedown", "onmouseenter", "onmouseleave", "onmousemove", "onmouseout",
    "onmouseover", "onmouseup", "onpaste", "onpause", "onplay", "onplaying", "onprogress", "onratechange", "onreset",
    "onresize", "onscroll", "onscrollend", "onsecuritypolicyviolation", "onseeked", "onseeking", "onselect",
    "onslotchange", "onstalled", "onsubmit", "onsuspend", "ontimeupdate", "ontoggle", "onvolumechange", "onwaiting",
    "onwheel",
    "onafterprint", "onbeforeprint", "onbeforeunload", "onhashchange", "onlanguagechange", "onmessage",
    "onmessageerror", "onoffline", "ononline", "onpagehide", "onpagereveal", "onpageshow", "onpageswap", "onpopstate",
    "onrejectionhandled", "onstorage", "onunhandledrejection", "onunload",
    "onpointerdown", "onpointerup", "onpointermove", "onpointerover", "onpointerout", "onpointerenter",
    "onpointerleave", "onpointercancel", "onpointerrawupdate", "ongotpointercapture", "onlostpointercapture",
    "ontouchstart", "ontouchend", "ontouchmove", "ontouchcancel",
    "onanimationstart", "onanimationend", "onanimationiteration", "onanimationcancel",
    "ontransitionstart", "ontransitionend", "ontransitionrun", "ontransitioncancel",
    "onfullscreenchange", "onfullscreenerror", "onselectstart", "onselectionchange",
    "onbegin", "onend", "onrepeat",
];

// SVG 2's attributes, in their case (SVG's are case-sensitive): the regular ones, then the
// presentation attributes. `href` and `xlink:href` are URLs; the rest are text.
export const SVG_ATTRIBUTES = [
    "id", "class", "style", "lang", "tabindex", "xml:lang", "xml:space", "xmlns", "xmlns:xlink", "href",
    "xlink:href", "xlink:title", "viewBox", "preserveAspectRatio", "width", "height", "x", "y", "x1", "y1", "x2", "y2",
    "cx", "cy", "r", "rx", "ry", "fx", "fy", "fr", "d", "points", "pathLength", "transform", "gradientUnits",
    "gradientTransform", "spreadMethod", "patternUnits", "patternContentUnits", "patternTransform", "clipPathUnits",
    "maskUnits", "maskContentUnits", "markerUnits", "markerWidth", "markerHeight", "refX", "refY", "orient",
    "filterUnits", "primitiveUnits", "in", "in2", "result", "mode", "operator", "k1", "k2", "k3", "k4",
    "stdDeviation", "edgeMode", "kernelMatrix", "kernelUnitLength", "order", "divisor", "bias", "targetX", "targetY",
    "preserveAlpha", "surfaceScale", "diffuseConstant", "specularConstant", "specularExponent", "limitingConeAngle",
    "pointsAtX", "pointsAtY", "pointsAtZ", "azimuth", "elevation", "scale", "xChannelSelector", "yChannelSelector",
    "baseFrequency", "numOctaves", "seed", "stitchTiles", "type", "values", "tableValues", "slope", "intercept",
    "amplitude", "exponent", "offset", "dx", "dy", "rotate", "textLength", "lengthAdjust", "startOffset", "method",
    "spacing", "side", "path", "radius", "requiredExtensions", "systemLanguage", "crossorigin", "download",
    "hreflang", "ping", "referrerpolicy", "rel", "target", "begin", "value",
    "alignment-baseline", "baseline-shift", "clip", "clip-path", "clip-rule", "color", "color-interpolation",
    "color-interpolation-filters", "color-rendering", "cursor", "direction", "display", "dominant-baseline", "fill",
    "fill-opacity", "fill-rule", "filter", "flood-color", "flood-opacity", "font-family", "font-size",
    "font-size-adjust", "font-stretch", "font-style", "font-variant", "font-weight", "glyph-orientation-horizontal",
    "glyph-orientation-vertical", "image-rendering", "letter-spacing", "lighting-color", "marker-end", "marker-mid",
    "marker-start", "mask", "mask-type", "opacity", "overflow", "paint-order", "pointer-events", "shape-rendering",
    "stop-color", "stop-opacity", "stroke", "stroke-dasharray", "stroke-dashoffset", "stroke-linecap",
    "stroke-linejoin", "stroke-miterlimit", "stroke-opacity", "stroke-width", "text-anchor", "text-decoration",
    "text-overflow", "text-rendering", "transform-origin", "unicode-bidi", "vector-effect", "visibility",
    "white-space", "word-spacing", "writing-mode",
];

// The namespaces the HTML parser gives SVG's and MathML's prefixed attributes.
export const ATTRIBUTE_NAMESPACES = {
    "xlink:href": "http://www.w3.org/1999/xlink",
    "xlink:title": "http://www.w3.org/1999/xlink",
    "xml:lang": "http://www.w3.org/XML/1998/namespace",
    "xml:space": "http://www.w3.org/XML/1998/namespace",
    xmlns: "http://www.w3.org/2000/xmlns/",
    "xmlns:xlink": "http://www.w3.org/2000/xmlns/",
};

// MathML's attributes: Core's global ones and each element's, then MathML 3's that browsers read.
export const MATHML_ATTRIBUTES = [
    "id", "class", "style", "dir", "tabindex", "nonce", "displaystyle", "mathbackground", "mathcolor", "mathsize",
    "mathvariant", "scriptlevel", "display", "alttext", "intent", "arg", "href", "accent", "accentunder",
    "columnspan", "rowspan", "depth", "height", "width", "lspace", "rspace", "voffset", "fence", "form", "largeop",
    "linethickness", "maxsize", "minsize", "movablelimits", "separator", "stretchy", "symmetric", "encoding",
    "definitionURL", "notation", "actiontype", "selection", "columnalign", "rowalign", "columnlines", "rowlines",
    "frame", "framespacing", "equalrows", "equalcolumns", "open", "close", "separators", "bevelled", "numalign",
    "denomalign", "subscriptshift", "superscriptshift", "lquote", "rquote",
];

// MathML's own booleans are the strings "true" and "false", never presence.
export const MATHML_FALSE_IS_A_VALUE = ["displaystyle", "accent", "accentunder", "fence", "largeop", "movablelimits", "separator", "stretchy", "symmetric"];

// Names no attribute has, each from data: the name is the injection.
export const BAD_ATTRIBUTE_NAMES = [
    "", " ", "x onmouseover", "a=b", "a\"b", "a'b", "a>b", "a<b", "a/b", "a b", "a\tb", "a\nb", "a\u0000b", "1abc",
    "-abc", ".abc", "@click", "#x", "a`b", "é", "x​onclick",
];
