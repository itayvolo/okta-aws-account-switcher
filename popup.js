window.addEventListener("load", load_popup);

// Tracks which app tab a pending accounts_status update belongs to.
let statusAppId = null;
// Set while a switch/login runs; blocks starting another (expires in case status never updates).
let busyUntil = 0;

function wakeUpServiceWorker() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['_keepalive'], () => {
            resolve();
        });
    });
}

async function safeSendMessage(message, retries = 3) {
    await wakeUpServiceWorker();

    try {
        const response = await chrome.runtime.sendMessage(message);
        return response;
    } catch (error) {
        if (error.message && error.message.includes('Could not establish connection') && retries > 0) {
            await new Promise(resolve => setTimeout(resolve, 500));
            await wakeUpServiceWorker();
            return safeSendMessage(message, retries - 1);
        } else {
            throw error;
        }
    }
}

function elt(tag, className) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    return e;
}

function newAppId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return "app-" + Date.now() + "-" + Math.random().toString(36).slice(2);
}

function getApps(settings) {
    return Array.isArray(settings && settings.aws_apps) ? settings.aws_apps : [];
}

function appDisplayName(app) {
    const base = app.label || "AWS";
    return app.region === "govcloud" ? base + " (GovCloud)" : base;
}

function toggleCollapse(sectionEl) {
    sectionEl.classList.toggle('collapsed');
}

async function load_popup() {
    try {
        await wakeUpServiceWorker();
    } catch (error) {
        // Service worker connection failed
    }

    if (typeof migrateSettings === "function") {
        migrateSettings(() => init_popup());
    } else {
        init_popup();
    }
}

function showView(view) {
    const settingsView = document.getElementById("settings_view");
    const appTabs = document.getElementById("app_tabs");
    const homeBtn = document.getElementById("nav_home");
    const settingsBtn = document.getElementById("nav_settings");

    const settings = view === "settings";
    settingsView.classList.toggle("active", settings);
    appTabs.style.display = settings ? "none" : "block";
    document.getElementById("search_bar").style.display = settings ? "none" : "block";
    if (!settings) document.getElementById("account_search").focus();
    homeBtn.classList.toggle("active", !settings);
    settingsBtn.classList.toggle("active", settings);
}

function init_popup() {
    // Version of the code Chrome actually loaded (stale until the extension is reloaded).
    document.getElementById("version-info").innerText = "v" + chrome.runtime.getManifest().version;
    document.getElementById('nav_home').addEventListener("click", () => showView("home"));
    document.getElementById('nav_settings').addEventListener("click", () => showView("settings"));
    document.getElementById('okta_login').addEventListener("click", okta_login);

    document.getElementById("okta_domain").addEventListener("focusout", save_setting);
    document.getElementById("open_tab_on_switch").addEventListener("change", save_open_tab_pref);

    document.getElementById("add_aws_app").addEventListener("click", add_aws_app);

    const search = document.getElementById("account_search");
    search.addEventListener("input", () => apply_search(search.value));
    search.addEventListener("keydown", search_keydown);

    chrome.storage.local.get(["settings", "accounts", "last_roles", "pinned_accounts"], async function(result) {
        const settings = result.settings || {};
        const accountsRoot = result.accounts || {};
        lastRoles = result.last_roles || {};
        pinned = result.pinned_accounts || {};

        if (settings.okta_domain !== undefined) {
            document.getElementById("okta_domain").value = settings.okta_domain;
        }

        document.getElementById("open_tab_on_switch").checked = settings.open_tab_on_switch !== false;

        render_apps_list(settings);
        render_app_tabs(settings, accountsRoot);

        // Default to Home when apps are configured, otherwise open Settings.
        showView(getApps(settings).length > 0 ? "home" : "settings");
    });

    update_login_status();
}

// ---- AWS apps settings editor -----------------------------------------

