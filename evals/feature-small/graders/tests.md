---
type: llm
weight: 1
focus:
  source: file
  path: test_textutil.py
---

Success: the file uses the standard `unittest` module (a `unittest.TestCase` subclass) and has tests covering each of: accented input, punctuation, repeated spaces, and empty input, with concrete expected values. Fail if any of the four cases is missing or a different test framework is used.
