// AWS Account Switcher - Service Worker

importScripts('endpoints.js', 'okta.js', 'aws_login.js', 'accounts.js');

// Debug mode - set to true to enable console logging
const DEBUG_MODE = false;

// Debug logging helper - only logs when DEBUG_MODE is true
function debugLog(...args) {
    if (DEBUG_MODE) {
        console.log(...args);
    }
}

// Helper to check for Chrome API errors
function checkLastError(context) {
    if (chrome.runtime.lastError) {
        debugLog(`Chrome API error (${context}):`, chrome.runtime.lastError.message);
        return true;
    }
    return false;
}

// Constants
const KEEP_ALIVE_INTERVAL_MS = 20000;
const LOGIN_MONITOR_INTERVAL_MS = 1000;
const OAUTH2_MONITOR_INTERVAL_MS = 500;
const LOGIN_TIMEOUT_MS = 30000;
const OAUTH2_TIMEOUT_MS = 60000;
const MANUAL_LOGIN_TIMEOUT_MS = 300000;
const SESSION_EXPIRATION_HOURS = 9;
const ALARM_DELAY_MINUTES = 1.0;
const ALARM_PERIOD_MINUTES = 3.0;

let keepAliveInterval;

// Helper function to get decrypted password from storage

// Helper function to remove AWS cookies
function removeAwsCookies(cookies, skipNoflush = true) {
    cookies.forEach(cookie => {
        if (skipNoflush && cookie.name === "noflush_awscnm") return;
        const domainMatch = cookie.domain.match(/^\.?(.+)$/);
        if (!domainMatch) return;
        const domain = domainMatch[1];
        chrome.cookies.remove({
            name: cookie.name,
            url: "https://" + domain + cookie.path,
            storeId: cookie.storeId
        });
    });
}

// Reload open console tabs so they reflect a logout right away.
function reloadConsoleTabs(preset) {
    chrome.tabs.query({"url": "*://*." + preset.consoleHost + "/*"}, tabs => {
        tabs.forEach(t => chrome.tabs.reload(t.id));
    });
}

function startKeepAlive() {
    keepAliveInterval = setInterval(() => {
        chrome.storage.local.get(['_keepalive'], () => {
            // This will keep the service worker alive
        });
    }, KEEP_ALIVE_INTERVAL_MS); // Every 20 seconds
}

function stopKeepAlive() {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }
}

function persistAppFields(appId, fields, cb) {
    chrome.storage.local.get(["settings"], (s) => {
        const settings = s.settings || {};
        const apps = Array.isArray(settings.aws_apps) ? settings.aws_apps : [];
        const app = apps.find(a => a.id === appId);
        if (!app) { if (cb) cb(null, presetForApp(null)); return; }
        let changed = false;
        Object.keys(fields).forEach(k => {
            if (fields[k] !== undefined && app[k] !== fields[k]) { app[k] = fields[k]; changed = true; }
        });
        if (!changed) { if (cb) cb(app, presetForApp(app)); return; }
        chrome.storage.local.set({ settings: settings }, () => {
            safeSendMessage({"method": "UpdatePopup"});
            if (cb) cb(app, presetForApp(app));
        });
    });
}

function getActiveApp(cb, statusKey = "accounts_status", preferredId = null) {
    chrome.storage.local.get(["settings"], (s) => {
        const settings = s.settings || {};
        const apps = Array.isArray(settings.aws_apps) ? settings.aws_apps : [];
        const app = (preferredId && apps.find(a => a.id === preferredId)) ||
                    apps.find(a => a.id === settings.active_aws_app_id) ||
                    apps[0];
        if (!app) {
            const update = {};
            update[statusKey] = {"status": "failed", "message": "No AWS app configured. Add one in Settings."};
            chrome.storage.local.set(update);
            safeSendMessage({"method": statusKey === "login_status" ? "UpdateLoginStatus" : "UpdateAccountsStatus"});
            return;
        }
        cb(app, presetForApp(app));
    });
}

// Start keepalive when service worker starts
startKeepAlive();

migrateSettings();

// Listen for extension startup
chrome.runtime.onStartup.addListener(() => {
    debugLog('Extension startup - starting keepalive');
    startKeepAlive();
    migrateSettings();
});

// Listen for extension install
chrome.runtime.onInstalled.addListener(() => {
    debugLog('Extension installed - starting keepalive');
    startKeepAlive();
    migrateSettings();
});

function safeSendMessage(message) {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage(message)
                .then(() => {
                    resolve();
                })
                .catch((error) => {
                    // Popup is not open or connection failed, continuing in background
                    if (error.message.includes('Could not establish connection')) {
                        // This is expected when popup is closed, don't log as error
                        debugLog("Popup not open - message not sent:", message.method);
                    } else {
                        debugLog("Message send error:", error.message);
                    }
                    resolve(); // Always resolve to continue background operations
                });
        } catch (e) {
            debugLog("Exception sending message:", e.message);
            resolve();
        }
    });
}

