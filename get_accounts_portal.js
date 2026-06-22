(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const collect = () => {
    const out = [];
    const accountRows = document.querySelectorAll('tr[aria-level="1"]');
    accountRows.forEach(row => {
      const nameEl = row.querySelector('[data-testid="account-list-cell"]');
      const idEl = row.querySelector('[data-testid="account-federation-link"]');
      if (!nameEl || !idEl) return;
      const accountName = nameEl.textContent.trim();
      const accountId = idEl.textContent.trim();

      // Walk forward through level-2 sibling rows until we hit another level-1 row.
      let next = row.nextElementSibling;
      while (next && next.getAttribute('aria-level') === '2') {
        const roleLink = next.querySelector('a[data-testid="federation-link"]');
        if (roleLink) {
          // The role's federation link is the source of truth for the
          // account id (the per-row id text can be mis-associated). Fall
          // back to the row's id only if the href has no account_id.
          const href = roleLink.getAttribute('href') || '';
          const m = href.match(/account_id=([0-9]+)/);
          out.push({
            accountName,
            accountId: m ? m[1] : accountId,
            roleName: roleLink.textContent.trim(),
          });
        }
        next = next.nextElementSibling;
      }
    });
    return out;
  };

  try {
    // Expand every collapsed account row so all roles are in the DOM.
    const toggles = document.querySelectorAll('tr[aria-level="1"] button[aria-expanded="false"]');
    toggles.forEach(t => t.click());

    // Wait for expansions to settle (give the SPA up to ~2s to render role rows).
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      const stillCollapsed = document.querySelectorAll('tr[aria-level="1"] button[aria-expanded="false"]').length;
      if (stillCollapsed === 0) break;
    }
    await sleep(200);

    const accounts = collect();
    if (accounts.length === 0) {
      return { error: 'no accounts found in portal table' };
    }
    return { accounts };
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
})();
