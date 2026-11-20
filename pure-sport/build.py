#!/usr/bin/env python3
"""Inline src/style.css, src/core.js and src/app.js into dist/index.html (the single file that gets published)."""
import pathlib
root = pathlib.Path(__file__).parent
shell = (root / "src/shell.html").read_text()
out = (shell.replace("/*STYLE*/", (root / "src/style.css").read_text())
            .replace("/*CORE*/", (root / "src/core.js").read_text())
            .replace("/*APP*/", (root / "src/app.js").read_text()))
(root / "dist").mkdir(exist_ok=True)
(root / "dist/index.html").write_text(out)
print("dist/index.html", len(out), "bytes")