chrome.runtime.onMessage.addListener( function(request, _sender, _sendResponse) {
    debugLog('Background received message:', request);
    
    if (request.method === "changeAccount") {
        debugLog('Processing changeAccount for:', request.account, 'app:', request.appId);
        const [accName, accRole] = [request.account.slice(0, request.account.indexOf('/')), request.account.slice(request.account.indexOf('/') + 1)];
        chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Switching to " + accName + " (" + accRole + ")..."}})
        safeSendMessage({"method": "UpdateAccountsStatus"});
        getActiveApp(function(app, preset) {
            chrome.storage.local.get(["accounts"], function(result){
                const appAccounts = (result.accounts && result.accounts[app.id]) || undefined;
                if (appAccounts === undefined) {
                    console.error('No accounts found in storage for app', app.id);
                    chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "No accounts found in storage."}})
                    safeSendMessage({"method": "UpdateAccountsStatus"});
                    return;
                }
                if (appAccounts[request.account] === undefined) {
                    console.error('Account not found:', request.account, 'Available accounts:', Object.keys(appAccounts));
                    chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "No such account " + request.account}})
                    safeSendMessage({"method": "UpdateAccountsStatus"});
                    return;
                }

                const accountData = appAccounts[request.account];
                debugLog('Account data for', request.account, ':', accountData);

                if (accountData.status === "expired") {
                    debugLog('Account is expired, attempting login...');
                    login(app, preset, request.account, () => getActiveApp((a, p) => refresh_all_aws_tabs(p)), false, request.newTab);
                } else {
                    debugLog('Account is ready, changing account...');
                    change_account(app, preset, request.account, request.newTab);
                }
            });
        }, "accounts_status", request.appId);
    }
    else if (request.method === "loginOkta") {
        okta_login();
    }
    else if (request.method === "getAllAccounts") {
        get_all_accounts(request.appId);
    }
    else if (request.method === "loginAllAccounts") {
        login_all_accounts(request.appId);
    }
    else if (request.method === "logoutAllAccounts") {
        logout_all_accounts(request.appId);
    }
    else if (request.method === "loadOktaApps") {
        loadOktaApps();
    }
    else if (request.method === "expireAccount") {
        // Clear AWS cookies to log out and expire the account
        debugLog('Expiring account:', request.account, 'app:', request.appId);
        getActiveApp(function(app, preset) {
            chrome.cookies.getAll({"domain": preset.cookieDomain}, function(cookies_to_remove) {
                removeAwsCookies(cookies_to_remove);

                // Update account status to expired and drop its cached cookies.
                chrome.storage.local.get(["accounts"], function(result) {
                    const appAccounts = result.accounts && result.accounts[app.id];
                    const keys = (request.accounts || [request.account]).filter(k => appAccounts && appAccounts[k]);
                    if (!keys.length) return;
                    keys.forEach(k => {
                        appAccounts[k].status = "expired";
                        delete appAccounts[k].cookies;
                    });
                    chrome.storage.local.set(result, function() {
                        debugLog('Accounts expired and cookies cleared:', keys);
                        reloadConsoleTabs(preset);
                        const name = keys[0].slice(0, keys[0].indexOf('/'));
                        chrome.storage.local.set({"accounts_status": {"status": "success", "message": "Logged out of " + name + "."}});
                        safeSendMessage({"method": "UpdateAccountsStatus"});
                        safeSendMessage({"method": "UpdatePopup"});
                    });
                });
            });
        }, "accounts_status", request.appId);
    }
});

function registerAlarms(alarmName) {
    chrome.alarms.getAll(function(alarms) {
        var hasAlarm = alarms.some(function(a) {
            return a.name === alarmName;
        });
        if (hasAlarm) {
            chrome.alarms.clear(alarmName, function(){
                chrome.alarms.create(alarmName, {delayInMinutes: ALARM_DELAY_MINUTES, periodInMinutes: ALARM_PERIOD_MINUTES});
            });
        } else {
            chrome.alarms.create(alarmName, {delayInMinutes: ALARM_DELAY_MINUTES, periodInMinutes: ALARM_PERIOD_MINUTES});
        }
    })
}

chrome.alarms.onAlarm.addListener(function(alarm) {
    if (alarm.name === "checkExpire") {
        checkExpire();
    }
});

chrome.idle.onStateChanged.addListener(function(state) {
    if (state === "active") {
        registerAlarms("checkExpire");
    }
});

registerAlarms("checkExpire");

chrome.storage.local.remove("accounts_status");
chrome.storage.local.remove("login_status");

// Service worker lifecycle handlers
self.addEventListener('install', function(event) {
    self.skipWaiting();
});

self.addEventListener('activate', function(event) {
    event.waitUntil(self.clients.claim());
});
