// AWS Account Switcher - Service Worker

importScripts('endpoints.js');

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

// Auto-detect AWS app from Okta apps list
// Pull the AWS apps out of an Okta "home/tabs" API response, normalized to
// { label, url }. Handles both the flat `apps` shape and the expanded
// `items[].resource` shape.
function extractAwsApps(okta_data) {
    if (!okta_data) return [];

    let allApps = [];
    const collectFromTab = tab => {
        if (Array.isArray(tab.apps)) {
            allApps = allApps.concat(tab.apps);
        }
        if (Array.isArray(tab.items)) {
            tab.items.forEach(it => allApps.push(it.resource || it));
        }
    };

    if (Array.isArray(okta_data)) {
        okta_data.forEach(item => {
            if (Array.isArray(item.apps) || Array.isArray(item.items)) {
                collectFromTab(item);
            } else if (item.linkUrl || item.label) {
                allApps.push(item);
            }
        });
    } else if (okta_data && (Array.isArray(okta_data.apps) || Array.isArray(okta_data.items))) {
        collectFromTab(okta_data);
    }

    return allApps.filter(app => {
        const label = (app.label || app.name || "").toLowerCase();
        const url = (app.linkUrl || app.href || "").toLowerCase();
        return label.includes("aws") || label.includes("amazon") ||
               url.includes("amazon.com") || url.includes("aws.amazon");
    }).map(app => ({
        label: app.label || app.name || "",
        url: app.linkUrl || app.href || ""
    })).filter(a => a.url);
}

// Fetch the AWS apps for the signed-in Okta user directly from the service
// worker (session cookies are sent with credentials:'include'). Returns the
// normalized app list, or null if the request could not be made/parsed.
function fetchOktaAwsApps(okta_domain, cb) {
    const url = "https://" + okta_domain + "/api/v1/users/me/home/tabs?type=all&expand=items%2Citems.resource";
    fetch(url, { method: 'GET', credentials: 'include', headers: { 'Accept': 'application/json' } })
        .then(r => (r.ok ? r.json() : null))
        .then(data => cb(data ? extractAwsApps(data) : null))
        .catch(() => cb(null));
}

// Choose which detected Okta AWS app corresponds to a stored app entry.
// Region narrows the pool (GovCloud vs commercial); label disambiguates the
// rest. Returns null when the choice is genuinely ambiguous.
function pickAppMatch(app, awsApps) {
    if (!awsApps || awsApps.length === 0) return null;

    const isGov = u => /us-gov|govcloud/i.test(u || "");
    const wantGov = app.region === "govcloud";
    let pool = awsApps.filter(a => isGov(a.url) === wantGov);
    if (pool.length === 0) pool = awsApps.slice();
    if (pool.length === 1) return pool[0];

    const want = (app.label || "").trim().toLowerCase();
    if (want) {
        const exact = pool.find(a => a.label.trim().toLowerCase() === want);
        if (exact) return exact;
        const partial = pool.filter(a => {
            const l = a.label.toLowerCase();
            return l.includes(want) || want.includes(l);
        });
        if (partial.length === 1) return partial[0];
    }
    return null;
}

function autoDetectAwsApp(okta_data) {
    debugLog("Auto-detecting AWS app from Okta apps data");

    if (!okta_data) {
        chrome.storage.local.set({
            "login_status": { "status": "failed", "message": "Failed to load Okta apps" }
        });
        safeSendMessage({"method": "UpdateLoginStatus"});
        return;
    }

    const awsApps = extractAwsApps(okta_data);
    debugLog("AWS apps detected:", awsApps.length);

    if (awsApps.length === 0) {
        // No AWS app in the API response; fall back to dashboard detection.
        debugLog("No AWS app found in Okta API response, trying dashboard detection...");
        handlePostLoginAccountLoad();
        return;
    }

    chrome.storage.local.get(["settings"], function(result) {
        if (result.settings === undefined) {
            result.settings = {};
        }
        awsApps.forEach(app => upsertAwsAppInSettings(result.settings, { label: app.label, url: app.url }));

        chrome.storage.local.set(result, function() {
            debugLog("AWS apps merged into settings:", result.settings.aws_apps);
            chrome.storage.local.set({
                "login_status": { "status": "success", "message": "Logged in! Loading accounts..." }
            });
            safeSendMessage({"method": "UpdateLoginStatus"});
            safeSendMessage({"method": "UpdatePopup"});
            setTimeout(() => get_all_accounts(), 500);
        });
    });
}

// Helper function to handle post-login account loading
function handlePostLoginAccountLoad() {
    chrome.action.setBadgeText({text: ""});
    chrome.storage.local.get(["settings"], function(result) {
        const apps = (result.settings && Array.isArray(result.settings.aws_apps)) ? result.settings.aws_apps : [];
        const usableApp = apps.find(a => a && a.url);
        if (usableApp) {
            chrome.storage.local.set({
                "login_status": {
                    "status": "success",
                    "message": "Logged in! Loading accounts..."
                }
            });
            safeSendMessage({"method": "UpdateLoginStatus"});
            // Load the app that actually has a URL (the active one may be a
            // blank manual entry) so we never fall into the no-URL retry loop.
            setTimeout(() => get_all_accounts(usableApp.id), 500);
        } else if (apps.length > 0) {
            // Apps exist but none has a URL. Don't loop trying to detect — the
            // user needs to fill it in (or auto-detection found nothing).
            chrome.storage.local.set({
                "login_status": {
                    "status": "success",
                    "message": "Logged in! Set the AWS App URL in Settings."
                }
            });
            safeSendMessage({"method": "UpdateLoginStatus"});
        } else {
            // Try to detect AWS app from Okta dashboard
            debugLog("No AWS app configured, attempting to detect from dashboard...");
            detectAwsAppFromDashboard();
        }
    });
}

