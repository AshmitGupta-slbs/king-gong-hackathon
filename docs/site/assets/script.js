/* ============================================================
   AGENT FLEET — Documentation site · shared script
   - Mermaid initialization
   - TOC active-state on scroll
   - Glossary search filter
   - Mobile nav toggle
   - Expand-all / collapse-all for deep dives
   ============================================================ */

// Mermaid init (uses CDN script loaded in pages)
if (window.mermaid) {
  mermaid.initialize({
    startOnLoad: true,
    theme: 'base',
    themeVariables: {
      fontFamily: 'Inter Tight, sans-serif',
      primaryColor: '#fffaf2',
      primaryTextColor: '#1c1917',
      primaryBorderColor: '#1c1917',
      lineColor: '#57534e',
      secondaryColor: '#ffedd5',
      tertiaryColor: '#ccfbf1',
      background: '#fffaf2'
    },
    flowchart: { curve: 'basis', padding: 18, useMaxWidth: true },
    sequence: { actorMargin: 50, messageMargin: 35, mirrorActors: false, useMaxWidth: true }
  });
}

// TOC active state on scroll
document.addEventListener('DOMContentLoaded', () => {
  const tocLinks = document.querySelectorAll('.toc a');
  if (tocLinks.length === 0) return;

  const headings = Array.from(tocLinks)
    .map(a => {
      const id = a.getAttribute('href').replace('#', '');
      const el = document.getElementById(id);
      return el ? { link: a, el } : null;
    })
    .filter(Boolean);

  function onScroll() {
    const scrollY = window.scrollY + 120;
    let current = null;
    for (const item of headings) {
      if (item.el.offsetTop <= scrollY) current = item;
      else break;
    }
    tocLinks.forEach(l => l.classList.remove('active'));
    if (current) current.link.classList.add('active');
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
});

// Glossary search filter
document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('glossary-search');
  if (!input) return;
  const items = document.querySelectorAll('.glossary-item');
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    items.forEach(item => {
      const text = item.textContent.toLowerCase();
      item.classList.toggle('hidden', q && !text.includes(q));
    });
  });
});

// Mobile sidebar toggle
document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.querySelector('.mobile-nav-toggle');
  const sidebar = document.querySelector('.sidebar');
  if (toggle && sidebar) {
    toggle.addEventListener('click', () => {
      sidebar.classList.toggle('collapsed');
    });
    if (window.innerWidth <= 800) sidebar.classList.add('collapsed');
  }
});

// Expand all / Collapse all deep dives
document.addEventListener('DOMContentLoaded', () => {
  const expandBtn = document.getElementById('expand-all');
  const collapseBtn = document.getElementById('collapse-all');
  const details = document.querySelectorAll('details.dd');
  if (expandBtn) expandBtn.addEventListener('click', () => details.forEach(d => d.open = true));
  if (collapseBtn) collapseBtn.addEventListener('click', () => details.forEach(d => d.open = false));
});
