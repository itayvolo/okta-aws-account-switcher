const REGION_PRESETS = {
    commercial: {
        label: "Commercial",
        consoleHost: "console.aws.amazon.com",
        cookieDomain: ".amazon.com",
        signinSamlUrl: "https://signin.aws.amazon.com/saml",
        portalStartPattern: "^https://([^/]+\\.awsapps\\.com)/start",
        consoleCreateUrl: "https://console.aws.amazon.com/"
    },
    govcloud: {
        label: "GovCloud",
        consoleHost: "console.amazonaws-us-gov.com",
        cookieDomain: ".amazonaws-us-gov.com",
        signinSamlUrl: "https://signin.amazonaws-us-gov.com/saml",
        portalStartPattern: "^https://([^/]+\\.awsapps(?:-us-gov)?\\.com)/start",
        consoleCreateUrl: "https://console.amazonaws-us-gov.com/"
    }
};

function presetForApp(app) {
    return REGION_PRESETS[app && app.region] || REGION_PRESETS.commercial;
}

function cookieApex(cookieDomain) {
    return (cookieDomain || ".amazon.com").replace(/^\./, "");
}

function generateAppId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return "app-" + Date.now() + "-" + Math.random().toString(36).slice(2);
}

const SCHEMA_VERSION = 2;

function migrateSettings(callback) {
    chrome.storage.local.get(["settings", "accounts"], (result) => {
        let settings = result.settings;
        let accounts = result.accounts;

        const alreadyMigrated = settings && settings._schema_v >= SCHEMA_VERSION;

        if (settings === undefined) settings = {};

        // The extension no longer stores credentials — purge any that linger from
        // older versions (idempotent, runs regardless of schema version).
        let purged = false;
        if (settings.okta_password !== undefined) { delete settings.okta_password; purged = true; }
        if (settings.okta_username !== undefined) { delete settings.okta_username; purged = true; }
        if (purged) chrome.storage.local.remove("_crypto_salts");

        if (alreadyMigrated) {
            if (purged) {
                chrome.storage.local.set({ settings: settings }, () => {
                    if (callback) callback(settings, accounts);
                });
            } else if (callback) {
                callback(settings, accounts);
            }
            return;
        }

        if (!Array.isArray(settings.aws_apps)) {
            const apps = [];
            let activeId = null;
            if (settings.aws_app && settings.aws_app.url) {
                const id = generateAppId();
                apps.push({
                    id: id,
                    label: settings.aws_app.label || "AWS",
                    url: settings.aws_app.url,
                    flow_mode: settings.aws_flow_mode || "access_portal",
                    region: "commercial"
                });
                activeId = id;
            }
            settings.aws_apps = apps;
            settings.active_aws_app_id = activeId;
        }
        delete settings.aws_app;
        delete settings.aws_flow_mode;

        let newAccounts = accounts;
        if (accounts && Object.keys(accounts).length > 0) {
            if (settings.aws_apps.length === 0) {
                const id = generateAppId();
                settings.aws_apps.push({
                    id: id,
                    label: "AWS",
                    url: "",
                    flow_mode: "access_portal",
                    region: "commercial"
                });
                settings.active_aws_app_id = id;
            }
            const bucketId = settings.active_aws_app_id || settings.aws_apps[0].id;
            newAccounts = { [bucketId]: accounts };
        }

        settings._schema_v = SCHEMA_VERSION;

        const toWrite = { settings: settings };
        if (newAccounts !== undefined) toWrite.accounts = newAccounts;

        chrome.storage.local.set(toWrite, () => {
            if (callback) callback(settings, toWrite.accounts);
        });
    });
}

// The Okta app-instance id (e.g. 0oa1z6rb084Cd33lz1d8) embedded in a linkUrl
// uniquely identifies an AWS app even if the surrounding URL differs.
function appInstanceKey(url) {
    const m = String(url || "").match(/\/(0o[0-9a-zA-Z]+)(?:[/?#]|$)/);
    return m ? m[1] : null;
}

function upsertAwsAppInSettings(settings, app) {
    if (!Array.isArray(settings.aws_apps)) settings.aws_apps = [];
    const apps = settings.aws_apps;
    const key = appInstanceKey(app.url);

    // Already present? Match by exact URL or by Okta app-instance id.
    const existing = apps.find(a => a.url && (a.url === app.url || (key && appInstanceKey(a.url) === key)));
    if (existing) {
        if (app.url) existing.url = app.url;
        if (app.label) existing.label = app.label;
    } else {
        // Adopt a blank placeholder (no URL) instead of creating a duplicate:
        // prefer one whose label matches, else the sole blank entry.
        let target = app.label
            ? apps.find(a => !a.url && a.label && a.label.toLowerCase() === String(app.label).toLowerCase())
            : null;
        if (!target) {
            const blanks = apps.filter(a => !a.url);
            if (blanks.length === 1) target = blanks[0];
        }
        if (target) {
            target.url = app.url;
            if (app.label) target.label = app.label;
            if (!target.flow_mode) target.flow_mode = app.flow_mode || "access_portal";
            if (!target.region) target.region = app.region || "commercial";
        } else {
            apps.push({
                id: generateAppId(),
                label: app.label || "AWS",
                url: app.url,
                flow_mode: app.flow_mode || "access_portal",
                region: app.region || "commercial"
            });
        }
    }
    if (!settings.active_aws_app_id && apps.length > 0) {
        settings.active_aws_app_id = apps[0].id;
    }
    return apps;
}

// Drop leftover blank placeholder apps once at least one real (URL-bearing)
// app exists, so a detected app never leaves a stray empty tab behind.
function pruneBlankApps(settings) {
    if (!settings || !Array.isArray(settings.aws_apps)) return;
    if (!settings.aws_apps.some(a => a.url)) return;
    settings.aws_apps = settings.aws_apps.filter(a => a.url);
    if (!settings.aws_apps.find(a => a.id === settings.active_aws_app_id)) {
        settings.active_aws_app_id = settings.aws_apps[0] ? settings.aws_apps[0].id : null;
    }
}

const EndpointUtils = {
    REGION_PRESETS,
    presetForApp,
    cookieApex,
    generateAppId,
    migrateSettings,
    upsertAwsAppInSettings,
    pruneBlankApps,
    SCHEMA_VERSION
};

if (typeof window !== 'undefined') {
    window.EndpointUtils = EndpointUtils;
}

if (typeof self !== 'undefined' && typeof window === 'undefined') {
    self.EndpointUtils = EndpointUtils;
}