// Detect AWS app URL by scraping the Okta dashboard
function detectAwsAppFromDashboard() {
    chrome.storage.local.get(["settings"], function(storage) {
        if (!storage.settings || !storage.settings.okta_domain) {
            chrome.storage.local.set({
                "login_status": {
                    "status": "success",
                    "message": "Logged in! Please set AWS App URL in settings."
                }
            });
            safeSendMessage({"method": "UpdateLoginStatus"});
            return;
        }

        const dashboardUrl = "https://" + storage.settings.okta_domain + "/app/UserHome";
        debugLog("Opening dashboard to detect AWS app:", dashboardUrl);

        chrome.tabs.create({url: dashboardUrl, active: false}, function(tab) {
            if (chrome.runtime.lastError || !tab) {
                debugLog("Failed to create tab for AWS app detection");
                chrome.storage.local.set({
                    "login_status": {
                        "status": "success",
                        "message": "Logged in! Please set AWS App URL in settings."
                    }
                });
                safeSendMessage({"method": "UpdateLoginStatus"});
                return;
            }

            // Wait for page to load then scrape for AWS app
            setTimeout(() => {
                chrome.scripting.executeScript({
                    target: {tabId: tab.id},
                    func: () => {
                        // Look for AWS app links on the Okta dashboard
                        const links = document.querySelectorAll('a[href*="amazon_aws"], a[href*="amazon-aws"], a[data-se*="aws"], a[data-se*="amazon"]');
                        for (const link of links) {
                            if (link.href && link.href.includes('okta.com')) {
                                return {url: link.href, label: link.textContent || 'AWS'};
                            }
                        }

                        // Also check for app chiclets/tiles
                        const appLinks = document.querySelectorAll('.app-button, .chiclet-link, [data-se="app-card"]');
                        for (const appLink of appLinks) {
                            const href = appLink.href || appLink.querySelector('a')?.href;
                            const text = (appLink.textContent || '').toLowerCase();
                            if (href && (text.includes('aws') || text.includes('amazon') || href.includes('amazon'))) {
                                return {url: href, label: appLink.textContent?.trim() || 'AWS'};
                            }
                        }

                        // Check all links as fallback
                        const allLinks = document.querySelectorAll('a[href*="/home/amazon"]');
                        if (allLinks.length > 0) {
                            return {url: allLinks[0].href, label: 'AWS'};
                        }

                        return null;
                    }
                }).then((results) => {
                    chrome.tabs.remove(tab.id);

                    if (results && results[0] && results[0].result) {
                        const awsApp = results[0].result;
                        debugLog("Detected AWS app from dashboard:", awsApp);

                        chrome.storage.local.get(["settings"], function(result) {
                            if (!result.settings) result.settings = {};
                            upsertAwsAppInSettings(result.settings, {
                                label: awsApp.label,
                                url: awsApp.url
                            });
                            chrome.storage.local.set(result, function() {
                                chrome.storage.local.set({
                                    "login_status": {
                                        "status": "success",
                                        "message": "Logged in! Loading accounts..."
                                    }
                                });
                                safeSendMessage({"method": "UpdateLoginStatus"});
                                safeSendMessage({"method": "UpdatePopup"}); // Refresh popup to show URL
                                setTimeout(() => get_all_accounts(), 500);
                            });
                        });
                    } else {
                        debugLog("Could not detect AWS app from dashboard");
                        chrome.storage.local.set({
                            "login_status": {
                                "status": "success",
                                "message": "Logged in! Please set AWS App URL in settings."
                            }
                        });
                        safeSendMessage({"method": "UpdateLoginStatus"});
                    }
                }).catch(error => {
                    debugLog("Error detecting AWS app:", error.message);
                    chrome.tabs.remove(tab.id);
                    chrome.storage.local.set({
                        "login_status": {
                            "status": "success",
                            "message": "Logged in! Please set AWS App URL in settings."
                        }
                    });
                    safeSendMessage({"method": "UpdateLoginStatus"});
                });
            }, 3000); // Wait 3 seconds for dashboard to load
        });
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

function get_all_accounts(preferredId) {
    chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Retrieving list of AWS accounts..."}})
    safeSendMessage({"method": "UpdateAccountsStatus"});
    getActiveApp(function(app, preset) {
    aws_login(app, preset, function(tab_id, portalHost, app, preset){
        chrome.storage.local.get(["settings"], settings_storage => {
            const flow_mode = app.flow_mode || "access_portal";
            const is_portal = flow_mode === "access_portal";
            const inject = is_portal
                ? { target: {tabId: tab_id}, files: ['get_accounts_portal.js'] }
                : { target: {tabId: tab_id}, files: ['get_accounts.js'] };

            chrome.scripting.executeScript(inject).then((results) => {
                const raw = results[0].result;
                let parsed;
                if (is_portal) {
                    if (!raw || raw.error || !raw.accounts) {
                        const msg = raw && raw.error ? `Failed to get accounts: ${raw.error}` : "Failed to get accounts";
                        chrome.storage.local.set({"accounts_status": {"status": "failed", "message": msg}});
                        safeSendMessage({"method": "UpdateAccountsStatus"});
                        return;
                    }
                    parsed = raw.accounts.map(a => ({
                        account_name: a.accountName + '/' + a.roleName,
                        account_id: a.accountId,
                        role: a.roleName,
                    }));
                } else {
                    if (!raw) {
                        chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "Failed to get accounts"}});
                        safeSendMessage({"method": "UpdateAccountsStatus"});
                        return;
                    }
                    parsed = [];
                    raw.forEach(account => {
                        const matches = account.name.match(/Account: (.+) \(([0-9]+)\)/);
                        if (!matches || matches.length < 3) {
                            console.error('Failed to parse account name:', account.name);
                            return;
                        }
                        parsed.push({
                            account_name: matches[1] + '/' + account.role,
                            account_id: matches[2],
                            role: account.role,
                        });
                    });
                }

                chrome.storage.local.get(["accounts"], accounts_storage => {
                    if (accounts_storage.accounts === undefined) {
                        accounts_storage.accounts = {};
                    }
                    if (accounts_storage.accounts[app.id] === undefined) {
                        accounts_storage.accounts[app.id] = {};
                    }
                    const appAccounts = accounts_storage.accounts[app.id];
                    if (settings_storage.settings === undefined) {settings_storage.settings = {}}
                    if (settings_storage.settings.role_filters === undefined) {settings_storage.settings.role_filters = []}
                    const role_filters = settings_storage.settings.role_filters;
                    parsed.forEach(a => {
                        if (role_filters.length > 0 && role_filters.indexOf(a.role) === -1) {
                            if (appAccounts[a.account_name] !== undefined) {
                                delete appAccounts[a.account_name];
                            }
                        } else {
                            if (appAccounts[a.account_name] === undefined) {
                                appAccounts[a.account_name] = {"id": a.account_id, "status": "expired"};
                            } else {
                                appAccounts[a.account_name].id = a.account_id;
                            }
                        }
                    });
                    chrome.storage.local.set(accounts_storage);
                    chrome.tabs.remove(tab_id);
                    chrome.storage.local.set({accountsstatus: "ready"})
                    chrome.storage.local.set({"accounts_status": {"status": "success", "message": "Successfully retrieved the list of AWS accounts."}})
                    chrome.storage.local.remove("login_status", function() {
                        safeSendMessage({"method": "UpdatePopup"});
                    });
                });
            }).catch((error) => {
                chrome.storage.local.set({"accounts_status": {"status": "failed", "message": error.message}});
                safeSendMessage({"method": "UpdateAccountsStatus"});
            });
        });
    })
    }, "accounts_status", preferredId);
}

function change_account(app, preset, account){
    debugLog('change_account called for:', account);
    debugLog('Switching to account:', account);
    chrome.cookies.getAll({"domain": preset.cookieDomain}, function(cookies_to_remove) {
        removeAwsCookies(cookies_to_remove);
        chrome.storage.local.get(["accounts"], function(result) {
            const appAccounts = (result["accounts"] && result["accounts"][app.id]) || {};
            const cookies_to_add = appAccounts[account].cookies;
            for (let i = 0; i < cookies_to_add.length; i++) {
                var cookie_to_add = cookies_to_add[i];
                delete cookie_to_add.hostOnly;
                delete cookie_to_add.session;
                const domainMatch = cookie_to_add.domain.match(/^\.?(.+)$/);
                if (!domainMatch) {continue;}
                var domain = domainMatch[1];
                cookie_to_add.url = "https://" + domain + cookie_to_add.path;
                chrome.cookies.set(cookie_to_add);
            }
            refresh_all_aws_tabs(preset);
        });
    });
}

function refresh_all_aws_tabs(preset) {
    preset = preset || REGION_PRESETS.commercial;
    chrome.storage.local.get(["settings"], function(s) {
        // Default ON: open a fresh console tab when none is open. When OFF we
        // only reload an already-open console tab and never pop a new one.
        const openNewTab = !(s.settings && s.settings.open_tab_on_switch === false);
        chrome.tabs.query({"url": "*://*." + preset.consoleHost + "/*"}, tabs => {
            if (tabs.length > 0) {
                for (let i = 0; i < tabs.length; i++) {
                    chrome.tabs.reload(tabs[i].id);
                }
            } else if (openNewTab) {
                chrome.tabs.create({"url": preset.consoleCreateUrl});
            }
            chrome.storage.local.set({"accounts_status": {"status": "success", "message": "🎉 Account changed successfully!"}})
            safeSendMessage({"method": "UpdateAccountsStatus"});
            if (tabs.length > 0) {
                chrome.tabs.query({ active: true, currentWindow: true }, active_tabs => {
                    if (active_tabs[0] != undefined) {
                        if (!active_tabs[0].url.includes(preset.consoleHost)) {
                            chrome.tabs.update(tabs[0].id, {selected: true});
                        }
                    }
                });
            }
        });
    });
}

