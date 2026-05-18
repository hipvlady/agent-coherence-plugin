---
description: "Append one or more workspace-relative paths to the coordinator's ignored set."
argument-hint: "<path> [<path>...]"
allowed-tools: ["Bash"]
---

Run `agent-coherence-untrack $ARGUMENTS` and report the output.

The command's stdout lists each successfully untracked path. Stderr carries
any rejections (invalid path syntax). The coordinator does NOT delete
existing artifact rows from SQLite — it just adds the path to ignored.yaml
so future Reads suppress warnings.

If no paths were given, ask the user which workspace-relative path(s) they
want to untrack. Don't invoke the CLI without arguments — argparse will error.
