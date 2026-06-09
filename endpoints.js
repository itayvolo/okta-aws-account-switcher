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

function upsertAwsAppInSettings(settings, app) {
    if (!Array.isArray(settings.aws_apps)) settings.aws_apps = [];
    const existing = settings.aws_apps.find(a => a.url === app.url);
    if (existing) {
        if (app.label) existing.label = app.label;
    } else {
        settings.aws_apps.push({
            id: generateAppId(),
            label: app.label || "AWS",
            url: app.url,
            flow_mode: app.flow_mode || "access_portal",
            region: app.region || "commercial"
        });
    }
    if (!settings.active_aws_app_id && settings.aws_apps.length > 0) {
        settings.active_aws_app_id = settings.aws_apps[0].id;
    }
    return settings.aws_apps;
}

const EndpointUtils = {
    REGION_PRESETS,
    presetForApp,
    cookieApex,
    generateAppId,
    migrateSettings,
    upsertAwsAppInSettings,
    SCHEMA_VERSION
};

if (typeof window !== 'undefined') {
    window.EndpointUtils = EndpointUtils;
}

if (typeof self !== 'undefined' && typeof window === 'undefined') {
    self.EndpointUtils = EndpointUtils;
}
