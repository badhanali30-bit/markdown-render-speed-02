# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/badhanali30-bit/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/badhanali30-bit/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free, single-pass Markdown-to-HTML renderer that is byte-for-byte compatible with marked 18.1.3 (GFM defaults) and renders a full 720-case set several times faster than marked itself.

Its block and inline grammars follow the algorithms of [marked](https://github.com/markedjs/marked) 18.1.3 (MIT), reimplemented from scratch for speed: direct HTML emission, deferred inline runs, lazy emphasis masking, and first-character dispatch.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=badhan-50651&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
