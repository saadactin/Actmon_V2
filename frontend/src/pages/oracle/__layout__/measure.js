/* Runs inside the page. Returns the geometry needed to prove the brief's
   acceptance criteria, rather than a screenshot that still has to be judged
   by eye. */
(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; };
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];

  const n1 = q('[data-node="1"]');
  const n2 = q('[data-node="2"]');
  const inter = q('[data-inter]');
  const railLine = q('[data-rail-line]');
  const storage = q('[data-storage]');
  const legend = q('[data-legend]');
  const connRow = q('[data-connrow]');

  // Anything whose content box is wider than its own padding box is spilling.
  const overflowing = qa('[data-root] *')
    .filter((el) => el.scrollWidth - el.clientWidth > 1 && getComputedStyle(el).overflowX === 'visible')
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      cls: (el.className || '').toString().slice(0, 60),
      over: el.scrollWidth - el.clientWidth,
    }));

  // Text that is cut off: a single-line element whose content does not fit.
  const clipped = qa('[data-root] span, [data-root] h3')
    .filter((el) => !el.children.length && el.scrollWidth > el.clientWidth + 1)
    .map((el) => ({ text: el.textContent.trim().slice(0, 40), over: el.scrollWidth - el.clientWidth }));

  return {
    viewport: window.innerWidth,
    node1: r(n1), node2: r(n2), inter: r(inter), rail: r(railLine),
    storage: r(storage), legend: r(legend), conn: r(connRow),
    // Does anything in the interconnect column escape it?
    interChildrenOutside: [...inter.querySelectorAll('[data-label]')]
      .filter((el) => { const b = r(el); const i = r(inter); return b.l < i.l - 0.5 || b.r > i.r + 0.5; })
      .map((el) => ({ label: el.dataset.label, box: r(el) })),
    railVsCards: { railLeftMinusNode1Right: r(railLine).l - r(n1).r, node2LeftMinusRailRight: r(n2).l - r(railLine).r },
    gapN1toInter: r(inter).l - r(n1).r,
    gapIntertoN2: r(n2).l - r(inter).r,
    widths: { n1: r(n1).w, n2: r(n2).w, inter: r(inter).w, delta: Math.abs(r(n1).w - r(n2).w) },
    storageClearance: { belowConn: r(storage).t - r(connRow).b, legendGap: r(legend).t - r(storage).b },
    overflowing, clipped,
  };
})()