function save(login, callback, originalAccountKey, appId, preset){
    preset = preset || REGION_PRESETS.commercial;
    const apex = cookieApex(preset.cookieDomain);
    chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Saving account cookies."}});
    safeSendMessage({"method": "UpdateAccountsStatus"});
    var account_name, account_id, account_role;
    chrome.cookies.getAll({"domain": preset.cookieDomain}, function(all_cookies){

        if (all_cookies.length === 0) {callback();return}
        for (let i = 0; i < all_cookies.length; i++) {
            if (all_cookies[i].name === "XSRF-TOKEN") {
                all_cookies.splice(i,1);
                i--;
            }
            if (all_cookies[i].name === "noflush_awscnm") {
                all_cookies.splice(i,1);
                i--;
            }
            // Check for aws-userInfo (legacy)
            if (all_cookies[i].name === "aws-userInfo") {
                if (all_cookies[i].domain === apex) {continue;}
                try {
                    var userInfo = JSON.parse(decodeURIComponent(all_cookies[i].value));
                    account_name = userInfo.alias;
                    account_id = userInfo.arn.match(/sts::([0-9]+):/)[1];
                    account_role = userInfo.arn.split('/')[1];
                } catch (error) {
                    // Continue to next cookie on error
                }
            }

            // Check for aws-consoleInfo (newer AWS console - JWT format)
            if (all_cookies[i].name === "aws-consoleInfo") {
                if (all_cookies[i].domain === apex) {continue;}
                try {
                    // JWT has 3 parts separated by dots: header.payload.signature
                    const jwtParts = all_cookies[i].value.split('.');
                    if (jwtParts.length >= 2) {
                        // Decode the payload (second part)
                        const payload = JSON.parse(atob(jwtParts[1]));

                        if (payload.sub) {
                            // Extract from ARN format like: "arn:aws:iam::015428540659:user/route53"
                            const arnMatch = payload.sub.match(/arn:aws(?:-us-gov|-cn)?:iam::([0-9]+):(?:user|assumed-role)\/(.+?)(?:\/|$)/);
                            if (arnMatch) {
                                account_id = arnMatch[1];
                                const userOrRole = arnMatch[2];
                                
                                // For assumed roles, extract role name
                                if (payload.sub.includes('assumed-role')) {
                                    account_role = userOrRole.split('/')[0];
                                    account_name = account_id; // Use account ID as name for now
                                } else {
                                    // For IAM users
                                    account_name = account_id; // Use account ID as name
                                    account_role = userOrRole; // The user name becomes the role
                                }
                                
                                break; // Stop after finding the first valid cookie
                            }
                        }
                    }
                } catch (error) {
                    // Continue to next cookie on error
                }
            }
        }
        
        debugLog('save() extracted account info:', {
            account_name: account_name,
            account_id: account_id,
            account_role: account_role,
            originalAccountKey: originalAccountKey
        });

        // For login operations, we MUST use the originalAccountKey to update the correct account
        // The cookie-extracted info may differ (e.g., account name from cookie might be account ID)
        if (originalAccountKey && login) {
            // Use original key - extract account_id from cookies if available
            const extractedId = account_id;

            chrome.storage.local.get(["accounts"], function(storage) {
                if (storage.accounts === undefined) {
                    storage.accounts = {};
                }
                if (storage.accounts[appId] === undefined) {
                    storage.accounts[appId] = {};
                }
                const appAccounts = storage.accounts[appId];

                if (appAccounts[originalAccountKey] === undefined) {
                    console.error('save() originalAccountKey not found in storage:', originalAccountKey);
                    console.error('Available accounts:', Object.keys(appAccounts));
                    callback();
                    return;
                }

                // Update the existing account with new cookies and ready status
                const newExpirationDate = (Date.now()/1000) + (SESSION_EXPIRATION_HOURS * 60 * 60);
                appAccounts[originalAccountKey].cookies = all_cookies;
                appAccounts[originalAccountKey].expirationDate = newExpirationDate;
                appAccounts[originalAccountKey].status = "ready";
                if (extractedId) {
                    appAccounts[originalAccountKey].id = extractedId;
                }

                console.log('[AWS Switcher] save() updating existing account:', originalAccountKey, 'to status: ready');

                // Combine both updates into a single storage set to avoid race conditions
                const updateData = {
                    accounts: storage.accounts,
                    accounts_status: {"status": "success", "message": "Account ready!"}
                };

                chrome.storage.local.set(updateData, function(){
                    console.log('[AWS Switcher] save() completed successfully for:', originalAccountKey);
                    safeSendMessage({"method": "UpdateAccountsStatus"});
                    safeSendMessage({"method": "UpdatePopup"});
                    callback();
                });
            });
            return;
        }

        if (account_name === undefined || account_id === undefined || account_role === undefined) {
            console.error('save() failed to extract account info from cookies');
            callback();
            return;
        }
        var expirationDate;
        chrome.storage.local.get(["accounts"], function(storage) {
            if (storage.accounts === undefined) {
                storage.accounts = {};
            }
            if (storage.accounts[appId] === undefined) {
                storage.accounts[appId] = {};
            }
            const appAccounts = storage.accounts[appId];
            // Try to get existing expiration date using the original account key if provided
            const lookupKey = originalAccountKey || (account_name + '/' + account_role);
            if (appAccounts[lookupKey] !== undefined) {
                expirationDate = appAccounts[lookupKey].expirationDate;
            }
            if (login) {
                expirationDate = (Date.now()/1000) + (SESSION_EXPIRATION_HOURS * 60 * 60);
            }

            // Use original account key if provided, otherwise construct new one
            const accountKey = originalAccountKey || (account_name + '/' + account_role);
            const accountData = {"id": account_id, "cookies": all_cookies, "expirationDate": expirationDate, "status": "ready"};

            debugLog('save() storing account data:', {
                accountKey: accountKey,
                accountId: account_id,
                originalAccountKey: originalAccountKey
            });

            appAccounts[accountKey] = accountData;
            chrome.storage.local.set(storage, function(){
                debugLog('save() completed, account status set to ready for:', accountKey);
                chrome.storage.local.set({"accounts_status": {"status": "success", "message": "Account ready!"}});
                safeSendMessage({"method": "UpdateAccountsStatus"});
                safeSendMessage({"method": "UpdatePopup"});
                callback();
            });
        });
    });
}

