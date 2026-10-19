#!/usr/bin/env python3
"""Split a rendered chart (helm template on stdin) for a server-side dry run: resources that are NOT helm hooks go to
--rest (for `kubectl apply --dry-run=server`, as they will be applied); hooks go to --hooks with a unique name (for
`kubectl create --dry-run=server`, which validates them without touching the existing one).

Why: a hook Job (realm-sync, hook-delete-policy before-hook-creation) exists from the previous run until helm deletes
and recreates it; a Job's spec.template is immutable, so a dry-run APPLY of the rendered Job is rejected with
"field is immutable" on every upgrade although the real helm upgrade works. A fresh namespace has no such Job, which is
why a dry run on a clean cluster passes. Standard library only (the operator's machine may lack PyYAML): documents are
split on helm's `---` separators and a hook is a document carrying a `helm.sh/hook:` annotation.

  helm template … | split-hooks.py --rest rest.yaml --hooks hooks.yaml [--suffix dryrun]
"""
import re
import sys


def split(text):
    docs, rest, hooks = re.split(r"(?m)^---[ \t]*$", text), [], []
    for d in docs:
        if not re.search(r"(?m)^\s*(kind|apiVersion):", d):
            continue   # empty document or comments only
        (hooks if re.search(r"(?m)^\s*helm\.sh/hook:", d) else rest).append(d)
    return rest, hooks


def rename(doc, suffix):
    """metadata.name of the top-level object → <name>-<suffix> (the first `name:` at two spaces under metadata:)."""
    m = re.search(r"(?m)^metadata:\n((?:  .*\n|\n)*?)  name:[ \t]+(\S+)[ \t]*$", doc)
    if not m:
        return doc
    start, end = m.start(2), m.end(2)
    return doc[:start] + m.group(2).strip('"\'') + "-" + suffix + doc[end:]


def main(argv):
    args = dict(zip(argv[1::2], argv[2::2]))
    rest_path, hooks_path, suffix = args.get("--rest"), args.get("--hooks"), args.get("--suffix", "dryrun")
    rest, hooks = split(sys.stdin.read())
    if rest_path:
        with open(rest_path, "w") as f:
            f.write("---\n".join(rest))
    if hooks_path:
        with open(hooks_path, "w") as f:
            f.write("---\n".join(rename(h, suffix) for h in hooks))
    print(f"{len(rest)} resources to apply, {len(hooks)} hook(s) checked as new objects", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv)
