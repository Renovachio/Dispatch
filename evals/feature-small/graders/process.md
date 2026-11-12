---
type: llm
weight: 1
focus: trace
---

Success: in this transcript, `python3 -m unittest` (or an equivalent unittest invocation) was actually run and its output shows the tests passed; no `git commit` was run; and at most two subagents were spawned for this small task. Fail if the tests were never run, the last run failed, a commit was made, or more than two subagents were spawned.