function login(app, preset, account, callback, alwaysCloseTab) {
    debugLog('login called for account:', account);
    chrome.storage.local.get(["accounts"], function(storage){
        chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Performing AWS account login"}});
        safeSendMessage({"method": "UpdateAccountsStatus"});
        const appAccounts = (storage.accounts && storage.accounts[app.id]) || undefined;
        if (appAccounts === undefined) {
            chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "No accounts found in storage."}})
            safeSendMessage({"method": "UpdateAccountsStatus"});
            return;
        }
        if (appAccounts[account] === undefined) {
            chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "No such account " + account}})
            safeSendMessage({"method": "UpdateAccountsStatus"});
            return;
        }
        var account_id = appAccounts[account].id;
        var account_name = account.split('/')[0];
        var account_role = account.split('/')[1];
        debugLog(`Extracted account info: id="${account_id}", name="${account_name}", role="${account_role}"`);

        aws_login(app, preset, function(tab_id, portalHost, app, preset){
            debugLog('aws_login callback called with tab_id:', tab_id, 'portalHost:', portalHost);
            chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Selecting account..."}});
            safeSendMessage({"method": "UpdateAccountsStatus"});

            const startWaitConsole = () => {
                debugLog('Starting wait_console timer for tab:', tab_id);
                var console_timer = setInterval(wait_console, 1000);
                var console_check_count = 0;
                function wait_console() {
                    console_check_count++;
                    chrome.tabs.get(tab_id, function(tab) {
                        if (chrome.runtime.lastError) {
                            console.log('[AWS Switcher] Tab error:', chrome.runtime.lastError.message);
                            if (console_check_count > 30) {
                                console.log('[AWS Switcher] Timeout waiting for console');
                                clearInterval(console_timer);
                            }
                            return;
                        }
                        const tab_url = tab.url;
                        console.log('[AWS Switcher] Checking tab URL:', tab_url);
                        const isGovConsole = tab_url && tab_url.includes(REGION_PRESETS.govcloud.consoleHost);
                        const isCommercialConsole = tab_url && tab_url.includes(REGION_PRESETS.commercial.consoleHost);
                        if (isGovConsole || isCommercialConsole) {
                            clearInterval(console_timer);
                            console.log('[AWS Switcher] AWS console loaded:', tab_url);
                            const detectedRegion = isGovConsole ? "govcloud" : "commercial";
                            persistAppFields(app.id, { region: detectedRegion }, function(updatedApp, updatedPreset) {
                                const finalPreset = updatedPreset || preset;
                                setTimeout(() => {
                                    save(true, function(){
                                        // The federation tab was opened only to capture
                                        // cookies. When "open new tab" is off, close it so
                                        // switching an expired account leaves no new tab.
                                        chrome.storage.local.get(["settings"], function(s) {
                                            const keepTab = alwaysCloseTab ? false : !(s.settings && s.settings.open_tab_on_switch === false);
                                            if (!keepTab) {
                                                chrome.tabs.remove(tab_id, function(){ checkLastError('close federation tab'); });
                                            }
                                            callback();
                                        });
                                    }, account, app.id, finalPreset);
                                }, 2000);
                            });
                        } else if (console_check_count > 30) {
                            console.log('[AWS Switcher] Timeout waiting for console after 30 checks');
                            clearInterval(console_timer);
                            chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "Timeout waiting for AWS console"}});
                            safeSendMessage({"method": "UpdateAccountsStatus"});
                        }
                    });
                }
            };

            if (portalHost) {
                // Access Portal mode: find the role's federation link in the SPA and click it.
                // The SPA intercepts the click and calls window.open(<federation-url>, '_blank'),
                // so we run in the page's main world and override window.open to navigate
                // in-place — that way wait_console keeps tracking the same tab.
                debugLog('Access Portal mode, clicking role link for', account_name, account_role);
                chrome.scripting.executeScript({
                    target: {tabId: tab_id},
                    world: 'MAIN',
                    func: async (account_name, account_role) => {
                        const sleep = ms => new Promise(r => setTimeout(r, ms));

                        // Override window.open so the SPA's window.open(url, '_blank') navigates this tab.
                        window.open = function(url) {
                            if (url) {
                                try { window.location.href = url; } catch (e) {}
                            }
                            return null;
                        };

                        // Expand every collapsed account row so the target role's
                        // federation link is in the DOM.
                        const toggles = document.querySelectorAll('tr[aria-level="1"] button[aria-expanded="false"]');
                        toggles.forEach(t => t.click());

                        // Locate the link exactly the way the account list was built
                        // (get_accounts_portal.js): find the level-1 account row by its
                        // visible name, then walk its level-2 sibling rows for the role
                        // link whose text matches. This is independent of the account id,
                        // so it can't collide when rows share or mis-report ids.
                        const findLink = () => {
                            const rows = document.querySelectorAll('tr[aria-level="1"]');
                            for (const row of rows) {
                                const nameEl = row.querySelector('[data-testid="account-list-cell"]');
                                if (!nameEl || nameEl.textContent.trim() !== account_name) continue;
                                let next = row.nextElementSibling;
                                while (next && next.getAttribute('aria-level') === '2') {
                                    const link = next.querySelector('a[data-testid="federation-link"]');
                                    if (link && link.textContent.trim() === account_role) return link;
                                    next = next.nextElementSibling;
                                }
                            }
                            return null;
                        };

                        let targetLink = findLink();
                        for (let i = 0; i < 50 && !targetLink; i++) {
                            await sleep(100);
                            targetLink = findLink();
                        }

                        if (!targetLink) {
                            return { ok: false, error: 'role link not found for ' + account_name + '/' + account_role };
                        }

                        targetLink.removeAttribute('target');
                        targetLink.removeAttribute('rel');
                        targetLink.click();
                        return { ok: true };
                    },
                    args: [account_name, account_role]
                }).then((results) => {
                    const r = results[0].result;
                    if (!r || !r.ok) {
                        debugLog('Portal role click failed:', r);
                        chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "Could not click role in portal: " + (r && r.error ? r.error : "unknown")}});
                        safeSendMessage({"method": "UpdateAccountsStatus"});
                        return;
                    }
                    debugLog('Portal role click dispatched, waiting for console...');
                    startWaitConsole();
                }).catch((error) => {
                    debugLog('Portal click error:', error.message);
                    chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "Portal click error: " + error.message}});
                    safeSendMessage({"method": "UpdateAccountsStatus"});
                });
                return;
            }

            debugLog('Executing account selection script on tab:', tab_id);
            chrome.scripting.executeScript({
                target: {tabId: tab_id},
                func: (account_id, account_name, account_role) => {
                    console.log('[AWS Switcher] ========================================');
                    console.log('[AWS Switcher] Script execution started on AWS SSO page');
                    console.log('[AWS Switcher] Current URL:', window.location.href);
                    console.log('[AWS Switcher] Searching for account:', account_name, 'role:', account_role, 'id:', account_id);
                    console.log('[AWS Switcher] Document ready state:', document.readyState);
                    console.log('[AWS Switcher] ========================================');

                    // Get all radio buttons
                    const allRadios = document.querySelectorAll('input[type="radio"]');
                    console.log('[AWS Switcher] Total radio buttons on page:', allRadios.length);

                    if (allRadios.length === 0) {
                        console.error('[AWS Switcher] No radio buttons found - page might not be loaded');
                        return { status: 'no_radios_found', html: document.body.innerHTML.substring(0, 500) };
                    }

                    // Log ALL available options in detail
                    console.log('[AWS Switcher] Available radio buttons:');
                    allRadios.forEach((radio, idx) => {
                        const container = radio.closest('.saml-account');
                        const accountNameEl = container ? container.querySelector('.saml-account-name') : null;
                        const roleNameEl = container ? container.querySelector('.saml-role .saml-role-description') : null;
                        console.log(`[AWS Switcher] Radio ${idx}:`);
                        console.log(`  - value: "${radio.value}"`);
                        console.log(`  - name: "${radio.name}"`);
                        console.log(`  - accountName: "${accountNameEl?.innerText?.trim() || 'N/A'}"`);
                        console.log(`  - roleName: "${roleNameEl?.innerText?.trim() || 'N/A'}"`);
                    });

                    let radioButton = null;
                    let matchReason = '';

                    // Strategy 1: Match by account ID in radio value (ARN contains account ID)
                    for (const radio of allRadios) {
                        if (radio.value && radio.value.includes(account_id)) {
                            console.log('[AWS Switcher] Strategy 1: Found match by account ID in radio value');
                            radioButton = radio;
                            matchReason = 'account_id_in_value';
                            break;
                        }
                    }

                    // Strategy 2: Find radio by matching role AND account name in container
                    if (!radioButton) {
                        for (const radio of allRadios) {
                            const container = radio.closest('.saml-account');
                            if (!container) continue;

                            const accountNameEl = container.querySelector('.saml-account-name');
                            const roleEls = container.querySelectorAll('.saml-role .saml-role-description');

                            const containerAccountName = accountNameEl?.innerText?.trim() || '';

                            // Check if account name matches
                            const accountMatch = containerAccountName.toLowerCase().includes(account_name.toLowerCase()) ||
                                                account_name.toLowerCase().includes(containerAccountName.toLowerCase());

                            if (!accountMatch) continue;

                            // Now find the role within this account
                            for (const roleEl of roleEls) {
                                const roleName = roleEl?.innerText?.trim() || '';
                                if (roleName.toLowerCase().includes(account_role.toLowerCase()) ||
                                    account_role.toLowerCase().includes(roleName.toLowerCase())) {
                                    // Find the radio for this specific role
                                    const roleContainer = roleEl.closest('.saml-role');
                                    const roleRadio = roleContainer?.querySelector('input[type="radio"]');
                                    if (roleRadio) {
                                        console.log('[AWS Switcher] Strategy 2: Found match by account name + role');
                                        radioButton = roleRadio;
                                        matchReason = 'account_name_and_role';
                                        break;
                                    }
                                }
                            }
                            if (radioButton) break;
                        }
                    }

                    // Strategy 3: If only one radio matches the role name in value, use it
                    if (!radioButton) {
                        const roleMatches = Array.from(allRadios).filter(r =>
                            r.value && r.value.toLowerCase().includes(account_role.toLowerCase())
                        );
                        console.log('[AWS Switcher] Strategy 3: Role matches found:', roleMatches.length);
                        if (roleMatches.length === 1) {
                            radioButton = roleMatches[0];
                            matchReason = 'unique_role_match';
                            console.log('[AWS Switcher] Using unique role match');
                        }
                    }

                    // Strategy 4: Match role name exactly in value
                    if (!radioButton) {
                        for (const radio of allRadios) {
                            // ARN format: arn:aws:iam::ACCOUNT_ID:role/ROLE_NAME
                            if (radio.value && radio.value.includes('/' + account_role)) {
                                console.log('[AWS Switcher] Strategy 4: Found exact role match in ARN');
                                radioButton = radio;
                                matchReason = 'exact_role_in_arn';
                                break;
                            }
                        }
                    }

                    if (radioButton) {
                        console.log('[AWS Switcher] ========================================');
                        console.log('[AWS Switcher] MATCH FOUND via:', matchReason);
                        console.log('[AWS Switcher] Selecting radio button:', radioButton.value);
                        console.log('[AWS Switcher] ========================================');

                        // Select the radio button with multiple methods
                        radioButton.checked = true;
                        radioButton.setAttribute('checked', 'checked');

                        // Trigger multiple events to ensure selection is registered
                        radioButton.click();
                        radioButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                        radioButton.dispatchEvent(new Event('change', { bubbles: true }));
                        radioButton.dispatchEvent(new Event('input', { bubbles: true }));

                        // Also try focusing and using keyboard
                        radioButton.focus();

                        // Find and click the sign-in button
                        const signInButton = document.getElementById('signin_button') ||
                                           document.querySelector('#signin_button') ||
                                           document.querySelector('button[type="submit"]') ||
                                           document.querySelector('input[type="submit"]') ||
                                           document.querySelector('#saml_form button') ||
                                           document.querySelector('button.btn-primary');

                        console.log('[AWS Switcher] Sign-in button found:', !!signInButton, signInButton?.id, signInButton?.tagName);

                        if (signInButton) {
                            console.log('[AWS Switcher] Clicking sign-in button in 200ms...');
                            setTimeout(() => {
                                console.log('[AWS Switcher] Now clicking sign-in button');
                                signInButton.click();
                                signInButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                            }, 200);
                            return { status: 'success', selectedAccount: radioButton.value, matchReason };
                        } else {
                            // Try submitting the form directly
                            const form = document.getElementById('saml_form') || document.querySelector('form');
                            if (form) {
                                console.log('[AWS Switcher] No button found, submitting form directly');
                                setTimeout(() => form.submit(), 200);
                                return { status: 'success', selectedAccount: radioButton.value, formSubmit: true, matchReason };
                            }
                            console.error('[AWS Switcher] No sign-in button or form found!');
                            return { status: 'signin_button_not_found', selectedAccount: radioButton.value, matchReason };
                        }
                    } else {
                        console.error('[AWS Switcher] ========================================');
                        console.error('[AWS Switcher] ACCOUNT NOT FOUND');
                        console.error('[AWS Switcher] Searched for:', { name: account_name, id: account_id, role: account_role });
                        console.error('[AWS Switcher] ========================================');
                        const availableAccounts = Array.from(allRadios).map(r => ({
                            value: r.value,
                            container: r.closest('.saml-account')?.querySelector('.saml-account-name')?.innerText?.trim()
                        }));
                        return {
                            status: 'account_not_found',
                            searchedFor: { name: account_name, id: account_id, role: account_role },
                            availableRadioValues: availableAccounts
                        };
                    }
                },
                args: [account_id, account_name, account_role]
            }).then((results) => {
                console.log('[AWS Switcher] Account selection script executed');
                const result = results[0].result;
                console.log('[AWS Switcher] Script result:', JSON.stringify(result));

                if (result && result.status === 'page_not_ready') {
                    console.log('[AWS Switcher] Page not ready, will retry selection after page loads');
                    return;
                }

                if (result && result.status === 'no_radios_found') {
                    console.error('[AWS Switcher] No radio buttons found on page');
                    chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "No accounts found on SAML page"}});
                    safeSendMessage({"method": "UpdateAccountsStatus"});
                    return;
                }

                if (result && result.status === 'account_not_found') {
                    console.error('[AWS Switcher] Account not found on AWS SSO page');
                    console.error('[AWS Switcher] Searched for:', result.searchedFor);
                    console.error('[AWS Switcher] Available accounts:', result.availableRadioValues);
                    chrome.storage.local.set({"accounts_status": {"status": "failed", "message": `Account not found`}});
                    safeSendMessage({"method": "UpdateAccountsStatus"});
                    return;
                }

                if (result && result.status === 'signin_button_not_found') {
                    console.log('[AWS Switcher] Sign-in button not found but account was selected, continuing...');
                }

                startWaitConsole();
            }).catch((error) => {
                console.error('Script execution failed:', error);
                console.error('Error details:', error.message);
                chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "Script execution failed: " + error.message}})
                safeSendMessage({"method": "UpdateAccountsStatus"});
            });
        });
    });
}

