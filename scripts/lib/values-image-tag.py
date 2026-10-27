#!/usr/bin/env python3
"""Pins the cell's image tag in its values file (deploy/cells/<slug>.values.yaml): `image.tag`, `worker.image.tag`,
`web.image.tag`, `managedRunners.image.tag` — the four images move together. The file is the source of truth for
`apply`: a tag passed once with `apply --tag X` and not written here is lost by the next `apply`, which upgrades to the
chart's default appVersion (a kind cell did exactly that: realm-sync lost its image, the hook timed out, release
'failed'). Standard library only; every other line of the file is left byte for byte; a block that lacks the tag gets it.

  values-image-tag.py <values.yaml> <tag>        prints the tags it replaced
"""
import re
import sys

# (top-level key, nested key or None): the four images
IMAGES = [("image", None), ("worker", "image"), ("web", "image"), ("managedRunners", "image")]


def _q(v: str) -> str:
    return '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'


def set_tag(text: str, tag: str) -> tuple[str, list[str]]:
    lines = text.split("\n")
    changed: list[str] = []
    for top, nested in IMAGES:
        start = next((i for i, l in enumerate(lines) if re.match(rf"^{top}:\s*(#.*)?$", l)), None)
        if start is None:
            # the whole block is missing: append it
            block = f"{top}:\n  tag: {_q(tag)}\n" if nested is None else f"{top}:\n  {nested}: {{ tag: {_q(tag)} }}\n"
            while lines and lines[-1] == "":
                lines.pop()
            lines += ["", *block.rstrip("\n").split("\n")]
            changed.append(f"{top}{'.' + nested if nested else ''}.tag (added) → {tag}")
            continue
        end = next((i for i in range(start + 1, len(lines)) if lines[i].strip() and not lines[i].startswith((" ", "\t"))), len(lines))
        body = range(start + 1, end)
        if nested is None:
            key_re = re.compile(r"^(\s+tag:\s*)(\"[^\"]*\"|'[^']*'|\S+)(\s*#.*)?$")
            idx = next((i for i in body if key_re.match(lines[i])), None)
            if idx is None:
                lines.insert(start + 1, f"  tag: {_q(tag)}")
                changed.append(f"{top}.tag (added) → {tag}")
            else:
                m = key_re.match(lines[idx])
                lines[idx] = f"{m.group(1)}{_q(tag)}{m.group(3) or ''}"
                changed.append(f"{top}.tag {m.group(2)} → {tag}")
            continue
        # nested `image:` — the flow form `image: { repository: …, tag: "x" }` or a block form with its own tag line
        flow_re = re.compile(rf"^(\s+{nested}:\s*\{{.*?)(tag:\s*)(\"[^\"]*\"|'[^']*'|[^,}}\s]+)(.*\}}.*)$")
        done = False
        for i in body:
            m = flow_re.match(lines[i])
            if m:
                lines[i] = f"{m.group(1)}{m.group(2)}{_q(tag)}{m.group(4)}"
                changed.append(f"{top}.{nested}.tag {m.group(3)} → {tag}")
                done = True
                break
            if re.match(rf"^\s+{nested}:\s*\{{", lines[i]):   # a flow map without a tag
                lines[i] = re.sub(r"\}\s*(#.*)?$", lambda mm: f", tag: {_q(tag)} }}{(' ' + mm.group(1)) if mm.group(1) else ''}", lines[i], count=1).replace("{, ", "{ ")
                changed.append(f"{top}.{nested}.tag (added) → {tag}")
                done = True
                break
            if re.match(rf"^\s+{nested}:\s*(#.*)?$", lines[i]):   # block form
                indent = len(lines[i]) - len(lines[i].lstrip())
                j = i + 1
                tag_line = None
                while j < end and (len(lines[j]) - len(lines[j].lstrip()) > indent or not lines[j].strip()):
                    if re.match(r"^\s+tag:", lines[j]):
                        tag_line = j
                    j += 1
                if tag_line is None:
                    lines.insert(i + 1, " " * (indent + 2) + f"tag: {_q(tag)}")
                    changed.append(f"{top}.{nested}.tag (added) → {tag}")
                else:
                    m2 = re.match(r"^(\s+tag:\s*)(\"[^\"]*\"|'[^']*'|\S+)(\s*#.*)?$", lines[tag_line])
                    lines[tag_line] = f"{m2.group(1)}{_q(tag)}{m2.group(3) or ''}"
                    changed.append(f"{top}.{nested}.tag {m2.group(2)} → {tag}")
                done = True
                break
        if not done:
            lines.insert(start + 1, f"  {nested}: {{ tag: {_q(tag)} }}")
            changed.append(f"{top}.{nested}.tag (added) → {tag}")
    return "\n".join(lines), changed


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    path, tag = sys.argv[1], sys.argv[2]
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", tag):
        sys.exit(f"not an image tag: {tag!r}")
    with open(path, encoding="utf-8") as f:
        text = f.read()
    out, changed = set_tag(text, tag)
    with open(path, "w", encoding="utf-8") as f:
        f.write(out)
    print(f"{path}: " + "; ".join(changed))