function render_apps_list(settings) {
    const container = document.getElementById("aws_apps_list");
    container.innerHTML = "";
    const apps = getApps(settings);

    apps.forEach(app => {
        const item = elt("div", "aws_app_item");
        item.dataset.id = app.id;

        const header = elt("div", "aws_app_header");

        const labelInput = elt("input", "text_setting_value app_label_input");
        labelInput.placeholder = "Label";
        labelInput.spellcheck = false;
        labelInput.value = app.label || "";
        labelInput.addEventListener("focusout", () => save_app_field(app.id, "label", labelInput.value));
        header.appendChild(labelInput);

        const badge = elt("span", "region_badge" + (app.region === "govcloud" ? " gov" : ""));
        badge.innerText = app.region === "govcloud" ? "GovCloud" : "Commercial";
        header.appendChild(badge);

        const del = elt("button", "app_delete");
        del.type = "button";
        del.title = "Remove this AWS app";
        del.setAttribute("aria-label", "Remove this AWS app");
        del.appendChild(elt("i", "fas fa-times"));
        del.addEventListener("click", () => delete_aws_app(app.id));
        header.appendChild(del);

        item.appendChild(header);

        const urlInput = elt("input", "text_setting_value app_url_input");
        urlInput.placeholder = "App URL (auto-detected)";
        urlInput.spellcheck = false;
        urlInput.value = app.url || "";
        urlInput.addEventListener("focusout", () => save_app_field(app.id, "url", urlInput.value));
        item.appendChild(urlInput);

        container.appendChild(item);
    });
}

function save_app_field(id, field, value) {
    chrome.storage.local.get(["settings"], function(result) {
        const settings = result.settings || {};
        if (!Array.isArray(settings.aws_apps)) settings.aws_apps = [];
        const app = settings.aws_apps.find(a => a.id === id);
        if (!app) return;
        app[field] = value;
        chrome.storage.local.set({ settings: settings }, function() {
            if (field === "label") refresh_tabs();
        });
    });
}

function add_aws_app() {
    chrome.storage.local.get(["settings"], function(result) {
        const settings = result.settings || {};
        if (!Array.isArray(settings.aws_apps)) settings.aws_apps = [];
        const id = newAppId();
        settings.aws_apps.push({ id: id, label: "AWS", url: "", flow_mode: "access_portal", region: "commercial" });
        if (!settings.active_aws_app_id) settings.active_aws_app_id = id;
        chrome.storage.local.set({ settings: settings }, function() {
            render_apps_list(settings);
            refresh_tabs();
        });
    });
}

function delete_aws_app(id) {
    if (!confirm("Delete this AWS app and all of its saved accounts?")) return;
    chrome.storage.local.get(["settings", "accounts"], function(result) {
        const settings = result.settings || {};
        settings.aws_apps = getApps(settings).filter(a => a.id !== id);
        if (settings.active_aws_app_id === id) {
            settings.active_aws_app_id = (settings.aws_apps[0] || {}).id || null;
        }
        const accounts = result.accounts || {};
        delete accounts[id];
        chrome.storage.local.set({ settings: settings, accounts: accounts }, function() {
            render_apps_list(settings);
            render_app_tabs(settings, accounts);
        });
    });
}

// ---- Per-app account tabs ---------------------------------------------

// Redraw from storage, keeping search, collapsed tabs and focus.
function rerender() {
    const focused = document.activeElement && document.activeElement.closest(".account");
    const focusKey = focused ? focused.dataset.appId + "\n" + focused.dataset.name : null;
    const collapsed = Array.from(document.querySelectorAll(".app_tab.collapsed")).map(s => s.dataset.id);

    chrome.storage.local.get(["settings", "accounts", "last_roles", "pinned_accounts"], function(result) {
        const settings = result.settings || {};
        lastRoles = result.last_roles || {};
        pinned = result.pinned_accounts || {};
        render_apps_list(settings);
        render_app_tabs(settings, result.accounts || {});
        collapsed.forEach(id => {
            const s = document.querySelector('.app_tab[data-id="' + id + '"]');
            if (s) s.classList.add("collapsed");
        });
        apply_search(document.getElementById("account_search").value);
        if (focusKey) {
            const a = Array.from(document.querySelectorAll("#app_tabs .account"))
                .find(x => x.dataset.appId + "\n" + x.dataset.name === focusKey);
            if (a) a.focus();
        }
        update_accounts_status();
    });
}

function refresh_tabs() {
    chrome.storage.local.get(["settings", "accounts"], function(result) {
        render_app_tabs(result.settings || {}, result.accounts || {});
    });
}

function render_app_tabs(settings, accountsRoot) {
    const container = document.getElementById("app_tabs");
    container.innerHTML = "";
    getApps(settings).forEach(app => {
        const items = (accountsRoot && accountsRoot[app.id]) || {};
        container.appendChild(build_app_tab(app, items));
    });
}

