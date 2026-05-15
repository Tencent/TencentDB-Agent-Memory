---
name: memory-search
description: Search long-term memory (TencentDB Agent Memory) for relevant past interactions, preferences, or decisions. Use when the user asks "do you remember…" or references past work in this project.
argument-hint: <query>
---

The user wants to search the long-term memory store for the following query:

$ARGUMENTS

Run the search via the Bash tool. The plugin reads the query from **stdin** to keep user-controlled text outside any shell word-split / expansion stage (cc currently performs a literal `replaceAll` on `$ARGUMENTS`, so passing it as an argv element would expose a command-injection surface — see Anthropic GH issue #16163).

Use a here-document with a long random sentinel:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/lib/hook.mjs" search-stdin <<'__TDAI_QUERY_EOF__'
<paste the user's query verbatim, on one or more lines, exactly as shown above>
__TDAI_QUERY_EOF__
```

Then summarize the matching memories to answer the user's question. If no memories were returned, say so plainly.