function checkExpire(){
    chrome.storage.local.get(["accounts"], (result) => {
        if (result.accounts === undefined) {return}
        var currentDate = Math.floor(Date.now() / 1000);
        var changed = false;
        Object.keys(result.accounts).forEach(appId => {
            var appAccounts = result.accounts[appId];
            if (!appAccounts || typeof appAccounts !== "object") {return}
            Object.keys(appAccounts).forEach(account => {
                var entry = appAccounts[account];
                if (!entry || entry.status === "expired") {return}
                if (entry.expirationDate < currentDate) {
                    entry.status = "expired";
                    changed = true;
                }
            });
        });
        if (changed) {
            chrome.storage.local.set(result);
        }
    });
}

function login_all_accounts(appId) {
    getActiveApp(function(app, preset) {
        chrome.storage.local.get(["accounts"], function(result) {
            const appAccounts = (result.accounts && result.accounts[app.id]) || {};
            const expiredKeys = Object.keys(appAccounts).filter(k => appAccounts[k].status === "expired");
            const total = expiredKeys.length;
            if (total === 0) {
                chrome.storage.local.set({"accounts_status": {"status": "success", "message": "All accounts are already logged in."}});
                safeSendMessage({"method": "UpdateAccountsStatus"});
                return;
            }
            // Federate one account at a time: they share a cookie domain, so a
            // parallel login would clobber the previous account's cookies before
            // save() captures them. alwaysCloseTab=true keeps tabs from piling up.
            let i = 0;
            const next = function() {
                if (i >= total) {
                    chrome.storage.local.set({"accounts_status": {"status": "success", "message": "🎉 Logged in to " + total + " account" + (total === 1 ? "" : "s") + "."}});
                    safeSendMessage({"method": "UpdateAccountsStatus"});
                    safeSendMessage({"method": "UpdatePopup"});
                    return;
                }
                const key = expiredKeys[i];
                i++;
                chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Logging in " + i + "/" + total + ": " + key.split('/')[0]}});
                safeSendMessage({"method": "UpdateAccountsStatus"});
                login(app, preset, key, next, true);
            };
            next();
        });
    }, "accounts_status", appId);
}