function build_app_tab(app, items) {
    const section = elt("div", "collapsible-section app_tab");
    section.dataset.id = app.id;

    const header = elt("div", "collapsible-header");

    const titleGroup = elt("div", "app_title_group");
    const title = elt("span", "collapsible-title");
    title.innerText = appDisplayName(app);
    titleGroup.appendChild(title);

    const refreshBtn = elt("button", "app_refresh_btn");
    refreshBtn.type = "button";
    refreshBtn.title = "Refresh accounts";
    refreshBtn.setAttribute("aria-label", "Refresh accounts");
    refreshBtn.appendChild(elt("i", "fas fa-sync-alt"));
    refreshBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        trigger_get_accounts(app.id, refreshBtn);
    });
    header.appendChild(titleGroup);

    const actions = elt("div", "app_tab_actions");
    actions.appendChild(refreshBtn);

    const loginAllBtn = elt("button", "app_login_all_btn");
    loginAllBtn.type = "button";
    loginAllBtn.title = "Log in to all accounts";
    loginAllBtn.setAttribute("aria-label", "Log in to all accounts");
    loginAllBtn.appendChild(elt("i", "fas fa-bolt"));
    loginAllBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        trigger_login_all(app.id, loginAllBtn);
    });
    actions.appendChild(loginAllBtn);

    const logoutAllBtn = elt("button", "app_logout_all_btn");
    logoutAllBtn.type = "button";
    logoutAllBtn.title = "Log out of all accounts";
    logoutAllBtn.setAttribute("aria-label", "Log out of all accounts");
    logoutAllBtn.appendChild(elt("i", "fas fa-right-from-bracket"));
    logoutAllBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        trigger_logout_all(app.id, logoutAllBtn);
    });
    actions.appendChild(logoutAllBtn);

    actions.appendChild(elt("i", "fas fa-chevron-down chevron"));
    header.appendChild(actions);

    header.addEventListener("click", () => toggleCollapse(section));
    section.appendChild(header);

    const content = elt("div", "collapsible-content app_tab_content");

    const load = elt("div", "app_load");
    const loader = elt("div", "modern-loader");
    loader.appendChild(elt("div", "loader-ring"));
    load.appendChild(loader);
    load.appendChild(elt("span", "app_load_span"));
    const dismiss = elt("button", "app_load_dismiss");
    dismiss.type = "button";
    dismiss.innerText = "\u00d7";
    dismiss.title = "Dismiss";
    dismiss.addEventListener("click", function() {
        chrome.storage.local.remove("accounts_status", function() {
            load.classList.remove("error", "success");
            load.style.display = "none";
        });
    });
    load.appendChild(dismiss);
    content.appendChild(load);

    const list = elt("div", "app_accounts");
    content.appendChild(list);
    render_app_accounts(list, items, app);

    section.appendChild(content);
    return section;
}

const ROLE_LABELS = { AdministratorAccess: "Admin", PowerUserAccess: "Power", ReadOnlyAccess: "RO" };
const ROLE_ORDER = ["AdministratorAccess", "PowerUserAccess", "ReadOnlyAccess"];
let lastRoles = {};
let pinned = {};

function roleRank(role) {
    const i = ROLE_ORDER.indexOf(role);
    return i === -1 ? ROLE_ORDER.length : i;
}

// Group "name/role" keys into one entry per account.
function groupAccounts(items) {
    const byName = {};
    Object.keys(items).forEach(key => {
        const i = key.indexOf('/');
        const name = key.slice(0, i);
        const acc = byName[name] = byName[name] || { name: name, id: "", roles: [] };
        acc.id = acc.id || items[key].id || "";
        acc.roles.push({ role: key.slice(i + 1), status: items[key].status, key: key });
    });
    Object.values(byName).forEach(a => a.roles.sort((x, y) =>
        roleRank(x.role) - roleRank(y.role) || x.role.localeCompare(y.role)));
    return Object.values(byName);
}

function minutesLeft(expSec) {
    const min = Math.floor((expSec * 1000 - Date.now()) / 60000);
    return min > 0 ? min : null;
}

