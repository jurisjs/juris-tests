// Reading the server's markup back: the start tag of an element and its attributes, as the HTML
// tokenizer would read the double-quoted form the SSR renderer writes.

const REFERENCES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
export const unescape = (text) => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => REFERENCES[name]);

// The first start tag in `html`: { tag, attributes: [[name, value]...], rest } (rest is what follows
// the tag's `>`). Throws when the markup is not a start tag the tokenizer would read cleanly.
export function startTag(html) {
    const head = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(html);
    if (!head) throw new Error(`not a start tag: ${JSON.stringify(html.slice(0, 60))}`);
    let i = head[0].length;
    const attributes = [];
    for (;;) {
        if (html[i] === ">") return { tag: head[1], attributes, rest: html.slice(i + 1) };
        const attribute = /^ ([^\s"'>/=]+)="([^"]*)"/.exec(html.slice(i));
        if (!attribute) throw new Error(`unreadable attribute at ${i}: ${JSON.stringify(html.slice(i, i + 60))}`);
        attributes.push([attribute[1], unescape(attribute[2])]);
        i += attribute[0].length;
    }
}

// The attributes of the first start tag as { name: value }; a name written twice throws.
export function attributesIn(html) {
    const out = {};
    for (const [name, value] of startTag(html).attributes) {
        if (name in out) throw new Error(`attribute ${name} written twice: ${html.slice(0, 200)}`);
        out[name] = value;
    }
    return out;
}