function logout_all_accounts(appId) {
    getActiveApp(function(app, preset) {
        chrome.cookies.getAll({"domain": preset.cookieDomain}, function(cookies_to_remove) {
            removeAwsCookies(cookies_to_remove);
            chrome.storage.local.get(["accounts"], function(result) {
                const appAccounts = result.accounts && result.accounts[app.id];
                if (!appAccounts) {
                    chrome.storage.local.set({"accounts_status": {"status": "success", "message": "No accounts to log out of."}});
                    safeSendMessage({"method": "UpdateAccountsStatus"});
                    return;
                }
                let count = 0;
                Object.keys(appAccounts).forEach(function(k) {
                    if (appAccounts[k].status !== "expired") count++;
                    appAccounts[k].status = "expired";
                    delete appAccounts[k].cookies;
                });
                chrome.storage.local.set(result, function() {
                    chrome.storage.local.set({"accounts_status": {"status": "success", "message": "Logged out of " + count + " account" + (count === 1 ? "" : "s") + "."}});
                    safeSendMessage({"method": "UpdateAccountsStatus"});
                    safeSendMessage({"method": "UpdatePopup"});
                });
            });
        });
    }, "accounts_status", appId);
}

chrome.runtime.onMessage.addListener( function(request, _sender, _sendResponse) {
    debugLog('Background received message:', request);
    
    if (request.method === "changeAccount") {
        debugLog('Processing changeAccount for:', request.account, 'app:', request.appId);
        chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Retrieving list of AWS accounts..."}})
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
                    login(app, preset, request.account, () => getActiveApp((a, p) => refresh_all_aws_tabs(p)));
                } else {
                    debugLog('Account is ready, changing account...');
                    change_account(app, preset, request.account);
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
                    if (result.accounts && result.accounts[app.id] && result.accounts[app.id][request.account]) {
                        result.accounts[app.id][request.account].status = "expired";
                        delete result.accounts[app.id][request.account].cookies;
                        chrome.storage.local.set(result, function() {
                            debugLog('Account expired and cookies cleared:', request.account);
                            safeSendMessage({"method": "UpdatePopup"});
                        });
                    }
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

function clearAwsCookiesAllRegions(done) {
    const domains = [REGION_PRESETS.commercial.cookieDomain, REGION_PRESETS.govcloud.cookieDomain];
    let pending = domains.length;
    domains.forEach(domain => {
        chrome.cookies.getAll({"domain": domain}, function(cookies_to_remove) {
            removeAwsCookies(cookies_to_remove);
            if (--pending === 0) done();
        });
    });
}

function aws_login(app, preset, callback) {
    debugLog('aws_login function called for app:', app && app.id, app && app.region);
    preset = preset || presetForApp(app);

    // Clear cookies for both regions so a region change can't leave a stale session.
    debugLog('Clearing existing AWS cookies...');
    clearAwsCookiesAllRegions(function() {
        debugLog('AWS cookies cleared, proceeding with login...');

        // Now proceed with login after cookies are cleared
        chrome.storage.local.get(["settings"], function(storage){
            // Settings loaded successfully
            if (storage.settings === undefined) {
                chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "Settings not found. Open Settings and fill in your Okta details."}})
                safeSendMessage({"method": "UpdateAccountsStatus"});
                return;
            }
            if (storage.settings.okta_domain === undefined) {
                chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "OKTA domain not set. Fill in 'OKTA Domain' in Settings."}})
                safeSendMessage({"method": "UpdateAccountsStatus"});
                return;
            }
            if (!app.url) {
                // No URL stored: resolve it on demand from the Okta apps list and
                // cache it, then retry. We never re-launch okta_login here (that
                // caused an open/close loop) — a plain fetch either finds the URL
                // or we report a clear, terminal message.
                chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Finding the AWS app in Okta..."}});
                safeSendMessage({"method": "UpdateAccountsStatus"});
                fetchOktaAwsApps(storage.settings.okta_domain, function(awsApps) {
                    if (awsApps === null) {
                        chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "Couldn't reach Okta to find the AWS app. Use Login, then try again."}});
                        safeSendMessage({"method": "UpdateAccountsStatus"});
                        return;
                    }
                    const match = pickAppMatch(app, awsApps);
                    if (!match) {
                        const msg = awsApps.length === 0
                            ? "No AWS app found in your Okta org."
                            : "Found several AWS apps and can't tell which one this is. Rename this tab to match the Okta app, or set its URL in Settings.";
                        chrome.storage.local.set({"accounts_status": {"status": "failed", "message": msg}});
                        safeSendMessage({"method": "UpdateAccountsStatus"});
                        return;
                    }
                    persistAppFields(app.id, { url: match.url }, function(updatedApp, updatedPreset) {
                        aws_login(updatedApp || Object.assign({}, app, { url: match.url }), updatedPreset || preset, callback);
                    });
                });
                return;
            }
            var aws_saml_url = app.url;
            //Check okta login
            const list_apps_url = "https://" + storage.settings.okta_domain + "/api/v1/users/me/home/tabs";
            fetch(list_apps_url, {
                method: 'GET',
                credentials: 'include'
            }).then(response => {
                if (!response.ok) {
                    chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Performing okta login"}});
                    safeSendMessage({"method": "UpdateAccountsStatus"});
                    okta_login(() => aws_login(app, preset, callback), null);
                    return;
                }
                chrome.storage.local.set({"accounts_status": {"status": "progress", "message": "Opening AWS login page"}});
                safeSendMessage({"method": "UpdateAccountsStatus"});
                chrome.tabs.create({"url": aws_saml_url, "selected": false}, function(tab) {
                    if (checkLastError('tabs.create aws_saml_url') || !tab) {
                        chrome.storage.local.set({"accounts_status": {"status": "failed", "message": "Failed to create AWS login tab"}});
                        safeSendMessage({"method": "UpdateAccountsStatus"});
                        return;
                    }
                    var signin_timer = setInterval(wait_signin, 1000);
                    // Detect the flow mode and region from wherever the app URL lands,
                    // persist it back onto the app, then continue with the resolved app/preset.
                    function proceed(result) {
                        clearInterval(signin_timer);
                        const detected = {};
                        if (result.flow) detected.flow_mode = result.flow;
                        if (result.region) detected.region = result.region;
                        persistAppFields(app.id, detected, function(updatedApp, updatedPreset) {
                            const finalApp = updatedApp || app;
                            const finalPreset = updatedPreset || preset;
                            setTimeout(() => callback(tab.id, result.portalHost, finalApp, finalPreset), 500);
                        });
                    }
                    function wait_signin(){
                        chrome.scripting.executeScript({
                            target: {tabId: tab.id},
                            func: () => {
                                const href = window.location.href;
                                const portal = href.match(/^https:\/\/([^/]+\.awsapps(?:-us-gov)?\.com)\/start/);
                                if (portal) {
                                    const host = portal[1];
                                    return {
                                        ready: true,
                                        flow: "access_portal",
                                        region: host.includes("awsapps-us-gov") ? "govcloud" : undefined,
                                        portalHost: host,
                                        url: href
                                    };
                                }
                                const samlMatch = href.match(/^https:\/\/signin\.(aws\.amazon\.com|amazonaws-us-gov\.com)\/saml/);
                                if (samlMatch) {
                                    const accountContainers = document.querySelectorAll('.saml-account');
                                    const signinButton = document.getElementById('signin_button');
                                    return {
                                        ready: accountContainers.length > 0 && signinButton !== null,
                                        flow: "classic_saml",
                                        region: samlMatch[1] === "amazonaws-us-gov.com" ? "govcloud" : "commercial",
                                        accountCount: accountContainers.length,
                                        url: href
                                    };
                                }
                                return { ready: false, url: href };
                            }
                        }).then((results) => {
                            const result = results[0].result;
                            if (!result || !result.ready) {
                                debugLog("AWS login page not ready yet:", result);
                                return;
                            }
                            if (result.flow === "access_portal") {
                                // Wait for the SPA's accounts table to render.
                                chrome.scripting.executeScript({
                                    target: {tabId: tab.id},
                                    func: () => {
                                        const cell = document.querySelector('[data-testid="account-list-cell"]');
                                        const idLink = document.querySelector('[data-testid="account-federation-link"]');
                                        return { ok: !!(cell && idLink) };
                                    }
                                }).then((probeResults) => {
                                    const probe = probeResults[0].result;
                                    if (!probe || !probe.ok) {
                                        debugLog("Portal table not rendered yet");
                                        return;
                                    }
                                    debugLog("Portal table ready, host:", result.portalHost);
                                    proceed(result);
                                }).catch((error) => {
                                    debugLog("Portal probe error:", error.message);
                                });
                                return;
                            }
                            debugLog("SAML page ready with", result.accountCount, "accounts, region:", result.region);
                            proceed(result);
                        }).catch((error) => {
                            clearInterval(signin_timer);
                            chrome.storage.local.set({"accounts_status": {"status": "failed", "message": error.message}});
                            safeSendMessage({"method": "UpdateAccountsStatus"});
                            chrome.tabs.remove(tab.id);
                        });
                    }
                });
            }).catch((error) => {
                chrome.storage.local.set({"accounts_status": {"status": "failed", "message": error.message}});
                safeSendMessage({"method": "UpdateAccountsStatus"});
            });
        });
    });
}

