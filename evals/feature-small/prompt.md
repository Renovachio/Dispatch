---
max_turns: 40
allowed_tools: [Read, Glob, Grep, Edit, Write, Bash, Skill, Agent]
tags: [acceptance, code, small]
---

/dispatch:dispatch In this folder, create `textutil.py` with a function `slugify(text: str) -> str` (lowercase, ASCII only, words joined by single hyphens, no leading or trailing hyphens) and `test_textutil.py` with `unittest` tests covering accents, punctuation, repeated spaces and empty input. Run them with `python3 -m unittest`. Do not commit.
