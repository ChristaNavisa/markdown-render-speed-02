[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/ChristaNavisa/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/ChristaNavisa/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# markdown-render-speed-02

A fast, dependency-free CommonMark + GFM parser whose output matches
[marked](https://github.com/markedjs/marked) 18.1.3 (default options: gfm on,
breaks off) exactly — code unit for code unit — on the competition's 720
cases, and renders them faster than marked itself.

Entry for the [make.fun](https://make.fun/competitions/markdown-render-speed-02)
bounty **"Make Markdown rendering faster"** ($250).

## Files

- `parse.js` — the parser. ES module, no dependencies, no build step.
  Exports `parse(markdown)` (named and default), returning the HTML marked
  18.1.3 renders for the same input. Written from scratch as a direct-to-HTML
  design (no token objects, no repeated re-slicing), with the block and
  inline grammars expressed as the same anchored patterns marked uses, so
  edge cases agree with it — where marked deviates from the CommonMark/GFM
  spec, marked's HTML is what this returns.
- `main.ts` — the driver the harness runs (`node /bot/main.ts`, Node 22).
  Reads every case from `/input/cases.json`, renders each one alone with
  `parse()`, writes `/output/html.json`.
- `package.json` — `{"type": "module"}`.

## How it works

- Block parsing builds a light node tree (the same node types marked
  produces), deferring inline rendering so link definitions collected
  anywhere in the document are visible to every paragraph, including
  forward references — the same two-pass split marked itself uses.
- Inline rendering is a single loop over the paragraph text, dispatching
  on the first character so token checks that cannot match are skipped,
  with fast paths for plain prose (no inline token can start) and for the
  emphasis/delimiter masking (skipped when the text has no code spans,
  links, or HTML that could hide a delimiter).
- No network, no file reads, no clock reads, no caching between cases:
  `parse()` returns for each case exactly what it returns for that case
  alone. Deterministic: two runs produce byte-identical output.

## Local grading

Against the kit's practice set (720 cases: 680 CommonMark/GFM spec
examples + 40 generated README documents ≥ 20.000 characters), this entry
passes **720/720** cases (verified with the kit's scorer,
`program/scorer/main.ts`, and an independent diff harness).

## License

MIT. See `LICENSE`.
