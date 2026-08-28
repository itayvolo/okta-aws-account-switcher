window.addEventListener("load", load_popup);

// Tracks which app tab a pending accounts_status update belongs to.
let statusAppId = null;

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
    homeBtn.classList.toggle("active", !settings);
    settingsBtn.classList.toggle("active", settings);
}

function init_popup() {
    document.getElementById('nav_home').addEventListener("click", () => showView("home"));
    document.getElementById('nav_settings').addEventListener("click", () => showView("settings"));
    document.getElementById('okta_login').addEventListener("click", okta_login);

    document.getElementById("okta_domain").addEventListener("focusout", save_setting);
    document.getElementById("open_tab_on_switch").addEventListener("change", save_open_tab_pref);

    document.getElementById("add_aws_app").addEventListener("click", add_aws_app);

    chrome.storage.local.get(["settings", "accounts"], async function(result) {
        const settings = result.settings || {};
        const accountsRoot = result.accounts || {};

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
        labelInput.placeholder = "Label (e.g. Commercial, GovCloud)";
        labelInput.spellcheck = false;
        labelInput.value = app.label || "";
        labelInput.addEventListener("focusout", () => save_app_field(app.id, "label", labelInput.value));
        header.appendChild(labelInput);

        const del = elt("button", "app_delete");
        del.type = "button";
        del.title = "Remove this AWS app";
        del.setAttribute("aria-label", "Remove this AWS app");
        del.appendChild(elt("i", "fas fa-times"));
        del.addEventListener("click", () => delete_aws_app(app.id));
        header.appendChild(del);

        item.appendChild(header);

        const urlInput = elt("input", "text_setting_value");
        urlInput.placeholder = "Optional - auto-detected from Okta";
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
    titleGroup.appendChild(refreshBtn);
    header.appendChild(titleGroup);

    const actions = elt("div", "app_tab_actions");

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
    dismiss.innerText = "Dismiss";
    dismiss.addEventListener("click", function() {
        chrome.storage.local.remove("accounts_status", function() {
            load.classList.remove("error");
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

function render_app_accounts(listEl, items, app) {
    listEl.innerHTML = "";
    const allKeys = Object.keys(items);

    for (let i = 0; i < allKeys.length; i++) {
        const row_div = elt('div', 'row');

        const account_div = elt('div', 'account');
        account_div.id = allKeys[i];
        account_div.dataset.appId = app.id;
        account_div.addEventListener("click", account_change);
        row_div.appendChild(account_div);

        const account_name_role_div = document.createElement('div');
        account_name_role_div.id = "account_name_role";
        account_div.appendChild(account_name_role_div);

        const account_name_div = document.createElement('div');
        account_name_div.innerText = allKeys[i].split('/')[0];
        account_name_div.id = "account_name";
        account_name_role_div.appendChild(account_name_div);

        const account_role_div = document.createElement('div');
        account_role_div.id = "account_role";
        account_role_div.innerText = allKeys[i].split('/')[1];
        account_name_role_div.appendChild(account_role_div);

        const info_div = document.createElement('div');
        info_div.id = "status_div";
        account_div.appendChild(info_div);

        const status = items[allKeys[i]].status;
        const status_div = document.createElement('div');
        status_div.id = "status";
        status_div.innerText = status;
        status_div.classList.add(status === "ready" ? "green" : "red");
        info_div.appendChild(status_div);

        const account_id_div = elt('div', 'status');
        account_id_div.innerText = items[allKeys[i]].id;
        info_div.appendChild(account_id_div);

        if (status === "ready") {
            const logoutBtn = elt("button", "account_logout_btn");
            logoutBtn.type = "button";
            logoutBtn.title = "Log out of this account";
            logoutBtn.setAttribute("aria-label", "Log out of this account");
            logoutBtn.dataset.account = allKeys[i];
            logoutBtn.dataset.appId = app.id;
            logoutBtn.appendChild(elt("i", "fas fa-right-from-bracket"));
            logoutBtn.addEventListener("click", logout_account);
            row_div.appendChild(logoutBtn);
        }

        listEl.appendChild(row_div);
    }
}

function trigger_get_accounts(appId, btn) {
    statusAppId = appId;
    btn.classList.add('spinning');
    btn.disabled = true;

    safeSendMessage({ "method": "getAllAccounts", "appId": appId });

    setTimeout(() => {
        btn.classList.remove('spinning');
        btn.disabled = false;
    }, 10000);
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

function logout_account(e) {
    e.stopPropagation();
    const target = e.currentTarget;
    const account = target.dataset.account;
    const appId = target.dataset.appId;
    if (!account) return;
    target.disabled = true;
    statusAppId = appId;
    safeSendMessage({ "method": "expireAccount", "account": account, "appId": appId });
}

function account_change(e) {
    const target = e.currentTarget;
    const account = target.id;
    const appId = target.dataset.appId;
    if (!account) return;

    statusAppId = appId;
    safeSendMessage({ "method": "changeAccount", "account": account, "appId": appId })
        .catch(() => {
            alert('Failed to switch account. Please try again.');
        });
}

chrome.runtime.onMessage.addListener(function(request, _sender, _sendResponse) {
    if (request.method === "UpdatePopup") {
        location.reload();
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

function okta_login() {
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

        if (storage.accounts_status.status === "success") {
            loadDiv.style.display = "none";
            loadDiv.classList.remove("error");
            resetButton();
        }
        else if (storage.accounts_status.status === "failed") {
            loadDiv.style.display = "flex";
            loadDiv.classList.add("error");
            resetButton();
        }
        else if (storage.accounts_status.status === "progress") {
            loadDiv.style.display = "flex";
            loadDiv.classList.remove("error");
            buttons.forEach(b => { b.classList.add('spinning'); b.disabled = true; });
        }
        else {
            loadDiv.style.display = "none";
            loadDiv.classList.remove("error");
            resetButton();
        }
    });
}