// Opens the Okta sign-in page and lets the USER authenticate directly on Okta
// (the extension never handles the password). Once the Okta session is
// established, startManualLoginMonitoring detects it and loads the apps.
function okta_login(callback, callback_argument = null) {
    chrome.storage.local.get(["settings"], function(storage){
        chrome.action.setBadgeText({text: "..."});
        chrome.action.setBadgeBackgroundColor({color: "#2196F3"});

        if (storage.settings === undefined || storage.settings.okta_domain === undefined) {
            chrome.action.setBadgeText({text: ""});
            chrome.storage.local.set({"login_status": {"status": "failed", "message": "Login failed! OKTA domain not set"}});
            safeSendMessage({"method": "UpdateLoginStatus"});
            return;
        }

        var domain = storage.settings.okta_domain;
        const okta_url = "https://" + domain + "/";
        const list_apps_url = "https://" + domain + "/api/v1/users/me/home/tabs?type=all&expand=items%2Citems.resource";

        chrome.storage.local.set({"login_status": {"status": "progress", "message": "Checking Okta session..."}});
        safeSendMessage({"method": "UpdateLoginStatus"});

        // If the Okta session is still valid, load everything with a silent
        // background request — no tab is opened and the popup keeps focus.
        // Only when the session has expired do we open Okta for manual sign-in.
        fetch(list_apps_url, { method: 'GET', credentials: 'include', headers: { 'Accept': 'application/json' } })
            .then(r => (r.ok ? r.json() : Promise.reject(new Error("okta session invalid"))))
            .then(data => {
                chrome.action.setBadgeText({text: ""});
                chrome.storage.local.set({"login_status": {"status": "success", "message": "Signed in! Loading applications..."}});
                safeSendMessage({"method": "UpdateLoginStatus"});
                autoDetectAwsApp(data);
                if (callback) callback(callback_argument);
            })
            .catch(() => openOktaTabForManualLogin());

        function openOktaTabForManualLogin() {
            chrome.storage.local.set({"login_status": {"status": "progress", "message": "Sign in to Okta in the opened tab..."}});
            safeSendMessage({"method": "UpdateLoginStatus"});

            const onTab = function(tab) {
                if (checkLastError('open okta tab') || !tab) {
                    chrome.action.setBadgeText({text: ""});
                    chrome.storage.local.set({"login_status": {"status": "failed", "message": "Failed to open Okta tab"}});
                    safeSendMessage({"method": "UpdateLoginStatus"});
                    return;
                }
                startManualLoginMonitoring(tab.id, callback, callback_argument);
            };

            // Reuse an existing Okta tab if one is open, otherwise open one in
            // the foreground so the user can complete sign-in.
            chrome.tabs.query({url: "*://" + domain + "/*"}, function(existingTabs) {
                checkLastError('tabs.query okta domain');
                if (existingTabs && existingTabs.length > 0) {
                    chrome.tabs.update(existingTabs[0].id, {url: okta_url, active: true}, onTab);
                } else {
                    chrome.tabs.create({"url": okta_url, "active": true}, onTab);
                }
            });
        }
    });
}


function startManualLoginMonitoring(tabId, callback, callback_argument) {
    chrome.storage.local.set({"login_status": {"status": "progress", "message": "Please complete login in the opened tab..."}});
    safeSendMessage({"method": "UpdateLoginStatus"});
    
    let monitorCount = 0;
    const monitor_timer = setInterval(function() {
        monitorCount++;
        
        chrome.scripting.executeScript({
            target: {tabId: tabId},
            func: () => {
                const url = window.location.href;
                const title = document.title;
                
                // Check if user has successfully logged in and reached dashboard
                const isLoggedIn = (url.includes('/app/') || 
                                  url.includes('/dashboard') || 
                                  url.includes('/user/profile') ||
                                  title.includes('Dashboard') ||
                                  document.querySelector('.okta-dashboard')) &&
                                  !url.includes('/oauth2') &&
                                  !url.includes('/authorize');
                
                return {
                    url: url,
                    title: title,
                    isLoggedIn: isLoggedIn
                };
            }
        }).then((results) => {
            const state = results[0].result;
            debugLog(`Manual login monitoring (attempt ${monitorCount}):`, state);
            
            if (state.isLoggedIn) {
                clearInterval(monitor_timer);
                chrome.storage.local.set({"oauth2LoginCompleted": true}); // Mark login as completed
                chrome.storage.local.set({"login_status": {"status": "success", "message": "Login successful! Loading applications..."}});
                safeSendMessage({"method": "UpdateLoginStatus"});

                // Auto-load applications
                chrome.storage.local.get(["settings"], function(storage){
                    if (storage.settings && storage.settings.okta_domain) {
                        debugLog("Manual login successful - auto-loading applications");
                        const list_apps_url = "https://" + storage.settings.okta_domain + "/api/v1/users/me/home/tabs?type=all&expand=items%2Citems.resource";
                        makeOktaApiCall(tabId, list_apps_url, true);
                    } else {
                        chrome.tabs.remove(tabId);
                    }
                    
                    if (callback) {
                        callback(callback_argument);
                    }
                });
            }
        }).catch(error => {
            debugLog("Manual login monitoring error:", error.message);
        });
    }, 3000); // Check every 3 seconds
    
    // Timeout after 5 minutes
    setTimeout(() => {
        clearInterval(monitor_timer);
        chrome.storage.local.set({"login_status": {"status": "failed", "message": "Manual login timed out after 5 minutes"}});
        safeSendMessage({"method": "UpdateLoginStatus"});
        chrome.tabs.remove(tabId);
    }, 300000);
}



