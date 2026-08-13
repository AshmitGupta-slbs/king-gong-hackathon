#!/usr/bin/env python3
"""Assemble the docs/site pages from body fragments + one shared shell.

NOT part of the app build. The generated .html files are committed and fully standalone — a reader
only needs a browser, and `npm install` never runs this. It exists only for whoever edits the docs:
the sidebar, topbar, prev/next chain and footer are identical on every page, and maintaining them
by hand across eleven pages invites exactly the drift it is easy to miss in review (two `active`
links, a nav entry that points at a renamed file, a broken prev/next chain). Generating them makes
the navigation correct by construction, with one place to change it.

    python3 docs/site/build.py      # rewrites docs/site/NN-slug.html from every fragment

So: edit `_parts/<slug>.html`, re-run this, and commit both. Editing the generated file directly
works until the next run silently reverts it.

`index.html` is hand-written — it is the only page with a hero and tile grid rather than the
standard section shell — so it is not generated and has no fragment. If you add or rename a
section, update NAV below AND the tiles in index.html; nothing enforces that pair.

Fragments contain ONLY the <main> body content (page-eyebrow through the last section; the
page-nav is appended by the generator). Front matter is the first three lines:
    <!--title: 03 · Data contract-->
    <!--pill: Contract-->
    <!--toc: id|Label ;; id|Label-->
Omitting `toc` renders the page with `.layout.no-toc` — correct for pages with fewer than three
<h2> sections.
"""
import re
import sys
from pathlib import Path

SITE = Path(__file__).resolve().parent
PARTS = SITE / '_parts'

NAV = [
    ('Start here', [('index.html', '00', 'Overview'), ('01-what-it-does.html', '01', 'What it does')]),
    ('How it works', [
        ('02-architecture.html', '02', 'Architecture'),
        ('03-data-contract.html', '03', 'Data contract'),
        ('04-citation-gate.html', '04', 'The citation gate'),
        ('05-harness.html', '05', 'The harness'),
    ]),
    ('Reality', [
        ('06-pyai-api-truth.html', '06', 'PyAI API truth'),
        ('07-extraction-providers.html', '07', 'Extraction &amp; providers'),
        ('08-status.html', '08', 'Built vs pending'),
        ('09-run-and-verify.html', '09', 'Run &amp; verify'),
        ('10-decisions-risks.html', '10', 'Decisions &amp; risks'),
        ('11-scorecard.html', '11', 'Scorecard'),
    ]),
]

ORDER = [f for _, group in NAV for f, _, _ in group]
LABEL = {f: (n, t) for _, g in NAV for f, n, t in g}

SHELL = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>{title} · King Gong</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500;9..144,600;9..144,700&family=JetBrains+Mono:wght@400;500;600&family=Inter+Tight:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/style.css">
<script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.0/dist/mermaid.min.js"></script>
</head>
<body>

<div class="topbar">
  <div class="topbar-inner">
    <a href="index.html" class="brand">
      <img class="brand-mark" src="assets/logo-mark.png" alt="" width="28" height="28" />
      <span>King Gong</span>
    </a>
    <div class="topbar-right">
      <span class="pill">{pill}</span>
      <span>§ {num}</span>
    </div>
  </div>
</div>

<div class="layout{layout_mod}">
<aside class="sidebar">
  <button class="mobile-nav-toggle" aria-label="Toggle navigation">☰ Sections</button>
{sidebar}</aside>

<main class="content">

{body}
{page_nav}
</main>
{toc}</div>

<footer class="site">
  <span>King Gong — Documentation</span>
  <span>§ {num} · {short}</span>
</footer>
<script src="assets/script.js"></script>

</body>
</html>
"""


def sidebar_for(current: str) -> str:
    out = []
    for label, items in NAV:
        out.append('  <div class="sidebar-section">')
        out.append(f'    <div class="sidebar-label">{label}</div>')
        out.append('    <nav>')
        for href, num, text in items:
            cls = ' class="active"' if href == current else ''
            out.append(f'      <a href="{href}"{cls}><span class="nav-num">{num}</span>{text}</a>')
        out.append('    </nav>')
        out.append('  </div>')
    return '\n'.join(out) + '\n'


def page_nav_for(current: str) -> str:
    i = ORDER.index(current)
    prev_html = '<span></span>'
    next_html = '<span></span>'
    if i > 0:
        f = ORDER[i - 1]
        n, t = LABEL[f]
        prev_html = (f'<a href="{f}">\n      <span class="nav-direction">← Previous</span>\n'
                     f'      <span class="nav-title">{n} · {t}</span>\n    </a>')
    if i < len(ORDER) - 1:
        f = ORDER[i + 1]
        n, t = LABEL[f]
        next_html = (f'<a href="{f}" class="next">\n      <span class="nav-direction">Next →</span>\n'
                     f'      <span class="nav-title">{n} · {t}</span>\n    </a>')
    return f'  <div class="page-nav">\n    {prev_html}\n    {next_html}\n  </div>\n'


def toc_for(items):
    if not items:
        return ''
    rows = '\n'.join(f'    <li><a href="#{i}">{lab}</a></li>' for i, lab in items)
    return f'\n<aside class="toc">\n  <div class="toc-label">On this page</div>\n  <ul>\n{rows}\n  </ul>\n</aside>\n'


def front_matter(text):
    meta = {}
    body_lines = []
    for line in text.split('\n'):
        m = re.match(r'^<!--(\w+):\s*(.*?)-->$', line.strip())
        if m and m.group(1) in ('title', 'pill', 'toc'):
            meta[m.group(1)] = m.group(2)
        else:
            body_lines.append(line)
    return meta, '\n'.join(body_lines).strip('\n')


def main():
    if not PARTS.exists():
        print(f'no fragments at {PARTS}', file=sys.stderr)
        sys.exit(1)
    written = []
    for frag in sorted(PARTS.glob('*.html')):
        slug = frag.name
        meta, body = front_matter(frag.read_text())
        title = meta.get('title', slug)
        num = title.split(' ')[0]
        short = title.split('·', 1)[1].strip() if '·' in title else title
        toc_items = []
        if meta.get('toc'):
            for chunk in meta['toc'].split(';;'):
                if '|' in chunk:
                    i, lab = chunk.split('|', 1)
                    toc_items.append((i.strip(), lab.strip()))
        html = SHELL.format(
            title=title,
            pill=meta.get('pill', 'Documentation'),
            num=num,
            short=short,
            layout_mod='' if toc_items else ' no-toc',
            sidebar=sidebar_for(slug),
            body=body,
            page_nav=page_nav_for(slug),
            toc=toc_for(toc_items),
        )
        (SITE / slug).write_text(html)
        written.append(slug)
    print(f'built {len(written)} pages: {", ".join(written)}')


if __name__ == '__main__':
    main()