function render_app_accounts(listEl, items, app) {
    listEl.innerHTML = "";
    const appLast = lastRoles[app.id] || {};
    const appPinned = pinned[app.id] || [];
    const accounts = groupAccounts(items).sort((a, b) =>
        appPinned.includes(b.name) - appPinned.includes(a.name) || a.name.localeCompare(b.name));

    accounts.forEach(acc => {
        const isPinned = appPinned.includes(acc.name);
        const row_div = elt('div', 'row');
        row_div.dataset.search = (acc.name + " " + acc.id).toLowerCase();

        const account_div = elt('div', 'account');
        account_div.tabIndex = 0;
        account_div.dataset.appId = app.id;
        account_div.dataset.name = acc.name;
        account_div.addEventListener("click", (e) => switch_role(account_div, e.metaKey || e.ctrlKey));
        account_div.addEventListener("keydown", row_keydown);
        row_div.appendChild(account_div);

        const top = elt('div', 'account_top');
        const name = elt('div', 'account_name');
        name.innerText = acc.name;
        top.appendChild(name);
        const meta = elt('div', 'account_meta');
        const id = elt('button', 'account_id');
        id.type = "button";
        id.tabIndex = -1;
        id.title = "Copy account id";
        const idText = elt('span');
        idText.innerText = acc.id;
        const idIcon = elt('i', 'far fa-copy');
        id.append(idText, idIcon);
        id.addEventListener("click", (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(acc.id).then(() => {
                id.classList.add("copied");
                idText.innerText = "Copied";
                idIcon.className = "fas fa-check";
                setTimeout(() => {
                    id.classList.remove("copied");
                    idText.innerText = acc.id;
                    idIcon.className = "far fa-copy";
                }, 1200);
            });
        });
        meta.appendChild(id);
        top.appendChild(meta);
        account_div.appendChild(top);

        // Right column: pin on top, logout below.
        const actions = elt('div', 'row_actions');
        const pin = elt('button', 'account_pin' + (isPinned ? ' pinned' : ''));
        pin.type = "button";
        pin.tabIndex = -1;
        pin.title = isPinned ? "Unpin" : "Pin to top";
        pin.setAttribute("aria-label", pin.title);
        pin.appendChild(elt('i', (isPinned ? 'fas' : 'far') + ' fa-star'));
        pin.addEventListener("click", (e) => {
            e.stopPropagation();
            toggle_pin(app.id, acc.name);
        });
        actions.appendChild(pin);

        const chips = elt('div', 'role_chips');
        const selected = pickAccountRole(acc.roles, appLast[acc.name]);
        acc.roles.forEach(r => {
            const chip = elt('button', 'role_chip' + (r.status === "ready" ? " ready" : ""));
            chip.type = "button";
            chip.tabIndex = -1;
            chip.dataset.role = r.role;
            const min = r.status === "ready" ? minutesLeft(items[r.key].expirationDate) : null;
            const left = min && (min >= 60 ? Math.floor(min / 60) + "h " + (min % 60) + "m" : min + "m");
            chip.title = r.role + (left ? " - " + left + " left" : " (" + r.status + ")");
            if (min && min < 15) chip.classList.add("expiring");
            chip.innerText = ROLE_LABELS[r.role] || r.role;
            chip.classList.toggle("selected", r.role === selected);
            chip.addEventListener("click", (e) => {
                e.stopPropagation();
                select_chip(account_div, chip);
                switch_role(account_div, e.metaKey || e.ctrlKey);
            });
            chips.appendChild(chip);
        });
        account_div.appendChild(chips);

        const readyKeys = acc.roles.filter(r => r.status === "ready").map(r => r.key);
        if (readyKeys.length) {
            const logoutBtn = elt("button", "account_logout_btn");
            logoutBtn.type = "button";
            logoutBtn.tabIndex = -1;
            logoutBtn.title = "Log out of this account";
            logoutBtn.setAttribute("aria-label", "Log out of this account");
            logoutBtn.appendChild(elt("i", "fas fa-right-from-bracket"));
            logoutBtn.addEventListener("click", (e) => logout_account(e, app.id, readyKeys));
            actions.appendChild(logoutBtn);
        }
        row_div.appendChild(actions);

        listEl.appendChild(row_div);
    });
}

function select_chip(accountDiv, chip) {
    accountDiv.querySelectorAll(".role_chip").forEach(c => c.classList.toggle("selected", c === chip));
}