function loadOktaApps() {
    chrome.storage.local.get(["settings"], function(storage){
        if (storage.settings === undefined || storage.settings.okta_domain === undefined) {
            chrome.storage.local.set({"okta_apps_status": {"status": "failed", "message": "OKTA domain not set"}});
            safeSendMessage({"method": "UpdateOktaApps"});
            return;
        }
        
        const list_apps_url = "https://" + storage.settings.okta_domain + "/api/v1/users/me/home/tabs?type=all&expand=items%2Citems.resource";
        const okta_domain = storage.settings.okta_domain;
        
        // First try the direct service worker fetch with proper host permissions
        debugLog("Manual app refresh requested - attempting direct API call to:", list_apps_url);
        fetch(list_apps_url, {
            method: 'GET',
            credentials: 'include',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        }).then(response => {
            debugLog("Direct API response status:", response.status);
            if (response.ok) {
                return response.json().then(okta_tabs => {
                    debugLog("Direct API call succeeded");
                    chrome.storage.local.set({"okta_apps_status": {"status": "success", "apps": okta_tabs}});
                    safeSendMessage({"method": "UpdateOktaApps"});
                });
            } else {
                debugLog("Direct API call failed (status:", response.status, "), trying tab-based approach");
                // Always fallback to tab-based approach - service worker doesn't have access to browser session cookies
                loadOktaAppsViaTab(okta_domain, list_apps_url);
            }
        }).catch(error => {
            debugLog("Direct API call error:", error.message, "- falling back to tab approach");
            // Fallback to tab-based approach
            loadOktaAppsViaTab(okta_domain, list_apps_url);
        });
    });
}

function loadOktaAppsViaTab(okta_domain, list_apps_url) {
    // Look for any existing Okta tabs that might have a valid session
    debugLog("Searching for Okta tabs with pattern: *://" + okta_domain + "/*");
    chrome.tabs.query({url: "*://" + okta_domain + "/*"}, function(existingTabs) {
        debugLog("Tab query result:", existingTabs.map(tab => ({id: tab.id, url: tab.url, title: tab.title})));
        
        if (existingTabs.length > 0) {
            debugLog(`Found ${existingTabs.length} existing Okta tab(s), trying the first one`);
            // Filter for tabs that look like they might be logged in (not on login/auth pages)
            const loggedInTabs = existingTabs.filter(tab => 
                !tab.url.includes('/login') && 
                !tab.url.includes('/signin') && 
                !tab.url.includes('/oauth2') &&
                !tab.url.includes('/authorize')
            );
            
            if (loggedInTabs.length > 0) {
                debugLog("Found potentially logged-in tab:", loggedInTabs[0].url);
                makeOktaApiCall(loggedInTabs[0].id, list_apps_url);
            } else {
                debugLog("All tabs appear to be on login pages, using first tab anyway:", existingTabs[0].url);
                makeOktaApiCall(existingTabs[0].id, list_apps_url);
            }
        } else {
            debugLog("No existing Okta tabs found, user needs to login first");
            chrome.storage.local.set({"okta_apps_status": {"status": "failed", "message": "No Okta session found. Please login first!"}});
            safeSendMessage({"method": "UpdateOktaApps"});
        }
    });
}

function makeOktaApiCall(tabId, apiUrl, closeTab = false, callback = null, retryCount = 0) {
    // First verify the tab still exists
    chrome.tabs.get(tabId, function(tab) {
        if (chrome.runtime.lastError) {
            debugLog("Tab no longer exists:", chrome.runtime.lastError.message);
            handlePostLoginAccountLoad();
            if (callback) callback(false);
            return;
        }

        debugLog("Making API call on existing tab:", tab.url);
        debugLog("Expected tab to be on dashboard, but URL is:", tab.url);

        // Check if tab reverted to OAuth2 page
        if (tab.url.includes('/oauth2') || tab.url.includes('/authorize')) {
            debugLog("ERROR: Tab reverted to OAuth2 page after dashboard navigation!");

            if (retryCount >= 2) {
                debugLog("Too many retries, giving up on navigation fix");
                chrome.tabs.remove(tabId);
                handlePostLoginAccountLoad();
                if (callback) callback(false);
                return;
            }
            
            debugLog(`Attempting to navigate back to dashboard (retry ${retryCount + 1}/2)...`);
            
            // Extract domain from current URL
            const domain = new URL(tab.url).hostname;
            const dashboardUrl = "https://" + domain + "/app/UserHome";
            
            chrome.tabs.update(tabId, {url: dashboardUrl}, function() {
                debugLog("Re-navigated to dashboard, waiting before API call...");
                setTimeout(() => {
                    // Recursive call after navigation with incremented retry count
                    makeOktaApiCall(tabId, apiUrl, closeTab, callback, retryCount + 1);
                }, 3000);
            });
            return;
        }
        
        debugLog("Tab URL looks correct for API call:", tab.url);
        
        chrome.scripting.executeScript({
            target: {tabId: tabId},
            func: (url) => {
                debugLog("=== API CALL SCRIPT STARTING ===");
                debugLog("Making Okta API call to:", url);
                debugLog("From page:", window.location.href);
                debugLog("Page title:", document.title);
                debugLog("Document ready state:", document.readyState);
                
                try {
                    return fetch(url, {
                        method: 'GET',
                        credentials: 'include',
                        headers: {
                            'Accept': 'application/json',
                            'Content-Type': 'application/json'
                        }
                    }).then(response => {
                        debugLog("Tab-based API Response status:", response.status);
                        debugLog("Response headers:", response.headers);
                        
                        if (!response.ok) {
                            debugLog("API response not OK, getting response text...");
                            return response.text().then(text => {
                                debugLog("Error response text:", text.substring(0, 200));
                                return {
                                    success: false,
                                    status: response.status,
                                    statusText: response.statusText,
                                    responseText: text.substring(0, 500), // Limit response text length
                                    url: window.location.href,
                                    title: document.title
                                };
                            });
                        }
                        debugLog("API response OK, parsing JSON...");
                        return response.json().then(data => {
                            debugLog("Successfully parsed JSON, data keys:", Object.keys(data));
                            return {
                                success: true,
                                data: data,
                                url: window.location.href,
                                title: document.title
                            };
                        });
                    }).catch(error => {
                        debugLog("Fetch error:", error.message);
                        debugLog("Error stack:", error.stack);
                        return {
                            success: false,
                            error: error.message,
                            url: window.location.href,
                            title: document.title
                        };
                    });
                } catch (error) {
                    debugLog("Script execution error:", error.message);
                    debugLog("Error stack:", error.stack);
                    return {
                        success: false,
                        error: "Script execution error: " + error.message,
                        url: window.location.href,
                        title: document.title
                    };
                }
            },
            args: [apiUrl]
        }).then((results) => {
            debugLog("Raw API call results:", results);

            if (!results || results.length === 0) {
                debugLog("No results returned from API call script");
                if (closeTab) chrome.tabs.remove(tabId);
                handlePostLoginAccountLoad();
                if (callback) callback(false);
                return;
            }

            const result = results[0]?.result;
            debugLog("API call result:", result);

            if (!result) {
                debugLog("API call script returned null result");
                if (closeTab) chrome.tabs.remove(tabId);
                handlePostLoginAccountLoad();
                if (callback) callback(false);
                return;
            }
            
            if (result.success) {
                // Auto-detect AWS app from the list
                autoDetectAwsApp(result.data);

                // Clear badge after successful operation
                chrome.action.setBadgeText({text: ""});

                if (callback) callback(true);
            } else {
                debugLog("API call failed, status:", result.status);
                if (result.responseText) {
                    debugLog("Response details:", result.responseText);
                }
                handlePostLoginAccountLoad();
                if (callback) callback(false);
            }
            
            if (closeTab) {
                // Small delay before closing tab to ensure response is processed
                setTimeout(() => {
                    chrome.tabs.remove(tabId, () => {
                        if (chrome.runtime.lastError) {
                            debugLog("Tab already closed");
                        }
                    });
                }, 100);
            }
        }).catch(error => {
            debugLog("Script injection error:", error.message);
            if (closeTab) {
                chrome.tabs.remove(tabId, () => {
                    if (chrome.runtime.lastError) {
                        debugLog("Tab already closed");
                    }
                });
            }
            handlePostLoginAccountLoad();
            if (callback) callback(false);
        });
    });
}

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
