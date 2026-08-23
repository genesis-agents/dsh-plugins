import io

p = "lib/episodes.js"
s = io.open(p, encoding="utf-8", newline="").read()

old = '    .replace(/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]/g, "");\n'
new = (
    '    .replace(/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]/g, "")\n'
    '    // Unpaired surrogates and the two noncharacters are the same problem\n'
    '    // arriving by a different road, and the road is real: a title is a\n'
    '    // JavaScript string of UTF-16 code units, so slicing one to a character\n'
    '    // budget — as `itemDescription` does at 300 — can cut an emoji in half\n'
    '    // and leave a surrogate with no mate. A lone surrogate is not a\n'
    '    // character, and an XML reader rejects the WHOLE document over one: a\n'
    '    // single broken emoji in a single title would empty every subscriber\'s\n'
    '    // feed rather than spoil one item. Dropped, like the controls above.\n'
    '    .replace(/[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]|[\\uFFFE\\uFFFF]/g, "");\n'
)
assert s.count(old) == 1, s.count(old)
io.open(p, "w", encoding="utf-8", newline="").write(s.replace(old, new))
print("patched")