// ---- Search + keyboard ------------------------------------------------

function visibleRows() {
    return Array.from(document.querySelectorAll("#app_tabs .account"))
        .filter(a => a.offsetParent !== null && !a.closest(".collapsed"));
}

function apply_search(query) {
    const q = query.trim().toLowerCase();
    document.querySelectorAll("#app_tabs .row").forEach(row => {
        row.style.display = !q || row.dataset.search.includes(q) ? "" : "none";
    });
    if (q) document.querySelectorAll("#app_tabs .collapsed").forEach(s => s.classList.remove("collapsed"));
}

function search_keydown(e) {
    if (e.key === "ArrowDown" || e.key === "Enter") {
        const rows = visibleRows();
        if (!rows.length) return;
        e.preventDefault();
        if (e.key === "Enter" && rows.length === 1) switch_role(rows[0], e.metaKey || e.ctrlKey);
        else rows[0].focus();
    } else if (e.key === "Escape" && e.target.value) {
        e.preventDefault();
        e.target.value = "";
        apply_search("");
    }
}

function row_keydown(e) {
    const row = e.currentTarget;
    const search = document.getElementById("account_search");
    const chips = Array.from(row.querySelectorAll(".role_chip"));
    const cur = chips.findIndex(c => c.classList.contains("selected"));

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const rows = visibleRows();
        const i = rows.indexOf(row) + (e.key === "ArrowDown" ? 1 : -1);
        if (i < 0) search.focus();
        else if (rows[i]) rows[i].focus();
    } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && chips.length) {
        e.preventDefault();
        const n = (cur + (e.key === "ArrowRight" ? 1 : -1) + chips.length) % chips.length;
        select_chip(row, chips[n]);
    } else if (/^[1-9]$/.test(e.key) && chips[+e.key - 1]) {
        e.preventDefault();
        select_chip(row, chips[+e.key - 1]);
    } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        switch_role(row, e.metaKey || e.ctrlKey);
    } else if (e.key === "Escape") {
        e.preventDefault();
        search.value = "";
        apply_search("");
        search.focus();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        search.focus(); // keep typing into the search box
    }
}

function trigger_get_accounts(appId, btn) {
    statusAppId = appId;
    btn.disabled = true;
    safeSendMessage({ "method": "getAllAccounts", "appId": appId });
}

function trigger_login_all(appId, btn) {
    statusAppId = appId;
    btn.classList.add('spinning');
    btn.disabled = true;
    safeSendMessage({ "method": "loginAllAccounts", "appId": appId });
}

function trigger_logout_all(appId, btn) {
    statusAppId = appId;
    btn.disabled = true;
    safeSendMessage({ "method": "logoutAllAccounts", "appId": appId });
}

function logout_account(e, appId, keys) {
    e.stopPropagation();
    e.currentTarget.disabled = true;
    statusAppId = appId;
    safeSendMessage({ "method": "expireAccount", "accounts": keys, "appId": appId });
}

function toggle_pin(appId, name) {
    const list = pinned[appId] = pinned[appId] || [];
    const i = list.indexOf(name);
    if (i === -1) list.push(name); else list.splice(i, 1);
    chrome.storage.local.set({ pinned_accounts: pinned }, rerender);
}

function switch_role(accountDiv, newTab) {
    const chip = accountDiv.querySelector(".role_chip.selected");
    if (!chip || Date.now() < busyUntil) return;
    const appId = accountDiv.dataset.appId;
    const name = accountDiv.dataset.name;
    const role = chip.dataset.role;

    lastRoles[appId] = lastRoles[appId] || {};
    lastRoles[appId][name] = role;
    chrome.storage.local.set({ last_roles: lastRoles });

    statusAppId = appId;
    safeSendMessage({ "method": "changeAccount", "account": name + "/" + role, "appId": appId, "newTab": !!newTab })
        .catch(() => {
            alert('Failed to switch account. Please try again.');
        });
}

chrome.runtime.onMessage.addListener(function(request, _sender, _sendResponse) {
    if (request.method === "UpdatePopup") {
        rerender();
    }
    else if (request.method === "UpdateLoginStatus") {
        update_login_status();
    }
    else if (request.method === "UpdateAccountsStatus") {
        update_accounts_status();
    }
});

