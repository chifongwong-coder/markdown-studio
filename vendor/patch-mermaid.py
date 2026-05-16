#!/usr/bin/env python3
# Scrub Chrome-content-script-incompatible characters out of vendor/mermaid.min.js.
#
# Chrome's content_scripts loader runs every JS file through `base::IsStringUTF8`
# in strict mode. That check rejects valid-UTF-8 files whose decoded text
# contains:
#   * Unicode non-characters: U+FDD0..U+FDEF, U+FFFE, U+FFFF, and the per-plane
#     equivalents U+xxFFFE / U+xxFFFF.
#   * Unpaired surrogates: U+D800..U+DFFF (can't appear in valid UTF-8 anyway).
#   * C0 control bytes other than \t \n \r (e.g. U+0001).
# When any of these occur, Chrome surfaces the misleading error
#   "Could not load JavaScript ... is not UTF-8 encoded."
# and refuses to load the manifest.
#
# Mermaid's minified bundle currently embeds two such characters as raw bytes
# inside string literals (one U+FFFF in a regex character class, one U+0001 in
# an internal sentinel string). We rewrite each occurrence to an equivalent JS
# escape sequence (￿ / \x01) — the parser produces the same character at
# runtime, but the on-disk file becomes ASCII at those positions.
#
# Re-runnable: if the file is already clean, exits 0 without rewriting.

import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "mermaid.min.js")


def is_nonchar(cp: int) -> bool:
    """Unicode non-character code points (Corrigendum #9)."""
    return (0xFDD0 <= cp <= 0xFDEF) or (cp & 0xFFFE) == 0xFFFE


def is_bad_control(cp: int) -> bool:
    """C0 control char Chrome's UTF-8 check rejects (allows \t \n \r)."""
    return cp < 0x20 and cp not in (0x09, 0x0A, 0x0D)


def js_escape(cp: int) -> str:
    """Render `cp` as a JS string/regex escape that re-parses to the same char."""
    if cp <= 0xFF:
        return "\\x%02x" % cp
    if cp <= 0xFFFF:
        return "\\u%04x" % cp
    # Supplementary plane: emit a UTF-16 surrogate pair so older parsers
    # without ES6 \u{...} support still work.
    cp -= 0x10000
    high = 0xD800 + (cp >> 10)
    low = 0xDC00 + (cp & 0x3FF)
    return "\\u%04x\\u%04x" % (high, low)


def main() -> int:
    if not os.path.exists(TARGET):
        print("patch-mermaid: %s not found — run install.sh first" % TARGET,
              file=sys.stderr)
        return 1

    with open(TARGET, "rb") as f:
        raw = f.read()

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as e:
        print("patch-mermaid: file is not valid UTF-8 (%s) — aborting" % e,
              file=sys.stderr)
        return 2

    offenders = [(i, ord(c)) for i, c in enumerate(text)
                 if is_nonchar(ord(c)) or is_bad_control(ord(c))]
    if not offenders:
        print("patch-mermaid: already clean (no offending chars)")
        return 0

    # Rewrite. Walk back-to-front so prior indices remain valid as we splice.
    chars = list(text)
    summary = {}
    for i, cp in reversed(offenders):
        chars[i] = js_escape(cp)
        summary[cp] = summary.get(cp, 0) + 1
    patched = "".join(chars)

    # Defense in depth: don't ship a broken file if the patched output somehow
    # still trips the rules (e.g. we missed a category).
    leftover = [(i, ord(c)) for i, c in enumerate(patched)
                if is_nonchar(ord(c)) or is_bad_control(ord(c))]
    if leftover:
        print("patch-mermaid: internal error — %d offenders survived patch" %
              len(leftover), file=sys.stderr)
        return 3

    backup = TARGET + ".bak"
    shutil.copy(TARGET, backup)
    try:
        with open(TARGET, "wb") as f:
            f.write(patched.encode("utf-8"))

        # If node is available, syntax-check the result so a future mermaid
        # version with a weirder context (e.g. a non-char inside a comment we
        # didn't expect) fails loudly here instead of at Chrome load time.
        try:
            subprocess.run(["node", "--check", TARGET],
                           check=True, capture_output=True)
        except FileNotFoundError:
            pass  # node not installed — skip the optional check
        except subprocess.CalledProcessError as e:
            shutil.copy(backup, TARGET)
            print("patch-mermaid: node --check failed after patch — reverted",
                  file=sys.stderr)
            print(e.stderr.decode("utf-8", errors="replace"), file=sys.stderr)
            return 4
    finally:
        if os.path.exists(backup):
            os.remove(backup)

    parts = ", ".join("U+%04X x%d" % (cp, n) for cp, n in sorted(summary.items()))
    print("patch-mermaid: rewrote %d char(s) as JS escapes (%s)" %
          (len(offenders), parts))
    return 0


if __name__ == "__main__":
    sys.exit(main())
