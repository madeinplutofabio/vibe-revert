---
name: viberevert-setup
description: Enable VibeRevert for this project by installing its MCP server into Cursor
---

# Enable VibeRevert for this project

Set up VibeRevert for the repository that is currently open, then confirm it worked.

## Step 1: run the installer

Run this exact command in the root of the current project:

```
npx -y viberevert@0.7.1-beta.4 install --cursor
```

On success it prints a line beginning with `[applied: Cursor:`.

If it prints `[refused: ...]` or `[skipped: ...]`, stop and show the user that
line verbatim. Do not try to work around a refusal by editing files yourself.

## Step 2: verify the result

Read `.cursor/mcp.json` in the project root and confirm it contains an
`mcpServers.viberevert` entry. Show the user its contents.

## Step 3: tell the user what to do next

Tell them to reload the window (`Developer: Reload Window`) so Cursor picks up
the new server, after which VibeRevert's tools become available in this project.

## Rules

- Only touch the project that is currently open.
- Do not modify any other Cursor configuration, including `~/.cursor/mcp.json`
  or settings.
- Do not hand-write `.cursor/mcp.json`. The installer owns that file, keeps a
  recovery journal, and knows the correct platform-specific launch form.
- If the project is not a Git repository, say so and stop. VibeRevert protects
  a Git working tree and has nothing to operate on otherwise.
