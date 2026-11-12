---
type: llm
weight: 1
---

Success: `textutil.py` defines `slugify` with the stated behaviour; `test_textutil.py` uses unittest and covers accents, punctuation, repeated spaces and empty input; the final report states that `python3 -m unittest` was run and passed, either by the main agent or relayed from the agent that ran it, with the test count; nothing was committed. Fail if the tests were not run or failed, or if the work was split across more than two agents for this small task.