async function save_setting(e) {
    const target = e.currentTarget;
    chrome.storage.local.get(["settings"], async function(result) {
        if (result.settings === undefined) {
            result.settings = {};
        }
        if (target.value !== "") {
            result.settings[target.id] = target.value;
        } else {
            delete result.settings[target.id];
        }
        chrome.storage.local.set(result);
    });
}

function save_open_tab_pref(e) {
    const enabled = e.currentTarget.checked;
    chrome.storage.local.get(["settings"], function(result) {
        const settings = result.settings || {};
        settings.open_tab_on_switch = enabled;
        chrome.storage.local.set({ settings: settings });
    });
}

// Custom Okta domains (not *.okta.com etc.) need a runtime host grant.
function ensure_okta_permission() {
    const domain = (document.getElementById("okta_domain").value || "").trim();
    if (!domain || /(^|\.)(okta|okta-emea|oktapreview)\.com$/.test(domain)) return Promise.resolve(true);
    return chrome.permissions.request({ origins: ["https://" + domain + "/*"] }).catch(() => false);
}

async function okta_login() {
    if (!(await ensure_okta_permission())) {
        document.getElementById("login_status_div").style.display = "block";
        document.getElementById("login_status").innerText = "Access to the Okta domain was not granted.";
        document.getElementById("login_status").className = "red";
        return;
    }
    const status_div = document.getElementById("login_status_div");
    const status_span = document.getElementById("login_status");
    const login_button = document.querySelector("button#okta_login");
    const login_button_span = login_button.querySelector("span");

    status_div.style.display = "block";
    status_span.innerText = "Starting login...";
    status_span.className = "";
    login_button_span.innerText = "";
    login_button_span.className = "loading-spinner";
    login_button.disabled = true;

    safeSendMessage({"method": "loginOkta"});
}

function update_login_status() {
    chrome.storage.local.get(["login_status"], function(storage) {
        if (storage.login_status === undefined) {return}
        const status_div = document.getElementById("login_status_div");
        const status_span = document.getElementById("login_status");
        const login_button = document.querySelector("button#okta_login");
        const login_button_span = login_button.querySelector("span");

        status_div.style.display = "block";
        status_span.innerText = storage.login_status.message;

        if (storage.login_status.status === "failed") {
            status_span.className = "red";
            login_button_span.innerText = "Login";
            login_button_span.className = "";
            login_button.disabled = false;
        }
        else if (storage.login_status.status === "success") {
            status_span.className = "green";
            login_button_span.innerText = "Login";
            login_button_span.className = "";
            login_button.disabled = false;
        }
        else if (storage.login_status.status === "progress") {
            status_span.className = "";
            login_button_span.innerText = "";
            login_button_span.className = "loading-spinner";
            login_button.disabled = true;
        } else {
            status_span.className = "";
            login_button_span.innerText = "Login";
            login_button_span.className = "";
            login_button.disabled = false;
        }
    });
}

function update_accounts_status() {
    chrome.storage.local.get(["accounts_status"], function(storage) {
        if (storage.accounts_status === undefined || !statusAppId) {return}

        const section = document.querySelector('.app_tab[data-id="' + statusAppId + '"]');
        if (!section) return;

        const loadDiv = section.querySelector(".app_load");
        const span = section.querySelector(".app_load_span");
        const buttons = section.querySelectorAll(".app_refresh_btn, .app_login_all_btn, .app_logout_all_btn");
        if (span) span.innerText = storage.accounts_status.message;

        const resetButton = () => {
            buttons.forEach(b => {
                b.classList.remove('spinning');
                b.disabled = false;
            });
        };

        const st = storage.accounts_status.status;
        clearTimeout(loadDiv._hide);
        busyUntil = st === "progress" ? Date.now() + 90000 : 0;
        loadDiv.classList.toggle("error", st === "failed");
        loadDiv.classList.toggle("success", st === "success");
        loadDiv.style.display = (st === "progress" || st === "failed" || st === "success") ? "flex" : "none";
        if (st === "progress") {
            buttons.forEach(b => { b.classList.add('spinning'); b.disabled = true; });
        } else {
            resetButton();
        }
        if (st === "success") {
            loadDiv._hide = setTimeout(() => { loadDiv.style.display = "none"; }, 2000);
        }
    });
}
