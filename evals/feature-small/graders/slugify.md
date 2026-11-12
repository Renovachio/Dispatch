---
type: llm
weight: 1
focus:
  source: file
  path: textutil.py
---

Success: the file defines `slugify(text: str) -> str` that lowercases, transliterates or strips accents to ASCII (e.g. "Café" → "cafe"), joins words with single hyphens, collapses repeated spaces and punctuation into one hyphen, and leaves no leading or trailing hyphens; empty input returns an empty string. Fail if any of these behaviours is missing or plainly wrong when you trace the code.
